/**
 * Growth Simulator Service
 *
 * Projects fish growth over time using SGR (Specific Growth Rate) formula.
 * Supports both tank-based and batch-based simulations.
 *
 * Tank-based simulation is preferred for:
 * - Per-tank feed management and FCR analysis
 * - Scientific studies and feed trials
 * - Comparing growth across tanks with same batch
 *
 * Key formulas:
 * - Wt = W0 × e^(SGR × t / 100)  (Weight at time t)
 * - SGR = (ln(Wt) - ln(W0)) / t × 100  (Specific Growth Rate)
 * - Daily Feed = Biomass × (Feeding Rate % / 100)
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Batch } from '../../batch/entities/batch.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { FeedSelectorService } from './feed-selector.service';

export interface GrowthProjection {
  day: number;
  date: Date;
  avgWeightG: number;
  fishCount: number;
  biomassKg: number;
  sgr: number;
  feedCode?: string;
  feedName?: string;
  feedingRatePercent: number;
  dailyFeedKg: number;
  cumulativeFeedKg: number;
  fcr?: number;
  temperature?: number;
  mortality: number;
  cumulativeMortality: number;
}

export interface GrowthSimulationInput {
  tenantId: string;
  schemaName: string;
  // Primary key - use tankId for tank-based simulation (preferred)
  tankId?: string;
  // Or use batchId for batch-level simulation (legacy)
  batchId?: string;
  // Manual input (if no tankId or batchId)
  currentWeightG: number;
  currentCount: number;
  sgr: number;                      // Daily SGR % (typically 1-3% for fish)
  projectionDays: number;           // How many days to project
  mortalityRate?: number;           // Daily mortality rate (default 0.01%)
  temperatureForecast?: number[];   // Optional daily temperature forecast
  startDate?: Date;                 // Projection start date (default: today)
}

/**
 * Multi-tank comparison input
 * Allows simulating multiple tanks in a single request for comparison
 */
export interface MultiTankSimulationInput {
  tenantId: string;
  schemaName: string;
  tankIds: string[];                // Multiple tanks to compare
  projectionDays: number;
  mortalityRate?: number;
  temperatureForecast?: number[];
  startDate?: Date;
}

/**
 * Tank-specific simulation result
 */
export interface TankSimulationResult extends GrowthSimulationResult {
  tankId: string;
  tankName?: string;
  tankCode?: string;
  batchId?: string;
  batchNumber?: string;
}

export interface GrowthSimulationResult {
  projections: GrowthProjection[];
  summary: {
    startWeight: number;
    endWeight: number;
    startBiomass: number;
    endBiomass: number;
    totalFeedKg: number;
    avgFCR: number;
    totalMortality: number;
    harvestDate?: Date;
    harvestWeight?: number;
  };
  feedRequirements: {
    feedCode: string;
    feedName: string;
    totalKg: number;
    daysUsed: number;
    startDay: number;
    endDay: number;
  }[];
}

@Injectable()
export class GrowthSimulatorService {
  private readonly logger = new Logger(GrowthSimulatorService.name);

  constructor(
    @InjectRepository(Batch)
    private readonly batchRepo: Repository<Batch>,
    @InjectRepository(Feed)
    private readonly feedRepo: Repository<Feed>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepo: Repository<TankBatch>,
    private readonly feedSelectorService: FeedSelectorService,
  ) {}

