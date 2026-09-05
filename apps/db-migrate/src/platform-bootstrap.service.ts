/**
 * Platform Bootstrap Atom (ADR-031).
 * ============================================================================
 *
 * Phase 0 of aqua-db-migrate. Runs BEFORE per-service migration loops.
 * Idempotent — re-applies the platform DDL contract every invocation so the
 * system survives:
 *
 *   1. Postgres container restart with non-empty PGDATA (init-scripts
 *      contract only fires once on initdb; restart does NOT re-run them).
 *   2. DROP SCHEMA CASCADE / DROP ROLE / DROP EXTENSION operations from
 *      backup-restore or day-one reset paths.
 *   3. Manual PGDATA volume replacement during disaster recovery.
 *
 * # Architecture
 *
 * The bootstrap is split into 12 ordered stages. Each stage is a single SQL
 * file under apps/db-migrate/src/sql/platform-bootstrap/, except stage 002
 * (roles) which carries env-substituted passwords and is generated in this
 * file. Order is load-bearing:
 *
 *   001  extensions       — CREATE EXTENSION IF NOT EXISTS x6
 *   002  roles            — CREATE ROLE + ALTER ROLE PASSWORD (env-aware)
 *   003  schemas          — CREATE SCHEMA IF NOT EXISTS x17 + AUTHORIZATION
 *   004  schema-grants    — GRANT / ALTER DEFAULT PRIVILEGES idempotent
 *   005  platform-funcs   — CREATE OR REPLACE FUNCTION x4 + GRANT EXECUTE
 *   006  shared-tables    — CREATE TABLE IF NOT EXISTS x5 + RLS + triggers
 *   007  bootstrap-signal — INSERT ON CONFLICT DO UPDATE on platform.bootstrap_signal
 *   008  least-privilege  — final runtime DML-only/schema-owner hardening
 *   009  provisioner      — platform.tenant_schema_jobs request ledger
 *   010  partition-definer — platform.create_messaging_partition (SECURITY
 *        DEFINER, owner messaging_schema_owner) + tenant-schema authority
 *        backfill (DATA-HIGH-006)
 *   011  PITR drill ledger — immutable before/after transaction sentinels
 *        used by the protected timestamp-recovery ceremony (INFRA-HIGH-041)
 *   012  shared-role-hardening — revoke PUBLIC on the shared schema and
 *        re-grant DML to shared_schema_owner only (SEC-MEDIUM-110,
 *        2026-08-23 scan №55: grants enumerate roles, never PUBLIC)
 *
 * # Why TypeScript wraps SQL files
 *
 * Two reasons SQL alone cannot carry this contract:
 *
 *   a) Role passwords come from env vars (one per service role). Embedding
 *      them in checked-in SQL would leak credentials; emitting them at
 *      runtime from this module keeps the SQL files secret-free + reviewable.
 *
 *   b) Stage 004 uses POSTGRES_USER + POSTGRES_DB substitution. psql-style
 *      `:"var"` placeholders don't expand when the SQL is executed via the
 *      node-postgres TypeORM connection — we substitute at read time with a
 *      strict identifier validator before sending to the server.
 *
 * # Tier-1 architectural property
 *
 * The bootstrap runs at the same trust boundary as service migrations
 * (cluster superuser, advisory lock, structured JSON log). A service
 * cannot proceed past SchemaVersionGate without observing the
 * platform.bootstrap_signal row this stage writes — making "missing
 * platform DDL" an unreachable runtime state for app services.
 */
import 'reflect-metadata';

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { PROTECTED_TABLES } from '@aquaculture/backend-common/constants';
import { bootstrapSignalSchemas, platformFunctions } from '@platform/service-catalog';
import { DataSource } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

/**
 * Strict SQL identifier validator — used for every value that becomes a
 * naked SQL identifier (POSTGRES_USER, POSTGRES_DB, role names). Matches
 * the regex used by migration-runner.service.ts so substitution semantics
 * stay aligned across the two runners.
 */
const SAFE_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Service roles created in stage 002. Order matters only for log clarity
 * — every CREATE/ALTER ROLE is wrapped in its own DO block.
 *
 * The list MUST stay aligned with apps/db-migrate/src/schema-registry.ts
 * + libs/backend-common/src/constants/protected-tables.ts.
 */
