import { Injectable, Logger, OnApplicationBootstrap, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, MigrationExecutor, QueryRunner } from 'typeorm';

/**
 * createMigrationRunnerService
 * ============================================================================
 *
 * Factory that produces an `OnApplicationBootstrap` NestJS provider which
 * runs pending TypeORM migrations — first on the caller-specified source
 * schema, then (for services that own per-tenant schemas) on every
 * `tenant_<uuid16>` schema that matches this service's ownership set.
 *
 * # Why a factory (instead of a generic class)
 *
 * NestJS DI requires providers to be classes with decorators baked in at
 * import time. A generic class parametrised by schema name via a
 * constructor argument forces every service to wire the schema name
 * through its DI module configuration — noisy and easy to get wrong.
 * A factory that captures `sourceSchema` in a closure and returns a
 * service-specific class preserves the one-liner ergonomics while still
 * being schema-aware.
 *
 * # Source-schema invariants (pre-existing, unchanged)
 *
 *   - Session-level `search_path` pin before the first migration (not
 *     `SET LOCAL` — must survive the BEGIN/COMMIT cycles that
 *     `MigrationExecutor` issues in `transaction: 'each'` mode).
 *   - Re-assert the pin before every migration's `up()` so one migration's
 *     `SET search_path` leak can't poison the next (the 2026-04-07
 *     farm-service incident).
 *   - Per-migration transaction: partial failures rollback cleanly.
 *
 * # Tenant-aware fan-out (added for the schema-per-tenant services)
 *
 * Services listed in `TENANT_AWARE_SCHEMAS` own per-tenant schema clones
 * named `tenant_<uuid16>`. A migration that adds a new column to the
 * source schema (e.g. `farm.daily_feeding_executions`) must also land in
 * every existing tenant's copy, or tenant queries start failing with
 * "column does not exist". Historically this required the migration
 * author to hand-roll a schema-discovery loop inside `up()` — most
 * migrations didn't, silently drifting tenant schemas from source.
 *
 * This runner closes the gap architecturally: after the source schema is
 * migrated, it lists every `tenant_*` schema and runs the same migration
 * set against each. The per-tenant `typeorm_migrations` table makes the
 * fan-out idempotent — already-applied migrations on a tenant are skipped
 * by `MigrationExecutor.getPendingMigrations()` on the next boot, so the
 * cost is near-zero after the first deploy.
 *
 * Advisory lock is per-schema (source and each tenant), so two services
 * booting concurrently can fan out without stepping on each other.
 *
 * Shared-schema services (`auth`, `billing`, `notification`, `config`,
 * `admin`) keep the old single-schema behaviour — no tenant loop.
 *
 * # Usage
 *
 * ```ts
 * // apps/farm-service/src/database/database.module.ts
 * import { createMigrationRunnerService } from '@aquaculture/backend-common';
 *
 * const FarmMigrationRunnerService = createMigrationRunnerService('farm');
 * //                                                                ^^^^
 * //                                    Auto-detected as tenant-aware.
 *
 * @Module({ providers: [FarmMigrationRunnerService] })
 * export class DatabaseModule {}
 * ```
 *
 * Override auto-detection via the options bag if needed:
 *
 * ```ts
 * createMigrationRunnerService('farm', { tenantAware: false })  // source only
 * createMigrationRunnerService('auth', { tenantAware: true  })  // manual opt-in
 * ```
 *
 * # SECURITY invariant preserved
 *
 * In production, `DATABASE_MIGRATIONS_RUN=false` hard-fails boot. Schema
 * migrations are mandatory for at-least-once schema delivery; running a
 * service without applying pending migrations risks querying tables that
 * don't yet have their expected columns.
 */

// TENANT_AWARE_SCHEMAS + tenant-schema regex come from the SSoT module
// (MA6). Local duplicates here, in the orchestrator, and in the
// schema-propagation invariant test were prone to drift; the SSoT
// export makes them impossible to diverge.
import {
  TENANT_AWARE_SCHEMAS,
  TENANT_SCHEMA_NAME_RE as TENANT_SCHEMA_RE,
} from '../tenant-aware-schemas';

export interface MigrationRunnerOptions {
  /**
   * Explicit override for tenant fan-out. When omitted, defaults to
   * `true` for `sourceSchema` in `TENANT_AWARE_SCHEMAS`, else `false`.
   */
  tenantAware?: boolean;
  /** Advisory-lock acquisition timeout per schema. Default 300 s. */
  lockTimeoutSeconds?: number;
}

