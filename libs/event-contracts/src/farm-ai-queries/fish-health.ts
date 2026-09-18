/**
 * Fish-health shapes for the farm AI read contract. Compact projections
 * with no operator or veterinarian identity and no notes/attachments
 * (reportedBy, vetName, vetLicense, notes, attachments are never emitted).
 * The event `title` IS carried — it is the operator's one-line name for the
 * event and the model cannot reason about an event without it; it is the
 * single free-text field, trimmed and length-bounded by the entity.
 */
import {
  isAiQueryList,
  isAiQueryRequestShape,
  isBoundedInt,
  isIsoDateString,
  isNullableNumber,
  isNullableString,
  isOptional,
  isRecord,
  isUuidString,
  type AiQueryList,
  type AiQueryRequest,
  FARM_AI_QUERY_LIMITS,
} from '../farm-ai-queries';

// ── Stats ───────────────────────────────────────────────────────────────────

export type FishHealthStatsRequest = AiQueryRequest;
export interface FishHealthStatsReply {
  total: number;
  active: number;
  critical: number;
  underTreatment: number;
  quarantined: number;
  resolved: number;
  byEventType: Record<string, number>;
  bySeverity: Record<string, number>;
}
export function isFishHealthStatsRequest(value: unknown): value is FishHealthStatsRequest {
  return isAiQueryRequestShape(value, []);
}
export function isFishHealthStatsReply(value: unknown): value is FishHealthStatsReply {
  return (
    isRecord(value) &&
    typeof value['total'] === 'number' &&
    typeof value['active'] === 'number' &&
    typeof value['critical'] === 'number' &&
    typeof value['underTreatment'] === 'number' &&
    typeof value['quarantined'] === 'number' &&
    typeof value['resolved'] === 'number' &&
    isRecord(value['byEventType']) &&
    isRecord(value['bySeverity'])
  );
}

// ── Health events ───────────────────────────────────────────────────────────

export const HEALTH_SEVERITIES = ['minor', 'moderate', 'severe', 'critical'] as const;
export type HealthSeverityCode = (typeof HEALTH_SEVERITIES)[number];

export interface HealthEventDto {
  id: string;
  eventType: string;
  severity: string;
  status: string;
  title: string;
  diseaseCategory: string | null;
  diseaseName: string | null;
  batchId: string | null;
  tankId: string | null;
  eventDate: string;
  isUnderTreatment: boolean;
  isQuarantined: boolean;
  mortalityCount: number | null;
  withdrawalPeriodDays: number | null;
  earliestHarvestDate: string | null;
  followUpRequired: boolean;
  nextFollowUpDate: string | null;
}

export function isHealthEventDto(value: unknown): value is HealthEventDto {
  return (
    isRecord(value) &&
    isUuidString(value['id']) &&
    typeof value['eventType'] === 'string' &&
    typeof value['severity'] === 'string' &&
    typeof value['status'] === 'string' &&
    typeof value['title'] === 'string' &&
    isNullableString(value['diseaseCategory']) &&
    isNullableString(value['diseaseName']) &&
    isNullableString(value['batchId']) &&
    isNullableString(value['tankId']) &&
    isIsoDateString(value['eventDate']) &&
    typeof value['isUnderTreatment'] === 'boolean' &&
    typeof value['isQuarantined'] === 'boolean' &&
    isNullableNumber(value['mortalityCount']) &&
    isNullableNumber(value['withdrawalPeriodDays']) &&
    isNullableString(value['earliestHarvestDate']) &&
    typeof value['followUpRequired'] === 'boolean' &&
    isNullableString(value['nextFollowUpDate'])
  );
}

export interface HealthEventsRequest extends AiQueryRequest {
  batchId?: string;
  tankId?: string;
  activeOnly: boolean;
  severity?: HealthSeverityCode;
  limit: number;
}
export type HealthEventsReply = AiQueryList<HealthEventDto>;

