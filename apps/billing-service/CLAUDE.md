# billing-service — CLAUDE.md (domain context)

> Root rules in `/CLAUDE.md` already apply (always loaded). This file adds ONLY the billing-domain facts that CONTRADICT a correct reading of those rules.

Subscription lifecycle, invoicing, metering, Stripe webhook/API. Schema: `billing` (platform-level). Billing is the SSoT for per-tenant subscription STATE (D14).

## Billing is NOT the SSoT for plan limits

The natural assumption — billing owns plans, so billing owns plan limits — is wrong. `PLAN_CATALOG` in `libs/event-contracts/src/billing/plan-catalog.ts` is the canonical limit SSoT; billing PROJECTS from it, as does every other consumer. Adding a limits map here fails `tests/invariants/plan-limits-ssot.spec.ts`.

Pre-fix the numbers were hand-copied across five per-plan catalogs and drifted apart.

## …but billing DOES own everything that prices a subscription (ADR-0013)

This reverses the former clause here that made plan definitions, pricing and discount codes admin-owned. Anything participating in pricing a subscription or an invoice lives in `billing`: admin-panel remains the editing UI, admin-api forwards `request.billing.admin.*` commands and maps the rows read-only (`schema: 'billing'`, `synchronize: false`). `billing.discount_codes` / `discount_redemptions` moved first (BILLING-CRITICAL-002, migration `1802000000000`); `admin.plan_definitions`, `module_pricing` and `custom_plans` follow.

Money uses `MoneyColumn` (`numeric(19,4)`) — never a `number` inside a `jsonb` blob, which no CHECK can constrain. A discount's value is a column per kind (`percent_off`, `amount_off`, `free_months`, `trial_extension_days`) under one CHECK, because a single polymorphic value column cannot tell 150% from $150. Gate: `tests/invariants/plan-catalog-ssot.spec.ts` + the ratchet in `.claude/allowlists/money-in-jsonb.yaml`.

## Every money field has a `Float` and a `*Decimal` twin — on purpose

Money crosses GraphQL as a `Decimal` string, not a lossy IEEE-754 `Float`. During the additive coexistence window each deprecated `Float` field keeps a parallel `*Decimal` sibling populated by a `@ResolveField` in `apps/billing-service/src/billing/billing-decimal.resolver.ts`.

This is not duplication to clean up. Removing the `Float` breaks the tenant-admin UI that still reads it; removing the `Decimal` silently rounds invoices. Guarded by `tests/invariants/billing-money-decimal-coexistence.spec.ts`.

## Erasure really does delete here

Unlike `event_store` — which excludes its ledger and relies on crypto-shred — billing runs `source-schema-tenant-column` erasure with **no exclusions**. Billing rows are deleted outright. Do not copy an exclusion pattern across from another service's registry entry.

## Enforcement

Boot: `SchemaDriftValidator`. CI: `tests/invariants/plan-limits-ssot.spec.ts`, `billing-money-decimal-coexistence.spec.ts`, `billing-webhook-redis-required.spec.ts`, `stripe-calls-via-canonical-client.spec.ts`, `webhook-public-paths.spec.ts`, `platform-entity-registry-parity.spec.ts`.
