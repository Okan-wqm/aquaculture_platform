/**
 * Reply-data guards for the 13 PR-3 farm-AI query tools (Water & Health
 * specialist). farm-service already projects these shapes
 * (apps/farm-service/src/{water-quality,fish-health}/responders/projections.ts);
 * the guards are the ai-service side's defense-in-depth so a drifted
 * projection fails loudly instead of feeding the model an unexpected shape.
 */
import { AiQueryList, isAiQueryList, isUuidString } from '@platform/event-contracts';

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

// --- water-quality replies --------------------------------------------------

export interface WqStatsReply {
  windowDays: number;
  avgTemperatureC: number | null;
  avgDissolvedOxygenMgL: number | null;
  avgPh: number | null;
  avgAmmoniaMgL: number | null;
  avgNitriteMgL: number | null;
  measurementCount: number;
  criticalCount: number;
  warningCount: number;
  lastMeasurement: WqPointReply | null;
}

export interface WqPointReply {
  id: string;
  measuredAt: string | null;
  temperatureC: number | null;
  dissolvedOxygenMgL: number | null;
  ph: number | null;
  ammoniaMgL: number | null;
  nitriteMgL: number | null;
  overallStatus: string;
}

export interface CriticalWqReply extends WqPointReply {
  tankId: string | null;
  tankCode: string | null;
  tankName: string | null;
  hasAlarm: boolean;
}

export interface WqThresholdReply {
  id: string;
  code: string;
  name: string;
  unit: string;
  dataType: string;
  group: string;
  optimalMin: number | null;
  optimalMax: number | null;
  warningMin: number | null;
  warningMax: number | null;
  criticalMin: number | null;
  criticalMax: number | null;
  isActive: boolean;
  isVisible: boolean;
}

export function isWqPoint(value: unknown): value is WqPointReply {
  if (!isRec(value) || !hasStr(value, 'id') || !hasStr(value, 'overallStatus')) return false;
  return (
    hasNullableStr(value, 'measuredAt') &&
    hasNullableNum(value, 'temperatureC') &&
    hasNullableNum(value, 'dissolvedOxygenMgL') &&
    hasNullableNum(value, 'ph') &&
    hasNullableNum(value, 'ammoniaMgL') &&
    hasNullableNum(value, 'nitriteMgL')
  );
}

export function isWqStats(value: unknown): value is WqStatsReply {
  if (!isRec(value) || !hasNum(value, 'windowDays')) return false;
  if (!hasNum(value, 'measurementCount') || !hasNum(value, 'criticalCount')) return false;
  if (!hasNum(value, 'warningCount')) return false;
  if (!hasNullableNum(value, 'avgTemperatureC') || !hasNullableNum(value, 'avgDissolvedOxygenMgL')) {
    return false;
  }
  if (!hasNullableNum(value, 'avgPh') || !hasNullableNum(value, 'avgAmmoniaMgL')) return false;
  if (!hasNullableNum(value, 'avgNitriteMgL')) return false;
  const last = value.lastMeasurement;
  return last === null || last === undefined || isWqPoint(last);
}

export function isCriticalWq(value: unknown): value is CriticalWqReply {
  return (
    isWqPoint(value) &&
    isRec(value) &&
    hasNullableStr(value, 'tankId') &&
    hasNullableStr(value, 'tankCode') &&
    hasNullableStr(value, 'tankName') &&
    hasBool(value, 'hasAlarm')
  );
}

export function isWqThreshold(value: unknown): value is WqThresholdReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'id') || !hasStr(value, 'code') || !hasStr(value, 'name')) return false;
  if (!hasStr(value, 'unit') || !hasStr(value, 'dataType') || !hasStr(value, 'group')) return false;
  if (!hasBool(value, 'isActive') || !hasBool(value, 'isVisible')) return false;
  return (
    hasNullableNum(value, 'optimalMin') &&
    hasNullableNum(value, 'optimalMax') &&
    hasNullableNum(value, 'warningMin') &&
    hasNullableNum(value, 'warningMax') &&
    hasNullableNum(value, 'criticalMin') &&
    hasNullableNum(value, 'criticalMax')
  );
}

// --- fish-health replies ----------------------------------------------------

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

export interface HealthEventReply {
  id: string;
  batchId: string;
  tankId: string | null;
  title: string;
  eventType: string;
  severity: string;
  status: string;
  diseaseCategory: string | null;
  diseaseName: string | null;
  eventDate: string | null;
  isUnderTreatment: boolean;
  isQuarantined: boolean;
  labConfirmed: boolean;
  vetNotified: boolean;
  withdrawalPeriodDays: number | null;
  earliestHarvestDate: string | null;
  followUpRequired: boolean;
  nextFollowUpDate: string | null;
}

export interface LiceCountReply {
  id: string;
  siteId: string;
  tankId: string;
  batchId: string | null;
  countDate: string | null;
  reportingYear: number;
  reportingWeek: number;
  adultFemaleLice: number;
  mobileLice: number;
  attachedLice: number;
  fishSampled: number;
  seaTemperatureC: number | null;
}

