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

    // ── Phase 14: strict module ownership enforcement ──────────────────
    // Before any sync, drop any table in this source schema that is
    // not declared as owned by the module. See `dropOrphanTables` for
    // the enforcement logic and `MODULE_SCHEMAS[mod].strictOwnership`
    // for the opt-in flag. This is an architectural fix for the
    // cross-module contamination failure mode — tables belonging to
    // OTHER services (e.g. backend-common's AuditLogEntity leaking
    // into farm schema via transitive imports) are detected and
    // removed deterministically on every startup.
    //
    // Runs BEFORE the sync-missing-tables path so orphans with FK
    // references are gone before any ALTER TABLE or RLS discovery
    // query ever runs against this schema.
    await this.dropOrphanTables(sourceSchema);

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
   * Phase 14: strict module ownership enforcement.
   *
   * Discover every table currently present in the source schema and
   * DROP any table that is NOT in the module's declared ownership set
   * (`tables` ∪ `referenceDataTables` ∪ `infrastructureTables`). This
   * closes the cross-module contamination failure mode where historical
   * transitive entity imports synchronized foreign-service tables into
   * the current service's source schema; those tables persisted on
   * disk after the imports were removed, and later RLS / migration
   * work tripped over them.
   *
   * Concrete 2026-04-07/08 incident this fixes: on the production
   * farm-service droplet, the `farm` schema contained four orphan
   * tables — `audit_logs` and `user_consents` and `gdpr_data_requests`
   * (originally synchronized via a transitive import of
   * backend-common's AuditLogEntity / UserConsent / GdprDataRequest
   * from a long-removed module) and `employees` (leaked from hr).
   * All four declared `tenantId` as `varchar(255)` in their foreign
   * entity definitions, which the farm-service
   * `EnableRowLevelSecurity1776000000000` migration then discovered
   * via its camelCase-tenantId probe and crashed with
   * `operator does not exist: character varying = uuid` on the very
   * first `CREATE POLICY … USING "tenantId" = …::uuid` call. The
   * architectural answer is NOT "dynamically converge every
   * tenantId column to uuid" — that accepts the contamination as
   * legitimate. The architectural answer is "declare the module's
   * owned tables authoritatively and refuse to host any other
   * table in its schema".
   *
   * ## Opt-in semantics
   *
   * Only runs when the module's MODULE_SCHEMAS entry sets
   * `strictOwnership: true`. Default behaviour for existing services
   * is unchanged — they get the new method on the class but do not
   * execute it. This is a conservative rollout: the farm module opts
   * in because that's where the contamination was observed, and other
   * modules can opt in as their source schemas are audited and the
   * corresponding MODULE_SCHEMAS entries are verified complete.
   *
   * ## Idempotence and safety
   *
   * - `DROP TABLE IF EXISTS … CASCADE` is idempotent; a second run
   *   after a successful first run is a no-op (no orphans to find).
   * - `CASCADE` removes any dependent FKs, RLS policies, indexes,
   *   and views, so the drop is terminal and doesn't leave loose
   *   constraint references.
   * - DDL (`DROP TABLE`) is not subject to row-level BEFORE-INSERT
   *   triggers installed by `SourceSchemaWriteGuardService`, so
   *   enforcement can run at any point in the bootstrap lifecycle
   *   without conflicting with the write-guard invariant.
   * - Errors are fatal: strict enforcement MUST be complete, and a
   *   partial drop could leave the RLS migration crashing on the
   *   half-cleaned schema. The single `try` wrapper in
   *   `onModuleInit` still catches the fatal error and logs it
   *   without crashing the pod, matching the rest of the bootstrap's
   *   non-fatal-on-failure contract.
   */
  private async dropOrphanTables(sourceSchema: string): Promise<void> {
    // Dynamic import to avoid circular dependency between
    // source-schema-bootstrap.service and schema-manager.service.
    const { MODULE_SCHEMAS } = await import('./schema-manager.service');
    const mod = MODULE_SCHEMAS.find(m => m.sourceSchema === sourceSchema);
    if (!mod) {
      this.logger.debug(
        `No MODULE_SCHEMAS entry for source schema "${sourceSchema}" — skipping strict-ownership enforcement.`,
      );
      return;
    }
    if (mod.strictOwnership !== true) {
      this.logger.debug(
        `Module "${mod.moduleName}" does not opt into strict ownership — skipping orphan drop for "${sourceSchema}".`,
      );
      return;
    }

    // Build the authoritative "legitimate tables" set from the three
    // declared lists. Anything in the schema that isn't in this set is
    // an orphan by definition.
    const legitimate = new Set<string>([
      ...mod.tables,
      ...(mod.referenceDataTables ?? []),
      ...(mod.infrastructureTables ?? []),
    ]);

    // Query actual tables present in the schema. Excludes views,
    // materialized views, and foreign tables — those are managed
    // differently and the orphan-drop policy does not apply to them.
    const rows: Array<{ table_name: string }> = await this.dataSource.query(
      `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
      `,
      [sourceSchema],
    );

    const actual = rows.map(r => r.table_name);
    const orphans = actual.filter(name => !legitimate.has(name));

    if (orphans.length === 0) {
      this.logger.log(
        `Source schema "${sourceSchema}" strict-ownership check passed — no orphan tables found ` +
          `(${actual.length} table(s) present, all declared in MODULE_SCHEMAS[${mod.moduleName}]).`,
      );
      return;
    }

    this.logger.warn(
      `Source schema "${sourceSchema}" has ${orphans.length} orphan table(s) from cross-module contamination: ${orphans.join(', ')}. ` +
        `These tables are NOT declared in MODULE_SCHEMAS[${mod.moduleName}] (tables | referenceDataTables | infrastructureTables) ` +
        `and belong to a different module or a removed transitive import. Dropping with CASCADE to enforce strict module ownership.`,
    );

    for (const orphan of orphans) {
      try {
        await this.dataSource.query(
          `DROP TABLE IF EXISTS "${sourceSchema}"."${orphan}" CASCADE`,
        );
        this.logger.log(
          `Dropped orphan table "${sourceSchema}"."${orphan}" (CASCADE removed any attached FKs, RLS policies, and indexes).`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to drop orphan table "${sourceSchema}"."${orphan}": ${msg}. ` +
            `Strict-ownership enforcement cannot complete — fail loud so the deploy stops here ` +
            `rather than proceeding to the RLS migration on a half-cleaned schema.`,
        );
        throw error;
      }
    }

    this.logger.log(
      `Strict-ownership enforcement complete for "${sourceSchema}": dropped ${orphans.length} orphan table(s). ` +
        `The schema now contains only tables declared by MODULE_SCHEMAS[${mod.moduleName}].`,
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
