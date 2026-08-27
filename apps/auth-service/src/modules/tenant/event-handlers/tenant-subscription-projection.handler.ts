import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IEventBus, IEventHandler } from '@platform/event-bus';
import { TenantPlan, type TenantSubscriptionChangedEvent } from '@platform/event-contracts';
import { Repository } from 'typeorm';

import { Tenant } from '../entities/tenant.entity';
import { EventDedupService } from '@aquaculture/backend-common';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Narrowing guard: a raw plan string is one of the canonical TenantPlan values. */
function isTenantPlan(value: string): value is TenantPlan {
  return (Object.values(TenantPlan) as string[]).includes(value);
}

/**
 * TenantSubscriptionProjectionHandler (DATA-LOW-001)
 *
 * billing.subscriptions is the single source of truth for a tenant's
 * subscription state; auth.tenants only holds a PROJECTION of it (plan —
 * which the JWT planLevel claim reads — plus trialEndsAt and
 * subscriptionEndsAt). Pre-fix nothing reconciled that projection, so it drifted
 * after every billing-side plan change / trial end / cancellation.
 *
 * This subscribes to the billing-emitted TenantSubscriptionChanged event and
 * mirrors the carried state onto auth.tenants. It is a one-way projection: it
 * only writes the fields the event carries (skipping any left undefined by an
 * older producer) and never writes back to billing.
 */
@Injectable()
export class TenantSubscriptionProjectionHandler
  implements IEventHandler<TenantSubscriptionChangedEvent>, OnModuleInit
{
  private readonly logger = new Logger(TenantSubscriptionProjectionHandler.name);

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus: IEventBus | undefined,
    // SEC-MEDIUM-101 (2026-08-23 scan №46): shared dedup + apply-if-newer
    private readonly eventDedup?: EventDedupService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.eventBus) {
      // Dev harnesses boot without NATS — the projection is simply inert there
      // (the same posture every other cross-service consumer takes).
      this.logger.warn(
        'EVENT_BUS unavailable — auth.tenants subscription projection disabled (no NATS)',
      );
      return;
    }
    await this.eventBus.subscribeWildcard('TenantSubscriptionChanged', this);
    this.logger.log(
      'Subscribed to TenantSubscriptionChanged — projecting billing subscription state onto auth.tenants',
    );
  }

  getEventType(): string {
    return 'TenantSubscriptionChanged';
  }

  async handle(event: TenantSubscriptionChangedEvent): Promise<void> {
    // SEC-MEDIUM-101 (№46): at-least-once delivery makes redelivery normal;
    // claim the eventId so a replayed duplicate is a no-op.
    if (this.eventDedup && event.eventId) {
      const claimed = await this.eventDedup.claimEventId(
        'auth:subscription-projection',
        event.eventId,
        event.tenantId,
      );
      if (!claimed) {
        this.logger.log(
          `TenantSubscriptionChanged eventId=${event.eventId} already projected — skipping`,
        );
        return;
      }
    }

    // SEC-MEDIUM-101 (№46) apply-if-newer: a STALE event arriving after a
    // newer projection must not regress the tenant's plan (the JWT planLevel
    // claim reads the projected columns). The event's server-clock timestamp
    // is compared against the last-accepted timestamp, tracked per tenant in
    // the dedup service's Redis.
    if (this.eventDedup && event.tenantId && event.timestamp) {
      const isNewer = await this.eventDedup.isNewerAndRecord(
        'auth:subscription-projection',
        event.tenantId,
        event.timestamp,
      );
      if (!isNewer) {
        this.logger.log(
          `TenantSubscriptionChanged for ${event.tenantId} is STALE (event=${event.timestamp}) — skipping to avoid regression`,
        );
        return;
      }
    }

    if (!event.tenantId || !UUID_REGEX.test(event.tenantId)) {
      this.logger.error(
        `TenantSubscriptionChanged has an invalid/missing tenantId ('${event.tenantId}') — projection skipped to avoid a cross-tenant write.`,
      );
      return;
    }

    const patch: Partial<Pick<Tenant, 'plan' | 'trialEndsAt' | 'subscriptionEndsAt'>> = {};

    if (isTenantPlan(event.newPlan)) {
      patch.plan = event.newPlan;
    } else {
      this.logger.warn(
        `TenantSubscriptionChanged carried an unknown plan '${event.newPlan}' for tenant ${event.tenantId} — plan not projected.`,
      );
    }
    // trialEndsAt / subscriptionEndsAt arrive as an ISO string (or null) over
    // NATS; only project a field the producer actually set.
    if (event.trialEndsAt !== undefined) {
      patch.trialEndsAt = event.trialEndsAt ? new Date(event.trialEndsAt) : null;
    }
    if (event.subscriptionEndsAt !== undefined) {
      patch.subscriptionEndsAt = event.subscriptionEndsAt
        ? new Date(event.subscriptionEndsAt)
        : null;
    }

    if (Object.keys(patch).length === 0) {
      return;
    }

    const result = await this.tenantRepository.update({ id: event.tenantId }, patch);
    if (!result.affected) {
      this.logger.warn(
        `TenantSubscriptionChanged for tenant ${event.tenantId} matched no auth.tenants row — projection skipped.`,
      );
      return;
    }
    this.logger.log(
      `Projected subscription state onto auth.tenants for tenant ${event.tenantId} (plan=${event.newPlan}).`,
    );
  }
}
