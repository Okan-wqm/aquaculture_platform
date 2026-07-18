import { BadRequestException, Injectable } from '@nestjs/common';

import {
  type SentinelProcessProductDefinition,
  getSentinelProcessProduct,
} from './sentinel-product-registry';

export const MAX_BBOX_DEGREES_AREA = 1;
const MAX_DATE_RANGE_DAYS = 31;
const MIN_DIMENSION = 64;
const MAX_DIMENSION = 2048;
const MAX_PIXELS = 4_194_304;
const MAX_RESPONSE_BYTES = 15 * 1024 * 1024;

const ALLOWED_COLLECTIONS = new Set(['sentinel-2-l2a', 'sentinel-2-l1c']);
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/tiff']);
const ALLOWED_JSON_TYPES = new Set(['application/json', 'application/geo+json']);
const SAFE_LAYER_ID_REGEX = /^[A-Za-z0-9_-]+$/;

export interface ProcessPolicyResult {
  bbox: number[];
  fromIso: string;
  toIso: string;
  width: number;
  height: number;
  collection: string;
  evalscript: string;
}

export interface CatalogPolicyResult {
  bbox: number[];
  datetime: string;
  collections: string[];
  limit: number;
}

export interface WmsPolicyResult {
  queryParams: URLSearchParams;
}

@Injectable()
export class SentinelProxyPolicy {
  validateProcessRequest(input: {
    bbox?: string;
    fromDate?: string;
    toDate?: string;
    width?: string;
    height?: string;
    product?: string;
    evalscript?: string;
    collection?: string;
  }): ProcessPolicyResult {
    if (input.evalscript) {
      throw new BadRequestException('Client-provided evalscript is not accepted');
    }
    if (input.collection) {
      throw new BadRequestException('Client-provided collection is not accepted for process requests');
    }

    const product = this.parseProduct(input.product);
    const dates = this.parseDateRange(input.fromDate, input.toDate);
    const width = this.parseDimension('width', input.width, 512);
    const height = this.parseDimension('height', input.height, 512);
    this.assertPixelLimit(width, height);

    return {
      bbox: this.parseBbox(input.bbox),
      fromIso: dates.fromIso,
      toIso: dates.toIso,
      width,
      height,
      collection: product.collection,
      evalscript: product.evalscript,
    };
  }

  validateCatalogRequest(input: {
    bbox?: string;
    fromDate?: string;
    toDate?: string;
    collections?: string;
  }): CatalogPolicyResult {
    const dates = this.parseDateRange(input.fromDate, input.toDate);
    const collections = input.collections
      ? input.collections.split(',').map((value) => value.trim()).filter(Boolean)
      : ['sentinel-2-l2a'];

    if (collections.length === 0 || collections.length > ALLOWED_COLLECTIONS.size) {
      throw new BadRequestException('Invalid collection set');
    }
    for (const collection of collections) {
      if (!ALLOWED_COLLECTIONS.has(collection)) {
        throw new BadRequestException(`Collection is not allowed: ${collection}`);
      }
    }

    return {
      bbox: this.parseBbox(input.bbox),
      datetime: `${dates.fromIso}/${dates.toIso}`,
      collections,
      limit: 100,
    };
  }

  validateWmsRequest(layerId: string, rawQuery: Record<string, unknown>): WmsPolicyResult {
    if (!SAFE_LAYER_ID_REGEX.test(layerId)) {
      throw new BadRequestException('Invalid layer ID format');
    }

    const query = new URLSearchParams();
    const bbox = this.parseBbox(this.firstQueryValue(rawQuery.bbox));
    query.set('bbox', bbox.join(','));

    const width = this.parseDimension('width', this.firstQueryValue(rawQuery.width), 512);
    const height = this.parseDimension('height', this.firstQueryValue(rawQuery.height), 512);
    this.assertPixelLimit(width, height);
    query.set('width', String(width));
    query.set('height', String(height));

    const format = this.firstQueryValue(rawQuery.format) ?? 'image/png';
    if (!ALLOWED_IMAGE_TYPES.has(format)) {
      throw new BadRequestException('Requested image format is not allowed');
    }
    query.set('format', format);

    const service = this.firstQueryValue(rawQuery.service);
    if (service) query.set('service', this.assertOneOf('service', service, ['WMS', 'WMTS']));

    const request = this.firstQueryValue(rawQuery.request);
    if (request) query.set('request', this.assertOneOf('request', request, ['GetMap', 'GetTile']));

    const version = this.firstQueryValue(rawQuery.version);
    if (version) query.set('version', this.assertOneOf('version', version, ['1.1.1', '1.3.0']));

    const crs = this.firstQueryValue(rawQuery.crs) ?? this.firstQueryValue(rawQuery.srs);
    if (crs) query.set('crs', this.assertOneOf('crs', crs, ['EPSG:4326', 'EPSG:3857']));

    const layers = this.firstQueryValue(rawQuery.layers);
    if (layers) {
      if (!SAFE_LAYER_ID_REGEX.test(layers)) throw new BadRequestException('Invalid layers format');
      query.set('layers', layers);
    }

    const time = this.firstQueryValue(rawQuery.time);
    if (time) query.set('time', this.normalizeWmsTime(time));

    const transparent = this.firstQueryValue(rawQuery.transparent);
    if (transparent) query.set('transparent', this.assertOneOf('transparent', transparent.toLowerCase(), ['true', 'false']));

    return { queryParams: query };
  }

