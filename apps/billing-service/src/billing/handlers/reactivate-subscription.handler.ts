/**
 * Reactivate a cancelled subscription (ADR-0014, BILLING-CRITICAL-003).
 *
 * This replaces a raw `UPDATE billing.subscriptions` in the admin NATS
 * handler that flipped `status` back to active and cleared the cancellation
 * columns — and did nothing else. It touched no Stripe object, so Stripe went
 * on stopping the subscription at period end; it wrote no outbox event, so
 * metering and notification never learned the tenant was back; it projected
 * nothing onto `auth.tenants`, so the tenant's entitlements stayed cancelled;
 * and its `WHERE tenant_id = $1` had no id, so it would have written every
 * subscription row the tenant had.
 */
import { StripeApiService } from '@aquaculture/backend-common/billing';
import { RedisService } from '@aquaculture/backend-common/redis';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import {
  createBaseEvent,
  toEventIso,
  type TenantSubscriptionChangedEvent,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource, Repository } from 'typeorm';

import { ReactivateSubscriptionCommand } from '../commands/reactivate-subscription.command';
import { Subscription, SubscriptionStatus } from '../entities/subscription.entity';

@Injectable()
@CommandHandler(ReactivateSubscriptionCommand)
export class ReactivateSubscriptionHandler
  implements ICommandHandler<ReactivateSubscriptionCommand, Subscription>
{
  private readonly logger = new Logger(ReactivateSubscriptionHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly stripeApi: StripeApiService,
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    @Optional() private readonly redisService?: RedisService,
  ) {}

  async execute(command: ReactivateSubscriptionCommand): Promise<Subscription> {
    const { tenantId, subscriptionId, userId } = command;

    const existing = await this.subscriptions.findOne({
      where: { id: subscriptionId, tenantId },
    });
    if (!existing) {
      throw new NotFoundException(`Subscription with id ${subscriptionId} not found`);
    }
    if (existing.status !== SubscriptionStatus.CANCELLED) {
      throw new BadRequestException(
        `Can only reactivate a cancelled subscription; this one is ${existing.status}`,
      );
    }

    // Un-schedule the Stripe cancellation BEFORE opening the DB transaction —
    // never hold a pool connection across a network call (SSOT-C-12). The
    // update is idempotent, so a retry after a later DB failure is harmless,
    // and the webhook reconciles if the local commit never happens.
    if (existing.stripeSubscriptionId) {
      await this.stripeApi.updateSubscription({
        tenantId,
        subscriptionId: existing.stripeSubscriptionId,
        cancelAtPeriodEnd: false,
        idempotencyKey: `sub-reactivate:${existing.stripeSubscriptionId}`,
      });
    }

    return this.dataSource.transaction(async (manager) => {
      const subscription = await manager.findOne(Subscription, {
        where: { id: subscriptionId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!subscription) {
        throw new NotFoundException(`Subscription with id ${subscriptionId} not found`);
      }
      // Re-checked under the lock: two operators reactivating at once would
      // otherwise both pass the pre-flight check above.
      if (subscription.status !== SubscriptionStatus.CANCELLED) {
        throw new BadRequestException(
          `Can only reactivate a cancelled subscription; this one is ${subscription.status}`,
        );
      }

      subscription.status = SubscriptionStatus.ACTIVE;
      // The entity types these as optional, not nullable — `undefined` is
      // what TypeORM writes as NULL for them.
      subscription.cancelledAt = undefined;
      subscription.cancellationReason = undefined;
      subscription.autoRenew = true;
      subscription.endDate = undefined;
      subscription.updatedBy = userId;
      const saved = await manager.save(Subscription, subscription);

      if (this.redisService) {
        await this.redisService.del(`subscription:${tenantId}`).catch(() => {
          /* non-fatal: stale cache self-heals on TTL; the DB is SSoT */
        });
      }

      // The projection onto `auth.tenants` is what actually restores the
      // tenant's entitlements. Enqueued on the same transactional manager, so
      // a failure rolls the reactivation back rather than committing it
      // silently un-projected.
      const projection: TenantSubscriptionChangedEvent = {
        ...createBaseEvent<TenantSubscriptionChangedEvent>('TenantSubscriptionChanged', tenantId, {
          userId,
        }),
        previousPlan: saved.planTier,
        newPlan: saved.planTier,
        effectiveDate: toEventIso(new Date()),
        trialEndsAt: saved.trialEndDate ?? null,
        subscriptionEndsAt: null,
        subscriptionStatus: saved.status,
      };
      await this.outboxPublisher.enqueue(projection, manager);

      this.logger.log(
        JSON.stringify({ event: 'subscription.reactivated', subscriptionId, tenantId, userId }),
      );
      return saved;
    });
  }
}
