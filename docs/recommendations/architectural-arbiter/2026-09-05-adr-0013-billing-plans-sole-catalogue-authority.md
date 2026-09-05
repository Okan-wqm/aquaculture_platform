# ADR-0013 — `billing.plans` Is the Sole Catalogue Authority; Admin Keeps Authoring, Not Ownership

**Status:** accepted
**Date:** 2026-09-05
**Extends:** `docs/adr/037-plan-limit-ssot.md` from limits to the full catalogue
**Reverses:** the plan-ownership clause in `apps/billing-service/CLAUDE.md` ("Plan DEFINITIONS, pricing and discount codes are admin-owned, not billing-owned") — to be edited in the implementing PR
**Resolves:** billing-expert#BILL-005, #BILL-006, #BILL-014, #BILL-016; database-reviewer#DB-REVIEW-010, #DB-REVIEW-013, #DB-REVIEW-018; form-write-auditor#FORM-010, #FORM-012; db-audit-platform-admin#DB-ADMIN-HIGH-007, #DB-ADMIN-HIGH-012
**Finding reference:** docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#BILLING-CRITICAL-002

## Context

`libs/event-contracts/src/billing/plan-catalog.ts:31-37` already records the 2026-06-25 ruling "billing.plans is the value authority". Yet `admin.plan_definitions` (Stripe ids with zero readers, prices as IEEE-754 floats in `jsonb`), `admin.module_pricing` (money in `jsonb`, feeds provisioning), `admin.custom_plans` (never reaches ACTIVE) and `admin.discount_codes` persist as a shadow catalogue with a UI. Every runtime read — `create-subscription.handler.ts:83`, `change-subscription-plan.handler.ts:218`, `billing-scheduler.service.ts:580`, `billing-admin-nats.handler.ts:579-583` — resolves `billing.plans`; admin plan ids never resolve at execution.

The "admin keeps a draft catalogue that publishes to billing" path is a middle path and is rejected: two catalogues plus a synchronisation problem is precisely the defect.

## Decision

We rule that anything participating in pricing a subscription or an invoice lives in `billing`. `billing.plans` is the sole catalogue of record for plan id, price, billing cycle and Stripe product / price ids. `PLAN_CATALOG` in event-contracts keeps plan limits (ADR-037 unchanged). `admin.plan_definitions`, `admin.module_pricing`, `admin.custom_plans` and `admin.discount_codes` are deleted and their data migrated into billing with typed `numeric(12,2)` columns and `CHECK (>= 0)`, ISO-4217 `char(3)` currency with CHECK, and `discountPercent CHECK BETWEEN 0 AND 100`. admin-panel remains the editing UI; admin-api becomes a pure command forwarder over `request.billing.admin.*`.

Gate: `tests/invariants/plan-limits-ssot.spec.ts` grows into `plan-catalog-ssot.spec.ts` — (i) no entity outside `apps/billing-service/` declares a plan, price, module-price, custom-plan or discount-code table; (ii) no money-typed field is declared inside a `jsonb` / `simple-json` column anywhere in the fleet; (iii) `stripeProductId` / `stripePriceIds` appear in exactly one entity.

## Consequences

- Largest blast radius in the set: 4 admin tables, 6 entities, ~5 admin services, the money routes in `billing.controller.ts`, new billing tables / handlers / migration, new `billing-admin-commands.ts` subjects, `services.yaml` + `nats.conf` regeneration, five admin pages re-pointed.
- `billing-expert` becomes primary owner of the catalogue tables; `admin-expert` drops to secondary (prompt-writer to update).
- Also closes torn module pricing (one handler, one transaction), the discount TOCTOU (conditional UPDATE with the `UNIQUE(discountCodeId, tenantId)` it never had) and the shadow FK columns.
- The losing side: admin-expert's documented ownership. Ownership is where the reads are.
