import { Injectable, Logger } from '@nestjs/common';
import { ModulePricingService } from './module-pricing.service';
import { DiscountCodeService } from './discount-code.service';
import { ModulePricing } from '../entities/module-pricing.entity';
import { PlanTier, BillingCycle } from '../entities/plan-definition.entity';
import { PricingMetricType, PricingMetricLabels } from '../entities/pricing-metric.enum';
import { ModuleQuantities } from './subscription-management.service';

/**
 * Module selection for pricing calculation
 */
export interface ModuleSelection {
  moduleId: string;
  moduleCode: string;
  moduleName?: string;
  quantities: ModuleQuantities;
}

/**
 * Line item in pricing breakdown
 */
export interface PricingLineItem {
  metric: PricingMetricType;
  metricLabel: string;
  quantity: number;
  includedQuantity: number;
  billableQuantity: number;
  unitPrice: number;
  total: number;
  tierMultiplier: number;
}

/**
 * Price breakdown for a single module
 */
export interface ModulePriceBreakdown {
  moduleId: string;
  moduleCode: string;
  moduleName: string;
  lineItems: PricingLineItem[];
  subtotal: number;
  tierDiscount: number;
  total: number;
}

/**
 * Complete pricing calculation result
 */
export interface PricingCalculation {
  modules: ModulePriceBreakdown[];
  subtotal: number;
  tierDiscount: number;
  discount: {
    code?: string;
    description?: string;
    amount: number;
    percent: number;
  };
  tax: number;
  taxRate: number;
  total: number;
  monthlyTotal: number;
  annualTotal: number;
  billingCycle: BillingCycle;
  billingCycleMultiplier: number;
  currency: string;
  tier: PlanTier;
  calculatedAt: Date;
}

/**
 * Quote request
 */
export interface QuoteRequest {
  modules: ModuleSelection[];
  tier: PlanTier;
  billingCycle: BillingCycle;
  discountCode?: string;
  taxRate?: number;
}

/**
 * Map metric type to quantity field
 */
const METRIC_TO_QUANTITY_MAP: Partial<Record<PricingMetricType, keyof ModuleQuantities>> = {
  [PricingMetricType.PER_USER]: 'users',
  [PricingMetricType.PER_FARM]: 'farms',
  [PricingMetricType.PER_POND]: 'ponds',
  [PricingMetricType.PER_SENSOR]: 'sensors',
  [PricingMetricType.PER_DEVICE]: 'devices',
  [PricingMetricType.PER_GB_STORAGE]: 'storageGb',
  [PricingMetricType.PER_API_CALL]: 'apiCalls',
  [PricingMetricType.PER_ALERT]: 'alerts',
  [PricingMetricType.PER_REPORT]: 'reports',
  [PricingMetricType.PER_INTEGRATION]: 'integrations',
};

/**
 * Billing cycle multipliers (months per cycle)
 */
const BILLING_CYCLE_MONTHS: Record<BillingCycle, number> = {
  [BillingCycle.MONTHLY]: 1,
  [BillingCycle.QUARTERLY]: 3,
  [BillingCycle.SEMI_ANNUAL]: 6,
  [BillingCycle.ANNUAL]: 12,
};

/**
 * Billing cycle discounts
 */
const BILLING_CYCLE_DISCOUNTS: Record<BillingCycle, number> = {
  [BillingCycle.MONTHLY]: 0,
  [BillingCycle.QUARTERLY]: 0.05,    // 5% discount
  [BillingCycle.SEMI_ANNUAL]: 0.10,  // 10% discount
  [BillingCycle.ANNUAL]: 0.15,       // 15% discount
};

/**
 * Pricing Calculator Service
 *
 * Calculates pricing for module combinations with:
 * - Per-metric pricing
 * - Tier-based discounts
 * - Billing cycle discounts
 * - Discount code application
 */