export function createMigrationRunnerService(
  sourceSchema: string,
  options?: MigrationRunnerOptions,
): Type<OnApplicationBootstrap> {
  // Validate at factory-call time — this identifier is interpolated directly
  // into SQL below, so it's the only line between a misconfigured caller and
  // a SQL-injection vector.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sourceSchema)) {
    throw new Error(
      `[createMigrationRunnerService] Unsafe sourceSchema identifier: "${sourceSchema}". ` +
        `Must match /^[a-zA-Z_][a-zA-Z0-9_]*$/.`,
    );
  }

  const tenantAware =
    options?.tenantAware ?? TENANT_AWARE_SCHEMAS.has(sourceSchema);
  const lockTimeoutSeconds = options?.lockTimeoutSeconds ?? 300;

  @Injectable()
  class MigrationRunnerService implements OnApplicationBootstrap {
    private readonly logger = new Logger(
      `MigrationRunnerService[${sourceSchema}]`,
    );

    constructor(
      private readonly dataSource: DataSource,
      private readonly configService: ConfigService,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
      const enabled =
        this.configService.get('DATABASE_MIGRATIONS_RUN', 'true') === 'true';
      const isProduction = this.configService.get('NODE_ENV') === 'production';

      if (!enabled && isProduction) {
        // SECURITY: hard-fail boundary — production MUST run migrations.
        throw new Error(
          'SECURITY: DATABASE_MIGRATIONS_RUN must not be false in production. ' +
            'Schema migrations are mandatory for safe rollouts.',
        );
      }

      if (!enabled) {
        this.logger.warn(
          'Skipping migrations because DATABASE_MIGRATIONS_RUN=false (non-production only)',
        );
        return;
      }

      // ── Phase 1 — source schema (always) ──
      this.logger.log(
        `Phase 1: migrating source schema "${sourceSchema}" (tenantAware=${tenantAware})`,
      );
      await this.runForSchema(sourceSchema);

      // ── Phase 2 — tenant schemas (only for tenant-aware services) ──
      let tenantCount = 0;
      if (tenantAware) {
        const tenantSchemas = await this.listTenantSchemas();
        tenantCount = tenantSchemas.length;
        if (tenantSchemas.length === 0) {
          this.logger.log(
            'Phase 2: no tenant schemas present — skipping tenant fan-out',
          );
        } else {
          this.logger.log(
            `Phase 2: fanning out to ${tenantSchemas.length} tenant schema(s)`,
          );
          for (const tenantSchema of tenantSchemas) {
            // Defense-in-depth: listTenantSchemas already filters via regex,
            // but we re-assert before SQL interpolation.
            if (!TENANT_SCHEMA_RE.test(tenantSchema)) {
              throw new Error(
                `[MigrationRunner:${sourceSchema}] Refusing unsafe tenant ` +
                  `schema name "${tenantSchema}" — expected /${TENANT_SCHEMA_RE.source}/.`,
              );
            }
            await this.runForSchema(tenantSchema);
          }
        }
      }

      // Canonical end-of-run signal (WS7 / required-signals.yaml contract).
      // Fires on EVERY successful runner completion regardless of whether
      // any migration was actually applied — a warm-start path where
      // db-migrate already applied every pending DDL still emits this.
      // The pre-existing "Applied N migration(s)" / "No pending migrations"
      // logs only fire on the per-schema hot path; they don't represent
      // the runner-as-a-whole completing, which is what the deploy-time
      // boot signal is asserting. Pattern matched by required-signals.yaml
      // signal_library.migration_runner_applied (substring).
      this.logger.log(
        `Migration runner complete for schema "${sourceSchema}": tenants=${tenantCount}`,
      );
    }

    /**
     * Query information_schema for every per-tenant schema.
     */
    private async listTenantSchemas(): Promise<string[]> {
      const rows: Array<{ schema_name: string }> = await this.dataSource.query(
        `SELECT schema_name FROM information_schema.schemata
         WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'
         ORDER BY schema_name`,
      );
      return rows.map((r) => r.schema_name);
    }

    /**
     * Acquire advisory lock, pin search_path, run pending migrations for
     * one schema. Invoked once per schema (source + each tenant).
     *
     * Each invocation opens its own QueryRunner and releases it on exit,
     * keeping connection pressure bounded — matches the per-schema
     * isolation pattern used by aqua-db-migrate's orchestrator.
     */
    private async runForSchema(schema: string): Promise<void> {
      const queryRunner = this.dataSource.createQueryRunner();
      try {
        await queryRunner.connect();

        // Advisory-lock key mirrors aqua-db-migrate's
        // `hashtext('aqua-db-migrate:<schema>')` so legacy per-service runners
        // and the consolidation container share a single lock namespace and
        // cannot slip past each other.
        const acquired = await this.acquireAdvisoryLock(queryRunner, schema);
        if (!acquired) {
          throw new Error(
            `[MigrationRunner:${sourceSchema}] Could not acquire advisory lock for ` +
              `"${schema}" within ${lockTimeoutSeconds}s. Another migration runner ` +
              `may be active — resolve before retrying.`,
          );
        }

        try {
          // ── Pin search_path at session level (NOT `SET LOCAL`) ──
          //
          // # The 2026-04-07 farm-service incident this enforcement closes
          //
          // `AddPurchaseOrders1772000000000.up()` ran `SET search_path TO
          // public` at the end of its execution as a "cleanup". Because
          // `SET search_path` without `LOCAL` is SESSION-level, that
          // setting persisted across BEGIN/COMMIT into every subsequent
          // migration — their unqualified `ALTER TABLE ...` statements
          // resolved against `public.*` (where the table does not exist)
          // and crashed every farm-service deploy.
          //
          // The fix is runner-level enforcement: we own the contract and
          // re-assert the correct search_path before every migration's
          // up(), regardless of what the previous migration left the
          // session state as.
          await queryRunner.query(
            `SET search_path TO "${schema}", public`,
          );

          const schemaRow: Array<{ current_schema: string }> =
            await queryRunner.query(`SELECT current_schema()`);
          const observedSchema = schemaRow[0]?.current_schema ?? '<unknown>';

          if (observedSchema !== schema) {
            throw new Error(
              `[MigrationRunner:${sourceSchema}] Failed to pin search_path on ` +
                `"${schema}": observed current_schema() = "${observedSchema}". ` +
                `Verify the schema exists and the DB user has USAGE on it.`,
            );
          }

          this.logger.log(
            `QueryRunner pinned on "${schema}" (current_schema() verified)`,
          );

          const executor = new MigrationExecutor(
            this.dataSource,
            queryRunner,
          );
          executor.transaction = 'each';

          const pending = await executor.getPendingMigrations();
          if (pending.length === 0) {
            this.logger.log(`No pending migrations on "${schema}"`);
            return;
          }

          this.logger.log(
            `Executing ${pending.length} pending migration(s) on "${schema}"`,
          );

          const appliedNames: string[] = [];
          for (const migration of pending) {
            // Re-assert search_path before every migration (see incident
            // note above — runner-level enforcement, not distributed).
            await queryRunner.query(
              `SET search_path TO "${schema}", public`,
            );

            // Per-migration transaction so a partial failure in migration
            // N does not leak uncommitted DDL into migration N+1.
            await queryRunner.startTransaction();
            try {
              await executor.executeMigration(migration);
              await queryRunner.commitTransaction();
              appliedNames.push(migration.name);
              this.logger.log(
                `Migration "${migration.name}" applied on "${schema}"`,
              );
            } catch (migrationErr) {
              await queryRunner.rollbackTransaction();
              const msg =
                migrationErr instanceof Error
                  ? migrationErr.message
                  : String(migrationErr);
              this.logger.error(
                `Migration "${migration.name}" failed on "${schema}": ${msg}`,
                migrationErr instanceof Error
                  ? migrationErr.stack
                  : undefined,
              );
              throw migrationErr;
            }
          }

          this.logger.log(
            `Applied ${appliedNames.length} migration(s) on "${schema}": ${appliedNames.join(', ')}`,
          );
        } finally {
          // Release advisory lock inside the inner try so we always free
          // it even if the SET search_path / MigrationExecutor step threw.
          await queryRunner.query(
            `SELECT pg_advisory_unlock(hashtext('aqua-db-migrate:' || $1))`,
            [schema],
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        this.logger.error(
          `Migration runner failed on schema "${schema}": ${message}`,
          stack,
        );
        // Re-throw — failed migrations indicate a deployment problem and
        // the service must not start with an inconsistent schema.
        throw error;
      } finally {
        // Always release the QueryRunner, even if a step threw. A leaked
        // QueryRunner pins a pool connection forever.
        await queryRunner.release();
      }
    }

    /**
     * Acquire `pg_try_advisory_lock` with polling + timeout. Key matches
     * aqua-db-migrate orchestrator so both runners coordinate.
     */
    private async acquireAdvisoryLock(
      queryRunner: QueryRunner,
      schema: string,
    ): Promise<boolean> {
      const deadline = Date.now() + lockTimeoutSeconds * 1000;
      while (Date.now() < deadline) {
        const rows: Array<{ locked: boolean }> = await queryRunner.query(
          `SELECT pg_try_advisory_lock(hashtext('aqua-db-migrate:' || $1)) AS locked`,
          [schema],
        );
        if (rows[0]?.locked) {
          return true;
        }
        this.logger.warn(
          `Waiting for advisory lock on schema "${schema}" (aqua-db-migrate may be active)`,
        );
        await new Promise((r) => setTimeout(r, 2000));
      }
      return false;
    }
  }

  return MigrationRunnerService;
}
