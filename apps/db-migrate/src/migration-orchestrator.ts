/**
 * Standalone migration orchestrator (no NestJS DI).
 * ============================================================================
 *
 * WS10 / ADR-016 Phase E — Phase 1.
 *
 * This module runs pending TypeORM migrations for a single PostgreSQL
 * schema from a one-shot container (no HTTP server, no Nest lifecycle).
 * It mirrors the invariants of `createMigrationRunnerService` in
 * `libs/backend-common/src/database/migration-runner/migration-runner.service.ts`
 * but as a plain async function so it can be invoked from a bare CLI
 * entry point without bootstrapping a Nest module graph.
 *
 * # Invariants preserved from the Nest-side runner
 *
 * 1. Source-schema identifier validation.
 *    `search_path` is pinned via string interpolation (`SET search_path TO
 *    "<schema>"`). Anything reaching this SQL must match
 *    /^[a-zA-Z_][a-zA-Z0-9_]*$/ to eliminate the injection vector.
 *
 * 2. Session-level search_path pin.
 *    `SET search_path TO "<schema>", public` (NOT `SET LOCAL`) so the
 *    pin persists across the BEGIN/COMMIT cycles MigrationExecutor issues
 *    in `transaction: 'each'` mode.
 *
 * 3. Re-assert search_path before every migration's up().
 *    Closes the 2026-04-07 farm-service incident class where migration N
 *    left `search_path = public` and migration N+1 silently executed
 *    against the wrong schema.
 *
 * 4. Per-migration transaction.
 *    Partial failure in migration N does not leak uncommitted DDL into
 *    migration N+1's execution.
 *
 * 5. Production hard-fail on DATABASE_MIGRATIONS_RUN=false.
 *    NODE_ENV=production + DATABASE_MIGRATIONS_RUN=false is a security
 *    boundary — the runner aborts rather than silently skipping.
 *
 * # What this runner adds over the Nest-side runner
 *
 * 6. Postgres advisory lock before schema migration.
 *    `pg_try_advisory_lock(hashtext('<schema>'))` — if another writer
 *    holds the lock, this runner waits for release (bounded by a timeout).
 *    Phase 1 runs ONE container per deploy, so the lock is mostly
 *    defensive. Once Phase 2 ships, it prevents a service that hasn't
 *    yet cut over from stepping on the container's toes during a
 *    deploy-mid-hotfix window.
 *
 * # Shape of the output
 *
 * Every log line is a single-line structured JSON record matching the
 * platform logger contract (level, message, context, extra). The deploy
 * workflow greps this output for the
 *   "Schema migration complete"
 * signal to decide whether to unblock service containers. Breaking that
 * contract is a contract change — review like an event shape change.
 */
import { DataSource, MigrationExecutor } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

/**
 * Safe SQL identifier regex — must match the regex used by
 * `libs/backend-common/src/database/migration-runner/migration-runner.service.ts`
 * so validation semantics across the two runners never diverge.
 */
const SAFE_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Hash used for pg_try_advisory_lock keys (one 64-bit int per schema). */
function advisoryLockKey(schema: string): string {
  // Postgres hashtext() is deterministic across a major version; we
  // defer to the server to compute the key so DBAs can inspect
  // pg_locks and recognize the lock by schema name.
  return `hashtext('aqua-db-migrate:${schema.replace(/'/g, "''")}')`;
}

export interface RunSchemaOptions {
  /** Target schema (source schema). Must be a safe SQL identifier. */
  schema: string;
  /** TypeORM migrations path(s) or class list. */
  migrations: string[];
  /** Database connection parameters. */
  database: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
    ssl?: PostgresConnectionOptions['ssl'];
  };
  /** Emit JSON log record. */
  log: (record: Record<string, unknown>) => void;
  /** Advisory-lock acquisition timeout, seconds. Default 300. */
  lockTimeoutSeconds?: number;
}

export interface RunSchemaResult {
  schema: string;
  pending: number;
  applied: string[];
  durationMs: number;
}

/**
 * Run pending migrations for a single schema.
 *
 * The DataSource is created, initialized, used, and destroyed inside
 * this function — the container opens one PostgreSQL connection per
 * schema and closes it before moving on. That is intentional: it keeps
 * resource use bounded (at most one active pool) and makes failures
 * isolate cleanly (an error in schema N does not leak a half-initialised
 * pool into schema N+1).
 */
