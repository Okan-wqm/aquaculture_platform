# billing-service — CLAUDE.md (domain context)

> Root rules in `/CLAUDE.md` already apply (always loaded). This file adds ONLY the billing-domain facts that CONTRADICT a correct reading of those rules.

Subscription lifecycle, invoicing, metering, Stripe webhook/API. Schema: `billing` (platform-level). Billing is the SSoT for per-tenant subscription STATE (D14).

## Billing is NOT the SSoT for plan limits

The natural assumption — billing owns plans, so billing owns plan limits — is wrong. `PLAN_CATALOG` in `libs/event-contracts/src/billing/plan-catalog.ts` is the canonical limit SSoT; billing PROJECTS from it, as does every other consumer. Adding a limits map here fails `tests/invariants/plan-limits-ssot.spec.ts`.

Pre-fix the numbers were hand-copied across five per-plan catalogs and drifted apart.

## …but billing DOES own everything that prices a subscription (ADR-0013)

This reverses the former clause here that made plan definitions, pricing and discount codes admin-owned. Anything participating in pricing a subscription or an invoice lives in `billing`: admin-panel remains the editing UI, admin-api forwards `request.billing.admin.*` commands and maps the rows read-only (`schema: 'billing'`, `synchronize: false`). `discount_codes` / `discount_redemptions` moved first (migration `1802000000000`), then `module_prices` + its metric and tier-multiplier rows (`1802100000000`), then the plan catalogue: `admin.plan_definitions` folded into `billing.plans` and its jsonb price matrix and add-ons became `plan_cycle_prices` / `plan_add_ons` rows (`1802200000000`, admin drop `1809100000000`); finally `admin.custom_plans` became `billing.custom_plans` + `custom_plan_modules` + `custom_plan_line_items` (`1802300000000`, admin drop `1809200000000`). The move is complete.

**The arithmetic lives with the prices.** billing answers `request.billing.admin.quoteModuleSelection`; admin-api multiplies nothing. Four float copies of that calculation used to exist (the admin calculator, the custom-plan service and two admin-panel pages), and the browser ones rendered a total the server would not have charged. A negotiated discount goes through the SAME quote (`negotiatedDiscountPercent` / `negotiatedDiscountAmount`), so a custom plan's stored total and the builder's preview are one number from one code path. `roundToCurrency` is in `@aquaculture/backend-common/monetary` beside `getCurrencyScale` — two byte-identical copies had grown inside this service.

Money uses `MoneyColumn` (`numeric(19,4)`) — never a `number` inside a `jsonb` blob, which no CHECK can constrain. The one surviving jsonb money is the flat rate card `plans.pricing` / `subscriptions.pricing` / `scheduled_plan_changes.pricing` snapshot: all three are the same shape and normalise together under BILLING-CRITICAL-003, so they stay in the ratchet until then. A discount's value is a column per kind (`percent_off`, `amount_off`, `free_months`, `trial_extension_days`) under one CHECK, because a single polymorphic value column cannot tell 150% from $150. Gate: `tests/invariants/plan-catalog-ssot.spec.ts` + the ratchet in `.claude/allowlists/money-in-jsonb.yaml`.

## Every money field has a `Float` and a `*Decimal` twin — on purpose

Money crosses GraphQL as a `Decimal` string, not a lossy IEEE-754 `Float`. During the additive coexistence window each deprecated `Float` field keeps a parallel `*Decimal` sibling populated by a `@ResolveField` in `apps/billing-service/src/billing/billing-decimal.resolver.ts`.

This is not duplication to clean up. Removing the `Float` breaks the tenant-admin UI that still reads it; removing the `Decimal` silently rounds invoices. Guarded by `tests/invariants/billing-money-decimal-coexistence.spec.ts`.

## `billing.custom_plans` is the one tenant-scoped row in the catalogue

The rest of the catalogue (`plans`, `discount_codes`, `module_prices` and their children) is platform reference data with no tenant column, excluded from erasure. A custom plan is negotiated FOR one tenant, so it carries `tenant_id`, is erased with that tenant, and its two child tables cascade from it. Do not copy the catalogue's `excluded` policy across to it.

