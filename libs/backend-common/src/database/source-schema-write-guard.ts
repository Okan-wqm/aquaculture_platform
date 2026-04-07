import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MODULE_SCHEMAS } from './schema-manager.service';

/**
 * SourceSchemaWriteGuardService
 *
 * Database-level defense-in-depth for tenant isolation.
 * Installs PostgreSQL BEFORE triggers on non-reference tables in source schemas
 * that RAISE EXCEPTION on any INSERT/UPDATE/DELETE attempt.
 *
 * Even if application code has bugs (missing request context, wrong search_path),
 * the database itself will reject writes to source schema tables.
 *
 * Reference data tables (seed/lookup data) are EXCLUDED because they need to be
 * writable for initial seeding and updates.
 *
 * The trigger function uses ERRCODE 'P0999' which can be caught and handled
 * specifically by application error handlers.
 */
@Injectable()
export class SourceSchemaWriteGuardService implements OnModuleInit {
  private readonly logger = new Logger(SourceSchemaWriteGuardService.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.installWriteGuards();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to install source schema write guards (non-fatal): ${msg}`);
    }
  }

  /**
   * Install write guard triggers on all non-reference tables in the service's source schema.
   */
  async installWriteGuards(): Promise<void> {
    // Detect which source schema this service owns
    const sourceSchema = await this.detectSourceSchema();
    if (!sourceSchema) {
      this.logger.warn('Could not detect source schema — skipping write guard installation');
      return;
    }

    const mod = MODULE_SCHEMAS.find(m => m.sourceSchema === sourceSchema);
    if (!mod) {
      this.logger.debug(`No MODULE_SCHEMAS entry for "${sourceSchema}" — skipping write guards`);
      return;
    }

    const referenceSet = new Set(mod.referenceDataTables ?? []);
    const protectedTables = mod.tables.filter(t => !referenceSet.has(t));

    if (protectedTables.length === 0) {
      this.logger.log(`No non-reference tables to protect in "${sourceSchema}"`);
      return;
    }

    // ── Phase 12.2 — clean-slate trigger reinstall ────────────────────
    // BEFORE we install triggers on currently-protected tables, drop
    // every existing `guard_source_write` trigger in this source
    // schema. This handles the cross-deploy state transition where a
    // table was protected in a previous deploy but is now exempt
    // (moved into `referenceDataTables`): the old trigger would
    // otherwise stay on the table and block the writes that the
    // exemption was supposed to allow.
    //
    // Concrete incident this fixes: in Phase 11.4 (commit 91abb3dd) I
    // added `species` to the farm module's `referenceDataTables` so
    // `FarmSeedService.seedGlobalCleanerFishSpecies` could write
    // cleaner-fish template rows. The registry change took effect for
    // NEW trigger installs, but the install loop never touched the
    // already-existing `farm.species` trigger from a previous deploy.
    // The stale trigger continued to raise TENANT_ISOLATION_VIOLATION
    // on every subsequent seed attempt. Dropping all triggers at the
    // start of every install makes the state transition complete and
    // idempotent: whatever set of tables the MODULE_SCHEMAS registry
    // currently marks as protected is the authoritative set after
    // this method returns.
    //
    // The query uses `pg_trigger` (catalogue) rather than
    // `information_schema.triggers` so it finds BOTH enabled AND
    // disabled triggers of our name, and uses the schema-qualified
    // table name in the DROP so schema isolation is explicit.
    const existingGuards: Array<{ schemaname: string; tablename: string }> =
      await this.dataSource.query(
        `
        SELECT n.nspname AS schemaname, c.relname AS tablename
        FROM pg_trigger t
        JOIN pg_class c ON t.tgrelid = c.oid
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE t.tgname = 'guard_source_write'
          AND n.nspname = $1
          AND NOT t.tgisinternal
        `,
        [sourceSchema],
      );

    for (const row of existingGuards) {
      try {
        await this.dataSource.query(
          `DROP TRIGGER IF EXISTS guard_source_write ON "${row.schemaname}"."${row.tablename}"`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Failed to drop stale write guard on ${row.schemaname}.${row.tablename}: ${msg}`,
        );
      }
    }

    if (existingGuards.length > 0) {
      this.logger.log(
        `Clean-slate trigger reset: dropped ${existingGuards.length} existing guard_source_write trigger(s) in "${sourceSchema}" before reinstall.`,
      );
    }

    // Create or replace the trigger function in the source schema
    await this.dataSource.query(`
      CREATE OR REPLACE FUNCTION "${sourceSchema}".block_source_writes()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'TENANT_ISOLATION_VIOLATION: Direct write to source schema %.% blocked. Use tenant schema instead.',
          TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = 'P0999';
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);

    let installed = 0;
    let skipped = 0;

    for (const tableName of protectedTables) {
      try {
        // Check if table exists in source schema
        const exists = await this.dataSource.query(
          `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'`,
          [sourceSchema, tableName],
        );
        if (exists.length === 0) {
          skipped++;
          continue;
        }

        // Drop existing trigger if any (idempotent)
        await this.dataSource.query(`
          DROP TRIGGER IF EXISTS guard_source_write ON "${sourceSchema}"."${tableName}"
        `);

        // Create the guard trigger
        await this.dataSource.query(`
          CREATE TRIGGER guard_source_write
            BEFORE INSERT OR UPDATE OR DELETE ON "${sourceSchema}"."${tableName}"
            FOR EACH ROW EXECUTE FUNCTION "${sourceSchema}".block_source_writes()
        `);

        installed++;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Failed to install write guard on ${sourceSchema}.${tableName}: ${msg}`);
      }
    }

    this.logger.log(
      `Write guards installed: ${installed} tables protected in "${sourceSchema}" ` +
      `(${referenceSet.size} reference tables excluded, ${skipped} not-yet-created skipped)`,
    );
  }

  /**
   * Temporarily disable write guards for DDL operations (e.g., synchronize).
   * Call this before SourceSchemaBootstrapService.synchronize() if needed.
   */
  async disableGuards(sourceSchema: string, tables: string[]): Promise<void> {
    for (const tableName of tables) {
      try {
        await this.dataSource.query(
          `ALTER TABLE IF EXISTS "${sourceSchema}"."${tableName}" DISABLE TRIGGER guard_source_write`,
        );
      } catch {
        // Table might not exist yet — ignore
      }
    }
    this.logger.debug(`Write guards disabled for ${tables.length} tables in "${sourceSchema}"`);
  }

  /**
   * Re-enable write guards after DDL operations.
   */
  async enableGuards(sourceSchema: string, tables: string[]): Promise<void> {
    for (const tableName of tables) {
      try {
        await this.dataSource.query(
          `ALTER TABLE IF EXISTS "${sourceSchema}"."${tableName}" ENABLE TRIGGER guard_source_write`,
        );
      } catch {
        // Table might not exist yet — ignore
      }
    }
    this.logger.debug(`Write guards re-enabled for ${tables.length} tables in "${sourceSchema}"`);
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
}
