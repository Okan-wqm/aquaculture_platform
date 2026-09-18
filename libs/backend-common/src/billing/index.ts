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
export { StripeApiModule, STRIPE_API_CLIENT, STRIPE_AUDIT_RECORDER } from './stripe-api.module';
// W1.1 (ADR-016): the production Stripe client factory — the one adapter that
// constructs a real Stripe SDK instance. billing-service binds it to
// STRIPE_API_CLIENT via StripeApiModule.forRoot.
export {
  stripeClientFactory,
  stripeSettingsFromEnv,
  buildStripeClient,
  buildClientFromDecision,
  classifyStripeSettings,
  UnconfiguredStripeClient,
  StripeNotConfiguredError,
  STRIPE_BILLING_ENABLED_ENV,
  STRIPE_SECRET_KEY_ENV,
  BILLING_PROVIDER_ENV,
  type BillingProvider,
  type StripeClientSettings,
  type StripeClientDecision,
} from './stripe-client.factory';
// Faz C: runtime-config Stripe client — swaps the underlying client behind the
// STRIPE_API_CLIENT token from config-service without a redeploy or boot crash.
export { DynamicStripeClient, DynamicStripeClientProvider } from './dynamic-stripe-client.provider';
export { MockBillingProvider } from './mock-billing.provider';
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
export * from './canary-tenant.registry';
// SECREV-CRITICAL-001 cure: the one wire key both the Stripe producer and the
// inbound webhook consumers import, plus the hint reader that keeps the value
// out of authoritative tenant resolution.
export { STRIPE_TENANT_METADATA_KEY, readStripeTenantHint } from './stripe-metadata';
// BILLING-CRITICAL-007 cure: the commercial terms of a billing cycle, shared by
// the service that quotes a price and the service that invoices it.
// `BILLING_CYCLES` / `BillingCycle` are deliberately NOT re-exported here — they
// belong to `@platform/event-contracts`, and a second import path for the same
// symbol is how the set came to be declared twice (BILLING-HIGH-008).
export {
  BILLING_CYCLE_MONTHS,
  BILLING_CYCLE_COMMITMENT_DISCOUNT,
  addBillingCycle,
  commitmentDiscountRateFor,
  cycleAmountFor,
  isBillingCycle,
} from './billing-cycle-terms';
export type { CycleAmount } from './billing-cycle-terms';
