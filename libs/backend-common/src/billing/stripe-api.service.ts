import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  CircuitBreakerService,
  CircuitOpenError,
  DEFAULT_BREAKER_OPTIONS,
  type CircuitBreakerOptions,
} from '../resilience/circuit-breaker';

import {
  IAuditRecorder,
  IStripeApiClient,
  STRIPE_API_CLIENT,
  STRIPE_AUDIT_RECORDER,
  StripeCustomer,
  StripeIdempotencyKey,
  StripeInvoice,
  StripeMetadata,
  StripeMeterEvent,
  StripeRefund,
  StripeSubscription,
} from './stripe-api.types';

/**
 * Canonical Stripe API surface. Single client every billing handler
 * MUST use for outbound Stripe traffic — direct usage of the SDK
 * (`new Stripe(...)`, `stripe.subscriptions.create(...)`) anywhere
 * else in the codebase is forbidden by the
 * `tests/invariants/stripe-calls-via-canonical-client.spec.ts`
 * invariant.
 *
 * # Architectural contract
 *
 *   1. Per-tenant CircuitBreaker keying — a noisy tenant's Stripe
 *      trouble cannot trip the breaker for everyone.
 *   2. failureMode = 'fail-closed' for every billable mutation. A
 *      DB / network blip on a refund must surface as a hard error
 *      to the caller; silently degrading would issue refunds Stripe
 *      never received (or vice versa).
 *   3. Audit row recorded BEFORE the Stripe call. recordAwait()
 *      throws on insert failure; if audit cannot be persisted the
 *      Stripe call does not fire — preserving the SOC 2 CC4 + GDPR
 *      Art 30 invariant that every regulated mutation has an audit row.
 *   4. Idempotency key is REQUIRED on every mutating call. Outbox-
 *      delivered retries (W1.4) reuse the key so Stripe deduplicates
 *      at its side.
 *
 * # Why this lives in libs/backend-common (not apps/billing-service)
 *
 * Two services consume Stripe outbound traffic: billing-service (every
 * subscription mutation) and notification-service (post-payment-failure
 * follow-up via Stripe customer email). Promoting the wrapper to
 * backend-common avoids both services re-deriving the breaker / audit
 * contract.
 *
 * Closes: docs/reviews/billing-expert/2026-04-28-core-platform-review.md#BILLING-CRITICAL-001 (foundation; W1 cascade migrates handlers)
 */

const STRIPE_BREAKER_OPTIONS: CircuitBreakerOptions = {
  ...DEFAULT_BREAKER_OPTIONS,
  // Stripe's documented availability is ~99.99% — moderate failure
  // tolerance is appropriate. Tighter than DEFAULT_BREAKER_OPTIONS on
  // failureRatePct because false positives here cost real money.
  failureThreshold: 5,
  failureRatePct: 30,
  openTimeoutMs: 60_000, // 1 minute — Stripe outages are typically short
  // Billable boundary REQUIRES fail-closed. Each public method below
  // passes this constant; never reduced to fail-open-degraded for
  // mutating calls.
  failureMode: 'fail-closed',
};

const STRIPE_BREAKER_OPTIONS_READ: CircuitBreakerOptions = {
  ...STRIPE_BREAKER_OPTIONS,
  // Read-only operations (retrieve, list) may degrade gracefully —
  // showing stale local cache is preferable to blocking the user's
  // dashboard. Mutating operations stay fail-closed.
  failureMode: 'fail-open-degraded',
};

@Injectable()
export class StripeApiService {
  private readonly logger = new Logger(StripeApiService.name);

  constructor(
    @Inject(STRIPE_API_CLIENT) private readonly client: IStripeApiClient,
    @Inject(STRIPE_AUDIT_RECORDER) private readonly audit: IAuditRecorder,
    private readonly breaker: CircuitBreakerService,
  ) {}

