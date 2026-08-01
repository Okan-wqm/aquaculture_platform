import { DataSource, EntityManager, FindOperator, QueryRunner } from 'typeorm';
import { createMockDataSource } from '@aquaculture/testing';

const runInTenantReadMock = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantRead: (
    dataSource: DataSource,
    schema: string,
    tenantId: string,
    callback: (queryRunner: QueryRunner) => Promise<unknown>,
  ) => runInTenantReadMock(dataSource, schema, tenantId, callback),
}));

import { SiteAuthorizationService, SiteScopeCaller } from '@aquaculture/backend-common/security';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { Site, SiteType } from '../../site/entities/site.entity';
import {
  EnvironmentAvailabilityStatus,
  EnvironmentMetric,
  EnvironmentProvider,
  EnvironmentQualityStatus,
  EnvironmentSemanticClass,
  EnvironmentSyncScopeKind,
  EnvironmentSyncScopeOutcome,
  EnvironmentSyncStatus,
  SATELLITE_COVERAGE_LEGACY_METHOD,
  SatelliteCoverageStatus,
} from '../entities/environment-observation.types';
import { EnvironmentMetricSyncOutcome } from '../entities/environment-metric-sync-outcome.entity';
import { MarineObservation } from '../entities/marine-observation.entity';
import { SatelliteSceneCoverageAssessment } from '../entities/satellite-scene-coverage-assessment.entity';
import { SatelliteSceneObservation } from '../entities/satellite-scene-observation.entity';
import { SiteEnvironmentSyncState } from '../entities/site-environment-sync-state.entity';
import { WeatherDataType, WeatherObservation } from '../entities/weather-observation.entity';
import { CDSE_COVERAGE_METHOD } from '../services/cdse-sentinel.provider';
import { EnvironmentMonitoringGate } from '../services/environment-monitoring-gate.service';
import { EnvironmentReadService } from '../services/environment-read.service';
import { selectSatelliteCoverageAssessment } from '../services/satellite-coverage-assessment-selection';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OBSERVATION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CALLER: SiteScopeCaller = {
  sub: 'user-1',
  roles: [],
  assignedSiteIds: [SITE_ID],
};

function site(): Site {
  return {
    id: SITE_ID,
    tenantId: TENANT_ID,
    type: SiteType.SEA_CAGE,
    location: { latitude: 0, longitude: 0 },
    monitoringLocationRevision: 3,
    isActive: true,
    isDeleted: false,
  } as Site;
}

function metricOutcome(
  provider: EnvironmentProvider,
  metric: EnvironmentMetric,
  outcome: EnvironmentSyncScopeOutcome,
  options: {
    scopeKey?: string;
    validFrom?: Date | null;
    validTo?: Date | null;
    errorCode?: string | null;
    observationCount?: number;
  } = {},
): EnvironmentMetricSyncOutcome {
  return Object.assign(new EnvironmentMetricSyncOutcome(), {
    id: `${provider}:${metric}:${options.scopeKey ?? outcome}`,
    tenantId: TENANT_ID,
    siteId: SITE_ID,
    provider,
    metric,
    scopeKind: EnvironmentSyncScopeKind.METRIC_HORIZON,
    scopeKey: options.scopeKey ?? `${provider}:${metric}`,
    validFrom: options.validFrom ?? null,
    validTo: options.validTo ?? null,
    outcome,
    errorCode: options.errorCode ?? null,
    observationCount: options.observationCount ?? 0,
    monitoringLocationRevision: 3,
    completedAt: new Date(),
  });
}

function coverageAssessment(
  status: SatelliteCoverageStatus = SatelliteCoverageStatus.PARTIAL,
): SatelliteSceneCoverageAssessment {
  return Object.assign(new SatelliteSceneCoverageAssessment(), {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    tenantId: TENANT_ID,
    siteId: SITE_ID,
    sceneId: 'S2B_TEST_SCENE',
    monitoringLocationRevision: 3,
    coverageStatus: status,
    coverageMethod: CDSE_COVERAGE_METHOD,
    coveragePercent:
      status === SatelliteCoverageStatus.OUT_OF_COVERAGE
        ? 0
        : status === SatelliteCoverageStatus.FULL
          ? 100
          : 50,
    coverageSampleCount: status === SatelliteCoverageStatus.PARTIAL ? 256 : 0,
    qualityStatus:
      status === SatelliteCoverageStatus.OUT_OF_COVERAGE
        ? EnvironmentQualityStatus.OUT_OF_COVERAGE
        : EnvironmentQualityStatus.PROVISIONAL,
    createdAt: new Date('2026-07-31T04:00:00.000Z'),
  });
}