export async function runSchemaMigrations(
  opts: RunSchemaOptions,
): Promise<RunSchemaResult> {
  const { schema, migrations, database, log, lockTimeoutSeconds = 300 } = opts;

  if (!SAFE_IDENT_RE.test(schema)) {
    throw new Error(
      `[db-migrate] Unsafe schema identifier: "${schema}". ` +
        `Must match /^[a-zA-Z_][a-zA-Z0-9_]*$/.`,
    );
  }

  const started = Date.now();
  log({
    level: 'info',
    message: 'Schema migration starting',
    context: 'DbMigrate',
    schema,
    migrationsGlobs: migrations,
  });

  const dataSource = new DataSource({
    type: 'postgres',
    host: database.host,
    port: database.port,
    username: database.username,
    password: database.password,
    database: database.database,
    schema,
    migrations,
    // The runner owns migration execution — TypeORM must NOT run them
    // itself at init time, or we'd execute them twice (once with the
    // wrong search_path, once with the correct one).
    migrationsRun: false,
    synchronize: false,
    logging: false,
    ssl: database.ssl,
    // Bound pool size to 2: one connection for the migration session,
    // one reserve for the advisory-lock meta-queries below.
    extra: { max: 2 },
  });

  await dataSource.initialize();
  const queryRunner = dataSource.createQueryRunner();

  try {
    await queryRunner.connect();

    // ── Advisory lock so two db-migrate containers cannot race on the
    //    same schema. During Phase 1 only one container runs per deploy,
    //    but the lock is cheap insurance; Phase 2's service-side schema
    //    version gate reuses this same key so a rogue legacy runner
    //    cannot slip in under a live container either.
    const lockKey = advisoryLockKey(schema);
    const lockDeadline = Date.now() + lockTimeoutSeconds * 1000;
    let locked = false;
    while (Date.now() < lockDeadline) {
      const rows: Array<{ locked: boolean }> = await queryRunner.query(
        `SELECT pg_try_advisory_lock(${lockKey}) AS locked`,
      );
      if (rows[0]?.locked) {
        locked = true;
        break;
      }
      log({
        level: 'warn',
        message: 'Waiting for advisory lock',
        context: 'DbMigrate',
        schema,
      });
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!locked) {
      throw new Error(
        `[db-migrate] Could not acquire advisory lock for "${schema}" ` +
          `within ${lockTimeoutSeconds}s. Another migration runner may be ` +
          `active — resolve before retrying.`,
      );
    }

    try {
      // ── Pin search_path at session level (NOT `SET LOCAL`) ──
      await queryRunner.query(
        `SET search_path TO "${schema}", public`,
      );
      const schemaRows: Array<{ current_schema: string }> =
        await queryRunner.query(`SELECT current_schema()`);
      const observed = schemaRows[0]?.current_schema;
      if (observed !== schema) {
        throw new Error(
          `[db-migrate] search_path pin verification failed for "${schema}" — ` +
            `observed current_schema() = "${observed ?? '<null>'}". ` +
            `Ensure 00-init-schemas.sh created the schema and granted USAGE ` +
            `to the connecting role before this container ran.`,
        );
      }

      const executor = new MigrationExecutor(dataSource, queryRunner);
      executor.transaction = 'each';
      const pending = await executor.getPendingMigrations();

      log({
        level: 'info',
        message: 'Pending migrations enumerated',
        context: 'DbMigrate',
        schema,
        pendingCount: pending.length,
        pendingNames: pending.map((m) => m.name),
      });

      if (pending.length === 0) {
        log({
          level: 'info',
          message: 'Schema migration complete',
          context: 'DbMigrate',
          schema,
          applied: [],
        });
        return {
          schema,
          pending: 0,
          applied: [],
          durationMs: Date.now() - started,
        };
      }

      const applied: string[] = [];
      for (const migration of pending) {
        // Re-assert search_path before EVERY migration. Mirrors the
        // contract in libs/backend-common/src/database/migration-runner.
        await queryRunner.query(
          `SET search_path TO "${schema}", public`,
        );

        // Tier-1 architectural correctness: a migration class may
        // declare `transaction = false` to opt OUT of the per-migration
        // transaction wrapper. CONCURRENTLY-scoped DDL (CREATE INDEX
        // CONCURRENTLY, DROP INDEX CONCURRENTLY) cannot run inside any
        // transaction block — Postgres rejects with `cannot run inside
        // a transaction block` regardless of how the wrapper got
        // started. Honoring the instance-level opt-out is the only
        // way to support that DDL surface; ignoring it (the previous
        // unconditional startTransaction) made every CONCURRENTLY
        // migration fail at runtime, which silently propagated through
        // multiple schemas (auth.AddTenantsCustomDomainPartialUnique,
        // farm.AlignCodeSequencesSchema, etc.) until production deploy
        // exposed it. Closes: ORPHAN-CRITICAL-058.
        // WHY: TypeORM's MigrationExecutor.executeMigration() also
        // honors migration.instance.transaction, but the orchestrator
        // was wrapping the call in its OWN transaction layer, so the
        // executor's intent was overruled by the outer wrapper.
        const useTransaction =
          (migration as { instance?: { transaction?: boolean } }).instance
            ?.transaction !== false;

        if (useTransaction) {
          await queryRunner.startTransaction();
        }
        try {
          await executor.executeMigration(migration);
          if (useTransaction && queryRunner.isTransactionActive) {
            await queryRunner.commitTransaction();
          }
          applied.push(migration.name);
          log({
            level: 'info',
            message: 'Migration applied',
            context: 'DbMigrate',
            schema,
            migration: migration.name,
          });
        } catch (err: unknown) {
          if (useTransaction && queryRunner.isTransactionActive) {
            await queryRunner.rollbackTransaction();
          }
          const msg = err instanceof Error ? err.message : String(err);
          log({
            level: 'error',
            message: 'Migration failed',
            context: 'DbMigrate',
            schema,
            migration: migration.name,
            error: msg,
          });
          throw err;
        }
      }

      log({
        level: 'info',
        message: 'Schema migration complete',
        context: 'DbMigrate',
        schema,
        applied,
      });

      return {
        schema,
        pending: pending.length,
        applied,
        durationMs: Date.now() - started,
      };
    } finally {
      // Release the advisory lock even if an error bubbled up.
      try {
        await queryRunner.query(
          `SELECT pg_advisory_unlock(${lockKey})`,
        );
      } catch {
        // unlock failure is non-fatal — the session closes below and
        // advisory locks are session-scoped by default.
      }
    }
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
}
