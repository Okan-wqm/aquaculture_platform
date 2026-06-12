import { TenantPlan } from '@platform/event-contracts';

import { Tenant } from './tenant.entity';

/**
 * MT-MEDIUM-001 — trial state is derived from `trialEndsAt` (the SSoT).
 *
 * Pre-fix the helpers gated on `plan === TRIAL`, which matched zero production
 * rows (tenants trial on a real tier with trialEndsAt set), so every active
 * trial was silently reported as "not on trial". The stored is_trial_active
 * column is gone; isTrialActive is now a derived getter.
 */
describe('Tenant trial derivation (MT-MEDIUM-001)', () => {
  const makeTenant = (overrides: Partial<Tenant>): Tenant =>
    Object.assign(new Tenant(), { plan: TenantPlan.STARTER, ...overrides });

  const future = (): Date => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const past = (): Date => new Date(Date.now() - 24 * 60 * 60 * 1000);

  describe('isOnTrial / isTrialActive', () => {
    it('is true when trialEndsAt is in the future — regardless of plan tier', () => {
      // The regression guard: a STARTER tenant with an open trial window IS on
      // trial. The old `plan === TRIAL` gate returned false here.
      const tenant = makeTenant({ plan: TenantPlan.STARTER, trialEndsAt: future() });
      expect(tenant.isOnTrial()).toBe(true);
      expect(tenant.isTrialActive).toBe(true);
      expect(tenant.isTrialExpired()).toBe(false);
    });

    it('is false when trialEndsAt has elapsed', () => {
      const tenant = makeTenant({ trialEndsAt: past() });
      expect(tenant.isOnTrial()).toBe(false);
      expect(tenant.isTrialActive).toBe(false);
      expect(tenant.isTrialExpired()).toBe(true);
    });

    it('is false when there is no trial window', () => {
      const tenant = makeTenant({ trialEndsAt: null });
      expect(tenant.isOnTrial()).toBe(false);
      expect(tenant.isTrialActive).toBe(false);
      expect(tenant.isTrialExpired()).toBe(false);
    });

    it('does NOT treat plan === TRIAL as a trial signal without a window', () => {
      // plan is a tier, not a trial flag: a TRIAL-plan row with no trialEndsAt
      // is not "on trial" (trial-ness derives from the date alone).
      const tenant = makeTenant({ plan: TenantPlan.TRIAL, trialEndsAt: null });
      expect(tenant.isOnTrial()).toBe(false);
      expect(tenant.isTrialActive).toBe(false);
    });

    it('isTrialActive tracks isOnTrial exactly (single derivation)', () => {
      for (const trialEndsAt of [future(), past(), null]) {
        const tenant = makeTenant({ trialEndsAt });
        expect(tenant.isTrialActive).toBe(tenant.isOnTrial());
      }
    });
  });
});
