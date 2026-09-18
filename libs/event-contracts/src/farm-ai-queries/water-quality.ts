/**
 * Water-quality shapes for the farm AI read contract. Compact projections:
 * unit-suffixed numerics, ISO dates, nulls for unmeasured values, no free
 * text and no operator identities.
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

// ── Measurements ────────────────────────────────────────────────────────────

export interface WqMeasurementDto {
  measuredAt: string;
  tankId: string | null;
  pondId: string | null;
  temperatureC: number | null;
  doMgL: number | null;
  doSaturationPct: number | null;
  ph: number | null;
  salinityPpt: number | null;
  ammoniaMgL: number | null;
  tanMgL: number | null;
  nitriteMgL: number | null;
  nitrateMgL: number | null;
  alkalinityMgL: number | null;
  /** optimal | acceptable | warning | critical | unknown */
  overallStatus: string;
}

export function isWqMeasurementDto(value: unknown): value is WqMeasurementDto {
  return (
    isRecord(value) &&
    isIsoDateString(value['measuredAt']) &&
    isNullableString(value['tankId']) &&
    isNullableString(value['pondId']) &&
    isNullableNumber(value['temperatureC']) &&
    isNullableNumber(value['doMgL']) &&
    isNullableNumber(value['doSaturationPct']) &&
    isNullableNumber(value['ph']) &&
    isNullableNumber(value['salinityPpt']) &&
    isNullableNumber(value['ammoniaMgL']) &&
    isNullableNumber(value['tanMgL']) &&
    isNullableNumber(value['nitriteMgL']) &&
    isNullableNumber(value['nitrateMgL']) &&
    isNullableNumber(value['alkalinityMgL']) &&
    typeof value['overallStatus'] === 'string'
  );
}

// ── Tank / system statistics ────────────────────────────────────────────────

export interface TankWaterQualityStatsRequest extends AiQueryRequest {
  tankId: string;
  days: number;
}
export interface SystemWaterQualityStatsRequest extends AiQueryRequest {
  systemId: string;
  days: number;
}

export interface WaterQualityStatsReply {
  /** The tank or system the statistics were computed for. */
  scopeId: string;
  days: number;
  measurementCount: number;
  criticalCount: number;
  warningCount: number;
  avgTemperatureC: number | null;
  avgDoMgL: number | null;
  avgPh: number | null;
  avgAmmoniaMgL: number | null;
  avgNitriteMgL: number | null;
  lastMeasurement: WqMeasurementDto | null;
}

export function isTankWaterQualityStatsRequest(
  value: unknown,
): value is TankWaterQualityStatsRequest {
  return (
    isAiQueryRequestShape(value, ['tankId', 'days']) &&
    isUuidString(value['tankId']) &&
    isBoundedInt(value['days'], 1, 90)
  );
}

export function isSystemWaterQualityStatsRequest(
  value: unknown,
): value is SystemWaterQualityStatsRequest {
  return (
    isAiQueryRequestShape(value, ['systemId', 'days']) &&
    isUuidString(value['systemId']) &&
    isBoundedInt(value['days'], 1, 90)
  );
}

export function isWaterQualityStatsReply(value: unknown): value is WaterQualityStatsReply {
  return (
    isRecord(value) &&
    typeof value['scopeId'] === 'string' &&
    typeof value['days'] === 'number' &&
    typeof value['measurementCount'] === 'number' &&
    typeof value['criticalCount'] === 'number' &&
    typeof value['warningCount'] === 'number' &&
    isNullableNumber(value['avgTemperatureC']) &&
    isNullableNumber(value['avgDoMgL']) &&
    isNullableNumber(value['avgPh']) &&
    isNullableNumber(value['avgAmmoniaMgL']) &&
    isNullableNumber(value['avgNitriteMgL']) &&
    (value['lastMeasurement'] === null || isWqMeasurementDto(value['lastMeasurement']))
  );
}

// ── History ─────────────────────────────────────────────────────────────────

