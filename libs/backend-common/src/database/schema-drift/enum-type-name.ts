/**
 * Canonical pg_enum type name for an entity enum column.
 *
 * When the entity sets `@Column({ enumName: 'foo' })` that name is the type. Otherwise TypeORM
 * derives `<table>_<column lowercased>_enum` (PostgresQueryRunner.buildEnumName): the COLUMN is
 * lowercased, the table is not. The drift validator reads the same identifier the schema builder
 * wrote, so a camelCase column (`moduleCode`, `employmentType`) is looked up as `..._modulecode_enum`
 * and its labels are actually compared — a derivation that kept the column's case found no such
 * type and reported a missing enum for every such column instead of comparing its labels.
 *
 * Pure and exported so it can be pinned without booting a validator.
 */
export function resolveEnumTypeName(
  enumName: string | undefined,
  tableName: string,
  columnDbName: string,
): string {
  if (enumName && typeof enumName === 'string') return enumName;
  return `${tableName}_${columnDbName.toLowerCase()}_enum`;
}
