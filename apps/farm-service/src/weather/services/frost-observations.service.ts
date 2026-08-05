import { Inject, Injectable, Optional } from '@nestjs/common';

import {
  buildMetNorwayUserAgent,
  isUnknownRecord,
  MET_NORWAY_CLOCK,
  MET_NORWAY_FETCH,
  MET_NORWAY_PROVIDER_CONFIG,
  MetNorwayClock,
  MetNorwayFetch,
  MetNorwayHttpClient,
  MetNorwayProvider,
  MetNorwayProviderConfig,
  MetNorwayProviderError,
  MetNorwayProviderErrorCode,
  metSchemaError,
  normalizeUtcTimestamp,
  requireFiniteNumber,
} from './met-norway-provider';

const FROST_ORIGIN = 'https://frost.met.no';
const FROST_SOURCES_PATH = '/sources/v0.jsonld';
const FROST_OBSERVATIONS_PATH = '/observations/v0.jsonld';
const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const CHUNK_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * Product-level locality boundary for observations presented as relevant to a
 * farm site. Frost's nearest-source query has no distance ceiling, so the
 * returned station must pass this contract before any observations are read.
 */
export const FROST_ACCEPTED_MAX_STATION_DISTANCE_KM = 25;

export enum FrostElementId {
  AIR_TEMPERATURE = 'air_temperature',
  WIND_SPEED = 'wind_speed',
  WIND_FROM_DIRECTION = 'wind_from_direction',
  RELATIVE_HUMIDITY = 'relative_humidity',
  SURFACE_AIR_PRESSURE = 'surface_air_pressure',
  HOURLY_PRECIPITATION = 'sum(precipitation_amount PT1H)',
}

export const FROST_DEFAULT_ELEMENTS: readonly FrostElementId[] = [
  FrostElementId.AIR_TEMPERATURE,
  FrostElementId.WIND_SPEED,
  FrostElementId.WIND_FROM_DIRECTION,
  FrostElementId.RELATIVE_HUMIDITY,
  FrostElementId.HOURLY_PRECIPITATION,
];

export interface FrostHistoryRequest {
  latitude: number;
  longitude: number;
  elements?: readonly FrostElementId[];
}

export interface FrostStation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  distanceKm: number;
}

export enum FrostQualityStatus {
  CONTROLLED_OK = 'CONTROLLED_OK',
  CONTROLLED_CORRECTED = 'CONTROLLED_CORRECTED',
  SLIGHTLY_UNCERTAIN = 'SLIGHTLY_UNCERTAIN',
  VERY_UNCERTAIN = 'VERY_UNCERTAIN',
  ERRONEOUS = 'ERRONEOUS',
  UNKNOWN = 'UNKNOWN',
}

export interface FrostObservation {
  stationId: string;
  referenceTime: string;
  elementId: FrostElementId;
  value: number;
  unit: string;
  qualityCode: number;
  qualityStatus: FrostQualityStatus;
  timeOffset: string | null;
  timeResolution: string | null;
}

export interface FrostMissingInterval {
  elementId: FrostElementId;
  from: string;
  to: string;
  reason: 'NO_OBSERVATIONS';
}

export interface FrostElementCoverage {
  elementId: FrostElementId;
  status: 'AVAILABLE' | 'NO_DATA';
  observationCount: number;
}

export interface FrostHistoryAvailable {
  status: 'AVAILABLE';
  provider: MetNorwayProvider.FROST;
  fetchedAt: string;
  requestedFrom: string;
  requestedTo: string;
  station: FrostStation;
  elements: FrostElementId[];
  observations: FrostObservation[];
  elementCoverage: FrostElementCoverage[];
  missingIntervals: FrostMissingInterval[];
}

export interface FrostHistoryNoCoverage {
  status: 'NO_COVERAGE';
  provider: MetNorwayProvider.FROST;
  fetchedAt: string;
  requestedFrom: string;
  requestedTo: string;
  reason: 'NO_STATION_WITH_REQUIRED_ELEMENTS' | 'NO_OBSERVATIONS';
}

export type FrostHistoryResult = FrostHistoryAvailable | FrostHistoryNoCoverage;

