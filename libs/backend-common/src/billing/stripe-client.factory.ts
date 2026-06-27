import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

import {
  IStripeApiClient,
  StripeCustomer,
  StripeIdempotencyKey,
  StripeInvoice,
  StripeMetadata,
  StripeRefund,
  StripeSubscription,
  StripeMeterEvent,
} from './stripe-api.types';

/**
 * The ONE adapter that constructs a real Stripe SDK instance and maps its
 * 14k-line types down to the narrow `IStripeApiClient` contract. This is the
 * only file in the repo permitted to `import 'stripe'`
 * (`tests/invariants/stripe-calls-via-canonical-client.spec.ts`, ADR-016).
 *
 * Everything outbound flows through `StripeApiService` → this client; the
 * service owns the audit-first + per-tenant circuit-breaker + fail-closed
 * contract, so this adapter is a thin, side-effect-free translation layer.
 */

// ADR-016: pin the API version so an SDK upgrade never silently changes wire
// behaviour. Bump deliberately alongside an SDK bump + a contract review.
const STRIPE_API_VERSION = '2024-12-18.acacia';

/**
 * Single source of truth for whether outbound Stripe billing is wired on.
 *
 * WHY this flag exists: two contracts collided. The 2026-04-14 graceful-boot
 * contract wanted billing-service to start even with no Stripe key so the rest
 * of the platform can deploy; the #640 fail-closed contract wanted the service
 * to REFUSE to boot when it cannot bill. NODE_ENV gating reconciled neither —
 * a production droplet with no key would crash-loop on boot and roll the deploy
 * back. `STRIPE_BILLING_ENABLED` (default false) is the explicit operator
 * intent that reconciles both:
 *   - off (default, any env)        → boot with a fail-closed disabled client
 *                                      (UnconfiguredStripeClient throws at the
 *                                      moment any Stripe call is attempted).
 *   - on + STRIPE_SECRET_KEY set    → the real Stripe adapter.
 *   - on + STRIPE_SECRET_KEY missing → throw at BOOT (the service must not start
 *                                      claiming it can bill when it cannot).
 * The flag is NON-secret (it is intent, not a credential) — it is NOT part of
 * PLATFORM_SECRET_ENV_VARS. The credential remains the canonical
 * STRIPE_SECRET_KEY.
 */
export const STRIPE_BILLING_ENABLED_ENV = 'STRIPE_BILLING_ENABLED';
export const STRIPE_SECRET_KEY_ENV = 'STRIPE_SECRET_KEY';

/**
 * Canonical boolean-env idiom (matches DATABASE_SSL in
 * libs/backend-common/src/database/ssl-config.ts and SCHEMA_DRIFT_ENABLED in
 * schema-drift-validator.service.ts): default to the safe value, opt-in only on
 * the exact string 'true'.
 */
function isStripeBillingEnabled(config: ConfigService): boolean {
  return config.get<string>(STRIPE_BILLING_ENABLED_ENV, 'false') === 'true';
}

/**
 * Thrown when a Stripe mutation is attempted while billing is disabled
 * (`STRIPE_BILLING_ENABLED` off or unset) — the service booted with a
 * fail-closed disabled client (see stripeClientFactory / UnconfiguredStripeClient)
 * so any code path that DOES try to call Stripe fails loudly rather than
 * silently succeeding. When billing is ENABLED but no key is present the factory
 * throws at boot instead, so this error never indicates an enabled-but-keyless
 * misconfiguration.
 */
export class StripeNotConfiguredError extends Error {
  constructor() {
    super(
      `Stripe billing is disabled (${STRIPE_BILLING_ENABLED_ENV} is off or ` +
        'unset). Outbound billing calls are refused (fail-closed) until the ' +
        `flag is enabled and ${STRIPE_SECRET_KEY_ENV} is configured.`,
    );
    this.name = 'StripeNotConfiguredError';
  }
}

function customerId(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
): string {
  if (!customer) return '';
  return typeof customer === 'string' ? customer : customer.id;
}

function epochToIso(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) return new Date(0).toISOString();
  return new Date(epochSeconds * 1000).toISOString();
}

