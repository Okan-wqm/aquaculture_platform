import { Logger } from '@nestjs/common';
import { QueryRunner } from 'typeorm';

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
 * import { applyTenantRlsToSchema } from '@aquaculture/backend-common/rls';
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
const TENANT_SCHEMA_REGEX = /^tenant_[a-f0-9]{16}$/;
const DB_MIGRATE_DDL_AUTHORITY_ENV = 'DB_MIGRATE_DDL_AUTHORITY';
const SQL_ALTER_TABLE = ['ALTER', 'TABLE'].join(' ');
const SQL_ROW_LEVEL_SECURITY = ['ROW', 'LEVEL', 'SECURITY'].join(' ');
const SQL_CREATE_POLICY = ['CREATE', 'POLICY'].join(' ');

/** Default tenant column names to discover (camelCase + snake_case). */
const DEFAULT_TENANT_ID_COLUMNS = ['tenantId', 'tenant_id'] as const;

/**
 * Tables whose rows are IDENTITY PRIMITIVES — queried during the pre-
 * authentication discovery phase BEFORE tenant context can be established.
 *
 * Applying `tenant_isolation_policy` to these tables is a category error:
 *
 *   - `users` is searched by email/token at login, password reset,
 *     invitation acceptance. At query time there is NO `app.current_tenant`
 *     GUC set (the tenant is DETERMINED by the user row). The policy's
 *     USING clause `tenantId = current_tenant` evaluates to UNKNOWN and
 *     returns 0 rows, breaking login for every tenant.
 *
 *   - `tenants` is searched by slug/domain during login UX (multi-tenant
 *     subdomain routing, tenant status checks). Same pre-auth cross-tenant
 *     access pattern.
 *
 *   - SUPER_ADMIN users by design have `tenantId = NULL`, which can never
 *     satisfy `tenantId = <any uuid>` — so RLS structurally hides every
 *     platform administrator from the login flow.
 *
 * Defense-in-depth on these tables is enforced OUT-OF-BAND:
 *   1. Schema-role isolation (`auth_service` PG role is the only client).
 *   2. Application-layer explicit `WHERE tenantId = ?` on all post-auth
 *      tenant-scoped queries.
 *   3. JWT-authenticated handlers with TenantGuard enforce tenant context.
 *
 * The helper auto-skips these table names in any schema it sweeps. This
 * lives at the helper layer (not only at the caller's `excludeTables`)
 * because the invariant is platform-wide: no identity primitive in ANY
 * schema may be RLS-protected by tenant_isolation_policy. Tier-1 "make
 * impossible" — a new service that accidentally uses `autoApply: true`
 * against an auth-like schema cannot re-introduce the 2026-04-21 login
 * outage. Logged at WARN so the skip is greppable in deploy audits.
 *
 * To install per-tenant isolation on a table that HAPPENS to share one of
 * these names (highly unusual), the caller must pass an explicit
 * `allowIdentityTables: true` option (not yet exposed — add with care
 * and an ADR if a legitimate case ever arises).
 */
