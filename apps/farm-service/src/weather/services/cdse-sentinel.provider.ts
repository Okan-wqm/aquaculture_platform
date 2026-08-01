import { createHash } from 'node:crypto';

import { MARINE_BINARY_MAX_RESPONSE_BYTES } from '@aquaculture/backend-common/http';
import { RedisService } from '@aquaculture/backend-common/redis';
import {
  CircuitBreakerService,
  CircuitOpenError,
  DEFAULT_BREAKER_OPTIONS,
} from '@aquaculture/backend-common/resilience';
import { createAbortSignalTimeout } from '@aquaculture/backend-common/utils';
import { Inject, Injectable, Optional } from '@nestjs/common';

import { MonitoringAreaGeometry, MonitoringPosition } from '../../site/entities/site.entity';
import {
  CdseTokenError,
  CdseTokenErrorCode,
  SentinelHubService,
} from '../../sentinel-hub/sentinel-hub.service';
import {
  SentinelProductKey,
  getSentinelProcessProduct,
} from '../../sentinel-hub/sentinel-product-registry';
import {
  EnvironmentProvider,
  EnvironmentQualityStatus,
  SatelliteCoverageStatus,
} from '../entities/environment-observation.types';
import { CdseRenderAdmission, CdseRenderAdmissionError } from './cdse-render-admission';
import { parseProviderRetryAfterMs } from './provider-http-headers';

export const CDSE_FETCH = Symbol('CDSE_FETCH');
export const CDSE_CLOCK = Symbol('CDSE_CLOCK');
export const CDSE_DELAY = Symbol('CDSE_DELAY');
export const CDSE_RENDER_ADMISSION = Symbol('CDSE_RENDER_ADMISSION');

export const CDSE_ORIGIN = 'https://sh.dataspace.copernicus.eu';
export const CDSE_CATALOG_PATH = '/catalog/v1/search';
export const CDSE_PROCESS_PATH = '/process/v1';
export const CDSE_SENTINEL_2_COLLECTION = 'sentinel-2-l2a';
export const CDSE_REQUEST_TIMEOUT_MS = 30_000;
export const CDSE_MAX_CATALOG_BYTES = 2 * 1024 * 1024;
export const CDSE_MAX_IMAGE_BYTES = MARINE_BINARY_MAX_RESPONSE_BYTES;
export const CDSE_MAX_REQUEST_BYTES = 128 * 1024;
export const CDSE_MAX_CATALOG_DAYS = 30;
export const CDSE_MAX_PAGE_SIZE = 100;
export const CDSE_MAX_PAGES = 3;
export const CDSE_MAX_SCENES = 100;
export const CDSE_CLOUD_OBSCURED_PERCENT = 80;
export const CDSE_VALID_CLOUD_PERCENT = 20;
export const CDSE_COVERAGE_METHOD = 'TOPOLOGY_WITH_16_X_16_STRATIFIED_GRID_V3';
export const CDSE_MAX_FEATURE_GEOMETRY_POSITIONS = 64;
export const CDSE_COVERAGE_BATCH_SIZE = 4;
export const CDSE_MAX_COVERAGE_COMPLEXITY = 4_096;

