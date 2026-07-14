/**
 * Source-schema write-guard reconciler — the SSoT for the `guard_source_write`
 * BEFORE-triggers that enforce tenant isolation at the database layer
 * (ORPHAN-HIGH-087; completes FARM-CRITICAL-061).
 *
 * WHY: per-tenant DATA tables live in a source schema ONLY as templates — every
 * real tenant write goes through a `tenant_<uuid>` clone via `search_path`. A
 * direct INSERT/UPDATE/DELETE against a source-schema data table is therefore
 * always a tenant-isolation defect. A BEFORE trigger (`guard_source_write`,
 * calling `<schema>.block_source_writes()`, ERRCODE `P0999`) rejects such writes
 * so a bug (missing request context, wrong search_path) fails closed at the DB.
 *
 * Historically these triggers were installed at service boot by the now-inert
 * `SourceSchemaWriteGuardService`, with NO source of truth binding "which tables
 * carry the guard" to the schema registry. That let the guard drift onto a
 * cross-tenant infrastructure ledger (`farm.farm_audit_logs`), whose direct
 * INSERTs are legitimate, and broke every farm mutation (FARM-CRITICAL-061).
 *
 * WHAT: derive the guarded set from `MODULE_SCHEMAS` as
 *   guardedSet = tables − referenceDataTables − infrastructureTables
 * (per-tenant DATA tables only — reference tables stay writable for seeding;
 * infrastructure ledgers are written directly by design), restricted to
 * `TENANT_AWARE_SCHEMAS` (platform-level schemas write their source tables
 * directly and must NEVER be guarded). {@link assertSourceSchemaWriteGuards}
 * idempotently (re)creates the guard on exactly that set AND drops it from every
 * other table in the schema, so the FARM-CRITICAL-061 drift self-heals and
 * cannot recur. {@link verifySourceSchemaWriteGuards} re-reads `pg_catalog` and
 * returns `{ missing, misplaced }`; callers treat non-empty as deploy/job-
 * blocking. Because the set is registry-derived and the statements idempotent,
 * every deploy converges the guards with no manual ceremony.
 *
 * Ownership: aqua-db-migrate owns source-schema DDL. Runtime services cannot
 * open DDL windows, so this runs ONLY on the db-migrate bootstrap connection.
 */
import { type ModuleSchema, MODULE_SCHEMAS } from './schema-manager.service';
import { TENANT_AWARE_SCHEMAS } from './tenant-aware-schemas';

const SAFE_SQL_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const GUARD_TRIGGER_NAME = 'guard_source_write';
const GUARD_FUNCTION_NAME = 'block_source_writes';

export interface SourceSchemaGuardExecutor {
  query(sql: string, parameters?: readonly unknown[]): Promise<unknown>;
}

export interface SourceSchemaWriteGuardReport {
  sourceSchema: string;
  /** Guarded data tables where the trigger was (re)created (existed in schema). */
  installed: string[];
  /** Guarded data tables the registry declares but that are not yet present. */
  absentTables: string[];
  /** Tables where a stray `guard_source_write` was dropped (reconcile). */
  droppedMisplaced: string[];
}

export interface SourceSchemaWriteGuardViolationSets {
  sourceSchema: string;
  /** Guarded data table present in the schema but lacking `guard_source_write`. */
  missing: string[];
  /**
   * Table carrying `guard_source_write` that is NOT in the guarded set — i.e.
   * a reference/infrastructure/unknown table (the FARM-CRITICAL-061 class).
   */
  misplaced: string[];
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!SAFE_SQL_IDENTIFIER_RE.test(value)) {
    throw new Error(`[source-schema-write-guard] Unsafe ${label}: "${value}".`);
  }
}

function moduleEntryForSourceSchema(sourceSchema: string): ModuleSchema {
  const entry = MODULE_SCHEMAS.find((m) => m.sourceSchema === sourceSchema);
  if (!entry) {
    throw new Error(
      `[source-schema-write-guard] Source schema "${sourceSchema}" is not in MODULE_SCHEMAS — ` +
        `register it before reconciling its write guards.`,
    );
  }
  return entry;
}

/** Reference + infrastructure tables of a source schema — never guardable. */
function nonGuardableTables(entry: ModuleSchema): Set<string> {
  return new Set<string>([
    ...(entry.referenceDataTables ?? []),
    ...(entry.infrastructureTables ?? []),
  ]);
}

/**
 * The per-tenant DATA tables of a source schema that MUST NOT be written
 * directly (the guarded set): `tables − referenceDataTables − infrastructureTables`.
 *
 * Only defined for `TENANT_AWARE_SCHEMAS`; refuses platform-level schemas, whose
 * services write their source tables directly. The set-difference guarantees the
 * guard can never target a reference or infrastructure table (the
 * FARM-CRITICAL-061 class) regardless of registry mistakes.
 */
export function sourceSchemaGuardedTables(sourceSchema: string): string[] {
  assertSafeIdentifier(sourceSchema, 'source schema');
  if (!TENANT_AWARE_SCHEMAS.has(sourceSchema)) {
    throw new Error(
      `[source-schema-write-guard] Refusing non-tenant-aware source schema "${sourceSchema}". ` +
        `Platform-level schemas write their source tables directly and must not be guarded.`,
    );
  }
  const entry = moduleEntryForSourceSchema(sourceSchema);
  const excluded = nonGuardableTables(entry);
  const guarded = entry.tables.filter((table) => !excluded.has(table));
  for (const table of guarded) {
    assertSafeIdentifier(table, 'table name');
  }
  return guarded;
}

