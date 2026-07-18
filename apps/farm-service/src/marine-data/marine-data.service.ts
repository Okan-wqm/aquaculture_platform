import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';

import { SentinelHubService } from '../sentinel-hub/sentinel-hub.service';
import { buildSentinelProcessBody } from '../sentinel-hub/sentinel-process-request.factory';
import {
  type SentinelPointProductDefinition,
  getSentinelPointProduct,
  getSentinelProcessProduct,
} from '../sentinel-hub/sentinel-product-registry';
import { MAX_BBOX_DEGREES_AREA, SentinelProxyPolicy } from '../sentinel-hub/sentinel-proxy.policy';
import {
  CmemsLayerDefinition,
  MARINE_LAYER_CATALOG,
  MarineLayerDefinition,
  SentinelLayerDefinition,
  findCmemsLayer,
  findMarineLayer,
  findSentinelLayer,
} from './marine-layer-catalog';

const CMEMS_WMTS_BASE_URL = 'https://wmts.marine.copernicus.eu/teroWmts';
const CDSE_BASE_URL = 'https://sh.dataspace.copernicus.eu';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CMEMS_TILE_MATRIX = 12;
const MAX_SENTINEL_TILE_MATRIX = 18;
const TILE_SIZE = 256;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Worst-case (equatorial) WMTS tile bbox area in deg² at a given zoom. Web-Mercator
 * tiles span the most latitude at the equator, so this bounds the area the Sentinel
 * proxy policy will accept for any tile at that zoom.
 */
export function worstCaseTileAreaDeg2(tileMatrix: number): number {
  const n = 2 ** tileMatrix;
  const lonSpan = 360 / n;
  const latSpan = (Math.atan(Math.sinh((2 * Math.PI) / n)) * 180) / Math.PI;
  return lonSpan * latSpan;
}

/**
 * Lowest Sentinel zoom whose worst-case tile still fits the proxy policy's bbox-area
 * cap. Derived from MAX_BBOX_DEGREES_AREA so the two cannot drift: a tile the service
 * would emit below this zoom is exactly one the policy would reject with a 400.
 */
function minSentinelTileMatrix(maxAreaDeg2: number): number {
  for (let z = 0; z <= MAX_SENTINEL_TILE_MATRIX; z += 1) {
    if (worstCaseTileAreaDeg2(z) <= maxAreaDeg2) {
      return z;
    }
  }
  return MAX_SENTINEL_TILE_MATRIX;
}

export const MIN_SENTINEL_TILE_MATRIX = minSentinelTileMatrix(MAX_BBOX_DEGREES_AREA);

/** Sentinel point queries render a small window and sample its centre pixel. */
const SENTINEL_POINT_DIMENSION = 64;
/** ~64 native (10 m) pixels wide, so the centre pixel is a true sample, not an upsample. */
const SENTINEL_POINT_BBOX_BUFFER_DEG = 0.0032;

type SentinelPointQuality = 'good' | 'cloud' | 'land' | 'no_data';

export interface MarineTileRequest {
  layerId: string;
  tileMatrix: string;
  tileCol: string;
  tileRow: string;
  date?: string;
  depth?: string;
}

export interface MarinePointRequest {
  layerId: string;
  lat: string;
  lng: string;
  date?: string;
  depth?: string;
  zoom?: string;
}

export interface MarineAoiAnalysisRequest {
  tenantId: string;
  layerId: string;
  bbox?: string;
  fromDate?: string;
  toDate?: string;
  width?: string;
  height?: string;
}

export interface MarineTileResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

export interface MarinePointResponse {
  lat: number;
  lng: number;
  value: number | null;
  unit: string;
  variableId: string;
  datasetId: string;
  timestamp: string;
  quality?: SentinelPointQuality;
}

@Injectable()
export class MarineDataService {
  private readonly logger = new Logger(MarineDataService.name);

  constructor(
    private readonly sentinelHubService: SentinelHubService,
    private readonly sentinelPolicy: SentinelProxyPolicy,
  ) {}

  getLayers(): readonly MarineLayerDefinition[] {
    return MARINE_LAYER_CATALOG;
  }

