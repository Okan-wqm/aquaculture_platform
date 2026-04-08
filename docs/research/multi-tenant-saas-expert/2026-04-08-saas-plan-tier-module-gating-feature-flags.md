# Research: SaaS Plan Tier & Module Gating with Per-Tenant Feature Flags

**Topic:** Plan hierarchy (Starter < Professional < Enterprise < Custom), module gating, per-tenant feature flags, Stripe metered billing integration
**Date:** 2026-04-08
**Agent:** multi-tenant-saas-expert

## Sources

- Stripe Documentation — "Recurring pricing models": https://docs.stripe.com/products-prices/pricing-models — tiered, per-seat, usage-based, package, volume, graduated pricing.
- Stripe Documentation — "Usage-based billing with Meters and Meter Events" (API 2025-03-31.basil and later): https://docs.stripe.com/billing/subscriptions/usage-based/pricing-plans — metered billing is now Meter-backed; legacy usage records API is removed.
- Microsoft Learn, "Tenancy models for a multitenant solution" — feature-tier mapping to deployment model.
- Martin Fowler, "Feature Toggles (aka Feature Flags)": https://martinfowler.com/articles/feature-toggles.html — release toggles, experiment toggles, ops toggles, permission toggles.
- ThoughtWorks Tech Radar — LaunchDarkly / Unleash feature-flag platform guidance.
- OWASP Authorization Cheat Sheet — permission evaluation ordering.
- Aqua-saas codebase: `libs/event-contracts/src/base-event.ts` (`PlanTier = 'starter' | 'professional' | 'enterprise'`), `libs/event-contracts/src/billing-events.ts`, `libs/event-contracts/src/tenant-events.ts`, `apps/auth-service/src/modules/tenant/entities/tenant.entity.ts` (`TenantPlan enum`), `apps/auth-service/src/modules/tenant/entities/tenant-module.entity.ts`.

## Key Findings

1. **Codebase-vs-spec drift note.** The task spec lists `Starter < Professional < Enterprise < Custom`. The codebase currently defines `TenantPlan = { TRIAL, STARTER, PROFESSIONAL, ENTERPRISE }` and `PlanTier = 'starter' | 'professional' | 'enterprise'`. The CUSTOM tier is documented as an aspiration but not yet in the `PlanTier` union type. The agent must flag this as HIGH drift between product documentation and event contracts. When adding CUSTOM, it MUST extend the union type atomically and an upcaster is not required because adding enum values is additive.
2. **Plan tier must be a strictly-ordered enum** with integer levels to support transitive hierarchy checks: `STARTER (1) < PROFESSIONAL (2) < ENTERPRISE (3) < CUSTOM (4)`. Feature checks use `tenant.planLevel >= feature.requiredPlanLevel`, never strict equality. Strict equality = CRITICAL (professional users fail feature checks intended for starter+).
3. **Module gating is separate from plan tier.** A tenant on Professional may have `farm + sensor + hr` modules enabled, another Professional tenant may have `farm + sensor` only. Module grants are stored in a `tenant_modules` join table with `tenantId`, `moduleKey`, `status`, `grantedAt`, `expiresAt`. Plan tier determines the MAX modules allowed; module grants determine which are ACTIVE.
4. **Per-tenant feature flags** layer on top of plan tier and module grants. Flag sources ordered by precedence: per-tenant override > plan-tier default > global default. Flags must be evaluable in < 1 ms (in-memory cache with short TTL, invalidated on flag change events).
5. **Stripe metered billing (2026 architecture).** Every metered price links to a `Meter` object with an aggregation function and an event name. Application sends `MeterEvent` webhooks on billable operations. Legacy `usage_records` API is deprecated as of API version 2025-03-31.basil. Platforms still using `usage_records` = HIGH (removal timeline).
6. **Billing state drives feature access in near-real-time.** On `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted` Stripe webhooks, the application must update a cached subscription state that middleware checks on every request. Eventual consistency beyond ~60 seconds = MEDIUM to HIGH depending on the feature's financial risk.
7. **Plan change is a saga with a pivot.** Upgrade: provision new modules → update Stripe subscription (PIVOT) → notify tenant → emit `PlanChanged` event. Downgrade: validate module dependency graph (which modules lose access) → explicit tenant acknowledgment → update Stripe (PIVOT) → decommission modules (soft) → grace period → hard decommission.
8. **Downgrade validation must check dependency graph.** Example: if HR module depends on BILLING module (for payroll), removing BILLING forces HR removal. Silent downgrade that leaves dependent modules in broken state = HIGH.
9. **Feature flag kill switches for operational emergencies.** A per-tenant ops toggle must be able to disable expensive features for a specific tenant without a deploy (noisy-neighbor response).