const SERVICE_ROLES: ReadonlyArray<{ readonly role: string; readonly passEnv: string }> = [
  { role: 'auth_service', passEnv: 'AUTH_SERVICE_DB_PASS' },
  { role: 'farm_service', passEnv: 'FARM_SERVICE_DB_PASS' },
  { role: 'sensor_service', passEnv: 'SENSOR_SERVICE_DB_PASS' },
  { role: 'billing_service', passEnv: 'BILLING_SERVICE_DB_PASS' },
  { role: 'hr_service', passEnv: 'HR_SERVICE_DB_PASS' },
  { role: 'alert_service', passEnv: 'ALERT_SERVICE_DB_PASS' },
  { role: 'admin_service', passEnv: 'ADMIN_SERVICE_DB_PASS' },
  { role: 'gateway_service', passEnv: 'GATEWAY_SERVICE_DB_PASS' },
  { role: 'notification_service', passEnv: 'NOTIFICATION_SERVICE_DB_PASS' },
  { role: 'hydroponics_service', passEnv: 'HYDROPONICS_SERVICE_DB_PASS' },
  { role: 'ai_service', passEnv: 'AI_SERVICE_DB_PASS' },
  { role: 'messaging_service', passEnv: 'MESSAGING_SERVICE_DB_PASS' },
  { role: 'observability_service', passEnv: 'OBSERVABILITY_SERVICE_DB_PASS' },
  { role: 'event_store_service', passEnv: 'EVENT_STORE_SERVICE_DB_PASS' },
  { role: 'config_service', passEnv: 'CONFIG_SERVICE_DB_PASS' },
] as const;

/**
 * Schemas counted in the bootstrap-signal post-condition — DERIVED from the
 * platform-topology SSoT (@platform/service-catalog), never hand-copied. This
 * is the writer half of the count contract the boot gate reads back; keeping
 * both on one source is what closed the ORPHAN-HIGH-405 stale-literal class.
 */
const PLATFORM_SCHEMAS: ReadonlyArray<string> = bootstrapSignalSchemas();

/** Platform functions installed in stage 005 — DERIVED from the topology SSoT. */
const PLATFORM_FUNCTIONS: ReadonlyArray<string> = platformFunctions();

/**
 * Shared schema tables installed in stage 006 — DERIVED from PROTECTED_TABLES'
 * canonical `shared.*` set (the same source the boot gate's
 * EXPECTED_SHARED_TABLE_COUNT reads, parity-enforced against generate-init-
 * schemas + 006-shared-schema-tables.sql by shared-schema-canonical.spec.ts).
 * user_permissions was retired from that set (ADR-042, ORPHAN-HIGH-378); the
 * post-condition only counts tables named here, so behind-DBs still carrying
 * the table pass unchanged.
 */
const SHARED_SCHEMA_TABLES: ReadonlyArray<string> = PROTECTED_TABLES.filter((table) =>
  table.startsWith('shared.'),
).map((table) => table.slice('shared.'.length));

/** Advisory lock key for the platform-bootstrap atom. */
const PLATFORM_BOOTSTRAP_LOCK_NAME = 'aqua-db-migrate:platform-bootstrap';

export interface PlatformBootstrapOptions {
  database: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
    ssl?: PostgresConnectionOptions['ssl'];
  };
  /** Absolute path to apps/db-migrate/src/sql/platform-bootstrap/. */
  sqlDir: string;
  /** Structured JSON logger (matches main.ts log function shape). */
  log: (record: Record<string, unknown>) => void;
  /** Optional bootstrap version label (git SHA / image tag). */
  version?: string;
  /** Advisory-lock acquisition timeout, seconds. Default 300. */
  lockTimeoutSeconds?: number;
}

export interface PlatformBootstrapResult {
  schemaCount: number;
  functionCount: number;
  sharedTableCount: number;
  durationMs: number;
  stagesApplied: string[];
}

/**
 * Substitute the two non-identifier placeholders the bootstrap SQL files
 * carry. Every value is validated as a safe SQL identifier before being
 * inlined; anything else throws before we touch the database.
 */
function substitutePlaceholders(sql: string, vars: Record<string, string>): string {
  let out = sql;
  for (const [key, value] of Object.entries(vars)) {
    if (!SAFE_IDENT_RE.test(value)) {
      throw new Error(
        `[platform-bootstrap] Refusing to substitute unsafe identifier ` +
          `${key}=${JSON.stringify(value)} — must match ${SAFE_IDENT_RE.source}.`,
      );
    }
    out = out.split('${' + key + '}').join(value);
  }
  // After substitution there must be NO unresolved placeholders left.
  // Any survivor is a configuration error — fail loud, never silently
  // ship a SQL statement containing the literal "${VAR}" to the server.
  const stray = out.match(/\$\{[A-Z_]+\}/);
  if (stray) {
    throw new Error(
      `[platform-bootstrap] Unresolved placeholder ${stray[0]} after ` +
        `substitution — every ${'${VAR}'} must have a matching entry in vars.`,
    );
  }
  return out;
}

