import { createMockDataSource } from '@aquaculture/testing';
import type { QueryRunner } from 'typeorm';

import { PersistTenantErasureDryRunMode1807500000000 } from '../1807500000000-PersistTenantErasureDryRunMode';

describe('PersistTenantErasureDryRunMode1807500000000', () => {
  let queryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner: queryRunner } = createMockDataSource());
    queryRunner.query.mockResolvedValue(undefined);
  });

  it('backfills mode, blocks old writers, aborts jobs, and installs a DB deletion guard', async () => {
    await new PersistTenantErasureDryRunMode1807500000000().up(queryRunner);

    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "dryRun" boolean');
    expect(sql).toContain('admin.admin_outbox');
    expect(sql).toContain("outbox.payload->>'dryRun'");
    expect(sql).toContain('TenantErasureModeBackfillFailed');
    expect(sql).toContain('platform.tenant_schema_jobs');
    expect(sql).toContain("SET status = 'ABORTED'");
    expect(sql).toContain('TRG_reject_dry_run_schema_deletion_job');
    expect(sql).toContain('tenant schema deletion rejected because erasure operation is a dry run');
    expect(sql).toContain('historical tenant-erasure dry run has a completed schema deletion job');
    expect(sql).toContain("job.status = 'DELETED'");
    expect(sql).toContain('TenantErasureProofModeMismatch');
    expect(sql).toContain('TenantErasureDryRunSchemaDeletionRejected');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = pg_catalog, pg_temp');
    expect(sql).toContain('OWNER TO admin_schema_owner');
    expect(sql).toContain('conflicting historical tenant-erasure dry-run modes');
    expect(sql).toContain('outbox.id DESC');
    expect(sql).toContain('FROM information_schema.columns');
    expect(sql).toContain("AND is_nullable = 'YES'");
    expect(sql).toContain('ALTER COLUMN "dryRun" SET NOT NULL');
    expect(sql).toContain('idx_tenant_erasure_operations_request_recovery');
    expect(sql).not.toContain('SET DEFAULT');
  });

  it('is forward-only because rollback would restore destructive ambiguity', async () => {
    await new PersistTenantErasureDryRunMode1807500000000().down(queryRunner);

    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('cannot roll back persisted tenant-erasure dry-run semantics safely');
  });
});
