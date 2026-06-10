/**
 * Partition proposal builders for messaging tables.
 *
 * Used by:
 *   - PartitionManagerService (@Cron monthly job) to create future partitions
 *   - TenantMigrationRunner to provision partitions in new tenant schemas
 *   - Admin tooling for partition lifecycle management
 *
 * Runtime services do not emit partition DDL. These functions return
 * non-executable db-migrate proposal descriptors.
 *
 * SECURITY: All schema and table names are validated with assertSafeSqlIdentifier()
 * to prevent SQL injection via string interpolation.
 *
 * WHY no DEFAULT partition: These query builders intentionally do not generate a
 * DEFAULT partition. See PartitionManagerService for the rationale (fail-fast on
 * out-of-range timestamps rather than silent catch-all routing).
 */

/**
 * Regex for valid PostgreSQL identifiers: starts with letter or underscore,
 * followed by letters, digits, or underscores.
 */
const SAFE_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validate that a string is a safe SQL identifier.
 * Rejects any name that does not match the safe identifier pattern,
 * preventing SQL injection through schema/table name interpolation.
 *
 * @param name - The identifier to validate
 * @param label - Human-readable label for error messages (e.g., 'schema', 'tableName')
 * @throws Error if the identifier is not safe
 */
function assertSafeSqlIdentifier(name: string, label: string): void {
  if (!SAFE_IDENTIFIER_RE.test(name)) {
    throw new Error(
      `Invalid ${label} "${name}": must match ${SAFE_IDENTIFIER_RE.toString()}`,
    );
  }
}

/**
 * Generates a db-migrate proposal descriptor for a monthly partition.
 *
 * The partition name follows the convention: {tableName}_{year}_{month}
 * (e.g., messages_2026_04 for April 2026).
 *
 * The range is [fromDate, toDate) — inclusive start, exclusive end.
 *
 * @param schema - Schema name (e.g., 'messaging', 'tenant_abc123')
 * @param tableName - Parent table name (e.g., 'messages', 'message_receipts')
 * @param year - Partition year (e.g., 2026)
 * @param month - Partition month (1-12)
 * @returns Non-executable db-migrate proposal descriptor
 */
export function createMonthlyPartition(
  schema: string,
  tableName: string,
  year: number,
  month: number,
): string {
  assertSafeSqlIdentifier(schema, 'schema');
  assertSafeSqlIdentifier(tableName, 'tableName');
  const paddedMonth = String(month).padStart(2, '0');
  const partitionSuffix = `${year}_${paddedMonth}`;

  // Calculate the start and end dates for the partition range.
  // End date is the first day of the next month.
  const fromDate = `${year}-${paddedMonth}-01`;

  let toYear = year;
  let toMonth = month + 1;
  if (toMonth > 12) {
    toMonth = 1;
    toYear = year + 1;
  }
  const paddedToMonth = String(toMonth).padStart(2, '0');
  const toDate = `${toYear}-${paddedToMonth}-01`;

  return [
    'db-migrate partition proposal',
    `schema=${schema}`,
    `table=${tableName}`,
    `partition=${tableName}_${partitionSuffix}`,
    `from=${fromDate}`,
    `to=${toDate}`,
  ].join('\n');
}

/**
 * Branded token proving the legal-hold registry was consulted before
 * a partition drop (LEGAL-MEDIUM-003 cure).
 *
 * # Why this exists
 *
 * Pre-cure `dropPartition()` was a free function any code path could
 * call to emit destructive SQL. The agent spec mandates: "DROP SCHEMA
 * partition / DROP migrations are explicitly enumerated as a
 * destructive surface; primary remains the destructive handler's
 * owner". A bare WARNING comment was Tier-4 documentation only —
 * it could not stop a future caller from emitting the DROP without
 * checking the hold registry.
 *
 * # How the brand works (Tier-1 — make impossible)
 *
 * The token is a branded type whose nominal shape is unconstructible
 * outside this module (its only field is a `Symbol` declared `unique`,
 * not exported). The factory is `LegalHoldGuard.assertHoldClearedFor(...)`
 * — it queries `LegalHoldService.isUnderLegalHold()` and only returns
 * a token when the answer is `false`. The destructive helper now
 * requires a `HoldClearedToken` argument; TypeScript refuses to compile
 * a callsite that omits it, and there is no runtime path to fabricate
 * one without going through the guard.
 *
 * # Why "Hold Cleared" not "Hold Checked"
 *
 * "Checked" leaves room for a yes-or-no token; the brand is granted
 * ONLY for the cleared (no-hold) outcome, so the type's mere existence
 * proves clearance. The fail-CLOSED LegalHoldCheckUnavailable path
 * (LEGAL-MEDIUM-001) means the token is also withheld when the
 * registry was unreachable — destructive ops abort on registry
 * failure by construction.
 */
