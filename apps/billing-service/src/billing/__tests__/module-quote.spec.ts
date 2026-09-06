/**
 * The module quote arithmetic (ADR-0013 / BILLING-CRITICAL-002).
 *
 * This moved out of admin-api's `PricingCalculatorService`, where it lived in
 * floats beside three other copies: the custom-plan service, the browser's
 * CreateTenantPage, and the seed. What is pinned here is the behaviour those
 * copies got wrong.
 */
import { roundToCurrency } from '@aquaculture/backend-common/monetary';
import type { BillingModuleQuoteSelection } from '@platform/event-contracts';
import { BILLING_CYCLES, BillingPlanTier } from '@platform/event-contracts';
import Decimal from 'decimal.js';

import type {
  ModulePrice,
  ModulePriceMetric,
  ModulePriceTierMultiplier,
} from '../entities/module-price.entity';
import {
  cycleAmountFor,
  defaultCommitmentDiscountPercent,
  priceModule,
  tierMultiplierOf,
} from '../services/module-quote';

function metric(
  metricType: ModulePriceMetric['metricType'],
  price: string,
  includedQuantity: number | null = null,
): ModulePriceMetric {
  return {
    id: `metric-${metricType}`,
    modulePriceId: 'sheet-1',
    metricType,
    price: new Decimal(price),
    description: null,
    minQuantity: null,
    maxQuantity: null,
    includedQuantity,
  };
}

function multiplier(tier: BillingPlanTier, value: string): ModulePriceTierMultiplier {
  return {
    id: `multiplier-${tier}`,
    modulePriceId: 'sheet-1',
    tier,
    multiplier: new Decimal(value),
  };
}

function sheet(overrides: Partial<ModulePrice> = {}): ModulePrice {
  return Object.assign(
    {
      id: 'sheet-1',
      moduleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      moduleCode: 'sensor',
      currency: 'USD',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      effectiveTo: null,
      isActive: true,
      notes: null,
      version: 1,
      metrics: [metric('base_price', '75'), metric('per_sensor', '2', 10)],
      tierMultipliers: [multiplier(BillingPlanTier.PROFESSIONAL, '0.9')],
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      createdBy: null,
      updatedBy: null,
    } satisfies ModulePrice,
    overrides,
  );
}

const selection: BillingModuleQuoteSelection = {
  moduleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  moduleCode: 'sensor',
  moduleName: 'Sensor Monitoring',
  quantities: { sensors: 30 },
};

describe('priceModule (BILLING-CRITICAL-002)', () => {
  it('charges the base price once and bills only the quantity above what is included', () => {
    const breakdown = priceModule(selection, sheet(), BillingPlanTier.STARTER);

    // 75 base + (30 - 10 included) x 2 = 115
    expect(breakdown.subtotal).toBe('115');
    expect(breakdown.total).toBe('115');
    expect(
      breakdown.lineItems.map((line) => [line.metric, line.billableQuantity, line.total]),
    ).toEqual([
      ['base_price', 1, '75'],
      ['per_sensor', 20, '40'],
    ]);
  });

  it('applies the tier multiplier and reports the tier discount from the LIST price', () => {
    const breakdown = priceModule(selection, sheet(), BillingPlanTier.PROFESSIONAL);

    // 75 x 0.9 + 20 x (2 x 0.9) = 67.5 + 36 = 103.5, list is 115.
    expect(breakdown.subtotal).toBe('103.5');
    expect(breakdown.tierDiscount).toBe('11.5');
    // The old implementation recovered this by DIVIDING the discounted unit
    // price back out by the multiplier — float drift, and 0/0 on a 0
    // multiplier. It is computed from the list price now.
    expect(breakdown.lineItems[0]?.listUnitPrice).toBe('75');
    expect(breakdown.lineItems[0]?.unitPrice).toBe('67.5');
  });

  it('charges a FREE tenant nothing, by rule rather than by a multiplier that may be absent', () => {
    // The sheet declares no `free` multiplier; a lookup would default to 1 and
    // charge full price, which is why FREE short-circuits instead.
    const breakdown = priceModule(selection, sheet(), BillingPlanTier.FREE);
    expect(breakdown).toMatchObject({ subtotal: '0', tierDiscount: '0', total: '0' });
    expect(breakdown.lineItems).toEqual([]);
  });

  it('still charges a paid tier, so the FREE clamp is not a global zero', () => {
    // The other half of the FREE assertion the retired
    // `pricing-calculator-free-tier.spec.ts` made in admin-api: waiving FREE
    // must not waive everyone.
    const paid = priceModule(selection, sheet(), BillingPlanTier.ENTERPRISE);
    expect(new Decimal(paid.total).isPositive()).toBe(true);
  });

  it('skips a metered metric with no quantity but never the base price', () => {
    const breakdown = priceModule(
      { ...selection, quantities: {} },
      sheet(),
      BillingPlanTier.STARTER,
    );
    expect(breakdown.lineItems.map((line) => line.metric)).toEqual(['base_price']);
    expect(breakdown.subtotal).toBe('75');
  });

  it('bills nothing for a quantity inside the included allowance', () => {
    const breakdown = priceModule(
      { ...selection, quantities: { sensors: 4 } },
      sheet(),
      BillingPlanTier.STARTER,
    );
    const perSensor = breakdown.lineItems.find((line) => line.metric === 'per_sensor');
    expect(perSensor?.billableQuantity).toBe(0);
    expect(perSensor?.total).toBe('0');
  });

  it('stays exact where floats drift — 0.02 x 1000 is 20, not 20.000000000000004', () => {
    const alerts = sheet({ metrics: [metric('per_alert', '0.02')] });
    const breakdown = priceModule(
      { ...selection, quantities: { alerts: 1000 } },
      alerts,
      BillingPlanTier.STARTER,
    );
    expect(breakdown.subtotal).toBe('20');
  });

  it('rounds each line to the currency minor unit', () => {
    const yen = sheet({
      currency: 'JPY',
      metrics: [metric('per_user', '10.5')],
      tierMultipliers: [multiplier(BillingPlanTier.PROFESSIONAL, '0.9')],
    });
    const breakdown = priceModule(
      { ...selection, quantities: { users: 3 } },
      yen,
      BillingPlanTier.PROFESSIONAL,
    );
    // 10.5 x 0.9 = 9.45 → ¥9 per user, x3 = ¥27.
    expect(breakdown.lineItems[0]?.unitPrice).toBe('9');
    expect(breakdown.subtotal).toBe('27');
  });
});