  async createCustomer(args: {
    tenantId: string;
    email?: string;
    name?: string;
    metadata?: StripeMetadata;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeCustomer> {
    return this.executeMutation({
      tenantId: args.tenantId,
      action: 'stripe.customer.create',
      resourceId: args.tenantId,
      metadata: { email: args.email ?? null },
      fn: () =>
        this.client.createCustomer({
          email: args.email,
          name: args.name,
          // Bind the internal tenant id so an inbound webhook can be associated
          // back (re-resolved authoritatively per SECREV-CRITICAL-001, never
          // trusted blindly).
          metadata: { ...args.metadata, internalTenantId: args.tenantId },
          idempotencyKey: args.idempotencyKey,
        }),
    });
  }

  async createSubscription(args: {
    tenantId: string;
    customerId: string;
    priceId: string;
    metadata?: StripeMetadata;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeSubscription> {
    return this.executeMutation({
      tenantId: args.tenantId,
      action: 'stripe.subscription.create',
      resourceId: args.customerId,
      metadata: { customerId: args.customerId, priceId: args.priceId },
      fn: () =>
        this.client.createSubscription({
          customerId: args.customerId,
          priceId: args.priceId,
          // tenantId is bound into Stripe metadata so any later inbound
          // webhook can be associated back, but is NOT trusted as the
          // authoritative tenant source — webhook handlers re-resolve
          // via the customer-lookup table per SECREV-CRITICAL-001 cure.
          metadata: { ...args.metadata, internalTenantId: args.tenantId },
          idempotencyKey: args.idempotencyKey,
        }),
    });
  }

  async updateSubscription(args: {
    tenantId: string;
    subscriptionId: string;
    priceId?: string;
    metadata?: StripeMetadata;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeSubscription> {
    return this.executeMutation({
      tenantId: args.tenantId,
      action: 'stripe.subscription.update',
      resourceId: args.subscriptionId,
      metadata: { subscriptionId: args.subscriptionId, priceId: args.priceId ?? null },
      fn: () =>
        this.client.updateSubscription({
          subscriptionId: args.subscriptionId,
          priceId: args.priceId,
          metadata: args.metadata,
          idempotencyKey: args.idempotencyKey,
        }),
    });
  }

  async cancelSubscription(args: {
    tenantId: string;
    subscriptionId: string;
    immediately: boolean;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeSubscription> {
    return this.executeMutation({
      tenantId: args.tenantId,
      action: 'stripe.subscription.cancel',
      resourceId: args.subscriptionId,
      metadata: { subscriptionId: args.subscriptionId, immediately: args.immediately },
      fn: () =>
        this.client.cancelSubscription({
          subscriptionId: args.subscriptionId,
          immediately: args.immediately,
          idempotencyKey: args.idempotencyKey,
        }),
    });
  }

  async retrieveSubscription(args: {
    tenantId: string;
    subscriptionId: string;
  }): Promise<StripeSubscription | null> {
    // Read path — fail-open-degraded with caller-side cache fallback.
    return this.breaker.execute({
      serviceName: 'stripe-api',
      tenantId: args.tenantId,
      fn: () => this.client.retrieveSubscription({ subscriptionId: args.subscriptionId }),
      options: STRIPE_BREAKER_OPTIONS_READ,
      // No fallback supplied → if breaker is OPEN the call rejects with
      // an error that the caller interprets as "use local cache". The
      // ergonomics live with the caller; we expose the breaker outcome.
      fallback: () => null,
    });
  }

  async createRefund(args: {
    tenantId: string;
    chargeId: string;
    amount: bigint;
    reason: 'duplicate' | 'fraudulent' | 'requested_by_customer';
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeRefund> {
    return this.executeMutation({
      tenantId: args.tenantId,
      action: 'stripe.refund.create',
      resourceId: args.chargeId,
      metadata: { chargeId: args.chargeId, amount: args.amount.toString(), reason: args.reason },
      fn: () =>
        this.client.createRefund({
          chargeId: args.chargeId,
          amount: args.amount,
          reason: args.reason,
          idempotencyKey: args.idempotencyKey,
        }),
    });
  }

  async retrieveRefund(args: { tenantId: string; refundId: string }): Promise<StripeRefund | null> {
    return this.breaker.execute({
      serviceName: 'stripe-api',
      tenantId: args.tenantId,
      fn: () => this.client.retrieveRefund({ refundId: args.refundId }),
      options: STRIPE_BREAKER_OPTIONS_READ,
      fallback: () => null,
    });
  }

  async finalizeInvoice(args: {
    tenantId: string;
    invoiceId: string;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeInvoice> {
    return this.executeMutation({
      tenantId: args.tenantId,
      action: 'stripe.invoice.finalize',
      resourceId: args.invoiceId,
      metadata: { invoiceId: args.invoiceId },
      fn: () =>
        this.client.finalizeInvoice({
          invoiceId: args.invoiceId,
          idempotencyKey: args.idempotencyKey,
        }),
    });
  }

  async reportMeterEvent(
    args: StripeMeterEvent & {
      tenantId: string;
      idempotencyKey: StripeIdempotencyKey;
    },
  ): Promise<void> {
    return this.executeMutation({
      tenantId: args.tenantId,
      action: 'stripe.meter.report',
      resourceId: args.identifier,
      metadata: {
        meterEventName: args.meterEventName,
        customerId: args.customerId,
        value: args.value.toString(),
      },
      fn: async () => {
        await this.client.reportMeterEvent({
          identifier: args.identifier,
          meterEventName: args.meterEventName,
          customerId: args.customerId,
          value: args.value,
          idempotencyKey: args.idempotencyKey,
        });
      },
    });
  }

  /**
   * Common path for mutating calls: audit row first, then breaker-wrapped
   * Stripe call. recordAwait() throws on failure so the Stripe call
   * cannot fire without a successful audit.
   */
  private async executeMutation<T>(args: {
    tenantId: string;
    action: string;
    resourceId: string;
    metadata: Record<string, unknown>;
    fn: () => Promise<T>;
  }): Promise<T> {
    await this.audit.recordAwait({
      action: args.action,
      tenantId: args.tenantId,
      resource: 'stripe-api',
      resourceId: args.resourceId,
      severity: 'INFO',
      metadata: args.metadata,
    });

    try {
      return await this.breaker.execute({
        serviceName: 'stripe-api',
        tenantId: args.tenantId,
        fn: args.fn,
        options: STRIPE_BREAKER_OPTIONS,
      });
    } catch (e) {
      // Re-record at WARN severity if the breaker tripped or Stripe
      // rejected the call. The original audit row stays as the
      // request record; this row records the outcome.
      await this.audit
        .recordAwait({
          action: `${args.action}.outcome.failure`,
          tenantId: args.tenantId,
          resource: 'stripe-api',
          resourceId: args.resourceId,
          severity: e instanceof CircuitOpenError ? 'CRITICAL' : 'WARN',
          metadata: {
            ...args.metadata,
            errorName: (e as Error).name,
            errorMessage: (e as Error).message,
          },
        })
        .catch((auditErr) => {
          // Failure to write the OUTCOME audit row does NOT mask the
          // original error — log and re-throw the original for the caller.
          this.logger.error(
            `Failed to record Stripe failure audit row: ${(auditErr as Error).message}`,
          );
        });
      throw e;
    }
  }
}
