import { Logger } from '@nestjs/common';
import { QueryRunner } from 'typeorm';

import { assertRuntimeDdlAllowed } from './db-migrate-authority.util';
import { executeQueryRowsNormalized } from './query-result-normalizer';

/**
 * convertAuditColumnsToTimestamptz
 * ============================================================================
 *
 * Companion to `apps/auth-service/.../1781100000000-ConvertTimestampToTimestamptz.ts`
 * (and the admin-api equivalent), but targeted at TypeORM
 * `@CreateDateColumn()` and `@UpdateDateColumn()` columns that the
 * Phase 2 C-1 migrations missed.
 *
 * # Why this is needed (NEW-H1)
 *
 * The Phase 2 C-1 migrations only converted columns declared with
 * explicit `type: 'timestamp'`. Columns declared via the bare
 * `@CreateDateColumn()` and `@UpdateDateColumn()` decorators (no
 * explicit `type`) inherit the postgres driver's default, which is
 * **`timestamp without time zone`** — confirmed in the TypeORM source:
 *
 *     // node_modules/typeorm/.../driver/postgres/PostgresDriver.js:170
 *     createDate: "timestamp",
 *     createDateDefault: "now()",
 *
 * Therefore 154 forensic audit columns across 8 services were left on
 * `TIMESTAMP WITHOUT TIME ZONE`, with the same DST drift bug C-1 was
 * meant to fix. `createdAt`/`updatedAt` are the foundation of the
 * audit trail — a ±1h drift on these is a compliance finding for any
 * service that records security-sensitive events.
 *
 * # What this helper does
 *
 * 1. Discovers every column in `current_schema()` (or `schemaOverride`)
 *    whose name matches one of `auditColumns` AND whose type is
 *    `timestamp without time zone`. Already-converted columns are
 *    skipped at the discovery layer — the helper is naturally
 *    idempotent.
 * 2. Groups results by table so each table's ALTER fires as a single
 *    multi-clause statement, minimising the number of table rewrites
 *    PostgreSQL does.
 * 3. Issues `ALTER TABLE "schema"."table" ALTER COLUMN "col" TYPE
 *    TIMESTAMPTZ USING "col" AT TIME ZONE 'UTC'` per qualifying column.
 *    Same `AT TIME ZONE 'UTC'` semantics as the C-1 migrations: our
 *    container fleet runs `TZ=UTC`, Node.js `new Date()` produces UTC
 *    wall-clock values, and the postgres session `TimeZone` GUC is
 *    `UTC`, so existing rows are already-UTC instants and re-stamping
 *    is a semantic no-op.
 * 4. Logs the session `TimeZone` GUC at the start as an audit
 *    artefact. An unexpected value is a warning sign that needs
 *    operator review before deploy.
 *
 * # Why dynamic discovery, not a hard-coded table list
 *
 * The same finding affects 7 services, each with its own table
 * inventory. A hard-coded table list would mean per-service maintenance
 * for every new entity. Discovery via `information_schema.columns` lets
 * the helper handle every existing entity AND every future entity that
 * uses the bare `@CreateDateColumn()` decorator without modification.
 *
 * # When to call
 *
 * - From a TypeORM migration in services with a migration runner
 *   (auth, admin-api, farm, sensor, messaging).
 * - From `AuditColumnsBootstrap` in services without one
 *   (hr, billing, notification, config, ai).
 *
 * # Locking
 *
 * `ALTER COLUMN ... TYPE TIMESTAMPTZ USING ... AT TIME ZONE 'UTC'`
 * acquires `ACCESS EXCLUSIVE LOCK` and rewrites the table. The audit
 * columns are typically present on every table in a service, so
 * cumulative lock time scales with table count × table size. Audit
 * tables (`activity_logs`, `slow_query_logs`) can be large; consider
 * running this off-hours or via `CREATE INDEX CONCURRENTLY`-style
 * out-of-band procedures for tables past ~10M rows. The helper
 * documents this in its log output so operators see the per-table
 * progress.
 *
 * # Related skill rule
 *
 * `database-design:postgresql` — *"DO NOT use `timestamp` (without time
 * zone); DO use `timestamptz` instead."* The fix here is the second
 * half of the C-1 work that closes the audit-column blind spot.
 */

