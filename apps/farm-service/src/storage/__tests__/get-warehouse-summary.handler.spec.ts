import { createMockDataSource, stub } from '@aquaculture/testing';
import { Role } from '@aquaculture/backend-common/decorators';
import { SiteAuthorizationService, type SiteScopeCaller } from '@aquaculture/backend-common/security';

import { MovementType } from '../entities/stock-movement.entity';
import { StorageItemType } from '../entities/storage-inventory.entity';
import { GetWarehouseSummaryQuery } from '../queries/get-warehouse-summary.query';
import { GetWarehouseSummaryHandler } from '../handlers/get-warehouse-summary.handler';
import { LowStockLevel } from '../dto/warehouse-summary.response';
import { LowStockEvaluator } from '../services/low-stock/low-stock-evaluator.service';
import type { DescribedStockReading } from '../services/low-stock/low-stock.types';

describe('GetWarehouseSummaryHandler', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const SITE_A = 'a0000000-0000-4000-8000-00000000000a';
  const SITE_B = 'b0000000-0000-4000-8000-00000000000b';
  const manager: SiteScopeCaller = { sub: 'u1', roles: [Role.MODULE_MANAGER] };
  const worker: SiteScopeCaller = { sub: 'u2', roles: [Role.MODULE_USER], assignedSiteIds: [SITE_A] };

  /** Chainable query-builder fake for the recent-movement list. */
  const makeQb = (rows: unknown[]) => ({
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  });

  const pool: DescribedStockReading = {
    level: 'pool',
    itemType: StorageItemType.FEED,
    itemId: 'feed-1',
    itemName: 'Skretting 3mm',
    unit: 'kg',
    onHand: 300,
    onOrder: 100,
    threshold: 500,
    band: 'low_stock',
  };
  const siteA: DescribedStockReading = {
    level: 'site',
    itemType: StorageItemType.FEED,
    itemId: 'feed-1',
    itemName: 'Skretting 3mm',
    unit: 'kg',
    siteId: SITE_A,
    onHand: 0,
    threshold: 200,
    band: 'out_of_stock',
  };
  const siteB: DescribedStockReading = { ...siteA, siteId: SITE_B, onHand: 50, band: 'low_stock' };

  function build(readings: DescribedStockReading[]): {
    handler: GetWarehouseSummaryHandler;
    mockManager: ReturnType<typeof createMockDataSource>['mockManager'];
    listBelowThreshold: jest.Mock;
  } {
    const { mockDataSource, mockManager } = createMockDataSource();
    mockManager.createQueryBuilder = jest
      .fn()
      .mockReturnValue(
        makeQb([
          { id: 'm1', movementType: MovementType.IN, itemName: 'Pellets', quantity: 5, unit: 'kg', createdAt: new Date() },
        ]),
      ) as typeof mockManager.createQueryBuilder;
    mockManager.count = jest.fn().mockResolvedValue(3) as typeof mockManager.count;
    (mockManager.find as jest.Mock).mockResolvedValue([
      { id: SITE_A, name: 'Site A' },
      { id: SITE_B, name: 'Site B' },
    ]);
    const listBelowThreshold = jest.fn().mockResolvedValue(readings);
    const handler = new GetWarehouseSummaryHandler(
      mockDataSource,
      stub<LowStockEvaluator>({ listBelowThreshold }),
      new SiteAuthorizationService(),
    );
    return { handler, mockManager, listBelowThreshold };
  }

  it('aggregates the warehouse summary through the tenant boundary', async () => {
    // SCENARIO: three catalog counts of 3 + today's movements 3. EXPECTS: KPIs.
    const { handler } = build([]);
    const result = await handler.execute(new GetWarehouseSummaryQuery(tenantId, manager));

    expect(result.totalItems).toBe(9);
    expect(result.todaysMovementCount).toBe(3);
    expect(result.recentMovements.map((m) => m.movementType)).toEqual([MovementType.IN]);
  });

  it('lists low stock from the ledger evaluator, both tiers, with site names (FARM-HIGH-335)', async () => {
    // SCENARIO: pool low + two short sites. EXPECTS: one row per tier, in the
    // evaluator's urgency order, never from the catalog quantity column.
    const { handler, listBelowThreshold } = build([siteA, pool, siteB]);
    const result = await handler.execute(new GetWarehouseSummaryQuery(tenantId, manager));

    expect(listBelowThreshold).toHaveBeenCalledWith(expect.anything(), tenantId);
    expect(result.lowStockAlertCount).toBe(3);
    expect(result.lowStockItems).toEqual([
      {
        id: 'feed-1', name: 'Skretting 3mm', itemType: StorageItemType.FEED, level: LowStockLevel.SITE,
        siteId: SITE_A, siteName: 'Site A', currentQty: 0, minQty: 200, onOrderQty: 0, unit: 'kg',
      },
      {
        id: 'feed-1', name: 'Skretting 3mm', itemType: StorageItemType.FEED, level: LowStockLevel.POOL,
        siteId: null, siteName: null, currentQty: 300, minQty: 500, onOrderQty: 100, unit: 'kg',
      },
      {
        id: 'feed-1', name: 'Skretting 3mm', itemType: StorageItemType.FEED, level: LowStockLevel.SITE,
        siteId: SITE_B, siteName: 'Site B', currentQty: 50, minQty: 200, onOrderQty: 0, unit: 'kg',
      },
    ]);
  });

  it('shows a MODULE_USER only the site rows of their assigned sites (SEC-HIGH-051)', async () => {
    // SCENARIO: worker assigned to Site A only. EXPECTS: pool + Site A, no Site B.
    const { handler } = build([siteA, pool, siteB]);
    const result = await handler.execute(new GetWarehouseSummaryQuery(tenantId, worker));

    expect(result.lowStockItems.map((row) => [row.level, row.siteId])).toEqual([
      [LowStockLevel.SITE, SITE_A],
      [LowStockLevel.POOL, null],
    ]);
    expect(result.lowStockAlertCount).toBe(2);
  });

  it('caps the mobile list at 10 while counting every short tier', async () => {
    // SCENARIO: 12 short pool readings. EXPECTS: count 12, list 10.
    const many = Array.from({ length: 12 }, (_, i) => ({ ...pool, itemId: `feed-${i}` }));
    const { handler } = build(many);
    const result = await handler.execute(new GetWarehouseSummaryQuery(tenantId, manager));

    expect(result.lowStockAlertCount).toBe(12);
    expect(result.lowStockItems).toHaveLength(10);
  });
});
