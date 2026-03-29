/**
 * Pure SQL query builders for partition operations on messaging tables.
 *
 * Used by:
 *   - PartitionManagerService (@Cron monthly job) to create future partitions
 *   - TenantMigrationRunner to provision partitions in new tenant schemas
 *   - Admin tooling for partition lifecycle management
 *
 * All functions return raw SQL strings. The caller is responsible for
 * executing them via QueryRunner or DataSource.query().
 *
 * SECURITY: All schema and table names are validated with assertSafeSqlIdentifier()
 * to prevent SQL injection via string interpolation.
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
 * Generates a SQL statement to create a monthly partition for a given table.
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
 * @returns SQL CREATE TABLE ... PARTITION OF statement
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
    `CREATE TABLE IF NOT EXISTS "${schema}"."${tableName}_${partitionSuffix}"`,
    `  PARTITION OF "${schema}"."${tableName}"`,
    `  FOR VALUES FROM ('${fromDate}') TO ('${toDate}');`,
  ].join('\n');
}

/**
 * Generates a SQL statement to drop a monthly partition.
 *
 * WARNING: This permanently deletes all data in the partition.
 * Use for retention cleanup only after confirming the data retention
 * policy allows it.
 *
 * @param schema - Schema name
 * @param tableName - Parent table name
 * @param year - Partition year
 * @param month - Partition month (1-12)
 * @returns SQL DROP TABLE statement
 */
export function dropPartition(
  schema: string,
  tableName: string,
  year: number,
  month: number,
): string {
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
