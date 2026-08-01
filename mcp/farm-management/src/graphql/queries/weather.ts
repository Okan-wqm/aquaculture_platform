// ============================================================================
// MCP Farm Intelligence — canonical site environment queries
// ============================================================================
//
// The farm subgraph exposes one provenance-bearing environment contract for
// atmospheric and marine values. This module maps that metric stream into the
// compact weather shapes consumed by the existing intelligence tools.

import type { GraphQLClient } from '../client.js';

export type EnvironmentMetric =
  | 'AIR_TEMPERATURE'
  | 'WIND_SPEED'
  | 'WIND_DIRECTION'
  | 'WIND_GUST'
  | 'PRECIPITATION'
  | 'CLOUD_COVER'
  | 'PRESSURE_MSL'
  | 'RELATIVE_HUMIDITY'
  | 'WAVE_HEIGHT'
  | 'WAVE_DIRECTION'
  | 'WAVE_PERIOD'
  | 'CURRENT_SPEED'
  | 'CURRENT_DIRECTION'
  | 'SEA_TEMPERATURE'
  | 'SALINITY'
  | 'DISSOLVED_OXYGEN'
  | 'MODEL_CHLOROPHYLL';

export type EnvironmentProvider =
  | 'MET_LOCATIONFORECAST'
  | 'MET_FROST'
  | 'CMEMS'
  | 'CDSE_SENTINEL_2';

export type EnvironmentSemanticClass =
  | 'OBSERVATION'
  | 'ANALYSIS'
  | 'FORECAST'
  | 'SATELLITE_ACQUISITION'
  | 'INDICATOR'
  | 'IMAGERY';

export type EnvironmentQualityStatus =
  | 'VALID'
  | 'PROVISIONAL'
  | 'NO_DATA'
  | 'CLOUD_OBSCURED'
  | 'OUT_OF_COVERAGE'
  | 'STALE'
  | 'PROVIDER_UNAVAILABLE'
  | 'CONFIGURATION_ERROR';

export type EnvironmentFreshness = 'CURRENT' | 'STALE' | 'UNAVAILABLE';

interface EnvironmentValueResponse {
  metric: EnvironmentMetric;
  value: number;
  unit: string;
  source: EnvironmentProvider;
  semanticClass: EnvironmentSemanticClass;
  validAt: string;
  issuedAt: string | null;
  fetchedAt: string;
  qualityStatus: EnvironmentQualityStatus;
  depthM: number | null;
  requestedDepthM: number | null;
  datasetId: string;
  productId: string;
  variableId: string;
  resolutionM: number | null;
  gridCellDistanceM: number | null;
  locationRevision: number;
  stationId: string | null;
  stationDistanceKm: number | null;
}

export interface EnvironmentValue extends EnvironmentValueResponse {
  freshness: EnvironmentFreshness;
}

interface SiteEnvironmentValues {
  siteId: string;
  values: EnvironmentValueResponse[];
}

export interface CurrentWeather {
  siteId: string;
  observedAt: string;
  temperature?: number;
  windSpeed?: number;
  windDirection?: number;
  windGusts?: number;
  precipitation?: number;
  cloudCover?: number;
  pressureMsl?: number;
  relativeHumidity?: number;
  waveHeight?: number;
  waveDirection?: number;
  wavePeriod?: number;
  seaSurfaceTemperature?: number;
  fetchedAt: string;
  metrics: EnvironmentValue[];
}

export interface WeatherObservation {
  siteId: string;
  observedAt: string;
  temperature?: number;
  windSpeed?: number;
  windDirection?: number;
  windGusts?: number;
  precipitation?: number;
  cloudCover?: number;
  pressureMsl?: number;
  relativeHumidity?: number;
  fetchedAt: string;
  metrics: EnvironmentValue[];
}

const ENVIRONMENT_VALUE_FIELDS = `
  metric
  value
  unit
  source
  semanticClass
  validAt
  issuedAt
  fetchedAt
  qualityStatus
  depthM
  requestedDepthM
  datasetId
  productId
  variableId
  resolutionM
  gridCellDistanceM
  locationRevision
  stationId
  stationDistanceKm
`;

const WEATHER_HISTORY_METRICS = [
  'AIR_TEMPERATURE',
  'WIND_SPEED',
  'WIND_DIRECTION',
  'WIND_GUST',
  'PRECIPITATION',
  'CLOUD_COVER',
  'PRESSURE_MSL',
  'RELATIVE_HUMIDITY',
] as const satisfies readonly EnvironmentMetric[];

function latestTimestamp(
  values: EnvironmentValueResponse[],
  field: 'validAt' | 'fetchedAt',
  initial: string,
): string {
  return values.reduce(
    (latest, value) =>
      new Date(value[field]).getTime() > new Date(latest).getTime() ? value[field] : latest,
    initial,
  );
}

