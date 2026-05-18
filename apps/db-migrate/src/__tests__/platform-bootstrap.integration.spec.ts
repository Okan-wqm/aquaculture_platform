import { resolve } from 'node:path';

import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';

import {
  runPlatformBootstrap,
  resolvePlatformBootstrapSqlDir,
} from '../platform-bootstrap.service';

/**
 * Platform Bootstrap Atom — restart-survive + idempotency integration test (ADR-031).
 *
 * Proves:
 *   1. Phase 0 applies cleanly against an empty database (fresh-PGDATA path).
 *   2. Second invocation against the same DB is a no-op (idempotent contract).
 *   3. DROP SCHEMA → re-run → schemas + functions + shared tables rebuilt
 *      (restart-survive contract — the bug ADR-031 closes).
 *   4. platform.bootstrap_signal row reflects the latest run.
 *
 * # Why this lives in the integration suite, not a unit mock
 *
 * The bootstrap atom's correctness is exclusively about real Postgres
 * behavior: CREATE EXTENSION semantics, AUTHORIZATION clause idempotency,
 * GRANT re-issue semantics, CREATE POLICY drop-then-create cycle, RLS
 * row-level enforcement. Mocking node-postgres would lose every one of
 * those signals — the test would assert what the code does, not what
 * Postgres does in response.
 */

const silentLog = (_record: Record<string, unknown>): void => undefined;

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const SQL_DIR = resolvePlatformBootstrapSqlDir(REPO_ROOT);

const PLATFORM_SCHEMAS = [
  'auth', 'farm', 'sensor', 'hr', 'messaging', 'hydroponics', 'alert',
  'billing', 'notification', 'ai', 'admin', 'observability',
  'event_store', 'config', 'gateway', 'shared',
] as const;

const PLATFORM_FUNCTIONS = [
  'current_tenant_id',
  'set_tenant_id',
  'update_updated_at_column',
  'audit_immutability_guard',
] as const;

const SHARED_SCHEMA_TABLES = [
  'audit_logs',
  'gdpr_data_requests',
  'user_consents',
  'user_permissions',
  'access_logs',
] as const;

