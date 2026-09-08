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
 * longer cycle, and how long that cycle is. Both tables live here and nowhere
 * else: `apps/billing-service/.../module-quote.ts` restated both of them, and
 * `module-pricing.service.ts` read the restatement rather than this module, so
 * the quote engine and the invoice scheduler were again pricing from two
 * separate declarations of the same commercial rule (BILLING-HIGH-008 for the
 * months, BILLING-HIGH-009 for the discount).
 * `tests/invariants/billing-cycle-terms-single-source.spec.ts` now fails a
 * second copy of either table.
 */

import { BILLING_CYCLES, type BillingCycle } from '@platform/event-contracts';
import Decimal from 'decimal.js';

import { Money } from '../monetary';

/**
 * Months billed in one cycle.
 *
 * Keyed on `BillingCycle` from `@platform/event-contracts` — the platform's one
 * declaration of which cycles exist — rather than on a local copy of the four
 * values. A local copy is exactly what the second table in `module-quote.ts`
 * was keyed on, and a set that can drift is how two tables come to cover
 * different cycles without either being wrong on its own terms.
 */
export const BILLING_CYCLE_MONTHS: Readonly<Record<BillingCycle, number>> = {
  monthly: 1,
  quarterly: 3,
  semi_annual: 6,
  annual: 12,
};

/**
 * The discount granted for committing to a longer cycle, as a fraction of the
 * gross cycle amount. Changing a number here changes what the platform charges,
 * so it is a commercial decision, not a refactor.
 *
 * Written as decimal STRINGS, and read back through `commitmentDiscountRateFor`
 * as a `Decimal`. A rate is an exact commercial quantity; an IEEE-754 literal is
 * only the nearest binary approximation of one, and `0.1 + 0.2 !== 0.3` is the
 * arithmetic every other step of this module goes out of its way to avoid.
 * Today's four rates happen to round-trip through a `number` intact, so nothing
 * is mispriced by the old spelling — but that is a property of these particular
 * values, not of the type, and it stops holding the day someone writes a rate
 * like 0.145. Stating them as strings makes the exactness structural instead of
 * incidental.
 */
export const BILLING_CYCLE_COMMITMENT_DISCOUNT: Readonly<Record<BillingCycle, string>> = {
  monthly: '0',
  quarterly: '0.05',
  semi_annual: '0.10',
  annual: '0.15',
};

/**
 * The commitment discount for a cycle, as exact arithmetic.
 *
 * This is the accessor both pricing paths call. `cycleAmountFor` prices an
 * invoice in `Money`; `ModulePricingService.quote` prices a module selection in
 * raw `Decimal` and never builds a `Money`. Handing both a `Decimal` is what
 * lets the second one consume this module instead of restating the table, which
 * is the whole of BILLING-HIGH-009.
 */
export function commitmentDiscountRateFor(cycle: BillingCycle): Decimal {
  return new Decimal(BILLING_CYCLE_COMMITMENT_DISCOUNT[cycle]);
}

/** What one cycle costs, decomposed the way an invoice presents it. */
export interface CycleAmount {
  /** Months billed in this cycle. */
  readonly months: number;
  /** The commitment discount rate applied, as an exact fraction. */
  readonly discountRate: Decimal;
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
export function cycleAmountFor(monthly: Money, cycle: BillingCycle): CycleAmount {
  const months = BILLING_CYCLE_MONTHS[cycle];
  const discountRate = commitmentDiscountRateFor(cycle);
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
 * When the period that starts at `start` ends.
 *
 * # Why the arithmetic is here and not at the four callsites
 *
 * The months table was restated in four places, and every restatement came
 * paired with its own copy of this calculation — which is the actual defect
 * BILLING-HIGH-008 named. A constant that four services import is only half a
 * single source: what they each do with it is the other half, and that half had
 * drifted. `SubscriptionCoreService.calculateNextPeriodEnd` wrote the same rule
 * with a bare `setMonth`, so a subscription starting 31 January would have
 * rolled its period end to 3 March — `setMonth(0 + 1)` on the 31st asks for
 * 31 February and JS answers by counting past the end of the month. The other
 * three clamp. One of the four was wrong and nothing could tell, because there
 * was nothing for it to be wrong against.
 *
 * So the terms module owns the calculation, not just the number. A caller that
 * imports this cannot reintroduce the overflow, because it no longer writes the
 * date arithmetic at all.
 *
 * The day is clamped to the last valid day of the target month: 31 January plus
 * one month is 28 (or 29) February, not 3 March.
 */
export function addBillingCycle(start: Date, cycle: BillingCycle): Date {
  const months = BILLING_CYCLE_MONTHS[cycle];
  const targetYear = start.getFullYear();
  const targetMonth = start.getMonth() + months;
  const lastDayOfTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate();

  const result = new Date(start);
  result.setFullYear(targetYear, targetMonth, Math.min(start.getDate(), lastDayOfTargetMonth));
  return result;
}

/**
 * Narrows an untyped cycle string to a cycle the terms cover. A value that is
 * not one of them has no commercial term, and a caller that guesses would bill
 * it as monthly — so callers reaching this module from an untyped edge fail
 * closed instead.
 */
export function isBillingCycle(value: string): value is BillingCycle {
  return (BILLING_CYCLES as readonly string[]).includes(value);
}
