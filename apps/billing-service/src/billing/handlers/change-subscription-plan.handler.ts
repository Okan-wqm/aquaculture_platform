import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
  Optional,
  Inject,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { NatsEventBus } from '@platform/event-bus';
import { createBaseEvent, SubscriptionUpdatedEvent } from '@platform/event-contracts';
import { AuditedOperation, RedisService, Money } from '@aquaculture/backend-common';
import { ChangeSubscriptionPlanCommand } from '../commands/change-subscription-plan.command';
import { Subscription, SubscriptionStatus, BillingCycle } from '../entities/subscription.entity';
import { ScheduledPlanChange, ScheduledChangeStatus } from '../entities/scheduled-plan-change.entity';
import { Plan } from '../entities/plan.entity';

/** Result of a plan change operation, includes the updated subscription and pro-rata details */
export interface PlanChangeResult {
  subscription: Subscription;
  proRataCredit: number;
  effectiveDate: Date;
  isImmediate: boolean;
}

/**
 * Tier ordering for upgrade/downgrade detection.
 * Higher number = higher tier.
 */
const TIER_ORDER: Record<string, number> = {
  starter: 1,
  professional: 2,
  enterprise: 3,
  custom: 4,
};

@AuditedOperation({ resource: 'Subscription', action: 'CHANGE_PLAN' })
@Injectable()
@CommandHandler(ChangeSubscriptionPlanCommand)
export class ChangeSubscriptionPlanHandler
  implements ICommandHandler<ChangeSubscriptionPlanCommand, Subscription>
{
  private readonly logger = new Logger(ChangeSubscriptionPlanHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    @Optional() @Inject('EVENT_BUS') private readonly eventBus?: NatsEventBus,
    @Optional() private readonly redisService?: RedisService,
  ) {}

  async execute(command: ChangeSubscriptionPlanCommand): Promise<Subscription> {
    const { tenantId, input, userId } = command;

    return await this.dataSource.transaction(async (manager) => {
      const subscriptionRepo = manager.getRepository(Subscription);
      const planRepo = manager.getRepository(Plan);

      // 1. Fetch current subscription with lock
      const subscription = await subscriptionRepo.findOne({
        where: { tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!subscription) {
        throw new NotFoundException(
          `No subscription found for tenant ${tenantId}`,
        );
      }

      // Only active or trial subscriptions can change plans
      const changeable = [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIAL];
      if (!changeable.includes(subscription.status)) {
        throw new BadRequestException(
          `Cannot change plan for subscription with status "${subscription.status}". Only active or trial subscriptions can change plans.`,
        );
      }

      // 2. Fetch target plan
      const newPlan = await planRepo.findOne({
        where: { id: input.newPlanId },
      });

      if (!newPlan) {
        throw new NotFoundException(
          `Plan with id ${input.newPlanId} not found`,
        );
      }

      if (!newPlan.isActive) {
        throw new BadRequestException(
          `Plan "${newPlan.name}" is deactivated and cannot be selected`,
        );
      }

      // 3. Prevent changing to the same tier (unless it's a different plan)
      if (
        subscription.planTier === newPlan.tier &&
        subscription.planName === newPlan.name
      ) {
        throw new ConflictException(
          `Subscription is already on the "${newPlan.name}" plan`,
        );
      }

      // 4. Determine if this is an upgrade or downgrade
      // Capture BEFORE mutation — all three branches overwrite subscription.planTier,
      // so reading it after mutation always gives the new tier (wrong in the event).
      const previousPlanTier = subscription.planTier;
      const currentTierOrder = TIER_ORDER[subscription.planTier] || 0;
      const newTierOrder = TIER_ORDER[newPlan.tier] || 0;
      const isUpgrade = newTierOrder > currentTierOrder;
      const isDowngrade = newTierOrder < currentTierOrder;

      const now = new Date();

      // 5. Calculate pro-rata credit for the remaining period using Money
      const pricingCurrency = subscription.pricing.currency || 'USD';
      const proRataCredit = this.calculateProRataCredit(
        subscription.currentPeriodStart,
        subscription.currentPeriodEnd,
        Money.of(subscription.pricing.basePrice, pricingCurrency),
        Money.of(newPlan.pricing.basePrice, pricingCurrency),
        now,
      );

      // 6. Apply the plan change
      if (isUpgrade || input.immediate) {
        // UPGRADE: Takes effect immediately with pro-rata credit
        subscription.planTier = newPlan.tier;
        subscription.planName = newPlan.name;
        subscription.limits = { ...newPlan.limits };
        subscription.pricing = { ...newPlan.pricing };
        subscription.updatedBy = userId;

        this.logger.log(
          `Immediate plan change for tenant ${tenantId}: ` +
          `${subscription.planTier} → ${newPlan.tier} ` +
          `(pro-rata credit: ${proRataCredit})`,
        );
      } else if (isDowngrade) {
        // IP-2: DOWNGRADE — schedule for end of current billing period.
        // WHY: Immediate downgrades would revoke access to features the tenant
        // has already paid for. The scheduled change preserves full value for
        // the current period. The billing scheduler cron applies it at periodEnd.
        const scheduledChangeRepo = manager.getRepository(ScheduledPlanChange);

        // Cancel any existing pending change for this subscription
        await scheduledChangeRepo.update(
          { subscriptionId: subscription.id, status: ScheduledChangeStatus.PENDING },
          { status: ScheduledChangeStatus.CANCELLED, cancelledAt: now, cancellationReason: 'Superseded by new plan change' },
        );

        // Create new scheduled change
        const scheduledChange = scheduledChangeRepo.create({
          tenantId,
          subscriptionId: subscription.id,
          currentPlanId: subscription.planId ?? '',
          currentPlanTier: subscription.planTier,
          newPlanId: newPlan.id,
          newPlanTier: newPlan.tier,
          newPlanName: newPlan.name,
          newLimits: { ...newPlan.limits },
          newPricing: { ...newPlan.pricing },
          status: ScheduledChangeStatus.PENDING,
          effectiveDate: subscription.currentPeriodEnd,
          reason: input.reason,
          scheduledBy: userId,
        });
        await scheduledChangeRepo.save(scheduledChange);

        // IMPORTANT: Do NOT change subscription fields — current plan stays active
        subscription.updatedBy = userId;

        this.logger.log(
          `Downgrade scheduled for tenant ${tenantId}: ` +
          `${subscription.planTier} → ${newPlan.tier} ` +
          `(effective: ${subscription.currentPeriodEnd.toISOString()}, changeId: ${scheduledChange.id})`,
        );
      } else {
        // Same tier level — lateral move (e.g., from one professional plan to another)
        subscription.planTier = newPlan.tier;
        subscription.planName = newPlan.name;
        subscription.limits = { ...newPlan.limits };
        subscription.pricing = { ...newPlan.pricing };
        subscription.updatedBy = userId;

        this.logger.log(
          `Lateral plan change for tenant ${tenantId}: "${subscription.planName}" → "${newPlan.name}"`,
        );
      }

      const savedSubscription = await subscriptionRepo.save(subscription);

      // Invalidate subscription cache
      if (this.redisService) {
        await this.redisService
          .del(`subscription:${tenantId}`)
          .catch(() => { /* non-fatal */ });
      }

      // Publish SubscriptionUpdated event
      try {
        const event: SubscriptionUpdatedEvent = {
          ...createBaseEvent<SubscriptionUpdatedEvent>(
            'SubscriptionUpdated',
            tenantId,
            { userId },
          ),
          subscriptionId: savedSubscription.id,
          tier: savedSubscription.planTier as SubscriptionUpdatedEvent['tier'],
          monthlyPrice: Number(savedSubscription.pricing.basePrice),
          currency: savedSubscription.pricing.currency || 'USD',
          isDowngrade,
          previousPlanTier: previousPlanTier as SubscriptionUpdatedEvent['previousPlanTier'],
          features: {
            maxFarms: savedSubscription.limits?.maxFarms,
            maxPonds: savedSubscription.limits?.maxPonds,
            maxSensors: savedSubscription.limits?.maxSensors,
            maxUsers: savedSubscription.limits?.maxUsers,
          },
        };
        await this.eventBus?.publish(event);
      } catch (eventError) {
        this.logger.warn(
          `Failed to publish SubscriptionUpdated event for ${savedSubscription.id}: ${
            eventError instanceof Error ? eventError.message : 'Unknown error'
          }`,
        );
      }

      return savedSubscription;
    });
  }

  /**
   * Calculate pro-rata credit for the unused portion of the current billing period.
   *
   * Formula: remainingDays x (newPrice - oldPrice) / totalDays
   *
   * If the result is negative (upgrade), the tenant owes additional amount.
   * If the result is positive (downgrade), the tenant gets a credit.
   *
   * @returns Money representing the pro-rata credit/charge
   */
  private calculateProRataCredit(
    periodStart: Date,
    periodEnd: Date,
    oldBasePrice: Money,
    newBasePrice: Money,
    changeDate: Date,
  ): Money {
    const totalMs = periodEnd.getTime() - periodStart.getTime();
    const remainingMs = periodEnd.getTime() - changeDate.getTime();

    if (totalMs <= 0 || remainingMs <= 0) {
      return Money.zero(oldBasePrice.currency);
    }

    const totalDays = totalMs / (1000 * 60 * 60 * 24);
    const remainingDays = remainingMs / (1000 * 60 * 60 * 24);

    // Pro-rata = (newPrice - oldPrice) * remainingDays / totalDays
    const priceDiff = newBasePrice.subtract(oldBasePrice);
    return priceDiff.multiply(remainingDays).divide(totalDays);
  }
}
