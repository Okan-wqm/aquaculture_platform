import { round3 } from '../common/utils/rounding.util';
import { registerEnumType } from '@nestjs/graphql';

export const DAY_PLAN_GROWTH_APPLICATION_MODE = Object.freeze({
  PER_MEAL: 'per_meal',
  DAILY: 'daily',
} as const);

registerEnumType(DAY_PLAN_GROWTH_APPLICATION_MODE, {
  name: 'DayPlanGrowthApplicationMode',
  description: 'Immutable growth application mode frozen into a feeding day plan',
});

/**
 * Versioned source of truth for day-plan growth semantics and bounded DAILY
 * reconciliation.  A plan freezes this policy when it is created; protocol
 * edits never reinterpret an existing plan.
 */
export const DAY_PLAN_GROWTH_RECONCILIATION_AUTHORITY_V1 = Object.freeze({
  policyVersion: 1,
  applicationModes: Object.freeze(Object.values(DAY_PLAN_GROWTH_APPLICATION_MODE)),
  dailyCandidateStatuses: Object.freeze(['in_progress', 'completed'] as const),
  lookbackDays: 35,
  candidateLimit: 500,
} as const);

export type DayPlanGrowthApplicationMode =
  (typeof DAY_PLAN_GROWTH_RECONCILIATION_AUTHORITY_V1.applicationModes)[number];

export interface FrozenDayPlanGrowthPolicyV1 {
  readonly version: typeof DAY_PLAN_GROWTH_RECONCILIATION_AUTHORITY_V1.policyVersion;
  readonly applicationMode: DayPlanGrowthApplicationMode;
}

export function freezeDayPlanGrowthPolicyV1(
  applicationMode: DayPlanGrowthApplicationMode,
): FrozenDayPlanGrowthPolicyV1 {
  if (
    applicationMode !== DAY_PLAN_GROWTH_APPLICATION_MODE.PER_MEAL &&
    applicationMode !== DAY_PLAN_GROWTH_APPLICATION_MODE.DAILY
  ) {
    throw new Error(`Unsupported day-plan growth application mode: ${String(applicationMode)}`);
  }
  return Object.freeze({
    version: DAY_PLAN_GROWTH_RECONCILIATION_AUTHORITY_V1.policyVersion,
    applicationMode,
  });
}

export interface DayPlanGrowthRollupDeltaV1 {
  readonly appliedDeltaKg: number;
  readonly growthDeltaKg: number;
  readonly applicable: boolean;
}

/**
 * Quantity reconciliation, not a one-shot flag.  Negative deltas are valid:
 * correcting a finalized pour downwards must reverse only the corresponding
 * growth on the next DAILY pass.
 */
export function computeDayPlanGrowthRollupDeltaV1(input: {
  readonly totalActualKg: number;
  readonly previouslyAppliedKg: number;
  readonly expectedFcr: number;
}): DayPlanGrowthRollupDeltaV1 {
  if (
    !Number.isFinite(input.totalActualKg) ||
    input.totalActualKg < 0 ||
    !Number.isFinite(input.previouslyAppliedKg) ||
    input.previouslyAppliedKg < 0
  ) {
    throw new Error('Day-plan growth reconciliation quantities must be finite and non-negative');
  }

  const appliedDeltaKg = round3(input.totalActualKg - input.previouslyAppliedKg);
  if (!Number.isFinite(input.expectedFcr) || input.expectedFcr <= 0) {
    return { appliedDeltaKg, growthDeltaKg: 0, applicable: false };
  }

  return {
    appliedDeltaKg,
    growthDeltaKg: round3(appliedDeltaKg / input.expectedFcr),
    applicable: true,
  };
}