  getAvailability(input: { layerId: string; date?: string; depth?: string }): {
    layerId: string;
    available: boolean;
    effectiveDate: string;
    elevation: number;
    source: MarineLayerDefinition['source'];
    supportsDepth: boolean;
    fallbackApplied: boolean;
  } {
    const layer = this.requireMarineLayer(input.layerId);
    const requestedDate = input.date;
    const effectiveDate = layer.source === 'cmems'
      ? this.parseCmemsDate(requestedDate)
      : this.parseSentinelDate(requestedDate);
    return {
      layerId: layer.id,
      available: true,
      effectiveDate,
      elevation: layer.supportsDepth ? this.parseDepth(input.depth) : 0,
      source: layer.source,
      supportsDepth: layer.supportsDepth,
      fallbackApplied: requestedDate !== undefined && requestedDate !== effectiveDate,
    };
  }

  async getTile(input: MarineTileRequest & { tenantId: string }): Promise<MarineTileResponse> {
    const layer = this.requireMarineLayer(input.layerId);
    if (layer.source === 'sentinel') {
      return this.getSentinelTile(input, this.requireSentinelLayer(input.layerId));
    }
    return this.getCmemsTile(input, this.requireCmemsLayer(input.layerId));
  }

  private async getCmemsTile(
    input: MarineTileRequest,
    layer: CmemsLayerDefinition,
  ): Promise<MarineTileResponse> {
    const tileMatrix = this.parseTileMatrix(input.tileMatrix, MAX_CMEMS_TILE_MATRIX);
    const tileCol = this.parseTileCoordinate('TILECOL', input.tileCol, tileMatrix);
    const tileRow = this.parseTileCoordinate('TILEROW', input.tileRow, tileMatrix);
    const effectiveDate = this.parseCmemsDate(input.date);
    const depth = this.parseDepth(input.depth);
    const response = await this.fetchCmems(this.buildWmtsParams(layer, {
      REQUEST: 'GetTile',
      FORMAT: 'image/png',
      TIME: effectiveDate,
      ELEVATION: String(depth),
      TILEMATRIX: String(tileMatrix),
      TILECOL: String(tileCol),
      TILEROW: String(tileRow),
    }));

    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    if (!response.ok) {
      this.logger.warn(`CMEMS tile returned ${response.status} for ${layer.id}`);
      return {
        status: response.status,
        contentType: 'text/plain; charset=utf-8',
        body: Buffer.from('CMEMS tile request failed'),
      };
    }
    if (!contentType.startsWith('image/')) {
      throw new BadGatewayException('CMEMS returned a non-image tile response');
    }

    return {
      status: response.status,
      contentType,
      body: Buffer.from(await response.arrayBuffer()),
    };
  }

  async getPoint(input: MarinePointRequest & { tenantId: string }): Promise<MarinePointResponse | null> {
    const layer = this.requireMarineLayer(input.layerId);
    if (layer.source === 'sentinel') {
      return this.getSentinelPoint(input, this.requireSentinelLayer(input.layerId));
    }
    return this.getCmemsPoint(input, this.requireCmemsLayer(input.layerId));
  }

  private async getCmemsPoint(
    input: MarinePointRequest,
    layer: CmemsLayerDefinition,
  ): Promise<MarinePointResponse | null> {
    const lat = this.parseLatitude(input.lat);
    const lng = this.parseLongitude(input.lng);
    const zoom = this.parseZoom(input.zoom, MAX_CMEMS_TILE_MATRIX);
    const effectiveDate = this.parseCmemsDate(input.date);
    const depth = this.parseDepth(input.depth);
    const tile = this.calculateTileCoords(lat, lng, zoom);

    const response = await this.fetchCmems(this.buildWmtsParams(layer, {
      REQUEST: 'GetFeatureInfo',
      TILEMATRIX: String(zoom),
      TILEROW: String(tile.tileRow),
      TILECOL: String(tile.tileCol),
      I: String(tile.pixelI),
      J: String(tile.pixelJ),
      INFOFORMAT: 'application/json',
      TIME: effectiveDate,
      ELEVATION: String(depth),
    }));

    if (!response.ok) {
      this.logger.warn(`CMEMS point query returned ${response.status} for ${layer.id}`);
      return null;
    }

    const payload: unknown = await response.json();
    return this.extractPointValue(payload, layer, lat, lng, effectiveDate);
  }

