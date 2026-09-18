/**
 * Farm AI read-only query contracts (request/reply — NOT BaseEvent envelopes).
 *
 * PR-3 (FARM-AI program): ai-service's farm personas call farm-service over
 * NATS request-reply to GROUND their answers in live farm data. This file is
 * the single source of truth for the `request.farm.ai.<op>` subject space,
 * the shared `{ ok, data | error }` reply envelope, the bounded list shape,
 * and the runtime request guards each responder validates BEFORE any CQRS
 * query runs.
 *
 * Security posture (deliberate):
 *  - READ-ONLY. Every subject maps to a farm-service CQRS *query* (never a
 *    command); responders must not touch the DB directly.
 *  - NO PII. Reply data is projected by pure functions that strip every
 *    operator identity field (reportedBy, vet, notes, attachments, …) — the
 *    AI persona answers about water and fish, never about people.
 *  - Tenant-pin. `tenantId` is server-populated from the verified execution
 *    context on the ai-service side and re-validated here; a model-supplied
 *    tenant can never steer the read.
 *
 * Subject naming follows the established `request.<service>.<area>.<op>`
 * request/reply pattern (see auth-user-queries.ts / tenant-commands.ts).
 */

/**
 * All farm-AI query subjects. PR-3 implemented the first 13 (Water & Health
 * specialist); PR-4 (Production, 17) and PR-5 (Operations, 10) implement the
 * rest — every key below now has a responder, a request guard, and an
 * explicit ACL entry in infrastructure/nats/services.yaml.
 */
export const FARM_AI_QUERY_SUBJECTS = {
  // --- PR-3: Water & Health specialist (implemented) ----------------------
  WQ_TANK_STATS: 'request.farm.ai.getTankWaterQualityStats',
  WQ_SYSTEM_STATS: 'request.farm.ai.getSystemWaterQualityStats',
  WQ_HISTORY: 'request.farm.ai.getWaterQualityHistory',
  WQ_CRITICAL: 'request.farm.ai.listCriticalWaterQuality',
  WQ_THRESHOLDS: 'request.farm.ai.getWaterQualityThresholds',
  FH_STATS: 'request.farm.ai.getFishHealthStats',
  FH_EVENTS: 'request.farm.ai.listHealthEvents',
  FH_CRITICAL: 'request.farm.ai.listCriticalHealthEvents',
  FH_OVERDUE_FOLLOW_UPS: 'request.farm.ai.listOverdueHealthFollowUps',
  FH_LICE_COUNTS: 'request.farm.ai.listLiceCounts',
  FH_TREATMENTS: 'request.farm.ai.listTreatmentApplications',
  FH_WELFARE: 'request.farm.ai.listWelfareAssessments',
  FH_HARVEST_ELIGIBILITY: 'request.farm.ai.checkBatchHarvestEligibility',
  // --- PR-4: Production specialist (implemented) ---------------------------
  BATCH_PERFORMANCE: 'request.farm.ai.getBatchPerformance',
  BATCH_MORTALITY_BY_CAUSE: 'request.farm.ai.getBatchMortalityByCause',
  BATCH_TRANSFERS_SUMMARY: 'request.farm.ai.getBatchTransfersSummary',
  GROWTH_ANALYSIS: 'request.farm.ai.getGrowthAnalysis',
  GROWTH_MEASUREMENTS: 'request.farm.ai.listGrowthMeasurements',
  FEEDING_DAILY_PLAN: 'request.farm.ai.getFeedingDailyPlan',
  FEEDING_SUMMARY: 'request.farm.ai.getFeedingSummary',
  FEEDING_SITE_CONSUMPTION: 'request.farm.ai.getFeedingSiteConsumption',
  FEED_PROTOCOLS: 'request.farm.ai.listFeedProtocols',
  SPECIES_LIST: 'request.farm.ai.listSpecies',
  TANK_CAPACITY: 'request.farm.ai.getTankCapacity',
  HARVEST_PLANS: 'request.farm.ai.listHarvestPlans',
  HARVEST_PLAN_STATS: 'request.farm.ai.getHarvestPlanStats',
  REG_BIOMASS_REPORT: 'request.farm.ai.getRegulatoryBiomassReport',
  REG_REPORTS: 'request.farm.ai.listRegulatoryReports',
  FINANCE_SUMMARY: 'request.farm.ai.getFinanceSummary',
  FINANCE_BATCH_TOTALS: 'request.farm.ai.getFinanceBatchTotals',
  // --- PR-5: Operations specialist (implemented) ---------------------------
  MAINT_OVERDUE_WORK_ORDERS: 'request.farm.ai.listOverdueWorkOrders',
  MAINT_WORK_ORDER_STATS: 'request.farm.ai.getWorkOrderStats',
  MAINT_SCHEDULE_ALERTS: 'request.farm.ai.listMaintenanceScheduleAlerts',
  MAINT_LOW_STOCK: 'request.farm.ai.listLowStockParts',
  MAINT_STOCK_SUMMARY: 'request.farm.ai.getSpareStockSummary',
  EQUIPMENT_LIST: 'request.farm.ai.listEquipment',
  EQUIPMENT_FEEDER_CALIBRATIONS: 'request.farm.ai.listFeederCalibrations',
  FARM_STOCK_INVENTORY: 'request.farm.ai.getFarmStockInventory',
  TASKS_TODAY: 'request.farm.ai.listTasksToday',
  TASK_STATS: 'request.farm.ai.getTaskStats',
} as const;

