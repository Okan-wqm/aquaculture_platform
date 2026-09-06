/**
 * What a module selection costs — the arithmetic, with no database in it
 * (ADR-0013, BILLING-CRITICAL-002).
 *
 * This moved out of admin-api's `PricingCalculatorService` with the price
 * sheet it reads. Two things changed on the way:
 *
 *  1. Every step is `Decimal`. The float version multiplied a list price by a
 *     tier multiplier per line, summed the lines, applied a cycle discount and
 *     then a discount code — five roundings deep before anything reached an
 *     invoice, and it reconstructed the pre-discount subtotal by DIVIDING the
 *     discounted unit price by the multiplier, which is where 0.1 + 0.2
 *     arithmetic becomes a cent of drift.
 *  2. The tier discount is now computed from the list price rather than
 *     recovered by division, so it is exact and a multiplier of 0 (which the
 *     database now forbids anyway) can no longer produce 0/0 = NaN.
 */
import { roundToCurrency } from '@aquaculture/backend-common/monetary';
import type {
  BillingCycle,
  BillingModuleQuoteBreakdown,
  BillingModuleQuoteLineItem,
  BillingModuleQuoteSelection,
  BillingPricingMetricType,
} from '@platform/event-contracts';
import {
  BILLING_METRIC_QUANTITY_FIELD,
  BILLING_PRICING_METRIC_LABELS,
  BillingPlanTier,
} from '@platform/event-contracts';
import Decimal from 'decimal.js';

import type { ModulePrice } from '../entities/module-price.entity';

/** Months billed at once, per cycle. */
export const BILLING_CYCLE_MONTHS: Readonly<Record<BillingCycle, number>> = {
  monthly: 1,
  quarterly: 3,
  semi_annual: 6,
  annual: 12,
};

/**
 * The DEFAULT commitment discount for a longer cycle, as an exact rate.
 *
 * BILLING-CRITICAL-003: this is a seed default, not the authority. What a
 * given plan takes off lives in `billing.plan_cycle_prices.discount_percent`,
 * and what a given SUBSCRIPTION was sold at is snapshotted on
 * `billing.subscriptions.commitment_discount_percent` — editing the catalogue
 * must not silently re-price a customer who already signed. Only
 * `PlanSeedService` reads this map; everything that charges reads a row.
 *
 * Stated as strings so the 0.15 never arrives as 0.15000000000000002.
 */
export const BILLING_CYCLE_DISCOUNT_RATE: Readonly<Record<BillingCycle, string>> = {
  monthly: '0',
  quarterly: '0.05',
  semi_annual: '0.10',
  annual: '0.15',
};

/**
 * What a cycle's worth of a monthly amount actually costs.
 *
 * BILLING-CRITICAL-003: this rule was written TWICE and the two copies
 * disagreed. `ModulePricingService.quote` multiplied by the months and took
 * the commitment discount off, which is the figure an operator approves;
 * `BillingSchedulerService` multiplied by the months and took NOTHING off, so
 * an annual tenant was invoiced 15% more than the quote they signed, every
 * year, silently. Both now call this.
 *
 * The discount is a REQUIRED argument rather than a lookup inside. It is not a
 * property of the cycle — it is a term of the plan being quoted or of the
 * subscription being invoiced, and reading it from a global map here is
 * exactly how `plan_cycle_prices.discount_percent` came to be a number the
 * catalogue displayed and nothing billed. Callers pass the row's value; only
 * the seed passes `BILLING_CYCLE_DISCOUNT_RATE`.
 *
 * Rounding happens at each currency boundary — the gross and the discount are
 * each a real money amount that appears on the invoice, so neither may carry
 * sub-cent residue into the total.
 */
export interface BillingCycleAmount {
  /** The monthly amount times the months in the cycle. */
  gross: Decimal;
  /** What committing to the longer cycle takes off. */
  discount: Decimal;
  /** What is charged for the cycle. */
  total: Decimal;
}

