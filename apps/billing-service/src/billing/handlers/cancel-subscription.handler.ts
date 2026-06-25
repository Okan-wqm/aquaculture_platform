import { Injectable, NotFoundException, BadRequestException, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import {
  createBaseEvent,
  SubscriptionCancelledEvent,
  TenantSubscriptionChangedEvent,
} from '@platform/event-contracts';
import { StripeApiService } from '@aquaculture/backend-common/billing';
import { RedisService } from '@aquaculture/backend-common/redis';
import { CancelSubscriptionCommand } from '../commands/cancel-subscription.command';
import { Subscription, SubscriptionStatus } from '../entities/subscription.entity';

const MAX_CANCELLATION_REASON_LENGTH = 1000;

@Injectable()
@CommandHandler(CancelSubscriptionCommand)
export class CancelSubscriptionHandler
  implements ICommandHandler<CancelSubscriptionCommand, Subscription>
{
  private readonly logger = new Logger(CancelSubscriptionHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly stripeApi: StripeApiService,
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
    @Optional() private readonly redisService?: RedisService,
  ) {}

  async execute(command: CancelSubscriptionCommand): Promise<Subscription> {
    const { tenantId, subscriptionId, reason, userId } = command;

    // Validate cancellation reason length
    if (reason && reason.length > MAX_CANCELLATION_REASON_LENGTH) {
      throw new BadRequestException(
        `Cancellation reason must not exceed ${MAX_CANCELLATION_REASON_LENGTH} characters`,
      );
    }

    // W1.1 (SSOT-C-12): cancel at Stripe BEFORE opening the DB tx — never hold a
    // pool connection/lock across the network call. Cancelling is idempotent, so
    // a retry after a later DB failure is harmless; if the local commit then
    // fails the webhook (customer.subscription.deleted) reconciles. We cancel at
    // period end to mirror the local endDate = currentPeriodEnd.
    const existing = await this.subscriptionRepository.findOne({
      where: { id: subscriptionId, tenantId },
    });
    if (existing?.stripeSubscriptionId) {
      await this.stripeApi.cancelSubscription({
        tenantId,
        subscriptionId: existing.stripeSubscriptionId,
        immediately: false,
        idempotencyKey: `sub-cancel:${existing.stripeSubscriptionId}`,
      });
    }

    // Use transaction with pessimistic lock to prevent concurrent cancellations
    return await this.dataSource.transaction(async (manager) => {
      const subscription = await manager.findOne(Subscription, {
        where: { id: subscriptionId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!subscription) {
        throw new NotFoundException(`Subscription with id ${subscriptionId} not found`);
      }

      // Validate that subscription can be cancelled
      const cancellableStatuses = [
        SubscriptionStatus.ACTIVE,
        SubscriptionStatus.TRIAL,
        SubscriptionStatus.PAST_DUE,
        SubscriptionStatus.SUSPENDED,
      ];

      if (!cancellableStatuses.includes(subscription.status)) {
        throw new BadRequestException(
          `Cannot cancel subscription with status ${subscription.status}`,
        );
      }

      subscription.status = SubscriptionStatus.CANCELLED;
      subscription.cancelledAt = new Date();
      subscription.cancellationReason = reason;
      subscription.autoRenew = false;
      subscription.endDate = subscription.currentPeriodEnd;
      subscription.updatedBy = userId;

      const savedSubscription = await manager.save(Subscription, subscription);

      this.logger.log(
        `Subscription cancelled: ${savedSubscription.id} for tenant ${tenantId}. Reason: ${reason}`,
      );

      // Invalidate Redis subscription cache so callers immediately see the cancellation
      if (this.redisService) {
        await this.redisService.del(`subscription:${tenantId}`).catch(() => { /* non-fatal */ });
      }

      // Enqueue SubscriptionCancelled into the transactional outbox so other
      // services (metering, notification, etc.) react after the cancellation
      // commits. The relay publishes to NATS after commit; an enqueue failure
      // rolls the cancellation back rather than committing it eventless
      // (replaces the prior fire-and-forget publish).
      const event: SubscriptionCancelledEvent = {
        ...createBaseEvent<SubscriptionCancelledEvent>('SubscriptionCancelled', tenantId, { userId }),
        subscriptionId: savedSubscription.id,
        cancellationDate: savedSubscription.cancelledAt!,
        effectiveEndDate: savedSubscription.endDate!,
        reason,
      };
      await this.outboxPublisher.enqueue(event, manager);

      // DATA-LOW-001: project the post-cancellation state onto auth.tenants
      // (status -> cancelled, the subscription end date). The plan tier itself
      // is unchanged by a cancellation, so previousPlan === newPlan here.
      // Enqueued on the same transactional manager so it commits atomically.
      const projection: TenantSubscriptionChangedEvent = {
        ...createBaseEvent<TenantSubscriptionChangedEvent>(
          'TenantSubscriptionChanged',
          tenantId,
          { userId },
        ),
        previousPlan: savedSubscription.planTier,
        newPlan: savedSubscription.planTier,
        effectiveDate: savedSubscription.cancelledAt ?? new Date(),
        trialEndsAt: savedSubscription.trialEndDate ?? null,
        subscriptionEndsAt: savedSubscription.endDate ?? null,
        subscriptionStatus: savedSubscription.status,
      };
      await this.outboxPublisher.enqueue(projection, manager);

      return savedSubscription;
    });
  }
}
