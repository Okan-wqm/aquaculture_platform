import { canonicalWireJsonStringifyV1 } from '@aquaculture/shared-contracts';
import {
  FEEDING_METHOD,
  decodeFeedingRecordTime,
  decodeFeedingRecordEnvironment,
  decodeFeedingRecordFishBehavior,
  decodeOptionalFeedingCurrency,
  type FeedingJobId,
} from '@aquaculture/feeding-contracts';

import type {
  DayPlanOperationResult,
  FeedingOperationCommandResult,
  FeedingRecordOperationResult,
  MealOperationResult,
} from './feeding-operation-command';

export interface FeedingOperationResultEnvelope<K extends FeedingJobId = FeedingJobId> {
  readonly schema: `feeding-operation-result/${K}/v1`;
  readonly payload: unknown;
}

export interface FeedingOperationResultCodec<K extends FeedingJobId> {
  encode(result: FeedingOperationCommandResult<K>): FeedingOperationResultEnvelope<K>;
  decode(payload: unknown): FeedingOperationCommandResult<K>;
}

type VoidFeedingJobId =
  | 'v2.day-plan.generate'
  | 'v2.meal-window.sweep'
  | 'v2.morning.sweep'
  | 'v2.daily-summary.publish'
  | 'v2.stock-coverage.refresh'
  | 'v2.fcr-alert.sweep'
  | 'v2.retention.purge';

type DayPlanFeedingJobId = 'manual.day-plan.regenerate' | 'manual.feed.transition';
type MealFeedingJobId =
  | 'manual.meal.correct'
  | 'manual.meal.finalize'
  | 'manual.meal.skip'
  | 'mobile.meal.record';
type FeedingRecordResultJobId = 'manual.feeding.record' | 'manual.feeding.update';

function normalizedJson(value: unknown): unknown {
  const normalized: unknown = JSON.parse(canonicalWireJsonStringifyV1(value));
  return normalized;
}

function validatedPayload<R>(value: R, decode: (payload: unknown) => R): unknown {
  const wireValue = normalizedJson(value);
  return normalizedJson(decode(wireValue));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const actual = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new TypeError('Persisted feeding result is missing a required field');
  }
  if (actual.some((key) => !allowed.has(key))) {
    throw new TypeError('Persisted feeding result contains an unknown field');
  }
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function nullableFiniteNumber(value: unknown, label: string): number | null {
  return value === null ? null : finiteNumber(value, label);
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : finiteNumber(value, label);
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  const decoded = finiteNumber(value, label);
  if (!Number.isSafeInteger(decoded) || decoded < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return decoded;
}

function optionalNonNegativeSafeInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : nonNegativeSafeInteger(value, label);
}

function boundedString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1_000) {
    throw new TypeError(`${label} must be a bounded string`);
  }
  return value;
}

function optionalBoundedString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : boundedString(value, label);
}

function dateValue(value: unknown, label: string): Date {
  const encoded = boundedString(value, label);
  const parsed = new Date(encoded);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== encoded) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return parsed;
}

function optionalDateValue(value: unknown, label: string): Date | undefined {
  return value === undefined ? undefined : dateValue(value, label);
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  for (const candidate of allowed) {
    if (value === candidate) return candidate;
  }
  throw new TypeError(`${label} is invalid`);
}

export function feedingVoidResultCodec<K extends VoidFeedingJobId>(jobId: K) {
  const decode = (payload: unknown): void => {
    const value = record(payload, 'Void feeding result');
    exactKeys(value, []);
  };
  return Object.freeze({
    encode(_result: void): FeedingOperationResultEnvelope<K> {
      const payload = Object.freeze({});
      decode(payload);
      return {
        schema: `feeding-operation-result/${jobId}/v1`,
        payload,
      };
    },
    decode,
  });
}