export type FarmAiQuerySubject =
  (typeof FARM_AI_QUERY_SUBJECTS)[keyof typeof FARM_AI_QUERY_SUBJECTS];

/**
 * Hard bounds shared by every farm-AI list/stat query. Reply payloads cross
 * into an LLM context window — an unbounded list is both a prompt-size and a
 * data-exfiltration multiplier, so the responder clamps every list.
 */
export const FARM_AI_QUERY_LIMITS = {
  /** Applied when the request carries no usable `limit`. */
  DEFAULT_LIST_LIMIT: 20,
  /** Hard ceiling for any one reply list. */
  MAX_LIST_LIMIT: 50,
  /** Trailing-window stats (days) ceiling. */
  MAX_STAT_DAYS: 90,
  /** Date-range query (days) ceiling. */
  MAX_RANGE_DAYS: 366,
  /** Forward-looking "upcoming" query (days) ceiling. */
  MAX_UPCOMING_DAYS: 180,
} as const;

/**
 * Every request starts with the tenant pin. Populated by ai-service from the
 * verified execution context (NEVER from the model) and re-validated by the
 * farm-service responder before any query runs.
 */
export interface AiQueryRequest {
  tenantId: string;
}

/**
 * Reply envelope: `{ ok: true, data }` or `{ ok: false, error }`. Responders
 * NEVER reply with a bare array/object and NEVER let an exception escape as
 * a transport error — the model sees a stable, machine-checkable shape.
 */
export type AiQueryReply<T> =
  | { ok: true; data: T }
  | { ok: false; error: 'INVALID_REQUEST' | 'INTERNAL_ERROR' };

/**
 * Bounded list shape. `truncated: true` means more rows existed than the
 * clamped `limit` allowed — the caller (tool) narrows the window on retry.
 */
export interface AiQueryList<T> {
  items: T[];
  truncated: boolean;
  total?: number;
}

/** Health event severity filter (mirrors farm-service's HealthSeverity enum). */
export type AiHealthSeverity = 'minor' | 'moderate' | 'severe' | 'critical';

// ============================================================================
// PRIMITIVE GUARDS
// ============================================================================

const UUID_PATTERN_STR = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/** Loose UUID shape check (any version, any variant) — rejects non-strings. */
export function isUuidString(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(UUID_PATTERN_STR).test(value);
}

