import { Injectable, NotFoundException, BadRequestException, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisService } from '@aquaculture/backend-common';
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
    private readonly eventEmitter: EventEmitter2,
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

      // Emit event so MeteredBillingService can evict any cached billing calculations
      // for this subscription (H-03: stale cache after plan change / cancellation).
      this.eventEmitter.emit('subscription.cancelled', {
        subscriptionId: savedSubscription.id,
        tenantId,
      });

      return savedSubscription;
    });
  }
}
