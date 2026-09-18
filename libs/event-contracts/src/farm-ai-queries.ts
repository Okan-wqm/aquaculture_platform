/**
 * farm-service → ai-service read contract for the farm AI specialists
 * (FARM-MEDIUM-328).
 *
 * Every subject is a tenant-pinned READ answered by a farm-service
 * `@MessagePattern` responder and consumed by exactly one ai-service tool.
 * Subjects are `IDENT.UPPER_CASE` constants so the NATS ACL invariant
 * (e2e/tests/integration/nats-invariants.spec.ts, RPC coverage) resolves
 * them, and tests/invariants/farm-ai-query-contract-ssot.spec.ts proves each
 * one has its responder, its tool and its explicit services.yaml grants.
 *
 * Replies travel in an envelope: `{ ok: true, data }` or `{ ok: false, error }`.
 * The pre-existing overview responders answered `[]` on any failure, which the
 * model could not tell from "no data"; the envelope makes farm-service being
 * down a visible tool error instead of an empty list.
 *
 * Request shapes carry the tenant id, which the ai-service tool base composes
 * from the execution context — never from the model. The per-domain shape
 * modules live under ./farm-ai-queries/ and are re-exported here.
 */

export const FARM_AI_QUERY_NAMESPACE = 'request.farm.ai.' as const;

export const FARM_AI_QUERY_SUBJECTS = {
  // water quality
  WQ_TANK_STATS: 'request.farm.ai.getTankWaterQualityStats',
  WQ_SYSTEM_STATS: 'request.farm.ai.getSystemWaterQualityStats',
  WQ_HISTORY: 'request.farm.ai.getWaterQualityHistory',
  WQ_CRITICAL: 'request.farm.ai.listCriticalWaterQuality',
  WQ_THRESHOLDS: 'request.farm.ai.getWaterQualityThresholds',
  // fish health
  FH_STATS: 'request.farm.ai.getFishHealthStats',
  FH_EVENTS: 'request.farm.ai.listHealthEvents',
  FH_CRITICAL: 'request.farm.ai.listCriticalHealthEvents',
  FH_OVERDUE_FOLLOW_UPS: 'request.farm.ai.listOverdueHealthFollowUps',
  FH_LICE_COUNTS: 'request.farm.ai.listLiceCounts',
  FH_TREATMENTS: 'request.farm.ai.listTreatmentApplications',
  FH_WELFARE: 'request.farm.ai.listWelfareAssessments',
  FH_HARVEST_ELIGIBILITY: 'request.farm.ai.checkBatchHarvestEligibility',
  // production: batch / growth / species / tank capacity
  BATCH_PERFORMANCE: 'request.farm.ai.getBatchPerformance',
  BATCH_MORTALITY_BY_CAUSE: 'request.farm.ai.getMortalityByCause',
  BATCH_TRANSFERS_SUMMARY: 'request.farm.ai.getTransfersSummary',
  GROWTH_ANALYSIS: 'request.farm.ai.getGrowthAnalysis',
  GROWTH_MEASUREMENTS: 'request.farm.ai.listGrowthMeasurements',
  SPECIES_LIST: 'request.farm.ai.listSpecies',
  TANK_CAPACITY: 'request.farm.ai.getTankCapacity',
  // feeding
  FEEDING_DAILY_PLAN: 'request.farm.ai.getDailyFeedingPlan',
  FEEDING_SUMMARY: 'request.farm.ai.getFeedingSummary',
  FEEDING_SITE_CONSUMPTION: 'request.farm.ai.getSiteFeedConsumption',
  FEED_PROTOCOLS: 'request.farm.ai.listFeedingProtocols',
  // harvest / regulatory / finance
  HARVEST_PLANS: 'request.farm.ai.listHarvestPlans',
  HARVEST_PLAN_STATS: 'request.farm.ai.getHarvestPlanStats',
  REG_BIOMASS_REPORT: 'request.farm.ai.getBiomassReport',
  REG_REPORTS: 'request.farm.ai.listRegulatoryReports',
  FINANCE_SUMMARY: 'request.farm.ai.getFinanceSummary',
  FINANCE_BATCH_TOTALS: 'request.farm.ai.getFinanceBatchTotals',
} as const;