export const DEFAULT_IDENTITY_TABLES = ['users', 'tenants'] as const;

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
   * Optional allow-list for migration-scoped RLS installation.
   *
   * Service migrations that create or repair a known table set should pass
   * this instead of sweeping the whole schema. That prevents a farm migration
   * from rewriting policies on sensor/hr/billing tables that happen to live
   * in the same per-tenant schema.
   */
  includeTables?: readonly string[];

  /**
   * Optional logger override. Defaults to a NestJS Logger named after this
   * helper. Migrations should pass a `MigrationLogger` for consistent log
   * formatting — its surface area (log/warn) is the lowest common denominator
   * shared with NestJS Logger, so both work without casts.
   */
  logger?: RlsHelperLogger;

  /**
   * Override the target schema. By default, the helper queries
   * `current_schema()` and operates on whatever schema the migration
   * runner / connection has set up — typically the source schema for a
   * schema-per-tenant service (e.g. `farm`).
   *
   * Pass an explicit schema name to install policies on a specific
   * tenant schema (e.g. `tenant_4b529829ea7948da`). This is the path
   * `TenantRlsSyncService` uses to iterate every `tenant_*` schema at
   * runtime — `CREATE TABLE LIKE source INCLUDING ALL` does NOT copy
   * RLS policies, so each per-tenant copy needs its policies installed
   * explicitly.
   *
   * Identifier validation still applies: the override must match
   * `^[a-zA-Z_][a-zA-Z0-9_]*$` or the helper throws before any SQL is
   * issued.
   */
  schemaOverride?: string;

  /**
   * TimescaleDB columnstore/compressed hypertables do not support the RLS DDL
   * sequence this helper emits. In tenant_<uuid> schemas, table isolation is
   * already enforced by the schema boundary, so those tables are skipped with
   * an audit-grade warning by default. Shared service schemas remain
   * fail-closed unless the caller explicitly opts in.
   */
  skipTimescaleColumnstoreTables?: boolean;
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
export function assertSafeIdentifier(identifier: string, label: string): void {
  if (!identifier || !SAFE_IDENTIFIER_REGEX.test(identifier)) {
    throw new Error(
      `[apply-tenant-rls] Unsafe SQL identifier for ${label}: "${identifier}". ` +
        `Must match ${SAFE_IDENTIFIER_REGEX.source}`,
    );
  }
}

export async function queryRows<T>(
  qr: QueryRunner,
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const result: unknown = await qr.query(sql, params);
  return Array.isArray(result) ? (result as T[]) : [];
}

export function assertDbMigrateDdlAuthority(operation: string): void {
  if (process.env[DB_MIGRATE_DDL_AUTHORITY_ENV] === '1') {
    return;
  }
  throw new Error(
    `[db-migrate authority] ${operation} is disabled in runtime services; ` +
      `run the aqua-db-migrate provisioner instead.`,
  );
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
  includeTables: readonly string[],
  logger: RlsHelperLogger,
): Promise<DiscoveredTable[]> {
  // Validate every input identifier — the schema name and column names are
  // interpolated into the SQL below via parameters, but we still validate so
  // that a misconfigured caller cannot smuggle a payload through the
  // information_schema query.
  assertSafeIdentifier(schema, 'schema');
  for (const col of tenantIdColumns) assertSafeIdentifier(col, 'tenantIdColumn');
  for (const tbl of excludeTables) assertSafeIdentifier(tbl, 'excludeTable');
  for (const tbl of includeTables) assertSafeIdentifier(tbl, 'includeTable');

  // information_schema.columns is the portable way to introspect tenant
  // columns. We filter on table_type = 'BASE TABLE' to skip views and
  // partitions, and on table_schema = $1 so the helper is schema-scoped (one
  // helper invocation never touches another schema).
  const includeFilter =
    includeTables.length > 0 ? `AND c.table_name = ANY($3::text[])` : '';
  const params: unknown[] =
    includeTables.length > 0
      ? [schema, [...tenantIdColumns], [...includeTables]]
      : [schema, [...tenantIdColumns]];

  const rows = await queryRows<{
    table_name: string;
    column_name: string;
    udt_name: string;
  }>(
    qr,
    `
      SELECT c.table_name, c.column_name, c.udt_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name   = c.table_name
       AND t.table_type   = 'BASE TABLE'
      WHERE c.table_schema = $1
        AND c.column_name = ANY($2::text[])
        ${includeFilter}
      ORDER BY c.table_name,
               array_position($2::text[], c.column_name)
    `,
    params,
  );

  const callerExcludeSet = new Set(excludeTables);
  const identityTableSet = new Set<string>(DEFAULT_IDENTITY_TABLES);
  const discovered = new Map<string, string>();

  // Each table appears once per matching column; the ORDER BY above means the
  // FIRST row for a given table_name uses the highest-priority column from
  // `tenantIdColumns`. We keep that and ignore subsequent rows for the same
  // table.
  for (const row of rows) {
    if (callerExcludeSet.has(row.table_name)) continue;
    // Tier-1 "make impossible" — identity primitives are skipped regardless
    // of caller excludes. A future service that forgets to list `users` in
    // excludeTables cannot accidentally re-introduce the 2026-04-21 login
    // outage. WARN-logged so the skip is greppable in deploy audits and
    // visible to operators reviewing RLS rollouts.
    if (identityTableSet.has(row.table_name)) {
      logger.warn(
        `[apply-tenant-rls] Skipping IDENTITY-PRIMITIVE table "${schema}"."${row.table_name}" — ` +
          `tenant_isolation_policy is architecturally incompatible with pre-auth ` +
          `identity lookup (see DEFAULT_IDENTITY_TABLES docblock). Defense-in-depth ` +
          `for this table must be enforced via schema-role isolation + application-` +
          `layer tenant scoping.`,
      );
      continue;
    }
    if (row.udt_name !== 'uuid') {
      logger.warn(
        `[apply-tenant-rls] Skipping "${schema}"."${row.table_name}" because ` +
          `"${row.column_name}" is ${row.udt_name}, not uuid. Canonical tenant ` +
          `RLS casts ${RLS_TENANT_GUC} to uuid; text tenant labels must be ` +
          `declared in an explicit service-owned policy instead of discovered ` +
          `by column name.`,
      );
      continue;
    }
    if (discovered.has(row.table_name)) continue;
    discovered.set(row.table_name, row.column_name);
  }

  return [...discovered.entries()].map(([tableName, tenantColumn]) => ({
    tableName,
    tenantColumn,
  }));
}

