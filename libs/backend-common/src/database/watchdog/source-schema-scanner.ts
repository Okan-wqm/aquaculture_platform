import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

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
 * UNVERIFIABLE_SCHEMA - The scan could not read a schema, so its cleanliness is
 *                       unknown. Not the same as "clean": an unreadable schema
 *                       is a hole in the coverage of a safety mechanism.
 */
export type ViolationType =
  | 'SOURCE_CONTAMINATION'
  | 'CROSS_TENANT_DATA'
  | 'SCHEMA_DRIFT'
  | 'MISSING_TABLE'
  | 'UNVERIFIABLE_SCHEMA';

/**
 * PostgreSQL SQLSTATE codes this scanner must tell apart.
 *
 * `undefined_table` is the benign case the original catch-all was written for:
 * a service that has not booted yet has no tables, and that is not a finding.
 * `insufficient_privilege` and `invalid_schema_name` are the opposite — the
 * scanner was refused at the door, so it learned NOTHING about that schema and
 * must not let silence be read as cleanliness.
 */
const PG_UNDEFINED_TABLE = '42P01';
const PG_INSUFFICIENT_PRIVILEGE = '42501';
const PG_INVALID_SCHEMA_NAME = '3F000';

/** SQLSTATE off a driver error, when the driver supplies one. */
function pgErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : undefined;
}

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
 * The only capability this scanner needs from a connection.
 *
 * Depending on the narrow shape rather than the whole `DataSource` lets the
 * regression suite drive real refusals through a plain object — no cast, no
 * partial-mock pretending to be a DataSource. A real `DataSource` satisfies it
 * structurally, so production wiring is unchanged.
 */
export interface SchemaQueryExecutor {
  query<T = unknown>(sql: string, parameters?: unknown[]): Promise<T>;
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

  constructor(private readonly dataSource: SchemaQueryExecutor | DataSource) {}

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
      const nonRefTables = mod.tables.filter(t => !refTables.includes(t));

      // Ask ONCE whether this connection may read the schema at all, before
      // issuing a query per table. Each service connects as its own role and
      // has no grants on its siblings' schemas, so without this the scan fires
      // hundreds of doomed COUNT(*)s every run — the production symptom that
      // exposed this bug was a postgres log filling with `permission denied
      // for schema ...` at ~1600 lines per scan cycle. The gap is REPORTED,
      // not skipped: a schema nobody could read is not a schema found clean.
      const access = await this.schemaAccess(mod.sourceSchema);
      if (access !== 'readable') {
        violations.push(this.unverifiable(mod.sourceSchema, '*', access));
        continue;
      }

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
          const result: { cnt: string }[] = await this.dataSource.query(
            `SELECT COUNT(*) as cnt FROM "${mod.sourceSchema}"."${table}"`,
          );
          const count = parseInt(result[0]?.cnt || '0');

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
          const code = pgErrorCode(err);
          if (code === PG_UNDEFINED_TABLE) {
            // The benign case this catch was originally written for: the
            // owning service has not created its tables yet. Nothing to count,
            // nothing to report.
            this.logger.debug(`Table ${mod.sourceSchema}.${table} does not exist yet`);
            continue;
          }
          // Anything else means the count did not happen. Swallowing it here
          // is what let a denied scan report zero violations for ten schemas
          // and still be recorded as a completed, clean run.
          violations.push(
            this.unverifiable(
              mod.sourceSchema,
              table,
              code === PG_INSUFFICIENT_PRIVILEGE ? 'denied' : 'error',
              (err as Error).message,
            ),
          );
        }
      }
    }

    return violations;
  }

  /**
   * Whether this connection can read `schema`, decided in one round trip.
   *
   * A driver failure here is itself an unverifiable outcome, never an implicit
   * "yes" — the caller turns anything that is not `readable` into a reported
   * gap.
   */
  private async schemaAccess(schema: string): Promise<'readable' | 'denied' | 'absent' | 'error'> {
    if (!SAFE_SQL_IDENTIFIER.test(schema)) return 'error';
    try {
      const rows: { readable: boolean | null }[] = await this.dataSource.query(
        `SELECT has_schema_privilege(current_user, $1, 'USAGE') AS readable`,
        [schema],
      );
      return rows[0]?.readable === true ? 'readable' : 'denied';
    } catch (err) {
      return pgErrorCode(err) === PG_INVALID_SCHEMA_NAME ? 'absent' : 'error';
    }
  }

  /**
   * A gap in what the scan could see, expressed as a finding.
   *
   * HIGH rather than CRITICAL: an unread schema is not proof of contamination,
   * but it is proof that this run cannot claim the schema is clean — and a
   * safety mechanism that quietly covers less than it advertises is the defect
   * being fixed here, not an operational footnote.
   */
  private unverifiable(
    schema: string,
    table: string,
    reason: 'denied' | 'absent' | 'error',
    detail?: string,
  ): WatchdogViolation {
    const why =
      reason === 'denied'
        ? `the scanning role has no USAGE privilege on it`
        : reason === 'absent'
          ? `the schema does not exist in this database`
          : `the query failed: ${detail ?? 'unknown driver error'}`;
    return {
      type: 'UNVERIFIABLE_SCHEMA',
      severity: 'HIGH',
      schema,
      table,
      details:
        `Source contamination could not be checked for ${schema}${table === '*' ? '' : `.${table}`} because ${why}. ` +
        `This scan makes NO claim about that schema. Grant the scanning role read access, ` +
        `or run the scan from the service that owns the schema.`,
      timestamp: new Date().toISOString(),
    };
  }
}