export function feedingForecastResultCodec(): FeedingOperationResultCodec<'v2.forecast.refresh'> {
  const decode = (payload: unknown): number => {
    const value = record(payload, 'Forecast result');
    exactKeys(value, ['refreshedCount']);
    return nonNegativeSafeInteger(value.refreshedCount, 'refreshedCount');
  };
  return {
    encode: (result) => {
      const payload = { refreshedCount: result };
      decode(payload);
      return {
        schema: 'feeding-operation-result/v2.forecast.refresh/v1',
        payload,
      };
    },
    decode,
  };
}

export function feedingDayPlanResultCodec<K extends DayPlanFeedingJobId>(jobId: K) {
  const decode = (payload: unknown): DayPlanOperationResult => {
    const value = record(payload, 'Day-plan result');
    exactKeys(value, ['outcome'], ['dayPlanId']);
    const outcome = enumValue(
      value.outcome,
      ['recalculated', 'generated', 'transitioned'],
      'Day-plan result outcome',
    );
    const dayPlanId = optionalBoundedString(value.dayPlanId, 'dayPlanId');
    return Object.freeze({
      outcome,
      ...(dayPlanId === undefined ? {} : { dayPlanId }),
    });
  };
  return Object.freeze({
    encode(result: DayPlanOperationResult): FeedingOperationResultEnvelope<K> {
      return {
        schema: `feeding-operation-result/${jobId}/v1`,
        payload: validatedPayload(result, decode),
      };
    },
    decode,
  });
}

export function feedingMealResultCodec<K extends MealFeedingJobId>(jobId: K) {
  const decode = (payload: unknown): MealOperationResult => {
    const value = record(payload, 'Meal result');
    exactKeys(value, ['id', 'status', 'actualKg', 'varianceKg', 'variancePercent']);
    return Object.freeze({
      id: boundedString(value.id, 'id'),
      status: enumValue(
        value.status,
        ['scheduled', 'fed', 'partially_fed', 'skipped', 'missed', 'cancelled'],
        'Meal result status',
      ),
      actualKg: finiteNumber(value.actualKg, 'actualKg'),
      varianceKg: nullableFiniteNumber(value.varianceKg, 'varianceKg'),
      variancePercent: nullableFiniteNumber(value.variancePercent, 'variancePercent'),
    });
  };
  return Object.freeze({
    encode(result: MealOperationResult): FeedingOperationResultEnvelope<K> {
      return {
        schema: `feeding-operation-result/${jobId}/v1`,
        payload: validatedPayload(result, decode),
      };
    },
    decode,
  });
}

const FEEDING_RECORD_REQUIRED_KEYS = Object.freeze([
  'id',
  'tenantId',
  'batchId',
  'feedingDate',
  'feedingTime',
  'feedingSequence',
  'totalMealsToday',
  'feedId',
  'plannedAmount',
  'actualAmount',
  'variance',
  'variancePercent',
  'feedCostDecimal',
  'fedBy',
  'feedingMethod',
  'createdAt',
  'updatedAt',
] as const);

const FEEDING_RECORD_OPTIONAL_KEYS = Object.freeze([
  'tankId',
  'pondId',
  'batchLocationId',
  'feedBatchNumber',
  'wasteAmount',
  'mealId',
  'pourIndex',
  'dayPlanId',
  'environment',
  'fishBehavior',
  'equipmentId',
  'feedingDurationMinutes',
  'feedCost',
  'currency',
  'verifiedBy',
  'verifiedAt',
  'notes',
  'skipReason',
] as const);

