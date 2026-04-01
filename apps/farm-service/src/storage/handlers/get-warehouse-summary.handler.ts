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
 * never from client-supplied GraphQL variables.
 */
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import { GetWarehouseSummaryQuery } from '../queries/get-warehouse-summary.query';
import { StockMovement } from '../entities/stock-movement.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { Chemical } from '../../chemical/entities/chemical.entity';
import { Consumable } from '../../consumable/entities/consumable.entity';
import {
  WarehouseSummaryResponse,
  WarehouseLowStockItem,
  WarehouseRecentMovement,
} from '../dto/warehouse-summary.response';

/** Maximum number of low-stock items and recent movements to return. */
const MOBILE_LIST_CAP = 10;

@QueryHandler(GetWarehouseSummaryQuery)
export class GetWarehouseSummaryHandler
  implements IQueryHandler<GetWarehouseSummaryQuery>
{
  constructor(
    @InjectRepository(StockMovement)
    private readonly movementRepo: Repository<StockMovement>,
    @InjectRepository(Feed)
    private readonly feedRepo: Repository<Feed>,
    @InjectRepository(Chemical)
    private readonly chemicalRepo: Repository<Chemical>,
    @InjectRepository(Consumable)
    private readonly consumableRepo: Repository<Consumable>,
  ) {}

  async execute(
    query: GetWarehouseSummaryQuery,
  ): Promise<WarehouseSummaryResponse> {
    const { tenantId } = query;

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
    ] = await Promise.all([
      this.countActiveItems(this.feedRepo, tenantId),
      this.countActiveItems(this.chemicalRepo, tenantId),
      this.countActiveItems(this.consumableRepo, tenantId),
      this.getLowStockFeeds(tenantId),
      this.getLowStockChemicals(tenantId),
      this.getLowStockConsumables(tenantId),
      this.getTodaysMovementCount(tenantId),
      this.getRecentMovements(tenantId),
    ]);

    const lowStockItems: WarehouseLowStockItem[] = [
      ...lowStockFeeds,
      ...lowStockChemicals,
      ...lowStockConsumables,
    ].slice(0, MOBILE_LIST_CAP);

    return {
      totalItems: feedCount + chemicalCount + consumableCount,
      lowStockAlertCount: lowStockItems.length,
      todaysMovementCount,
      lowStockItems,
      recentMovements,
    };
  }

  /**
   * Count active, non-deleted items for a given entity type.
   * Uses COUNT(*) to avoid loading entity data into memory.
   */
  private async countActiveItems(
    repo: Repository<Feed> | Repository<Chemical> | Repository<Consumable>,
    tenantId: string,
  ): Promise<number> {
    return (repo as Repository<{ tenantId: string; isDeleted: boolean; isActive: boolean }>).count({
      where: { tenantId, isDeleted: false, isActive: true },
    });
  }

  /**
   * Find feeds where current quantity is at or below minimum stock.
   * Returns at most MOBILE_LIST_CAP items sorted by urgency (lowest ratio first).
   */
  private async getLowStockFeeds(
    tenantId: string,
  ): Promise<WarehouseLowStockItem[]> {
    const feeds = await this.feedRepo
      .createQueryBuilder('f')
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
    tenantId: string,
  ): Promise<WarehouseLowStockItem[]> {
    const chemicals = await this.chemicalRepo
      .createQueryBuilder('c')
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
    tenantId: string,
  ): Promise<WarehouseLowStockItem[]> {
    const consumables = await this.consumableRepo
      .createQueryBuilder('c')
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
  private async getTodaysMovementCount(tenantId: string): Promise<number> {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    return this.movementRepo.count({
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
    tenantId: string,
  ): Promise<WarehouseRecentMovement[]> {
    const movements = await this.movementRepo
      .createQueryBuilder('m')
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