const CDSE_BREAKER_OPTIONS = {
  ...DEFAULT_BREAKER_OPTIONS,
  failureMode: 'fail-closed' as const,
};
const CATALOG_CONTENT_TYPES = new Set(['application/json', 'application/geo+json']);
const IMAGE_CONTENT_TYPES = new Set(['image/png']);
const COVERAGE_GRID_SIZE = 16;
const MAX_RETRY_AFTER_MS = 2_000;
const MAX_RENDER_PIXELS = 4_194_304;
const MIN_RENDER_DIMENSION = 64;
const MAX_RENDER_DIMENSION = 2_048;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export interface CdseFetch {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface CdseClock {
  now(): Date;
}

export interface CdseDelay {
  wait(milliseconds: number): Promise<void>;
}

export interface CdseAccessTokenProvider {
  getAccessToken(tenantId: string): Promise<{ accessToken: string; expiresIn: number } | null>;
}

export enum CdseProviderErrorCode {
  CONFIGURATION = 'CONFIGURATION',
  CREDENTIAL_SERVICE = 'CREDENTIAL_SERVICE',
  AUTHENTICATION = 'AUTHENTICATION',
  CLIENT_REQUEST = 'CLIENT_REQUEST',
  RATE_LIMITED = 'RATE_LIMITED',
  UPSTREAM = 'UPSTREAM',
  TIMEOUT = 'TIMEOUT',
  TRANSPORT = 'TRANSPORT',
  SCHEMA = 'SCHEMA',
  RESPONSE_TOO_LARGE = 'RESPONSE_TOO_LARGE',
  REDIRECT_BLOCKED = 'REDIRECT_BLOCKED',
  CIRCUIT_OPEN = 'CIRCUIT_OPEN',
  SCENE_MISMATCH = 'SCENE_MISMATCH',
  SATURATED = 'SATURATED',
  CANCELLED = 'CANCELLED',
}

export interface CdseProviderErrorOptions {
  readonly code: CdseProviderErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

export class CdseProviderError extends Error {
  readonly code: CdseProviderErrorCode;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly providerCause?: unknown;

  constructor(options: CdseProviderErrorOptions) {
    super(options.message);
    this.name = 'CdseProviderError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.httpStatus = options.httpStatus;
    this.retryAfterMs = options.retryAfterMs;
    this.providerCause = options.cause;
  }
}

export type CdseCoverageStatus = Exclude<
  SatelliteCoverageStatus,
  typeof SatelliteCoverageStatus.UNKNOWN
>;

export interface CdseSceneCoverage {
  readonly status: CdseCoverageStatus;
  /**
   * FULL and OUT_OF_COVERAGE are exact topological results (100 and 0).
   * PARTIAL is a deterministic AOI-area estimate. It is null when the
   * versioned sampling grid cannot resolve a sufficiently narrow overlap.
   */
  readonly percent: number | null;
  readonly method: typeof CDSE_COVERAGE_METHOD;
  readonly aoiSampleCount: number;
}

export interface CdseSceneObservationCandidate {
  readonly tenantId: string;
  readonly siteId: string;
  readonly sceneId: string;
  readonly collection: typeof CDSE_SENTINEL_2_COLLECTION;
  readonly provider: EnvironmentProvider.CDSE_SENTINEL_2;
  readonly productId: string;
  readonly datasetId: typeof CDSE_SENTINEL_2_COLLECTION;
  readonly acquiredAt: string;
  readonly cloudCoverPercent: number;
  readonly coveragePercent: number | null;
  readonly coverageStatus: CdseCoverageStatus;
  readonly coverageMethod: typeof CDSE_COVERAGE_METHOD;
  /**
   * AOI sample points evaluated. Zero means topology was exact or the grid
   * could not resolve a usable point; coverageStatus disambiguates the cases.
   */
  readonly coverageSampleCount: number;
  readonly qualityStatus: EnvironmentQualityStatus;
  readonly monitoringLocationRevision: number;
  readonly fetchedAt: string;
  readonly cursor: string;
}

export interface CdseSceneCatalogInput {
  readonly tenantId: string;
  readonly siteId: string;
  readonly monitoringLocationRevision: number;
  readonly geometry: MonitoringAreaGeometry;
  readonly from: Date;
  readonly to: Date;
  readonly limit?: number;
  readonly maxCloudCoverPercent?: number;
}

export interface CdseSceneCatalogResult {
  readonly scenes: readonly CdseSceneObservationCandidate[];
  readonly hasMore: boolean;
  readonly endCursor: string | null;
}

export interface CdseCataloguedSceneReference {
  readonly sceneId: string;
  readonly collection: string;
  readonly acquiredAt: Date;
}

export interface CdseRenderSceneInput {
  readonly tenantId: string;
  readonly siteId: string;
  readonly monitoringLocationRevision: number;
  readonly geometry: MonitoringAreaGeometry;
  readonly scene: CdseCataloguedSceneReference;
  readonly product: SentinelProductKey;
  readonly width: number;
  readonly height: number;
  readonly signal?: AbortSignal;
}

export interface CdseRenderedScene {
  readonly status: number;
  readonly contentType: 'image/png';
  readonly contentLength: number | null;
  readonly body: ReadableStream<Uint8Array>;
  readonly sceneId: string;
  readonly validAt: Date;
  readonly dispose: () => void;
}

interface CdseCatalogFeature {
  readonly id: string;
  readonly collection: typeof CDSE_SENTINEL_2_COLLECTION;
  readonly geometry: MonitoringAreaGeometry;
  readonly acquiredAt: string;
  readonly cloudCoverPercent: number;
  readonly geometryPositionCount: number;
}

interface CdseCatalogPage {
  readonly features: readonly CdseCatalogFeature[];
  readonly next: string | number | null;
}

interface CdseCoverageContext {
  readonly aoi: MonitoringAreaGeometry;
  readonly bbox: readonly [number, number, number, number];
  readonly samplePoints: readonly MonitoringPosition[];
}

interface CatalogSearchOptions {
  readonly geometry: MonitoringAreaGeometry;
  readonly fromIso: string;
  readonly toIso: string;
  readonly limit: number;
  readonly maxCloudCoverPercent?: number;
  readonly ids?: readonly string[];
  readonly next?: string | number;
}

interface CompletedResponse {
  readonly response: Response;
  readonly timeout: ReturnType<typeof createAbortSignalTimeout>;
  readonly signal: AbortSignal;
}

const SYSTEM_CLOCK: CdseClock = {
  now: (): Date => new Date(),
};

const SYSTEM_DELAY: CdseDelay = {
  wait: async (milliseconds: number): Promise<void> => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  },
};

const PROCESS_RENDER_ADMISSION = new CdseRenderAdmission();

@Injectable()
export class CdseSentinelProvider {
  private readonly fetchFn: CdseFetch;
  private readonly clock: CdseClock;
  private readonly delay: CdseDelay;
  private readonly renderAdmission: CdseRenderAdmission;

  constructor(
    @Inject(SentinelHubService)
    private readonly tokenProvider: CdseAccessTokenProvider,
    private readonly circuitBreaker: CircuitBreakerService,
    @Optional() @Inject(CDSE_FETCH) fetchFn?: CdseFetch,
    @Optional() @Inject(CDSE_CLOCK) clock?: CdseClock,
    @Optional() @Inject(CDSE_DELAY) delay?: CdseDelay,
    @Optional()
    @Inject(CDSE_RENDER_ADMISSION)
    renderAdmission?: CdseRenderAdmission,
    @Optional() @Inject(RedisService) redisService?: RedisService,
  ) {
    this.fetchFn = fetchFn ?? globalThis.fetch;
    this.clock = clock ?? SYSTEM_CLOCK;
    this.delay = delay ?? SYSTEM_DELAY;
    this.renderAdmission =
      renderAdmission ??
      (redisService ? new CdseRenderAdmission(redisService.getClient()) : PROCESS_RENDER_ADMISSION);
  }

  async searchScenes(input: CdseSceneCatalogInput): Promise<CdseSceneCatalogResult> {
    assertTenantScopedCatalogInput(input, this.clock.now());
    const accessToken = await this.requireAccessToken(input.tenantId);
    const requestedLimit = input.limit ?? CDSE_MAX_PAGE_SIZE;
    const features = new Map<string, CdseCatalogFeature>();
    let next: string | number | null = null;
    let pageCount = 0;
    let providerHasMore = false;

    do {
      const remaining = Math.min(requestedLimit - features.size, CDSE_MAX_SCENES - features.size);
      if (remaining <= 0) {
        providerHasMore = next !== null;
        break;
      }
      const page = await this.searchCatalogPage(input.tenantId, accessToken, {
        geometry: input.geometry,
        fromIso: input.from.toISOString(),
        toIso: input.to.toISOString(),
        limit: Math.min(remaining, CDSE_MAX_PAGE_SIZE),
        ...(input.maxCloudCoverPercent === undefined
          ? {}
          : { maxCloudCoverPercent: input.maxCloudCoverPercent }),
        ...(next === null ? {} : { next }),
      });
      pageCount += 1;
      for (const feature of page.features) {
        const existing = features.get(feature.id);
        if (
          existing &&
          (existing.acquiredAt !== feature.acquiredAt || existing.collection !== feature.collection)
        ) {
          throw cdseError(
            CdseProviderErrorCode.SCHEMA,
            'CDSE catalog returned conflicting records for one scene identifier',
            false,
          );
        }
        features.set(feature.id, feature);
      }
      next = page.next;
      providerHasMore = next !== null;
    } while (
      next !== null &&
      pageCount < CDSE_MAX_PAGES &&
      features.size < requestedLimit &&
      features.size < CDSE_MAX_SCENES
    );

    const coverageComplexity = [...features.values()].reduce(
      (total, feature) => total + feature.geometryPositionCount,
      0,
    );
    if (coverageComplexity > CDSE_MAX_COVERAGE_COMPLEXITY) {
      throw cdseError(
        CdseProviderErrorCode.SCHEMA,
        'CDSE catalog exceeded the bounded geometry processing budget',
        false,
      );
    }
    const fetchedAt = this.clock.now().toISOString();
    const coverageContext = createCoverageContext(input.geometry);
    const candidates: CdseSceneObservationCandidate[] = [];
    let candidateIndex = 0;
    for (const feature of features.values()) {
      candidates.push(this.toObservationCandidate(input, feature, fetchedAt, coverageContext));
      candidateIndex += 1;
      if (candidateIndex % CDSE_COVERAGE_BATCH_SIZE === 0) {
        await yieldToEventLoop();
      }
    }
    const scenes = candidates.sort(compareSceneCandidates).slice(0, requestedLimit);

    return Object.freeze({
      scenes: Object.freeze(scenes),
      hasMore: providerHasMore || features.size > scenes.length,
      endCursor: scenes.length === 0 ? null : scenes[scenes.length - 1]!.cursor,
    });
  }

  async renderScene(input: CdseRenderSceneInput): Promise<CdseRenderedScene> {
    assertRenderInput(input);
    const product = getSentinelProcessProduct(input.product);
    if (!product || product.collection !== CDSE_SENTINEL_2_COLLECTION) {
      throw cdseError(
        CdseProviderErrorCode.CONFIGURATION,
        'Sentinel rendering product is not in the backend allowlist',
        false,
      );
    }
    let releaseAdmission: (() => void) | null = null;
    try {
      releaseAdmission = await this.renderAdmission.acquire(
        input.tenantId,
        renderFlightKey(input),
        input.signal,
      );
    } catch (error) {
      if (error instanceof CdseRenderAdmissionError) {
        throw cdseError(
          error.reason === 'CANCELLED'
            ? CdseProviderErrorCode.CANCELLED
            : CdseProviderErrorCode.SATURATED,
          error.message,
          error.reason !== 'CANCELLED',
          { cause: error },
        );
      }
      throw error;
    }

    try {
      const accessToken = await this.requireAccessToken(input.tenantId);
      this.assertNotCancelled(input.signal);
      const { feature: exactFeature, coverage } = await this.requireExactScene(input, accessToken);
      if (coverage.status === 'OUT_OF_COVERAGE') {
        throw cdseError(
          CdseProviderErrorCode.SCENE_MISMATCH,
          'The catalogued scene does not cover the current site monitoring area',
          false,
        );
      }

      const endpoint = cdseEndpoint('PROCESS');
      const acquiredAt = new Date(exactFeature.acquiredAt);
      const to = new Date(acquiredAt.getTime() + 1);
      const requestBody = {
        input: {
          bounds: {
            geometry: input.geometry,
            properties: {
              crs: 'http://www.opengis.net/def/crs/EPSG/0/4326',
            },
          },
          data: [
            {
              type: CDSE_SENTINEL_2_COLLECTION,
              dataFilter: {
                timeRange: {
                  from: exactFeature.acquiredAt,
                  to: to.toISOString(),
                },
                mosaickingOrder: 'mostRecent',
                maxCloudCoverage: Math.ceil(exactFeature.cloudCoverPercent),
              },
            },
          ],
        },
        output: {
          width: input.width,
          height: input.height,
          responses: [
            {
              identifier: 'default',
              format: { type: 'image/png' },
            },
          ],
        },
        evalscript: product.evalscript,
      };
      const serializedBody = serializeBoundedRequest(requestBody);
      const completed = await this.requestWithRetry(
        input.tenantId,
        'cdse-processing-api',
        endpoint,
        accessToken,
        serializedBody,
        'image/png',
        input.signal,
      );

      try {
        assertSuccessfulImageResponse(completed.response);
        const body = completed.response.body;
        if (!body) {
          throw cdseError(
            CdseProviderErrorCode.SCHEMA,
            'CDSE processing response had no image body',
            false,
          );
        }
        const contentLength = parseContentLength(completed.response, CDSE_MAX_IMAGE_BYTES);
        const finalize = once((): void => {
          completed.timeout.abort();
          completed.timeout.clear();
          releaseAdmission?.();
          releaseAdmission = null;
        });
        return Object.freeze({
          status: completed.response.status,
          contentType: 'image/png' as const,
          contentLength,
          body: boundedReadableStream(
            body,
            CDSE_MAX_IMAGE_BYTES,
            completed.signal,
            input.signal,
            finalize,
          ),
          sceneId: exactFeature.id,
          validAt: acquiredAt,
          dispose: finalize,
        });
      } catch (error) {
        completed.timeout.abort();
        completed.timeout.clear();
        throw error;
      }
    } catch (error) {
      releaseAdmission?.();
      releaseAdmission = null;
      throw error;
    }
  }

  private async requireExactScene(
    input: CdseRenderSceneInput,
    accessToken: string,
  ): Promise<{ readonly feature: CdseCatalogFeature; readonly coverage: CdseSceneCoverage }> {
    const expectedAcquisition = requireValidDate(
      'scene.acquiredAt',
      input.scene.acquiredAt,
    ).toISOString();
    const acquisitionEnd = new Date(input.scene.acquiredAt.getTime() + 1).toISOString();
    const identityPage = await this.searchCatalogPage(input.tenantId, accessToken, {
      geometry: input.geometry,
      fromIso: expectedAcquisition,
      toIso: acquisitionEnd,
      ids: [input.scene.sceneId],
      limit: 2,
      signal: input.signal,
    });
    const matching = identityPage.features.filter((feature) => feature.id === input.scene.sceneId);
    if (
      matching.length !== 1 ||
      matching[0]!.collection !== input.scene.collection ||
      matching[0]!.acquiredAt !== expectedAcquisition
    ) {
      throw cdseError(
        CdseProviderErrorCode.SCENE_MISMATCH,
        'The requested scene no longer matches the CDSE catalogue record',
        false,
      );
    }

    /*
     * Sentinel Hub Processing accepts an acquisition time range but no STAC
     * item identifier. Prove the 1 ms AOI acquisition is unambiguous before
     * attributing the returned bytes to the persisted scene ID. If two
     * overlapping Sentinel tiles share the timestamp, rendering is rejected
     * instead of publishing false X-Environment-Scene-Id provenance.
     */
    const acquisitionPage = await this.searchCatalogPage(input.tenantId, accessToken, {
      geometry: input.geometry,
      fromIso: expectedAcquisition,
      toIso: acquisitionEnd,
      limit: CDSE_MAX_PAGE_SIZE,
      signal: input.signal,
    });
    if (
      acquisitionPage.next !== null ||
      acquisitionPage.features.length !== 1 ||
      acquisitionPage.features[0]!.id !== input.scene.sceneId
    ) {
      throw cdseError(
        CdseProviderErrorCode.SCENE_MISMATCH,
        'The catalogued acquisition is ambiguous for this site area',
        false,
      );
    }
    const feature = acquisitionPage.features[0]!;
    return {
      feature,
      coverage: calculateCoverageWithContext(
        createCoverageContext(input.geometry),
        feature.geometry,
      ),
    };
  }

  private async searchCatalogPage(
    tenantId: string,
    accessToken: string,
    options: CatalogSearchOptions & { readonly signal?: AbortSignal },
  ): Promise<CdseCatalogPage> {
    const endpoint = cdseEndpoint('CATALOG');
    const body = {
      collections: [CDSE_SENTINEL_2_COLLECTION],
      intersects: options.geometry,
      datetime: `${options.fromIso}/${options.toIso}`,
      limit: options.limit,
      ...(options.ids === undefined ? {} : { ids: [...options.ids] }),
      ...(options.maxCloudCoverPercent === undefined
        ? {}
        : {
            filter: {
              op: '<=',
              args: [{ property: 'eo:cloud_cover' }, options.maxCloudCoverPercent],
            },
            'filter-lang': 'cql2-json',
          }),
      ...(options.next === undefined ? {} : { next: options.next }),
    };
    const serializedBody = serializeBoundedRequest(body);
    assertCdseEndpointAllowed(endpoint, 'CATALOG');
    return this.executeWithRetry(
      tenantId,
      'cdse-catalog-api',
      async (): Promise<CdseCatalogPage> => {
        const completed = await this.requestOnce(
          endpoint,
          accessToken,
          serializedBody,
          'application/json',
          options.signal,
        );
        try {
          const payload = await readBoundedJson(
            completed.response,
            CDSE_MAX_CATALOG_BYTES,
            completed.signal,
            options.signal,
          );
          const page = parseCatalogPage(payload, options.limit);
          assertCatalogPageWithinRequest(page, options);
          return page;
        } finally {
          completed.timeout.abort();
          completed.timeout.clear();
        }
      },
      options.signal,
    );
  }

  private toObservationCandidate(
    input: CdseSceneCatalogInput,
    feature: CdseCatalogFeature,
    fetchedAt: string,
    coverageContext: CdseCoverageContext,
  ): CdseSceneObservationCandidate {
    const coverage = calculateCoverageWithContext(coverageContext, feature.geometry);
    const qualityStatus = classifySceneQuality(coverage.status, feature.cloudCoverPercent);
    return Object.freeze({
      tenantId: input.tenantId,
      siteId: input.siteId,
      sceneId: feature.id,
      collection: feature.collection,
      provider: EnvironmentProvider.CDSE_SENTINEL_2,
      productId: feature.id,
      datasetId: CDSE_SENTINEL_2_COLLECTION,
      acquiredAt: feature.acquiredAt,
      cloudCoverPercent: feature.cloudCoverPercent,
      coveragePercent: coverage.percent,
      coverageStatus: coverage.status,
      coverageMethod: coverage.method,
      coverageSampleCount: coverage.aoiSampleCount,
      qualityStatus,
      monitoringLocationRevision: input.monitoringLocationRevision,
      fetchedAt,
      cursor: encodeSceneCursor(feature.acquiredAt, feature.id),
    });
  }

  private async requireAccessToken(tenantId: string): Promise<string> {
    let resolved: { accessToken: string; expiresIn: number } | null;
    try {
      resolved = await this.tokenProvider.getAccessToken(tenantId);
    } catch (error) {
      if (error instanceof CdseTokenError) {
        throw cdseError(
          mapTokenErrorCode(error.code),
          'CDSE token acquisition failed',
          error.retryable,
          {
            ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
            ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
            cause: error,
          },
        );
      }
      throw cdseError(
        CdseProviderErrorCode.TRANSPORT,
        'CDSE token acquisition failed without a classified result',
        true,
        { cause: error },
      );
    }
    if (!resolved) {
      throw cdseError(
        CdseProviderErrorCode.CONFIGURATION,
        'CDSE credentials are not configured',
        false,
      );
    }
    if (
      resolved.accessToken.length === 0 ||
      !Number.isSafeInteger(resolved.expiresIn) ||
      resolved.expiresIn <= 0
    ) {
      throw cdseError(
        CdseProviderErrorCode.SCHEMA,
        'CDSE token provider returned an invalid token contract',
        false,
      );
    }
    return resolved.accessToken;
  }

  private async requestWithRetry(
    tenantId: string,
    breakerServiceName: string,
    endpoint: URL,
    accessToken: string,
    body: string,
    accept: string,
    signal?: AbortSignal,
  ): Promise<CompletedResponse> {
    assertCdseEndpointAllowed(
      endpoint,
      endpoint.pathname === CDSE_CATALOG_PATH ? 'CATALOG' : 'PROCESS',
    );
    return this.executeWithRetry(
      tenantId,
      breakerServiceName,
      async (): Promise<CompletedResponse> =>
        this.requestOnce(endpoint, accessToken, body, accept, signal),
      signal,
    );
  }

  private async executeWithRetry<T>(
    tenantId: string,
    breakerServiceName: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let lastError: CdseProviderError | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.assertNotCancelled(signal);
      try {
        return await this.circuitBreaker.execute({
          serviceName: breakerServiceName,
          tenantId,
          options: CDSE_BREAKER_OPTIONS,
          fn: operation,
        });
      } catch (error) {
        if (error instanceof CircuitOpenError) {
          throw cdseError(
            CdseProviderErrorCode.CIRCUIT_OPEN,
            'CDSE provider circuit is open',
            true,
            { cause: error },
          );
        }
        if (!(error instanceof CdseProviderError) || !error.retryable) {
          throw error;
        }
        lastError = error;
        if (attempt === 0 && error.retryAfterMs !== undefined && error.retryAfterMs > 0) {
          await this.delay.wait(error.retryAfterMs);
          this.assertNotCancelled(signal);
        }
      }
    }
    throw (
      lastError ?? cdseError(CdseProviderErrorCode.UPSTREAM, 'CDSE provider request failed', true)
    );
  }

  private async requestOnce(
    endpoint: URL,
    accessToken: string,
    body: string,
    accept: string,
    externalSignal?: AbortSignal,
  ): Promise<CompletedResponse> {
    const timeout = createAbortSignalTimeout(CDSE_REQUEST_TIMEOUT_MS);
    const signal =
      externalSignal === undefined
        ? timeout.signal
        : AbortSignal.any([timeout.signal, externalSignal]);
    let response: Response;
    try {
      response = await this.fetchFn(endpoint, {
        method: 'POST',
        redirect: 'manual',
        signal,
        headers: {
          Accept: accept,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body,
      });
    } catch (error) {
      const cancelled = externalSignal?.aborted === true;
      const timedOut = !cancelled && (timeout.signal.aborted || isAbortError(error));
      timeout.clear();
      throw cdseError(
        cancelled
          ? CdseProviderErrorCode.CANCELLED
          : timedOut
            ? CdseProviderErrorCode.TIMEOUT
            : CdseProviderErrorCode.TRANSPORT,
        cancelled
          ? 'CDSE provider request was cancelled'
          : timedOut
            ? 'CDSE provider request timed out'
            : 'CDSE provider transport request failed',
        !cancelled,
        { cause: error },
      );
    }

    try {
      await assertAcceptedResponseStatus(response, this.clock.now());
      return { response, timeout, signal };
    } catch (error) {
      timeout.clear();
      throw error;
    }
  }

  private assertNotCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw cdseError(
        CdseProviderErrorCode.CANCELLED,
        'CDSE provider request was cancelled',
        false,
      );
    }
  }
}

