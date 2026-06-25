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
 * Thrown when a Stripe mutation is attempted but no STRIPE_SECRET_KEY is
 * configured. In production the factory fails CLOSED at boot instead (see
 * stripeClientFactory); this error only surfaces in non-prod/test when code
 * actually calls Stripe without a key — never a silent local-only success.
 */
export class StripeNotConfiguredError extends Error {
  constructor() {
    super(
      'Stripe is not configured (STRIPE_SECRET_KEY missing). Outbound billing ' +
        'calls are disabled in this environment.',
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
    metadata: (sub.metadata ?? {}) as StripeMetadata,
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
    metadata: (customer.metadata ?? {}) as StripeMetadata,
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
 * A client that throws on every mutating call — bound in non-production when no
 * STRIPE_SECRET_KEY is present, so unit tests that never touch Stripe boot
 * fine while any code path that DOES call Stripe fails loudly (never a silent
 * local-only success).
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
 * Production factory for the canonical Stripe client (bind to STRIPE_API_CLIENT).
 *
 * Fail-closed sourcing:
 *   - production + no key  → throw at boot (the service must not start claiming
 *     it can bill when it cannot).
 *   - any env + `sk_live_` key outside production → throw (never let a real
 *     live key run against a non-prod database).
 *   - non-prod + no key    → an UnconfiguredStripeClient that throws on use.
 *   - key present          → the real Stripe adapter.
 */
export function stripeClientFactory(config: ConfigService): IStripeApiClient {
  const logger = new Logger('StripeClientFactory');
  const isProd = config.get<string>('NODE_ENV') === 'production';
  const secretKey = config.get<string>('STRIPE_SECRET_KEY');

  if (!secretKey) {
    if (isProd) {
      throw new Error(
        'STRIPE_SECRET_KEY is required in production — refusing to boot ' +
          'billing without an outbound Stripe credential (fail-closed).',
      );
    }
    logger.warn(
      'STRIPE_SECRET_KEY not set; binding an unconfigured Stripe client. ' +
        'Outbound billing calls will throw StripeNotConfiguredError.',
    );
    return new UnconfiguredStripeClient();
  }

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
