/**
 * GetWarehouseSummaryHandler
 *
 * CQRS query handler that aggregates warehouse KPI data for the AquaMobil
 * PWA hub page. Returns:
 * - Total distinct inventory items (feeds + chemicals + consumables)
 * - Low-stock tiers (pool + sites) from LowStockEvaluator and their count
 *   (the list capped at 10; the count is the full count)
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

import { FORECAST_STALE_AFTER_MS } from '../../feeding-protocol/services/protocol-feed-forecast.service';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, MoreThanOrEqual } from 'typeorm';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { GetWarehouseSummaryQuery } from '../queries/get-warehouse-summary.query';
import { StockMovement } from '../entities/stock-movement.entity';
import { LowStockEvaluator } from '../services/low-stock/low-stock-evaluator.service';
import { listVisibleLowStock, VisibleLowStockRow } from '../services/low-stock/low-stock-listing';
import { Feed } from '../../feed/entities/feed.entity';
import { Chemical } from '../../chemical/entities/chemical.entity';
import { Consumable } from '../../consumable/entities/consumable.entity';
import { FeedingForecastSnapshot } from '../../feeding-protocol/entities/feeding-forecast-snapshot.entity';
import {
  WarehouseSummaryResponse,
  WarehouseLowStockItem,
  WarehouseRecentMovement,
  WarehouseFeedCoverage,
  WarehouseFeedCoverageStatus,
  LowStockLevel,
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
    // Plan K8 / FARM-HIGH-335: the ONE low-stock decision (ledger, two tiers).
    private readonly lowStockEvaluator: LowStockEvaluator,
    private readonly siteAuth: SiteAuthorizationService,
  ) {}

  async execute(
    query: GetWarehouseSummaryQuery,
  ): Promise<WarehouseSummaryResponse> {
    const { tenantId, caller } = query;

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
        lowStockRows,
        todaysMovementCount,
        recentMovements,
        feedCoverage,
      ] = await Promise.all([
        this.countActiveFeeds(manager, tenantId),
        this.countActiveChemicals(manager, tenantId),
        this.countActiveConsumables(manager, tenantId),
        listVisibleLowStock(this.lowStockEvaluator, this.siteAuth, manager, tenantId, caller),
        this.getTodaysMovementCount(manager, tenantId),
        this.getRecentMovements(manager, tenantId),
        this.getFeedCoverage(manager, tenantId),
      ]);

      // The count is the FULL count of short tiers; only the list is capped.
      // (It used to count three already-capped lists, so it topped out at 30.)
      return {
        totalItems: feedCount + chemicalCount + consumableCount,
        lowStockAlertCount: lowStockRows.length,
        todaysMovementCount,
        lowStockItems: lowStockRows.slice(0, MOBILE_LIST_CAP).map(toWarehouseLowStockItem),
        recentMovements,
        feedCoverage,
      };
    });
  }

  /**
   * Feed başına stok-kapsama (Faz 7, P-27): materyalize forecast
   * snapshot'ının ucuz okuması — sorgu anında yeniden hesap YOK (K-10).
   *
   * YALNIZ otorite (`poolScope = 'TENANT'`) satırı okunur (W6,
   * FARM-HIGH-249). Eski hâl tüm kapsamların EN KÖTÜSÜNÜ alıyordu: havuzda
   * 40 günlük yem varken deposu küçük bir sitenin satırı yüzünden mobil
   * "2 gün kaldı" diyordu — aynı fiziksel kg iki kapsamda taahhüt
   * edildiğinden bu sayı fiziksel gerçeğe karşılık gelmiyordu.
   * İlk 07:00 süpürmesinden önce snapshot yoksa boş liste döner.
   * Eşik SSoT'si event'in yanındaki FEED_STOCKOUT_CRITICAL_DAYS sabitidir —
   * alert-engine incident önemiyle YAPISAL hizalı (kod-ikizi eşik yok).
   */
  private async getFeedCoverage(
    manager: EntityManager,
    tenantId: string,
  ): Promise<WarehouseFeedCoverage[]> {
    const snapshot = await manager.findOne(FeedingForecastSnapshot, {
      where: { tenantId, poolScope: 'TENANT' },
    });
    if (!snapshot) return [];
    const stale = Date.now() - snapshot.computedAt.getTime() > FORECAST_STALE_AFTER_MS;
    const worstByFeed = new Map<string, WarehouseFeedCoverage>();
    for (const feed of snapshot.perFeed) {
      const status: WarehouseFeedCoverageStatus =
        feed.daysOfCover === null
          ? WarehouseFeedCoverageStatus.OK
          : feed.daysOfCover <= FEED_STOCKOUT_CRITICAL_DAYS
            ? WarehouseFeedCoverageStatus.CRITICAL
            : feed.daysOfCover <= feed.procurementLeadTimeDays
              ? WarehouseFeedCoverageStatus.WARNING
              : WarehouseFeedCoverageStatus.OK;
      const candidate: WarehouseFeedCoverage = {
        feedId: feed.feedId,
        feedCode: feed.feedCode,
        feedName: feed.feedName,
        daysOfCover: feed.daysOfCover,
        stockoutDate: feed.stockoutDate,
        coverageStatus: status,
        stale,
      };
      worstByFeed.set(feed.feedId, candidate);
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

/** Evaluator reading → mobile row (the reading carries the catalog label). */
function toWarehouseLowStockItem({ reading, siteName }: VisibleLowStockRow): WarehouseLowStockItem {
  return {
    id: reading.itemId,
    name: reading.itemName,
    itemType: reading.itemType,
    level: reading.level === 'site' ? LowStockLevel.SITE : LowStockLevel.POOL,
    siteId: reading.level === 'site' ? reading.siteId : null,
    siteName,
    currentQty: reading.onHand,
    minQty: reading.threshold,
    onOrderQty: reading.level === 'pool' ? reading.onOrder : 0,
    unit: reading.unit,
  };
}
