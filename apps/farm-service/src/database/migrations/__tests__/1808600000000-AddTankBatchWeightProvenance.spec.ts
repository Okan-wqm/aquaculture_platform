import { createMockDataSource } from '@aquaculture/testing';
import type { QueryRunner } from 'typeorm';

import { AddTankBatchWeightProvenance1808600000000 } from '../1808600000000-AddTankBatchWeightProvenance';

describe('AddTankBatchWeightProvenance1808600000000', () => {
  let queryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner: queryRunner } = createMockDataSource());
    queryRunner.query.mockResolvedValue(undefined);
  });

  const sqlOf = (): string =>
    queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');

  it('adds a nullable jsonb provenance column, idempotently', async () => {
    await new AddTankBatchWeightProvenance1808600000000().up(queryRunner);

    const sql = sqlOf();
    expect(sql).toContain('ALTER TABLE "tank_batches"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "weightProvenance" jsonb');
    // Blue-green safety: a NOT NULL / DEFAULT would break old replicas that
    // never write the column mid-rollout.
    expect(sql).not.toContain('"weightProvenance" jsonb NOT NULL');
    expect(sql).not.toContain('SET DEFAULT');
  });

  it('constrains the discriminator to the two sources that exist', async () => {
    await new AddTankBatchWeightProvenance1808600000000().up(queryRunner);

    const sql = sqlOf();
    expect(sql).toContain('CHK_tank_batches_weight_provenance_source');
    expect(sql).toContain("'fcr_projection'");
    expect(sql).toContain("'measurement'");
    // NULL = "written before provenance was recorded"; it must stay legal
    // rather than be back-filled with a source nobody observed.
    expect(sql).toContain('"weightProvenance" IS NULL');
    // Re-runnable: the constraint is dropped before it is added.
    expect(
      sql.indexOf('DROP CONSTRAINT IF EXISTS "CHK_tank_batches_weight_provenance_source"'),
    ).toBeLessThan(sql.indexOf('ADD CONSTRAINT "CHK_tank_batches_weight_provenance_source"'));
  });

  it('targets the tenant-relative table name (tank_batches is per-tenant)', async () => {
    await new AddTankBatchWeightProvenance1808600000000().up(queryRunner);

    const sql = sqlOf();
    // db-migrate fans farm migrations out with search_path pinned per schema;
    // a hardcoded schema qualifier would write into one schema only.
    expect(sql).not.toContain('"farm"."tank_batches"');
    expect(sql).not.toContain('public.tank_batches');
  });

  it('bounds lock and statement time so the ALTER cannot wedge a busy table', async () => {
    await new AddTankBatchWeightProvenance1808600000000().up(queryRunner);

    const sql = sqlOf();
    expect(sql).toContain("SET LOCAL lock_timeout = '2s'");
    expect(sql).toContain("SET LOCAL statement_timeout = '30s'");
  });

  it('drops the constraint before the column on rollback', async () => {
    await new AddTankBatchWeightProvenance1808600000000().down(queryRunner);

    const sql = sqlOf();
    expect(
      sql.indexOf('DROP CONSTRAINT IF EXISTS "CHK_tank_batches_weight_provenance_source"'),
    ).toBeLessThan(sql.indexOf('DROP COLUMN IF EXISTS "weightProvenance"'));
  });
});
