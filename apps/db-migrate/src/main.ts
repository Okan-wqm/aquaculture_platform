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

process.env['DB_MIGRATE_DDL_AUTHORITY'] = '1';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { bootInvariantSignalRecord } from '@aquaculture/backend-common/constants';
import {
  applyTenantRlsToSchema,
  assertTenantSchemaPrivileges,
  convertAuditColumnsToTimestamptz,
  getTenantSchemaName,
  grantTenantMigrationLedgerReadAccess,
  MIGRATION_LEDGER_TABLE,
  tenantMigrationLedgerTable,
  TENANT_AWARE_SCHEMAS,
  TENANT_SCHEMA_NAME_RE,
  verifyTenantSchemaPrivileges,
} from '@aquaculture/backend-common/database';
import { DataSource, QueryRunner } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

import { parseArgs } from './cli-args';
import {
  readLedgerHead,
  rollbackSchemaMigrations,
  runSchemaMigrations,
  type MigrationLedgerHead,
  type RunSchemaOptions,
  type RunSchemaResult,
} from './migration-orchestrator';
import { runPlatformBootstrap, resolvePlatformBootstrapSqlDir } from './platform-bootstrap.service';
import { SCHEMA_REGISTRY, type SchemaPostMigrationHardening } from './schema-registry';
import { runTenantSchemaProvisioner } from './tenant-schema-provisioner';

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
  /** Registered per-tenant tables aligned to owner+DML this pass (2026-07-06 grant incident). */
  alignedTables: string[];
  absentTables: string[];
}> {
  const dataSource = createControlDataSource(database);
  await dataSource.initialize();
  const queryRunner = dataSource.createQueryRunner();

  try {
    await queryRunner.connect();
    const ledgerGrant = await grantTenantMigrationLedgerReadAccess(queryRunner, {
      tenantSchema,
      sourceSchema,
    });
    // The fan-out creates tables on the bootstrap (superuser) connection —
    // Postgres neither copies privileges nor applies another role's default
    // ACLs, so without this every migration-added tenant table is born
    // owner=superuser with an empty ACL and the owning service's first query
    // dies with "permission denied" (live incident: sensor_temperature_latest
    // blanked mobile batchMetrics). Idempotent registry-derived alignment.
    const privileges = await assertTenantSchemaPrivileges(queryRunner, {
      tenantSchema,
      sourceSchema,
    });
    return {
      ...ledgerGrant,
      alignedTables: privileges.alignedTables,
      absentTables: privileges.absentTables,
    };
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
}

/**
 * Deploy-blocking drift gate (make-it-detectable half of the 2026-07-06 grant
 * incident): after the full fan-out, re-read pg_catalog and fail the deploy if
 * any registered-and-present per-tenant table still lacks its
 * <source>_schema_owner ownership or <source>_service DML privileges.
 * Unknown (unregistered) tenant tables are logged loudly — silence is how the
 * class stayed invisible before.
 */
async function verifyTenantPrivilegesOrFail(
  database: RunSchemaOptions['database'],
  tenantSchemas: readonly string[],
  log: (record: Record<string, unknown>) => void,
): Promise<boolean> {
  if (tenantSchemas.length === 0) {
    return true;
  }
  const sources = [...TENANT_AWARE_SCHEMAS];
  const dataSource = createControlDataSource(database);
  await dataSource.initialize();
  const queryRunner = dataSource.createQueryRunner();
  let ok = true;

  try {
    await queryRunner.connect();
    for (const tenantSchema of tenantSchemas) {
      const verification = await verifyTenantSchemaPrivileges(queryRunner, tenantSchema, sources);
      if (verification.unknownTables.length > 0) {
        log({
          level: 'warn',
          message:
            'Tenant schema contains tables registered by NO module — they carry no managed ' +
            'grants and their owning service WILL fail at runtime. Register them in ' +
            'MODULE_SCHEMAS or drop them.',
          context: 'DbMigrate',
          tenantSchema,
          unknownTables: verification.unknownTables,
        });
      }
      if (verification.violations.length > 0) {
        ok = false;
        log({
          level: 'error',
          message: 'Tenant-schema privilege drift detected — aborting deploy',
          context: 'DbMigrate',
          tenantSchema,
          violations: verification.violations,
        });
      }
    }
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
  return ok;
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
    status?: 'db_complete' | 'rollback_attempted' | 'rollback_verified' | 'rollback_failed';
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
         $7,
         $8,
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
        args.status ?? 'db_complete',
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

function tenantRollbackSchemaFromInput(input: string): string {
  if (TENANT_SCHEMA_NAME_RE.test(input)) return input;
  return getTenantSchemaName(input);
}

async function readSchemaLedgerHead(
  database: RunSchemaOptions['database'],
  schema: string,
  migrationsTableName: string = MIGRATION_LEDGER_TABLE,
): Promise<MigrationLedgerHead | null> {
  const dataSource = createControlDataSource(database);
  await dataSource.initialize();
  const queryRunner = dataSource.createQueryRunner();
  try {
    await queryRunner.connect();
    return await readLedgerHead(queryRunner, schema, migrationsTableName);
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
}

async function runRollback(
  database: RunSchemaOptions['database'],
  args: {
    schema: string;
    down: number;
    tenantSelector?: { type: 'all' } | { type: 'tenant'; tenant: string };
  },
  root: string,
): Promise<number> {
  const entry = SCHEMA_REGISTRY.find((candidate) => candidate.schema === args.schema);
  if (!entry) {
    log({
      level: 'error',
      message: 'Rollback schema is not registered',
      schema: args.schema,
      registeredSchemas: SCHEMA_REGISTRY.map((candidate) => candidate.schema),
    });
    return 2;
  }

  const migrations = entry.migrationsGlob.map((glob) => resolve(root, glob));
  const entities = entry.entitiesGlob?.map((glob) => resolve(root, glob));
  const tenantSchemas = TENANT_AWARE_SCHEMAS.has(entry.schema)
    ? args.tenantSelector?.type === 'tenant'
      ? [tenantRollbackSchemaFromInput(args.tenantSelector.tenant)]
      : await listTenantSchemas(database)
    : [];
  const tenantHeads = new Map<string, Map<string, MigrationLedgerHead | null>>();
  const sourceHeads = new Map<string, MigrationLedgerHead | null>();
  const fanoutResults: Record<string, unknown> = {};
  const preflightSourceHeads = new Map<string, MigrationLedgerHead | null>();
  const preflightTenantHeads = new Map<string, Map<string, MigrationLedgerHead | null>>();

  try {
    preflightSourceHeads.set(entry.schema, await readSchemaLedgerHead(database, entry.schema));
    for (const tenantSchema of tenantSchemas) {
      preflightTenantHeads.set(
        tenantSchema,
        new Map([
          [
            entry.schema,
            await readSchemaLedgerHead(
              database,
              tenantSchema,
              tenantMigrationLedgerTable(entry.schema),
            ),
          ],
        ]),
      );
    }
    const preflightHeads = buildHeadPayloads(preflightSourceHeads, preflightTenantHeads);
    await writeReleaseLedgerMigrationState(database, {
      expectedHeads: preflightHeads.expectedHeads,
      appliedHeads: preflightHeads.appliedHeads,
      tenantSchemas,
      fanoutResults: {
        [entry.schema]: {
          status: 'rollback_preflight_complete',
          rollbackCount: args.down,
          tenantSelector: args.tenantSelector ?? { type: 'all' },
        },
      },
      status: 'rollback_attempted',
    });

    const sourceRollback = await rollbackSchemaMigrations(
      {
        schema: entry.schema,
        migrations,
        ...(entities !== undefined ? { entities } : {}),
        database,
        log,
      },
      { count: args.down },
    );
    const sourceHead = await readSchemaLedgerHead(database, entry.schema);
    sourceHeads.set(entry.schema, sourceHead);
    fanoutResults[entry.schema] = {
      rollbackCount: args.down,
      tenantSelector: args.tenantSelector ?? { type: 'all' },
      source: {
        status: 'rolled_back',
        reverted: sourceRollback.reverted,
        beforeHead: headToJson(preflightSourceHeads.get(entry.schema) ?? null),
        afterHead: headToJson(sourceHead),
      },
      tenantCount: tenantSchemas.length,
      tenants: {},
    };

    if (tenantSchemas.length > 0) {
      const tenants: Record<string, unknown> = {};
      for (const tenantSchema of tenantSchemas) {
        const tenantRollback = await rollbackSchemaMigrations(
          {
            schema: tenantSchema,
            migrations,
            ...(entities !== undefined ? { entities } : {}),
            database,
            log,
            migrationsTableName: tenantMigrationLedgerTable(entry.schema),
          },
          { count: args.down },
        );
        const tenantHead = await readSchemaLedgerHead(
          database,
          tenantSchema,
          tenantMigrationLedgerTable(entry.schema),
        );
        tenantHeads.set(tenantSchema, new Map([[entry.schema, tenantHead]]));
        tenants[tenantSchema] = {
          status: 'rolled_back',
          reverted: tenantRollback.reverted,
          beforeHead: headToJson(preflightTenantHeads.get(tenantSchema)?.get(entry.schema) ?? null),
          expectedHead: headToJson(sourceHead),
          appliedHead: headToJson(tenantHead),
        };
      }
      fanoutResults[entry.schema] = {
        ...(fanoutResults[entry.schema] as Record<string, unknown>),
        tenants,
      };
    }

    const { expectedHeads, appliedHeads } = buildHeadPayloads(sourceHeads, tenantHeads);
    await writeReleaseLedgerMigrationState(database, {
      expectedHeads,
      appliedHeads,
      tenantSchemas,
      fanoutResults,
      status: 'rollback_verified',
    });

    if (JSON.stringify(expectedHeads) !== JSON.stringify(appliedHeads)) {
      log({
        level: 'error',
        message: 'Release ledger expected/applied rollback heads diverge',
        expectedHeads,
        appliedHeads,
      });
      return 1;
    }

    log({
      level: 'warn',
      message: 'Schema rollback complete',
      context: 'DbMigrate',
      schema: entry.schema,
      reverted: sourceRollback.reverted,
      tenantCount: tenantSchemas.length,
    });
    return 0;
  } catch (err: unknown) {
    log({
      level: 'error',
      message: 'Schema rollback failed',
      context: 'DbMigrate',
      schema: entry.schema,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    try {
      const schemaFanoutResult = fanoutResults[entry.schema];
      const previousSchemaFanoutResult =
        schemaFanoutResult !== null &&
        typeof schemaFanoutResult === 'object' &&
        !Array.isArray(schemaFanoutResult)
          ? schemaFanoutResult
          : {};
      await writeReleaseLedgerMigrationState(database, {
        expectedHeads: buildHeadPayloads(preflightSourceHeads, preflightTenantHeads).expectedHeads,
        appliedHeads: buildHeadPayloads(sourceHeads, tenantHeads).appliedHeads,
        tenantSchemas,
        fanoutResults: {
          ...fanoutResults,
          [entry.schema]: {
            ...previousSchemaFanoutResult,
            status: 'rollback_failed',
            error: err instanceof Error ? err.message : String(err),
            failedAt: new Date().toISOString(),
          },
        },
        status: 'rollback_failed',
      });
    } catch (ledgerError: unknown) {
      log({
        level: 'error',
        message: 'Release ledger rollback failure write failed',
        context: 'DbMigrate',
        error: ledgerError instanceof Error ? ledgerError.message : String(ledgerError),
      });
    }
    return 1;
  }
}

async function main(): Promise<number> {
  let parsedArgs: ReturnType<typeof parseArgs>;
  try {
    parsedArgs = parseArgs(process.argv.slice(2));
  } catch (err: unknown) {
    log({
      level: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
    return 2;
  }

  log({
    level: 'info',
    message:
      parsedArgs.mode === 'tenant-schema-provisioner'
        ? 'aqua-db-migrate tenant schema provisioner starting'
        : parsedArgs.mode === 'tenant-schema-rollback'
          ? 'aqua-db-migrate tenant schema rollback starting'
          : parsedArgs.down === undefined
            ? 'aqua-db-migrate starting'
            : 'aqua-db-migrate rollback starting',
    schemaCount: SCHEMA_REGISTRY.length,
    ...(parsedArgs.down !== undefined
      ? { rollbackSchema: parsedArgs.schema, rollbackCount: parsedArgs.down }
      : {}),
    ...(parsedArgs.mode === 'tenant-schema-provisioner'
      ? { provisionerRunMode: parsedArgs.provisionerRunMode ?? 'once' }
      : {}),
    ...(parsedArgs.mode === 'tenant-schema-rollback'
      ? {
          tenantRollbackTarget: parsedArgs.tenantRollbackTarget,
          tenantRollbackTenant: parsedArgs.tenantRollbackTenant,
        }
      : {}),
  });

  // Production hard-fail boundary — mirrors
  // createMigrationRunnerService. A deploy that set this to "false"
  // in production almost certainly misconfigured the stack; refuse.
  const nodeEnv = envOr('NODE_ENV', 'development');
  const migrationsRun = envOr('DATABASE_MIGRATIONS_RUN', 'true') === 'true';
  const rollbackMode =
    parsedArgs.down !== undefined || parsedArgs.mode === 'tenant-schema-rollback';
  if (!migrationsRun && nodeEnv === 'production' && !rollbackMode) {
    log({
      level: 'error',
      message: 'SECURITY: DATABASE_MIGRATIONS_RUN must not be false in production',
    });
    return 2;
  }
  if (!migrationsRun && !rollbackMode) {
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

  if (parsedArgs.mode === 'tenant-schema-provisioner') {
    return runTenantSchemaProvisioner({
      database,
      root,
      once: parsedArgs.provisionerRunMode !== 'loop',
      pollIntervalMs: Number.parseInt(
        process.env['TENANT_SCHEMA_PROVISIONER_POLL_INTERVAL_MS'] ?? '5000',
        10,
      ),
      leaseSeconds: Number.parseInt(
        process.env['TENANT_SCHEMA_PROVISIONER_LEASE_SECONDS'] ?? '900',
        10,
      ),
      provisionerId: process.env['TENANT_SCHEMA_PROVISIONER_ID'],
      log,
    });
  }

  if (
    parsedArgs.mode === 'tenant-schema-rollback' &&
    parsedArgs.down !== undefined &&
    parsedArgs.schema !== undefined &&
    parsedArgs.tenantRollbackTarget !== undefined
  ) {
    const rollbackSchema = parsedArgs.schema;
    const rollbackCount = parsedArgs.down;
    // Branch-then-assign (not guard + ternary): the selector union demands
    // tenant: string, and TS only narrows tenantRollbackTenant inside the
    // branch where the target check and the undefined check are coupled.
    let tenantSelector: { type: 'all' } | { type: 'tenant'; tenant: string };
    if (parsedArgs.tenantRollbackTarget === 'tenant') {
      const rollbackTenant = parsedArgs.tenantRollbackTenant;
      if (rollbackTenant === undefined) {
        log({
          level: 'error',
          message: '--tenant is required when --tenant-rollback-target=tenant',
        });
        return 2;
      }
      tenantSelector = { type: 'tenant', tenant: rollbackTenant };
    } else {
      tenantSelector = { type: 'all' };
    }
    return await withReleaseMigrationLock(database, async () =>
      runRollback(
        database,
        {
          schema: rollbackSchema,
          down: rollbackCount,
          tenantSelector,
        },
        root,
      ),
    );
  }

  if (parsedArgs.down !== undefined && parsedArgs.schema !== undefined) {
    const rollbackSchema = parsedArgs.schema;
    const rollbackCount = parsedArgs.down;
    return await withReleaseMigrationLock(database, async () =>
      runRollback(database, { schema: rollbackSchema, down: rollbackCount }, root),
    );
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
              if (entry.postMigrationHardening !== undefined) {
                await runSchemaPostMigrationHardening(
                  database,
                  tenantSchema,
                  entry.postMigrationHardening,
                );
              }
              const grant = await grantTenantLedgerReadAccess(database, entry.schema, tenantSchema);
              log({
                level: 'info',
                message: 'Tenant ledger read grant + table privileges asserted',
                context: 'DbMigrate',
                sourceSchema: entry.schema,
                tenantSchema,
                tenantLedger: grant.tenantLedger,
                serviceRole: grant.serviceRole,
                alignedTables: grant.alignedTables.length,
                absentTables: grant.absentTables,
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

    // Deploy-blocking privilege drift gate (2026-07-06 grant incident): every
    // registered-and-present per-tenant table must carry its schema-owner
    // ownership + service-role DML before the deploy is allowed to proceed.
    try {
      const privilegesOk = await verifyTenantPrivilegesOrFail(database, tenantSchemas, log);
      if (!privilegesOk) {
        return 1;
      }
    } catch (err: unknown) {
      log({
        level: 'error',
        message: 'Tenant-schema privilege verification failed — aborting deploy',
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return 1;
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
