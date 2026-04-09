# Package 13: platform-billing-integrity

## Metadata
Status: PENDING
Estimated Tokens: 25K
Priority: HIGH
Security-Sensitive: no
Parallelizable: yes
Prerequisites: none
Closing-Findings: [PLAT-HIGH-004, PLAT-HIGH-005, PLAT-HIGH-006]
Source-Reviews:
  - docs/reviews/platform-services/2026-04-05-s2-high-findings.md

## Context
Billing-service has three data integrity HIGHs: (1) webhook key is mutable global variable, (2) duplicate FAILED payment records on Stripe retry when Redis unavailable, (3) SubscriptionUpdatedEvent always reports previousPlanTier == newTier because the entity is mutated before event construction. Also: missing exchangeRate field in billing calculations, and sent invoice is mutatable after finalization.

## Findings

**PLAT-HIGH-004** (platform-services, HIGH)
File: apps/billing-service/src/billing/controllers/stripe-webhook.service.ts
Webhook encryption key is a mutable module-level global. Also: handlePaymentIntentFailed has no idempotency check -- Stripe retries insert duplicate FAILED payment records when Redis is unavailable.

**PLAT-HIGH-005** (platform-services, HIGH)
File: apps/billing-service/src/billing/handlers/change-subscription-plan.handler.ts (lines 124-196)
SubscriptionUpdatedEvent.previousPlanTier always equals new tier. Subscription object mutated in-place before event construction. Missing exchangeRate in billing calculations.

**PLAT-HIGH-006** (platform-services, HIGH)
File: apps/billing-service/src/billing/entities/invoice.entity.ts
Sent/finalized invoices are mutatable -- no status guard prevents modification of amount, lineItems, or payment status after invoice has been sent to customer.

## Affected Files
- apps/billing-service/src/billing/controllers/stripe-webhook.service.ts
- apps/billing-service/src/billing/handlers/change-subscription-plan.handler.ts
- apps/billing-service/src/billing/entities/invoice.entity.ts
- apps/billing-service/src/billing/services/invoice.service.ts

## Dependencies
None.

## Atomic Commit Plan
```
fix(billing): fix payment idempotency, capture previousPlanTier before mutation, guard sent invoices

handlePaymentIntentFailed lacks idempotency check creating duplicate FAILED
records. SubscriptionUpdatedEvent.previousPlanTier always equals new tier
because entity mutated before event construction. Sent invoices can be
modified after finalization.

Add idempotency findOne guard to handlePaymentIntentFailed. Capture
previousPlanTier before any mutation. Add Invoice.guardImmutableAfterSent()
validation that throws on modification attempts when status >= SENT. Move
webhook key to instance property.

Plan: docs/plans/2026-04-09-high-fixes/packages/13-platform-billing-integrity.md
Closes: docs/reviews/platform-services/2026-04-05-s2-high-findings.md#H-04
Closes: docs/reviews/platform-services/2026-04-05-s2-high-findings.md#H-06
Closes: docs/reviews/platform-services/2026-04-05-s2-high-findings.md#PLAT-HIGH-005
```

## Test Plan
- Unit test: second handlePaymentIntentFailed call for same stripePaymentIntentId is no-op
- Unit test: SubscriptionUpdatedEvent.previousPlanTier != tier on downgrade
- Unit test: Invoice.save() throws when status is SENT and amount is modified
- Unit test: webhook key is instance property, not module global

## Verification Command
`npx tsc --noEmit -p apps/billing-service/tsconfig.json && npx jest --testPathPattern="apps/billing-service/src/billing" --coverage=false`

## Rollback Plan
`git revert {placeholder_for_commit_hash} --no-edit`

## Failure Notes
