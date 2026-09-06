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
import { SubscriptionWriterService } from '../services/subscription-writer.service';
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
    private readonly subscriptionWriter: SubscriptionWriterService,
    @InjectRepository(Plan) private readonly planRepository: Repository<Plan>,
    @Optional() private readonly redisService?: RedisService,
  ) {}

  /**
   * D09-F01: Minimum base price per plan tier.
   * Prevents clients from submitting arbitrarily low prices via the GraphQL mutation.
   * CUSTOM tier has no minimum — pricing is negotiated externally.
   * Tenant provisioning prices modules via admin-api's PricingCalculatorService
   * (admin.module_pricing) and is not subject to this GraphQL-mutation minimum.
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
    // antipattern this handler already warns about). ADR-0014 moved this into
    // `SubscriptionWriterService` so admin tenant provisioning mints the same
    // objects with the same idempotency keys; it used to mint none at all.
    const plan = await this.planRepository.findOne({
      where: { tier: input.planTier, isActive: true },
      order: { sortOrder: 'ASC' },
    });
    const stripe = plan
      ? await this.subscriptionWriter.ensureStripeObjects({
          tenantId,
          plan,
          billingCycle: input.billingCycle,
          existingCustomerId: input.stripeCustomerId ?? undefined,
        })
      : { stripeCustomerId: input.stripeCustomerId ?? undefined };

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

      // BILLING-CRITICAL-001: the writer enqueues SubscriptionCreated into the
      // transactional outbox INSIDE this tx — atomic with the subscription
      // write, replacing the prior post-commit fire-and-forget publish that
      // could silently drop the event if the broker was down after commit.
      const savedSubscription = await this.subscriptionWriter.createWithin(
        queryRunner.manager,
        {
          tenantId,
          plan: {
            tier: input.planTier,
            name: input.planName,
            billingCycle: input.billingCycle,
            currency: input.pricing.currency || 'USD',
          },
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
          trialDays: input.trialDays,
          autoRenew: input.autoRenew,
          actorId: userId,
          stripe,
        },
      );

      // Commit transaction (subscription row + outbox row commit together)
      await queryRunner.commitTransaction();

      // Invalidate subscription cache so the new subscription is immediately visible
      if (this.redisService) {
        await this.redisService.del(`subscription:${tenantId}`).catch(() => { /* non-fatal */ });
      }

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
}
