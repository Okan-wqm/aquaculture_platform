import { createMockDataSource } from '@aquaculture/testing';

import { MovementType } from '../entities/stock-movement.entity';
import { StorageItemType } from '../entities/storage-inventory.entity';
import { GetWarehouseSummaryQuery } from '../queries/get-warehouse-summary.query';
import { GetWarehouseSummaryHandler } from '../handlers/get-warehouse-summary.handler';

describe('GetWarehouseSummaryHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  /**
   * Flexible query-builder fake. The low-stock and recent-movement
   * helpers terminate in `getMany`; every chain method returns `this`.
   */
  const makeQb = (rows: unknown[]) => ({
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  });

  it('aggregates the warehouse summary through the tenant boundary', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb([
      { id: 'm1', movementType: MovementType.IN, itemName: 'Pellets', quantity: 5, unit: 'kg', createdAt: new Date() },
    ]);
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;
    mockManager.count = jest.fn().mockResolvedValue(3) as typeof mockManager.count;

    const handler = new GetWarehouseSummaryHandler(mockDataSource);
    const result = await handler.execute(new GetWarehouseSummaryQuery(tenantId));

    // countActiveItems is called for feed + chemical + consumable (each 3),
    // plus getTodaysMovementCount (3).
    expect(result.totalItems).toBe(9);
    expect(result.todaysMovementCount).toBe(3);
    expect(result.recentMovements.map((m) => m.movementType)).toEqual([MovementType.IN]);
    expect(qb.where).toHaveBeenCalledWith('f.tenantId = :tenantId', { tenantId });
  });

  it('labels every low-stock row with the StorageItemType enum member (FARM-HIGH-319)', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    const lowStockRow = { id: 'i1', name: 'Item', quantity: 1, minStock: 5, unit: 'kg' };
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(makeQb([lowStockRow])) as typeof mockManager.createQueryBuilder;
    mockManager.count = jest.fn().mockResolvedValue(0) as typeof mockManager.count;

    const result = await new GetWarehouseSummaryHandler(mockDataSource).execute(
      new GetWarehouseSummaryQuery(tenantId),
    );

    expect(result.lowStockItems.map((item) => item.itemType)).toEqual([
      StorageItemType.FEED,
      StorageItemType.CHEMICAL,
      StorageItemType.CONSUMABLE,
    ]);
  });
});
