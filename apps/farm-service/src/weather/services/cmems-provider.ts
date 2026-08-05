import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  CircuitBreakerService,
  CircuitOpenError,
  DEFAULT_BREAKER_OPTIONS,
} from '@aquaculture/backend-common/resilience';
import { createAbortSignalTimeout } from '@aquaculture/backend-common/utils';

import { parseProviderRetryAfterMs } from './provider-http-headers';

export const CMEMS_FETCH = Symbol('CMEMS_FETCH');
export const CMEMS_CLOCK = Symbol('CMEMS_CLOCK');
export const CMEMS_DELAY = Symbol('CMEMS_DELAY');
export const CMEMS_CACHE_POLICY = Symbol('CMEMS_CACHE_POLICY');

export const CMEMS_CSW_ORIGIN = 'https://csw.marine.copernicus.eu';
export const CMEMS_CSW_PATH = '/geonetwork/csw-MYOCEAN-CORE-PRODUCTS/eng/csw';
export const CMEMS_WMTS_ORIGIN = 'https://wmts.marine.copernicus.eu';
export const CMEMS_WMTS_PATH = '/teroWmts';
export const CMEMS_TILE_MATRIX_SET = 'EPSG:3857';
export const CMEMS_TILE_MATRIX = 10;
export const CMEMS_REQUEST_TIMEOUT_MS = 30_000;
export const CMEMS_MAX_XML_BYTES = 4 * 1024 * 1024;
export const CMEMS_MAX_JSON_BYTES = 1024 * 1024;
export const CMEMS_MAX_OUTBOUND_CONCURRENCY = 8;
export const CMEMS_CAPABILITY_FRESH_MS = 2 * 60 * 60 * 1000;

const CMEMS_BREAKER_SERVICE = 'cmems-public-api';
const CMEMS_BREAKER_OPTIONS = {
  ...DEFAULT_BREAKER_OPTIONS,
  failureMode: 'fail-closed' as const,
};
const DATASET_TAG_PATTERN = /^\d{6}$/u;
const PRODUCT_ID_PATTERN = /^[A-Z0-9_]+$/u;
const DATASET_BASE_PATTERN = /^[A-Za-z0-9_.-]+$/u;
const VARIABLE_ID_PATTERN = /^[A-Za-z0-9_]+$/u;
const ISO_DURATION_PATTERN = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/u;

export interface CmemsFetch {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface CmemsClock {
  now(): Date;
}

export interface CmemsDelay {
  wait(milliseconds: number): Promise<void>;
}

export interface CmemsCachePolicy {
  discoveryFreshMs: number;
  discoveryStaleMs: number;
  capabilityFreshMs: number;
  capabilityStaleMs: number;
}

export const DEFAULT_CMEMS_CACHE_POLICY: Readonly<CmemsCachePolicy> = {
  discoveryFreshMs: 6 * 60 * 60 * 1000,
  discoveryStaleMs: 7 * 24 * 60 * 60 * 1000,
  // One ingestion lease resolves many forecast horizons. Keep the immutable
  // capabilities snapshot fresh for longer than that bounded execution so a
  // legitimate run cannot silently multiply metadata calls after 15 minutes.
  capabilityFreshMs: CMEMS_CAPABILITY_FRESH_MS,
  capabilityStaleMs: 24 * 60 * 60 * 1000,
};

const SYSTEM_CLOCK: CmemsClock = {
  now: (): Date => new Date(),
};

const SYSTEM_DELAY: CmemsDelay = {
  wait: async (milliseconds: number): Promise<void> => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  },
};

class CmemsOutboundSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}

const PROCESS_CMEMS_OUTBOUND_SEMAPHORE = new CmemsOutboundSemaphore(CMEMS_MAX_OUTBOUND_CONCURRENCY);

export enum CmemsRegion {
  NORTH_WEST_SHELF = 'NORTH_WEST_SHELF',
  ARCTIC = 'ARCTIC',
}

export enum CmemsProductKey {
  NWS_PHY = 'NWS_PHY',
  NWS_WAV = 'NWS_WAV',
  NWS_BGC = 'NWS_BGC',
  ARCTIC_PHY = 'ARCTIC_PHY',
  ARCTIC_WAV = 'ARCTIC_WAV',
  ARCTIC_BGC = 'ARCTIC_BGC',
}

export interface CmemsProductDefinition {
  key: CmemsProductKey;
  region: CmemsRegion;
  uuid: string;
  productId: string;
  resolutionM: number;
  datasetBases: readonly string[];
}

export const CMEMS_PRODUCTS: Readonly<Record<CmemsProductKey, CmemsProductDefinition>> = {
  [CmemsProductKey.NWS_PHY]: {
    key: CmemsProductKey.NWS_PHY,
    region: CmemsRegion.NORTH_WEST_SHELF,
    uuid: '3352d5a8-e582-41aa-90f9-c53d9a585366',
    productId: 'NWSHELF_ANALYSISFORECAST_PHY_004_013',
    resolutionM: 1_500,
    datasetBases: [
      'cmems_mod_nws_phy-tem_anfc_1.5km-3D_PT1H-i',
      'cmems_mod_nws_phy-sal_anfc_1.5km-3D_PT1H-i',
      'cmems_mod_nws_phy-cur_anfc_1.5km-3D_PT1H-i',
    ],
  },
  [CmemsProductKey.NWS_WAV]: {
    key: CmemsProductKey.NWS_WAV,
    region: CmemsRegion.NORTH_WEST_SHELF,
    uuid: 'e32cd7b4-a738-49d1-be5f-79308416c800',
    productId: 'NWSHELF_ANALYSISFORECAST_WAV_004_014',
    resolutionM: 1_500,
    datasetBases: ['cmems_mod_nws_wav_anfc_1.5km_PT1H-i'],
  },
  [CmemsProductKey.NWS_BGC]: {
    key: CmemsProductKey.NWS_BGC,
    region: CmemsRegion.NORTH_WEST_SHELF,
    uuid: 'a0cef231-2f56-40f6-a039-d27dec2216e6',
    productId: 'NWSHELF_ANALYSISFORECAST_BGC_004_002',
    resolutionM: 7_000,
    datasetBases: [
      'cmems_mod_nws_bgc-o2_anfc_7km-3D_P1D-m',
      'cmems_mod_nws_bgc-chl_anfc_7km-3D_P1D-m',
    ],
  },
  [CmemsProductKey.ARCTIC_PHY]: {
    key: CmemsProductKey.ARCTIC_PHY,
    region: CmemsRegion.ARCTIC,
    uuid: 'c157a8b7-794b-473a-8ceb-d216b743fd03',
    productId: 'ARCTIC_ANALYSISFORECAST_PHY_002_001',
    resolutionM: 6_250,
    datasetBases: ['cmems_mod_arc_phy_anfc_6km_detided_PT1H-i'],
  },
  [CmemsProductKey.ARCTIC_WAV]: {
    key: CmemsProductKey.ARCTIC_WAV,
    region: CmemsRegion.ARCTIC,
    uuid: '77c2aa09-f61e-4a60-abed-cb72b611040d',
    productId: 'ARCTIC_ANALYSIS_FORECAST_WAV_002_014',
    resolutionM: 3_000,
    datasetBases: ['dataset-wam-arctic-1hr3km-be'],
  },
  [CmemsProductKey.ARCTIC_BGC]: {
    key: CmemsProductKey.ARCTIC_BGC,
    region: CmemsRegion.ARCTIC,
    uuid: 'f60933b2-c2bf-4026-b540-a278c71b1cbc',
    productId: 'ARCTIC_ANALYSISFORECAST_BGC_002_004',
    resolutionM: 6_250,
    datasetBases: ['cmems_mod_arc_bgc_anfc_ecosmo_P1D-m'],
  },
};

