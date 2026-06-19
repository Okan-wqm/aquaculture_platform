import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { getMigrationRunnerCompletion } from './migration-runner';
import {
  queryRowsWithStringColumn,
  querySingleStringColumn,
  type StringColumnRow,
} from './query-result-normalizer';

type TableNameRow = StringColumnRow<'table_name'>;

/**
 * Bootstraps source schema tables on service startup.
 *
 * In multi-tenant architecture, each service owns a "source schema" (e.g. `sensor`, `farm`, `hr`)
 * that holds the template table structures. Tenant provisioning is owned by
 * db-migrate, which creates per-tenant schema objects from this catalogued
 * source-schema surface.
 *
 * # Architectural contract (post INFRA-CRITICAL-009)
 *
 * Migrations are the SINGLE SOURCE OF TRUTH for source-schema DDL. Per CLAUDE.md,
 * `dataSource.synchronize()` is FORBIDDEN at runtime. This service VERIFIES that
 * the source schema is healthy after migrations have run, and verifies strict
 * module-ownership. It never mutates schema objects.
 *
 * # Lifecycle ordering
 *
 * Hook: `onApplicationBootstrap` (NOT `onModuleInit`). NestJS may invoke
 * bootstrap hooks concurrently, so this verifier waits on the in-process
 * `MigrationRunnerService` completion promise when the service-side runner is
 * active. In production-like gate mode the external `aqua-db-migrate` container
 * has already populated the schema before service boot.
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
      // Re-throw: a missing-table or orphan-table failure is a deploy-blocking
      // signal, not a "log and continue" condition. The legacy try/catch
      // swallowed the error and let downstream tenant provisioning fail
      // mysteriously; that contract is reversed here.
      throw error;
    }
  }

  private async bootstrapSourceSchema(): Promise<void> {
    // Read the default search_path to determine the source schema
    const searchPathResult: unknown = await this.dataSource.query('SHOW search_path');
    const searchPath = querySingleStringColumn(
      searchPathResult,
      'search_path',
      'SHOW search_path',
    );

    // Extract the source schema (first non-public, non-user schema in search_path)
    const schemas = searchPath
      .split(',')
      .map((s: string) => s.trim().replace(/"/g, ''))
      .filter((s: string) => s && s !== 'public' && s !== '"$user"' && s !== '$user');

    if (schemas.length === 0) {
      throw new Error(
        'No source schema found in connection search_path. ' +
          'SourceSchemaBootstrapService cannot verify migration-owned tables without an explicit source schema. ' +
          'Ensure the TypeORM connection has options: \'-c search_path=<schema>,public\'.',
      );
    }

    const sourceSchema = schemas[0] as string;
    this.logger.log(`Verifying source schema "${sourceSchema}" post-migration state...`);

    const migrationRunnerCompletion =
      getMigrationRunnerCompletion(sourceSchema);
    if (migrationRunnerCompletion) {
      this.logger.log(
        `Waiting for MigrationRunnerService[${sourceSchema}] before source schema verification...`,
      );
      await migrationRunnerCompletion;
    }

    // ── Phase 14: strict module ownership enforcement ──────────────────
    // Before missing-table verification, detect any table in this source
    // schema that is not declared as owned by the module. This is an
    // architectural fix for the cross-module contamination failure mode:
    // tables belonging to other services are reported deterministically
    // on every startup.
    //
    // Runs BEFORE the missing-table verification path so orphans with
    // FK references are surfaced before any RLS discovery query can run.
    await this.assertNoOrphanTables(sourceSchema);

    // Check the post-migration table set
    const tablesResult: unknown = await this.dataSource.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      [sourceSchema],
    );
    const tables = queryRowsWithStringColumn(
      tablesResult,
      'table_name',
      `source schema "${sourceSchema}" table scan`,
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
    existingTables: TableNameRow[],
  ): Promise<void> {
    // Dynamic import to avoid circular dependency
    const mod = await this.getModuleSchema(sourceSchema);

    const existingSet = new Set(existingTables.map(t => t.table_name));
    const expectedTables = this.expectedTablesForModule(mod);
    const missing = expectedTables.filter(t => !existingSet.has(t));

    if (missing.length === 0) {
      this.logger.log(
        `Source schema "${sourceSchema}" verified — all ${expectedTables.length} declared tables present.`,
      );
      return;
    }

    // Hard-fail with the actionable list. The legacy code path called
    // dataSource.synchronize() here, which was the source of INFRA-CRITICAL-009.
    throw new Error(
      `Source schema "${sourceSchema}" is missing ${missing.length}/${expectedTables.length} ` +
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
        `Verify the schema is listed in apps/db-migrate/src/schema-registry.ts.`,
    ].join(' ');
  }

  /**
   * Phase 14: strict module ownership enforcement.
   *
   * Discover every table currently present in the source schema and
   * fail when any table is NOT in the module's declared ownership set
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
   * ## Safety
   *
   * - Runtime DDL is deliberately absent. Orphan cleanup belongs in
   *   db-migrate, where cleanup can be reviewed, versioned, and paired
   *   with rollback and compliance evidence.
   * - Errors are fatal: strict verification MUST be complete before the
   *   service can serve traffic. The single `try` wrapper in
   *   `onApplicationBootstrap` re-throws the fatal error so the deploy
   *   gate catches the regression.
   */
  private async assertNoOrphanTables(sourceSchema: string): Promise<void> {
    const mod = await this.getModuleSchema(sourceSchema);
    if (mod.strictOwnership !== true) {
      this.logger.debug(
        `Module "${mod.moduleName}" does not opt into strict ownership — skipping orphan verification for "${sourceSchema}".`,
      );
      return;
    }

    // Build the authoritative "legitimate tables" set from the three
    // declared lists. Anything in the schema that isn't in this set is
    // an orphan by definition.
    const legitimate = new Set<string>(this.expectedTablesForModule(mod));

    // Query actual tables present in the schema. Excludes views,
    // materialized views, and foreign tables — those are managed
    // differently and the orphan verification policy does not apply to them.
    const rowsResult: unknown = await this.dataSource.query(
      `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
      `,
      [sourceSchema],
    );
    const rows = queryRowsWithStringColumn(
      rowsResult,
      'table_name',
      `source schema "${sourceSchema}" strict ownership table scan`,
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
        `and belong to a different module or a removed transitive import.`,
    );

    throw new Error(
      `Source schema "${sourceSchema}" has ${orphans.length} orphan table(s): ${orphans.join(', ')}. ` +
        `Runtime services cannot clean this with DDL. Add a db-migrate cleanup migration or declare ` +
        `legitimate tables in MODULE_SCHEMAS[${mod.moduleName}] before deploy.`,
    );
  }

  private expectedTablesForModule(mod: {
    tables: readonly string[];
    referenceDataTables?: readonly string[];
    infrastructureTables?: readonly string[];
  }): string[] {
    return [
      ...mod.tables,
      ...(mod.referenceDataTables ?? []),
      ...(mod.infrastructureTables ?? []),
    ];
  }

  private async getModuleSchema(sourceSchema: string): Promise<{
    moduleName: string;
    sourceSchema: string;
    strictOwnership?: boolean;
    tables: readonly string[];
    referenceDataTables?: readonly string[];
    infrastructureTables?: readonly string[];
  }> {
    // Dynamic import to avoid circular dependency between
    // source-schema-bootstrap.service and schema-manager.service.
    const { MODULE_SCHEMAS } = await import('./schema-manager.service');
    const mod = MODULE_SCHEMAS.find(m => m.sourceSchema === sourceSchema);
    if (!mod) {
      throw new Error(
        `Source schema "${sourceSchema}" is not declared in MODULE_SCHEMAS. ` +
          `Runtime services cannot infer schema ownership from search_path. ` +
          `Declare the schema in libs/backend-common/src/database/schema-manager.service.ts ` +
          `or fix the TypeORM search_path before deploy.`,
      );
    }
    return mod;
  }
}
