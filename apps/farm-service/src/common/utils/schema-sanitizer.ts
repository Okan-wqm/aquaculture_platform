/**
 * Schema sanitizer utilities.
 *
 * getTenantSchemaName is now provided by @aquaculture/backend-common.
 * This file re-exports it for backward compatibility with existing consumers.
 * New code should import directly from '@aquaculture/backend-common'.
 *
 * @deprecated Import { getTenantSchemaName } from '@aquaculture/backend-common' instead.
 */
export { getTenantSchemaName } from '@aquaculture/backend-common';

/**
 * Sanitizes and validates PostgreSQL schema names to prevent SQL injection.
 * Only allows alphanumeric characters and underscores.
 */
export function sanitizeSchemaName(schemaName: string): string {
  if (!schemaName || typeof schemaName !== 'string') {
    throw new Error('Invalid schema name: must be a non-empty string');
  }

  // Only allow lowercase alphanumeric and underscores
  if (!/^[a-z0-9_]+$/.test(schemaName)) {
    throw new Error(`Invalid schema name: "${schemaName}" contains invalid characters`);
  }

  // Prevent reserved PostgreSQL schema names
  const reserved = ['pg_catalog', 'information_schema', 'pg_toast', 'pg_temp'];
  if (reserved.includes(schemaName.toLowerCase())) {
    throw new Error(`Invalid schema name: "${schemaName}" is a reserved schema`);
  }

  return schemaName;
}
