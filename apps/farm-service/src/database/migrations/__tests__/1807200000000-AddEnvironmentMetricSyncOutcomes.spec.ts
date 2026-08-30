import { createMockDataSource } from '@aquaculture/testing';
import type { QueryRunner } from 'typeorm';

import { AddEnvironmentMetricSyncOutcomes1807200000000 } from '../1807200000000-AddEnvironmentMetricSyncOutcomes';

describe('AddEnvironmentMetricSyncOutcomes1807200000000', () => {
  let queryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner: queryRunner } = createMockDataSource());
    queryRunner.query.mockResolvedValue(undefined);
  });

  it('adds typed per-metric coverage and partial-failure state constraints', async () => {
    await new AddEnvironmentMetricSyncOutcomes1807200000000().up(queryRunner);

    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "environment_metric_sync_outcomes"');
    expect(sql).toContain("'PARTIAL_FAILURE'");
    expect(sql).toContain('"expected_scope_count"');
    expect(sql).toContain('"successful_scope_count" + "failed_scope_count"');
    expect(sql).toContain('"scope_kind"');
    expect(sql).toContain('"valid_from" <= "valid_to"');
    expect(sql).toContain('FK_environment_metric_sync_state');
    expect(sql).toContain('"uq_environment_metric_sync_outcome_scope"');
    expect(sql).toContain('NULLS NOT DISTINCT');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "expected_scope_count"');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "CHK_site_environment_sync_status"');
    expect(sql).toContain('FROM pg_catalog.pg_constraint');
    expect(sql).toContain("conname = 'CHK_site_environment_sync_status'");
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
  });

  it('refuses a destructive rollback when typed coverage has been persisted', async () => {
    await new AddEnvironmentMetricSyncOutcomes1807200000000().down(queryRunner);

    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql.indexOf('Refusing to drop persisted')).toBeLessThan(
      sql.indexOf('DROP TABLE IF EXISTS "environment_metric_sync_outcomes"'),
    );
    expect(sql).toContain("pg_catalog.to_regclass('environment_metric_sync_outcomes')");
    expect(sql).toContain('FROM pg_catalog.pg_attribute');
    expect(sql).toContain('coverage_column_count = 5');
    expect(sql).toContain('OR "expected_scope_count" <> 0');
    expect(sql).toContain('Refusing rollback from an incomplete environmental sync counter schema');
    expect(sql).toContain('DROP COLUMN IF EXISTS "expected_scope_count"');
    expect(sql).toContain('-- DESTRUCTIVE: down()-only rollback');
    expect(sql).toContain('FROM pg_catalog.pg_constraint');
  });
});