export function assertCdseEndpointAllowed(url: URL, kind: 'CATALOG' | 'PROCESS'): void {
  const expectedPath = kind === 'CATALOG' ? CDSE_CATALOG_PATH : CDSE_PROCESS_PATH;
  if (
    url.protocol !== 'https:' ||
    url.origin !== CDSE_ORIGIN ||
    url.pathname !== expectedPath ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw cdseError(
      CdseProviderErrorCode.CONFIGURATION,
      'CDSE endpoint is not in the fixed provider allowlist',
      false,
    );
  }
}

export function classifySceneQuality(
  coverageStatus: CdseCoverageStatus,
  cloudCoverPercent: number,
): EnvironmentQualityStatus {
  if (coverageStatus === 'OUT_OF_COVERAGE') {
    return EnvironmentQualityStatus.OUT_OF_COVERAGE;
  }
  if (cloudCoverPercent >= CDSE_CLOUD_OBSCURED_PERCENT) {
    return EnvironmentQualityStatus.CLOUD_OBSCURED;
  }
  if (coverageStatus === 'FULL' && cloudCoverPercent <= CDSE_VALID_CLOUD_PERCENT) {
    return EnvironmentQualityStatus.VALID;
  }
  return EnvironmentQualityStatus.PROVISIONAL;
}