/**
 * ISO-8601 date or date-time string (`YYYY-MM-DD` or `YYYY-MM-DDTHH:mm…`).
 * Rejects non-strings and strings `Date` cannot parse.
 */
export function isIsoDateString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
}

/** Integer within [min, max] inclusive — rejects NaN/floats/non-numbers. */
export function isBoundedInt(
  min: number,
  max: number,
): (value: unknown) => value is number {
  return (value: unknown): value is number =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shared `tenantId` pin check used by every per-subject guard below. */
function hasValidTenantId(value: Record<string, unknown>): boolean {
  return 'tenantId' in value && isUuidString(value.tenantId);
}

// ============================================================================
// REPLY/SHAPE GUARDS (ai-service side — validate before trusting a reply)
// ============================================================================

/** Runtime validation of the reply envelope. */
export function isAiQueryReply(value: unknown): value is AiQueryReply<unknown> {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  if (value.ok) return 'data' in value;
  return value.error === 'INVALID_REQUEST' || value.error === 'INTERNAL_ERROR';
}

/** Runtime validation of the bounded list shape (`data` of a list subject). */
export function isAiQueryList(value: unknown): value is AiQueryList<unknown> {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.items)) return false;
  if (typeof value.truncated !== 'boolean') return false;
  if ('total' in value && typeof value.total !== 'number') return false;
  return true;
}

// ============================================================================
// PR-3 REQUEST GUARDS (farm-service side — validate BEFORE executing a query)
// ============================================================================

const isStatDays = isBoundedInt(1, FARM_AI_QUERY_LIMITS.MAX_STAT_DAYS);
const isListLimit = isBoundedInt(1, FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT);
const isReportingYear = isBoundedInt(2000, 2100);
const isReportingWeek = isBoundedInt(1, 53);

/** `fromDate`/`toDate` both ISO and window ≤ maxDays (inclusive). */
function isValidDateRange(
  from: unknown,
  to: unknown,
  maxDays: number,
): from is string {
  if (!isIsoDateString(from) || !isIsoDateString(to)) return false;
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return false;
  if (toMs < fromMs) return false;
  return toMs - fromMs <= maxDays * 24 * 60 * 60 * 1000;
}

function isOptionalListLimit(value: Record<string, unknown>): boolean {
  return !('limit' in value) || isListLimit(value.limit);
}

export interface TankWqStatsRequest extends AiQueryRequest {
  tankId: string;
  days?: number;
}

/** WQ_TANK_STATS: { tenantId, tankId, days? (1..90) }. */
export function isTankWqStatsRequest(value: unknown): value is TankWqStatsRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if (!isUuidString(value.tankId)) return false;
  return !('days' in value) || isStatDays(value.days);
}

export interface SystemWqStatsRequest extends AiQueryRequest {
  systemId: string;
  days?: number;
}

/** WQ_SYSTEM_STATS: { tenantId, systemId, days? (1..90) }. */
export function isSystemWqStatsRequest(
  value: unknown,
): value is SystemWqStatsRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if (!isUuidString(value.systemId)) return false;
  return !('days' in value) || isStatDays(value.days);
}

export interface WaterQualityHistoryRequest extends AiQueryRequest {
  tankId: string;
  fromDate: string;
  toDate: string;
  limit?: number;
}

/** WQ_HISTORY: { tenantId, tankId, fromDate, toDate (range ≤ 90d), limit? }. */
export function isWaterQualityHistoryRequest(
  value: unknown,
): value is WaterQualityHistoryRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if (!isUuidString(value.tankId)) return false;
  if (!isValidDateRange(value.fromDate, value.toDate, FARM_AI_QUERY_LIMITS.MAX_STAT_DAYS)) {
    return false;
  }
  return isOptionalListLimit(value);
}

export interface CriticalWaterQualityRequest extends AiQueryRequest {
  limit?: number;
}