export enum CmemsProviderErrorCode {
  CONFIGURATION = 'CONFIGURATION',
  PROVIDER_UNAVAILABLE = 'PROVIDER_UNAVAILABLE',
  SCHEMA = 'SCHEMA',
  RESPONSE_TOO_LARGE = 'RESPONSE_TOO_LARGE',
  REDIRECT_BLOCKED = 'REDIRECT_BLOCKED',
  CLIENT_REQUEST = 'CLIENT_REQUEST',
  RATE_LIMITED = 'RATE_LIMITED',
  TIMEOUT = 'TIMEOUT',
  TRANSPORT = 'TRANSPORT',
}

export interface CmemsProviderErrorOptions {
  code: CmemsProviderErrorCode;
  message: string;
  retryable: boolean;
  httpStatus?: number;
  retryAfterMs?: number;
  cause?: unknown;
}

export class CmemsProviderError extends Error {
  readonly code: CmemsProviderErrorCode;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly providerCause?: unknown;

  constructor(options: CmemsProviderErrorOptions) {
    super(options.message);
    this.name = 'CmemsProviderError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.httpStatus = options.httpStatus;
    this.retryAfterMs = options.retryAfterMs;
    this.providerCause = options.cause;
  }
}

interface CmemsHttpResponse {
  body: string;
  fetchedAt: string;
}

interface CmemsCompletedResponse {
  body: string;
  contentType: string;
  fetchedAt: string;
  status: number;
}

export interface CmemsHttpNoData {
  status: 'NO_DATA';
  fetchedAt: string;
}

export interface CmemsHttpAvailable {
  status: 'AVAILABLE';
  payload: unknown;
  fetchedAt: string;
}

export type CmemsJsonResponse = CmemsHttpNoData | CmemsHttpAvailable;

function providerError(
  code: CmemsProviderErrorCode,
  message: string,
  retryable: boolean,
  options?: {
    httpStatus?: number;
    retryAfterMs?: number;
    cause?: unknown;
  },
): CmemsProviderError {
  return new CmemsProviderError({
    code,
    message,
    retryable,
    httpStatus: options?.httpStatus,
    retryAfterMs: options?.retryAfterMs,
    cause: options?.cause,
  });
}

export function cmemsSchemaError(path: string): CmemsProviderError {
  return providerError(
    CmemsProviderErrorCode.SCHEMA,
    `CMEMS response failed schema validation at ${path}`,
    false,
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isRetryableProviderError(error: unknown): error is CmemsProviderError {
  return error instanceof CmemsProviderError && error.retryable;
}

function parseRetryAfterMilliseconds(value: string | null, now: Date): number {
  return parseProviderRetryAfterMs(value, now, 1_000) ?? 0;
}

export type CmemsEndpoint =
  | {
      kind: 'CSW';
      url: URL;
    }
  | {
      kind: 'CAPABILITIES';
      url: URL;
      productId: string;
      datasetId: string;
    }
  | {
      kind: 'FEATURE_INFO';
      url: URL;
    };

function assertIdentifier(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) {
    throw providerError(CmemsProviderErrorCode.CONFIGURATION, `Invalid CMEMS ${label}`, false);
  }
}

function assertExactQueryKeys(url: URL, expectedKeys: ReadonlySet<string>): void {
  const actualKeys = Array.from(url.searchParams.keys());
  if (
    actualKeys.length !== expectedKeys.size ||
    actualKeys.some((key) => !expectedKeys.has(key)) ||
    actualKeys.some((key) => url.searchParams.getAll(key).length !== 1)
  ) {
    throw providerError(
      CmemsProviderErrorCode.CONFIGURATION,
      'CMEMS endpoint query is not allowed',
      false,
    );
  }
}

function assertAllowedProductDataset(productId: string, datasetId: string): CmemsProductDefinition {
  const product = Object.values(CMEMS_PRODUCTS).find(
    (candidate) => candidate.productId === productId,
  );
  if (
    !product ||
    !product.datasetBases.some((base) => {
      if (!datasetId.startsWith(`${base}_`)) return false;
      return DATASET_TAG_PATTERN.test(datasetId.slice(base.length + 1));
    })
  ) {
    throw providerError(
      CmemsProviderErrorCode.CONFIGURATION,
      'CMEMS product or dataset is not allowlisted',
      false,
    );
  }
  return product;
}

function requireBoundedIntegerQuery(
  url: URL,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const raw = url.searchParams.get(key);
  const value = raw === null ? Number.NaN : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw providerError(
      CmemsProviderErrorCode.CONFIGURATION,
      'CMEMS tile coordinate is not allowed',
      false,
    );
  }
  return value;
}

function assertAllowedFeatureQuery(url: URL): void {
  const allowedKeys = new Set([
    'service',
    'request',
    'version',
    'layer',
    'tilematrixset',
    'tilematrix',
    'tilerow',
    'tilecol',
    'i',
    'j',
    'INFOFORMAT',
    'time',
  ]);
  if (url.searchParams.has('elevation')) allowedKeys.add('elevation');
  assertExactQueryKeys(url, allowedKeys);

  const layer = url.searchParams.get('layer')?.split('/');
  if (layer?.length !== 3) {
    throw providerError(
      CmemsProviderErrorCode.CONFIGURATION,
      'CMEMS layer is not allowlisted',
      false,
    );
  }
  const productId = layer[0];
  const datasetId = layer[1];
  const variableId = layer[2];
  if (!productId || !datasetId || !variableId) {
    throw providerError(
      CmemsProviderErrorCode.CONFIGURATION,
      'CMEMS layer is not allowlisted',
      false,
    );
  }
  assertAllowedProductDataset(productId, datasetId);
  assertIdentifier(variableId, VARIABLE_ID_PATTERN, 'variable ID');
  const matrixMaximum = 2 ** CMEMS_TILE_MATRIX - 1;
  requireBoundedIntegerQuery(url, 'tilerow', 0, matrixMaximum);
  requireBoundedIntegerQuery(url, 'tilecol', 0, matrixMaximum);
  requireBoundedIntegerQuery(url, 'i', 0, 255);
  requireBoundedIntegerQuery(url, 'j', 0, 255);

  const time = url.searchParams.get('time');
  if (!time || !time.endsWith('Z') || Number.isNaN(new Date(time).getTime())) {
    throw providerError(
      CmemsProviderErrorCode.CONFIGURATION,
      'CMEMS feature time is invalid',
      false,
    );
  }
  const rawElevation = url.searchParams.get('elevation');
  if (rawElevation !== null) {
    const elevation = Number(rawElevation);
    if (!Number.isFinite(elevation) || elevation > 0) {
      throw providerError(
        CmemsProviderErrorCode.CONFIGURATION,
        'CMEMS model elevation is invalid',
        false,
      );
    }
  }
}

