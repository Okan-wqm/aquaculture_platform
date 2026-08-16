import type { QueryRunner } from 'typeorm';

import { ConsolidateTenantActivityAuthority1808800000000 } from '../1808800000000-ConsolidateTenantActivityAuthority';

describe('ConsolidateTenantActivityAuthority1808800000000', () => {
  it('preserves every legacy row in immutable audit before retiring the duplicate table', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new ConsolidateTenantActivityAuthority1808800000000();
    await migration.up({
      query,
    } as unknown as QueryRunner);

    const statements = query.mock.calls.map(([statement]) => String(statement));
    expect(migration.transaction).toBe(true);
    expect(statements[0]).toContain('INSERT INTO admin.audit_logs');
    expect(statements[0]).toContain("'LEGACY_TENANT_ACTIVITY_IMPORTED'");
    expect(statements[0]).toContain("'LEGACY_UNVERIFIED'");
    expect(statements[0]).toContain("'sourceAuthority', 'admin.tenant_activities'");
    expect(statements[0]).toContain("public.digest(convert_to(to_jsonb(activity)::text, 'UTF8')");
    expect(statements[0]).toContain('FROM admin.tenant_activities activity');
    expect(statements[1]).toContain('DROP TABLE admin.tenant_activities');
    expect(statements[2]).toContain(
      'DROP TYPE IF EXISTS admin.tenant_activities_activitytype_enum',
    );
  });

  it('does not retire the duplicate table when provenance import fails', async () => {
    const query = jest.fn().mockRejectedValueOnce(new Error('tenant activity import failed'));
    const migration = new ConsolidateTenantActivityAuthority1808800000000();

    await expect(migration.up({ query } as unknown as QueryRunner)).rejects.toThrow(
      'tenant activity import failed',
    );

    expect(migration.transaction).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([statement]) => String(statement).includes('DROP TABLE'))).toBe(
      false,
    );
  });
});
