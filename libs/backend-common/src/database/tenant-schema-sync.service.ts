import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MODULE_SCHEMAS } from './schema-manager.service';
import { listTenantSchemas } from './tenant-schema.utils';

export interface SyncReport {
  tablesCreated: number;
  columnsAdded: number;
  errors: string[];
}

/**
 * Synchronizes all tenant schemas with their source schemas at application bootstrap.
 *
 * Runs AFTER SourceSchemaBootstrapService (which uses OnModuleInit) because
 * OnApplicationBootstrap fires after all OnModuleInit hooks complete.
 *
 * For each tenant schema, this service:
 * - Creates missing tables (via CREATE TABLE ... LIKE source INCLUDING ALL)
 * - Adds missing columns to existing tables (via ALTER TABLE ADD COLUMN)
 *
 * This ensures that when new tables or columns are added to a module's entities,
 * existing tenant schemas are automatically brought up to date without requiring
 * manual migration scripts.
 */
@Injectable()
export class TenantSchemaSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TenantSchemaSyncService.name);

  constructor(private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    const strictMode = this.isStrictMode();
    try {
      const report = await this.syncAllTenantSchemas();
      if (report.tablesCreated > 0 || report.columnsAdded > 0) {
        this.logger.warn(
          `Tenant schema sync complete: ${report.tablesCreated} tables created, ${report.columnsAdded} columns added` +
          (report.errors.length > 0 ? `, ${report.errors.length} errors` : ''),
        );
      } else {
        this.logger.log('Tenant schema sync: all schemas up to date');
      }
      if (report.errors.length > 0) {
        this.logger.error(`Sync errors: ${report.errors.join('; ')}`);
        if (strictMode) {
          throw new Error(
            `Tenant schema sync failed in strict mode: ${report.errors.join('; ')}`,
          );
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (strictMode) {
        this.logger.error(`Tenant schema sync failed (fatal): ${msg}`);
        throw error;
      }
      this.logger.error(`Tenant schema sync failed (non-fatal): ${msg}`);
    }
  }

  async syncAllTenantSchemas(): Promise<SyncReport> {
    const tenantSchemas = await listTenantSchemas(this.dataSource);
    const report: SyncReport = { tablesCreated: 0, columnsAdded: 0, errors: [] };

    if (tenantSchemas.length === 0) {
      this.logger.debug('No tenant schemas found — nothing to sync');
      return report;
    }

    // Determine which source schema this service manages (from connection search_path)
    const sourceSchema = await this.detectSourceSchema();
    if (!sourceSchema) {
      this.logger.warn('Could not detect source schema from connection — skipping tenant sync');
      return report;
    }

    const mod = MODULE_SCHEMAS.find(m => m.sourceSchema === sourceSchema);
    if (!mod) {
      this.logger.warn(`No MODULE_SCHEMAS entry for source schema "${sourceSchema}" — skipping tenant sync`);
      return report;
    }

    this.logger.log(`Syncing ${tenantSchemas.length} tenant schemas against source "${sourceSchema}" (${mod.tables.length} tables)`);

    for (const tenantSchema of tenantSchemas) {
      await this.syncTenantSchema(tenantSchema, mod, report);
    }

    return report;
  }

  private async syncTenantSchema(
    tenantSchema: string,
    mod: { sourceSchema: string; tables: string[] },
    report: SyncReport,
  ): Promise<void> {
    for (const tableName of mod.tables) {
      try {
        const sourceExists = await this.tableExists(mod.sourceSchema, tableName);
        if (!sourceExists) continue;

        const tenantExists = await this.tableExists(tenantSchema, tableName);

        if (!tenantExists) {
          // Create missing table from source schema template
          await this.dataSource.query(`
            CREATE TABLE IF NOT EXISTS "${tenantSchema}"."${tableName}"
            (LIKE "${mod.sourceSchema}"."${tableName}" INCLUDING ALL)
          `);
          report.tablesCreated++;
          this.logger.log(`Created missing table: ${tenantSchema}.${tableName}`);
        } else {
          // Table exists — check for missing columns
          await this.syncColumns(mod.sourceSchema, tenantSchema, tableName, report);
        }
      } catch (error) {
        const msg = `${tenantSchema}.${tableName}: ${error instanceof Error ? error.message : String(error)}`;
        report.errors.push(msg);
        this.logger.error(`Sync error: ${msg}`);
      }
    }
  }

  private async syncColumns(
    sourceSchema: string,
    tenantSchema: string,
    tableName: string,
    report: SyncReport,
  ): Promise<void> {
    const sourceColumns = await this.getColumns(sourceSchema, tableName);
    const tenantColumns = await this.getColumns(tenantSchema, tableName);
    const tenantColumnNames = new Set(tenantColumns.map((c: any) => c.column_name));

    for (const col of sourceColumns) {
      if (!tenantColumnNames.has(col.column_name)) {
        try {
          const dataType = col.full_data_type;
          const nullClause = col.is_nullable === 'NO' ? 'NOT NULL' : '';
          // Skip schema-qualified defaults (sequences etc.) — they reference source schema
          const hasSchemaDefault = col.column_default && col.column_default.includes(`${sourceSchema}.`);
          const defaultClause = col.column_default && !hasSchemaDefault
            ? `DEFAULT ${col.column_default}`
            : '';
          // For NOT NULL without default, use a permissive approach
          const effectiveNull = (nullClause === 'NOT NULL' && !defaultClause) ? '' : nullClause;

          await this.dataSource.query(`
            ALTER TABLE "${tenantSchema}"."${tableName}"
            ADD COLUMN IF NOT EXISTS "${col.column_name}" ${dataType} ${effectiveNull} ${defaultClause}
          `);
          report.columnsAdded++;
          this.logger.log(`Added missing column: ${tenantSchema}.${tableName}.${col.column_name}`);
        } catch (error) {
          const msg = `Column ${tenantSchema}.${tableName}.${col.column_name}: ${error instanceof Error ? error.message : String(error)}`;
          report.errors.push(msg);
          this.logger.warn(`Sync column error (non-fatal): ${msg}`);
        }
      }
    }
  }

  private async tableExists(schema: string, table: string): Promise<boolean> {
    const rows = await this.dataSource.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'`,
      [schema, table],
    );
    return rows.length > 0;
  }

  private async getColumns(schema: string, table: string): Promise<any[]> {
    return this.dataSource.query(
      `SELECT
        a.attname AS column_name,
        format_type(a.atttypid, a.atttypmod) AS full_data_type,
        CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
        pg_get_expr(d.adbin, d.adrelid) AS column_default
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE a.attrelid = ($1 || '.' || $2)::regclass
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY a.attnum`,
      [schema, table],
    );
  }

  private async detectSourceSchema(): Promise<string | null> {
    const result = await this.dataSource.query('SHOW search_path');
    const searchPath: string = result[0]?.search_path || '';
    const schemas = searchPath
      .split(',')
      .map((s: string) => s.trim().replace(/"/g, ''))
      .filter((s: string) => s && s !== 'public' && s !== '"$user"' && s !== '$user');
    return schemas.length > 0 ? (schemas[0] as string) : null;
  }

  private isStrictMode(): boolean {
    // WHY 2026-04-29: schema-per-tenant services must not start after a failed
    // tenant DDL sync in deploy/test gates. Leaving strict mode env-driven keeps
    // local legacy environments observable without hiding production drift.
    return process.env['TENANT_SCHEMA_SYNC_STRICT'] === 'true';
  }
}
