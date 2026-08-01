import { randomBytes } from 'node:crypto';

import { applyTenantRlsToSchema, getTenantSchemaName } from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource } from 'typeorm';

import {
  EnvironmentProvider,
  EnvironmentMetric,
  EnvironmentQualityStatus,
  EnvironmentSemanticClass,
  EnvironmentSyncScopeKind,
  EnvironmentSyncScopeOutcome,
  EnvironmentSyncStatus,
} from '../entities/environment-observation.types';
import { WeatherDataType } from '../entities/weather-observation.entity';
import { ENVIRONMENT_LEASE_DURATION_MS } from './environment-cron.service';
import { EnvironmentSyncStore } from './environment-sync-store.service';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-07-31T04:00:00.000Z');
const OLD_OBSERVATION = new Date('2026-01-10T04:00:00.000Z');
const RUNTIME_ROLE = 'farm_environment_worker_test';

jest.setTimeout(120_000);

describe('EnvironmentSyncStore FORCE-RLS boundary on real Postgres', () => {
  let harness: HarnessContext | undefined;
  let runtime: DataSource | undefined;
  let store: EnvironmentSyncStore;

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    const admin = harness.dataSource;
    const password = randomBytes(24).toString('hex');

    await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await admin.query('CREATE SCHEMA farm');
    await admin.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${password}'`);

    await createTenantEnvironmentSchema(admin, TENANT_A, SITE_A);
    await createTenantEnvironmentSchema(admin, TENANT_B, SITE_B);
    await admin.query(
      `CREATE TABLE farm.weather_observations (
         LIKE "${getTenantSchemaName(TENANT_A)}".weather_observations INCLUDING ALL
       )`,
    );

    runtime = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      username: RUNTIME_ROLE,
      password,
      name: `farm-environment-rls-${randomBytes(4).toString('hex')}`,
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

  it('denies an unscoped worker but claims, completes, and retains inside the tenant GUC', async () => {
    const admin = requireAdmin();
    const schemaA = getTenantSchemaName(TENANT_A);
    const schemaB = getTenantSchemaName(TENANT_B);

    const unscoped: Array<{ count: string }> = await requireRuntime().query(
      `SELECT COUNT(*)::text AS count FROM "${schemaA}".sites`,
    );
    expect(unscoped[0]?.count).toBe('0');

    await store.reconcileSyncStates(schemaA, TENANT_A, NOW);
    const leases = await store.claimDue(
      schemaA,
      TENANT_A,
      NOW,
      NOW,
      4,
      ENVIRONMENT_LEASE_DURATION_MS,
    );
    const lease = leases.find(
      (candidate) => candidate.provider === EnvironmentProvider.MET_LOCATIONFORECAST,
    );
    expect(lease).toBeDefined();
    expect(lease?.tenantId).toBe(TENANT_A);

    await expect(
      store.complete(
        lease!,
        {
          status: EnvironmentSyncStatus.READY,
          nextRunAt: new Date(NOW.getTime() + 60_000),
          errorCode: null,
          cursor: null,
          successfulProviderResponse: true,
          coverage: [
            {
              scopeKind: EnvironmentSyncScopeKind.METRIC_SUMMARY,
              scopeKey: 'MET_LOCATIONFORECAST:AIR_TEMPERATURE',
              metric: EnvironmentMetric.AIR_TEMPERATURE,
              validFrom: OLD_OBSERVATION,
              validTo: OLD_OBSERVATION,
              outcome: EnvironmentSyncScopeOutcome.AVAILABLE,
              errorCode: null,
              observationCount: 1,
            },
          ],
          weather: [
            {
              tenantId: TENANT_A,
              siteId: SITE_A,
              observedAt: OLD_OBSERVATION,
              dataType: WeatherDataType.FORECAST,
              provider: EnvironmentProvider.MET_LOCATIONFORECAST,
              productId: 'locationforecast-2.0',
              datasetId: 'compact',
              sourceRunKey: 'rls-integration-run',
              issuedAt: NOW,
              semanticClass: EnvironmentSemanticClass.FORECAST,
              qualityStatus: EnvironmentQualityStatus.PROVISIONAL,
              stationId: null,
              stationDistanceKm: null,
              horizontalResolutionM: null,
              monitoringLocationRevision: 1,
              temperature: 7.5,
              windSpeed: 3.2,
              windDirection: 180,
              windGusts: 4.1,
              precipitation: 0,
              cloudCover: 25,
              pressureMsl: 1_010,
              relativeHumidity: 80,
              fetchedAt: NOW,
            },
          ],
          marine: [],
          scenes: [],
        },
        NOW,
      ),
    ).resolves.toBe(true);

    expect(await countRows(admin, schemaA, 'weather_observations')).toBe(1);
    expect(await countRows(admin, schemaB, 'weather_observations')).toBe(0);
    expect(await countRows(admin, 'farm', 'weather_observations')).toBe(0);

    await expect(
      store.retainSchema(schemaA, TENANT_A, new Date('2026-02-01T00:00:00.000Z')),
    ).resolves.toMatchObject({ weatherDeleted: 1 });
    expect(await countRows(admin, schemaA, 'weather_observations')).toBe(0);
    expect(await countRows(admin, schemaB, 'weather_observations')).toBe(0);
  });

  it('rejects a schema and tenant identity mismatch before database work', async () => {
    await expect(
      store.claimDue(
        getTenantSchemaName(TENANT_A),
        TENANT_B,
        NOW,
        NOW,
        1,
        ENVIRONMENT_LEASE_DURATION_MS,
      ),
    ).rejects.toThrow(/identity does not match/u);
  });

  function requireAdmin(): DataSource {
    if (!harness) {
      throw new Error('Postgres harness is unavailable');
    }
    return harness.dataSource;
  }

  function requireRuntime(): DataSource {
    if (!runtime) {
      throw new Error('Runtime DataSource is unavailable');
    }
    return runtime;
  }
});

