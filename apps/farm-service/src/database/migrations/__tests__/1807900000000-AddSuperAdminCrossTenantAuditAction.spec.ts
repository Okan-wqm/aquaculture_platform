import { createMockDataSource } from '@aquaculture/testing';

import { AddSuperAdminCrossTenantAuditAction1807900000000 } from '../1807900000000-AddSuperAdminCrossTenantAuditAction';

describe('AddSuperAdminCrossTenantAuditAction1807900000000', () => {
  it('adds the source-schema enum label idempotently and tenant-fanout safely', async () => {
    const { mockQueryRunner } = createMockDataSource();
    mockQueryRunner.query.mockResolvedValue(undefined);
    const migration = new AddSuperAdminCrossTenantAuditAction1807900000000();

    await migration.up(mockQueryRunner);

    const sql = String(mockQueryRunner.query.mock.calls[0]?.[0]);
    expect(sql).toContain('n.nspname = current_schema()');
    expect(sql).toContain("t.typname = 'farm_audit_logs_action_enum'");
    expect(sql).toContain("ADD VALUE IF NOT EXISTS 'SUPER_ADMIN_CROSS_TENANT_ACCESS'");
    expect(migration.transaction).toBe(false);
  });

  it('verifies the label wherever the source enum exists', async () => {
    const { mockQueryRunner } = createMockDataSource();
    mockQueryRunner.query.mockResolvedValue([{ valid: true }]);
    const migration = new AddSuperAdminCrossTenantAuditAction1807900000000();

    await expect(migration.postCondition(mockQueryRunner)).resolves.toBe(true);

    const sql = String(mockQueryRunner.query.mock.calls[0]?.[0]);
    expect(sql).toContain("e.enumlabel = 'SUPER_ADMIN_CROSS_TENANT_ACCESS'");
    expect(sql).toContain('WHEN NOT EXISTS');
  });
});
