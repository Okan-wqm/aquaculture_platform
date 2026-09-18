/**
 * PURE projections for the feeding farm-AI responder (PR-4, Production
 * specialist). Covers the daily feeding plan, batch/tank feeding summaries,
 * site feed consumption and the feed-protocol catalogue.
 *
 * Rules of the read-only namespace (see common/nats/ai-query-responder.ts):
 *  - Input = the query handler's return shape; output = wire DTO ONLY.
 *  - NO entity metadata (createdAt/updatedAt/tenantId) and NO operator PII.
 *  - Dates → ISO strings (or null); numbers keep their unit in the name.
 */
import {
  DailyFeedingPlanResult,
  PlannedFeeding,
} from '../queries/get-daily-feeding-plan.query';
import { FeedingSummaryResult } from '../queries/get-feeding-summary.query';
import {
  SiteFeedConsumptionResult,
  SiteFeedTypeConsumption,
} from '../queries/get-site-feed-consumption.query';
import { FeedingProtocol } from '../../feed/entities/feeding-protocol.entity';
import { isoOrNull } from '../../common/nats/ai-query-responder';
import { FARM_AI_QUERY_LIMITS } from '@platform/event-contracts';

/** Cap any embedded reply list to the contract's hard ceiling. */
function capList<T>(rows: readonly T[]): { items: T[]; truncated: boolean } {
  const bounded = rows.slice(0, FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT);
  return { items: bounded, truncated: rows.length > bounded.length };
}

// ---------------------------------------------------------------------------
// FEEDING_DAILY_PLAN
// ---------------------------------------------------------------------------

/** One planned feeding entry per tank. */
export interface PlannedFeedingDto {
  batchId: string | null;
  batchCode: string | null;
  tankId: string | null;
  tankCode: string | null;
  feedId: string | null;
  feedName: string | null;
  plannedAmountKg: number;
  actualAmountKg: number;
  mealsPlanned: number;
  mealsCompleted: number;
  isComplete: boolean;
}

function projectPlannedFeeding(entry: PlannedFeeding): PlannedFeedingDto {
  return {
    batchId: entry.batchId || null,
    batchCode: entry.batchCode || null,
    tankId: entry.tankId ?? null,
    tankCode: entry.tankCode ?? null,
    feedId: entry.feedId || null,
    feedName: entry.feedName || null,
    plannedAmountKg: entry.plannedAmountKg,
    actualAmountKg: entry.actualAmountKg,
    mealsPlanned: entry.mealsPlanned,
    mealsCompleted: entry.mealsCompleted,
    isComplete: entry.isComplete === true,
  };
}

/** Daily feeding plan DTO (plannedFeedings capped at 50). */
export interface DailyFeedingPlanDto {
  date: string | null;
  siteId: string;
  plannedFeedings: PlannedFeedingDto[];
  plannedFeedingsTruncated: boolean;
  totalPlannedKg: number;
  totalActualKg: number;
  completionPercent: number;
}

/** Project the daily feeding plan for a site + date. */
export function projectDailyFeedingPlan(
  result: DailyFeedingPlanResult,
): DailyFeedingPlanDto {
  const feedings = capList(result.plannedFeedings);
  return {
    date: isoOrNull(result.date),
    siteId: result.siteId,
    plannedFeedings: feedings.items.map(projectPlannedFeeding),
    plannedFeedingsTruncated: feedings.truncated,
    totalPlannedKg: result.totalPlannedKg,
    totalActualKg: result.totalActualKg,
    completionPercent: result.completionPercent,
  };
}

// ---------------------------------------------------------------------------
// FEEDING_SUMMARY
// ---------------------------------------------------------------------------

/** Batch/tank feeding summary DTO (distributions + trend capped at 50). */
export interface FeedingSummaryDto {
  entityId: string;
  entityType: string;
  entityName: string;
  startDate: string | null;
  endDate: string | null;
  totalFeedingsCount: number;
  totalPlannedKg: number;
  totalActualKg: number;
  totalVarianceKg: number;
  totalWasteKg: number;
  totalFeedCost: number;
  avgDailyFeedingKg: number;
  avgVariancePercent: number;
  avgFeedingDurationMinutes: number;
  appetiteDistribution: {
    excellent: number;
    good: number;
    moderate: number;
    poor: number;
    none: number;
  };
  feedTypeDistribution: {
    feedId: string;
    feedName: string;
    totalKg: number;
    percentage: number;
    cost: number;
  }[];
  dailyTrend: {
    date: string;
    plannedKg: number;
    actualKg: number;
    variancePercent: number;
  }[];
  dailyTrendTruncated: boolean;
}