export function buildCmemsCswUrl(product: CmemsProductDefinition): URL {
  const allowlisted = CMEMS_PRODUCTS[product.key];
  if (allowlisted.uuid !== product.uuid || allowlisted.productId !== product.productId) {
    throw providerError(
      CmemsProviderErrorCode.CONFIGURATION,
      'CMEMS CSW product is not allowlisted',
      false,
    );
  }
  const url = new URL(CMEMS_CSW_PATH, CMEMS_CSW_ORIGIN);
  url.searchParams.set('service', 'CSW');
  url.searchParams.set('version', '2.0.2');
  url.searchParams.set('request', 'GetRecordById');
  url.searchParams.set('elementSetName', 'full');
  url.searchParams.set('outputSchema', 'http://www.isotc211.org/2005/gmd');
  url.searchParams.set('id', product.uuid);
  return url;
}

export function buildCmemsCapabilitiesUrl(productId: string, datasetId: string): URL {
  assertIdentifier(productId, PRODUCT_ID_PATTERN, 'product ID');
  assertIdentifier(datasetId, DATASET_BASE_PATTERN, 'dataset ID');
  assertAllowedProductDataset(productId, datasetId);
  const url = new URL(`${CMEMS_WMTS_PATH}/${productId}/${datasetId}`, CMEMS_WMTS_ORIGIN);
  url.searchParams.set('SERVICE', 'WMTS');
  url.searchParams.set('version', '1.0.0');
  url.searchParams.set('REQUEST', 'GetCapabilities');
  return url;
}

export function buildCmemsFeatureInfoUrl(input: {
  productId: string;
  datasetId: string;
  variableId: string;
  latitude: number;
  longitude: number;
  validAt: string;
  modelElevationM: number | null;
}): URL {
  assertIdentifier(input.productId, PRODUCT_ID_PATTERN, 'product ID');
  assertIdentifier(input.datasetId, DATASET_BASE_PATTERN, 'dataset ID');
  assertIdentifier(input.variableId, VARIABLE_ID_PATTERN, 'variable ID');
  assertAllowedProductDataset(input.productId, input.datasetId);
  if (!input.validAt.endsWith('Z') || Number.isNaN(new Date(input.validAt).getTime())) {
    throw providerError(
      CmemsProviderErrorCode.CONFIGURATION,
      'CMEMS feature time is invalid',
      false,
    );
  }
  if (
    input.modelElevationM !== null &&
    (!Number.isFinite(input.modelElevationM) || input.modelElevationM > 0)
  ) {
    throw providerError(
      CmemsProviderErrorCode.CONFIGURATION,
      'CMEMS model elevation is invalid',
      false,
    );
  }
  const pixel = webMercatorPixel(input.latitude, input.longitude, CMEMS_TILE_MATRIX);
  const url = new URL(CMEMS_WMTS_PATH, CMEMS_WMTS_ORIGIN);
  url.searchParams.set('service', 'WMTS');
  url.searchParams.set('request', 'GetFeatureInfo');
  url.searchParams.set('version', '1.0.0');
  url.searchParams.set('layer', `${input.productId}/${input.datasetId}/${input.variableId}`);
  url.searchParams.set('tilematrixset', CMEMS_TILE_MATRIX_SET);
  url.searchParams.set('tilematrix', String(CMEMS_TILE_MATRIX));
  url.searchParams.set('tilerow', String(pixel.tileRow));
  url.searchParams.set('tilecol', String(pixel.tileCol));
  url.searchParams.set('i', String(pixel.i));
  url.searchParams.set('j', String(pixel.j));
  url.searchParams.set('INFOFORMAT', 'application/json');
  if (input.modelElevationM !== null) {
    url.searchParams.set('elevation', String(input.modelElevationM));
  }
  url.searchParams.set('time', input.validAt);
  return url;
}

export interface WebMercatorPixel {
  tileCol: number;
  tileRow: number;
  i: number;
  j: number;
}

