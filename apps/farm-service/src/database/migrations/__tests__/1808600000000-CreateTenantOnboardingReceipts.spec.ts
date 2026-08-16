import { createMockDataSource } from '@aquaculture/testing';
import type { QueryRunner } from 'typeorm';

import { CreateTenantOnboardingReceipts1808600000000 } from '../1808600000000-CreateTenantOnboardingReceipts';

describe('CreateTenantOnboardingReceipts1808600000000', () => {
  let queryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner: queryRunner } = createMockDataSource());
    queryRunner.query.mockResolvedValue(undefined);
  });

  it('creates a source-only leased receipt ledger with immutable terminal states', async () => {
    await new CreateTenantOnboardingReceipts1808600000000().up(queryRunner);
    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');

    expect(sql).toContain('farm.tenant_onboarding_receipts');
    expect(sql).toContain('UNIQUE ("operationId", attempt)');
    expect(sql).toContain('UNIQUE ("requestEventId")');
    expect(sql).toContain("state IN ('PROCESSING', 'ACKNOWLEDGED', 'FAILED')");
    expect(sql).toContain('guard_terminal_tenant_onboarding_receipt');
    expect(sql).toContain('REVOKE DELETE');
  });

  it('refuses destructive rollback of durable receipts', async () => {
    await expect(new CreateTenantOnboardingReceipts1808600000000().down()).rejects.toThrow(
      'durable recovery evidence',
    );
  });
});
