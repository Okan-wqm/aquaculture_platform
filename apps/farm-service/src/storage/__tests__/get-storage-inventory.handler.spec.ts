import { createMockDataSource } from '@aquaculture/testing';

import { GetStorageInventoryQuery } from '../queries/get-storage-inventory.query';
import { GetStorageInventoryHandler } from '../handlers/get-storage-inventory.handler';

describe('GetStorageInventoryHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const makeQb = (rows: unknown[]) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  });

  it('returns inventory rows read through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([{ id: 'inv1' }]);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new GetStorageInventoryHandler(mockDataSource);
    const result = await handler.execute(
      new GetStorageInventoryQuery(tenantId, 'loc-1', 'feed', 50, 10),
    );

    expect(result).toEqual([{ id: 'inv1' }]);
    expect(qb.where).toHaveBeenCalledWith('inv.tenantId = :tenantId', { tenantId });
    expect(qb.andWhere).toHaveBeenCalledWith('inv.storageLocationId = :locationId', {
      locationId: 'loc-1',
    });
    expect(qb.andWhere).toHaveBeenCalledWith('inv.itemType = :itemType', { itemType: 'feed' });
    expect(qb.take).toHaveBeenCalledWith(50);
    expect(qb.skip).toHaveBeenCalledWith(10);
  });

  it('caps the page size at the maximum limit', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([]);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;

    const handler = new GetStorageInventoryHandler(mockDataSource);
    await handler.execute(new GetStorageInventoryQuery(tenantId, undefined, undefined, 10_000));

    expect(qb.take).toHaveBeenCalledWith(500);
  });
});
