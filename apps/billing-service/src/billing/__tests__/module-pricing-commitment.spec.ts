/**
 * The commitment discount a quote SHOWS is the one the sale will SNAPSHOT
 * (BILLING-CRITICAL-003).
 *
 * `billing.plan_cycle_prices.discount_percent` was written by the catalogue UI
 * and read back into the catalogue snapshot, but no pricing path read it: what
 * was actually charged came from the platform-wide `BILLING_CYCLE_DISCOUNT_RATE`.
 * Two numbers claimed to be the same thing and only one of them billed, so an
 * operator editing a plan's annual terms changed a figure the platform ignored.
 *
 * The plan's own row is now the authority on both sides — the quote reads it
 * here, and `SubscriptionWriterService` snapshots it onto the subscription so a
 * later catalogue edit cannot re-price a customer who already signed.
 */
import { BillingPlanTier } from '@platform/event-contracts';
import type { BillingCycle } from '@platform/event-contracts';
import Decimal from 'decimal.js';
import { DataSource, Repository } from 'typeorm';

import { ModulePrice } from '../entities/module-price.entity';
import { DiscountCodeService } from '../services/discount-code.service';
import { ModulePricingService } from '../services/module-pricing.service';
import { PlanCatalogService } from '../services/plan-catalog.service';

const MODULE_CODE = 'FARM';

function sheet(): ModulePrice {
  return {
    id: 'sheet-1',
    moduleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    moduleCode: MODULE_CODE,
    currency: 'USD',
    effectiveFrom: new Date('2020-01-01T00:00:00Z'),
    effectiveTo: null,
    isActive: true,
    notes: null,
    version: 1,
    metrics: [
      {
        id: 'metric-base',
        modulePriceId: 'sheet-1',
        metricType: 'base_price',
        price: new Decimal('100'),
        description: null,
        minQuantity: null,
        maxQuantity: null,
        includedQuantity: null,
      },
    ],
    tierMultipliers: [],
    createdAt: new Date('2020-01-01T00:00:00Z'),
    updatedAt: new Date('2020-01-01T00:00:00Z'),
    createdBy: null,
    updatedBy: null,
  } satisfies ModulePrice;
}

function build(commitments: ReadonlyMap<BillingCycle, Decimal>): {
  service: ModulePricingService;
  commitmentDiscountsFor: jest.Mock;
} {
  // Real collaborator instances rather than shapes cast into their types: a
  // never-connected DataSource, a real Repository over it, and prototypes for
  // the two services whose ONE method this quote path touches.
  const dataSource = new DataSource({ type: 'postgres', entities: [] });
  const sheets = new Repository<ModulePrice>(ModulePrice, dataSource.manager);
  jest.spyOn(sheets, 'find').mockResolvedValue([sheet()]);

  const discounts: DiscountCodeService = Object.create(DiscountCodeService.prototype);
  const planCatalog: PlanCatalogService = Object.create(PlanCatalogService.prototype);
  const commitmentDiscountsFor = jest.fn().mockResolvedValue(commitments);
  planCatalog.commitmentDiscountsFor = commitmentDiscountsFor;

  return {
    service: new ModulePricingService(sheets, dataSource, discounts, planCatalog),
    commitmentDiscountsFor,
  };
}

function selection(): Parameters<ModulePricingService['quote']>[0] {
  return {
    modules: [{ moduleId: 'm1', moduleCode: MODULE_CODE, moduleName: 'Farm', quantities: {} }],
    tier: BillingPlanTier.PROFESSIONAL,
    billingCycle: 'annual',
  };
}

describe('ModulePricingService.quote — commitment terms come from the plan', () => {
  it("uses the PLAN's discount for the quoted cycle, not the platform default", async () => {
    // The platform default for annual is 15%. This plan says 22%.
    const { service, commitmentDiscountsFor } = build(
      new Map<BillingCycle, Decimal>([['annual', new Decimal(22)]]),
    );

    const quote = await service.quote(selection());

    expect(commitmentDiscountsFor).toHaveBeenCalledWith(BillingPlanTier.PROFESSIONAL);
    // 100/month x 12 = 1200 gross, 22% off = 264.
    expect(quote.cycleDiscountAmount).toBe('264');
    expect(quote.total).toBe('936');
    expect(quote.cycleDiscountPercent).toBe('22');
  });

  it('quotes annualTotal on the ANNUAL term even when the cycle asked for is monthly', async () => {
    const { service } = build(
      new Map<BillingCycle, Decimal>([
        ['monthly', new Decimal(0)],
        ['annual', new Decimal(22)],
      ]),
    );

    const quote = await service.quote({ ...selection(), billingCycle: 'monthly' });

    expect(quote.total).toBe('100');
    // The figure beside a monthly quote is what a YEAR would cost.
    expect(quote.annualTotal).toBe('936');
  });

  it('offers no commitment discount for a tier with no catalogue plan', async () => {
    // Consistent with provisioning, which refuses that tier outright — a quote
    // must not advertise terms no sale could honour.
    const { service } = build(new Map());

    const quote = await service.quote(selection());

    expect(quote.cycleDiscountAmount).toBe('0');
    expect(quote.total).toBe('1200');
  });
});
