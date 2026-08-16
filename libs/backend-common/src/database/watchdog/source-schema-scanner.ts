import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { executeQueryRowsNormalized } from '../query-result-normalizer';
import { MODULE_SCHEMAS } from '../schema-manager.service';

/**
 * Regex for safe SQL identifiers. Prevents injection via schema/table names.
 * Allows lowercase alphanumeric and underscores only.
 */
const SAFE_SQL_IDENTIFIER = /^[a-z][a-z0-9_]*$/;

/**
 * Severity levels for watchdog violations.
 *
 * CRITICAL - Immediate data safety risk (source contamination, cross-tenant leak)
 * HIGH     - Structural integrity issue (missing tables, schema drift)
 * MEDIUM   - Potential future issue (orphaned schemas, reference data mismatch)
 * LOW      - Informational (extra tables, minor inconsistencies)
 */
export type ViolationSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * Types of violations the watchdog system can detect.
 *
 * SOURCE_CONTAMINATION - Tenant data found in source (template) schemas
 * CROSS_TENANT_DATA   - Rows with wrong tenant_id found in a tenant schema
 * SCHEMA_DRIFT        - Tenant schema tables don't match MODULE_SCHEMAS definition
 * MISSING_TABLE       - Expected table not found in a tenant schema
 */
export type ViolationType =
  | 'SOURCE_CONTAMINATION'
  | 'CROSS_TENANT_DATA'
  | 'SCHEMA_DRIFT'
  | 'MISSING_TABLE';

/**
 * A single violation detected by any watchdog scanner.
 */
export interface WatchdogViolation {
  /** Classification of the violation */
  type: ViolationType;
  /** How urgent this violation is */
  severity: ViolationSeverity;
  /** The database schema where the violation was found */
  schema: string;
  /** The table involved in the violation */
  table: string;
  /** Human-readable explanation of what was found */
  details: string;
  /** Number of offending rows (when applicable) */
  rowCount?: number;
  /** When the violation was detected (ISO 8601) */
  timestamp: string;
}

/**
 * SourceSchemaScanner checks source (template) schemas for tenant data contamination.
 *
 * In the multi-tenant architecture, source schemas (sensor, farm, hr, etc.) serve as
 * templates for creating tenant schemas. They should only contain:
 * - Table definitions (DDL structure)
 * - Reference/lookup data (defined in referenceDataTables)
 *
 * Any other data in source schemas indicates a misconfigured service that is
 * writing directly to the template schema instead of the tenant schema.
 * This is a CRITICAL security issue that can lead to data leaking across tenants.
 */
export class SourceSchemaScanner {
  private readonly logger = new Logger(SourceSchemaScanner.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Scan all source schemas for tenant data contamination.
   *
   * For each module defined in MODULE_SCHEMAS:
   * 1. Get the list of non-reference-data tables
   * 2. Check if any of them contain rows in the source schema
   * 3. If rows found, report as CRITICAL violation
   *
   * @returns Array of violations found (empty = clean)
   */
  async scan(): Promise<WatchdogViolation[]> {
    const violations: WatchdogViolation[] = [];

    for (const mod of MODULE_SCHEMAS) {
      const refTables = mod.referenceDataTables ?? [];
      const nonRefTables = mod.tables.filter((t) => !refTables.includes(t));

      for (const table of nonRefTables) {
        // Defence-in-depth: validate identifiers before interpolation into SQL.
        // MODULE_SCHEMAS is trusted app code, but if it were ever corrupted
        // (e.g. bad merge), this prevents SQL injection via identifier names.
        if (!SAFE_SQL_IDENTIFIER.test(mod.sourceSchema) || !SAFE_SQL_IDENTIFIER.test(table)) {
          this.logger.error(
            `Skipping unsafe identifier: schema="${mod.sourceSchema}" table="${table}"`,
          );
          continue;
        }
        try {
          const rows = await executeQueryRowsNormalized<{ cnt: string | number }>(
            this.dataSource,
            `SELECT COUNT(*) as cnt FROM "${mod.sourceSchema}"."${table}"`,
          );
          const count = Number.parseInt(String(rows[0]?.cnt ?? 0), 10);

          if (count > 0) {
            violations.push({
              type: 'SOURCE_CONTAMINATION',
              severity: 'CRITICAL',
              schema: mod.sourceSchema,
              table,
              details:
                `Source schema ${mod.sourceSchema}.${table} has ${count} rows of tenant data. ` +
                `Data should be in tenant_xxx.${table}, not the template schema. ` +
                `Check that ${mod.moduleName}-service TenantSchemaMiddleware is correctly setting search_path.`,
              rowCount: count,
              timestamp: new Date().toISOString(),
            });
          }
        } catch (err) {
          // Table might not exist in source schema yet (service not started)
          this.logger.debug(
            `Table ${mod.sourceSchema}.${table} not queryable: ${(err as Error).message}`,
          );
        }
      }
    }

    return violations;
  }
}
