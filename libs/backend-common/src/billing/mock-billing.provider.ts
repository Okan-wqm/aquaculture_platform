import { Logger } from '@nestjs/common';

import {
  IStripeApiClient,
  StripeCustomer,
  StripeIdempotencyKey,
  StripeInvoice,
  StripeMeterEvent,
  StripeMetadata,
  StripeRefund,
  StripeSubscription,
} from './stripe-api.types';

/** Mock billing period length for synthetic local subscriptions (30 days). */
const MOCK_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * MockBillingProvider — the IStripeApiClient bound when BILLING_PROVIDER=mock
 * (see BILLING_PROVIDER_ENV in stripe-client.factory.ts).
 *
 * WHY: app.suderra.com tenants are test/demo and must run with NO outbound
 * Stripe (operator decision). billing-service stays a real, REQUIRED federation
 * subgraph (the tenant-provisioning saga depends on it synchronously, and the
 * gateway composes its schema) — it just must BOOT and serve the
 * subscription/invoice contract from LOCAL records.
 *
 * WHAT: every method RESOLVES with a benign result carrying EMPTY stripe_* ids.
 * An empty id is the unambiguous "no Stripe object" marker; a synthetic
 * `cus_*`/`sub_*` id is deliberately NOT used because storing it in the
 * subscription's stripe_* columns would make a future BILLING_PROVIDER=stripe
 * flip call REAL Stripe with a bogus identifier (4xx / data corruption).
 *
 * Contrast with UnconfiguredStripeClient (the STRIPE_BILLING_ENABLED-off path in
 * stripe-client.factory.ts), which THROWS on every call: that is the correct
 * "billing disabled" posture, but a provider that throws cannot back a WORKING
 * billing subgraph for a demo tenant — hence this functional mock. SECURITY:
 * this file imports NO `stripe` SDK and performs ZERO network I/O — enforced by
 * tests/invariants/stripe-calls-via-canonical-client.spec.ts (ALLOWED dir) plus
 * a source-level assertion in the provider's own spec.
 */
export class MockBillingProvider implements IStripeApiClient {
  private readonly logger = new Logger(MockBillingProvider.name);

  private noop(method: string): void {
    this.logger.debug(
      `mock billing provider: ${method} — local no-op (no outbound Stripe)`,
    );
  }

  private period(): { currentPeriodStartIso: string; currentPeriodEndIso: string } {
    const now = Date.now();
    return {
      currentPeriodStartIso: new Date(now).toISOString(),
      currentPeriodEndIso: new Date(now + MOCK_PERIOD_MS).toISOString(),
    };
  }

  async createCustomer(args: {
    email?: string;
    name?: string;
    metadata: StripeMetadata;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeCustomer> {
    this.noop('createCustomer');
    return { id: '', email: args.email ?? null, metadata: args.metadata };
  }

  async createSubscription(args: {
    customerId: string;
    priceId: string;
    metadata: StripeMetadata;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeSubscription> {
    this.noop('createSubscription');
    return { id: '', customer: '', status: 'active', ...this.period(), metadata: args.metadata };
  }

  async updateSubscription(args: {
    subscriptionId: string;
    priceId?: string;
    metadata?: StripeMetadata;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeSubscription> {
    this.noop('updateSubscription');
    return {
      id: args.subscriptionId,
      customer: '',
      status: 'active',
      ...this.period(),
      metadata: args.metadata ?? {},
    };
  }

  async cancelSubscription(args: {
    subscriptionId: string;
    immediately: boolean;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeSubscription> {
    this.noop('cancelSubscription');
    return {
      id: args.subscriptionId,
      customer: '',
      status: 'canceled',
      ...this.period(),
      metadata: {},
    };
  }

  async retrieveSubscription(args: { subscriptionId: string }): Promise<StripeSubscription> {
    this.noop('retrieveSubscription');
    return {
      id: args.subscriptionId,
      customer: '',
      status: 'active',
      ...this.period(),
      metadata: {},
    };
  }

  async createRefund(args: {
    chargeId: string;
    amount: bigint;
    reason: 'duplicate' | 'fraudulent' | 'requested_by_customer';
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeRefund> {
    this.noop('createRefund');
    return {
      id: '',
      chargeId: args.chargeId,
      amount: args.amount,
      currency: '',
      status: 'succeeded',
      reason: args.reason,
    };
  }

  async retrieveRefund(args: { refundId: string }): Promise<StripeRefund> {
    this.noop('retrieveRefund');
    return {
      id: args.refundId,
      chargeId: '',
      amount: 0n,
      currency: '',
      status: 'succeeded',
      reason: null,
    };
  }

  async finalizeInvoice(_args: {
    invoiceId: string;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeInvoice> {
    this.noop('finalizeInvoice');
    return { id: '', status: 'open', hostedInvoiceUrl: null };
  }

  async reportMeterEvent(
    _args: StripeMeterEvent & { idempotencyKey: StripeIdempotencyKey },
  ): Promise<void> {
    this.noop('reportMeterEvent');
  }
}
