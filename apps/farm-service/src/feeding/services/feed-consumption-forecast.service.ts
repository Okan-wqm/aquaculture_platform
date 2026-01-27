/**
 * Feed Consumption Forecast Service
 *
 * Aggregates feed consumption forecast across all tanks/cages/ponds.
 * Uses tank-based simulation for accurate per-tank feed planning.
 * Groups by feed type and calculates when stock runs out.
 * Provides alerts for reorder timing.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { FeedInventory } from '../entities/feed-inventory.entity';
import { GrowthSimulatorService, GrowthProjection } from './growth-simulator.service';

export interface FeedConsumptionByType {
  feedId: string;
  feedCode: string;
  feedName: string;
  dailyConsumption: number[];      // Daily consumption for each day
  totalConsumption: number;        // Total kg over forecast period
  currentStock: number;            // Current inventory
  daysUntilStockout: number;       // When will stock run out
  stockoutDate: Date | null;       // Date of stockout
  reorderDate: Date | null;        // Recommended reorder date (leadTime before stockout)
  reorderQuantity: number;         // Recommended order quantity
  batches: {                       // Batches using this feed
    batchId: string;
    batchCode: string;
    consumption: number;
  }[];
}

export interface FeedForecastSummary {
  forecastDays: number;
  startDate: Date;
  endDate: Date;
  byFeedType: FeedConsumptionByType[];
  alerts: {
    feedId: string;
    feedCode: string;
    type: 'STOCKOUT_IMMINENT' | 'LOW_STOCK' | 'REORDER_NOW';
    message: string;
    daysUntilStockout: number;
  }[];
  totalConsumption: number;
  totalCurrentStock: number;
}

export interface FeedForecastInput {
  tenantId: string;
  schemaName: string;
  siteId?: string;                 // Filter by site
  forecastDays: number;            // Number of days to forecast (default 30)
  leadTimeDays?: number;           // Days before stockout to recommend reorder (default 7)
  safetyStockDays?: number;        // Days of safety stock to maintain (default 5)
}

@Injectable()
export class FeedConsumptionForecastService {
  private readonly logger = new Logger(FeedConsumptionForecastService.name);

  constructor(
    @InjectRepository(TankBatch)
    private readonly tankBatchRepo: Repository<TankBatch>,
    @InjectRepository(Batch)
    private readonly batchRepo: Repository<Batch>,
    @InjectRepository(Feed)
    private readonly feedRepo: Repository<Feed>,
    @InjectRepository(FeedInventory)
    private readonly inventoryRepo: Repository<FeedInventory>,
    private readonly growthSimulator: GrowthSimulatorService,
  ) {}

  /**
   * Forecast feed consumption across all active tanks/cages/ponds
   * Uses tank-based simulation for accurate per-tank feed planning
   */
  async forecastConsumption(input: FeedForecastInput): Promise<FeedForecastSummary> {
    const {
      tenantId,
      schemaName,
      siteId,
      forecastDays = 30,
      leadTimeDays = 7,
      safetyStockDays = 5,
    } = input;

    this.logger.log(`Forecasting feed consumption for ${forecastDays} days (tank-based)`);

    const startDate = new Date();
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + forecastDays);

    // 1. Get all active tanks with fish
    const activeTanks = await this.getActiveTanks(tenantId, schemaName, siteId);
    this.logger.log(`Found ${activeTanks.length} active tanks`);

    // 2. Batch load SGR for all batches (fixes N+1 query)
    const batchIds = [...new Set(
      activeTanks
        .map(tb => tb.primaryBatchId)
        .filter((id): id is string => !!id)
    )];

    const batchSgrMap = new Map<string, number>();
    if (batchIds.length > 0) {
      const batches = await this.batchRepo.find({
        where: batchIds.map(id => ({ id })),
        select: ['id', 'sgr'],
      });
      for (const batch of batches) {
        if (batch.sgr) {
          batchSgrMap.set(batch.id, batch.sgr);
        }
      }
    }

    // 3. Run growth simulation for each tank
    const tankProjections = new Map<string, { tankBatch: TankBatch; projections: GrowthProjection[] }>();
    for (const tankBatch of activeTanks) {
      const currentCount = tankBatch.totalQuantity;
      const currentWeightG = Number(tankBatch.avgWeightG) || 0;

      if (currentCount > 0 && currentWeightG > 0) {
        // Get SGR from pre-loaded batch data (O(1) lookup)
        const sgr = (tankBatch.primaryBatchId && batchSgrMap.get(tankBatch.primaryBatchId)) || 1.5;

        const result = await this.growthSimulator.simulateGrowth({
          tenantId,
          schemaName,
          tankId: tankBatch.tankId,
          currentWeightG,
          currentCount,
          sgr,
          projectionDays: forecastDays,
        });
        tankProjections.set(tankBatch.tankId, { tankBatch, projections: result.projections });
      }
    }

    // 4. Aggregate consumption by feed type
    const consumptionByFeed = new Map<string, {
      feedId: string;
      feedCode: string;
      feedName: string;
      dailyConsumption: number[];
      batches: Map<string, { batchId: string; batchCode: string; consumption: number }>;
    }>();

    for (const [tankId, { tankBatch, projections }] of tankProjections) {
      for (const projection of projections) {
        if (projection.feedCode && projection.dailyFeedKg > 0) {
          let feedData = consumptionByFeed.get(projection.feedCode);
          if (!feedData) {
            feedData = {
              feedId: '', // Will be filled later
              feedCode: projection.feedCode,
              feedName: projection.feedName ?? projection.feedCode,
              dailyConsumption: new Array(forecastDays + 1).fill(0),
              batches: new Map(),
            };
            consumptionByFeed.set(projection.feedCode, feedData);
          }

          // Add to daily consumption
          if (projection.day <= forecastDays) {
            feedData.dailyConsumption[projection.day] =
              (feedData.dailyConsumption[projection.day] ?? 0) + projection.dailyFeedKg;
          }

          // Track tank/batch contribution (use tank name for display)
          const trackingKey = tankId;
          const existing = feedData.batches.get(trackingKey);
          if (existing) {
            existing.consumption += projection.dailyFeedKg;
          } else {
            feedData.batches.set(trackingKey, {
              batchId: tankId, // Using tankId as identifier
              batchCode: tankBatch.tankCode ?? tankBatch.tankName ?? tankId,
              consumption: projection.dailyFeedKg,
            });
          }
        }
      }
    }

    // 4. Get current inventory levels
    const inventory = await this.getCurrentInventory(tenantId, schemaName, siteId);

    // 5. Calculate stockout dates and reorder recommendations
    const byFeedType: FeedConsumptionByType[] = [];
    const alerts: FeedForecastSummary['alerts'] = [];

    for (const [feedCode, data] of consumptionByFeed) {
      const currentStock = inventory.get(feedCode) ?? 0;
      const totalConsumption = data.dailyConsumption.reduce((sum, d) => sum + d, 0);

      // Calculate days until stockout
      let cumulativeConsumption = 0;
      let daysUntilStockout = -1;
      for (let day = 0; day < data.dailyConsumption.length; day++) {
        cumulativeConsumption += data.dailyConsumption[day] ?? 0;
        if (cumulativeConsumption >= currentStock && daysUntilStockout === -1) {
          daysUntilStockout = day;
          break;
        }
      }

      if (daysUntilStockout === -1) {
        daysUntilStockout = forecastDays + 1; // Stock won't run out in forecast period
      }

      const stockoutDate = daysUntilStockout <= forecastDays
        ? new Date(startDate.getTime() + daysUntilStockout * 24 * 60 * 60 * 1000)
        : null;

      const reorderDate = stockoutDate && daysUntilStockout > leadTimeDays
        ? new Date(stockoutDate.getTime() - leadTimeDays * 24 * 60 * 60 * 1000)
        : null;

      // Calculate reorder quantity (enough for 30 days + safety stock)
      const avgDailyConsumption = totalConsumption / forecastDays;
      const reorderQuantity = Math.ceil(avgDailyConsumption * (30 + safetyStockDays));

      byFeedType.push({
        feedId: data.feedId,
        feedCode: data.feedCode,
        feedName: data.feedName,
        dailyConsumption: data.dailyConsumption,
        totalConsumption: Math.round(totalConsumption * 100) / 100,
        currentStock,
        daysUntilStockout,
        stockoutDate,
        reorderDate,
        reorderQuantity,
        batches: Array.from(data.batches.values()),
      });

      // Generate alerts
      if (daysUntilStockout <= 3) {
        alerts.push({
          feedId: data.feedId,
          feedCode: data.feedCode,
          type: 'STOCKOUT_IMMINENT',
          message: `${data.feedName} will run out in ${daysUntilStockout} days!`,
          daysUntilStockout,
        });
      } else if (daysUntilStockout <= leadTimeDays) {
        alerts.push({
          feedId: data.feedId,
          feedCode: data.feedCode,
          type: 'REORDER_NOW',
          message: `Reorder ${data.feedName} now - ${daysUntilStockout} days of stock remaining`,
          daysUntilStockout,
        });
      } else if (daysUntilStockout <= leadTimeDays + safetyStockDays) {
        alerts.push({
          feedId: data.feedId,
          feedCode: data.feedCode,
          type: 'LOW_STOCK',
          message: `${data.feedName} running low - ${daysUntilStockout} days of stock remaining`,
          daysUntilStockout,
        });
      }
    }

    // Sort alerts by urgency
    alerts.sort((a, b) => a.daysUntilStockout - b.daysUntilStockout);

    return {
      forecastDays,
      startDate,
      endDate,
      byFeedType,
      alerts,
      totalConsumption: byFeedType.reduce((sum, f) => sum + f.totalConsumption, 0),
      totalCurrentStock: Array.from(inventory.values()).reduce((sum, s) => sum + s, 0),
    };
  }

  /**
   * Get active tanks with fish for the tenant/site (tank-based approach)
   */
  private async getActiveTanks(
    tenantId: string,
    schemaName: string,
    siteId?: string,
  ): Promise<TankBatch[]> {
    try {
      // Query tank_batches with fish (totalQuantity > 0)
      const queryBuilder = this.tankBatchRepo
        .createQueryBuilder('tb')
        .where('tb.tenantId = :tenantId', { tenantId })
        .andWhere('tb.totalQuantity > 0');

      const tankBatches = await queryBuilder.getMany();
      this.logger.log(`Found ${tankBatches.length} tanks with fish`);
      return tankBatches;
    } catch (error) {
      // Fallback to raw query
      this.logger.warn(`TankBatch query failed, using fallback: ${error}`);
      try {
        const rawTanks = await this.tankBatchRepo.query(
          `SELECT * FROM "${schemaName}".tank_batches WHERE "tenantId" = $1 AND "totalQuantity" > 0`,
          [tenantId]
        );
        return rawTanks;
      } catch {
        this.logger.warn('Fallback query also failed, returning empty array');
        return [];
      }
    }
  }

  /**
   * Get active batches for the tenant/site (legacy batch-based approach)
   * @deprecated Use getActiveTanks for tank-based simulation
   */
  private async getActiveBatches(
    tenantId: string,
    schemaName: string,
    siteId?: string,
  ): Promise<Batch[]> {
    // Use TypeORM QueryBuilder for proper column mapping
    // The Batch entity may have different DB column names depending on schema setup
    const queryBuilder = this.batchRepo
      .createQueryBuilder('batch')
      .where('batch.tenantId = :tenantId', { tenantId })
      .andWhere('batch.status IN (:...statuses)', { statuses: ['ACTIVE', 'STOCKED', 'QUARANTINE'] });

    if (siteId) {
      queryBuilder.andWhere('batch.siteId = :siteId', { siteId });
    }

    // Try to get batches - use simpler query if entity fields don't match DB
    try {
      return await queryBuilder.getMany();
    } catch {
      // Fallback: Query with minimal filtering if entity mapping fails
      this.logger.warn('Batch entity mapping issue, using fallback query');
      const rawBatches = await this.batchRepo.query(
        `SELECT * FROM "${schemaName}".batches WHERE "tenantId" = $1 AND "status" IN ('ACTIVE', 'STOCKED', 'QUARANTINE')`,
        [tenantId]
      );
      return rawBatches;
    }
  }

  /**
   * Get current feed inventory levels
   */
  private async getCurrentInventory(
    tenantId: string,
    schemaName: string,
    siteId?: string,
  ): Promise<Map<string, number>> {
    const inventory = new Map<string, number>();

    try {
      // Try using TypeORM first for proper mapping
      const feeds = await this.feedRepo.find({
        where: {
          tenantId,
          isDeleted: false,
        },
        select: ['code', 'quantity'],
      });

      for (const feed of feeds) {
        if (feed.code) {
          inventory.set(feed.code, parseFloat(String(feed.quantity ?? 0)) || 0);
        }
      }
    } catch {
      // Fallback to raw query
      this.logger.warn('Feed entity mapping issue, using fallback query');
      const query = `
        SELECT code, quantity
        FROM "${schemaName}".feeds
        WHERE "tenantId" = $1 AND ("isDeleted" = false OR "isDeleted" IS NULL)
      `;
      const feeds = await this.feedRepo.query(query, [tenantId]);
      for (const feed of feeds) {
        if (feed.code) {
          inventory.set(feed.code, parseFloat(String(feed.quantity ?? 0)) || 0);
        }
      }
    }

    return inventory;
  }

  /**
   * Calculate recommended order date based on current consumption rate
   */
  calculateReorderDate(
    currentStock: number,
    dailyConsumptionRate: number,
    leadTimeDays: number,
    safetyStockDays: number,
  ): { reorderDate: Date; daysUntilReorder: number } | null {
    if (dailyConsumptionRate <= 0) {
      return null;
    }

    const daysOfStock = currentStock / dailyConsumptionRate;
    const daysUntilReorder = Math.max(0, daysOfStock - leadTimeDays - safetyStockDays);

    const reorderDate = new Date();
    reorderDate.setDate(reorderDate.getDate() + Math.floor(daysUntilReorder));

    return { reorderDate, daysUntilReorder: Math.floor(daysUntilReorder) };
  }
}