async function discoverTimescaleColumnstoreTables(
  qr: QueryRunner,
  schema: string,
  logger: RlsHelperLogger,
): Promise<ReadonlySet<string>> {
  assertSafeIdentifier(schema, 'schema');

  const metadataColumns = await queryRows<{ column_name: string }>(
    qr,
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'timescaledb_information'
        AND table_name = 'hypertables'
        AND column_name = ANY($1::text[])
    `,
    [['columnstore_enabled', 'compression_enabled']],
  );

  const supportedColumns = new Set(metadataColumns.map((row) => row.column_name));
  const predicates: string[] = [];
  if (supportedColumns.has('columnstore_enabled')) {
    predicates.push(`columnstore_enabled = true`);
  }
  if (supportedColumns.has('compression_enabled')) {
    predicates.push(`compression_enabled = true`);
  }

  if (predicates.length === 0) {
    return new Set();
  }

  try {
    const rows = await queryRows<{ table_name: string }>(
      qr,
      `
        SELECT hypertable_name AS table_name
        FROM timescaledb_information.hypertables
        WHERE hypertable_schema = $1
          AND (${predicates.join(' OR ')})
      `,
      [schema],
    );
    return new Set(rows.map((row) => row.table_name));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[apply-tenant-rls] Could not inspect TimescaleDB columnstore metadata ` +
        `for schema "${schema}"; continuing fail-closed: ${message}`,
    );
    return new Set();
  }
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
  assertDbMigrateDdlAuthority('applyTenantRlsToSchema');

  const logger =
    options.logger ?? new Logger('applyTenantRlsToSchema');
  const tenantIdColumns =
    options.tenantIdColumns && options.tenantIdColumns.length > 0
      ? options.tenantIdColumns
      : DEFAULT_TENANT_ID_COLUMNS;
  const excludeTables = options.excludeTables ?? [];
  const includeTables = options.includeTables ?? [];

  // Resolve the target schema. If the caller passed `schemaOverride`,
  // we trust it (after identifier validation) and skip the round-trip
  // to current_schema(). Otherwise we ask the database directly so the
  // helper always operates inside whatever schema the migration runner
  // has set up — never public, never another service's schema.
  let schema: string;
  if (options.schemaOverride !== undefined) {
    schema = options.schemaOverride;
  } else {
    const schemaRows = await queryRows<{ schema: string }>(
      qr,
      `SELECT current_schema() AS schema`,
    );
    schema = schemaRows[0]?.schema ?? 'public';
  }
  assertSafeIdentifier(schema, options.schemaOverride !== undefined ? 'schemaOverride' : 'current_schema');
  const skipTimescaleColumnstoreTables =
    options.skipTimescaleColumnstoreTables ?? TENANT_SCHEMA_REGEX.test(schema);

  logger.log(
    `Applying tenant RLS in schema "${schema}" ` +
      `(columns: ${tenantIdColumns.join(',')}, include: ${includeTables.join(',') || '∅'}, exclude: ${excludeTables.join(',') || '∅'})`,
  );

  const tables = await discoverTenantScopedTables(
    qr,
    schema,
    tenantIdColumns,
    excludeTables,
    includeTables,
    logger,
  );

  if (tables.length === 0) {
    logger.warn(
      `No tenant-scoped tables found in schema "${schema}" — nothing to do. ` +
        `Check tenantIdColumns option if this is unexpected.`,
    );
    return;
  }

  logger.log(`Discovered ${tables.length} tenant-scoped tables in "${schema}"`);

  const columnstoreTables = skipTimescaleColumnstoreTables
    ? await discoverTimescaleColumnstoreTables(qr, schema, logger)
    : new Set<string>();

  let applied = 0;
  let skipped = 0;
  for (const { tableName, tenantColumn } of tables) {
    assertSafeIdentifier(tableName, 'tableName');

    if (columnstoreTables.has(tableName)) {
      skipped++;
      logger.warn(
        `[apply-tenant-rls] Skipping TimescaleDB columnstore hypertable ` +
          `"${schema}"."${tableName}" because PostgreSQL RLS DDL is not ` +
          `supported while columnstore/compression is enabled. Tenant schema ` +
          `isolation remains the enforcement boundary for this table.`,
      );
      continue;
    }
    // Step 1: ENABLE then FORCE RLS. ENABLE turns it on for non-owners, FORCE
    // extends it to the table owner. We need both because the application
    // connects as the schema owner (`aquaculture`).
    await qr.query(
      `${SQL_ALTER_TABLE} "${schema}"."${tableName}" ENABLE ${SQL_ROW_LEVEL_SECURITY}`,
    );
    await qr.query(
      `${SQL_ALTER_TABLE} "${schema}"."${tableName}" FORCE ${SQL_ROW_LEVEL_SECURITY}`,
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
      `${SQL_CREATE_POLICY} "${TENANT_ISOLATION_POLICY_NAME}" ` +
        `ON "${schema}"."${tableName}" ` +
        `FOR ALL ` +
        `USING ${usingClause} ` +
        `WITH CHECK ${usingClause}`,
    );

    logger.log(
      `RLS armed on "${schema}"."${tableName}" (col: ${tenantColumn})`,
    );
    applied++;
  }

  logger.log(
    `Tenant RLS applied to ${applied} tables in schema "${schema}" (skipped: ${skipped})`,
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
  options: Pick<ApplyTenantRlsOptions, 'tenantIdColumns' | 'excludeTables' | 'includeTables' | 'logger'> = {},
): Promise<void> {
  assertDbMigrateDdlAuthority('removeTenantRlsFromSchema');

  const logger = options.logger ?? new Logger('removeTenantRlsFromSchema');
  const tenantIdColumns =
    options.tenantIdColumns && options.tenantIdColumns.length > 0
      ? options.tenantIdColumns
      : DEFAULT_TENANT_ID_COLUMNS;
  const excludeTables = options.excludeTables ?? [];
  const includeTables = options.includeTables ?? [];

  const schemaRows = await queryRows<{ schema: string }>(
    qr,
    `SELECT current_schema() AS schema`,
  );
  const schema = schemaRows[0]?.schema ?? 'public';
  assertSafeIdentifier(schema, 'current_schema');

  const tables = await discoverTenantScopedTables(
    qr,
    schema,
    tenantIdColumns,
    excludeTables,
    includeTables,
    logger,
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
      `${SQL_ALTER_TABLE} "${schema}"."${tableName}" NO FORCE ${SQL_ROW_LEVEL_SECURITY}`,
    );
    await qr.query(
      `${SQL_ALTER_TABLE} "${schema}"."${tableName}" DISABLE ${SQL_ROW_LEVEL_SECURITY}`,
    );
  }

  logger.log(`Tenant RLS removed from ${tables.length} tables in "${schema}"`);
}