function toStripeSubscription(sub: Stripe.Subscription): StripeSubscription {
  return {
    id: sub.id,
    customer: customerId(sub.customer),
    status: sub.status,
    currentPeriodStartIso: epochToIso(sub.current_period_start),
    currentPeriodEndIso: epochToIso(sub.current_period_end),
    metadata: sub.metadata ?? {},
  };
}

function toStripeRefund(refund: Stripe.Refund): StripeRefund {
  return {
    id: refund.id,
    chargeId: typeof refund.charge === 'string' ? refund.charge : (refund.charge?.id ?? ''),
    amount: BigInt(refund.amount),
    currency: refund.currency,
    status: (refund.status ?? 'pending') as StripeRefund['status'],
    reason: refund.reason ?? null,
  };
}

function toStripeCustomer(customer: Stripe.Customer): StripeCustomer {
  return {
    id: customer.id,
    email: customer.email ?? null,
    metadata: customer.metadata ?? {},
  };
}

function toStripeInvoice(invoice: Stripe.Invoice): StripeInvoice {
  return {
    id: invoice.id,
    status: invoice.status ?? null,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
  };
}

/** Real implementation of IStripeApiClient backed by the Stripe SDK. */
class RealStripeClient implements IStripeApiClient {
  constructor(private readonly stripe: Stripe) {}

