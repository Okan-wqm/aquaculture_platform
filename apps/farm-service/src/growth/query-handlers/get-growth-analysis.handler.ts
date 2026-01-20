/**
 * GetGrowthAnalysisHandler
 *
 * GetGrowthAnalysisQuery'yi işler ve detaylı büyüme analizi döner.
 *
 * OPTIMIZED: Redis caching with 2 hour TTL for expensive calculations.
 *
 * @module Growth/QueryHandlers
 */
import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@platform/cqrs';
import { GetGrowthAnalysisQuery, GrowthAnalysisResult } from '../queries/get-growth-analysis.query';
import { GrowthMeasurement, GrowthPerformance } from '../entities/growth-measurement.entity';
import { Batch } from '../../batch/entities/batch.entity';
import { Species } from '../../species/entities/species.entity';
import { RedisService } from '@platform/backend-common';

@Injectable()
@QueryHandler(GetGrowthAnalysisQuery)
export class GetGrowthAnalysisHandler implements IQueryHandler<GetGrowthAnalysisQuery, GrowthAnalysisResult> {
  private static readonly CACHE_TTL = 7200; // 2 hours

  constructor(
    @InjectRepository(GrowthMeasurement)
    private readonly measurementRepository: Repository<GrowthMeasurement>,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(Species)
    private readonly speciesRepository: Repository<Species>,
    @Optional()
    private readonly redisService?: RedisService,
  ) {}

