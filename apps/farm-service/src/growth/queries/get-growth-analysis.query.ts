/**
 * GetGrowthAnalysisQuery
 *
 * Batch için detaylı büyüme analizi getirir.
 *
 * @module Growth/Queries
 */
import { ITenantQuery } from '@platform/cqrs';

/**
 * Büyüme analizi sonucu
 */
export interface GrowthAnalysisResult {
  batchId: string;
  batchNumber: string;
  speciesName: string;

  // Genel bilgiler
  measurementCount: number;
  daysInProduction: number;
  stockedDate: Date;

  // Ağırlık bilgileri
  initialAvgWeightG: number;
  currentAvgWeightG: number;
  targetAvgWeightG?: number;
  totalWeightGainG: number;
  weightGainPercent: number;

  // Büyüme hızları
  avgDailyGrowthG: number;
  targetDailyGrowthG?: number;
  dailyGrowthVariancePercent: number;
  specificGrowthRate: number; // SGR

  // Biomass
  initialBiomassKg: number;
  currentBiomassKg: number;
  biomassGainKg: number;
  biomassGainPercent: number;

  // FCR
  cumulativeFCR: number;
  targetFCR: number;
  fcrVariancePercent: number;
  fcrTrend: 'improving' | 'stable' | 'declining';

  // Homojenlik
  avgWeightCV: number;
  cvTrend: 'improving' | 'stable' | 'declining';
  needsGrading: boolean;

  // Performans özeti
  overallPerformance: 'excellent' | 'good' | 'average' | 'below_average' | 'poor';
  performanceIndex: number; // 0-100

  // Trend verileri
  growthTrend: {
    date: string;
    avgWeightG: number;
    theoreticalWeightG: number;
    cv: number;
    sgr: number;
  }[];

  // Projeksiyonlar
  projectedHarvestDate?: Date;
  projectedHarvestWeightG?: number;
  daysToHarvest?: number;

  // Öneriler
  recommendations: {
    priority: 'high' | 'medium' | 'low';
    type: string;
    description: string;
  }[];
}

export class GetGrowthAnalysisQuery implements ITenantQuery {
  readonly queryName = 'GetGrowthAnalysisQuery';

  constructor(
    public readonly tenantId: string,
    public readonly batchId: string,
  ) {}
}
