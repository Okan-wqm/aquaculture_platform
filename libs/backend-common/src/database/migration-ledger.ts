/**
 * Canonical TypeORM migration ledger table name.
 *
 * TypeORM defaults to `migrations`; db-migrate, service DataSources,
 * tenant-schema seeding, bootstrap tests, and operator SQL must all use the
 * same source-schema table name. Allowing mixed names makes
 * baseline-vs-forward decisions ambiguous after a partial deploy.
 */
export const MIGRATION_LEDGER_TABLE = 'migrations' as const;

const SAFE_SCHEMA_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Tenant schemas host tables for multiple source schemas. Using one shared
 * TypeORM ledger there makes identical migration names such as
 * `Baseline1800000000000` collide across services. Keep source schemas on
 * TypeORM's canonical `migrations` table, but namespace tenant ledgers by
 * source schema.
 */
export function tenantMigrationLedgerTable(sourceSchema: string): string {
  if (!SAFE_SCHEMA_RE.test(sourceSchema)) {
    throw new Error(`Unsafe source schema for tenant migration ledger: ${sourceSchema}`);
  }
  return `${MIGRATION_LEDGER_TABLE}_${sourceSchema}`;
}