describe('EnvironmentReadService', () => {
  let manager: jest.Mocked<EntityManager>;
  let queryRunner: jest.Mocked<QueryRunner>;
  let dataSource: jest.Mocked<DataSource>;
  let siteAuthorization: SiteAuthorizationService;
  let service: EnvironmentReadService;

  afterEach(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    const mocks = createMockDataSource();
    manager = mocks.mockManager;
    queryRunner = mocks.mockQueryRunner;
    dataSource = mocks.mockDataSource;
    manager.findOne.mockResolvedValue(site());
    manager.find.mockResolvedValue([]);
    queryRunner.query.mockResolvedValue([{ id: OBSERVATION_ID }]);
    runInTenantReadMock.mockReset();
    runInTenantReadMock.mockImplementation(
      async (
        _dataSource: DataSource,
        _schema: string,
        _tenantId: string,
        callback: (queryRunner: QueryRunner) => Promise<unknown>,
      ) => callback(queryRunner),
    );
    siteAuthorization = new SiteAuthorizationService();
    const gate: EnvironmentMonitoringGate = Object.create(EnvironmentMonitoringGate.prototype);
    gate.assertEnabled = jest.fn();
    service = new EnvironmentReadService(dataSource, siteAuthorization, gate);
  });

  it('authorizes the site before entering the tenant database boundary', async () => {
    await expect(
      service.current(TENANT_ID, { sub: 'other-user', roles: [], assignedSiteIds: [] }, SITE_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(runInTenantReadMock).not.toHaveBeenCalled();
  });

  it('returns the complete persisted satellite coverage provenance bundle', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-31T12:00:00.000Z'));
    const scene = Object.assign(new SatelliteSceneObservation(), {
      id: OBSERVATION_ID,
      tenantId: TENANT_ID,
      siteId: SITE_ID,
      sceneId: 'S2B_TEST_SCENE',
      collection: 'sentinel-2-l2a',
      provider: EnvironmentProvider.CDSE_SENTINEL_2,
      productId: 'S2B_TEST_SCENE',
      datasetId: 'sentinel-2-l2a',
      acquiredAt: new Date('2026-07-30T10:25:59.000Z'),
      cloudCoverPercent: 30,
      coveragePercent: 50,
      coverageAssessments: [coverageAssessment()],
      qualityStatus: EnvironmentQualityStatus.VALID,
      monitoringLocationRevision: 3,
      fetchedAt: new Date('2026-07-31T04:00:00.000Z'),
    });
    const queryBuilder = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([scene]),
    };
    manager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(queryBuilder) as typeof manager.createQueryBuilder;

    const result = await service.scenes(TENANT_ID, CALLER, {
      siteId: SITE_ID,
      from: new Date('2026-07-01T12:00:00.000Z'),
      to: new Date('2026-07-31T12:00:00.000Z'),
      first: 10,
    });

    expect(result.nodes).toEqual([
      expect.objectContaining({
        sceneId: 'S2B_TEST_SCENE',
        coveragePercent: 50,
        coverageStatus: SatelliteCoverageStatus.PARTIAL,
        coverageMethod: CDSE_COVERAGE_METHOD,
        coverageSampleCount: 256,
        qualityStatus: EnvironmentQualityStatus.PROVISIONAL,
      }),
    ]);
  });

  it('preserves valid zero-valued weather and marine facts with independent timestamps', async () => {
    const weatherAt = new Date(Date.now() - 60_000);
    const marineAt = new Date(Date.now() - 120_000);
    const weather = {
      tenantId: TENANT_ID,
      siteId: SITE_ID,
      observedAt: weatherAt,
      dataType: WeatherDataType.HISTORICAL,
      temperature: 0,
      windSpeed: 0,
      provider: EnvironmentProvider.MET_FROST,
      productId: 'frost',
      datasetId: 'SN00001',
      sourceRunKey: 'weather-run',
      semanticClass: EnvironmentSemanticClass.OBSERVATION,
      qualityStatus: EnvironmentQualityStatus.PROVISIONAL,
      fetchedAt: new Date(),
      monitoringLocationRevision: 3,
    } as WeatherObservation;
    const marine = {
      tenantId: TENANT_ID,
      siteId: SITE_ID,
      observedAt: marineAt,
      dataType: WeatherDataType.HISTORICAL,
      waveHeight: 0,
      provider: EnvironmentProvider.CMEMS,
      productId: 'regional-wave',
      datasetId: 'wave-dataset',
      variableSetId: 'WAVE_HEIGHT=VHM0',
      sourceRunKey: 'marine-run',
      semanticClass: EnvironmentSemanticClass.ANALYSIS,
      qualityStatus: EnvironmentQualityStatus.PROVISIONAL,
      fetchedAt: new Date(),
      monitoringLocationRevision: 3,
    } as MarineObservation;
    manager.find.mockImplementation((entity) => {
      if (entity === WeatherObservation) {
        return Promise.resolve([weather]);
      }
      if (entity === MarineObservation) {
        return Promise.resolve([marine]);
      }
      return Promise.resolve([]);
    });

    const result = await service.current(TENANT_ID, CALLER, SITE_ID);

    expect(result.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: EnvironmentMetric.AIR_TEMPERATURE,
          value: 0,
          validAt: weatherAt,
        }),
        expect.objectContaining({
          metric: EnvironmentMetric.WIND_SPEED,
          value: 0,
          validAt: weatherAt,
        }),
        expect.objectContaining({
          metric: EnvironmentMetric.WAVE_HEIGHT,
          value: 0,
          validAt: marineAt,
        }),
      ]),
    );
  });

  it('excludes newer provider-null legacy rows from the canonical environment surface', async () => {
    const canonicalAt = new Date(Date.now() - 120_000);
    const legacyAt = new Date(Date.now() - 60_000);
    const canonicalWeather = {
      tenantId: TENANT_ID,
      siteId: SITE_ID,
      observedAt: canonicalAt,
      dataType: WeatherDataType.HISTORICAL,
      temperature: 4,
      provider: EnvironmentProvider.MET_FROST,
      productId: 'frost-observations-v0',
      datasetId: 'SN00001:timeseries-0',
      sourceRunKey: 'canonical-weather-run',
      semanticClass: EnvironmentSemanticClass.OBSERVATION,
      qualityStatus: EnvironmentQualityStatus.VALID,
      fetchedAt: canonicalAt,
      monitoringLocationRevision: 3,
    } as WeatherObservation;
    const legacyWeather = {
      tenantId: TENANT_ID,
      siteId: SITE_ID,
      observedAt: legacyAt,
      dataType: WeatherDataType.HISTORICAL,
      temperature: 99,
      provider: null,
      fetchedAt: legacyAt,
      monitoringLocationRevision: 3,
    } as WeatherObservation;
    const canonicalMarine = {
      tenantId: TENANT_ID,
      siteId: SITE_ID,
      observedAt: canonicalAt,
      dataType: WeatherDataType.HISTORICAL,
      waveHeight: 1.2,
      provider: EnvironmentProvider.CMEMS,
      productId: 'NWSHELF_ANALYSISFORECAST_WAV_004_014',
      datasetId: 'nws-wave',
      variableSetId: 'WAVE_HEIGHT=VHM0',
      sourceRunKey: 'canonical-marine-run',
      semanticClass: EnvironmentSemanticClass.ANALYSIS,
      qualityStatus: EnvironmentQualityStatus.PROVISIONAL,
      fetchedAt: canonicalAt,
      monitoringLocationRevision: 3,
    } as MarineObservation;
    const legacyMarine = {
      tenantId: TENANT_ID,
      siteId: SITE_ID,
      observedAt: legacyAt,
      dataType: WeatherDataType.HISTORICAL,
      waveHeight: 9.9,
      provider: null,
      fetchedAt: legacyAt,
      monitoringLocationRevision: 3,
    } as MarineObservation;
    manager.find.mockImplementation((entity) => {
      if (entity === WeatherObservation) {
        return Promise.resolve([legacyWeather, canonicalWeather]);
      }
      if (entity === MarineObservation) {
        return Promise.resolve([legacyMarine, canonicalMarine]);
      }
      return Promise.resolve([]);
    });

    const result = await service.current(TENANT_ID, CALLER, SITE_ID);

    expect(
      result.values.find((value) => value.metric === EnvironmentMetric.AIR_TEMPERATURE),
    ).toMatchObject({
      value: 4,
      source: EnvironmentProvider.MET_FROST,
      productId: 'frost-observations-v0',
    });
    expect(
      result.values.find((value) => value.metric === EnvironmentMetric.WAVE_HEIGHT),
    ).toMatchObject({
      value: 1.2,
      source: EnvironmentProvider.CMEMS,
      productId: 'NWSHELF_ANALYSISFORECAST_WAV_004_014',
    });
    expect(result.values.some((value) => value.value === 99 || value.value === 9.9)).toBe(false);
  });

  it('deterministically prefers a Frost observation over a Locationforecast value at the same instant', async () => {
    const validAt = new Date(Date.now() - 60_000);
    const locationForecast = {
      tenantId: TENANT_ID,
      siteId: SITE_ID,
      observedAt: validAt,
      dataType: WeatherDataType.HISTORICAL,
      temperature: 20,
      provider: EnvironmentProvider.MET_LOCATIONFORECAST,
      productId: 'locationforecast-2.0',
      datasetId: 'compact',
      sourceRunKey: 'locationforecast-newer-fetch',
      issuedAt: new Date(Date.now() - 10_000),
      semanticClass: EnvironmentSemanticClass.FORECAST,
      qualityStatus: EnvironmentQualityStatus.PROVISIONAL,
      fetchedAt: new Date(),
      monitoringLocationRevision: 3,
    } as WeatherObservation;
    const frostObservation = {
      tenantId: TENANT_ID,
      siteId: SITE_ID,
      observedAt: validAt,
      dataType: WeatherDataType.HISTORICAL,
      temperature: 5,
      provider: EnvironmentProvider.MET_FROST,
      productId: 'frost-observations-v0',
      datasetId: 'SN00001:timeseries-0',
      sourceRunKey: 'frost-observation',
      issuedAt: null,
      semanticClass: EnvironmentSemanticClass.OBSERVATION,
      qualityStatus: EnvironmentQualityStatus.VALID,
      fetchedAt: new Date(Date.now() - 30_000),
      monitoringLocationRevision: 3,
    } as WeatherObservation;
    manager.find.mockImplementation((entity) =>
      Promise.resolve(entity === WeatherObservation ? [locationForecast, frostObservation] : []),
    );

    const current = await service.current(TENANT_ID, CALLER, SITE_ID);
    const history = await service.history(TENANT_ID, CALLER, {
      siteId: SITE_ID,
      metrics: [EnvironmentMetric.AIR_TEMPERATURE],
      from: new Date(validAt.getTime() - 1_000),
      to: new Date(),
    });

    expect(
      current.values.find((value) => value.metric === EnvironmentMetric.AIR_TEMPERATURE),
    ).toMatchObject({
      value: 5,
      source: EnvironmentProvider.MET_FROST,
      semanticClass: EnvironmentSemanticClass.OBSERVATION,
    });
    expect(history.values).toEqual([
      expect.objectContaining({
        value: 5,
        source: EnvironmentProvider.MET_FROST,
      }),
    ]);
  });

  it('uses issuedAt then fetchedAt as deterministic canonical tie-breakers', async () => {
    const validAt = new Date(Date.now() - 60_000);
    const base = {
      tenantId: TENANT_ID,
      siteId: SITE_ID,
      observedAt: validAt,
      dataType: WeatherDataType.HISTORICAL,
      provider: EnvironmentProvider.MET_LOCATIONFORECAST,
      productId: 'locationforecast-2.0',
      datasetId: 'compact',
      semanticClass: EnvironmentSemanticClass.FORECAST,
      qualityStatus: EnvironmentQualityStatus.PROVISIONAL,
      monitoringLocationRevision: 3,
    };
    const olderIssue = {
      ...base,
      temperature: 1,
      sourceRunKey: 'older-issue',
      issuedAt: new Date(Date.now() - 120_000),
      fetchedAt: new Date(),
    } as WeatherObservation;
    const newerIssueOlderFetch = {
      ...base,
      temperature: 2,
      sourceRunKey: 'newer-issue-older-fetch',
      issuedAt: new Date(Date.now() - 30_000),
      fetchedAt: new Date(Date.now() - 20_000),
    } as WeatherObservation;
    const newerIssueNewerFetch = {
      ...base,
      temperature: 3,
      sourceRunKey: 'newer-issue-newer-fetch',
      issuedAt: new Date(Date.now() - 30_000),
      fetchedAt: new Date(Date.now() - 10_000),
    } as WeatherObservation;
    manager.find.mockImplementation((entity) =>
      Promise.resolve(
        entity === WeatherObservation
          ? [olderIssue, newerIssueOlderFetch, newerIssueNewerFetch]
          : [],
      ),
    );

    const result = await service.current(TENANT_ID, CALLER, SITE_ID);

    expect(
      result.values.find((value) => value.metric === EnvironmentMetric.AIR_TEMPERATURE),
    ).toMatchObject({ value: 3, issuedAt: newerIssueNewerFetch.issuedAt });
  });

  it('marks a current forecast stale when its source issue and fetch are old', async () => {
    const now = new Date('2026-07-31T12:00:00.000Z');
    jest.useFakeTimers();
    jest.setSystemTime(now);
    const row = {
      tenantId: TENANT_ID,
      siteId: SITE_ID,
      observedAt: new Date(now.getTime() - 60_000),
      dataType: WeatherDataType.FORECAST,
      temperature: 7,
      provider: EnvironmentProvider.MET_LOCATIONFORECAST,
      productId: 'locationforecast-2.0',
      datasetId: 'compact',
      sourceRunKey: 'old-forecast-run',
      issuedAt: new Date(now.getTime() - 12 * 60 * 60 * 1_000),
      semanticClass: EnvironmentSemanticClass.FORECAST,
      qualityStatus: EnvironmentQualityStatus.PROVISIONAL,
      fetchedAt: new Date(now.getTime() - 12 * 60 * 60 * 1_000),
      monitoringLocationRevision: 3,
    } as WeatherObservation;
    manager.find.mockImplementation((entity) =>
      Promise.resolve(entity === WeatherObservation ? [row] : []),
    );

    const result = await service.current(TENANT_ID, CALLER, SITE_ID);

    expect(
      result.values.find((value) => value.metric === EnvironmentMetric.AIR_TEMPERATURE),
    ).toMatchObject({
      validAt: row.observedAt,
      issuedAt: row.issuedAt,
      fetchedAt: row.fetchedAt,
      qualityStatus: EnvironmentQualityStatus.STALE,
    });
  });

  it('reports provider-accurate Frost and regional current variable identities', async () => {
    const validAt = new Date(Date.now() - 60_000);
    const frostRow = {
      tenantId: TENANT_ID,
      siteId: SITE_ID,
      observedAt: validAt,
      dataType: WeatherDataType.HISTORICAL,
      provider: EnvironmentProvider.MET_FROST,
      productId: 'frost-observations-v0',
      datasetId: 'SN00001:timeseries-0',
      sourceRunKey: 'frost-run',
      semanticClass: EnvironmentSemanticClass.OBSERVATION,
      qualityStatus: EnvironmentQualityStatus.VALID,
      precipitation: 1,
      fetchedAt: validAt,
      monitoringLocationRevision: 3,
    } as WeatherObservation;
    const nwsCurrent = {
      tenantId: TENANT_ID,
      siteId: SITE_ID,
      observedAt: validAt,
      dataType: WeatherDataType.HISTORICAL,
      provider: EnvironmentProvider.CMEMS,
      productId: 'NWSHELF_ANALYSISFORECAST_PHY_004_013',
      datasetId: 'nws-current',
      variableSetId: 'CURRENT_DIRECTION=uo+vo,CURRENT_SPEED=uo+vo',
      sourceRunKey: 'nws-run',
      semanticClass: EnvironmentSemanticClass.ANALYSIS,
      qualityStatus: EnvironmentQualityStatus.PROVISIONAL,
      oceanCurrentDirection: 30,
      fetchedAt: validAt,
      monitoringLocationRevision: 3,
    } as MarineObservation;
    manager.find.mockImplementation((entity) => {
      if (entity === WeatherObservation) return Promise.resolve([frostRow]);
      if (entity === MarineObservation) return Promise.resolve([nwsCurrent]);
      return Promise.resolve([]);
    });

    const nwsResult = await service.current(TENANT_ID, CALLER, SITE_ID);
    expect(
      nwsResult.values.find((value) => value.metric === EnvironmentMetric.PRECIPITATION),
    ).toMatchObject({ variableId: 'sum(precipitation_amount PT1H)' });
    expect(
      nwsResult.values.find((value) => value.metric === EnvironmentMetric.CURRENT_DIRECTION),
    ).toMatchObject({ variableId: 'uo,vo' });

    const arcticCurrent = {
      ...nwsCurrent,
      productId: 'ARCTIC_ANALYSISFORECAST_PHY_002_001',
      datasetId: 'arctic-current',
      variableSetId: 'CURRENT_DIRECTION=vxo+vyo',
      sourceRunKey: 'arctic-run',
    } as MarineObservation;
    manager.find.mockImplementation((entity) => {
      if (entity === WeatherObservation) return Promise.resolve([]);
      if (entity === MarineObservation) return Promise.resolve([arcticCurrent]);
      return Promise.resolve([]);
    });
    const arcticResult = await service.current(TENANT_ID, CALLER, SITE_ID);
    expect(
      arcticResult.values.find((value) => value.metric === EnvironmentMetric.CURRENT_DIRECTION),
    ).toMatchObject({ variableId: 'vxo,vyo' });
  });

  it('rejects direct environment reads for non-sea-cage sites', async () => {
    manager.findOne.mockResolvedValue({
      ...site(),
      type: SiteType.LAND_BASED,
    });

    await expect(service.current(TENANT_ID, CALLER, SITE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects history windows over 30 days instead of truncating them', async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 31 * 24 * 60 * 60 * 1_000);

    await expect(
      service.history(TENANT_ID, CALLER, {
        siteId: SITE_ID,
        metrics: [EnvironmentMetric.WAVE_HEIGHT],
        from,
        to,
      }),
    ).rejects.toThrow('cannot exceed 30 days');
    expect(runInTenantReadMock).not.toHaveBeenCalled();
  });

  it('accepts bounded client clock skew but clamps the database range to server time', async () => {
    const serverNow = new Date('2026-07-31T12:00:00.000Z');
    jest.useFakeTimers();
    jest.setSystemTime(serverNow);
    const from = new Date(serverNow.getTime() - 60 * 60 * 1_000);

    await service.history(TENANT_ID, CALLER, {
      siteId: SITE_ID,
      metrics: [EnvironmentMetric.AIR_TEMPERATURE],
      from,
      to: new Date(serverNow.getTime() + 30_000),
    });

    const weatherCall = queryRunner.query.mock.calls.find(([statement]) =>
      String(statement).includes('FROM weather_observations AS observation'),
    );
    expect(weatherCall?.[1]?.[3]).toEqual(from);
    expect(weatherCall?.[1]?.[4]).toEqual(serverNow);
  });

  it('rejects material future ranges instead of opening a future history window', async () => {
    const serverNow = new Date('2026-07-31T12:00:00.000Z');
    jest.useFakeTimers();
    jest.setSystemTime(serverNow);

    await expect(
      service.history(TENANT_ID, CALLER, {
        siteId: SITE_ID,
        metrics: [EnvironmentMetric.AIR_TEMPERATURE],
        from: new Date(serverNow.getTime() - 60 * 60 * 1_000),
        to: new Date(serverNow.getTime() + 5 * 60 * 1_000 + 1),
      }),
    ).rejects.toThrow('cannot end more than 5 minutes in the future');
    expect(runInTenantReadMock).not.toHaveBeenCalled();
  });

  it('rejects duplicate metrics rather than silently deduplicating the request', async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 24 * 60 * 60 * 1_000);

    await expect(
      service.history(TENANT_ID, CALLER, {
        siteId: SITE_ID,
        metrics: [EnvironmentMetric.SALINITY, EnvironmentMetric.SALINITY],
        from,
        to,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('publishes the full metric catalog even before any provider has produced data', async () => {
    manager.find.mockImplementation((entity) => {
      if (
        entity === WeatherObservation ||
        entity === MarineObservation ||
        entity === SatelliteSceneObservation ||
        entity === SiteEnvironmentSyncState
      ) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    const layers = await service.layerCatalog(TENANT_ID, CALLER, SITE_ID);

    expect(layers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'met:air-temperature',
          metric: EnvironmentMetric.AIR_TEMPERATURE,
          unit: '°C',
          availability: EnvironmentAvailabilityStatus.PREPARING,
        }),
        expect.objectContaining({
          id: 'cmems:dissolved-oxygen',
          metric: EnvironmentMetric.DISSOLVED_OXYGEN,
          availability: EnvironmentAvailabilityStatus.PREPARING,
        }),
        expect.objectContaining({
          id: 'sentinel:chlorophyll-proxy',
          unit: '1',
          availability: EnvironmentAvailabilityStatus.PREPARING,
        }),
      ]),
    );
  });

  it('reports a missing metric as NO_DATA after its provider completed successfully', async () => {
    manager.find.mockImplementation((entity) => {
      if (entity === SiteEnvironmentSyncState) {
        return Promise.resolve([
          {
            tenantId: TENANT_ID,
            siteId: SITE_ID,
            provider: EnvironmentProvider.CMEMS,
            status: EnvironmentSyncStatus.READY,
            monitoringLocationRevision: 3,
          } as SiteEnvironmentSyncState,
        ]);
      }
      return Promise.resolve([]);
    });

    const layers = await service.layerCatalog(TENANT_ID, CALLER, SITE_ID);
    const oxygen = layers.find((layer) => layer.id === 'cmems:dissolved-oxygen');

    expect(oxygen?.availability).toBe(EnvironmentAvailabilityStatus.NO_DATA);
  });

  it('reports current provider failure while retaining the cached metric range', async () => {
    const now = new Date('2026-07-31T12:00:00.000Z');
    jest.useFakeTimers();
    jest.setSystemTime(now);
    const cached = {
      tenantId: TENANT_ID,
      siteId: SITE_ID,
      observedAt: new Date(now.getTime() + 6 * 60 * 60 * 1_000),
      dataType: WeatherDataType.FORECAST,
      waveHeight: 1.4,
      provider: EnvironmentProvider.CMEMS,
      productId: 'NWSHELF_ANALYSISFORECAST_WAV_004_014',
      datasetId: 'nws-wave',
      variableSetId: 'WAVE_HEIGHT=VHM0',
      sourceRunKey: 'cached-wave-run',
      issuedAt: new Date(now.getTime() - 4 * 60 * 60 * 1_000),
      semanticClass: EnvironmentSemanticClass.FORECAST,
      qualityStatus: EnvironmentQualityStatus.PROVISIONAL,
      fetchedAt: new Date(now.getTime() - 4 * 60 * 60 * 1_000),
      monitoringLocationRevision: 3,
    } as MarineObservation;
    manager.find.mockImplementation((entity) => {
      if (entity === MarineObservation) return Promise.resolve([cached]);
      if (entity === SiteEnvironmentSyncState) {
        return Promise.resolve([
          {
            tenantId: TENANT_ID,
            siteId: SITE_ID,
            provider: EnvironmentProvider.CMEMS,
            status: EnvironmentSyncStatus.PROVIDER_UNAVAILABLE,
            monitoringLocationRevision: 3,
          } as SiteEnvironmentSyncState,
        ]);
      }
      return Promise.resolve([]);
    });

    const layers = await service.layerCatalog(TENANT_ID, CALLER, SITE_ID);
    const wave = layers.find((layer) => layer.id === 'cmems:wave');

    expect(wave).toMatchObject({
      availability: EnvironmentAvailabilityStatus.PROVIDER_UNAVAILABLE,
      availableFrom: cached.observedAt,
      availableTo: cached.observedAt,
    });
  });

  it('keeps a shared MET layer usable when Locationforecast has data and optional Frost fails', async () => {
    const validAt = new Date();
    const locationForecast = {
      tenantId: TENANT_ID,
      siteId: SITE_ID,
      observedAt: validAt,
      dataType: WeatherDataType.FORECAST,
      temperature: 6.5,
      provider: EnvironmentProvider.MET_LOCATIONFORECAST,
      productId: 'locationforecast-2.0',
      datasetId: 'compact',
      sourceRunKey: 'locationforecast-run',
      issuedAt: validAt,
      semanticClass: EnvironmentSemanticClass.FORECAST,
      qualityStatus: EnvironmentQualityStatus.PROVISIONAL,
      fetchedAt: validAt,
      monitoringLocationRevision: 3,
    } as WeatherObservation;
    const locationCoverage = metricOutcome(
      EnvironmentProvider.MET_LOCATIONFORECAST,
      EnvironmentMetric.AIR_TEMPERATURE,
      EnvironmentSyncScopeOutcome.AVAILABLE,
      { validFrom: validAt, validTo: validAt, observationCount: 1 },
    );
    const frostFailure = metricOutcome(
      EnvironmentProvider.MET_FROST,
      EnvironmentMetric.AIR_TEMPERATURE,
      EnvironmentSyncScopeOutcome.CONFIGURATION_ERROR,
      { errorCode: 'FROST_CLIENT_ID_MISSING' },
    );
    manager.find.mockImplementation((entity) => {
      if (entity === WeatherObservation) return Promise.resolve([locationForecast]);
      if (entity === EnvironmentMetricSyncOutcome) {
        return Promise.resolve([locationCoverage, frostFailure]);
      }
      if (entity === SiteEnvironmentSyncState) {
        return Promise.resolve([
          Object.assign(new SiteEnvironmentSyncState(), {
            provider: EnvironmentProvider.MET_LOCATIONFORECAST,
            status: EnvironmentSyncStatus.READY,
          }),
          Object.assign(new SiteEnvironmentSyncState(), {
            provider: EnvironmentProvider.MET_FROST,
            status: EnvironmentSyncStatus.CONFIGURATION_ERROR,
          }),
        ]);
      }
      return Promise.resolve([]);
    });

    const layers = await service.layerCatalog(TENANT_ID, CALLER, SITE_ID);
    const temperature = layers.find((layer) => layer.id === 'met:air-temperature');

    expect(temperature).toMatchObject({
      availability: EnvironmentAvailabilityStatus.READY,
      availableFrom: validAt,
      availableTo: validAt,
      coverage: {
        expected: 2,
        successful: 1,
        failed: 1,
      },
    });
  });

  it('keeps a shared MET layer preparing while its primary source is pending', async () => {
    const frostFailure = metricOutcome(
      EnvironmentProvider.MET_FROST,
      EnvironmentMetric.AIR_TEMPERATURE,
      EnvironmentSyncScopeOutcome.CONFIGURATION_ERROR,
      { errorCode: 'FROST_CLIENT_ID_MISSING' },
    );
    manager.find.mockImplementation((entity) => {
      if (entity === EnvironmentMetricSyncOutcome) return Promise.resolve([frostFailure]);
      if (entity === SiteEnvironmentSyncState) {
        return Promise.resolve([
          Object.assign(new SiteEnvironmentSyncState(), {
            provider: EnvironmentProvider.MET_LOCATIONFORECAST,
            status: EnvironmentSyncStatus.PENDING,
          }),
          Object.assign(new SiteEnvironmentSyncState(), {
            provider: EnvironmentProvider.MET_FROST,
            status: EnvironmentSyncStatus.CONFIGURATION_ERROR,
          }),
        ]);
      }
      return Promise.resolve([]);
    });

    const layers = await service.layerCatalog(TENANT_ID, CALLER, SITE_ID);

    expect(layers.find((layer) => layer.id === 'met:air-temperature')?.availability).toBe(
      EnvironmentAvailabilityStatus.PREPARING,
    );
  });

  it('does not turn a pending primary MET source into out-of-coverage from optional Frost', async () => {
    const frostOutOfCoverage = metricOutcome(
      EnvironmentProvider.MET_FROST,
      EnvironmentMetric.AIR_TEMPERATURE,
      EnvironmentSyncScopeOutcome.OUT_OF_COVERAGE,
    );
    manager.find.mockImplementation((entity) => {
      if (entity === EnvironmentMetricSyncOutcome) return Promise.resolve([frostOutOfCoverage]);
      if (entity === SiteEnvironmentSyncState) {
        return Promise.resolve([
          Object.assign(new SiteEnvironmentSyncState(), {
            provider: EnvironmentProvider.MET_LOCATIONFORECAST,
            status: EnvironmentSyncStatus.PENDING,
          }),
          Object.assign(new SiteEnvironmentSyncState(), {
            provider: EnvironmentProvider.MET_FROST,
            status: EnvironmentSyncStatus.OUT_OF_COVERAGE,
          }),
        ]);
      }
      return Promise.resolve([]);
    });

    const layers = await service.layerCatalog(TENANT_ID, CALLER, SITE_ID);

    expect(layers.find((layer) => layer.id === 'met:air-temperature')?.availability).toBe(
      EnvironmentAvailabilityStatus.PREPARING,
    );
  });

  it('surfaces primary MET configuration failure when no provider supplies the metric', async () => {
    const locationFailure = metricOutcome(
      EnvironmentProvider.MET_LOCATIONFORECAST,
      EnvironmentMetric.AIR_TEMPERATURE,
      EnvironmentSyncScopeOutcome.CONFIGURATION_ERROR,
      { errorCode: 'MET_APPLICATION_IDENTITY' },
    );
    const frostOutOfCoverage = metricOutcome(
      EnvironmentProvider.MET_FROST,
      EnvironmentMetric.AIR_TEMPERATURE,
      EnvironmentSyncScopeOutcome.OUT_OF_COVERAGE,
    );
    manager.find.mockImplementation((entity) => {
      if (entity === EnvironmentMetricSyncOutcome) {
        return Promise.resolve([locationFailure, frostOutOfCoverage]);
      }
      if (entity === SiteEnvironmentSyncState) {
        return Promise.resolve([
          Object.assign(new SiteEnvironmentSyncState(), {
            provider: EnvironmentProvider.MET_LOCATIONFORECAST,
            status: EnvironmentSyncStatus.CONFIGURATION_ERROR,
          }),
          Object.assign(new SiteEnvironmentSyncState(), {
            provider: EnvironmentProvider.MET_FROST,
            status: EnvironmentSyncStatus.OUT_OF_COVERAGE,
          }),
        ]);
      }
      return Promise.resolve([]);
    });

    const layers = await service.layerCatalog(TENANT_ID, CALLER, SITE_ID);

    expect(layers.find((layer) => layer.id === 'met:air-temperature')?.availability).toBe(
      EnvironmentAvailabilityStatus.CONFIGURATION_ERROR,
    );
  });

  it('reports exact Frost missing intervals as partial coverage without hiding observations', async () => {
    const observedAt = new Date('2026-07-30T10:00:00.000Z');
    const missingFrom = new Date('2026-07-30T11:00:00.000Z');
    const missingTo = new Date('2026-07-30T12:00:00.000Z');
    const frost = {
      tenantId: TENANT_ID,
      siteId: SITE_ID,
      observedAt,
      dataType: WeatherDataType.HISTORICAL,
      temperature: 5.2,
      provider: EnvironmentProvider.MET_FROST,
      productId: 'frost-observations-v0',
      datasetId: 'SN00001:timeseries-0',
      sourceRunKey: 'frost-run',
      semanticClass: EnvironmentSemanticClass.OBSERVATION,
      qualityStatus: EnvironmentQualityStatus.VALID,
      fetchedAt: observedAt,
      monitoringLocationRevision: 3,
    } as WeatherObservation;
    const available = metricOutcome(
      EnvironmentProvider.MET_FROST,
      EnvironmentMetric.AIR_TEMPERATURE,
      EnvironmentSyncScopeOutcome.AVAILABLE,
      { validFrom: observedAt, validTo: observedAt, observationCount: 1 },
    );
    const gap = metricOutcome(
      EnvironmentProvider.MET_FROST,
      EnvironmentMetric.AIR_TEMPERATURE,
      EnvironmentSyncScopeOutcome.NO_DATA,
      {
        scopeKey: 'MET_FROST:AIR_TEMPERATURE:missing:0',
        validFrom: missingFrom,
        validTo: missingTo,
      },
    );
    gap.scopeKind = EnvironmentSyncScopeKind.METRIC_INTERVAL;
    manager.find.mockImplementation((entity) => {
      if (entity === WeatherObservation) return Promise.resolve([frost]);
      if (entity === EnvironmentMetricSyncOutcome) return Promise.resolve([available, gap]);
      return Promise.resolve([]);
    });

    const layers = await service.layerCatalog(TENANT_ID, CALLER, SITE_ID);
    const temperature = layers.find((layer) => layer.id === 'met:air-temperature');

    expect(temperature?.availability).toBe(EnvironmentAvailabilityStatus.PARTIAL_COVERAGE);
    expect(temperature?.coverage.scopes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scopeKey: 'MET_FROST:AIR_TEMPERATURE:missing:0',
          validFrom: missingFrom,
          validTo: missingTo,
          outcome: EnvironmentSyncScopeOutcome.NO_DATA,
        }),
      ]),
    );
  });

  it('marks a catalog layer stale from source age even when forecast validity is future', async () => {
    const now = new Date('2026-07-31T12:00:00.000Z');
    jest.useFakeTimers();
    jest.setSystemTime(now);
    const cached = {
      tenantId: TENANT_ID,
      siteId: SITE_ID,
      observedAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
      dataType: WeatherDataType.FORECAST,
      waveHeight: 0.8,
      provider: EnvironmentProvider.CMEMS,
      productId: 'NWSHELF_ANALYSISFORECAST_WAV_004_014',
      datasetId: 'nws-wave',
      variableSetId: 'WAVE_HEIGHT=VHM0',
      sourceRunKey: 'stale-wave-run',
      issuedAt: new Date(now.getTime() - 24 * 60 * 60 * 1_000),
      semanticClass: EnvironmentSemanticClass.FORECAST,
      qualityStatus: EnvironmentQualityStatus.PROVISIONAL,
      fetchedAt: new Date(now.getTime() - 24 * 60 * 60 * 1_000),
      monitoringLocationRevision: 3,
    } as MarineObservation;
    manager.find.mockImplementation((entity) =>
      Promise.resolve(entity === MarineObservation ? [cached] : []),
    );

    const layers = await service.layerCatalog(TENANT_ID, CALLER, SITE_ID);

    expect(layers.find((layer) => layer.id === 'cmems:wave')?.availability).toBe(
      EnvironmentAvailabilityStatus.STALE,
    );
  });

  it('pins every observation read to the current monitoring-location revision', async () => {
    await service.current(TENANT_ID, CALLER, SITE_ID);

    const observationCalls = manager.find.mock.calls.filter(
      ([entity]) => entity === WeatherObservation || entity === MarineObservation,
    );
    expect(observationCalls).toHaveLength(2);
    for (const [, options] of observationCalls) {
      expect(options).toEqual(
        expect.objectContaining({
          where: expect.objectContaining({ monitoringLocationRevision: 3 }),
        }),
      );
    }
  });

  it('selects metric-level correction winners in PostgreSQL before hydrating bounded rows', async () => {
    await service.current(TENANT_ID, CALLER, SITE_ID);

    const statements = queryRunner.query.mock.calls.map(([statement]) => String(statement));
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('CROSS JOIN LATERAL');
    expect(statements[0]).toContain('row_number() OVER');
    expect(statements[0]).toContain('PARTITION BY metric');
    expect(statements[0]).toContain("CASE provider WHEN 'MET_FROST' THEN 0 ELSE 1 END");
    expect(statements[1]).toContain('row_number() OVER');
    expect(statements[1]).toContain('SELECT DISTINCT observation_id AS id');
  });

  it('reports Sentinel out-of-coverage metadata as unavailable rather than ready', async () => {
    manager.find.mockImplementation((entity) => {
      if (entity === SatelliteSceneObservation) {
        return Promise.resolve([
          {
            acquiredAt: new Date(),
            qualityStatus: EnvironmentQualityStatus.OUT_OF_COVERAGE,
            coverageAssessments: [coverageAssessment(SatelliteCoverageStatus.OUT_OF_COVERAGE)],
          } as SatelliteSceneObservation,
        ]);
      }
      return Promise.resolve([]);
    });

    const layers = await service.layerCatalog(TENANT_ID, CALLER, SITE_ID);
    const imagery = layers.find((layer) => layer.id === 'sentinel:natural-color');

    expect(imagery?.availability).toBe(EnvironmentAvailabilityStatus.OUT_OF_COVERAGE);
    expect(imagery?.availableFrom).toBeNull();
    expect(imagery?.availableTo).toBeNull();
  });
});

