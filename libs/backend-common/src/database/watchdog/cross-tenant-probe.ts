import { DataSource } from 'typeorm';

import { getTenantSchemaName, listTenantSchemas, SCHEMA_NAME_REGEX } from '../tenant-schema.utils';

import { WatchdogViolation } from './source-schema-scanner';

/**
 * Regex for safe SQL identifiers returned by information_schema.
 * Allows alphanumeric, underscores. Must start with letter or underscore.
 * Intentionally more permissive than SCHEMA_NAME_REGEX to handle camelCase column names.
 */
const SAFE_SQL_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function probeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * CrossTenantProbe detects data that has leaked between tenant schemas.
 *
 * Each tenant schema should ONLY contain rows belonging to that tenant.
 * Tables that have a `tenant_id` column provide an easy way to verify this:
 * every row's tenant_id should match the tenant who owns the schema.
 *
 * If rows with a foreign tenant_id are found, it indicates a serious
 * isolation failure -- likely caused by a bug in search_path management
 * or a direct cross-schema INSERT.
 */
export class CrossTenantProbe {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Probe all tenant schemas for cross-tenant data contamination.
   *
   * For each tenant schema:
   * 1. Resolve the expected tenantId from the schema name
   * 2. Find tables that have a tenant_id column
   * 3. Check if any rows have a tenant_id that doesn't match the expected one
   *
   * To keep execution time reasonable, we sample up to 10 tables per schema.
   *
   * @returns Array of violations found (empty = clean)
   */
  async probe(): Promise<WatchdogViolation[]> {
    const violations: WatchdogViolation[] = [];
    const schemas = await listTenantSchemas(this.dataSource);

    // Build schema -> tenantId map from the canonical tenant directory. Suspended
    // and archived tenants still retain schemas that must remain covered by the
    // isolation probe; lifecycle state must not create a monitoring blind spot.
    const tenantMap = new Map<string, string>();
    try {
      const tenants: { id: string }[] = await this.dataSource.query(`SELECT id FROM auth.tenants`);
      for (const t of tenants) {
        tenantMap.set(getTenantSchemaName(t.id), t.id);
      }
    } catch (error) {
      throw new Error(
        `Cross-tenant probe could not load the tenant directory: ${probeErrorMessage(error)}`,
      );
    }

    for (const schema of schemas) {
      // Defence-in-depth: validate schema name before interpolation into SQL
      if (!SCHEMA_NAME_REGEX.test(schema)) {
        throw new Error(`Cross-tenant probe rejected unsafe schema name "${schema}"`);
      }

      const expectedTenantId = tenantMap.get(schema);
      if (!expectedTenantId) {
        throw new Error(
          `Cross-tenant probe found schema "${schema}" without a canonical auth.tenants mapping`,
        );
      }

      // Find tables in this schema that have a tenant_id column.
      // Check BOTH snake_case ('tenant_id') and camelCase ('tenantId') because
      // this codebase has no global SnakeNamingStrategy -- some entities use
      // explicit name: 'tenant_id' while others default to camelCase 'tenantId'.
      let tablesWithTenantCol: { table_name: string; column_name: string }[];
      try {
        tablesWithTenantCol = await this.dataSource.query(
          `SELECT DISTINCT table_name, column_name FROM information_schema.columns
           WHERE table_schema = $1 AND column_name IN ('tenant_id', 'tenantId')
           ORDER BY table_name, column_name LIMIT 10`,
          [schema],
        );
      } catch (error) {
        throw new Error(
          `Cross-tenant probe could not discover tenant columns in schema "${schema}": ${probeErrorMessage(error)}`,
        );
      }

      for (const { table_name, column_name } of tablesWithTenantCol) {
        // Validate identifiers from information_schema before SQL interpolation
        if (!SAFE_SQL_IDENTIFIER.test(table_name) || !SAFE_SQL_IDENTIFIER.test(column_name)) {
          throw new Error(
            `Cross-tenant probe rejected unsafe identifier table="${table_name}" column="${column_name}" in schema="${schema}"`,
          );
        }
        try {
          // Use the actual column name found in information_schema (quoted to preserve case)
          const foreignData: { cnt: string }[] = await this.dataSource.query(
            `SELECT COUNT(*) as cnt FROM "${schema}"."${table_name}"
             WHERE "${column_name}" IS NOT NULL AND "${column_name}" != $1`,
            [expectedTenantId],
          );

          const count = parseInt(foreignData[0]?.cnt || '0');
          if (count > 0) {
            violations.push({
              type: 'CROSS_TENANT_DATA',
              severity: 'CRITICAL',
              schema,
              table: table_name,
              details:
                `Found ${count} rows with foreign tenant_id in ${schema}.${table_name} ` +
                `(column: "${column_name}"). ` +
                `Expected only tenant_id=${expectedTenantId}. ` +
                `This indicates a cross-tenant data leak that must be investigated immediately.`,
              rowCount: count,
              timestamp: new Date().toISOString(),
            });
          }
        } catch (error) {
          throw new Error(
            `Cross-tenant probe could not inspect "${schema}"."${table_name}"."${column_name}": ${probeErrorMessage(error)}`,
          );
        }
      }
    }

    return violations;
  }
}
