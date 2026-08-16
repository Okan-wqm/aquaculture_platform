import type { QueryRunner } from 'typeorm';

import { EnforceTenantOnboardingAckMonotonicity1808300000000 } from '../1808300000000-EnforceTenantOnboardingAckMonotonicity';

describe('EnforceTenantOnboardingAckMonotonicity1808300000000', () => {
  it('installs the durable requirement, admission, and activation barrier', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new EnforceTenantOnboardingAckMonotonicity1808300000000();

    await migration.up({ query } as Pick<QueryRunner, 'query'> as QueryRunner);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).not.toContain('farm-service');
    expect(sql).not.toMatch(/["']sourceProfileDigest["']\s*:/);
    expect(sql).not.toContain('ADD COLUMN IF NOT EXISTS');
    expect(sql).not.toContain('CREATE TABLE IF NOT EXISTS');
    expect(sql).toContain('LEGACY_UNQUALIFIED');
    expect(sql).toContain('requires an explicit catalog-qualified retry');
    expect(sql).toContain('tenant_onboarding_acks_legacy');
    expect(sql).toContain('descriptor_mismatch');
    expect(sql).toContain("ERRCODE = '23514'");
    expect(sql).toContain('tenant_onboarding_requirements');
    expect(sql).toContain('onboardingRequirementsDigest');
    expect(sql).toContain('WAITING_ONBOARDING');
    expect(sql).toContain('admit_tenant_onboarding_outcome');
    expect(sql).toContain('CONTRADICTORY_TERMINAL_OUTCOME');
    expect(sql).toContain('seal_tenant_onboarding_activation');
    expect(sql).toContain('consume_tenant_onboarding_activation');
    expect(sql).toContain('publish_tenant_onboarding_request');
    expect(sql).toContain('assert_tenant_onboarding_publication');
    expect(sql).toContain('onboardingPublicationDigest');
    expect(sql).toContain('FROM PUBLIC');
    expect(sql).not.toContain('chr(0)');
    expect(sql).toContain('publish_onboarding_requested');
    expect(sql).toContain('wait_for_onboarding_ack');
    expect(sql).toContain('FOR EACH ROW');
    expect(query.mock.calls.length).toBeGreaterThan(12);
  });

  it('refuses a rollback that would make failures reversible', async () => {
    const migration = new EnforceTenantOnboardingAckMonotonicity1808300000000();

    await expect(migration.down()).rejects.toThrow(
      'durable tenant onboarding admission and activation barrier',
    );
  });
});