describe('platform-bootstrap atom — restart-survive + idempotency (ADR-031)', () => {
  let ctx: HarnessContext;

  beforeAll(async () => {
    ctx = await bootPostgresContainer();
  }, 120_000);

  afterAll(async () => {
    await shutdownHarness(ctx);
  }, 30_000);

  async function countRows(query: string, params: unknown[] = []): Promise<number> {
    const qr = ctx.dataSource.createQueryRunner();
    try {
      const rows: Array<{ count: string }> = await qr.query(query, params);
      return Number.parseInt(rows[0]?.count ?? '0', 10);
    } finally {
      await qr.release();
    }
  }

  async function countSchemas(): Promise<number> {
    return countRows(
      `SELECT COUNT(*)::text AS count FROM pg_namespace WHERE nspname = ANY($1)`,
      [PLATFORM_SCHEMAS as unknown as string[]],
    );
  }

  async function countFunctions(): Promise<number> {
    return countRows(
      `SELECT COUNT(*)::text AS count
         FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.proname = ANY($1)`,
      [PLATFORM_FUNCTIONS as unknown as string[]],
    );
  }

  async function countSharedTables(): Promise<number> {
    return countRows(
      `SELECT COUNT(*)::text AS count FROM pg_tables
        WHERE schemaname = 'shared' AND tablename = ANY($1)`,
      [SHARED_SCHEMA_TABLES as unknown as string[]],
    );
  }

  async function readBootstrapSignal(): Promise<{
    schemaCount: number;
    functionCount: number;
    sharedTableCount: number;
  } | null> {
    const qr = ctx.dataSource.createQueryRunner();
    try {
      const rows: Array<{ schema_count: number; function_count: number; shared_table_count: number }> =
        await qr.query(`SELECT schema_count, function_count, shared_table_count FROM platform.bootstrap_signal WHERE id = 1`);
      const r = rows[0];
      if (!r) return null;
      return {
        schemaCount: Number(r.schema_count),
        functionCount: Number(r.function_count),
        sharedTableCount: Number(r.shared_table_count),
      };
    } finally {
      await qr.release();
    }
  }

  it('applies cleanly against an empty database', async () => {
    const result = await runPlatformBootstrap({
      database: ctx.connectionOptions,
      sqlDir: SQL_DIR,
      log: silentLog,
      lockTimeoutSeconds: 30,
    });

    expect(result.schemaCount).toBe(PLATFORM_SCHEMAS.length);
    expect(result.functionCount).toBe(PLATFORM_FUNCTIONS.length);
    expect(result.sharedTableCount).toBe(SHARED_SCHEMA_TABLES.length);

    expect(await countSchemas()).toBe(PLATFORM_SCHEMAS.length);
    expect(await countFunctions()).toBe(PLATFORM_FUNCTIONS.length);
    expect(await countSharedTables()).toBe(SHARED_SCHEMA_TABLES.length);

    const signal = await readBootstrapSignal();
    expect(signal).not.toBeNull();
    expect(signal?.schemaCount).toBe(PLATFORM_SCHEMAS.length);
    expect(signal?.functionCount).toBe(PLATFORM_FUNCTIONS.length);
    expect(signal?.sharedTableCount).toBe(SHARED_SCHEMA_TABLES.length);
  }, 90_000);

  it('second invocation is idempotent — no error, same final counts', async () => {
    // First run was applied in the previous test against the same ctx
    // (testcontainer is shared via beforeAll). This call must succeed
    // without error and without changing observable counts.
    const result = await runPlatformBootstrap({
      database: ctx.connectionOptions,
      sqlDir: SQL_DIR,
      log: silentLog,
      lockTimeoutSeconds: 30,
    });

    expect(result.schemaCount).toBe(PLATFORM_SCHEMAS.length);
    expect(result.functionCount).toBe(PLATFORM_FUNCTIONS.length);
    expect(result.sharedTableCount).toBe(SHARED_SCHEMA_TABLES.length);

    expect(await countSchemas()).toBe(PLATFORM_SCHEMAS.length);
    expect(await countFunctions()).toBe(PLATFORM_FUNCTIONS.length);
    expect(await countSharedTables()).toBe(SHARED_SCHEMA_TABLES.length);
  }, 90_000);

  it('survives DROP SCHEMA — restart-survive contract', async () => {
    // Drop every per-service schema CASCADE. Roles and extensions
    // remain (cluster-level). This simulates the day-one reset
    // cutover state.
    const dropQr = ctx.dataSource.createQueryRunner();
    try {
      for (const schema of PLATFORM_SCHEMAS) {
        await dropQr.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
      // Also drop the platform schema so we observe the signal table
      // recovery path.
      await dropQr.query(`DROP SCHEMA IF EXISTS platform CASCADE`);
    } finally {
      await dropQr.release();
    }

    expect(await countSchemas()).toBe(0);
    expect(await countFunctions()).toBe(PLATFORM_FUNCTIONS.length); // still in public
    expect(await countSharedTables()).toBe(0);

    // Re-run bootstrap. Should reconstruct everything.
    const result = await runPlatformBootstrap({
      database: ctx.connectionOptions,
      sqlDir: SQL_DIR,
      log: silentLog,
      lockTimeoutSeconds: 30,
    });

    expect(result.schemaCount).toBe(PLATFORM_SCHEMAS.length);
    expect(result.functionCount).toBe(PLATFORM_FUNCTIONS.length);
    expect(result.sharedTableCount).toBe(SHARED_SCHEMA_TABLES.length);

    expect(await countSchemas()).toBe(PLATFORM_SCHEMAS.length);
    expect(await countFunctions()).toBe(PLATFORM_FUNCTIONS.length);
    expect(await countSharedTables()).toBe(SHARED_SCHEMA_TABLES.length);

    const signal = await readBootstrapSignal();
    expect(signal?.schemaCount).toBe(PLATFORM_SCHEMAS.length);
  }, 120_000);
});
