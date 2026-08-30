import type { QueryRunner } from 'typeorm';

import { createMockDataSource } from '@aquaculture/testing';

import { ProtectFeedingRecordBackfillProvenance1808600000000 } from '../1808600000000-ProtectFeedingRecordBackfillProvenance';

describe('ProtectFeedingRecordBackfillProvenance1808600000000', () => {
  let mockQueryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner } = createMockDataSource());
    mockQueryRunner.query.mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  async function upSql(): Promise<string> {
    await new ProtectFeedingRecordBackfillProvenance1808600000000().up(mockQueryRunner);
    return mockQueryRunner.query.mock.calls.map((call) => String(call[0])).join('\n');
  }

  it('classifies 180660 rows only by exact migration-ledger transaction xmin', async () => {
    const sql = await upSql();

    expect(sql).toContain('LOCK TABLE feeding_records IN SHARE ROW EXCLUSIVE MODE');
    expect(sql).toContain("m.name = 'BackfillExecutionsToFeedingRecords1806600000000'");
    expect(sql).toContain('m.timestamp = 1806600000000');
    expect(sql).toContain("WHEN current_schema() = 'farm' THEN 'migrations'");
    expect(sql).toContain("ELSE 'migrations_farm'");
    expect(sql).toContain('FROM %I.%I m');
    expect(sql).toMatch(/migration_tx\.transaction_xmin\s*=\s*fr\.xmin/);
    expect(sql).toContain("THEN 'BACKFILL_180660'");
    expect(sql).toContain("ELSE 'UNKNOWN'");
    expect(sql).toContain('conflicting classified provenance exists');
    expect(sql).toContain('provenance.content_hash IS DISTINCT FROM expected.content_hash');
    expect(sql).toContain("'aqua.feeding_provenance_preprotected'");
    expect(sql).toContain("IS DISTINCT FROM 'on'");
    expect(sql).not.toContain('ON CONFLICT (feeding_record_id) DO NOTHING');
    expect(sql).not.toMatch(/"createdAt"\s*[<>=]/);
  });

  it('captures later source-execution inserts as LIVE_DRAIN with immutable evidence', async () => {
    const sql = await upSql();
    const captureFunctionSql = mockQueryRunner.query.mock.calls
      .map((call) => String(call[0]))
      .find((statement) =>
        statement.includes(
          'CREATE OR REPLACE FUNCTION capture_live_drain_feeding_record_provenance',
        ),
      );

    expect(sql).toContain('AFTER INSERT ON feeding_records');
    expect(sql).toContain("new_row ? 'sourceExecutionId'");
    expect(sql).toContain("new_row->>'sourceExecutionId' IS NOT NULL");
    expect(sql).toContain("'LIVE_DRAIN'");
    expect(sql).toContain('NEW.xmin::text');
    expect(sql).toContain('expected_hash := md5(new_row::text)');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON feeding_record_provenance');
    expect(captureFunctionSql).toBeDefined();
    expect(captureFunctionSql).not.toContain('ON CONFLICT');
    expect(captureFunctionSql).toContain("current_setting('aqua.migration_name', true)");
    expect(captureFunctionSql).toContain("current_setting('aqua.migration_direction', true)");
    expect(captureFunctionSql).toContain("expected_origin := 'BACKFILL_180660'");
    expect(captureFunctionSql).toContain("expected_origin := 'LIVE_DRAIN'");
    expect(captureFunctionSql).toContain("pg_has_role(session_user, 'db_migrate', 'USAGE')");
    expect(captureFunctionSql).toContain('conflicting provenance already exists');
  });

  it('pins every trigger function to its creation-time schema and forbids provenance truncation', async () => {
    const sql = await upSql();

    expect((sql.match(/SET search_path FROM CURRENT/g) ?? []).length).toBe(3);
    expect(sql).toContain('BEFORE TRUNCATE ON feeding_record_provenance');
    expect(sql).toContain('FOR EACH STATEMENT');
    expect(sql).toContain('feeding_record_provenance is immutable (TRUNCATE)');
  });

  it('allows only proven backfill deletion, preserves live drain, and rejects unknown', async () => {
    const sql = await upSql();

    expect(sql).toContain(
      "current_setting('aqua.migration_direction', true) IS DISTINCT FROM 'down'",
    );
    expect(sql).toContain("pg_has_role(session_user, 'db_migrate', 'USAGE')");
    expect(sql).toContain('old_row := to_jsonb(OLD)');
    expect(sql).toMatch(/recorded_origin\s*=\s*'BACKFILL_180660'[\s\S]*RETURN OLD/);
    expect(sql).toMatch(/recorded_origin\s*=\s*'LIVE_DRAIN'[\s\S]*RETURN NULL/);
    expect(sql).toContain('refusing to delete feeding record');
    expect(sql).toContain("COALESCE(recorded_origin, 'UNKNOWN')");
  });

  it('retains every provenance control on down', async () => {
    await new ProtectFeedingRecordBackfillProvenance1808600000000().down();
    expect(mockQueryRunner.query).not.toHaveBeenCalled();
  });

  it('revokes direct service-role writes to the protected ledger', async () => {
    const sql = await upSql();

    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE');
    expect(sql).toContain('FROM farm_service');
    expect(sql).toContain('GRANT SELECT ON feeding_record_provenance TO farm_service');
    expect(sql).toContain('SECURITY DEFINER');
  });
});
