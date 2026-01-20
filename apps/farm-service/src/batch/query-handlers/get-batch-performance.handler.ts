/**
 * GetBatchPerformanceHandler
 *
 * GetBatchPerformanceQuery'yi işler ve batch performans metriklerini hesaplar.
 *
 * OPTIMIZED: Redis caching with 1 hour TTL for expensive calculations.
 *
 * @module Batch/QueryHandlers
 */
import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { GetBatchPerformanceQuery, BatchPerformanceResult } from '../queries/get-batch-performance.query';
import { Batch } from '../entities/batch.entity';
import { TankOperation, OperationType } from '../entities/tank-operation.entity';
import { Species } from '../../species/entities/species.entity';
import { RedisService } from '@platform/backend-common';

@Injectable()
@QueryHandler(GetBatchPerformanceQuery)
export class GetBatchPerformanceHandler implements IQueryHandler<GetBatchPerformanceQuery, BatchPerformanceResult> {
  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(TankOperation)
    private readonly operationRepository: Repository<TankOperation>,
    @InjectRepository(Species)
    private readonly speciesRepository: Repository<Species>,
    @Optional()
    private readonly redisService?: RedisService,
  ) {}

  async execute(query: GetBatchPerformanceQuery): Promise<BatchPerformanceResult> {
    const { tenantId, batchId } = query;

    // OPTIMIZED: Check Redis cache first (TTL: 1 hour)
    const cacheKey = `batch:performance:${tenantId}:${batchId}`;
    if (this.redisService) {
      try {
        const cached = await this.redisService.getJson<BatchPerformanceResult>(cacheKey);
        if (cached) {
          return cached;
        }
      } catch {
        // Cache miss or error, continue to compute
      }
    }

    // Batch bul
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId },
      relations: ['species'],
    });

    if (!batch) {
      throw new NotFoundException(`Batch ${batchId} bulunamadı`);
    }

    // Species bilgileri
    const species = batch.species || await this.speciesRepository.findOne({
      where: { id: batch.speciesId, tenantId },
    });

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

    // FCR - mortality biomass'ı hesapla
    const mortalityOps = await this.operationRepository.find({
      where: { tenantId, batchId, operationType: OperationType.MORTALITY, isDeleted: false },
    });
    const mortalityBiomassKg = mortalityOps.reduce((sum, op) => sum + Number(op.biomassKg || 0), 0);
    const actualFCR = batch.calculateFCR(mortalityBiomassKg);
    const targetFCR = batch.fcr.target;
    const fcrVariance = actualFCR - targetFCR;
    const fcrStatus = this.getFCRStatus(actualFCR, targetFCR);

    // SGR
    const sgr = batch.calculateSGR();

    // Feed
    const totalFeedConsumedKg = Number(batch.totalFeedConsumed);
    const totalFeedCost = Number(batch.totalFeedCost);
    const avgDailyFeedKg = daysInProduction > 0 ? totalFeedConsumedKg / daysInProduction : 0;

    // Cost calculations
    const purchaseCost = Number(batch.purchaseCost || 0);
    const totalCost = purchaseCost + totalFeedCost;
    const costPerKg = currentBiomassKg > 0 ? totalCost / currentBiomassKg : 0;
    const costPerFish = batch.currentQuantity > 0 ? totalCost / batch.currentQuantity : 0;

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

    // Cache the result (TTL: 1 hour = 3600 seconds)
    if (this.redisService) {
      this.redisService.setJson(cacheKey, result, 3600).catch(() => {
        // Ignore cache write errors
      });
    }

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
