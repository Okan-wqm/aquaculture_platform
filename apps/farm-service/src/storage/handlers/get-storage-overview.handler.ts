import { numberOrUndefined, runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, MoreThanOrEqual } from 'typeorm';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { GetStorageOverviewQuery } from '../queries/get-storage-overview.query';
import { LowStockEvaluator } from '../services/low-stock/low-stock-evaluator.service';
import { listVisibleLowStock, VisibleLowStockRow } from '../services/low-stock/low-stock-listing';
import { LowStockLevel } from '../dto/warehouse-summary.response';
import { StorageLocation } from '../entities/storage-location.entity';
import { StockMovement } from '../entities/stock-movement.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { Chemical } from '../../chemical/entities/chemical.entity';
import { Consumable } from '../../consumable/entities/consumable.entity';
import {
  StorageOverviewResponse,
  CategoryTotal,
  LocationFillRate,
  LowStockAlert,
} from '../dto/storage-overview.response';

/** Shape of the raw aggregate row returned by the category stats query. */
interface CategoryStatsRaw {
  totalQuantity: string | null;
  totalValue: string | null;
  itemCount: string | null;
}

/** Aggregated totals for a single inventory category. */
interface CategoryStats {
  totalQuantity: number;
  totalValue: number;
  itemCount: number;
}

