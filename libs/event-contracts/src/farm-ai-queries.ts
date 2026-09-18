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
 * All farm-AI query subjects. PR-3 implements the first 13 (Water & Health
 * specialist); the remaining keys are PR-4/5 placeholders reserved NOW so
 * later PRs extend the space without reshuffling the ACL registry
 * (infrastructure/nats/services.yaml lists every subject explicitly).
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
  // --- PR-4/5 placeholders (subjects reserved; responders land later) -----
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