@Injectable()
export class PricingCalculatorService {
  private readonly logger = new Logger(PricingCalculatorService.name);

  constructor(
    private readonly modulePricingService: ModulePricingService,
    private readonly discountCodeService: DiscountCodeService,
  ) {}

  /**
   * Calculate pricing for a set of modules
   */
  async calculatePricing(request: QuoteRequest): Promise<PricingCalculation> {
    const { modules, tier, billingCycle, discountCode, taxRate = 0 } = request;

    const moduleBreakdowns: ModulePriceBreakdown[] = [];
    let subtotal = 0;
    let totalTierDiscount = 0;

    // Calculate each module's pricing
    for (const moduleSelection of modules) {
      const pricing = await this.modulePricingService.getModulePricingByCode(
        moduleSelection.moduleCode,
      );

      if (!pricing) {
        this.logger.warn(`No pricing found for module: ${moduleSelection.moduleCode}`);
        continue;
      }

      const breakdown = this.calculateModulePrice(
        moduleSelection,
        pricing,
        tier,
      );

      moduleBreakdowns.push(breakdown);
      subtotal += breakdown.subtotal;
      totalTierDiscount += breakdown.tierDiscount;
    }

    // Apply billing cycle
    const cycleMonths = BILLING_CYCLE_MONTHS[billingCycle];
    const cycleDiscount = BILLING_CYCLE_DISCOUNTS[billingCycle];

    // Calculate monthly total (after tier discounts)
    const monthlyTotal = subtotal - totalTierDiscount;

    // Calculate cycle total
    let cycleTotal = monthlyTotal * cycleMonths;

    // Apply cycle discount
    const cycleDiscountAmount = cycleTotal * cycleDiscount;
    cycleTotal -= cycleDiscountAmount;

    // Apply discount code
    let discountAmount = 0;
    let discountPercent = 0;
    let discountDescription = '';

    if (discountCode) {
      const discount = await this.applyDiscountCode(discountCode, cycleTotal);
      if (discount) {
        discountAmount = discount.amount;
        discountPercent = discount.percent;
        discountDescription = discount.description;
        cycleTotal -= discountAmount;
      }
    }

    // Calculate tax
    const tax = cycleTotal * (taxRate / 100);
    const total = cycleTotal + tax;

    return {
      modules: moduleBreakdowns,
      subtotal,
      tierDiscount: totalTierDiscount,
      discount: {
        code: discountCode,
        description: discountDescription,
        amount: discountAmount + cycleDiscountAmount,
        percent: discountPercent || cycleDiscount * 100,
      },
      tax,
      taxRate,
      total,
      monthlyTotal,
      annualTotal: monthlyTotal * 12 * (1 - cycleDiscount),
      billingCycle,
      billingCycleMultiplier: cycleMonths,
      currency: 'USD',
      tier,
      calculatedAt: new Date(),
    };
  }

  /**
   * Calculate pricing for a single module
   */
  calculateModulePrice(
    selection: ModuleSelection,
    pricing: ModulePricing,
    tier: PlanTier,
  ): ModulePriceBreakdown {
    const lineItems: PricingLineItem[] = [];
    let subtotal = 0;

    const tierMultiplier = pricing.getTierMultiplier(tier);

    // Process each pricing metric
    for (const metric of pricing.pricingMetrics) {
      let quantity = 1; // Default for base price

      // Get quantity from selection
      if (metric.type !== PricingMetricType.BASE_PRICE) {
        const quantityField = METRIC_TO_QUANTITY_MAP[metric.type];
        if (quantityField) {
          quantity = selection.quantities[quantityField] ?? 0;
        }
      }

      if (quantity === 0 && metric.type !== PricingMetricType.BASE_PRICE) {
        continue; // Skip metrics with 0 quantity
      }

      const includedQuantity = metric.includedQuantity ?? 0;
      const billableQuantity = Math.max(0, quantity - includedQuantity);

      // For base price, always charge full (no included concept)
      const effectiveQuantity =
        metric.type === PricingMetricType.BASE_PRICE ? 1 : billableQuantity;

      const unitPrice = metric.price * tierMultiplier;
      const total = effectiveQuantity * metric.price; // Before tier discount

      lineItems.push({
        metric: metric.type,
        metricLabel: PricingMetricLabels[metric.type] || metric.type,
        quantity,
        includedQuantity,
        billableQuantity: effectiveQuantity,
        unitPrice: metric.price,
        total,
        tierMultiplier,
      });

      subtotal += total;
    }

    // Calculate tier discount
    const tierDiscount = subtotal * (1 - tierMultiplier);
    const total = subtotal - tierDiscount;

    return {
      moduleId: selection.moduleId,
      moduleCode: selection.moduleCode,
      moduleName: selection.moduleName || selection.moduleCode,
      lineItems,
      subtotal,
      tierDiscount,
      total,
    };
  }

