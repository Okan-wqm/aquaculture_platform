/**
 * aqua-db-migrate container entry point.
 * ============================================================================
 *
 * WS10 / ADR-016 Phase E — Phase 1 (backward-compatible).
 *
 * A one-shot container that applies all pending schema migrations in a
 * deterministic order BEFORE any backend service container starts.
 *
 * # What this container does
 *
 *   1. Reads DB connection details from environment variables (matching
 *      the naming convention used by every backend service's compose
 *      entry: DATABASE_HOST / DATABASE_PORT / DATABASE_USER /
 *      DATABASE_PASSWORD / DATABASE_NAME).
 *   2. Iterates `SCHEMA_REGISTRY` from `./schema-registry.ts` in order.
 *   3. For each entry, invokes `runSchemaMigrations` — a standalone
 *      equivalent of `createMigrationRunnerService` with the same
 *      search_path pinning, per-migration transaction, and post-migration
 *      re-assert invariants.
 *   4. Emits a single JSON log line per event so deploy observers can
 *      grep for `"Schema migration complete"` without string-matching
 *      free-form text.
 *   5. Exits 0 on success, non-zero on any failure.
 *
 * # Why this container exists at all
 *
 * ADR-016 Phase E diagnosis: with 14 services running migrations in
 * parallel on OnApplicationBootstrap, race conditions on shared
 * resources (shared-schema RLS install, source-schema DDL feeding
 * tenant-clone, TimescaleDB hypertable continuous-aggregate creation)
 * become real. Dedicating a single container owns that contention
 * window — it is the ONE process mutating schemas during deploy, while
 * the rest of the platform is still stopped or waiting for
 * `service_completed_successfully` from this container.
 *
 * # Phase 1 boundary — explicit
 *
 * Phase 1 does NOT remove the per-service `createMigrationRunnerService`
 * registrations. If this container fails (container crashes, OOM,
 * network blip), Phase 1 still boots the platform because every
 * service's own runner is a working fallback. That backward-compat is
 * intentional — it lets this container land in production without
 * requiring the Phase 2 schema-version gate that would block boot on
 * this container's absence. Phase 2 landing is tracked as
 * TRACKED-DEPLOY-003 and requires WS9 (staging environment) first.
 *
 * # Exit contract
 *
 *   0 — every schema's pending migrations applied successfully.
 *   1 — at least one schema's migration failed. Deploy workflow MUST
 *       abort without starting service containers.
 *   2 — invocation error (missing env var, unreadable configuration,
 *       postgres unreachable).
 */
// MUST be the FIRST import in the runtime entrypoint. Activates Node's
// `Reflect.getMetadata()` / `Reflect.defineMetadata()` API used by every
// class-level decorator (`@TenantFanOut`, `@ExpandContract`, `@MigrationMeta`,
// `@CompatibleWithAppVersion`) the enterprise-refactor plan ships in Phase 6
// and later. Without this import, decorator metadata is silently a no-op at
// runtime — the orchestrator's class-map dispatch (plan v3 R7) would observe
// empty metadata on every migration class and fall through to a legacy
// code path, giving the illusion that decorators work while they don't.
//
// Plan v3 lists this as CRITICAL kick-off prereq (R29). Every other
// aqua-* service already imports reflect-metadata from its own main.ts
// (grep "reflect-metadata" across apps/). aqua-db-migrate was the lone
// exception because it was born before the plan existed.
//
// Safe to land BEFORE any decorator is authored: the import is inert
// without `Reflect.decorate()` call sites. Prereq-first-deploy pattern
// — we deploy this now, the decorators that rely on it ship later
// phases, the contract is already in place when they do.
import 'reflect-metadata';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseArgs, type ParsedArgs } from './cli-args';
import { SCHEMA_REGISTRY } from './schema-registry';
import {
  rollbackSchemaMigrations,
  runSchemaMigrations,
  type RollbackSchemaResult,
  type RunSchemaOptions,
  type RunSchemaResult,
} from './migration-orchestrator';