  private async getSentinelTile(
    input: MarineTileRequest & { tenantId: string },
    layer: SentinelLayerDefinition,
  ): Promise<MarineTileResponse> {
    const tileMatrix = this.parseTileMatrix(
      input.tileMatrix,
      MAX_SENTINEL_TILE_MATRIX,
      MIN_SENTINEL_TILE_MATRIX,
    );
    const tileCol = this.parseTileCoordinate('TILECOL', input.tileCol, tileMatrix);
    const tileRow = this.parseTileCoordinate('TILEROW', input.tileRow, tileMatrix);
    const effectiveDate = this.parseSentinelDate(input.date);
    const fromDate = this.sentinelWindowStart(effectiveDate);
    const bbox = this.tileToBbox4326(tileCol, tileRow, tileMatrix);

    return this.fetchSentinelProcess({
      tenantId: input.tenantId,
      bbox: bbox.join(','),
      fromDate,
      toDate: this.endOfDayIso(effectiveDate),
      width: String(TILE_SIZE),
      height: String(TILE_SIZE),
      product: layer.product,
    });
  }

  private async getSentinelPoint(
    input: MarinePointRequest & { tenantId: string },
    layer: SentinelLayerDefinition,
  ): Promise<MarinePointResponse | null> {
    const lat = this.parseLatitude(input.lat);
    const lng = this.parseLongitude(input.lng);
    const effectiveDate = this.parseSentinelDate(input.date);
    const definition = getSentinelPointProduct(layer.id);
    if (!definition) {
      throw new BadRequestException(`Sentinel point query is not supported for layer: ${layer.id}`);
    }

    const rendered = await this.fetchSentinelProcess({
      tenantId: input.tenantId,
      bbox: this.pointBbox(lat, lng).join(','),
      fromDate: this.sentinelWindowStart(effectiveDate),
      toDate: this.endOfDayIso(effectiveDate),
      width: String(SENTINEL_POINT_DIMENSION),
      height: String(SENTINEL_POINT_DIMENSION),
      product: layer.product,
      evalscriptOverride: definition.evalscript,
    });

    // Upstream failures come back as a non-image body; never feed that to sharp (F3).
    if (rendered.status !== 200 || !rendered.contentType.startsWith('image/')) {
      throw new BadGatewayException('Sentinel Hub point query failed');
    }

    const decoded = await this.decodeSentinelPoint(rendered.body, definition);
    return {
      lat,
      lng,
      value: decoded.value,
      unit: definition.unit,
      variableId: layer.id,
      datasetId: getSentinelProcessProduct(layer.product)?.collection ?? layer.product,
      timestamp: effectiveDate,
      quality: decoded.quality,
    };
  }

