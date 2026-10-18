import type { QueryRunner } from 'typeorm';

import { createMockDataSource } from '@aquaculture/testing';

import { BackfillTankBatchPrimaryAndShareStamps1822100000000 } from '../1822100000000-BackfillTankBatchPrimaryAndShareStamps';

/**
 * Shape cover for the tank_batches backfill that goes with the weighing path
 * (FARM-CRITICAL-454 verification). Its effect on real rows is proven against
 * PostgreSQL in weighing-reaches-ration.postgres.spec.ts; here the guards that
 * must never regress: it no-ops where `tank_batches` does not exist, clears a
 * primary only on an emptied row, and stamps only unstamped shares.
 */
describe('BackfillTankBatchPrimaryAndShareStamps1822100000000', () => {
  let mockQueryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner } = createMockDataSource());
    mockQueryRunner.query.mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  async function upSql(): Promise<string> {
    await new BackfillTankBatchPrimaryAndShareStamps1822100000000().up(mockQueryRunner);
    expect(mockQueryRunner.query).toHaveBeenCalledTimes(1);
    return String(mockQueryRunner.query.mock.calls[0]![0]);
  }

  it('no-ops in schemas that do not own the per-tenant tank_batches table', async () => {
    const sql = await upSql();
    expect(sql).toContain("to_regclass(current_schema() || '.tank_batches') IS NULL");
    expect(sql).toContain('RETURN;');
  });

  it('clears the primary batch only on a row with no fish and no shares', async () => {
    const sql = await upSql();
    expect(sql).toMatch(
      /SET "primaryBatchId" = NULL,\s*"primaryBatchNumber" = NULL\s*WHERE tb\."primaryBatchId" IS NOT NULL\s*AND tb\."totalQuantity" = 0\s*AND COALESCE\(jsonb_array_length\(tb\."batchDetails"\), 0\) = 0/,
    );
  });

  it('materializes a pre-SSoT single share only while the row has fish', async () => {
    const sql = await upSql();
    expect(sql).toMatch(
      /SET "batchDetails" = jsonb_build_array\(jsonb_build_object\([\s\S]*WHERE tb\."primaryBatchId" IS NOT NULL\s*AND tb\."totalQuantity" > 0\s*AND COALESCE\(jsonb_array_length\(tb\."batchDetails"\), 0\) = 0/,
    );
  });

  it('stamps only unstamped shares, with the day their row was last written, keeping order', async () => {
    const sql = await upSql();
    expect(sql).toContain("WHEN share.value ? 'grownThrough' THEN share.value");
    expect(sql).toContain(`to_char(tb."updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD')`);
    expect(sql).toContain('ORDER BY share.ordinality');
    expect(sql).toContain("WHERE NOT (unstamped.value ? 'grownThrough')");
  });

  it('down() is a deliberate no-op', async () => {
    await new BackfillTankBatchPrimaryAndShareStamps1822100000000().down(mockQueryRunner);
    expect(mockQueryRunner.query).not.toHaveBeenCalled();
  });
});
