/**
 * Standalone migration orchestrator (no NestJS DI).
 * ============================================================================
 *
 * ADR-033 — standalone schema migration primitive for aqua-db-migrate.
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
import {
  assertExpandContractDependency,
  isSourceOnlyMigration,
  MIGRATION_LEDGER_TABLE,
} from '@aquaculture/backend-common/database';
import {
  DataSource,
  Migration,
  MigrationExecutor,
  MigrationInterface,
  QueryRunner,
} from 'typeorm';
import type { MixedList } from 'typeorm/common/MixedList';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

/**
 * Safe SQL identifier regex — must match the regex used by
 * `libs/backend-common/src/database/migration-runner/migration-runner.service.ts`
 * so validation semantics across the two runners never diverge.
 */
const SAFE_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const TENANT_SCHEMA_RE = /^tenant_[a-f0-9]{16}$/;

export const MIGRATION_NAME_GUC = 'aqua.migration_name' as const;
export const MIGRATION_DIRECTION_GUC = 'aqua.migration_direction' as const;
export type MigrationDirection = 'up' | 'down';

type MigrationTarget =
  Parameters<typeof assertExpandContractDependency>[0]['migrationClass'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function rowsFromQueryResult(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function booleanColumn(
  rows: readonly Record<string, unknown>[],
  column: string,
): boolean {
  return rows[0]?.[column] === true;
}

function stringColumn(
  row: Record<string, unknown> | undefined,
  column: string,
): string | null {
  const value = row?.[column];
  return typeof value === 'string' ? value : null;
}

/** Hash used for pg_try_advisory_lock keys (one 64-bit int per schema). */
function advisoryLockKey(schema: string): string {
  // Postgres hashtext() is deterministic across a major version; we
  // defer to the server to compute the key so DBAs can inspect
  // pg_locks and recognize the lock by schema name.
  return `hashtext('aqua-db-migrate:${schema.replace(/'/g, "''")}')`;
}

/**
 * Bind exact migration intent to the caller-owned transaction. Database
 * triggers may use this only together with an independent migration-role
 * check; custom GUCs alone are not authority because any session can set one.
 */
export async function setMigrationExecutionContext(
  queryRunner: QueryRunner,
  migrationName: string,
  direction: MigrationDirection,
): Promise<void> {
  if (!queryRunner.isTransactionActive) {
    throw new Error(
      `[db-migrate] Migration context for ${migrationName}/${direction} requires an active transaction.`,
    );
  }
  await queryRunner.query(
    `SELECT pg_catalog.set_config($1, $2, true), pg_catalog.set_config($3, $4, true)`,
    [MIGRATION_NAME_GUC, migrationName, MIGRATION_DIRECTION_GUC, direction],
  );
}

export interface RunSchemaOptions {
  /** Target schema (source schema). Must be a safe SQL identifier. */
  schema: string;
  /** TypeORM migrations path(s) or class list. */
  migrations: MixedList<string | MigrationTarget>;
  /** Optional TypeORM entity glob(s), required by entity-driven migrations. */
  entities?: MixedList<string | MigrationTarget>;
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
  /** TypeORM ledger table name. Defaults to the source-schema ledger. */
  migrationsTableName?: string;
}

export interface RunSchemaResult {
  schema: string;
  migrationsTableName: string;
  pending: number;
  applied: string[];
  head: MigrationLedgerHead | null;
  durationMs: number;
}

export interface MigrationLedgerHead {
  timestamp: string;
  name: string;
}

export interface RollbackSchemaOptions {
  /** Number of latest executed migrations to revert. */
  count: number;
}

export interface RollbackSchemaResult {
  schema: string;
  reverted: string[];
  durationMs: number;
}

interface MigrationSession {
  queryRunner: ReturnType<DataSource['createQueryRunner']>;
  executor: MigrationExecutor;
}

interface PostConditionAwareMigration {
  postCondition?(queryRunner: QueryRunner): Promise<unknown>;
}

function assertSafeSchema(schema: string): void {
  if (!SAFE_IDENT_RE.test(schema)) {
    throw new Error(
      `[db-migrate] Unsafe schema identifier: "${schema}". ` +
        `Must match /^[a-zA-Z_][a-zA-Z0-9_]*$/.`,
    );
  }
}

function createMigrationDataSource(opts: RunSchemaOptions): DataSource {
  const {
    schema,
    migrations,
    entities,
    database,
    migrationsTableName = MIGRATION_LEDGER_TABLE,
  } = opts;

  return new DataSource({
    type: 'postgres',
    host: database.host,
    port: database.port,
    username: database.username,
    password: database.password,
    database: database.database,
    schema,
    ...(entities !== undefined ? { entities } : {}),
    migrations,
    // The runner owns migration execution — TypeORM must NOT run them
    // itself at init time, or we'd execute them twice (once with the
    // wrong search_path, once with the correct one).
    migrationsRun: false,
    migrationsTableName,
    synchronize: false,
    logging: false,
    ssl: database.ssl,
    // Bound pool size to 2: one connection for the migration session,
    // one reserve for the advisory-lock meta-queries below.
    extra: { max: 2 },
  });
}

export async function readLedgerHead(
  queryRunner: QueryRunner,
  schema: string,
  migrationsTableName: string,
): Promise<MigrationLedgerHead | null> {
  const existsRowsResult: unknown = await queryRunner.query(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name = $2
    ) AS exists`,
    [schema, migrationsTableName],
  );
  if (!booleanColumn(rowsFromQueryResult(existsRowsResult), 'exists')) {
    return null;
  }

  const rowsResult: unknown = await queryRunner.query(
    `SELECT "timestamp"::text AS timestamp, "name"
       FROM "${schema}"."${migrationsTableName}"
      ORDER BY "timestamp" DESC, "id" DESC
      LIMIT 1`,
  );
  const row = rowsFromQueryResult(rowsResult)[0];
  const timestamp = stringColumn(row, 'timestamp');
  const name = stringColumn(row, 'name');
  if (timestamp === null || name === null) return null;
  return {
    timestamp,
    name,
  };
}

async function runPostConditionProbe(
  migration: { name: string; instance?: unknown },
  queryRunner: QueryRunner,
  schema: string,
): Promise<void> {
  const instance = migration.instance;
  if (instance === null || typeof instance !== 'object') {
    return;
  }

  const candidate = instance as PostConditionAwareMigration & MigrationInterface;
  if (typeof candidate.postCondition !== 'function') {
    return;
  }

  let result: unknown;
  try {
    result = await candidate.postCondition(queryRunner);
  } catch (probeErr) {
    const wrapped = new Error(
      `Migration "${migration.name}" postCondition() threw on "${schema}" — ` +
        `DDL did not satisfy its declared invariant. Rolling back.`,
    );
    (wrapped as Error & { cause?: unknown }).cause = probeErr;
    throw wrapped;
  }

  if (result === false) {
    throw new Error(
      `Migration "${migration.name}" postCondition() returned false on "${schema}" — ` +
        `DDL did not satisfy its declared invariant. Rolling back.`,
    );
  }
}

async function recordSourceOnlySkip(
  queryRunner: QueryRunner,
  schema: string,
  migrationsTableName: string,
  migration: Migration,
): Promise<void> {
  await queryRunner.query(
    `CREATE TABLE IF NOT EXISTS "${schema}"."${migrationsTableName}" (
       "id" SERIAL NOT NULL PRIMARY KEY,
       "timestamp" bigint NOT NULL,
       "name" varchar NOT NULL
     )`,
  );
  await queryRunner.query(
    `INSERT INTO "${schema}"."${migrationsTableName}" ("timestamp", "name")
     SELECT $1::bigint, $2::varchar
     WHERE NOT EXISTS (
       SELECT 1 FROM "${schema}"."${migrationsTableName}"
        WHERE "timestamp" = $1::bigint AND "name" = $2::varchar
     )`,
    [migration.timestamp, migration.name],
  );
}

async function withLockedMigrationSession<T>(
  opts: RunSchemaOptions,
  work: (session: MigrationSession) => Promise<T>,
): Promise<T> {
  const { schema, log, lockTimeoutSeconds = 300 } = opts;
  assertSafeSchema(schema);

  const dataSource = createMigrationDataSource(opts);
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
      const rowsResult: unknown = await queryRunner.query(
        `SELECT pg_try_advisory_lock(${lockKey}) AS locked`,
      );
      if (booleanColumn(rowsFromQueryResult(rowsResult), 'locked')) {
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
      await queryRunner.query(`SET search_path TO "${schema}", public`);
      const schemaRowsResult: unknown =
        await queryRunner.query(`SELECT current_schema()`);
      const observed = stringColumn(
        rowsFromQueryResult(schemaRowsResult)[0],
        'current_schema',
      );
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
      return await work({ queryRunner, executor });
    } finally {
      // Release the advisory lock even if an error bubbled up.
      try {
        await queryRunner.query(`SELECT pg_advisory_unlock(${lockKey})`);
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
export async function runSchemaMigrations(opts: RunSchemaOptions): Promise<RunSchemaResult> {
  const {
    schema,
    migrations,
    entities,
    log,
    migrationsTableName = MIGRATION_LEDGER_TABLE,
  } = opts;

  const started = Date.now();
  log({
    level: 'info',
    message: 'Schema migration starting',
    context: 'DbMigrate',
    schema,
    migrationsGlobs: migrations,
    ...(entities !== undefined ? { entitiesGlobs: entities } : {}),
  });

  return withLockedMigrationSession(opts, async ({ queryRunner, executor }) => {
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
      const head = await readLedgerHead(queryRunner, schema, migrationsTableName);
      log({
        level: 'info',
        message: 'Schema migration complete',
        context: 'DbMigrate',
        schema,
        applied: [],
        head,
      });
      return {
        schema,
        migrationsTableName,
        pending: 0,
        applied: [],
        head,
        durationMs: Date.now() - started,
      };
    }

    const applied: string[] = [];
    for (const migration of pending) {
      // Re-assert search_path before EVERY migration. Mirrors the
      // contract in libs/backend-common/src/database/migration-runner.
      await queryRunner.query(`SET search_path TO "${schema}", public`);

      const migrationCtor =
        typeof migration.instance === 'object' &&
        migration.instance !== null
          ? (migration.instance as { constructor: MigrationTarget }).constructor
          : undefined;
      if (migrationCtor !== undefined) {
        await assertExpandContractDependency({
          dataSource: queryRunner.connection,
          migrationClass: migrationCtor,
          environment: process.env['AQUA_ENV'] ?? process.env['NODE_ENV'] ?? 'development',
        });

        if (TENANT_SCHEMA_RE.test(schema) && isSourceOnlyMigration(migrationCtor)) {
          await recordSourceOnlySkip(
            queryRunner,
            schema,
            migrationsTableName,
            migration,
          );
          applied.push(`${migration.name} (source-only skipped)`);
          log({
            level: 'info',
            message: 'Migration source-only skipped',
            context: 'DbMigrate',
            schema,
            migration: migration.name,
          });
          continue;
        }
      }

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
        (migration as { instance?: { transaction?: boolean } }).instance?.transaction !== false;

      if (useTransaction) {
        await queryRunner.startTransaction();
      }
      try {
        if (useTransaction) {
          await setMigrationExecutionContext(queryRunner, migration.name, 'up');
        }
        await executor.executeMigration(migration);
        await runPostConditionProbe(migration, queryRunner, schema);
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

    const head = await readLedgerHead(queryRunner, schema, migrationsTableName);

    log({
      level: 'info',
      message: 'Schema migration complete',
      context: 'DbMigrate',
      schema,
      applied,
      head,
    });

    return {
      schema,
      migrationsTableName,
      pending: pending.length,
      applied,
      head,
      durationMs: Date.now() - started,
    };
  });
}

/**
 * Revert the latest executed migration(s) for a single schema.
 *
 * This is intentionally not a deploy-time automatic rollback primitive.
 * Production deploy rollback is release-wide and image-based (ADR-033).
 * This function exists for operator-directed database recovery where the
 * caller explicitly chooses a bounded migration count after inspecting the
 * release ledger and database state.
 */
export async function rollbackSchemaMigrations(
  opts: RunSchemaOptions,
  rollback: RollbackSchemaOptions,
): Promise<RollbackSchemaResult> {
  const { schema, migrations, entities, log } = opts;
  const { count } = rollback;

  if (!Number.isInteger(count) || count < 1) {
    throw new Error(
      `[db-migrate] Rollback count must be a positive integer; received ${count}.`,
    );
  }

  const started = Date.now();
  log({
    level: 'warn',
    message: 'Schema migration rollback starting',
    context: 'DbMigrate',
    schema,
    count,
    migrationsGlobs: migrations,
    ...(entities !== undefined ? { entitiesGlobs: entities } : {}),
  });

  return withLockedMigrationSession(opts, async ({ queryRunner, executor }) => {
    const executed = await executor.getExecutedMigrations();
    if (count > executed.length) {
      throw new Error(
        `[db-migrate] Cannot roll back ${count} migration(s) for "${schema}" ` +
          `because only ${executed.length} executed migration(s) exist.`,
      );
    }

    const reverted: string[] = [];
    for (let i = 0; i < count; i += 1) {
      await queryRunner.query(`SET search_path TO "${schema}", public`);
      const before = await executor.getExecutedMigrations();
      const migration = before[0];
      if (!migration?.name) {
        throw new Error(
          `[db-migrate] Could not identify migration ${i + 1} selected for rollback on "${schema}".`,
        );
      }
      await queryRunner.startTransaction();
      try {
        await setMigrationExecutionContext(queryRunner, migration.name, 'down');
        await executor.undoLastMigration();
        if (queryRunner.isTransactionActive) {
          await queryRunner.commitTransaction();
        }
      } catch (err: unknown) {
        if (queryRunner.isTransactionActive) {
          await queryRunner.rollbackTransaction();
        }
        throw err;
      }
      reverted.push(migration.name);
      log({
        level: 'warn',
        message: 'Migration reverted',
        context: 'DbMigrate',
        schema,
        migration: migration?.name ?? '<unknown>',
      });
    }

    log({
      level: 'warn',
      message: 'Schema migration rollback complete',
      context: 'DbMigrate',
      schema,
      reverted,
    });

    return {
      schema,
      reverted,
      durationMs: Date.now() - started,
    };
  });
}
