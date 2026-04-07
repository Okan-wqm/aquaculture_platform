import { QueryRunner } from 'typeorm';
import { Logger } from '@nestjs/common';

/**
 * applyTenantRlsToSchema
 * ============================================================================
 *
 * Bulk Row-Level Security (RLS) installer for tenant-scoped tables, designed
 * to be invoked from a TypeORM `MigrationInterface.up()`.
 *
 * # Why a helper instead of per-service hand-written SQL?
 *
 * 1. **Single source of truth** for the RLS predicate. The predicate is
 *    SECURITY-CRITICAL — a typo silently allows cross-tenant reads.
 * 2. **Bug fix**: the previous farm-service migration used
 *    `COALESCE(current_setting('app.current_tenant', true), '')::uuid` which
 *    throws `invalid input syntax for type uuid: ""` whenever the GUC is
 *    unset. We use `NULLIF(...)::uuid` so an unset GUC becomes NULL and the
 *    comparison cleanly evaluates to UNKNOWN (no cast error, no rows leaked).
 * 3. **Column-name flexibility**: the platform mixes naming conventions —
 *    `farm-service.BaseEntity` uses `tenant_id` (snake_case), while
 *    `auth-service.User` uses `"tenantId"` (camelCase quoted). Per-table
 *    discovery handles both.
 * 4. **Bypass clause** baked in: admin-api-service, background workers, and
 *    cross-tenant analytics queries set `app.bypass_rls = 'on'` for the
 *    duration of a transaction. The policy honours this without needing a
 *    separate DB role (which would be operationally heavier).
 * 5. **Idempotent**: safe to re-run after partial failures or in dev/staging
 *    where the schema may already have policies installed (DROP IF EXISTS +
 *    CREATE).
 *
 * # The RLS predicate (security-critical — read carefully)
 *
 * ```sql
 * USING (
 *   -- (1) Explicit bypass for SUPER_ADMIN/background-job contexts.
 *   --     The caller must SET LOCAL app.bypass_rls = 'on' inside a
 *   --     transaction; the setting is reset on COMMIT/ROLLBACK so it
 *   --     cannot leak into pooled connections.
 *   current_setting('app.bypass_rls', true) = 'on'
 *
 *   OR
 *
 *   -- (2) Tenant context active and matches the row's tenant.
 *   --     NULLIF turns the empty string (when the GUC is unset) into NULL,
 *   --     which makes the cast safe and forces the comparison to UNKNOWN —
 *   --     so no rows are exposed by accident.
 *   "<tenant_col>" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
 * )
 * ```
 *
 * Behaviour matrix:
 *
 * | bypass GUC | tenant GUC      | Result                                |
 * | ---------- | --------------- | ------------------------------------- |
 * | unset      | unset           | No rows visible (deny by default)     |
 * | unset      | UUID            | Only rows where tenantId matches      |
 * | 'on'       | unset           | All rows visible (admin/job mode)     |
 * | 'on'       | UUID            | All rows visible (bypass wins)        |
 *
 * # Discovery semantics
 *
 * The helper introspects `information_schema.columns` for the *current*
 * schema and finds every base table that contains a column whose name is in
 * `tenantIdColumns`. Each match gets RLS enabled, FORCED (so even the table
 * owner is subject to the policy), and a `tenant_isolation_policy` created.
 *
 * Tables in `excludeTables` are skipped — typically outbox, audit logs, and
 * any deliberately cross-tenant infrastructure tables.
 *
 * # Why FORCE ROW LEVEL SECURITY?
 *
 * Without FORCE, the table owner bypasses all policies — and the application
 * connects as the table owner (`aquaculture` user per init-schemas.sql). FORCE
 * removes that escape hatch and is therefore mandatory for defence-in-depth.
 *
 * @example
 * ```ts
 * import { applyTenantRlsToSchema } from '@aquaculture/backend-common';
 *
 * export class EnableRowLevelSecurity1781000000000 implements MigrationInterface {
 *   public async up(qr: QueryRunner): Promise<void> {
 *     await applyTenantRlsToSchema(qr, {
 *       excludeTables: ['billing_outbox', 'audit_logs'],
 *     });
 *   }
 *
 *   public async down(qr: QueryRunner): Promise<void> {
 *     await removeTenantRlsFromSchema(qr);
 *   }
 * }
 * ```
 */

