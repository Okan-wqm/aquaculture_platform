import { grantTenantMessagingPartitionAuthority } from '../messaging-partition-privileges';

describe('messaging partition privileges (DATA-HIGH-006)', () => {
  it('delegates the complete recipe to the SSoT SQL function and returns its relations', async () => {
    const queries: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const relations = [
      'tenant_7f6b08ab90e246d3.messages',
      'tenant_7f6b08ab90e246d3.message_receipts',
      '"tenant_7f6b08ab90e246d3"."messages_2026_07"',
    ];
    const executor = {
      query(sql: string, params?: readonly unknown[]): Promise<unknown> {
        queries.push({ sql, params });
        if (sql.includes('grant_messaging_partition_authority')) {
          return Promise.resolve([{ relations }]);
        }
        return Promise.resolve([]);
      },
    };

    const grant = await grantTenantMessagingPartitionAuthority(executor, {
      tenantSchema: 'tenant_7f6b08ab90e246d3',
    });

    expect(grant).toEqual({
      tenantSchema: 'tenant_7f6b08ab90e246d3',
      ownerRole: 'messaging_schema_owner',
      runtimeRole: 'messaging_service',
      reownedRelations: relations,
      runtimeGrantedRelations: relations,
    });

    // The recipe (re-own + runtime DML grant + default-privilege forward cover)
    // lives ONLY in platform.grant_messaging_partition_authority — the helper
    // emits exactly ONE call to it, never a hand-mirrored GRANT/ALTER sequence
    // that could drift from the Stage 010 backfill.
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toBe(
      'SELECT platform.grant_messaging_partition_authority($1) AS relations',
    );
    expect(queries[0]?.params).toEqual(['tenant_7f6b08ab90e246d3']);
  });

  it('refuses non-tenant schemas before SQL is emitted', async () => {
    await expect(
      grantTenantMessagingPartitionAuthority(
        { query: jest.fn() },
        { tenantSchema: 'messaging' },
      ),
    ).rejects.toThrow(/non-tenant schema/);
    await expect(
      grantTenantMessagingPartitionAuthority(
        { query: jest.fn() },
        { tenantSchema: 'tenant_x"; DROP SCHEMA auth' },
      ),
    ).rejects.toThrow(/non-tenant schema/);
  });
});