/**
 * Resolve the bundle root so migration globs in schema-registry.ts
 * are portable across dev (ts-node) and container (compiled dist) runs.
 *
 * Container layout (Dockerfile.db-migrate COPY path):
 *   /app/dist/main.js                        — entry shim
 *   /app/dist/apps/db-migrate/src/main.js    — this file compiled
 *   /app/dist/apps/<svc>/src/**\/migrations/*.js
 *
 * From __dirname = /app/dist/apps/db-migrate/src the compiled path to
 * /app/dist (the directory that contains apps/<svc>/...) is three
 * parents up: `../../../`.
 *
 * Dev layout (ts-node, unit-test only):
 *   <repo>/apps/db-migrate/src/main.ts
 *   <repo>/apps/<svc>/src/**\/migrations/*.ts
 *
 * From __dirname = <repo>/apps/db-migrate/src the path to <repo> is
 * also three parents up. So the same ".." count works in both.
 *
 * DB_MIGRATE_ROOT env override exists as an escape hatch for layouts
 * this function hasn't anticipated (bind-mounted source tree, etc).
 */
function bundleRoot(): string {
  const override = process.env['DB_MIGRATE_ROOT'];
  if (override) return resolve(override);
  return resolve(__dirname, '..', '..', '..');
}

/** Structured JSON log — matches platform logger shape. */
function log(record: Record<string, unknown>): void {
  process.stdout.write(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      service: 'aqua-db-migrate',
      ...record,
    }) + '\n',
  );
}

