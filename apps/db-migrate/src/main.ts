/**
 * aqua-db-migrate container entry point.
 * ============================================================================
 *
 * ADR-031 / ADR-033 — authoritative production schema writer.
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
 * # Production boundary
 *
 * Production app containers use schema-version gates. They may refuse boot
 * when a schema is missing or behind, but they do not write migration ledgers.
 * This container is the single production schema writer. If it fails, the
 * deploy aborts before long-running services start or restart.
 *
 * # Exit contract
 *
 *   0 — every schema's pending migrations applied successfully.
 *   1 — at least one schema's migration failed. Deploy workflow MUST
 *       abort without starting service containers.
 *   2 — invocation error (missing env var, unreadable configuration,
 *       postgres unreachable).
 */
import 'reflect-metadata';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { bootInvariantSignalRecord } from '@aquaculture/backend-common/constants';
import {
  applyTenantRlsToSchema,
  convertAuditColumnsToTimestamptz,
  grantTenantMigrationLedgerReadAccess,
  installSourceSchemaWriteGuards,
  MIGRATION_LEDGER_TABLE,
  tenantMigrationLedgerTable,
  TENANT_AWARE_SCHEMAS,
  TENANT_SCHEMA_NAME_RE,
} from '@aquaculture/backend-common/database';
import { DataSource, QueryRunner } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

import { parseArgs } from './cli-args';
import {
  rollbackSchemaMigrations,
  runSchemaMigrations,
  type MigrationLedgerHead,
  type RollbackSchemaPlan,
  type RunSchemaOptions,
  type RunSchemaResult,
} from './migration-orchestrator';
import { runPlatformBootstrap, resolvePlatformBootstrapSqlDir } from './platform-bootstrap.service';
import {
  SCHEMA_REGISTRY,
  type SchemaPostMigrationHardening,
  type SchemaRegistryEntry,
} from './schema-registry';

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
 */
function buildSsl(): PostgresConnectionOptions['ssl'] {
  const enabled = envOr('DATABASE_SSL', 'false') === 'true';
  if (!enabled) return false;
  const caPath = process.env['DATABASE_SSL_CA'];
  const rejectUnauthorized = envOr('DATABASE_SSL_REJECT_UNAUTHORIZED', 'true') !== 'false';
  return {
    rejectUnauthorized,
    ...(caPath ? { ca: readFileSync(caPath) } : {}),
  };
}

function createControlDataSource(database: RunSchemaOptions['database'], max = 1): DataSource {
  return new DataSource({
    type: 'postgres',
    host: database.host,
    port: database.port,
    username: database.username,
    password: database.password,
    database: database.database,
    migrationsRun: false,
    synchronize: false,
    logging: false,
    ssl: database.ssl,
    extra: { max },
  });
}

const SAFE_SCHEMA_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function assertSafeSchemaIdentifier(schema: string): void {
  if (!SAFE_SCHEMA_IDENT_RE.test(schema)) {
    throw new Error(`[db-migrate] Unsafe schema identifier for hardening: "${schema}".`);
  }
}

async function queryRows<T extends Record<string, unknown>>(
  queryRunner: QueryRunner,
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const result: unknown = await queryRunner.query(sql, params);
  return Array.isArray(result) ? (result as T[]) : [];
}