interface FrostChunk {
  from: Date;
  to: Date;
}

const FROST_STATION_ID_PATTERN = /^SN\d+$/u;
const FROST_ELEMENT_IDS = new Set<string>(Object.values(FrostElementId));

function isFrostElementId(value: string): value is FrostElementId {
  return FROST_ELEMENT_IDS.has(value);
}

function isValidFrostClientId(value: string): boolean {
  if (value.length === 0 || value.length > 512 || value.includes(':') || /\s/u.test(value)) {
    return false;
  }
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
  });
}

function validateRequest(request: FrostHistoryRequest): FrostElementId[] {
  if (!Number.isFinite(request.latitude) || request.latitude < -90 || request.latitude > 90) {
    throw new RangeError('latitude must be a finite number between -90 and 90');
  }
  if (!Number.isFinite(request.longitude) || request.longitude < -180 || request.longitude > 180) {
    throw new RangeError('longitude must be a finite number between -180 and 180');
  }

  const elements = request.elements
    ? Array.from(new Set(request.elements))
    : [...FROST_DEFAULT_ELEMENTS];
  if (elements.length === 0) {
    throw new RangeError('at least one Frost element is required');
  }
  if (elements.some((element) => !FROST_ELEMENT_IDS.has(element))) {
    throw new RangeError('unsupported Frost element requested');
  }
  return elements;
}

function requireRecord(
  parent: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> {
  const value = parent[key];
  if (!isUnknownRecord(value)) throw metSchemaError(MetNorwayProvider.FROST, path);
  return value;
}

function requireString(parent: Record<string, unknown>, key: string, path: string): string {
  const value = parent[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw metSchemaError(MetNorwayProvider.FROST, path);
  }
  return value;
}

function parseStation(payload: unknown): FrostStation | null {
  if (!isUnknownRecord(payload) || !Array.isArray(payload.data)) {
    throw metSchemaError(MetNorwayProvider.FROST, 'data');
  }
  if (payload.data.length === 0) return null;

  const rawStation = payload.data[0];
  if (!isUnknownRecord(rawStation)) {
    throw metSchemaError(MetNorwayProvider.FROST, 'data[0]');
  }
  const geometry = requireRecord(rawStation, 'geometry', 'data[0].geometry');
  if (geometry.type !== 'Point' || !Array.isArray(geometry.coordinates)) {
    throw metSchemaError(MetNorwayProvider.FROST, 'data[0].geometry');
  }
  if (geometry.coordinates.length < 2) {
    throw metSchemaError(MetNorwayProvider.FROST, 'data[0].geometry.coordinates');
  }

  const id = requireString(rawStation, 'id', 'data[0].id');
  if (!FROST_STATION_ID_PATTERN.test(id)) {
    throw metSchemaError(MetNorwayProvider.FROST, 'data[0].id');
  }
  const longitude = requireFiniteNumber(
    MetNorwayProvider.FROST,
    geometry.coordinates[0],
    'data[0].geometry.coordinates[0]',
  );
  const latitude = requireFiniteNumber(
    MetNorwayProvider.FROST,
    geometry.coordinates[1],
    'data[0].geometry.coordinates[1]',
  );
  const distanceKm = requireFiniteNumber(
    MetNorwayProvider.FROST,
    rawStation.distance,
    'data[0].distance',
  );
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    throw metSchemaError(MetNorwayProvider.FROST, 'data[0].geometry');
  }
  if (distanceKm < 0) {
    throw metSchemaError(MetNorwayProvider.FROST, 'data[0].distance');
  }

  return {
    id,
    name: requireString(rawStation, 'name', 'data[0].name'),
    longitude,
    latitude,
    distanceKm,
  };
}

function parseQualityStatus(qualityCode: number): FrostQualityStatus {
  switch (qualityCode) {
    case 0:
      return FrostQualityStatus.CONTROLLED_OK;
    case 1:
      return FrostQualityStatus.CONTROLLED_CORRECTED;
    case 2:
    case 3:
    case 4:
      return FrostQualityStatus.SLIGHTLY_UNCERTAIN;
    case 5:
    case 6:
      return FrostQualityStatus.VERY_UNCERTAIN;
    case 7:
      return FrostQualityStatus.ERRONEOUS;
    default:
      return FrostQualityStatus.UNKNOWN;
  }
}