/** WQ_CRITICAL: { tenantId, limit? }. */
export function isCriticalWaterQualityRequest(
  value: unknown,
): value is CriticalWaterQualityRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  return isOptionalListLimit(value);
}

export interface WqThresholdsRequest extends AiQueryRequest {
  speciesId?: string;
}

/** WQ_THRESHOLDS: { tenantId, speciesId? }. */
export function isWqThresholdsRequest(value: unknown): value is WqThresholdsRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  return !('speciesId' in value) || isUuidString(value.speciesId);
}

/** FH_STATS request — { tenantId } only; alias keeps the guard signature legible. */
export type FishHealthStatsRequest = AiQueryRequest;

/** FH_STATS: { tenantId } — no further inputs. */
export function isFishHealthStatsRequest(
  value: unknown,
): value is FishHealthStatsRequest {
  return isRecord(value) && hasValidTenantId(value);
}

const AI_HEALTH_SEVERITIES: readonly string[] = [
  'minor',
  'moderate',
  'severe',
  'critical',
];

export interface HealthEventsRequest extends AiQueryRequest {
  batchId?: string;
  tankId?: string;
  activeOnly?: boolean;
  severity?: AiHealthSeverity;
  limit?: number;
}

/** FH_EVENTS: { tenantId, batchId?, tankId?, activeOnly?, severity?, limit? }. */
export function isHealthEventsRequest(value: unknown): value is HealthEventsRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if ('batchId' in value && !isUuidString(value.batchId)) return false;
  if ('tankId' in value && !isUuidString(value.tankId)) return false;
  if ('activeOnly' in value && typeof value.activeOnly !== 'boolean') return false;
  if ('severity' in value && !AI_HEALTH_SEVERITIES.includes(value.severity as string)) {
    return false;
  }
  return isOptionalListLimit(value);
}

export interface CriticalHealthEventsRequest extends AiQueryRequest {
  limit?: number;
}

/** FH_CRITICAL: { tenantId, limit? }. */
export function isCriticalHealthEventsRequest(
  value: unknown,
): value is CriticalHealthEventsRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  return isOptionalListLimit(value);
}

export interface OverdueFollowUpsRequest extends AiQueryRequest {
  limit?: number;
}

/** FH_OVERDUE_FOLLOW_UPS: { tenantId, limit? }. */
export function isOverdueFollowUpsRequest(
  value: unknown,
): value is OverdueFollowUpsRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  return isOptionalListLimit(value);
}

export interface LiceCountsRequest extends AiQueryRequest {
  siteId?: string;
  tankId?: string;
  reportingYear?: number;
  reportingWeek?: number;
  limit?: number;
}

/** FH_LICE_COUNTS: { tenantId, siteId?, tankId?, reportingYear?, reportingWeek?, limit? }. */
export function isLiceCountsRequest(value: unknown): value is LiceCountsRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if ('siteId' in value && !isUuidString(value.siteId)) return false;
  if ('tankId' in value && !isUuidString(value.tankId)) return false;
  if ('reportingYear' in value && !isReportingYear(value.reportingYear)) return false;
  if ('reportingWeek' in value && !isReportingWeek(value.reportingWeek)) return false;
  return isOptionalListLimit(value);
}

export interface TreatmentApplicationsRequest extends AiQueryRequest {
  siteId?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

/** FH_TREATMENTS: { tenantId, siteId?, fromDate?, toDate? (range ≤ 366d), limit? }. */
export function isTreatmentApplicationsRequest(
  value: unknown,
): value is TreatmentApplicationsRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if ('siteId' in value && !isUuidString(value.siteId)) return false;
  if ('fromDate' in value || 'toDate' in value) {
    if (!isValidDateRange(value.fromDate, value.toDate, FARM_AI_QUERY_LIMITS.MAX_RANGE_DAYS)) {
      return false;
    }
  }
  return isOptionalListLimit(value);
}

