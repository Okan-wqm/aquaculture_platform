import { Injectable, Logger, OnApplicationBootstrap, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, MigrationExecutor } from 'typeorm';

/**
 * createMigrationRunnerService
 * ============================================================================
 *
 * Factory that produces an `OnApplicationBootstrap` NestJS provider which
 * runs pending TypeORM migrations on a caller-specified source schema.
 *
 * The runner pins the session `search_path` to the target schema BEFORE
 * the first migration executes AND re-asserts that pin between every
 * migration, closing the "one migration's `SET search_path` leaks into
 * the next migration's execution" failure mode observed in farm-service
 * during the 2026-04-07 incident (see the incident notes inlined in the
 * implementation below). This is the same architectural guarantee that
 * the original `apps/farm-service/src/database/services/migration-runner.service.ts`
 * provided — extracted here so that billing / config / notification /
 * alert / ai / event-store (and any future service) can get it without
 * copy-paste drift.
 *
 * # Why a factory (instead of a generic class)
 *
 * NestJS DI requires providers to be classes with decorators baked in at
 * import time. A generic class parametrised by schema name via a
 * constructor argument forces every service to wire the schema name
 * through its DI module configuration — noisy and easy to get wrong.
 * A factory that captures `sourceSchema` in a closure and returns a
 * service-specific class preserves the one-liner ergonomics that the
 * original farm implementation had (`providers: [MigrationRunnerService]`)
 * while still being schema-aware.
 *
 * # Usage
 *
 * ```ts
 * // apps/billing-service/src/database/database.module.ts
 * import { createMigrationRunnerService } from '@aquaculture/backend-common';
 *
 * const BillingMigrationRunnerService =
 *   createMigrationRunnerService('billing');
 *
 * @Module({
 *   providers: [BillingMigrationRunnerService],
 * })
 * export class DatabaseModule {}
 * ```
 *
 * # SECURITY invariant preserved
 *
 * In production, `DATABASE_MIGRATIONS_RUN=false` hard-fails boot. Schema
 * migrations are mandatory for at-least-once schema delivery; running a
 * service without applying pending migrations risks querying tables that
 * don't yet have their expected columns (see the billing `Plan.deleted_at`
 * drift that was caught in the 2026-04-14 log audit).
 *
 * @param sourceSchema Target schema for `search_path`. Must be a safe SQL
 *                     identifier (letters, digits, underscores; no
 *                     starting digit). Unvalidated callers pass arbitrary
 *                     strings straight into SQL — validate at the call
 *                     site. Typical values: `'farm'`, `'billing'`,
 *                     `'notification'`, or `'public'` for global-schema
 *                     services.
 * @returns A class implementing `OnApplicationBootstrap`. Register it in
 *          a NestJS module's `providers` list.
 */