  private async fetchSentinelProcess(input: {
    tenantId: string;
    bbox?: string;
    fromDate?: string;
    toDate?: string;
    width?: string;
    height?: string;
    product?: string;
    evalscriptOverride?: string;
  }): Promise<MarineTileResponse> {
    const requestPolicy = this.sentinelPolicy.validateProcessRequest({
      bbox: input.bbox,
      fromDate: input.fromDate,
      toDate: input.toDate,
      width: input.width,
      height: input.height,
      product: input.product,
    });

    const tokenResult = await this.sentinelHubService.getAccessToken(input.tenantId);
    if (!tokenResult) {
      throw new BadRequestException('Sentinel Hub is not configured for this tenant');
    }

    const response = await this.fetchSentinel(`${CDSE_BASE_URL}/api/v1/process`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenResult.accessToken}`,
      },
      body: buildSentinelProcessBody(requestPolicy, input.evalscriptOverride),
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.warn(`Sentinel Hub Process returned ${response.status}: ${errorText}`);
      return {
        status: response.status,
        contentType: 'text/plain; charset=utf-8',
        body: Buffer.from('Sentinel Hub processing request failed'),
      };
    }

    this.sentinelPolicy.assertImageResponse(
      response.headers.get('content-type'),
      response.headers.get('content-length'),
    );
    const body = Buffer.from(await response.arrayBuffer());
    this.sentinelPolicy.assertResponseBytes(body.byteLength);

    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? 'image/png',
      body,
    };
  }

  async analyzeAoi(input: MarineAoiAnalysisRequest): Promise<MarineTileResponse> {
    const layer = this.requireSentinelLayer(input.layerId);
    return this.fetchSentinelProcess({
      tenantId: input.tenantId,
      bbox: input.bbox,
      fromDate: input.fromDate,
      toDate: input.toDate,
      width: input.width,
      height: input.height,
      product: layer.product,
    });
  }

  private requireMarineLayer(layerId: string): MarineLayerDefinition {
    const layer = findMarineLayer(layerId);
    if (!layer) {
      throw new BadRequestException(`Unsupported marine layer: ${layerId}`);
    }
    return layer;
  }

  private requireCmemsLayer(layerId: string): CmemsLayerDefinition {
    const layer = findCmemsLayer(layerId);
    if (!layer) {
      throw new BadRequestException(`Unsupported CMEMS layer: ${layerId}`);
    }
    return layer;
  }

  private requireSentinelLayer(layerId: string): SentinelLayerDefinition {
    const layer = findSentinelLayer(layerId);
    if (!layer) {
      throw new BadRequestException(`Unsupported Sentinel layer: ${layerId}`);
    }
    return layer;
  }

  private buildWmtsParams(
    layer: CmemsLayerDefinition,
    params: Record<string, string>,
  ): URLSearchParams {
    return new URLSearchParams({
      SERVICE: 'WMTS',
      VERSION: '1.0.0',
      LAYER: `${layer.product}/${layer.dataset}/${layer.variable}`,
      TILEMATRIXSET: 'EPSG:3857',
      ...params,
    });
  }

  private async fetchCmems(params: URLSearchParams): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(`${CMEMS_WMTS_BASE_URL}?${params.toString()}`, {
        signal: controller.signal,
      });
    } catch (error) {
      this.logger.warn(`CMEMS request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      throw new BadGatewayException('CMEMS request failed');
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchSentinel(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      this.logger.warn(`Sentinel Hub request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      throw new BadGatewayException('Sentinel Hub request failed');
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseCmemsDate(input: string | undefined): string {
    if (!input) {
      return this.latestCmemsDate();
    }
    if (!ISO_DATE_RE.test(input)) {
      throw new BadRequestException('date must use YYYY-MM-DD format');
    }
    const parsed = new Date(`${input}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('date is not a valid date');
    }
    if (input > this.latestCmemsDate()) {
      throw new BadRequestException('Requested CMEMS date is not available yet');
    }
    return input;
  }

  private latestCmemsDate(): string {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - 2);
    date.setUTCHours(0, 0, 0, 0);
    return date.toISOString().slice(0, 10);
  }

