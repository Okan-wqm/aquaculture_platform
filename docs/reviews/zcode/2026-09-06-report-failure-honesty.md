# A report of zero is not a failed report — 2026-09-06

Reviewer: zcode. Cycle: `2026-09-05-branch-sweep`. Target: `origin/main` @ `3f06a9919`.

Second slice re-derived from `claude/admin-panel-e2e-audit-9b80i5`. Both findings below were
verified still live on main before anything was changed; the branch itself stays unmerged (1001
commits behind, 95 conflicting files).

## ADMIN-HIGH-098 — a failed read answered with a zeroed 200, and it was cached

**Severity:** HIGH. **Owner:** chart-widget-auditor. **State:** IN-PROGRESS.

**Evidence.** Three generators in `apps/admin-api-service/src/analytics/services/reports.service.ts`
— revenue, payments and system performance — caught every failure and returned a structurally valid
report of zero:

```ts
} catch (error) {
  this.logger.error(`Failed to generate revenue report: ${(error as Error).message}`);
  return { data: [], summary: { totalRevenue: 0, …, error: 'Failed to generate revenue report' } };
}
```

Three things make this worse than it first reads:

1. **The `error` marker is inert.** Nothing in the repository reads `summary.error` — the only
   matches anywhere are an unrelated farm-service cleanup summary. So the payload records that it
   failed and then renders as data.
2. **The admin panel's failure state already exists.** `ReportsPage.tsx:437` sets
   "Failed to generate report: …" on a rejected request. It never fired, because the request
   succeeded. The frontend was ready; the backend defeated it.
3. **Two of the three are cached.** `financial_revenue` and `system_performance` run through
   `getCachedOrCompute`, so the zeroed body was written to Redis and served for the 4-hour TTL. One
   transient outage kept reporting zero revenue long after it ended.

An operator reading ₺0 revenue during a database blip cannot distinguish it from a real period that
earned nothing — and may act on it.

**Rule violated.** A report that could not be produced says so; it never answers with a body that
reads as a real measurement of zero.

**Fix.** `reportGenerationFailed` logs the upstream detail and returns an
`InternalServerErrorException` carrying only a safe message, so a driver error cannot reach the
browser. Each of the three catches now throws it. The panel shows the banner it already had, and
`getCachedOrCompute` never sees a value to cache because the compute threw.

**Closure criterion.** Verified in both directions. Three new cases in
`reports-caching.spec.ts` — refuses instead of answering with zeros, keeps the upstream detail out
of the response, and never caches the failure — all three fail against the pre-fix code and pass
after. The third failing on the reverted code is the direct evidence that the zeroed body really
was cached. admin-api-service 60 suites / 958 tests; `type-check` green across 41 projects.

## ADMIN-HIGH-099 — the same report invents the numbers it never measured

**Severity:** HIGH. **Owner:** observability-expert. **State:** OPEN. **Deadline:** 2026-10-04.

**Evidence.** When no snapshot rows exist, the performance report fills the series with constants:

```ts
avgResponseTime: 45,  // Default estimate in ms
errorRate: 0.1,       // Default low error rate
uptime: 99.9,         // Default uptime since we don't track downtime
```

`analytics.service.ts` does the platform-wide version of the same thing: it logs
"System metrics (apiCalls, responseTime, errorRate, uptime) require infrastructure monitoring
integration" and then returns `avgResponseTimeMs: 0 // Requires APM`, `errorRate: 0 // Requires
error tracking`.

This is worse than the zeros ADMIN-HIGH-098 fixed. Zero at least looks like a measurement of
nothing; 99.9% uptime and a 45ms response time actively assert that the system is healthy, on the
one screen an operator consults to find out whether it is.

**Rule violated.** An unmeasured metric is representable as unmeasured, and never rendered as a
number nobody produced.

**Why it is not in this slice.** The correct fix is a nullable measured-metric contract —
`number | null` rendered as "—" — which changes `analytics-snapshot.entity.ts`, both analytics
services, the report DTOs and the admin-panel rendering. Landing half of it (say, only the report
generator) would leave `analytics.service` still substituting, so the dashboard and the report would
disagree about the same metric. It needs its own slice and its own review, not a rushed rider on a
failure-handling change.