  async createCustomer(args: {
    email?: string;
    name?: string;
    metadata: StripeMetadata;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeCustomer> {
    const customer = await this.stripe.customers.create(
      { email: args.email, name: args.name, metadata: { ...args.metadata } },
      { idempotencyKey: args.idempotencyKey },
    );
    return toStripeCustomer(customer);
  }

  async createSubscription(args: {
    customerId: string;
    priceId: string;
    metadata: StripeMetadata;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeSubscription> {
    const sub = await this.stripe.subscriptions.create(
      {
        customer: args.customerId,
        items: [{ price: args.priceId }],
        metadata: { ...args.metadata },
      },
      { idempotencyKey: args.idempotencyKey },
    );
    return toStripeSubscription(sub);
  }

  async updateSubscription(args: {
    subscriptionId: string;
    priceId?: string;
    metadata?: StripeMetadata;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeSubscription> {
    const params: Stripe.SubscriptionUpdateParams = {};
    if (args.metadata) {
      params.metadata = { ...args.metadata };
    }
    if (args.priceId) {
      // Swap the single subscription item to the new price (proration default).
      const current = await this.stripe.subscriptions.retrieve(args.subscriptionId);
      const itemId = current.items.data[0]?.id;
      if (itemId) {
        params.items = [{ id: itemId, price: args.priceId }];
      }
    }
    const sub = await this.stripe.subscriptions.update(args.subscriptionId, params, {
      idempotencyKey: args.idempotencyKey,
    });
    return toStripeSubscription(sub);
  }

  async cancelSubscription(args: {
    subscriptionId: string;
    immediately: boolean;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeSubscription> {
    const sub = args.immediately
      ? await this.stripe.subscriptions.cancel(args.subscriptionId, undefined, {
          idempotencyKey: args.idempotencyKey,
        })
      : await this.stripe.subscriptions.update(
          args.subscriptionId,
          { cancel_at_period_end: true },
          { idempotencyKey: args.idempotencyKey },
        );
    return toStripeSubscription(sub);
  }

  async retrieveSubscription(args: {
    subscriptionId: string;
  }): Promise<StripeSubscription> {
    const sub = await this.stripe.subscriptions.retrieve(args.subscriptionId);
    return toStripeSubscription(sub);
  }

  async createRefund(args: {
    chargeId: string;
    amount: bigint;
    reason: 'duplicate' | 'fraudulent' | 'requested_by_customer';
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeRefund> {
    const refund = await this.stripe.refunds.create(
      { charge: args.chargeId, amount: Number(args.amount), reason: args.reason },
      { idempotencyKey: args.idempotencyKey },
    );
    return toStripeRefund(refund);
  }

  async retrieveRefund(args: { refundId: string }): Promise<StripeRefund> {
    const refund = await this.stripe.refunds.retrieve(args.refundId);
    return toStripeRefund(refund);
  }

  async finalizeInvoice(args: {
    invoiceId: string;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeInvoice> {
    const invoice = await this.stripe.invoices.finalizeInvoice(
      args.invoiceId,
      { idempotencyKey: args.idempotencyKey },
    );
    return toStripeInvoice(invoice);
  }

  async reportMeterEvent(
    args: StripeMeterEvent & { idempotencyKey: StripeIdempotencyKey },
  ): Promise<void> {
    await this.stripe.billing.meterEvents.create(
      {
        event_name: args.meterEventName,
        identifier: args.identifier,
        payload: {
          stripe_customer_id: args.customerId,
          value: String(args.value),
        },
      },
      { idempotencyKey: args.idempotencyKey },
    );
  }
}

/**
 * A client that throws on every mutating call — bound in ANY environment
 * (including production) when billing is disabled (`STRIPE_BILLING_ENABLED` off
 * or unset). This is the fail-closed disabled binding: the service boots so the
 * rest of the platform can deploy, but any code path that DOES attempt a Stripe
 * call fails loudly with StripeNotConfiguredError (never a silent success). It
 * is NOT gated by NODE_ENV — a production droplet with billing intentionally off
 * boots cleanly with this client.
 */
class UnconfiguredStripeClient implements IStripeApiClient {
  private fail(): never {
    throw new StripeNotConfiguredError();
  }
  createCustomer(): Promise<StripeCustomer> {
    return this.fail();
  }
  createSubscription(): Promise<StripeSubscription> {
    return this.fail();
  }
  updateSubscription(): Promise<StripeSubscription> {
    return this.fail();
  }
  cancelSubscription(): Promise<StripeSubscription> {
    return this.fail();
  }
  retrieveSubscription(): Promise<StripeSubscription> {
    return this.fail();
  }
  createRefund(): Promise<StripeRefund> {
    return this.fail();
  }
  retrieveRefund(): Promise<StripeRefund> {
    return this.fail();
  }
  finalizeInvoice(): Promise<StripeInvoice> {
    return this.fail();
  }
  reportMeterEvent(): Promise<void> {
    return this.fail();
  }
}

/**
 * Factory for the canonical Stripe client (bind to STRIPE_API_CLIENT).
 *
 * Flag-gated SSoT (see STRIPE_BILLING_ENABLED_ENV docblock above). NODE_ENV no
 * longer gates boot survival — it is consulted ONLY for the sk_live_ safety
 * check — so a production droplet with billing intentionally off boots cleanly:
 *   - STRIPE_BILLING_ENABLED off/unset (any env) → an UnconfiguredStripeClient
 *     that fails closed at REQUEST time (the service boots).
 *   - enabled + no STRIPE_SECRET_KEY             → throw at BOOT (refuse to start
 *     claiming it can bill when it cannot).
 *   - enabled + `sk_live_` key outside production → throw (never let a real live
 *     key run against a non-prod database).
 *   - enabled + key present                       → the real Stripe adapter.
 */
export function stripeClientFactory(config: ConfigService): IStripeApiClient {
  const logger = new Logger('StripeClientFactory');

  if (!isStripeBillingEnabled(config)) {
    logger.warn(
      `${STRIPE_BILLING_ENABLED_ENV} is off or unset; binding a disabled ` +
        'Stripe client (fail-closed). The service boots, but any outbound ' +
        'billing call will throw StripeNotConfiguredError.',
    );
    return new UnconfiguredStripeClient();
  }

  const secretKey = config.get<string>(STRIPE_SECRET_KEY_ENV);
  if (!secretKey) {
    throw new Error(
      `${STRIPE_BILLING_ENABLED_ENV}=true but ${STRIPE_SECRET_KEY_ENV} is ` +
        'missing — refusing to boot billing with no outbound Stripe credential ' +
        '(fail-closed).',
    );
  }

  const isProd = config.get<string>('NODE_ENV') === 'production';
  if (!isProd && secretKey.startsWith('sk_live_')) {
    throw new Error(
      'Refusing to use a live Stripe key (sk_live_) outside production.',
    );
  }

  const stripe = new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion,
    typescript: true,
  });
  return new RealStripeClient(stripe);
}
