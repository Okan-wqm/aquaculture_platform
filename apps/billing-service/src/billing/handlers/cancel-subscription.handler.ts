import { Injectable, NotFoundException, BadRequestException, Logger, Optional, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { NatsEventBus } from '@platform/event-bus';
import {
  createBaseEvent,
  SubscriptionCancelledEvent,
  TenantSubscriptionChangedEvent,
} from '@platform/event-contracts';
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
    @Optional() @Inject('EVENT_BUS') private readonly eventBus?: NatsEventBus,
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

      // Publish NATS event so other services (metering, notification, etc.)
      // can react to the cancellation.
      try {
        const event: SubscriptionCancelledEvent = {
          ...createBaseEvent<SubscriptionCancelledEvent>('SubscriptionCancelled', tenantId, { userId }),
          subscriptionId: savedSubscription.id,
          cancellationDate: savedSubscription.cancelledAt!,
          effectiveEndDate: savedSubscription.endDate!,
          reason,
        };
        await this.eventBus?.publish(event);
      } catch (eventError) {
        // Event publish failure must not block the main operation
        this.logger.warn(
          `Failed to publish SubscriptionCancelled event for ${savedSubscription.id}: ${
            eventError instanceof Error ? eventError.message : 'Unknown error'
          }`,
        );
      }

      // DATA-LOW-001: project the post-cancellation state onto auth.tenants
      // (status -> cancelled, the subscription end date). The plan tier itself
      // is unchanged by a cancellation, so previousPlan === newPlan here.
      try {
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
        await this.eventBus?.publish(projection);
      } catch (eventError) {
        this.logger.warn(
          `Failed to publish TenantSubscriptionChanged event for ${savedSubscription.id}: ${
            eventError instanceof Error ? eventError.message : 'Unknown error'
          }`,
        );
      }

      return savedSubscription;
    });
  }
}
