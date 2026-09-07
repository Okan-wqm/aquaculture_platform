/**
 * Commercial terms of a billing cycle — the single source of truth.
 *
 * # Why this module exists
 *
 * What a longer billing cycle costs was written twice, and the two copies
 * disagreed. `PricingCalculatorService.calculatePricing` (admin-api-service)
 * multiplies the monthly total by the months in the cycle and takes a
 * commitment discount off — 5% quarterly, 10% semi-annual, 15% annual. That is
 * the number an operator approves and a customer signs.
 * `BillingSchedulerService` (billing-service) multiplied by the months and took
 * nothing off.
 *
 * So an annual tenant was invoiced 15% above the price they agreed to, every
 * year, and a quarterly one 5% above. Neither figure is implausible on its own,
 * and nobody reconciles a quote against an invoice by hand, so nothing said so.
 *
 * The terms live in `libs/backend-common` rather than either service because
 * both sides of the disagreement are in different services: admin-api-service
 * quotes, billing-service invoices, and a rule that has to hold across a
 * service boundary cannot be owned by one side of it. Both already depend on
 * backend-common.
 *
 * # Scope
 *
 * These are COMMERCIAL terms — what the platform charges for committing to a
 * longer cycle. `BILLING_CYCLE_MONTHS` is also the cycle's length, and several
 * date-arithmetic paths still carry their own copy of it (BILLING-HIGH-008);
 * those never disagreed with anything, so they are a separate consolidation.
 * The commitment discount exists only here, and
 * `tests/invariants/billing-cycle-terms-single-source.spec.ts` keeps it that way.
 */

import { Money } from '../monetary';

/**
 * The cycles the platform sells on, as the string values every service's local
 * `BillingCycle` enum uses (`subscription.entity.ts`,
 * `plan-definition.entity.ts`, `analytics/entities/external/subscription.entity.ts`
 * all declare the same four). Keying on the values rather than importing one
 * service's enum is what lets both services share the terms without either
 * depending on the other's entity.
 */
export const BILLING_CYCLES = ['monthly', 'quarterly', 'semi_annual', 'annual'] as const;

export type BillingCycleValue = (typeof BILLING_CYCLES)[number];

/** Months billed in one cycle. */
export const BILLING_CYCLE_MONTHS: Readonly<Record<BillingCycleValue, number>> = {
  monthly: 1,
  quarterly: 3,
  semi_annual: 6,
  annual: 12,
};

/**
 * The discount granted for committing to a longer cycle, as a fraction of the
 * gross cycle amount. Changing a number here changes what the platform charges,
 * so it is a commercial decision, not a refactor.
 */
export const BILLING_CYCLE_COMMITMENT_DISCOUNT: Readonly<Record<BillingCycleValue, number>> = {
  monthly: 0,
  quarterly: 0.05,
  semi_annual: 0.1,
  annual: 0.15,
};

/** What one cycle costs, decomposed the way an invoice presents it. */
export interface CycleAmount {
  /** Months billed in this cycle. */
  readonly months: number;
  /** The commitment discount rate applied, as a fraction. */
  readonly discountRate: number;
  /** Monthly rate × months, before the commitment discount. */
  readonly gross: Money;
  /** The commitment discount, as an amount of money. */
  readonly commitmentDiscount: Money;
  /** What the customer actually owes: `gross - commitmentDiscount`, exactly. */
  readonly net: Money;
}

/**
 * Rounds to the currency's minor unit.
 *
 * Applied to the DISCOUNT only, and deliberately not to the gross. `Money`
 * keeps full precision through multiplication on purpose (ADR-0004), and
 * multiplying a monthly rate by a whole number of months introduces no new
 * precision — rounding it would quietly truncate a rate the platform stores at
 * four decimal places. The discount is different: it is a FRACTION of an
 * amount, so it is the step that can produce a sub-cent value, and it appears
 * on the invoice as real money in its own right. Rounding it here also makes
 * `gross - commitmentDiscount === net` exact, since subtraction of two Decimals
 * is lossless.
 */
function roundToCurrency(amount: Money): Money {
  return Money.fromMinorUnits(amount.toMinorUnits(), amount.currency);
}

/**
 * Prices one billing cycle from a monthly rate.
 *
 * Both the quote an operator approves and the invoice the scheduler issues go
 * through this function, so they cannot state different numbers.
 */
export function cycleAmountFor(monthly: Money, cycle: BillingCycleValue): CycleAmount {
  const months = BILLING_CYCLE_MONTHS[cycle];
  const discountRate = BILLING_CYCLE_COMMITMENT_DISCOUNT[cycle];
  const gross = monthly.multiply(months);
  const commitmentDiscount = roundToCurrency(gross.multiply(discountRate));

  return {
    months,
    discountRate,
    gross,
    commitmentDiscount,
    net: gross.subtract(commitmentDiscount),
  };
}

/**
 * Narrows an untyped cycle string to a cycle the terms cover. A value that is
 * not one of them has no commercial term, and a caller that guesses would bill
 * it as monthly — so callers reaching this module from an untyped edge fail
 * closed instead.
 */
export function isBillingCycleValue(value: string): value is BillingCycleValue {
  return (BILLING_CYCLES as readonly string[]).includes(value);
}
