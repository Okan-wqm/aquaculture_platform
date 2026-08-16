import type { QueryRunner } from 'typeorm';

import { SealTenantCommandReceiptEvidence1808500000000 } from '../1808500000000-SealTenantCommandReceiptEvidence';

describe('SealTenantCommandReceiptEvidence1808500000000', () => {
  it('installs a forward-only UPDATE/DELETE fence for successful receipts', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new SealTenantCommandReceiptEvidence1808500000000().up({
      query,
    } as unknown as QueryRunner);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain("IF OLD.status = 'SUCCEEDED'");
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON auth.tenant_command_receipts');
    expect(sql).toContain('REVOKE DELETE ON auth.tenant_command_receipts FROM PUBLIC');
  });
});
