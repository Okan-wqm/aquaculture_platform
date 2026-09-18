/**
 * Production shapes for the farm AI read contract: batch performance,
 * growth, species targets and tank capacity. Compact projections — trend
 * arrays are capped, no free text, no operator identities.
 */
import {
  FARM_AI_QUERY_LIMITS,
  isAiQueryList,
  isAiQueryRequestShape,
  isBoundedDateRange,
  isBoundedInt,
  isIsoDateString,
  isNullableNumber,
  isNullableString,
  isRecord,
  isUuidString,
  type AiQueryList,
  type AiQueryRequest,
} from '../farm-ai-queries';

// ── Batch performance ───────────────────────────────────────────────────────

export interface BatchPerformanceRequest extends AiQueryRequest {
  batchId: string;
}
export interface BatchPerformanceReply {
  batchId: string;
  batchNumber: string;
  speciesName: string;
  initialQuantity: number;
  currentQuantity: number;
  initialBiomassKg: number;
  currentBiomassKg: number;
  initialAvgWeightG: number;
  currentAvgWeightG: number;
  weightGainG: number;
  weightGainPct: number;
  totalMortality: number;
  mortalityRatePct: number;
  survivalRatePct: number;
  cullCount: number;
  fcr: { target: number; actual: number; theoretical: number; variance: number; status: string };
  sgr: number;
  daysInProduction: number;
  avgDailyGrowthG: number;
  targetDailyGrowthG: number;
  growthVariancePct: number;
  totalFeedConsumedKg: number;
  totalFeedCost: number;
  avgDailyFeedKg: number;
  totalCost: number;
  costPerKg: number;
  costPerFish: number;
  projectedHarvestDate: string | null;
  projectedHarvestWeightG: number | null;
  daysToHarvest: number | null;
  performanceIndex: number;
  performanceStatus: string;
}
export function isBatchPerformanceRequest(value: unknown): value is BatchPerformanceRequest {
  return isAiQueryRequestShape(value, ['batchId']) && isUuidString(value['batchId']);
}
export function isBatchPerformanceReply(value: unknown): value is BatchPerformanceReply {
  return (
    isRecord(value) &&
    typeof value['batchId'] === 'string' &&
    typeof value['batchNumber'] === 'string' &&
    typeof value['currentBiomassKg'] === 'number' &&
    typeof value['sgr'] === 'number' &&
    isRecord(value['fcr']) &&
    typeof value['performanceIndex'] === 'number' &&
    typeof value['performanceStatus'] === 'string' &&
    isNullableString(value['projectedHarvestDate'])
  );
}

// ── Mortality by cause / transfers ──────────────────────────────────────────

export interface SiteWindowRequest extends AiQueryRequest {
  siteId: string;
  fromDate: string;
  toDate: string;
}
export function isSiteWindowRequest(value: unknown): value is SiteWindowRequest {
  return (
    isAiQueryRequestShape(value, ['siteId', 'fromDate', 'toDate']) &&
    isUuidString(value['siteId']) &&
    isBoundedDateRange(value['fromDate'], value['toDate'], FARM_AI_QUERY_LIMITS.MAX_RANGE_DAYS)
  );
}

export interface MortalityByCauseReply {
  siteId: string;
  fromDate: string;
  toDate: string;
  totalCount: number;
  recordCount: number;
  byCause: Array<{ cause: string; count: number; pct: number }>;
}
export function isMortalityByCauseReply(value: unknown): value is MortalityByCauseReply {
  return (
    isRecord(value) &&
    typeof value['siteId'] === 'string' &&
    typeof value['totalCount'] === 'number' &&
    typeof value['recordCount'] === 'number' &&
    Array.isArray(value['byCause'])
  );
}

export interface TransfersSummaryReply {
  siteId: string;
  fromDate: string;
  toDate: string;
  recordCount: number;
  totalInCount: number;
  totalInBiomassKg: number;
  totalOutCount: number;
  totalOutBiomassKg: number;
  records: Array<{
    date: string;
    direction: string;
    speciesCode: string;
    fishCount: number;
    biomassKg: number;
  }>;
  truncated: boolean;
}
export function isTransfersSummaryReply(value: unknown): value is TransfersSummaryReply {
  return (
    isRecord(value) &&
    typeof value['siteId'] === 'string' &&
    typeof value['recordCount'] === 'number' &&
    typeof value['totalInBiomassKg'] === 'number' &&
    Array.isArray(value['records']) &&
    typeof value['truncated'] === 'boolean'
  );
}

// ── Growth ──────────────────────────────────────────────────────────────────

