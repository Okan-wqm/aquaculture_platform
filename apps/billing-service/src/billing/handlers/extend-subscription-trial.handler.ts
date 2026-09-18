/**
 * Extend a trial (ADR-0014, BILLING-CRITICAL-003).
 *
 * This replaces a raw `UPDATE billing.subscriptions` in the admin NATS handler
 * that moved `trial_end_date` locally and told Stripe nothing — so a tenant
 * granted another fourteen days was invoiced on the ORIGINAL date and, from
 * their side, charged during a trial they had been promised. It also wrote no
 * outbox event and projected nothing onto `auth.tenants`, and its
 * `WHERE tenant_id = $3` named no subscription id.
 *
 * It also overwrote `current_period_end` with the new trial end. That is the
 * BILLING period, not the trial: on a monthly plan it silently moved the next
 * invoice date, and on a plan whose period already ran past the trial it moved
 * it BACKWARDS. Only the trial end moves here.
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

import { ExtendSubscriptionTrialCommand } from '../commands/extend-subscription-trial.command';
import { Subscription, SubscriptionStatus } from '../entities/subscription.entity';

/** A trial nobody would grant by hand; a typo in days should not become one. */
const MAX_ADDITIONAL_TRIAL_DAYS = 365;

@Injectable()
@CommandHandler(ExtendSubscriptionTrialCommand)
export class ExtendSubscriptionTrialHandler
  implements ICommandHandler<ExtendSubscriptionTrialCommand, Subscription>
{
  private readonly logger = new Logger(ExtendSubscriptionTrialHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly stripeApi: StripeApiService,
    @InjectRepository(Subscription)
    private readonly subscriptions: Repository<Subscription>,
    @Optional() private readonly redisService?: RedisService,
  ) {}

  async execute(command: ExtendSubscriptionTrialCommand): Promise<Subscription> {
    const { tenantId, subscriptionId, additionalDays, userId } = command;

    if (!Number.isInteger(additionalDays) || additionalDays < 1) {
      throw new BadRequestException('additionalDays must be a positive whole number of days');
    }
    if (additionalDays > MAX_ADDITIONAL_TRIAL_DAYS) {
      throw new BadRequestException(`additionalDays cannot exceed ${MAX_ADDITIONAL_TRIAL_DAYS}`);
    }

    const existing = await this.subscriptions.findOne({
      where: { id: subscriptionId, tenantId },
    });
    if (!existing) {
      throw new NotFoundException(`Subscription with id ${subscriptionId} not found`);
    }
    if (existing.status !== SubscriptionStatus.TRIAL) {
      throw new BadRequestException(
        `Can only extend the trial of a trialing subscription; this one is ${existing.status}`,
      );
    }

    const newTrialEnd = addDays(existing.trialEndDate ?? new Date(), additionalDays);

    // Move Stripe's trial BEFORE opening the DB transaction (SSOT-C-12). If the
    // local commit then fails, Stripe holds the longer trial and the operator
    // retries; the reverse order would charge a customer mid-trial.
    if (existing.stripeSubscriptionId) {
      await this.stripeApi.updateSubscription({
        tenantId,
        subscriptionId: existing.stripeSubscriptionId,
        trialEnd: newTrialEnd,
        idempotencyKey: `sub-trial:${existing.stripeSubscriptionId}:${newTrialEnd.toISOString()}`,
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
      if (subscription.status !== SubscriptionStatus.TRIAL) {
        throw new BadRequestException(
          `Can only extend the trial of a trialing subscription; this one is ${subscription.status}`,
        );
      }

      subscription.trialEndDate = newTrialEnd;
      subscription.updatedBy = userId;
      const saved = await manager.save(Subscription, subscription);

      if (this.redisService) {
        await this.redisService.del(`subscription:${tenantId}`).catch(() => {
          /* non-fatal: stale cache self-heals on TTL; the DB is SSoT */
        });
      }

      const projection: TenantSubscriptionChangedEvent = {
        ...createBaseEvent<TenantSubscriptionChangedEvent>('TenantSubscriptionChanged', tenantId, {
          userId,
        }),
        previousPlan: saved.planTier,
        newPlan: saved.planTier,
        effectiveDate: toEventIso(new Date()),
        trialEndsAt: saved.trialEndDate ?? null,
        subscriptionEndsAt: saved.endDate ?? null,
        subscriptionStatus: saved.status,
      };
      await this.outboxPublisher.enqueue(projection, manager);

      this.logger.log(
        JSON.stringify({
          event: 'subscription.trial-extended',
          subscriptionId,
          tenantId,
          additionalDays,
          trialEndsAt: newTrialEnd.toISOString(),
          userId,
        }),
      );
      return saved;
    });
  }
}

/**
 * Days added in UTC, so an extension does not gain or lose an hour across a
 * daylight-saving boundary — `setDate` on a local-time Date does exactly that.
 */
function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}
