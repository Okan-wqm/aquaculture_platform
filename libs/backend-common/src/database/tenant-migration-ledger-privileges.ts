import { tenantMigrationLedgerTable } from './migration-ledger';
import { TENANT_SCHEMA_NAME_RE } from './tenant-aware-schemas';

const SAFE_SQL_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface TenantMigrationLedgerQueryExecutor {
  query(sql: string, parameters?: readonly unknown[]): Promise<unknown>;
}

export interface TenantMigrationLedgerReadGrantOptions {
  tenantSchema: string;
  sourceSchema: string;
  serviceRole?: string;
}

export interface TenantMigrationLedgerReadGrant {
  tenantSchema: string;
  sourceSchema: string;
  tenantLedger: string;
  serviceRole: string;
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!SAFE_SQL_IDENTIFIER_RE.test(value)) {
    throw new Error(`[tenant-ledger-grants] Unsafe ${label}: "${value}".`);
  }
}

function assertTenantSchema(value: string): void {
  assertSafeIdentifier(value, 'tenant schema');
  if (!TENANT_SCHEMA_NAME_RE.test(value)) {
    throw new Error(
      `[tenant-ledger-grants] Refusing non-tenant schema "${value}". ` +
        `Expected ${TENANT_SCHEMA_NAME_RE.toString()}.`,
    );
  }
}

export function serviceRoleForTenantAwareSchema(sourceSchema: string): string {
  assertSafeIdentifier(sourceSchema, 'source schema');
  return `${sourceSchema}_service`;
}

export function buildTenantMigrationLedgerReadGrant(
  options: TenantMigrationLedgerReadGrantOptions,
): TenantMigrationLedgerReadGrant {
  assertTenantSchema(options.tenantSchema);
  assertSafeIdentifier(options.sourceSchema, 'source schema');

  const tenantLedger = tenantMigrationLedgerTable(options.sourceSchema);
  const serviceRole = options.serviceRole ?? serviceRoleForTenantAwareSchema(options.sourceSchema);
  assertSafeIdentifier(serviceRole, 'service role');

  return {
    tenantSchema: options.tenantSchema,
    sourceSchema: options.sourceSchema,
    tenantLedger,
    serviceRole,
  };
}

/**
 * Grant the least privilege a runtime service needs to pass SchemaVersionGate
 * for a tenant-aware schema: schema USAGE plus read access to its own
 * tenant-scoped TypeORM ledger. Runtime services must not mutate ledgers in
 * production; aqua-db-migrate remains the sole migration writer.
 */
export async function grantTenantMigrationLedgerReadAccess(
  executor: TenantMigrationLedgerQueryExecutor,
  options: TenantMigrationLedgerReadGrantOptions,
): Promise<TenantMigrationLedgerReadGrant> {
  const grant = buildTenantMigrationLedgerReadGrant(options);

  await executor.query(
    `GRANT USAGE ON SCHEMA "${grant.tenantSchema}" TO "${grant.serviceRole}"`,
  );
  await executor.query(
    `GRANT SELECT ON TABLE "${grant.tenantSchema}"."${grant.tenantLedger}" ` +
      `TO "${grant.serviceRole}"`,
  );

  return grant;
}
