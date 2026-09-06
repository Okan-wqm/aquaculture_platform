/**
 * Typed interface describing the surface we consume from Stripe.
 *
 * # Why a custom interface instead of importing Stripe types
 *
 * `Stripe.Subscription`, `Stripe.Refund`, etc. types are 14k+ lines
 * and chase Stripe's release schedule. Pinning consumers to this
 * narrower interface gives us:
 *
 *   1. Compile-time contract independent of SDK upgrades — the factory
 *      that constructs a real Stripe client is the only place that
 *      sees Stripe.* types directly. ADR-016 § "Why a typed interface".
 *   2. Drop-in fakes for unit tests — no need to spin up `stripe-mock`
 *      for behaviour tests; just pass a stub object literal.
 *   3. Make-impossible enforcement: invariant
 *      `tests/invariants/stripe-calls-via-canonical-client.spec.ts`
 *      asserts no production code imports `stripe` outside
 *      `libs/backend-common/src/billing/`.
 *
 * # Methods listed
 *
 * Only the seven methods that production handlers actually call are
 * exposed. Adding a new method requires editing this file (the
 * compile-time gate) AND the StripeApiService wrapping (the audit +
 * breaker contract).
 */

export type StripeIdempotencyKey = string;

export interface StripeMetadata {
  readonly [key: string]: string;
}

export interface StripeMoney {
  readonly amount: bigint;
  readonly currency: string;
}

export interface StripeSubscription {
  readonly id: string;
  readonly customer: string;
  readonly status: 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused';
  readonly currentPeriodStartIso: string;
  readonly currentPeriodEndIso: string;
  readonly metadata: StripeMetadata;
}

export interface StripeRefund {
  readonly id: string;
  readonly chargeId: string;
  readonly amount: bigint;
  readonly currency: string;
  readonly status: 'pending' | 'succeeded' | 'failed' | 'canceled' | 'requires_action';
  readonly reason: string | null;
}

export interface StripeCustomer {
  readonly id: string;
  readonly email: string | null;
  readonly metadata: StripeMetadata;
}

export interface StripeInvoice {
  readonly id: string;
  readonly status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void' | null;
  readonly hostedInvoiceUrl: string | null;
}

export interface StripeMeterEvent {
  readonly identifier: string;
  readonly meterEventName: string;
  readonly customerId: string;
  readonly value: bigint;
}

/**
 * Canonical client interface — the StripeApiService consumes ONE
 * implementation of this. Production binds a factory that constructs
 * a real Stripe SDK instance; tests bind a stub literal.
 */
export interface IStripeApiClient {
  createCustomer(args: {
    email?: string;
    name?: string;
    metadata: StripeMetadata;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeCustomer>;

  createSubscription(args: {
    customerId: string;
    priceId: string;
    metadata: StripeMetadata;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeSubscription>;

  updateSubscription(args: {
    subscriptionId: string;
    priceId?: string;
    metadata?: StripeMetadata;
    /**
     * Set `false` to un-schedule a pending cancellation — the Stripe half of
     * reactivating a subscription. Without it, a subscription "reactivated"
     * locally still stops billing at period end (ADR-0014).
     */
    cancelAtPeriodEnd?: boolean;
    /**
     * Move the trial's end. The Stripe half of extending a trial: a local-only
     * extension leaves Stripe charging on the original date (ADR-0014).
     */
    trialEnd?: Date;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeSubscription>;

  cancelSubscription(args: {
    subscriptionId: string;
    immediately: boolean;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeSubscription>;

  retrieveSubscription(args: {
    subscriptionId: string;
  }): Promise<StripeSubscription>;

  createRefund(args: {
    chargeId: string;
    amount: bigint;
    reason: 'duplicate' | 'fraudulent' | 'requested_by_customer';
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeRefund>;

  retrieveRefund(args: {
    refundId: string;
  }): Promise<StripeRefund>;

  finalizeInvoice(args: {
    invoiceId: string;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeInvoice>;

  reportMeterEvent(args: StripeMeterEvent & {
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<void>;
}

/**
 * Token used to inject the IStripeApiClient. Production wiring binds a
 * StripeClientFactory that returns a real Stripe instance adapter (W1.1
 * commit); tests pass a stub literal directly.
 */
export const STRIPE_API_CLIENT = Symbol('STRIPE_API_CLIENT');

/**
 * Audit-row writer interface used by StripeApiService. Decoupled from
 * the canonical AuditLogService import path so this module compiles
 * without pulling in the full audit subtree (audit subtree carries
 * @Entity decorators and is intentionally deep-import-only).
 */
export interface IAuditRecorder {
  recordAwait(args: {
    action: string;
    tenantId: string;
    resource: string;
    resourceId?: string;
    severity: 'INFO' | 'WARN' | 'CRITICAL';
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export const STRIPE_AUDIT_RECORDER = Symbol('STRIPE_AUDIT_RECORDER');
