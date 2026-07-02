import type { QueryRunner } from 'typeorm';

import { createMockDataSource } from '@aquaculture/testing';

import { BackfillTankBatchCurrentQuantityMirror1801800000000 } from '../1801800000000-BackfillTankBatchCurrentQuantityMirror';

/**
 * Contract cover for the currentQuantity/currentBiomassKg mirror reconciliation
 * (ORPHAN-HIGH-276) — the completion of the 719-vs-900 data repair. London-school
 * SHAPE assertions (typed jest.Mocked<QueryRunner>, no live DB): the risks are
 * (a) running against a per-tenant table absent in the source schema, and
 * (b) mutating rows that are already consistent.
 */
describe('BackfillTankBatchCurrentQuantityMirror1801800000000', () => {
  let mockQueryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner } = createMockDataSource());
    mockQueryRunner.query.mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  async function upSql(): Promise<string> {
    await new BackfillTankBatchCurrentQuantityMirror1801800000000().up(mockQueryRunner);
    return String(mockQueryRunner.query.mock.calls[0]![0]);
  }

  it('no-ops in schemas that do not own the per-tenant tank_batches table', async () => {
    const sql = await upSql();
    expect(sql).toContain("to_regclass(current_schema() || '.tank_batches') IS NULL");
    expect(sql).toContain('RETURN;');
  });

  it('mirrors currentQuantity/currentBiomassKg to the authoritative totals', async () => {
    const sql = await upSql();
    expect(sql).toMatch(/"currentQuantity"\s*=\s*"totalQuantity"/);
    expect(sql).toMatch(/"currentBiomassKg"\s*=\s*"totalBiomassKg"/);
  });

  it('only touches divergent rows (idempotent — IS DISTINCT FROM covers NULL mirrors)', async () => {
    const sql = await upSql();
    expect(sql).toMatch(/"currentQuantity"\s+IS DISTINCT FROM\s+"totalQuantity"/);
    expect(sql).toMatch(/"currentBiomassKg"\s+IS DISTINCT FROM\s+"totalBiomassKg"/);
  });

  it('down() is a deliberate no-op — the mirror is derived, not restorable', async () => {
    await new BackfillTankBatchCurrentQuantityMirror1801800000000().down(mockQueryRunner);
    expect(mockQueryRunner.query).not.toHaveBeenCalled();
  });
});