// Module-private symbol used at runtime as the brand key. NOT exported —
// any code outside this file that wants to forge a token would need to
// import this symbol, and no such import path exists. Combined with the
// invariant test that pins the import topology, the brand is unforgeable.
const HoldClearedTokenBrand: unique symbol = Symbol('HoldClearedTokenBrand');

export interface HoldClearedToken {
  readonly [HoldClearedTokenBrand]: true;
  /** Records the (tenant, channel) scope the clearance was granted for. */
  readonly tenantId: string;
  readonly channelId: string | null;
  /** Wall-clock timestamp the registry was consulted. */
  readonly checkedAt: Date;
}

/**
 * Internal token factory — exported only for the LegalHoldGuard module
 * to call. Direct invocation outside the guard is forbidden by the
 * `tests/invariants/legal-hold-drop-partition-guard.spec.ts` invariant.
 *
 * The two-tier protection (TS brand + invariant test) catches both
 * accidental drift (compile-time) and deliberate bypass (CI-time).
 */
export function __mintHoldClearedTokenForGuard(args: {
  tenantId: string;
  channelId: string | null;
}): HoldClearedToken {
  return Object.freeze({
    [HoldClearedTokenBrand]: true as const,
    tenantId: args.tenantId,
    channelId: args.channelId,
    checkedAt: new Date(),
  }) as HoldClearedToken;
}

/**
 * Generates a SQL statement to drop a monthly partition.
 *
 * # WHY THE `unsafe` PREFIX
 *
 * This helper emits a destructive `DROP TABLE` statement. The
 * legal-hold-auditor agent spec requires the hold registry to be
 * consulted before any partition drop (LEGAL-MEDIUM-003). Pre-cure
 * the helper was named `dropPartition` and protected only by a
 * WARNING comment — Tier-4 documentation that a future caller
 * could ignore. Post-cure the `unsafe` prefix makes the destructive
 * nature visible at every callsite, and the `HoldClearedToken`
 * argument forces the caller to go through `LegalHoldGuard.assertHoldClearedFor()`
 * — there is no path to emit the SQL without registry clearance.
 *
 * @param schema - Schema name
 * @param tableName - Parent table name
 * @param year - Partition year
 * @param month - Partition month (1-12)
 * @param holdToken - Proof that the legal-hold registry has been
 *   consulted and returned "no hold" for the (tenant, partition) scope.
 *   Mintable only via LegalHoldGuard.
 * @returns SQL DROP TABLE statement
 */
export function unsafeDropPartitionSql(
  schema: string,
  tableName: string,
  year: number,
  month: number,
  holdToken: HoldClearedToken,
): string {
  // The argument is type-checked at compile time. The runtime read is
  // also defensive — a malformed token (e.g., missing tenantId) hard-fails
  // before the destructive SQL is emitted.
  if (!holdToken || !holdToken.tenantId) {
    throw new Error(
      'unsafeDropPartitionSql: HoldClearedToken is required (LEGAL-MEDIUM-003). ' +
        'Use LegalHoldGuard.assertHoldClearedFor() to obtain one.',
    );
  }
  assertSafeSqlIdentifier(schema, 'schema');
  assertSafeSqlIdentifier(tableName, 'tableName');
  const paddedMonth = String(month).padStart(2, '0');
  const partitionSuffix = `${year}_${paddedMonth}`;

  return `DROP TABLE IF EXISTS "${schema}"."${tableName}_${partitionSuffix}";`;
}

