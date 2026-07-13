import { Test, TestingModule } from '@nestjs/testing';

import { ModulePricing } from '../entities/module-pricing.entity';
import { PlanTier } from '../entities/plan-definition.entity';
import { PricingMetricType } from '../entities/pricing-metric.enum';
import { DiscountCodeService } from '../services/discount-code.service';
import { ModulePricingService } from '../services/module-pricing.service';
import {
  PricingCalculatorService,
  type ModuleSelection,
} from '../services/pricing-calculator.service';

/**
 * Billing Revival Faz B (D4): the FREE tier is permanently $0. A FREE tenant's
 * module pricing must resolve to zero for EVERY metric — base price included —
 * even when the module's ModulePricing carries no `free` tier multiplier (which
 * would otherwise default to 1.0 → full price). This proves the FREE
 * short-circuit in calculateModulePrice, the source of the priced moduleItems
 * that admin-api sends to billing.
 */
describe('PricingCalculatorService — FREE tier is $0 (Faz B)', () => {
  let service: PricingCalculatorService;

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PricingCalculatorService,
        // calculateModulePrice touches neither collaborator; empty stubs suffice.
        { provide: ModulePricingService, useValue: {} },
        { provide: DiscountCodeService, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get<PricingCalculatorService>(PricingCalculatorService);
  });

  const buildPricing = (): ModulePricing => {
    const pricing = new ModulePricing();
    pricing.pricingMetrics = [
      { type: PricingMetricType.BASE_PRICE, price: 99, currency: 'USD' },
      { type: PricingMetricType.PER_USER, price: 10, currency: 'USD', includedQuantity: 0 },
      { type: PricingMetricType.PER_SENSOR, price: 2, currency: 'USD', includedQuantity: 0 },
    ];
    // Deliberately NO `free` multiplier — proves FREE is $0 structurally, not by
    // a per-module config that could be absent.
    pricing.tierMultipliers = {
      [PlanTier.STARTER]: 1.0,
      [PlanTier.PROFESSIONAL]: 0.9,
      [PlanTier.ENTERPRISE]: 0.7,
    };
    return pricing;
  };

  const selection: ModuleSelection = {
    moduleId: 'mod-1',
    moduleCode: 'IOT',
    moduleName: 'IoT Sensors',
    quantities: { users: 25, sensors: 40 },
  };

  it('returns an all-zero breakdown for FREE (base price + metered charges waived)', () => {
    const breakdown = service.calculateModulePrice(selection, buildPricing(), PlanTier.FREE);

    expect(breakdown.subtotal).toBe(0);
    expect(breakdown.total).toBe(0);
    expect(breakdown.tierDiscount).toBe(0);
    // No NaN can leak from a 0-multiplier reconstruction.
    expect(Number.isNaN(breakdown.total)).toBe(false);
    expect(breakdown.lineItems).toEqual([]);
    expect(breakdown.moduleId).toBe('mod-1');
  });

  it('still charges a paid tier so the FREE clamp is not a global zero', () => {
    const breakdown = service.calculateModulePrice(selection, buildPricing(), PlanTier.STARTER);

    // base 99 + 25 users * 10 + 40 sensors * 2 = 99 + 250 + 80 = 429 (multiplier 1.0)
    expect(breakdown.total).toBe(429);
  });
});
