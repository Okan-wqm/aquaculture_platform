/**
 * PURE projections for the batch/growth farm-AI responder (PR-4, Production
 * specialist). Covers batch performance, mortality-by-cause, transfers
 * summary, growth analysis and growth measurement rows.
 *
 * Rules of the read-only namespace (see common/nats/ai-query-responder.ts):
 *  - Input = the query handler's return shape; output = wire DTO ONLY.
 *  - NO entity metadata (createdAt/updatedAt/tenantId) and NO operator PII
 *    (measuredBy, verifiedBy, notes …) — the AI persona answers about fish,
 *    never about people.
 *  - Dates → ISO strings (or null); numbers keep their unit in the name.
 */
import {
  BatchPerformanceResult,
} from '../queries/get-batch-performance.query';
import {
  GrowthAnalysisResult,
} from '../../growth/queries/get-growth-analysis.query';
import {
  MortalityByCauseDetail,
  MortalityByCauseResult,
} from '../queries/get-mortality-by-cause.query';
import {
  TransfersSummaryResult,
  TransferSummaryRecord,
} from '../queries/get-transfers-summary.query';
import { isoOrNull } from '../../common/nats/ai-query-responder';
import { FARM_AI_QUERY_LIMITS } from '@platform/event-contracts';
import { GrowthMeasurement } from '../../growth/entities/growth-measurement.entity';

/** Cap any embedded reply list to the contract's hard ceiling. */
function capList<T>(rows: readonly T[]): { items: T[]; truncated: boolean } {
  const bounded = rows.slice(0, FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT);
  return { items: bounded, truncated: rows.length > bounded.length };
}

// ---------------------------------------------------------------------------
// BATCH_PERFORMANCE
// ---------------------------------------------------------------------------

/** Batch performance DTO — every number keeps its unit in the key. */
export interface BatchPerformanceDto {
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
  weightGainPercent: number;
  totalMortality: number;
  mortalityRate: number;
  survivalRate: number;
  retentionRate: number;
  cullCount: number;
  fcr: { target: number; actual: number; theoretical: number; variance: number; status: string };
  sgr: number;
  daysInProduction: number;
  avgDailyGrowthG: number;
  targetDailyGrowthG: number;
  growthVariancePercent: number;
  totalFeedConsumedKg: number;
  totalFeedCost: number;
  avgDailyFeedKg: number;
  purchaseCost: number;
  totalCost: number;
  costPerKg: number;
  costPerFish: number;
  projectedHarvestDate: string | null;
  projectedHarvestWeightG: number | null;
  daysToHarvest: number | null;
  performanceIndex: number;
  performanceStatus: string;
}

/** Project the batch-performance aggregate (already PII-free handler output). */
export function projectBatchPerformance(
  result: BatchPerformanceResult,
): BatchPerformanceDto {
  return {
    batchId: result.batchId,
    batchNumber: result.batchNumber,
    speciesName: result.speciesName,
    initialQuantity: result.initialQuantity,
    currentQuantity: result.currentQuantity,
    initialBiomassKg: result.initialBiomassKg,
    currentBiomassKg: result.currentBiomassKg,
    initialAvgWeightG: result.initialAvgWeightG,
    currentAvgWeightG: result.currentAvgWeightG,
    weightGainG: result.weightGainG,
    weightGainPercent: result.weightGainPercent,
    totalMortality: result.totalMortality,
    mortalityRate: result.mortalityRate,
    survivalRate: result.survivalRate,
    retentionRate: result.retentionRate,
    cullCount: result.cullCount,
    fcr: { ...result.fcr, status: String(result.fcr.status) },
    sgr: result.sgr,
    daysInProduction: result.daysInProduction,
    avgDailyGrowthG: result.avgDailyGrowthG,
    targetDailyGrowthG: result.targetDailyGrowthG,
    growthVariancePercent: result.growthVariancePercent,
    totalFeedConsumedKg: result.totalFeedConsumedKg,
    totalFeedCost: result.totalFeedCost,
    avgDailyFeedKg: result.avgDailyFeedKg,
    purchaseCost: result.purchaseCost,
    totalCost: result.totalCost,
    costPerKg: result.costPerKg,
    costPerFish: result.costPerFish,
    projectedHarvestDate: isoOrNull(result.projectedHarvestDate),
    projectedHarvestWeightG: result.projectedHarvestWeightG ?? null,
    daysToHarvest: result.daysToHarvest ?? null,
    performanceIndex: result.performanceIndex,
    performanceStatus: String(result.performanceStatus),
  };
}

