# Finance E2E Review — production-readiness hardening (2026-07-10)

Cycle: `2026-07-10-finance-e2e-review`
Scope: `apps/farm-service/src/finance/**`, `apps/hr-service/src/finance/**`,
`web/modules/{farm,hr}-module/src/**/finance/**`, the currency SSoT plumbing
(`FinanceSettingsService`, `PayrollCostSettingsService`,
`FinanceSettingsUpdatedConsumer`) and the finance migrations.

Eight specialist agents (multi-tenant-saas / performance / security /
frontend / data-expert / database-reviewer / hr-expert / farm-expert) reviewed
the finance feature end-to-end. No CRITICAL was found in the delivered feature's
**security or tenant isolation** (both verified steel-grade). The defects below
concentrate in the read/aggregation path and the seed lifecycle. This document is
the SSoT for the finding IDs; the hash-chained registry entries carry the state.

## Fixed this cycle (root-cause, tier-1 where possible)

### FARM-CRITICAL-153 — lazy category seed runs an INSERT inside a READ-ONLY transaction
`finance-ledger-query.service.ts` called `ensureDefaults` (an `INSERT`) inside
`runInTenantRead` (which issues `SET TRANSACTION READ ONLY`). PostgreSQL rejects
the statement (SQLSTATE 25006), so summary/ledger/batch-totals reads 500 for any
tenant not yet warmed by a write in the same process.
**Fix (tier-1):** `ensureDefaults` now owns a dedicated tenant WRITE transaction
that commits before the read boundary opens; seeding is a write-only concern and
the read boundary structurally rejects writes.

### FARM-HIGH-154 — computed 5% rule sums its base across BOTH scopes
`ComputedRuleEvaluator` received the full cross-scope category list, so the
`OTHER_VARIABLE` (FARM_OPEX, "5% of operational cost") base included
`HARVEST_REVENUE` (FARM_REVENUE) — an 11× overstatement when revenue dominates.
**Fix (tier-1):** `evaluate` now takes a required `scope` and filters internally;
a caller cannot fold another scope's totals into the base. Regression spec added.

### FARM-HIGH-155 — seed guard poisoned before the caller's transaction commits
The in-memory `seededTenants` guard was set inside the caller's still-open tx; a
rollback deleted the seeded rows but not the guard, so categories silently vanished
for the process lifetime.
**Fix (tier-1):** the guard is populated ONLY after the dedicated seed tx commits.

### FARM-HIGH-156 — finance/payroll settings reads return an unsaved entity (GraphQL non-null id crash)
`financeSettings` / `payrollCostSettings` returned a `new FinanceSettings()` /
`new PayrollCostSettings()` with an unset non-null `id` for tenants without a
persisted row → `Cannot return null for non-nullable field …id`.
**Fix:** `id` is now nullable in GraphQL on both entities — the read honestly
models a not-yet-persisted settings view; the update mutation returns a real id.

### FARM-MEDIUM-157 — per-entry currency override + cross-currency aggregation
Manual entries accepted an arbitrary `currency`; the summary summed heterogeneous
currencies and labelled the total with the tenant default.
**Fix (tier-1):** the `currency` field is removed from the finance entry inputs
(farm + HR); every entry is booked in the tenant default, so the ledger is
structurally single-currency.

### FARM-MEDIUM-158 — updateFinanceCategory (manager) archives via `isActive`, bypassing the admin-only gate
`updateFinanceCategory` (MODULE_MANAGER) accepted `isActive:false`, reproducing the
TENANT_ADMIN-only `archiveFinanceCategory` effect at a lower privilege level.
**Fix (tier-1):** `isActive` is removed from the update input; activation state
changes only through admin-gated `archiveFinanceCategory` / new
`restoreFinanceCategory` (farm + HR).

### FARM-MEDIUM-159 — time-series buckets split by session-timezone `date_trunc` + `Date.toISOString()`
Manual (`DATE`) and derived (`timestamptz`) columns truncated differently under a
non-UTC session tz, producing two chart points for one period.
**Fix:** both sides truncate on a UTC-normalized value and key by a canonical
`YYYY-MM-DD` string (no JS `Date` round-trip).

### FARM-MEDIUM-160 — unbounded ledger `offset` (deep-pagination self-DoS)
`limit` was capped at 200 but `offset` was unbounded; the merge-paginate strategy
over-fetched `offset+limit` from each of ~7 sources.
**Fix:** `offset` is clamped to `MAX_LEDGER_OFFSET`.

