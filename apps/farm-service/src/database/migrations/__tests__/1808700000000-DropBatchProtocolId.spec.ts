import { createMockDataSource } from '@aquaculture/testing';
import type { QueryRunner } from 'typeorm';

import { DropBatchProtocolId1808700000000 } from '../1808700000000-DropBatchProtocolId';

/**
 * Pins the SQL SHAPE of the drop, which is where this class of migration goes
 * wrong: a hardcoded schema turns a per-tenant DDL into cross-schema DDL and
 * aborts the whole db-migrate fan-out (the 2026-07-07 #926 outage). Every
 * reference here must be current_schema()-relative and guarded.
 */
describe('DropBatchProtocolId1808700000000', () => {
  let queryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner: queryRunner } = createMockDataSource());
    queryRunner.query.mockResolvedValue(undefined);
  });

  function upSql(): string {
    return queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');
  }

  it('drops the column only when it exists in the CURRENT schema', async () => {
    await new DropBatchProtocolId1808700000000().up(queryRunner);
    const sql = upSql();

    expect(sql).toContain('ALTER TABLE %I.batches_v2 DROP COLUMN IF EXISTS "protocolId"');
    // Existence probe scoped to current_schema() — a schema that never ran
    // 1802000000000 skips instead of erroring.
    expect(sql).toContain('information_schema.columns');
    expect(sql).toContain("table_name = 'batches_v2'");
    expect(sql).toContain("column_name = 'protocolId'");
    expect(sql).toContain('RAISE NOTICE');
  });

  it('never names a schema explicitly — every reference is current_schema()', async () => {
    await new DropBatchProtocolId1808700000000().up(queryRunner);
    const sql = upSql();

    // Two current_schema() uses: the probe predicate and the format() argument.
    expect(sql.match(/current_schema\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    // No hardcoded source/tenant schema anywhere.
    expect(sql).not.toMatch(/"farm"\./);
    expect(sql).not.toMatch(/\btenant_[0-9a-f]/);
  });

  it('bounds the lock so a busy table cannot stall the deploy', async () => {
    await new DropBatchProtocolId1808700000000().up(queryRunner);
    const sql = upSql();

    expect(sql).toContain(`SET LOCAL lock_timeout = '2s'`);
    expect(sql).toContain(`SET LOCAL statement_timeout = '30s'`);
  });

  it('is forward-only: down() re-creates nothing', async () => {
    await new DropBatchProtocolId1808700000000().down(queryRunner);

    expect(queryRunner.query).not.toHaveBeenCalled();
  });
});
