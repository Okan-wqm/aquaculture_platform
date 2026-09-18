/**
 * Reply-data guards for the 17 PR-4 Production specialist farm-AI query
 * tools. farm-service already projects these shapes
 * (apps/farm-service/src/{batch,feeding,species,tank,harvest,regulatory,finance}/responders/projections.ts);
 * the guards are the ai-service side's defense-in-depth so a drifted
 * projection fails loudly instead of feeding the model an unexpected shape.
 */
import { AiQueryList, isAiQueryList } from '@platform/event-contracts';

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNum(v: Rec, key: string): boolean {
  return typeof v[key] === 'number';
}

function hasNullableNum(v: Rec, key: string): boolean {
  return v[key] === null || v[key] === undefined || typeof v[key] === 'number';
}

function hasStr(v: Rec, key: string): boolean {
  return typeof v[key] === 'string';
}

function hasNullableStr(v: Rec, key: string): boolean {
  return v[key] === null || v[key] === undefined || typeof v[key] === 'string';
}

function hasBool(v: Rec, key: string): boolean {
  return typeof v[key] === 'boolean';
}

function hasNumRecord(v: Rec, key: string): boolean {
  return isRec(v[key]);
}

/** List-reply combinator: bounded list whose items all pass `isItem`. */
export function isAiListOf<T>(
  isItem: (value: unknown) => value is T,
): (value: unknown) => value is AiQueryList<T> {
  return (value: unknown): value is AiQueryList<T> =>
    isAiQueryList(value) && value.items.every(isItem);
}

// --- batch / growth replies -------------------------------------------------

export interface BatchPerformanceReply {
  batchId: string;
  batchNumber: string;
  speciesName: string;
  currentQuantity: number;
  currentBiomassKg: number;
  currentAvgWeightG: number;
  survivalRate: number;
  fcr: { actual: number; target: number; status: string };
  sgr: number;
  performanceIndex: number;
  performanceStatus: string;
  projectedHarvestDate: string | null;
}

export function isBatchPerformance(value: unknown): value is BatchPerformanceReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'batchId') || !hasStr(value, 'batchNumber')) return false;
  if (!hasStr(value, 'speciesName') || !hasStr(value, 'performanceStatus')) return false;
  if (
    !hasNum(value, 'currentQuantity') ||
    !hasNum(value, 'currentBiomassKg') ||
    !hasNum(value, 'currentAvgWeightG') ||
    !hasNum(value, 'survivalRate') ||
    !hasNum(value, 'sgr') ||
    !hasNum(value, 'performanceIndex')
  ) {
    return false;
  }
  if (!hasNullableStr(value, 'projectedHarvestDate')) return false;
  return isRec(value.fcr) && hasNum(value.fcr, 'actual') && hasStr(value.fcr, 'status');
}

export interface GrowthAnalysisReply {
  batchId: string;
  batchNumber: string;
  speciesName: string;
  currentAvgWeightG: number;
  avgDailyGrowthG: number;
  specificGrowthRate: number;
  cumulativeFCR: number;
  avgWeightCV: number;
  needsGrading: boolean;
  overallPerformance: string;
  performanceIndex: number;
  growthTrend: unknown[];
  recommendations: unknown[];
}

export function isGrowthAnalysis(value: unknown): value is GrowthAnalysisReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'batchId') || !hasStr(value, 'speciesName')) return false;
  if (!hasStr(value, 'overallPerformance')) return false;
  if (
    !hasNum(value, 'currentAvgWeightG') ||
    !hasNum(value, 'avgDailyGrowthG') ||
    !hasNum(value, 'specificGrowthRate') ||
    !hasNum(value, 'cumulativeFCR') ||
    !hasNum(value, 'avgWeightCV') ||
    !hasNum(value, 'performanceIndex')
  ) {
    return false;
  }
  if (!hasBool(value, 'needsGrading')) return false;
  return Array.isArray(value.growthTrend) && Array.isArray(value.recommendations);
}