/** Allowed identifier pattern — letters, digits, underscores, must not start with a digit. */
const SAFE_IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Default tenant column names to discover (camelCase + snake_case). */
const DEFAULT_TENANT_ID_COLUMNS = ['tenantId', 'tenant_id'] as const;

/** The single, canonical policy name. Stable across migrations so DROP IF EXISTS works. */
export const TENANT_ISOLATION_POLICY_NAME = 'tenant_isolation_policy';

/** Session GUC keys. Public so callers (BypassRlsService, RlsConnectionBootstrap) can reuse. */
export const RLS_TENANT_GUC = 'app.current_tenant';
export const RLS_BYPASS_GUC = 'app.bypass_rls';

export interface ApplyTenantRlsOptions {
  /**
   * Column names to look for when discovering tenant-scoped tables.
   * Defaults to `['tenantId', 'tenant_id']` to handle the platform's mixed
   * naming conventions. Override only if a service uses a non-standard name.
   */
  tenantIdColumns?: readonly string[];

  /**
   * Tables to skip — typically cross-tenant infrastructure (outbox, audit
   * logs, system tables). Names are matched literally against the discovered
   * `table_name` in the current schema.
   */
  excludeTables?: readonly string[];

  /**
   * Optional logger override. Defaults to a NestJS Logger named after this
   * helper. Migrations should pass a `MigrationLogger` for consistent log
   * formatting — its surface area (log/warn) is the lowest common denominator
   * shared with NestJS Logger, so both work without casts.
   */
  logger?: RlsHelperLogger;
}

/**
 * Minimal logger surface used by the helper. Intentionally restricted to
 * `log` and `warn` so that both NestJS `Logger` and our `MigrationLogger`
 * (which lacks `debug`) satisfy the type without adapter shims.
 */
export interface RlsHelperLogger {
  log(message: string): void;
  warn(message: string): void;
}

interface DiscoveredTable {
  tableName: string;
  tenantColumn: string;
}

/**
 * Validate an SQL identifier against `SAFE_IDENTIFIER_REGEX`. Throws on
 * mismatch. This is the only thing standing between user input and SQL
 * interpolation, so the regex is intentionally strict.
 */
function assertSafeIdentifier(identifier: string, label: string): void {
  if (!identifier || !SAFE_IDENTIFIER_REGEX.test(identifier)) {
    throw new Error(
      `[apply-tenant-rls] Unsafe SQL identifier for ${label}: "${identifier}". ` +
        `Must match ${SAFE_IDENTIFIER_REGEX.source}`,
    );
  }
}

/**
 * Build the security-critical USING clause for the tenant isolation policy.
 *
 * Exported for unit testing — production code should not call this directly.
 *
 * @internal
 */
export function buildTenantPolicyUsingClause(tenantColumn: string): string {
  assertSafeIdentifier(tenantColumn, 'tenantColumn');
  return (
    `(` +
    `current_setting('${RLS_BYPASS_GUC}', true) = 'on' ` +
    `OR ` +
    `"${tenantColumn}" = NULLIF(current_setting('${RLS_TENANT_GUC}', true), '')::uuid` +
    `)`
  );
}

/**
 * Discover every base table in `schema` that has at least one of the
 * candidate `tenantIdColumns`. Returns one entry per table with the FIRST
 * matching column (the order in `tenantIdColumns` is significant — list
 * preferred names first).
 */
