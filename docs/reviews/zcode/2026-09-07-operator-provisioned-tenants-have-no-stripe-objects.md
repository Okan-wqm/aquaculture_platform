# A subscription Stripe had never heard of — 2026-09-07

Reviewer: zcode. Cycle: `2026-09-05-branch-sweep`. Target: `origin/main` @ `fdc4afff4`.

Headline surfaced by `claude/superadmin-panel-audit-dm2t1v` (`e27b0fa1c`), verified against current
main, and re-derived here. The branch is not merged.

## BILLING-CRITICAL-010 — nothing charged an operator-provisioned tenant

**Severity:** CRITICAL. **Owner:** billing-expert. **State:** IN-PROGRESS.

### Evidence

Two paths create a subscription, and only one of them told Stripe.

`apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts:669` raw-INSERTs into
`billing.subscriptions`. Its column list names eighteen columns and omits exactly two:

```sql
INSERT INTO billing.subscriptions (
  tenant_id, plan_id, plan_tier, plan_name, status, billing_cycle,
  limits, pricing, start_date, current_period_start, current_period_end,
  trial_end_date, auto_renew, created_by, updated_by, version, is_deleted,
  "createdAt", "updatedAt"
) VALUES (...)
```

No `stripe_customer_id`, no `stripe_subscription_id`. They land NULL, and nothing ever fills them:

- The three `UPDATE billing.subscriptions` statements in the same handler (lines 373, 418, 457)
  touch status, cancellation and trial fields only.
- The sole writer of those two columns anywhere in billing-service is
  `create-subscription.handler.ts:85-102` — the GraphQL path, which the operator flow does not use.

So every tenant an operator provisioned had a subscription this platform believed in and Stripe had
never heard of. Nothing charged them, and the divergence was invisible short of reconciling by hand.

**It also bounds the fix that shipped this morning.** Two of the five inbound webhook handlers
repaired under BILLING-CRITICAL-006 resolve the tenant from `Subscription.stripeSubscriptionId` —
`invoice.payment_failed` and `customer.subscription.deleted`. For these tenants that column is
NULL, so those two stay inert. That is not a regression and not a flaw in that resolution: Stripe
cannot emit an invoice or subscription event for a subscription it never had. It is this defect
capping the population the other fix can reach.

### Rule violated

Two paths that create the same aggregate mint its external identifiers through one writer, or one
of them will forget.

### Fix

The obvious repair — copy the mint into the second handler — is the defect class this repo paid for
in BILLING-CRITICAL-007 eight hours ago, where a price rule written twice in two services disagreed
and nobody noticed for as long as both numbers stayed plausible. So the mint moved to
`StripeSubscriptionProvisionerService` and both paths call it.

Its `ensureStripeObjects` returns both ids undefined when the plan is not billable through Stripe —
a FREE tier (a permanent $0 plan; a recurring Stripe object for a charge that must never happen
would be worse than none), or a plan with no configured price for the cycle being sold (a WARN, not
an error: a catalogue can legitimately predate its Stripe wiring, and the subscription is still
recorded, just not charged).

**Ordering.** The mint runs BEFORE the provisioning transaction opens, for two reasons pointing the
same way: a pool connection is never held across a network call (SSOT-C-12), and a SERIALIZABLE
transaction that waits on Stripe holds a serialization slot for the length of an HTTP round trip.
That required moving the plan resolution out too, which is safe — the catalogue read is guarded by
`catalogVersionId`, and the GraphQL path already reads its plan outside its own transaction.

**Why the ordering is safe against the handler's short-circuits.** The keys derive from the tenant
and the plan (`cust-create:<tenant>`, `sub-create:<tenant>:<tier>:<cycle>`), never from a command
id, so a receipt replay re-resolves the same Stripe objects rather than minting a second pair. And
`assertActiveSubscriptionReplayMatches` throws `ConflictException` when an already-active
subscription's plan does not match the command, so a command that would mint a subscription for a
plan the tenant does not end up on is rejected rather than silently returning — no orphan.

- **Tier 2 (automatic).** One `ensureStripeObjects`. Both paths get the same idempotency keys and
  the same no-price rule because there is only one copy of them.
- **Tier 3 (detectable).** `tests/invariants/stripe-subscription-mint-single-source.spec.ts` fails
  on a `createCustomer` / `createSubscription` call anywhere in billing-service outside that file,
  and — because the original defect was a column list, not a wrong value — on any raw
  `INSERT INTO billing.subscriptions` that does not name both Stripe columns.

### Behaviour change, stated

A Stripe failure now fails the provisioning command instead of quietly producing a tenant nothing
can charge. That is the fail-closed rule every billable mutation already follows (`StripeApiService`
documents `failureMode = 'fail-closed'` for exactly this), the circuit breaker still governs the
degradation, and the command is retryable — its receipt is keyed on the payload hash. An operator
provisioning while Stripe is down now gets an error and can retry; before, they got a tenant that
could never be billed and no signal that anything was wrong.

### Verification

- `billing-admin-nats.handler.spec.ts` — six new cases: the ids land on the row, the idempotency
  keys derive from tenant and plan, Stripe is called **before** the transaction opens (asserted by
  position in the same ordered log the RLS-bypass cases already use), FREE mints nothing, a plan
  with no price records a local-only subscription, and a Stripe failure fails the command with no
  subscription row written.
- **Mutation-verified in both directions.** Against the previous handler all six fail; the
  invariant reports two mint sites and both missing columns. Against the fix all pass.
- `create-subscription.handler.spec.ts` (36 cases) now injects the **real** provisioner over a
  mocked Stripe client, so it still asserts what actually reaches Stripe rather than a stub of the
  mint. `apps/billing-service` full suite green.

## What this does not do

It does not backfill. Tenants provisioned before this change still carry NULL Stripe ids and are
still uncharged; giving them Stripe objects means minting a customer and a subscription per tenant
against the live Stripe account and deciding what happens to the un-billed period — a commercial
decision with a finance owner, not a code change. The population is derivable:
`billing.subscriptions` where `stripe_subscription_id IS NULL AND is_deleted = false` and the plan
tier is not FREE.
