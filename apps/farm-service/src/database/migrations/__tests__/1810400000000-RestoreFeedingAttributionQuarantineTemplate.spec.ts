import { createMockDataSource } from '@aquaculture/testing';
import type { QueryRunner } from 'typeorm';

import { RestoreFeedingAttributionQuarantineTemplate1810400000000 } from '../1810400000000-RestoreFeedingAttributionQuarantineTemplate';

describe('RestoreFeedingAttributionQuarantineTemplate1810400000000', () => {
  let queryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner: queryRunner } = createMockDataSource());
    queryRunner.query.mockResolvedValue(undefined);
  });

  it('recreates the per-tenant template unqualified and idempotently, with the same shape as 1808700000000', async () => {
    await new RestoreFeedingAttributionQuarantineTemplate1810400000000().up(queryRunner);
    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "feeding_record_attribution_quarantine"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "IDX_fraq_tenant_record"');
    expect(sql).toContain(
      'CONSTRAINT "PK_feeding_record_attribution_quarantine" PRIMARY KEY ("id")',
    );
    expect(sql).toContain('"actualAmount" numeric(10,3) NOT NULL');
    // Per-tenant: the fan-out pins search_path, so the DDL must not name a schema.
    expect(sql).not.toContain('"farm".');
    expect(sql).not.toContain('DROP');
  });

  it('checks the table resolves on the pinned schema and reverts nothing', async () => {
    const migration = new RestoreFeedingAttributionQuarantineTemplate1810400000000();
    queryRunner.query.mockResolvedValueOnce([{ ok: true }]);
    await expect(migration.postCondition(queryRunner)).resolves.toBe(true);
    expect(String(queryRunner.query.mock.calls[0]?.[0])).toContain(
      "to_regclass('feeding_record_attribution_quarantine')",
    );
    queryRunner.query.mockClear();
    await migration.down();
    expect(queryRunner.query).not.toHaveBeenCalled();
  });
});
