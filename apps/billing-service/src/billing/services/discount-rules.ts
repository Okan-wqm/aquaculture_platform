/**
 * Discount eligibility and arithmetic — the rules, with no database in them
 * (ADR-0013, BILLING-CRITICAL-002).
 *
 * Validation and redemption asked the same eight questions in two places in
 * admin-api, and `applyDiscount` re-ran `validateCode` and then recomputed the
 * amount from scratch, so the two answers could differ. Here the decision is
 * one pure function over a row and a context: `validate` reports it and
 * `apply` acts on it, which is why the message a customer sees and the money
 * actually taken off can no longer disagree.
 */
import { roundToCurrency } from '@aquaculture/backend-common/monetary';
import type {
  BillingDiscountRejectionReason,
  BillingDiscountSubscriptionChange,
} from '@platform/event-contracts';
import Decimal from 'decimal.js';

import { DiscountAppliesTo, DiscountCode, DiscountType } from '../entities/discount-code.entity';

export interface DiscountEvaluationContext {
  readonly now: Date;
  readonly planId?: string;
  /**
   * What the redemption is being applied to. Required to decide an
   * `upgrades_only` / `new_subscriptions_only` code; its absence refuses one.
   */
  readonly subscriptionChange?: BillingDiscountSubscriptionChange;
  /** Absent when the caller is only asking whether the code exists. */
  readonly orderAmount?: Decimal;
  /** How many times this tenant has already redeemed this code. */
  readonly tenantRedemptions: number;
}

/** What a redemption grants. Exactly one kind, mirroring the value columns. */
export type DiscountGrant =
  | { readonly kind: 'amount'; readonly amountOff: Decimal }
  | { readonly kind: 'free-months'; readonly months: number }
  | { readonly kind: 'trial-extension'; readonly days: number };

export type DiscountEvaluation =
  | { readonly valid: true; readonly grant: DiscountGrant; readonly message: string }
  | {
      readonly valid: false;
      readonly reason: BillingDiscountRejectionReason;
      readonly message: string;
    };

const REJECTION_MESSAGES: Record<BillingDiscountRejectionReason, string> = {
  unknown_code: 'Invalid discount code',
  inactive: 'This discount code is no longer active',
  not_yet_valid: 'This discount code is not yet valid',
  expired: 'This discount code has expired',
  redemption_limit_reached: 'This discount code has reached its maximum usage limit',
  tenant_limit_reached:
    'This tenant has already used this discount code the maximum number of times',
  plan_not_eligible: 'This discount code is not valid for the selected plan',
  upgrades_only: 'This discount code applies to plan upgrades only',
  new_subscriptions_only: 'This discount code applies to new subscriptions only',
  below_minimum_order: 'The order does not meet the minimum amount for this discount',
};

export function reject(reason: BillingDiscountRejectionReason): DiscountEvaluation {
  return { valid: false, reason, message: REJECTION_MESSAGES[reason] };
}

/**
 * What the code takes off a given order. Total over `DiscountType` because
 * each kind has its own column: the free-period kinds grant a period, not an
 * amount, which the old single-column calculator could only express as a
 * silent 0.
 */
export function grantOf(code: DiscountCode, orderAmount: Decimal): DiscountGrant {
  switch (code.discountType) {
    case DiscountType.PERCENTAGE: {
      const percent = code.percentOff ?? new Decimal(0);
      const raw = orderAmount.times(percent).dividedBy(100);
      return { kind: 'amount', amountOff: roundToCurrency(raw, code.currency) };
    }
    case DiscountType.FIXED_AMOUNT: {
      const amount = code.amountOff ?? new Decimal(0);
      return {
        kind: 'amount',
        amountOff: roundToCurrency(Decimal.min(amount, orderAmount), code.currency),
      };
    }
    case DiscountType.FREE_MONTHS:
      return { kind: 'free-months', months: code.freeMonths ?? 0 };
    case DiscountType.FREE_TRIAL_EXTENSION:
      return { kind: 'trial-extension', days: code.trialExtensionDays ?? 0 };
  }
}

/** Every reason a code can be refused, asked once, in a fixed order. */
export function evaluateDiscount(
  code: DiscountCode,
  context: DiscountEvaluationContext,
): DiscountEvaluation {
  if (!code.isActive) return reject('inactive');
  if (code.validFrom && context.now < new Date(code.validFrom)) return reject('not_yet_valid');
  if (code.validUntil && context.now > new Date(code.validUntil)) return reject('expired');

  if (
    code.maxRedemptions !== null &&
    code.maxRedemptions !== undefined &&
    code.currentRedemptions >= code.maxRedemptions
  ) {
    return reject('redemption_limit_reached');
  }

  if (
    code.maxRedemptionsPerTenant !== null &&
    code.maxRedemptionsPerTenant !== undefined &&
    context.tenantRedemptions >= code.maxRedemptionsPerTenant
  ) {
    return reject('tenant_limit_reached');
  }

  // A restriction that cannot be evaluated REFUSES. The previous rules only
  // checked the plan list when a plan happened to be named, and never checked
  // the upgrade / new-subscription restrictions at all — so both of those
  // permitted every redemption, which is the opposite of what the operator
  // selected when minting the code.
  switch (code.appliesTo) {
    case DiscountAppliesTo.SPECIFIC_PLANS:
      if (
        context.planId === undefined ||
        !(code.applicablePlanIds ?? []).includes(context.planId)
      ) {
        return reject('plan_not_eligible');
      }
      break;
    case DiscountAppliesTo.UPGRADES_ONLY:
      if (context.subscriptionChange !== 'upgrade') return reject('upgrades_only');
      break;
    case DiscountAppliesTo.NEW_SUBSCRIPTIONS_ONLY:
      if (context.subscriptionChange !== 'new') return reject('new_subscriptions_only');
      break;
    case DiscountAppliesTo.ALL_PLANS:
      break;
  }

  if (
    context.orderAmount !== undefined &&
    code.minimumOrderAmount !== null &&
    code.minimumOrderAmount !== undefined &&
    context.orderAmount.lessThan(code.minimumOrderAmount)
  ) {
    return reject('below_minimum_order');
  }

  const grant = grantOf(code, context.orderAmount ?? new Decimal(0));
  return { valid: true, grant, message: 'Discount code is valid' };
}
