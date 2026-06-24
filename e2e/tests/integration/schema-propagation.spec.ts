/**
 * Schema Propagation Invariant
 * ============================================================================
 *
 * Static invariant: every per-tenant schema (tenant_<uuid16>) must carry,
 * for every table it shares with its source schema, AT LEAST the column
 * set the source schema currently defines. Extra tenant-specific columns
 * are allowed (data), but missing columns are a regression — they signal
 * that a migration landed on the source schema without propagating to
 * existing tenants, which is exactly the architectural gap closed by:
 *
 *   - WP3 (libs/backend-common MigrationRunnerService tenant fan-out)
 *   - WP4 (SchemaManagerService migrations history seed)
 *   - WP5 (apps/db-migrate orchestrator tenant fan-out)
 *
 * # What this test catches
 *
 *   - A developer writes a migration that adds a column to
 *     `farm.daily_feeding_executions` but forgets to loop tenant schemas.
 *     Source gets the column. Existing tenants don't. Next deploy,
 *     this test FAILS on every tenant whose daily_feeding_executions
 *     table is missing the new column.
 *
 *   - The MigrationRunnerService fan-out silently skips a tenant (e.g.
 *     due to an advisory-lock deadline). Same symptom, same catch.
 *
 *   - A future schema-per-tenant service is added to the platform but not
 *     to TENANT_AWARE_SCHEMAS in the runners. New tenant schemas miss its
 *     tables entirely — test FAILS on missing table.
 *
 * # When this test fails
 *
 *   - Identify the missing (table, column) per-tenant pair.
 *   - Confirm the source schema version shows the column (it should —
 *     migrations landed there).
 *   - Re-run the relevant service's migration runner, or manually apply
 *     the ALTER TABLE on the affected tenants while root-causing why the
 *     runner skipped them.
 *
 * # No tenants in the DB? Test passes trivially
 *
 *   On a freshly-provisioned CI database with no tenants yet, the tenant
 *   schema list is empty and the test is a no-op. That's intentional —
 *   propagation can't drift when there's nothing to propagate to.
 */

import {
  MIGRATION_LEDGER_TABLE,
  TENANT_AWARE_SCHEMAS,
  TENANT_SCHEMA_NAME_RE as TENANT_SCHEMA_RE,
} from '@aquaculture/backend-common/database';

import { TestDatabase } from '../../helpers/db.helper';

const TENANT_AWARE_SOURCE_SCHEMAS = [...TENANT_AWARE_SCHEMAS] as const;

interface ColumnRow {
  table_name: string;
  column_name: string;
  [k: string]: unknown;
}

interface SchemaRow {
  schema_name: string;
  [k: string]: unknown;
}

/** Build a `Map<table, Set<column>>` for a schema in one round-trip. */
async function fetchSchemaColumns(
  db: TestDatabase,
  schema: string,
): Promise<Map<string, Set<string>>> {
  const result = await db.query<ColumnRow>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = $1
        -- TypeORM's own migration-history table is not a domain table;
        -- its row shape is identical everywhere so drift comparison is
        -- noise. Exclude.
        AND table_name <> $2
        AND table_name !~ '^migrations_'`,
    [schema, MIGRATION_LEDGER_TABLE],
  );
  const byTable = new Map<string, Set<string>>();
  for (const row of result.rows) {
    let columns = byTable.get(row.table_name);
    if (!columns) {
      columns = new Set<string>();
      byTable.set(row.table_name, columns);
    }
    columns.add(row.column_name);
  }
  return byTable;
}

/** Enumerate every `tenant_<uuid16>` schema currently in the DB. */
async function listTenantSchemas(db: TestDatabase): Promise<string[]> {
  const result = await db.query<SchemaRow>(
    `SELECT schema_name
       FROM information_schema.schemata
      WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'
      ORDER BY schema_name`,
  );
  return result.rows.map((r) => r.schema_name);
}

describe('Schema Propagation (tenant schemas track source)', () => {
  const db = new TestDatabase();

  afterAll(async () => {
    await db.close();
  });

  for (const sourceSchema of TENANT_AWARE_SOURCE_SCHEMAS) {
    describe(`source "${sourceSchema}" → tenants`, () => {
      it('no tenant is missing a table that exists in source', async () => {
        const tenants = await listTenantSchemas(db);
        if (tenants.length === 0) {
          // Fresh CI DB — no tenants, no propagation to verify.
          return;
        }

        const sourceTables = await fetchSchemaColumns(db, sourceSchema);
        if (sourceTables.size === 0) {
          // Source schema empty (e.g. hydroponics before its first
          // migration lands). No invariant to check.
          return;
        }

        const missingByTenant: Record<string, string[]> = {};
        for (const tenantSchema of tenants) {
          expect(tenantSchema).toMatch(TENANT_SCHEMA_RE);
          const tenantTables = await fetchSchemaColumns(db, tenantSchema);
          const missingTables = [...sourceTables.keys()].filter((t) => !tenantTables.has(t));
          if (missingTables.length > 0) {
            missingByTenant[tenantSchema] = missingTables;
          }
        }

        expect(missingByTenant).toEqual({});
      });

      it('no tenant is missing a column that exists in source', async () => {
        const tenants = await listTenantSchemas(db);
        if (tenants.length === 0) return;

        const sourceTables = await fetchSchemaColumns(db, sourceSchema);
        if (sourceTables.size === 0) return;

        const drift: Record<string, Record<string, string[]>> = {};
        for (const tenantSchema of tenants) {
          const tenantTables = await fetchSchemaColumns(db, tenantSchema);
          const tableDrift: Record<string, string[]> = {};
          for (const [table, sourceCols] of sourceTables.entries()) {
            const tenantCols = tenantTables.get(table);
            if (!tenantCols) continue; // already caught by "missing table" test above
            const missingCols = [...sourceCols].filter((c) => !tenantCols.has(c));
            if (missingCols.length > 0) {
              tableDrift[table] = missingCols;
            }
          }
          if (Object.keys(tableDrift).length > 0) {
            drift[tenantSchema] = tableDrift;
          }
        }

        // When this fails, the assertion diff reports exactly which
        // tenants miss which columns — directly actionable.
        expect(drift).toEqual({});
      });
    });
  }
});
