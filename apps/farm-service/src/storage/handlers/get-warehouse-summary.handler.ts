/**
 * GetWarehouseSummaryHandler
 *
 * CQRS query handler that aggregates warehouse KPI data for the AquaMobil
 * PWA hub page. Returns:
 * - Total distinct inventory items (feeds + chemicals + consumables)
 * - Low-stock alert count and the items themselves (capped at 10)
 * - Today's stock movement count and recent movements (capped at 10)
 *
 * Architectural decisions:
 * 1. Runs all DB queries in parallel (Promise.all) to minimize latency
 *    on mobile networks.
 * 2. Filters by tenantId in every query for multi-tenant isolation.
 * 3. Caps list results at 10 to keep the mobile payload under 5KB.
 * 4. Uses raw counts instead of loading full entities where possible
 *    to reduce memory pressure on the backend.
 *
 * Security: tenantId comes from JWT via @CurrentTenant() decorator,
 * never from client-supplied GraphQL variables. Reads run through the
 * fail-closed tenant boundary, which pins and asserts the tenant schema
 * before any domain query executes.
 */
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { FEED_STOCKOUT_CRITICAL_DAYS } from '@platform/event-contracts';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, MoreThanOrEqual } from 'typeorm';
import { GetWarehouseSummaryQuery } from '../queries/get-warehouse-summary.query';
import { StockMovement } from '../entities/stock-movement.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { Chemical } from '../../chemical/entities/chemical.entity';
import { Consumable } from '../../consumable/entities/consumable.entity';
import { FeedingForecastSnapshot } from '../../feeding-protocol/entities/feeding-forecast-snapshot.entity';
import {
  WarehouseSummaryResponse,
  WarehouseLowStockItem,
  WarehouseRecentMovement,
  WarehouseFeedCoverage,
} from '../dto/warehouse-summary.response';

/** Maximum number of low-stock items and recent movements to return. */
const MOBILE_LIST_CAP = 10;

