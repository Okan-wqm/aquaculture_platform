import { describe, expect, it } from 'vitest';

import type { CurrentWeather, EnvironmentValue } from '../graphql/queries/weather.js';
import { buildWeatherRiskContext } from '../tools/intelligence/assess-risk.js';

function metric(
  overrides: Pick<EnvironmentValue, 'metric' | 'value' | 'qualityStatus' | 'freshness' | 'validAt'>,
): EnvironmentValue {
  return {
    ...overrides,
    unit: overrides.metric === 'AIR_TEMPERATURE' ? 'degC' : 'm/s',
    source: 'MET_LOCATIONFORECAST',
    semanticClass: 'FORECAST',
    issuedAt: '2026-07-31T08:00:00.000Z',
    fetchedAt: '2026-07-31T08:05:00.000Z',
    depthM: null,
    requestedDepthM: null,
    datasetId: 'met-locationforecast-compact',
    productId: 'locationforecast-2.0',
    variableId: overrides.metric,
    resolutionM: 1_000,
    gridCellDistanceM: 320,
    locationRevision: 2,
    stationId: null,
    stationDistanceKm: null,
  };
}

function weather(metrics: EnvironmentValue[]): CurrentWeather {
  return {
    siteId: 'site-1',
    observedAt: '2026-07-31T09:00:00.000Z',
    fetchedAt: '2026-07-31T08:05:00.000Z',
    metrics,
  };
}

describe('assess-risk weather input', () => {
  it('does not create a cold alert when temperature is absent', () => {
    const context = buildWeatherRiskContext(
      weather([
        metric({
          metric: 'WIND_SPEED',
          value: 8,
          qualityStatus: 'VALID',
          freshness: 'CURRENT',
          validAt: '2026-07-31T09:00:00.000Z',
        }),
      ]),
    );

    expect(context?.weather).toEqual({
      windSpeedKph: 28.8,
      stormWarning: false,
    });
    expect(context?.weather.extremeCold).toBeUndefined();
  });

  it('excludes stale and unavailable metrics from risk evaluation', () => {
    const context = buildWeatherRiskContext(
      weather([
        metric({
          metric: 'AIR_TEMPERATURE',
          value: -12,
          qualityStatus: 'STALE',
          freshness: 'STALE',
          validAt: '2026-07-30T09:00:00.000Z',
        }),
        metric({
          metric: 'WIND_SPEED',
          value: 30,
          qualityStatus: 'PROVIDER_UNAVAILABLE',
          freshness: 'UNAVAILABLE',
          validAt: '2026-07-31T09:00:00.000Z',
        }),
      ]),
    );

    expect(context).toBeNull();
  });

  it('uses each current metric with its own provenance timestamp', () => {
    const currentTemperature = metric({
      metric: 'AIR_TEMPERATURE',
      value: 3,
      qualityStatus: 'PROVISIONAL',
      freshness: 'CURRENT',
      validAt: '2026-07-31T08:00:00.000Z',
    });
    const currentWind = metric({
      metric: 'WIND_SPEED',
      value: 22,
      qualityStatus: 'VALID',
      freshness: 'CURRENT',
      validAt: '2026-07-31T09:00:00.000Z',
    });

    const context = buildWeatherRiskContext(weather([currentTemperature, currentWind]));

    expect(context?.weather).toEqual({
      windSpeedKph: 79.2,
      stormWarning: true,
      temperatureC: 3,
      extremeHeat: false,
      extremeCold: true,
    });
    expect(context?.values).toEqual([currentWind, currentTemperature]);
    expect(context?.lastDataTimestamp).toBe('2026-07-31T09:00:00.000Z');
  });
});