/**
 * Coverage classification uses exact polygon topology for FULL/PARTIAL/NONE.
 * The percentage for a partial overlap is a deterministic 16×16 stratified
 * grid estimate over the AOI bounding box, counting only cells whose centres
 * lie inside the AOI. This method is versioned in every candidate so it cannot
 * be confused with a provider measurement or silently changed later.
 */
export function calculateCdseSceneCoverage(
  aoi: MonitoringAreaGeometry,
  scene: MonitoringAreaGeometry,
): CdseSceneCoverage {
  assertGeometry(aoi, 'site monitoring geometry', 500);
  assertGeometry(scene, 'CDSE scene geometry', CDSE_MAX_FEATURE_GEOMETRY_POSITIONS);
  return calculateCoverageWithContext(createCoverageContext(aoi), scene);
}

function calculateCoverageWithContext(
  context: CdseCoverageContext,
  scene: MonitoringAreaGeometry,
): CdseSceneCoverage {
  const sceneBbox = geometryBbox(scene);
  if (!boundingBoxesOverlapWithArea(context.bbox, sceneBbox)) {
    return Object.freeze({
      status: 'OUT_OF_COVERAGE',
      percent: 0,
      method: CDSE_COVERAGE_METHOD,
      aoiSampleCount: 0,
    });
  }
  if (geometryFullyCovered(context.aoi, scene)) {
    return Object.freeze({
      status: 'FULL',
      percent: 100,
      method: CDSE_COVERAGE_METHOD,
      aoiSampleCount: 0,
    });
  }
  if (!geometriesIntersect(context.aoi, scene)) {
    return Object.freeze({
      status: 'OUT_OF_COVERAGE',
      percent: 0,
      method: CDSE_COVERAGE_METHOD,
      aoiSampleCount: 0,
    });
  }

  let coveredSamples = 0;
  for (const point of context.samplePoints) {
    if (pointInsideBbox(point, sceneBbox) && pointInGeometry(point, scene)) {
      coveredSamples += 1;
    }
  }
  const aoiSamples = context.samplePoints.length;
  const rawPercent = aoiSamples === 0 ? null : (coveredSamples / aoiSamples) * 100;
  const percent =
    rawPercent === null || rawPercent <= 0 || rawPercent >= 100
      ? null
      : Math.round(rawPercent * 100) / 100;
  return Object.freeze({
    status: 'PARTIAL',
    percent,
    method: CDSE_COVERAGE_METHOD,
    aoiSampleCount: aoiSamples,
  });
}

function pointInsideBbox(
  point: MonitoringPosition,
  bbox: readonly [number, number, number, number],
): boolean {
  return point[0] >= bbox[0] && point[0] <= bbox[2] && point[1] >= bbox[1] && point[1] <= bbox[3];
}