export function isHealthEventsRequest(value: unknown): value is HealthEventsRequest {
  return (
    isAiQueryRequestShape(value, ['batchId', 'tankId', 'activeOnly', 'severity', 'limit']) &&
    isOptional(value['batchId'], isUuidString) &&
    isOptional(value['tankId'], isUuidString) &&
    typeof value['activeOnly'] === 'boolean' &&
    isOptional(value['severity'], (v): v is HealthSeverityCode =>
      (HEALTH_SEVERITIES as readonly string[]).includes(v as string),
    ) &&
    isBoundedInt(value['limit'], 1, FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT)
  );
}
export function isHealthEventsReply(value: unknown): value is HealthEventsReply {
  return isAiQueryList(value, isHealthEventDto);
}

/** Critical events and overdue follow-ups share the bounded-list request. */
export interface BoundedListRequest extends AiQueryRequest {
  limit: number;
}
export function isBoundedListRequest(value: unknown): value is BoundedListRequest {
  return (
    isAiQueryRequestShape(value, ['limit']) &&
    isBoundedInt(value['limit'], 1, FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT)
  );
}

// ── Lice counts ─────────────────────────────────────────────────────────────

export interface LiceCountsRequest extends AiQueryRequest {
  siteId?: string;
  tankId?: string;
  reportingYear?: number;
  reportingWeek?: number;
  limit: number;
}
export interface LiceCountDto {
  id: string;
  siteId: string;
  tankId: string;
  batchId: string | null;
  countDate: string;
  reportingYear: number;
  reportingWeek: number;
  adultFemaleLice: number;
  mobileLice: number;
  attachedLice: number;
  fishSampled: number;
  seaTemperatureC: number | null;
}
export type LiceCountsReply = AiQueryList<LiceCountDto>;

export function isLiceCountsRequest(value: unknown): value is LiceCountsRequest {
  return (
    isAiQueryRequestShape(value, ['siteId', 'tankId', 'reportingYear', 'reportingWeek', 'limit']) &&
    isOptional(value['siteId'], isUuidString) &&
    isOptional(value['tankId'], isUuidString) &&
    isOptional(value['reportingYear'], (v): v is number => isBoundedInt(v, 2000, 2100)) &&
    isOptional(value['reportingWeek'], (v): v is number => isBoundedInt(v, 1, 53)) &&
    isBoundedInt(value['limit'], 1, FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT)
  );
}
export function isLiceCountDto(value: unknown): value is LiceCountDto {
  return (
    isRecord(value) &&
    isUuidString(value['id']) &&
    typeof value['siteId'] === 'string' &&
    typeof value['tankId'] === 'string' &&
    isNullableString(value['batchId']) &&
    isIsoDateString(value['countDate']) &&
    typeof value['reportingYear'] === 'number' &&
    typeof value['reportingWeek'] === 'number' &&
    typeof value['adultFemaleLice'] === 'number' &&
    typeof value['mobileLice'] === 'number' &&
    typeof value['attachedLice'] === 'number' &&
    typeof value['fishSampled'] === 'number' &&
    isNullableNumber(value['seaTemperatureC'])
  );
}
export function isLiceCountsReply(value: unknown): value is LiceCountsReply {
  return isAiQueryList(value, isLiceCountDto);
}

// ── Treatment applications ──────────────────────────────────────────────────

export interface TreatmentApplicationsRequest extends AiQueryRequest {
  siteId?: string;
  fromDate?: string;
  toDate?: string;
  limit: number;
}
export interface TreatmentApplicationDto {
  id: string;
  healthEventId: string | null;
  siteId: string;
  tankId: string | null;
  batchId: string | null;
  category: string;
  method: string;
  activeSubstance: string | null;
  strengthValue: number | null;
  strengthUnit: string | null;
  amountValue: number | null;
  amountUnit: string | null;
  wholeSite: boolean;
  appliedAt: string;
  completedAt: string | null;
}
export type TreatmentApplicationsReply = AiQueryList<TreatmentApplicationDto>;