export function webMercatorPixel(
  latitude: number,
  longitude: number,
  zoom: number,
): WebMercatorPixel {
  if (!Number.isFinite(latitude) || latitude < -85.05112878 || latitude > 85.05112878) {
    throw new RangeError('latitude must be a finite Web Mercator coordinate');
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError('longitude must be a finite number between -180 and 180');
  }
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 22) {
    throw new RangeError('zoom must be an integer between 0 and 22');
  }

  const tileCount = 2 ** zoom;
  const normalizedLongitude = longitude === 180 ? -180 : longitude;
  const x = ((normalizedLongitude + 180) / 360) * tileCount;
  const radians = (latitude * Math.PI) / 180;
  const y = ((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * tileCount;
  const tileCol = Math.min(tileCount - 1, Math.max(0, Math.floor(x)));
  const tileRow = Math.min(tileCount - 1, Math.max(0, Math.floor(y)));
  return {
    tileCol,
    tileRow,
    i: Math.min(255, Math.max(0, Math.floor((x - Math.floor(x)) * 256))),
    j: Math.min(255, Math.max(0, Math.floor((y - Math.floor(y)) * 256))),
  };
}

@Injectable()
export class CmemsHttpClient {
  private readonly fetchFn: CmemsFetch;
  private readonly clock: CmemsClock;
  private readonly delay: CmemsDelay;
  /**
   * The module-level semaphore bounds aggregate CSW, capabilities and
   * FeatureInfo traffic across every client instance, site, forecast horizon,
   * and retry in this process.
   */
  private readonly outbound = PROCESS_CMEMS_OUTBOUND_SEMAPHORE;

  constructor(
    private readonly circuitBreaker: CircuitBreakerService,
    @Optional() @Inject(CMEMS_FETCH) fetchFn?: CmemsFetch,
    @Optional() @Inject(CMEMS_CLOCK) clock?: CmemsClock,
    @Optional() @Inject(CMEMS_DELAY) delay?: CmemsDelay,
  ) {
    this.fetchFn = fetchFn ?? globalThis.fetch;
    this.clock = clock ?? SYSTEM_CLOCK;
    this.delay = delay ?? SYSTEM_DELAY;
  }

  async getCswRecord(product: CmemsProductDefinition): Promise<CmemsHttpResponse> {
    const endpoint: CmemsEndpoint = {
      kind: 'CSW',
      url: buildCmemsCswUrl(product),
    };
    return this.getText(endpoint, new Set(['application/xml', 'text/xml']));
  }

  async getCapabilities(productId: string, datasetId: string): Promise<CmemsHttpResponse> {
    const endpoint: CmemsEndpoint = {
      kind: 'CAPABILITIES',
      url: buildCmemsCapabilitiesUrl(productId, datasetId),
      productId,
      datasetId,
    };
    return this.getText(endpoint, new Set(['application/xml', 'text/xml']));
  }

  async getFeatureInfo(url: URL): Promise<CmemsJsonResponse> {
    const endpoint: CmemsEndpoint = {
      kind: 'FEATURE_INFO',
      url,
    };
    const result = await this.requestWithRetry(endpoint, CMEMS_MAX_JSON_BYTES);
    if (result.status === 404) {
      return {
        status: 'NO_DATA',
        fetchedAt: result.fetchedAt,
      };
    }
    if (
      result.contentType !== 'application/json' &&
      result.contentType !== 'application/geo+json'
    ) {
      throw cmemsSchemaError('Content-Type');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(result.body);
    } catch (error) {
      throw providerError(CmemsProviderErrorCode.SCHEMA, 'CMEMS returned malformed JSON', false, {
        cause: error,
      });
    }
    return {
      status: 'AVAILABLE',
      payload,
      fetchedAt: result.fetchedAt,
    };
  }

  /** Exposed for invariant-focused endpoint security tests. */
  assertAllowedEndpoint(endpoint: CmemsEndpoint): void {
    const { url } = endpoint;
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw providerError(
        CmemsProviderErrorCode.CONFIGURATION,
        'CMEMS endpoint is not allowed',
        false,
      );
    }

    if (endpoint.kind === 'CSW') {
      assertExactQueryKeys(
        url,
        new Set(['service', 'version', 'request', 'elementSetName', 'outputSchema', 'id']),
      );
      if (
        url.origin !== CMEMS_CSW_ORIGIN ||
        url.pathname !== CMEMS_CSW_PATH ||
        url.searchParams.get('service') !== 'CSW' ||
        url.searchParams.get('version') !== '2.0.2' ||
        url.searchParams.get('request') !== 'GetRecordById' ||
        url.searchParams.get('elementSetName') !== 'full' ||
        url.searchParams.get('outputSchema') !== 'http://www.isotc211.org/2005/gmd' ||
        !Object.values(CMEMS_PRODUCTS).some(
          (product) => product.uuid === url.searchParams.get('id'),
        )
      ) {
        throw providerError(
          CmemsProviderErrorCode.CONFIGURATION,
          'CMEMS CSW endpoint is not allowed',
          false,
        );
      }
      return;
    }

    if (url.origin !== CMEMS_WMTS_ORIGIN) {
      throw providerError(
        CmemsProviderErrorCode.CONFIGURATION,
        'CMEMS WMTS endpoint is not allowed',
        false,
      );
    }

    if (endpoint.kind === 'CAPABILITIES') {
      assertExactQueryKeys(url, new Set(['SERVICE', 'version', 'REQUEST']));
      const expectedPath = `${CMEMS_WMTS_PATH}/${endpoint.productId}/${endpoint.datasetId}`;
      if (
        url.pathname !== expectedPath ||
        url.searchParams.get('SERVICE') !== 'WMTS' ||
        url.searchParams.get('version') !== '1.0.0' ||
        url.searchParams.get('REQUEST') !== 'GetCapabilities'
      ) {
        throw providerError(
          CmemsProviderErrorCode.CONFIGURATION,
          'CMEMS capabilities endpoint is not allowed',
          false,
        );
      }
      assertAllowedProductDataset(endpoint.productId, endpoint.datasetId);
      return;
    }

    const required = {
      service: 'WMTS',
      request: 'GetFeatureInfo',
      version: '1.0.0',
      tilematrixset: CMEMS_TILE_MATRIX_SET,
      tilematrix: String(CMEMS_TILE_MATRIX),
      INFOFORMAT: 'application/json',
    };
    if (url.pathname !== CMEMS_WMTS_PATH) {
      throw providerError(
        CmemsProviderErrorCode.CONFIGURATION,
        'CMEMS feature endpoint is not allowed',
        false,
      );
    }
    for (const [key, value] of Object.entries(required)) {
      if (url.searchParams.get(key) !== value) {
        throw providerError(
          CmemsProviderErrorCode.CONFIGURATION,
          'CMEMS feature endpoint is not allowed',
          false,
        );
      }
    }
    assertAllowedFeatureQuery(url);
  }

  private async getText(
    endpoint: CmemsEndpoint,
    allowedContentTypes: ReadonlySet<string>,
  ): Promise<CmemsHttpResponse> {
    const result = await this.requestWithRetry(endpoint, CMEMS_MAX_XML_BYTES);
    if (result.status === 404) {
      throw providerError(
        CmemsProviderErrorCode.CONFIGURATION,
        'CMEMS metadata endpoint was not found',
        false,
        { httpStatus: 404 },
      );
    }
    if (!allowedContentTypes.has(result.contentType)) {
      throw cmemsSchemaError('Content-Type');
    }
    return {
      body: result.body,
      fetchedAt: result.fetchedAt,
    };
  }

  private async requestWithRetry(
    endpoint: CmemsEndpoint,
    maxBytes: number,
  ): Promise<CmemsCompletedResponse> {
    this.assertAllowedEndpoint(endpoint);
    let lastError: CmemsProviderError | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.circuitBreaker.execute({
          serviceName: CMEMS_BREAKER_SERVICE,
          options: CMEMS_BREAKER_OPTIONS,
          fn: async (): Promise<CmemsCompletedResponse> => this.requestOnce(endpoint, maxBytes),
        });
      } catch (error) {
        if (error instanceof CircuitOpenError) {
          throw providerError(
            CmemsProviderErrorCode.PROVIDER_UNAVAILABLE,
            'CMEMS circuit is open',
            true,
            { cause: error },
          );
        }
        if (!isRetryableProviderError(error)) throw error;
        lastError = error;
        if (attempt === 0 && error.retryAfterMs && error.retryAfterMs > 0) {
          await this.delay.wait(error.retryAfterMs);
        }
      }
    }
    if (!lastError) {
      throw providerError(
        CmemsProviderErrorCode.PROVIDER_UNAVAILABLE,
        'CMEMS request failed',
        true,
      );
    }
    throw lastError;
  }

  private async requestOnce(
    endpoint: CmemsEndpoint,
    maxBytes: number,
  ): Promise<CmemsCompletedResponse> {
    return this.outbound.run(() => this.requestOnceWithPermit(endpoint, maxBytes));
  }

  private async requestOnceWithPermit(
    endpoint: CmemsEndpoint,
    maxBytes: number,
  ): Promise<CmemsCompletedResponse> {
    const timeout = createAbortSignalTimeout(CMEMS_REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchFn(endpoint.url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept:
            endpoint.kind === 'FEATURE_INFO'
              ? 'application/json'
              : 'application/xml, text/xml;q=0.9',
        },
        signal: timeout.signal,
      });
      return await this.completeResponse(
        response,
        maxBytes,
        timeout.signal,
        endpoint.kind === 'FEATURE_INFO'
          ? new Set(['application/json', 'application/geo+json'])
          : new Set(['application/xml', 'text/xml']),
      );
    } catch (error) {
      const timeoutReached = timeout.signal.aborted || isAbortError(error);
      if (!timeoutReached && error instanceof CmemsProviderError) {
        throw error;
      }
      throw providerError(
        timeoutReached ? CmemsProviderErrorCode.TIMEOUT : CmemsProviderErrorCode.TRANSPORT,
        timeoutReached ? 'CMEMS request timed out' : 'CMEMS transport request failed',
        true,
        { cause: error },
      );
    } finally {
      timeout.clear();
    }
  }

  private async completeResponse(
    response: Response,
    maxBytes: number,
    signal: AbortSignal,
    allowedContentTypes: ReadonlySet<string>,
  ): Promise<CmemsCompletedResponse> {
    if (response.status >= 300 && response.status < 400) {
      await cancelResponseBody(response);
      throw providerError(
        CmemsProviderErrorCode.REDIRECT_BLOCKED,
        'CMEMS returned an unexpected redirect',
        false,
        { httpStatus: response.status },
      );
    }
    if (response.status === 404) {
      await cancelResponseBody(response);
      return {
        body: '',
        contentType: '',
        fetchedAt: this.clock.now().toISOString(),
        status: 404,
      };
    }
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMilliseconds(
        response.headers.get('retry-after'),
        this.clock.now(),
      );
      await cancelResponseBody(response);
      throw providerError(CmemsProviderErrorCode.RATE_LIMITED, 'CMEMS rate limit exceeded', true, {
        httpStatus: 429,
        retryAfterMs,
      });
    }
    if (response.status >= 500) {
      await cancelResponseBody(response);
      throw providerError(
        CmemsProviderErrorCode.PROVIDER_UNAVAILABLE,
        'CMEMS upstream service failed',
        true,
        { httpStatus: response.status },
      );
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      throw providerError(
        CmemsProviderErrorCode.CLIENT_REQUEST,
        'CMEMS rejected the request',
        false,
        { httpStatus: response.status },
      );
    }
    const contentType = normalizeContentType(response);
    if (!allowedContentTypes.has(contentType)) {
      await cancelResponseBody(response);
      throw cmemsSchemaError('Content-Type');
    }
    await assertContentLength(response, maxBytes);
    return {
      body: await readBoundedBody(response, maxBytes, signal),
      contentType,
      fetchedAt: this.clock.now().toISOString(),
      status: response.status,
    };
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body) await response.body.cancel();
}