// ---------------------------------------------------------------------------
// BATCH_MORTALITY_BY_CAUSE
// ---------------------------------------------------------------------------

/** One mortality detail row (date + cause + count + biomass loss). */
export interface MortalityDetailDto {
  date: string;
  cause: string;
  speciesCode: string;
  count: number;
  biomassLossKg: number | null;
}

/** Mortality-by-cause aggregate DTO. */
export interface MortalityByCauseDto {
  totalCount: number;
  byCause: { cause: string; count: number }[];
  details: MortalityDetailDto[];
  /** More detail rows existed than the contract's list cap allows. */
  detailsTruncated: boolean;
  recordCount: number;
}

function projectMortalityDetail(detail: MortalityByCauseDetail): MortalityDetailDto {
  return {
    date: detail.date,
    cause: detail.cause,
    speciesCode: detail.speciesCode,
    count: detail.count,
    biomassLossKg: detail.biomassLossKg ?? null,
  };
}

/** Project the mortality-by-cause aggregate (details capped at 50). */
export function projectMortalityByCause(result: MortalityByCauseResult): MortalityByCauseDto {
  const details = capList(result.details);
  return {
    totalCount: result.totalCount,
    byCause: result.byCause.map((entry) => ({ ...entry })),
    details: details.items.map(projectMortalityDetail),
    detailsTruncated: details.truncated,
    recordCount: result.recordCount,
  };
}

// ---------------------------------------------------------------------------
// BATCH_TRANSFERS_SUMMARY
// ---------------------------------------------------------------------------

/** One cross-site transfer record. */
export interface TransferRecordDto {
  date: string;
  direction: string;
  speciesCode: string;
  fishCount: number;
  biomassKg: number;
  counterparty: string | null;
}

/** Transfers-summary DTO. */
export interface TransfersSummaryDto {
  records: TransferRecordDto[];
  /** More transfer rows existed than the contract's list cap allows. */
  recordsTruncated: boolean;
  recordCount: number;
}

function projectTransferRecord(record: TransferSummaryRecord): TransferRecordDto {
  return {
    date: record.date,
    direction: String(record.direction),
    speciesCode: record.speciesCode,
    fishCount: record.fishCount,
    biomassKg: record.biomassKg,
    counterparty: record.counterparty ?? null,
  };
}

/** Project the cross-site transfers roll-up (records capped at 50). */
export function projectTransfersSummary(result: TransfersSummaryResult): TransfersSummaryDto {
  const records = capList(result.records);
  return {
    records: records.items.map(projectTransferRecord),
    recordsTruncated: records.truncated,
    recordCount: result.recordCount,
  };
}

// ---------------------------------------------------------------------------
// GROWTH_ANALYSIS
// ---------------------------------------------------------------------------

/** Growth-analysis DTO (trend + recommendation rows bounded by the responder). */
export interface GrowthAnalysisDto {
  batchId: string;
  batchNumber: string;
  speciesName: string;
  measurementCount: number;
  daysInProduction: number;
  stockedDate: string | null;
  initialAvgWeightG: number;
  currentAvgWeightG: number;
  targetAvgWeightG: number | null;
  totalWeightGainG: number;
  weightGainPercent: number;
  avgDailyGrowthG: number;
  targetDailyGrowthG: number | null;
  dailyGrowthVariancePercent: number;
  specificGrowthRate: number;
  initialBiomassKg: number;
  currentBiomassKg: number;
  biomassGainKg: number;
  biomassGainPercent: number;
  cumulativeFCR: number;
  targetFCR: number;
  fcrVariancePercent: number;
  fcrTrend: string;
  avgWeightCV: number;
  cvTrend: string;
  needsGrading: boolean;
  overallPerformance: string;
  performanceIndex: number;
  growthTrend: {
    date: string;
    avgWeightG: number;
    theoreticalWeightG: number;
    cv: number;
    sgr: number;
  }[];
  /** More trend points existed than the contract's list cap allows. */
  growthTrendTruncated: boolean;
  projectedHarvestDate: string | null;
  projectedHarvestWeightG: number | null;
  daysToHarvest: number | null;
  recommendations: { priority: string; type: string; description: string }[];
  /** More recommendations existed than the contract's list cap allows. */
  recommendationsTruncated: boolean;
}

