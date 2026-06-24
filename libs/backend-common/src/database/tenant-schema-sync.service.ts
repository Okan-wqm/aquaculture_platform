import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  queryRowCountNormalized,
  queryRowsWithStringColumn,
  querySingleStringColumn,
  type StringColumnRow,
} from './query-result-normalizer';
import { MODULE_SCHEMAS } from './schema-manager.service';
import { validateSqlIdentifier } from './sql-identifier.util';
import { listTenantSchemas } from './tenant-schema.utils';

type ColumnNameRow = StringColumnRow<'column_name'>;

export interface SyncReport {
  /**
   * Number of tables present in the source schema but missing in a tenant
   * schema. The detector NEVER creates them — operators must author a
   * tenant fan-out migration.
   */
  tablesMissing: number;
  /**
   * Number of columns present on a source-schema table but missing from
   * the same table in a tenant schema. The detector NEVER adds them —
   * operators must author a tenant fan-out migration.
   */
  columnsMissing: number;
  /**
   * Detailed per-(tenant,table) drift entries — fed to logs + metrics so
   * operators can act before a request hits the missing column path.
   */
  drift: Array<{
    tenantSchema: string;
    table: string;
    kind: 'table-missing' | 'column-missing';
    column?: string;
  }>;
  errors: string[];
}

/**
 * TenantSchemaSyncService — DRIFT DETECTOR (read-only)
 * ============================================================================
 *
 * # Why this service exists in this shape
 *
 * Pre-2026-04-28 this service ran `CREATE TABLE ... LIKE source INCLUDING ALL`
 * and `ALTER TABLE ... ADD COLUMN ...` from `OnApplicationBootstrap` for every
 * tenant schema where source-schema entities had drifted past tenant tables.
 * Two compounding architectural defects:
 *
 *   1. ADR-011 + ADR-012 violation — DDL was applied OUTSIDE the migration
 *      ledger. No version row was written, no rollback was possible, and the
 *      change never appeared in `git log` or `pg_migrations`. The pattern is
 *      the `synchronize: true` antipattern under a different name. (Captured
 *      as DATA-CRITICAL-002.)
 *
 *   2. Legal-hold registry bypass — every destructive or schema-changing
 *      operation against a tenant schema MUST consult the canonical legal-
 *      hold registry before proceeding. Boot-time DDL bypassed it entirely;
 *      a tenant under litigation hold would silently get DDL applied
 *      regardless. (Captured as LEGAL-HIGH-004.)
 *
 * # How this version fixes both
 *
 * The DDL-applying code paths are GONE. This service now does ONE thing
 * only: detect drift between source and tenant schemas and report it loudly.
 *
 *   - `OnApplicationBootstrap` runs the detector, logs WARN-level structured
 *     diagnostics, and (when STRICT_TENANT_SCHEMA_DRIFT=true) refuses to
 *     boot. Defaults to non-strict so existing dev / CI flows are unaffected
 *     by the regime change; production overrides via env.
 *   - There is no path through this class that issues CREATE TABLE, ALTER
 *     TABLE, DROP TABLE, or any other DDL statement. Eliminating the path
 *     architecturally is the make-impossible cure (Tier-1) for both findings —
 *     legal hold cannot be bypassed by a code path that does not exist.
 *
 * # How to apply the change the detector reports
 *
 * Author a per-tenant migration in the owning service's `migrations/`
 * directory. The migration body fans out across `listTenantSchemas()` and
 * runs the desired DDL inside a transaction (so the lock auto-releases
 * on commit/rollback). Consult the legal-hold registry per-tenant before
 * issuing the DDL — see the W0.G runbook in
 * `docs/runbooks/tenant-schema-drift-response.md`.
 *
 * # Backwards compat
 *
 * The class name + DI token stay the same so the 7 service AppModules that
 * register this service in their `providers` array do not need any change.
 * The `SyncReport` shape changes: `tablesCreated`/`columnsAdded` become
 * `tablesMissing`/`columnsMissing` (numbers reflect detection, not
 * application). Test sites that asserted the old shape get updated in the
 * same PR.
 *
 * Closes: docs/reviews/data-expert/2026-04-28-core-platform-review.md#DATA-CRITICAL-002
 * Closes: docs/reviews/legal-hold-auditor/2026-04-28-core-platform-review.md#LEGAL-HIGH-004
 */
