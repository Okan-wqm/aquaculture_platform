# Runbook — admin-api SLO alerts

**Rules:** `infrastructure/monitoring/droplet/rules/70-admin-api-slo.yml`

These four are admin-api-_specific_. The fleet-wide baseline
(`10-service-health.yml`, `20-latency.yml`) already covers admin-api for
ServiceDown, HighErrorRate, CriticalErrorRate, HighLatency and CriticalLatency,
because those rules select `namespace="aquaculture"` and group `by (app)`. If
one of those is firing too, treat it as the primary signal and read its own
runbook first.

---

## AdminApiWriteLatencyP99High (warning)

**Meaning.** p99 latency of admin-api POST/PUT/PATCH/DELETE has been above 2s for
10 minutes. Reads are excluded on purpose: the dashboard polls hard enough to
hide a slow mutation inside a fleet-wide p95.

**First actions:**

1. Which route? `topk(5, histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{app="admin-api-service",method=~"POST|PUT|PATCH|DELETE"}[5m])) by (le, route)))`
2. Is it a NATS round trip? admin-api delegates every tenant lifecycle mutation
   and every billing command over request/reply. Check the target service's own
   latency (auth-service, billing-service) before looking at admin-api itself.
3. Is it the pool? Check **AdminApiSaturated** and `pg_stat_activity` — admin-api
   reads across `admin`, `auth`, `billing`, `shared` and per-tenant schemas on a
   single 40-connection pool.

**Likely causes:** a slow subgraph behind a NATS command; an unindexed analytics
query on the same pool (`getFinancialMetrics` materialises every active
subscription into Node); pool contention with the dashboard's own reads.

---

## AdminApiAuthzDenialSpike (warning)

**Meaning.** admin-api has returned more than 1 rps of 401/403 for 10 minutes,
with real traffic present.

admin-api is a directly-reachable auth boundary: production nginx routes `/api/`
straight to it, bypassing gateway-api's guard. A denial burst here is one of two
things and they need opposite responses.

**First actions:**

1. **Did we just deploy?** A broken guard chain denies legitimate operators.
   Check the deploy time against the alert's start; if they match, roll back
   before investigating.
2. **If not, it is traffic.** Group by route and look at the access log:
   `sum by (route) (rate(http_requests_total{app="admin-api-service",status_code=~"40[13]"}[5m]))`.
   A single route with a single source is credential stuffing against the
   platform-admin surface.
3. Cross-check `admin.security_events` — the login stream now feeds the
   detectors (ADMIN-HIGH-014), so a real attempt should also have produced a
   `brute_force_attempt` row.

**Escalation:** a sustained denial burst on `/auth/*` with no deploy is a
security incident, not a performance one. Page security on-call.

---

## AdminApiSaturated (warning)

**Meaning.** More than 50 requests have been in flight concurrently for 5
minutes.

In-flight count climbs before p99 does, so this is the early signal for the same
condition **AdminApiWriteLatencyP99High** reports late.

**First actions:**

1. `SELECT count(*), state FROM pg_stat_activity WHERE application_name LIKE 'admin%' GROUP BY state;`
   — if `idle in transaction` is non-trivial, a handler is holding a connection.
2. Is a dashboard on a short refresh multiplying one operator into many requests?
   Check `sum by (route) (rate(http_requests_total{app="admin-api-service"}[1m]))`.
3. Is the process CPU-bound? `docker stats aqua-admin-api-service --no-stream`.
   The analytics read path sums MRR in a JS loop over every active subscription.

---

## AdminApiTenantProvisioningStalled (critical)

**Meaning.** The oldest active tenant provisioning run has been going for more
than 30 minutes.

This is the alert with no error behind it. A run that never reaches a terminal
state returns nothing to any 5xx rate; the tenant is simply half-created, and the
first anyone hears of it is a support ticket.

**First actions:**

1. Find it:
   `SELECT id, "tenantId", status, "createdAt", "updatedAt" FROM admin.tenant_provisioning_runs WHERE status NOT IN ('COMPLETED','FAILED') ORDER BY "createdAt";`
2. Which step? `SELECT * FROM admin.tenant_provisioning_steps WHERE "runId" = '<id>' ORDER BY "createdAt";`
   and `tenant_provisioning_step_failures_total{step}` for the pattern across runs.
3. Did a service fail to acknowledge? `SELECT * FROM admin.tenant_onboarding_acks WHERE "operationId" = '<operationId>';`
   — every participating service records an ACK or a FAILED there.
4. Is the broker healthy? Provisioning is a NATS saga; if the bus is down the
   run cannot progress and no step fails either.

**Escalation:** a stalled run blocks the customer it belongs to. If step 3 shows
a service that never acked, restart that service and re-drive the run rather
than creating a second tenant.
