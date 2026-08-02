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
  metSchemaError,
  normalizeUtcTimestamp,
  requireFiniteNumber,
} from './met-norway-provider';

const LOCATIONFORECAST_ORIGIN = 'https://api.met.no';
const LOCATIONFORECAST_PATH = '/weatherapi/locationforecast/2.0/compact';
const FORECAST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CURRENT_LOOKBACK_MS = 60 * 60 * 1000;

export interface MetLocationForecastRequest {
  latitude: number;
  longitude: number;
  altitudeM?: number;
}

export interface MetLocationForecastMeasurement {
  value: number;
  unit: string;
}

export interface MetLocationForecastPrecipitation {
  amount: MetLocationForecastMeasurement;
  periodHours: 1 | 6;
}

export interface MetLocationForecastObservation {
  validAt: string;
  airTemperature: MetLocationForecastMeasurement | null;
  windSpeed: MetLocationForecastMeasurement | null;
  windFromDirection: MetLocationForecastMeasurement | null;
  windGust: MetLocationForecastMeasurement | null;
  precipitation: MetLocationForecastPrecipitation | null;
  cloudAreaFraction: MetLocationForecastMeasurement | null;
  airPressureAtSeaLevel: MetLocationForecastMeasurement | null;
  relativeHumidity: MetLocationForecastMeasurement | null;
  symbolCode: string | null;
}

export interface MetLocationForecastAvailable {
  status: 'AVAILABLE';
  provider: MetNorwayProvider.LOCATIONFORECAST;
  issuedAt: string;
  fetchedAt: string;
  forecastUntil: string;
  returnedLocation: {
    latitude: number;
    longitude: number;
    altitudeM: number | null;
  };
  current: MetLocationForecastObservation;
  forecast: MetLocationForecastObservation[];
}

export interface MetLocationForecastNoCoverage {
  status: 'NO_COVERAGE';
  provider: MetNorwayProvider.LOCATIONFORECAST;
  fetchedAt: string;
  reason: 'OUT_OF_COVERAGE' | 'NO_TIMESERIES_IN_WINDOW';
}

export type MetLocationForecastResult =
  | MetLocationForecastAvailable
  | MetLocationForecastNoCoverage;

interface ParsedLocationForecast {
  issuedAt: string;
  returnedLocation: MetLocationForecastAvailable['returnedLocation'];
  observations: MetLocationForecastObservation[];
}

type MetLocationMeasurementKey =
  | 'air_temperature'
  | 'wind_speed'
  | 'wind_from_direction'
  | 'wind_speed_of_gust'
  | 'precipitation_amount'
  | 'cloud_area_fraction'
  | 'air_pressure_at_sea_level'
  | 'relative_humidity';

function validateCoordinates(request: MetLocationForecastRequest): void {
  if (!Number.isFinite(request.latitude) || request.latitude < -90 || request.latitude > 90) {
    throw new RangeError('latitude must be a finite number between -90 and 90');
  }
  if (!Number.isFinite(request.longitude) || request.longitude < -180 || request.longitude > 180) {
    throw new RangeError('longitude must be a finite number between -180 and 180');
  }
  if (
    request.altitudeM !== undefined &&
    (!Number.isInteger(request.altitudeM) || request.altitudeM < -500 || request.altitudeM > 9_000)
  ) {
    throw new RangeError('altitudeM must be an integer between -500 and 9000');
  }
}