/** Allowed identifier pattern — letters, digits, underscores. */
const SAFE_IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Default audit column names to discover. Covers both camelCase
 * (TypeORM default for `@CreateDateColumn()`) and snake_case (used by
 * `farm-service.BaseEntity` via explicit `name:` mapping).
 */
const DEFAULT_AUDIT_COLUMNS = ['createdAt', 'updatedAt', 'created_at', 'updated_at'] as const;

/**
 * WHY delegation: the legality decision ("db-migrate container → allowed;
 * authoritative runtime service → forbidden; local/test → allowed") lives
 * ONCE in `assertRuntimeDdlAllowed` so this helper can never drift from
 * the RLS bootstraps that consult the same contract.
 */
function assertDbMigrateDdlAuthority(operation: string): void {
  assertRuntimeDdlAllowed({ serviceName: 'audit-columns-helper', operation });
}

export interface ConvertAuditColumnsOptions {
  /**
   * Override the target schema. By default, the helper queries
   * `current_schema()` so it operates on whatever schema the migration
   * runner / connection has set up. Pass an explicit name when
   * iterating tenant schemas at runtime.
   */
  schemaOverride?: string;

  /**
   * Audit column names to discover. Defaults to
   * `['createdAt', 'updatedAt', 'created_at', 'updated_at']` to handle
   * both naming conventions used across the platform.
   */
  auditColumns?: readonly string[];

  /**
   * Tables to skip — typically infrastructure tables that intentionally
   * use TIMESTAMP (e.g., a partition key that needs to be partitionable
   * by RANGE on a non-tz value, though this is rare).
   */
  excludeTables?: readonly string[];

  /**
   * Optional logger. Defaults to a NestJS Logger named after this
   * helper. Migrations should pass a `MigrationLogger` for consistent
   * formatting.
   */
  logger?: ConvertAuditColumnsLogger;
}

/**
 * Minimal logger surface — same shape as the RLS helper's logger so
 * MigrationLogger and Nest Logger both satisfy without adapter shims.
 */
export interface ConvertAuditColumnsLogger {
  log(message: string): void;
  warn(message: string): void;
}

/** A discovered column awaiting conversion. */
interface DiscoveredAuditColumn {
  tableName: string;
  columnName: string;
}

/**
 * Validate an identifier against `SAFE_IDENTIFIER_REGEX`. Throws on
 * mismatch. Same SQL injection guard the RLS helper uses.
 */
function assertSafeIdentifier(identifier: string, label: string): void {
  if (!identifier || !SAFE_IDENTIFIER_REGEX.test(identifier)) {
    throw new Error(
      `[convert-audit-columns] Unsafe SQL identifier for ${label}: "${identifier}". ` +
        `Must match ${SAFE_IDENTIFIER_REGEX.source}`,
    );
  }
}

/**
 * Discover every base-table column that:
 *   - lives in the given `schema`
 *   - has a name in `auditColumns`
 *   - has type `timestamp without time zone`
 *
 * The third filter is what makes this helper idempotent — already-
 * converted (`timestamptz`) columns are excluded at the database level,
 * so re-running is free.
 */
async function discoverAuditColumns(
  qr: QueryRunner,
  schema: string,
  auditColumns: readonly string[],
  excludeTables: readonly string[],
): Promise<DiscoveredAuditColumn[]> {
  assertSafeIdentifier(schema, 'schema');
  for (const col of auditColumns) assertSafeIdentifier(col, 'auditColumn');
  for (const tbl of excludeTables) assertSafeIdentifier(tbl, 'excludeTable');

  // information_schema.columns surfaces both the column name and the
  // data type. We filter on `data_type = 'timestamp without time zone'`
  // (the standard SQL spelling for naked TIMESTAMP) so columns already
  // converted to `timestamp with time zone` are skipped.
  const rows = await executeQueryRowsNormalized<{
    table_name: string;
    column_name: string;
  }>(
    qr,
    `
      SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name = c.table_name
       AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = $1
        AND c.column_name = ANY($2::text[])
        AND c.data_type = 'timestamp without time zone'
      ORDER BY c.table_name, c.column_name
      `,
    [schema, [...auditColumns]],
  );

  const excludeSet = new Set(excludeTables);
  return rows
    .filter((r) => !excludeSet.has(r.table_name))
    .map((r) => ({ tableName: r.table_name, columnName: r.column_name }));
}