export interface GrowthMeasurementReply {
  id: string;
  batchId: string;
  measurementDate: string | null;
  measurementType: string;
  sampleSize: number;
  averageWeightG: number;
  weightCV: number;
  performance: string | null;
}

export function isGrowthMeasurement(value: unknown): value is GrowthMeasurementReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'id') || !hasStr(value, 'batchId') || !hasStr(value, 'measurementType')) {
    return false;
  }
  if (!hasNullableStr(value, 'measurementDate') || !hasNullableStr(value, 'performance')) {
    return false;
  }
  return (
    hasNum(value, 'sampleSize') && hasNum(value, 'averageWeightG') && hasNum(value, 'weightCV')
  );
}

export interface MortalityByCauseReply {
  totalCount: number;
  byCause: { cause: string; count: number }[];
  details: { date: string; cause: string; count: number }[];
  detailsTruncated: boolean;
  recordCount: number;
}

export function isMortalityByCause(value: unknown): value is MortalityByCauseReply {
  if (!isRec(value)) return false;
  if (!hasNum(value, 'totalCount') || !hasNum(value, 'recordCount')) return false;
  if (!hasBool(value, 'detailsTruncated')) return false;
  if (!Array.isArray(value.byCause) || !Array.isArray(value.details)) return false;
  return value.byCause.every(
    (entry) => isRec(entry) && hasStr(entry, 'cause') && hasNum(entry, 'count'),
  );
}

export interface TransfersSummaryReply {
  records: {
    date: string;
    direction: string;
    speciesCode: string;
    fishCount: number;
    biomassKg: number;
  }[];
  recordsTruncated: boolean;
  recordCount: number;
}

export function isTransfersSummary(value: unknown): value is TransfersSummaryReply {
  if (!isRec(value)) return false;
  if (!hasNum(value, 'recordCount') || !hasBool(value, 'recordsTruncated')) return false;
  if (!Array.isArray(value.records)) return false;
  return value.records.every(
    (entry) =>
      isRec(entry) &&
      hasStr(entry, 'date') &&
      hasStr(entry, 'direction') &&
      hasNum(entry, 'fishCount') &&
      hasNum(entry, 'biomassKg'),
  );
}

// --- feeding replies --------------------------------------------------------

export interface DailyFeedingPlanReply {
  date: string | null;
  siteId: string;
  plannedFeedings: unknown[];
  plannedFeedingsTruncated: boolean;
  totalPlannedKg: number;
  totalActualKg: number;
  completionPercent: number;
}

export function isDailyFeedingPlan(value: unknown): value is DailyFeedingPlanReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'siteId') || !hasNullableStr(value, 'date')) return false;
  if (!hasBool(value, 'plannedFeedingsTruncated')) return false;
  return (
    Array.isArray(value.plannedFeedings) &&
    hasNum(value, 'totalPlannedKg') &&
    hasNum(value, 'totalActualKg') &&
    hasNum(value, 'completionPercent')
  );
}

export interface FeedingSummaryReply {
  entityId: string;
  entityType: string;
  entityName: string;
  startDate: string | null;
  endDate: string | null;
  totalActualKg: number;
  totalPlannedKg: number;
  totalVarianceKg: number;
  avgDailyFeedingKg: number;
  appetiteDistribution: Record<string, number>;
  feedTypeDistribution: unknown[];
  dailyTrend: unknown[];
  dailyTrendTruncated: boolean;
}

