/**
 * Tenant-schema privilege assertion — the ownership/grant SSoT for per-tenant
 * table clones (INFRA-CRITICAL: 2026-07-06 grant incident).
 *
 * WHY: per-tenant tables reach `tenant_<uuid>` schemas through two paths — the
 * provisioner job (new tenants) and the deploy-time migration fan-out (new
 * tables into existing tenants). Both run on the db-migrate bootstrap
 * connection (a superuser), and Postgres neither copies privileges through
 * `CREATE TABLE` under `search_path` nor applies another role's default ACLs,
 * so every table born there was owner=superuser with an EMPTY ACL. The owning
 * service's first query then failed with `permission denied` — silently at
 * boot (SchemaVersionGate only reads the ledger, which WAS granted), loudly in
 * production (live incident: `sensor_temperature_latest` blanked
 * equipmentList.batchMetrics for mobile; farm_documents / regulatory_reports /
 * training_sessions / message_receipt_ledger were equally dead).
 *
 * WHAT: derive the per-tenant table set from MODULE_SCHEMAS (`tables` ∪
 * `referenceDataTables` — `infrastructureTables` stay source-only) and
 * idempotently align, per table that exists in the tenant schema:
 *   - owner  → `<sourceSchema>_schema_owner` (the stage-008 ownership model;
 *     also what the messaging partition-definer requires on its parents),
 *   - DML    → GRANT SELECT, INSERT, UPDATE, DELETE TO `<sourceSchema>_service`,
 *              except registry-declared read-only ledgers, which receive
 *              SELECT and an explicit INSERT/UPDATE/DELETE revoke,
 *   - owned sequences → owner + USAGE/SELECT/UPDATE for the service role,
 * plus schema USAGE for the service role. Because the set is registry-derived
 * and the statements are idempotent, re-running a deploy self-heals any
 * pre-existing drift with no manual ceremony.
 *
 * `verifyTenantSchemaPrivileges` is the make-it-detectable half: it re-reads
 * pg_catalog and returns every registered-and-present table whose owner or
 * service-role DML privileges are still wrong. Callers (db-migrate fan-out,
 * provisioner PROVISION/RECONCILE) treat violations as deploy/job-blocking —
 * the drift class can no longer ship silently. Tables present in the tenant
 * schema but unknown to the registry are reported for LOUD logging (they are
 * exactly how this incident stayed invisible), not silently skipped.
 */
import { tenantMigrationLedgerTable } from './migration-ledger';
import { MODULE_SCHEMAS } from './schema-manager.service';
import { TENANT_SCHEMA_NAME_RE } from './tenant-aware-schemas';

const SAFE_SQL_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface TenantSchemaPrivilegeExecutor {
  query(sql: string, parameters?: readonly unknown[]): Promise<unknown>;
}

export interface TenantSchemaPrivilegeOptions {
  tenantSchema: string;
  sourceSchema: string;
}

export interface TenantSchemaPrivilegeReport {
  tenantSchema: string;
  sourceSchema: string;
  ownerRole: string;
  serviceRole: string;
  /** Registered tables found in the tenant schema and aligned (owner + grants). */
  alignedTables: string[];
  /** Registered tables not (yet) present in the tenant schema — informational. */
  absentTables: string[];
  /** Sequences owned by aligned tables that were aligned alongside them. */
  alignedSequences: string[];
}

export interface TenantSchemaPrivilegeViolation {
  table: string;
  sourceSchema: string;
  /** 'owner' | 'privilege' — what is wrong. */
  kind: 'owner' | 'privilege';
  detail: string;
}

export interface TenantSchemaPrivilegeVerification {
  tenantSchema: string;
  violations: TenantSchemaPrivilegeViolation[];
  /** Tables present in the tenant schema but registered by no module — must be logged loudly. */
  unknownTables: string[];
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!SAFE_SQL_IDENTIFIER_RE.test(value)) {
    throw new Error(`[tenant-schema-privileges] Unsafe ${label}: "${value}".`);
  }
}

function assertTenantSchema(value: string): void {
  assertSafeIdentifier(value, 'tenant schema');
  if (!TENANT_SCHEMA_NAME_RE.test(value)) {
    throw new Error(
      `[tenant-schema-privileges] Refusing non-tenant schema "${value}". ` +
        `Expected ${TENANT_SCHEMA_NAME_RE.toString()}.`,
    );
  }
}

export function ownerRoleForTenantAwareSchema(sourceSchema: string): string {
  assertSafeIdentifier(sourceSchema, 'source schema');
  return `${sourceSchema}_schema_owner`;
}

