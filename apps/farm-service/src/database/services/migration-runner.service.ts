import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, MigrationExecutor } from 'typeorm';

/**
 * MigrationRunnerService
 * ============================================================================
 *
 * Runs pending TypeORM migrations on the farm source schema AFTER
 * SourceSchemaBootstrapService has finished its `synchronize()` pass.
 *
 * # WHY OnApplicationBootstrap (and not OnModuleInit)
 *
 * `OnApplicationBootstrap` fires after every module's `OnModuleInit`.
 * `SourceSchemaBootstrapService` runs in `OnModuleInit` and may create
 * the base tables via `synchronize()`. Running migrations before that
 * on a fresh DB would fail (`relation does not exist`). Sequencing via
 * lifecycle phases gives a deterministic ordering without coupling this
 * service to backend-common internals.
 *
 * # Why a hand-constructed `MigrationExecutor` with an explicit QueryRunner
 *
 * Earlier revisions of this service called `this.dataSource.runMigrations()`
 * and trusted that the connection TypeORM internally acquired for the
 * migration run would inherit the `farm, public` search_path from the
 * pool-level patch installed by `TenantConnectionBootstrap`. On every
 * farm-service production deploy from 2026-04-07 09:38Z through the
 * 19:00Z cycle, that trust was misplaced: the pre-step query in THIS
 * service reported `current_schema() = "farm"` correctly, but the first
 * query inside every migration reported `current_schema() = "public"`
 * — the migration queryRunner was a DIFFERENT connection than the
 * pre-step queryRunner, and that different connection was drawing its
 * search_path from the pool's contaminated baseline instead of from
 * the patched `pool.connect` path. The observable result was every
 * migration after `AddWeatherTables1773000000000` crashing with
 * `relation "daily_feeding_executions" does not exist`, because the
 * unqualified table name resolved against `public.*` (where the
 * table never existed) instead of against `farm.*` (where it does).
 *
 * The architectural fix is to stop trusting the pool-level search_path
 * invariant for this single high-stakes code path, and instead:
 *
 *   1. Create ONE `QueryRunner` up-front via `dataSource.createQueryRunner()`.
 *   2. Connect it and explicitly issue `SET search_path TO "farm", public`.
 *   3. Verify `current_schema()` is `"farm"` and hard-fail if not.
 *   4. Construct a `MigrationExecutor` by hand, passing our controlled
 *      QueryRunner as its second constructor argument.
 *   5. Set `executor.transaction = 'each'` and call
 *      `executor.executePendingMigrations()`.
 *   6. Release the QueryRunner in `finally`.
 *
 * TypeORM's `MigrationExecutor` uses the provided QueryRunner for every
 * migration's `up()` call and for the transaction boundaries between
 * them. Because PostgreSQL `SET search_path` (without `LOCAL`) is a
 * session-level setting, it persists across `BEGIN`/`COMMIT` boundaries.
 * All migrations therefore execute on the same physical connection with
 * the same search_path invariant, independently of whatever state the
 * rest of the pool might be in.
 *
 * # SECURITY
 *
 * In production, `DATABASE_MIGRATIONS_RUN=false` is forbidden. Schema
 * migrations are mandatory for at-least-once schema delivery. The
 * hard-fail boundary is preserved from the previous revision.
 *
 * @see Phase 0 of farm domain real-time visibility plan
 * @see Phase 12.1 — 2026-04-07 schema split-brain root-cause fix
 */
