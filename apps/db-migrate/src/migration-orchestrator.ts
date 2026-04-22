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
import type { EntityMetadata } from 'typeorm';

/**
 * Safe SQL identifier regex — must match the regex used by
 * `libs/backend-common/src/database/migration-runner/migration-runner.service.ts`
 * so validation semantics across the two runners never diverge.
 */
const SAFE_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// TENANT_AWARE_SCHEMAS + tenant-schema regex come from the SSoT module
// in backend-common (MA6). Previously this orchestrator and
// MigrationRunnerService each maintained a local copy of the same
// 7-element Set — the SSoT export makes drift between the two
// impossible.
import {
  TENANT_AWARE_SCHEMAS,
  TENANT_SCHEMA_NAME_RE as TENANT_SCHEMA_RE,
} from '@aquaculture/backend-common';

/** Hash used for pg_try_advisory_lock keys (one 64-bit int per schema). */
function advisoryLockKey(schema: string): string {
  return `hashtext('aqua-db-migrate:${schema.replace(/'/g, "''")}')`;
}

export interface RunSchemaOptions {
  /** Target schema (source schema). Must be a safe SQL identifier. */
  schema: string;
  /**
   * Database role that owns the schema (from SCHEMA_REGISTRY). When
   * provided, the orchestrator CREATEs the schema with AUTHORIZATION
   * to this role if it doesn't already exist — one-time bootstrap for
   * droplets whose init-schemas.sh didn't include the schema at
   * postgres first-init (MA4c safety net for existing-droplet upgrades
   * that add new entries to SCHEMA_REGISTRY). When omitted, the
   * orchestrator assumes the schema was created by init-schemas.sh and
   * fails loudly at search_path pin if absent.
   */
  role?: string;
  /** TypeORM migrations path(s) or class list. */
  migrations: string[];
  /**
   * Optional entity glob path(s) loaded into the per-slot DataSource.
   *
   * When supplied, TypeORM resolves the glob, dynamic-requires each
   * file, and registers every exported class as an entity. The slot's
   * migrations can then introspect `connection.entityMetadatas` (e.g.
   * RdbmsSchemaBuilder.log() for catch-up sync migrations).
   *
   * When omitted, the DataSource has zero entity metadata — preserves
   * the pre-Phase-H runtime behaviour.
   *
   * Loaded entities are filtered post-init: any entity whose declared
   * @Entity({ schema }) does not match `opts.schema` is rejected with
   * a warn log and removed from `entityMetadatas`. This stops cross-
   * schema entities (e.g. admin-api's read-only billing entities) from
   * polluting the metadata graph and breaking entity-driven migrations.
   *
   * Caller MUST resolve relative globs to absolute paths against the
   * bundle root — TypeORM's `entities` glob loader is invoked from its
   * own cwd, not the caller's, so a relative path would silently match
   * zero files. main.ts performs the resolve.
   */
  entities?: string[];
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
 * Rollback knobs for {@link rollbackSchemaMigrations}.
 *
 * `count` — number of applied migrations to revert from the
 * `typeorm_migrations` HEAD, newest-first. `1` undoes only the most
 * recent migration. Must be ≥ 1; the orchestrator refuses to run
 * with 0 (would be a confusing no-op) or a negative number (would
 * be a type-system bypass).
 *
 * Advisory-lock + search_path semantics mirror
 * {@link runSchemaMigrations} byte-for-byte. The tenant-fan-out
 * path is INTENTIONALLY NOT invoked on rollback — reverting a
 * tenant-scoped migration requires per-tenant operator review
 * (some tenants may have business-critical data on the new schema
 * shape), and a blind fan-out reversal is the kind of destructive
 * side-effect ADR-011 forbids without explicit intent. Operators
 * roll back per-tenant by scripting {@link rollbackSchemaMigrations}
 * against each tenant schema by name.
 */
export interface RollbackSchemaOptions {
  /** Number of migrations to undo, newest-first. Must be ≥ 1. */
  count: number;
}

export interface RollbackSchemaResult {
  schema: string;
  /** Number of migrations requested. */
  requested: number;
  /** Names of migrations actually reverted, newest-first. */
  reverted: string[];
  durationMs: number;
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
    // Phase H: opt-in entity loading per slot. Undefined when the slot
    // has no entitiesGlob — preserves the pre-Phase-H entity-less
    // DataSource. See docblock on RunSchemaOptions.entities for the
    // foreign-schema filter that runs immediately after initialize().
    entities: opts.entities,
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

