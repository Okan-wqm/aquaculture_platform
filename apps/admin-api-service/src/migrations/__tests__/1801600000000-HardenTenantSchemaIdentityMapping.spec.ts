import { HardenTenantSchemaIdentityMapping1801600000000 } from '../1801600000000-HardenTenantSchemaIdentityMapping';

describe('HardenTenantSchemaIdentityMapping1801600000000', () => {
  it('makes schema identity unique, deterministic, and readable only by db-migrate', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new HardenTenantSchemaIdentityMapping1801600000000();

    await migration.up({ query });

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('UQ_admin_tenant_schemas_schema_name');
    expect(sql).toContain('CHK_admin_tenant_schema_identity');
    expect(sql).toContain(`'tenant_' || LEFT(REPLACE("tenantId"::text, '-', ''), 16)`);
    expect(sql).toContain('GRANT SELECT ON TABLE "admin"."tenant_schemas" TO "db_migrate"');
    expect(sql).not.toContain('TO "farm_service"');
  });

  it('reverses the narrow grant and identity constraints', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new HardenTenantSchemaIdentityMapping1801600000000();

    await migration.down({ query });

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('REVOKE SELECT ON TABLE "admin"."tenant_schemas" FROM "db_migrate"');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS "CHK_admin_tenant_schema_identity"');
    expect(sql).toContain('DROP INDEX IF EXISTS "admin"."UQ_admin_tenant_schemas_schema_name"');
  });
});