function normalizeContentType(response: Response): string {
  return response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

async function assertContentLength(response: Response, maxBytes: number): Promise<void> {
  const rawLength = response.headers.get('content-length');
  if (rawLength === null) return;
  if (!/^\d+$/u.test(rawLength)) {
    await cancelResponseBody(response);
    throw providerError(
      CmemsProviderErrorCode.SCHEMA,
      'CMEMS response had an invalid content length',
      false,
    );
  }
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
    await cancelResponseBody(response);
    throw providerError(
      CmemsProviderErrorCode.RESPONSE_TOO_LARGE,
      'CMEMS response exceeded the size limit',
      false,
    );
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) throw cmemsSchemaError('body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let byteLength = 0;
  let body = '';
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await readCmemsStreamChunk(reader, signal);
      } catch (error) {
        if (signal.aborted || isAbortError(error)) {
          await reader.cancel().catch(() => undefined);
          throw providerError(
            CmemsProviderErrorCode.TIMEOUT,
            'CMEMS response body timed out',
            true,
            { cause: error },
          );
        }
        throw providerError(
          CmemsProviderErrorCode.TRANSPORT,
          'CMEMS response stream failed',
          true,
          { cause: error },
        );
      }
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw providerError(
          CmemsProviderErrorCode.RESPONSE_TOO_LARGE,
          'CMEMS response exceeded the size limit',
          false,
        );
      }
      try {
        body += decoder.decode(chunk.value, { stream: true });
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw providerError(
          CmemsProviderErrorCode.SCHEMA,
          'CMEMS returned an invalid UTF-8 response',
          false,
          { cause: error },
        );
      }
    }
    try {
      body += decoder.decode();
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw providerError(
        CmemsProviderErrorCode.SCHEMA,
        'CMEMS returned an invalid UTF-8 response',
        false,
        { cause: error },
      );
    }
  } finally {
    reader.releaseLock();
  }
  return body;
}

async function readCmemsStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    throw new DOMException('aborted', 'AbortError');
  }
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error('CMEMS response stream failed'));
      },
    );
  });
}

export interface CmemsDiscoveredProduct {
  product: CmemsProductDefinition;
  datasetIds: Readonly<Record<string, string>>;
  metadataUpdatedAt: string;
  discoveredAt: string;
  stale: boolean;
}

interface CacheEntry<T extends { stale: boolean }> {
  value: T;
  /** Absolute age anchor. Never advanced by stale fallback. */
  storedAtMs: number;
  /** Negative-refresh cooldown. Never extends the absolute stale window. */
  retryNotBeforeMs: number | null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalizeIsoTimestamp(value: string, path: string): string {
  const normalized = value.replace(
    /\.(\d{3})\d+Z$/u,
    (_match, milliseconds: string) => `.${milliseconds}Z`,
  );
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) throw cmemsSchemaError(path);
  return parsed.toISOString();
}

