import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetStorageOverviewQuery } from '../queries/get-storage-overview.query';
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

@QueryHandler(GetStorageOverviewQuery)
export class GetStorageOverviewHandler implements IQueryHandler<GetStorageOverviewQuery> {
  constructor(
    @InjectRepository(StorageLocation)
    private readonly locationRepository: Repository<StorageLocation>,
    @InjectRepository(StockMovement)
    private readonly movementRepository: Repository<StockMovement>,
    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,
    @InjectRepository(Chemical)
    private readonly chemicalRepository: Repository<Chemical>,
    @InjectRepository(Consumable)
    private readonly consumableRepository: Repository<Consumable>,
  ) {}

  async execute(query: GetStorageOverviewQuery): Promise<StorageOverviewResponse> {
    const { tenantId } = query;

    // Run aggregations in parallel
    const [
      feedStats,
      chemicalStats,
      consumableStats,
      locationFillRates,
      recentMovementsCount,
      lowStockFeeds,
      lowStockChemicals,
      lowStockConsumables,
    ] = await Promise.all([
      this.getFeedStats(tenantId),
      this.getChemicalStats(tenantId),
      this.getConsumableStats(tenantId),
      this.getLocationFillRates(tenantId),
      this.getRecentMovementsCount(tenantId),
      this.getLowStockFeeds(tenantId),
      this.getLowStockChemicals(tenantId),
      this.getLowStockConsumables(tenantId),
    ]);

    const categoryTotals: CategoryTotal[] = [
      { category: 'feed', ...feedStats },
      { category: 'chemical', ...chemicalStats },
      { category: 'consumable', ...consumableStats },
    ];

    const totalStockValue = categoryTotals.reduce((sum, c) => sum + c.totalValue, 0);
    const totalItems = categoryTotals.reduce((sum, c) => sum + c.itemCount, 0);

    const lowStockAlerts: LowStockAlert[] = [
      ...lowStockFeeds,
      ...lowStockChemicals,
      ...lowStockConsumables,
    ];

    return {
      totalStockValue,
      totalItems,
      lowStockAlertCount: lowStockAlerts.length,
      recentMovementsCount,
      categoryTotals,
      locationFillRates,
      lowStockAlerts,
    };
  }

  private async getFeedStats(tenantId: string): Promise<{ totalQuantity: number; totalValue: number; itemCount: number }> {
    const result = await this.feedRepository
      .createQueryBuilder('f')
      .select('COALESCE(SUM(f.quantity), 0)', 'totalQuantity')
      .addSelect('COALESCE(SUM(f.quantity * COALESCE(f.pricePerKg, 0)), 0)', 'totalValue')
      .addSelect('COUNT(*)', 'itemCount')
      .where('f.tenantId = :tenantId', { tenantId })
      .andWhere('f.isDeleted = false')
      .andWhere('f.isActive = true')
      .getRawOne();

    return {
      totalQuantity: parseFloat(result?.totalQuantity || '0'),
      totalValue: parseFloat(result?.totalValue || '0'),
      itemCount: parseInt(result?.itemCount || '0'),
    };
  }

  private async getChemicalStats(tenantId: string): Promise<{ totalQuantity: number; totalValue: number; itemCount: number }> {
    const result = await this.chemicalRepository
      .createQueryBuilder('c')
      .select('COALESCE(SUM(c.quantity), 0)', 'totalQuantity')
      .addSelect('COALESCE(SUM(c.quantity * COALESCE(c.unitPrice, 0)), 0)', 'totalValue')
      .addSelect('COUNT(*)', 'itemCount')
      .where('c.tenantId = :tenantId', { tenantId })
      .andWhere('c.isDeleted = false')
      .andWhere('c.isActive = true')
      .getRawOne();

    return {
      totalQuantity: parseFloat(result?.totalQuantity || '0'),
      totalValue: parseFloat(result?.totalValue || '0'),
      itemCount: parseInt(result?.itemCount || '0'),
    };
  }

  private async getConsumableStats(tenantId: string): Promise<{ totalQuantity: number; totalValue: number; itemCount: number }> {
    const result = await this.consumableRepository
      .createQueryBuilder('c')
      .select('COALESCE(SUM(c.quantity), 0)', 'totalQuantity')
      .addSelect('COALESCE(SUM(c.quantity * COALESCE(c.unitPrice, 0)), 0)', 'totalValue')
      .addSelect('COUNT(*)', 'itemCount')
      .where('c.tenantId = :tenantId', { tenantId })
      .andWhere('c.isDeleted = false')
      .andWhere('c.isActive = true')
      .getRawOne();

    return {
      totalQuantity: parseFloat(result?.totalQuantity || '0'),
      totalValue: parseFloat(result?.totalValue || '0'),
      itemCount: parseInt(result?.itemCount || '0'),
    };
  }

  private async getLocationFillRates(tenantId: string): Promise<LocationFillRate[]> {
    const locations = await this.locationRepository.find({
      where: { tenantId, isDeleted: false, isActive: true },
    });

    return locations.map((loc) => ({
      locationId: loc.id,
      locationName: loc.name,
      locationType: loc.type,
      capacity: loc.capacity ? Number(loc.capacity) : undefined,
      capacityUnit: loc.capacityUnit,
      usedCapacity: Number(loc.usedCapacity),
      fillPercentage: loc.capacity && Number(loc.capacity) > 0
        ? Math.min(100, (Number(loc.usedCapacity) / Number(loc.capacity)) * 100)
        : 0,
    }));
  }

  private async getRecentMovementsCount(tenantId: string): Promise<number> {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    return this.movementRepository.count({
      where: { tenantId },
    });
  }

  private async getLowStockFeeds(tenantId: string): Promise<LowStockAlert[]> {
    const feeds = await this.feedRepository
      .createQueryBuilder('f')
      .where('f.tenantId = :tenantId', { tenantId })
      .andWhere('f.isDeleted = false')
      .andWhere('f.isActive = true')
      .andWhere('f.quantity <= f.minStock')
      .andWhere('f.minStock > 0')
      .getMany();

    return feeds.map((f) => ({
      itemId: f.id,
      itemName: f.name,
      itemType: 'feed',
      currentQuantity: Number(f.quantity),
      minStock: Number(f.minStock),
      unit: f.unit,
    }));
  }

  private async getLowStockChemicals(tenantId: string): Promise<LowStockAlert[]> {
    const chemicals = await this.chemicalRepository
      .createQueryBuilder('c')
      .where('c.tenantId = :tenantId', { tenantId })
      .andWhere('c.isDeleted = false')
      .andWhere('c.isActive = true')
      .andWhere('c.quantity <= c.minStock')
      .andWhere('c.minStock > 0')
      .getMany();

    return chemicals.map((c) => ({
      itemId: c.id,
      itemName: c.name,
      itemType: 'chemical',
      currentQuantity: Number(c.quantity),
      minStock: Number(c.minStock),
      unit: c.unit,
    }));
  }

  private async getLowStockConsumables(tenantId: string): Promise<LowStockAlert[]> {
    const consumables = await this.consumableRepository
      .createQueryBuilder('c')
      .where('c.tenantId = :tenantId', { tenantId })
      .andWhere('c.isDeleted = false')
      .andWhere('c.isActive = true')
      .andWhere('c.quantity <= c.minStock')
      .andWhere('c.minStock > 0')
      .getMany();

    return consumables.map((c) => ({
      itemId: c.id,
      itemName: c.name,
      itemType: 'consumable',
      currentQuantity: Number(c.quantity),
      minStock: Number(c.minStock),
      unit: c.unit,
    }));
  }
}