/**
 * Build the SQL for stage 002 (roles) at runtime so passwords come from
 * env vars rather than checked-in source. Idempotent: every role is
 * created if missing AND password-synced on every run.
 *
 * Password resolution contract (Tier-1 Make-Impossible, ADR-031 follow-up):
 *   - Env var present AND non-empty → use that.
 *   - Env var missing OR empty → throw before any database mutation.
 *
 * The previous random-password fallback was a silent failure surface:
 * Phase 0 reported success while the random secret was never shared with
 * the service container that connects as the role, so Phase 1+ services
 * crash-looped on authentication. The contract is now: every role-bearing
 * env var MUST be provisioned in /var/aqua-saas/.env BEFORE the migration
 * container starts. `scripts/deploy/droplet-up.sh` already enforces this
 * via its `generate_credential` block (l.421–424); fail-fast guarantees
 * the contract holds.
 */
function buildRolesSql(log: PlatformBootstrapOptions['log']): {
  sql: string;
  rolesCreated: number;
} {
  const blocks: string[] = [];
  const missingEnv: string[] = [];
  for (const { role, passEnv } of SERVICE_ROLES) {
    const envValue = process.env[passEnv];
    if (!envValue || envValue.length === 0) {
      missingEnv.push(`${passEnv} (role=${role})`);
      continue;
    }
    const pass = envValue;
    // Escape single quotes for safe embedding in PASSWORD '...' literal.
    const passEscaped = pass.replace(/'/g, "''");
    if (!SAFE_IDENT_RE.test(role)) {
      throw new Error(`[platform-bootstrap] Refusing role name "${role}" — not a safe identifier.`);
    }
    blocks.push(
      `DO $platform_bootstrap_roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${role}') THEN
    EXECUTE 'CREATE ROLE ${role} WITH LOGIN PASSWORD ''${passEscaped}''';
  ELSE
    EXECUTE 'ALTER ROLE ${role} WITH LOGIN PASSWORD ''${passEscaped}''';
  END IF;
END
$platform_bootstrap_roles$;`,
    );
  }
  if (missingEnv.length > 0) {
    throw new Error(
      `[platform-bootstrap] Phase 0 abort: ${missingEnv.length}/${SERVICE_ROLES.length} ` +
        `service-role password env vars are missing or empty: ${missingEnv.join(', ')}. ` +
        `Provision them in /var/aqua-saas/.env BEFORE running aqua-db-migrate. ` +
        `docker-compose.droplet.yml's db-migrate service forwards each *_SERVICE_DB_PASS ` +
        `with an empty :- fallback, so an unset host env var arrives as an empty string in ` +
        `the container. Source of provisioning: scripts/deploy/droplet-up.sh ` +
        `generate_credential loop (l.421–424 for full deploy, l.564–570 for selective). ` +
        `Refusing to ship random passwords that no service can ever know.`,
    );
  }
  log({
    level: 'info',
    message: 'Stage 002 roles SQL synthesised',
    context: 'PlatformBootstrap',
    rolesTotal: SERVICE_ROLES.length,
    rolesEnvSourced: SERVICE_ROLES.length,
  });
  return { sql: blocks.join('\n'), rolesCreated: SERVICE_ROLES.length };
}

/** Order the SQL stage files load. */
function loadOrderedStages(
  sqlDir: string,
  vars: Record<string, string>,
): Array<{ stage: string; sql: string }> {
  const allFiles = readdirSync(sqlDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return allFiles.map((f) => ({
    stage: f,
    sql: substitutePlaceholders(readFileSync(join(sqlDir, f), 'utf8'), vars),
  }));
}

/**
 * Run the platform-bootstrap atom.
 *
 * Idempotent + restart-survive: every CREATE is IF NOT EXISTS, every
 * GRANT is a SET, every CREATE FUNCTION is OR REPLACE, every CREATE
 * POLICY is preceded by DROP POLICY IF EXISTS. Running this function
 * against a fully bootstrapped database is a no-op that completes in
 * sub-second time.
 *
 * Exit contract:
 *   - resolves with PlatformBootstrapResult on full success
 *   - rejects with the underlying error otherwise (caller fails fast)
 */
export async function runPlatformBootstrap(
  opts: PlatformBootstrapOptions,
): Promise<PlatformBootstrapResult> {
  const { database, sqlDir, log, version, lockTimeoutSeconds = 300 } = opts;
  const started = Date.now();

  log({
    level: 'info',
    message: 'Platform bootstrap starting',
    context: 'PlatformBootstrap',
    sqlDir,
    version: version ?? '(unset)',
    targetSchemas: PLATFORM_SCHEMAS.length,
    targetFunctions: PLATFORM_FUNCTIONS.length,
    targetSharedTables: SHARED_SCHEMA_TABLES.length,
  });

  // Validate substitution inputs BEFORE opening any connection.
  if (!SAFE_IDENT_RE.test(database.username)) {
    throw new Error(
      `[platform-bootstrap] POSTGRES_USER "${database.username}" is not a safe identifier ` +
        `(/^[a-zA-Z_][a-zA-Z0-9_]*$/). Refusing to substitute into DDL.`,
    );
  }
  if (!SAFE_IDENT_RE.test(database.database)) {
    throw new Error(
      `[platform-bootstrap] POSTGRES_DB "${database.database}" is not a safe identifier. ` +
        `Refusing to substitute into DDL.`,
    );
  }

  const vars: Record<string, string> = {
    POSTGRES_USER: database.username,
    POSTGRES_DB: database.database,
  };

  // Load every static SQL stage with placeholders already substituted.
  const staticStages = loadOrderedStages(sqlDir, vars);
  const stageNames = staticStages.map((s) => s.stage);

  // Synthesise stage 002 (roles) at runtime.
  const rolesStage = buildRolesSql(log);

  // Open one short-lived DataSource for the entire bootstrap. The
  // connection runs as the superuser (POSTGRES_USER), which is the
  // only role that can CREATE EXTENSION + CREATE ROLE.
  const dataSource = new DataSource({
    type: 'postgres',
    host: database.host,
    port: database.port,
    username: database.username,
    password: database.password,
    database: database.database,
    // No schema pin — bootstrap touches public + every per-service schema.
    schema: 'public',
    migrations: [],
    entities: [],
    migrationsRun: false,
    synchronize: false,
    logging: false,
    ssl: database.ssl,
    extra: { max: 2 },
  });

  await dataSource.initialize();
  const queryRunner = dataSource.createQueryRunner();
  const stagesApplied: string[] = [];

  try {
    await queryRunner.connect();

    // ── Acquire the advisory lock so only one bootstrap atom can run
    //    against this database at a time. Phase 1 has one db-migrate
    //    container per deploy, but the lock is cheap insurance against
    //    a stack-restart racing the same atom.
    const lockKeyExpr = `hashtext('${PLATFORM_BOOTSTRAP_LOCK_NAME}')`;
    const lockDeadline = Date.now() + lockTimeoutSeconds * 1000;
    let locked = false;
    while (Date.now() < lockDeadline) {
      const rows: Array<{ locked: boolean }> = await queryRunner.query(
        `SELECT pg_try_advisory_lock(${lockKeyExpr}) AS locked`,
      );
      if (rows[0]?.locked) {
        locked = true;
        break;
      }
      log({
        level: 'warn',
        message: 'Waiting for platform-bootstrap advisory lock',
        context: 'PlatformBootstrap',
      });
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!locked) {
      throw new Error(
        `[platform-bootstrap] Could not acquire advisory lock within ${lockTimeoutSeconds}s. ` +
          `Another bootstrap may be active — investigate before retrying.`,
      );
    }

    try {
      // Order stages: 001, then synthesised 002, then 003..007.
      const stage001 = staticStages.find((s) => s.stage.startsWith('001-'));
      const stage003plus = staticStages.filter((s) => !s.stage.startsWith('001-'));

      if (!stage001) {
        throw new Error('[platform-bootstrap] Stage 001 SQL file missing from sqlDir.');
      }

      // Stage 001 — extensions.
      log({ level: 'info', message: 'Stage 001: extensions', context: 'PlatformBootstrap' });
      await queryRunner.query(stage001.sql);
      stagesApplied.push(stage001.stage);

      // Stage 002 — roles (synthesised).
      log({
        level: 'info',
        message: 'Stage 002: roles',
        context: 'PlatformBootstrap',
        roleCount: rolesStage.rolesCreated,
      });
      await queryRunner.query(rolesStage.sql);
      stagesApplied.push('002-roles.synthesised');

      // Stages 003..007 — static SQL files in lexicographic order.
      for (const { stage, sql } of stage003plus) {
        log({ level: 'info', message: `Stage ${stage}`, context: 'PlatformBootstrap' });
        await queryRunner.query(sql);
        stagesApplied.push(stage);
      }

      // Verify the artifacts the bootstrap claims to have installed.
      const schemaCheck: Array<{ count: string }> = await queryRunner.query(
        `SELECT COUNT(*)::text AS count FROM pg_namespace WHERE nspname = ANY($1)`,
        [PLATFORM_SCHEMAS as string[]],
      );
      const schemaCount = Number.parseInt(schemaCheck[0]?.count ?? '0', 10);
      if (schemaCount !== PLATFORM_SCHEMAS.length) {
        throw new Error(
          `[platform-bootstrap] Post-condition: expected ${PLATFORM_SCHEMAS.length} platform ` +
            `schemas, observed ${schemaCount}.`,
        );
      }

      const fnCheck: Array<{ count: string }> = await queryRunner.query(
        `SELECT COUNT(*)::text AS count
           FROM pg_proc p
           JOIN pg_namespace n ON p.pronamespace = n.oid
          WHERE n.nspname = 'public'
            AND p.proname = ANY($1)`,
        [PLATFORM_FUNCTIONS as string[]],
      );
      const functionCount = Number.parseInt(fnCheck[0]?.count ?? '0', 10);
      if (functionCount !== PLATFORM_FUNCTIONS.length) {
        throw new Error(
          `[platform-bootstrap] Post-condition: expected ${PLATFORM_FUNCTIONS.length} platform ` +
            `functions in public schema, observed ${functionCount}.`,
        );
      }

      const sharedTableCheck: Array<{ count: string }> = await queryRunner.query(
        `SELECT COUNT(*)::text AS count
           FROM pg_tables
          WHERE schemaname = 'shared' AND tablename = ANY($1)`,
        [SHARED_SCHEMA_TABLES as string[]],
      );
      const sharedTableCount = Number.parseInt(sharedTableCheck[0]?.count ?? '0', 10);
      if (sharedTableCount !== SHARED_SCHEMA_TABLES.length) {
        throw new Error(
          `[platform-bootstrap] Post-condition: expected ${SHARED_SCHEMA_TABLES.length} shared ` +
            `schema tables, observed ${sharedTableCount}.`,
        );
      }

      // Write the bootstrap_signal row (stage 007 created the table; we
      // upsert here so the row also reflects this run's counts).
      await queryRunner.query(
        `INSERT INTO platform.bootstrap_signal
           (id, last_run_at, schema_count, function_count, shared_table_count, bootstrap_version)
         VALUES
           (1, NOW(), $1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
           last_run_at        = EXCLUDED.last_run_at,
           schema_count       = EXCLUDED.schema_count,
           function_count     = EXCLUDED.function_count,
           shared_table_count = EXCLUDED.shared_table_count,
           bootstrap_version  = EXCLUDED.bootstrap_version`,
        [schemaCount, functionCount, sharedTableCount, version ?? null],
      );

      const durationMs = Date.now() - started;
      log({
        level: 'info',
        message: 'Platform bootstrap complete',
        context: 'PlatformBootstrap',
        durationMs,
        schemaCount,
        functionCount,
        sharedTableCount,
        stagesApplied,
        stageNames,
      });

      return {
        schemaCount,
        functionCount,
        sharedTableCount,
        durationMs,
        stagesApplied,
      };
    } finally {
      // Release the advisory lock even if an error bubbled up.
      try {
        await queryRunner.query(`SELECT pg_advisory_unlock(${lockKeyExpr})`);
      } catch {
        // Unlock failure is non-fatal — the session closes below.
      }
    }
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
}

/** Resolve the platform-bootstrap SQL directory across container + dev layouts. */
export function resolvePlatformBootstrapSqlDir(bundleRoot: string): string {
  // Container layout: SQL files are COPY'd into /app/dist/apps/db-migrate/src/sql/...
  // Dev layout: <repo>/apps/db-migrate/src/sql/...
  // Both bundleRoot resolutions land three levels above main.ts, so
  // append the relative path uniformly.
  return resolve(bundleRoot, 'apps', 'db-migrate', 'src', 'sql', 'platform-bootstrap');
}