export interface WelfareAssessmentsRequest extends AiQueryRequest {
  siteId?: string;
  tankId?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

/** FH_WELFARE: { tenantId, siteId?, tankId?, fromDate?, toDate? (range ≤ 366d), limit? }. */
export function isWelfareAssessmentsRequest(
  value: unknown,
): value is WelfareAssessmentsRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if ('siteId' in value && !isUuidString(value.siteId)) return false;
  if ('tankId' in value && !isUuidString(value.tankId)) return false;
  if ('fromDate' in value || 'toDate' in value) {
    if (!isValidDateRange(value.fromDate, value.toDate, FARM_AI_QUERY_LIMITS.MAX_RANGE_DAYS)) {
      return false;
    }
  }
  return isOptionalListLimit(value);
}

export interface BatchHarvestEligibilityRequest extends AiQueryRequest {
  batchId: string;
  harvestDate: string;
}

/** FH_HARVEST_ELIGIBILITY: { tenantId, batchId, harvestDate (ISO) }. */
export function isBatchHarvestEligibilityRequest(
  value: unknown,
): value is BatchHarvestEligibilityRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if (!isUuidString(value.batchId)) return false;
  return isIsoDateString(value.harvestDate);
}

// ============================================================================
// PR-4 REQUEST GUARDS (Production specialist — batch/growth/feeding/species/
// tank/harvest/regulatory/finance subjects)
// ============================================================================

const isReportMonth = isBoundedInt(1, 12);
const isUpcomingDays = isBoundedInt(1, FARM_AI_QUERY_LIMITS.MAX_UPCOMING_DAYS);

const AI_FINANCE_GRANULARITIES: readonly string[] = ['DAY', 'WEEK', 'MONTH', 'YEAR'];
const AI_HARVEST_SCOPES: readonly string[] = ['upcoming', 'overdue'];
const AI_FEEDING_ENTITY_TYPES: readonly string[] = ['batch', 'tank'];

export interface BatchPerformanceRequest extends AiQueryRequest {
  batchId: string;
}

/** BATCH_PERFORMANCE: { tenantId, batchId }. */
export function isBatchPerformanceRequest(
  value: unknown,
): value is BatchPerformanceRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  return isUuidString(value.batchId);
}

export interface GrowthAnalysisRequest extends AiQueryRequest {
  batchId: string;
}

/** GROWTH_ANALYSIS: { tenantId, batchId }. */
export function isGrowthAnalysisRequest(
  value: unknown,
): value is GrowthAnalysisRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  return isUuidString(value.batchId);
}

export interface GrowthMeasurementsRequest extends AiQueryRequest {
  batchId: string;
  limit?: number;
}

/** GROWTH_MEASUREMENTS: { tenantId, batchId, limit? }. */
export function isGrowthMeasurementsRequest(
  value: unknown,
): value is GrowthMeasurementsRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if (!isUuidString(value.batchId)) return false;
  return isOptionalListLimit(value);
}

export interface MortalityByCauseRequest extends AiQueryRequest {
  siteId: string;
  fromDate: string;
  toDate: string;
}

/** BATCH_MORTALITY_BY_CAUSE: { tenantId, siteId, fromDate, toDate (range ≤ 366d) }. */
export function isMortalityByCauseRequest(
  value: unknown,
): value is MortalityByCauseRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if (!isUuidString(value.siteId)) return false;
  return isValidDateRange(
    value.fromDate,
    value.toDate,
    FARM_AI_QUERY_LIMITS.MAX_RANGE_DAYS,
  );
}

export interface TransfersSummaryRequest extends AiQueryRequest {
  siteId: string;
  fromDate: string;
  toDate: string;
}

/** BATCH_TRANSFERS_SUMMARY: { tenantId, siteId, fromDate, toDate (range ≤ 366d) }. */
export function isTransfersSummaryRequest(
  value: unknown,
): value is TransfersSummaryRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if (!isUuidString(value.siteId)) return false;
  return isValidDateRange(
    value.fromDate,
    value.toDate,
    FARM_AI_QUERY_LIMITS.MAX_RANGE_DAYS,
  );
}

