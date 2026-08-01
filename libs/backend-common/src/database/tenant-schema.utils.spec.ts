import { DataSource } from 'typeorm';

import { listActiveTenantSchemaIdentities, type TenantSchemaIdentity } from './tenant-schema.utils';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SCHEMA_NAME = 'tenant_aaaaaaaaaaaa4aaa';

function dataSourceReturning(rows: unknown[]): DataSource {
  const dataSource = new DataSource({
    type: 'postgres',
    database: 'tenant-schema-unit-test',
    entities: [],
  });
  jest.spyOn(dataSource, 'query').mockResolvedValue(rows);
  return dataSource;
}

describe('listActiveTenantSchemaIdentities', () => {
  it('reads the db-migrate commit ledger through the narrow platform function', async () => {
    const dataSource = dataSourceReturning([
      {
        schema_name: SCHEMA_NAME,
        tenant_id: TENANT_ID.toUpperCase(),
        schema_exists: true,
        committed_proof: true,
      },
    ]);

    await expect(listActiveTenantSchemaIdentities(dataSource)).resolves.toEqual<
      TenantSchemaIdentity[]
    >([{ schemaName: SCHEMA_NAME, tenantId: TENANT_ID }]);
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('platform.list_active_tenant_schema_mappings()'),
    );
  });

  it('fails closed when the full tenant UUID does not derive the ledger schema', async () => {
    const dataSource = dataSourceReturning([
      {
        schema_name: SCHEMA_NAME,
        tenant_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        schema_exists: true,
        committed_proof: true,
      },
    ]);

    await expect(listActiveTenantSchemaIdentities(dataSource)).rejects.toThrow(/mapping mismatch/u);
  });

  it('fails closed on duplicate active schema mappings', async () => {
    const dataSource = dataSourceReturning([
      {
        schema_name: SCHEMA_NAME,
        tenant_id: TENANT_ID,
        schema_exists: true,
        committed_proof: true,
      },
      {
        schema_name: SCHEMA_NAME,
        tenant_id: TENANT_ID,
        schema_exists: true,
        committed_proof: true,
      },
    ]);

    await expect(listActiveTenantSchemaIdentities(dataSource)).rejects.toThrow(
      /duplicate active mapping/u,
    );
  });
});
