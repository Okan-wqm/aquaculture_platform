import { randomBytes } from 'node:crypto';

import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource } from 'typeorm';

import { AddSatelliteCoverageProvenance1808000000000 } from '../../database/migrations/1808000000000-AddSatelliteCoverageProvenance';
import {
  EnvironmentProvider,
  EnvironmentQualityStatus,
  EnvironmentSyncScopeKind,
  EnvironmentSyncScopeOutcome,
  EnvironmentSyncStatus,
  SatelliteCoverageStatus,
} from '../entities/environment-observation.types';
import { CDSE_COVERAGE_METHOD, CDSE_SENTINEL_2_COLLECTION } from './cdse-sentinel.provider';
import {
  CanonicalSatelliteSceneInsert,
  EnvironmentSyncCompletion,
  EnvironmentSyncLease,
  EnvironmentSyncStore,
} from './environment-sync-store.service';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_ID = '11111111-1111-4111-8111-111111111111';
const LEASE_TOKEN = '22222222-2222-4222-8222-222222222222';
const SCENE_ID = 'S2B_LEGACY_THEN_V3';
const ROLLING_SCENE_ID = 'S2B_OLD_REPLICA_AFTER_180800';
const NEW_BINARY_SCENE_ID = 'S2B_NEW_BINARY_DEFERRED_V3';
const NOW = new Date('2026-07-31T04:00:00.000Z');
const ACQUIRED_AT = new Date('2026-07-30T10:25:59.000Z');
const RUNTIME_ROLE = 'farm_satellite_coverage_worker_test';

jest.setTimeout(120_000);

