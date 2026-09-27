import { randomBytes } from 'node:crypto';

import { applyTenantRlsToSchema, getTenantSchemaName } from '@aquaculture/backend-common/database';
import { RedisService } from '@aquaculture/backend-common/redis';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource } from 'typeorm';

import { SensorTopicCacheService } from '../sensor-topic-cache.service';

/**
 * SENSOR-HIGH-119 on real Postgres: tenant schemas carry FORCE RLS and pooled
 * connections default to deny (app.bypass_rls='off' with no tenant context),
 * so the topic cache's cross-schema SELECT saw zero rows — MQTT messages could
 * not resolve sensors even with registration and channels correct.
 *
 * The fix reads each active tenant inside runInTenantRead (tenant GUC pinned
 * per transaction). This spec reproduces the exact pre-fix environment — a
 * non-owner runtime role, FORCE RLS on both tenant schemas, no bypass — and
 * asserts resolution works and stays tenant-isolated.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RUNTIME_ROLE = 'sensor_topic_cache_rls_test';

jest.setTimeout(180_000);

describe('SensorTopicCacheService under FORCE RLS (SENSOR-HIGH-119)', () => {
  let harness: HarnessContext | undefined;
  let admin: DataSource | undefined;
  let runtime: DataSource | undefined;
  let service: SensorTopicCacheService;
  let setJson: jest.Mock;
  let getJson: jest.Mock;
  const schemas: string[] = [];
  // Non-null views over the two fixture schemas (assigned in beforeAll).
  let SCHEMA_A = '';
  let SCHEMA_B = '';

  beforeAll(async () => {
    harness = await bootPostgresContainer({ startTimeoutMs: 120_000 });
    admin = harness.dataSource;
    const password = randomBytes(24).toString('hex');

    await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await admin.query(`CREATE SCHEMA sensor`);
    await admin.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD '${password}'`);

    for (const tenantId of [TENANT_A, TENANT_B]) {
      const schema = getTenantSchemaName(tenantId);
      schemas.push(schema);
      if (tenantId === TENANT_A) SCHEMA_A = schema;
      else SCHEMA_B = schema;
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.query(`
        CREATE TABLE "${schema}".sensors (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          name varchar(200) NOT NULL,
          type varchar(50) NOT NULL,
          protocol_configuration jsonb,
          is_parent_device boolean NOT NULL DEFAULT false,
          metadata jsonb,
          created_at timestamptz NOT NULL DEFAULT now()
        )`);
      await admin.query(`GRANT USAGE ON SCHEMA "${schema}", sensor, public TO ${RUNTIME_ROLE}`);
      await admin.query(`GRANT SELECT ON "${schema}".sensors TO ${RUNTIME_ROLE}`);

      const previousDdlAuthority = process.env['DB_MIGRATE_DDL_AUTHORITY'];
      process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
      try {
        const qr = admin.createQueryRunner();
        await applyTenantRlsToSchema(qr, { schemaOverride: schema });
        await qr.release();
      } finally {
        if (previousDdlAuthority === undefined) delete process.env['DB_MIGRATE_DDL_AUTHORITY'];
        else process.env['DB_MIGRATE_DDL_AUTHORITY'] = previousDdlAuthority;
      }

      // Seed as admin (table owner path): one sensor per tenant on distinct topics.
      await admin.query(
        `INSERT INTO "${schema}".sensors (tenant_id, name, type, protocol_configuration, is_parent_device)
         VALUES ($1, $2, 'temperature', $3::jsonb, true)`,
        [
          tenantId,
          `Sonde ${schema.slice(0, 12)}`,
          JSON.stringify({ topic: `sensors/${schema.slice(0, 8)}/sonde` }),
        ],
      );
    }

    // Least-privilege platform mapping stub — the same contract
    // platform.list_active_tenant_schema_mappings() serves in production.
    await admin.query(`CREATE SCHEMA IF NOT EXISTS platform`);
    await admin.query(`
      CREATE OR REPLACE FUNCTION platform.list_active_tenant_schema_mappings()
      RETURNS TABLE (schema_name text, tenant_id uuid, schema_exists boolean, committed_proof boolean)
      LANGUAGE sql STABLE AS $fn$
        SELECT * FROM (VALUES
          ('${SCHEMA_A}', '${TENANT_A}'::uuid, true, true),
          ('${SCHEMA_B}', '${TENANT_B}'::uuid, true, true)
        ) AS t(schema_name, tenant_id, schema_exists, committed_proof)
      $fn$`);
    await admin.query(`GRANT USAGE ON SCHEMA platform TO ${RUNTIME_ROLE}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform.list_active_tenant_schema_mappings() TO ${RUNTIME_ROLE}`,
    );

    runtime = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      username: RUNTIME_ROLE,
      password,
      name: `sensor-topic-rls-${randomBytes(4).toString('hex')}`,
      synchronize: false,
      logging: false,
    });
    await runtime.initialize();

    getJson = jest.fn().mockResolvedValue(null);
    setJson = jest.fn().mockResolvedValue(undefined);
    const redisService = {
      getJson,
      setJson,
      del: jest.fn().mockResolvedValue(undefined),
      keys: jest.fn().mockResolvedValue([]),
    } as Partial<RedisService> as RedisService;

    service = new SensorTopicCacheService(redisService, runtime);
  });

  afterAll(async () => {
    if (runtime?.isInitialized) await runtime.destroy();
    if (harness) await shutdownHarness(harness);
  });

  it('resolves a topic to its sensor under FORCE RLS with no bypass (was: zero rows)', async () => {
    const sensor = await service.getSensorByTopic(`sensors/${SCHEMA_A.slice(0, 8)}/sonde`);

    expect(sensor).not.toBeNull();
    expect(sensor?.tenantId).toBe(TENANT_A);
    expect(sensor?.schemaName).toBe(SCHEMA_A);
    expect(sensor?.protocolConfiguration).toMatchObject({
      topic: `sensors/${SCHEMA_A.slice(0, 8)}/sonde`,
    });
  });

  it('resolves each tenant independently (no cross-tenant bleed)', async () => {
    const sensorB = await service.getSensorByTopic(`sensors/${SCHEMA_B.slice(0, 8)}/sonde`);

    expect(sensorB?.tenantId).toBe(TENANT_B);
    expect(sensorB?.schemaName).toBe(SCHEMA_B);
  });

  it('warm-up caches every active tenant sensor (regression: "0 sensors")', async () => {
    await service.onModuleInit();

    // Earlier resolution tests also cached their hits — assert DISTINCT topics.
    const distinctTopics = new Set(
      setJson.mock.calls
        .map(([key]) => (typeof key === 'string' && key.startsWith('sensor:tenant:') ? key : null))
        .filter((key: string | null): key is string => key !== null),
    );
    expect(distinctTopics.size).toBe(2);
  });

  it('the RLS policy is genuinely enforced for the runtime role (regression guard)', async () => {
    // With tenant A's GUC, tenant A's rows are visible and tenant B's are not —
    // proves the policy is FORCED for this role, i.e. the fix works WITH the
    // isolation rather than around it.
    const qr = runtime!.createQueryRunner();
    try {
      await qr.startTransaction();
      await qr.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_A]);
      const visibleA = await qr.query(`SELECT count(*)::int AS n FROM "${SCHEMA_A}".sensors`);
      const visibleB = await qr.query(`SELECT count(*)::int AS n FROM "${SCHEMA_B}".sensors`);
      await qr.commitTransaction();

      expect(visibleA[0].n).toBe(1);
      expect(visibleB[0].n).toBe(0);
    } finally {
      await qr.release();
    }
  });
});