@QueryHandler(GetStorageOverviewQuery)
export class GetStorageOverviewHandler implements IQueryHandler<GetStorageOverviewQuery> {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    // Plan K8 / FARM-HIGH-335: the ONE low-stock decision (ledger, two tiers).
    private readonly lowStockEvaluator: LowStockEvaluator,
    private readonly siteAuth: SiteAuthorizationService,
  ) {}

  async execute(query: GetStorageOverviewQuery): Promise<StorageOverviewResponse> {
    const { tenantId, caller } = query;

    // Read through the fail-closed tenant boundary.
    return runInTenantRead(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;

      // Run aggregations in parallel
      const [
        feedStats,
        chemicalStats,
        consumableStats,
        locationFillRates,
        recentMovementsCount,
        lowStockRows,
      ] = await Promise.all([
        this.getFeedStats(manager, tenantId),
        this.getChemicalStats(manager, tenantId),
        this.getConsumableStats(manager, tenantId),
        this.getLocationFillRates(manager, tenantId),
        this.getRecentMovementsCount(manager, tenantId),
        listVisibleLowStock(this.lowStockEvaluator, this.siteAuth, manager, tenantId, caller),
      ]);

      const categoryTotals: CategoryTotal[] = [
        { category: 'feed', ...feedStats },
        { category: 'chemical', ...chemicalStats },
        { category: 'consumable', ...consumableStats },
      ];

      const totalStockValue = categoryTotals.reduce((sum, c) => sum + c.totalValue, 0);
      const totalItems = categoryTotals.reduce((sum, c) => sum + c.itemCount, 0);

      const lowStockAlerts: LowStockAlert[] = lowStockRows.map(toLowStockAlert);

      return {
        totalStockValue,
        totalItems,
        lowStockAlertCount: lowStockAlerts.length,
        recentMovementsCount,
        categoryTotals,
        locationFillRates,
        lowStockAlerts,
      };
    });
  }

  private async getFeedStats(manager: EntityManager, tenantId: string): Promise<CategoryStats> {
    const result = await manager
      .createQueryBuilder(Feed, 'f')
      .select('COALESCE(SUM(f.quantity), 0)', 'totalQuantity')
      .addSelect('COALESCE(SUM(f.quantity * COALESCE(f.pricePerKg, 0)), 0)', 'totalValue')
      .addSelect('COUNT(*)', 'itemCount')
      .where('f.tenantId = :tenantId', { tenantId })
      .andWhere('f.isDeleted = false')
      .andWhere('f.isActive = true')
      .getRawOne<CategoryStatsRaw>();

    return {
      totalQuantity: parseFloat(result?.totalQuantity || '0'),
      totalValue: parseFloat(result?.totalValue || '0'),
      itemCount: parseInt(result?.itemCount || '0'),
    };
  }

  private async getChemicalStats(manager: EntityManager, tenantId: string): Promise<CategoryStats> {
    const result = await manager
      .createQueryBuilder(Chemical, 'c')
      .select('COALESCE(SUM(c.quantity), 0)', 'totalQuantity')
      .addSelect('COALESCE(SUM(c.quantity * COALESCE(c.unitPrice, 0)), 0)', 'totalValue')
      .addSelect('COUNT(*)', 'itemCount')
      .where('c.tenantId = :tenantId', { tenantId })
      .andWhere('c.isDeleted = false')
      .andWhere('c.isActive = true')
      .getRawOne<CategoryStatsRaw>();

    return {
      totalQuantity: parseFloat(result?.totalQuantity || '0'),
      totalValue: parseFloat(result?.totalValue || '0'),
      itemCount: parseInt(result?.itemCount || '0'),
    };
  }

  private async getConsumableStats(manager: EntityManager, tenantId: string): Promise<CategoryStats> {
    const result = await manager
      .createQueryBuilder(Consumable, 'c')
      .select('COALESCE(SUM(c.quantity), 0)', 'totalQuantity')
      .addSelect('COALESCE(SUM(c.quantity * COALESCE(c.unitPrice, 0)), 0)', 'totalValue')
      .addSelect('COUNT(*)', 'itemCount')
      .where('c.tenantId = :tenantId', { tenantId })
      .andWhere('c.isDeleted = false')
      .andWhere('c.isActive = true')
      .getRawOne<CategoryStatsRaw>();

    return {
      totalQuantity: parseFloat(result?.totalQuantity || '0'),
      totalValue: parseFloat(result?.totalValue || '0'),
      itemCount: parseInt(result?.itemCount || '0'),
    };
  }

  private async getLocationFillRates(manager: EntityManager, tenantId: string): Promise<LocationFillRate[]> {
    const locations = await manager.find(StorageLocation, {
      where: { tenantId, isDeleted: false, isActive: true },
    });

    return locations.map((loc) => ({
      locationId: loc.id,
      locationName: loc.name,
      locationType: loc.type,
      capacity: numberOrUndefined(loc.capacity),
      capacityUnit: loc.capacityUnit,
      usedCapacity: Number(loc.usedCapacity),
      fillPercentage: loc.capacity && Number(loc.capacity) > 0
        ? Math.min(100, (Number(loc.usedCapacity) / Number(loc.capacity)) * 100)
        : 0,
    }));
  }

  /**
   * Count stock movements in the last 7 days for the overview dashboard KPI.
   * Bug fix: previously counted ALL movements regardless of date because
   * the sevenDaysAgo variable was created but never used in the WHERE clause.
   */
  private async getRecentMovementsCount(manager: EntityManager, tenantId: string): Promise<number> {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    return manager.count(StockMovement, {
      where: {
        tenantId,
        // Filter to movements performed within the last 7 days only.
        // Without this filter, the dashboard KPI showed the total movement
        // count across all time, which was misleading for operational teams
        // who need to see recent activity trends.
        performedAt: MoreThanOrEqual(sevenDaysAgo),
      },
    });
  }
}

/** Evaluator reading → web overview row. */
function toLowStockAlert({ reading, siteName }: VisibleLowStockRow): LowStockAlert {
  return {
    itemId: reading.itemId,
    itemName: reading.itemName,
    itemType: reading.itemType,
    level: reading.level === 'site' ? LowStockLevel.SITE : LowStockLevel.POOL,
    siteId: reading.level === 'site' ? reading.siteId : null,
    siteName,
    currentQuantity: reading.onHand,
    minStock: reading.threshold,
    onOrderQuantity: reading.level === 'pool' ? reading.onOrder : 0,
    unit: reading.unit,
  };
}
