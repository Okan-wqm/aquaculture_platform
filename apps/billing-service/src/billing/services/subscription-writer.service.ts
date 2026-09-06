/**
 * The one place a subscription row is written (ADR-0014, BILLING-CRITICAL-003).
 *
 * Two paths created subscriptions and only one of them created a Stripe
 * object. `CreateSubscriptionHandler` mints a customer and a subscription;
 * admin tenant provisioning raw-`INSERT`ed into `billing.subscriptions` with
 * `stripe_customer_id` and `stripe_subscription_id` left NULL — so every
 * tenant an operator provisioned had a subscription this platform believed in
 * and Stripe had never heard of. Nothing charged them, no Stripe webhook could
 * ever resolve to them, and the divergence was invisible until someone
 * reconciled by hand.
 *
 * The two paths differ in exactly two ways, and neither is the write itself:
 * where the numbers come from (a GraphQL input vs. the priced module items of
 * a provisioning command) and which transaction they belong to (its own vs.
 * the provisioning receipt's SERIALIZABLE one). So the write takes a resolved
 * shape and the caller's `EntityManager`, and the Stripe half is a separate
 * call the caller makes BEFORE opening its transaction — never hold a pool
 * connection across a network call (SSOT-C-12).
 */
import { StripeApiService } from '@aquaculture/backend-common/billing';
import { Injectable, Logger } from '@nestjs/common';
import {
  createBaseEvent,
  toEventIso,
  type SubscriptionCreatedEvent,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { EntityManager } from 'typeorm';

import { Plan } from '../entities/plan.entity';
import {
  BillingCycle,
  PlanTier,
  Subscription,
  SubscriptionStatus,
  type PlanLimits,
  type PlanPricing,
} from '../entities/subscription.entity';

/** The Stripe objects a subscription is backed by, or none for a local-only plan. */
export interface StripeSubscriptionRefs {
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
}

export interface SubscriptionWriteArgs {
  tenantId: string;
  plan: Pick<Plan, 'tier' | 'name' | 'billingCycle' | 'currency'>;
  billingCycle: BillingCycle;
  limits: PlanLimits;
  pricing: PlanPricing;
  startDate: Date;
  trialDays?: number;
  autoRenew?: boolean;
  actorId: string;
  stripe: StripeSubscriptionRefs;
}

@Injectable()
export class SubscriptionWriterService {
  private readonly logger = new Logger(SubscriptionWriterService.name);

  constructor(
    private readonly stripeApi: StripeApiService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  /**
   * Mint the Stripe customer and subscription for a plan that has a price.
   *
   * Runs OUTSIDE any transaction, and is idempotent: the keys derive from the
   * tenant and the plan, so a retry after a later DB failure reuses the same
   * Stripe objects rather than charging twice.
   *
   * A plan with no `stripe_price_ids[cycle]` yet creates local-only and says
   * so. That is a configuration gap, not an error — but it is logged at WARN
   * every time, because a subscription nobody is charged for looks exactly
   * like one that is.
   */
  async ensureStripeObjects(args: {
    tenantId: string;
    plan: Pick<Plan, 'tier' | 'stripePriceIds'>;
    billingCycle: BillingCycle;
    existingCustomerId?: string;
  }): Promise<StripeSubscriptionRefs> {
    const stripePriceId = args.plan.stripePriceIds?.[args.billingCycle] ?? null;
    if (!stripePriceId) {
      this.logger.warn(
        `Plan ${args.plan.tier}/${args.billingCycle} has no Stripe price configured; ` +
          `creating a local-only subscription for tenant ${args.tenantId} (no Stripe charge).`,
      );
      return { stripeCustomerId: args.existingCustomerId };
    }

    let stripeCustomerId = args.existingCustomerId;
    if (!stripeCustomerId) {
      const customer = await this.stripeApi.createCustomer({
        tenantId: args.tenantId,
        idempotencyKey: `cust-create:${args.tenantId}`,
      });
      stripeCustomerId = customer.id;
    }

    const stripeSub = await this.stripeApi.createSubscription({
      tenantId: args.tenantId,
      customerId: stripeCustomerId,
      priceId: stripePriceId,
      idempotencyKey: `sub-create:${args.tenantId}:${args.plan.tier}:${args.billingCycle}`,
    });

    return {
      stripeCustomerId: stripeSub.customer || stripeCustomerId,
      stripeSubscriptionId: stripeSub.id,
    };
  }

  /**
   * Write the subscription and its `SubscriptionCreated` outbox row inside the
   * CALLER's transaction, so the event commits atomically with the row.
   *
   * FREE is a permanent $0 tier (Billing Revival Faz B) and billing is the
   * SSoT for subscription state (D14), so its invariants are enforced here
   * rather than trusted from the caller: a FREE subscription is always
   * `active` (never `trial` — FREE is not a time-boxed preview) and its
   * recurring charge is $0 whatever numbers arrived.
   */
  async createWithin(manager: EntityManager, args: SubscriptionWriteArgs): Promise<Subscription> {
    const isFree = args.plan.tier === PlanTier.FREE;
    const currentPeriodEnd = periodEndFor(args.startDate, args.billingCycle);
    const trialEndDate =
      !isFree && args.trialDays && args.trialDays > 0
        ? addDays(args.startDate, args.trialDays)
        : undefined;

    const subscription = manager.create(Subscription, {
      tenantId: args.tenantId,
      planTier: args.plan.tier,
      planName: args.plan.name.trim(),
      status: trialEndDate ? SubscriptionStatus.TRIAL : SubscriptionStatus.ACTIVE,
      billingCycle: args.billingCycle,
      limits: args.limits,
      pricing: isFree
        ? { ...args.pricing, basePrice: 0, perFarmPrice: 0, perSensorPrice: 0, perUserPrice: 0 }
        : args.pricing,
      startDate: args.startDate,
      currentPeriodStart: args.startDate,
      currentPeriodEnd,
      trialEndDate,
      autoRenew: args.autoRenew !== false,
      stripeCustomerId: args.stripe.stripeCustomerId,
      stripeSubscriptionId: args.stripe.stripeSubscriptionId,
      createdBy: args.actorId,
      updatedBy: args.actorId,
    });

    const saved = await manager.save(Subscription, subscription);

    const event: SubscriptionCreatedEvent = {
      ...createBaseEvent<SubscriptionCreatedEvent>('SubscriptionCreated', args.tenantId, {
        userId: args.actorId,
        aggregateId: saved.id,
      }),
      subscriptionId: saved.id,
      tier: saved.planTier as SubscriptionCreatedEvent['tier'],
      monthlyPrice: saved.pricing.basePrice,
      currency: saved.pricing.currency,
      startDate: toEventIso(saved.startDate),
      features: {
        maxFarms: saved.limits?.maxFarms,
        maxPonds: saved.limits?.maxPonds,
        maxSensors: saved.limits?.maxSensors,
        maxUsers: saved.limits?.maxUsers,
      },
    };
    await this.outboxPublisher.enqueue(event, manager, { aggregateId: saved.id });

    this.logger.log(
      `Subscription created: ${saved.id} for tenant ${args.tenantId} with plan ` +
        `${args.plan.tier} by ${args.actorId}` +
        (args.stripe.stripeSubscriptionId
          ? ` (stripe ${args.stripe.stripeSubscriptionId})`
          : ' (local-only, no Stripe price)'),
    );
    return saved;
  }
}

/** The end of the first billing period. Shared, because both callers need it. */
export function periodEndFor(startDate: Date, billingCycle: BillingCycle): Date {
  return addMonthsClamped(startDate, cycleToMonths(billingCycle));
}

function cycleToMonths(billingCycle: BillingCycle): number {
  switch (billingCycle) {
    case BillingCycle.MONTHLY:
      return 1;
    case BillingCycle.QUARTERLY:
      return 3;
    case BillingCycle.SEMI_ANNUAL:
      return 6;
    case BillingCycle.ANNUAL:
      return 12;
  }
}

/**
 * Add months, clamping the day to the last valid one of the target month —
 * `Date.setMonth` overflows (Jan 31 + 1 month lands on Mar 3), which on a
 * billing period means an invoice raised two days late every February.
 */
function addMonthsClamped(date: Date, months: number): Date {
  const targetYear = date.getFullYear();
  const targetMonth = date.getMonth() + months;
  const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
  const clampedDay = Math.min(date.getDate(), lastDay);
  const result = new Date(date);
  result.setFullYear(targetYear, targetMonth, clampedDay);
  return result;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}