function createCoverageContext(aoi: MonitoringAreaGeometry): CdseCoverageContext {
  const bbox = geometryBbox(aoi);
  const samplePoints: MonitoringPosition[] = [];
  for (let row = 0; row < COVERAGE_GRID_SIZE; row += 1) {
    const latitude = bbox[1] + ((row + 0.5) / COVERAGE_GRID_SIZE) * (bbox[3] - bbox[1]);
    for (let column = 0; column < COVERAGE_GRID_SIZE; column += 1) {
      const longitude = bbox[0] + ((column + 0.5) / COVERAGE_GRID_SIZE) * (bbox[2] - bbox[0]);
      const point: MonitoringPosition = [longitude, latitude];
      if (pointInGeometry(point, aoi)) samplePoints.push(point);
    }
  }
  return Object.freeze({
    aoi,
    bbox,
    samplePoints: Object.freeze(samplePoints),
  });
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function renderFlightKey(input: CdseRenderSceneInput): string {
  const canonicalRequest = JSON.stringify([
    input.tenantId,
    input.siteId,
    input.monitoringLocationRevision,
    input.scene.collection,
    input.scene.sceneId,
    input.scene.acquiredAt.toISOString(),
    input.product,
    input.width,
    input.height,
    input.geometry,
  ]);
  return createHash('sha256').update(canonicalRequest).digest('base64url');
}

function once(callback: () => void): () => void {
  let called = false;
  return (): void => {
    if (called) return;
    called = true;
    callback();
  };
}

function cdseEndpoint(kind: 'CATALOG' | 'PROCESS'): URL {
  const url = new URL(kind === 'CATALOG' ? CDSE_CATALOG_PATH : CDSE_PROCESS_PATH, CDSE_ORIGIN);
  assertCdseEndpointAllowed(url, kind);
  return url;
}

function assertTenantScopedCatalogInput(input: CdseSceneCatalogInput, now: Date): void {
  if (input.tenantId.trim().length === 0 || input.siteId.trim().length === 0) {
    throw cdseError(
      CdseProviderErrorCode.CLIENT_REQUEST,
      'Tenant and site identifiers are required for CDSE catalog search',
      false,
    );
  }
  if (!Number.isInteger(input.monitoringLocationRevision) || input.monitoringLocationRevision < 1) {
    throw cdseError(
      CdseProviderErrorCode.CLIENT_REQUEST,
      'Monitoring location revision must be a positive integer',
      false,
    );
  }
  assertGeometry(input.geometry, 'site monitoring geometry', 500);
  const from = requireValidDate('from', input.from);
  const to = requireValidDate('to', input.to);
  if (from.getTime() > to.getTime()) {
    throw cdseError(
      CdseProviderErrorCode.CLIENT_REQUEST,
      'CDSE catalog start must not be after the end',
      false,
    );
  }
  if (to.getTime() - from.getTime() > CDSE_MAX_CATALOG_DAYS * 24 * 60 * 60 * 1_000) {
    throw cdseError(
      CdseProviderErrorCode.CLIENT_REQUEST,
      `CDSE catalog range cannot exceed ${CDSE_MAX_CATALOG_DAYS} days`,
      false,
    );
  }
  if (to.getTime() > now.getTime() + MAX_CLOCK_SKEW_MS) {
    throw cdseError(
      CdseProviderErrorCode.CLIENT_REQUEST,
      'CDSE catalog range cannot extend into the future',
      false,
    );
  }
  const limit = input.limit ?? CDSE_MAX_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > CDSE_MAX_SCENES) {
    throw cdseError(
      CdseProviderErrorCode.CLIENT_REQUEST,
      `CDSE catalog limit must be between 1 and ${CDSE_MAX_SCENES}`,
      false,
    );
  }
  if (
    input.maxCloudCoverPercent !== undefined &&
    (!Number.isFinite(input.maxCloudCoverPercent) ||
      input.maxCloudCoverPercent < 0 ||
      input.maxCloudCoverPercent > 100)
  ) {
    throw cdseError(
      CdseProviderErrorCode.CLIENT_REQUEST,
      'CDSE cloud-cover filter must be between 0 and 100',
      false,
    );
  }
}

function assertRenderInput(input: CdseRenderSceneInput): void {
  if (input.tenantId.trim().length === 0 || input.siteId.trim().length === 0) {
    throw cdseError(
      CdseProviderErrorCode.CLIENT_REQUEST,
      'Tenant and site identifiers are required for CDSE rendering',
      false,
    );
  }
  if (!Number.isInteger(input.monitoringLocationRevision) || input.monitoringLocationRevision < 1) {
    throw cdseError(
      CdseProviderErrorCode.CLIENT_REQUEST,
      'Monitoring location revision must be a positive integer',
      false,
    );
  }
  if (
    input.scene.collection !== CDSE_SENTINEL_2_COLLECTION ||
    input.scene.sceneId.trim().length === 0 ||
    input.scene.sceneId.length > 512
  ) {
    throw cdseError(
      CdseProviderErrorCode.SCENE_MISMATCH,
      'Rendering requires a catalogued Sentinel-2 L2A scene',
      false,
    );
  }
  requireValidDate('scene.acquiredAt', input.scene.acquiredAt);
  assertGeometry(input.geometry, 'site monitoring geometry', 500);
  if (
    !Number.isInteger(input.width) ||
    !Number.isInteger(input.height) ||
    input.width < MIN_RENDER_DIMENSION ||
    input.height < MIN_RENDER_DIMENSION ||
    input.width > MAX_RENDER_DIMENSION ||
    input.height > MAX_RENDER_DIMENSION ||
    input.width * input.height > MAX_RENDER_PIXELS
  ) {
    throw cdseError(
      CdseProviderErrorCode.CLIENT_REQUEST,
      'CDSE render dimensions are outside the backend limits',
      false,
    );
  }
}

function serializeBoundedRequest(value: object): string {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > CDSE_MAX_REQUEST_BYTES) {
    throw cdseError(
      CdseProviderErrorCode.CLIENT_REQUEST,
      'CDSE request body exceeded the backend limit',
      false,
    );
  }
  return body;
}

