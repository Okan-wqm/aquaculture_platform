import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionContext } from '../auth/session-context.js';
import type { McpConfig } from '../config.js';
import { GraphQLClient } from '../graphql/client.js';
import {
  fetchCurrentWeather,
  fetchWeatherObservations,
  type EnvironmentMetric,
  type EnvironmentQualityStatus,
} from '../graphql/queries/weather.js';

const config: McpConfig = {
  gatewayUrl: 'https://gateway.example.test/graphql',
  jwtToken: 'token',
  transport: 'stdio',
  port: 3009,
  logLevel: 'error',
  requestTimeout: 1_000,
};

const session: SessionContext = {
  token: 'token',
  tenantId: 'tenant-1',
  userId: 'user-1',
  roles: ['MODULE_USER'],
};

function environmentValue(
  metric: EnvironmentMetric,
  qualityStatus: EnvironmentQualityStatus,
  value: number,
  validAt: string,
) {
  return {
    metric,
    value,
    unit: metric === 'AIR_TEMPERATURE' ? 'degC' : 'm/s',
    source: 'MET_FROST' as const,
    semanticClass: 'OBSERVATION' as const,
    validAt,
    issuedAt: null,
    fetchedAt: '2026-07-31T12:05:00.000Z',
    qualityStatus,
    depthM: null,
    requestedDepthM: null,
    datasetId: 'frost-observations-v0.jsonld',
    productId: 'SN18700',
    variableId: metric,
    resolutionM: null,
    gridCellDistanceM: null,
    locationRevision: 7,
    stationId: 'SN18700',
    stationDistanceKm: 4.2,
  };
}

describe('canonical environment weather adapter', () => {
  let client: GraphQLClient;

  beforeEach(() => {
    client = new GraphQLClient(config, session);
  });

  it('preserves metric-level provenance while keeping stale values out of convenience fields', async () => {
    const staleTemperature = environmentValue(
      'AIR_TEMPERATURE',
      'STALE',
      -8,
      '2026-07-31T10:00:00.000Z',
    );
    const currentWind = environmentValue('WIND_SPEED', 'VALID', 12, '2026-07-31T11:00:00.000Z');
    const query = vi.spyOn(client, 'query').mockResolvedValue({
      siteEnvironmentCurrent: {
        siteId: 'site-1',
        values: [staleTemperature, currentWind],
      },
    });

    const weather = await fetchCurrentWeather(client, 'site-1');

    expect(query).toHaveBeenCalledOnce();
    const operation = query.mock.calls[0]?.[0] ?? '';
    expect(operation).toContain('source');
    expect(operation).toContain('semanticClass');
    expect(operation).toContain('qualityStatus');
    expect(operation).toContain('stationDistanceKm');
    expect(weather).not.toBeNull();
    expect(weather?.metrics).toEqual([
      { ...staleTemperature, freshness: 'STALE' },
      { ...currentWind, freshness: 'CURRENT' },
    ]);
    expect(weather?.metrics[0]?.validAt).toBe('2026-07-31T10:00:00.000Z');
    expect(weather?.metrics[1]?.validAt).toBe('2026-07-31T11:00:00.000Z');
    expect(weather?.temperature).toBeUndefined();
    expect(weather?.windSpeed).toBe(12);
  });

  it('retains provenance for every historical metric at its own valid time', async () => {
    const temperature = environmentValue(
      'AIR_TEMPERATURE',
      'PROVISIONAL',
      7,
      '2026-07-30T09:00:00.000Z',
    );
    const unavailableWind = environmentValue(
      'WIND_SPEED',
      'PROVIDER_UNAVAILABLE',
      18,
      '2026-07-30T09:00:00.000Z',
    );
    vi.spyOn(client, 'query').mockResolvedValue({
      siteEnvironmentHistory: {
        siteId: 'site-1',
        values: [temperature, unavailableWind],
      },
    });

    const observations = await fetchWeatherObservations(
      client,
      'site-1',
      '2026-07-30T00:00:00.000Z',
      '2026-07-31T00:00:00.000Z',
    );

    expect(observations).toHaveLength(1);
    expect(observations[0]?.metrics).toEqual([
      { ...temperature, freshness: 'CURRENT' },
      { ...unavailableWind, freshness: 'UNAVAILABLE' },
    ]);
    expect(observations[0]?.temperature).toBe(7);
    expect(observations[0]?.windSpeed).toBeUndefined();
  });
});