export function parseCmemsCswRecord(
  xml: string,
  product: CmemsProductDefinition,
  discoveredAt: string,
): CmemsDiscoveredProduct {
  if (
    !xml.includes('<csw:GetRecordByIdResponse') ||
    !xml.includes(`<gco:CharacterString>${product.productId}</gco:CharacterString>`)
  ) {
    throw cmemsSchemaError('CSW.productId');
  }
  const dateStampMatch =
    /<gmd:dateStamp>[\s\S]*?<gco:DateTime>([^<]+)<\/gco:DateTime>[\s\S]*?<\/gmd:dateStamp>/u.exec(
      xml,
    ) ?? /<gmd:dateStamp>[\s\S]*?<gco:Date>([^<]+)<\/gco:Date>[\s\S]*?<\/gmd:dateStamp>/u.exec(xml);
  if (!dateStampMatch?.[1]) throw cmemsSchemaError('CSW.dateStamp');
  const metadataUpdatedAt = normalizeIsoTimestamp(dateStampMatch[1], 'CSW.dateStamp');

  const datasetIds: Record<string, string> = {};
  for (const base of product.datasetBases) {
    const urlPattern = new RegExp(
      `<gmd:URL>https:\\/\\/wmts\\.marine\\.copernicus\\.eu\\/teroWmts\\/${escapeRegExp(
        product.productId,
      )}\\/(${escapeRegExp(base)}_(\\d{6}))<\\/gmd:URL>`,
      'gu',
    );
    const matches = Array.from(xml.matchAll(urlPattern));
    const candidates = new Map<string, string>();
    for (const match of matches) {
      const datasetId = match[1];
      const tag = match[2];
      if (datasetId && tag && datasetId === `${base}_${tag}` && DATASET_TAG_PATTERN.test(tag)) {
        candidates.set(tag, datasetId);
      }
    }
    const latestTag = Array.from(candidates.keys()).sort().at(-1);
    if (!latestTag) throw cmemsSchemaError(`CSW.datasets.${base}`);
    const datasetId = candidates.get(latestTag);
    if (!datasetId) throw cmemsSchemaError(`CSW.datasets.${base}`);
    datasetIds[base] = datasetId;
  }

  return {
    product,
    datasetIds,
    metadataUpdatedAt,
    discoveredAt,
    stale: false,
  };
}

@Injectable()
export class CmemsDatasetRegistry {
  private readonly clock: CmemsClock;
  private readonly policy: CmemsCachePolicy;
  private readonly discoveryCache = new Map<CmemsProductKey, CacheEntry<CmemsDiscoveredProduct>>();
  private readonly discoveryInFlight = new Map<CmemsProductKey, Promise<CmemsDiscoveredProduct>>();
  private readonly capabilityCache = new Map<string, CacheEntry<CmemsLayerCapabilities>>();
  private readonly capabilityInFlight = new Map<string, Promise<CmemsLayerCapabilities>>();

  constructor(
    private readonly http: CmemsHttpClient,
    @Optional() @Inject(CMEMS_CLOCK) clock?: CmemsClock,
    @Optional()
    @Inject(CMEMS_CACHE_POLICY)
    policy?: CmemsCachePolicy,
  ) {
    this.clock = clock ?? SYSTEM_CLOCK;
    this.policy = policy ?? DEFAULT_CMEMS_CACHE_POLICY;
    validateCachePolicy(this.policy);
  }

  async resolveProduct(productKey: CmemsProductKey): Promise<CmemsDiscoveredProduct> {
    const cached = this.discoveryCache.get(productKey);
    const nowMs = this.clock.now().getTime();
    if (cached && nowMs - cached.storedAtMs <= this.policy.discoveryFreshMs) {
      return cached.value;
    }
    if (
      cached &&
      cached.retryNotBeforeMs !== null &&
      nowMs < cached.retryNotBeforeMs &&
      nowMs - cached.storedAtMs <= this.policy.discoveryStaleMs
    ) {
      return { ...cached.value, stale: true };
    }
    const active = this.discoveryInFlight.get(productKey);
    if (active) return active;

    const resolution = this.refreshProduct(productKey, cached, nowMs);
    this.discoveryInFlight.set(productKey, resolution);
    try {
      return await resolution;
    } finally {
      this.discoveryInFlight.delete(productKey);
    }
  }

  async resolveCapabilities(input: {
    product: CmemsDiscoveredProduct;
    datasetBase: string;
    variableId: string;
    expectedUnits: readonly string[];
    requiresDepth: boolean;
  }): Promise<CmemsLayerCapabilities> {
    const datasetId = input.product.datasetIds[input.datasetBase];
    if (!datasetId) {
      throw providerError(
        CmemsProviderErrorCode.CONFIGURATION,
        'CMEMS dataset base is not part of the product allowlist',
        false,
      );
    }
    const cacheKey = `${input.product.product.productId}/${datasetId}/${input.variableId}`;
    const cached = this.capabilityCache.get(cacheKey);
    const nowMs = this.clock.now().getTime();
    if (cached && nowMs - cached.storedAtMs <= this.policy.capabilityFreshMs) {
      return cached.value;
    }
    if (
      cached &&
      cached.retryNotBeforeMs !== null &&
      nowMs < cached.retryNotBeforeMs &&
      nowMs - cached.storedAtMs <= this.policy.capabilityStaleMs
    ) {
      return { ...cached.value, stale: true };
    }
    const active = this.capabilityInFlight.get(cacheKey);
    if (active) return active;

    const resolution = this.refreshCapabilities(input, datasetId, cached, nowMs);
    this.capabilityInFlight.set(cacheKey, resolution);
    try {
      return await resolution;
    } finally {
      this.capabilityInFlight.delete(cacheKey);
    }
  }

  private async refreshProduct(
    productKey: CmemsProductKey,
    cached: CacheEntry<CmemsDiscoveredProduct> | undefined,
    nowMs: number,
  ): Promise<CmemsDiscoveredProduct> {
    const product = CMEMS_PRODUCTS[productKey];
    try {
      const response = await this.http.getCswRecord(product);
      const value = parseCmemsCswRecord(response.body, product, response.fetchedAt);
      this.discoveryCache.set(productKey, {
        value,
        storedAtMs: nowMs,
        retryNotBeforeMs: null,
      });
      return value;
    } catch (error) {
      if (
        cached &&
        isRetryableProviderError(error) &&
        nowMs - cached.storedAtMs <= this.policy.discoveryStaleMs
      ) {
        this.discoveryCache.set(productKey, {
          ...cached,
          retryNotBeforeMs: nowMs + this.policy.discoveryFreshMs,
        });
        return { ...cached.value, stale: true };
      }
      throw error;
    }
  }

  private async refreshCapabilities(
    input: {
      product: CmemsDiscoveredProduct;
      datasetBase: string;
      variableId: string;
      expectedUnits: readonly string[];
      requiresDepth: boolean;
    },
    datasetId: string,
    cached: CacheEntry<CmemsLayerCapabilities> | undefined,
    nowMs: number,
  ): Promise<CmemsLayerCapabilities> {
    try {
      const response = await this.http.getCapabilities(input.product.product.productId, datasetId);
      const value = parseCmemsCapabilities(response.body, {
        productId: input.product.product.productId,
        datasetId,
        variableId: input.variableId,
        expectedUnits: input.expectedUnits,
        requiresDepth: input.requiresDepth,
        fetchedAt: response.fetchedAt,
      });
      this.capabilityCache.set(
        `${input.product.product.productId}/${datasetId}/${input.variableId}`,
        { value, storedAtMs: nowMs, retryNotBeforeMs: null },
      );
      return value;
    } catch (error) {
      if (
        cached &&
        isRetryableProviderError(error) &&
        nowMs - cached.storedAtMs <= this.policy.capabilityStaleMs
      ) {
        this.capabilityCache.set(
          `${input.product.product.productId}/${datasetId}/${input.variableId}`,
          {
            ...cached,
            retryNotBeforeMs: nowMs + this.policy.capabilityFreshMs,
          },
        );
        return { ...cached.value, stale: true };
      }
      throw error;
    }
  }
}

