import { Injectable, Logger } from '@nestjs/common';
import { StripeApiService } from '@aquaculture/backend-common/billing';

import { PlanTier } from '../entities/subscription.entity';

/**
 * The one place a tenant's Stripe customer and subscription are minted.
 *
 * # Why this exists
 *
 * Two paths create a subscription. `CreateSubscriptionHandler` (the GraphQL
 * path) minted both Stripe objects; `BillingAdminNatsHandler` (operator
 * provisioning) raw-INSERTed into `billing.subscriptions` with
 * `stripe_customer_id` and `stripe_subscription_id` omitted from the column
 * list entirely, so they landed NULL and nothing ever filled them — the only
 * writer of those columns was the path the operator flow does not use. Every
 * tenant an operator provisioned therefore had a subscription this platform
 * believed in and Stripe had never heard of: nothing charged them, and the
 * divergence was invisible short of reconciling by hand (BILLING-CRITICAL-010).
 *
 * Copying the mint into the second handler would have made two copies of the
 * idempotency-key shapes and the no-price rule — the same defect class as
 * BILLING-CRITICAL-007, where a price rule written twice in two services
 * disagreed. So the mint moved here and both callers use it.
 *
 * # Idempotency
 *
 * The keys derive from the tenant and the plan, never from a command id, so a
 * provisioning replay reuses the same Stripe customer and subscription rather
 * than minting a second pair. That is what makes it safe to call this BEFORE
 * the provisioning transaction opens — which it must be, because a pool
 * connection is never held across a network call (SSOT-C-12), and because a
 * SERIALIZABLE transaction that waits on Stripe holds a serialization slot for
 * the length of an HTTP round trip.
 *
 * The caller's short-circuits are safe against that ordering:
 * `assertActiveSubscriptionReplayMatches` throws when an already-active
 * subscription's plan does not match the command, so a command that would mint
 * a Stripe subscription for a plan the tenant does not end up on is rejected
 * rather than silently returning — no orphan is created.
 */
@Injectable()
export class StripeSubscriptionProvisionerService {
  private readonly logger = new Logger(StripeSubscriptionProvisionerService.name);

  constructor(private readonly stripeApi: StripeApiService) {}

  /**
   * Mints (or re-resolves) the Stripe objects for a tenant's subscription.
   *
   * Returns both ids undefined when the plan is not billable through Stripe —
   * a FREE tier, or a plan with no configured price for the cycle being sold.
   * That is a local-only subscription, and it is a WARN rather than an error
   * because a catalogue can legitimately predate its Stripe wiring; the
   * subscription is still recorded, it is simply not charged.
   */
  async ensureStripeObjects(args: {
    tenantId: string;
    tier: PlanTier;
    billingCycle: string;
    stripePriceIds?: Record<string, string> | null;
    /** A customer the caller already knows, so a second one is never minted. */
    existingCustomerId?: string;
    /** Tenant name, so the Stripe customer is identifiable in the dashboard. */
    name?: string;
  }): Promise<{ stripeCustomerId?: string; stripeSubscriptionId?: string }> {
    if (args.tier === PlanTier.FREE) {
      // FREE is a permanent $0 tier, enforced in billing as the SSoT (D14).
      // Minting a Stripe subscription for it would create a recurring object
      // for a charge that must never happen.
      return {};
    }

    const priceId = args.stripePriceIds?.[args.billingCycle];
    if (!priceId) {
      this.logger.warn(
        `Plan ${args.tier}/${args.billingCycle} has no Stripe price configured; ` +
          `creating a local-only subscription for tenant ${args.tenantId} (no Stripe charge).`,
      );
      return { stripeCustomerId: args.existingCustomerId };
    }

    let stripeCustomerId = args.existingCustomerId;
    if (!stripeCustomerId) {
      const customer = await this.stripeApi.createCustomer({
        tenantId: args.tenantId,
        name: args.name,
        idempotencyKey: `cust-create:${args.tenantId}`,
      });
      stripeCustomerId = customer.id;
    }

    const subscription = await this.stripeApi.createSubscription({
      tenantId: args.tenantId,
      customerId: stripeCustomerId,
      priceId,
      idempotencyKey: `sub-create:${args.tenantId}:${args.tier}:${args.billingCycle}`,
    });

    return {
      stripeCustomerId: subscription.customer || stripeCustomerId,
      stripeSubscriptionId: subscription.id,
    };
  }
}