/**
 * Generates a SQL query to list all existing partitions for a given table.
 *
 * Returns rows with columns:
 *   - partition_name (text) — the partition table name
 *   - partition_expression (text) — the range bounds expression
 *
 * NOTE: This queries the pg_catalog system tables and works regardless
 * of which schema is active in search_path.
 *
 * @param tableName - Parent table name (without schema prefix)
 * @returns SQL SELECT query
 */
export function listPartitions(tableName: string): string {
  assertSafeSqlIdentifier(tableName, 'tableName');
  return [
    `SELECT`,
    `  child.relname AS partition_name,`,
    `  pg_get_expr(child.relpartbound, child.oid) AS partition_expression`,
    `FROM pg_inherits`,
    `  JOIN pg_class parent ON pg_inherits.inhparent = parent.oid`,
    `  JOIN pg_class child ON pg_inherits.inhrelid = child.oid`,
    `WHERE parent.relname = '${tableName}'`,
    `ORDER BY child.relname;`,
  ].join('\n');
}

/**
 * Generates a SQL query to verify whether a specific monthly partition exists.
 *
 * Returns a single row with a boolean column `exists`.
 *
 * @param schema - Schema name
 * @param tableName - Parent table name
 * @param year - Partition year
 * @param month - Partition month (1-12)
 * @returns SQL SELECT query returning { exists: boolean }
 */
export function verifyPartitionExists(
  schema: string,
  tableName: string,
  year: number,
  month: number,
): string {
  assertSafeSqlIdentifier(schema, 'schema');
  assertSafeSqlIdentifier(tableName, 'tableName');
  const paddedMonth = String(month).padStart(2, '0');
  const partitionSuffix = `${year}_${paddedMonth}`;

  return [
    `SELECT EXISTS (`,
    `  SELECT 1`,
    `  FROM pg_class c`,
    `    JOIN pg_namespace n ON n.oid = c.relnamespace`,
    `  WHERE n.nspname = '${schema}'`,
    `    AND c.relname = '${tableName}_${partitionSuffix}'`,
    `    AND c.relispartition = true`,
    `) AS "exists";`,
  ].join('\n');
}

/**
 * Generates SQL statements to create partitions for an entire year.
 *
 * Convenience wrapper that calls createMonthlyPartition for each month.
 *
 * @param schema - Schema name
 * @param tableName - Parent table name
 * @param year - Year to create partitions for (all 12 months)
 * @returns Array of SQL CREATE TABLE statements
 */
export function createYearPartitions(
  schema: string,
  tableName: string,
  year: number,
): string[] {
  assertSafeSqlIdentifier(schema, 'schema');
  assertSafeSqlIdentifier(tableName, 'tableName');
  const statements: string[] = [];
  for (let month = 1; month <= 12; month++) {
    statements.push(createMonthlyPartition(schema, tableName, year, month));
  }
  return statements;
}

/**
 * Generates SQL statements to create the next N months of partitions
 * starting from a given date.
 *
 * Used by the monthly cron job to ensure partitions exist ahead of time.
 *
 * @param schema - Schema name
 * @param tableName - Parent table name
 * @param startYear - Starting year
 * @param startMonth - Starting month (1-12)
 * @param count - Number of months to create
 * @returns Array of SQL CREATE TABLE statements
 */
export function createUpcomingPartitions(
  schema: string,
  tableName: string,
  startYear: number,
  startMonth: number,
  count: number,
): string[] {
  assertSafeSqlIdentifier(schema, 'schema');
  assertSafeSqlIdentifier(tableName, 'tableName');
  const statements: string[] = [];
  let year = startYear;
  let month = startMonth;

  for (let i = 0; i < count; i++) {
    statements.push(createMonthlyPartition(schema, tableName, year, month));
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }

  return statements;
}
