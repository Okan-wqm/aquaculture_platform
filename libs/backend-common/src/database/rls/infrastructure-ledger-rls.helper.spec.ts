import type { QueryRunner } from 'typeorm';

import {
  applyInfrastructureLedgerRls,
  INFRA_LEDGER_APPEND_POLICY_NAME,
  INFRA_LEDGER_READ_POLICY_NAME,
} from './infrastructure-ledger-rls.helper';

/**
 * applyInfrastructureLedgerRls — the canonical cross-tenant infrastructure
 * audit-ledger policy installer (ORPHAN-MEDIUM-324). Pins the exact DDL: drops
 * the category-error tenant_isolation_policy + the prior audit_append_system,
 * installs an unconditional append INSERT + a system-aware SELECT, and installs
 * NO update/delete policy (immutability). db-migrate authority only.
 */
describe('applyInfrastructureLedgerRls', () => {
  const AUTHORITY_ENV = 'DB_MIGRATE_DDL_AUTHORITY';
  const original = process.env[AUTHORITY_ENV];

  afterEach(() => {
    if (original === undefined) Reflect.deleteProperty(process.env, AUTHORITY_ENV);
    else process.env[AUTHORITY_ENV] = original;
  });

  /**
   * Recording QueryRunner double. `query` answers the two introspection probes
   * (table exists, tenant column) and records every DDL statement.
   */
  function makeQueryRunner(opts: {
    exists?: boolean;
    tenantColumn?: string | null;
  }): { qr: QueryRunner; statements: string[] } {
    const statements: string[] = [];
    const query = (sql: string): Promise<unknown> => {
      if (sql.includes('information_schema.tables')) {
        return Promise.resolve([{ exists: opts.exists ?? true }]);
      }
      if (sql.includes('information_schema.columns')) {
        const col = opts.tenantColumn === undefined ? 'tenantId' : opts.tenantColumn;
        return Promise.resolve(col ? [{ column_name: col }] : []);
      }
      statements.push(sql);
      return Promise.resolve([]);
    };
    // Cast-free: Object.create(null) + the one method the helper calls; the
    // helper's param is typed QueryRunner but only `query` is exercised.
    const qr = Object.assign(Object.create(null) as QueryRunner, { query });
    return { qr, statements };
  }

  it('refuses to run without db-migrate DDL authority', async () => {
    Reflect.deleteProperty(process.env, AUTHORITY_ENV);
    const { qr } = makeQueryRunner({});
    await expect(
      applyInfrastructureLedgerRls(qr, { schema: 'auth', ledgers: ['audit_logs'] }),
    ).rejects.toThrow(/db-migrate authority/);
  });

  it('installs the canonical append + system-read policy and drops the wrong ones', async () => {
    process.env[AUTHORITY_ENV] = '1';
    const { qr, statements } = makeQueryRunner({ exists: true, tenantColumn: 'tenantId' });

    await applyInfrastructureLedgerRls(qr, { schema: 'auth', ledgers: ['audit_logs'] });

    const joined = statements.join('\n');
    // Enable + FORCE RLS
    expect(joined).toContain('ENABLE ROW LEVEL SECURITY');
    expect(joined).toContain('FORCE ROW LEVEL SECURITY');
    // Drops the category-error tenant policy + the prior auth append patch
    expect(joined).toContain('DROP POLICY IF EXISTS "tenant_isolation_policy" ON "auth"."audit_logs"');
    expect(joined).toContain('DROP POLICY IF EXISTS "audit_append_system" ON "auth"."audit_logs"');
    // Append INSERT policy — unconditional
    expect(joined).toContain(
      `CREATE POLICY "${INFRA_LEDGER_APPEND_POLICY_NAME}" ON "auth"."audit_logs" FOR INSERT WITH CHECK (true)`,
    );
    // System-aware SELECT policy — bypass OR no-context OR tenant-scoped
    expect(joined).toContain(`CREATE POLICY "${INFRA_LEDGER_READ_POLICY_NAME}" ON "auth"."audit_logs" FOR SELECT`);
    expect(joined).toContain(`current_setting('app.bypass_rls', true) = 'on'`);
    expect(joined).toContain(`NULLIF(current_setting('app.current_tenant', true), '') IS NULL`);
    expect(joined).toContain(`"tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid`);
    // Immutability: NO update/delete policy is ever created
    expect(joined).not.toMatch(/CREATE POLICY .* FOR UPDATE/);
    expect(joined).not.toMatch(/CREATE POLICY .* FOR DELETE/);
    // And it never re-creates tenant_isolation_policy
    expect(joined).not.toMatch(/CREATE POLICY "tenant_isolation_policy"/);
  });

  it('omits the tenant-scoped SELECT branch when the ledger has no tenant column', async () => {
    process.env[AUTHORITY_ENV] = '1';
    const { qr, statements } = makeQueryRunner({ exists: true, tenantColumn: null });

    await applyInfrastructureLedgerRls(qr, { schema: 'event_store', ledgers: ['events'] });

    const joined = statements.join('\n');
    expect(joined).toContain(`CREATE POLICY "${INFRA_LEDGER_READ_POLICY_NAME}"`);
    expect(joined).toContain(`current_setting('app.bypass_rls', true) = 'on'`);
    // No tenantId equality branch when there is no tenant column.
    expect(joined).not.toContain('::uuid');
  });

  it('skips a ledger that does not exist yet (idempotent, no ALTER)', async () => {
    process.env[AUTHORITY_ENV] = '1';
    const { qr, statements } = makeQueryRunner({ exists: false });

    await applyInfrastructureLedgerRls(qr, { schema: 'hr', ledgers: ['payroll_audit'] });

    expect(statements).toHaveLength(0); // nothing armed
  });

  it('is a no-op for an empty ledger list', async () => {
    process.env[AUTHORITY_ENV] = '1';
    const { qr, statements } = makeQueryRunner({});
    await applyInfrastructureLedgerRls(qr, { schema: 'billing', ledgers: [] });
    expect(statements).toHaveLength(0);
  });
});