function requireRecord(
  parent: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> {
  const value = parent[key];
  if (!isUnknownRecord(value)) {
    throw metSchemaError(MetNorwayProvider.LOCATIONFORECAST, path);
  }
  return value;
}

function requireString(parent: Record<string, unknown>, key: string, path: string): string {
  const value = parent[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw metSchemaError(MetNorwayProvider.LOCATIONFORECAST, path);
  }
  return value;
}

function readMeasurement(
  details: Record<string, unknown>,
  key: MetLocationMeasurementKey,
  units: Record<string, unknown>,
  path: string,
): MetLocationForecastMeasurement | null {
  const rawValue = details[key];
  if (rawValue === undefined || rawValue === null) return null;

  const rawUnit = units[key];
  if (typeof rawUnit !== 'string' || rawUnit.length === 0) {
    throw metSchemaError(MetNorwayProvider.LOCATIONFORECAST, `properties.meta.units.${key}`);
  }
  const value = requireFiniteNumber(MetNorwayProvider.LOCATIONFORECAST, rawValue, `${path}.${key}`);
  assertMeasurementRange(key, value, `${path}.${key}`);
  return {
    value,
    unit: rawUnit,
  };
}

function assertMeasurementRange(key: MetLocationMeasurementKey, value: number, path: string): void {
  let valid: boolean;
  switch (key) {
    case 'air_temperature':
      valid = value >= -273.15;
      break;
    case 'wind_speed':
    case 'wind_speed_of_gust':
    case 'precipitation_amount':
      valid = value >= 0;
      break;
    case 'wind_from_direction':
      valid = value >= 0 && value <= 360;
      break;
    case 'cloud_area_fraction':
    case 'relative_humidity':
      valid = value >= 0 && value <= 100;
      break;
    case 'air_pressure_at_sea_level':
      valid = value > 0;
      break;
  }
  if (!valid) {
    throw metSchemaError(MetNorwayProvider.LOCATIONFORECAST, path);
  }
}

function readPeriod(
  data: Record<string, unknown>,
  units: Record<string, unknown>,
  path: string,
): {
  precipitation: MetLocationForecastPrecipitation | null;
  symbolCode: string | null;
} {
  const periodKey = isUnknownRecord(data.next_1_hours)
    ? 'next_1_hours'
    : isUnknownRecord(data.next_6_hours)
      ? 'next_6_hours'
      : null;
  if (!periodKey) return { precipitation: null, symbolCode: null };

  const period = requireRecord(data, periodKey, `${path}.${periodKey}`);
  const details = requireRecord(period, 'details', `${path}.${periodKey}.details`);
  const amount = readMeasurement(
    details,
    'precipitation_amount',
    units,
    `${path}.${periodKey}.details`,
  );
  const rawSummary = period.summary;
  let symbolCode: string | null = null;
  if (rawSummary !== undefined) {
    if (!isUnknownRecord(rawSummary)) {
      throw metSchemaError(MetNorwayProvider.LOCATIONFORECAST, `${path}.${periodKey}.summary`);
    }
    const rawSymbolCode = rawSummary.symbol_code;
    if (rawSymbolCode !== undefined && rawSymbolCode !== null) {
      if (typeof rawSymbolCode !== 'string' || rawSymbolCode.length === 0) {
        throw metSchemaError(
          MetNorwayProvider.LOCATIONFORECAST,
          `${path}.${periodKey}.summary.symbol_code`,
        );
      }
      symbolCode = rawSymbolCode;
    }
  }

  return {
    precipitation: amount
      ? {
          amount,
          periodHours: periodKey === 'next_1_hours' ? 1 : 6,
        }
      : null,
    symbolCode,
  };
}

function parseReturnedLocation(
  root: Record<string, unknown>,
): ParsedLocationForecast['returnedLocation'] {
  const geometry = requireRecord(root, 'geometry', 'geometry');
  if (geometry.type !== 'Point' || !Array.isArray(geometry.coordinates)) {
    throw metSchemaError(MetNorwayProvider.LOCATIONFORECAST, 'geometry');
  }
  if (geometry.coordinates.length < 2) {
    throw metSchemaError(MetNorwayProvider.LOCATIONFORECAST, 'geometry.coordinates');
  }

  return {
    longitude: requireFiniteNumber(
      MetNorwayProvider.LOCATIONFORECAST,
      geometry.coordinates[0],
      'geometry.coordinates[0]',
    ),
    latitude: requireFiniteNumber(
      MetNorwayProvider.LOCATIONFORECAST,
      geometry.coordinates[1],
      'geometry.coordinates[1]',
    ),
    altitudeM:
      geometry.coordinates[2] === undefined || geometry.coordinates[2] === null
        ? null
        : requireFiniteNumber(
            MetNorwayProvider.LOCATIONFORECAST,
            geometry.coordinates[2],
            'geometry.coordinates[2]',
          ),
  };
}

function parseLocationForecast(payload: unknown): ParsedLocationForecast {
  if (!isUnknownRecord(payload) || payload.type !== 'Feature') {
    throw metSchemaError(MetNorwayProvider.LOCATIONFORECAST, '$');
  }
  const properties = requireRecord(payload, 'properties', 'properties');
  const meta = requireRecord(properties, 'meta', 'properties.meta');
  const units = requireRecord(meta, 'units', 'properties.meta.units');
  const issuedAt = normalizeUtcTimestamp(
    MetNorwayProvider.LOCATIONFORECAST,
    meta.updated_at,
    'properties.meta.updated_at',
  );
  if (!Array.isArray(properties.timeseries)) {
    throw metSchemaError(MetNorwayProvider.LOCATIONFORECAST, 'properties.timeseries');
  }

  const observations = properties.timeseries.map((rawEntry, index) => {
    const path = `properties.timeseries[${index}]`;
    if (!isUnknownRecord(rawEntry)) {
      throw metSchemaError(MetNorwayProvider.LOCATIONFORECAST, path);
    }
    const validAt = normalizeUtcTimestamp(
      MetNorwayProvider.LOCATIONFORECAST,
      rawEntry.time,
      `${path}.time`,
    );
    const data = requireRecord(rawEntry, 'data', `${path}.data`);
    const instant = requireRecord(data, 'instant', `${path}.data.instant`);
    const details = requireRecord(instant, 'details', `${path}.data.instant.details`);
    const period = readPeriod(data, units, `${path}.data`);

    return {
      validAt,
      airTemperature: readMeasurement(
        details,
        'air_temperature',
        units,
        `${path}.data.instant.details`,
      ),
      windSpeed: readMeasurement(details, 'wind_speed', units, `${path}.data.instant.details`),
      windFromDirection: readMeasurement(
        details,
        'wind_from_direction',
        units,
        `${path}.data.instant.details`,
      ),
      windGust: readMeasurement(
        details,
        'wind_speed_of_gust',
        units,
        `${path}.data.instant.details`,
      ),
      precipitation: period.precipitation,
      cloudAreaFraction: readMeasurement(
        details,
        'cloud_area_fraction',
        units,
        `${path}.data.instant.details`,
      ),
      airPressureAtSeaLevel: readMeasurement(
        details,
        'air_pressure_at_sea_level',
        units,
        `${path}.data.instant.details`,
      ),
      relativeHumidity: readMeasurement(
        details,
        'relative_humidity',
        units,
        `${path}.data.instant.details`,
      ),
      symbolCode: period.symbolCode,
    } satisfies MetLocationForecastObservation;
  });

  return {
    issuedAt,
    returnedLocation: parseReturnedLocation(payload),
    observations,
  };
}

@Injectable()
export class MetLocationForecastService {
  private readonly http: MetNorwayHttpClient;
  private readonly clock: MetNorwayClock;
  private readonly userAgent: string;

  constructor(
    @Inject(MET_NORWAY_PROVIDER_CONFIG)
    config: MetNorwayProviderConfig,
    @Optional() @Inject(MET_NORWAY_FETCH) fetchFn?: MetNorwayFetch,
    @Optional() @Inject(MET_NORWAY_CLOCK) clock?: MetNorwayClock,
  ) {
    this.clock = clock ?? { now: (): Date => new Date() };
    this.http = new MetNorwayHttpClient(fetchFn, this.clock);
    this.userAgent = buildMetNorwayUserAgent(config, MetNorwayProvider.LOCATIONFORECAST);
  }

  async fetchForecast(request: MetLocationForecastRequest): Promise<MetLocationForecastResult> {
    validateCoordinates(request);
    const windowAnchor = this.clock.now();
    const url = new URL(LOCATIONFORECAST_PATH, LOCATIONFORECAST_ORIGIN);
    url.searchParams.set('lat', request.latitude.toFixed(4));
    url.searchParams.set('lon', request.longitude.toFixed(4));
    if (request.altitudeM !== undefined) {
      url.searchParams.set('altitude', request.altitudeM.toString());
    }

    const response = await this.http.getJson({
      provider: MetNorwayProvider.LOCATIONFORECAST,
      url,
      allowedOrigin: LOCATIONFORECAST_ORIGIN,
      allowedPath: LOCATIONFORECAST_PATH,
      headers: {
        Accept: 'application/json',
        'User-Agent': this.userAgent,
      },
    });
    if (response.status === 'NO_COVERAGE') {
      return {
        status: 'NO_COVERAGE',
        provider: MetNorwayProvider.LOCATIONFORECAST,
        fetchedAt: this.clock.now().toISOString(),
        reason: 'OUT_OF_COVERAGE',
      };
    }

    const parsed = parseLocationForecast(response.payload);
    const lowerBound = windowAnchor.getTime() - CURRENT_LOOKBACK_MS;
    const upperBound = windowAnchor.getTime() + FORECAST_WINDOW_MS;
    const forecast = parsed.observations
      .filter((observation) => {
        const validAt = new Date(observation.validAt).getTime();
        return validAt >= lowerBound && validAt <= upperBound;
      })
      .sort((left, right) => new Date(left.validAt).getTime() - new Date(right.validAt).getTime());

    if (forecast.length === 0) {
      return {
        status: 'NO_COVERAGE',
        provider: MetNorwayProvider.LOCATIONFORECAST,
        fetchedAt: this.clock.now().toISOString(),
        reason: 'NO_TIMESERIES_IN_WINDOW',
      };
    }

    const observationsAtOrBeforeNow = forecast.filter(
      (observation) => new Date(observation.validAt).getTime() <= windowAnchor.getTime(),
    );
    const current =
      observationsAtOrBeforeNow[observationsAtOrBeforeNow.length - 1] ??
      forecast.find(
        (observation) => new Date(observation.validAt).getTime() > windowAnchor.getTime(),
      );
    if (!current) {
      throw metSchemaError(MetNorwayProvider.LOCATIONFORECAST, 'properties.timeseries');
    }

    return {
      status: 'AVAILABLE',
      provider: MetNorwayProvider.LOCATIONFORECAST,
      issuedAt: parsed.issuedAt,
      fetchedAt: this.clock.now().toISOString(),
      forecastUntil: forecast[forecast.length - 1]?.validAt ?? current.validAt,
      returnedLocation: parsed.returnedLocation,
      current,
      forecast,
    };
  }
}