export function feedingRecordResultCodec<K extends FeedingRecordResultJobId>(jobId: K) {
  const decode = (payload: unknown): FeedingRecordOperationResult => {
    const value = record(payload, 'Feeding-record result');
    exactKeys(value, FEEDING_RECORD_REQUIRED_KEYS, FEEDING_RECORD_OPTIONAL_KEYS);

    const tankId = optionalBoundedString(value.tankId, 'tankId');
    const pondId = optionalBoundedString(value.pondId, 'pondId');
    const batchLocationId = optionalBoundedString(value.batchLocationId, 'batchLocationId');
    const feedBatchNumber = optionalBoundedString(value.feedBatchNumber, 'feedBatchNumber');
    const wasteAmount = optionalFiniteNumber(value.wasteAmount, 'wasteAmount');
    const mealId = optionalBoundedString(value.mealId, 'mealId');
    const pourIndex = optionalNonNegativeSafeInteger(value.pourIndex, 'pourIndex');
    const dayPlanId = optionalBoundedString(value.dayPlanId, 'dayPlanId');
    const environment = decodeFeedingRecordEnvironment(value.environment);
    const fishBehavior = decodeFeedingRecordFishBehavior(value.fishBehavior);
    const equipmentId = optionalBoundedString(value.equipmentId, 'equipmentId');
    const feedingDurationMinutes = optionalNonNegativeSafeInteger(
      value.feedingDurationMinutes,
      'feedingDurationMinutes',
    );
    const feedCost = optionalFiniteNumber(value.feedCost, 'feedCost');
    const currency = decodeOptionalFeedingCurrency(value.currency);
    const verifiedBy = optionalBoundedString(value.verifiedBy, 'verifiedBy');
    const verifiedAt = optionalDateValue(value.verifiedAt, 'verifiedAt');
    const notes = optionalBoundedString(value.notes, 'notes');
    const skipReason = optionalBoundedString(value.skipReason, 'skipReason');

    return Object.freeze({
      id: boundedString(value.id, 'id'),
      tenantId: boundedString(value.tenantId, 'tenantId'),
      batchId: boundedString(value.batchId, 'batchId'),
      ...(tankId === undefined ? {} : { tankId }),
      ...(pondId === undefined ? {} : { pondId }),
      ...(batchLocationId === undefined ? {} : { batchLocationId }),
      feedingDate: dateValue(value.feedingDate, 'feedingDate'),
      feedingTime: decodeFeedingRecordTime(value.feedingTime),
      feedingSequence: nonNegativeSafeInteger(value.feedingSequence, 'feedingSequence'),
      totalMealsToday: nonNegativeSafeInteger(value.totalMealsToday, 'totalMealsToday'),
      feedId: boundedString(value.feedId, 'feedId'),
      ...(feedBatchNumber === undefined ? {} : { feedBatchNumber }),
      plannedAmount: finiteNumber(value.plannedAmount, 'plannedAmount'),
      actualAmount: finiteNumber(value.actualAmount, 'actualAmount'),
      variance: finiteNumber(value.variance, 'variance'),
      variancePercent: finiteNumber(value.variancePercent, 'variancePercent'),
      ...(wasteAmount === undefined ? {} : { wasteAmount }),
      ...(mealId === undefined ? {} : { mealId }),
      ...(pourIndex === undefined ? {} : { pourIndex }),
      ...(dayPlanId === undefined ? {} : { dayPlanId }),
      ...(environment === undefined ? {} : { environment }),
      ...(fishBehavior === undefined ? {} : { fishBehavior }),
      feedingMethod: enumValue(
        value.feedingMethod,
        Object.values(FEEDING_METHOD),
        'Feeding-record method',
      ),
      ...(equipmentId === undefined ? {} : { equipmentId }),
      ...(feedingDurationMinutes === undefined ? {} : { feedingDurationMinutes }),
      ...(feedCost === undefined ? {} : { feedCost }),
      feedCostDecimal: nullableFiniteNumber(value.feedCostDecimal, 'feedCostDecimal'),
      ...(currency === undefined ? {} : { currency }),
      fedBy: boundedString(value.fedBy, 'fedBy'),
      ...(verifiedBy === undefined ? {} : { verifiedBy }),
      ...(verifiedAt === undefined ? {} : { verifiedAt }),
      ...(notes === undefined ? {} : { notes }),
      ...(skipReason === undefined ? {} : { skipReason }),
      createdAt: dateValue(value.createdAt, 'createdAt'),
      updatedAt: dateValue(value.updatedAt, 'updatedAt'),
    });
  };
  return Object.freeze({
    encode(result: FeedingRecordOperationResult): FeedingOperationResultEnvelope<K> {
      return {
        schema: `feeding-operation-result/${jobId}/v1`,
        payload: validatedPayload(result, decode),
      };
    },
    decode,
  });
}