function environmentFreshness(status: EnvironmentQualityStatus): EnvironmentFreshness {
  switch (status) {
    case 'VALID':
    case 'PROVISIONAL':
      return 'CURRENT';
    case 'STALE':
      return 'STALE';
    case 'NO_DATA':
    case 'CLOUD_OBSCURED':
    case 'OUT_OF_COVERAGE':
    case 'PROVIDER_UNAVAILABLE':
    case 'CONFIGURATION_ERROR':
      return 'UNAVAILABLE';
  }
}

function enrichEnvironmentValue(value: EnvironmentValueResponse): EnvironmentValue {
  return {
    ...value,
    freshness: environmentFreshness(value.qualityStatus),
  };
}

function applyEnvironmentValue(
  target: CurrentWeather | WeatherObservation,
  environmentValue: EnvironmentValue,
): void {
  switch (environmentValue.metric) {
    case 'AIR_TEMPERATURE':
      target.temperature = environmentValue.value;
      break;
    case 'WIND_SPEED':
      target.windSpeed = environmentValue.value;
      break;
    case 'WIND_DIRECTION':
      target.windDirection = environmentValue.value;
      break;
    case 'WIND_GUST':
      target.windGusts = environmentValue.value;
      break;
    case 'PRECIPITATION':
      target.precipitation = environmentValue.value;
      break;
    case 'CLOUD_COVER':
      target.cloudCover = environmentValue.value;
      break;
    case 'PRESSURE_MSL':
      target.pressureMsl = environmentValue.value;
      break;
    case 'RELATIVE_HUMIDITY':
      target.relativeHumidity = environmentValue.value;
      break;
    default:
      break;
  }
}

function applyCurrentMarineValue(target: CurrentWeather, environmentValue: EnvironmentValue): void {
  switch (environmentValue.metric) {
    case 'WAVE_HEIGHT':
      target.waveHeight = environmentValue.value;
      break;
    case 'WAVE_DIRECTION':
      target.waveDirection = environmentValue.value;
      break;
    case 'WAVE_PERIOD':
      target.wavePeriod = environmentValue.value;
      break;
    case 'SEA_TEMPERATURE':
      target.seaSurfaceTemperature = environmentValue.value;
      break;
    default:
      break;
  }
}

export async function fetchCurrentWeather(
  client: GraphQLClient,
  siteId: string,
): Promise<CurrentWeather | null> {
  const query = `
    query CurrentWeather($siteId: ID!) {
      siteEnvironmentCurrent(siteId: $siteId) {
        siteId
        values {
          ${ENVIRONMENT_VALUE_FIELDS}
        }
      }
    }
  `;

  const data = await client.query<{ siteEnvironmentCurrent: SiteEnvironmentValues }>(query, {
    siteId,
  });
  const environment = data.siteEnvironmentCurrent;
  const firstValue = environment.values[0];
  if (firstValue === undefined) {
    return null;
  }

  const metrics = environment.values.map(enrichEnvironmentValue);

  const current: CurrentWeather = {
    siteId: environment.siteId,
    observedAt: latestTimestamp(environment.values, 'validAt', firstValue.validAt),
    fetchedAt: latestTimestamp(environment.values, 'fetchedAt', firstValue.fetchedAt),
    metrics,
  };
  for (const value of metrics) {
    if (value.freshness !== 'CURRENT') {
      continue;
    }
    applyEnvironmentValue(current, value);
    applyCurrentMarineValue(current, value);
  }
  return current;
}

export async function fetchWeatherObservations(
  client: GraphQLClient,
  siteId: string,
  from?: string,
  to?: string,
): Promise<WeatherObservation[]> {
  const rangeEnd = to ?? new Date().toISOString();
  const rangeStart =
    from ?? new Date(new Date(rangeEnd).getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const query = `
    query WeatherObservations($input: SiteEnvironmentHistoryInput!) {
      siteEnvironmentHistory(input: $input) {
        siteId
        values {
          ${ENVIRONMENT_VALUE_FIELDS}
        }
      }
    }
  `;

  const data = await client.query<{ siteEnvironmentHistory: SiteEnvironmentValues }>(query, {
    input: {
      siteId,
      metrics: WEATHER_HISTORY_METRICS,
      from: rangeStart,
      to: rangeEnd,
    },
  });
  const environment = data.siteEnvironmentHistory;
  const byTimestamp = new Map<string, WeatherObservation>();
  for (const responseValue of environment.values) {
    const value = enrichEnvironmentValue(responseValue);
    const point = byTimestamp.get(value.validAt) ?? {
      siteId: environment.siteId,
      observedAt: value.validAt,
      fetchedAt: value.fetchedAt,
      metrics: [],
    };
    if (new Date(value.fetchedAt).getTime() > new Date(point.fetchedAt).getTime()) {
      point.fetchedAt = value.fetchedAt;
    }
    point.metrics.push(value);
    if (value.freshness === 'CURRENT') {
      applyEnvironmentValue(point, value);
    }
    byTimestamp.set(value.validAt, point);
  }

  return [...byTimestamp.values()].sort(
    (left, right) => new Date(right.observedAt).getTime() - new Date(left.observedAt).getTime(),
  );
}
