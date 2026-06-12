import { grantTenantMessagingPartitionAuthority } from '../messaging-partition-privileges';

describe('messaging partition privileges (DATA-HIGH-006)', () => {
  it('grants schema authority and re-owns exactly the messaging partitioned relations', async () => {
    const queries: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const executor = {
      query(sql: string, params?: readonly unknown[]): Promise<unknown> {
        queries.push({ sql, params });
        if (sql.includes('pg_catalog.pg_class')) {
          return Promise.resolve([
            { qualified_name: 'tenant_7f6b08ab90e246d3.messages' },
            { qualified_name: 'tenant_7f6b08ab90e246d3.message_receipts' },
            { qualified_name: '"tenant_7f6b08ab90e246d3"."messages_2026_07"' },
          ]);
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
      reownedRelations: [
        'tenant_7f6b08ab90e246d3.messages',
        'tenant_7f6b08ab90e246d3.message_receipts',
        '"tenant_7f6b08ab90e246d3"."messages_2026_07"',
      ],
    });

    expect(queries[0]?.sql).toBe(
      'GRANT USAGE, CREATE ON SCHEMA "tenant_7f6b08ab90e246d3" TO "messaging_schema_owner"',
    );
    // The relation discovery is parameterized — tenant schema and the
    // relation-name pattern never reach the SQL text as interpolation.
    expect(queries[1]?.params).toEqual([
      'tenant_7f6b08ab90e246d3',
      '^(messages|message_receipts)(_[0-9]{4}_[0-9]{2})?$',
    ]);
    expect(
      queries.slice(2).map((q) => q.sql),
    ).toEqual([
      'ALTER TABLE tenant_7f6b08ab90e246d3.messages OWNER TO "messaging_schema_owner"',
      'ALTER TABLE tenant_7f6b08ab90e246d3.message_receipts OWNER TO "messaging_schema_owner"',
      'ALTER TABLE "tenant_7f6b08ab90e246d3"."messages_2026_07" OWNER TO "messaging_schema_owner"',
    ]);
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