  /**
   * Apply discount code and return discount details
   */
  private async applyDiscountCode(
    code: string,
    subtotal: number,
  ): Promise<{ amount: number; percent: number; description: string } | null> {
    try {
      // Use validateCode method - pass empty tenantId since we're just checking the code
      const validation = await this.discountCodeService.validateCode(code, '', undefined, subtotal);

      if (!validation.valid) {
        this.logger.warn(`Invalid discount code: ${code} - ${validation.message}`);
        return null;
      }

      const discount = validation.discountCode!;
      let amount = 0;
      let percent = 0;

      if (discount.discountType === 'percentage') {
        percent = discount.discountValue;
        amount = subtotal * (percent / 100);
      } else {
        // Fixed amount
        amount = Math.min(discount.discountValue, subtotal);
      }

      return {
        amount,
        percent,
        description: discount.description || `Discount: ${code}`,
      };
    } catch (error) {
      this.logger.error(`Error applying discount code: ${error}`);
      return null;
    }
  }

  /**
   * Quick estimate without discount code
   */
  async getQuickEstimate(
    moduleCodes: string[],
    tier: PlanTier,
    defaultQuantities: ModuleQuantities = { users: 5 },
  ): Promise<{ monthlyTotal: number; annualTotal: number }> {
    const modules: ModuleSelection[] = moduleCodes.map((code) => ({
      moduleId: '',
      moduleCode: code,
      quantities: defaultQuantities,
    }));

    const calculation = await this.calculatePricing({
      modules,
      tier,
      billingCycle: BillingCycle.MONTHLY,
    });

    return {
      monthlyTotal: calculation.monthlyTotal,
      annualTotal: calculation.annualTotal,
    };
  }

  /**
   * Compare pricing between two configurations
   */
  async comparePricing(
    config1: QuoteRequest,
    config2: QuoteRequest,
  ): Promise<{
    config1: PricingCalculation;
    config2: PricingCalculation;
    difference: number;
    percentDifference: number;
    recommendation: string;
  }> {
    const pricing1 = await this.calculatePricing(config1);
    const pricing2 = await this.calculatePricing(config2);

    const difference = pricing2.monthlyTotal - pricing1.monthlyTotal;
    const percentDifference =
      pricing1.monthlyTotal > 0
        ? (difference / pricing1.monthlyTotal) * 100
        : 0;

    let recommendation = 'Both options are comparable.';
    if (difference > 0) {
      recommendation = `Configuration 2 is $${difference.toFixed(2)}/month more expensive (${percentDifference.toFixed(1)}% increase).`;
    } else if (difference < 0) {
      recommendation = `Configuration 2 saves $${Math.abs(difference).toFixed(2)}/month (${Math.abs(percentDifference).toFixed(1)}% savings).`;
    }

    return {
      config1: pricing1,
      config2: pricing2,
      difference,
      percentDifference,
      recommendation,
    };
  }
}