async function discoverTenantScopedTables(
  qr: QueryRunner,
  schema: string,
  tenantIdColumns: readonly string[],
  excludeTables: readonly string[],
): Promise<DiscoveredTable[]> {
  // Validate every input identifier — the schema name and column names are
  // interpolated into the SQL below via parameters, but we still validate so
  // that a misconfigured caller cannot smuggle a payload through the
  // information_schema query.
  assertSafeIdentifier(schema, 'schema');
  for (const col of tenantIdColumns) assertSafeIdentifier(col, 'tenantIdColumn');
  for (const tbl of excludeTables) assertSafeIdentifier(tbl, 'excludeTable');

  // information_schema.columns is the portable way to introspect tenant
  // columns. We filter on table_type = 'BASE TABLE' to skip views and
  // partitions, and on table_schema = $1 so the helper is schema-scoped (one
  // helper invocation never touches another schema).
  const rows: Array<{ table_name: string; column_name: string }> = await qr.query(
    `
      SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name   = c.table_name
       AND t.table_type   = 'BASE TABLE'
      WHERE c.table_schema = $1
        AND c.column_name = ANY($2::text[])
      ORDER BY c.table_name,
               array_position($2::text[], c.column_name)
    `,
    [schema, [...tenantIdColumns]],
  );

  const excludeSet = new Set(excludeTables);
  const discovered = new Map<string, string>();

  // Each table appears once per matching column; the ORDER BY above means the
  // FIRST row for a given table_name uses the highest-priority column from
  // `tenantIdColumns`. We keep that and ignore subsequent rows for the same
  // table.
  for (const row of rows) {
    if (excludeSet.has(row.table_name)) continue;
    if (discovered.has(row.table_name)) continue;
    discovered.set(row.table_name, row.column_name);
  }

  return [...discovered.entries()].map(([tableName, tenantColumn]) => ({
    tableName,
    tenantColumn,
  }));
}

/**
 * Enable RLS, FORCE it, and install the canonical tenant isolation policy on
 * every tenant-scoped table in the current PostgreSQL schema.
 *
 * Idempotent — safe to invoke against a schema that already has policies
 * installed; the helper drops the existing `tenant_isolation_policy` (if any)
 * and recreates it with the current canonical predicate. This is how we
 * forward-migrate predicate changes (e.g. the NULLIF bug fix) without
 * inventing per-service patch migrations.
 */
