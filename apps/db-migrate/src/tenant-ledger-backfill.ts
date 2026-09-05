import {
  grantTenantMigrationLedgerReadAccess,
  MIGRATION_LEDGER_TABLE,
  MODULE_SCHEMAS,
  queryRowsNormalized,
  tenantMigrationLedgerTable,
  TENANT_SCHEMA_NAME_RE,
  type TenantMigrationLedgerQueryExecutor,
} from '@aquaculture/backend-common/database';

/**
 * Tenant migration-ledger backfill (INFRA-CRITICAL-149).
 *
 * A deploy discovers tenant schemas by NAME (`listTenantSchemas` matches the
 * `tenant_<16 hex>` namespace pattern and consults no evidence table). For each
 * tenant-aware source schema it then makes sure the tenant carries a
 * `migrations_<src>` ledger and, when that ledger is EMPTY, seeds it with the
 * whole source history so the fan-out only applies the delta.
 *
 * An empty ledger is not evidence of a fully migrated schema. It is exactly the
 * shape a failed PROVISION leaves behind — `CREATE SCHEMA` is autocommit, the
 * per-migration rollback undoes both the DDL and the ledger row, and the live
 * gate produced four such schemas on its way to green (farm + sensor present,
 * the other five services absent). Stamping such a schema seals it: the
 * fan-out sees nothing pending, RECONCILE refuses it as empty, and where
 * TimescaleDB is installed the deploy's REVOKE on the missing `sensor_metrics`
 * fails every subsequent deploy.
 *
 * So the ledger is stamped only when the schema can back it: per source
 * schema, every per-tenant table `MODULE_SCHEMAS` registers for that source
 * (`tables` + `referenceDataTables`, the same set the provisioning gate
 * asserts) must exist in the tenant schema. Otherwise the ledger is left
 * empty and the fan-out that runs next sees every migration pending and
 * builds the missing schema in the same deploy — a bricked tenant becomes a
 * self-healing one, the phantoms already in production included.
 *
 * Extracted from main.ts so the decision runs against a real database in a
 * unit-shaped test (the executor is a QueryRunner or anything with `.query`),
 * following tenant-sensor-continuous-aggregate-authority.ts.
 */

export type TenantLedgerBackfillOutcome =
  | {
      readonly tenantSchema: string;
      readonly tenantLedger: string;
      readonly serviceRole: string;
      readonly skipped: false;
      readonly copiedRows: number;
    }
  | {
      readonly tenantSchema: string;
      readonly tenantLedger: string;
      readonly serviceRole: string;
      readonly skipped: true;
      readonly copiedRows: 0;
      readonly reason: 'ledger-populated';
    }
  | {
      readonly tenantSchema: string;
      readonly tenantLedger: string;
      readonly serviceRole: string;
      readonly skipped: true;
      readonly copiedRows: 0;
      readonly reason: 'missing-per-tenant-tables';
      readonly missingTables: readonly string[];
    };

/**
 * The per-tenant table set a fully provisioned tenant carries for one source
 * schema. Read from `MODULE_SCHEMAS`, never restated: the entity layer, the
 * provisioning gate and this guard must agree on one registry.
 */
export function perTenantTablesFor(sourceSchema: string): readonly string[] {
  const entry = MODULE_SCHEMAS.find((module) => module.sourceSchema === sourceSchema);
  if (entry === undefined) {
    throw new Error(
      `[db-migrate] MODULE_SCHEMAS has no entry for source schema "${sourceSchema}" — ` +
        'a tenant ledger cannot be backfilled for a schema the registry does not describe',
    );
  }
  // `species` is listed both as a table and as reference data; a table set
  // has no duplicates.
  return [...new Set([...entry.tables, ...(entry.referenceDataTables ?? [])])];
}

export async function findMissingPerTenantTables(
  executor: TenantMigrationLedgerQueryExecutor,
  sourceSchema: string,
  tenantSchema: string,
): Promise<string[]> {
  const expected = perTenantTablesFor(sourceSchema);
  const rows = queryRowsNormalized<{ table_name: string }>(
    await executor.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = $1
          AND table_type = 'BASE TABLE'`,
      [tenantSchema],
    ),
  );
  const present = new Set(rows.map((row) => row.table_name));
  return expected.filter((table) => !present.has(table)).sort();
}

async function ledgerRowCount(
  executor: TenantMigrationLedgerQueryExecutor,
  schema: string,
  table: string,
): Promise<number> {
  const rows = queryRowsNormalized<{ count: string }>(
    await executor.query(`SELECT COUNT(*)::text AS count FROM "${schema}"."${table}"`),
  );
  return Number.parseInt(rows[0]?.count ?? '0', 10);
}

/**
 * Ensure one tenant's `migrations_<source>` ledger exists and is readable by
 * the owning service, and seed it from the source ledger ONLY when the tenant
 * schema demonstrably carries the source's per-tenant tables.
 *
 * @param sourceRows row count of the source ledger; the caller has already
 *   established that it is non-zero.
 */
export async function backfillTenantLedger(
  executor: TenantMigrationLedgerQueryExecutor,
  args: { sourceSchema: string; tenantSchema: string; sourceRows: number },
): Promise<TenantLedgerBackfillOutcome> {
  const { sourceSchema, tenantSchema, sourceRows } = args;
  if (!TENANT_SCHEMA_NAME_RE.test(tenantSchema)) {
    throw new Error(
      `[db-migrate] Refusing unsafe tenant schema during ledger backfill: ${tenantSchema}`,
    );
  }
  const tenantLedger = tenantMigrationLedgerTable(sourceSchema);

  await executor.query(`
    CREATE TABLE IF NOT EXISTS "${tenantSchema}"."${tenantLedger}" (
      "id" SERIAL PRIMARY KEY,
      "timestamp" bigint NOT NULL,
      "name" varchar NOT NULL
    )
  `);
  const grant = await grantTenantMigrationLedgerReadAccess(executor, {
    tenantSchema,
    sourceSchema,
  });
  const base = { tenantSchema, tenantLedger, serviceRole: grant.serviceRole };

  const existingRows = await ledgerRowCount(executor, tenantSchema, tenantLedger);
  if (existingRows > 0) {
    return { ...base, skipped: true, copiedRows: 0, reason: 'ledger-populated' };
  }

  const missingTables = await findMissingPerTenantTables(executor, sourceSchema, tenantSchema);
  if (missingTables.length > 0) {
    return {
      ...base,
      skipped: true,
      copiedRows: 0,
      reason: 'missing-per-tenant-tables',
      missingTables,
    };
  }

  await executor.query(`
    INSERT INTO "${tenantSchema}"."${tenantLedger}" ("timestamp", "name")
    SELECT "timestamp", "name"
      FROM "${sourceSchema}"."${MIGRATION_LEDGER_TABLE}"
  `);
  return { ...base, skipped: false, copiedRows: sourceRows };
}