describe('satellite coverage assessment SSOT on real Postgres', () => {
  let harness: HarnessContext | undefined;
  let runtime: DataSource | undefined;
  let store: EnvironmentSyncStore;

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    const admin = harness.dataSource;
    const password = randomBytes(24).toString('hex');
    const farmServicePassword = randomBytes(24).toString('hex');
    const schema = getTenantSchemaName(TENANT_ID);

    await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await admin.query('CREATE SCHEMA farm');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${password}'`);
    await admin.query(`CREATE ROLE farm_service LOGIN PASSWORD '${farmServicePassword}'`);
    await createRawEnvironmentTables(admin, schema);
    await admin.query(
      `INSERT INTO "${schema}".sites (
         id, "tenantId", "type", "isActive", "isDeleted", location,
         "monitoringLocationRevision", "monitoringRadiusM", "monitoringArea"
       ) VALUES ($1, $2, 'sea_cage', TRUE, FALSE, $3::jsonb, 1, 2000, NULL)`,
      [SITE_ID, TENANT_ID, JSON.stringify({ latitude: 60, longitude: 5 })],
    );
    await admin.query(
      `INSERT INTO "${schema}".satellite_scene_observations (
         tenant_id, site_id, scene_id, collection, provider, product_id,
         dataset_id, acquired_at, cloud_cover_percent, coverage_percent,
         quality_status, monitoring_location_revision, fetched_at
       ) VALUES ($1, $2, $3, $4, 'CDSE_SENTINEL_2', $3, $4, $5, 30, 50,
                 'PROVISIONAL', 1, $6)`,
      [TENANT_ID, SITE_ID, SCENE_ID, CDSE_SENTINEL_2_COLLECTION, ACQUIRED_AT, NOW],
    );
    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO farm_service`);
    await admin.query(
      `GRANT SELECT, INSERT ON TABLE "${schema}".satellite_scene_observations
       TO farm_service`,
    );

    await runMigrationUp(admin, schema);
    const oldReplica = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      username: 'farm_service',
      password: farmServicePassword,
      name: `farm-old-replica-${randomBytes(4).toString('hex')}`,
      synchronize: false,
      logging: false,
    });
    await oldReplica.initialize();
    try {
      await insertOldReplicaScene(oldReplica, schema);
    } finally {
      await oldReplica.destroy();
    }
    await runMigrationUp(admin, schema);

    await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${RUNTIME_ROLE}`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}"
       TO ${RUNTIME_ROLE}`,
    );

    runtime = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      username: RUNTIME_ROLE,
      password,
      name: `farm-satellite-coverage-${randomBytes(4).toString('hex')}`,
      synchronize: false,
      logging: false,
    });
    await runtime.initialize();
    store = new EnvironmentSyncStore(runtime);
  });

  afterAll(async () => {
    if (runtime?.isInitialized) {
      await runtime.destroy();
    }
    await shutdownHarness(harness);
  });

  it('keeps legacy and V3, verifies exact replay, and rejects divergent same-method data', async () => {
    const admin = requireAdmin();
    const schema = getTenantSchemaName(TENANT_ID);
    expect(await assessments(admin, schema)).toEqual([
      expect.objectContaining({
        coverage_method: 'LEGACY_UNKNOWN',
        coverage_status: SatelliteCoverageStatus.UNKNOWN,
        coverage_percent: '50.00',
        coverage_sample_count: null,
        quality_status: EnvironmentQualityStatus.PROVISIONAL,
      }),
    ]);
    expect(await assessments(admin, schema, ROLLING_SCENE_ID)).toEqual([
      expect.objectContaining({
        coverage_method: 'LEGACY_UNKNOWN',
        coverage_status: SatelliteCoverageStatus.UNKNOWN,
        coverage_percent: '75.00',
        coverage_sample_count: null,
        quality_status: EnvironmentQualityStatus.PROVISIONAL,
      }),
    ]);
    const security: Array<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      has_insert: boolean;
      policy_count: string;
    }> = await admin.query(
      `SELECT relation.relrowsecurity,
              relation.relforcerowsecurity,
              has_table_privilege(
                'farm_service',
                format('%I.%I', namespace.nspname, relation.relname),
                'INSERT'
              ) AS has_insert,
              (
                SELECT COUNT(*)::text
                FROM pg_policy AS policy
                WHERE policy.polrelid = relation.oid
                  AND policy.polname = 'tenant_isolation_policy'
              ) AS policy_count
         FROM pg_class AS relation
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = $1
          AND relation.relname = 'satellite_scene_coverage_assessments'`,
      [schema],
    );
    expect(security).toEqual([
      {
        relrowsecurity: true,
        relforcerowsecurity: true,
        has_insert: true,
        policy_count: '1',
      },
    ]);

    await armLease(admin, schema);
    await expect(store.complete(lease(schema), completion(scene()), NOW)).resolves.toBe(true);
    expect(await assessments(admin, schema)).toHaveLength(2);

    await armLease(admin, schema);
    await expect(store.complete(lease(schema), completion(scene()), NOW)).resolves.toBe(true);
    expect(await assessments(admin, schema)).toHaveLength(2);

    await armLease(admin, schema);
    await expect(
      store.complete(lease(schema), completion({ ...scene(), coveragePercent: 55 }), NOW),
    ).rejects.toThrow(/conflicts with immutable persisted provenance/u);

    const persisted = await assessments(admin, schema);
    expect(persisted).toHaveLength(2);
    expect(
      persisted.find((assessment) => assessment.coverage_method === CDSE_COVERAGE_METHOD),
    ).toEqual(
      expect.objectContaining({
        coverage_status: SatelliteCoverageStatus.PARTIAL,
        coverage_percent: '50.00',
        coverage_sample_count: 256,
        quality_status: EnvironmentQualityStatus.PROVISIONAL,
      }),
    );

    const normalizedNewScene = {
      ...scene(NEW_BINARY_SCENE_ID),
      cloudCoverPercent: 12.345,
      coveragePercent: 50.004,
    };
    await armLease(admin, schema);
    await expect(store.complete(lease(schema), completion(normalizedNewScene), NOW)).resolves.toBe(
      true,
    );
    expect(await assessments(admin, schema, NEW_BINARY_SCENE_ID)).toEqual([
      expect.objectContaining({
        coverage_method: CDSE_COVERAGE_METHOD,
        coverage_status: SatelliteCoverageStatus.PARTIAL,
        coverage_percent: '50.00',
        coverage_sample_count: 256,
        quality_status: EnvironmentQualityStatus.PROVISIONAL,
      }),
    ]);

    await armLease(admin, schema);
    await expect(
      store.complete(
        lease(schema),
        completion({
          ...normalizedNewScene,
          fetchedAt: new Date(NOW.getTime() + 60_000),
        }),
        NOW,
      ),
    ).resolves.toBe(true);
    expect(await assessments(admin, schema, NEW_BINARY_SCENE_ID)).toHaveLength(1);
    await runMigrationUp(admin, schema);
    expect(await assessments(admin, schema, NEW_BINARY_SCENE_ID)).toHaveLength(1);

    await armLease(admin, schema);
    await expect(
      store.complete(
        lease(schema),
        completion({ ...scene(), productId: 'DIVERGENT_RAW_PRODUCT' }),
        NOW,
      ),
    ).rejects.toThrow(/conflicts with immutable persisted acquisition facts/u);

    await expect(runMigrationDown(admin, schema)).rejects.toThrow(
      /Refusing to drop persisted versioned satellite coverage assessments/u,
    );
    expect(await assessments(admin, schema)).toHaveLength(2);
  });

  function requireAdmin(): DataSource {
    if (!harness) {
      throw new Error('Postgres harness is unavailable');
    }
    return harness.dataSource;
  }
});

function scene(sceneId: string = SCENE_ID): CanonicalSatelliteSceneInsert {
  return {
    tenantId: TENANT_ID,
    siteId: SITE_ID,
    sceneId,
    collection: CDSE_SENTINEL_2_COLLECTION,
    provider: EnvironmentProvider.CDSE_SENTINEL_2,
    productId: sceneId,
    datasetId: CDSE_SENTINEL_2_COLLECTION,
    acquiredAt: ACQUIRED_AT,
    cloudCoverPercent: 30,
    coveragePercent: 50,
    coverageStatus: SatelliteCoverageStatus.PARTIAL,
    coverageMethod: CDSE_COVERAGE_METHOD,
    coverageSampleCount: 256,
    qualityStatus: EnvironmentQualityStatus.PROVISIONAL,
    monitoringLocationRevision: 1,
    fetchedAt: NOW,
  };
}

function lease(schema: string): EnvironmentSyncLease {
  return {
    schema,
    tenantId: TENANT_ID,
    siteId: SITE_ID,
    provider: EnvironmentProvider.CDSE_SENTINEL_2,
    token: LEASE_TOKEN,
    monitoringLocationRevision: 1,
    latitude: 60,
    longitude: 5,
    altitudeM: null,
    monitoringRadiusM: 2_000,
    monitoringArea: null,
    cursor: null,
    consecutiveFailures: 0,
  };
}

function completion(sceneRow: CanonicalSatelliteSceneInsert): EnvironmentSyncCompletion {
  return {
    status: EnvironmentSyncStatus.READY,
    nextRunAt: new Date(NOW.getTime() + 60_000),
    errorCode: null,
    cursor: SCENE_ID,
    successfulProviderResponse: true,
    coverage: [
      {
        scopeKind: EnvironmentSyncScopeKind.PROVIDER_RUN,
        scopeKey: 'CDSE:SENTINEL_2_L2A',
        metric: null,
        validFrom: ACQUIRED_AT,
        validTo: NOW,
        outcome: EnvironmentSyncScopeOutcome.AVAILABLE,
        errorCode: null,
        observationCount: 1,
      },
    ],
    weather: [],
    marine: [],
    scenes: [sceneRow],
  };
}

async function armLease(admin: DataSource, schema: string): Promise<void> {
  await admin.query(
    `INSERT INTO "${schema}".site_environment_sync_state (
       tenant_id, site_id, provider, status, next_run_at, lease_token,
       lease_expires_at, monitoring_location_revision
     ) VALUES ($1, $2, 'CDSE_SENTINEL_2', 'RUNNING', $3, $4, $5, 1)
     ON CONFLICT (tenant_id, site_id, provider, monitoring_location_revision)
     DO UPDATE SET status = 'RUNNING', lease_token = EXCLUDED.lease_token,
                   lease_expires_at = EXCLUDED.lease_expires_at`,
    [TENANT_ID, SITE_ID, NOW, LEASE_TOKEN, new Date(NOW.getTime() + 60_000)],
  );
}

interface CoverageDatabaseRow {
  coverage_method: string;
  coverage_status: string;
  coverage_percent: string | null;
  coverage_sample_count: number | null;
  quality_status: string;
}

async function assessments(
  admin: DataSource,
  schema: string,
  sceneId: string = SCENE_ID,
): Promise<CoverageDatabaseRow[]> {
  return admin.query(
    `SELECT coverage_method, coverage_status, coverage_percent,
            coverage_sample_count, quality_status
       FROM "${schema}".satellite_scene_coverage_assessments
      WHERE tenant_id = $1 AND site_id = $2 AND scene_id = $3
      ORDER BY coverage_method`,
    [TENANT_ID, SITE_ID, sceneId],
  );
}

async function runMigrationUp(admin: DataSource, schema: string): Promise<void> {
  const queryRunner = admin.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();
  const previousDdlAuthority = process.env['DB_MIGRATE_DDL_AUTHORITY'];
  process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
  try {
    await queryRunner.query(`SET LOCAL search_path TO "${schema}", public`);
    await new AddSatelliteCoverageProvenance1808000000000().up(queryRunner);
    await queryRunner.commitTransaction();
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    if (previousDdlAuthority === undefined) {
      Reflect.deleteProperty(process.env, 'DB_MIGRATE_DDL_AUTHORITY');
    } else {
      process.env['DB_MIGRATE_DDL_AUTHORITY'] = previousDdlAuthority;
    }
    await queryRunner.release();
  }
}

async function runMigrationDown(admin: DataSource, schema: string): Promise<void> {
  const queryRunner = admin.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();
  try {
    await queryRunner.query(`SET LOCAL search_path TO "${schema}", public`);
    await new AddSatelliteCoverageProvenance1808000000000().down(queryRunner);
    await queryRunner.commitTransaction();
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    await queryRunner.release();
  }
}

async function insertOldReplicaScene(admin: DataSource, schema: string): Promise<void> {
  const queryRunner = admin.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();
  try {
    await queryRunner.query(`SET LOCAL search_path TO "${schema}", public`);
    await queryRunner.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_ID]);
    await queryRunner.query(`SELECT set_config('app.bypass_rls', 'off', true)`);
    await queryRunner.query(
      `INSERT INTO satellite_scene_observations (
         tenant_id, site_id, scene_id, collection, provider, product_id,
         dataset_id, acquired_at, cloud_cover_percent, coverage_percent,
         quality_status, monitoring_location_revision, fetched_at
       ) VALUES ($1, $2, $3, $4, 'CDSE_SENTINEL_2', $3, $4, $5, 30, 75,
                 'PROVISIONAL', 1, $6)`,
      [TENANT_ID, SITE_ID, ROLLING_SCENE_ID, CDSE_SENTINEL_2_COLLECTION, ACQUIRED_AT, NOW],
    );
    await queryRunner.commitTransaction();
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    await queryRunner.release();
  }
}

async function createRawEnvironmentTables(admin: DataSource, schema: string): Promise<void> {
  await admin.query(`
    CREATE OR REPLACE FUNCTION "${schema}"."reject_canonical_environment_observation_update"()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'canonical environment observations are append-only';
    END;
    $$ LANGUAGE plpgsql;

    CREATE TABLE "${schema}".sites (
      id uuid NOT NULL,
      "tenantId" uuid NOT NULL,
      "type" varchar(40) NOT NULL,
      "isActive" boolean NOT NULL,
      "isDeleted" boolean NOT NULL,
      location jsonb NOT NULL,
      "monitoringLocationRevision" integer NOT NULL,
      "monitoringRadiusM" integer NOT NULL,
      "monitoringArea" jsonb,
      PRIMARY KEY (id),
      UNIQUE ("tenantId", id)
    );

    CREATE TABLE "${schema}".satellite_scene_observations (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id uuid NOT NULL,
      site_id uuid NOT NULL,
      scene_id varchar(512) NOT NULL,
      collection varchar(100) NOT NULL,
      provider varchar(40) NOT NULL DEFAULT 'CDSE_SENTINEL_2',
      product_id varchar(512) NOT NULL,
      dataset_id varchar(200) NOT NULL,
      acquired_at timestamptz NOT NULL,
      cloud_cover_percent numeric(5,2),
      coverage_percent numeric(5,2),
      quality_status varchar(32) NOT NULL,
      monitoring_location_revision integer NOT NULL,
      fetched_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, site_id, scene_id, monitoring_location_revision),
      FOREIGN KEY (tenant_id, site_id)
        REFERENCES "${schema}".sites("tenantId", id) ON DELETE CASCADE
    );

    CREATE TABLE "${schema}".site_environment_sync_state (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id uuid NOT NULL,
      site_id uuid NOT NULL,
      provider varchar(40) NOT NULL,
      status varchar(40) NOT NULL,
      cursor varchar(2048),
      last_attempt_at timestamptz,
      last_success_at timestamptz,
      next_run_at timestamptz,
      error_code varchar(100),
      consecutive_failures integer NOT NULL DEFAULT 0,
      expected_scope_count integer NOT NULL DEFAULT 0,
      successful_scope_count integer NOT NULL DEFAULT 0,
      failed_scope_count integer NOT NULL DEFAULT 0,
      no_data_scope_count integer NOT NULL DEFAULT 0,
      out_of_coverage_scope_count integer NOT NULL DEFAULT 0,
      lease_token uuid,
      lease_expires_at timestamptz,
      monitoring_location_revision integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, site_id, provider, monitoring_location_revision)
    );

    CREATE TABLE "${schema}".environment_metric_sync_outcomes (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id uuid NOT NULL,
      site_id uuid NOT NULL,
      provider varchar(40) NOT NULL,
      metric varchar(50),
      scope_kind varchar(40) NOT NULL,
      scope_key varchar(240) NOT NULL,
      valid_from timestamptz,
      valid_to timestamptz,
      outcome varchar(40) NOT NULL,
      error_code varchar(100),
      observation_count integer NOT NULL,
      monitoring_location_revision integer NOT NULL,
      completed_at timestamptz NOT NULL
    );
  `);
}
