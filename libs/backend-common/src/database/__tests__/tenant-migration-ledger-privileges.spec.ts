import {
  buildTenantMigrationLedgerReadGrant,
  grantTenantMigrationLedgerReadAccess,
  serviceRoleForTenantAwareSchema,
} from '../tenant-migration-ledger-privileges';

describe('tenant migration ledger privileges', () => {
  it('derives the runtime service role from the source schema', () => {
    expect(serviceRoleForTenantAwareSchema('farm')).toBe('farm_service');
    expect(serviceRoleForTenantAwareSchema('event_store')).toBe('event_store_service');
  });

  it('builds the tenant ledger grant contract', () => {
    expect(
      buildTenantMigrationLedgerReadGrant({
        tenantSchema: 'tenant_7f6b08ab90e246d3',
        sourceSchema: 'sensor',
      }),
    ).toEqual({
      tenantSchema: 'tenant_7f6b08ab90e246d3',
      sourceSchema: 'sensor',
      tenantLedger: 'migrations_sensor',
      serviceRole: 'sensor_service',
    });
  });

  it('grants only schema usage and ledger select access', async () => {
    const queries: string[] = [];
    const executor = {
      query(sql: string): Promise<unknown> {
        queries.push(sql);
        return Promise.resolve([]);
      },
    };

    const grant = await grantTenantMigrationLedgerReadAccess(executor, {
      tenantSchema: 'tenant_7f6b08ab90e246d3',
      sourceSchema: 'farm',
    });

    expect(grant).toEqual({
      tenantSchema: 'tenant_7f6b08ab90e246d3',
      sourceSchema: 'farm',
      tenantLedger: 'migrations_farm',
      serviceRole: 'farm_service',
    });
    expect(queries).toEqual([
      'GRANT USAGE ON SCHEMA "tenant_7f6b08ab90e246d3" TO "farm_service"',
      'GRANT SELECT ON TABLE "tenant_7f6b08ab90e246d3"."migrations_farm" TO "farm_service"',
    ]);
    expect(queries.join('\n')).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALL PRIVILEGES)\b/);
  });

  it('rejects unsafe or non-tenant identifiers before SQL is emitted', async () => {
    await expect(
      grantTenantMigrationLedgerReadAccess(
        { query: jest.fn() },
        {
          tenantSchema: 'public',
          sourceSchema: 'farm',
        },
      ),
    ).rejects.toThrow(/non-tenant schema/);

    await expect(
      grantTenantMigrationLedgerReadAccess(
        { query: jest.fn() },
        {
          tenantSchema: 'tenant_7f6b08ab90e246d3',
          sourceSchema: 'farm";drop',
        },
      ),
    ).rejects.toThrow(/Unsafe source schema/);
  });
});