export function createMigrationRunnerService(
  sourceSchema: string,
): Type<OnApplicationBootstrap> {
  // Validate once at factory-call time — the identifier is interpolated
  // directly into SQL below, so this is the only line standing between a
  // misconfigured caller and a SQL injection vector.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sourceSchema)) {
    throw new Error(
      `[createMigrationRunnerService] Unsafe sourceSchema identifier: "${sourceSchema}". ` +
        `Must match /^[a-zA-Z_][a-zA-Z0-9_]*$/.`,
    );
  }

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

      this.logger.log('Running pending migrations on source schema...');

      const queryRunner = this.dataSource.createQueryRunner();
      try {
        await queryRunner.connect();

        // Explicit session-level pin. Do NOT use `SET LOCAL` — LOCAL only
        // applies to the current transaction, and the setting needs to
        // persist across the multiple BEGIN/COMMIT cycles MigrationExecutor
        // issues in `transaction: 'each'` mode.
        await queryRunner.query(
          `SET search_path TO "${sourceSchema}", public`,
        );

        const schemaRow: Array<{ current_schema: string }> =
          await queryRunner.query(`SELECT current_schema()`);
        const observedSchema = schemaRow[0]?.current_schema ?? '<unknown>';
        this.logger.log(
          `queryRunner pinned — observed current_schema() = "${observedSchema}" (expected "${sourceSchema}"). ` +
            `Every migration in this run will execute on this connection with this search_path.`,
        );

        if (observedSchema !== sourceSchema) {
          throw new Error(
            `[MigrationRunner:${sourceSchema}] Failed to pin search_path: observed current_schema() = "${observedSchema}". ` +
              `The "${sourceSchema}" schema must exist and be accessible to the migration user BEFORE this runner executes. ` +
              `Verify that 00-init-schemas.sh ran successfully and that the DB user has USAGE on the schema.`,
          );
        }

        // ── Execute migrations with a runner-enforced search_path invariant ──
        //
        // # The 2026-04-07 incident this runner-level enforcement closes
        //
        // In farm-service, `AddPurchaseOrders1772000000000.up()` ran
        // `SET search_path TO public` at the end of its execution as a
        // "cleanup". Because `SET search_path` without `LOCAL` is
        // SESSION-level, that setting persisted across BEGIN/COMMIT into
        // every subsequent migration. `AddWeatherTables`,
        // `AddFeederCalibrations`, and `AddFeederFieldsToExecution` all
        // inherited `search_path = public`, so their unqualified
        // `ALTER TABLE "daily_feeding_executions"` statements resolved
        // against `public.*` (where the table does not exist) and
        // crashed every farm-service deploy.
        //
        // The architectural fix is runner-level enforcement: we own the
        // contract and re-assert the correct search_path before every
        // migration's up(), regardless of what the previous migration
        // left the session state as. Matches the Single Responsibility
        // Principle — search-path management belongs to the runner, not
        // to individual migration classes.
        const executor = new MigrationExecutor(this.dataSource, queryRunner);
        executor.transaction = 'each';

        const pending = await executor.getPendingMigrations();

        if (pending.length === 0) {
          this.logger.log('No pending migrations');
          return;
        }

        this.logger.log(
          `Executing ${pending.length} pending migration(s) with runner-enforced search_path invariant`,
        );

        const appliedNames: string[] = [];
        for (const migration of pending) {
          // Re-assert the target search_path before every migration's
          // up() runs, regardless of what the previous migration left the
          // session state as. This is the single architectural control
          // point replacing the previously-distributed per-migration
          // cleanup contract.
          await queryRunner.query(
            `SET search_path TO "${sourceSchema}", public`,
          );

          // Per-migration transaction so a partial failure in migration
          // N does not leak uncommitted DDL into migration N+1.
          await queryRunner.startTransaction();
          try {
            await executor.executeMigration(migration);
            await queryRunner.commitTransaction();
            appliedNames.push(migration.name);
            this.logger.log(
              `Migration "${migration.name}" applied successfully`,
            );
          } catch (migrationErr) {
            await queryRunner.rollbackTransaction();
            const msg =
              migrationErr instanceof Error
                ? migrationErr.message
                : String(migrationErr);
            this.logger.error(
              `Migration "${migration.name}" failed: ${msg}`,
              migrationErr instanceof Error ? migrationErr.stack : undefined,
            );
            throw migrationErr;
          }
        }

        this.logger.log(
          `Applied ${appliedNames.length} migration(s): ${appliedNames.join(', ')}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        this.logger.error(
          `Migration runner failed on "${sourceSchema}" schema: ${message}`,
          stack,
        );
        // Re-throw — failed migrations indicate a deployment problem and
        // the service must not start with an inconsistent schema.
        throw error;
      } finally {
        // Always release the queryRunner, even if a step threw. A leaked
        // QueryRunner pins a pool connection forever and is an observable
        // resource drain.
        await queryRunner.release();
      }
    }
  }

  return MigrationRunnerService;
}