### FARM-LOW-161 — `getDefaultCurrency` documented fail-open but propagated read errors
**Fix:** the settings read is wrapped; a transient error falls back to the platform
default (and is not cached) instead of failing the calling create handler.

### HR-HIGH-002 — unsupported/unregistered tenant currency bricks `Money.of` across HR labour cost
An ISO-shaped but unregistered code (e.g. `ISK`) persisted as the tenant currency
made every `Money.of(...)` throw, unrecoverable from the HR surface.
**Fix (tier-1):** the tenant default currency is validated at the write boundary
against the platform `isSupportedCurrency` registry (`@IsSupportedCurrency`), so an
unsupported currency can never be persisted.

### HR-MEDIUM-003 — FinanceSettingsUpdated projection has no ordering/idempotency guard
An out-of-order NATS redelivery could regress the tenant currency.
**Fix (tier-1):** a `currencyProjectedAt` watermark column; the consumer applies an
event only when its source timestamp is newer, making the projection idempotent and
order-insensitive.

## Wave 1 — integrity & audit SSoT (follow-up, implemented)

Per the directive to implement every finding (no deferral), the remaining
review tail is being closed in enterprise-grade waves rather than tracked as
debt. Wave 1:

### AUDIT-HIGH-016 — soft-delete had no `deletedBy` attribution
`finance_expense_entries` + `hr_finance_entries` recorded `isDeleted`/`deletedAt`
but not the acting user. Added a nullable `deletedBy` uuid column (blue-green
migrations `1804700000000` / `1801900000000`) and set it in the delete handlers.

### FARM-MEDIUM-163 — manual entry `batchId`/`siteId` not tenant-validated
`validateEntryDimensions` now rejects a finance entry whose `batchId`/`siteId`
does not reference an existing tenant-owned `batches_v2` / `sites` row, inside
the handler transaction (create + update).

### FARM-MEDIUM-164 — `computedRule` percent not bounds-validated
`ComputedRuleEvaluator` drops any computed category whose `percent` is outside
`(0,100]` instead of emitting a nonsensical cost line.

### HR-MEDIUM-004 — HR finance mutations missing `@AuditLog`
Every HR finance mutation (entry/category CRUD, restore, payroll cost settings)
now carries `@AuditLog`, so the platform audit interceptor captures them like the
rest of hr-service.

## Wave 2 — exact Money aggregation (follow-up, implemented)

### FARM-MEDIUM-165 — finance read-model accumulated money in IEEE-754 float
The ledger query and computed-rule evaluator summed `Number(row.total)` in JS
floats and rounded HALF_UP via `Math.round`, drifting fractions of a cent across
sources/buckets. Both now accumulate in **Decimal.js** and round **HALF_EVEN**
(the platform `Money` VO SSoT), converting to a JS number only at the GraphQL
boundary. `SUM(numeric(15,2))` was already exact; this closes the JS-side drift.

**Wire scalar (`DATA-MEDIUM-009`) — ruled a platform decision.** Whether finance
money should cross GraphQL as a string/Decimal scalar instead of `Float` was
routed to architectural-arbiter (ADR-0004,
`docs/recommendations/architectural-arbiter/2026-07-11-adr-0004-money-wire-representation.md`).
Verdict: it is a **platform-wide Shared-Kernel** change (billing-expert primary +
data-expert co-owner, ~65 money fields + ~115 `formatCurrency` call sites), NOT a
finance-only fix — a finance-only string scalar would fork the shared money
primitive. Finance keeps `@Field(Float)` and ships only the exact-aggregation fix
above; `DATA-MEDIUM-009` stays OPEN, re-parented to the platform effort.

## Wave 3 — performance bounds & indexes (follow-up, implemented)

### PERF-MEDIUM-005 — MAINTENANCE derived date had no index
Added expression index `idx_work_orders_tenant_effective_cost_date` on
`(tenantId, COALESCE(completedAt, createdAt))` (migration `1804800000000`) so the
work_orders range scan is index-driven. The feeding/harvest/health sources already
carry their `(tenantId, dateColumn)` indexes.

### PERF-MEDIUM-006 — unbounded time-series buckets
`clampGranularity` auto-coarsens the granularity so the series never exceeds
`MAX_SERIES_BUCKETS` (400) — bounded server work + payload regardless of range.

### PERF-MEDIUM-007 — unbounded per-batch rows
`financeBatchTotals` returns the top-N batches by cost (`MAX_BATCH_ROWS` = 25) and
rolls the remainder into an "Other" row.

