/**
 * Standalone migration orchestrator (no NestJS DI).
 * ============================================================================
 *
 * WS10 / ADR-016 Phase E — Phase 1.
 *
 * This module runs pending TypeORM migrations for a PostgreSQL schema from
 * a one-shot container (no HTTP server, no Nest lifecycle). It mirrors the
 * invariants of `createMigrationRunnerService` in backend-common.
 *
 * # Source-schema invariants (preserved)
 *
 * 1. Source-schema identifier validation.
 * 2. Session-level search_path pin (NOT `SET LOCAL`).
 * 3. Re-assert search_path before every migration's up().
 * 4. Per-migration transaction.
 * 5. Production hard-fail on DATABASE_MIGRATIONS_RUN=false.
 * 6. Postgres advisory lock per schema. Key:
 *    `hashtext('aqua-db-migrate:<schema>')`. Same key namespace as the
 *    per-service MigrationRunnerService so the Phase-1 "both runners can
 *    fire" world is race-free.
 *
 * # Tenant-aware fan-out (WP5)
 *
 * After the source schema is migrated, services listed in
 * `TENANT_AWARE_SCHEMAS` have their migration set replayed against every
 * `tenant_<uuid16>` schema in the database. This closes the "deploy
 * finishes, but existing tenants still lack the new column" window that
 * the per-service runner fan-out (WP3) only narrows to the service's own
 * boot time.
 *
 * Running this at the orchestrator level means every tenant is up-to-date
 * BEFORE any backend container starts.
 *
 * Idempotency: each tenant schema carries its own `typeorm_migrations`
 * table (seeded at provisioning time by SchemaManagerService, WP4). A
 * re-run of an already-applied migration on a tenant is skipped by
 * `MigrationExecutor.getPendingMigrations()`, so fan-out cost is near-
 * zero after the first deploy that introduces a new migration.
 *
 * # Shape of the output
 *
 * Every log line is a single-line structured JSON record. The deploy
 * workflow greps this output for "Schema migration complete".
 */
import { DataSource, MigrationExecutor, QueryRunner } from 'typeorm';

/**
 * Safe SQL identifier regex — must match the regex used by
 * `libs/backend-common/src/database/migration-runner/migration-runner.service.ts`
 * so validation semantics across the two runners never diverge.
 */
const SAFE_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Regex matching per-tenant schema names (`tenant_` + 16 hex). */
const TENANT_SCHEMA_RE = /^tenant_[a-f0-9]{16}$/;

/**
 * Schemas whose services own per-tenant schema clones. Keep in sync with
 * `TENANT_AWARE_SCHEMAS` in backend-common's migration-runner.service.ts
 * — the two lists describe the same architectural fact (which services
 * have schema-per-tenant deployments).
 */
const TENANT_AWARE_SCHEMAS: ReadonlySet<string> = new Set([
  'farm',
  'sensor',
  'hr',
  'messaging',
  'alert',
  'ai',
  'hydroponics',
]);

/** Hash used for pg_try_advisory_lock keys (one 64-bit int per schema). */
function advisoryLockKey(schema: string): string {
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
    ssl?: boolean | Record<string, unknown>;
  };
  /** Emit JSON log record. */
  log: (record: Record<string, unknown>) => void;
  /** Advisory-lock acquisition timeout, seconds. Default 300. */
  lockTimeoutSeconds?: number;
  /**
   * Explicit override for tenant fan-out. When omitted, defaults to
   * `true` if `schema` appears in `TENANT_AWARE_SCHEMAS`, else `false`.
   */
  tenantAware?: boolean;
}

export interface TenantMigrationResult {
  schema: string;
  pending: number;
  applied: string[];
  durationMs: number;
}

export interface RunSchemaResult {
  schema: string;
  pending: number;
  applied: string[];
  durationMs: number;
  /** Per-tenant fan-out results, populated when tenantAware is true. */
  tenantResults?: TenantMigrationResult[];
}

/**
 * Run pending migrations for a schema and (optionally) fan out to every
 * `tenant_<uuid16>` schema in the database.
 *
 * The DataSource is created, initialized, used, and destroyed inside this
 * function — the container opens one PostgreSQL connection per call and
 * closes it before moving on. Resource use is bounded (one active pool
 * per schema-registry entry) and failures isolate cleanly.
 */