describe('satellite coverage assessment read precedence', () => {
  function sceneWith(assessments: SatelliteSceneCoverageAssessment[]): SatelliteSceneObservation {
    return Object.assign(new SatelliteSceneObservation(), {
      coverageAssessments: assessments,
    });
  }

  function versionedAssessment(
    id: string,
    method: string,
    createdAt: string,
  ): SatelliteSceneCoverageAssessment {
    return Object.assign(new SatelliteSceneCoverageAssessment(), {
      id,
      coverageMethod: method,
      coverageStatus:
        method === SATELLITE_COVERAGE_LEGACY_METHOD
          ? SatelliteCoverageStatus.UNKNOWN
          : SatelliteCoverageStatus.PARTIAL,
      coveragePercent: method === SATELLITE_COVERAGE_LEGACY_METHOD ? null : 50,
      coverageSampleCount: method === SATELLITE_COVERAGE_LEGACY_METHOD ? null : 256,
      qualityStatus: EnvironmentQualityStatus.PROVISIONAL,
      createdAt: new Date(createdAt),
    });
  }

  it('prefers the current method over newer alternatives and legacy provenance', () => {
    const current = versionedAssessment(
      '11111111-1111-4111-8111-111111111111',
      CDSE_COVERAGE_METHOD,
      '2026-07-01T00:00:00.000Z',
    );
    const selected = selectSatelliteCoverageAssessment(
      sceneWith([
        versionedAssessment(
          '22222222-2222-4222-8222-222222222222',
          'FUTURE_METHOD_V4',
          '2026-08-01T00:00:00.000Z',
        ),
        versionedAssessment(
          '33333333-3333-4333-8333-333333333333',
          SATELLITE_COVERAGE_LEGACY_METHOD,
          '2026-06-01T00:00:00.000Z',
        ),
        current,
      ]),
    );

    expect(selected).toBe(current);
  });

  it('falls back to the newest nonlegacy method, then to legacy', () => {
    const older = versionedAssessment(
      '44444444-4444-4444-8444-444444444444',
      'TOPOLOGY_V1',
      '2026-06-01T00:00:00.000Z',
    );
    const newer = versionedAssessment(
      '55555555-5555-4555-8555-555555555555',
      'TOPOLOGY_V2',
      '2026-07-01T00:00:00.000Z',
    );
    const legacy = versionedAssessment(
      '66666666-6666-4666-8666-666666666666',
      SATELLITE_COVERAGE_LEGACY_METHOD,
      '2026-08-01T00:00:00.000Z',
    );

    expect(selectSatelliteCoverageAssessment(sceneWith([legacy, older, newer]))).toBe(newer);
    expect(selectSatelliteCoverageAssessment(sceneWith([legacy]))).toBe(legacy);
  });
});
