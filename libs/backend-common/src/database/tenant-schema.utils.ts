import { DataSource } from 'typeorm';

/**
 * UUID v4 format validator.
 * Shared across middleware, NATS handlers, and cron jobs.
 */
export const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Schema name validation regex.
 * Ensures schema names contain only safe characters for SQL interpolation.
 */
export const SCHEMA_NAME_REGEX = /^[a-z0-9_]+$/;

/**
 * Validate whether a string is a valid UUID v4 format.
 */
export function isValidUUID(id: string): boolean {
  return UUID_V4_REGEX.test(id);
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
