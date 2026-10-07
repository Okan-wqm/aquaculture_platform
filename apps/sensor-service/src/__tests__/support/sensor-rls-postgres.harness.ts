import { randomBytes } from 'node:crypto';

import { applyTenantRlsToSchema, getTenantSchemaName } from '@aquaculture/backend-common/database';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, type DataSourceOptions } from 'typeorm';

/**
 * One real-Postgres stage for sensor-service code that must work under the
 * production row security: the pinned TimescaleDB image, tenant schemas built
 * from the entities the runtime maps, FORCE RLS armed by the platform helper
 * (as db-migrate does), a non-owner runtime role, and the platform
 * tenant↔schema mapping the cross-tenant workers read.
 *
 * WHY one harness: each `*.rls.postgres.spec.ts` used to re-create this stage
 * by hand, and every copy was a place for the stage to drift from the
 * provisioner (role grants, RLS order, the mapping function).
 */

export interface SensorRlsTenantContext {
  readonly admin: DataSource;
  /** Owner connection pinned to this tenant schema, with the entities mapped. */
  readonly ddl: DataSource;
  readonly harness: HarnessContext;
  readonly tenantId: string;
  readonly schema: string;
}

export interface SensorRlsHarnessOptions {
  /** Distinguishes connection names when several specs run in one worker. */
  readonly name: string;
  readonly tenants: readonly string[];
  /** The entities the runtime maps; tenant tables are synchronized from them. */
  readonly entities: NonNullable<DataSourceOptions['entities']>;
  /**
   * Runs per tenant after its tables exist and BEFORE RLS is armed — the
   * provisioner's window for seeding, hypertables and rollups (TimescaleDB
   * refuses a continuous aggregate over a table with row security).
   */
  readonly beforeRls?: (tenant: SensorRlsTenantContext) => Promise<void>;
}

export interface SensorRlsHarness {
  /** Superuser connection: seeding and assertions, never the code under test. */
  readonly admin: DataSource;
  /** Non-owner runtime connection, subject to FORCE RLS like sensor_service. */
  readonly runtime: DataSource;
  readonly runtimeRole: string;
  readonly runtimePassword: string;
  readonly harness: HarnessContext;
  schemaOf(tenantId: string): string;
  shutdown(): Promise<void>;
}

export async function bootSensorRlsHarness(
  options: SensorRlsHarnessOptions,
): Promise<SensorRlsHarness> {
  const harness = await bootPostgresContainer({ startTimeoutMs: 180_000 });
  const admin = harness.dataSource;
  const runtimeRole = `sensor_rls_${options.name.replace(/[^a-z0-9_]/g, '_')}`;
  const runtimePassword = randomBytes(24).toString('hex');

  await admin.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
  await admin.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await admin.query('CREATE SCHEMA IF NOT EXISTS sensor');
  await admin.query(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}'`);

  for (const tenantId of options.tenants) {
    const schema = getTenantSchemaName(tenantId);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const ddl = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      name: `${options.name}-ddl-${schema}`,
      schema,
      entities: options.entities,
      synchronize: true,
      logging: false,
    });
    await ddl.initialize();
    try {
      await options.beforeRls?.({ admin, ddl, harness, tenantId, schema });
    } finally {
      await ddl.destroy();
    }

    const previousDdlAuthority = process.env['DB_MIGRATE_DDL_AUTHORITY'];
    process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';
    const qr = admin.createQueryRunner();
    try {
      await applyTenantRlsToSchema(qr, { schemaOverride: schema });
    } finally {
      await qr.release();
      if (previousDdlAuthority === undefined) delete process.env['DB_MIGRATE_DDL_AUTHORITY'];
      else process.env['DB_MIGRATE_DDL_AUTHORITY'] = previousDdlAuthority;
    }

    await admin.query(`GRANT USAGE ON SCHEMA "${schema}", sensor, public TO ${runtimeRole}`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "${schema}" TO ${runtimeRole}`,
    );
  }

  // The least-privilege mapping production serves through
  // platform.list_active_tenant_schema_mappings().
  const mappings = options.tenants
    .map((tenantId) => `('${getTenantSchemaName(tenantId)}', '${tenantId}'::uuid, true, true)`)
    .join(',\n          ');
  await admin.query('CREATE SCHEMA IF NOT EXISTS platform');
  await admin.query(`
    CREATE OR REPLACE FUNCTION platform.list_active_tenant_schema_mappings()
    RETURNS TABLE (schema_name text, tenant_id uuid, schema_exists boolean, committed_proof boolean)
    LANGUAGE sql STABLE AS $fn$
      SELECT * FROM (VALUES
          ${mappings}
      ) AS t(schema_name, tenant_id, schema_exists, committed_proof)
    $fn$`);
  await admin.query(`GRANT USAGE ON SCHEMA platform TO ${runtimeRole}`);
  await admin.query(
    `GRANT EXECUTE ON FUNCTION platform.list_active_tenant_schema_mappings() TO ${runtimeRole}`,
  );

  const runtime = new DataSource({
    type: 'postgres',
    ...harness.connectionOptions,
    username: runtimeRole,
    password: runtimePassword,
    name: `${options.name}-runtime-${randomBytes(4).toString('hex')}`,
    entities: options.entities,
    synchronize: false,
    logging: false,
  });
  await runtime.initialize();

  return {
    admin,
    runtime,
    runtimeRole,
    runtimePassword,
    harness,
    schemaOf: getTenantSchemaName,
    async shutdown(): Promise<void> {
      if (runtime.isInitialized) await runtime.destroy();
      await shutdownHarness(harness);
    },
  };
}