@QueryHandler(GetWarehouseSummaryQuery)
export class GetWarehouseSummaryHandler
  implements IQueryHandler<GetWarehouseSummaryQuery>
{
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async execute(
    query: GetWarehouseSummaryQuery,
  ): Promise<WarehouseSummaryResponse> {
    const { tenantId } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;

      /**
       * Run all aggregation queries in parallel to minimize total latency.
       * Each sub-query is tenant-scoped and uses indexed columns.
       */
      const [
        feedCount,
        chemicalCount,
        consumableCount,
        lowStockFeeds,
        lowStockChemicals,
        lowStockConsumables,
        todaysMovementCount,
        recentMovements,
        feedCoverage,
      ] = await Promise.all([
        this.countActiveFeeds(manager, tenantId),
        this.countActiveChemicals(manager, tenantId),
        this.countActiveConsumables(manager, tenantId),
        this.getLowStockFeeds(manager, tenantId),
        this.getLowStockChemicals(manager, tenantId),
        this.getLowStockConsumables(manager, tenantId),
        this.getTodaysMovementCount(manager, tenantId),
        this.getRecentMovements(manager, tenantId),
        this.getFeedCoverage(manager, tenantId),
      ]);

      const allLowStockItems: WarehouseLowStockItem[] = [
        ...lowStockFeeds,
        ...lowStockChemicals,
        ...lowStockConsumables,
      ];

      return {
        totalItems: feedCount + chemicalCount + consumableCount,
        lowStockAlertCount: allLowStockItems.length,
        todaysMovementCount,
        lowStockItems: allLowStockItems.slice(0, MOBILE_LIST_CAP),
        recentMovements,
        feedCoverage,
      };
    });
  }

  /**
   * Feed başına stok-kapsama (Faz 7, P-27): materyalize forecast
   * snapshot'ının ucuz okuması — sorgu anında yeniden hesap YOK (K-10).
   * Çok kapsamlı tenant'ta (site + tenant-fallback) EN KÖTÜ kapsam kazanır;
   * ilk 07:00 süpürmesinden önce snapshot yoksa boş liste döner.
   * Eşik SSoT'si event'in yanındaki FEED_STOCKOUT_CRITICAL_DAYS sabitidir —
   * alert-engine incident önemiyle YAPISAL hizalı (kod-ikizi eşik yok).
   */
  private async getFeedCoverage(
    manager: EntityManager,
    tenantId: string,
  ): Promise<WarehouseFeedCoverage[]> {
    const snapshots = await manager.find(FeedingForecastSnapshot, {
      where: { tenantId },
    });
    const worstByFeed = new Map<string, WarehouseFeedCoverage>();
    for (const snapshot of snapshots) {
      for (const feed of snapshot.perFeed) {
        const status =
          feed.daysOfCover === null
            ? 'ok'
            : feed.daysOfCover <= FEED_STOCKOUT_CRITICAL_DAYS
              ? 'critical'
              : feed.daysOfCover <= feed.procurementLeadTimeDays
                ? 'warning'
                : 'ok';
        const candidate: WarehouseFeedCoverage = {
          feedId: feed.feedId,
          feedCode: feed.feedCode,
          feedName: feed.feedName,
          daysOfCover: feed.daysOfCover,
          stockoutDate: feed.stockoutDate,
          coverageStatus: status,
        };
        const existing = worstByFeed.get(feed.feedId);
        const existingDays = existing?.daysOfCover ?? Number.POSITIVE_INFINITY;
        const candidateDays = feed.daysOfCover ?? Number.POSITIVE_INFINITY;
        if (!existing || candidateDays < existingDays) {
          worstByFeed.set(feed.feedId, candidate);
        }
      }
    }
    return [...worstByFeed.values()]
      .sort(
        (a, b) =>
          (a.daysOfCover ?? Number.POSITIVE_INFINITY) -
          (b.daysOfCover ?? Number.POSITIVE_INFINITY),
      )
      .slice(0, MOBILE_LIST_CAP);
  }

  /**
   * Count active, non-deleted feeds. Uses COUNT(*) to avoid loading
   * entity data into memory.
   */
  private async countActiveFeeds(
    manager: EntityManager,
    tenantId: string,
  ): Promise<number> {
    return manager.count(Feed, {
      where: { tenantId, isDeleted: false, isActive: true },
    });
  }

  /** Count active, non-deleted chemicals. */
  private async countActiveChemicals(
    manager: EntityManager,
    tenantId: string,
  ): Promise<number> {
    return manager.count(Chemical, {
      where: { tenantId, isDeleted: false, isActive: true },
    });
  }

  /** Count active, non-deleted consumables. */
  private async countActiveConsumables(
    manager: EntityManager,
    tenantId: string,
  ): Promise<number> {
    return manager.count(Consumable, {
      where: { tenantId, isDeleted: false, isActive: true },
    });
  }

  /**
   * Find feeds where current quantity is at or below minimum stock.
   * Returns at most MOBILE_LIST_CAP items sorted by urgency (lowest ratio first).
   */
  private async getLowStockFeeds(
    manager: EntityManager,
    tenantId: string,
  ): Promise<WarehouseLowStockItem[]> {
    const feeds = await manager
      .createQueryBuilder(Feed, 'f')
      .select(['f.id', 'f.name', 'f.quantity', 'f.minStock', 'f.unit'])
      .where('f.tenantId = :tenantId', { tenantId })
      .andWhere('f.isDeleted = false')
      .andWhere('f.isActive = true')
      .andWhere('f.quantity <= f.minStock')
      .andWhere('f.minStock > 0')
      .orderBy('f.quantity / NULLIF(f.minStock, 0)', 'ASC')
      .limit(MOBILE_LIST_CAP)
      .getMany();

    return feeds.map((f) => ({
      id: f.id,
      name: f.name,
      itemType: 'feed',
      currentQty: Number(f.quantity),
      minQty: Number(f.minStock),
      unit: f.unit,
    }));
  }

  /**
   * Find chemicals where current quantity is at or below minimum stock.
   */
  private async getLowStockChemicals(
    manager: EntityManager,
    tenantId: string,
  ): Promise<WarehouseLowStockItem[]> {
    const chemicals = await manager
      .createQueryBuilder(Chemical, 'c')
      .select(['c.id', 'c.name', 'c.quantity', 'c.minStock', 'c.unit'])
      .where('c.tenantId = :tenantId', { tenantId })
      .andWhere('c.isDeleted = false')
      .andWhere('c.isActive = true')
      .andWhere('c.quantity <= c.minStock')
      .andWhere('c.minStock > 0')
      .orderBy('c.quantity / NULLIF(c.minStock, 0)', 'ASC')
      .limit(MOBILE_LIST_CAP)
      .getMany();

    return chemicals.map((c) => ({
      id: c.id,
      name: c.name,
      itemType: 'chemical',
      currentQty: Number(c.quantity),
      minQty: Number(c.minStock),
      unit: c.unit,
    }));
  }

  /**
   * Find consumables where current quantity is at or below minimum stock.
   */
  private async getLowStockConsumables(
    manager: EntityManager,
    tenantId: string,
  ): Promise<WarehouseLowStockItem[]> {
    const consumables = await manager
      .createQueryBuilder(Consumable, 'c')
      .select(['c.id', 'c.name', 'c.quantity', 'c.minStock', 'c.unit'])
      .where('c.tenantId = :tenantId', { tenantId })
      .andWhere('c.isDeleted = false')
      .andWhere('c.isActive = true')
      .andWhere('c.quantity <= c.minStock')
      .andWhere('c.minStock > 0')
      .orderBy('c.quantity / NULLIF(c.minStock, 0)', 'ASC')
      .limit(MOBILE_LIST_CAP)
      .getMany();

    return consumables.map((c) => ({
      id: c.id,
      name: c.name,
      itemType: 'consumable',
      currentQty: Number(c.quantity),
      minQty: Number(c.minStock),
      unit: c.unit,
    }));
  }

  /**
   * Count stock movements performed today (since midnight UTC).
   * Uses performedAt rather than createdAt because a movement can
   * be back-dated when recording yesterday's activity.
   */
  private async getTodaysMovementCount(
    manager: EntityManager,
    tenantId: string,
  ): Promise<number> {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    return manager.count(StockMovement, {
      where: {
        tenantId,
        performedAt: MoreThanOrEqual(todayStart),
      },
    });
  }

  /**
   * Fetch the 10 most recent stock movements for the activity feed.
   * Only loads the fields needed by the mobile UI to minimize payload.
   */
  private async getRecentMovements(
    manager: EntityManager,
    tenantId: string,
  ): Promise<WarehouseRecentMovement[]> {
    const movements = await manager
      .createQueryBuilder(StockMovement, 'm')
      .select([
        'm.id',
        'm.movementType',
        'm.itemName',
        'm.quantity',
        'm.unit',
        'm.createdAt',
      ])
      .where('m.tenantId = :tenantId', { tenantId })
      .orderBy('m.createdAt', 'DESC')
      .limit(MOBILE_LIST_CAP)
      .getMany();

    return movements.map((m) => ({
      id: m.id,
      movementType: m.movementType,
      itemName: m.itemName,
      quantity: Number(m.quantity),
      unit: m.unit,
      createdAt: m.createdAt,
    }));
  }
}
