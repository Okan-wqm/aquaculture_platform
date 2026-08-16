import { createMockDataSource } from '@aquaculture/testing';
import type { QueryRunner } from 'typeorm';

import { HardenTenantOnboardingEvidence1808600000000 } from '../1808600000000-HardenTenantOnboardingEvidence';

describe('HardenTenantOnboardingEvidence1808600000000', () => {
  let queryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner: queryRunner } = createMockDataSource());
    queryRunner.query.mockResolvedValue(undefined);
  });

  it('adds generation-fenced command coordinates and immutable typed outcomes', async () => {
    await new HardenTenantOnboardingEvidence1808600000000().up(queryRunner);
    const sql = queryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');

    expect(sql).toContain('"onboardingAttempt" INTEGER NOT NULL DEFAULT 0');
    expect(sql).toContain('"onboardingRequestEventId" UUID NULL');
    expect(sql).toContain('UNIQUE ("operationId", service, attempt)');
    expect(sql).toContain('"schemaVersion" = 1');
    expect(sql).toContain("conname = 'chk_tenant_provisioning_runs_onboarding_command'");
    expect(sql).toContain("conname = 'uk_tenant_onboarding_acks_operation_service_attempt'");
    expect(sql).toContain("conname = 'chk_tenant_onboarding_acks_contract_v1'");
    expect(sql).toContain('NOT VALID');
    expect(sql).toContain('VALIDATE CONSTRAINT');
    expect(sql).toContain('guard_tenant_onboarding_outcome_immutability');
    expect(sql).toContain('REVOKE UPDATE, DELETE');
  });

  it('refuses rollback to an uncorrelated mutable ACK table', async () => {
    await expect(new HardenTenantOnboardingEvidence1808600000000().down()).rejects.toThrow(
      'forward-only',
    );
  });
});