export interface TreatmentReply {
  id: string;
  siteId: string;
  tankId: string | null;
  batchId: string | null;
  healthEventId: string | null;
  category: string;
  method: string;
  virkestoffType: string | null;
  styrkeVerdi: number | null;
  styrkeEnhet: string | null;
  mengdeVerdi: number | null;
  mengdeEnhet: string | null;
  wholeSite: boolean;
  pensCount: number | null;
  appliedAt: string | null;
  completedAt: string | null;
}

export interface WelfareReply {
  id: string;
  siteId: string;
  tankId: string;
  batchId: string | null;
  assessedAt: string | null;
  fishSampled: number;
  gillScore: number;
  finScore: number;
  woundScore: number;
  deformityScore: number;
}

export interface HarvestEligibilityReply {
  eligible: boolean;
  blockedUntil: string | null;
  reason: string | null;
  blockingEvents: {
    id: string;
    title: string;
    diseaseName: string | null;
    earliestHarvestDate: string | null;
    withdrawalPeriodDays: number | null;
    status: string;
  }[];
}

export function isFishHealthStats(value: unknown): value is FishHealthStatsReply {
  if (!isRec(value)) return false;
  for (const key of [
    'total',
    'active',
    'critical',
    'underTreatment',
    'quarantined',
    'resolved',
  ] as const) {
    if (!hasNum(value, key)) return false;
  }
  return isRec(value.byEventType) && isRec(value.bySeverity);
}

export function isHealthEvent(value: unknown): value is HealthEventReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'id') || !hasStr(value, 'batchId') || !hasStr(value, 'title')) return false;
  if (!hasStr(value, 'eventType') || !hasStr(value, 'severity') || !hasStr(value, 'status')) {
    return false;
  }
  if (!hasNullableStr(value, 'tankId') || !hasNullableStr(value, 'diseaseName')) return false;
  if (!hasNullableStr(value, 'diseaseCategory') || !hasNullableStr(value, 'eventDate')) {
    return false;
  }
  if (!hasBool(value, 'isUnderTreatment') || !hasBool(value, 'isQuarantined')) return false;
  if (!hasBool(value, 'labConfirmed') || !hasBool(value, 'vetNotified')) return false;
  if (!hasBool(value, 'followUpRequired')) return false;
  return (
    hasNullableNum(value, 'withdrawalPeriodDays') &&
    hasNullableStr(value, 'earliestHarvestDate') &&
    hasNullableStr(value, 'nextFollowUpDate')
  );
}

export function isLiceCount(value: unknown): value is LiceCountReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'id') || !hasStr(value, 'siteId') || !hasStr(value, 'tankId')) return false;
  if (!hasNum(value, 'reportingYear') || !hasNum(value, 'reportingWeek')) return false;
  if (!hasNum(value, 'adultFemaleLice') || !hasNum(value, 'mobileLice')) return false;
  if (!hasNum(value, 'attachedLice') || !hasNum(value, 'fishSampled')) return false;
  return hasNullableStr(value, 'countDate') && hasNullableNum(value, 'seaTemperatureC');
}

export function isTreatment(value: unknown): value is TreatmentReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'id') || !hasStr(value, 'siteId') || !hasStr(value, 'category')) return false;
  if (!hasStr(value, 'method') || !hasBool(value, 'wholeSite')) return false;
  return (
    hasNullableStr(value, 'appliedAt') &&
    hasNullableStr(value, 'completedAt') &&
    hasNullableStr(value, 'tankId') &&
    hasNullableNum(value, 'styrkeVerdi') &&
    hasNullableNum(value, 'mengdeVerdi')
  );
}

export function isWelfare(value: unknown): value is WelfareReply {
  if (!isRec(value)) return false;
  if (!hasStr(value, 'id') || !hasStr(value, 'siteId') || !hasStr(value, 'tankId')) return false;
  if (
    !hasNum(value, 'fishSampled') ||
    !hasNum(value, 'gillScore') ||
    !hasNum(value, 'finScore') ||
    !hasNum(value, 'woundScore') ||
    !hasNum(value, 'deformityScore')
  ) {
    return false;
  }
  return hasNullableStr(value, 'assessedAt');
}

export function isHarvestEligibility(value: unknown): value is HarvestEligibilityReply {
  if (!isRec(value) || !hasBool(value, 'eligible')) return false;
  if (!hasNullableStr(value, 'blockedUntil') || !hasNullableStr(value, 'reason')) return false;
  if (!Array.isArray(value.blockingEvents)) return false;
  return value.blockingEvents.every(
    (event) =>
      isRec(event) && hasStr(event, 'id') && hasStr(event, 'title') && hasStr(event, 'status'),
  );
}

/** List-reply combinator: bounded list whose items all pass `isItem`. */
export function isAiListOf<T>(
  isItem: (value: unknown) => value is T,
): (value: unknown) => value is AiQueryList<T> {
  return (value: unknown): value is AiQueryList<T> =>
    isAiQueryList(value) && value.items.every(isItem);
}

/** Shared helper: uuid inputs stay uuids on the request wire. */
export function uuidOrUndefined(value: unknown): string | undefined {
  return isUuidString(value) ? value : undefined;
}