/** The per-tenant table set a source schema owns (tables ∪ referenceDataTables). */
export function tenantTablesForSourceSchema(sourceSchema: string): string[] {
  const entry = MODULE_SCHEMAS.find((m) => m.sourceSchema === sourceSchema);
  if (!entry) {
    throw new Error(
      `[tenant-schema-privileges] Source schema "${sourceSchema}" is not in MODULE_SCHEMAS — ` +
        `register it before fanning tenant migrations out for it.`,
    );
  }
  const tables = [...entry.tables, ...(entry.referenceDataTables ?? [])];
  for (const table of tables) {
    assertSafeIdentifier(table, 'table name');
  }
  return tables;
}

/** Registry-declared tables that the runtime service may only read. */
export function serviceReadOnlyTenantTablesForSourceSchema(
  sourceSchema: string,
): string[] {
  const entry = MODULE_SCHEMAS.find((m) => m.sourceSchema === sourceSchema);
  if (!entry) {
    throw new Error(
      `[tenant-schema-privileges] Source schema "${sourceSchema}" is not in MODULE_SCHEMAS — ` +
        `register it before fanning tenant migrations out for it.`,
    );
  }
  const registered = new Set(tenantTablesForSourceSchema(sourceSchema));
  const readOnly = [...(entry.serviceReadOnlyTables ?? [])];
  for (const table of readOnly) {
    assertSafeIdentifier(table, 'read-only table name');
    if (!registered.has(table)) {
      throw new Error(
        `[tenant-schema-privileges] Read-only table "${table}" is not registered ` +
          `as a per-tenant table for source schema "${sourceSchema}".`,
      );
    }
  }
  return readOnly;
}

interface ExistingTableRow {
  tablename: string;
}

interface OwnedSequenceRow {
  seqname: string;
}

async function existingTenantTables(
  executor: TenantSchemaPrivilegeExecutor,
  tenantSchema: string,
): Promise<Set<string>> {
  const rows = (await executor.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = $1`,
    [tenantSchema],
  )) as ExistingTableRow[];
  return new Set(rows.map((r) => r.tablename));
}

async function ownedSequences(
  executor: TenantSchemaPrivilegeExecutor,
  tenantSchema: string,
  table: string,
): Promise<string[]> {
  const rows = (await executor.query(
    `SELECT seq.relname AS seqname
       FROM pg_class seq
       JOIN pg_depend d ON d.objid = seq.oid AND d.deptype IN ('a', 'i')
       JOIN pg_class tbl ON tbl.oid = d.refobjid
       JOIN pg_namespace n ON n.oid = seq.relnamespace
      WHERE seq.relkind = 'S' AND n.nspname = $1 AND tbl.relname = $2`,
    [tenantSchema, table],
  )) as OwnedSequenceRow[];
  return rows.map((r) => r.seqname);
}

/**
 * Idempotently align owner + service-role privileges for every registered
 * per-tenant table of `sourceSchema` that exists in `tenantSchema`.
 * Requires a connection allowed to ALTER ownership (db-migrate's bootstrap
 * connection). Returns what was aligned for structured logging.
 */
export async function assertTenantSchemaPrivileges(
  executor: TenantSchemaPrivilegeExecutor,
  options: TenantSchemaPrivilegeOptions,
): Promise<TenantSchemaPrivilegeReport> {
  assertTenantSchema(options.tenantSchema);
  assertSafeIdentifier(options.sourceSchema, 'source schema');

  const ownerRole = ownerRoleForTenantAwareSchema(options.sourceSchema);
  const serviceRole = `${options.sourceSchema}_service`;
  assertSafeIdentifier(ownerRole, 'owner role');
  assertSafeIdentifier(serviceRole, 'service role');

  const registered = tenantTablesForSourceSchema(options.sourceSchema);
  const readOnly = new Set(
    serviceReadOnlyTenantTablesForSourceSchema(options.sourceSchema),
  );
  const existing = await existingTenantTables(executor, options.tenantSchema);

  await executor.query(`GRANT USAGE ON SCHEMA "${options.tenantSchema}" TO "${serviceRole}"`);

  const alignedTables: string[] = [];
  const absentTables: string[] = [];
  const alignedSequences: string[] = [];

  for (const table of registered) {
    if (!existing.has(table)) {
      absentTables.push(table);
      continue;
    }
    await executor.query(
      `ALTER TABLE "${options.tenantSchema}"."${table}" OWNER TO "${ownerRole}"`,
    );
    if (readOnly.has(table)) {
      await executor.query(
        `REVOKE INSERT, UPDATE, DELETE ON TABLE "${options.tenantSchema}"."${table}" ` +
          `FROM "${serviceRole}"`,
      );
      await executor.query(
        `GRANT SELECT ON TABLE "${options.tenantSchema}"."${table}" TO "${serviceRole}"`,
      );
    } else {
      await executor.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "${options.tenantSchema}"."${table}" ` +
          `TO "${serviceRole}"`,
      );
    }
    for (const seq of await ownedSequences(executor, options.tenantSchema, table)) {
      assertSafeIdentifier(seq, 'sequence name');
      await executor.query(
        `ALTER SEQUENCE "${options.tenantSchema}"."${seq}" OWNER TO "${ownerRole}"`,
      );
      await executor.query(
        `GRANT USAGE, SELECT, UPDATE ON SEQUENCE "${options.tenantSchema}"."${seq}" ` +
          `TO "${serviceRole}"`,
      );
      alignedSequences.push(seq);
    }
    alignedTables.push(table);
  }

  return {
    tenantSchema: options.tenantSchema,
    sourceSchema: options.sourceSchema,
    ownerRole,
    serviceRole,
    alignedTables,
    absentTables,
    alignedSequences,
  };
}

