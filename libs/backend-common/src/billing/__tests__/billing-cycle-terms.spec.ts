import { Money } from '../../monetary';
import {
  BILLING_CYCLES,
  BILLING_CYCLE_COMMITMENT_DISCOUNT,
  BILLING_CYCLE_MONTHS,
  cycleAmountFor,
  isBillingCycleValue,
  type BillingCycleValue,
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
    // `undefined`, and `Money.multiply(undefined)` is NaN — a silent
    // mispriced invoice. Totality is asserted here rather than discovered
    // at the first billing run.
    for (const cycle of BILLING_CYCLES) {
      expect(typeof BILLING_CYCLE_MONTHS[cycle]).toBe('number');
      expect(typeof BILLING_CYCLE_COMMITMENT_DISCOUNT[cycle]).toBe('number');
    }
    expect(Object.keys(BILLING_CYCLE_MONTHS).sort()).toEqual([...BILLING_CYCLES].sort());
    expect(Object.keys(BILLING_CYCLE_COMMITMENT_DISCOUNT).sort()).toEqual(
      [...BILLING_CYCLES].sort(),
    );
  });

  it('states the commercial terms the operator quote has always used', () => {
    expect(BILLING_CYCLE_MONTHS).toEqual({ monthly: 1, quarterly: 3, semi_annual: 6, annual: 12 });
    expect(BILLING_CYCLE_COMMITMENT_DISCOUNT).toEqual({
      monthly: 0,
      quarterly: 0.05,
      semi_annual: 0.1,
      annual: 0.15,
    });
  });

  it.each<[BillingCycleValue, number, number, number]>([
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

  it('narrows an untyped cycle string, and refuses one with no commercial term', () => {
    expect(isBillingCycleValue('annual')).toBe(true);
    expect(isBillingCycleValue('biennial')).toBe(false);
    expect(isBillingCycleValue('')).toBe(false);
  });
});