  /**
   * Simulate growth for a tank, batch, or manual input
   * Tank-based simulation is preferred for more accurate per-tank management
   */
  async simulateGrowth(input: GrowthSimulationInput): Promise<GrowthSimulationResult> {
    const {
      tenantId,
      schemaName,
      tankId,
      batchId,
      currentWeightG,
      currentCount,
      sgr,
      projectionDays,
      mortalityRate = 0.0001, // Default 0.01% daily
      temperatureForecast,
      startDate = new Date(),
    } = input;

    // If tankId provided, get tank-specific data
    let effectiveBatchId = batchId;
    let effectiveWeightG = currentWeightG;
    let effectiveCount = currentCount;

    if (tankId) {
      const tankBatch = await this.getTankBatch(tenantId, tankId);
      if (tankBatch) {
        effectiveBatchId = tankBatch.primaryBatchId ?? batchId;
        effectiveWeightG = currentWeightG || Number(tankBatch.avgWeightG) || 0;
        effectiveCount = currentCount || tankBatch.totalQuantity || 0;
        this.logger.log(
          `Tank-based simulation: tank=${tankBatch.tankName ?? tankId}, weight=${effectiveWeightG}g, count=${effectiveCount}`,
        );
      }
    }

    this.logger.log(
      `Simulating growth: weight=${effectiveWeightG}g, count=${effectiveCount}, SGR=${sgr}%, days=${projectionDays}`,
    );

    const projections: GrowthProjection[] = [];
    const feedRequirements: Map<string, { feedCode: string; feedName: string; totalKg: number; daysUsed: number; startDay: number; endDay: number }> = new Map();

    let weight = effectiveWeightG;
    let count = effectiveCount;
    let cumulativeFeed = 0;
    let cumulativeMortality = 0;

    for (let day = 0; day <= projectionDays; day++) {
      // Calculate mortality for this day
      const dailyMortality = day === 0 ? 0 : Math.floor(count * mortalityRate);
      count = Math.max(1, count - dailyMortality);
      cumulativeMortality += dailyMortality;

      // Calculate biomass
      const biomassKg = (weight * count) / 1000;

      // Get temperature for this day
      const temperature = temperatureForecast?.[day] ?? 15;

      // Get feed info for current weight/temp
      let feedInfo = null;
      if (effectiveBatchId) {
        feedInfo = await this.feedSelectorService.selectFeedForBatch(
          tenantId,
          schemaName,
          effectiveBatchId,
          weight,
          biomassKg,
          temperature,
        );
      }

      const feedingRatePercent = feedInfo?.feedingRatePercent ?? this.getDefaultFeedingRate(weight);
      const dailyFeedKg = day === 0 ? 0 : this.feedSelectorService.calculateDailyFeed(biomassKg, feedingRatePercent);
      cumulativeFeed += dailyFeedKg;

      // Track feed requirements by type
      if (feedInfo && dailyFeedKg > 0) {
        const existing = feedRequirements.get(feedInfo.feedCode);
        if (existing) {
          existing.totalKg += dailyFeedKg;
          existing.daysUsed += 1;
          existing.endDay = day;
        } else {
          feedRequirements.set(feedInfo.feedCode, {
            feedCode: feedInfo.feedCode,
            feedName: feedInfo.feedName,
            totalKg: dailyFeedKg,
            daysUsed: 1,
            startDay: day,
            endDay: day,
          });
        }
      }

      const projectionDate = new Date(startDate);
      projectionDate.setDate(projectionDate.getDate() + day);

      projections.push({
        day,
        date: projectionDate,
        avgWeightG: Math.round(weight * 100) / 100,
        fishCount: count,
        biomassKg: Math.round(biomassKg * 100) / 100,
        sgr: day === 0 ? 0 : sgr,
        feedCode: feedInfo?.feedCode,
        feedName: feedInfo?.feedName,
        feedingRatePercent: Math.round(feedingRatePercent * 100) / 100,
        dailyFeedKg: Math.round(dailyFeedKg * 100) / 100,
        cumulativeFeedKg: Math.round(cumulativeFeed * 100) / 100,
        fcr: feedInfo?.fcr,
        temperature,
        mortality: dailyMortality,
        cumulativeMortality,
      });

      // Grow fish for next day using SGR formula: Wt = W0 × e^(SGR × 1 / 100)
      // For daily growth: W_tomorrow = W_today × e^(SGR/100)
      weight = weight * Math.exp(sgr / 100);
    }

    // Calculate summary
    const firstProjection = projections[0];
    const lastProjection = projections[projections.length - 1];

    // Calculate average FCR
    const weightGain = (lastProjection?.biomassKg ?? 0) - (firstProjection?.biomassKg ?? 0);
    const avgFCR = weightGain > 0 ? cumulativeFeed / weightGain : 0;

    return {
      projections,
      summary: {
        startWeight: firstProjection?.avgWeightG ?? effectiveWeightG,
        endWeight: lastProjection?.avgWeightG ?? effectiveWeightG,
        startBiomass: firstProjection?.biomassKg ?? 0,
        endBiomass: lastProjection?.biomassKg ?? 0,
        totalFeedKg: Math.round(cumulativeFeed * 100) / 100,
        avgFCR: Math.round(avgFCR * 100) / 100,
        totalMortality: cumulativeMortality,
      },
      feedRequirements: Array.from(feedRequirements.values()),
    };
  }

  /**
   * Calculate SGR from two weight measurements
   */
  calculateSGR(startWeightG: number, endWeightG: number, days: number): number {
    if (days <= 0 || startWeightG <= 0 || endWeightG <= 0) {
      return 0;
    }
    // SGR = (ln(Wt) - ln(W0)) / t × 100
    return ((Math.log(endWeightG) - Math.log(startWeightG)) / days) * 100;
  }

  /**
   * Estimate SGR based on species and temperature
   * This is a simplified model - real SGR varies by species, feed, conditions
   */
  estimateSGR(species: string, temperature: number): number {
    // Base SGR values for common aquaculture species at optimal temperature
    const baseSGR: Record<string, number> = {
      'seabass': 1.5,
      'seabream': 1.4,
      'trout': 2.0,
      'salmon': 1.8,
      'tilapia': 2.5,
      'default': 1.5,
    };

    const base = baseSGR[species.toLowerCase()] ?? baseSGR['default'] ?? 1.5;

    // Temperature adjustment (simplified model)
    // Optimal range assumed to be 15-22°C
    let tempFactor = 1.0;
    if (temperature < 10) {
      tempFactor = 0.5;
    } else if (temperature < 15) {
      tempFactor = 0.75;
    } else if (temperature > 25) {
      tempFactor = 0.8;
    } else if (temperature > 22) {
      tempFactor = 0.9;
    }

    return Math.round(base * tempFactor * 100) / 100;
  }

