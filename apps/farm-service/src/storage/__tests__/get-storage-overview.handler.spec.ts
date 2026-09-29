import { createMockDataSource, stub } from '@aquaculture/testing';
import { Role } from '@aquaculture/backend-common/decorators';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';

import { StorageItemType } from '../entities/storage-inventory.entity';
import { GetStorageOverviewQuery } from '../queries/get-storage-overview.query';
import { GetStorageOverviewHandler } from '../handlers/get-storage-overview.handler';
import { LowStockLevel } from '../dto/warehouse-summary.response';
import { LowStockEvaluator } from '../services/low-stock/low-stock-evaluator.service';

describe('GetStorageOverviewHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const caller = { sub: 'u1', roles: [Role.TENANT_ADMIN] };

  /**
   * Flexible query-builder fake. The stats helpers terminate in `getRawOne`.
   * Every intermediate builder method returns `this` so any chain composes.
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

  it('aggregates the overview through the tenant boundary, low stock from the evaluator', async () => {
    // SCENARIO: three category aggregates + one pool reading from the ledger
    // evaluator. EXPECTS: totals as before; the alert row comes from the
    // evaluator (FARM-HIGH-335), with its tier.
    const { mockDataSource, mockManager } = createMockDataSource();
    const qb = makeQb();
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(qb) as typeof mockManager.createQueryBuilder;
    (mockManager.find as jest.Mock).mockResolvedValue([]);
    mockManager.count = jest.fn().mockResolvedValue(7) as typeof mockManager.count;
    const listBelowThreshold = jest.fn().mockResolvedValue([
      {
        level: 'pool',
        itemType: StorageItemType.CHEMICAL,
        itemId: 'chem-1',
        itemName: 'H2O2',
        unit: 'liter',
        onHand: 5,
        onOrder: 0,
        threshold: 20,
        band: 'low_stock',
      },
    ]);

    const handler = new GetStorageOverviewHandler(
      mockDataSource,
      stub<LowStockEvaluator>({ listBelowThreshold }),
      new SiteAuthorizationService(),
    );
    const result = await handler.execute(new GetStorageOverviewQuery(tenantId, caller));

    // Three categories each return itemCount 2 and totalValue 34.5.
    expect(result.totalItems).toBe(6);
    expect(result.totalStockValue).toBeCloseTo(103.5);
    expect(result.recentMovementsCount).toBe(7);
    expect(result.categoryTotals).toHaveLength(3);
    expect(qb.where).toHaveBeenCalledWith('f.tenantId = :tenantId', { tenantId });
    expect(result.lowStockAlertCount).toBe(1);
    expect(result.lowStockAlerts).toEqual([
      {
        itemId: 'chem-1',
        itemName: 'H2O2',
        itemType: StorageItemType.CHEMICAL,
        level: LowStockLevel.POOL,
        siteId: null,
        siteName: null,
        currentQuantity: 5,
        minStock: 20,
        onOrderQuantity: 0,
        unit: 'liter',
      },
    ]);
  });
});
