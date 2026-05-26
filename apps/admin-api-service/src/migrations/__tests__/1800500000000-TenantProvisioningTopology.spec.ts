import { applyTenantRlsToSchema } from '@aquaculture/backend-common/database';
import { QueryRunner } from 'typeorm';

import { TenantProvisioningTopology1800500000000 } from '../1800500000000-TenantProvisioningTopology';

jest.mock('@aquaculture/backend-common/database', () => ({
  applyTenantRlsToSchema: jest.fn(),
}));

type QueryMock = jest.Mock<Promise<unknown>, [string, unknown[]?]>;

function createQueryRunner(responses: readonly unknown[]): {
  query: QueryMock;
  queryRunner: QueryRunner;
} {
  const queue = [...responses];
  const query: QueryMock = jest.fn((_: string, __?: unknown[]) =>
    Promise.resolve(queue.shift() ?? []),
  );

  return {
    query,
    queryRunner: { query } as unknown as QueryRunner,
  };
}

describe('TenantProvisioningTopology1800500000000', () => {
  const migration = new TenantProvisioningTopology1800500000000();
  const mockedApplyTenantRlsToSchema = jest.mocked(applyTenantRlsToSchema);

  beforeEach(() => {
    mockedApplyTenantRlsToSchema.mockReset();
    mockedApplyTenantRlsToSchema.mockResolvedValue(undefined);
  });

  it('delegates tenant topology RLS to the shared columnstore-aware helper', async () => {
    const { query, queryRunner } = createQueryRunner([
      [],
      [{ schema_name: 'tenant_7f6b08ab90e246d3' }],
      [{ table_name: 'farm_batches' }, { table_name: 'sensor_readings' }],
      [],
    ]);

    await migration.up(queryRunner);

    const topologySql = query.mock.calls[0]?.[0] ?? '';
    expect(topologySql).not.toContain('ENABLE ROW LEVEL SECURITY');
    expect(topologySql).not.toContain('CREATE POLICY tenant_isolation_policy');
    expect(mockedApplyTenantRlsToSchema).toHaveBeenCalledTimes(1);
    expect(mockedApplyTenantRlsToSchema).toHaveBeenCalledWith(queryRunner, {
      schemaOverride: 'tenant_7f6b08ab90e246d3',
      includeTables: ['farm_batches', 'sensor_readings'],
      tenantIdColumns: ['tenantId', 'tenant_id'],
    });
  });

  it('rejects untrusted tenant schema names before applying RLS', async () => {
    const { queryRunner } = createQueryRunner([
      [],
      [{ schema_name: 'public' }],
      [{ table_name: 'farm_batches' }],
    ]);

    await expect(migration.up(queryRunner)).rejects.toThrow(
      'Unsafe tenant schema name discovered during admin topology migration',
    );
    expect(mockedApplyTenantRlsToSchema).not.toHaveBeenCalled();
  });

  it('fails closed when no topology source tables are discoverable', async () => {
    const { queryRunner } = createQueryRunner([
      [],
      [{ schema_name: 'tenant_7f6b08ab90e246d3' }],
      [],
    ]);

    await expect(migration.up(queryRunner)).rejects.toThrow(
      'Admin tenant topology migration discovered no source tables',
    );
    expect(mockedApplyTenantRlsToSchema).not.toHaveBeenCalled();
  });
});
