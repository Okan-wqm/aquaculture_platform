/**
 * Monthly-price normalisation for the `billing.subscriptions` read-model.
 *
 * `billing` is the SSoT for monetary state (CLAUDE.md D14). A subscription is
 * charged `pricing.basePrice` once per `billingCycle`, so the only defensible
 * monthly figure is that base price divided by the months the cycle covers.
 *
 * WHY THIS EXISTS: admin-api used to have TWO pricing sources. Beside this one,
 * three byte-identical `{ TRIAL: 0, STARTER: 99, PROFESSIONAL: 299,
 * ENTERPRISE: 499 }` tables were copy-pasted into ReportsService. An in-code
 * tier table cannot see a repricing, a negotiated custom plan, a $0 tier, or
 * any billing cycle but monthly — so every report's MRR contradicted the
 * dashboard's MRR on the same screen, by construction (APA-147). One function,
 * fed from the billing read-model, leaves a hardcoded price nowhere to be read
 * from.
 */
import { BillingCycle, SubscriptionReadOnly } from './subscription.entity';

/** The only fields pricing depends on, so a partial projection is enough. */
export type PricedSubscription = Pick<SubscriptionReadOnly, 'pricing' | 'billingCycle'>;

/**
 * Monthly-normalised price of a subscription, from the billing SSoT.
 *
 * The switch is exhaustive over `BillingCycle` on purpose: the `never` binding
 * makes adding a billing cycle a COMPILE error here rather than a silently
 * mispriced report. The previous private copy fell through to
 * `default: basePrice`, which priced an unknown cycle as if it were monthly.
 */
export function monthlyPriceOf(subscription: PricedSubscription): number {
  const basePrice = subscription.pricing.basePrice;

  switch (subscription.billingCycle) {
    case BillingCycle.MONTHLY:
      return basePrice;
    case BillingCycle.QUARTERLY:
      return basePrice / 3;
    case BillingCycle.SEMI_ANNUAL:
      return basePrice / 6;
    case BillingCycle.ANNUAL:
      return basePrice / 12;
    default: {
      const unreachable: never = subscription.billingCycle;
      return unreachable;
    }
  }
}