export function isFeedingSummary(value: unknown): value is FeedingSummaryReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'entityId') || !hasStr(value, 'entityType')) return false;
  if (!hasStr(value, 'entityName')) return false;
  if (!hasNullableStr(value, 'startDate') || !hasNullableStr(value, 'endDate')) return false;
  if (
    !hasNum(value, 'totalActualKg') ||
    !hasNum(value, 'totalPlannedKg') ||
    !hasNum(value, 'totalVarianceKg') ||
    !hasNum(value, 'avgDailyFeedingKg')
  ) {
    return false;
  }
  if (!hasNumRecord(value, 'appetiteDistribution')) return false;
  if (!hasBool(value, 'dailyTrendTruncated')) return false;
  return Array.isArray(value.feedTypeDistribution) && Array.isArray(value.dailyTrend);
}

export interface SiteFeedConsumptionReply {
  totalKg: number;
  byFeedType: { feedName: string; quantityKg: number }[];
  byFeedTypeTruncated: boolean;
  recordCount: number;
}

export function isSiteFeedConsumption(value: unknown): value is SiteFeedConsumptionReply {
  if (!isRec(value)) return false;
  if (!hasNum(value, 'totalKg') || !hasNum(value, 'recordCount')) return false;
  if (!hasBool(value, 'byFeedTypeTruncated')) return false;
  if (!Array.isArray(value.byFeedType)) return false;
  return value.byFeedType.every(
    (entry) => isRec(entry) && hasStr(entry, 'feedName') && hasNum(entry, 'quantityKg'),
  );
}

export interface FeedProtocolReply {
  id: string;
  name: string;
  species: string;
  stage: string;
  targetFcr: number | null;
  isActive: boolean;
  isDefault: boolean;
}

export function isFeedProtocol(value: unknown): value is FeedProtocolReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'id') || !hasStr(value, 'name') || !hasStr(value, 'species')) return false;
  if (!hasStr(value, 'stage')) return false;
  if (!hasNullableNum(value, 'targetFcr')) return false;
  return hasBool(value, 'isActive') && hasBool(value, 'isDefault');
}

// --- species / tank replies -------------------------------------------------

export interface SpeciesReply {
  id: string;
  scientificName: string;
  commonName: string;
  code: string;
  category: string;
  waterType: string;
  status: string;
  isActive: boolean;
}

export function isSpecies(value: unknown): value is SpeciesReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'id') || !hasStr(value, 'scientificName') || !hasStr(value, 'commonName')) {
    return false;
  }
  if (!hasStr(value, 'code') || !hasStr(value, 'category') || !hasStr(value, 'waterType')) {
    return false;
  }
  return hasStr(value, 'status') && hasBool(value, 'isActive');
}

export interface TankCapacityReply {
  tankId: string;
  tankCode: string;
  tankName: string;
  volumeM3: number;
  maxCapacityKg: number;
  currentBiomassKg: number;
  currentDensityKgM3: number;
  capacityUsedPercent: number;
  densityStatus: string;
  capacityStatus: string;
  warnings: string[];
}

export function isTankCapacity(value: unknown): value is TankCapacityReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'tankId') || !hasStr(value, 'tankCode') || !hasStr(value, 'tankName')) {
    return false;
  }
  if (!hasStr(value, 'densityStatus') || !hasStr(value, 'capacityStatus')) return false;
  if (
    !hasNum(value, 'volumeM3') ||
    !hasNum(value, 'maxCapacityKg') ||
    !hasNum(value, 'currentBiomassKg') ||
    !hasNum(value, 'currentDensityKgM3') ||
    !hasNum(value, 'capacityUsedPercent')
  ) {
    return false;
  }
  return Array.isArray(value.warnings);
}

// --- harvest replies --------------------------------------------------------

export interface HarvestPlanReply {
  id: string;
  planCode: string;
  name: string;
  batchId: string;
  status: string;
  harvestType: string;
  productForm: string;
  plannedDate: string | null;
  estimates: { estimatedQuantity: number; estimatedBiomassKg: number };
}