function validateCachePolicy(policy: CmemsCachePolicy): void {
  for (const value of Object.values(policy)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw providerError(
        CmemsProviderErrorCode.CONFIGURATION,
        'CMEMS cache policy must use non-negative integer milliseconds',
        false,
      );
    }
  }
  if (
    policy.discoveryStaleMs < policy.discoveryFreshMs ||
    policy.capabilityStaleMs < policy.capabilityFreshMs
  ) {
    throw providerError(
      CmemsProviderErrorCode.CONFIGURATION,
      'CMEMS stale cache windows must include their fresh windows',
      false,
    );
  }
}

export interface CmemsTimeSequence {
  startAt: string;
  endAt: string;
  stepMs: number;
}

export interface CmemsLayerCapabilities {
  layerId: string;
  productId: string;
  datasetId: string;
  variableId: string;
  sourceUnit: string;
  bbox: {
    west: number;
    south: number;
    east: number;
    north: number;
  };
  timeSequences: readonly CmemsTimeSequence[];
  timeInstants: readonly string[];
  defaultTime: string;
  elevationsM: readonly number[];
  defaultElevationM: number | null;
  updatedAt: string;
  dataUpdatedAt: string | null;
  fetchedAt: string;
  stale: boolean;
}

function extractSingle(source: string, pattern: RegExp, path: string): string {
  const matches = Array.from(source.matchAll(pattern));
  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw cmemsSchemaError(path);
  }
  return matches[0][1];
}

function extractLayerBlock(xml: string, layerId: string): string {
  const layers = Array.from(xml.matchAll(/<Layer\b[\s\S]*?<\/Layer>/gu));
  const matching = layers.filter((match) =>
    match[0].includes(`<ows:Identifier>${layerId}</ows:Identifier>`),
  );
  if (matching.length !== 1 || !matching[0]) {
    throw cmemsSchemaError('Capabilities.Layer');
  }
  return matching[0][0];
}

function parseCoordinatePair(value: string, path: string): [number, number] {
  const parts = value.trim().split(/\s+/u).map(Number);
  if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
    throw cmemsSchemaError(path);
  }
  const first = parts[0];
  const second = parts[1];
  if (first === undefined || second === undefined) {
    throw cmemsSchemaError(path);
  }
  return [first, second];
}

function parseDurationMs(value: string, path: string): number {
  const match = ISO_DURATION_PATTERN.exec(value);
  if (!match) throw cmemsSchemaError(path);
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  const milliseconds = ((days * 24 + hours) * 60 * 60 + minutes * 60 + seconds) * 1_000;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw cmemsSchemaError(path);
  }
  return milliseconds;
}

function parseTimeDimension(layer: string): {
  sequences: CmemsTimeSequence[];
  instants: string[];
  defaultTime: string;
} {
  const dimensions = Array.from(layer.matchAll(/<Dimension>[\s\S]*?<\/Dimension>/gu)).map(
    (match) => match[0],
  );
  const time = dimensions.find((block) => block.includes('<ows:Identifier>time</ows:Identifier>'));
  if (!time || !time.includes('<ows:UOM>ISO8601</ows:UOM>')) {
    throw cmemsSchemaError('Capabilities.Dimension.time');
  }
  const defaultTime = normalizeIsoTimestamp(
    extractSingle(time, /<Default>([^<]+)<\/Default>/gu, 'Capabilities.Dimension.time.Default'),
    'Capabilities.Dimension.time.Default',
  );
  const values = Array.from(time.matchAll(/<Value>([^<]+)<\/Value>/gu))
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
  if (values.length === 0) {
    throw cmemsSchemaError('Capabilities.Dimension.time.Value');
  }

  const sequences: CmemsTimeSequence[] = [];
  const instants: string[] = [];
  for (const value of values) {
    const parts = value.split('/');
    if (parts.length === 1) {
      instants.push(normalizeIsoTimestamp(parts[0] ?? '', 'Capabilities.Dimension.time.Value'));
      continue;
    }
    if (parts.length !== 3) {
      throw cmemsSchemaError('Capabilities.Dimension.time.Value');
    }
    const startAt = normalizeIsoTimestamp(
      parts[0] ?? '',
      'Capabilities.Dimension.time.Value.start',
    );
    const endAt = normalizeIsoTimestamp(parts[1] ?? '', 'Capabilities.Dimension.time.Value.end');
    if (new Date(endAt).getTime() < new Date(startAt).getTime()) {
      throw cmemsSchemaError('Capabilities.Dimension.time.Value.range');
    }
    sequences.push({
      startAt,
      endAt,
      stepMs: parseDurationMs(parts[2] ?? '', 'Capabilities.Dimension.time.Value.period'),
    });
  }
  return { sequences, instants, defaultTime };
}

function parseElevationDimension(layer: string): {
  elevationsM: number[];
  defaultElevationM: number | null;
} {
  const dimensions = Array.from(layer.matchAll(/<Dimension>[\s\S]*?<\/Dimension>/gu)).map(
    (match) => match[0],
  );
  const elevation = dimensions.find((block) =>
    block.includes('<ows:Identifier>elevation</ows:Identifier>'),
  );
  if (!elevation) return { elevationsM: [], defaultElevationM: null };
  if (!elevation.includes('<UnitSymbol>m</UnitSymbol>')) {
    throw cmemsSchemaError('Capabilities.Dimension.elevation.UnitSymbol');
  }
  const values = Array.from(elevation.matchAll(/<Value>([^<]+)<\/Value>/gu)).map((match) =>
    Number(match[1]),
  );
  if (values.length === 0 || values.some((value) => !Number.isFinite(value) || value > 0)) {
    throw cmemsSchemaError('Capabilities.Dimension.elevation.Value');
  }
  const rawDefault = extractSingle(
    elevation,
    /<Default>([^<]+)<\/Default>/gu,
    'Capabilities.Dimension.elevation.Default',
  );
  const defaultElevationM = Number(rawDefault);
  if (!Number.isFinite(defaultElevationM) || !values.includes(defaultElevationM)) {
    throw cmemsSchemaError('Capabilities.Dimension.elevation.Default');
  }
  return {
    elevationsM: Array.from(new Set(values)).sort((left, right) => left - right),
    defaultElevationM,
  };
}

