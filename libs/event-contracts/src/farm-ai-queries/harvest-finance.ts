/**
 * Harvest, regulatory reporting and finance shapes for the farm AI read
 * contract. Commercial fields that identify customers, addresses, prices
 * per contract or approvers are never emitted.
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
  isOptional,
  isRecord,
  isUuidString,
  type AiQueryList,
  type AiQueryRequest,
} from '../farm-ai-queries';

// ── Harvest plans ───────────────────────────────────────────────────────────

export const HARVEST_PLAN_SCOPES = ['upcoming', 'overdue'] as const;
export type HarvestPlanScope = (typeof HARVEST_PLAN_SCOPES)[number];

export interface HarvestPlansRequest extends AiQueryRequest {
  scope: HarvestPlanScope;
  /** Look-ahead window for `upcoming` (ignored for `overdue`). */
  days: number;
  limit: number;
}
export interface HarvestPlanDto {
  id: string;
  planCode: string;
  name: string;
  batchId: string;
  status: string;
  harvestType: string;
  plannedDate: string;
  windowStartDate: string | null;
  windowEndDate: string | null;
  estimatedQuantity: number | null;
  estimatedBiomassKg: number | null;
  estimatedAvgWeightG: number | null;
  actualBiomassKg: number | null;
}
export type HarvestPlansReply = AiQueryList<HarvestPlanDto>;
export function isHarvestPlansRequest(value: unknown): value is HarvestPlansRequest {
  return (
    isAiQueryRequestShape(value, ['scope', 'days', 'limit']) &&
    (HARVEST_PLAN_SCOPES as readonly string[]).includes(value['scope'] as string) &&
    isBoundedInt(value['days'], 1, 180) &&
    isBoundedInt(value['limit'], 1, 50)
  );
}
export function isHarvestPlanDto(value: unknown): value is HarvestPlanDto {
  return (
    isRecord(value) &&
    isUuidString(value['id']) &&
    typeof value['planCode'] === 'string' &&
    typeof value['batchId'] === 'string' &&
    typeof value['status'] === 'string' &&
    isIsoDateString(value['plannedDate']) &&
    isNullableNumber(value['estimatedBiomassKg'])
  );
}
export function isHarvestPlansReply(value: unknown): value is HarvestPlansReply {
  return isAiQueryList(value, isHarvestPlanDto);
}

export type HarvestPlanStatsRequest = AiQueryRequest;
export interface HarvestPlanStatsReply {
  total: number;
  draft: number;
  planned: number;
  approved: number;
  scheduled: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  postponed: number;
  totalEstimatedBiomassKg: number;
  totalActualBiomassKg: number;
  upcomingCount: number;
  overdueCount: number;
}
export function isHarvestPlanStatsRequest(value: unknown): value is HarvestPlanStatsRequest {
  return isAiQueryRequestShape(value, []);
}
export function isHarvestPlanStatsReply(value: unknown): value is HarvestPlanStatsReply {
  return (
    isRecord(value) &&
    typeof value['total'] === 'number' &&
    typeof value['upcomingCount'] === 'number' &&
    typeof value['overdueCount'] === 'number' &&
    typeof value['totalEstimatedBiomassKg'] === 'number'
  );
}

// ── Regulatory: biomass report + submissions ────────────────────────────────

export interface BiomassReportRequest extends AiQueryRequest {
  siteId: string;
  reportMonth: number;
  reportYear: number;
}
export interface BiomassReportReply {
  found: boolean;
  siteId: string;
  reportMonth: number;
  reportYear: number;
  status: string | null;
  totalBiomassKg: number | null;
  currentBiomassBySpecies: Array<{
    speciesName: string;
    fishCount: number;
    biomassKg: number;
    avgWeightG: number;
  }>;
  mortalityTotalCount: number | null;
  slaughterTotalBiomassKg: number | null;
  feedConsumptionTotalKg: number | null;
  submittedAt: string | null;
}
export function isBiomassReportRequest(value: unknown): value is BiomassReportRequest {
  return (
    isAiQueryRequestShape(value, ['siteId', 'reportMonth', 'reportYear']) &&
    isUuidString(value['siteId']) &&
    isBoundedInt(value['reportMonth'], 1, 12) &&
    isBoundedInt(value['reportYear'], 2000, 2100)
  );
}
export function isBiomassReportReply(value: unknown): value is BiomassReportReply {
  return (
    isRecord(value) &&
    typeof value['found'] === 'boolean' &&
    typeof value['siteId'] === 'string' &&
    isNullableString(value['status']) &&
    isNullableNumber(value['totalBiomassKg']) &&
    Array.isArray(value['currentBiomassBySpecies'])
  );
}