export interface GrowthAnalysisReply {
  batchId: string;
  batchNumber: string;
  speciesName: string;
  measurementCount: number;
  daysInProduction: number;
  stockedDate: string;
  initialAvgWeightG: number;
  currentAvgWeightG: number;
  targetAvgWeightG: number | null;
  avgDailyGrowthG: number;
  targetDailyGrowthG: number | null;
  sgr: number;
  currentBiomassKg: number;
  biomassGainKg: number;
  cumulativeFcr: number;
  targetFcr: number;
  fcrVariancePct: number;
  fcrTrend: string;
  avgWeightCvPct: number;
  cvTrend: string;
  needsGrading: boolean;
  overallPerformance: string;
  performanceIndex: number;
  growthTrend: Array<{
    date: string;
    avgWeightG: number;
    theoreticalWeightG: number;
    cvPct: number;
    sgr: number;
  }>;
  growthTrendTruncated: boolean;
  projectedHarvestDate: string | null;
  projectedHarvestWeightG: number | null;
  daysToHarvest: number | null;
  recommendations: Array<{ priority: string; type: string; description: string }>;
}
export function isGrowthAnalysisReply(value: unknown): value is GrowthAnalysisReply {
  return (
    isRecord(value) &&
    typeof value['batchId'] === 'string' &&
    typeof value['sgr'] === 'number' &&
    typeof value['cumulativeFcr'] === 'number' &&
    typeof value['needsGrading'] === 'boolean' &&
    Array.isArray(value['growthTrend']) &&
    Array.isArray(value['recommendations'])
  );
}

export interface GrowthMeasurementsRequest extends AiQueryRequest {
  batchId: string;
  limit: number;
}
export interface GrowthMeasurementDto {
  id: string;
  measurementDate: string;
  measurementType: string;
  sampleSize: number;
  populationSize: number;
  avgWeightG: number;
  avgLengthCm: number | null;
  weightCvPct: number;
  conditionFactor: number | null;
  estimatedBiomassKg: number;
  biomassGainKg: number | null;
  performance: string | null;
  isVerified: boolean;
}
export type GrowthMeasurementsReply = AiQueryList<GrowthMeasurementDto>;
export function isGrowthMeasurementsRequest(value: unknown): value is GrowthMeasurementsRequest {
  return (
    isAiQueryRequestShape(value, ['batchId', 'limit']) &&
    isUuidString(value['batchId']) &&
    isBoundedInt(value['limit'], 1, FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT)
  );
}
export function isGrowthMeasurementDto(value: unknown): value is GrowthMeasurementDto {
  return (
    isRecord(value) &&
    isUuidString(value['id']) &&
    isIsoDateString(value['measurementDate']) &&
    typeof value['avgWeightG'] === 'number' &&
    typeof value['estimatedBiomassKg'] === 'number' &&
    isNullableNumber(value['avgLengthCm']) &&
    typeof value['isVerified'] === 'boolean'
  );
}
export function isGrowthMeasurementsReply(value: unknown): value is GrowthMeasurementsReply {
  return isAiQueryList(value, isGrowthMeasurementDto);
}

// ── Species targets ─────────────────────────────────────────────────────────

export type SpeciesListRequest = AiQueryRequest;
export interface SpeciesDto {
  id: string;
  code: string;
  commonName: string;
  scientificName: string;
  category: string;
  waterType: string;
  isActive: boolean;
  maxDensityKgM3: number | null;
  optimalDensityKgM3: number | null;
  avgDailyGrowthG: number | null;
  avgHarvestWeightG: number | null;
  avgTimeToHarvestDays: number | null;
  targetFcr: number | null;
  maxFcr: number | null;
  expectedSurvivalRatePct: number | null;
}
export type SpeciesListReply = AiQueryList<SpeciesDto>;
export function isSpeciesListRequest(value: unknown): value is SpeciesListRequest {
  return isAiQueryRequestShape(value, []);
}
export function isSpeciesDto(value: unknown): value is SpeciesDto {
  return (
    isRecord(value) &&
    isUuidString(value['id']) &&
    typeof value['code'] === 'string' &&
    typeof value['commonName'] === 'string' &&
    typeof value['isActive'] === 'boolean' &&
    isNullableNumber(value['targetFcr']) &&
    isNullableNumber(value['avgHarvestWeightG'])
  );
}
export function isSpeciesListReply(value: unknown): value is SpeciesListReply {
  return isAiQueryList(value, isSpeciesDto);
}

// ── Tank capacity ───────────────────────────────────────────────────────────

export interface TankCapacityRequest extends AiQueryRequest {
  tankId: string;
}
export interface TankCapacityReply {
  tankId: string;
  tankCode: string;
  tankName: string;
  volumeM3: number;
  maxCapacityKg: number;
  maxDensityKgM3: number;
  optimalDensityMinKgM3: number;
  optimalDensityMaxKgM3: number;
  currentQuantity: number;
  currentBiomassKg: number;
  currentDensityKgM3: number;
  currentAvgWeightG: number;
  capacityUsedKg: number;
  capacityAvailableKg: number;
  capacityUsedPct: number;
  densityStatus: string;
  capacityStatus: string;
  batchCount: number;
  primaryBatchId: string | null;
  primaryBatchNumber: string | null;
  warnings: string[];
}
export function isTankCapacityRequest(value: unknown): value is TankCapacityRequest {
  return isAiQueryRequestShape(value, ['tankId']) && isUuidString(value['tankId']);
}
export function isTankCapacityReply(value: unknown): value is TankCapacityReply {
  return (
    isRecord(value) &&
    typeof value['tankId'] === 'string' &&
    typeof value['volumeM3'] === 'number' &&
    typeof value['currentBiomassKg'] === 'number' &&
    typeof value['capacityUsedPct'] === 'number' &&
    typeof value['densityStatus'] === 'string' &&
    Array.isArray(value['warnings'])
  );
}
