# ADR-037 — Plan-limit single source of truth (PLAN_CATALOG)

- **Status:** Accepted
- **Date:** 2026-06-25
- **Finding:** SSOT-C-13 (`docs/reviews/2026-06-23-ssot-architecture-audit.md`)

## Context

Per-plan resource limits (`maxSensors`, `maxUsers`, `maxPonds`, …) were
hand-copied across **five** independent catalogs that had already drifted:

| # | Location | Starter `maxSensors` / `maxUsers` |
|---|----------|-----------------------------------|
| 1 | `billing-service` `plan-seed.service.ts` (`billing.plans`) | 20 / 5 |
| 2 | `billing-service` `tenant-subscription-requested.handler.ts` (`DEFAULT_LIMITS`) | 20 / 5 |
| 3 | `gateway-api` `tenant-context.middleware.ts` (`PLAN_LIMITS`) + identical copy in `tenant-lookup.service.ts` | 50 / 10 |
| 4 | `admin-api-service` `plan-definition.service.ts` (`getDefaultLimitsForTier`) | 50 / 5 |
| 5 | `auth-service` `tenant.service.ts` (`getDefaultMaxUsers`, dead) | — / 10 |

Whichever service a request happened to hit decided the limit, so the platform
had no single truth about what a customer actually bought. The three catalogs
also used **three different field shapes** (`storageGB` vs `maxStorageGb`,
`apiRateLimit` vs `maxApiRequests`, an extended admin boolean set) and two
different key enums (`PlanTier` has `CUSTOM`/no `FREE`; `TenantPlan` has
`TRIAL`/no `CUSTOM`).

## Decision

1. **One catalog.** `PLAN_CATALOG: Readonly<Record<TenantPlan, PlanLimits>>` in
   `libs/event-contracts/src/billing/plan-catalog.ts` is the single source of
   truth. `PlanLimits` is the **superset** of every field any consumer needs,
   with canonical names (`maxStorageGb`, `maxApiRequests`, `apiRateLimit` kept
   distinct — total budget vs requests-per-minute are different concepts).

2. **Consumers project, never re-declare.** Every former catalog is deleted;
   each consumer derives its local shape from `resolvePlanLimits(plan)` (the
   gateway `TenantLimits` subset; the billing 9-field subset via
   `billingPlanLimitsFor`; the admin 17-field shape via a `PlanTier→TenantPlan`
   map renaming `maxStorageGb→storageGB`). The numbers exist exactly once.

3. **Value authority = `billing.plans`.** Billing is the SSoT for subscription
   state (root CLAUDE.md D14), so where catalogs disagreed the billing-seed
   numbers win. Concretely the resolved canonical values are:

   | Tier | farms | ponds | sensors | users | retention | reports | apiAccess |
   |------|-------|-------|---------|-------|-----------|---------|-----------|
   | free | 1 | 5 | 10 | 3 | 30 | off | off |
   | trial | 5 | 25 | 100 | 10 | 90 | on | on |
   | **starter** | 3 | **30** | **20** | **5** | 90 | **off** | **off** |
   | professional | 10 | 100 | 100 | 25 | 365 | on | on |
   | enterprise | -1 | -1 | -1 | -1 | -1 | on | on |

   `-1` = unlimited. The gateway/admin "50 sensors / 10 users / api-on" Starter
   variants are standardised **down** to billing's intent. Two outliers are
   corrected: auth's enterprise `maxUsers: 500` and billing's enterprise
   `dataRetentionDays: 730` both become `-1` (fully unlimited). Fields only one
   service ever defined (gateway `maxApiRequests`/`maxStorageGb`; admin
   `maxModules`/`apiRateLimit`/extended booleans) are carried verbatim.

4. **The DB stays the per-env override surface.** `admin.plan_definitions`
   remains authoritative for per-environment Stripe price IDs and admin pricing
   overrides; its `limits` column is seeded from and validated against
   `PLAN_CATALOG`.

## Enforcement (architectural hierarchy)

- **Tier 1 (impossible):** `Readonly<Record<TenantPlan, PlanLimits>>` — a missing
  tier or limit field is a TypeScript compile error in every consumer.
- **Tier 3 (detectable):** `tests/invariants/plan-limits-ssot.spec.ts` fails any
  production file that declares a per-plan limits map (hard-coded limit number
  co-located with ≥2 plan-tier tokens) outside `plan-catalog.ts`.

## Consequences

- Existing tenants whose limits were read from the gateway path (50 sensors /
  api-on for Starter) are standardised to the billing values on next read. This
  is the intended correction, not a regression — billing already provisioned
  them at the lower numbers.
- Two further plan-AWARE limit defaults were also folded into the SSoT (not left
  as drift): the `gateway-api` `tenant-context.interceptor.ts` fallback now
  derives from the JWT `subscriptionTier` (and, as a bonus, fixes a latent bug
  where the limits never tracked the tenant's tier — defaulting to a generous
  500-sensor object), and the `admin` tenant entity `limits` getter now derives
  from its own `plan` column. Their non-canonical field names are projected
  (`maxApiRequestsPerHour = apiRateLimit × 60`; `storageGb ← maxStorageGb`); the
  one field with no PLAN_CATALOG equivalent, `maxAlertRules`, stays `-1`.
- Genuinely different concepts are intentionally NOT folded: the per-tenant
  *operational* config default (`tenant-configuration.entity.ts` `userLimits`:
  max admins / concurrent sessions / session timeout) and an unreachable
  zero-fallback in `tenant-detail.service.ts` are not plan resource limits.
- `PLAN_FEATURES` (the per-plan *feature* booleans in the gateway) is a sibling
  *features* catalog of a different shape, left for a separate features-SSoT
  pass and tracked as an orphan finding.
