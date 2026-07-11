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

> The per-tenant materialized rollup / query cache (`PERF-HIGH-004`) remains in
> progress on the hardening branch. Scoped FE invalidation landed in Wave 3b
> (`PERF-MEDIUM-008`); the single-UNION aggregation landed in Wave 3c
> (`PERF-MEDIUM-009`); the finance p99 SLO landed in Wave 3d (`PERF-MEDIUM-010`).

### PERF-MEDIUM-008 — mutations invalidated the whole finance surface (Wave 3b)
Root cause: every finance mutation invalidated the tenant-scoped `['finance']`
prefix, so a single row edit refetched the categories catalogue, settings, ledger,
summary and batch totals together. Scoped fix in `useFinance.ts`: entry mutations
invalidate only the aggregates that move (`ledger`, `summary`, `batchTotals`);
category mutations additionally invalidate the `categories` catalogue; settings
mutations invalidate `settings` plus the currency-dependent aggregates. No mutation
over-refetches a query it cannot affect.

### PERF-MEDIUM-009 — N+1 aggregation round-trips per summary/batch load (Wave 3c)
Root cause: `financeSummary` ran one grouped query for manual entries plus one more
per derived source (feed/fingerlings/maintenance/treatment/harvest×2) — up to seven
sequential DB round-trips per load; `financeBatchTotals` did the same. Fix: two pure
builders (`buildSummaryAggregationQuery`, `buildBatchAggregationQuery`) compose the
manual branch and every derived source into ONE `UNION ALL` query. Positional params
are shared (`$1`=tenantId, `$2`=from, `$3`=to across all branches) and each derived
branch appends its resolved category id as a bound param; the `date_trunc` unit is
asserted against the enum whitelist, so no API input ever reaches the SQL. The
per-source `await` loop and `aggregateDerivedSource` are removed. Result is identical
(same grouping keys, same Decimal accumulation), one round-trip instead of N.

### PERF-MEDIUM-010 — finance read path had no p99 SLO/alert (Wave 3d)
The finance read path (`financeSummary` / `financeLedger` / `financeBatchTotals`)
is the heaviest farm-service aggregation, yet no SLO watched its latency — a
regression would be silent. The `FarmMetricsInterceptor` already times queries
*and* mutations into `farm_mutation_duration_seconds{operation}`, so the finance
query series exist without new instrumentation. Added (tier-3, detectable): a
recording rule `aquaculture:farm_finance_query_latency_p99:5m`, the alert
`SloFinanceQueryP99High` (p99 > 1.5s for 10m, warning), and SLI #10 + the
`farm_mutation_duration_seconds` metric dependency + the rationale note in
`docs/slo/platform-slo.md`. The 1.5s target sits under the generic 2s API p99, so
a finance breach points at aggregation regression or a tenant that has outgrown
query-time derivation and needs the `PERF-HIGH-004` rollup/cache.

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

## Wave 4b — HR read-model correctness & salary privacy (follow-up, implemented)

### HR-HIGH-003 — small-cell salary disclosure
A `laborCategory`/department with headcount 1–2 exposed an individual's exact (or
pair-average) annual salary — `employee.baseSalary` is `@HideField()` precisely so
individual pay is never queryable, but the aggregate re-derived it through a tiny
cell. Fix (tier-1): a k-anonymity threshold (`SMALL_CELL_MIN_HEADCOUNT = 3`) in the
pure `LabourCostCalculator` and the department merge. A cell with `0 < headcount < k`
returns `null` salary + `salarySuppressed: true` (headcount is always kept);
**complementary suppression** blanks the smallest remaining disclosed cell when only
one is small, so the suppressed value can't be recovered from the published grand
total. The UI renders "—" with an explanatory tooltip. Covered by the calculator +
`merge-department-costs` specs.

### HR-HIGH-004 — per-department expense double-count (NULL-`departmentHrId` fan-out)
`hrFinanceSummary` grouped employees by `(departmentHrId, department-enum)`, so
employees with a NULL FK but different enum values fanned out into several rows that
**each** read the single `'none'` expense bucket — attributing the whole
unassigned-expense pool to every enum-department row; expenses for a `departmentHrId`
with no active employees were silently dropped. Fix (tier-1): employees are grouped by
`departmentHrId` only (one null "Unassigned" row), and a pure `mergeDepartmentCosts`
joins salaries and expenses on the single key, so each expense is attributed exactly
once and an expense-only department surfaces instead of vanishing. Unit-tested.

### HR-MEDIUM-005 — no aggregate-only tier (MODULE_MANAGER sees salary, not just headcount)
Resolved in **Wave 7** by making salary visibility a tenant-configurable RBAC
capability rather than a hardcoded role boundary (per the product decision: the tenant
admin decides who sees pay). See the Wave 7 section.

### HR-LOW-001 — backfill `lead`/`chief` precedence misclassifies technical leads
The `laborCategory` backfill ran the MANAGER pattern (`…|lead|chief|…`) before the
TECHNICAL pattern, so a "Lead Technician"/"Chief Engineer" (a craft role) was locked to
MANAGER. The `senior`-token mechanism the review hypothesised does not exist. The
migration already ran in production (immutable), so the fix is a conservative,
idempotent corrective migration that reclassifies `manager` rows whose position matches
a craft noun but **no** genuine management token → `technical`; the shared classifier
ordering is corrected so any future use is right. Analytics-only, no payroll/tax effect.

