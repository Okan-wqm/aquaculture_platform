import { createMockDataSource } from '@aquaculture/testing';
import { DataSource, QueryRunner } from 'typeorm';

import {
  SatelliteCoverageStatus,
  EnvironmentProvider,
  EnvironmentMetric,
  EnvironmentQualityStatus,
  EnvironmentSemanticClass,
  EnvironmentSyncScopeCoverage,
  EnvironmentSyncScopeKind,
  EnvironmentSyncScopeOutcome,
  EnvironmentSyncStatus,
} from '../entities/environment-observation.types';
import { WeatherDataType } from '../entities/weather-observation.entity';
import {
  CanonicalSatelliteSceneInsert,
  CanonicalWeatherInsert,
  EnvironmentSyncCompletion,
  EnvironmentSyncLease,
  EnvironmentSyncStore,
  assertEnvironmentSyncCompletionContract,
} from './environment-sync-store.service';
import { CDSE_COVERAGE_METHOD, CDSE_SENTINEL_2_COLLECTION } from './cdse-sentinel.provider';

const NOW = new Date('2026-07-31T04:00:00.000Z');
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SCHEMA = 'tenant_aaaaaaaaaaaa4aaa';
const LEASE_DURATION_MS = 2 * 60 * 60 * 1_000;

function lease(): EnvironmentSyncLease {
  return {
    schema: SCHEMA,
    tenantId: TENANT_ID,
    siteId: SITE_ID,
    provider: EnvironmentProvider.MET_LOCATIONFORECAST,
    token: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    monitoringLocationRevision: 2,
    latitude: 0,
    longitude: 0,
    altitudeM: 0,
    monitoringRadiusM: 2_000,
    monitoringArea: null,
    cursor: null,
    consecutiveFailures: 0,
  };
}

function weatherRow(): CanonicalWeatherInsert {
  return {
    tenantId: TENANT_ID,
    siteId: SITE_ID,
    observedAt: NOW,
    dataType: WeatherDataType.HISTORICAL,
    provider: EnvironmentProvider.MET_LOCATIONFORECAST,
    productId: 'locationforecast-2.0',
    datasetId: 'compact',
    sourceRunKey: 'met-locationforecast:2026-07-31T03:00:00.000Z',
    issuedAt: new Date('2026-07-31T03:00:00.000Z'),
    semanticClass: EnvironmentSemanticClass.FORECAST,
    qualityStatus: EnvironmentQualityStatus.PROVISIONAL,
    stationId: null,
    stationDistanceKm: null,
    horizontalResolutionM: null,
    monitoringLocationRevision: 2,
    temperature: 0,
    windSpeed: 0,
    windDirection: 0,
    windGusts: 0,
    precipitation: 0,
    cloudCover: 0,
    pressureMsl: 1000,
    relativeHumidity: 80,
    fetchedAt: NOW,
  };
}

function cdseSceneRow(): CanonicalSatelliteSceneInsert {
  return {
    tenantId: TENANT_ID,
    siteId: SITE_ID,
    sceneId: 'S2B_TEST_SCENE',
    collection: CDSE_SENTINEL_2_COLLECTION,
    provider: EnvironmentProvider.CDSE_SENTINEL_2,
    productId: 'S2B_TEST_SCENE',
    datasetId: CDSE_SENTINEL_2_COLLECTION,
    acquiredAt: new Date('2026-07-30T10:25:59.000Z'),
    cloudCoverPercent: 30,
    coveragePercent: 50,
    coverageStatus: SatelliteCoverageStatus.PARTIAL,
    coverageMethod: CDSE_COVERAGE_METHOD,
    coverageSampleCount: 256,
    qualityStatus: EnvironmentQualityStatus.PROVISIONAL,
    monitoringLocationRevision: 2,
    fetchedAt: NOW,
  };
}

function availableCoverage(): EnvironmentSyncScopeCoverage[] {
  return [
    {
      scopeKind: EnvironmentSyncScopeKind.METRIC_SUMMARY,
      scopeKey: 'MET_LOCATIONFORECAST:AIR_TEMPERATURE',
      metric: EnvironmentMetric.AIR_TEMPERATURE,
      validFrom: NOW,
      validTo: NOW,
      outcome: EnvironmentSyncScopeOutcome.AVAILABLE,
      errorCode: null,
      observationCount: 1,
    },
  ];
}

