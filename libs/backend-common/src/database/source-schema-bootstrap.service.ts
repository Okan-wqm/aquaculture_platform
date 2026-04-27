import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Bootstraps source schema tables on service startup.
 *
 * In multi-tenant architecture, each service owns a "source schema" (e.g. `sensor`, `farm`, `hr`)
 * that holds the template table structures. Tenant provisioning copies tables from these source
 * schemas into per-tenant schemas via `CREATE TABLE ... (LIKE source.table ...)`.
 *
 * # Architectural contract (post INFRA-CRITICAL-009)
 *
 * Migrations are the SINGLE SOURCE OF TRUTH for source-schema DDL. Per CLAUDE.md,
 * `dataSource.synchronize()` is FORBIDDEN at runtime. This service VERIFIES that
 * the source schema is healthy after migrations have run, and enforces strict
 * module-ownership (drops cross-module orphan tables). It NEVER creates tables.
 *
 * # Lifecycle ordering
 *
 * Hook: `onApplicationBootstrap` (NOT `onModuleInit`). The bootstrap hook fires
 * AFTER all `onModuleInit` callbacks have completed, which is where service-side
 * `MigrationRunnerService` instances live. Combined with provider-array ordering
 * that declares migration runners BEFORE this service, migrations land first;
 * by the time this service runs, every declared table MUST already exist in the
 * source schema. If any do not, this is a configuration error — not a recoverable
 * condition — and we fail loudly with a remediation message.
 *
 * # Why no synchronize() fallback
 *
 * Three concrete defects from the legacy synchronize-on-empty path:
 *   1. NestJS onModuleInit fires BEFORE onApplicationBootstrap, so synchronize
 *      ran before MigrationRunnerService applied DDL. The fresh DB had no
 *      tables → synchronize created them with shapes derived from current
 *      entity metadata, BYPASSING the migration history. Subsequent migrations
 *      then re-encountered the same tables and either no-op'd (IF NOT EXISTS)
 *      or crashed (no IF NOT EXISTS).
 *   2. TypeORM 0.3.x cannot generate composite-key FK to partitioned tables.
 *      The messaging service's `messages` table is partitioned by
 *      `(id, createdAt)`, but synchronize attempts a single-column FK
 *      `REFERENCES messages(id)` which has no unique constraint to satisfy →
 *      `there is no unique constraint matching given keys for referenced table
 *      "messages"` (CI run 24637240275, INFRA-CRITICAL-009).
 *   3. Synchronize creates columns from entity metadata as-of the running
 *      build, with WRONG nullability when the migration history would have
 *      arrived at NOT NULL via a backfill step. The schema-drift validator
 *      reports the resulting state as drift; operators chase drift that is
 *      synchronize's fault rather than missing migrations.
 *
 * Removing synchronize closes all three classes at once.
 */
@Injectable()
export class SourceSchemaBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SourceSchemaBootstrapService.name);

  constructor(private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.bootstrapSourceSchema();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Source schema bootstrap failed — service WILL crash so the deploy gate catches the regression: ${msg}`,
        stack,
      );
      // Re-throw: a missing-table or orphan-drop failure is a deploy-blocking
      // signal, not a "log and continue" condition. The legacy try/catch
      // swallowed the error and let downstream tenant provisioning fail
      // mysteriously; that contract is reversed here.
      throw error;
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
    this.logger.log(`Verifying source schema "${sourceSchema}" post-migration state...`);

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
    // Runs BEFORE the missing-table verification path so orphans with
    // FK references are gone before any RLS discovery query ever runs.
    await this.dropOrphanTables(sourceSchema);

    // Check the post-migration table set
    const tables = await this.dataSource.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      [sourceSchema],
    );

    if (tables.length === 0) {
      // Empty source schema after migrations have run = configuration error.
      // Either MigrationRunnerService never executed (lifecycle ordering bug)
      // or the migration set is empty (the service has no DDL — declared
      // intent missing in the migrations directory). Both are deploy-blocking.
      const remediation = this.formatEmptySchemaRemediation(sourceSchema);
      throw new Error(
        `Source schema "${sourceSchema}" is empty AFTER application bootstrap — ` +
          `migrations did not run, did not create any tables, or ran against a ` +
          `different schema. Refusing to fall back to runtime synchronize() per ` +
          `INFRA-CRITICAL-009. ${remediation}`,
      );
    }

    // Schema has tables — verify every declared table is present
    await this.assertNoMissingTables(sourceSchema, tables);
  }

  /**
   * Verify the live table set covers every table declared in MODULE_SCHEMAS.
   * Missing tables = declared-but-unmigrated entities. Hard-fail with the
   * exact list so the operator can identify the responsible migration package.
   */
  private async assertNoMissingTables(
    sourceSchema: string,
    existingTables: Array<{ table_name: string }>,
  ): Promise<void> {
    // Dynamic import to avoid circular dependency
    const { MODULE_SCHEMAS } = await import('./schema-manager.service');
    const mod = MODULE_SCHEMAS.find(m => m.sourceSchema === sourceSchema);
    if (!mod) {
      this.logger.debug(
        `No MODULE_SCHEMAS entry for source schema "${sourceSchema}" — ` +
          `skipping declared-vs-actual table reconciliation.`,
      );
      return;
    }

    const existingSet = new Set(existingTables.map(t => t.table_name));
    const missing = mod.tables.filter(t => !existingSet.has(t));

    if (missing.length === 0) {
      this.logger.log(
        `Source schema "${sourceSchema}" verified — all ${mod.tables.length} declared tables present.`,
      );
      return;
    }

    // Hard-fail with the actionable list. The legacy code path called
    // dataSource.synchronize() here, which was the source of INFRA-CRITICAL-009.
    throw new Error(
      `Source schema "${sourceSchema}" is missing ${missing.length}/${mod.tables.length} ` +
        `declared tables: ${missing.join(', ')}. Migrations did not create them. ` +
        `Refusing to fall back to runtime synchronize() per INFRA-CRITICAL-009. ` +
        `Add a migration that CREATEs these tables to ` +
        `apps/${mod.moduleName}-service/src/migrations/ (or wherever the ` +
        `MigrationRunnerService for this schema reads from), then redeploy.`,
    );
  }

  /**
   * Format the remediation message for an empty source schema. Splits
   * the path so the operator can either fix the migration runner OR
   * realise that no migrations exist for this service yet.
   */
  private formatEmptySchemaRemediation(sourceSchema: string): string {
    return [
      `Likely causes:`,
      `  (1) The MigrationRunnerService for "${sourceSchema}" never ran. ` +
        `Verify it is registered in providers BEFORE SourceSchemaBootstrapService ` +
        `(NestJS provider order determines onApplicationBootstrap firing order).`,
      `  (2) The MigrationRunnerService ran but its migrations directory is empty. ` +
        `The service has no declared DDL — add a migration before deploying.`,
      `  (3) The aqua-db-migrate centralised runner did not include this schema. ` +
        `Verify the schema is listed in apps/db-migrate/src/schema-slots.ts (or equivalent).`,
    ].join(' ');
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
   *   `onApplicationBootstrap` re-throws the fatal error so the
   *   deploy gate catches the regression.
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
}