## Wave 7 — HR salary visibility as a tenant-configurable RBAC capability (HR-MEDIUM-005, implemented)

Rather than hardcode "manager sees / admin doesn't", salary visibility is now a
granular permission the tenant admin assigns. Root-cause architectural fix wired into
the platform's existing tenant-RBAC system (`@RequireTenantPermission` +
`TenantPermissionGuard` + tenant-role editor):

- **New capability** `hr_finance:view_salary` added to the RBAC catalogue SSoT
  (`PERMISSION_CATEGORIES` in `tenant-role.service.ts`) — the tenant-admin role editor,
  token minting, and the guard all pick it up automatically. SUPER/TENANT_ADMIN bypass;
  any other role sees salary only if the tenant admin grants it.
- **Read model split by sensitivity (tier-1, make-it-impossible):** a new headcount-only
  `hrPersonnelTable` query (MANAGER+ADMIN, no salary) backs the Personnel Table, while
  the salary-bearing `hrLabourCost` is guarded by `hr_finance:view_salary`. The
  `hrFinanceSummary` withholds per-department salary **and** the aggregate `payrollGross`
  trend unless the caller holds the capability (expenses + headcount stay visible).
- **Frontend** mirrors it with `useAuth().hasPermission('hr_finance:view_salary')`: the
  Salaries/Labour-Cost tabs show a "salary is restricted" panel and the charts hide the
  payroll/salary series for a manager without the grant — the Personnel Table and
  expenses remain. `useHrLabourCost` is `enabled` only when permitted (no 403 fetch).

This closes the finding coherently with the payroll-manager design: a manager who runs
payroll can be granted `hr_finance:view_salary`; one who shouldn't see pay is not — the
tenant decides, and small-cell suppression (HR-HIGH-003) still applies on top.

## Wave 8 — finance read-model cache (PERF-HIGH-004, implemented)

`financeSummary` / `financeBatchTotals` re-aggregated the high-frequency
feeding/harvest/health/work-order source tables on **every** load (cost grows with
tenant age). Fix: read-through Redis caching via the platform `@Cacheable` /
`@CacheEvict` SSoT (`apps/farm-service/src/common/cache`), keyed per
(tenant, period, granularity):

- The two heavy aggregations are `@Cacheable` (TTL 300 s), so a repeated dashboard
  load re-aggregates at most once per TTL instead of every request.
- **Every** finance mutation (entry create/update/delete, category
  create/update/archive/restore, settings) carries `@CacheEvict` for both cached
  prefixes, so a finance-tab write is **never** stale — this matches the Wave 3b FE
  scoped invalidation exactly (the FE invalidates the same queries a finance mutation
  moves). A metadata invariant (`finance-cache-metadata.spec`) locks the contract: a
  future mutation added without an evict, or a new cached prefix left un-evicted, fails
  at build time — the classic stale-cache regression is made detectable (tier-3).
- Cross-domain cost writes (a feeding cost, a work-order cost) that don't go through a
  finance mutation surface within the TTL — bounded, documented staleness that is
  acceptable for an analytics dashboard (not a transactional ledger). The
  `SloFinanceQueryP99High` tripwire (`PERF-MEDIUM-010`) still fires if a tenant outgrows
  even the cached path, at which point the materialized-rollup escalation is warranted.

> Sub-TTL cross-domain freshness (a feeding-cost edit reflected in the finance summary
> in <300 s) would additionally require finance-relevant domain events on the
> maintenance + fish-health write paths (which today emit none) feeding a per-tenant
> cache-epoch bump. That is a pure refinement of freshness, not a correctness gap — the
> cache is never wrong, only bounded-stale for cross-domain writes — so it is noted, not
> blocking.

## Wave 9 — platform Decimal money wire scalar (DATA-MEDIUM-009, additive coexistence — in progress)

Per ADR-0004 this is a platform-wide Shared-Kernel change executed as an **additive
coexistence** migration (add a `Decimal`-scalar field alongside each `Float` money
field → migrate consumers → remove `Float` after the window), co-owned by
billing-expert + data-expert.

**Wave 9a — foundation (landed).** The ADR-named deliverable
`libs/backend-common/src/graphql/decimal.scalar.ts`: the Shared-Kernel `Decimal`
scalar that serialises a resolver's number / `Decimal.js` / string to an EXACT decimal
STRING (no IEEE-754 loss), wire-only (the DB axis is untouched). Unit-tested (10 cases
incl. exact fixed-scale money). Subpath alias `@aquaculture/backend-common/graphql`. FE
`formatCurrency` now accepts `number | string` via a new `parseMoney()` helper, so a
call site can migrate to a Decimal-scalar field without breaking display/arithmetic
during the window.

**Wave 9b+ — per-field rollout (continuing).** Add the parallel `Decimal` fields
alongside the ~65 `Float` money fields (billing ~35, farm finance + operational,
hr finance + payroll) and migrate the ~115 FE consumers, domain by domain; `Float`
removal is the post-coexistence step. This is the large mechanical sweep ADR-0004
scopes to billing-expert + data-expert; the billing portion touches **live** invoices /
payments, so it is migrated with the same additive-then-remove discipline rather than a
one-shot flip. The finance-domain adoption is the reference implementation for that
rollout.

## Tracked debt (owner + deadline — NOT fixed this cycle)

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