export async function runSchemaMigrations(
  opts: RunSchemaOptions,
): Promise<RunSchemaResult> {
  const { schema, migrations, database, log, lockTimeoutSeconds = 300 } = opts;
  const tenantAware = opts.tenantAware ?? TENANT_AWARE_SCHEMAS.has(schema);

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
    tenantAware,
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
    migrationsRun: false,
    synchronize: false,
    logging: false,
    ssl: database.ssl,
    // Pool size 3: one for active migration session, one reserve for
    // advisory-lock meta-queries, one headroom for brief overlap when
    // swapping schemas between source → tenant.
    extra: { max: 3 },
  });

  await dataSource.initialize();
  const queryRunner = dataSource.createQueryRunner();

  try {
    await queryRunner.connect();

    // ── Phase 1 — source schema ──
    const sourceResult = await runMigrationsOnSchema({
      queryRunner,
      dataSource,
      schema,
      log,
      lockTimeoutSeconds,
    });

    // ── Phase 2 — tenant fan-out (only when this service is tenant-aware) ──
    const tenantResults: TenantMigrationResult[] = [];
    if (tenantAware) {
      const tenantSchemas = await listTenantSchemas(queryRunner);
      if (tenantSchemas.length === 0) {
        log({
          level: 'info',
          message: 'Tenant fan-out skipped — no tenant_* schemas present',
          context: 'DbMigrate',
          schema,
        });
      } else {
        log({
          level: 'info',
          message: 'Tenant fan-out starting',
          context: 'DbMigrate',
          schema,
          tenantCount: tenantSchemas.length,
        });
        for (const tenantSchema of tenantSchemas) {
          if (!TENANT_SCHEMA_RE.test(tenantSchema)) {
            throw new Error(
              `[db-migrate] Refusing unsafe tenant schema name "${tenantSchema}" ` +
                `— expected /${TENANT_SCHEMA_RE.source}/.`,
            );
          }
          const tenantResult = await runMigrationsOnSchema({
            queryRunner,
            dataSource,
            schema: tenantSchema,
            log,
            lockTimeoutSeconds,
          });
          tenantResults.push(tenantResult);
        }
        log({
          level: 'info',
          message: 'Tenant fan-out complete',
          context: 'DbMigrate',
          schema,
          tenantCount: tenantSchemas.length,
          totalApplied: tenantResults.reduce(
            (acc, r) => acc + r.applied.length,
            0,
          ),
        });
      }
    }

    return {
      ...sourceResult,
      durationMs: Date.now() - started,
      tenantResults: tenantAware ? tenantResults : undefined,
    };
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
}

/** Query information_schema for every per-tenant schema. */
async function listTenantSchemas(queryRunner: QueryRunner): Promise<string[]> {
  const rows: Array<{ schema_name: string }> = await queryRunner.query(
    `SELECT schema_name FROM information_schema.schemata
     WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'
     ORDER BY schema_name`,
  );
  return rows.map((r) => r.schema_name);
}

interface RunMigrationsOnSchemaArgs {
  queryRunner: QueryRunner;
  dataSource: DataSource;
  schema: string;
  log: (record: Record<string, unknown>) => void;
  lockTimeoutSeconds: number;
}

/**
 * Acquire advisory lock, pin search_path, run pending migrations for ONE
 * schema. Reused for both the source schema and each tenant during fan-out.
 */
async function runMigrationsOnSchema(
  args: RunMigrationsOnSchemaArgs,
): Promise<TenantMigrationResult> {
  const { queryRunner, dataSource, schema, log, lockTimeoutSeconds } = args;
  const started = Date.now();

  // Advisory lock; key namespace shared with MigrationRunnerService.
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
    // Pin search_path at session level (NOT `SET LOCAL`).
    //
    // MA4 (2026-04-16): removed the defensive `CREATE SCHEMA IF NOT EXISTS`
    // that previously lived here. That line was a patch compensating for
    // drift between SCHEMA_REGISTRY and init-schemas.sh. Drift is now
    // architecturally impossible: init-schemas.sh's schema block is
    // generated from SCHEMA_REGISTRY by
    // `scripts/schema-registry/generate-init-schemas.ts`, and
    // `e2e/tests/integration/schema-registry-invariants.spec.ts` rejects
    // any PR that edits SCHEMA_REGISTRY without regenerating.
    await queryRunner.query(`SET search_path TO "${schema}", public`);
    const schemaRows: Array<{ current_schema: string }> =
      await queryRunner.query(`SELECT current_schema()`);
    const observed = schemaRows[0]?.current_schema;
    if (observed !== schema) {
      throw new Error(
        `[db-migrate] search_path pin verification failed for "${schema}" — ` +
          `observed current_schema() = "${observed ?? '<null>'}". ` +
          `Ensure 00-init-schemas.sh ran (regenerate with ` +
          `\`npm run codegen:schema-registry\` if SCHEMA_REGISTRY changed) ` +
          `and that the connecting DB user has USAGE on the schema.`,
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
      // Re-assert search_path before EVERY migration.
      await queryRunner.query(`SET search_path TO "${schema}", public`);
      await queryRunner.startTransaction();
      try {
        await executor.executeMigration(migration);
        await queryRunner.commitTransaction();
        applied.push(migration.name);
        log({
          level: 'info',
          message: 'Migration applied',
          context: 'DbMigrate',
          schema,
          migration: migration.name,
        });
      } catch (err: unknown) {
        await queryRunner.rollbackTransaction();
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
    // Release advisory lock even if an error bubbled up.
    try {
      await queryRunner.query(`SELECT pg_advisory_unlock(${lockKey})`);
    } catch {
      // unlock failure is non-fatal — session closes below and locks are
      // session-scoped.
    }
  }
}