/** Read a required string env var or throw. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`[db-migrate] Required env var missing: ${name}`);
  }
  return value;
}

/** Read an env var with fallback default. */
function envOr(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/**
 * Build the SSL options block from env vars matching the convention
 * used by every backend service (DATABASE_SSL / DATABASE_SSL_CA /
 * DATABASE_SSL_REJECT_UNAUTHORIZED). Default: disabled, to match the
 * local-dev compose.
 *
 * Return type binds to the consumer (RunSchemaOptions.database.ssl).
 * The previous `DataSourceOptions['ssl']` annotation failed to type-
 * check because DataSourceOptions is a union of every TypeORM driver's
 * connection type, and `ssl` is not a member of every branch — so the
 * property access resolves to never. Tying the annotation to the actual
 * consumer makes the contract explicit and internally consistent.
 */
function buildSsl(): NonNullable<RunSchemaOptions['database']['ssl']> {
  const enabled = envOr('DATABASE_SSL', 'false') === 'true';
  if (!enabled) return false;
  const caPath = process.env['DATABASE_SSL_CA'];
  const rejectUnauthorized =
    envOr('DATABASE_SSL_REJECT_UNAUTHORIZED', 'true') !== 'false';
  return {
    rejectUnauthorized,
    ...(caPath ? { ca: readFileSync(caPath) } : {}),
  };
}

async function main(): Promise<number> {
  // Parse CLI flags FIRST — a malformed invocation should fail
  // before any side effect (env probing, log banner, DB connect).
  let argv: ParsedArgs;
  try {
    argv = parseArgs(process.argv.slice(2));
  } catch (err: unknown) {
    log({
      level: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
    return 2;
  }

  const rollbackMode = argv.down !== undefined;
  log({
    level: 'info',
    message: rollbackMode
      ? `aqua-db-migrate starting (rollback: --down ${argv.down} --schema ${argv.schema})`
      : 'aqua-db-migrate starting',
    schemaCount: SCHEMA_REGISTRY.length,
    rollbackMode,
  });

  // Production hard-fail boundary — mirrors
  // createMigrationRunnerService. A deploy that set this to "false"
  // in production almost certainly misconfigured the stack; refuse.
  const nodeEnv = envOr('NODE_ENV', 'development');
  const migrationsRun =
    envOr('DATABASE_MIGRATIONS_RUN', 'true') === 'true';
  if (!migrationsRun && nodeEnv === 'production') {
    log({
      level: 'error',
      message:
        'SECURITY: DATABASE_MIGRATIONS_RUN must not be false in production',
    });
    return 2;
  }
  if (!migrationsRun) {
    log({
      level: 'warn',
      message:
        'DATABASE_MIGRATIONS_RUN=false — exiting without applying migrations ' +
        '(allowed in non-production).',
    });
    return 0;
  }

  let database: RunSchemaOptions['database'];
  try {
    database = {
      host: requireEnv('DATABASE_HOST'),
      port: Number.parseInt(envOr('DATABASE_PORT', '5432'), 10),
      username: requireEnv('DATABASE_USER'),
      password: requireEnv('DATABASE_PASSWORD'),
      database: requireEnv('DATABASE_NAME'),
      ssl: buildSsl(),
    };
  } catch (err: unknown) {
    log({
      level: 'error',
      message:
        err instanceof Error ? err.message : String(err),
    });
    return 2;
  }

  // Log the registry on first pass so the reasoning behind each slot
  // is visible to the operator in deploy output.
  for (const entry of SCHEMA_REGISTRY) {
    log({
      level: 'info',
      message: 'Schema slot',
      schema: entry.schema,
      service: entry.service,
      reason: entry.reason,
    });
  }

  const root = bundleRoot();
  log({
    level: 'info',
    message: 'Bundle root resolved',
    root,
  });

  // ── Rollback path (ORPHAN-020) — --down N --schema <name> ──
  //
  // Targets ONE schema registry entry. Tenant fan-out is NOT
  // invoked on rollback (see rollbackSchemaMigrations docblock).
  // Operators roll back per-tenant by invoking this CLI against
  // each tenant schema by name.
  if (rollbackMode) {
    const entry = SCHEMA_REGISTRY.find((e) => e.schema === argv.schema);
    if (entry === undefined) {
      log({
        level: 'error',
        message:
          `[db-migrate] --schema "${argv.schema}" is not in SCHEMA_REGISTRY. ` +
          `Valid values: ${SCHEMA_REGISTRY.map((e) => e.schema).join(', ')}`,
      });
      return 2;
    }
    try {
      const migrations = entry.migrationsGlob.map((g) => resolve(root, g));
      const entities = entry.entitiesGlob?.map((g) => resolve(root, g));
      // Non-null assertion is safe here — rollbackMode is true iff
      // argv.down !== undefined (parseArgs invariant).
      const rollbackResult: RollbackSchemaResult =
        await rollbackSchemaMigrations(
          {
            schema: entry.schema,
            role: entry.role,
            migrations,
            ...(entities ? { entities } : {}),
            database,
            log,
          },
          { count: argv.down as number },
        );
      log({
        level: 'info',
        message: 'aqua-db-migrate rollback complete',
        schema: rollbackResult.schema,
        reverted: rollbackResult.reverted,
        durationMs: rollbackResult.durationMs,
      });
      return 0;
    } catch (err: unknown) {
      log({
        level: 'error',
        message: 'Schema rollback failed — aborting',
        schema: entry.schema,
        service: entry.service,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return 1;
    }
  }

  const results: RunSchemaResult[] = [];
  for (const entry of SCHEMA_REGISTRY) {
    try {
      // Resolve each schema's migration glob against the bundle root so
      // the process works regardless of the process.cwd() at invocation.
      const migrations = entry.migrationsGlob.map((g) => resolve(root, g));
      // Phase H: opt-in entity glob resolution. When the slot declares
      // `entitiesGlob` in SCHEMA_REGISTRY, the orchestrator loads those
      // entities so migrations can introspect canonical metadata
      // (RdbmsSchemaBuilder.log() catch-up sync). Resolved against
      // bundleRoot like migration globs — TypeORM's loader runs from
      // its own cwd, so relative paths match zero files.
      const entities = entry.entitiesGlob?.map((g) => resolve(root, g));
      const result = await runSchemaMigrations({
        schema: entry.schema,
        role: entry.role,
        migrations,
        ...(entities ? { entities } : {}),
        database,
        log,
      });
      results.push(result);
    } catch (err: unknown) {
      log({
        level: 'error',
        message: 'Schema migration failed — aborting',
        schema: entry.schema,
        service: entry.service,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return 1;
    }
  }

  const totalApplied = results.reduce((sum, r) => sum + r.applied.length, 0);
  const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);

  log({
    level: 'info',
    message: 'aqua-db-migrate complete',
    schemaCount: SCHEMA_REGISTRY.length,
    totalAppliedMigrations: totalApplied,
    totalDurationMs: totalDuration,
    perSchema: results.map((r) => ({
      schema: r.schema,
      applied: r.applied.length,
      durationMs: r.durationMs,
    })),
  });

  return 0;
}

// Top-level error sink. We never want an unhandled rejection to exit 0.
main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    log({
      level: 'error',
      message: 'Unhandled error in aqua-db-migrate',
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  });
