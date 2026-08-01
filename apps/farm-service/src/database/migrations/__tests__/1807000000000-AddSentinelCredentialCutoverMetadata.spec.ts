import type { QueryRunner } from 'typeorm';

import { createMockDataSource } from '@aquaculture/testing';

import { AddSentinelCredentialCutoverMetadata1807000000000 } from '../1807000000000-AddSentinelCredentialCutoverMetadata';

describe('AddSentinelCredentialCutoverMetadata1807000000000', () => {
  let mockQueryRunner: jest.Mocked<QueryRunner>;

  beforeEach(() => {
    ({ mockQueryRunner } = createMockDataSource());
    mockQueryRunner.query.mockResolvedValue(undefined);
  });

  it('adds cutover provenance to the current tenant schema only', async () => {
    await new AddSentinelCredentialCutoverMetadata1807000000000().up(mockQueryRunner);

    const sql = mockQueryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');

    expect(sql).toContain('ALTER TABLE "sentinel_hub_settings"');
    expect(sql).not.toContain('"farm"."sentinel_hub_settings"');
    expect(sql).toContain('"config_cutover_at" timestamptz');
    expect(sql).toContain('"config_cutover_bundle_digest" varchar(64)');
    expect(sql).toContain('"config_cutover_version" integer');
    expect(sql).toContain('"config_cutover_source_tenant_id" uuid');
    expect(sql).toContain('"config_cutover_erased_at" timestamptz');
    expect(sql).toContain('UPDATE "sentinel_hub_settings"');
    expect(sql).toContain('"is_configured" = false');
    expect(sql).toContain('"client_secret" = NULL');
  });

  it('requires complete provenance and permanently scrubbed legacy credentials', async () => {
    await new AddSentinelCredentialCutoverMetadata1807000000000().up(mockQueryRunner);

    const sql = mockQueryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');

    expect(sql).toContain('CHK_sentinel_hub_settings_config_cutover_complete');
    expect(sql).toContain('"config_cutover_bundle_digest" ~ \'^[a-f0-9]{64}$\'');
    expect(sql).toContain('"config_cutover_version" > 0');
    expect(sql).toContain('"config_cutover_source_tenant_id" = "tenantId"');
    expect(sql).toContain('"is_configured" = false');
    expect(sql).toContain('"client_id" IS NULL');
    expect(sql).toContain('"client_secret" IS NULL');
    expect(sql).toContain('"instance_id" IS NULL');
    expect(sql).toContain('TRG_prevent_sentinel_hub_credential_reactivation');
    expect(sql).toContain('BEFORE UPDATE OR DELETE');
    expect(sql).toContain('OLD."config_cutover_bundle_digest" IS NOT NULL');
    expect(sql).toContain(
      'prepared Sentinel credential bundle is immutable until cutover completes',
    );
    expect(sql).toContain('"config_cutover_erased_at" IS NOT NULL');
    expect(sql).toContain('"config_cutover_version" IS NULL');
    expect(sql).toContain('"config_cutover_source_tenant_id" IS NULL');
  });

  it('allows DELETE only under the exact tenant-erasure transaction proof', async () => {
    await new AddSentinelCredentialCutoverMetadata1807000000000().up(mockQueryRunner);

    const sql = mockQueryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');

    expect(sql).toContain('pg_catalog.current_setting');
    expect(sql).toContain("'app.tenant_erasure_target_service', true");
    expect(sql).toContain("'app.tenant_erasure_tenant_id', true");
    expect(sql).toContain("'app.tenant_erasure_operation_id', true");
    expect(sql).toContain('erasure_tenant::uuid = OLD."tenantId"');
    expect(sql).toContain('scoped_tenant::uuid = OLD."tenantId"');
    expect(sql).toContain('SET search_path = pg_catalog');
    expect(sql).toContain("pg_catalog.hashtext('farm-service:sentinel-erasure:v1')::oid");
    expect(sql).toContain('held_lock.objsubid = 2');
    expect(sql).toContain('held_lock.pid = pg_catalog.pg_backend_pid()');
    expect(sql).toContain(
      'Sentinel credential rows may only be deleted by authorized tenant erasure',
    );
  });

  it('installs the cutover constraint through a relation-scoped idempotency guard', async () => {
    await new AddSentinelCredentialCutoverMetadata1807000000000().up(mockQueryRunner);

    const sql = mockQueryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');

    expect(sql).toContain('DO $$');
    expect(sql).toContain('IF NOT EXISTS');
    expect(sql).toContain('FROM pg_catalog.pg_constraint');
    expect(sql).toContain("conname = 'CHK_sentinel_hub_settings_config_cutover_complete'");
    expect(sql).toContain("conrelid = 'sentinel_hub_settings'::regclass");
    expect(sql).not.toContain(
      'DROP CONSTRAINT IF EXISTS "CHK_sentinel_hub_settings_config_cutover_complete"',
    );
  });

  it('reverts metadata without dropping the retained credential table', async () => {
    await new AddSentinelCredentialCutoverMetadata1807000000000().down(mockQueryRunner);

    const sql = mockQueryRunner.query.mock.calls.map(([statement]) => String(statement)).join('\n');

    expect(sql).toContain(
      'DROP CONSTRAINT IF EXISTS "CHK_sentinel_hub_settings_config_cutover_complete"',
    );
    expect(sql).toContain('DROP COLUMN IF EXISTS "config_cutover_at"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "config_cutover_bundle_digest"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "config_cutover_erased_at"');
    expect(sql).toContain(
      'DROP TRIGGER IF EXISTS "TRG_prevent_sentinel_hub_credential_reactivation"',
    );
    expect(sql).toContain(
      'DROP FUNCTION IF EXISTS "prevent_sentinel_hub_credential_reactivation"()',
    );
    expect(sql).not.toContain('DROP TABLE');
  });
});
