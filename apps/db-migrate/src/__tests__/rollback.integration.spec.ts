import {
  bootPostgresContainer,
  type HarnessContext,
  shutdownHarness,
} from '@platform/migration-harness';
import { QueryRunner, MigrationInterface } from 'typeorm';

import { rollbackSchemaMigrations, runSchemaMigrations } from '../migration-orchestrator';

/**
 * ORPHAN-020 integration suite — live Postgres round-trip for the
 * `--down N` rollback path. Proves:
 *   1. runSchemaMigrations applies the test migration.
 *   2. rollbackSchemaMigrations reverts it.
 *   3. runSchemaMigrations re-applies it (up → down → up round-trip).
 *   4. Reverting more migrations than exist fails with a clear error.
 *   5. Invalid count (< 1) fails at the orchestrator boundary.
 *
 * The test migration is a STAND-ALONE class defined below. TypeORM
 * migration loading by glob expects on-disk .js / .ts files; this
 * suite uses the class-array form on the DataSource so no temp
 * files land on disk.
 */

// ── Test migration: create + drop a tiny marker table ──────────────────

/** eslint-disable-next-line @typescript-eslint/naming-convention — TypeORM migration class
 *  naming convention is `<PascalCaseName><UnixEpochMillis>`. The numeric
 *  suffix is the idempotency key TypeORM records in `typeorm_migrations`.
 */
class RollbackMarker1700000000000 implements MigrationInterface {
  name = 'RollbackMarker1700000000000';

  async up(qr: QueryRunner): Promise<void> {
    await qr.query(`CREATE TABLE IF NOT EXISTS rollback_marker (id serial PRIMARY KEY)`);
  }

  async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE IF EXISTS rollback_marker`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/** No-op logger so spec output stays compact. Swap for `console.log` when debugging. */
const silentLog = (_record: Record<string, unknown>): void => undefined;

async function tableExists(qr: QueryRunner, schema: string): Promise<boolean> {
  const rows: Array<{ exists: boolean }> = await qr.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = $1 AND table_name = 'rollback_marker'
     ) AS exists`,
    [schema],
  );
  return rows[0]?.exists ?? false;
}

// ── Suite ──────────────────────────────────────────────────────────────

describe('rollbackSchemaMigrations — live PG round-trip', () => {
  let ctx: HarnessContext;

  beforeAll(async () => {
    ctx = await bootPostgresContainer();
  }, 120_000);

  afterAll(async () => {
    await shutdownHarness(ctx);
  }, 30_000);

  it('up → down → up round-trip leaves the system at steady state', async () => {
    // Ephemeral schema per test so state cannot leak across runs.
    const schema = `rbtest_${Date.now().toString(36)}`;
    const qr = ctx.dataSource.createQueryRunner();
    await qr.query(`CREATE SCHEMA "${schema}"`);
    await qr.release();

    // Pass the migration CLASS via the DataSource's `migrations`
    // array. TypeORM accepts both strings (globs) and classes.
    // runSchemaMigrations + rollbackSchemaMigrations forward the
    // value through unchanged — the class-array bypasses the glob
    // resolver so no on-disk file is needed.
    const opts = {
      schema,
      migrations: [RollbackMarker1700000000000] as unknown as string[],
      database: ctx.connectionOptions,
      log: silentLog,
      tenantAware: false,
      lockTimeoutSeconds: 5,
    };

    // ── Up 1 ──
    const up1 = await runSchemaMigrations(opts);
    expect(up1.applied).toEqual(['RollbackMarker1700000000000']);
    const verifyQr1 = ctx.dataSource.createQueryRunner();
    expect(await tableExists(verifyQr1, schema)).toBe(true);
    await verifyQr1.release();

    // ── Down 1 ──
    let observedPlan:
      | {
          beforeHead: { timestamp: string; name: string } | null;
          targetHead: { timestamp: string; name: string } | null;
          revertedMigrations: string[];
        }
      | undefined;
    const down = await rollbackSchemaMigrations(opts, {
      count: 1,
      onPlan: async (plan) => {
        observedPlan = plan;
      },
    });
    expect(down.reverted).toEqual(['RollbackMarker1700000000000']);
    expect(observedPlan).toEqual({
      schema,
      beforeHead: {
        timestamp: '1700000000000',
        name: 'RollbackMarker1700000000000',
      },
      targetHead: null,
      revertedMigrations: ['RollbackMarker1700000000000'],
    });
    expect(down.beforeHead).toEqual({
      timestamp: '1700000000000',
      name: 'RollbackMarker1700000000000',
    });
    expect(down.targetHead).toBeNull();
    expect(down.afterHead).toBeNull();
    const verifyQr2 = ctx.dataSource.createQueryRunner();
    expect(await tableExists(verifyQr2, schema)).toBe(false);
    await verifyQr2.release();

    // ── Up 1 again — idempotency under re-application ──
    const up2 = await runSchemaMigrations(opts);
    expect(up2.applied).toEqual(['RollbackMarker1700000000000']);
    const verifyQr3 = ctx.dataSource.createQueryRunner();
    expect(await tableExists(verifyQr3, schema)).toBe(true);
    await verifyQr3.release();
  });

  it('rejects count < 1 at the orchestrator boundary', async () => {
    const schema = `rbtest_zero_${Date.now().toString(36)}`;
    const qr = ctx.dataSource.createQueryRunner();
    await qr.query(`CREATE SCHEMA "${schema}"`);
    await qr.release();

    const opts = {
      schema,
      migrations: [RollbackMarker1700000000000] as unknown as string[],
      database: ctx.connectionOptions,
      log: silentLog,
      tenantAware: false,
      lockTimeoutSeconds: 5,
    };

    await expect(rollbackSchemaMigrations(opts, { count: 0 })).rejects.toThrow(/positive integer/i);
    await expect(rollbackSchemaMigrations(opts, { count: -3 })).rejects.toThrow(
      /positive integer/i,
    );
  });

  it('refuses to roll back more migrations than exist', async () => {
    // The orchestrator probes `getExecutedMigrations()` BEFORE the
    // first undo — too-many count fails fast, no half-rolled state.
    const schema = `rbtest_overflow_${Date.now().toString(36)}`;
    const qr = ctx.dataSource.createQueryRunner();
    await qr.query(`CREATE SCHEMA "${schema}"`);
    await qr.release();

    const opts = {
      schema,
      migrations: [RollbackMarker1700000000000] as unknown as string[],
      database: ctx.connectionOptions,
      log: silentLog,
      tenantAware: false,
      lockTimeoutSeconds: 5,
    };

    // Apply 1 migration, try to roll back 2.
    await runSchemaMigrations(opts);
    await expect(rollbackSchemaMigrations(opts, { count: 2 })).rejects.toThrow(
      /cannot roll back 2/i,
    );

    // And the one that WAS applied is still present — the refusal
    // aborted before any undo ran.
    const verifyQr = ctx.dataSource.createQueryRunner();
    expect(await tableExists(verifyQr, schema)).toBe(true);
    await verifyQr.release();
  });
});