async function createTenantEnvironmentSchema(
  admin: DataSource,
  tenantId: string,
  siteId: string,
): Promise<void> {
  const schema = getTenantSchemaName(tenantId);
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`
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
      completed_at timestamptz NOT NULL,
      FOREIGN KEY (tenant_id, site_id, provider, monitoring_location_revision)
        REFERENCES "${schema}".site_environment_sync_state (
          tenant_id, site_id, provider, monitoring_location_revision
        ) ON DELETE CASCADE
    );

    CREATE TABLE "${schema}".weather_observations (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id uuid NOT NULL,
      site_id uuid NOT NULL,
      observed_at timestamptz NOT NULL,
      data_type varchar(40) NOT NULL,
      provider varchar(40),
      product_id varchar(160),
      dataset_id varchar(200),
      source_run_key varchar(200),
      issued_at timestamptz,
      semantic_class varchar(40),
      quality_status varchar(40),
      station_id varchar(100),
      station_distance_km numeric,
      horizontal_resolution_m numeric,
      monitoring_location_revision integer NOT NULL,
      temperature numeric,
      wind_speed numeric,
      wind_direction numeric,
      wind_gusts numeric,
      precipitation numeric,
      cloud_cover numeric,
      pressure_msl numeric,
      relative_humidity numeric,
      fetched_at timestamptz NOT NULL
    );
    CREATE UNIQUE INDEX weather_provider_identity
      ON "${schema}".weather_observations (
        tenant_id, site_id, provider, dataset_id, source_run_key,
        observed_at, data_type, monitoring_location_revision
      ) WHERE provider IS NOT NULL;

    CREATE TABLE "${schema}".marine_observations (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id uuid NOT NULL,
      observed_at timestamptz NOT NULL,
      provider varchar(40)
    );

    CREATE TABLE "${schema}".satellite_scene_observations (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id uuid NOT NULL,
      acquired_at timestamptz NOT NULL
    );
  `);

  const queryRunner = admin.createQueryRunner();
  await queryRunner.connect();
  const previousDdlAuthority = process.env['DB_MIGRATE_DDL_AUTHORITY'];
  process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
  try {
    await applyTenantRlsToSchema(queryRunner, { schemaOverride: schema });
  } finally {
    if (previousDdlAuthority === undefined) {
      Reflect.deleteProperty(process.env, 'DB_MIGRATE_DDL_AUTHORITY');
    } else {
      process.env['DB_MIGRATE_DDL_AUTHORITY'] = previousDdlAuthority;
    }
    await queryRunner.release();
  }

  await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${RUNTIME_ROLE}`);
  await admin.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${RUNTIME_ROLE}`,
  );
  await admin.query(
    `INSERT INTO "${schema}".sites (
       id, "tenantId", "type", "isActive", "isDeleted", location,
       "monitoringLocationRevision", "monitoringRadiusM", "monitoringArea"
     ) VALUES ($1, $2, 'sea_cage', TRUE, FALSE, $3::jsonb, 1, 2000, NULL)`,
    [siteId, tenantId, JSON.stringify({ latitude: 60, longitude: 5 })],
  );
}

async function countRows(admin: DataSource, schema: string, table: string): Promise<number> {
  if (!/^[a-z0-9_]+$/u.test(schema) || !/^[a-z0-9_]+$/u.test(table)) {
    throw new Error('Unsafe integration-test relation identifier');
  }
  const rows: Array<{ count: string }> = await admin.query(
    `SELECT COUNT(*)::text AS count FROM "${schema}"."${table}"`,
  );
  return Number(rows[0]?.count ?? '0');
}
