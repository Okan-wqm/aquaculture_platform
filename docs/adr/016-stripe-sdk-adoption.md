# ADR-016: Stripe SDK Adoption + Outbound Billing API Pattern

**Status:** Accepted
**Date:** 2026-04-28
**Closes:** docs/reviews/billing-expert/2026-04-28-core-platform-review.md#BILLING-CRITICAL-001 (foundation)
**Plan:** harmonic-sleeping-cascade — W0.H

## Context

The 2026-04-28 core-platform audit captured BILLING-CRITICAL-001:
**no `stripe` SDK in the workspace; no outbound Stripe API integration**.
The platform receives Stripe webhooks (inbound) but has zero outbound
calls — refund handlers mutate internal state without ever calling
Stripe; the subscription saga has no PIVOT step; metered usage never
reaches Stripe MeterEvent. The system cannot bill customers.

## Decision

1. Adopt the official `stripe` npm SDK as the single canonical client.
   Pin the API version (`2024-12-18` at adoption time) and the SDK
   release that matches it. Pinning prevents wire-level drift between
   our integration tests and Stripe's behaviour as they evolve.

2. All outbound Stripe traffic flows through ONE injectable service:
   `StripeApiService` at `libs/backend-common/src/billing/stripe-api.service.ts`.
   Direct usage of the SDK (`new Stripe(...)`, `stripe.subscriptions.create(...)`)
   anywhere else in the codebase is forbidden — enforced by the
   invariant test `tests/invariants/stripe-calls-via-canonical-client.spec.ts`.

3. `StripeApiService` wraps every method with the canonical
   `CircuitBreakerService` (W0.B) keyed per-tenant. `failureMode` is
   `'fail-closed'` for billable operations (a financial DB outage MUST
   NOT silently succeed); read-only metadata fetches use
   `'fail-open-degraded'` with explicit fallback.

4. Every call records a transactional audit row via the canonical
   `AuditLogService.recordAwait()` BEFORE the Stripe call fires. If the
   audit insert fails, the Stripe call does NOT happen — preserving the
   "every billable action has an audit row" invariant SOC 2 CC4 + GDPR
   Art 30 require.

5. The subscription saga gains a PIVOT step. Each saga state has an
   explicit cancel-and-revert action when downstream Stripe operations
   fail mid-flow, so the system never strands money in a partial state.

6. Idempotency keys MUST be passed on every mutating call. The key is
   `${tenantId}:${aggregateId}:${eventId}` so retries from the outbox
   pattern (W1.4) deduplicate at the Stripe side.

## Two-phase rollout

**Phase 1 (W0.H — this commit, foundation only):**
- ADR (this document)
- `libs/backend-common/src/billing/stripe-api.types.ts` — typed interface
  describing the surface we consume from Stripe, independent of SDK
  internals. Lets us compile against the contract today and bind to
  the real SDK in Phase 2 without re-shaping consumers.
- `StripeApiService` shell: implements the typed interface using a
  caller-injected `IStripeApiClient`. Wraps every method with breaker
  + audit; per-tenant key; idempotency-key support.
- `StripeApiModule.forRoot()` Nest module.
- Unit tests with stub client (~13 tests).
- Invariant: every reference to `stripe.subscriptions`, `stripe.refunds`,
  etc. outside the canonical service is a CI fail.

**Phase 2 (W1.1, separate commit on the same PR):**
- Add `stripe@^17.x` (matching `apiVersion: '2024-12-18'`) to root
  package.json.
- Implement `StripeClientFactory` that constructs a real `Stripe`
  instance from `process.env.STRIPE_SECRET_KEY` and exposes the
  IStripeApiClient interface.
- `StripeApiModule.forRoot()` binds the factory in production; tests
  bind a mocked client (existing pattern).
- Migrate billing-service handlers from internal-state mutation to
  `StripeApiService` calls + outbox emit.
- Subscription saga PIVOT step.

Splitting prevents the SDK install + integration migration from
landing in one mega-commit; reviewers can sanity-check the contract
shape before the wire actually changes.

## Why a typed interface instead of `Stripe` direct types

The `Stripe` namespace types are 14k+ lines. Importing them into our
service interface ties our consumers to the SDK release schedule —
whenever Stripe re-shapes its types we'd have to chase. Defining
`IStripeApiClient` with the exact 7 methods we use (createSubscription,
updateSubscription, cancelSubscription, createRefund, listSubscriptions,
listRefunds, reportMeterEvent) gives consumers a stable contract and
keeps SDK upgrades to the factory boundary.

## Consequences

- `BILLING-CRITICAL-001` foundation closed. Cascade items —
  BILLING-HIGH-005 (outbox replacing direct eventBus.publish),
  BILLING-CRITICAL-003 (METER_RACE → MeterEvent), BILLING-HIGH-001
  (webhook persistent dedup), BILLING-HIGH-004 (signature failure
  alerts) — gain a wired client to call, so each closure is now
  unblocked.

- Tests run against the stub client by default. Integration tests use
  `stripe-mock` (Stripe's official server emulator) when full HTTP
  round-trips are needed.

- Service-side latency adds the breaker overhead (~negligible) plus
  one audit write (typically sub-ms). The breaker's per-tenant key
  prevents one tenant's Stripe trouble from tripping the global
  client for everyone (TENANTCOST-HIGH-001 noisy-neighbor class).

## Alternatives considered

- **Hand-rolled HTTP client.** Rejected — Stripe's SDK encodes the
  signature, retry-on-idempotency, and version-pinning conventions in
  ways a hand-rolled client would forever chase. The 14k-line types
  burden is real but containable behind our `IStripeApiClient`
  interface.

- **Fan-out at the controller boundary** (each handler instantiates
  Stripe). Rejected — multiplies the audit + breaker plumbing, makes
  testing harder, and the invariant test becomes a per-handler chase.
  One canonical service is cheaper architecturally.

## References

- Audit report: `docs/reviews/billing-expert/2026-04-28-core-platform-review.md`
- Plan: `/root/.claude/plans/harmonic-sleeping-cascade.md` § W0.H
- Stripe API versioning: <https://stripe.com/docs/api/versioning>
- Stripe SDK releases: <https://github.com/stripe/stripe-node/releases>
