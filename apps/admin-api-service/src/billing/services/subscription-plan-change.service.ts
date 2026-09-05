import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { BillingCycle } from '../entities/plan-definition.entity';

import { DiscountCodeService } from './discount-code.service';
import { PlanDefinitionService } from './plan-definition.service';
import { SubscriptionCoreService } from './subscription-core.service';

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
  ): Promise<{
    isUpgrade: boolean;
    isDowngrade: boolean;
    proratedAmount: number;
    newMonthlyPrice: number;
    effectiveDate: Date;
    warnings: string[];
    featureChanges: {
      added: string[];
      removed: string[];
    };
  }> {
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
      proratedAmount: proration.proratedAmount,
      newMonthlyPrice: newPlan.pricing.monthly.basePrice,
      effectiveDate: new Date(),
      warnings: comparison.warnings,
      featureChanges,
    };
  }
}