Its lifecycle (`draft` → `pending_approval` → `approved` → `active`, or `rejected`) is a state machine in `CustomPlanService`, not a check in the caller. admin-api keeps ONE precondition of its own — it refuses to activate a plan that is not `approved` — because the provisioning call it makes first is irreversible.

## One writer for `billing.subscriptions`, and one metadata key (ADR-0014)

A subscription row is written ONLY by `SubscriptionWriterService.createWithin`, which takes the caller's `EntityManager` so the GraphQL path and admin tenant provisioning share it across their different transactions; `ensureStripeObjects` runs before either transaction opens. Provisioning used to raw-`INSERT` with the Stripe columns NULL, so operator-provisioned tenants existed only locally. The three lifecycle transitions (cancel / reactivate / extend-trial) go through their `@CommandHandler`s, never raw SQL. Gate: `tests/invariants/billing-command-contract-ssot.spec.ts`.

Every admin billing command is at-most-once. `BillingAdminCommandMeta` requires `idempotencyKey` AND `correlationId`; the key is the operator's `Idempotency-Key` header (minted once per call by admin-panel's `apiFetch`, OUTSIDE its own 502/503/504 retry loop) composed with a per-command scope, and admin-api refuses a billing mutation that arrives without one. `BillingCommandReceiptInterceptor` is bound to all five NATS controllers, so a receipt is the DEFAULT: skipping it costs `@NonMutatingBillingCommand()` (quote / validate / generate — a repeat must recompute) or `@OwnsBillingCommandReceipt()` (provisioning, whose receipt commits inside its own SERIALIZABLE transaction). A reply with `success: false` is filed FAILED so a transient refusal can be retried; `success: true` is filed SUCCEEDED and replayed verbatim. Receipt identity is `(tenantId, commandType, idempotencyKey)` — `operationId` is evidence, not identity, and while it led the unique index a caller that regenerated it provisioned twice. `tenantId` is NULL for platform-scoped catalogue commands (`NULLS NOT DISTINCT`); a STARTED receipt fails closed and is released by marking the row `supersededAt`, which is an operator action and never a runtime write.

A plan is purchasable on a cycle exactly when it carries a `plan_cycle_prices` row for it; `plans.billing_cycle` is the plan's DEFAULT cycle, not its only one. Provisioning resolves the catalogue plan by TIER (as the GraphQL path always did) and refuses a cycle the plan is not priced for. `customPlanId` names a `billing.custom_plans` row — never a `plans` row — and is verified to exist, to belong to the tenant, and to be approved. What a cycle costs is `cycleAmountFor` in `services/module-quote.ts`, the one rule the quote AND the invoice scheduler use; a second copy that skipped the commitment discount billed annual tenants 15% above the price they signed. `pricing.basePrice` on a subscription is the MONTHLY rate — the scheduler multiplies it — so never divide it by the cycle again. `PlanSeedService` fails the boot rather than leaving an unsellable catalogue.

The Stripe↔tenant metadata key has ONE declaration, `STRIPE_TENANT_METADATA_KEY` in `libs/backend-common/src/billing/stripe-metadata.ts`. It is a HINT, never the authority: a webhook handler resolves the tenant from the local row that owns the Stripe object and cross-checks the hint through `readStripeTenantHint`. The producer's key is deliberately NOT renamed — every Stripe object the platform has created carries it.

## Erasure really does delete here

Unlike `event_store` — which excludes its ledger and relies on crypto-shred — billing runs `source-schema-tenant-column` erasure with **no exclusions**. Billing rows are deleted outright. Do not copy an exclusion pattern across from another service's registry entry.

## Enforcement

Boot: `SchemaDriftValidator`. CI: `tests/invariants/plan-limits-ssot.spec.ts`, `billing-money-decimal-coexistence.spec.ts`, `billing-webhook-redis-required.spec.ts`, `stripe-calls-via-canonical-client.spec.ts`, `webhook-public-paths.spec.ts`, `platform-entity-registry-parity.spec.ts`, `billing-command-contract-ssot.spec.ts`.