async function runSchemaPostMigrationHardening(
  database: RunSchemaOptions['database'],
  schema: string,
  hardening: SchemaPostMigrationHardening,
): Promise<void> {
  assertSafeSchemaIdentifier(schema);

  const dataSource = createControlDataSource(database);
  await dataSource.initialize();
  const queryRunner = dataSource.createQueryRunner();
  const helperLogger = {
    log: (message: string): void =>
      log({
        level: 'info',
        message,
        context: 'DbMigrateHardening',
        schema,
      }),
    warn: (message: string): void =>
      log({
        level: 'warn',
        message,
        context: 'DbMigrateHardening',
        schema,
      }),
  };

  try {
    await queryRunner.connect();
    await queryRunner.query(`SET search_path TO "${schema}", public`);
    log({
      level: 'info',
      message: 'Schema post-migration hardening starting',
      context: 'DbMigrateHardening',
      schema,
      reason: hardening.reason,
    });

    if (hardening.tenantRls !== undefined) {
      const rlsOptions = hardening.tenantRls === true ? {} : hardening.tenantRls;
      await applyTenantRlsToSchema(queryRunner, {
        schemaOverride: schema,
        logger: helperLogger,
        ...(rlsOptions.excludeTables !== undefined
          ? { excludeTables: rlsOptions.excludeTables }
          : {}),
        ...(rlsOptions.tenantIdColumns !== undefined
          ? { tenantIdColumns: rlsOptions.tenantIdColumns }
          : {}),
      });
    }

    if (hardening.auditColumns !== undefined) {
      const auditOptions = hardening.auditColumns === true ? {} : hardening.auditColumns;
      await convertAuditColumnsToTimestamptz(queryRunner, {
        schemaOverride: schema,
        logger: helperLogger,
        ...(auditOptions.excludeTables !== undefined
          ? { excludeTables: auditOptions.excludeTables }
          : {}),
        ...(auditOptions.auditColumns !== undefined
          ? { auditColumns: auditOptions.auditColumns }
          : {}),
      });
    }

    if (hardening.sourceWriteGuards === true) {
      await installSourceSchemaWriteGuards(queryRunner, {
        sourceSchema: schema,
        logger: helperLogger,
      });
    }

    log({
      level: 'info',
      message: 'Schema post-migration hardening complete',
      context: 'DbMigrateHardening',
      schema,
    });
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
}

async function withReleaseMigrationLock<T>(
  database: RunSchemaOptions['database'],
  work: () => Promise<T>,
): Promise<T> {
  const dataSource = createControlDataSource(database);
  await dataSource.initialize();
  const queryRunner = dataSource.createQueryRunner();
  const lockName = 'aqua-db-migrate:release-wide';
  const lockTimeoutSeconds = Number.parseInt(
    process.env['DB_MIGRATE_RELEASE_LOCK_TIMEOUT_SECONDS'] ?? '900',
    10,
  );

  try {
    await queryRunner.connect();
    const lockDeadline = Date.now() + lockTimeoutSeconds * 1000;
    let locked = false;
    while (Date.now() < lockDeadline) {
      const rows = await queryRows<{ locked: boolean }>(
        queryRunner,
        `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
        [lockName],
      );
      if (rows[0]?.locked) {
        locked = true;
        break;
      }
      log({
        level: 'warn',
        message: 'Waiting for release-wide migration lock',
        context: 'DbMigrate',
        lockName,
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
    }

    if (!locked) {
      throw new Error(
        `[db-migrate] Could not acquire release-wide advisory lock within ` +
          `${lockTimeoutSeconds}s. Another deploy or migration runner may be active.`,
      );
    }

    try {
      log({
        level: 'info',
        message: 'Release-wide migration lock acquired',
        context: 'DbMigrate',
        lockName,
      });
      return await work();
    } finally {
      await queryRunner.query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockName]);
      log({
        level: 'info',
        message: 'Release-wide migration lock released',
        context: 'DbMigrate',
        lockName,
      });
    }
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
}

async function relationExists(
  queryRunner: QueryRunner,
  schema: string,
  table: string,
): Promise<boolean> {
  const rows = await queryRows<{ exists: boolean }>(
    queryRunner,
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name = $2
     ) AS exists`,
    [schema, table],
  );
  return rows[0]?.exists ?? false;
}

async function ledgerRowCount(
  queryRunner: QueryRunner,
  schema: string,
  table: string,
): Promise<number> {
  const rows = await queryRows<{ count: string }>(
    queryRunner,
    `SELECT COUNT(*)::text AS count FROM "${schema}"."${table}"`,
  );
  return Number.parseInt(rows[0]?.count ?? '0', 10);
}

async function backfillTenantLedgersForSource(
  database: RunSchemaOptions['database'],
  sourceSchema: string,
  tenantSchemas: readonly string[],
): Promise<Array<{ tenantSchema: string; copiedRows: number; skipped: boolean }>> {
  if (tenantSchemas.length === 0) return [];

  const dataSource = createControlDataSource(database);
  await dataSource.initialize();
  const queryRunner = dataSource.createQueryRunner();
  const tenantLedger = tenantMigrationLedgerTable(sourceSchema);
  const backfills: Array<{
    tenantSchema: string;
    copiedRows: number;
    skipped: boolean;
  }> = [];

  try {
    await queryRunner.connect();
    const sourceHasLedger = await relationExists(queryRunner, sourceSchema, MIGRATION_LEDGER_TABLE);
    if (!sourceHasLedger) {
      log({
        level: 'info',
        message: 'Source schema has no migration ledger yet — tenant backfill skipped',
        context: 'DbMigrate',
        sourceSchema,
      });
      return backfills;
    }

    const sourceRows = await ledgerRowCount(queryRunner, sourceSchema, MIGRATION_LEDGER_TABLE);
    if (sourceRows === 0) {
      log({
        level: 'info',
        message: 'Source schema migration ledger is empty — tenant backfill skipped',
        context: 'DbMigrate',
        sourceSchema,
      });
      return backfills;
    }

    for (const tenantSchema of tenantSchemas) {
      if (!TENANT_SCHEMA_NAME_RE.test(tenantSchema)) {
        throw new Error(
          `[db-migrate] Refusing unsafe tenant schema during ledger backfill: ${tenantSchema}`,
        );
      }

      await queryRunner.query(`
        CREATE TABLE IF NOT EXISTS "${tenantSchema}"."${tenantLedger}" (
          "id" SERIAL PRIMARY KEY,
          "timestamp" bigint NOT NULL,
          "name" varchar NOT NULL
        )
      `);
      const grant = await grantTenantMigrationLedgerReadAccess(queryRunner, {
        tenantSchema,
        sourceSchema,
      });
      log({
        level: 'info',
        message: 'Tenant migration ledger read grant asserted',
        context: 'DbMigrate',
        sourceSchema,
        tenantSchema,
        tenantLedger: grant.tenantLedger,
        serviceRole: grant.serviceRole,
      });

      const existingRows = await ledgerRowCount(queryRunner, tenantSchema, tenantLedger);
      if (existingRows > 0) {
        backfills.push({ tenantSchema, copiedRows: 0, skipped: true });
        continue;
      }

      await queryRunner.query(`
        INSERT INTO "${tenantSchema}"."${tenantLedger}" ("timestamp", "name")
        SELECT "timestamp", "name"
          FROM "${sourceSchema}"."${MIGRATION_LEDGER_TABLE}"
      `);
      backfills.push({
        tenantSchema,
        copiedRows: sourceRows,
        skipped: false,
      });
      log({
        level: 'info',
        message: 'Tenant migration ledger backfilled',
        context: 'DbMigrate',
        sourceSchema,
        tenantSchema,
        tenantLedger,
        copiedRows: sourceRows,
      });
    }

    return backfills;
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
}

async function grantTenantLedgerReadAccess(
  database: RunSchemaOptions['database'],
  sourceSchema: string,
  tenantSchema: string,
): Promise<{
  tenantSchema: string;
  sourceSchema: string;
  tenantLedger: string;
  serviceRole: string;
}> {
  const dataSource = createControlDataSource(database);
  await dataSource.initialize();
  const queryRunner = dataSource.createQueryRunner();

  try {
    await queryRunner.connect();
    return await grantTenantMigrationLedgerReadAccess(queryRunner, {
      tenantSchema,
      sourceSchema,
    });
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
}

function headToJson(head: MigrationLedgerHead | null): Record<string, string> | null {
  if (!head) return null;
  return {
    timestamp: head.timestamp,
    name: head.name,
  };
}

function buildHeadPayloads(
  sourceHeads: ReadonlyMap<string, MigrationLedgerHead | null>,
  tenantHeads: ReadonlyMap<string, ReadonlyMap<string, MigrationLedgerHead | null>>,
): {
  expectedHeads: Record<string, unknown>;
  appliedHeads: Record<string, unknown>;
} {
  const expectedSchemas: Record<string, unknown> = {};
  const appliedSchemas: Record<string, unknown> = {};
  for (const [schema, head] of sourceHeads.entries()) {
    expectedSchemas[schema] = headToJson(head);
    appliedSchemas[schema] = headToJson(head);
  }

  const expectedTenants: Record<string, Record<string, unknown>> = {};
  const appliedTenants: Record<string, Record<string, unknown>> = {};
  for (const [tenantSchema, perSource] of tenantHeads.entries()) {
    expectedTenants[tenantSchema] = {};
    appliedTenants[tenantSchema] = {};
    for (const [sourceSchema, head] of perSource.entries()) {
      expectedTenants[tenantSchema][sourceSchema] = headToJson(
        sourceHeads.get(sourceSchema) ?? null,
      );
      appliedTenants[tenantSchema][sourceSchema] = headToJson(head);
    }
  }

  return {
    expectedHeads: {
      schemas: expectedSchemas,
      tenants: expectedTenants,
    },
    appliedHeads: {
      schemas: appliedSchemas,
      tenants: appliedTenants,
    },
  };
}

async function writeReleaseLedgerMigrationState(
  database: RunSchemaOptions['database'],
  args: {
    expectedHeads: Record<string, unknown>;
    appliedHeads: Record<string, unknown>;
    tenantSchemas: readonly string[];
    fanoutResults: Record<string, unknown>;
  },
): Promise<void> {
  const releaseId =
    process.env['DEPLOY_RELEASE_ID'] ?? process.env['DEPLOY_SHA'] ?? 'local-db-migrate';
  const gitSha = process.env['DEPLOY_SHA'] ?? 'unknown';
  const operator = process.env['GHCR_ACTOR'] ?? process.env['GITHUB_ACTOR'] ?? 'aqua-db-migrate';
  const dataSource = createControlDataSource(database);
  await dataSource.initialize();
  const queryRunner = dataSource.createQueryRunner();

  try {
    await queryRunner.connect();
    await queryRunner.query(
      `INSERT INTO platform.release_ledger (
         release_id,
         git_sha,
         expected_heads,
         applied_heads,
         tenant_schema_set,
         tenant_fanout,
         status,
         operator,
         completed_at
       ) VALUES (
         $1,
         $2,
         $3::jsonb,
         $4::jsonb,
         $5::jsonb,
         $6::jsonb,
         'db_complete',
         $7,
         NOW()
       )
       ON CONFLICT (release_id) DO UPDATE SET
         git_sha = EXCLUDED.git_sha,
         expected_heads = EXCLUDED.expected_heads,
         applied_heads = EXCLUDED.applied_heads,
         tenant_schema_set = EXCLUDED.tenant_schema_set,
         tenant_fanout = EXCLUDED.tenant_fanout,
         status = EXCLUDED.status,
         operator = EXCLUDED.operator,
         completed_at = EXCLUDED.completed_at,
         updated_at = NOW()`,
      [
        releaseId,
        gitSha,
        JSON.stringify(args.expectedHeads),
        JSON.stringify(args.appliedHeads),
        JSON.stringify(args.tenantSchemas),
        JSON.stringify(args.fanoutResults),
        operator,
      ],
    );
    log({
      level: 'info',
      message: 'Release ledger migration state recorded',
      context: 'DbMigrate',
      releaseId,
      tenantCount: args.tenantSchemas.length,
    });
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
}

type RollbackLedgerStatus = 'rollback_attempted' | 'rollback_verified' | 'rollback_failed';

interface RollbackLedgerStateArgs {
  releaseId: string;
  gitSha: string;
  operator: string;
  schema: string;
  service: string;
  count: number;
  status: RollbackLedgerStatus;
  plan?: RollbackSchemaPlan;
  afterHead?: MigrationLedgerHead | null;
  durationMs?: number;
  error?: string;
}

function resolveRollbackReleaseId(confirmRelease: string | undefined): string {
  const releaseId = process.env['DEPLOY_RELEASE_ID'] ?? process.env['DEPLOY_SHA'];
  if (releaseId === undefined || releaseId.length === 0) {
    throw new Error(
      '[db-migrate] Rollback requires DEPLOY_RELEASE_ID or DEPLOY_SHA so release-ledger evidence is bound to a concrete release.',
    );
  }
  if (confirmRelease !== releaseId) {
    throw new Error(
      `[db-migrate] --confirm-release must match the active release id. ` +
        `expected="${releaseId}" received="${confirmRelease ?? '<missing>'}".`,
    );
  }
  return releaseId;
}

function resolveRollbackOperator(): string {
  const operator =
    process.env['DB_MIGRATE_OPERATOR'] ?? process.env['GHCR_ACTOR'] ?? process.env['GITHUB_ACTOR'];
  if (operator !== undefined && operator.length > 0) {
    return operator;
  }

  const nodeEnv = process.env['NODE_ENV'] ?? 'development';
  const aquaEnv = process.env['AQUA_ENV'] ?? nodeEnv;
  const productionLike =
    nodeEnv === 'production' || aquaEnv === 'production' || aquaEnv === 'staging';
  if (productionLike) {
    throw new Error(
      '[db-migrate] Production rollback requires DB_MIGRATE_OPERATOR, GHCR_ACTOR, or GITHUB_ACTOR.',
    );
  }

  const localOperator = process.env['USER'];
  if (localOperator === undefined || localOperator.length === 0) {
    throw new Error(
      '[db-migrate] Rollback requires DB_MIGRATE_OPERATOR, GHCR_ACTOR, GITHUB_ACTOR, or USER.',
    );
  }
  return localOperator;
}

function rollbackHeadPayload(head: MigrationLedgerHead | null | undefined): string {
  return JSON.stringify(headToJson(head ?? null));
}

async function writeReleaseLedgerRollbackState(
  database: RunSchemaOptions['database'],
  args: RollbackLedgerStateArgs,
): Promise<void> {
  const dataSource = createControlDataSource(database);
  await dataSource.initialize();
  const queryRunner = dataSource.createQueryRunner();
  const expectedHeadJson = rollbackHeadPayload(args.plan?.targetHead);
  const appliedHeadJson = rollbackHeadPayload(
    args.status === 'rollback_verified' ? args.afterHead : args.plan?.beforeHead,
  );
  const metadata = {
    rollback: {
      releaseId: args.releaseId,
      schema: args.schema,
      service: args.service,
      count: args.count,
      operator: args.operator,
      status: args.status,
      beforeHead: args.plan?.beforeHead ?? null,
      targetHead: args.plan?.targetHead ?? null,
      afterHead: args.afterHead ?? null,
      revertedMigrations: args.plan?.revertedMigrations ?? [],
      durationMs: args.durationMs,
      error: args.error,
      recordedAt: new Date().toISOString(),
    },
  };

  try {
    await queryRunner.connect();
    await queryRunner.query(
      `INSERT INTO platform.release_ledger (
         release_id,
         git_sha,
         expected_heads,
         applied_heads,
         deploy_metadata,
         status,
         operator,
         schema_may_be_forward,
         rollback_attempted,
         rollback_verified,
         rollback_failed,
         failure_phase,
         completed_at
       ) VALUES (
         $1,
         $2,
         jsonb_build_object('schemas', jsonb_build_object($3::text, $4::jsonb)),
         jsonb_build_object('schemas', jsonb_build_object($3::text, $5::jsonb)),
         $6::jsonb,
         $7,
         $8,
         $9,
         $10,
         $11,
         $12,
         $13,
         CASE WHEN $7 IN ('rollback_verified', 'rollback_failed') THEN NOW() ELSE NULL END
       )
       ON CONFLICT (release_id) DO UPDATE SET
         git_sha = EXCLUDED.git_sha,
         expected_heads = jsonb_set(
           jsonb_set(
             COALESCE(platform.release_ledger.expected_heads, '{}'::jsonb),
             '{schemas}',
             COALESCE(platform.release_ledger.expected_heads->'schemas', '{}'::jsonb),
             true
           ),
           ARRAY['schemas', $3::text],
           $4::jsonb,
           true
         ),
         applied_heads = jsonb_set(
           jsonb_set(
             COALESCE(platform.release_ledger.applied_heads, '{}'::jsonb),
             '{schemas}',
             COALESCE(platform.release_ledger.applied_heads->'schemas', '{}'::jsonb),
             true
           ),
           ARRAY['schemas', $3::text],
           $5::jsonb,
           true
         ),
         deploy_metadata =
           COALESCE(platform.release_ledger.deploy_metadata, '{}'::jsonb) ||
           EXCLUDED.deploy_metadata,
         status = EXCLUDED.status,
         operator = EXCLUDED.operator,
         schema_may_be_forward = EXCLUDED.schema_may_be_forward,
         rollback_attempted =
           platform.release_ledger.rollback_attempted OR EXCLUDED.rollback_attempted,
         rollback_verified =
           platform.release_ledger.rollback_verified OR EXCLUDED.rollback_verified,
         rollback_failed =
           platform.release_ledger.rollback_failed OR EXCLUDED.rollback_failed,
         failure_phase = EXCLUDED.failure_phase,
         completed_at =
           CASE WHEN EXCLUDED.status IN ('rollback_verified', 'rollback_failed')
             THEN EXCLUDED.completed_at
             ELSE platform.release_ledger.completed_at
           END,
         updated_at = NOW()`,
      [
        args.releaseId,
        args.gitSha,
        args.schema,
        expectedHeadJson,
        appliedHeadJson,
        JSON.stringify(metadata),
        args.status,
        args.operator,
        args.status !== 'rollback_verified',
        true,
        args.status === 'rollback_verified',
        args.status === 'rollback_failed',
        args.status === 'rollback_failed' ? 'schema_rollback' : null,
      ],
    );
    log({
      level: args.status === 'rollback_failed' ? 'error' : 'warn',
      message: 'Release ledger rollback state recorded',
      context: 'DbMigrateRollback',
      releaseId: args.releaseId,
      schema: args.schema,
      status: args.status,
    });
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
}

async function listTenantSchemas(database: RunSchemaOptions['database']): Promise<string[]> {
  const dataSource = createControlDataSource(database);

  await dataSource.initialize();
  try {
    const rows: Array<{ schema_name: string }> = await dataSource.query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'
       ORDER BY schema_name`,
    );
    return rows
      .map((row) => row.schema_name)
      .filter((schema) => TENANT_SCHEMA_NAME_RE.test(schema));
  } finally {
    await dataSource.destroy();
  }
}

function registrySchemasForError(): string {
  return SCHEMA_REGISTRY.map((entry) => entry.schema).join(', ');
}

function registryEntryForSchema(schema: string): SchemaRegistryEntry {
  const entry = SCHEMA_REGISTRY.find((candidate) => candidate.schema === schema);
  if (entry === undefined) {
    throw new Error(
      `[db-migrate] --schema "${schema}" is not a SCHEMA_REGISTRY entry. ` +
        `Valid schemas: ${registrySchemasForError()}.`,
    );
  }
  return entry;
}

function resolveRegistryMigrationAssets(
  entry: SchemaRegistryEntry,
  root: string,
): Pick<RunSchemaOptions, 'migrations' | 'entities'> {
  const migrations = entry.migrationsGlob.map((glob) => resolve(root, glob));
  const entities = entry.entitiesGlob?.map((glob) => resolve(root, glob));
  return {
    migrations,
    ...(entities !== undefined ? { entities } : {}),
  };
}

export async function runRollbackMode(
  database: RunSchemaOptions['database'],
  root: string,
  args: { down: number; schema: string; confirmRelease?: string },
): Promise<number> {
  let releaseId: string;
  let operator: string;
  try {
    releaseId = resolveRollbackReleaseId(args.confirmRelease);
    operator = resolveRollbackOperator();
  } catch (err: unknown) {
    log({
      level: 'error',
      message: err instanceof Error ? err.message : String(err),
      context: 'DbMigrateRollback',
    });
    return 2;
  }

  let entry: SchemaRegistryEntry;
  try {
    entry = registryEntryForSchema(args.schema);
  } catch (err: unknown) {
    log({
      level: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
    return 2;
  }

  if (TENANT_AWARE_SCHEMAS.has(entry.schema)) {
    log({
      level: 'error',
      message:
        `[db-migrate] Rollback refused for tenant-aware schema "${entry.schema}". ` +
        `PR-1 rollback supports source-schema-only services; tenant fan-out rollback requires a separate contract.`,
      context: 'DbMigrateRollback',
      schema: entry.schema,
    });
    return 2;
  }

  if (entry.postMigrationHardening !== undefined) {
    log({
      level: 'error',
      message:
        `[db-migrate] Rollback refused for schema "${entry.schema}" because it declares ` +
        `postMigrationHardening. Hardening rollback must be modeled before down() can run.`,
      context: 'DbMigrateRollback',
      schema: entry.schema,
    });
    return 2;
  }

  const assets = resolveRegistryMigrationAssets(entry, root);
  const gitSha = process.env['DEPLOY_SHA'] ?? 'unknown';
  let rollbackPlan: RollbackSchemaPlan | undefined;

  return await withReleaseMigrationLock(database, async () => {
    try {
      const bootstrap = await runPlatformBootstrap({
        database,
        sqlDir: resolvePlatformBootstrapSqlDir(root),
        log,
      });
      log({
        level: 'info',
        message: 'Platform bootstrap verified before rollback',
        context: 'DbMigrateRollback',
        schemaCount: bootstrap.schemaCount,
      });

      log({
        level: 'warn',
        message: 'Operator-directed schema rollback starting',
        context: 'DbMigrateRollback',
        schema: entry.schema,
        service: entry.service,
        count: args.down,
        releaseId,
        operator,
      });

      const result = await rollbackSchemaMigrations(
        {
          schema: entry.schema,
          migrations: assets.migrations,
          ...(assets.entities !== undefined ? { entities: assets.entities } : {}),
          database,
          log,
        },
        {
          count: args.down,
          onPlan: async (plan) => {
            rollbackPlan = plan;
            await writeReleaseLedgerRollbackState(database, {
              releaseId,
              gitSha,
              operator,
              schema: entry.schema,
              service: entry.service,
              count: args.down,
              status: 'rollback_attempted',
              plan,
            });
          },
        },
      );

      await writeReleaseLedgerRollbackState(database, {
        releaseId,
        gitSha,
        operator,
        schema: entry.schema,
        service: entry.service,
        count: args.down,
        status: 'rollback_verified',
        plan: rollbackPlan,
        afterHead: result.afterHead,
        durationMs: result.durationMs,
      });

      log({
        level: 'warn',
        message: 'Operator-directed schema rollback complete',
        context: 'DbMigrateRollback',
        schema: entry.schema,
        service: entry.service,
        reverted: result.reverted,
        beforeHead: result.beforeHead,
        targetHead: result.targetHead,
        afterHead: result.afterHead,
        durationMs: result.durationMs,
      });
      return 0;
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      try {
        await writeReleaseLedgerRollbackState(database, {
          releaseId,
          gitSha,
          operator,
          schema: entry.schema,
          service: entry.service,
          count: args.down,
          status: 'rollback_failed',
          plan: rollbackPlan,
          error,
        });
      } catch (ledgerErr: unknown) {
        log({
          level: 'error',
          message: 'Release ledger rollback_failed write FAILED',
          context: 'DbMigrateRollback',
          schema: entry.schema,
          error: ledgerErr instanceof Error ? ledgerErr.message : String(ledgerErr),
        });
      }
      log({
        level: 'error',
        message: 'Operator-directed schema rollback FAILED',
        context: 'DbMigrateRollback',
        schema: entry.schema,
        service: entry.service,
        error,
        stack: err instanceof Error ? err.stack : undefined,
      });
      return 1;
    }
  });
}

async function main(): Promise<number> {
  let cliArgs: ReturnType<typeof parseArgs>;
  try {
    cliArgs = parseArgs(process.argv.slice(2));
  } catch (err: unknown) {
    log({
      level: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
    return 2;
  }
  const rollbackRequested = cliArgs.down !== undefined;

  log({
    level: 'info',
    message: 'aqua-db-migrate starting',
    schemaCount: SCHEMA_REGISTRY.length,
    mode: rollbackRequested ? 'rollback' : 'up',
  });

  // Production hard-fail boundary — mirrors
  // createMigrationRunnerService. A deploy that set this to "false"
  // in production almost certainly misconfigured the stack; refuse.
  const nodeEnv = envOr('NODE_ENV', 'development');
  const migrationsRun = envOr('DATABASE_MIGRATIONS_RUN', 'true') === 'true';
  if (!migrationsRun && nodeEnv === 'production' && !rollbackRequested) {
    log({
      level: 'error',
      message: 'SECURITY: DATABASE_MIGRATIONS_RUN must not be false in production',
    });
    return 2;
  }
  if (!migrationsRun && !rollbackRequested) {
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
      message: err instanceof Error ? err.message : String(err),
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

  if (rollbackRequested) {
    const rollbackCount = cliArgs.down;
    if (cliArgs.schema === undefined) {
      log({
        level: 'error',
        message: '[db-migrate] --down N requires --schema <name>.',
      });
      return 2;
    }
    if (rollbackCount === undefined) {
      log({
        level: 'error',
        message: '[db-migrate] Internal CLI state error: rollback mode without --down count.',
      });
      return 2;
    }
    if (!migrationsRun) {
      log({
        level: 'warn',
        message: 'DATABASE_MIGRATIONS_RUN=false ignored for explicit --down rollback mode.',
      });
    }
    return await runRollbackMode(database, root, {
      down: rollbackCount,
      schema: cliArgs.schema,
      confirmRelease: cliArgs.confirmRelease,
    });
  }

  return await withReleaseMigrationLock(database, async () => {
    // ── Phase 0 — Platform Bootstrap Atom (ADR-031) ─────────────────────────
    // Idempotent installation of extensions, roles, schemas, grants,
    // platform functions, and shared-schema tables. Survives postgres
    // restart + DROP SCHEMA + day-one reset. Replaces the
    // infrastructure/docker/init-scripts/* DDL contract which only fired
    // on initdb (empty PGDATA).
    try {
      const sqlDir = resolvePlatformBootstrapSqlDir(root);
      const bootstrap = await runPlatformBootstrap({
        database,
        sqlDir,
        log,
        ...(process.env['DB_MIGRATE_VERSION']
          ? { version: process.env['DB_MIGRATE_VERSION'] }
          : {}),
      });
      log({
        level: 'info',
        message: 'Phase 0 bootstrap success',
        schemaCount: bootstrap.schemaCount,
        functionCount: bootstrap.functionCount,
        sharedTableCount: bootstrap.sharedTableCount,
        durationMs: bootstrap.durationMs,
      });
    } catch (err: unknown) {
      log({
        level: 'error',
        message: 'Phase 0 platform bootstrap FAILED — aborting before service migrations',
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return 1;
    }

    // ── Phase 1 — Per-service migration loop ───────────────────────────────
    const results: RunSchemaResult[] = [];
    const sourceHeads = new Map<string, MigrationLedgerHead | null>();
    const tenantHeads = new Map<string, Map<string, MigrationLedgerHead | null>>();
    const fanoutResults: Record<string, unknown> = {};
    let tenantSchemas: string[];
    try {
      tenantSchemas = await listTenantSchemas(database);
    } catch (err: unknown) {
      log({
        level: 'error',
        message: 'Tenant schema discovery failed — aborting before migrations',
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return 2;
    }
    for (const entry of SCHEMA_REGISTRY) {
      try {
        // Resolve each schema's migration glob against the bundle root so
        // the process works regardless of the process.cwd() at invocation.
        const migrations = entry.migrationsGlob.map((g) => resolve(root, g));
        const entities = entry.entitiesGlob?.map((g) => resolve(root, g));
        let backfills:
          | Array<{ tenantSchema: string; copiedRows: number; skipped: boolean }>
          | undefined;
        if (TENANT_AWARE_SCHEMAS.has(entry.schema)) {
          backfills = await backfillTenantLedgersForSource(database, entry.schema, tenantSchemas);
        }
        const result = await runSchemaMigrations({
          schema: entry.schema,
          migrations,
          ...(entities !== undefined ? { entities } : {}),
          database,
          log,
        });
        if (entry.postMigrationHardening !== undefined) {
          await runSchemaPostMigrationHardening(
            database,
            entry.schema,
            entry.postMigrationHardening,
          );
        }
        results.push(result);
        sourceHeads.set(entry.schema, result.head);

        if (TENANT_AWARE_SCHEMAS.has(entry.schema)) {
          if (tenantSchemas.length === 0) {
            log({
              level: 'info',
              message: 'No tenant schemas present — fan-out skipped',
              context: 'DbMigrate',
              schema: entry.schema,
            });
          } else {
            log({
              level: 'info',
              message: 'Tenant migration fan-out starting',
              context: 'DbMigrate',
              sourceSchema: entry.schema,
              tenantCount: tenantSchemas.length,
            });
            const tenantFanout: Record<string, unknown> = {};
            for (const tenantSchema of tenantSchemas) {
              const tenantResult = await runSchemaMigrations({
                schema: tenantSchema,
                migrations,
                ...(entities !== undefined ? { entities } : {}),
                database,
                log,
                migrationsTableName: tenantMigrationLedgerTable(entry.schema),
              });
              const grant = await grantTenantLedgerReadAccess(database, entry.schema, tenantSchema);
              log({
                level: 'info',
                message: 'Tenant migration ledger read grant asserted',
                context: 'DbMigrate',
                sourceSchema: entry.schema,
                tenantSchema,
                tenantLedger: grant.tenantLedger,
                serviceRole: grant.serviceRole,
              });
              results.push(tenantResult);
              if (!tenantHeads.has(tenantSchema)) {
                tenantHeads.set(tenantSchema, new Map());
              }
              const tenantHeadMap = tenantHeads.get(tenantSchema);
              if (tenantHeadMap === undefined) {
                throw new Error(
                  `[db-migrate] Tenant head map was not initialized for ${tenantSchema}`,
                );
              }
              tenantHeadMap.set(entry.schema, tenantResult.head);
              tenantFanout[tenantSchema] = {
                status: 'applied',
                expectedHead: headToJson(result.head),
                appliedHead: headToJson(tenantResult.head),
                appliedMigrations: tenantResult.applied,
                pendingBeforeRun: tenantResult.pending,
              };
            }
            fanoutResults[entry.schema] = {
              tenantCount: tenantSchemas.length,
              backfills: backfills ?? [],
              tenants: tenantFanout,
            };
          }
        }
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

    const { expectedHeads, appliedHeads } = buildHeadPayloads(sourceHeads, tenantHeads);
    try {
      await writeReleaseLedgerMigrationState(database, {
        expectedHeads,
        appliedHeads,
        tenantSchemas,
        fanoutResults,
      });
    } catch (err: unknown) {
      log({
        level: 'error',
        message: 'Release ledger migration state write FAILED — aborting deploy',
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return 1;
    }
    if (JSON.stringify(expectedHeads) !== JSON.stringify(appliedHeads)) {
      log({
        level: 'error',
        message: 'Release ledger expected/applied migration heads diverge — aborting deploy',
        expectedHeads,
        appliedHeads,
      });
      return 1;
    }

    const totalApplied = results.reduce((sum, r) => sum + r.applied.length, 0);
    const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);

    log({
      level: 'info',
      ...bootInvariantSignalRecord('db_migrate_complete', {
        schemaCount: SCHEMA_REGISTRY.length,
        totalAppliedMigrations: totalApplied,
        totalDurationMs: totalDuration,
        perSchema: results.map((r) => ({
          schema: r.schema,
          applied: r.applied.length,
          durationMs: r.durationMs,
        })),
      }),
    });

    return 0;
  });
}

// Top-level error sink. We never want an unhandled rejection to exit 0.
if (require.main === module) {
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
}
