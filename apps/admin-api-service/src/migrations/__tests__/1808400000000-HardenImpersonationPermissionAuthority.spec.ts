import { createMockDataSource } from '@aquaculture/testing';
import type { QueryRunner } from 'typeorm';

import { HardenImpersonationPermissionAuthority1808400000000 } from '../1808400000000-HardenImpersonationPermissionAuthority';

describe('HardenImpersonationPermissionAuthority1808400000000', () => {
  let queryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner: queryRunner } = createMockDataSource());
    queryRunner.query.mockResolvedValue(undefined);
  });

  it('fails on duplicate authorities and installs the canonical projection constraints', async () => {
    await new HardenImpersonationPermissionAuthority1808400000000().up(queryRunner);

    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('HAVING COUNT(*) > 1');
    expect(sql).toContain('Duplicate impersonation permission authorities exist');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "revokedBy" uuid NULL');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "revokedAt" timestamptz NULL');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "revocationReason" text NULL');
    expect(sql).toContain('ALTER COLUMN "notifyTenantAdmin" SET DEFAULT false');
    expect(sql).toContain('SET "notifyTenantAdmin" = false');
    expect(sql).toContain('"UQ_admin_impersonation_permissions_super_admin"');
    expect(sql).toContain('("superAdminId")');
  });

  it('refuses rollback to duplicate or fictional authority state', async () => {
    await expect(new HardenImpersonationPermissionAuthority1808400000000().down()).rejects.toThrow(
      'Refusing to roll back impersonation permission authority hardening',
    );
  });
});
