import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');

describe('tenant schema provisioner contract', () => {
  const sql = readFileSync(
    resolve(ROOT, 'sql/platform-bootstrap/009-tenant-schema-provisioner.sql'),
    'utf8',
  );
  const worker = readFileSync(resolve(ROOT, 'tenant-schema-provisioner.ts'), 'utf8');
  const adminWorkflow = readFileSync(
    resolve(
      ROOT,
      '../../admin-api-service/src/tenant/services/tenant-provisioning-workflow.service.ts',
    ),
    'utf8',
  );

  it('exposes a narrow runtime request function instead of runtime DDL', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS platform.tenant_schema_jobs');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION platform.request_tenant_schema_provisioning');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('REVOKE ALL ON platform.tenant_schema_jobs FROM PUBLIC');
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION platform.request_tenant_schema_provisioning(UUID, UUID, TEXT, JSONB) TO admin_service',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION platform.request_tenant_schema_provisioning(UUID, UUID, TEXT, JSONB) TO auth_service',
    );
    expect(sql).not.toContain('GRANT CREATE ON DATABASE');
  });

  it('prevents duplicate active schema jobs for the same tenant', () => {
    expect(sql).toContain('idx_tenant_schema_jobs_active_tenant');
    expect(sql).toContain("WHERE status IN (\n    'REQUESTED'");
    expect(sql).toContain("'SEEDING_LEDGER'");
  });

  it('claims jobs with a lease and commits admin tenant schema evidence only from db-migrate', () => {
    expect(worker).toContain('FOR UPDATE SKIP LOCKED');
    expect(worker).toContain('lease_token = gen_random_uuid()');
    expect(worker).toContain('CREATE SCHEMA');
    expect(worker).toContain('runSchemaMigrations');
    expect(worker).toContain('applyTenantRlsToSchema');
    expect(worker).toContain('INSERT INTO admin.tenant_schemas');
    expect(worker).toContain("status = 'active'");
  });

  it('exposes db-migrate tenant rollback as the rollback authority', () => {
    const cli = readFileSync(resolve(ROOT, 'cli-args.ts'), 'utf8');
    const main = readFileSync(resolve(ROOT, 'main.ts'), 'utf8');

    expect(cli).toContain("mode?: 'migrate' | 'tenant-schema-provisioner' | 'tenant-schema-rollback'");
    expect(cli).toContain("flag === 'tenant-schema-rollback'");
    expect(cli).toContain("tenantRollbackTarget?: 'all' | 'tenant'");
    expect(main).toContain('tenantRollbackSchemaFromInput');
    expect(main).toContain("status: 'rollback_attempted'");
    expect(main).toContain("status: 'rollback_verified'");
    expect(main).toContain('preflightSourceHeads');
    expect(main).not.toContain("status: 'rollback_complete'");
  });

  it('keeps admin workflow on request/status authority instead of direct schema DDL', () => {
    expect(adminWorkflow).toContain('platform.request_tenant_schema_provisioning');
    expect(adminWorkflow).toContain('assertDbMigrateProvisionedTenantSchema');
    expect(adminWorkflow).not.toContain('CREATE SCHEMA');
    expect(adminWorkflow).not.toContain('DROP SCHEMA');
  });
});