  // ── Phase H post-init filter — reject foreign-schema entities ──
  //
  // When the slot opted in to entity loading, walk the resulting
  // entityMetadatas and remove any entity whose declared @Entity({ schema })
  // does not match this slot's schema. The defense matters because:
  //   1. A glob like `apps/admin-api-service/src/**/*.entity.ts` would
  //      otherwise pull in entities declaring `schema: 'billing'` /
  //      `schema: 'auth'` / `schema: 'shared'` (admin-api owns 4 of these
  //      cross-schema read views), polluting the metadata graph.
  //   2. RdbmsSchemaBuilder.log() inspects EVERY metadata entry. With
  //      foreign-schema entities present it would emit DDL targeting
  //      schemas the slot has no business mutating.
  //   3. The filter logs every rejection with a warn record so
  //      misconfigured opt-ins are visible in deploy output instead
  //      of silently producing wrong DDL.
  //
  // EntityMetadata.schema is undefined when an entity declares no
  // explicit schema (defaults to public). Such entities are also
  // rejected unless the slot itself targets `public`.
  if (opts.entities && opts.entities.length > 0) {
    const beforeCount = dataSource.entityMetadatas.length;
    const foreignEntities = dataSource.entityMetadatas.filter(
      (m) => (m.schema ?? 'public') !== schema,
    );
    if (foreignEntities.length > 0) {
      log({
        level: 'warn',
        message:
          `[${schema}] rejecting ${foreignEntities.length} foreign-schema ` +
          `entities loaded by entitiesGlob (declared schema does not match slot)`,
        context: 'DbMigrate',
        schema,
        rejected: foreignEntities.map(
          (m) => `${m.tableName}(declared schema='${m.schema ?? 'public'}')`,
        ),
      });
      // Mutate in place: TypeORM's MigrationExecutor + RdbmsSchemaBuilder
      // both read from this exact array reference. Replacing it with a
      // filtered copy is the cheapest way to constrain downstream work.
      (dataSource as unknown as { entityMetadatas: EntityMetadata[] })
        .entityMetadatas = dataSource.entityMetadatas.filter(
        (m) => (m.schema ?? 'public') === schema,
      );
    }
    log({
      level: 'info',
      message:
        `[${schema}] loaded ${dataSource.entityMetadatas.length}/${beforeCount} ` +
        `schema-matched entities for entity-aware migrations`,
      context: 'DbMigrate',
      schema,
    });
  }

  const queryRunner = dataSource.createQueryRunner();

