import { createMockDataSource } from '@aquaculture/testing';

import { ListStorageLocationsQuery } from '../queries/list-storage-locations.query';
import { ListStorageLocationsHandler } from '../handlers/list-storage-locations.handler';

describe('ListStorageLocationsHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const makeQb = (rows: unknown[], count: number) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([rows, count]),
  });

  it('returns paginated storage locations read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([{ id: 'loc1' }], 1);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListStorageLocationsHandler(mockDataSource);
    const result = await handler.execute(
      new ListStorageLocationsQuery(tenantId, { search: 'cold' }),
    );

    expect(result.data).toHaveLength(1);
    expect(result.pagination.total).toBe(1);
    expect(qb.where).toHaveBeenCalledWith('loc.tenantId = :tenantId', { tenantId });
    expect(qb.andWhere).toHaveBeenCalledWith(
      '(loc.name ILIKE :search OR loc.code ILIKE :search)',
      { search: '%cold%' },
    );
  });

  it('falls back to a safe sort field for an unknown sortBy', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([], 0);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new ListStorageLocationsHandler(mockDataSource);
    await handler.execute(
      new ListStorageLocationsQuery(tenantId, undefined, { sortBy: 'evil; DROP', sortOrder: 'ASC' }),
    );

    expect(qb.orderBy).toHaveBeenCalledWith('loc.createdAt', 'ASC');
  });
});