  assertImageResponse(contentType: string | null, contentLength: string | null): void {
    this.assertResponse('image response', contentType, contentLength, ALLOWED_IMAGE_TYPES);
  }

  assertJsonResponse(contentType: string | null, contentLength: string | null): void {
    this.assertResponse('JSON response', contentType, contentLength, ALLOWED_JSON_TYPES);
  }

  assertResponseBytes(byteLength: number): void {
    if (byteLength > MAX_RESPONSE_BYTES) {
      throw new BadRequestException('Sentinel Hub response is too large');
    }
  }

  private parseProduct(value: string | undefined): SentinelProcessProductDefinition {
    const product = getSentinelProcessProduct(value);
    if (!product) {
      throw new BadRequestException('Unsupported Sentinel product');
    }
    return product;
  }

  private parseBbox(value: string | undefined): number[] {
    if (!value) {
      throw new BadRequestException('Missing required parameter: bbox');
    }
    const parts = value.split(',').map((part) => Number(part.trim()));
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
      throw new BadRequestException('Invalid bbox format. Expected: minLon,minLat,maxLon,maxLat');
    }
    const [minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number];
    if (minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90) {
      throw new BadRequestException('bbox is outside EPSG:4326 bounds');
    }
    if (minLon >= maxLon || minLat >= maxLat) {
      throw new BadRequestException('bbox minimums must be smaller than maximums');
    }
    if ((maxLon - minLon) * (maxLat - minLat) > MAX_BBOX_DEGREES_AREA) {
      throw new BadRequestException('bbox area exceeds the allowed limit');
    }
    return parts;
  }

  private parseDateRange(fromDate: string | undefined, toDate: string | undefined): { fromIso: string; toIso: string } {
    if (!fromDate || !toDate) {
      throw new BadRequestException('Missing required parameters: fromDate, toDate');
    }
    const from = this.parseDate('fromDate', fromDate);
    const to = this.parseDate('toDate', toDate);
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('fromDate must be before toDate');
    }
    const maxRangeMs = MAX_DATE_RANGE_DAYS * 24 * 60 * 60 * 1000;
    if (to.getTime() - from.getTime() > maxRangeMs) {
      throw new BadRequestException(`Date range cannot exceed ${MAX_DATE_RANGE_DAYS} days`);
    }
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    if (from > tomorrow || to > tomorrow) {
      throw new BadRequestException('Date range cannot be in the future');
    }
    return { fromIso: from.toISOString(), toIso: to.toISOString() };
  }

  private parseDate(name: string, value: string): Date {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`${name} must be a valid ISO date`);
    }
    return parsed;
  }

  private parseDimension(name: 'width' | 'height', value: string | undefined, defaultValue: number): number {
    const parsed = value ? Number(value) : defaultValue;
    if (!Number.isInteger(parsed) || parsed < MIN_DIMENSION || parsed > MAX_DIMENSION) {
      throw new BadRequestException(`${name} must be an integer between ${MIN_DIMENSION} and ${MAX_DIMENSION}`);
    }
    return parsed;
  }

  private assertPixelLimit(width: number, height: number): void {
    if (width * height > MAX_PIXELS) {
      throw new BadRequestException('Requested image dimensions exceed the pixel limit');
    }
  }

  private assertResponse(name: string, contentType: string | null, contentLength: string | null, allowedTypes: Set<string>): void {
    const normalized = (contentType ?? '').split(';')[0]?.trim().toLowerCase();
    if (!normalized || !allowedTypes.has(normalized)) {
      throw new BadRequestException(`Sentinel Hub ${name} content type is not allowed`);
    }
    if (contentLength) {
      const length = Number(contentLength);
      if (!Number.isFinite(length) || length > MAX_RESPONSE_BYTES) {
        throw new BadRequestException(`Sentinel Hub ${name} content length is not allowed`);
      }
    }
  }

  private normalizeWmsTime(value: string): string {
    if (value.includes('/')) {
      const [from, to] = value.split('/', 2);
      const range = this.parseDateRange(from, to);
      return `${range.fromIso}/${range.toIso}`;
    }
    return this.parseDate('time', value).toISOString();
  }

  private firstQueryValue(value: unknown): string | undefined {
    if (Array.isArray(value)) return this.firstQueryValue(value[0]);
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }

  private assertOneOf(name: string, value: string, allowed: string[]): string {
    if (!allowed.includes(value)) {
      throw new BadRequestException(`${name} is not allowed`);
    }
    return value;
  }
}
