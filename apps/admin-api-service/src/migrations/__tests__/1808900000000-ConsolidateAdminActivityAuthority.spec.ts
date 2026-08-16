import type { QueryRunner } from 'typeorm';

import { ConsolidateAdminActivityAuthority1808900000000 } from '../1808900000000-ConsolidateAdminActivityAuthority';
import { ADMIN_AUDIT_DATABASE_AUTHORITY } from '../../audit/audit-database-authority';

describe('ConsolidateAdminActivityAuthority1808900000000', () => {
  it('imports both duplicate authorities with unverified content provenance before dropping them', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new ConsolidateAdminActivityAuthority1808900000000();

    await migration.up({
      query,
    } as unknown as QueryRunner);

    const statements = query.mock.calls.map(([statement]) => String(statement));
    expect(migration.transaction).toBe(true);
    expect(statements[0]).toContain("'LEGACY_ACTIVITY_IMPORTED'");
    expect(statements[0]).toContain("'sourceAuthority', 'admin.activity_logs'");
    expect(statements[0]).toContain("'LEGACY_UNVERIFIED'");
    expect(statements[0]).toContain("public.digest(convert_to(to_jsonb(activity)::text, 'UTF8')");
    expect(statements[1]).toContain("'LEGACY_RETENTION_POLICY_IMPORTED'");
    expect(statements[1]).toContain("'sourceAuthority', 'admin.retention_policies'");
    expect(statements[2]).toContain('DROP TABLE admin.activity_logs');
    expect(statements[3]).toContain('DROP TABLE admin.retention_policies');

    const sql = statements.join('\n');
    expect(sql).toContain(
      `CREATE OR REPLACE FUNCTION ${ADMIN_AUDIT_DATABASE_AUTHORITY.appendFunction}`,
    );
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain(ADMIN_AUDIT_DATABASE_AUTHORITY.appendContextSetting);
    expect(sql).toContain('current_user IS DISTINCT FROM');
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE ON admin.audit_logs');
    expect(sql).toContain(ADMIN_AUDIT_DATABASE_AUTHORITY.retentionControllerRole);
    expect(sql).toContain('trg_audit_logs_authorize_retention_delete');
    expect(sql).toContain('IF OLD."legalHold" = true THEN');
  });

  it('does not reach destructive retirement when a provenance import fails', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('retention provenance import failed'));

    await expect(
      new ConsolidateAdminActivityAuthority1808900000000().up({
        query,
      } as unknown as QueryRunner),
    ).rejects.toThrow('retention provenance import failed');

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.some(([statement]) => String(statement).includes('DROP TABLE'))).toBe(
      false,
    );
  });

  it('rolls back the transactional consolidation if canonical append sealing fails', async () => {
    const query = jest.fn(async (statement: string) => {
      if (
        statement.includes(
          `CREATE OR REPLACE FUNCTION ${ADMIN_AUDIT_DATABASE_AUTHORITY.appendFunction}(`,
        )
      ) {
        throw new Error('append authority installation failed');
      }
    });
    const migration = new ConsolidateAdminActivityAuthority1808900000000();

    await expect(migration.up({ query } as unknown as QueryRunner)).rejects.toThrow(
      'append authority installation failed',
    );

    expect(migration.transaction).toBe(true);
    const attempted = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(attempted).toContain('DROP TABLE admin.activity_logs');
    expect(attempted).not.toContain('GRANT EXECUTE ON FUNCTION');
    expect(attempted).not.toContain('trg_audit_logs_authorize_retention_delete');
  });
});