export function isTreatmentApplicationsRequest(
  value: unknown,
): value is TreatmentApplicationsRequest {
  return (
    isAiQueryRequestShape(value, ['siteId', 'fromDate', 'toDate', 'limit']) &&
    isOptional(value['siteId'], isUuidString) &&
    isOptional(value['fromDate'], isIsoDateString) &&
    isOptional(value['toDate'], isIsoDateString) &&
    isBoundedInt(value['limit'], 1, FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT)
  );
}
export function isTreatmentApplicationDto(value: unknown): value is TreatmentApplicationDto {
  return (
    isRecord(value) &&
    isUuidString(value['id']) &&
    isNullableString(value['healthEventId']) &&
    typeof value['siteId'] === 'string' &&
    isNullableString(value['tankId']) &&
    isNullableString(value['batchId']) &&
    typeof value['category'] === 'string' &&
    typeof value['method'] === 'string' &&
    isNullableString(value['activeSubstance']) &&
    isNullableNumber(value['strengthValue']) &&
    isNullableString(value['strengthUnit']) &&
    isNullableNumber(value['amountValue']) &&
    isNullableString(value['amountUnit']) &&
    typeof value['wholeSite'] === 'boolean' &&
    isIsoDateString(value['appliedAt']) &&
    isNullableString(value['completedAt'])
  );
}
export function isTreatmentApplicationsReply(value: unknown): value is TreatmentApplicationsReply {
  return isAiQueryList(value, isTreatmentApplicationDto);
}

// ── Welfare assessments ─────────────────────────────────────────────────────

export interface WelfareAssessmentsRequest extends AiQueryRequest {
  siteId?: string;
  tankId?: string;
  fromDate?: string;
  toDate?: string;
  limit: number;
}
export interface WelfareAssessmentDto {
  id: string;
  siteId: string;
  tankId: string;
  batchId: string | null;
  assessedAt: string;
  fishSampled: number;
  gillScore: number;
  finScore: number;
  woundScore: number;
  deformityScore: number;
}
export type WelfareAssessmentsReply = AiQueryList<WelfareAssessmentDto>;

export function isWelfareAssessmentsRequest(value: unknown): value is WelfareAssessmentsRequest {
  return (
    isAiQueryRequestShape(value, ['siteId', 'tankId', 'fromDate', 'toDate', 'limit']) &&
    isOptional(value['siteId'], isUuidString) &&
    isOptional(value['tankId'], isUuidString) &&
    isOptional(value['fromDate'], isIsoDateString) &&
    isOptional(value['toDate'], isIsoDateString) &&
    isBoundedInt(value['limit'], 1, FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT)
  );
}
export function isWelfareAssessmentDto(value: unknown): value is WelfareAssessmentDto {
  return (
    isRecord(value) &&
    isUuidString(value['id']) &&
    typeof value['siteId'] === 'string' &&
    typeof value['tankId'] === 'string' &&
    isNullableString(value['batchId']) &&
    isIsoDateString(value['assessedAt']) &&
    typeof value['fishSampled'] === 'number' &&
    typeof value['gillScore'] === 'number' &&
    typeof value['finScore'] === 'number' &&
    typeof value['woundScore'] === 'number' &&
    typeof value['deformityScore'] === 'number'
  );
}
export function isWelfareAssessmentsReply(value: unknown): value is WelfareAssessmentsReply {
  return isAiQueryList(value, isWelfareAssessmentDto);
}

// ── Harvest eligibility (withdrawal periods) ────────────────────────────────

export interface HarvestEligibilityRequest extends AiQueryRequest {
  batchId: string;
  harvestDate: string;
}
export interface BlockingHealthEventDto {
  id: string;
  title: string;
  diseaseName: string | null;
  earliestHarvestDate: string;
  withdrawalPeriodDays: number | null;
  status: string;
}
export interface HarvestEligibilityReply {
  batchId: string;
  harvestDate: string;
  eligible: boolean;
  blockedUntil: string | null;
  reason: string | null;
  blockingEvents: BlockingHealthEventDto[];
}

export function isHarvestEligibilityRequest(value: unknown): value is HarvestEligibilityRequest {
  return (
    isAiQueryRequestShape(value, ['batchId', 'harvestDate']) &&
    isUuidString(value['batchId']) &&
    isIsoDateString(value['harvestDate'])
  );
}
export function isHarvestEligibilityReply(value: unknown): value is HarvestEligibilityReply {
  return (
    isRecord(value) &&
    typeof value['batchId'] === 'string' &&
    isIsoDateString(value['harvestDate']) &&
    typeof value['eligible'] === 'boolean' &&
    isNullableString(value['blockedUntil']) &&
    isNullableString(value['reason']) &&
    Array.isArray(value['blockingEvents'])
  );
}