/**
 * Convert every discovered audit column from TIMESTAMP to TIMESTAMPTZ.
 *
 * Idempotent: rerun is a no-op because the discovery query filters
 * already-converted columns.
 *
 * @example
 * ```ts
 * // From a migration:
 * await convertAuditColumnsToTimestamptz(queryRunner, {
 *   excludeTables: ['outbox', 'audit_logs'],
 * });
 * ```
 *
 * @example
 * ```ts
 * // From AuditColumnsBootstrap (services without migration runner):
 * await convertAuditColumnsToTimestamptz(queryRunner, {
 *   logger: this.logger,
 * });
 * ```
 */
export async function convertAuditColumnsToTimestamptz(
  qr: QueryRunner,
  options: ConvertAuditColumnsOptions = {},
): Promise<void> {
  assertDbMigrateDdlAuthority('convertAuditColumnsToTimestamptz');

  const logger = options.logger ?? new Logger('convertAuditColumnsToTimestamptz');
  const auditColumns =
    options.auditColumns && options.auditColumns.length > 0
      ? options.auditColumns
      : DEFAULT_AUDIT_COLUMNS;
  const excludeTables = options.excludeTables ?? [];

  // Resolve target schema (mirrors apply-tenant-rls.helper pattern).
  let schema: string;
  if (options.schemaOverride !== undefined) {
    schema = options.schemaOverride;
  } else {
    const schemaRows = await executeQueryRowsNormalized<{ schema: string }>(
      qr,
      `SELECT current_schema() AS schema`,
    );
    schema = schemaRows[0]?.schema ?? 'public';
  }
  assertSafeIdentifier(
    schema,
    options.schemaOverride !== undefined ? 'schemaOverride' : 'current_schema',
  );

  // Audit-grade context: log the session TimeZone before any ALTERs.
  // Our entire conversion semantics depend on the assumption that
  // existing TIMESTAMP values were written by a UTC-pinned process.
  // An unexpected session TZ is a deploy-time signal for review.
  const tzRows = await executeQueryRowsNormalized<{ setting: string }>(
    qr,
    `SELECT setting FROM pg_settings WHERE name = 'TimeZone'`,
  );
  const sessionTz = tzRows[0]?.setting ?? 'unknown';

  logger.log(
    `Converting audit columns to TIMESTAMPTZ in schema "${schema}" ` +
      `(audit cols: ${auditColumns.join(',')}, ` +
      `exclude: ${excludeTables.join(',') || '∅'}, ` +
      `session TZ: ${sessionTz})`,
  );

  const discovered = await discoverAuditColumns(qr, schema, auditColumns, excludeTables);

  if (discovered.length === 0) {
    logger.log(
      `No TIMESTAMP-typed audit columns found in schema "${schema}" — ` +
        `nothing to convert. (Either already migrated, or no qualifying ` +
        `tables exist in this environment.)`,
    );
    return;
  }

  // Group columns by table so we can fold all conversions for a single
  // table into one ALTER TABLE statement. PostgreSQL rewrites the table
  // once per statement regardless of how many ALTER COLUMN clauses it
  // contains, so batching cuts the rewrite count from N to 1.
  const byTable = new Map<string, string[]>();
  for (const { tableName, columnName } of discovered) {
    const existing = byTable.get(tableName);
    if (existing) {
      existing.push(columnName);
    } else {
      byTable.set(tableName, [columnName]);
    }
  }

  logger.log(`Found ${discovered.length} columns across ${byTable.size} tables in "${schema}"`);

  for (const [tableName, columns] of byTable.entries()) {
    assertSafeIdentifier(tableName, 'tableName');

    // Build the ALTER TABLE clause. Quoted "camelCase" is required
    // because both the bare TypeORM default (`createdAt`) and the
    // farm BaseEntity snake_case (`created_at`) need to round-trip
    // unchanged through the SQL parser.
    const clauses = columns
      .map((col) => `ALTER COLUMN "${col}" TYPE TIMESTAMPTZ USING "${col}" AT TIME ZONE 'UTC'`)
      .join(', ');

    logger.log(`Converting "${schema}"."${tableName}": ${columns.join(', ')}`);

    await qr.query(`ALTER TABLE "${schema}"."${tableName}" ${clauses}`);
  }

  logger.log(
    `Audit column conversion complete: ${discovered.length} columns ` +
      `across ${byTable.size} tables in "${schema}"`,
  );
}