interface TableNameRow {
  tablename: string;
}

async function existingTables(
  executor: SourceSchemaGuardExecutor,
  sourceSchema: string,
): Promise<Set<string>> {
  const rows = (await executor.query(`SELECT tablename FROM pg_tables WHERE schemaname = $1`, [
    sourceSchema,
  ])) as TableNameRow[];
  return new Set(rows.map((r) => r.tablename));
}

async function tablesWithGuard(
  executor: SourceSchemaGuardExecutor,
  sourceSchema: string,
): Promise<string[]> {
  // `tg.tgparentid = 0` excludes triggers that a partition INHERITED from its
  // parent partitioned table. Under declarative partitioning, creating
  // `guard_source_write` on a parent (e.g. messaging.messages) auto-propagates a
  // child trigger to every partition (messages_2026_06, …) with tgparentid set
  // to the parent trigger's oid. Those child triggers CANNOT be dropped
  // independently — Postgres refuses ("... requires it") — they are managed via
  // the parent. Considering them here made the reconcile loop below try to drop
  // a partition's guard as "misplaced" and abort the whole deploy. The parent
  // is the only manageable unit, so we report and reconcile ONLY parents/
  // stand-alone tables; create/drop on the parent cascades to its partitions.
  const rows = (await executor.query(
    `SELECT c.relname AS tablename
       FROM pg_trigger tg
       JOIN pg_class c ON c.oid = tg.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND tg.tgname = $2 AND NOT tg.tgisinternal
        AND tg.tgparentid = 0`,
    [sourceSchema, GUARD_TRIGGER_NAME],
  )) as TableNameRow[];
  return rows.map((r) => r.tablename);
}

/**
 * Idempotently converge the source-schema write guards to the registry-derived
 * SSoT: (re)create the canonical `block_source_writes()` function, install
 * `guard_source_write` on exactly {@link sourceSchemaGuardedTables} that exist,
 * and DROP the guard from every OTHER table in the schema (reconcile — this is
 * what heals the FARM-CRITICAL-061 `farm.farm_audit_logs` drift permanently).
 *
 * Requires a DDL-capable connection (db-migrate's bootstrap connection).
 */
export async function assertSourceSchemaWriteGuards(
  executor: SourceSchemaGuardExecutor,
  sourceSchema: string,
): Promise<SourceSchemaWriteGuardReport> {
  const guarded = new Set(sourceSchemaGuardedTables(sourceSchema));

  // Canonical function definition (the guard's SSoT lives with the trigger set).
  await executor.query(
    `CREATE OR REPLACE FUNCTION "${sourceSchema}".${GUARD_FUNCTION_NAME}() RETURNS trigger
       LANGUAGE plpgsql AS $guard$
     BEGIN
       RAISE EXCEPTION 'TENANT_ISOLATION_VIOLATION: Direct write to source schema %.%',
         TG_TABLE_SCHEMA, TG_TABLE_NAME
         USING ERRCODE = 'P0999';
     END;
     $guard$`,
  );

  const existing = await existingTables(executor, sourceSchema);

  const installed: string[] = [];
  const absentTables: string[] = [];
  for (const table of guarded) {
    if (!existing.has(table)) {
      absentTables.push(table);
      continue;
    }
    await executor.query(
      `DROP TRIGGER IF EXISTS ${GUARD_TRIGGER_NAME} ON "${sourceSchema}"."${table}"`,
    );
    await executor.query(
      `CREATE TRIGGER ${GUARD_TRIGGER_NAME} ` +
        `BEFORE INSERT OR UPDATE OR DELETE ON "${sourceSchema}"."${table}" ` +
        `FOR EACH ROW EXECUTE FUNCTION "${sourceSchema}".${GUARD_FUNCTION_NAME}()`,
    );
    installed.push(table);
  }

  // Reconcile: any table carrying the guard that is NOT in the guarded set is
  // drift (reference/infra/unknown) — drop it. Makes FARM-CRITICAL-061 impossible.
  const droppedMisplaced: string[] = [];
  for (const table of await tablesWithGuard(executor, sourceSchema)) {
    if (!guarded.has(table)) {
      assertSafeIdentifier(table, 'existing guarded table');
      await executor.query(
        `DROP TRIGGER IF EXISTS ${GUARD_TRIGGER_NAME} ON "${sourceSchema}"."${table}"`,
      );
      droppedMisplaced.push(table);
    }
  }

  return { sourceSchema, installed, absentTables, droppedMisplaced };
}

/**
 * Re-read `pg_catalog` and report guard drift for a source schema. `missing` =
 * a guarded data table that exists but lacks the guard; `misplaced` = a table
 * carrying the guard that is not in the guarded set (the FARM-CRITICAL-061
 * class). Callers (db-migrate deploy fan-out, provisioner) treat any non-empty
 * result as deploy/job-blocking.
 */
export async function verifySourceSchemaWriteGuards(
  executor: SourceSchemaGuardExecutor,
  sourceSchema: string,
): Promise<SourceSchemaWriteGuardViolationSets> {
  const guarded = new Set(sourceSchemaGuardedTables(sourceSchema));
  const existing = await existingTables(executor, sourceSchema);
  const withGuard = await tablesWithGuard(executor, sourceSchema);
  const withGuardSet = new Set(withGuard);

  const missing = [...guarded].filter((table) => existing.has(table) && !withGuardSet.has(table));
  const misplaced = withGuard.filter((table) => !guarded.has(table));

  return { sourceSchema, missing, misplaced };
}