export interface DailyFeedingPlanRequest extends AiQueryRequest {
  siteId: string;
  date: string;
  departmentId?: string;
}

/** FEEDING_DAILY_PLAN: { tenantId, siteId, date (ISO), departmentId? }. */
export function isDailyFeedingPlanRequest(
  value: unknown,
): value is DailyFeedingPlanRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if (!isUuidString(value.siteId)) return false;
  if ('departmentId' in value && !isUuidString(value.departmentId)) return false;
  return isIsoDateString(value.date);
}

export interface FeedingSummaryRequest extends AiQueryRequest {
  entityType: 'batch' | 'tank';
  entityId: string;
  fromDate?: string;
  toDate?: string;
}

/** FEEDING_SUMMARY: { tenantId, entityType 'batch'|'tank', entityId, fromDate?, toDate? (range ≤ 366d) }. */
export function isFeedingSummaryRequest(
  value: unknown,
): value is FeedingSummaryRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if (!AI_FEEDING_ENTITY_TYPES.includes(value.entityType as string)) return false;
  if (!isUuidString(value.entityId)) return false;
  if ('fromDate' in value || 'toDate' in value) {
    if (!isValidDateRange(value.fromDate, value.toDate, FARM_AI_QUERY_LIMITS.MAX_RANGE_DAYS)) {
      return false;
    }
  }
  return true;
}

export interface SiteFeedConsumptionRequest extends AiQueryRequest {
  siteId: string;
  fromDate: string;
  toDate: string;
}

/** FEEDING_SITE_CONSUMPTION: { tenantId, siteId, fromDate, toDate (range ≤ 366d) }. */
export function isSiteFeedConsumptionRequest(
  value: unknown,
): value is SiteFeedConsumptionRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if (!isUuidString(value.siteId)) return false;
  return isValidDateRange(
    value.fromDate,
    value.toDate,
    FARM_AI_QUERY_LIMITS.MAX_RANGE_DAYS,
  );
}

export interface FeedProtocolsRequest extends AiQueryRequest {
  limit?: number;
}

/**
 * FEED_PROTOCOLS: { tenantId, limit? }. (No speciesId filter: the underlying
 * ListFeedingProtocolsQuery filters by species NAME via free-text ILIKE —
 * deliberately not exposed to the model surface.)
 */
export function isFeedProtocolsRequest(
  value: unknown,
): value is FeedProtocolsRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  return isOptionalListLimit(value);
}

/** SPECIES_LIST request — { tenantId } only. */
export type SpeciesListRequest = AiQueryRequest;

/** SPECIES_LIST: { tenantId } — no further inputs. */
export function isSpeciesListRequest(value: unknown): value is SpeciesListRequest {
  return isRecord(value) && hasValidTenantId(value);
}

export interface TankCapacityRequest extends AiQueryRequest {
  tankId: string;
}

/** TANK_CAPACITY: { tenantId, tankId }. */
export function isTankCapacityRequest(value: unknown): value is TankCapacityRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  return isUuidString(value.tankId);
}

export interface HarvestPlansRequest extends AiQueryRequest {
  scope: 'upcoming' | 'overdue';
  days: number;
  limit?: number;
}

/** HARVEST_PLANS: { tenantId, scope 'upcoming'|'overdue', days (1..180), limit? }. */
export function isHarvestPlansRequest(value: unknown): value is HarvestPlansRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if (!AI_HARVEST_SCOPES.includes(value.scope as string)) return false;
  if (!isUpcomingDays(value.days)) return false;
  return isOptionalListLimit(value);
}

/** HARVEST_PLAN_STATS request — { tenantId } only. */
export type HarvestPlanStatsRequest = AiQueryRequest;

