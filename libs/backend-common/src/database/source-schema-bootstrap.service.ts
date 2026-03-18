import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Bootstraps source schema tables on service startup.
 *
 * In multi-tenant architecture, each service owns a "source schema" (e.g. `sensor`, `farm`, `hr`)
 * that holds the template table structures. Tenant provisioning copies tables from these source
 * schemas into per-tenant schemas via `CREATE TABLE ... (LIKE source.table ...)`.
 *
 * Problem: With DATABASE_SYNC=false in production and no migrations for base tables, source schemas
 * remain empty after init SQL creates them. This service detects empty source schemas and runs
 * TypeORM synchronize() to create the tables.
 *
 * Behavior:
 * - Idempotent: skips if source schema already has tables
 * - Non-fatal: logs errors but does not crash the service
 * - Runs once at startup via OnModuleInit
 */
@Injectable()
export class SourceSchemaBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(SourceSchemaBootstrapService.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.bootstrapSourceSchema();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to bootstrap source schema — service will continue but tenant provisioning may fail: ${msg}`,
        stack,
      );
    }
  }

  private async bootstrapSourceSchema(): Promise<void> {
    // Read the default search_path to determine the source schema
    const result = await this.dataSource.query('SHOW search_path');
    const searchPath: string = result[0]?.search_path || '';

    // Extract the source schema (first non-public, non-user schema in search_path)
    const schemas = searchPath
      .split(',')
      .map((s: string) => s.trim().replace(/"/g, ''))
      .filter((s: string) => s && s !== 'public' && s !== '"$user"' && s !== '$user');

    if (schemas.length === 0) {
      this.logger.warn(
        'No source schema found in connection search_path — skipping bootstrap. ' +
        'Ensure the TypeORM connection has options: \'-c search_path=<schema>,public\'',
      );
      return;
    }

    const sourceSchema = schemas[0] as string;
    this.logger.log(`Checking source schema "${sourceSchema}" for existing tables...`);

    // Check if the source schema already has tables
    const tables = await this.dataSource.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      [sourceSchema],
    );

    if (tables.length > 0) {
      // Schema has tables — check for missing ones (incremental sync)
      await this.syncMissingTables(sourceSchema, tables);
      return;
    }

    this.logger.warn(
      `Source schema "${sourceSchema}" is empty — running synchronize to create template tables...`,
    );

    // Ensure the schema exists
    await this.dataSource.query(`CREATE SCHEMA IF NOT EXISTS "${sourceSchema}"`);

    // Drop orphaned indexes left by previous failed sync attempts.
    // TypeORM sync can fail mid-way leaving indexes without their tables,
    // then subsequent sync attempts crash with "relation IDX_xxx already exists".
    await this.dropOrphanedIndexes(sourceSchema);

    // Run synchronize which will create tables in the source schema
    // (because the connection's search_path is set to source_schema,public)
    await this.dataSource.synchronize();

    // Verify tables were created
    const tablesAfter = await this.dataSource.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      [sourceSchema],
    );

    this.logger.log(
      `Source schema "${sourceSchema}" bootstrap complete — created ${tablesAfter.length} tables`,
    );
  }

  /**
   * Check if MODULE_SCHEMAS defines tables not yet present in the source schema.
   * If so, run TypeORM synchronize() to create them.
   */
  private async syncMissingTables(
    sourceSchema: string,
    existingTables: Array<{ table_name: string }>,
  ): Promise<void> {
    // Dynamic import to avoid circular dependency
    const { MODULE_SCHEMAS } = await import('./schema-manager.service');
    const mod = MODULE_SCHEMAS.find(m => m.sourceSchema === sourceSchema);
    if (!mod) return;

    const existingSet = new Set(existingTables.map(t => t.table_name));
    const missing = mod.tables.filter(t => !existingSet.has(t));

    if (missing.length === 0) {
      this.logger.log(
        `Source schema "${sourceSchema}" has all ${mod.tables.length} expected tables`,
      );
      return;
    }

    this.logger.warn(
      `Source schema "${sourceSchema}" missing ${missing.length}/${mod.tables.length} tables — running synchronize: ${missing.join(', ')}`,
    );

    await this.dataSource.synchronize();

    const tablesAfter = await this.dataSource.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      [sourceSchema],
    );
    this.logger.log(
      `Source schema "${sourceSchema}" incremental sync complete — now has ${tablesAfter.length} tables`,
    );
  }

  /**
   * Drop orphaned indexes in a schema that has no tables.
   * This happens when a previous TypeORM sync failed mid-way, leaving indexes
   * without their parent tables. Subsequent sync attempts then crash with
   * "relation IDX_xxx already exists".
   */
  private async dropOrphanedIndexes(schema: string): Promise<void> {
    const indexes = await this.dataSource.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1`,
      [schema],
    );

    if (indexes.length === 0) return;

    this.logger.warn(
      `Found ${indexes.length} orphaned indexes in empty schema "${schema}" — dropping...`,
    );

    for (const row of indexes) {
      const indexName: string = row.indexname;
      await this.dataSource.query(`DROP INDEX IF EXISTS "${schema}"."${indexName}"`);
    }

    this.logger.log(`Dropped ${indexes.length} orphaned indexes from "${schema}"`);
  }
}