export interface WaterQualityHistoryRequest extends AiQueryRequest {
  tankId: string;
  fromDate: string;
  toDate: string;
  limit: number;
}
export type WaterQualityHistoryReply = AiQueryList<WqMeasurementDto>;

export function isWaterQualityHistoryRequest(value: unknown): value is WaterQualityHistoryRequest {
  return (
    isAiQueryRequestShape(value, ['tankId', 'fromDate', 'toDate', 'limit']) &&
    isUuidString(value['tankId']) &&
    isBoundedDateRange(value['fromDate'], value['toDate'], FARM_AI_QUERY_LIMITS.MAX_STAT_DAYS) &&
    isBoundedInt(value['limit'], 1, 50)
  );
}
export function isWaterQualityHistoryReply(value: unknown): value is WaterQualityHistoryReply {
  return isAiQueryList(value, isWqMeasurementDto);
}

// ── Critical readings ───────────────────────────────────────────────────────

export interface CriticalWaterQualityRequest extends AiQueryRequest {
  limit: number;
}
export interface CriticalParameterDto {
  parameter: string;
  value: number;
  unit: string;
  /** critical_low | critical_high | low | high */
  status: string;
  criticalMin: number | null;
  criticalMax: number | null;
}
export interface CriticalWaterQualityDto {
  measuredAt: string;
  tankId: string | null;
  pondId: string | null;
  overallStatus: string;
  criticalParameters: CriticalParameterDto[];
}
export type CriticalWaterQualityReply = AiQueryList<CriticalWaterQualityDto>;

export function isCriticalWaterQualityRequest(
  value: unknown,
): value is CriticalWaterQualityRequest {
  return isAiQueryRequestShape(value, ['limit']) && isBoundedInt(value['limit'], 1, 50);
}
export function isCriticalWaterQualityDto(value: unknown): value is CriticalWaterQualityDto {
  return (
    isRecord(value) &&
    isIsoDateString(value['measuredAt']) &&
    isNullableString(value['tankId']) &&
    isNullableString(value['pondId']) &&
    typeof value['overallStatus'] === 'string' &&
    Array.isArray(value['criticalParameters'])
  );
}
export function isCriticalWaterQualityReply(value: unknown): value is CriticalWaterQualityReply {
  return isAiQueryList(value, isCriticalWaterQualityDto);
}

// ── Thresholds (tenant parameter configuration) ─────────────────────────────

export interface WaterQualityThresholdsRequest extends AiQueryRequest {
  /** Parameter group filter (e.g. 'basic', 'nitrogen'); omitted = all active parameters. */
  group?: string;
}
export interface WaterQualityThresholdDto {
  code: string;
  name: string;
  unit: string;
  group: string;
  optimalMin: number | null;
  optimalMax: number | null;
  warningMin: number | null;
  warningMax: number | null;
  criticalMin: number | null;
  criticalMax: number | null;
}
export type WaterQualityThresholdsReply = AiQueryList<WaterQualityThresholdDto>;

export function isWaterQualityThresholdsRequest(
  value: unknown,
): value is WaterQualityThresholdsRequest {
  return (
    isAiQueryRequestShape(value, ['group']) &&
    isOptional(value['group'], (v): v is string => typeof v === 'string' && v.length <= 64)
  );
}
export function isWaterQualityThresholdDto(value: unknown): value is WaterQualityThresholdDto {
  return (
    isRecord(value) &&
    typeof value['code'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['unit'] === 'string' &&
    typeof value['group'] === 'string' &&
    isNullableNumber(value['optimalMin']) &&
    isNullableNumber(value['optimalMax']) &&
    isNullableNumber(value['warningMin']) &&
    isNullableNumber(value['warningMax']) &&
    isNullableNumber(value['criticalMin']) &&
    isNullableNumber(value['criticalMax'])
  );
}
export function isWaterQualityThresholdsReply(
  value: unknown,
): value is WaterQualityThresholdsReply {
  return isAiQueryList(value, isWaterQualityThresholdDto);
}
