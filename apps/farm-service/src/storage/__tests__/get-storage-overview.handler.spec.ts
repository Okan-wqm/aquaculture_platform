import { createMockDataSource } from '@aquaculture/testing';

import { GetStorageOverviewQuery } from '../queries/get-storage-overview.query';
import { GetStorageOverviewHandler } from '../handlers/get-storage-overview.handler';

describe('GetStorageOverviewHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  /**
   * Flexible query-builder fake. The stats helpers terminate in
   * `getRawOne`, the low-stock helpers terminate in `getMany`. Every
   * intermediate builder method returns `this` so any chain composes.
   */
  const makeQb = () => ({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getRawOne: jest
      .fn()
      .mockResolvedValue({ totalQuantity: '12', totalValue: '34.5', itemCount: '2' }),
    getMany: jest.fn().mockResolvedValue([]),
  });

  it('aggregates the overview through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb();
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;
    (mockManager.find as jest.Mock).mockResolvedValue([]);
    mockManager.count = jest.fn().mockResolvedValue(7) as typeof mockManager.count;

    const handler = new GetStorageOverviewHandler(mockDataSource);
    const result = await handler.execute(new GetStorageOverviewQuery(tenantId));

    // Three categories each return itemCount 2 and totalValue 34.5.
    expect(result.totalItems).toBe(6);
    expect(result.totalStockValue).toBeCloseTo(103.5);
    expect(result.recentMovementsCount).toBe(7);
    expect(result.categoryTotals).toHaveLength(3);
    expect(qb.where).toHaveBeenCalledWith('f.tenantId = :tenantId', { tenantId });
  });
});
