import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { BillingCycle } from '@platform/event-contracts';
import { DataSource } from 'typeorm';

import { PlanResponseDto } from '../dto/plan-response.dto';

import { DiscountCodeService } from './discount-code.service';
import { PlanDefinitionService } from './plan-definition.service';
import { SubscriptionCoreService } from './subscription-core.service';

export interface PlanChangePreview {
  isUpgrade: boolean;
  isDowngrade: boolean;
  /** Exact decimal string; positive = the customer pays, negative = credited. */
  proratedAmount: string;
  /** Exact decimal string: the new plan's base price on `billingCycle`. */
  newCyclePrice: string;
  billingCycle: BillingCycle;
  /** ISO-8601. */
  effectiveDate: string;
  warnings: string[];
  featureChanges: {
    added: string[];
    removed: string[];
  };
}

/**
 * The new plan's base price for the cycle the change lands on. `billing.plans`
 * prices per cycle now, so there is no single "monthly price" to quote when
 * the customer is moving onto an annual commitment.
 */
function priceForCycle(plan: PlanResponseDto, billingCycle: BillingCycle): string {
  const row = plan.cyclePrices.find((price) => price.billingCycle === billingCycle);
  return row?.basePrice ?? '0';
}

/**
 * Subscription Plan Change Service
 * Handles plan upgrades and downgrades with proration
 * SRP: Only responsible for plan change operations
 */
@Injectable()
export class SubscriptionPlanChangeService {
  private readonly logger = new Logger(SubscriptionPlanChangeService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly planService: PlanDefinitionService,
    private readonly discountService: DiscountCodeService,
    private readonly subscriptionCore: SubscriptionCoreService,
  ) {}

  /**
   * Preview plan change without executing
   */
  async previewPlanChange(
    tenantId: string,
    currentPlanId: string,
    newPlanId: string,
    newBillingCycle?: BillingCycle,
  ): Promise<PlanChangePreview> {
    const subscription = await this.subscriptionCore.getSubscriptionByTenant(tenantId);
    if (!subscription) {
      throw new NotFoundException(`No subscription found for tenant ${tenantId}`);
    }

    const [currentPlan, newPlan] = await Promise.all([
      this.planService.findById(currentPlanId),
      this.planService.findById(newPlanId),
    ]);

    const comparison = await this.planService.comparePlans(currentPlanId, newPlanId);
    const billingCycle = newBillingCycle || subscription.billingCycle;

    const proration = this.planService.calculateProratedPricing(
      currentPlan,
      newPlan,
      new Date(subscription.currentPeriodEnd),
      billingCycle,
    );

    // Transform feature changes to added/removed format
    const featureChanges = {
      added: comparison.featureChanges.filter(c => c.gaining).map(c => c.feature),
      removed: comparison.featureChanges.filter(c => !c.gaining).map(c => c.feature),
    };

    return {
      isUpgrade: comparison.isUpgrade,
      isDowngrade: comparison.isDowngrade,
      // Exact decimal strings: this preview is what the operator quotes, and a
      // float here would disagree with the invoice billing actually raises.
      proratedAmount: proration.proratedAmount,
      newCyclePrice: priceForCycle(newPlan, billingCycle),
      billingCycle,
      effectiveDate: proration.effectiveDate,
      warnings: comparison.warnings,
      featureChanges,
    };
  }
}