async function assertAcceptedResponseStatus(response: Response, now: Date): Promise<void> {
  if (response.status >= 300 && response.status < 400) {
    await cancelResponseBody(response);
    throw cdseError(
      CdseProviderErrorCode.REDIRECT_BLOCKED,
      'CDSE returned an unexpected redirect',
      false,
      { httpStatus: response.status },
    );
  }
  if (response.status === 401 || response.status === 403) {
    await cancelResponseBody(response);
    throw cdseError(
      CdseProviderErrorCode.AUTHENTICATION,
      'CDSE rejected the resolved provider credential',
      false,
      { httpStatus: response.status },
    );
  }
  if (response.status === 408 || response.status === 425 || response.status === 429) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'), now);
    await cancelResponseBody(response);
    throw cdseError(
      response.status === 429 ? CdseProviderErrorCode.RATE_LIMITED : CdseProviderErrorCode.UPSTREAM,
      'CDSE transiently rejected the request',
      true,
      {
        httpStatus: response.status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
    );
  }
  if (response.status >= 500) {
    await cancelResponseBody(response);
    throw cdseError(CdseProviderErrorCode.UPSTREAM, 'CDSE upstream service failed', true, {
      httpStatus: response.status,
    });
  }
  if (!response.ok) {
    await cancelResponseBody(response);
    throw cdseError(
      CdseProviderErrorCode.CLIENT_REQUEST,
      'CDSE rejected the backend request',
      false,
      { httpStatus: response.status },
    );
  }
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  externalSignal?: AbortSignal,
): Promise<unknown> {
  assertContentType(response, CATALOG_CONTENT_TYPES, 'catalog');
  parseContentLength(response, maxBytes);
  const body = response.body;
  if (!body) {
    throw cdseError(CdseProviderErrorCode.SCHEMA, 'CDSE catalog response had no body', false);
  }
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let byteLength = 0;
  let json = '';
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await readCdseStreamChunk(reader, signal);
      } catch (error) {
        const cancelled = externalSignal?.aborted === true;
        const timedOut = !cancelled && (signal.aborted || isAbortError(error));
        await reader.cancel().catch(() => undefined);
        throw cdseError(
          cancelled
            ? CdseProviderErrorCode.CANCELLED
            : timedOut
              ? CdseProviderErrorCode.TIMEOUT
              : CdseProviderErrorCode.TRANSPORT,
          cancelled
            ? 'CDSE catalog response was cancelled'
            : timedOut
              ? 'CDSE catalog response timed out'
              : 'CDSE catalog response stream failed',
          !cancelled,
          { cause: error },
        );
      }
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw cdseError(
          CdseProviderErrorCode.RESPONSE_TOO_LARGE,
          'CDSE catalog response exceeded the size limit',
          false,
        );
      }
      try {
        json += decoder.decode(chunk.value, { stream: true });
      } catch (error) {
        throw cdseError(
          CdseProviderErrorCode.SCHEMA,
          'CDSE catalog response was not valid UTF-8',
          false,
          { cause: error },
        );
      }
    }
    try {
      json += decoder.decode();
    } catch (error) {
      throw cdseError(
        CdseProviderErrorCode.SCHEMA,
        'CDSE catalog response was not valid UTF-8',
        false,
        { cause: error },
      );
    }
  } catch (error) {
    if (error instanceof CdseProviderError) throw error;
    throw cdseError(
      CdseProviderErrorCode.SCHEMA,
      'CDSE catalog response was not valid UTF-8',
      false,
      { cause: error },
    );
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(json);
  } catch (error) {
    throw cdseError(
      CdseProviderErrorCode.SCHEMA,
      'CDSE catalog response was malformed JSON',
      false,
      { cause: error },
    );
  }
}

function parseCatalogPage(value: unknown, requestedLimit: number): CdseCatalogPage {
  const record = requireRecord(value, 'catalog response');
  if (record['type'] !== 'FeatureCollection') {
    throw cdseSchemaError('catalog response.type');
  }
  const rawFeatures = record['features'];
  if (
    !Array.isArray(rawFeatures) ||
    rawFeatures.length > requestedLimit ||
    rawFeatures.length > CDSE_MAX_PAGE_SIZE
  ) {
    throw cdseSchemaError('catalog response.features');
  }
  const features = rawFeatures.map((feature, index) => parseCatalogFeature(feature, index));
  const context =
    record['context'] === undefined
      ? null
      : requireRecord(record['context'], 'catalog response.context');
  const rawNext = context?.['next'];
  if (
    rawNext !== undefined &&
    rawNext !== null &&
    !(
      (typeof rawNext === 'string' && rawNext.length > 0 && rawNext.length <= 512) ||
      (typeof rawNext === 'number' && Number.isSafeInteger(rawNext) && rawNext >= 0)
    )
  ) {
    throw cdseSchemaError('catalog response.context.next');
  }
  return Object.freeze({
    features: Object.freeze(features),
    next: rawNext ?? null,
  });
}

function assertCatalogPageWithinRequest(
  page: CdseCatalogPage,
  options: CatalogSearchOptions,
): void {
  const fromMs = new Date(options.fromIso).getTime();
  const toMs = new Date(options.toIso).getTime();
  const allowedIds = options.ids === undefined ? null : new Set(options.ids);
  for (const feature of page.features) {
    const acquiredAtMs = new Date(feature.acquiredAt).getTime();
    if (acquiredAtMs < fromMs || acquiredAtMs > toMs) {
      throw cdseSchemaError('catalog response.features.properties.datetime range');
    }
    if (allowedIds && !allowedIds.has(feature.id)) {
      throw cdseSchemaError('catalog response.features.id filter');
    }
    if (
      options.maxCloudCoverPercent !== undefined &&
      feature.cloudCoverPercent > options.maxCloudCoverPercent
    ) {
      throw cdseSchemaError('catalog response.features.properties.eo:cloud_cover filter');
    }
  }
  if (allowedIds && page.next !== null) {
    throw cdseSchemaError('catalog response.context.next for ID search');
  }
}

function parseCatalogFeature(value: unknown, index: number): CdseCatalogFeature {
  const path = `catalog response.features[${index}]`;
  const record = requireRecord(value, path);
  if (record['type'] !== 'Feature') throw cdseSchemaError(`${path}.type`);
  const id = requireBoundedString(record['id'], `${path}.id`, 512);
  if (record['collection'] !== CDSE_SENTINEL_2_COLLECTION) {
    throw cdseSchemaError(`${path}.collection`);
  }
  const properties = requireRecord(record['properties'], `${path}.properties`);
  const acquiredAt = requireUtcTimestamp(properties['datetime'], `${path}.properties.datetime`);
  const cloudCoverPercent = requireFiniteNumber(
    properties['eo:cloud_cover'],
    `${path}.properties.eo:cloud_cover`,
  );
  if (cloudCoverPercent < 0 || cloudCoverPercent > 100) {
    throw cdseSchemaError(`${path}.properties.eo:cloud_cover`);
  }
  const geometry = parseFeatureGeometry(record['geometry'], `${path}.geometry`);
  return Object.freeze({
    id,
    collection: CDSE_SENTINEL_2_COLLECTION,
    geometry,
    acquiredAt,
    cloudCoverPercent,
    geometryPositionCount: countGeometryPositions(geometry),
  });
}

function countGeometryPositions(geometry: MonitoringAreaGeometry): number {
  let count = 0;
  for (const polygon of geometryPolygons(geometry)) {
    for (const ring of polygon) count += ring.length;
  }
  return count;
}

function parseFeatureGeometry(value: unknown, path: string): MonitoringAreaGeometry {
  const record = requireRecord(value, path);
  if (record['type'] === 'Polygon') {
    const coordinates = parsePolygonCoordinates(record['coordinates'], `${path}.coordinates`);
    const geometry: MonitoringAreaGeometry = {
      type: 'Polygon',
      coordinates,
    };
    assertGeometry(
      geometry,
      path,
      CDSE_MAX_FEATURE_GEOMETRY_POSITIONS,
      CdseProviderErrorCode.SCHEMA,
    );
    return geometry;
  }
  if (record['type'] === 'MultiPolygon') {
    const rawCoordinates = record['coordinates'];
    if (!Array.isArray(rawCoordinates) || rawCoordinates.length === 0) {
      throw cdseSchemaError(`${path}.coordinates`);
    }
    const coordinates = rawCoordinates.map((polygon, index) =>
      parsePolygonCoordinates(polygon, `${path}.coordinates[${index}]`),
    );
    const geometry: MonitoringAreaGeometry = {
      type: 'MultiPolygon',
      coordinates,
    };
    assertGeometry(
      geometry,
      path,
      CDSE_MAX_FEATURE_GEOMETRY_POSITIONS,
      CdseProviderErrorCode.SCHEMA,
    );
    return geometry;
  }
  throw cdseSchemaError(`${path}.type`);
}

function parsePolygonCoordinates(value: unknown, path: string): MonitoringPosition[][] {
  if (!Array.isArray(value) || value.length === 0) {
    throw cdseSchemaError(path);
  }
  return value.map((ring, index) => parseRing(ring, `${path}[${index}]`));
}

function parseRing(value: unknown, path: string): MonitoringPosition[] {
  if (!Array.isArray(value) || value.length < 4) {
    throw cdseSchemaError(path);
  }
  const ring = value.map((position, index) => parsePosition(position, `${path}[${index}]`));
  if (!positionsEqual(ring[0]!, ring[ring.length - 1]!)) {
    throw cdseSchemaError(path);
  }
  return ring;
}