/** HARVEST_PLAN_STATS: { tenantId } — no further inputs. */
export function isHarvestPlanStatsRequest(
  value: unknown,
): value is HarvestPlanStatsRequest {
  return isRecord(value) && hasValidTenantId(value);
}

export interface BiomassReportRequest extends AiQueryRequest {
  siteId: string;
  reportMonth: number;
  reportYear: number;
}

/** REG_BIOMASS_REPORT: { tenantId, siteId, reportMonth (1..12), reportYear }. */
export function isBiomassReportRequest(value: unknown): value is BiomassReportRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if (!isUuidString(value.siteId)) return false;
  if (!isReportMonth(value.reportMonth)) return false;
  return isReportingYear(value.reportYear);
}

/**
 * Regulatory report type vocabulary (mirrors farm-service's
 * RegulatoryReportType enum) — kept in sync by the SSOT invariant spec.
 */
export const AI_REGULATORY_REPORT_TYPES: readonly string[] = [
  'SEA_LICE',
  'CLEANER_FISH',
  'SMOLT',
  'SLAUGHTER_PLANNED',
  'SLAUGHTER_EXECUTED',
  'WELFARE_EVENT',
  'ESCAPE',
  'DISEASE_OUTBREAK',
];

export interface RegulatoryReportsRequest extends AiQueryRequest {
  reportType: string;
  siteId?: string;
  limit?: number;
}

/** REG_REPORTS: { tenantId, reportType (enum string), siteId?, limit? }. */
export function isRegulatoryReportsRequest(
  value: unknown,
): value is RegulatoryReportsRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if (!AI_REGULATORY_REPORT_TYPES.includes(value.reportType as string)) {
    return false;
  }
  if ('siteId' in value && !isUuidString(value.siteId)) return false;
  return isOptionalListLimit(value);
}

export interface FinanceSummaryRequest extends AiQueryRequest {
  fromDate: string;
  toDate: string;
  granularity: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
}

/** FINANCE_SUMMARY: { tenantId, fromDate, toDate (range ≤ 366d), granularity }. */
export function isFinanceSummaryRequest(
  value: unknown,
): value is FinanceSummaryRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if (!isValidDateRange(value.fromDate, value.toDate, FARM_AI_QUERY_LIMITS.MAX_RANGE_DAYS)) {
    return false;
  }
  return AI_FINANCE_GRANULARITIES.includes(value.granularity as string);
}

export interface FinanceBatchTotalsRequest extends AiQueryRequest {
  fromDate: string;
  toDate: string;
  limit?: number;
}

/** FINANCE_BATCH_TOTALS: { tenantId, fromDate, toDate (range ≤ 366d), limit? }. */
export function isFinanceBatchTotalsRequest(
  value: unknown,
): value is FinanceBatchTotalsRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if (!isValidDateRange(value.fromDate, value.toDate, FARM_AI_QUERY_LIMITS.MAX_RANGE_DAYS)) {
    return false;
  }
  return isOptionalListLimit(value);
}

// ============================================================================
// PR-5 REQUEST GUARDS (Operations specialist — equipment/maintenance/
// farm-stock/task subjects)
// ============================================================================

const AI_EQUIPMENT_STATUSES: readonly string[] = [
  'operational',
  'maintenance',
  'repair',
  'out_of_service',
  'decommissioned',
  'standby',
  'active',
  'preparing',
  'cleaning',
  'harvesting',
  'fallow',
  'quarantine',
];

export interface EquipmentListRequest extends AiQueryRequest {
  equipmentTypeId?: string;
  status?: string;
  isTank?: boolean;
  limit?: number;
}

/** EQUIPMENT_LIST: { tenantId, equipmentTypeId?, status?, isTank?, limit? }. */
export function isEquipmentListRequest(value: unknown): value is EquipmentListRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if ('equipmentTypeId' in value && !isUuidString(value.equipmentTypeId)) return false;
  if ('status' in value && !AI_EQUIPMENT_STATUSES.includes(value.status as string)) {
    return false;
  }
  if ('isTank' in value && typeof value.isTank !== 'boolean') return false;
  return isOptionalListLimit(value);
}

