/**
 * The discount rules, asked directly (ADR-0013 / BILLING-CRITICAL-002).
 *
 * These are the questions `validate` and `apply` both ask. The old admin-side
 * implementation asked them twice — once in `validateCode` and again while
 * computing the amount in `applyDiscount` — so the message a customer saw and
 * the money actually taken off could differ. One pure function is the fix, and
 * this spec pins its answers.
 */
import { roundToCurrency } from '@aquaculture/backend-common/monetary';
import Decimal from 'decimal.js';

import {
  DiscountAppliesTo,
  DiscountCode,
  DiscountDuration,
  DiscountType,
} from '../entities/discount-code.entity';
import { evaluateDiscount, grantOf } from '../services/discount-rules';

const NOW = new Date('2026-06-15T12:00:00.000Z');

function code(overrides: Partial<DiscountCode> = {}): DiscountCode {
  const base: DiscountCode = {
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    code: 'SUMMER',
    name: 'Summer',
    description: null,
    discountType: DiscountType.PERCENTAGE,
    percentOff: new Decimal('10'),
    amountOff: null,
    freeMonths: null,
    trialExtensionDays: null,
    currency: 'USD',
    appliesTo: DiscountAppliesTo.ALL_PLANS,
    applicablePlanIds: null,
    duration: DiscountDuration.ONCE,
    durationInMonths: null,
    isActive: true,
    validFrom: null,
    validUntil: null,
    maxRedemptions: null,
    currentRedemptions: 0,
    maxRedemptionsPerTenant: null,
    minimumOrderAmount: null,
    campaignId: null,
    campaignName: null,
    stripePromotionCodeId: null,
    stripeCouponId: null,
    metadata: null,
    isReferralCode: false,
    referrerId: null,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: null,
    updatedBy: null,
  };
  return Object.assign(base, overrides);
}

const context = (over: Partial<Parameters<typeof evaluateDiscount>[1]> = {}) => ({
  now: NOW,
  tenantRedemptions: 0,
  ...over,
});

describe('evaluateDiscount (BILLING-CRITICAL-002)', () => {
  it('accepts an unrestricted active code', () => {
    expect(evaluateDiscount(code(), context()).valid).toBe(true);
  });

  it.each([
    ['inactive', code({ isActive: false }), 'inactive'],
    ['not yet valid', code({ validFrom: new Date('2026-07-01T00:00:00Z') }), 'not_yet_valid'],
    ['expired', code({ validUntil: new Date('2026-01-01T00:00:00Z') }), 'expired'],
    [
      'globally exhausted',
      code({ maxRedemptions: 5, currentRedemptions: 5 }),
      'redemption_limit_reached',
    ],
  ])('refuses a code that is %s', (_label, subject, reason) => {
    const result = evaluateDiscount(subject, context());
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toBe(reason);
  });

  it('refuses a tenant that has used its own allowance', () => {
    const result = evaluateDiscount(
      code({ maxRedemptionsPerTenant: 2 }),
      context({ tenantRedemptions: 2 }),
    );
    expect(result.valid === false && result.reason).toBe('tenant_limit_reached');
  });

  it('refuses a below-minimum order', () => {
    const result = evaluateDiscount(
      code({ minimumOrderAmount: new Decimal('100') }),
      context({ orderAmount: new Decimal('99.99') }),
    );
    expect(result.valid === false && result.reason).toBe('below_minimum_order');
  });

  describe('appliesTo — a restriction that cannot be evaluated refuses', () => {
    it('refuses a specific-plans code when no plan is named', () => {
      const subject = code({
        appliesTo: DiscountAppliesTo.SPECIFIC_PLANS,
        applicablePlanIds: ['11111111-2222-4333-8444-555555555555'],
      });
      // The previous rules only checked the list when a plan happened to be
      // supplied, so omitting it bypassed the restriction entirely.
      expect(evaluateDiscount(subject, context()).valid).toBe(false);
      expect(
        evaluateDiscount(subject, context({ planId: '11111111-2222-4333-8444-555555555555' }))
          .valid,
      ).toBe(true);
    });

    it('refuses an upgrades-only code unless the change is an upgrade', () => {
      const subject = code({ appliesTo: DiscountAppliesTo.UPGRADES_ONLY });
      const refused = evaluateDiscount(subject, context());
      expect(refused.valid === false && refused.reason).toBe('upgrades_only');
      expect(evaluateDiscount(subject, context({ subscriptionChange: 'new' })).valid).toBe(false);
      expect(evaluateDiscount(subject, context({ subscriptionChange: 'upgrade' })).valid).toBe(
        true,
      );
    });

    it('refuses a new-subscriptions-only code unless the change is new', () => {
      const subject = code({ appliesTo: DiscountAppliesTo.NEW_SUBSCRIPTIONS_ONLY });
      const refused = evaluateDiscount(subject, context({ subscriptionChange: 'upgrade' }));
      expect(refused.valid === false && refused.reason).toBe('new_subscriptions_only');
      expect(evaluateDiscount(subject, context({ subscriptionChange: 'new' })).valid).toBe(true);
    });
  });
});

describe('grantOf (BILLING-CRITICAL-002)', () => {
  it('takes a percentage of the order, rounded to the currency minor unit', () => {
    const grant = grantOf(code({ percentOff: new Decimal('33.33') }), new Decimal('10.00'));
    expect(grant).toEqual({ kind: 'amount', amountOff: new Decimal('3.33') });
  });

  it('rounds a percentage to whole units in a zero-decimal currency', () => {
    const grant = grantOf(
      code({ currency: 'JPY', percentOff: new Decimal('33.33') }),
      new Decimal('1000'),
    );
    expect(grant).toEqual({ kind: 'amount', amountOff: new Decimal('333') });
  });

  it('never takes more than the order for a fixed amount', () => {
    const subject = code({
      discountType: DiscountType.FIXED_AMOUNT,
      percentOff: null,
      amountOff: new Decimal('50.00'),
    });
    expect(grantOf(subject, new Decimal('20.00'))).toEqual({
      kind: 'amount',
      amountOff: new Decimal('20.00'),
    });
  });

  it('grants a period rather than an amount for the free kinds', () => {
    // The single-column calculator returned 0 here, so a "2 months free" code
    // silently discounted nothing and reported success.
    const months = code({
      discountType: DiscountType.FREE_MONTHS,
      percentOff: null,
      freeMonths: 2,
    });
    expect(grantOf(months, new Decimal('99.00'))).toEqual({ kind: 'free-months', months: 2 });

    const trial = code({
      discountType: DiscountType.FREE_TRIAL_EXTENSION,
      percentOff: null,
      trialExtensionDays: 14,
    });
    expect(grantOf(trial, new Decimal('99.00'))).toEqual({ kind: 'trial-extension', days: 14 });
  });

  it('keeps exact decimals — 0.1 + 0.2 arithmetic never appears', () => {
    const subject = code({ percentOff: new Decimal('10') });
    const grant = grantOf(subject, new Decimal('19.99'));
    expect(grant.kind === 'amount' && grant.amountOff.toString()).toBe('2');
  });
});

describe('roundToCurrency', () => {
  it('rounds half up to the currency minor unit', () => {
    expect(roundToCurrency(new Decimal('1.005'), 'USD').toString()).toBe('1.01');
    expect(roundToCurrency(new Decimal('1.005'), 'JPY').toString()).toBe('1');
    expect(roundToCurrency(new Decimal('1.0005'), 'BHD').toString()).toBe('1.001');
  });
});