export function isHarvestPlan(value: unknown): value is HarvestPlanReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'id') || !hasStr(value, 'planCode') || !hasStr(value, 'name')) return false;
  if (!hasStr(value, 'batchId') || !hasStr(value, 'status')) return false;
  if (!hasStr(value, 'harvestType') || !hasStr(value, 'productForm')) return false;
  if (!hasNullableStr(value, 'plannedDate')) return false;
  return (
    isRec(value.estimates) &&
    hasNum(value.estimates, 'estimatedQuantity') &&
    hasNum(value.estimates, 'estimatedBiomassKg')
  );
}

export interface HarvestPlanStatsReply {
  total: number;
  upcomingCount: number;
  overdueCount: number;
  totalEstimatedBiomass: number;
  totalActualBiomass: number;
}

export function isHarvestPlanStats(value: unknown): value is HarvestPlanStatsReply {
  if (!isRec(value)) return false;
  return (
    hasNum(value, 'total') &&
    hasNum(value, 'upcomingCount') &&
    hasNum(value, 'overdueCount') &&
    hasNum(value, 'totalEstimatedBiomass') &&
    hasNum(value, 'totalActualBiomass')
  );
}

// --- regulatory replies -----------------------------------------------------

export interface BiomassReportReply {
  id: string;
  siteId: string;
  reportMonth: number;
  reportYear: number;
  status: string;
  totalBiomassKg: number;
  currentBiomass: { totalKg: number };
  mortality: { totalCount: number };
  feedConsumption: { totalKg: number };
}

/** The monthly report is legitimately nullable (absent month). */
export function isBiomassReportOrNull(
  value: unknown,
): value is BiomassReportReply | null {
  if (value === null || value === undefined) return true;
  if (!isRec(value)) return false;
  if (!hasStr(value, 'id') || !hasStr(value, 'siteId') || !hasStr(value, 'status')) return false;
  if (!hasNum(value, 'reportMonth') || !hasNum(value, 'reportYear')) return false;
  if (!hasNum(value, 'totalBiomassKg')) return false;
  return (
    isRec(value.currentBiomass) &&
    hasNum(value.currentBiomass, 'totalKg') &&
    isRec(value.mortality) &&
    hasNum(value.mortality, 'totalCount') &&
    isRec(value.feedConsumption) &&
    hasNum(value.feedConsumption, 'totalKg')
  );
}

export interface RegulatoryReportReply {
  id: string;
  reportType: string;
  klientReferanse: string;
  status: string;
  lokalitetsnummer: number;
  attemptCount: number;
  submittedAt: string | null;
}

export function isRegulatoryReport(value: unknown): value is RegulatoryReportReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'id') || !hasStr(value, 'reportType') || !hasStr(value, 'status')) {
    return false;
  }
  if (!hasStr(value, 'klientReferanse')) return false;
  if (!hasNum(value, 'lokalitetsnummer') || !hasNum(value, 'attemptCount')) return false;
  return hasNullableStr(value, 'submittedAt');
}

// --- finance replies --------------------------------------------------------

export interface FinanceSummaryReply {
  currency: string;
  totalExpense: number;
  totalRevenue: number;
  netResult: number;
  byCategory: unknown[];
  byCategoryTruncated: boolean;
  series: unknown[];
  seriesTruncated: boolean;
}

export function isFinanceSummary(value: unknown): value is FinanceSummaryReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'currency')) return false;
  if (
    !hasNum(value, 'totalExpense') ||
    !hasNum(value, 'totalRevenue') ||
    !hasNum(value, 'netResult')
  ) {
    return false;
  }
  if (!hasBool(value, 'byCategoryTruncated') || !hasBool(value, 'seriesTruncated')) {
    return false;
  }
  return Array.isArray(value.byCategory) && Array.isArray(value.series);
}

export interface FinanceBatchTotalReply {
  batchId: string;
  totalExpense: number;
  totalRevenue: number;
}

export function isFinanceBatchTotal(value: unknown): value is FinanceBatchTotalReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'batchId')) return false;
  return hasNum(value, 'totalExpense') && hasNum(value, 'totalRevenue');
}