function parsePosition(value: unknown, path: string): MonitoringPosition {
  if (!Array.isArray(value) || value.length !== 2) {
    throw cdseSchemaError(path);
  }
  const longitude = requireFiniteNumber(value[0], `${path}[0]`);
  const latitude = requireFiniteNumber(value[1], `${path}[1]`);
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    throw cdseSchemaError(path);
  }
  return [longitude, latitude];
}

function assertSuccessfulImageResponse(response: Response): void {
  assertContentType(response, IMAGE_CONTENT_TYPES, 'processing');
  parseContentLength(response, CDSE_MAX_IMAGE_BYTES);
}

function assertContentType(
  response: Response,
  allowed: ReadonlySet<string>,
  subject: string,
): void {
  const contentType =
    response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!allowed.has(contentType)) {
    throw cdseError(
      CdseProviderErrorCode.SCHEMA,
      `CDSE ${subject} response content type is not allowed`,
      false,
    );
  }
}

function parseContentLength(response: Response, maxBytes: number): number | null {
  const raw = response.headers.get('content-length');
  if (raw === null) return null;
  if (!/^\d+$/u.test(raw)) {
    throw cdseError(
      CdseProviderErrorCode.SCHEMA,
      'CDSE response had an invalid content length',
      false,
    );
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
    throw cdseError(
      CdseProviderErrorCode.RESPONSE_TOO_LARGE,
      'CDSE response exceeded the size limit',
      false,
    );
  }
  return length;
}

function boundedReadableStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
  externalSignal?: AbortSignal,
  onFinalize?: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let byteLength = 0;
  let released = false;
  const release = (): void => {
    if (!released) {
      released = true;
      try {
        reader.releaseLock();
      } finally {
        onFinalize?.();
      }
    }
  };
  return new ReadableStream<Uint8Array>({
    pull: async (controller): Promise<void> => {
      try {
        const chunk = await readCdseStreamChunk(reader, signal);
        if (chunk.done) {
          release();
          controller.close();
          return;
        }
        byteLength += chunk.value.byteLength;
        if (byteLength > maxBytes) {
          await reader.cancel('CDSE image exceeded the size limit');
          release();
          controller.error(
            cdseError(
              CdseProviderErrorCode.RESPONSE_TOO_LARGE,
              'CDSE image response exceeded the size limit',
              false,
            ),
          );
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        const cancelled = externalSignal?.aborted === true;
        const timedOut = !cancelled && (signal.aborted || isAbortError(error));
        if (cancelled || timedOut) {
          await reader.cancel().catch(() => undefined);
        }
        release();
        controller.error(
          cancelled
            ? cdseError(
                CdseProviderErrorCode.CANCELLED,
                'CDSE image response was cancelled',
                false,
                { cause: error },
              )
            : timedOut
              ? cdseError(CdseProviderErrorCode.TIMEOUT, 'CDSE image response timed out', true, {
                  cause: error,
                })
              : error,
        );
      }
    },
    cancel: async (reason): Promise<void> => {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
}

async function readCdseStreamChunk(
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
        reject(error instanceof Error ? error : new Error('CDSE response stream failed'));
      },
    );
  });
}

function geometryFullyCovered(aoi: MonitoringAreaGeometry, scene: MonitoringAreaGeometry): boolean {
  if (geometryBoundariesProperlyIntersect(aoi, scene)) return false;
  for (const polygon of geometryPolygons(aoi)) {
    const exterior = polygon[0]!;
    for (let index = 0; index < exterior.length - 1; index += 1) {
      const start = exterior[index]!;
      const end = exterior[index + 1]!;
      const midpoint: MonitoringPosition = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
      if (!pointInGeometry(start, scene) || !pointInGeometry(midpoint, scene)) {
        return false;
      }
    }
  }
  for (const scenePolygon of geometryPolygons(scene)) {
    for (let ringIndex = 1; ringIndex < scenePolygon.length; ringIndex += 1) {
      const hole = scenePolygon[ringIndex]!;
      if (hole.some((position) => pointInGeometry(position, aoi))) {
        return false;
      }
    }
  }
  return true;
}

function geometryBoundariesProperlyIntersect(
  left: MonitoringAreaGeometry,
  right: MonitoringAreaGeometry,
): boolean {
  for (const leftPolygon of geometryPolygons(left)) {
    for (const rightPolygon of geometryPolygons(right)) {
      for (const leftRing of leftPolygon) {
        for (const rightRing of rightPolygon) {
          for (let leftIndex = 0; leftIndex < leftRing.length - 1; leftIndex += 1) {
            for (let rightIndex = 0; rightIndex < rightRing.length - 1; rightIndex += 1) {
              if (
                segmentsProperlyIntersect(
                  leftRing[leftIndex]!,
                  leftRing[leftIndex + 1]!,
                  rightRing[rightIndex]!,
                  rightRing[rightIndex + 1]!,
                )
              ) {
                return true;
              }
            }
          }
        }
      }
    }
  }
  return false;
}

function segmentsProperlyIntersect(
  firstStart: MonitoringPosition,
  firstEnd: MonitoringPosition,
  secondStart: MonitoringPosition,
  secondEnd: MonitoringPosition,
): boolean {
  const firstOrientation = orientation(firstStart, firstEnd, secondStart);
  const secondOrientation = orientation(firstStart, firstEnd, secondEnd);
  const thirdOrientation = orientation(secondStart, secondEnd, firstStart);
  const fourthOrientation = orientation(secondStart, secondEnd, firstEnd);
  return (
    firstOrientation !== 0 &&
    secondOrientation !== 0 &&
    thirdOrientation !== 0 &&
    fourthOrientation !== 0 &&
    firstOrientation !== secondOrientation &&
    thirdOrientation !== fourthOrientation
  );
}

function geometriesIntersect(left: MonitoringAreaGeometry, right: MonitoringAreaGeometry): boolean {
  const leftPolygons = geometryPolygons(left);
  const rightPolygons = geometryPolygons(right);
  for (const leftPolygon of leftPolygons) {
    for (const rightPolygon of rightPolygons) {
      if (polygonsIntersect(leftPolygon, rightPolygon)) return true;
    }
  }
  return false;
}