function assertFrostObservationRange(elementId: FrostElementId, value: number, path: string): void {
  let valid: boolean;
  switch (elementId) {
    case FrostElementId.AIR_TEMPERATURE:
      valid = value >= -273.15;
      break;
    case FrostElementId.WIND_SPEED:
    case FrostElementId.HOURLY_PRECIPITATION:
      valid = value >= 0;
      break;
    case FrostElementId.WIND_FROM_DIRECTION:
      valid = value >= 0 && value <= 360;
      break;
    case FrostElementId.RELATIVE_HUMIDITY:
      valid = value >= 0 && value <= 100;
      break;
    case FrostElementId.SURFACE_AIR_PRESSURE:
      valid = value > 0;
      break;
  }
  if (!valid) {
    throw metSchemaError(MetNorwayProvider.FROST, path);
  }
}

function readOptionalString(
  parent: Record<string, unknown>,
  key: string,
  path: string,
): string | null {
  const value = parent[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw metSchemaError(MetNorwayProvider.FROST, path);
  return value;
}

function parseObservationPage(
  payload: unknown,
  station: FrostStation,
  requestedElements: ReadonlySet<FrostElementId>,
  chunk: FrostChunk,
): FrostObservation[] {
  if (!isUnknownRecord(payload) || !Array.isArray(payload.data)) {
    throw metSchemaError(MetNorwayProvider.FROST, 'data');
  }
  if (payload.nextLink !== undefined && payload.nextLink !== null) {
    throw new MetNorwayProviderError({
      provider: MetNorwayProvider.FROST,
      code: MetNorwayProviderErrorCode.RESPONSE_TOO_LARGE,
      message: 'FROST observation chunk requires unexpected pagination',
      retryable: false,
    });
  }

  const observations: FrostObservation[] = [];
  payload.data.forEach((rawGroup, groupIndex) => {
    const groupPath = `data[${groupIndex}]`;
    if (!isUnknownRecord(rawGroup)) {
      throw metSchemaError(MetNorwayProvider.FROST, groupPath);
    }
    const sourceId = requireString(rawGroup, 'sourceId', `${groupPath}.sourceId`);
    const canonicalSourceId = sourceId.split(':', 1)[0];
    if (canonicalSourceId !== station.id) {
      throw metSchemaError(MetNorwayProvider.FROST, `${groupPath}.sourceId`);
    }
    const referenceTime = normalizeUtcTimestamp(
      MetNorwayProvider.FROST,
      rawGroup.referenceTime,
      `${groupPath}.referenceTime`,
    );
    const referenceTimeMs = new Date(referenceTime).getTime();
    if (referenceTimeMs < chunk.from.getTime() || referenceTimeMs >= chunk.to.getTime()) {
      throw metSchemaError(MetNorwayProvider.FROST, `${groupPath}.referenceTime`);
    }
    if (!Array.isArray(rawGroup.observations)) {
      throw metSchemaError(MetNorwayProvider.FROST, `${groupPath}.observations`);
    }

    rawGroup.observations.forEach((rawObservation, observationIndex) => {
      const path = `${groupPath}.observations[${observationIndex}]`;
      if (!isUnknownRecord(rawObservation)) {
        throw metSchemaError(MetNorwayProvider.FROST, path);
      }
      const rawElementId = requireString(rawObservation, 'elementId', `${path}.elementId`);
      if (!isFrostElementId(rawElementId) || !requestedElements.has(rawElementId)) return;
      const elementId = rawElementId;
      const qualityCode = requireFiniteNumber(
        MetNorwayProvider.FROST,
        rawObservation.qualityCode,
        `${path}.qualityCode`,
      );
      if (!Number.isInteger(qualityCode)) {
        throw metSchemaError(MetNorwayProvider.FROST, `${path}.qualityCode`);
      }
      const value = requireFiniteNumber(
        MetNorwayProvider.FROST,
        rawObservation.value,
        `${path}.value`,
      );
      assertFrostObservationRange(elementId, value, `${path}.value`);

      observations.push({
        stationId: station.id,
        referenceTime,
        elementId,
        value,
        unit: requireString(rawObservation, 'unit', `${path}.unit`),
        qualityCode,
        qualityStatus: parseQualityStatus(qualityCode),
        timeOffset: readOptionalString(rawObservation, 'timeOffset', `${path}.timeOffset`),
        timeResolution: readOptionalString(
          rawObservation,
          'timeResolution',
          `${path}.timeResolution`,
        ),
      });
    });
  });
  return observations;
}

function buildChunks(from: Date, to: Date): FrostChunk[] {
  const chunks: FrostChunk[] = [];
  let cursor = from.getTime();
  while (cursor < to.getTime()) {
    const next = Math.min(cursor + CHUNK_WINDOW_MS, to.getTime());
    chunks.push({ from: new Date(cursor), to: new Date(next) });
    cursor = next;
  }
  return chunks;
}

function observationKey(observation: FrostObservation): string {
  return [
    observation.stationId,
    observation.referenceTime,
    observation.elementId,
    observation.timeOffset ?? '',
    observation.timeResolution ?? '',
  ].join('|');
}

@Injectable()
export class FrostObservationsService {
  private readonly http: MetNorwayHttpClient;
  private readonly clock: MetNorwayClock;
  private readonly userAgent: string;
  private readonly frostClientId: string | null;

  constructor(
    @Inject(MET_NORWAY_PROVIDER_CONFIG)
    config: MetNorwayProviderConfig,
    @Optional() @Inject(MET_NORWAY_FETCH) fetchFn?: MetNorwayFetch,
    @Optional() @Inject(MET_NORWAY_CLOCK) clock?: MetNorwayClock,
  ) {
    this.clock = clock ?? { now: (): Date => new Date() };
    this.http = new MetNorwayHttpClient(fetchFn, this.clock);
    this.userAgent = buildMetNorwayUserAgent(config, MetNorwayProvider.FROST);
    this.frostClientId =
      typeof config.frostClientId === 'string' && config.frostClientId.trim().length > 0
        ? config.frostClientId.trim()
        : null;
  }

  async fetchLast30Days(request: FrostHistoryRequest): Promise<FrostHistoryResult> {
    const elements = validateRequest(request);
    const windowAnchor = this.clock.now();
    const from = new Date(windowAnchor.getTime() - HISTORY_WINDOW_MS);
    const commonResult = {
      provider: MetNorwayProvider.FROST,
      requestedFrom: from.toISOString(),
      requestedTo: windowAnchor.toISOString(),
    } as const;

    const authorization = this.buildAuthorization();
    const station = await this.findNearestStation(
      request.latitude,
      request.longitude,
      elements,
      authorization,
    );
    if (!station) {
      return {
        status: 'NO_COVERAGE',
        ...commonResult,
        fetchedAt: this.clock.now().toISOString(),
        reason: 'NO_STATION_WITH_REQUIRED_ELEMENTS',
      };
    }

    const requestedElements = new Set(elements);
    const observations = new Map<string, FrostObservation>();
    const missingIntervals: FrostMissingInterval[] = [];
    for (const chunk of buildChunks(from, windowAnchor)) {
      const result = await this.fetchObservationChunk(
        station,
        elements,
        requestedElements,
        chunk,
        authorization,
      );
      const returnedElements = new Set((result ?? []).map(({ elementId }) => elementId));
      for (const elementId of elements) {
        if (!returnedElements.has(elementId)) {
          missingIntervals.push({
            elementId,
            from: chunk.from.toISOString(),
            to: chunk.to.toISOString(),
            reason: 'NO_OBSERVATIONS',
          });
        }
      }
      (result ?? []).forEach((observation) => {
        observations.set(observationKey(observation), observation);
      });
    }

    if (observations.size === 0) {
      return {
        status: 'NO_COVERAGE',
        ...commonResult,
        fetchedAt: this.clock.now().toISOString(),
        reason: 'NO_OBSERVATIONS',
      };
    }

    const orderedObservations = [...observations.values()].sort((left, right) => {
      const timeDifference =
        new Date(left.referenceTime).getTime() - new Date(right.referenceTime).getTime();
      return timeDifference || left.elementId.localeCompare(right.elementId);
    });
    const observationCountByElement = new Map<FrostElementId, number>();
    orderedObservations.forEach((observation) => {
      observationCountByElement.set(
        observation.elementId,
        (observationCountByElement.get(observation.elementId) ?? 0) + 1,
      );
    });

    return {
      status: 'AVAILABLE',
      ...commonResult,
      fetchedAt: this.clock.now().toISOString(),
      station,
      elements,
      observations: orderedObservations,
      elementCoverage: elements.map((elementId) => {
        const observationCount = observationCountByElement.get(elementId) ?? 0;
        return {
          elementId,
          status: observationCount > 0 ? 'AVAILABLE' : 'NO_DATA',
          observationCount,
        };
      }),
      missingIntervals,
    };
  }

  private buildAuthorization(): string {
    if (!this.frostClientId || !isValidFrostClientId(this.frostClientId)) {
      throw new MetNorwayProviderError({
        provider: MetNorwayProvider.FROST,
        code: MetNorwayProviderErrorCode.CONFIGURATION,
        message: 'Frost client ID is not configured',
        retryable: false,
      });
    }
    return `Basic ${Buffer.from(`${this.frostClientId}:`, 'utf8').toString('base64')}`;
  }

  private async findNearestStation(
    latitude: number,
    longitude: number,
    elements: FrostElementId[],
    authorization: string,
  ): Promise<FrostStation | null> {
    const url = new URL(FROST_SOURCES_PATH, FROST_ORIGIN);
    url.searchParams.set(
      'geometry',
      `nearest(POINT(${longitude.toFixed(4)} ${latitude.toFixed(4)}))`,
    );
    url.searchParams.set('nearestmaxcount', '1');
    url.searchParams.set('types', 'SensorSystem');
    url.searchParams.set('validtime', 'now');
    url.searchParams.set('elements', elements.join(','));
    url.searchParams.set('fields', 'id,name,geometry,distance');

    const response = await this.http.getJson({
      provider: MetNorwayProvider.FROST,
      url,
      allowedOrigin: FROST_ORIGIN,
      allowedPath: FROST_SOURCES_PATH,
      headers: {
        Accept: 'application/ld+json, application/json',
        Authorization: authorization,
        'User-Agent': this.userAgent,
      },
    });
    if (response.status === 'NO_COVERAGE') return null;

    const station = parseStation(response.payload);
    return station !== null && station.distanceKm <= FROST_ACCEPTED_MAX_STATION_DISTANCE_KM
      ? station
      : null;
  }

  private async fetchObservationChunk(
    station: FrostStation,
    elements: FrostElementId[],
    requestedElements: ReadonlySet<FrostElementId>,
    chunk: FrostChunk,
    authorization: string,
  ): Promise<FrostObservation[] | null> {
    const url = new URL(FROST_OBSERVATIONS_PATH, FROST_ORIGIN);
    url.searchParams.set('sources', station.id);
    url.searchParams.set('referencetime', `${chunk.from.toISOString()}/${chunk.to.toISOString()}`);
    url.searchParams.set('elements', elements.join(','));
    url.searchParams.set('qualities', '0,1,2,3,4');
    url.searchParams.set('levels', 'default');
    url.searchParams.set('timeoffsets', 'default');
    url.searchParams.set('timeseriesids', '0');

    const response = await this.http.getJson({
      provider: MetNorwayProvider.FROST,
      url,
      allowedOrigin: FROST_ORIGIN,
      allowedPath: FROST_OBSERVATIONS_PATH,
      headers: {
        Accept: 'application/ld+json, application/json',
        Authorization: authorization,
        'User-Agent': this.userAgent,
      },
    });
    if (response.status === 'NO_COVERAGE') return null;
    const observations = parseObservationPage(response.payload, station, requestedElements, chunk);
    return observations.length === 0 ? null : observations;
  }
}