/** Project the feeding summary for a batch or tank. */
export function projectFeedingSummary(result: FeedingSummaryResult): FeedingSummaryDto {
  const feedTypes = capList(result.feedTypeDistribution);
  const trend = capList(result.dailyTrend);
  return {
    entityId: result.entityId,
    entityType: String(result.entityType),
    entityName: result.entityName,
    startDate: isoOrNull(result.startDate),
    endDate: isoOrNull(result.endDate),
    totalFeedingsCount: result.totalFeedingsCount,
    totalPlannedKg: result.totalPlannedKg,
    totalActualKg: result.totalActualKg,
    totalVarianceKg: result.totalVarianceKg,
    totalWasteKg: result.totalWasteKg,
    totalFeedCost: result.totalFeedCost,
    avgDailyFeedingKg: result.avgDailyFeedingKg,
    avgVariancePercent: result.avgVariancePercent,
    avgFeedingDurationMinutes: result.avgFeedingDuration,
    appetiteDistribution: { ...result.appetiteDistribution },
    feedTypeDistribution: feedTypes.items.map((entry) => ({ ...entry })),
    dailyTrend: trend.items.map((point) => ({ ...point })),
    dailyTrendTruncated: trend.truncated,
  };
}

// ---------------------------------------------------------------------------
// FEEDING_SITE_CONSUMPTION
// ---------------------------------------------------------------------------

/** One feed-type consumption row. */
export interface FeedTypeConsumptionDto {
  feedName: string;
  brandName: string | null;
  quantityKg: number;
}

function projectFeedTypeConsumption(
  entry: SiteFeedTypeConsumption,
): FeedTypeConsumptionDto {
  return {
    feedName: entry.feedName,
    brandName: entry.brandName ?? null,
    quantityKg: entry.quantityKg,
  };
}

/** Site feed consumption DTO (byFeedType capped at 50). */
export interface SiteFeedConsumptionDto {
  totalKg: number;
  byFeedType: FeedTypeConsumptionDto[];
  byFeedTypeTruncated: boolean;
  recordCount: number;
}

/** Project the site-wide feed consumption roll-up. */
export function projectSiteFeedConsumption(
  result: SiteFeedConsumptionResult,
): SiteFeedConsumptionDto {
  const feedTypes = capList(result.byFeedType);
  return {
    totalKg: result.totalKg,
    byFeedType: feedTypes.items.map(projectFeedTypeConsumption),
    byFeedTypeTruncated: feedTypes.truncated,
    recordCount: result.recordCount,
  };
}

// ---------------------------------------------------------------------------
// FEED_PROTOCOLS
// ---------------------------------------------------------------------------

/** Feeding-protocol catalogue row. */
export interface FeedProtocolDto {
  id: string;
  name: string;
  description: string | null;
  feedId: string | null;
  species: string;
  stage: string;
  targetFcr: number | null;
  minDissolvedOxygen: number | null;
  optimalTemperatureC: { min: number | null; max: number | null } | null;
  isActive: boolean;
  isDefault: boolean;
}

/**
 * Project a feeding-protocol row. The structured feeding tables
 * (temperatureRanges/growthStageProtocols/defaultSchedule) stay behind the
 * service surface — the catalogue row carries identity + targets only.
 */
export function projectFeedProtocol(
  row: Pick<
    FeedingProtocol,
    | 'id'
    | 'name'
    | 'description'
    | 'feedId'
    | 'species'
    | 'stage'
    | 'targetFcr'
    | 'minDissolvedOxygen'
    | 'optimalTemperature'
    | 'isActive'
    | 'isDefault'
  >,
): FeedProtocolDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    feedId: row.feedId ?? null,
    species: row.species,
    stage: String(row.stage),
    targetFcr: row.targetFcr ?? null,
    minDissolvedOxygen: row.minDissolvedOxygen ?? null,
    optimalTemperatureC: row.optimalTemperature
      ? {
          min: row.optimalTemperature.min ?? null,
          max: row.optimalTemperature.max ?? null,
        }
      : null,
    isActive: row.isActive === true,
    isDefault: row.isDefault === true,
  };
}
