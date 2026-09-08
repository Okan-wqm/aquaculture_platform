import { BILLING_CYCLES, type BillingCycle } from '@platform/event-contracts';
import Decimal from 'decimal.js';

import { Money } from '../../monetary';
import {
  BILLING_CYCLE_COMMITMENT_DISCOUNT,
  BILLING_CYCLE_MONTHS,
  addBillingCycle,
  commitmentDiscountRateFor,
  cycleAmountFor,
  isBillingCycle,
} from '../billing-cycle-terms';

/**
 * BILLING-CRITICAL-007.
 *
 * The quote and the invoice disagreed about what a longer cycle costs. These
 * cases pin the agreement itself — the numbers, their totality over the cycles
 * the platform sells, and the exactness the invoice depends on.
 */
describe('billing cycle commercial terms', () => {
  const usd = (amount: number): Money => Money.of(amount, 'USD');

  it('covers every cycle the platform sells, in both tables', () => {
    // A cycle added without a commercial term would fall through to
    // `undefined`, and `new Decimal(undefined)` throws while
    // `Money.multiply(undefined)` is NaN — either way a billing run that
    // should never have started. Totality is asserted here rather than
    // discovered at the first invoice.
    for (const cycle of BILLING_CYCLES) {
      expect(typeof BILLING_CYCLE_MONTHS[cycle]).toBe('number');
      expect(typeof BILLING_CYCLE_COMMITMENT_DISCOUNT[cycle]).toBe('string');
    }
    expect(Object.keys(BILLING_CYCLE_MONTHS).sort()).toEqual([...BILLING_CYCLES].sort());
    expect(Object.keys(BILLING_CYCLE_COMMITMENT_DISCOUNT).sort()).toEqual(
      [...BILLING_CYCLES].sort(),
    );
  });

  it('states the commercial terms the operator quote has always used', () => {
    expect(BILLING_CYCLE_MONTHS).toEqual({ monthly: 1, quarterly: 3, semi_annual: 6, annual: 12 });
    expect(BILLING_CYCLE_COMMITMENT_DISCOUNT).toEqual({
      monthly: '0',
      quarterly: '0.05',
      semi_annual: '0.10',
      annual: '0.15',
    });
  });

  it('reads every rate back as an exact Decimal', () => {
    // BILLING-HIGH-009. The rates are stored as decimal strings so the value
    // the platform charges is the value written, not the nearest double to it.
    // `ModulePricingService.quote` prices in raw Decimal and never builds a
    // Money, so this accessor — not `cycleAmountFor` — is the surface that
    // stopped it from restating the table.
    for (const cycle of BILLING_CYCLES) {
      const rate = commitmentDiscountRateFor(cycle);
      expect(rate).toBeInstanceOf(Decimal);
      expect(rate.toString()).toBe(
        new Decimal(BILLING_CYCLE_COMMITMENT_DISCOUNT[cycle]).toString(),
      );
    }
    expect(commitmentDiscountRateFor('annual').equals(new Decimal('0.15'))).toBe(true);
    expect(commitmentDiscountRateFor('monthly').isZero()).toBe(true);
  });

  it.each<[BillingCycle, number, number, number]>([
    ['monthly', 100, 100, 0],
    ['quarterly', 100, 300, 15],
    ['semi_annual', 100, 600, 60],
    ['annual', 100, 1200, 180],
  ])('prices a %s cycle on a $%d monthly rate', (cycle, monthly, gross, discount) => {
    const amount = cycleAmountFor(usd(monthly), cycle);

    expect(amount.gross.toDecimal().toNumber()).toBe(gross);
    expect(amount.commitmentDiscount.toDecimal().toNumber()).toBe(discount);
    expect(amount.net.toDecimal().toNumber()).toBe(gross - discount);
  });

  it('reports the rate it actually applied', () => {
    // The invoice names the discount rate it granted. A `CycleAmount` that
    // reported one rate and charged another would reconcile against nothing.
    for (const cycle of BILLING_CYCLES) {
      const amount = cycleAmountFor(usd(100), cycle);
      expect(amount.discountRate.equals(commitmentDiscountRateFor(cycle))).toBe(true);
      expect(amount.gross.multiply(amount.discountRate).toMinorUnits()).toBe(
        amount.commitmentDiscount.toMinorUnits(),
      );
    }
  });

  it('keeps gross minus discount exactly equal to net', () => {
    // The invoice stores all three. If they did not reconcile to the cent, the
    // document would not add up, which is the failure mode a customer notices.
    for (const cycle of BILLING_CYCLES) {
      const amount = cycleAmountFor(usd(33.33), cycle);
      expect(amount.gross.subtract(amount.commitmentDiscount).equals(amount.net)).toBe(true);
    }
  });

  it('rounds the discount at the currency boundary but not the gross', () => {
    // The gross is a whole number of months of a stored rate — rounding it
    // would truncate a rate the platform holds to four decimal places. The
    // discount is a fraction, so it is the step that can go sub-cent.
    const monthly = cycleAmountFor(Money.of('33.333', 'USD'), 'monthly');
    expect(monthly.gross.toDecimal().toString()).toBe('33.333');
    expect(monthly.net.toDecimal().toString()).toBe('33.333');

    // 33.333 x 3 = 99.999; 5% of that is 4.99995, which is not an amount of money.
    const quarterly = cycleAmountFor(Money.of('33.333', 'USD'), 'quarterly');
    expect(quarterly.gross.toDecimal().toString()).toBe('99.999');
    expect(quarterly.commitmentDiscount.toDecimal().toNumber()).toBe(5);
  });

  describe('addBillingCycle', () => {
    const iso = (date: Date): string =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
        date.getDate(),
      ).padStart(2, '0')}`;

    it.each<[BillingCycle, string]>([
      ['monthly', '2026-02-15'],
      ['quarterly', '2026-04-15'],
      ['semi_annual', '2026-07-15'],
      ['annual', '2027-01-15'],
    ])('advances a %s period by its own length', (cycle, expected) => {
      expect(iso(addBillingCycle(new Date(2026, 0, 15), cycle))).toBe(expected);
    });

    it('clamps the day instead of counting past the end of the target month', () => {
      // BILLING-HIGH-008. `setMonth(0 + 1)` on 31 January asks JS for 31
      // February, and JS answers 3 March. `SubscriptionCoreService` wrote it
      // that way while billing-service's three copies clamped, so the two
      // services disagreed about when a period ends — for exactly the
      // subscriptions that start on a 29th, 30th or 31st.
      expect(iso(addBillingCycle(new Date(2026, 0, 31), 'monthly'))).toBe('2026-02-28');
      expect(iso(addBillingCycle(new Date(2026, 4, 31), 'monthly'))).toBe('2026-06-30');
      expect(iso(addBillingCycle(new Date(2026, 10, 30), 'quarterly'))).toBe('2027-02-28');
    });

    it('keeps 29 February in a leap year and clamps it out of a common one', () => {
      expect(iso(addBillingCycle(new Date(2028, 1, 29), 'annual'))).toBe('2029-02-28');
      expect(iso(addBillingCycle(new Date(2027, 1, 28), 'annual'))).toBe('2028-02-28');
    });

    it('does not mutate the date it was given', () => {
      // All four copies happened to build a fresh Date, so this held before the
      // consolidation too. It is pinned because it is now a property of ONE
      // function that four callers depend on: a future implementation that
      // mutated its argument would hand every caller that reused its start date
      // the end date back instead.
      const start = new Date(2026, 0, 15);
      addBillingCycle(start, 'annual');
      expect(iso(start)).toBe('2026-01-15');
    });

    it('carries the time of day through unchanged', () => {
      const start = new Date(2026, 0, 15, 13, 45, 30, 123);
      const end = addBillingCycle(start, 'quarterly');
      expect([end.getHours(), end.getMinutes(), end.getSeconds(), end.getMilliseconds()]).toEqual([
        13, 45, 30, 123,
      ]);
    });
  });

  it('narrows an untyped cycle string, and refuses one with no commercial term', () => {
    expect(isBillingCycle('annual')).toBe(true);
    expect(isBillingCycle('biennial')).toBe(false);
    expect(isBillingCycle('')).toBe(false);
  });
});
