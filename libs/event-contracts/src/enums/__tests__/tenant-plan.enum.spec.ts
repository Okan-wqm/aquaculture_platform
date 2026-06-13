import {
  TenantPlan,
  PLAN_LEVEL,
  planLevel,
  planMeetsMinimum,
} from '../tenant-plan.enum';

/**
 * Tier-ordinal contract for the plan-level SSoT (MT-MEDIUM-001).
 *
 * The EXPECTED ranks below are declared independently of {@link PLAN_LEVEL} so
 * a re-ranking of the source map that is not also reflected here fails CI — the
 * spec is the second witness, not a copy of the impl.
 */
const EXPECTED_LEVEL: Record<TenantPlan, number> = {
  [TenantPlan.FREE]: 0,
  [TenantPlan.TRIAL]: 0,
  [TenantPlan.STARTER]: 1,
  [TenantPlan.PROFESSIONAL]: 2,
  [TenantPlan.ENTERPRISE]: 3,
};

describe('PLAN_LEVEL tier ordinal (MT-MEDIUM-001)', () => {
  it('ranks every plan exactly as the independent witness matrix', () => {
    expect(PLAN_LEVEL).toEqual(EXPECTED_LEVEL);
  });

  it('covers every TenantPlan member (no gaps)', () => {
    for (const plan of Object.values(TenantPlan)) {
      expect(PLAN_LEVEL[plan]).toBeDefined();
      expect(typeof PLAN_LEVEL[plan]).toBe('number');
    }
  });

  it('orders the paid tiers strictly ascending', () => {
    expect(planLevel(TenantPlan.STARTER)).toBeLessThan(
      planLevel(TenantPlan.PROFESSIONAL),
    );
    expect(planLevel(TenantPlan.PROFESSIONAL)).toBeLessThan(
      planLevel(TenantPlan.ENTERPRISE),
    );
  });

  it('ranks TRIAL at FREE-equivalent (a state, not a paid tier)', () => {
    // A trialing tenant carries no committed paid tier, so its plan string must
    // never satisfy a paid-tier minimum (trial-ness is derived from
    // trialEndsAt, never from plan === TRIAL).
    expect(planLevel(TenantPlan.TRIAL)).toBe(planLevel(TenantPlan.FREE));
    expect(planMeetsMinimum(TenantPlan.TRIAL, TenantPlan.STARTER)).toBe(false);
    expect(planMeetsMinimum(TenantPlan.FREE, TenantPlan.STARTER)).toBe(false);
  });

  describe('planMeetsMinimum', () => {
    it('is true when the plan is the exact minimum', () => {
      expect(planMeetsMinimum(TenantPlan.PROFESSIONAL, TenantPlan.PROFESSIONAL)).toBe(
        true,
      );
    });

    it('is true when the plan exceeds the minimum', () => {
      expect(planMeetsMinimum(TenantPlan.ENTERPRISE, TenantPlan.STARTER)).toBe(true);
    });

    it('is false when the plan is below the minimum', () => {
      expect(planMeetsMinimum(TenantPlan.STARTER, TenantPlan.PROFESSIONAL)).toBe(false);
    });
  });
});
