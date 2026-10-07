import { randomBytes } from 'node:crypto';

import {
  applyTenantRlsToSchema,
  CONTINUOUS_AGGREGATE_OWNER_READ_POLICY_NAME,
  getTenantSchemaName,
  runInTenantTransaction,
  SENSOR_CONTINUOUS_AGGREGATE_STATEMENTS,
  TenantContextError,
} from '@aquaculture/backend-common/database';
import { DataSource } from 'typeorm';

import {
  bootSensorRlsHarness,
  type SensorRlsHarness,
} from '../../__tests__/support/sensor-rls-postgres.harness';
import { SensorDataChannel } from '../../database/entities/sensor-data-channel.entity';
import { SensorMetric, SensorMetricInput } from '../../database/entities/sensor-metric.entity';
import { SensorProtocol } from '../../database/entities/sensor-protocol.entity';
import { SensorTypeDefinition } from '../../database/entities/sensor-type-definition.entity';
import { Sensor } from '../../database/entities/sensor.entity';
import { SensorMetricWriterService } from '../sensor-metric-writer.service';

/**
 * The single sensor_metrics writer under FORCE RLS, on the production
 * TimescaleDB image, as a non-owner runtime role.
 *
 * db-migrate applies FORCE RLS to every tenant table that carries tenant_id
 * and is not columnstore-compressed — which is every freshly provisioned
 * tenant's sensor_metrics hypertable (1815 creates it uncompressed). The
 * policy admits a row only when `app.current_tenant` names its tenant. The
 * writer's buffered/immediate paths opened a bare transaction that set no
 * tenant, so a new tenant could not store a single reading; the prod tenant
 * escaped only because legacy compression made the helper skip its table.
 *
 * This spec pins the end result: every write path stores a tenant's rows in
 * that tenant's schema under RLS, a managed write refuses rows of a tenant the
 * transaction is not bound to, and the LOGIN rollup owner still materializes
 * what was written.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AGGREGATE_ROLE = 'sensor_aggregate_owner';
const ENTITIES = [Sensor, SensorDataChannel, SensorMetric, SensorProtocol, SensorTypeDefinition];
/** One sensor + channel per tenant; sensor_metrics references both. */
type TestTenant = typeof TENANT_A | typeof TENANT_B;
const SOURCES: Record<TestTenant, { sensorId: string; channelId: string }> = {
  [TENANT_A]: {
    sensorId: '11111111-1111-4111-8111-111111111111',
    channelId: '33333333-3333-4333-8333-333333333333',
  },
  [TENANT_B]: {
    sensorId: '22222222-2222-4222-8222-222222222222',
    channelId: '44444444-4444-4444-8444-444444444444',
  },
};

const CREATE_METRICS_1MIN = SENSOR_CONTINUOUS_AGGREGATE_STATEMENTS.find(
  (statement) => statement.label === 'create metrics_1min',
)?.sql;
if (CREATE_METRICS_1MIN === undefined) {
  throw new Error('SENSOR_CONTINUOUS_AGGREGATE_STATEMENTS lost the metrics_1min definition');
}

jest.setTimeout(240_000);

function metric(tenantId: TestTenant, minute: number, value: number): SensorMetricInput {
  return {
    time: new Date(Date.UTC(2026, 9, 6, 10, minute, 0)),
    sensorId: SOURCES[tenantId].sensorId,
    channelId: SOURCES[tenantId].channelId,
    tenantId,
    rawValue: value,
    value,
    qualityCode: 192,
    qualityBits: 0,
  };
}

