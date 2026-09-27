import { getSourceOnlyMigrationMetadata } from '@aquaculture/backend-common/database';
import { createMockDataSource } from '@aquaculture/testing';
import type { QueryRunner } from 'typeorm';

import { RestoreFeedingClockLedgersInSource1810500000000 } from '../1810500000000-RestoreFeedingClockLedgersInSource';

describe('RestoreFeedingClockLedgersInSource1810500000000', () => {
  let queryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner: queryRunner } = createMockDataSource());
    queryRunner.query.mockResolvedValue(undefined);
  });

  it('is source-only: the ledgers are infrastructure and never cloned into tenant schemas', () => {
    expect(getSourceOnlyMigrationMetadata(RestoreFeedingClockLedgersInSource1810500000000)).toEqual(
      expect.objectContaining({
        reason: expect.stringContaining('cross-tenant farm infrastructure'),
      }),
    );
  });

  it('recreates both ledgers schema-qualified and idempotently, with the same shape as 1809100000000', async () => {
    await new RestoreFeedingClockLedgersInSource1810500000000().up(queryRunner);
    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "farm"."tenant_localization"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "farm"."feeding_job_runs"');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "UQ_fjr_tenant_job_local_date"\n         ON "farm"."feeding_job_runs" ("tenantId", "jobName", "localDate")',
    );
    expect(sql).toContain(
      'CREATE INDEX IF NOT EXISTS "IDX_fjr_started_at" ON "farm"."feeding_job_runs"',
    );
    expect(sql).toContain(
      `CONSTRAINT "CHK_fjr_status" CHECK ("status" IN ('running', 'succeeded', 'failed'))`,
    );
    expect(sql).not.toContain('DROP');
  });

  it('checks both tables and the claim index in the source schema, and reverts nothing', async () => {
    const migration = new RestoreFeedingClockLedgersInSource1810500000000();
    queryRunner.query.mockResolvedValueOnce([{ ok: true }]);
    await expect(migration.postCondition(queryRunner)).resolves.toBe(true);
    const check = String(queryRunner.query.mock.calls[0]?.[0]);
    expect(check).toContain("to_regclass('farm.tenant_localization')");
    expect(check).toContain("to_regclass('farm.feeding_job_runs')");
    expect(check).toContain("schemaname = 'farm' AND indexname = 'UQ_fjr_tenant_job_local_date'");
    queryRunner.query.mockClear();
    await migration.down();
    expect(queryRunner.query).not.toHaveBeenCalled();
  });
});
