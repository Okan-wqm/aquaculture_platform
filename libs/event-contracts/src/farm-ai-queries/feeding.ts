/**
 * Feeding shapes for the farm AI read contract: daily plan, per-entity
 * summary, site consumption and feeding protocols.
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

// ── Daily feeding plan ──────────────────────────────────────────────────────

export interface DailyFeedingPlanRequest extends AiQueryRequest {
  siteId: string;
  date: string;
  departmentId?: string;
}
export interface PlannedFeedingDto {
  batchId: string;
  batchCode: string;
  tankId: string | null;
  tankCode: string | null;
  feedId: string;
  feedName: string;
  plannedAmountKg: number;
  actualAmountKg: number;
  mealsPlanned: number;
  mealsCompleted: number;
  isComplete: boolean;
}
export interface DailyFeedingPlanReply {
  date: string;
  siteId: string;
  totalPlannedKg: number;
  totalActualKg: number;
  completionPct: number;
  plannedFeedings: PlannedFeedingDto[];
  truncated: boolean;
}
export function isDailyFeedingPlanRequest(value: unknown): value is DailyFeedingPlanRequest {
  return (
    isAiQueryRequestShape(value, ['siteId', 'date', 'departmentId']) &&
    isUuidString(value['siteId']) &&
    isIsoDateString(value['date']) &&
    isOptional(value['departmentId'], isUuidString)
  );
}
export function isDailyFeedingPlanReply(value: unknown): value is DailyFeedingPlanReply {
  return (
    isRecord(value) &&
    isIsoDateString(value['date']) &&
    typeof value['siteId'] === 'string' &&
    typeof value['totalPlannedKg'] === 'number' &&
    typeof value['completionPct'] === 'number' &&
    Array.isArray(value['plannedFeedings']) &&
    typeof value['truncated'] === 'boolean'
  );
}

// ── Feeding summary ─────────────────────────────────────────────────────────

export const FEEDING_ENTITY_TYPES = ['batch', 'tank'] as const;
export type FeedingEntityType = (typeof FEEDING_ENTITY_TYPES)[number];

export interface FeedingSummaryRequest extends AiQueryRequest {
  entityType: FeedingEntityType;
  entityId: string;
  fromDate?: string;
  toDate?: string;
}
export interface FeedingSummaryReply {
  entityId: string;
  entityType: FeedingEntityType;
  entityName: string;
  startDate: string;
  endDate: string;
  totalFeedingsCount: number;
  totalPlannedKg: number;
  totalActualKg: number;
  totalVarianceKg: number;
  totalWasteKg: number;
  totalFeedCost: number;
  avgDailyFeedingKg: number;
  avgVariancePct: number;
  appetiteDistribution: {
    excellent: number;
    good: number;
    moderate: number;
    poor: number;
    none: number;
  };
  feedTypeDistribution: Array<{
    feedId: string;
    feedName: string;
    totalKg: number;
    pct: number;
    cost: number;
  }>;
  dailyTrend: Array<{ date: string; plannedKg: number; actualKg: number; variancePct: number }>;
  dailyTrendTruncated: boolean;
}
export function isFeedingSummaryRequest(value: unknown): value is FeedingSummaryRequest {
  if (
    !isAiQueryRequestShape(value, ['entityType', 'entityId', 'fromDate', 'toDate']) ||
    !(FEEDING_ENTITY_TYPES as readonly string[]).includes(value['entityType'] as string) ||
    !isUuidString(value['entityId']) ||
    !isOptional(value['fromDate'], isIsoDateString) ||
    !isOptional(value['toDate'], isIsoDateString)
  ) {
    return false;
  }
  if (value['fromDate'] !== undefined && value['toDate'] !== undefined) {
    return isBoundedDateRange(
      value['fromDate'],
      value['toDate'],
      FARM_AI_QUERY_LIMITS.MAX_RANGE_DAYS,
    );
  }
  return true;
}
export function isFeedingSummaryReply(value: unknown): value is FeedingSummaryReply {
  return (
    isRecord(value) &&
    typeof value['entityId'] === 'string' &&
    typeof value['totalActualKg'] === 'number' &&
    isRecord(value['appetiteDistribution']) &&
    Array.isArray(value['feedTypeDistribution']) &&
    Array.isArray(value['dailyTrend']) &&
    typeof value['dailyTrendTruncated'] === 'boolean'
  );
}

// ── Site feed consumption ───────────────────────────────────────────────────

export interface SiteFeedConsumptionReply {
  siteId: string;
  fromDate: string;
  toDate: string;
  totalKg: number;
  recordCount: number;
  byFeedType: Array<{ feedName: string; brandName: string | null; quantityKg: number }>;
}
export function isSiteFeedConsumptionReply(value: unknown): value is SiteFeedConsumptionReply {
  return (
    isRecord(value) &&
    typeof value['siteId'] === 'string' &&
    typeof value['totalKg'] === 'number' &&
    typeof value['recordCount'] === 'number' &&
    Array.isArray(value['byFeedType'])
  );
}

// ── Feeding protocols ───────────────────────────────────────────────────────

export interface FeedingProtocolsRequest extends AiQueryRequest {
  species?: string;
  limit: number;
}
export interface FeedingProtocolDto {
  id: string;
  name: string;
  species: string;
  stage: string;
  feedId: string | null;
  targetFcr: number | null;
  minDissolvedOxygenMgL: number | null;
  isActive: boolean;
  isDefault: boolean;
}
export type FeedingProtocolsReply = AiQueryList<FeedingProtocolDto>;
export function isFeedingProtocolsRequest(value: unknown): value is FeedingProtocolsRequest {
  return (
    isAiQueryRequestShape(value, ['species', 'limit']) &&
    isOptional(value['species'], (v): v is string => typeof v === 'string' && v.length <= 64) &&
    isBoundedInt(value['limit'], 1, 50)
  );
}
export function isFeedingProtocolDto(value: unknown): value is FeedingProtocolDto {
  return (
    isRecord(value) &&
    isUuidString(value['id']) &&
    typeof value['name'] === 'string' &&
    typeof value['species'] === 'string' &&
    typeof value['stage'] === 'string' &&
    isNullableString(value['feedId']) &&
    isNullableNumber(value['targetFcr']) &&
    typeof value['isActive'] === 'boolean'
  );
}
export function isFeedingProtocolsReply(value: unknown): value is FeedingProtocolsReply {
  return isAiQueryList(value, isFeedingProtocolDto);
}
