import type { QueryRunner } from 'typeorm';

import { EstablishAdminAuditTrustClasses1808750000000 } from '../1808750000000-EstablishAdminAuditTrustClasses';

describe('EstablishAdminAuditTrustClasses1808750000000', () => {
  it('makes imported evidence structurally unqualified and provenance-bound', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new EstablishAdminAuditTrustClasses1808750000000();

    await migration.up({
      query,
    } as unknown as QueryRunner);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(migration.transaction).toBe(true);
    expect(sql).toContain("'AUTHORITATIVE_RUNTIME'");
    expect(sql).toContain("'LEGACY_UNVERIFIED'");
    expect(sql).toContain("'sourceAuthority', 'admin.audit_logs.pretrust'");
    expect(sql).toContain("'sourceRowId', audit.id::text");
    expect(sql).toContain("'sourceAction', audit.action");
    expect(sql).toContain("to_jsonb(audit) - 'trustClass' - 'provenance'");
    expect(sql).toContain(
      'ALTER TABLE admin.audit_logs DISABLE TRIGGER trg_audit_logs_prevent_update',
    );
    expect(sql.match(/ENABLE TRIGGER trg_audit_logs_prevent_update/gu)).toHaveLength(2);
    expect(sql).toContain('CHK_admin_audit_logs_trust_provenance');
    expect(sql).toContain(') IS TRUE)');
    expect(sql).toContain("provenance->>'sourceRowSha256' ~ '^[a-f0-9]{64}$'");
    expect(sql).toContain("to_regprocedure('public.digest(bytea,text)')");

    const statements = query.mock.calls.map(([statement]) => String(statement));
    expect(
      statements.findIndex((statement) => statement.includes('admin.audit_logs.pretrust')),
    ).toBeLessThan(statements.findIndex((statement) => statement.includes('SET DEFAULT')));
  });

  it('does not install a runtime default or constraint when pre-trust classification fails', async () => {
    const query = jest.fn(async (statement: string) => {
      if (statement.includes('DO $classification$')) {
        throw new Error('pre-trust digest classification failed');
      }
    });

    await expect(
      new EstablishAdminAuditTrustClasses1808750000000().up({
        query,
      } as unknown as QueryRunner),
    ).rejects.toThrow('pre-trust digest classification failed');

    const attempted = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(attempted).toContain('EXCEPTION WHEN OTHERS');
    expect(attempted).toContain(
      'ALTER TABLE admin.audit_logs ENABLE TRIGGER trg_audit_logs_prevent_update',
    );
    expect(attempted).not.toContain('ALTER COLUMN "trustClass" SET DEFAULT');
    expect(attempted).not.toContain('CHK_admin_audit_logs_trust_provenance');
  });
});