function cdseCoverage(): EnvironmentSyncScopeCoverage[] {
  return [
    {
      scopeKind: EnvironmentSyncScopeKind.PROVIDER_RUN,
      scopeKey: 'CDSE:SENTINEL_2_L2A',
      metric: null,
      validFrom: new Date('2026-07-01T04:00:00.000Z'),
      validTo: NOW,
      outcome: EnvironmentSyncScopeOutcome.AVAILABLE,
      errorCode: null,
      observationCount: 1,
    },
  ];
}

describe('EnvironmentSyncStore', () => {
  let dataSource: jest.Mocked<DataSource>;
  let queryRunner: jest.Mocked<QueryRunner>;
  let store: EnvironmentSyncStore;

  beforeEach(() => {
    ({ mockDataSource: dataSource, mockQueryRunner: queryRunner } = createMockDataSource());
    store = new EnvironmentSyncStore(dataSource);
  });

  it('reconciles missing site-provider states only at the explicit tenant sweep boundary', async () => {
    queryRunner.query.mockImplementation((statement: string) => {
      if (statement.includes('current_setting($1, true) AS tenant')) {
        return Promise.resolve([{ schema: SCHEMA, tenant: TENANT_ID, bypass: 'off' }]);
      }
      return Promise.resolve([]);
    });

    await store.reconcileSyncStates(SCHEMA, TENANT_ID, NOW);

    const reconciliationCalls = queryRunner.query.mock.calls.filter(([statement]) =>
      String(statement).includes('INSERT INTO site_environment_sync_state'),
    );
    expect(reconciliationCalls).toHaveLength(1);
    expect(reconciliationCalls[0]?.[1]).toEqual([NOW, expect.any(Array)]);
  });

  it('claims zero-coordinate SEA_CAGE work with an atomic replica-safe lease', async () => {
    queryRunner.query.mockImplementation((statement: string) => {
      if (statement.includes('WITH due AS')) {
        return Promise.resolve([
          {
            schema_name: SCHEMA,
            tenant_id: TENANT_ID,
            site_id: SITE_ID,
            provider: EnvironmentProvider.MET_LOCATIONFORECAST,
            lease_token: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            monitoring_location_revision: 2,
            latitude: 0,
            longitude: 0,
            altitude_m: 0,
            monitoring_radius_m: 2_000,
            monitoring_area: null,
            cursor: null,
            consecutive_failures: 0,
          },
        ]);
      }
      if (statement.includes('current_setting($1, true) AS tenant')) {
        return Promise.resolve([{ schema: SCHEMA, tenant: TENANT_ID, bypass: 'off' }]);
      }
      return Promise.resolve([]);
    });

    const result = await store.claimDue(SCHEMA, TENANT_ID, NOW, NOW, 1, LEASE_DURATION_MS);

    expect(result).toEqual([lease()]);
    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).not.toContain('INSERT INTO site_environment_sync_state');
    expect(sql).toContain('FOR UPDATE OF state SKIP LOCKED');
    expect(sql).toContain(`site."type"::text = 'sea_cage'`);
    expect(sql).toContain(`site."isDeleted" = FALSE`);
    expect(sql).toContain(`state.next_run_at <= $2`);
    expect(sql).toContain(`state.last_attempt_at < $2`);
    expect(sql).toContain(`state.lease_expires_at <= $3`);
    expect(sql).toContain(`$3 + ($5::integer * interval '1 millisecond')`);
    const claimCall = queryRunner.query.mock.calls.find(([statement]) =>
      String(statement).includes('WITH due AS'),
    );
    expect(claimCall?.[1]?.[4]).toBe(LEASE_DURATION_MS);
    expect(queryRunner.query).toHaveBeenCalledWith(
      `SELECT pg_catalog.set_config('search_path', $1, true)`,
      [`"${SCHEMA}", "farm", public`],
    );
    expect(queryRunner.query).toHaveBeenCalledWith(`SELECT set_config($1, $2, true)`, [
      'app.current_tenant',
      TENANT_ID,
    ]);
    expect(queryRunner.query).toHaveBeenCalledWith(`SELECT set_config($1, 'off', true)`, [
      'app.bypass_rls',
    ]);
  });

  it('measures the existing due backlog without re-running state reconciliation', async () => {
    const oldestDueAt = new Date('2026-07-31T02:30:00.000Z');
    queryRunner.query.mockImplementation((statement: string) => {
      if (statement.includes('COUNT(*)::text AS due_count')) {
        return Promise.resolve([{ due_count: '17', oldest_due_at: oldestDueAt }]);
      }
      if (statement.includes('current_setting($1, true) AS tenant')) {
        return Promise.resolve([{ schema: SCHEMA, tenant: TENANT_ID, bypass: 'off' }]);
      }
      return Promise.resolve([]);
    });

    await expect(store.measureDueBacklog(SCHEMA, TENANT_ID, NOW)).resolves.toEqual({
      dueCount: 17,
      oldestDueAt,
    });

    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).not.toContain('INSERT INTO site_environment_sync_state');
    expect(sql).toContain('MIN(COALESCE(state.next_run_at, $2))');
    expect(sql).toContain('state.lease_expires_at <= $2');
  });

  it('fences completion on both lease token and current location revision', async () => {
    queryRunner.query.mockResolvedValue([]);

    await expect(
      store.complete(
        lease(),
        {
          status: EnvironmentSyncStatus.READY,
          nextRunAt: new Date(NOW.getTime() + 60_000),
          errorCode: null,
          cursor: null,
          successfulProviderResponse: true,
          coverage: availableCoverage(),
          weather: [weatherRow()],
          marine: [],
          scenes: [],
        },
        NOW,
      ),
    ).resolves.toBe(false);

    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain(`state.lease_token = $4`);
    expect(sql).toContain(`state.lease_expires_at > $6`);
    expect(sql).toContain(`site."monitoringLocationRevision" = $5`);
    expect(sql).not.toContain('INSERT INTO weather_observations');
  });

  it('uses append-only conflict identities so replay is idempotent without updates', async () => {
    queryRunner.query.mockImplementation((statement: string) => {
      if (statement.includes('SELECT state.id')) {
        return Promise.resolve([{ id: 'state-id' }]);
      }
      if (statement.includes('UPDATE site_environment_sync_state')) {
        return Promise.resolve([{ id: 'state-id' }]);
      }
      return Promise.resolve([]);
    });

    await expect(
      store.complete(
        lease(),
        {
          status: EnvironmentSyncStatus.READY,
          nextRunAt: new Date(NOW.getTime() + 60_000),
          errorCode: null,
          cursor: null,
          successfulProviderResponse: true,
          coverage: availableCoverage(),
          weather: [weatherRow()],
          marine: [],
          scenes: [],
        },
        NOW,
      ),
    ).resolves.toBe(true);

    const insert = queryRunner.query.mock.calls
      .map(([statement]) => String(statement))
      .find((statement) => statement.includes('INSERT INTO weather_observations'));
    expect(insert).toContain('source_run_key');
    expect(insert).toContain('monitoring_location_revision');
    expect(insert).toContain('DO NOTHING');
    expect(insert).not.toContain('DO UPDATE');
    const coverageInsertCall = queryRunner.query.mock.calls.find(([statement]) =>
      String(statement).includes('INSERT INTO environment_metric_sync_outcomes'),
    );
    expect(coverageInsertCall?.[1]?.slice(5)).toEqual([
      [EnvironmentMetric.AIR_TEMPERATURE],
      [EnvironmentSyncScopeKind.METRIC_SUMMARY],
      ['MET_LOCATIONFORECAST:AIR_TEMPERATURE'],
      [NOW],
      [NOW],
      [EnvironmentSyncScopeOutcome.AVAILABLE],
      [null],
      [1],
    ]);
    const completionUpdate = queryRunner.query.mock.calls
      .map(([statement]) => String(statement))
      .find((statement) => statement.includes('WITH updated AS'));
    expect(completionUpdate).toContain('SELECT id FROM updated');
    const completionUpdateCall = queryRunner.query.mock.calls.find(([statement]) =>
      String(statement).includes('WITH updated AS'),
    );
    expect(completionUpdateCall?.[1]?.slice(11)).toEqual([1, 1, 0, 0, 0]);
  });

  it('persists raw scenes before their separate immutable coverage assessment', async () => {
    queryRunner.query.mockImplementation((statement: string) => {
      if (statement.includes('SELECT state.id')) return Promise.resolve([{ id: 'state-id' }]);
      if (statement.includes('UPDATE site_environment_sync_state')) {
        return Promise.resolve([{ id: 'state-id' }]);
      }
      return Promise.resolve([]);
    });
    const cdseLease = { ...lease(), provider: EnvironmentProvider.CDSE_SENTINEL_2 };

    await expect(
      store.complete(
        cdseLease,
        {
          status: EnvironmentSyncStatus.READY,
          nextRunAt: new Date(NOW.getTime() + 60_000),
          errorCode: null,
          cursor: 'scene-cursor',
          successfulProviderResponse: true,
          coverage: cdseCoverage(),
          weather: [],
          marine: [],
          scenes: [cdseSceneRow()],
        },
        NOW,
      ),
    ).resolves.toBe(true);

    const sceneInsertCall = queryRunner.query.mock.calls.find(([statement]) =>
      String(statement).includes('INSERT INTO satellite_scene_observations'),
    );
    const assessmentInsertCall = queryRunner.query.mock.calls.find(([statement]) =>
      String(statement).includes('INSERT INTO satellite_scene_coverage_assessments'),
    );
    const statements = queryRunner.query.mock.calls.map(([statement]) => String(statement));
    expect(String(sceneInsertCall?.[0])).not.toContain('coverage_status');
    expect(String(sceneInsertCall?.[0])).not.toContain('coverage_method');
    expect(String(sceneInsertCall?.[0])).not.toContain('coverage_sample_count');
    expect(String(assessmentInsertCall?.[0])).toContain('coverage_status');
    expect(String(assessmentInsertCall?.[0])).toContain('coverage_method');
    expect(String(assessmentInsertCall?.[0])).toContain('coverage_sample_count');
    expect(assessmentInsertCall?.[1]?.[0]).toContain('"coverage_status":"PARTIAL"');
    expect(assessmentInsertCall?.[1]?.[0]).toContain(`"coverage_method":"${CDSE_COVERAGE_METHOD}"`);
    expect(assessmentInsertCall?.[1]?.[0]).toContain('"coverage_sample_count":256');
    expect(assessmentInsertCall?.[1]?.[0]).toContain('"quality_status":"PROVISIONAL"');
    expect(statements.indexOf(String(sceneInsertCall?.[0]))).toBeLessThan(
      statements.indexOf(String(assessmentInsertCall?.[0])),
    );
    expect(statements.join('\n')).toContain('IS DISTINCT FROM source.coverage_status');
    expect(statements.join('\n')).toContain('CAST(source.coverage_percent AS numeric(5,2))');
    expect(statements.join('\n')).toContain('CAST(source.cloud_cover_percent AS numeric(5,2))');
  });

  it('rejects divergent immutable raw acquisition facts before writing an assessment', async () => {
    queryRunner.query.mockImplementation((statement: string) => {
      if (statement.includes('SELECT state.id')) return Promise.resolve([{ id: 'state-id' }]);
      if (
        statement.includes('SELECT source.scene_id') &&
        !statement.includes('source.coverage_method')
      ) {
        return Promise.resolve([{ scene_id: 'S2B_TEST_SCENE' }]);
      }
      return Promise.resolve([]);
    });

    await expect(
      store.complete(
        { ...lease(), provider: EnvironmentProvider.CDSE_SENTINEL_2 },
        {
          status: EnvironmentSyncStatus.READY,
          nextRunAt: new Date(NOW.getTime() + 60_000),
          errorCode: null,
          cursor: 'scene-cursor',
          successfulProviderResponse: true,
          coverage: cdseCoverage(),
          weather: [],
          marine: [],
          scenes: [{ ...cdseSceneRow(), productId: 'DIVERGENT_PRODUCT' }],
        },
        NOW,
      ),
    ).rejects.toThrow(/conflicts with immutable persisted acquisition facts/u);

    expect(
      queryRunner.query.mock.calls.some(([statement]) =>
        String(statement).includes('INSERT INTO satellite_scene_coverage_assessments'),
      ),
    ).toBe(false);
  });

  it('rolls completion back when the same coverage method has divergent provenance', async () => {
    queryRunner.query.mockImplementation((statement: string) => {
      if (statement.includes('SELECT state.id')) return Promise.resolve([{ id: 'state-id' }]);
      if (statement.includes('SELECT source.scene_id, source.coverage_method')) {
        return Promise.resolve([
          { scene_id: 'S2B_TEST_SCENE', coverage_method: CDSE_COVERAGE_METHOD },
        ]);
      }
      return Promise.resolve([]);
    });

    await expect(
      store.complete(
        { ...lease(), provider: EnvironmentProvider.CDSE_SENTINEL_2 },
        {
          status: EnvironmentSyncStatus.READY,
          nextRunAt: new Date(NOW.getTime() + 60_000),
          errorCode: null,
          cursor: 'scene-cursor',
          successfulProviderResponse: true,
          coverage: cdseCoverage(),
          weather: [],
          marine: [],
          scenes: [cdseSceneRow()],
        },
        NOW,
      ),
    ).rejects.toThrow(/conflicts with immutable persisted provenance/u);

    expect(
      queryRunner.query.mock.calls.some(([statement]) =>
        String(statement).includes('UPDATE site_environment_sync_state'),
      ),
    ).toBe(false);
  });

  it('rejects missing or contradictory scene coverage provenance before database I/O', () => {
    const cdseLease = { ...lease(), provider: EnvironmentProvider.CDSE_SENTINEL_2 };
    const completion: EnvironmentSyncCompletion = {
      status: EnvironmentSyncStatus.READY,
      nextRunAt: new Date(NOW.getTime() + 60_000),
      errorCode: null,
      cursor: 'scene-cursor',
      successfulProviderResponse: true,
      coverage: cdseCoverage(),
      weather: [],
      marine: [],
      scenes: [{ ...cdseSceneRow(), coverageSampleCount: 0 }],
    };

    expect(() => assertEnvironmentSyncCompletionContract(cdseLease, completion)).toThrow(
      /coverage dimensions contradict/u,
    );

    expect(() =>
      assertEnvironmentSyncCompletionContract(cdseLease, {
        ...completion,
        scenes: [{ ...cdseSceneRow(), coveragePercent: null, coverageSampleCount: 0 }],
      }),
    ).not.toThrow();
  });

  it('persists mixed coverage as an explicit partial completion summary', async () => {
    queryRunner.query.mockImplementation((statement: string) => {
      if (statement.includes('SELECT state.id')) return Promise.resolve([{ id: 'state-id' }]);
      if (statement.includes('UPDATE site_environment_sync_state')) {
        return Promise.resolve([{ id: 'state-id' }]);
      }
      return Promise.resolve([]);
    });
    const coverage: EnvironmentSyncScopeCoverage[] = [
      ...availableCoverage(),
      {
        scopeKind: EnvironmentSyncScopeKind.METRIC_INTERVAL,
        scopeKey: 'MET_LOCATIONFORECAST:AIR_TEMPERATURE:failed-window',
        metric: EnvironmentMetric.AIR_TEMPERATURE,
        validFrom: NOW,
        validTo: NOW,
        outcome: EnvironmentSyncScopeOutcome.PROVIDER_UNAVAILABLE,
        errorCode: 'UPSTREAM_TIMEOUT',
        observationCount: 0,
      },
    ];

    await expect(
      store.complete(
        lease(),
        {
          status: EnvironmentSyncStatus.PARTIAL_FAILURE,
          nextRunAt: new Date(NOW.getTime() + 60_000),
          errorCode: 'PROVIDER_PARTIAL_FAILURE',
          cursor: null,
          successfulProviderResponse: true,
          coverage,
          weather: [weatherRow()],
          marine: [],
          scenes: [],
        },
        NOW,
      ),
    ).resolves.toBe(true);

    const completionUpdateCall = queryRunner.query.mock.calls.find(([statement]) =>
      String(statement).includes('WITH updated AS'),
    );
    expect(completionUpdateCall?.[1]?.slice(5)).toEqual([
      EnvironmentSyncStatus.PARTIAL_FAILURE,
      null,
      true,
      NOW,
      new Date(NOW.getTime() + 60_000),
      'PROVIDER_PARTIAL_FAILURE',
      2,
      1,
      1,
      0,
      0,
    ]);
  });

  it('rolls back inserted observations if the locked sync-state update is lost', async () => {
    Object.defineProperty(queryRunner, 'isTransactionActive', {
      configurable: true,
      get: () => true,
    });
    queryRunner.query.mockImplementation((statement: string) => {
      if (statement.includes('SELECT state.id')) {
        return Promise.resolve([{ id: 'state-id' }]);
      }
      if (statement.includes('UPDATE site_environment_sync_state')) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    await expect(
      store.complete(
        lease(),
        {
          status: EnvironmentSyncStatus.READY,
          nextRunAt: new Date(NOW.getTime() + 60_000),
          errorCode: null,
          cursor: null,
          successfulProviderResponse: true,
          coverage: availableCoverage(),
          weather: [weatherRow()],
          marine: [],
          scenes: [],
        },
        NOW,
      ),
    ).rejects.toThrow(/state update was lost/u);

    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  it('retains canonical rows and removes obsolete, inactive, deleted, or non-sea-cage state', async () => {
    queryRunner.query.mockImplementation((statement: string) => {
      if (statement.includes('current_setting($1, true) AS tenant')) {
        return Promise.resolve([{ schema: SCHEMA, tenant: TENANT_ID, bypass: 'off' }]);
      }
      if (statement.includes('pg_try_advisory_xact_lock')) {
        return Promise.resolve([{ acquired: true }]);
      }
      if (statement.includes('DELETE FROM')) return Promise.resolve([[], 2]);
      return Promise.resolve([]);
    });
    const cutoff = new Date('2026-06-16T04:00:00.000Z');

    await expect(store.retainSchema(SCHEMA, TENANT_ID, cutoff)).resolves.toEqual({
      weatherDeleted: 2,
      marineDeleted: 2,
      scenesDeleted: 2,
      obsoleteStatesDeleted: 2,
    });

    const calls = queryRunner.query.mock.calls.filter(([statement]) =>
      String(statement).includes('DELETE FROM'),
    );
    expect(calls).toHaveLength(4);
    expect(calls.every(([, parameters]) => parameters?.[0] === cutoff)).toBe(true);
    expect(String(calls[3]![0])).toContain('state.monitoring_location_revision <>');
    expect(String(calls[3]![0])).toContain('site."isActive" = FALSE');
    expect(String(calls[3]![0])).toContain('site."isDeleted" = TRUE');
    expect(String(calls[3]![0])).toContain(`site."type"::text <> 'sea_cage'`);
    expect(queryRunner.query).toHaveBeenCalledWith(`SET LOCAL lock_timeout = '2s'`);
    expect(queryRunner.query).toHaveBeenCalledWith(`SET LOCAL statement_timeout = '60s'`);
  });

  it('skips tenant retention when another replica owns its transaction lock', async () => {
    queryRunner.query.mockImplementation((statement: string) => {
      if (statement.includes('current_setting($1, true) AS tenant')) {
        return Promise.resolve([{ schema: SCHEMA, tenant: TENANT_ID, bypass: 'off' }]);
      }
      if (statement.includes('pg_try_advisory_xact_lock')) {
        return Promise.resolve([{ acquired: false }]);
      }
      return Promise.resolve([]);
    });

    await expect(
      store.retainSchema(SCHEMA, TENANT_ID, new Date('2026-06-16T04:00:00.000Z')),
    ).resolves.toEqual({
      weatherDeleted: 0,
      marineDeleted: 0,
      scenesDeleted: 0,
      obsoleteStatesDeleted: 0,
    });

    expect(
      queryRunner.query.mock.calls.some(([statement]) => String(statement).includes('DELETE FROM')),
    ).toBe(false);
    expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the retention lock result violates its database contract', async () => {
    queryRunner.query.mockImplementation((statement: string) => {
      if (statement.includes('current_setting($1, true) AS tenant')) {
        return Promise.resolve([{ schema: SCHEMA, tenant: TENANT_ID, bypass: 'off' }]);
      }
      if (statement.includes('pg_try_advisory_xact_lock')) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    await expect(
      store.retainSchema(SCHEMA, TENANT_ID, new Date('2026-06-16T04:00:00.000Z')),
    ).rejects.toThrow(/retention lock failed database contract validation/u);

    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  it('rejects an unsafe schema before opening a database connection', async () => {
    await expect(
      store.claimDue('tenant_bad";DROP SCHEMA farm', TENANT_ID, NOW, NOW, 1, 60_000),
    ).rejects.toThrow(/Unsafe schema name/u);
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('rejects a tenant identity that does not derive the requested schema', async () => {
    await expect(
      store.claimDue(SCHEMA, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', NOW, NOW, 1, 60_000),
    ).rejects.toThrow(/identity does not match/u);
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('rejects a claim clock older than its fixed sweep cutoff', async () => {
    await expect(
      store.claimDue(SCHEMA, TENANT_ID, NOW, new Date(NOW.getTime() - 1), 1, LEASE_DURATION_MS),
    ).rejects.toThrow(/claim clock cannot precede/u);
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('rejects cross-tenant completion rows before opening a transaction', async () => {
    await expect(
      store.complete(
        lease(),
        {
          status: EnvironmentSyncStatus.READY,
          nextRunAt: NOW,
          errorCode: null,
          cursor: null,
          successfulProviderResponse: true,
          coverage: availableCoverage(),
          weather: [{ ...weatherRow(), tenantId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }],
          marine: [],
          scenes: [],
        },
        NOW,
      ),
    ).rejects.toThrow(/outside its claimed site revision/u);
    expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
  });
});
