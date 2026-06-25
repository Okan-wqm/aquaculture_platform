/**
 * @aquaculture/backend-common/billing
 *
 * Outbound billing-API surface — currently exposes the canonical
 * StripeApiService. All billing handlers MUST consume this service for
 * outbound Stripe traffic; direct usage of the `stripe` SDK anywhere
 * else in the codebase is forbidden by the
 * `tests/invariants/stripe-calls-via-canonical-client.spec.ts` invariant.
 *
 * Closes: docs/reviews/billing-expert/2026-04-28-core-platform-review.md#BILLING-CRITICAL-001 (foundation)
 */

export { StripeApiService } from './stripe-api.service';
export {
  StripeApiModule,
  STRIPE_API_CLIENT,
  STRIPE_AUDIT_RECORDER,
} from './stripe-api.module';
// W1.1 (ADR-016): the production Stripe client factory — the one adapter that
// constructs a real Stripe SDK instance. billing-service binds it to
// STRIPE_API_CLIENT via StripeApiModule.forRoot.
export {
  stripeClientFactory,
  StripeNotConfiguredError,
} from './stripe-client.factory';
export type {
  IStripeApiClient,
  IAuditRecorder,
  StripeIdempotencyKey,
  StripeMetadata,
  StripeMoney,
  StripeSubscription,
  StripeRefund,
  StripeMeterEvent,
} from './stripe-api.types';