  async execute(query: GetGrowthAnalysisQuery): Promise<GrowthAnalysisResult> {
    const { tenantId, batchId } = query;

    // OPTIMIZED: Check Redis cache first
    const cacheKey = `growth:analysis:${tenantId}:${batchId}`;
    if (this.redisService) {
      try {
        const cached = await this.redisService.getJson<GrowthAnalysisResult>(cacheKey);
        if (cached) {
          return cached;
        }
      } catch {
        // Cache miss or error, continue to compute
      }
    }

    // Batch'i bul
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId },
      relations: ['species'],
    });

    if (!batch) {
      throw new NotFoundException(`Batch ${batchId} bulunamadı`);
    }

    // Species bilgilerini al
    const species = batch.species || await this.speciesRepository.findOne({
      where: { id: batch.speciesId, tenantId },
    });

    // Tüm ölçümleri al
    const measurements = await this.measurementRepository.find({
      where: { tenantId, batchId },
      order: { measurementDate: 'ASC' },
    });

    const measurementCount = measurements.length;

    // Temel ağırlık bilgileri
    const initialAvgWeightG = batch.weight?.initial?.avgWeight || 0;
    const lastMeasurement = measurements.length > 0 ? measurements[measurements.length - 1] : undefined;
    const currentAvgWeightG = lastMeasurement
      ? lastMeasurement.averageWeight
      : initialAvgWeightG;
    const targetAvgWeightG = species?.growthParameters?.avgHarvestWeight;
    const totalWeightGainG = currentAvgWeightG - initialAvgWeightG;
    const weightGainPercent = initialAvgWeightG > 0
      ? (totalWeightGainG / initialAvgWeightG) * 100
      : 0;

    // Gün hesaplamaları
    const daysInProduction = batch.getDaysInProduction();
    const stockedDate = batch.stockedAt;

    // Büyüme hızları
    const avgDailyGrowthG = daysInProduction > 0
      ? totalWeightGainG / daysInProduction
      : 0;
    const targetDailyGrowthG = species?.growthParameters?.avgDailyGrowth;
    const dailyGrowthVariancePercent = targetDailyGrowthG && targetDailyGrowthG > 0
      ? ((avgDailyGrowthG - targetDailyGrowthG) / targetDailyGrowthG) * 100
      : 0;

    // SGR hesapla
    const specificGrowthRate = daysInProduction > 0 && initialAvgWeightG > 0
      ? ((Math.log(currentAvgWeightG) - Math.log(initialAvgWeightG)) / daysInProduction) * 100
      : 0;

    // Biomass bilgileri
    const initialBiomassKg = batch.weight?.initial?.totalBiomass || 0;
    const currentBiomassKg = lastMeasurement
      ? lastMeasurement.estimatedBiomass
      : initialBiomassKg;
    const biomassGainKg = currentBiomassKg - initialBiomassKg;
    const biomassGainPercent = initialBiomassKg > 0
      ? (biomassGainKg / initialBiomassKg) * 100
      : 0;

    // FCR bilgileri
    const cumulativeFCR = batch.fcr?.actual || batch.calculateFCR(0);
    const targetFCR = batch.fcr?.target || 1.5;
    const fcrVariancePercent = ((cumulativeFCR - targetFCR) / targetFCR) * 100;
    const fcrTrend = this.calculateFCRTrend(measurements);

    // CV bilgileri
    const cvValues = measurements.map(m => m.weightCV);
    const avgWeightCV = cvValues.length > 0
      ? cvValues.reduce((a, b) => a + b, 0) / cvValues.length
      : 0;
    const cvTrend = this.calculateCVTrend(measurements);
    const needsGrading = avgWeightCV > 25;

    // Performans özeti
    const { overallPerformance, performanceIndex } = this.calculateOverallPerformance(
      dailyGrowthVariancePercent,
      fcrVariancePercent,
      avgWeightCV,
      batch.getSurvivalRate(),
    );

    // Trend verileri
    const growthTrend = measurements.map((m, index) => {
      const theoreticalWeight = initialAvgWeightG + (avgDailyGrowthG * this.getDaysBetween(stockedDate, m.measurementDate));
      return {
        date: m.measurementDate.toString().split('T')[0] ?? '',
        avgWeightG: m.averageWeight,
        theoreticalWeightG: theoreticalWeight,
        cv: m.weightCV,
        sgr: m.growthComparison?.specificGrowthRate || 0,
      };
    });

    // Projeksiyonlar
    const projectedHarvestDate = batch.expectedHarvestDate;
    const projectedHarvestWeightG = targetAvgWeightG;
    const daysToHarvest = projectedHarvestDate
      ? Math.max(0, this.getDaysBetween(new Date(), projectedHarvestDate))
      : undefined;

    // Öneriler
    const recommendations = this.generateRecommendations(
      dailyGrowthVariancePercent,
      fcrVariancePercent,
      avgWeightCV,
      cvTrend,
      fcrTrend,
    );

    const result: GrowthAnalysisResult = {
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      speciesName: species?.commonName || species?.scientificName || 'Unknown',

      measurementCount,
      daysInProduction,
      stockedDate,

      initialAvgWeightG,
      currentAvgWeightG,
      targetAvgWeightG,
      totalWeightGainG,
      weightGainPercent,

      avgDailyGrowthG,
      targetDailyGrowthG,
      dailyGrowthVariancePercent,
      specificGrowthRate,

      initialBiomassKg,
      currentBiomassKg,
      biomassGainKg,
      biomassGainPercent,

      cumulativeFCR,
      targetFCR,
      fcrVariancePercent,
      fcrTrend,

      avgWeightCV,
      cvTrend,
      needsGrading,

      overallPerformance,
      performanceIndex,

      growthTrend,

      projectedHarvestDate,
      projectedHarvestWeightG,
      daysToHarvest,

      recommendations,
    };

    // Cache the result (TTL: 2 hours)
    if (this.redisService) {
      this.redisService.setJson(cacheKey, result, GetGrowthAnalysisHandler.CACHE_TTL).catch(() => {
        // Ignore cache write errors
      });
    }

    return result;
  }

  private getDaysBetween(start: Date, end: Date): number {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const diffTime = endDate.getTime() - startDate.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  private calculateFCRTrend(measurements: GrowthMeasurement[]): 'improving' | 'stable' | 'declining' {
    const fcrValues = measurements
      .filter(m => m.fcrAnalysis?.periodFCR)
      .map(m => m.fcrAnalysis!.periodFCR);

    if (fcrValues.length < 3) return 'stable';

    const recentAvg = fcrValues.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const olderAvg = fcrValues.slice(0, 3).reduce((a, b) => a + b, 0) / 3;

    const diff = recentAvg - olderAvg;
    if (diff < -0.1) return 'improving';
    if (diff > 0.1) return 'declining';
    return 'stable';
  }

  private calculateCVTrend(measurements: GrowthMeasurement[]): 'improving' | 'stable' | 'declining' {
    if (measurements.length < 3) return 'stable';

    const recentCV = measurements.slice(-3).map(m => m.weightCV);
    const olderCV = measurements.slice(0, 3).map(m => m.weightCV);

    const recentAvg = recentCV.reduce((a, b) => a + b, 0) / recentCV.length;
    const olderAvg = olderCV.reduce((a, b) => a + b, 0) / olderCV.length;

    const diff = recentAvg - olderAvg;
    if (diff < -2) return 'improving';
    if (diff > 2) return 'declining';
    return 'stable';
  }

  private calculateOverallPerformance(
    growthVariance: number,
    fcrVariance: number,
    cv: number,
    survivalRate: number,
  ): { overallPerformance: GrowthAnalysisResult['overallPerformance']; performanceIndex: number } {
    // Performans index hesaplama (0-100)
    let index = 100;

    // Growth penalty
    if (growthVariance < 0) {
      index -= Math.min(30, Math.abs(growthVariance));
    }

    // FCR penalty
    if (fcrVariance > 0) {
      index -= Math.min(25, fcrVariance);
    }

    // CV penalty
    if (cv > 15) {
      index -= Math.min(20, (cv - 15) * 2);
    }

    // Survival bonus/penalty
    if (survivalRate >= 95) {
      index += 5;
    } else if (survivalRate < 85) {
      index -= (85 - survivalRate);
    }

    index = Math.max(0, Math.min(100, index));

    let overallPerformance: GrowthAnalysisResult['overallPerformance'];
    if (index >= 90) overallPerformance = 'excellent';
    else if (index >= 75) overallPerformance = 'good';
    else if (index >= 60) overallPerformance = 'average';
    else if (index >= 45) overallPerformance = 'below_average';
    else overallPerformance = 'poor';

    return { overallPerformance, performanceIndex: Math.round(index) };
  }

  private generateRecommendations(
    growthVariance: number,
    fcrVariance: number,
    cv: number,
    cvTrend: string,
    fcrTrend: string,
  ): GrowthAnalysisResult['recommendations'] {
    const recommendations: GrowthAnalysisResult['recommendations'] = [];

    if (growthVariance < -15) {
      recommendations.push({
        priority: growthVariance < -25 ? 'high' : 'medium',
        type: 'feeding',
        description: 'Yemleme programını gözden geçirin ve optimize edin',
      });
    }

    if (fcrVariance > 15) {
      recommendations.push({
        priority: fcrVariance > 25 ? 'high' : 'medium',
        type: 'feeding',
        description: 'Yem kalitesini ve yemleme tekniklerini kontrol edin',
      });
    }

    if (fcrTrend === 'declining') {
      recommendations.push({
        priority: 'high',
        type: 'health',
        description: 'FCR kötüleşiyor - sağlık kontrolü yapın',
      });
    }

    if (cv > 25) {
      recommendations.push({
        priority: cv > 35 ? 'high' : 'medium',
        type: 'grading',
        description: 'Yüksek boyut varyasyonu - grading yapılmalı',
      });
    }

    if (cvTrend === 'declining') {
      recommendations.push({
        priority: 'medium',
        type: 'feeding',
        description: 'Boyut homojenliği azalıyor - yemleme dağılımını iyileştirin',
      });
    }

    return recommendations;
  }
}