export interface FeederCalibrationsRequest extends AiQueryRequest {
  equipmentId: string;
  limit?: number;
}

/** EQUIPMENT_FEEDER_CALIBRATIONS: { tenantId, equipmentId, limit? }. */
export function isFeederCalibrationsRequest(
  value: unknown,
): value is FeederCalibrationsRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if (!isUuidString(value.equipmentId)) return false;
  return isOptionalListLimit(value);
}

export interface OverdueWorkOrdersRequest extends AiQueryRequest {
  limit?: number;
}

/** MAINT_OVERDUE_WORK_ORDERS: { tenantId, limit? }. */
export function isOverdueWorkOrdersRequest(
  value: unknown,
): value is OverdueWorkOrdersRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  return isOptionalListLimit(value);
}

export interface WorkOrderStatsRequest extends AiQueryRequest {
  fromDate?: string;
  toDate?: string;
}

/** MAINT_WORK_ORDER_STATS: { tenantId, fromDate?, toDate? (range ≤ 366d) }. */
export function isWorkOrderStatsRequest(
  value: unknown,
): value is WorkOrderStatsRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if ('fromDate' in value || 'toDate' in value) {
    if (!isValidDateRange(value.fromDate, value.toDate, FARM_AI_QUERY_LIMITS.MAX_RANGE_DAYS)) {
      return false;
    }
  }
  return true;
}

export interface MaintenanceScheduleAlertsRequest extends AiQueryRequest {
  limit?: number;
}

/** MAINT_SCHEDULE_ALERTS: { tenantId, limit? }. */
export function isMaintenanceScheduleAlertsRequest(
  value: unknown,
): value is MaintenanceScheduleAlertsRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  return isOptionalListLimit(value);
}

export interface LowStockPartsRequest extends AiQueryRequest {
  limit?: number;
}

/** MAINT_LOW_STOCK: { tenantId, limit? }. */
export function isLowStockPartsRequest(value: unknown): value is LowStockPartsRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  return isOptionalListLimit(value);
}

/** SPARE_STOCK_SUMMARY request — { tenantId } only. */
export type StockSummaryRequest = AiQueryRequest;

/** MAINT_STOCK_SUMMARY: { tenantId } — no further inputs. */
export function isStockSummaryRequest(value: unknown): value is StockSummaryRequest {
  return isRecord(value) && hasValidTenantId(value);
}

export interface FarmStockInventoryRequest extends AiQueryRequest {
  siteId?: string;
  status?: string;
  hasActiveBatch?: boolean;
  limit?: number;
}

/** FARM_STOCK_INVENTORY: { tenantId, siteId?, status?, hasActiveBatch?, limit? }. */
export function isFarmStockInventoryRequest(
  value: unknown,
): value is FarmStockInventoryRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  if ('siteId' in value && !isUuidString(value.siteId)) return false;
  if ('status' in value && typeof value.status !== 'string') return false;
  if ('hasActiveBatch' in value && typeof value.hasActiveBatch !== 'boolean') {
    return false;
  }
  return isOptionalListLimit(value);
}

export interface TodaysTasksRequest extends AiQueryRequest {
  limit?: number;
}

/** TASKS_TODAY: { tenantId, limit? }. */
export function isTodaysTasksRequest(value: unknown): value is TodaysTasksRequest {
  if (!isRecord(value) || !hasValidTenantId(value)) return false;
  return isOptionalListLimit(value);
}

/** TASK_STATS request — { tenantId } only. */
export type TaskStatsRequest = AiQueryRequest;

/** TASK_STATS: { tenantId } — no further inputs. */
export function isTaskStatsRequest(value: unknown): value is TaskStatsRequest {
  return isRecord(value) && hasValidTenantId(value);
}