@Injectable()
export class TenantSchemaSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TenantSchemaSyncService.name);

  constructor(private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    const strictMode = this.isStrictMode();
    try {
      const report = await this.detectAllTenantSchemas();
      this.emitReport(report);
      if (
        report.tablesMissing + report.columnsMissing + report.errors.length > 0 &&
        strictMode
      ) {
        // WHY: STRICT_TENANT_SCHEMA_DRIFT=true causes the service to fail
        // boot when drift is present. Operators opt in by setting the env
        // var on environments where drift signals an unrun migration AND
        // a request to the missing-column path would surface as a 500 to
        // tenants. Default off so dev/CI are unaffected.
        // WHAT: throw so the Nest bootstrap fails — Docker restarts the
        // container, operator sees the same WARN logs at the next boot.
        throw new Error(
          'TenantSchemaSyncService: tenant-schema drift detected and ' +
            'STRICT_TENANT_SCHEMA_DRIFT=true. Author a per-tenant ' +
            'migration or fix the schema SSoT before booting (runbook: ' +
            'docs/runbooks/tenant-schema-drift-response.md).',
        );
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Strict-mode rethrow propagates; non-strict surface still logs.
      if (this.isStrictMode()) throw error;
      this.logger.error(`Tenant schema drift detection failed (non-fatal): ${msg}`);
    }
  }

  /**
   * Read-only drift scan — never modifies any schema.
   *
   * Kept on the public API so test sites and operator tooling can invoke
   * the detector explicitly (e.g. a CI gate or a runbook diagnostic).
   */
  async detectAllTenantSchemas(): Promise<SyncReport> {
    const tenantSchemas = await listTenantSchemas(this.dataSource);
    const report: SyncReport = {
      tablesMissing: 0,
      columnsMissing: 0,
      drift: [],
      errors: [],
    };

    if (tenantSchemas.length === 0) {
      this.logger.debug('No tenant schemas found — drift scan complete');
      return report;
    }

    const sourceSchema = await this.detectSourceSchema();
    if (!sourceSchema) {
      report.errors.push(
        'Could not detect source schema from connection search_path; tenant drift scan cannot determine the source SSoT.',
      );
      return report;
    }

    const mod = MODULE_SCHEMAS.find((m) => m.sourceSchema === sourceSchema);
    if (!mod) {
      report.errors.push(
        `No MODULE_SCHEMAS entry for source schema "${sourceSchema}"; tenant drift scan cannot determine table ownership.`,
      );
      return report;
    }

    this.logger.log(
      `Scanning ${tenantSchemas.length} tenant schemas against source "${sourceSchema}" (${this.expectedTenantTables(mod).length} tables) — read-only`,
    );

    for (const tenantSchema of tenantSchemas) {
      await this.detectTenantDrift(tenantSchema, mod, report);
    }

    return report;
  }

  private async detectTenantDrift(
    tenantSchema: string,
    mod: { sourceSchema: string; tables: string[]; referenceDataTables?: string[] },
    report: SyncReport,
  ): Promise<void> {
    // WHY: Identifiers from listTenantSchemas + MODULE_SCHEMAS are
    // structurally trusted (regex-bound + hard-coded), but defense-in-depth
    // requires the same validator at every interpolation point so that a
    // future change of source for either input cannot silently inherit an
    // injection surface (DATA-CRITICAL-002 (1) hardening).
    const safeTenantSchema = validateSqlIdentifier(tenantSchema, 'schema');
    const safeSourceSchema = validateSqlIdentifier(mod.sourceSchema, 'schema');

    for (const tableName of this.expectedTenantTables(mod)) {
      try {
        const safeTableName = validateSqlIdentifier(tableName, 'table');
        const sourceExists = await this.tableExists(safeSourceSchema, safeTableName);
        if (!sourceExists) continue;

        const tenantExists = await this.tableExists(safeTenantSchema, safeTableName);

        if (!tenantExists) {
          report.tablesMissing++;
          report.drift.push({
            tenantSchema: safeTenantSchema,
            table: safeTableName,
            kind: 'table-missing',
          });
          continue;
        }

        await this.detectColumnDrift(safeSourceSchema, safeTenantSchema, safeTableName, report);
      } catch (error) {
        const msg = `${tenantSchema}.${tableName}: ${error instanceof Error ? error.message : String(error)}`;
        report.errors.push(msg);
        this.logger.error(`Drift scan error: ${msg}`);
      }
    }
  }

  private async detectColumnDrift(
    sourceSchema: string,
    tenantSchema: string,
    tableName: string,
    report: SyncReport,
  ): Promise<void> {
    const sourceColumns = await this.getColumns(sourceSchema, tableName);
    const tenantColumns = await this.getColumns(tenantSchema, tableName);
    const tenantColumnNames = new Set(tenantColumns.map((c) => c.column_name));

    for (const col of sourceColumns) {
      if (!tenantColumnNames.has(col.column_name)) {
        report.columnsMissing++;
        report.drift.push({
          tenantSchema,
          table: tableName,
          kind: 'column-missing',
          column: col.column_name,
        });
      }
    }
  }

  private async tableExists(schema: string, table: string): Promise<boolean> {
    const rowsResult: unknown = await this.dataSource.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'`,
      [schema, table],
    );
    return queryRowCountNormalized(rowsResult) > 0;
  }

  private async getColumns(schema: string, table: string): Promise<ColumnNameRow[]> {
    const columnsResult: unknown = await this.dataSource.query(
      `SELECT a.attname AS column_name
       FROM pg_attribute a
       WHERE a.attrelid = ($1 || '.' || $2)::regclass
         AND a.attnum > 0
         AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [schema, table],
    );
    return queryRowsWithStringColumn(
      columnsResult,
      'column_name',
      `${schema}.${table} column scan`,
    );
  }

  private async detectSourceSchema(): Promise<string | null> {
    const searchPathResult: unknown = await this.dataSource.query('SHOW search_path');
    const searchPath = querySingleStringColumn(
      searchPathResult,
      'search_path',
      'SHOW search_path',
    );
    const schemas = searchPath
      .split(',')
      .map((s: string) => s.trim().replace(/"/g, ''))
      .filter((s: string) => s && s !== 'public' && s !== '"$user"' && s !== '$user');
    return schemas.length > 0 ? (schemas[0] as string) : null;
  }

  private isStrictMode(): boolean {
    // WHY: env-driven so production can opt in without code change.
    // Strict mode fails boot when drift is present — escalates to Docker's
    // restart loop and the deploy asserter, surfacing the missing migration
    // before tenant requests start hitting the column path.
    return process.env['STRICT_TENANT_SCHEMA_DRIFT'] === 'true';
  }

  private emitReport(report: SyncReport): void {
    if (
      report.tablesMissing === 0 &&
      report.columnsMissing === 0 &&
      report.errors.length === 0
    ) {
      this.logger.log('Tenant schema drift scan: all schemas up to date');
      return;
    }
    if (report.errors.length > 0) {
      this.logger.error(`Drift scan errors: ${report.errors.join('; ')}`);
    }
    if (report.tablesMissing === 0 && report.columnsMissing === 0) {
      return;
    }
    // Structured WARN so log aggregators trip an alert. Per-(tenant,table)
    // drift is dumped at DEBUG so operators can pinpoint without flooding
    // the WARN stream.
    this.logger.warn(
      `Tenant schema drift detected: ${report.tablesMissing} table(s) missing, ${report.columnsMissing} column(s) missing across ${this.distinctTenants(report)} tenant(s). Author a per-tenant migration — see docs/runbooks/tenant-schema-drift-response.md`,
    );
    for (const entry of report.drift) {
      this.logger.debug(
        entry.kind === 'table-missing'
          ? `drift: ${entry.tenantSchema}.${entry.table} — table missing`
          : `drift: ${entry.tenantSchema}.${entry.table}.${entry.column} — column missing`,
      );
    }
  }

  private distinctTenants(report: SyncReport): number {
    return new Set(report.drift.map((d) => d.tenantSchema)).size;
  }

  private expectedTenantTables(mod: {
    tables: string[];
    referenceDataTables?: string[];
  }): string[] {
    return [...mod.tables, ...(mod.referenceDataTables ?? [])];
  }
}
