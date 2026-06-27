import { Injectable, ConflictException, Logger, InternalServerErrorException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryRunner, Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { toEventIso, createBaseEvent, SubscriptionCreatedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { AuditedOperation } from '@aquaculture/backend-common/audit';
import { StripeApiService } from '@aquaculture/backend-common/billing';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { RedisService } from '@aquaculture/backend-common/redis';
import { CreateSubscriptionCommand } from '../commands/create-subscription.command';
import { Plan } from '../entities/plan.entity';
import { Subscription, SubscriptionStatus, BillingCycle, PlanTier } from '../entities/subscription.entity';

@AuditedOperation({ resource: 'Subscription', action: 'CREATE' })
@Injectable()
@CommandHandler(CreateSubscriptionCommand)
export class CreateSubscriptionHandler
  implements ICommandHandler<CreateSubscriptionCommand, Subscription>
{
  private readonly logger = new Logger(CreateSubscriptionHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly stripeApi: StripeApiService,
    @InjectRepository(Plan) private readonly planRepository: Repository<Plan>,
    @Optional() private readonly redisService?: RedisService,
  ) {}

  /**
   * D09-F01: Minimum base price per plan tier.
   * Prevents clients from submitting arbitrarily low prices via the GraphQL mutation.
   * CUSTOM tier has no minimum — pricing is negotiated externally.
   * The NATS event handler (TenantSubscriptionRequestedHandler) uses its own
   * DEFAULT_PRICING and is not subject to this validation.
   */
  private static readonly MIN_PRICES: Partial<Record<PlanTier, number>> = {
    [PlanTier.STARTER]: 49,
    [PlanTier.PROFESSIONAL]: 149,
    [PlanTier.ENTERPRISE]: 499,
  };

  async execute(command: CreateSubscriptionCommand): Promise<Subscription> {
    const { tenantId, input, userId } = command;

    // Validate application-level inputs BEFORE acquiring a DB connection from the pool.
    // This avoids holding a connection during cheap validation logic, preventing pool
    // exhaustion under burst provisioning (LOW-004).
    if (input.pricing.basePrice < 0) {
      throw new ConflictException('Base price cannot be negative');
    }

    // D09-F01: Enforce minimum base price per plan tier
    const minPrice = CreateSubscriptionHandler.MIN_PRICES[input.planTier];
    if (minPrice !== undefined && input.pricing.basePrice < minPrice) {
      throw new ConflictException(
        `Minimum base price for ${input.planTier.toUpperCase()} tier is $${minPrice}`,
      );
    }

    const startDate = input.startDate ? new Date(input.startDate) : new Date();
    if (isNaN(startDate.getTime())) {
      throw new ConflictException('Invalid start date');
    }

    if (input.trialDays && input.trialDays > 0 && input.trialDays > 30) {
      throw new ConflictException('Trial period cannot exceed 30 days');
    }

    // W1.1 (BILLING-CRITICAL-001 / SSOT-C-12): outbound Stripe runs BEFORE the DB
    // tx — never hold a pool connection across a network call (the pool-exhaustion
    // antipattern this handler already warns about). When the plan carries a
    // denormalized Stripe price (billing.plans.stripe_price_ids[cycle], W1.1) we
    // charge for real and fail-closed; deterministic idempotency keys make a
    // retry after a later DB failure reuse the same Stripe objects (no double
    // charge). Plans with no Stripe price yet create local-only (logged) until
    // an admin configures the price.
    const plan = await this.planRepository.findOne({
      where: { tier: input.planTier, isActive: true },
      order: { sortOrder: 'ASC' },
    });
    const stripePriceId = plan?.stripePriceIds?.[input.billingCycle] ?? null;

    let stripeCustomerId: string | undefined = input.stripeCustomerId ?? undefined;
    let stripeSubscriptionId: string | undefined;
    if (stripePriceId) {
      if (!stripeCustomerId) {
        const customer = await this.stripeApi.createCustomer({
          tenantId,
          idempotencyKey: `cust-create:${tenantId}`,
        });
        stripeCustomerId = customer.id;
      }
      const stripeSub = await this.stripeApi.createSubscription({
        tenantId,
        customerId: stripeCustomerId,
        priceId: stripePriceId,
        idempotencyKey: `sub-create:${tenantId}:${input.planTier}:${input.billingCycle}`,
      });
      stripeSubscriptionId = stripeSub.id;
      stripeCustomerId = stripeSub.customer || stripeCustomerId;
    } else {
      this.logger.warn(
        `Plan ${input.planTier}/${input.billingCycle} has no Stripe price configured; ` +
          `creating a local-only subscription for tenant ${tenantId} (no Stripe charge).`,
      );
    }

    // Create a query runner for transaction management
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      const subscriptionRepo = tenantManagerRepo(queryRunner.manager, Subscription, tenantId);

      // Check for existing subscription with pessimistic lock to prevent race conditions.
      // tenantId auto-injected by the scoped wrapper.
      // Only the live (non-soft-deleted) row holds the active unique slot —
      // historical soft-deleted cancellations must NOT be re-found as "existing".
      const existingSubscription = await subscriptionRepo.findOne({
        where: { isDeleted: false },
        lock: { mode: 'pessimistic_write' },
      });

      if (existingSubscription) {
        if (existingSubscription.status !== SubscriptionStatus.CANCELLED) {
          throw new ConflictException(`Active subscription already exists for tenant ${tenantId}`);
        }
        // ORPHAN-175 / BILLING-MEDIUM-004: SOFT-delete the cancelled subscription
        // instead of hard-deleting it. The partial unique index
        // UQ_subscriptions_tenantId_active is `WHERE is_deleted = false`, so a
        // soft-deleted row frees the active slot for the new INSERT below while
        // preserving the audit trail (invoices/payments) tied to the old row.
        existingSubscription.softDelete('system:create-subscription');
        await subscriptionRepo.save(existingSubscription);
      }

      const periodEnd = this.calculatePeriodEnd(startDate, input.billingCycle);

      // Handle trial period
      let status = SubscriptionStatus.ACTIVE;
      let trialEndDate: Date | undefined;

      if (input.trialDays && input.trialDays > 0) {
        // trialDays > 30 is already validated before the transaction starts
        status = SubscriptionStatus.TRIAL;
        trialEndDate = new Date(startDate);
        trialEndDate.setDate(trialEndDate.getDate() + input.trialDays);
      }

      const subscription = subscriptionRepo.create({
        tenantId,
        planTier: input.planTier,
        planName: input.planName.trim(),
        status,
        billingCycle: input.billingCycle,
        limits: {
          maxFarms: input.limits.maxFarms,
          maxPonds: input.limits.maxPonds,
          maxSensors: input.limits.maxSensors,
          maxUsers: input.limits.maxUsers,
          dataRetentionDays: input.limits.dataRetentionDays,
          alertsEnabled: input.limits.alertsEnabled,
          reportsEnabled: input.limits.reportsEnabled,
          apiAccessEnabled: input.limits.apiAccessEnabled,
          customIntegrationsEnabled: input.limits.customIntegrationsEnabled,
        },
        pricing: {
          basePrice: input.pricing.basePrice,
          perFarmPrice: input.pricing.perFarmPrice,
          perSensorPrice: input.pricing.perSensorPrice,
          perUserPrice: input.pricing.perUserPrice,
          currency: input.pricing.currency || 'USD',
        },
        startDate,
        currentPeriodStart: startDate,
        currentPeriodEnd: periodEnd,
        trialEndDate,
        autoRenew: input.autoRenew !== false,
        // W1.1: the REAL Stripe-generated ids (or undefined for local-only plans),
        // never the raw DTO value.
        stripeCustomerId,
        stripeSubscriptionId,
        createdBy: userId,
        updatedBy: userId,
      });

      const savedSubscription = await subscriptionRepo.save(subscription);

      // BILLING-CRITICAL-001: enqueue SubscriptionCreated into the transactional
      // outbox INSIDE the tx — atomic with the subscription write. Replaces the
      // prior post-commit fire-and-forget eventBus.publish that could silently
      // drop the event if the broker was down after commit. The outbox relay
      // publishes to NATS at-least-once after commit.
      const event: SubscriptionCreatedEvent = {
        ...createBaseEvent<SubscriptionCreatedEvent>('SubscriptionCreated', tenantId, {
          userId,
          aggregateId: savedSubscription.id,
        }),
        subscriptionId: savedSubscription.id,
        tier: savedSubscription.planTier as SubscriptionCreatedEvent['tier'],
        monthlyPrice: input.pricing.basePrice,
        currency: input.pricing.currency || 'USD',
        startDate: toEventIso(savedSubscription.startDate),
        features: {
          maxFarms: savedSubscription.limits?.maxFarms,
          maxPonds: savedSubscription.limits?.maxPonds,
          maxSensors: savedSubscription.limits?.maxSensors,
          maxUsers: savedSubscription.limits?.maxUsers,
        },
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager, {
        aggregateId: savedSubscription.id,
      });

      // Commit transaction (subscription row + outbox row commit together)
      await queryRunner.commitTransaction();

      // Invalidate subscription cache so the new subscription is immediately visible
      if (this.redisService) {
        await this.redisService.del(`subscription:${tenantId}`).catch(() => { /* non-fatal */ });
      }

      this.logger.log(
        `Subscription created: ${savedSubscription.id} for tenant ${tenantId} with plan ${input.planTier} by user ${userId}` +
          (stripeSubscriptionId ? ` (stripe ${stripeSubscriptionId})` : ' (local-only, no Stripe price)'),
      );

      return savedSubscription;
    } catch (error) {
      // Rollback transaction on error
      await queryRunner.rollbackTransaction();

      if (error instanceof ConflictException) {
        throw error;
      }

      this.logger.error(
        `Failed to create subscription for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to create subscription');
    } finally {
      // Release the query runner
      await queryRunner.release();
    }
  }

  private calculatePeriodEnd(startDate: Date, billingCycle: BillingCycle): Date {
    return this.addMonthsClamped(startDate, this.cycleToMonths(billingCycle));
  }

  private cycleToMonths(billingCycle: BillingCycle): number {
    switch (billingCycle) {
      case BillingCycle.MONTHLY:    return 1;
      case BillingCycle.QUARTERLY:  return 3;
      case BillingCycle.SEMI_ANNUAL: return 6;
      case BillingCycle.ANNUAL:     return 12;
    }
  }

  /**
   * Add months to a date, clamping the day to the last valid day of the target month.
   * Avoids the JS Date.setMonth() overflow bug (e.g. Jan 31 + 1 month → Mar 3).
   */
  private addMonthsClamped(date: Date, months: number): Date {
    const targetYear = date.getFullYear();
    const targetMonth = date.getMonth() + months;

    // Last day of the target month
    const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
    const clampedDay = Math.min(date.getDate(), lastDay);

    const result = new Date(date);
    result.setFullYear(targetYear, targetMonth, clampedDay);
    return result;
  }
}
