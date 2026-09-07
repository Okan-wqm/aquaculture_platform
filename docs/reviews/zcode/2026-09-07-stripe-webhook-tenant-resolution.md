# Two spellings of one wire key, and the money stopped — 2026-09-07

Reviewer: zcode. Cycle: `2026-09-05-branch-sweep`. Target: `origin/main` @ `a618cb4ee`.

Headline surfaced by `claude/superadmin-panel-audit-dm2t1v`, verified against current main, and
re-derived here. The branch is not merged.

## BILLING-CRITICAL-006 — every Stripe webhook was discarded before it wrote anything

**Severity:** CRITICAL. **Owner:** billing-expert. **State:** IN-PROGRESS.

### Evidence

`libs/backend-common/src/billing/stripe-api.service.ts:108,134` binds the internal tenant id into
the metadata of every Stripe object the platform creates:

```ts
metadata: { ...args.metadata, internalTenantId: args.tenantId },
```

All five inbound handlers in
`apps/billing-service/src/billing/controllers/stripe-webhook.service.ts` read a different key:

| Line | Handler                         | Read                                    |
| ---- | ------------------------------- | --------------------------------------- |
| 62   | `payment_intent.succeeded`      | `paymentIntent.metadata?.tenantId`      |
| 207  | `payment_intent.payment_failed` | `paymentIntent.metadata?.tenantId`      |
| 318  | `invoice.payment_failed`        | `stripeInvoice.metadata?.tenantId`      |
| 385  | `customer.subscription.deleted` | `stripeSubscription.metadata?.tenantId` |
| 470  | `charge.refunded`               | `charge.metadata?.tenantId`             |

`internalTenantId` is never read. `tenantId` is never written. Each handler warns and returns, so
in production: no payment is ever recorded, no invoice reaches PAID, no subscription moves to
PAST_DUE on a failed charge or to CANCELLED on a Stripe-side cancellation, and no refund reaches a
payment row. The two payment-intent handlers additionally required `metadata.invoiceId`, which
nothing in the codebase writes at all — so those two could not have worked even after a rename.

Nothing caught it because each side is internally consistent: the producer's own spec asserts it
writes `internalTenantId`, and the only webhook test file
(`__tests__/stripe-webhook.controller.spec.ts`) mocks `StripeWebhookService` wholesale and asserts
the controller dispatches to it. No service-level spec existed. The pair was never tested, and the
compiler cannot see a relationship between two string literals in different files.

The producer's own comment states the intended design — "webhook handlers re-resolve via the
customer-lookup table per SECREV-CRITICAL-001 cure" — and `apps/billing-service/src/app.module.ts`
recorded SECREV-CRITICAL-001 as closed by the header-stripping middleware. The middleware closed
the forge-on-public-route half. The payload half stayed open, documented as fixed.

### Rule violated

A tenant is resolved from the local row that owns the third-party object, never from a field the
third party's account holders can write.

### Fix

Renaming the read would have cured the symptom and kept the flaw. Stripe metadata is writable by
anyone who can reach the Stripe account — dashboard operators, any API key, any integration sharing
the account — so a tenant id read out of it is an association hint, never proof of ownership.

Each handler now resolves the tenant from the **local row that owns the Stripe object**:

| Event                           | Resolution key                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `payment_intent.*`              | `Payment.stripePaymentIntentId`, else `Invoice.stripeInvoiceId` via `paymentIntent.invoice` |
| `invoice.payment_failed`        | `Subscription.stripeSubscriptionId`                                                         |
| `customer.subscription.deleted` | `Subscription.stripeSubscriptionId`                                                         |
| `charge.refunded`               | `Payment.stripeChargeId`, else `Payment.stripePaymentIntentId` via `charge.payment_intent`  |

`readStripeTenantHint` then cross-checks the payload's claim against the resolved owner and logs a
disagreement at ERROR without letting it change the outcome — an edited Stripe object or genuine
ledger corruption is operator-actionable, and neither gets to redirect a write.

Three tiers carry it:

- **Tier 1 (impossible).** The resolution is a single-row `findOne` on a Stripe identifier column,
  so it is only sound while that column is single-valued: a duplicate would let `findOne` pick an
  arbitrary tenant's row. `payments.stripe_payment_intent_id` already carried a partial unique
  index. `payments.stripe_charge_id`, `subscriptions.stripe_subscription_id` and
  `invoices.stripe_invoice_id` carried **no index at all** — neither a uniqueness guarantee nor a
  lookup path, so each resolution would also have been a sequential scan. Migration
  `1802300000000-StripeObjectOwnershipUniqueIndexes` adds the three partial unique indexes the
  resolution rests on.
- **Tier 2 (automatic).** `STRIPE_TENANT_METADATA_KEY` in
  `libs/backend-common/src/billing/stripe-metadata.ts` is the one spelling of the wire key, imported
  by the producer. The specific drift that caused this cannot recur.
- **Tier 3 (detectable).** `tests/invariants/stripe-webhook-tenant-resolution.spec.ts` fails on any
  tenant id read out of a payload's metadata inside `apps/billing-service/src`, and on any bare
  `'internalTenantId'` literal outside its declaration.

### Verification

`apps/billing-service/src/billing/controllers/__tests__/stripe-webhook.service.spec.ts` — 13 cases,
every one driving a handler with a payload that carries no `metadata.tenantId`. Mutation-verified
in both directions: reverted to main's handler, **10 of the 13 fail** (the 3 that pass are the
negative cases, which assert nothing is written and are correct either way). The invariant reports
**5 offending reads** against main's handler and passes against the fix.

`payment_intent.payment_failed` gained a behaviour the old code could not reach: with the partial
unique index in place, a row already carrying the intent id (typically left PENDING by
`record-payment`) is transitioned rather than inserted alongside — the second insert would have
violated the index. Pinned by the case "transitions the existing row instead of inserting a second
row with the same intent id".

### What this does not do

It does not backfill. Any Stripe event delivered while the handlers were returning early is gone
from the ledger and Stripe's webhook retention has long since expired for the older ones; recovering
that state means a reconciliation pass over Stripe's API (list charges/invoices/subscriptions per
customer and replay against the local rows), which is a separate piece of work against live
production data and is not attempted here.

It also does not change `handleInvoicePaymentFailed`'s use of the top-level `invoice.subscription`
field. That field exists in the pinned API version (`2024-12-18.acacia`,
`libs/backend-common/src/billing/stripe-client.factory.ts:30`); it moves under
`parent.subscription_details` in later versions, and that is a version-upgrade concern rather than
this defect.