describe('tierMultiplierOf', () => {
  it('is full price when the sheet names no multiplier for the tier', () => {
    expect(tierMultiplierOf(sheet(), BillingPlanTier.ENTERPRISE).toString()).toBe('1');
    expect(tierMultiplierOf(sheet(), BillingPlanTier.PROFESSIONAL).toString()).toBe('0.9');
  });
});

describe('roundToCurrency', () => {
  it('respects the currency minor unit', () => {
    expect(roundToCurrency(new Decimal('1.005'), 'USD').toString()).toBe('1.01');
    expect(roundToCurrency(new Decimal('1.5'), 'JPY').toString()).toBe('2');
  });
});

/**
 * BILLING-CRITICAL-003: what a cycle costs was written twice and the copies
 * disagreed. `ModulePricingService.quote` applied the commitment discount;
 * `BillingSchedulerService` multiplied by the months and applied nothing, so
 * the invoice ran above the approved quote by exactly that discount.
 */
describe('cycleAmountFor — one rule for the quote and the invoice', () => {
  it.each([
    ['monthly' as const, '100', '100', '0'],
    ['quarterly' as const, '100', '285', '15'],
    ['semi_annual' as const, '100', '540', '60'],
    ['annual' as const, '100', '1020', '180'],
  ])('%s: %s/month costs %s for the cycle (%s off)', (cycle, monthly, total, discount) => {
    const amount = cycleAmountFor(
      new Decimal(monthly),
      cycle,
      'USD',
      defaultCommitmentDiscountPercent(cycle),
    );

    expect(amount.total.toString()).toBe(total);
    expect(amount.discount.toString()).toBe(discount);
    expect(amount.gross.minus(amount.discount).toString()).toBe(total);
  });

  it('rounds the gross and the discount at the currency boundary, not once at the end', () => {
    // 33.33 x 12 = 399.96; 15% of that is 59.994, which is not a payable
    // amount. Both halves appear on the invoice, so both are money.
    const amount = cycleAmountFor(new Decimal('33.33'), 'annual', 'USD', new Decimal(15));

    expect(amount.gross.toString()).toBe('399.96');
    expect(amount.discount.toString()).toBe('59.99');
    expect(amount.total.toString()).toBe('339.97');
  });

  it('has a seed default for every cycle the platform can store', () => {
    // Totality against the contract's own list, so adding a cycle to
    // BILLING_CYCLES without a default fails here rather than at the first
    // seeded plan — which would then carry no commitment term at all.
    for (const cycle of BILLING_CYCLES) {
      expect(() => defaultCommitmentDiscountPercent(cycle)).not.toThrow();
      expect(() =>
        cycleAmountFor(new Decimal('10'), cycle, 'USD', defaultCommitmentDiscountPercent(cycle)),
      ).not.toThrow();
    }
  });

  it('refuses a commitment discount outside [0, 100] rather than inverting the price', () => {
    // A 400% discount used to be storable; the CHECK bounds the column, and
    // this bounds the arithmetic that reads it.
    expect(() => cycleAmountFor(new Decimal('10'), 'annual', 'USD', new Decimal(150))).toThrow(
      RangeError,
    );
    expect(() => cycleAmountFor(new Decimal('10'), 'annual', 'USD', new Decimal(-1))).toThrow(
      RangeError,
    );
  });

  it('takes the discount from the CALLER, not from a table of its own', () => {
    // The whole defect: plan_cycle_prices.discount_percent was a number the
    // catalogue displayed while a global constant did the billing.
    const negotiated = cycleAmountFor(new Decimal('100'), 'annual', 'USD', new Decimal(25));

    expect(negotiated.gross.toString()).toBe('1200');
    expect(negotiated.discount.toString()).toBe('300');
    expect(negotiated.total.toString()).toBe('900');
  });
});
