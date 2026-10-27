import { randomBytes } from 'node:crypto';

import { getTenantSchemaName } from '@aquaculture/backend-common/database';
import {
  armTenantRls,
  publishActiveTenantMappings,
} from '@aquaculture/backend-common/database/testing';
import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { DataSource, type DataSourceOptions, type EntitySchema } from 'typeorm';

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

/** An entity class (or schema) declaring `schema: 'sensor'`. */
export type SourceEntity = EntitySchema | (new () => object);

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
  /**
   * Cross-tenant tables in `sensor` (entities declaring `schema: 'sensor'`, e.g.
   * the device and provisioning-key route directories): created, FORCE RLS
   * armed by the same helper, and given the service's DML grants — the way
   * they stand in production.
   */
  readonly sourceEntities?: readonly SourceEntity[];
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
  /**
   * What db-migrate's tenant schema delete job (deprovision or erasure) leaves
   * behind, in one transaction as that job commits it: the schema dropped with
   * CASCADE and the ledger row out of `active`, so
   * platform.list_active_tenant_schema_mappings() no longer lists the tenant.
   */
  deprovisionTenant(tenantId: string): Promise<void>;
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

    await armTenantRls(admin, { schemaOverride: schema });

    await admin.query(`GRANT USAGE ON SCHEMA "${schema}", sensor, public TO ${runtimeRole}`);
    // The DML set tenant-schema-privileges.ts grants `sensor_service` on every
    // tenant table (DELETE included: tenant erasure deletes through it).
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${runtimeRole}`,
    );
  }

  const sourceEntities = options.sourceEntities ?? [];
  if (sourceEntities.length > 0) {
    const sourceDdl = new DataSource({
      type: 'postgres',
      ...harness.connectionOptions,
      name: `${options.name}-ddl-sensor`,
      entities: [...sourceEntities],
      synchronize: true,
      logging: false,
    });
    await sourceDdl.initialize();
    const sourceTables = sourceDdl.entityMetadatas.map((metadata) => metadata.tableName);
    await sourceDdl.destroy();
    await armTenantRls(admin, { schemaOverride: 'sensor', includeTables: sourceTables });
    for (const table of sourceTables) {
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON sensor."${table}" TO ${runtimeRole}`,
      );
    }
  }

  // The least-privilege mapping production serves through
  // platform.list_active_tenant_schema_mappings().
  const activeTenants = new Set(options.tenants);
  await admin.query('CREATE SCHEMA IF NOT EXISTS platform');
  await publishActiveTenantMappings(admin, [...activeTenants]);
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
    entities: Array.isArray(options.entities)
      ? [...options.entities, ...sourceEntities]
      : [...Object.values(options.entities), ...sourceEntities],
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
    async deprovisionTenant(tenantId: string): Promise<void> {
      activeTenants.delete(tenantId);
      await admin.transaction(async (manager) => {
        await manager.query(`DROP SCHEMA IF EXISTS "${getTenantSchemaName(tenantId)}" CASCADE`);
        await publishActiveTenantMappings(manager, [...activeTenants]);
      });
    },
    async shutdown(): Promise<void> {
      if (runtime.isInitialized) await runtime.destroy();
      await shutdownHarness(harness);
    },
  };
}
