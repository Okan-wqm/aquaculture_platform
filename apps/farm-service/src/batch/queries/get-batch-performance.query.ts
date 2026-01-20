/**
 * GetBatchPerformanceQuery
 *
 * Batch performans metriklerini hesaplar ve getirir.
 *
 * @module Batch/Queries
 */
import { ITenantQuery } from '@platform/cqrs';

export interface BatchPerformanceResult {
  batchId: string;
  batchNumber: string;
  speciesName: string;

  // Quantity & Biomass
  initialQuantity: number;
  currentQuantity: number;
  initialBiomassKg: number;
  currentBiomassKg: number;

  // Weight
  initialAvgWeightG: number;
  currentAvgWeightG: number;
  weightGainG: number;
  weightGainPercent: number;

  // Mortality & Survival
  totalMortality: number;
  mortalityRate: number;
  survivalRate: number;
  retentionRate: number;
  cullCount: number;

  // FCR & SGR
  fcr: {
    target: number;
    actual: number;
    theoretical: number;
    variance: number;
    status: 'excellent' | 'good' | 'average' | 'poor';
  };
  sgr: number;

  // Growth
  daysInProduction: number;
  avgDailyGrowthG: number;
  targetDailyGrowthG: number;
  growthVariancePercent: number;

  // Feed
  totalFeedConsumedKg: number;
  totalFeedCost: number;
  avgDailyFeedKg: number;

  // Cost
  purchaseCost: number;
  totalCost: number;
  costPerKg: number;
  costPerFish: number;

  // Projections
  projectedHarvestDate?: Date;
  projectedHarvestWeightG?: number;
  daysToHarvest?: number;

  // Comparison with species targets
  performanceIndex: number;        // 0-100 overall score
  performanceStatus: 'excellent' | 'good' | 'average' | 'below_average' | 'poor';
}

export class GetBatchPerformanceQuery implements ITenantQuery {
  constructor(
    public readonly tenantId: string,
    public readonly batchId: string,
  ) {}
}