/**
 * Reverse the conversion — strip the timezone info from all audit
 * columns in the target schema. The inverse of the `up()` direction:
 * `AT TIME ZONE 'UTC'` against a `timestamptz` returns a wall-clock
 * `timestamp` in UTC, which is byte-identical to the pre-up() state.
 *
 * BREAK-GLASS ONLY. This re-introduces the DST drift bug that
 * motivated the conversion in the first place. Use during incident
 * rollback only.
 */
export async function revertAuditColumnsToTimestamp(
  qr: QueryRunner,
  options: ConvertAuditColumnsOptions = {},
): Promise<void> {
  assertDbMigrateDdlAuthority('revertAuditColumnsToTimestamp');

  const logger = options.logger ?? new Logger('revertAuditColumnsToTimestamp');
  const auditColumns =
    options.auditColumns && options.auditColumns.length > 0
      ? options.auditColumns
      : DEFAULT_AUDIT_COLUMNS;
  const excludeTables = options.excludeTables ?? [];

  let schema: string;
  if (options.schemaOverride !== undefined) {
    schema = options.schemaOverride;
  } else {
    const schemaRows = await executeQueryRowsNormalized<{ schema: string }>(
      qr,
      `SELECT current_schema() AS schema`,
    );
    schema = schemaRows[0]?.schema ?? 'public';
  }
  assertSafeIdentifier(
    schema,
    options.schemaOverride !== undefined ? 'schemaOverride' : 'current_schema',
  );

  // Discovery for the rollback path uses `timestamp with time zone`
  // (the post-up() state) so we only revert what we previously
  // converted, not random columns that happened to use timestamptz
  // for other reasons.
  const rows = await executeQueryRowsNormalized<{
    table_name: string;
    column_name: string;
  }>(
    qr,
    `
      SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name = c.table_name
       AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = $1
        AND c.column_name = ANY($2::text[])
        AND c.data_type = 'timestamp with time zone'
      ORDER BY c.table_name, c.column_name
      `,
    [schema, [...auditColumns]],
  );

  const excludeSet = new Set(excludeTables);
  const filtered = rows.filter((r) => !excludeSet.has(r.table_name));

  if (filtered.length === 0) {
    logger.log(`No timestamptz audit columns to revert in "${schema}"`);
    return;
  }

  logger.warn(
    `Reverting ${filtered.length} audit columns from TIMESTAMPTZ to TIMESTAMP — ` +
      `DST drift risk reintroduced. Break-glass operation only.`,
  );

  const byTable = new Map<string, string[]>();
  for (const { table_name, column_name } of filtered) {
    const existing = byTable.get(table_name);
    if (existing) {
      existing.push(column_name);
    } else {
      byTable.set(table_name, [column_name]);
    }
  }

  for (const [tableName, columns] of byTable.entries()) {
    assertSafeIdentifier(tableName, 'tableName');
    const clauses = columns
      .map((col) => `ALTER COLUMN "${col}" TYPE TIMESTAMP USING "${col}" AT TIME ZONE 'UTC'`)
      .join(', ');
    await qr.query(`ALTER TABLE "${schema}"."${tableName}" ${clauses}`);
    logger.warn(`Reverted "${schema}"."${tableName}": ${columns.join(', ')}`);
  }

  logger.warn('Rollback complete');
}