function polygonsIntersect(left: MonitoringPosition[][], right: MonitoringPosition[][]): boolean {
  const leftExterior = left[0]!;
  const rightExterior = right[0]!;
  if (
    leftExterior.some((position) => pointStrictlyInPolygon(position, right)) ||
    rightExterior.some((position) => pointStrictlyInPolygon(position, left)) ||
    edgeMidpoints(leftExterior).some((position) => pointStrictlyInPolygon(position, right)) ||
    edgeMidpoints(rightExterior).some((position) => pointStrictlyInPolygon(position, left))
  ) {
    return true;
  }
  for (const leftRing of left) {
    for (const rightRing of right) {
      for (let leftIndex = 0; leftIndex < leftRing.length - 1; leftIndex += 1) {
        for (let rightIndex = 0; rightIndex < rightRing.length - 1; rightIndex += 1) {
          if (
            segmentsProperlyIntersect(
              leftRing[leftIndex]!,
              leftRing[leftIndex + 1]!,
              rightRing[rightIndex]!,
              rightRing[rightIndex + 1]!,
            )
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function edgeMidpoints(ring: MonitoringPosition[]): MonitoringPosition[] {
  const midpoints: MonitoringPosition[] = [];
  for (let index = 0; index < ring.length - 1; index += 1) {
    const start = ring[index]!;
    const end = ring[index + 1]!;
    midpoints.push([(start[0] + end[0]) / 2, (start[1] + end[1]) / 2]);
  }
  return midpoints;
}

function pointStrictlyInPolygon(
  point: MonitoringPosition,
  polygon: MonitoringPosition[][],
): boolean {
  if (polygon.some((ring) => pointOnRing(point, ring))) return false;
  return pointInPolygon(point, polygon);
}

function pointOnRing(point: MonitoringPosition, ring: MonitoringPosition[]): boolean {
  for (let index = 0; index < ring.length - 1; index += 1) {
    if (pointOnSegment(point, ring[index]!, ring[index + 1]!)) return true;
  }
  return false;
}

function pointInGeometry(point: MonitoringPosition, geometry: MonitoringAreaGeometry): boolean {
  return geometryPolygons(geometry).some((polygon) => pointInPolygon(point, polygon));
}

function pointInPolygon(point: MonitoringPosition, polygon: MonitoringPosition[][]): boolean {
  if (!pointInRing(point, polygon[0]!)) return false;
  for (let index = 1; index < polygon.length; index += 1) {
    if (pointInRing(point, polygon[index]!)) return false;
  }
  return true;
}

function pointInRing(point: MonitoringPosition, ring: MonitoringPosition[]): boolean {
  let inside = false;
  for (
    let index = 0, previous = ring.length - 2;
    index < ring.length - 1;
    previous = index, index += 1
  ) {
    const current = ring[index]!;
    const prior = ring[previous]!;
    if (pointOnSegment(point, prior, current)) return true;
    const crosses =
      current[1] > point[1] !== prior[1] > point[1] &&
      point[0] <
        ((prior[0] - current[0]) * (point[1] - current[1])) / (prior[1] - current[1]) + current[0];
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointOnSegment(
  point: MonitoringPosition,
  start: MonitoringPosition,
  end: MonitoringPosition,
): boolean {
  return (
    orientation(start, end, point) === 0 &&
    point[0] >= Math.min(start[0], end[0]) &&
    point[0] <= Math.max(start[0], end[0]) &&
    point[1] >= Math.min(start[1], end[1]) &&
    point[1] <= Math.max(start[1], end[1])
  );
}

function orientation(
  first: MonitoringPosition,
  second: MonitoringPosition,
  third: MonitoringPosition,
): number {
  const cross =
    (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0]);
  if (Math.abs(cross) < 1e-12) return 0;
  return cross > 0 ? 1 : -1;
}

function geometryPolygons(geometry: MonitoringAreaGeometry): MonitoringPosition[][][] {
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
}

function geometryBbox(geometry: MonitoringAreaGeometry): readonly [number, number, number, number] {
  const positions = geometryPolygons(geometry).flat(2);
  return [
    Math.min(...positions.map((position) => position[0])),
    Math.min(...positions.map((position) => position[1])),
    Math.max(...positions.map((position) => position[0])),
    Math.max(...positions.map((position) => position[1])),
  ];
}

function boundingBoxesOverlapWithArea(
  left: readonly [number, number, number, number],
  right: readonly [number, number, number, number],
): boolean {
  return (
    Math.max(left[0], right[0]) < Math.min(left[2], right[2]) &&
    Math.max(left[1], right[1]) < Math.min(left[3], right[3])
  );
}

function assertGeometry(
  geometry: MonitoringAreaGeometry,
  subject: string,
  maxPositions: number,
  errorCode = CdseProviderErrorCode.CLIENT_REQUEST,
): void {
  if (
    !geometry ||
    (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') ||
    !Array.isArray(geometry.coordinates)
  ) {
    throw cdseError(errorCode, `${subject} is not a supported GeoJSON geometry`, false);
  }
  const polygons = geometryPolygons(geometry);
  if (polygons.length === 0) {
    throw cdseError(errorCode, `${subject} contains no polygons`, false);
  }
  let positionCount = 0;
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || polygon.length === 0) {
      throw cdseError(errorCode, `${subject} contains an empty polygon`, false);
    }
    for (const ring of polygon) {
      if (!Array.isArray(ring)) {
        throw cdseError(errorCode, `${subject} contains an invalid ring`, false);
      }
      positionCount += ring.length;
      if (ring.length < 4 || !positionsEqual(ring[0]!, ring[ring.length - 1]!)) {
        throw cdseError(errorCode, `${subject} contains an invalid ring`, false);
      }
      for (const position of ring) {
        if (!Array.isArray(position) || position.length !== 2) {
          throw cdseError(errorCode, `${subject} contains an invalid coordinate`, false);
        }
        const longitude = position[0];
        const latitude = position[1];
        if (
          !Number.isFinite(longitude) ||
          !Number.isFinite(latitude) ||
          longitude < -180 ||
          longitude > 180 ||
          latitude < -90 ||
          latitude > 90
        ) {
          throw cdseError(errorCode, `${subject} contains an invalid coordinate`, false);
        }
      }
    }
  }
  if (positionCount > maxPositions) {
    throw cdseError(errorCode, `${subject} exceeded the coordinate limit`, false);
  }
}

function compareSceneCandidates(
  left: CdseSceneObservationCandidate,
  right: CdseSceneObservationCandidate,
): number {
  const byAcquisition = right.acquiredAt.localeCompare(left.acquiredAt);
  return byAcquisition !== 0 ? byAcquisition : left.sceneId.localeCompare(right.sceneId);
}

function encodeSceneCursor(acquiredAt: string, sceneId: string): string {
  return Buffer.from(JSON.stringify([acquiredAt, sceneId]), 'utf8').toString('base64url');
}

function parseRetryAfterMs(value: string | null, now: Date): number | undefined {
  return parseProviderRetryAfterMs(value, now, MAX_RETRY_AFTER_MS);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw cdseSchemaError(path);
  }
  return value as Record<string, unknown>;
}

function requireBoundedString(value: unknown, path: string, maximumLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength) {
    throw cdseSchemaError(path);
  }
  return value;
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw cdseSchemaError(path);
  }
  return value;
}

function requireUtcTimestamp(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw cdseSchemaError(path);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw cdseSchemaError(path);
  return parsed.toISOString();
}

function requireValidDate(name: string, value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw cdseError(CdseProviderErrorCode.CLIENT_REQUEST, `${name} must be a valid date`, false);
  }
  return value;
}

function positionsEqual(left: MonitoringPosition, right: MonitoringPosition): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function cdseSchemaError(path: string): CdseProviderError {
  return cdseError(
    CdseProviderErrorCode.SCHEMA,
    `CDSE response failed schema validation at ${path}`,
    false,
  );
}

function mapTokenErrorCode(code: CdseTokenErrorCode): CdseProviderErrorCode {
  switch (code) {
    case CdseTokenErrorCode.CREDENTIAL_SERVICE:
      return CdseProviderErrorCode.CREDENTIAL_SERVICE;
    case CdseTokenErrorCode.AUTHENTICATION:
      return CdseProviderErrorCode.AUTHENTICATION;
    case CdseTokenErrorCode.RATE_LIMITED:
      return CdseProviderErrorCode.RATE_LIMITED;
    case CdseTokenErrorCode.UPSTREAM:
      return CdseProviderErrorCode.UPSTREAM;
    case CdseTokenErrorCode.TIMEOUT:
      return CdseProviderErrorCode.TIMEOUT;
    case CdseTokenErrorCode.TRANSPORT:
      return CdseProviderErrorCode.TRANSPORT;
    case CdseTokenErrorCode.SCHEMA:
      return CdseProviderErrorCode.SCHEMA;
    case CdseTokenErrorCode.REDIRECT_BLOCKED:
      return CdseProviderErrorCode.REDIRECT_BLOCKED;
  }
}

function cdseError(
  code: CdseProviderErrorCode,
  message: string,
  retryable: boolean,
  details: {
    readonly httpStatus?: number;
    readonly retryAfterMs?: number;
    readonly cause?: unknown;
  } = {},
): CdseProviderError {
  return new CdseProviderError({
    code,
    message,
    retryable,
    ...(details.httpStatus === undefined ? {} : { httpStatus: details.httpStatus }),
    ...(details.retryAfterMs === undefined ? {} : { retryAfterMs: details.retryAfterMs }),
    ...(details.cause === undefined ? {} : { cause: details.cause }),
  });
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body) await response.body.cancel();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