/** Project the growth-analysis aggregate (trend + recommendations capped at 50). */
export function projectGrowthAnalysis(result: GrowthAnalysisResult): GrowthAnalysisDto {
  const trend = capList(result.growthTrend);
  const recommendations = capList(result.recommendations);
  return {
    batchId: result.batchId,
    batchNumber: result.batchNumber,
    speciesName: result.speciesName,
    measurementCount: result.measurementCount,
    daysInProduction: result.daysInProduction,
    stockedDate: isoOrNull(result.stockedDate),
    initialAvgWeightG: result.initialAvgWeightG,
    currentAvgWeightG: result.currentAvgWeightG,
    targetAvgWeightG: result.targetAvgWeightG ?? null,
    totalWeightGainG: result.totalWeightGainG,
    weightGainPercent: result.weightGainPercent,
    avgDailyGrowthG: result.avgDailyGrowthG,
    targetDailyGrowthG: result.targetDailyGrowthG ?? null,
    dailyGrowthVariancePercent: result.dailyGrowthVariancePercent,
    specificGrowthRate: result.specificGrowthRate,
    initialBiomassKg: result.initialBiomassKg,
    currentBiomassKg: result.currentBiomassKg,
    biomassGainKg: result.biomassGainKg,
    biomassGainPercent: result.biomassGainPercent,
    cumulativeFCR: result.cumulativeFCR,
    targetFCR: result.targetFCR,
    fcrVariancePercent: result.fcrVariancePercent,
    fcrTrend: String(result.fcrTrend),
    avgWeightCV: result.avgWeightCV,
    cvTrend: String(result.cvTrend),
    needsGrading: result.needsGrading === true,
    overallPerformance: String(result.overallPerformance),
    performanceIndex: result.performanceIndex,
    growthTrend: trend.items.map((point) => ({ ...point })),
    growthTrendTruncated: trend.truncated,
    projectedHarvestDate: isoOrNull(result.projectedHarvestDate),
    projectedHarvestWeightG: result.projectedHarvestWeightG ?? null,
    daysToHarvest: result.daysToHarvest ?? null,
    recommendations: recommendations.items.map((rec) => ({
      priority: String(rec.priority),
      type: rec.type,
      description: rec.description,
    })),
    recommendationsTruncated: recommendations.truncated,
  };
}

// ---------------------------------------------------------------------------
// GROWTH_MEASUREMENTS
// ---------------------------------------------------------------------------

/** One growth measurement row (aggregates only — no per-fish raw data). */
export interface GrowthMeasurementDto {
  id: string;
  batchId: string;
  tankId: string | null;
  measurementDate: string | null;
  measurementType: string;
  sampleSize: number;
  populationSize: number;
  averageWeightG: number;
  averageLengthCm: number | null;
  weightCV: number;
  conditionFactor: number | null;
  performance: string | null;
}

/**
 * Project a growth-measurement row. Strips the sampler identity
 * (measuredBy/verifiedBy), free-text notes and the individual-measurement
 * blob — only the statistical aggregates cross the wire.
 */
export function projectGrowthMeasurement(
  row: Pick<
    GrowthMeasurement,
    | 'id'
    | 'batchId'
    | 'tankId'
    | 'measurementDate'
    | 'measurementType'
    | 'sampleSize'
    | 'populationSize'
    | 'averageWeight'
    | 'averageLength'
    | 'weightCV'
    | 'conditionFactor'
    | 'performance'
  >,
): GrowthMeasurementDto {
  return {
    id: row.id,
    batchId: row.batchId,
    tankId: row.tankId ?? null,
    measurementDate: isoOrNull(row.measurementDate),
    measurementType: String(row.measurementType),
    sampleSize: row.sampleSize,
    populationSize: row.populationSize,
    averageWeightG: row.averageWeight,
    averageLengthCm: row.averageLength ?? null,
    weightCV: row.weightCV,
    conditionFactor: row.conditionFactor ?? null,
    performance: row.performance == null ? null : String(row.performance),
  };
}
