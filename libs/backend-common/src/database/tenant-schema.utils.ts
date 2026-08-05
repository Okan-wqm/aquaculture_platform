import { DataSource } from 'typeorm';

/**
 * UUID format validator (any version). File-local; not exported to avoid
 * a name collision with `security/validators/regex-patterns.ts::UUID_V4_REGEX`
 * (which is strictly v4) now that both subtrees are `export *`-barreled
 * through the root. Previously the old root barrel used explicit named
 * re-exports that masked the duplication. Consumers that need UUID matching
 * outside this file should import from either:
 *   - `@aquaculture/backend-common/constants` (UUID_REGEX, v1-v5, preferred)
 *   - `@aquaculture/backend-common/security` (UUID_V4_REGEX, v4-only)
 *
 * This regex accepts any-version UUIDs and exists solely to back the
 * `isValidUUID()` helper below — callers who want stricter v4 checking
 * should use `UUID_V4_REGEX` from the security sub-barrel.
 */
const UUID_ANY_VERSION_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Schema name validation regex.
 * Ensures schema names contain only safe characters for SQL interpolation.
 */
export const SCHEMA_NAME_REGEX = /^[a-z0-9_]+$/;

export interface TenantSchemaIdentity {
  schemaName: string;
  tenantId: string;
}

/**
 * Validate whether a string is a valid UUID v4 format.
 */
export function isValidUUID(id: string): boolean {
  return UUID_ANY_VERSION_REGEX.test(id);
}

/**
 * Validates a schema name contains only safe characters.
 */
export function isValidSchemaName(name: string): boolean {
  return SCHEMA_NAME_REGEX.test(name);
}

/**
 * Assert that a schema name is safe for SQL interpolation — throws on failure.
 *
 * Use this in migrations that interpolate schema names from information_schema
 * into SQL templates. Although information_schema.schemata is a trusted source,
 * defense-in-depth requires validation before any SQL identifier interpolation.
 *
 * @throws Error if the schema name contains unsafe characters or is too long.
 */
export function assertSafeSchemaName(name: string): void {
  if (!SCHEMA_NAME_REGEX.test(name) || name.length > 63) {
    throw new Error(
      `SECURITY: Unsafe schema name '${name}' rejected before SQL interpolation. ` +
        'Schema names must match ^[a-z0-9_]+$ and be ≤63 chars.',
    );
  }
}

/**
 * Derive the PostgreSQL schema name from a tenant UUID.
 *
 * Format: tenant_{first16_hex_chars_of_uuid_without_dashes}
 * Example: "4b529829-ea79-48da-982c-cd6fbec8ffb7" -> "tenant_4b529829ea7948da"
 *
 * This is a pure function (no DB access, no DI required) so it can be used
 * in middleware, NATS handlers, cron jobs, and MQTT listeners without
 * injecting SchemaManagerService.
 *
 * MUST stay in sync with SchemaManagerService.getTenantSchemaName().
 * SchemaManagerService adds UUID validation and throws BadRequestException;
 * this function does NOT validate -- callers must validate before calling.
 */
export function getTenantSchemaName(tenantId: string): string {
  const cleanId = tenantId.replace(/-/g, '').substring(0, 16).toLowerCase();
  return `tenant_${cleanId}`;
}

/**
 * Query all tenant schema names from information_schema.
 *
 * Used by cron jobs and schedulers that need to iterate over all tenant
 * schemas. Requires a TypeORM DataSource (no NestJS DI dependency).
 *
 * @param dataSource - TypeORM DataSource instance
 * @returns Sorted array of schema names matching 'tenant_%'
 */
export async function listTenantSchemas(dataSource: DataSource): Promise<string[]> {
  const rows: { schema_name: string }[] = await dataSource.query(
    `SELECT schema_name FROM information_schema.schemata
     WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'
     ORDER BY schema_name`,
  );
  return rows.map((r) => r.schema_name);
}

/**
 * Resolve provisioned tenant schemas to their full tenant UUIDs through the
 * db-migrate-owned commit ledger.
 *
 * A schema name contains only the first 16 UUID hex characters, so it cannot
 * be reversed into the RLS identity required by `runInTenantTransaction`.
 * Cross-tenant workers must use this mapping instead of guessing an ID or
 * enabling an unrestricted RLS bypass. The SECURITY DEFINER function exposes
 * only active `{schema_name, tenant_id}` pairs and keeps direct access to
 * `admin.tenant_schemas` outside runtime service roles.
 */
export async function listActiveTenantSchemaIdentities(
  dataSource: DataSource,
): Promise<TenantSchemaIdentity[]> {
  return listVerifiedTenantSchemaIdentities(
    dataSource,
    'platform.list_active_tenant_schema_mappings()',
    'active',
  );
}

/**
 * Resolve every committed physical schema that still retains tenant data.
 *
 * Lifecycle work (secret scrubbing, retention and erasure) must continue for
 * suspended, migrating and pending-deletion tenants even though provider
 * ingestion is intentionally active-only. The platform wrapper is
 * least-privileged and excludes creating/deleted ledger rows.
 */
export async function listRetainedTenantSchemaIdentities(
  dataSource: DataSource,
): Promise<TenantSchemaIdentity[]> {
  return listVerifiedTenantSchemaIdentities(
    dataSource,
    'platform.list_retained_tenant_schema_mappings()',
    'retained',
  );
}

type TenantSchemaMappingFunction =
  | 'platform.list_active_tenant_schema_mappings()'
  | 'platform.list_retained_tenant_schema_mappings()';

async function listVerifiedTenantSchemaIdentities(
  dataSource: DataSource,
  mappingFunction: TenantSchemaMappingFunction,
  mappingKind: 'active' | 'retained',
): Promise<TenantSchemaIdentity[]> {
  const rows: Array<{
    schema_name: string;
    tenant_id: string;
    schema_exists: boolean;
    committed_proof: boolean;
  }> = await dataSource.query(
    `SELECT schema_name, tenant_id::text AS tenant_id
            , schema_exists, committed_proof
       FROM ${mappingFunction}
      ORDER BY schema_name`,
  );

  const schemas = new Set<string>();
  const tenants = new Set<string>();
  return rows.map((row) => {
    assertSafeSchemaName(row.schema_name);
    if (row.schema_exists !== true) {
      throw new Error(
        `${mappingKind} tenant schema ledger entry "${row.schema_name}" has no physical schema`,
      );
    }
    if (row.committed_proof !== true) {
      throw new Error(
        `${mappingKind} tenant schema ledger entry "${row.schema_name}" has no matching committed operation`,
      );
    }
    if (!isValidUUID(row.tenant_id)) {
      throw new Error(
        `Tenant schema ledger returned an invalid tenant UUID for "${row.schema_name}"`,
      );
    }
    if (getTenantSchemaName(row.tenant_id) !== row.schema_name) {
      throw new Error(`Tenant schema ledger mapping mismatch for "${row.schema_name}"`);
    }
    const normalizedTenantId = row.tenant_id.toLowerCase();
    if (schemas.has(row.schema_name) || tenants.has(normalizedTenantId)) {
      throw new Error(`Tenant schema ledger returned a duplicate ${mappingKind} mapping`);
    }
    schemas.add(row.schema_name);
    tenants.add(normalizedTenantId);
    return {
      schemaName: row.schema_name,
      tenantId: normalizedTenantId,
    };
  });
}