describe('SensorMetricWriterService under FORCE RLS (SENSOR-HIGH-145, SENSOR-HIGH-146)', () => {
  let stage: SensorRlsHarness | undefined;
  let admin: DataSource | undefined;
  let runtime: DataSource | undefined;
  let writer: SensorMetricWriterService | undefined;
  const SCHEMA_A = getTenantSchemaName(TENANT_A);
  const SCHEMA_B = getTenantSchemaName(TENANT_B);

  beforeAll(async () => {
    const aggregatePassword = randomBytes(24).toString('hex');
    let aggregate: DataSource | undefined;
    try {
      stage = await bootSensorRlsHarness({
        name: 'metric_writer',
        tenants: [TENANT_A, TENANT_B],
        entities: ENTITIES,
        beforeRls: async ({ admin: owner, harness, tenantId, schema }) => {
          if (aggregate === undefined) {
            // The production rollup owner: LOGIN (Timescale jobs run as it),
            // and — like every application role — without BYPASSRLS.
            await owner.query(
              `CREATE ROLE ${AGGREGATE_ROLE} LOGIN NOBYPASSRLS PASSWORD '${aggregatePassword}'`,
            );
            aggregate = new DataSource({
              type: 'postgres',
              ...harness.connectionOptions,
              username: AGGREGATE_ROLE,
              password: aggregatePassword,
              name: `writer-rls-aggregate-${randomBytes(4).toString('hex')}`,
              logging: false,
            });
            await aggregate.initialize();
          }
          const { sensorId, channelId } = SOURCES[tenantId as TestTenant];
          await owner.query(
            `INSERT INTO "${schema}".sensors (id, tenant_id, name, serial_number, type, status)
             VALUES ($1, $2, 'Probe', $3, 'temperature', 'active')`,
            [sensorId, tenantId, `RLS-${schema}`],
          );
          await owner.query(
            `INSERT INTO "${schema}".sensor_data_channels
               (id, sensor_id, tenant_id, channel_key, display_label, data_type, unit, "dataPath",
                is_enabled, display_order)
             VALUES ($1, $2, $3, 'temperature', 'temperature', 'number', '°C', 'temperature', true, 1)`,
            [channelId, sensorId, tenantId],
          );
          // 1815 shape: an uncompressed hypertable on `time`.
          await owner.query(
            `SELECT create_hypertable('"${schema}".sensor_metrics', 'time', migrate_data => true)`,
          );
          await owner.query(`GRANT USAGE, CREATE ON SCHEMA "${schema}" TO ${AGGREGATE_ROLE}`);
          await owner.query(`GRANT SELECT ON "${schema}".sensor_metrics TO ${AGGREGATE_ROLE}`);

          // The rollup in the provisioner's order (tenant-schema-provisioner.ts,
          // "rollups are created HERE … before postMigrationHardening"):
          // Timescale refuses a continuous aggregate on a hypertable that
          // already has row security, so it is built from the SSoT definition,
          // by the LOGIN aggregate owner, before RLS is armed.
          await aggregate.query(`SET search_path TO "${schema}", public`);
          await aggregate.query(CREATE_METRICS_1MIN);
          // Tenant B carries the production tenant's legacy shape: a compressed
          // (columnstore) sensor_metrics, which the RLS helper must skip
          // without touching its policies — DDL there would abort every deploy.
          if (schema === SCHEMA_B) {
            await owner.query(
              `ALTER TABLE "${schema}".sensor_metrics SET (timescaledb.compress, timescaledb.compress_segmentby = 'sensor_id')`,
            );
          }
        },
      });
    } finally {
      if (aggregate?.isInitialized) await aggregate.destroy();
    }
    admin = stage.admin;
    runtime = stage.runtime;
    writer = new SensorMetricWriterService(runtime);
  });

  afterAll(async () => {
    await stage?.shutdown();
  });

  async function storedValues(schema: string): Promise<number[]> {
    const rows: Array<{ value: string }> = await admin!.query(
      `SELECT value FROM "${schema}".sensor_metrics ORDER BY time`,
    );
    return rows.map((row) => Number(row.value));
  }

  it('applies FORCE RLS to the uncompressed tenant hypertable (the precondition)', async () => {
    const [row] = await admin!.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE oid = '"${SCHEMA_A}".sensor_metrics'::regclass`,
    );
    expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it('writeImmediate stores each tenant’s rows in its own schema', async () => {
    await writer!.writeImmediate([metric(TENANT_A, 0, 1.5), metric(TENANT_B, 0, 2.5)]);

    expect(await storedValues(SCHEMA_A)).toEqual([1.5]);
    expect(await storedValues(SCHEMA_B)).toEqual([2.5]);
  });

  it('enqueue resolves only after the buffered batch committed under RLS', async () => {
    const outcome = writer!.enqueue(metric(TENANT_A, 1, 3.5));
    await writer!.flush();

    await expect(outcome).resolves.toEqual({ tenantId: TENANT_A, committedRows: 1 });
    expect(await storedValues(SCHEMA_A)).toEqual([1.5, 3.5]);
  });

  it('writeManaged commits inside a transaction bound to the rows’ tenant', async () => {
    await runInTenantTransaction(runtime!, 'sensor', TENANT_A, async (queryRunner) => {
      await writer!.writeManaged([metric(TENANT_A, 2, 4.5)], queryRunner.manager);
    });

    expect(await storedValues(SCHEMA_A)).toEqual([1.5, 3.5, 4.5]);
  });

  it('writeManaged refuses rows of a tenant the transaction is not bound to', async () => {
    await expect(
      runInTenantTransaction(runtime!, 'sensor', TENANT_A, async (queryRunner) => {
        await writer!.writeManaged([metric(TENANT_B, 3, 9.9)], queryRunner.manager);
      }),
    ).rejects.toBeInstanceOf(TenantContextError);

    expect(await storedValues(SCHEMA_B)).toEqual([2.5]);
  });

  it('writeManaged refuses a transaction bound to no tenant', async () => {
    await expect(
      runtime!.transaction(async (manager) => {
        await writer!.writeManaged([metric(TENANT_A, 4, 9.9)], manager);
      }),
    ).rejects.toBeInstanceOf(TenantContextError);

    expect(await storedValues(SCHEMA_A)).toEqual([1.5, 3.5, 4.5]);
  });

  async function ownerPolicy(schema: string): Promise<{ oid: number; roles: string[] } | null> {
    const rows: Array<{ oid: number; roles: string[] }> = await admin!.query(
      `SELECT p.oid::int AS oid, ARRAY(SELECT rolname::text FROM pg_roles WHERE oid = ANY (p.polroles)) AS roles
         FROM pg_policy p
        WHERE p.polrelid = format('%I.sensor_metrics', $1::text)::regclass
          AND p.polname = $2`,
      [schema, CONTINUOUS_AGGREGATE_OWNER_READ_POLICY_NAME],
    );
    return rows[0] ?? null;
  }

  it('arms the rollup owner read policy together with RLS, and re-arming leaves it untouched', async () => {
    const before = await ownerPolicy(SCHEMA_A);
    expect(before?.roles).toEqual([AGGREGATE_ROLE]);

    const previousDdlAuthority = process.env['DB_MIGRATE_DDL_AUTHORITY'];
    process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
    const qr = admin!.createQueryRunner();
    try {
      await applyTenantRlsToSchema(qr, { schemaOverride: SCHEMA_A });
    } finally {
      await qr.release();
      if (previousDdlAuthority === undefined) delete process.env['DB_MIGRATE_DDL_AUTHORITY'];
      else process.env['DB_MIGRATE_DDL_AUTHORITY'] = previousDdlAuthority;
    }

    expect((await ownerPolicy(SCHEMA_A))?.oid).toBe(before?.oid);
  });

  it('skips a compressed (legacy) hypertable: no RLS and no policy DDL on it', async () => {
    const [row] = await admin!.query(
      `SELECT relrowsecurity FROM pg_class WHERE oid = format('%I.sensor_metrics', $1::text)::regclass`,
      [SCHEMA_B],
    );
    expect(row.relrowsecurity).toBe(false);
    expect(await ownerPolicy(SCHEMA_B)).toBeNull();
  });

  it('the LOGIN rollup owner materializes every row written under RLS', async () => {
    // One pinned connection: SET ROLE is session state, and a pooled
    // query could otherwise run the refresh on a different session.
    const session = admin!.createQueryRunner();
    await session.connect();
    try {
      await session.query(`SET ROLE ${AGGREGATE_ROLE}`);
      await session.query(
        `CALL refresh_continuous_aggregate('"${SCHEMA_A}".metrics_1min', NULL, NULL)`,
      );
    } finally {
      await session.query('RESET ROLE');
      await session.release();
    }
    const [row] = await admin!.query(
      `SELECT COALESCE(SUM(sample_count), 0)::int AS samples
         FROM _timescaledb_internal._materialized_hypertable_${await materializationId()}`,
    );

    expect(row.samples).toBe(3);
  });

  async function materializationId(): Promise<number> {
    const [row] = await admin!.query(
      `SELECT h.id FROM timescaledb_information.continuous_aggregates c
         JOIN _timescaledb_catalog.hypertable h
           ON h.schema_name = c.materialization_hypertable_schema
          AND h.table_name = c.materialization_hypertable_name
        WHERE c.view_schema = $1 AND c.view_name = 'metrics_1min'`,
      [SCHEMA_A],
    );
    return row.id;
  }
});
