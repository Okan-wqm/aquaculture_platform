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
      runtimeRole: 'messaging_service',
      reownedRelations: [
        'tenant_7f6b08ab90e246d3.messages',
        'tenant_7f6b08ab90e246d3.message_receipts',
        '"tenant_7f6b08ab90e246d3"."messages_2026_07"',
      ],
      runtimeGrantedRelations: [
        'tenant_7f6b08ab90e246d3.messages',
        'tenant_7f6b08ab90e246d3.message_receipts',
        '"tenant_7f6b08ab90e246d3"."messages_2026_07"',
      ],
    });

    expect(queries[0]?.sql).toBe(
      'GRANT USAGE, CREATE ON SCHEMA "tenant_7f6b08ab90e246d3" TO "messaging_schema_owner"',
    );
    // Forward cover for future partition children created by the definer role.
    expect(queries[1]?.sql).toBe(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "messaging_schema_owner" ' +
        'IN SCHEMA "tenant_7f6b08ab90e246d3" ' +
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "messaging_service"',
    );
    // The relation discovery is parameterized — tenant schema and the
    // relation-name pattern never reach the SQL text as interpolation.
    expect(queries[2]?.params).toEqual([
      'tenant_7f6b08ab90e246d3',
      '^(messages|message_receipts)(_[0-9]{4}_[0-9]{2})?$',
    ]);
    // Each relation is re-owned to the definer AND explicitly re-granted DML to
    // the runtime role (default privileges are forward-only, so parents +
    // existing children need the explicit backfill grant).
    expect(queries.slice(3).map((q) => q.sql)).toEqual([
      'ALTER TABLE tenant_7f6b08ab90e246d3.messages OWNER TO "messaging_schema_owner"',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tenant_7f6b08ab90e246d3.messages TO "messaging_service"',
      'ALTER TABLE tenant_7f6b08ab90e246d3.message_receipts OWNER TO "messaging_schema_owner"',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tenant_7f6b08ab90e246d3.message_receipts TO "messaging_service"',
      'ALTER TABLE "tenant_7f6b08ab90e246d3"."messages_2026_07" OWNER TO "messaging_schema_owner"',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "tenant_7f6b08ab90e246d3"."messages_2026_07" TO "messaging_service"',
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