## Security Concerns

- **Upward plan escalation via direct DB write** — any code path that writes `tenant.plan` outside the plan-change saga = CRITICAL.
- **Horizontal feature escalation** — a starter tenant calling an enterprise-only endpoint. Guard must check plan level AND module grant AND feature flag BEFORE the handler runs.
- **Stripe webhook signature verification** — signatures verified via `stripe.webhooks.constructEvent()` with raw body parser. Body-parser middleware running before the webhook route breaks verification = CRITICAL.
- **Webhook replay** — every Stripe webhook is processed in a `stripe_webhook_events` table with `UNIQUE(event_id)` for first-write-wins deduplication.
- **Feature flag bypass** — evaluating flags in the frontend only, without a backend guard, is a CRITICAL security gap. Frontend is untrusted.

## Performance Concerns

- **Plan-tier check on every request** — must be O(1) from in-memory cache (tenant-scoped), not a DB query per request.
- **Feature flag evaluation latency** — budget < 1 ms per check, cached per tenant with TTL 30-60 s and event-driven invalidation on flag change.
- **Stripe meter event fan-out** — metered billing requires sending N meter events per unit of work; batch or sample high-volume events.

## Architectural Implications for multi-tenant-saas-expert reviews

- Flag any code path that writes `tenant.plan` outside the plan-change saga as CRITICAL.
- Flag strict equality on plan tier checks as CRITICAL. Hierarchy checks must use `>=` on integer levels.
- Flag any downgrade path that does not validate the module dependency graph as HIGH.
- Flag any Stripe webhook handler missing `stripe.webhooks.constructEvent` or missing dedup on `event.id` as CRITICAL.
- Flag any feature flag evaluation on the frontend without a backend mirror as CRITICAL.
- Flag any metered price still using `usage_records` API as HIGH (deprecation timeline).
- Flag `PlanTier` and `TenantPlan` drift between event contracts and auth-service entity as HIGH (drift risk).

## Domain Rule Additions for multi-tenant-saas-expert

- **Plan tier is a strictly-ordered enum** with integer levels `STARTER (1) < PROFESSIONAL (2) < ENTERPRISE (3) < CUSTOM (4)`. Feature checks use `>=`, never `===`. Strict equality = CRITICAL.
- **Plan tier mutation is restricted** to the plan-change saga. Direct `tenant.plan = ...` writes outside the saga = CRITICAL.
- **Module gating** is separate from plan tier — `tenant_modules` join table with `(tenantId, moduleKey, status)`. Plan tier defines MAX modules; grants define ACTIVE modules.
- **Feature flag precedence** — per-tenant override > plan-tier default > global default. Frontend-only evaluation without a backend guard = CRITICAL.
- **Backend must evaluate flags** in < 1 ms via tenant-scoped in-memory cache with event-driven invalidation; DB query per request = HIGH.
- **Stripe webhook verification** — `stripe.webhooks.constructEvent` with raw body parser, dedup on `event.id` via `stripe_webhook_events UNIQUE(event_id)`. Missing either = CRITICAL.
- **Plan change is a saga with PIVOT at Stripe subscription update.** Pre-pivot compensation rolls back module grants; post-pivot compensation issues refund.
- **Downgrade validates module dependency graph** BEFORE pivot; silent dependent-module breakage = HIGH.
- **Legacy Stripe `usage_records` API usage** = HIGH (deprecated in API 2025-03-31.basil, replaced by Meter/MeterEvent).
- **Per-tenant kill switch** — platform must be able to disable an expensive feature for a single tenant without a deploy (noisy-neighbor response). Missing kill switch = HIGH.
- **Drift between `PlanTier` (event contract) and `TenantPlan` (auth-service entity)** = HIGH until reconciled. Adding CUSTOM requires atomic update in both places.
