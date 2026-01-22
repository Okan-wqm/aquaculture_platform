import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PlanDefinitionService } from './plan-definition.service';
import { DiscountCodeService } from './discount-code.service';
import { SubscriptionCoreService } from './subscription-core.service';
import { BillingCycle } from '../entities/plan-definition.entity';
import {
  PlanChangeRequest,
  PlanChangeResult,
} from './subscription-types';

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
   * Change subscription plan (upgrade/downgrade)
   */
  async changePlan(request: PlanChangeRequest): Promise<PlanChangeResult> {
    const {
      tenantId,
      currentPlanId,
      newPlanId,
      newBillingCycle,
      discountCode,
      effectiveImmediately,
      changedBy,
    } = request;

    // Get current subscription
    const subscription = await this.subscriptionCore.getSubscriptionByTenant(tenantId);
    if (!subscription) {
      throw new NotFoundException(`No subscription found for tenant ${tenantId}`);
    }

    // Get plans
    const [currentPlan, newPlan] = await Promise.all([
      this.planService.findById(currentPlanId),
      this.planService.findById(newPlanId),
    ]);

    // Compare plans
    const comparison = await this.planService.comparePlans(currentPlanId, newPlanId);
    const billingCycle = newBillingCycle || (subscription.billingCycle as BillingCycle);

    // Calculate prorated pricing
    const proration = this.planService.calculateProratedPricing(
      currentPlan,
      newPlan,
      new Date(subscription.currentPeriodEnd),
      billingCycle,
    );

    // Apply discount if provided
    let discountAmount = 0;
    if (discountCode && proration.proratedAmount > 0) {
      const discountResult = await this.discountService.validateCode(
        discountCode,
        tenantId,
        newPlanId,
        proration.proratedAmount,
      );

      if (discountResult.valid && discountResult.discountAmount) {
        discountAmount = discountResult.discountAmount;
      }
    }

    const finalAmount = Math.max(0, proration.proratedAmount - discountAmount);
    const effectiveDate = effectiveImmediately
      ? new Date()
      : new Date(subscription.currentPeriodEnd);

    // Execute plan change in transaction
    await this.dataSource.transaction(async (manager) => {
      // Update subscription
      await manager.query(
        `
        UPDATE public.subscriptions SET
          "planTier" = $1,
          "planName" = $2,
          "billingCycle" = $3,
          limits = $4,
          pricing = $5,
          "updatedAt" = NOW(),
          "updatedBy" = $6
        WHERE "tenantId" = $7
      `,
        [
          newPlan.tier,
          newPlan.name,
          billingCycle,
          JSON.stringify(newPlan.limits),
          JSON.stringify(newPlan.pricing),
          changedBy,
          tenantId,
        ],
      );

      // Update tenant limits
      await manager.query(
        `
        UPDATE public.tenants SET
          tier = $1,
          limits = $2,
          "updatedAt" = NOW()
        WHERE id = $3::uuid
      `,
        [newPlan.tier, JSON.stringify(newPlan.limits), tenantId],
      );

      // Create invoice for prorated amount if positive
      if (finalAmount > 0 && effectiveImmediately) {
        const invoiceNumber = `INV-${Date.now()}-${tenantId.substring(0, 8)}`;
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 7);

        await manager.query(
          `
          INSERT INTO public.invoices (
            id, "tenantId", "subscriptionId", "invoiceNumber", status,
            "lineItems", subtotal, discount, "discountCode", total, "amountDue",
            currency, "issueDate", "dueDate", "periodStart", "periodEnd",
            notes, "createdAt", "updatedAt", "createdBy"
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, 'pending',
            $4, $5, $6, $7, $8, $8,
            'USD', NOW(), $9, $10, $11,
            $12, NOW(), NOW(), $13
          )
        `,
          [
            tenantId,
            subscription.id,
            invoiceNumber,
            JSON.stringify([
              {
                description: `Plan change: ${currentPlan.name} to ${newPlan.name} (prorated)`,
                quantity: 1,
                unitPrice: proration.proratedAmount,
                amount: proration.proratedAmount,
              },
            ]),
            proration.proratedAmount,
            discountAmount,
            discountCode,
            finalAmount,
            dueDate,
            new Date(),
            subscription.currentPeriodEnd,
            `Prorated plan change from ${currentPlan.name} to ${newPlan.name}`,
            changedBy,
          ],
        );
      }

      // Log the plan change
      await manager.query(
        `
        INSERT INTO public.audit_logs (
          id, action, "entityType", "entityId", "tenantId",
          "userId", changes, "createdAt"
        ) VALUES (
          gen_random_uuid(), 'PLAN_CHANGE', 'subscription', $1, $2,
          $3, $4, NOW()
        )
      `,
        [
          subscription.id,
          tenantId,
          changedBy,
          JSON.stringify({
            fromPlan: currentPlan.code,
            toPlan: newPlan.code,
            fromTier: currentPlan.tier,
            toTier: newPlan.tier,
            proratedAmount: finalAmount,
            effectiveDate,
            isUpgrade: comparison.isUpgrade,
            isDowngrade: comparison.isDowngrade,
          }),
        ],
      );
    });

    this.logger.log(
      `Plan changed for tenant ${tenantId}: ${currentPlan.name} -> ${newPlan.name} (${comparison.isUpgrade ? 'upgrade' : 'downgrade'})`,
    );

    return {
      success: true,
      isUpgrade: comparison.isUpgrade,
      isDowngrade: comparison.isDowngrade,
      proratedAmount: finalAmount,
      newMonthlyPrice: newPlan.pricing.monthly.basePrice,
      effectiveDate,
      invoice: finalAmount > 0
        ? {
            id: 'generated',
            amount: finalAmount,
            dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          }
        : undefined,
      warnings: comparison.warnings,
      message: comparison.isUpgrade
        ? `Successfully upgraded to ${newPlan.name}`
        : `Successfully downgraded to ${newPlan.name}`,
    };
  }

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
    const billingCycle = newBillingCycle || (subscription.billingCycle as BillingCycle);

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