interface PrivilegeCheckRow {
  tablename: string;
  tableowner: string;
  has_select: boolean;
  has_insert: boolean;
  has_update: boolean;
  has_delete: boolean;
}

/**
 * Re-read pg_catalog and report every registered-and-present per-tenant table
 * whose owner or service-role DML privileges are wrong, across the given
 * source schemas, plus tenant-schema tables no module registers. Callers
 * treat `violations.length > 0` as deploy/job-blocking; `unknownTables` must
 * be logged loudly (they are how this class of failure previously stayed
 * invisible).
 */
export async function verifyTenantSchemaPrivileges(
  executor: TenantSchemaPrivilegeExecutor,
  tenantSchema: string,
  sourceSchemas: readonly string[],
): Promise<TenantSchemaPrivilegeVerification> {
  assertTenantSchema(tenantSchema);

  const existing = await existingTenantTables(executor, tenantSchema);
  const violations: TenantSchemaPrivilegeViolation[] = [];
  const claimed = new Set<string>();

  for (const sourceSchema of sourceSchemas) {
    assertSafeIdentifier(sourceSchema, 'source schema');
    const ownerRole = ownerRoleForTenantAwareSchema(sourceSchema);
    const serviceRole = `${sourceSchema}_service`;
    const registered = tenantTablesForSourceSchema(sourceSchema);
    const readOnly = new Set(serviceReadOnlyTenantTablesForSourceSchema(sourceSchema));
    const present = registered.filter((t) => existing.has(t));
    // The per-source tenant migration ledger is service-read-only by design.
    claimed.add(tenantMigrationLedgerTable(sourceSchema));
    for (const t of registered) {
      claimed.add(t);
    }
    if (present.length === 0) {
      continue;
    }

    const rows = (await executor.query(
      `SELECT t.tablename,
              t.tableowner,
              has_table_privilege($2, format('%I.%I', t.schemaname, t.tablename), 'SELECT') AS has_select,
              has_table_privilege($2, format('%I.%I', t.schemaname, t.tablename), 'INSERT') AS has_insert,
              has_table_privilege($2, format('%I.%I', t.schemaname, t.tablename), 'UPDATE') AS has_update,
              has_table_privilege($2, format('%I.%I', t.schemaname, t.tablename), 'DELETE') AS has_delete
         FROM pg_tables t
        WHERE t.schemaname = $1 AND t.tablename = ANY($3)`,
      [tenantSchema, serviceRole, present],
    )) as PrivilegeCheckRow[];

    for (const row of rows) {
      if (row.tableowner !== ownerRole) {
        violations.push({
          table: row.tablename,
          sourceSchema,
          kind: 'owner',
          detail: `owner is "${row.tableowner}", expected "${ownerRole}"`,
        });
      }
      const expectsWrites = !readOnly.has(row.tablename);
      if (
        !row.has_select ||
        row.has_insert !== expectsWrites ||
        row.has_update !== expectsWrites ||
        row.has_delete !== expectsWrites
      ) {
        violations.push({
          table: row.tablename,
          sourceSchema,
          kind: 'privilege',
          detail:
            `"${serviceRole}" expected ${expectsWrites ? 'full DML' : 'SELECT-only'} ` +
            `(S:${row.has_select} I:${row.has_insert} U:${row.has_update} D:${row.has_delete})`,
        });
      }
    }
  }

  // Partition children (e.g. messages_2026_07) are accessed through their
  // parent's ACL — claim them via their registered parent prefix so they are
  // not reported as unknown.
  const unknownTables = [...existing].filter((t) => {
    if (claimed.has(t)) return false;
    for (const parent of claimed) {
      if (t.startsWith(`${parent}_`) && /_\d{4}_\d{2}$/.test(t)) return false;
    }
    return true;
  });

  return { tenantSchema, violations, unknownTables };
}
