import { createMockDataSource } from '@aquaculture/testing';
import type { QueryRunner } from 'typeorm';

import { ConvertFarmAuditColumnsToTimestamptz1801300000000 } from '../1801300000000-ConvertFarmAuditColumnsToTimestamptz';

/** The mocked QueryRunner.query — TypeORM's overloaded signature, jest-wrapped. */
type MockedQuery = jest.Mocked<QueryRunner>['query'];

/**
 * Unit spec (mocked QueryRunner — no DB). Drives the REAL self-bounding helper
 * (the ESM re-export is non-configurable so it cannot be spied; running it for
 * real against a controlled mock is the honest test) and proves the migration:
 *   - sets the SET LOCAL lock/statement-timeout envelope first;
 *   - lets the helper DISCOVER columns via information_schema (self-bounding);
 *   - issues the targeted ALTER ... TYPE TIMESTAMPTZ only for discovered drift;
 *   - issues NO ALTER when nothing is drifted (idempotent no-op);
 *   - never issues a migration-body SET search_path.
 */
describe('ConvertFarmAuditColumnsToTimestamptz1801300000000', () => {
  /**
   * Build a mock runner. `discovered` is the row set the helper's
   * information_schema.columns discovery query returns; everything else
   * (current_schema, pg_settings, ALTERs) resolves trivially.
   */
  function makeRunner(
    discovered: ReadonlyArray<{ table_name: string; column_name: string }>,
  ): { query: MockedQuery; queryRunner: QueryRunner } {
    const { mockQueryRunner } = createMockDataSource();
    mockQueryRunner.query.mockImplementation((sql: string) => {
      if (/SELECT current_schema\(\) AS schema/i.test(sql)) {
        return Promise.resolve([{ schema: 'farm' }]);
      }
      if (/pg_settings WHERE name = 'TimeZone'/i.test(sql)) {
        return Promise.resolve([{ setting: 'UTC' }]);
      }
      if (/information_schema\.columns/i.test(sql)) {
        return Promise.resolve([...discovered]);
      }
      return Promise.resolve([]);
    });
    return { query: mockQueryRunner.query, queryRunner: mockQueryRunner };
  }

  it('sets the SET LOCAL lock_timeout + statement_timeout envelope before converting', async () => {
    const { query, queryRunner } = makeRunner([]);
    await new ConvertFarmAuditColumnsToTimestamptz1801300000000().up(queryRunner);

    expect(query).toHaveBeenCalledWith(`SET LOCAL lock_timeout = '30s'`);
    expect(query).toHaveBeenCalledWith(`SET LOCAL statement_timeout = '600s'`);
  });

  it('discovers via information_schema and is a no-op when nothing is drifted', async () => {
    const { query, queryRunner } = makeRunner([]);
    await new ConvertFarmAuditColumnsToTimestamptz1801300000000().up(queryRunner);

    const sqls = query.mock.calls.map(([s]) => String(s));
    expect(sqls.some((s) => /information_schema\.columns/i.test(s))).toBe(true);
    // Empty discovery → no table-rewrite ALTERs.
    expect(sqls.some((s) => /ALTER TABLE.*TYPE TIMESTAMPTZ/i.test(s))).toBe(false);
  });

  it('issues the targeted ALTER ... TYPE TIMESTAMPTZ for each discovered drifted table', async () => {
    const { query, queryRunner } = makeRunner([
      { table_name: 'farms', column_name: 'createdAt' },
      { table_name: 'farms', column_name: 'updatedAt' },
      { table_name: 'ponds', column_name: 'createdAt' },
      { table_name: 'farm_workers', column_name: 'createdAt' },
    ]);
    await new ConvertFarmAuditColumnsToTimestamptz1801300000000().up(queryRunner);

    const alters = query.mock.calls
      .map(([s]) => String(s))
      .filter((s) => /ALTER TABLE .* TYPE TIMESTAMPTZ/i.test(s));
    // Helper folds per-table → one ALTER per discovered table (farms, ponds, farm_workers).
    expect(alters).toHaveLength(3);
    expect(alters.some((s) => s.includes('"farm"."farms"'))).toBe(true);
    expect(alters.some((s) => s.includes('"farm"."ponds"'))).toBe(true);
    expect(alters.some((s) => s.includes('"farm"."farm_workers"'))).toBe(true);
    expect(alters.every((s) => /AT TIME ZONE 'UTC'/i.test(s))).toBe(true);
  });

  it('never issues a migration-body SET search_path (runner owns the pin)', async () => {
    const { query, queryRunner } = makeRunner([]);
    await new ConvertFarmAuditColumnsToTimestamptz1801300000000().up(queryRunner);

    const searchPathCalls = query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && /SET\s+search_path/i.test(sql),
    );
    expect(searchPathCalls).toHaveLength(0);
  });

  it('down() is a documented no-op (does not revert to naked timestamp)', async () => {
    const migration = new ConvertFarmAuditColumnsToTimestamptz1801300000000();
    await expect(migration.down()).resolves.toBeUndefined();
  });
});