export const REGULATORY_REPORT_TYPES = [
  'SEA_LICE',
  'CLEANER_FISH',
  'SMOLT',
  'SLAUGHTER_PLANNED',
  'SLAUGHTER_EXECUTED',
  'WELFARE_EVENT',
  'ESCAPE',
  'DISEASE_OUTBREAK',
] as const;
export type RegulatoryReportTypeCode = (typeof REGULATORY_REPORT_TYPES)[number];

export interface RegulatoryReportsRequest extends AiQueryRequest {
  reportType: RegulatoryReportTypeCode;
  siteId?: string;
  limit: number;
}
export interface RegulatoryReportDto {
  id: string;
  reportType: string;
  siteId: string | null;
  reportYear: number | null;
  reportWeek: number | null;
  reportMonth: number | null;
  status: string;
  submittedAt: string | null;
  attemptCount: number;
  failureClass: string | null;
}
export type RegulatoryReportsReply = AiQueryList<RegulatoryReportDto>;
export function isRegulatoryReportsRequest(value: unknown): value is RegulatoryReportsRequest {
  return (
    isAiQueryRequestShape(value, ['reportType', 'siteId', 'limit']) &&
    (REGULATORY_REPORT_TYPES as readonly string[]).includes(value['reportType'] as string) &&
    isOptional(value['siteId'], isUuidString) &&
    isBoundedInt(value['limit'], 1, 50)
  );
}
export function isRegulatoryReportDto(value: unknown): value is RegulatoryReportDto {
  return (
    isRecord(value) &&
    isUuidString(value['id']) &&
    typeof value['reportType'] === 'string' &&
    typeof value['status'] === 'string' &&
    typeof value['attemptCount'] === 'number' &&
    isNullableString(value['submittedAt'])
  );
}
export function isRegulatoryReportsReply(value: unknown): value is RegulatoryReportsReply {
  return isAiQueryList(value, isRegulatoryReportDto);
}

// ── Finance ─────────────────────────────────────────────────────────────────

export const FINANCE_GRANULARITIES = ['DAY', 'WEEK', 'MONTH', 'YEAR'] as const;
export type FinanceGranularityCode = (typeof FINANCE_GRANULARITIES)[number];

export interface FinanceSummaryRequest extends AiQueryRequest {
  fromDate: string;
  toDate: string;
  granularity: FinanceGranularityCode;
}
export interface FinanceSummaryReply {
  fromDate: string;
  toDate: string;
  granularity: FinanceGranularityCode;
  currency: string;
  totalExpense: number;
  totalRevenue: number;
  netResult: number;
  byCategory: Array<{
    categoryCode: string | null;
    categoryName: string;
    kind: string;
    total: number;
  }>;
  byCategoryTruncated: boolean;
  series: Array<{ bucketStart: string; totalExpense: number; totalRevenue: number }>;
  seriesTruncated: boolean;
}
export function isFinanceSummaryRequest(value: unknown): value is FinanceSummaryRequest {
  return (
    isAiQueryRequestShape(value, ['fromDate', 'toDate', 'granularity']) &&
    isBoundedDateRange(value['fromDate'], value['toDate'], FARM_AI_QUERY_LIMITS.MAX_RANGE_DAYS) &&
    (FINANCE_GRANULARITIES as readonly string[]).includes(value['granularity'] as string)
  );
}
export function isFinanceSummaryReply(value: unknown): value is FinanceSummaryReply {
  return (
    isRecord(value) &&
    typeof value['currency'] === 'string' &&
    typeof value['totalExpense'] === 'number' &&
    typeof value['totalRevenue'] === 'number' &&
    typeof value['netResult'] === 'number' &&
    Array.isArray(value['byCategory']) &&
    Array.isArray(value['series'])
  );
}

export interface FinanceBatchTotalsRequest extends AiQueryRequest {
  fromDate: string;
  toDate: string;
  limit: number;
}
export interface FinanceBatchTotalDto {
  batchId: string;
  totalExpense: number;
  totalRevenue: number;
  netResult: number;
}
export type FinanceBatchTotalsReply = AiQueryList<FinanceBatchTotalDto>;
export function isFinanceBatchTotalsRequest(value: unknown): value is FinanceBatchTotalsRequest {
  return (
    isAiQueryRequestShape(value, ['fromDate', 'toDate', 'limit']) &&
    isBoundedDateRange(value['fromDate'], value['toDate'], FARM_AI_QUERY_LIMITS.MAX_RANGE_DAYS) &&
    isBoundedInt(value['limit'], 1, 50)
  );
}
export function isFinanceBatchTotalDto(value: unknown): value is FinanceBatchTotalDto {
  return (
    isRecord(value) &&
    typeof value['batchId'] === 'string' &&
    typeof value['totalExpense'] === 'number' &&
    typeof value['totalRevenue'] === 'number' &&
    typeof value['netResult'] === 'number'
  );
}
export function isFinanceBatchTotalsReply(value: unknown): value is FinanceBatchTotalsReply {
  return isAiQueryList(value, isFinanceBatchTotalDto);
}
