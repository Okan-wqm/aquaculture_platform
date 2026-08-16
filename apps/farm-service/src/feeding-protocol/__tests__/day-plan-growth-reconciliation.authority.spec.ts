import {
  computeDayPlanGrowthRollupDeltaV1,
  DAY_PLAN_GROWTH_RECONCILIATION_AUTHORITY_V1,
  freezeDayPlanGrowthPolicyV1,
} from '../day-plan-growth-reconciliation.authority';

describe('day-plan growth reconciliation authority v1', () => {
  it('freezes the plan mode under the one supported semantic version', () => {
    expect(freezeDayPlanGrowthPolicyV1('daily')).toEqual({
      version: DAY_PLAN_GROWTH_RECONCILIATION_AUTHORITY_V1.policyVersion,
      applicationMode: 'daily',
    });
  });

  it('applies only the late actual delta and supports downward corrections', () => {
    expect(
      computeDayPlanGrowthRollupDeltaV1({
        totalActualKg: 7.25,
        previouslyAppliedKg: 5,
        expectedFcr: 1.5,
      }),
    ).toEqual({ appliedDeltaKg: 2.25, growthDeltaKg: 1.5, applicable: true });
    expect(
      computeDayPlanGrowthRollupDeltaV1({
        totalActualKg: 4,
        previouslyAppliedKg: 5,
        expectedFcr: 2,
      }),
    ).toEqual({ appliedDeltaKg: -1, growthDeltaKg: -0.5, applicable: true });
  });

  it('does not advance the durable quantity when FCR is unresolved', () => {
    expect(
      computeDayPlanGrowthRollupDeltaV1({
        totalActualKg: 2,
        previouslyAppliedKg: 0,
        expectedFcr: 0,
      }),
    ).toEqual({ appliedDeltaKg: 2, growthDeltaKg: 0, applicable: false });
  });

  it('rejects non-finite or negative durable quantities', () => {
    expect(() =>
      computeDayPlanGrowthRollupDeltaV1({
        totalActualKg: Number.NaN,
        previouslyAppliedKg: 0,
        expectedFcr: 1,
      }),
    ).toThrow('finite and non-negative');
  });
});
