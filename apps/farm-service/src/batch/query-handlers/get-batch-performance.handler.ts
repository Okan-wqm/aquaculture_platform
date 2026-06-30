/**
 * GetBatchPerformanceHandler
 *
 * GetBatchPerformanceQuery'yi işler ve batch performans metriklerini hesaplar.
 *
 * Phase 7.3.1: Redis caching moved from this handler to the
 * @Cacheable decorator on the `batchPerformance` resolver method.
 * The handler body is now pure compute — one caching pattern for
 * the whole service (CacheableInterceptor at the resolver layer)
 * instead of four bespoke read-through blocks. The handler
 * signature stays stable so callers (tests, other services) are
 * unaffected.
 *
 * @module Batch/QueryHandlers
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { runInTenantRead } from '@aquaculture/backend-common/database';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { GetBatchPerformanceQuery, BatchPerformanceResult } from '../queries/get-batch-performance.query';
import { Batch } from '../entities/batch.entity';
import { Species } from '../../species/entities/species.entity';
import { RedisService } from '@aquaculture/backend-common/redis';
import { BatchCostCalculatorService } from '../services/batch-cost-calculator.service';
import { FCRCalculationService } from '../../growth/services/fcr-calculation.service';

@Injectable()
@QueryHandler(GetBatchPerformanceQuery)
export class GetBatchPerformanceHandler implements IQueryHandler<GetBatchPerformanceQuery, BatchPerformanceResult> {
  private readonly logger = new Logger(GetBatchPerformanceHandler.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly costCalculator: BatchCostCalculatorService,
    private readonly fcrCalculation: FCRCalculationService,
  ) {}

  async execute(query: GetBatchPerformanceQuery): Promise<BatchPerformanceResult> {
    const { tenantId, batchId } = query;

    // Batch bul — read through the fail-closed tenant boundary so a lost/wrong
    // pooled-connection search_path raises instead of silently resolving the
    // source schema (→ NotFound / empty for a record that actually exists).
    const batch = await runInTenantRead(this.dataSource, 'farm', tenantId, (queryRunner) =>
      queryRunner.manager.findOne(Batch, {
        where: { id: batchId, tenantId },
        relations: ['species'],
      }),
    );

    if (!batch) {
      throw new NotFoundException(`Batch ${batchId} bulunamadı`);
    }

    // Species bilgileri — same fail-closed boundary for the relation fallback.
    const species =
      batch.species ||
      (await runInTenantRead(this.dataSource, 'farm', tenantId, (queryRunner) =>
        queryRunner.manager.findOne(Species, {
          where: { id: batch.speciesId, tenantId },
        }),
      ));

    // Weight calculations
    const initialAvgWeightG = batch.weight.initial.avgWeight;
    const currentAvgWeightG = batch.getCurrentAvgWeight();
    const weightGainG = currentAvgWeightG - initialAvgWeightG;
    const weightGainPercent = initialAvgWeightG > 0 ? (weightGainG / initialAvgWeightG) * 100 : 0;

    // Biomass
    const initialBiomassKg = batch.weight.initial.totalBiomass;
    const currentBiomassKg = batch.getCurrentBiomass();

    // Mortality calculations
    const mortalityRate = batch.getMortalityRate();
    const survivalRate = batch.getSurvivalRate();
    const retentionRate = batch.getRetentionRate();

    // Days in production
    const daysInProduction = batch.getDaysInProduction();

    // Growth rates
    const avgDailyGrowthG = daysInProduction > 0 ? weightGainG / daysInProduction : 0;
    const targetDailyGrowthG = species?.growthParameters?.avgDailyGrowth || 0;
    const growthVariancePercent = targetDailyGrowthG > 0
      ? ((avgDailyGrowthG - targetDailyGrowthG) / targetDailyGrowthG) * 100
      : 0;

    // FCR — the single authority is FcrCalculationService.calculateCumulativeFCR,
    // which reads net-exited biomass (mortality + cull + harvest + transfer-out
    // − transfer-in) from the TankOperation ledger. The previous
    // batch.calculateFCR(mortalityBiomass) only credited mortality biomass and
    // used the stored snapshot, overstating FCR (FARM-HIGH-007).
    const cumulativeFCR = await this.fcrCalculation.calculateCumulativeFCR(batchId, tenantId);
    const actualFCR = cumulativeFCR.fcr;
    const targetFCR = batch.fcr.target;
    const fcrVariance = actualFCR - targetFCR;
    const fcrStatus = this.getFCRStatus(actualFCR, targetFCR);

    // SGR
    const sgr = batch.calculateSGR();

    // Feed
    const totalFeedConsumedKg = Number(batch.totalFeedConsumed);
    const totalFeedCost = Number(batch.totalFeedCost);
    const avgDailyFeedKg = daysInProduction > 0 ? totalFeedConsumedKg / daysInProduction : 0;

    // Cost calculations — full breakdown via BatchCostCalculatorService
    // (phase 2.3). Previous implementation was
    //   totalCost = purchaseCost + totalFeedCost
    // which understated treatment, labour, and equipment amortization
    // axes entirely. The service fan-outs to health_events + work_orders
    // and exposes a `warnings` array so the UI can flag partial data.
    const costBreakdown = await this.costCalculator.compute(batch);
    const purchaseCost = costBreakdown.purchaseCost;
    const totalCost = costBreakdown.totalCost;
    const costPerKg = costBreakdown.costPerKg;
    const costPerFish = costBreakdown.costPerFish;

    // Projections
    const projectedHarvestDate = batch.expectedHarvestDate;
    const projectedHarvestWeightG = species?.growthParameters?.avgHarvestWeight;
    const daysToHarvest = projectedHarvestDate
      ? Math.max(0, Math.ceil((new Date(projectedHarvestDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
      : undefined;

    // Performance index calculation (0-100)
    const performanceIndex = this.calculatePerformanceIndex({
      fcrVariance,
      survivalRate,
      growthVariancePercent,
      targetSurvivalRate: species?.growthParameters?.expectedSurvivalRate || 85,
    });

    const performanceStatus = this.getPerformanceStatus(performanceIndex);

    const result: BatchPerformanceResult = {
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      speciesName: species?.commonName || species?.scientificName || 'Unknown',

      initialQuantity: batch.initialQuantity,
      currentQuantity: batch.currentQuantity,
      initialBiomassKg,
      currentBiomassKg,

      initialAvgWeightG,
      currentAvgWeightG,
      weightGainG,
      weightGainPercent,

      totalMortality: batch.totalMortality,
      mortalityRate,
      survivalRate,
      retentionRate,
      cullCount: batch.cullCount,

      fcr: {
        target: targetFCR,
        actual: actualFCR,
        theoretical: batch.fcr.theoretical,
        variance: fcrVariance,
        status: fcrStatus,
      },
      sgr,

      daysInProduction,
      avgDailyGrowthG,
      targetDailyGrowthG,
      growthVariancePercent,

      totalFeedConsumedKg,
      totalFeedCost,
      avgDailyFeedKg,

      purchaseCost,
      totalCost,
      costPerKg,
      costPerFish,

      projectedHarvestDate,
      projectedHarvestWeightG,
      daysToHarvest,

      performanceIndex,
      performanceStatus,
    };

    return result;
  }

  private getFCRStatus(actual: number, target: number): 'excellent' | 'good' | 'average' | 'poor' {
    if (actual <= 0) return 'average';
    const ratio = actual / target;
    if (ratio <= 0.9) return 'excellent';
    if (ratio <= 1.0) return 'good';
    if (ratio <= 1.15) return 'average';
    return 'poor';
  }

  private calculatePerformanceIndex(params: {
    fcrVariance: number;
    survivalRate: number;
    growthVariancePercent: number;
    targetSurvivalRate: number;
  }): number {
    const { fcrVariance, survivalRate, growthVariancePercent, targetSurvivalRate } = params;

    // FCR score (30 points) - lower is better
    let fcrScore = 30;
    if (fcrVariance > 0) {
      fcrScore = Math.max(0, 30 - fcrVariance * 10);
    } else {
      fcrScore = Math.min(30, 30 + Math.abs(fcrVariance) * 5);
    }

    // Survival rate score (35 points)
    const survivalScore = Math.min(35, (survivalRate / targetSurvivalRate) * 35);

    // Growth score (35 points)
    let growthScore = 35;
    if (growthVariancePercent < 0) {
      growthScore = Math.max(0, 35 + growthVariancePercent * 0.35);
    } else {
      growthScore = Math.min(35, 35 + growthVariancePercent * 0.2);
    }

    return Math.round(fcrScore + survivalScore + growthScore);
  }

  private getPerformanceStatus(index: number): 'excellent' | 'good' | 'average' | 'below_average' | 'poor' {
    if (index >= 90) return 'excellent';
    if (index >= 75) return 'good';
    if (index >= 60) return 'average';
    if (index >= 45) return 'below_average';
    return 'poor';
  }
}