export function cycleAmountFor(
  monthly: Decimal,
  billingCycle: BillingCycle,
  currency: string,
  /** The commitment discount as a PERCENTAGE in [0, 100], from the row that owns it. */
  discountPercent: Decimal,
): BillingCycleAmount {
  const months = BILLING_CYCLE_MONTHS[billingCycle];
  if (months === undefined) {
    throw new RangeError(`Unknown billing cycle ${String(billingCycle)}`);
  }
  if (discountPercent.isNegative() || discountPercent.greaterThan(100)) {
    throw new RangeError(
      `Commitment discount must be between 0 and 100, got ${discountPercent.toString()}`,
    );
  }
  const gross = roundToCurrency(monthly.times(months), currency);
  const discount = roundToCurrency(gross.times(discountPercent).dividedBy(100), currency);
  return { gross, discount, total: gross.minus(discount) };
}

/** The seed default for a cycle, as a percentage in [0, 100]. */
export function defaultCommitmentDiscountPercent(billingCycle: BillingCycle): Decimal {
  const rate = BILLING_CYCLE_DISCOUNT_RATE[billingCycle];
  if (rate === undefined) {
    throw new RangeError(`Unknown billing cycle ${String(billingCycle)}`);
  }
  return new Decimal(rate).times(100);
}

/** The multiplier in force for a tier — absent means full list price. */
export function tierMultiplierOf(sheet: ModulePrice, tier: BillingPlanTier): Decimal {
  const found = (sheet.tierMultipliers ?? []).find((entry) => entry.tier === tier);
  return found ? found.multiplier : new Decimal(1);
}

function quantityFor(
  metricType: BillingPricingMetricType,
  quantities: BillingModuleQuoteSelection['quantities'],
): number {
  if (metricType === 'base_price') return 1;
  const field = BILLING_METRIC_QUANTITY_FIELD[metricType];
  if (!field) return 0;
  return quantities[field] ?? 0;
}

/**
 * Price one module against one sheet.
 *
 * FREE is permanently $0 (Billing Revival Faz B): base price and every metered
 * charge are waived, so the module contributes nothing. That is stated as an
 * explicit all-zero breakdown rather than left to a `free` tier multiplier,
 * which may simply be absent from a sheet and would then default to full price.
 */
export function priceModule(
  selection: BillingModuleQuoteSelection,
  sheet: ModulePrice,
  tier: BillingPlanTier,
): BillingModuleQuoteBreakdown {
  const moduleName = selection.moduleName || selection.moduleCode;
  if (tier === BillingPlanTier.FREE) {
    return {
      moduleId: selection.moduleId,
      moduleCode: selection.moduleCode,
      moduleName,
      lineItems: [],
      subtotal: '0',
      tierDiscount: '0',
      total: '0',
    };
  }

  const multiplier = tierMultiplierOf(sheet, tier);
  const lineItems: BillingModuleQuoteLineItem[] = [];
  let subtotal = new Decimal(0);
  let listSubtotal = new Decimal(0);

  for (const metric of sheet.metrics ?? []) {
    const quantity = quantityFor(metric.metricType, selection.quantities);
    if (quantity === 0 && metric.metricType !== 'base_price') continue;

    const includedQuantity = metric.includedQuantity ?? 0;
    // A base price is charged once per module; "included" has no meaning there.
    const billableQuantity =
      metric.metricType === 'base_price' ? 1 : Math.max(0, quantity - includedQuantity);

    const listUnitPrice = metric.price;
    const unitPrice = roundToCurrency(listUnitPrice.times(multiplier), sheet.currency);
    const lineTotal = roundToCurrency(unitPrice.times(billableQuantity), sheet.currency);
    const listLineTotal = roundToCurrency(listUnitPrice.times(billableQuantity), sheet.currency);

    lineItems.push({
      metric: metric.metricType,
      metricLabel: BILLING_PRICING_METRIC_LABELS[metric.metricType] ?? metric.metricType,
      quantity,
      includedQuantity,
      billableQuantity,
      listUnitPrice: listUnitPrice.toString(),
      unitPrice: unitPrice.toString(),
      total: lineTotal.toString(),
      tierMultiplier: multiplier.toString(),
    });

    subtotal = subtotal.plus(lineTotal);
    listSubtotal = listSubtotal.plus(listLineTotal);
  }

  return {
    moduleId: selection.moduleId,
    moduleCode: selection.moduleCode,
    moduleName,
    lineItems,
    subtotal: subtotal.toString(),
    // From the list price, not recovered by dividing the discounted price back
    // out — that division was the float trap and broke on a 0 multiplier.
    tierDiscount: listSubtotal.minus(subtotal).toString(),
    total: subtotal.toString(),
  };
}
