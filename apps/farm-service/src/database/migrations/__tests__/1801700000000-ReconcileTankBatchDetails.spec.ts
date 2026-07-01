import type { QueryRunner } from 'typeorm';

import { createMockDataSource } from '@aquaculture/testing';

import { ReconcileTankBatchDetails1801700000000 } from '../1801700000000-ReconcileTankBatchDetails';

/**
 * Contract cover for the tank_batches.batchDetails reconciliation backfill
 * (ORPHAN-HIGH-272). London-school SHAPE assertions (fully-typed
 * `jest.Mocked<QueryRunner>` from createMockDataSource — no forbidden casts, no
 * live DB): the risk this migration must never regress is (a) running against a
 * per-tenant table absent in the source `farm` schema, and (b) inventing a
 * multi-batch split it cannot know.
 */
describe('ReconcileTankBatchDetails1801700000000', () => {
  let mockQueryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner } = createMockDataSource());
    mockQueryRunner.query.mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  async function upSql(): Promise<string> {
    await new ReconcileTankBatchDetails1801700000000().up(mockQueryRunner);
    return String(mockQueryRunner.query.mock.calls[0]![0]);
  }

  it('no-ops in schemas that do not own the per-tenant tank_batches table', async () => {
    const sql = await upSql();
    expect(sql).toContain("to_regclass(current_schema() || '.tank_batches') IS NULL");
    expect(sql).toContain('RETURN;');
  });

  it('reconciles ONLY single-batch rows — never guesses a multi-batch split', async () => {
    const sql = await upSql();
    // The single UPDATE is gated to a one-batch composition.
    expect(sql).toMatch(/UPDATE tank_batches[\s\S]*jsonb_array_length\(tb\."batchDetails"\) = 1/);
    // There is exactly ONE UPDATE — multi-batch is counted + surfaced, not mutated.
    expect((sql.match(/UPDATE tank_batches/g) ?? []).length).toBe(1);
    expect(sql).toMatch(/jsonb_array_length\(tb\."batchDetails"\) > 1/);
    expect(sql).toContain('RAISE NOTICE');
  });

  it('sets the lone detail to the live totals and only touches stale rows (idempotent)', async () => {
    const sql = await upSql();
    expect(sql).toContain('\'quantity\', tb."totalQuantity"');
    expect(sql).toContain('\'percentageOfTank\', 100');
    // Idempotent filter: rows already consistent with the totals are skipped.
    expect(sql).toContain('<> tb."totalQuantity"');
  });

  it('down() is a deliberate no-op — the reconciliation is not reversible', async () => {
    await new ReconcileTankBatchDetails1801700000000().down(mockQueryRunner);
    expect(mockQueryRunner.query).not.toHaveBeenCalled();
  });
});