  try {
    await queryRunner.connect();

    // ── Phase 0 — bootstrap missing schema on existing droplets (MA4c) ──
    //
    // 00-init-schemas.sh runs ONCE at postgres container first-init. If
    // SCHEMA_REGISTRY gains a new entry after that initial run, the
    // new schema never materialises on the existing droplet — deploy
    // fails at search_path pin. This Phase 0 check heals that gap
    // deterministically, using the SSoT role assignment from the
    // caller (main.ts passes e.role from SCHEMA_REGISTRY). This is
    // NOT a defensive CREATE against arbitrary schemas — the call is
    // gated on `role` being supplied and SAFE_IDENT_RE-validated.
    //
    // Idempotent on the common path (schema present): a single existence
    // check against pg_namespace, zero DDL. Ownership fix (ALTER OWNER)
    // is also issued because a prior orchestrator-level defensive
    // CREATE (b4ccb36a before MA4 removed it) may have created the
    // schema with the connecting user's ownership rather than the
    // intended service role.
    if (opts.role) {
      if (!SAFE_IDENT_RE.test(opts.role)) {
        throw new Error(
          `[db-migrate] Unsafe role identifier: "${opts.role}". ` +
            `Must match /^[a-zA-Z_][a-zA-Z0-9_]*$/.`,
        );
      }
      const roleExists: Array<{ exists: boolean }> = await queryRunner.query(
        `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1) AS exists`,
        [opts.role],
      );
      if (roleExists[0]?.exists) {
        await queryRunner.query(
          `CREATE SCHEMA IF NOT EXISTS "${schema}" AUTHORIZATION "${opts.role}"`,
        );
        await queryRunner.query(
          `ALTER SCHEMA "${schema}" OWNER TO "${opts.role}"`,
        );
      } else {
        // Role missing — init-schemas.sh hasn't been run with the
        // updated role block either. CREATE SCHEMA without AUTHORIZATION
        // as a last-resort (connecting user owns it); at least the
        // schema exists so migrations can land. `ALTER OWNER TO <role>`
        // will be applied by the next init-schemas.sh regeneration.
        log({
          level: 'warn',
          message: 'Phase 0: role missing; creating schema without AUTHORIZATION',
          context: 'DbMigrate',
          schema,
          role: opts.role,
          remediation:
            'Re-run init-schemas.sh (add role block + re-run codegen) ' +
            'to grant correct ownership.',
        });
        await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      }
    }

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

/**
 * Revert the N most recent applied migrations on a schema, newest-
 * first (ORPHAN-020 — apps/db-migrate CLI `--down N`).
 *
 * Each `undoLastMigration()` call wraps in its own transaction;
 * advisory lock is held for the whole session so no concurrent
 * runner can race a half-rolled-back schema.
 *
 * # Semantics mirror runSchemaMigrations
 *
 *   - Same `SAFE_IDENT_RE` identifier validation.
 *   - Same advisory-lock key namespace — NO concurrent up + down on
 *     the same schema.
 *   - Same session-level search_path pin.
 *   - Per-migration transaction via TypeORM's `MigrationExecutor`
 *     (it wraps `down()` in a transaction automatically when
 *     `transaction = 'each'`).
 *
 * # Tenant fan-out is INTENTIONALLY NOT invoked here
 *
 * Reverting a tenant-scoped migration requires per-tenant operator
 * review — some tenants may have business-critical data on the new
 * schema shape. A blind fan-out reversal is the kind of destructive
 * side-effect ADR-011 forbids without explicit intent. Operators
 * roll back per-tenant by scripting this function against each
 * tenant schema by name via the CLI `--schema <name>` flag.
 *
 * @throws when `count < 1` (no-op / typo guard) or when there are
 *   fewer than `count` applied migrations to revert.
 */
export async function rollbackSchemaMigrations(
  opts: RunSchemaOptions,
  rollback: RollbackSchemaOptions,
): Promise<RollbackSchemaResult> {
  const { schema, migrations, database, log, lockTimeoutSeconds = 300 } = opts;
  const { count } = rollback;

  if (!SAFE_IDENT_RE.test(schema)) {
    throw new Error(
      `[db-migrate] Unsafe schema identifier: "${schema}". ` +
        `Must match /^[a-zA-Z_][a-zA-Z0-9_]*$/.`,
    );
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(
      `[db-migrate] rollback count must be a positive integer; got ${count}.`,
    );
  }

  const started = Date.now();
  log({
    level: 'info',
    message: 'Schema rollback starting',
    context: 'DbMigrate',
    schema,
    count,
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
    entities: opts.entities,
    migrationsRun: false,
    synchronize: false,
    logging: false,
    ssl: database.ssl,
    extra: { max: 3 },
  });
  await dataSource.initialize();

  const queryRunner = dataSource.createQueryRunner();
  const lockKey = advisoryLockKey(schema);
  const lockDeadline = Date.now() + lockTimeoutSeconds * 1000;
  let locked = false;

  try {
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

    await queryRunner.query(`SET search_path TO "${schema}", public`);

    const executor = new MigrationExecutor(dataSource, queryRunner);
    executor.transaction = 'each';
    // Use the executor's public accessor so the count of currently-
    // applied migrations is authoritative (vs a raw SELECT from the
    // typeorm_migrations table that could drift from TypeORM's view).
    const applied = await executor.getExecutedMigrations();
    if (applied.length < count) {
      throw new Error(
        `[db-migrate] Schema "${schema}" has ${applied.length} applied ` +
          `migration(s); cannot roll back ${count}. Reduce --down N or ` +
          `verify the schema's typeorm_migrations table.`,
      );
    }

    const reverted: string[] = [];
    for (let i = 0; i < count; i += 1) {
      // Re-assert search_path before EVERY down() — same invariant
      // the up() loop enforces; a down() that drops the pin loses
      // its per-schema isolation.
      await queryRunner.query(`SET search_path TO "${schema}", public`);
      // `undoLastMigration` reads the `typeorm_migrations` HEAD and
      // calls down() on the newest applied entry. It auto-wraps in
      // a transaction when `executor.transaction === 'each'`.
      try {
        await executor.undoLastMigration();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log({
          level: 'error',
          message: 'Rollback failed',
          context: 'DbMigrate',
          schema,
          stepsCompleted: reverted,
          error: msg,
        });
        throw err;
      }
      // The name of the migration we just reverted is the last entry
      // of the pre-rollback `applied` list minus the number of
      // rollbacks already performed.
      const revertedName = applied[applied.length - 1 - i]?.name ?? '<unknown>';
      reverted.push(revertedName);
      log({
        level: 'info',
        message: 'Migration reverted',
        context: 'DbMigrate',
        schema,
        migration: revertedName,
      });
    }

    log({
      level: 'info',
      message: 'Schema rollback complete',
      context: 'DbMigrate',
      schema,
      reverted,
    });

    return {
      schema,
      requested: count,
      reverted,
      durationMs: Date.now() - started,
    };
  } finally {
    try {
      await queryRunner.query(`SELECT pg_advisory_unlock(${lockKey})`);
    } catch {
      // Unlock failure is non-fatal — session closes below and
      // advisory locks are session-scoped.
    }
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
