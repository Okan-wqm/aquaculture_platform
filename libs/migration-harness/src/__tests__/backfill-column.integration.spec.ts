import { backfillColumn, sql } from '@aquaculture/backend-common/database';

import {
  type HarnessContext,
  bootPostgresContainer,
  shutdownHarness,
} from '../index';

import { expectHarnessContext, queryRows, rowAt, withHarnessSchema } from './test-helpers';

describe('backfillColumn — Phase 3.5 Class H primitive', () => {
  let ctx: HarnessContext | undefined;

  beforeAll(async () => {
    ctx = await bootPostgresContainer();
  }, 90_000);

  afterAll(async () => {
    await shutdownHarness(ctx);
  }, 30_000);

  it('fills NULL rows via chunked UPDATE (single chunk covers small tables)', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS backfill_test`);
      try {
        await qr.query(
          `CREATE TABLE backfill_test.widget (id uuid PRIMARY KEY, status text)`,
        );
        await qr.query(
          `INSERT INTO backfill_test.widget (id, status) VALUES
             ('11111111-1111-1111-1111-111111111111', NULL),
             ('22222222-2222-2222-2222-222222222222', NULL),
             ('33333333-3333-3333-3333-333333333333', 'keep')`,
        );
        const result = await backfillColumn(qr, {
          schema: 'backfill_test',
          table: 'widget',
          updateExpr: sql.fragment`${sql.ident('status')} = ${sql.value('backfilled')}`,
          filterExpr: sql.fragment`${sql.ident('status')} IS NULL`,
        });
        expect(result.rowsUpdatedTotal).toBe(2);
        expect(result.completed).toBe(true);
        expect(result.iterations).toBeGreaterThanOrEqual(1);

        const rows = await queryRows<{ id: string; status: string }>(
          qr,
          `SELECT id, status FROM backfill_test.widget ORDER BY id`,
        );
        expect(rowAt(rows, 0).status).toBe('backfilled');
        expect(rowAt(rows, 1).status).toBe('backfilled');
        expect(rowAt(rows, 2).status).toBe('keep');
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS backfill_test CASCADE`);
      }
    });
  });

  it('honors chunkSize and multi-chunks through a large update', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS backfill_test`);
      try {
        await qr.query(
          `CREATE TABLE backfill_test.big (id serial PRIMARY KEY, val int)`,
        );
        // Seed 25 rows with val=NULL.
        for (let i = 0; i < 25; i++) {
          await qr.query(
            `INSERT INTO backfill_test.big (val) VALUES (NULL)`,
          );
        }
        const progress: Array<{ iter: number; chunkRows: number }> = [];
        const result = await backfillColumn(qr, {
          schema: 'backfill_test',
          table: 'big',
          updateExpr: sql.fragment`${sql.ident('val')} = ${sql.value(0)}`,
          filterExpr: sql.fragment`${sql.ident('val')} IS NULL`,
          chunkSize: 10,
          onChunk: (p) => {
            progress.push({ iter: p.iteration, chunkRows: p.rowsUpdatedThisChunk });
          },
        });
        expect(result.rowsUpdatedTotal).toBe(25);
        // 10 + 10 + 5 rows then a terminal 0-chunk → 4 iterations.
        expect(result.iterations).toBe(4);
        expect(progress.map((p) => p.chunkRows)).toEqual([10, 10, 5, 0]);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS backfill_test CASCADE`);
      }
    });
  });

  it('is a no-op when filter matches zero rows', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS backfill_test`);
      try {
        await qr.query(
          `CREATE TABLE backfill_test.widget (id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'ok')`,
        );
        await qr.query(
          `INSERT INTO backfill_test.widget (id) VALUES ('11111111-1111-1111-1111-111111111111')`,
        );
        const result = await backfillColumn(qr, {
          schema: 'backfill_test',
          table: 'widget',
          updateExpr: sql.fragment`${sql.ident('status')} = ${sql.value('other')}`,
          filterExpr: sql.fragment`${sql.ident('status')} IS NULL`,
        });
        expect(result.rowsUpdatedTotal).toBe(0);
        expect(result.completed).toBe(true);
        expect(result.iterations).toBe(1);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS backfill_test CASCADE`);
      }
    });
  });

  it('throws when maxIterations tripped by self-matching predicate', async () => {
    const harness = expectHarnessContext(ctx);
    await withHarnessSchema(harness, async (_e, qr) => {
      await qr.query(`CREATE SCHEMA IF NOT EXISTS backfill_test`);
      try {
        await qr.query(
          `CREATE TABLE backfill_test.loop (id serial PRIMARY KEY, val text)`,
        );
        await qr.query(
          `INSERT INTO backfill_test.loop (val) SELECT 'x' FROM generate_series(1, 5)`,
        );
        // Self-matching predicate: always true post-update.
        await expect(
          backfillColumn(qr, {
            schema: 'backfill_test',
            table: 'loop',
            updateExpr: sql.fragment`${sql.ident('val')} = ${sql.value('x')}`,
            filterExpr: sql.fragment`${sql.ident('val')} = ${sql.value('x')}`,
            chunkSize: 2,
            maxIterations: 3,
          }),
        ).rejects.toThrow(/maxIterations/);
      } finally {
        await qr.query(`DROP SCHEMA IF EXISTS backfill_test CASCADE`);
      }
    });
  });

  it('rejects unsafe identifier at call site', async () => {
    const qr = {} as never;
    await expect(
      backfillColumn(qr, {
        schema: `bad"; DROP--`,
        table: 'widget',
        updateExpr: sql.fragment`val = 1`,
        filterExpr: sql.fragment`val IS NULL`,
      }),
    ).rejects.toThrow(/SAFE_IDENT_RE/);
  });
});
