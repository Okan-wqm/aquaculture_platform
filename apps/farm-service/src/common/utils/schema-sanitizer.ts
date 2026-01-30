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

/**
 * Creates a sanitized schema name from tenant ID.
 */
export function getTenantSchemaName(tenantId: string): string {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('Invalid tenant ID');
  }

  // Use first 8 characters of tenant ID for schema name
  const schemaName = `tenant_${tenantId.substring(0, 8).toLowerCase()}`;
  return sanitizeSchemaName(schemaName);
}