export async function applyTenantRlsToSchema(
  qr: QueryRunner,
  options: ApplyTenantRlsOptions = {},
): Promise<void> {
  const logger =
    options.logger ?? new Logger('applyTenantRlsToSchema');
  const tenantIdColumns =
    options.tenantIdColumns && options.tenantIdColumns.length > 0
      ? options.tenantIdColumns
      : DEFAULT_TENANT_ID_COLUMNS;
  const excludeTables = options.excludeTables ?? [];

  // current_schema() respects the search_path the migration runner set up,
  // so the helper always operates inside the service's own schema — never
  // public, never another service's schema.
  const schemaRows: Array<{ schema: string }> = await qr.query(
    `SELECT current_schema() AS schema`,
  );
  const schema = schemaRows[0]?.schema ?? 'public';
  assertSafeIdentifier(schema, 'current_schema');

  logger.log(
    `Applying tenant RLS in schema "${schema}" ` +
      `(columns: ${tenantIdColumns.join(',')}, exclude: ${excludeTables.join(',') || '∅'})`,
  );

  const tables = await discoverTenantScopedTables(
    qr,
    schema,
    tenantIdColumns,
    excludeTables,
  );

  if (tables.length === 0) {
    logger.warn(
      `No tenant-scoped tables found in schema "${schema}" — nothing to do. ` +
        `Check tenantIdColumns option if this is unexpected.`,
    );
    return;
  }

  logger.log(`Discovered ${tables.length} tenant-scoped tables in "${schema}"`);

  for (const { tableName, tenantColumn } of tables) {
    assertSafeIdentifier(tableName, 'tableName');

    // Step 1: ENABLE then FORCE RLS. ENABLE turns it on for non-owners, FORCE
    // extends it to the table owner. We need both because the application
    // connects as the schema owner (`aquaculture`).
    await qr.query(
      `ALTER TABLE "${schema}"."${tableName}" ENABLE ROW LEVEL SECURITY`,
    );
    await qr.query(
      `ALTER TABLE "${schema}"."${tableName}" FORCE ROW LEVEL SECURITY`,
    );

    // Step 2: drop any pre-existing policy with the canonical name. This is
    // what makes the helper a forward-migration tool — predicate changes
    // (like the NULLIF fix) are applied by simply re-running the helper.
    await qr.query(
      `DROP POLICY IF EXISTS "${TENANT_ISOLATION_POLICY_NAME}" ` +
        `ON "${schema}"."${tableName}"`,
    );

    // Step 3: create the policy with the canonical bypass-aware predicate.
    // FOR ALL covers SELECT/INSERT/UPDATE/DELETE — for INSERT and UPDATE the
    // USING clause acts as the WITH CHECK clause too, so writers cannot
    // insert rows for other tenants either.
    const usingClause = buildTenantPolicyUsingClause(tenantColumn);
    await qr.query(
      `CREATE POLICY "${TENANT_ISOLATION_POLICY_NAME}" ` +
        `ON "${schema}"."${tableName}" ` +
        `FOR ALL ` +
        `USING ${usingClause} ` +
        `WITH CHECK ${usingClause}`,
    );

    logger.log(
      `RLS armed on "${schema}"."${tableName}" (col: ${tenantColumn})`,
    );
  }

  logger.log(
    `Tenant RLS applied to ${tables.length} tables in schema "${schema}"`,
  );
}

/**
 * Reverse `applyTenantRlsToSchema` — drops the canonical policy and disables
 * RLS on every tenant-scoped table in the current schema. Used by migration
 * `down()` methods so that rollbacks restore the pre-RLS state.
 *
 * Idempotent: missing policies and already-disabled tables are no-ops.
 */
export async function removeTenantRlsFromSchema(
  qr: QueryRunner,
  options: Pick<ApplyTenantRlsOptions, 'tenantIdColumns' | 'excludeTables' | 'logger'> = {},
): Promise<void> {
  const logger = options.logger ?? new Logger('removeTenantRlsFromSchema');
  const tenantIdColumns =
    options.tenantIdColumns && options.tenantIdColumns.length > 0
      ? options.tenantIdColumns
      : DEFAULT_TENANT_ID_COLUMNS;
  const excludeTables = options.excludeTables ?? [];

  const schemaRows: Array<{ schema: string }> = await qr.query(
    `SELECT current_schema() AS schema`,
  );
  const schema = schemaRows[0]?.schema ?? 'public';
  assertSafeIdentifier(schema, 'current_schema');

  const tables = await discoverTenantScopedTables(
    qr,
    schema,
    tenantIdColumns,
    excludeTables,
  );

  for (const { tableName } of tables) {
    assertSafeIdentifier(tableName, 'tableName');

    await qr.query(
      `DROP POLICY IF EXISTS "${TENANT_ISOLATION_POLICY_NAME}" ` +
        `ON "${schema}"."${tableName}"`,
    );

    // NO FORCE first, then DISABLE. Order matters: DISABLE on a FORCEd table
    // is a no-op for the owner but PostgreSQL accepts it without error.
    await qr.query(
      `ALTER TABLE "${schema}"."${tableName}" NO FORCE ROW LEVEL SECURITY`,
    );
    await qr.query(
      `ALTER TABLE "${schema}"."${tableName}" DISABLE ROW LEVEL SECURITY`,
    );
  }

  logger.log(`Tenant RLS removed from ${tables.length} tables in "${schema}"`);
}