  /**
   * Project harvest date based on target weight
   */
  projectHarvestDate(
    currentWeightG: number,
    targetWeightG: number,
    sgr: number,
    startDate: Date = new Date(),
  ): { harvestDate: Date; daysToHarvest: number } {
    if (sgr <= 0 || currentWeightG >= targetWeightG) {
      return { harvestDate: startDate, daysToHarvest: 0 };
    }

    // Solve for t: Wt = W0 × e^(SGR × t / 100)
    // t = ln(Wt/W0) / (SGR/100)
    const daysToHarvest = Math.ceil(Math.log(targetWeightG / currentWeightG) / (sgr / 100));

    const harvestDate = new Date(startDate);
    harvestDate.setDate(harvestDate.getDate() + daysToHarvest);

    return { harvestDate, daysToHarvest };
  }

  /**
   * Default feeding rate based on fish weight (when no feed curve is available)
   * Follows general aquaculture patterns: smaller fish = higher % BW
   */
  private getDefaultFeedingRate(weightG: number): number {
    if (weightG < 5) return 8.0;      // Fry
    if (weightG < 20) return 5.0;     // Fingerlings
    if (weightG < 50) return 4.0;
    if (weightG < 100) return 3.0;
    if (weightG < 200) return 2.5;
    if (weightG < 500) return 2.0;
    if (weightG < 1000) return 1.5;
    return 1.2;                       // Market size
  }

  /**
   * Get tank batch data by tankId
   */
  private async getTankBatch(tenantId: string, tankId: string): Promise<TankBatch | null> {
    try {
      return await this.tankBatchRepo.findOne({
        where: { tenantId, tankId },
      });
    } catch (error) {
      this.logger.warn(`Failed to get tank batch for tank ${tankId}: ${error}`);
      return null;
    }
  }

  /**
   * Simulate growth for multiple tanks (comparison mode)
   * Useful for feed trials, A/B testing, and scientific studies
   */
  async simulateMultiTank(input: MultiTankSimulationInput): Promise<TankSimulationResult[]> {
    const {
      tenantId,
      schemaName,
      tankIds,
      projectionDays,
      mortalityRate,
      temperatureForecast,
      startDate,
    } = input;

    this.logger.log(`Multi-tank simulation: ${tankIds.length} tanks, ${projectionDays} days`);

    const results: TankSimulationResult[] = [];

    for (const tankId of tankIds) {
      // Get tank batch data
      const tankBatch = await this.getTankBatch(tenantId, tankId);

      if (!tankBatch || !tankBatch.totalQuantity || !tankBatch.avgWeightG) {
        this.logger.warn(`Tank ${tankId} has no valid data, skipping`);
        continue;
      }

      // Get batch SGR (from batch entity or estimate)
      let sgr = 1.5; // Default
      if (tankBatch.primaryBatchId) {
        const batch = await this.batchRepo.findOne({
          where: { id: tankBatch.primaryBatchId },
          select: ['id', 'sgr', 'species'],
        });
        if (batch?.sgr) {
          sgr = batch.sgr;
        }
      }

      // Run simulation for this tank
      const simulation = await this.simulateGrowth({
        tenantId,
        schemaName,
        tankId,
        currentWeightG: Number(tankBatch.avgWeightG),
        currentCount: tankBatch.totalQuantity,
        sgr,
        projectionDays,
        mortalityRate,
        temperatureForecast,
        startDate,
      });

      results.push({
        ...simulation,
        tankId,
        tankName: tankBatch.tankName,
        tankCode: tankBatch.tankCode,
        batchId: tankBatch.primaryBatchId,
        batchNumber: tankBatch.primaryBatchNumber,
      });
    }

    return results;
  }

  /**
   * Get all active tanks with fish for a tenant
   * Useful for selecting which tanks to simulate
   */
  async getActiveTanks(tenantId: string): Promise<{
    tankId: string;
    tankName?: string;
    tankCode?: string;
    batchId?: string;
    batchNumber?: string;
    fishCount: number;
    avgWeightG: number;
    biomassKg: number;
  }[]> {
    const tankBatches = await this.tankBatchRepo.find({
      where: { tenantId },
      select: ['tankId', 'tankName', 'tankCode', 'primaryBatchId', 'primaryBatchNumber', 'totalQuantity', 'avgWeightG', 'totalBiomassKg'],
    });

    return tankBatches
      .filter(tb => tb.totalQuantity > 0)
      .map(tb => ({
        tankId: tb.tankId,
        tankName: tb.tankName,
        tankCode: tb.tankCode,
        batchId: tb.primaryBatchId,
        batchNumber: tb.primaryBatchNumber,
        fishCount: tb.totalQuantity,
        avgWeightG: Number(tb.avgWeightG),
        biomassKg: Number(tb.totalBiomassKg),
      }));
  }
}
