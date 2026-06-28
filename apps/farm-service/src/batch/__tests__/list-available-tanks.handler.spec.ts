import { createMockDataSource } from '@aquaculture/testing';

import { ListAvailableTanksQuery } from '../queries/list-available-tanks.query';
import { ListAvailableTanksHandler } from '../query-handlers/list-available-tanks.handler';

describe('ListAvailableTanksHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  it('rejects a malformed tenant id before touching the database', async () => {
    const { mockDataSource } = createMockDataSource();
    const handler = new ListAvailableTanksHandler(mockDataSource);

    await expect(
      handler.execute(new ListAvailableTanksQuery('not-a-uuid')),
    ).rejects.toThrow('Invalid tenant ID format');
  });

  it('reads equipment + tanks through the tenant boundary and merges them', async () => {
    const { mockDataSource, mockQueryRunner } = createMockDataSource();
    (mockQueryRunner.query as jest.Mock).mockImplementation((sql: string) => {
      if (sql.includes('FROM equipment')) {
        return Promise.resolve([
          {
            id: 'eq-1',
            name: 'Tank A',
            code: 'TA',
            status: 'operational',
            volume: 100,
            currentBiomass: 0,
            currentCount: 0,
            specifications: { maxBiomass: 50, maxDensity: 30 },
            departmentId: 'd1',
            departmentName: 'D',
            siteId: 's1',
            siteName: 'S',
            category: 'tank',
          },
        ]);
      }
      if (sql.includes('FROM tanks')) {
        return Promise.resolve([
          {
            id: 'tk-1',
            name: 'Pond B',
            code: 'PB',
            status: 'active',
            volume: 200,
            maxBiomass: 80,
            currentBiomass: 10,
            maxDensity: 30,
            currentCount: 0,
            departmentId: 'd1',
            departmentName: 'D',
            siteId: 's1',
            siteName: 'S',
          },
        ]);
      }
      // set_config / SET TRANSACTION / current_schema() readback -> no rows
      return Promise.resolve([]);
    });

    const handler = new ListAvailableTanksHandler(mockDataSource);
    const result = await handler.execute(new ListAvailableTanksQuery(tenantId));

    expect(result.map((t) => t.id).sort()).toEqual(['eq-1', 'tk-1']);
  });

  it('excludes tanks at capacity when excludeFullTanks is set', async () => {
    const { mockDataSource, mockQueryRunner } = createMockDataSource();
    (mockQueryRunner.query as jest.Mock).mockImplementation((sql: string) => {
      if (sql.includes('FROM equipment')) return Promise.resolve([]);
      if (sql.includes('FROM tanks')) {
        return Promise.resolve([
          {
            id: 'full',
            name: 'Full',
            code: 'F',
            status: 'active',
            volume: 100,
            maxBiomass: 50,
            currentBiomass: 50, // availableCapacity = 0 -> excluded
            maxDensity: 30,
            currentCount: 0,
            departmentId: null,
            departmentName: null,
            siteId: null,
            siteName: null,
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const handler = new ListAvailableTanksHandler(mockDataSource);
    const result = await handler.execute(
      new ListAvailableTanksQuery(tenantId, undefined, undefined, true),
    );

    expect(result).toHaveLength(0);
  });
});