export function parseCmemsCapabilities(
  xml: string,
  expected: {
    productId: string;
    datasetId: string;
    variableId: string;
    expectedUnits: readonly string[];
    requiresDepth: boolean;
    fetchedAt: string;
  },
): CmemsLayerCapabilities {
  const layerId = `${expected.productId}/${expected.datasetId}/${expected.variableId}`;
  if (
    !xml.includes('<Capabilities') ||
    !xml.includes(
      `<ows:Title>Copernicus Marine Data Store - ${expected.productId}/${expected.datasetId}</ows:Title>`,
    )
  ) {
    throw cmemsSchemaError('Capabilities.ServiceIdentification');
  }
  const layer = extractLayerBlock(xml, layerId);
  if (!layer.includes('<InfoFormat>application/json</InfoFormat>')) {
    throw cmemsSchemaError('Capabilities.Layer.InfoFormat');
  }
  if (
    !layer.includes(`<TileMatrixSet>${CMEMS_TILE_MATRIX_SET}</TileMatrixSet>`) ||
    !xml.includes('<ows:SupportedCRS>urn:ogc:def:crs:EPSG::3857</ows:SupportedCRS>') ||
    !xml.includes(`<ows:Identifier>${CMEMS_TILE_MATRIX}</ows:Identifier>`)
  ) {
    throw cmemsSchemaError('Capabilities.TileMatrixSet.EPSG3857');
  }

  const lower = parseCoordinatePair(
    extractSingle(
      layer,
      /<ows:LowerCorner>([^<]+)<\/ows:LowerCorner>/gu,
      'Capabilities.Layer.WGS84BoundingBox.LowerCorner',
    ),
    'Capabilities.Layer.WGS84BoundingBox.LowerCorner',
  );
  const upper = parseCoordinatePair(
    extractSingle(
      layer,
      /<ows:UpperCorner>([^<]+)<\/ows:UpperCorner>/gu,
      'Capabilities.Layer.WGS84BoundingBox.UpperCorner',
    ),
    'Capabilities.Layer.WGS84BoundingBox.UpperCorner',
  );
  if (
    lower[0] < -180 ||
    lower[1] < -90 ||
    upper[0] > 180 ||
    upper[1] > 90 ||
    lower[0] >= upper[0] ||
    lower[1] >= upper[1]
  ) {
    throw cmemsSchemaError('Capabilities.Layer.WGS84BoundingBox');
  }

  const variableMetadata = extractSingle(
    layer,
    /<VariableInformation>([\s\S]*?)<\/VariableInformation>/gu,
    'Capabilities.Layer.VariableInformation',
  );
  const variableId = extractSingle(
    variableMetadata,
    /<Id>([^<]+)<\/Id>/gu,
    'Capabilities.Layer.VariableInformation.Id',
  );
  if (variableId !== expected.variableId) {
    throw cmemsSchemaError('Capabilities.Layer.VariableInformation.Id');
  }
  const sourceUnit = extractSingle(
    variableMetadata,
    /<Unit>([^<]+)<\/Unit>/gu,
    'Capabilities.Layer.VariableInformation.Unit',
  );
  if (!expected.expectedUnits.includes(sourceUnit)) {
    throw cmemsSchemaError('Capabilities.Layer.VariableInformation.Unit');
  }
  const dataCube = extractSingle(
    layer,
    /<DataCubeInformation>([\s\S]*?)<\/DataCubeInformation>/gu,
    'Capabilities.Layer.DataCubeInformation',
  );
  const updatedAt = normalizeIsoTimestamp(
    extractSingle(
      dataCube,
      /<admp_updated>([^<]+)<\/admp_updated>/gu,
      'Capabilities.Layer.DataCubeInformation.admp_updated',
    ),
    'Capabilities.Layer.DataCubeInformation.admp_updated',
  );
  const dataUpdatedMatch = /<admp_updated_data>([^<]+)<\/admp_updated_data>/u.exec(dataCube);
  const dataUpdatedAt = dataUpdatedMatch?.[1]
    ? normalizeIsoTimestamp(
        dataUpdatedMatch[1],
        'Capabilities.Layer.DataCubeInformation.admp_updated_data',
      )
    : null;
  const time = parseTimeDimension(layer);
  const elevation = parseElevationDimension(layer);
  if (expected.requiresDepth && elevation.elevationsM.length === 0) {
    throw cmemsSchemaError('Capabilities.Dimension.elevation');
  }
  if (!expected.requiresDepth && elevation.elevationsM.length > 0) {
    throw cmemsSchemaError('Capabilities.Dimension.elevation');
  }

  return {
    layerId,
    productId: expected.productId,
    datasetId: expected.datasetId,
    variableId,
    sourceUnit,
    bbox: {
      west: lower[0],
      south: lower[1],
      east: upper[0],
      north: upper[1],
    },
    timeSequences: time.sequences,
    timeInstants: time.instants,
    defaultTime: time.defaultTime,
    elevationsM: elevation.elevationsM,
    defaultElevationM: elevation.defaultElevationM,
    updatedAt,
    dataUpdatedAt,
    fetchedAt: expected.fetchedAt,
    stale: false,
  };
}

export function selectNearestCmemsTime(
  capabilities: CmemsLayerCapabilities,
  requestedAt: Date,
): string | null {
  const requestedMs = requestedAt.getTime();
  if (!Number.isFinite(requestedMs)) {
    throw new RangeError('requestedAt must be a valid date');
  }
  const candidates: number[] = capabilities.timeInstants
    .map((instant) => new Date(instant).getTime())
    .filter((instantMs) => instantMs === requestedMs);
  for (const sequence of capabilities.timeSequences) {
    const startMs = new Date(sequence.startAt).getTime();
    const endMs = new Date(sequence.endAt).getTime();
    if (requestedMs < startMs || requestedMs > endMs) {
      continue;
    }
    const stepIndex = Math.round((requestedMs - startMs) / sequence.stepMs);
    const selectedMs = startMs + stepIndex * sequence.stepMs;
    const toleranceMs = sequence.stepMs / 2;
    if (
      selectedMs >= startMs &&
      selectedMs <= endMs &&
      Math.abs(selectedMs - requestedMs) <= toleranceMs
    ) {
      candidates.push(selectedMs);
    }
  }
  const finiteCandidates = candidates.filter(Number.isFinite);
  if (finiteCandidates.length === 0) return null;
  finiteCandidates.sort((left, right) => {
    const distance = Math.abs(left - requestedMs) - Math.abs(right - requestedMs);
    return distance === 0 ? left - right : distance;
  });
  const selected = finiteCandidates[0];
  return selected === undefined ? null : new Date(selected).toISOString();
}

export function selectNearestCmemsElevation(
  capabilities: CmemsLayerCapabilities,
  requestedDepthM: number,
): number | null {
  if (!Number.isFinite(requestedDepthM) || requestedDepthM < 0) {
    throw new RangeError('requestedDepthM must be a non-negative finite number');
  }
  if (capabilities.elevationsM.length === 0) return null;
  const target = -requestedDepthM;
  return (
    [...capabilities.elevationsM].sort((left, right) => {
      const distance = Math.abs(left - target) - Math.abs(right - target);
      return distance === 0 ? right - left : distance;
    })[0] ?? null
  );
}

export function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireFiniteCmemsNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw cmemsSchemaError(path);
  }
  return value;
}