  private parseSentinelDate(input: string | undefined): string {
    const value = input ?? this.todayUtcDate();
    if (!ISO_DATE_RE.test(value)) {
      throw new BadRequestException('date must use YYYY-MM-DD format');
    }
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('date is not a valid date');
    }
    if (value > this.todayUtcDate()) {
      throw new BadRequestException('Requested Sentinel date is in the future');
    }
    return value;
  }

  private todayUtcDate(): string {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    return date.toISOString().slice(0, 10);
  }

  private sentinelWindowStart(effectiveDate: string): string {
    const date = new Date(`${effectiveDate}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() - 30);
    return date.toISOString();
  }

  private endOfDayIso(effectiveDate: string): string {
    return `${effectiveDate}T23:59:59.999Z`;
  }

  private parseDepth(input: string | undefined): number {
    const depth = input === undefined ? 0 : Number(input);
    if (!Number.isFinite(depth) || depth < 0 || depth > 5000) {
      throw new BadRequestException('depth must be between 0 and 5000');
    }
    return depth;
  }

  private parseTileMatrix(input: string, maxTileMatrix: number, minTileMatrix = 0): number {
    const tileMatrix = this.parseInteger('TILEMATRIX', input);
    if (tileMatrix < minTileMatrix || tileMatrix > maxTileMatrix) {
      throw new BadRequestException(`TILEMATRIX must be between ${minTileMatrix} and ${maxTileMatrix}`);
    }
    return tileMatrix;
  }

  private parseZoom(input: string | undefined, maxZoom: number): number {
    const zoom = input === undefined ? 8 : this.parseInteger('zoom', input);
    if (zoom < 0 || zoom > maxZoom) {
      throw new BadRequestException(`zoom must be between 0 and ${maxZoom}`);
    }
    return zoom;
  }

  private parseTileCoordinate(name: string, input: string, tileMatrix: number): number {
    const value = this.parseInteger(name, input);
    const exclusiveMax = 2 ** tileMatrix;
    if (value < 0 || value >= exclusiveMax) {
      throw new BadRequestException(`${name} is outside the TILEMATRIX bounds`);
    }
    return value;
  }

  private parseInteger(name: string, input: string): number {
    const parsed = Number(input);
    if (!Number.isInteger(parsed)) {
      throw new BadRequestException(`${name} must be an integer`);
    }
    return parsed;
  }

  private parseLatitude(input: string): number {
    const lat = Number(input);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new BadRequestException('lat must be between -90 and 90');
    }
    return lat;
  }

  private parseLongitude(input: string): number {
    const lng = Number(input);
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      throw new BadRequestException('lng must be between -180 and 180');
    }
    return lng;
  }

  private tileToBbox4326(
    tileCol: number,
    tileRow: number,
    tileMatrix: number,
  ): [number, number, number, number] {
    const n = 2 ** tileMatrix;
    const west = (tileCol / n) * 360 - 180;
    const east = ((tileCol + 1) / n) * 360 - 180;
    const north = this.tileYToLatitude(tileRow, n);
    const south = this.tileYToLatitude(tileRow + 1, n);
    return [west, south, east, north];
  }

  private tileYToLatitude(tileY: number, scale: number): number {
    const mercator = Math.PI * (1 - (2 * tileY) / scale);
    return (Math.atan(Math.sinh(mercator)) * 180) / Math.PI;
  }

  private pointBbox(lat: number, lng: number): [number, number, number, number] {
    const buffer = SENTINEL_POINT_BBOX_BUFFER_DEG;
    return [
      Math.max(-180, lng - buffer),
      Math.max(-90, lat - buffer),
      Math.min(180, lng + buffer),
      Math.min(90, lat + buffer),
    ];
  }

  private calculateTileCoords(
    lat: number,
    lng: number,
    zoom: number,
  ): { tileCol: number; tileRow: number; pixelI: number; pixelJ: number } {
    const n = 2 ** zoom;
    const x = ((lng + 180) / 360) * n;
    const latRad = (lat * Math.PI) / 180;
    const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
    const tileCol = Math.floor(x);
    const tileRow = Math.floor(y);

    return {
      tileCol,
      tileRow,
      pixelI: Math.floor((x - tileCol) * TILE_SIZE),
      pixelJ: Math.floor((y - tileRow) * TILE_SIZE),
    };
  }

  private extractPointValue(
    payload: unknown,
    layer: CmemsLayerDefinition,
    lat: number,
    lng: number,
    timestamp: string,
  ): MarinePointResponse | null {
    if (!this.isRecord(payload) || !Array.isArray(payload.features)) {
      return null;
    }
    const firstFeature = payload.features[0];
    if (!this.isRecord(firstFeature) || !this.isRecord(firstFeature.properties)) {
      return null;
    }
    const props = firstFeature.properties;
    return {
      lat: this.numberOrDefault(props.lat, lat),
      lng: this.numberOrDefault(props.lon, lng),
      value: this.numberOrNull(props.value),
      unit: this.stringOrDefault(props.units, layer.unit),
      variableId: layer.id,
      datasetId: this.stringOrDefault(props.datasetId, layer.dataset),
      timestamp,
    };
  }

  private async decodeSentinelPoint(
    buffer: Buffer,
    definition: SentinelPointProductDefinition,
  ): Promise<{ value: number | null; quality: SentinelPointQuality }> {
    const decoded = await sharp(buffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = decoded.info;
    if (width < 1 || height < 1 || channels < 4) {
      return { value: null, quality: 'no_data' };
    }

    // Sample the centre pixel of the rendered window (the requested lat/lng).
    const centre = (Math.floor(height / 2) * width + Math.floor(width / 2)) * channels;
    if (decoded.data.byteLength < centre + 4) {
      return { value: null, quality: 'no_data' };
    }

    const red = decoded.data[centre] ?? 0;
    const green = decoded.data[centre + 1] ?? 0;
    const blue = decoded.data[centre + 2] ?? 0;
    const alpha = decoded.data[centre + 3] ?? 0;

    if (alpha === 0 || blue === 0) {
      return { value: null, quality: 'no_data' };
    }
    if (blue < 150) {
      return { value: null, quality: 'land' };
    }
    if (blue < 220) {
      return { value: null, quality: 'cloud' };
    }

    const normalized = ((red << 8) | green) / 65535;
    return {
      value: definition.min + normalized * (definition.max - definition.min),
      quality: 'good',
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private numberOrDefault(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  private numberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private stringOrDefault(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value : fallback;
  }
}
