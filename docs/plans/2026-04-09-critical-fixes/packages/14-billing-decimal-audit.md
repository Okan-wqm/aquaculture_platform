# Package 14: billing-decimal-audit

## Metadata
Status: PENDING
Estimated Tokens: 35K
Priority: CRITICAL
Security-Sensitive: no
Parallelizable: yes (Sprint 1)
Prerequisites: none
Sprint: 1
Closing-Findings: [PLAT-CRITICAL-001, PLAT-CRITICAL-002, PLAT-CRITICAL-003]
Source-Reviews: [user-provided finding list 2026-04-09]

## Context
Three compounding billing integrity defects: (1) invoice entity uses `precision:12, scale:2` which is insufficient for tax calculations requiring 4+ decimal places, and the DecimalTransformer uses `parseFloat()` destroying precision on read; (2) ALL billing math uses native JS `number` instead of a decimal library, and Stripe amount conversion uses hardcoded `/100` instead of currency-aware conversion; (3) no BillingAuditEntry rows are created on any billing mutation, making financial reconciliation impossible and violating SOX-style audit requirements. Together these guarantee incorrect invoices and no audit trail.

## Findings
- **PLAT-CRITICAL-001**: Invoice precision:12,scale:2 insufficient; DecimalTransformer parseFloat
  - File: `apps/billing-service/src/billing/entities/invoice.entity.ts` (~7.8K chars)
  - Column `amount` uses `numeric(12,2)` -- insufficient for tax intermediates
  - DecimalTransformer.from() calls parseFloat(), destroying precision

- **PLAT-CRITICAL-002**: All billing math uses JS number not Decimal; hardcoded /100 for Stripe
  - Files: `apps/billing-service/src/billing/handlers/*.ts` (11 handlers, ~56.3K chars total)
  - Every handler performs monetary arithmetic with `+`, `-`, `*`, `/` on JS numbers
  - Stripe amount conversion: `amount / 100` instead of currency-aware `Dinero` or `decimal.js`

- **PLAT-CRITICAL-003**: No BillingAuditEntry rows on any billing mutation
  - Files: `apps/billing-service/src/billing/handlers/*.ts`
  - No handler creates audit trail entries for create/update/void/refund operations

## Affected Files
- `/var/aqua-saas/apps/billing-service/src/billing/entities/invoice.entity.ts` (~7.8K chars)
- `/var/aqua-saas/apps/billing-service/src/billing/entities/payment.entity.ts` (~5.7K chars)
- `/var/aqua-saas/apps/billing-service/src/billing/entities/plan.entity.ts` (~3.4K chars)
- `/var/aqua-saas/apps/billing-service/src/billing/entities/subscription.entity.ts` (~5.7K chars)
- `/var/aqua-saas/apps/billing-service/src/billing/handlers/create-invoice.handler.ts` (~6.8K chars)
- `/var/aqua-saas/apps/billing-service/src/billing/handlers/record-payment.handler.ts` (~7.8K chars)
- `/var/aqua-saas/apps/billing-service/src/billing/handlers/refund-payment.handler.ts` (~6.6K chars)
- `/var/aqua-saas/apps/billing-service/src/billing/handlers/void-invoice.handler.ts` (~2.3K chars)
- `/var/aqua-saas/apps/billing-service/src/billing/handlers/create-subscription.handler.ts` (~8.8K chars)
- `/var/aqua-saas/apps/billing-service/src/billing/handlers/change-subscription-plan.handler.ts` (~10K chars)
- `/var/aqua-saas/apps/billing-service/src/billing/handlers/finalize-invoice.handler.ts` (~1.5K chars)

## Dependencies
None.

## Atomic Commit Plan
```
fix(billing): use decimal arithmetic, fix column precision, add audit entries

1. All billing entities: change monetary columns to numeric(19,4).
   Replace DecimalTransformer.from parseFloat() with Decimal constructor.
2. All billing handlers: replace JS number arithmetic with decimal.js
   for all monetary calculations. Replace /100 Stripe conversion with
   currency-aware minor-unit conversion.
3. Create BillingAuditEntry entity. Add audit entry creation to every
   billing mutation handler within the same transaction.

Closes: docs/reviews/2026-04-09-critical-fixes#PLAT-CRITICAL-001
Closes: docs/reviews/2026-04-09-critical-fixes#PLAT-CRITICAL-002
Closes: docs/reviews/2026-04-09-critical-fixes#PLAT-CRITICAL-003
Plan: docs/plans/2026-04-09-critical-fixes/packages/14-billing-decimal-audit.md
```

## Test Plan
- Unit test: DecimalTransformer round-trip preserves 4 decimal places
- Unit test: invoice total with tax calculated to 4 decimals, rounded to 2 for display
- Unit test: Stripe conversion uses currency minor-unit table (not hardcoded /100)
- Unit test: every billing handler creates BillingAuditEntry in same transaction
- Unit test: audit entry contains before/after state, actor, timestamp

## Verification Command
```bash
cd /var/aqua-saas && npx tsc --noEmit -p apps/billing-service/tsconfig.json && npx jest --testPathPattern="apps/billing-service/src/billing" --coverage=false
```

## Rollback Plan
```
git revert {placeholder_for_commit_hash} --no-edit
```

## Failure Notes
