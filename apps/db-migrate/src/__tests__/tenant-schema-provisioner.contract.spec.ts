import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');

describe('tenant schema provisioner contract', () => {
  const sql = readFileSync(
    resolve(ROOT, 'sql/platform-bootstrap/009-tenant-schema-provisioner.sql'),
    'utf8',
  );
  const leastPrivilegeSql = readFileSync(
    resolve(ROOT, 'sql/platform-bootstrap/008-least-privilege-hardening.sql'),
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

  it('pins search_path on every SECURITY DEFINER function (definer hardening)', () => {
    // A SECURITY DEFINER function without a pinned search_path is the
    // classic privilege-escalation footgun; the pin count must track the
    // definer count exactly. Line-anchored so prose mentions in SQL
    // comments don't inflate either side.
    const definerCount = (sql.match(/^SECURITY DEFINER$/gm) ?? []).length;
    const pinCount = (sql.match(/^SET search_path = pg_catalog, pg_temp$/gm) ?? []).length;
    expect(definerCount).toBeGreaterThan(0);
    expect(pinCount).toBe(definerCount);
  });

  it('exposes only the committed active schema identity needed by FORCE-RLS workers', () => {
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION platform.list_active_tenant_schema_mappings()',
    );
    expect(sql).toContain('FROM admin.tenant_schemas AS ts');
    expect(sql).toContain('FROM pg_catalog.pg_namespace AS namespace');
    expect(sql).toContain('FROM platform.tenant_schema_jobs AS committed_job');
    expect(sql).toContain('AS schema_exists');
    expect(sql).toContain('AS committed_proof');
    expect(sql).toContain("committed_job.status = 'COMMITTED'");
    expect(sql).toContain("committed_job.operation_id::text = ts.metadata->>'operationId'");
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION platform.list_active_tenant_schema_mappings() FROM PUBLIC',
    );
    expect(sql).toContain(
      'ALTER FUNCTION platform.list_active_tenant_schema_mappings() OWNER TO db_migrate',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION platform.list_active_tenant_schema_mappings() TO farm_service',
    );
    expect(sql).toContain('GRANT USAGE, CREATE ON SCHEMA platform TO db_migrate');
    expect(sql).toContain('GRANT USAGE ON SCHEMA platform TO farm_service');
    expect(leastPrivilegeSql).toContain(
      "EXECUTE format('GRANT USAGE ON SCHEMA platform TO %I', service_role)",
    );
    expect(sql).not.toContain('GRANT SELECT ON admin.tenant_schemas TO farm_service');
  });

  it('grants messaging partition authority on every provisioned tenant schema (DATA-HIGH-006)', () => {
    // pg16 requires parent-table OWNERSHIP for PARTITION OF; the fan-out
    // creates clones under the bootstrap connection role, so APPLYING_GRANTS
    // must re-own the messaging relations + grant schema CREATE to
    // messaging_schema_owner — otherwise the first monthly partition for a
    // new tenant fails and the unowned-ceremony-grant class returns.
    expect(worker).toContain('grantTenantMessagingPartitionAuthority');
  });

  it('prevents duplicate active schema jobs for the same tenant', () => {
    expect(sql).toContain('idx_tenant_schema_jobs_active_tenant');
    expect(sql).toContain('idx_tenant_schema_jobs_active_schema');
    expect(sql).toContain("WHERE status IN (\n    'REQUESTED'");
    expect(sql).toContain("'SEEDING_LEDGER'");
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION platform.assert_tenant_schema_identity_available',
    );
    expect(worker).toContain('assertTenantSchemaIdentityAvailable');
    expect(worker).toContain('Tenant schema identity collision');
  });

  it('requires deletion proof only on DELETE requests, not PROVISION requests', () => {
    const provisioningFunction = sql.split(
      'CREATE OR REPLACE FUNCTION platform.request_tenant_schema_deletion',
    )[0];
    const deletionFunction =
      sql.split('CREATE OR REPLACE FUNCTION platform.request_tenant_schema_deletion')[1] ?? '';

    expect(provisioningFunction).not.toContain(
      'Tenant schema deletion requires cleanupProof evidence',
    );
    expect(provisioningFunction).toContain("'PROVISION'");
    expect(deletionFunction).toContain('Tenant schema deletion requires tenant_erasure cleanupProof');
    expect(deletionFunction).not.toContain('tenant_deprovision');
    expect(deletionFunction).toContain('Tenant schema deletion requires cleanupProof evidence');
    expect(deletionFunction).not.toContain('Tenant schema deletion requires encrypted backup evidence');
    expect(deletionFunction).toContain("'DELETE'");
  });

  it('claims jobs with a lease and commits admin tenant schema evidence only from db-migrate', () => {
    expect(worker).toContain('FOR UPDATE SKIP LOCKED');
    expect(worker).toContain('lease_token = gen_random_uuid()');
    expect(worker).toContain('CREATE SCHEMA');
    expect(worker).toContain('runSchemaMigrations');
    expect(worker).toContain('applyTenantRlsToSchema');
    expect(worker).toContain('INSERT INTO admin.tenant_schemas');
    expect(worker).toContain("status = 'active'");
    expect(worker).toContain('commitTenantSchemaEvidence');
    expect(worker).toContain('await queryRunner.startTransaction()');
    expect(worker).toContain('await queryRunner.commitTransaction()');
  });

  it('exposes db-migrate tenant rollback as the rollback authority', () => {
    const cli = readFileSync(resolve(ROOT, 'cli-args.ts'), 'utf8');
    const main = readFileSync(resolve(ROOT, 'main.ts'), 'utf8');

    expect(cli).toContain(
      "mode?: 'migrate' | 'tenant-schema-provisioner' | 'tenant-schema-rollback'",
    );
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
