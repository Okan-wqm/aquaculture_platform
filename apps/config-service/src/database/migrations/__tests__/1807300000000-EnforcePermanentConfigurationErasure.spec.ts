import { createMockDataSource } from '@aquaculture/testing';
import type { QueryRunner } from 'typeorm';

import { EnforcePermanentConfigurationErasure1807300000000 } from '../1807300000000-EnforcePermanentConfigurationErasure';

describe('EnforcePermanentConfigurationErasure1807300000000', () => {
  let queryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner: queryRunner } = createMockDataSource());
    queryRunner.query.mockResolvedValue(undefined);
  });

  it('uses explicit RLS authority and deletes only tenants with non-dry config proofs', async () => {
    await new EnforcePermanentConfigurationErasure1807300000000().up(queryRunner);

    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain("set_config('app.bypass_rls', 'on', true)");
    expect(sql).toContain("current_setting('app.bypass_rls', true) IS DISTINCT FROM 'on'");
    expect(sql).toContain('DELETE FROM "config"."configuration_history"');
    expect(sql).toContain('DELETE FROM "config"."configurations"');
    expect(sql).toContain('proof."targetService" = \'config-service\'');
    expect(sql).toContain('proof."dryRun" = false');
    expect(sql).toContain('configuration."tenant_id" = erased.tenant_id');
  });

  it('is deliberately forward-only because erased secrets cannot be restored', async () => {
    await new EnforcePermanentConfigurationErasure1807300000000().down(queryRunner);

    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('cannot roll back historical config erasure residual repair');
  });
});