> The per-tenant materialized rollup / query cache (`PERF-HIGH-004`), scoped FE
> invalidation (`PERF-005`), single-UNION aggregation (`PERF-009`) and finance p99
> SLO (`PERF-008`) remain in progress on the hardening branch.

## Wave 4 — derived site attribution (follow-up, implemented)

### FARM-MEDIUM-162 — derived ledger lines ignored the `siteId` filter
Root cause: `DerivedCostSource` has no `siteIdExpr`, and maintenance/fingerling
costs have no site dimension at all. Tier-1 fix: a site-filtered ledger now
**excludes** any derived source that cannot be attributed to the site (rather than
silently mixing tenant-wide costs into one site's P&L), and applies a
`siteIdExpr = :siteId` predicate for any source that can resolve one. The
resolver's `siteId` arg documents this behavior.

## Wave 5 — frontend correctness/UX (follow-up, implemented)

### FE-MEDIUM-061 — chart date off-by-one + window.confirm deletes
The chart `bucketLabel` now formats the (UTC-midnight) bucket start in `timeZone:
'UTC'` (and uses `getUTCFullYear`), so labels never shift a day in negative-UTC
locales. The Expenses tab delete now routes through the shared accessible
`ConfirmModal` (danger variant) instead of `window.confirm`.

## Wave 5b — frontend role-gating (follow-up, implemented)

### FE-HIGH-060 — no frontend role-gating for the finance surface
The 8 farm finance mutations are now in the shared FE permission-matrix
(`web/shared-ui/src/authz/permission-matrix.ts`), parity-locked to the backend
matrix by `permission-matrix.parity.spec`. Every farm finance action button
(add/edit/delete entry, category create/rename/archive/restore, settings save) is
gated by `useCanMutate(...)`, so a role that would 403 on the backend never sees
the button. Residual completed in Wave 5c (`FE-MEDIUM-062`).

### FE-MEDIUM-062 — nav role-filter + route guards
The shell finance nav entries (`/sites/finance`, `/hr/finance`) now carry
`requiredRoles: [SUPER_ADMIN, TENANT_ADMIN, MODULE_MANAGER]` and the Sidebar is
wired with the current user's role, so lower roles no longer see the finance link.
Both the farm `FinancePage` and hr `HRFinancePage` guard the whole route with
`useAuth().hasAnyRole(...)`, showing an explicit "restricted" message on a direct
URL visit — which also gates every HR finance button (unauthorized users never
reach them). Matches the backend MANAGER+ADMIN read gate.

## Tracked debt (owner + deadline — NOT fixed this cycle)

### PERF-HIGH-004 — no rollup/cache; derived aggregation re-scans high-frequency source tables per load
Owner: performance-expert. Deadline 2026-08-31. `financeSummary` re-aggregates the
feeding/harvest/health/work-order tables every load; grows with tenant age. Needs a
per-tenant outbox-refreshed rollup (or covering indexes + backend cache) with an
EXPLAIN benchmark at 100k rows. Not fixed here: it is a self-contained caching
subsystem, out of scope for the correctness/security pass.

### DATA-MEDIUM-009 — money persisted/transported as IEEE-754 float (platform-wide)
Owner: billing-expert. Deadline 2026-09-30. `DecimalTransformer` returns a JS number
and money crosses GraphQL as `Float`. The exact aggregation / string-decimal-scalar
change is platform-wide (billing-expert primary) and larger than the finance domain.

### FARM-MEDIUM-162 — derived ledger lines ignore the `siteId` filter
Owner: farm-expert. Deadline 2026-08-31. Derived sources have no `siteIdExpr`, so a
site-scoped ledger mixes one site's manual entries with the whole tenant's derived
costs. Needs `siteIdExpr` populated (feeding→tank→site, harvest→tank→site) or derived
rows excluded when a `siteId` filter is present.

### FE-HIGH-060 — no frontend role-gating for the finance surface
Owner: frontend-expert. Deadline 2026-08-31. Backend is fail-closed (verified — no
leak), so this is defense-in-depth + UX: role-filter the finance nav, `useCanMutate`
on buttons, `requiredRoles` on the routes, and mirror the finance mutations in the FE
permission-matrix. Partially addressed here: farm form error banners now announce via
`role="alert"`; money now formats through the shared 2-decimal `formatCurrency`.

### FE-MEDIUM-061 — chart date off-by-one + window.confirm deletes
Owner: frontend-expert. Deadline 2026-08-31. Format bucket dates with `timeZone:'UTC'`
(the backend now emits canonical UTC `YYYY-MM-DD` bucket starts, FARM-MEDIUM-159) and
route deletes through the shared accessible `ConfirmModal`.