@Injectable()
export class MigrationRunnerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MigrationRunnerService.name);

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

    // ── Create a controlled QueryRunner for every migration ─────────────
    // This is the authoritative connection for the entire migration run.
    // MigrationExecutor uses whatever queryRunner we pass to its
    // constructor for (a) every migration's up()/down() invocation and
    // (b) the transaction boundaries around each migration. Because
    // PostgreSQL `SET search_path` (without LOCAL) is session-level and
    // persists across BEGIN/COMMIT, pinning the search_path once here
    // guarantees every migration sees `farm` as `current_schema()`.
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();

      // Explicit session-level pin — authoritative control point for
      // all migration queries. Do NOT use `SET LOCAL` here: LOCAL only
      // applies to the current transaction, and we want the setting to
      // persist across the multiple BEGIN/COMMIT cycles that
      // MigrationExecutor issues in `transaction: 'each'` mode.
      await queryRunner.query(`SET search_path TO "farm", public`);

      const schemaRow: Array<{ current_schema: string }> = await queryRunner.query(
        `SELECT current_schema()`,
      );
      const observedSchema = schemaRow[0]?.current_schema ?? '<unknown>';
      this.logger.log(
        `MigrationRunner queryRunner pinned — observed current_schema() = "${observedSchema}" (expected "farm"). ` +
          `Every migration in this run will execute on this connection with this search_path.`,
      );

      if (observedSchema !== 'farm') {
        // Hard-fail before running any migration. If we can't pin to
        // farm schema, either the schema doesn't exist yet (bootstrap
        // ordering bug) or the user lacks access — both are conditions
        // that MUST block the deploy rather than silently mis-target.
        throw new Error(
          `[MigrationRunner] Failed to pin search_path to farm: observed current_schema() = "${observedSchema}". ` +
            `The farm schema must exist and be accessible to the migration user BEFORE this runner executes. ` +
            `Verify that SourceSchemaBootstrapService ran successfully and that the DB user has USAGE on the farm schema.`,
        );
      }

      // ── Hand-rolled migration loop with per-migration search_path reset ──
      // Phase 13.1 — we cannot simply call
      // `executor.executePendingMigrations()` because an individual
      // migration is free to `SET search_path TO something_else` during
      // its own `up()`, and that SET persists on the session-level
      // connection into the NEXT migration's execution. On 2026-04-07
      // `AddPurchaseOrders1772000000000` did exactly that at
      // `apps/farm-service/src/database/migrations/1772000000000-AddPurchaseOrders.ts:95`
      // (`SET search_path TO public` as a "reset" at the end of up()).
      // The subsequent `AddWeatherTables` / `AddFeederCalibrations` /
      // `AddFeederFieldsToExecution` migrations inherited the
      // contaminated `public` search_path, their unqualified
      // `ALTER TABLE "daily_feeding_executions"` resolved against
      // `public.*` where the table never existed, and the whole
      // farm-service bootstrap crashed with `relation does not exist`.
      //
      // The architectural fix is to control the invariant at the
      // RUNNER layer instead of relying on every migration to clean up
      // after itself. Before each migration's `up()` call, we
      // explicitly issue `SET search_path TO "farm", public` on the
      // shared queryRunner. Whatever the previous migration did to the
      // session is overwritten, and every migration starts with the
      // same deterministic initial state — regardless of how careful
      // or careless its author was about cleanup.
      //
      // This also means migrations CAN legitimately manipulate
      // search_path during their own execution (e.g. to iterate tenant
      // schemas as AddPurchaseOrders does) without breaking their
      // neighbours. The runner enforces the contract, not the
      // migration code.
      //
      // We use the MigrationExecutor's helpers (`getAllMigrations` /
      // `loadExecutedMigrations` / `insertExecutedMigration`) for the
      // discovery and bookkeeping so the migrations metadata table
      // stays in sync with TypeORM's expectations — only the per-
      // migration loop is replaced.
      const executor = new MigrationExecutor(this.dataSource, queryRunner);
      executor.transaction = 'each';

      // Ensure the migrations metadata table exists. TypeORM would do
      // this inside executePendingMigrations; we do it manually so our
      // custom loop has a place to record execution.
      // @ts-expect-error — createMigrationsTableIfNotExist is internal
      // but public enough that TypeORM's type surface tolerates access.
      await executor.createMigrationsTableIfNotExist(queryRunner);

      // Discover pending migrations via the executor's public API.
      // @ts-expect-error — loadExecutedMigrations is internal.
      const executed: Array<{ name: string }> = await executor.loadExecutedMigrations(
        queryRunner,
      );
      // @ts-expect-error — getMigrations is internal.
      const allMigrations: Array<{ name: string; instance?: { up: (qr: unknown) => Promise<void> }; transaction?: boolean }> =
        executor.getMigrations();
      const pending = allMigrations.filter(
        (m) => !executed.find((e) => e.name === m.name),
      );

      if (pending.length === 0) {
        this.logger.log('No pending migrations');
      } else {
        this.logger.log(
          `Executing ${pending.length} pending migration(s) with per-migration search_path re-assertion`,
        );

        const appliedNames: string[] = [];
        for (const migration of pending) {
          if (!migration.instance) {
            this.logger.warn(
              `Migration "${migration.name}" has no instance — skipping`,
            );
            continue;
          }

          // Re-assert the farm search_path invariant BEFORE this
          // migration's up() runs. See the docblock above for the full
          // incident history behind this line.
          await queryRunner.query(`SET search_path TO "farm", public`);

          // Each migration runs inside its own BEGIN/COMMIT so a
          // partial failure only rolls back that single migration's
          // DDL, matching the previous `transaction: 'each'` behaviour.
          await queryRunner.startTransaction();
          try {
            await migration.instance.up(queryRunner);
            // @ts-expect-error — insertExecutedMigration is internal.
            await executor.insertExecutedMigration(queryRunner, migration);
            await queryRunner.commitTransaction();
            appliedNames.push(migration.name);
            this.logger.log(`Migration "${migration.name}" applied successfully`);
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
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Migration runner failed on source schema: ${message}`,
        stack,
      );
      // Re-throw — failed migrations indicate a deployment problem and
      // the service must not start with an inconsistent schema.
      throw error;
    } finally {
      // Always release the queryRunner, even if executePendingMigrations
      // or the pin step threw. A leaked QueryRunner pins a pool
      // connection forever and is an observable resource drain.
      await queryRunner.release();
    }
  }
}