export type FarmAiQuerySubject =
  (typeof FARM_AI_QUERY_SUBJECTS)[keyof typeof FARM_AI_QUERY_SUBJECTS];

/** Server-side caps: the model can ask for less, never for more. */
export const FARM_AI_QUERY_LIMITS = {
  DEFAULT_LIST_LIMIT: 20,
  MAX_LIST_LIMIT: 50,
  /** Days of history a statistics query may span. */
  MAX_STAT_DAYS: 90,
  /** Days a from/to window may span. */
  MAX_RANGE_DAYS: 366,
} as const;

// ── Envelope ────────────────────────────────────────────────────────────────

/** Every request carries the tenant; the ai-service tool base sets it from context. */
export interface AiQueryRequest {
  tenantId: string;
}

export type AiQueryErrorCode = 'INVALID_REQUEST' | 'INTERNAL_ERROR';

export type AiQueryReply<T> = { ok: true; data: T } | { ok: false; error: AiQueryErrorCode };

/** A bounded list: `truncated` tells the model the cap bit and to narrow the window. */
export interface AiQueryList<T> {
  items: T[];
  truncated: boolean;
  /** Total rows matching, when the source query knows it. */
  total?: number;
}

// ── Guard primitives (shared by the per-domain shape modules) ───────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isUuidString(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** `YYYY-MM-DD` or a full ISO timestamp that parses. */
export function isIsoDateString(value: unknown): value is string {
  return (
    typeof value === 'string' && ISO_DATE_RE.test(value) && !Number.isNaN(new Date(value).getTime())
  );
}

export function isBoundedInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function isOptional<T>(
  value: unknown,
  guard: (candidate: unknown) => candidate is T,
): value is T | undefined {
  return value === undefined || guard(value);
}

export function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

export function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** Request envelope: a record whose `tenantId` is a UUID and whose other keys are exactly `allowedKeys`. */
export function isAiQueryRequestShape(
  value: unknown,
  allowedKeys: readonly string[],
): value is AiQueryRequest & Record<string, unknown> {
  if (!isRecord(value) || !isUuidString(value['tenantId'])) return false;
  const allowed = new Set<string>(['tenantId', ...allowedKeys]);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function isAiQueryReply(value: unknown): value is AiQueryReply<unknown> {
  if (!isRecord(value) || typeof value['ok'] !== 'boolean') return false;
  if (value['ok'] === true) return 'data' in value;
  return value['error'] === 'INVALID_REQUEST' || value['error'] === 'INTERNAL_ERROR';
}

export function isAiQueryList<T>(
  value: unknown,
  isItem: (candidate: unknown) => candidate is T,
): value is AiQueryList<T> {
  return (
    isRecord(value) &&
    Array.isArray(value['items']) &&
    value['items'].every(isItem) &&
    typeof value['truncated'] === 'boolean' &&
    (value['total'] === undefined || typeof value['total'] === 'number')
  );
}

/** Whole days from `fromDate` to `toDate` (negative when reversed). */
export function daySpan(fromDate: string, toDate: string): number {
  return Math.ceil((new Date(toDate).getTime() - new Date(fromDate).getTime()) / 86_400_000);
}

/** A from/to pair that is ordered and spans at most `maxDays`. */
export function isBoundedDateRange(fromDate: unknown, toDate: unknown, maxDays: number): boolean {
  if (!isIsoDateString(fromDate) || !isIsoDateString(toDate)) return false;
  const span = daySpan(fromDate, toDate);
  return span >= 0 && span <= maxDays;
}

/** Clamp a caller-supplied limit into [1, MAX_LIST_LIMIT]; undefined → the default. */
export function clampListLimit(requested: number | undefined): number {
  if (requested === undefined) return FARM_AI_QUERY_LIMITS.DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(Math.trunc(requested), 1), FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT);
}

export * from './farm-ai-queries/water-quality';
export * from './farm-ai-queries/fish-health';
export * from './farm-ai-queries/production';
export * from './farm-ai-queries/feeding';
export * from './farm-ai-queries/harvest-finance';
