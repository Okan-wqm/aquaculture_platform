import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { CancelSubscriptionCommand } from '../commands/cancel-subscription.command';
import { Subscription, SubscriptionStatus } from '../entities/subscription.entity';

@Injectable()
@CommandHandler(CancelSubscriptionCommand)
export class CancelSubscriptionHandler
  implements ICommandHandler<CancelSubscriptionCommand, Subscription>
{
  private readonly logger = new Logger(CancelSubscriptionHandler.name);

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
  ) {}

  async execute(command: CancelSubscriptionCommand): Promise<Subscription> {
    const { tenantId, subscriptionId, reason, userId } = command;

    const subscription = await this.subscriptionRepository.findOne({
      where: { id: subscriptionId, tenantId },
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
    subscription.endDate = subscription.currentPeriodEnd; // Allow usage until end of current period
    subscription.updatedBy = userId;

    const savedSubscription = await this.subscriptionRepository.save(subscription);

    this.logger.log(
      `Subscription cancelled: ${savedSubscription.id} for tenant ${tenantId}. Reason: ${reason}`,
    );

    return savedSubscription;
  }
}
