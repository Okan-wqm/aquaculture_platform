# multi-tenant-saas-expert — review (CATCHER) — 2026-04-28-core-platform

**Cycle anchor:** `main` HEAD `a958dc66` (clean working tree).
**Mode:** READ-ONLY full audit of cross-cutting tenant contract — auth, tenant
provisioning, isolation, billing — with domain modules (farm, hr, sensor,
messaging, alert-engine) excluded per dispatch.
**Prior cycles re-read:**
`docs/reviews/multi-tenant-saas-expert/2026-04-09-tenant-isolation-exploitability.md`,
`2026-04-10-full-repo-audit.md`,
`docs/reviews/_audit/2026-04-W16-multi-tenant.md`.
**Prior-work rule:** unfixed findings escalate +1 severity per cycle; 3+
recurrences flagged SYSTEMIC.

## Scope

Cross-cutting tenant-contract surfaces, reviewed against the multi-tenant
invariant matrix in `.claude/agents/multi-tenant-saas-expert.md`
§"Domain-specific invariants":

- L1 search-path bootstrap (`libs/backend-common/src/database/tenant-connection-bootstrap.service.ts`).
- L1 app-layer scoped repository (`libs/backend-common/src/database/tenant-scoped-repository.ts`).
- L2 Postgres RLS (`libs/backend-common/src/database/rls/tenant-rls.service.ts` + per-service migrations).
- L3 Redis namespace (`libs/backend-common/src/redis/tenant-redis.service.ts`).
- L4 NATS subject scoping + event flat shape (event-contracts, billing event handler).
- L5 request guard + middleware (`libs/backend-common/src/guards/tenant.guard.ts`,
  `libs/backend-common/src/middleware/tenant-context.middleware.ts`,
  `apps/gateway-api/src/middleware/tenant-context.middleware.ts`).
- Tenant lifecycle (admin-api `tenant-provisioning.service.ts`,
  `provisioning-saga.service.ts`, suspend/archive/purge handlers).
- Plan tier contract — 5 enum sources reconciled.
- Plan-limit enforcement (gateway middleware `PLAN_LIMITS` + per-service
  resource-creation paths).
- Quota / rate-limit / token-budget (ai-service cost services + admin-api
  impersonation).
- Cross-tenant access surface (`X-Act-As-Tenant`, MFA step-up, dual-identity
  audit, session rate-limit).
- GDPR Art 17 cascade (delegated to compliance-expert as
  `COMPLIANCE-CRITICAL-001`; tenant-CONTRACT slice retained here).
- Per-tenant observability / cost attribution + tenant cardinality on hot-path
  metrics.
- Cross-handoff confirmation against this cycle's sibling reviews
  (auth-security-expert, billing-expert, platform-kernel-expert,
  database-reviewer).

## Executive summary

The L1 (search-path bootstrap) and entity-schema-ownership layers continue to
firm up: every reviewed `@Entity()` carrying tenant data declares `schema:`
(MT-CRITICAL-004 from W16 closed); the W2 `_constants.ts` SSoT now exists and
adoption-invariants run on every PR; AI rate-limit and AI token-budget hard-fail
on Redis-missing in production. Beyond those, **the cross-cutting tenant
contract is not converging**:

- **Confirmed CRITICALs unchanged from W16:** `req.query['tenantId']` still
  accepted by the platform middleware (worse than the `x-tenant-id` header it
  sits next to); impersonation rate-limit STILL fail-open while the AI sibling
  fail-closes; `event.payload?.tenantId` flat-event-contract violation on the
  Stripe-PIVOT path still routes Stripe customer creation; per-tenant erasure
  cascade still 1/8 services; `TenantPurged` event still 0 hits.
- **NEW CRITICAL this cycle:** unbounded `tenant` Prometheus label on the
  shared `MetricsMiddleware` sourced from the unauthenticated `x-tenant-id`
  header — confirms PLAT-CRITICAL-001 from platform-kernel-expert and adds the
  tenant-trust-anchor angle (the same query/header bypass class on a different
  surface).
- **NEW CRITICAL this cycle:** `shared.audit_logs` immutability triggers were
  silently destroyed by `1787200000000-RealignSharedAuditLogsSchema` —
  confirms DBR-CRITICAL-001 and adds the cross-tenant audit-integrity angle:
  the impersonation dual-identity audit trail (the only forensic record of
  cross-tenant SUPER_ADMIN actions) is now mutable.
- **HIGH escalations:** PlanTier drift WIDENED to 5 sources (MT-HIGH-003);
  RLS still 2/7 services third cycle; provisioning saga still has no
  `COMPENSABLE | PIVOT | RETRYABLE` classification, no Stripe-PIVOT marker,
  no persisted idempotency record (third cycle); PLAN_LIMITS still enforces
  only `maxUsers`; watchdog still wired in farm-service only.
- **NEW HIGH this cycle:** `auth.users.tenantId` carries no FK to
  `auth.tenants` — confirms DBR-HIGH-002. Tenant-row deletion would orphan
  user rows; no DB-level guarantee that a user's `tenantId` resolves.

Verdict: **BLOCK** on merge of any new tenant-touching surface until the four
listed CRITICALs land. The four HIGH escalations are SYSTEMIC (3+ cycles
unresolved each) and per agent prior-work rule promote to CRITICAL on the
next cycle without progress; recommend `architectural-arbiter` invocation if
any of the four cannot land within two cycles.

## Findings (by severity)

### CRITICAL

#### MT-CRITICAL-001 — `req.query['tenantId']` accepted at backend-common middleware (third cycle unresolved — strictly worse than the `x-tenant-id` header beside it)
**Severity:** CRITICAL
**Layer:** 5 (request-trust-anchor invariant)
**State:** OPEN — third cycle since W16

**Evidence**
- `libs/backend-common/src/middleware/tenant-context.middleware.ts:108-112` —
  ```ts
  const queryTenant = req.query['tenantId'] as string;
  if (queryTenant) {
    return { tenantId: queryTenant, source: 'query' };
  }
  ```
  No UUID validation, no allowlist, no boundary-file scoping. The middleware
  is registered in every service that imports backend-common middleware.
- `libs/backend-common/src/middleware/tenant-context.middleware.ts:328` —
  audit-write fallback `req.tenantId || req.headers['x-tenant-id']` carries
  the same spoofed value into the audit log.
- `apps/gateway-api/src/middleware/tenant-context.middleware.ts:374-399` —
  gateway copy carries a `path-parameter` branch with bare slug acceptance
  on the subdomain branch (no UUID validation; bypasses tenant registry).

**Rule violated**
multi-tenant-saas-expert.md §"Five-layer isolation — L5 guards" — *"`TenantGuard`
reads `tenantId` from JWT `tenantId` claim EXCLUSIVELY. Reading from request
body / query / any header except `X-Act-As-Tenant` for SUPER_ADMIN = CRITICAL
(horizontal escalation)."* CLAUDE.md §Security — *"JWT claims are the trust
anchor when an authenticated user is present."* No clause permits
`?tenantId=` at any callsite.

This is strictly worse than the prior `x-tenant-id` finding because:
1. Query strings appear in browser history, server logs, third-party analytics,
   email forwards.
2. CSRF defenses commonly inspect headers, never query parameters.
3. A subdomain switch followed by `?tenantId=<other>` is a one-click cross-
   tenant entry vector.

The TenantGuard at `libs/backend-common/src/guards/tenant.guard.ts:171-184`
correctly reads only from `req.user.tenantId`, but the middleware runs BEFORE
the guard and writes `req.tenantId` from query. Any downstream code that reads
`req.tenantId` instead of `req.user.tenantId` (the case for several
scoped-repo factory paths via `getRequestContext().tenantId`) inherits the
spoofed value.

**Proposed fix direction**
- Tier 1 (make impossible): Delete the `query`-source branch entirely from
  `libs/backend-common/src/middleware/tenant-context.middleware.ts:108-112`.
  The `header`-source branch should be narrowed to a 3-path allowlist
  (pre-auth login, admin cross-tenant via `X-Act-As-Tenant` only, edge
  ingestion via cert-CN), per the agent invariant.
- Tier 1: Gateway middleware path-param + raw-subdomain branches must
  resolve via `tenantLookupService.resolveBySlug` (or the registry FK)
  before returning a `tenantId`; raw slug acceptance is removed.
- Tier 3: ESLint rule `no-tenant-id-from-request-input` disallowing
  `req.query.tenantId`, `req.body.tenantId`, `req.headers['x-tenant-id']`
  outside the 3 boundary files.
- CI invariant: `tests/invariants/tenant-id-source-discipline.spec.ts` greps
  the codebase for any read of `tenantId` from non-JWT sources outside an
  allowlist.

**Affected surface (ripple set)**
- `libs/backend-common/src/middleware/tenant-context.middleware.ts:95-149`
  (whole `extractTenantContext` function — narrow to JWT + boundary
  subdomains only)
- `libs/backend-common/src/middleware/tenant-context.middleware.ts:328`
  (audit-write fallback — same class, same fix)
- `apps/gateway-api/src/middleware/tenant-context.middleware.ts:355-402`
  (query-string + path-param branches present in the gateway copy too —
  also remove)
- `apps/event-store-service/src/guards/internal-api-key.guard.ts` — verify
  it does not consume `req.query.tenantId`

**Cross-handoff confirmation:** consistent with auth-security-expert
SEC-CRITICAL-002 (StripInternalHeadersMiddleware missing in auth-service) —
both are tenant-trust-anchor vectors. The auth-service strip-middleware gap
combined with the query-tenantId path means a Docker-network attacker can
forge BOTH `x-user-payload` (auth-security primary) and `?tenantId=` on the
same request and end up with a fully-authenticated cross-tenant session.

**Expected closer**
auth-security-expert WRITER (trust-anchor primary). CATCHER must be
multi-tenant-saas-expert (this agent).

#### MT-CRITICAL-002 — Impersonation rate-limit STILL fail-OPEN in production (third cycle — sibling AI rate-limit fixed two cycles ago)
**Severity:** CRITICAL
**Layer:** 2 (pattern) — fail-closed-on-distributed-state
**State:** OPEN — third cycle

**Evidence**
- `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:84-106` —
  ```ts
  @Optional() private readonly redisService?: RedisService,
  ) {
    this.useRedis = !!this.redisService;
    if (!this.useRedis) {
      this.logger.warn(
        'Impersonation rate limiting using in-memory Map — NOT distributed. ' +
        'Multi-instance deployments bypass rate limits.',
      );
    }
  ```
  Constructor logs a warning but DOES NOT THROW.
- `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:163-179` —
  `checkRateLimitLocal` is the in-memory Map fallback path, still active.
- Compare `apps/ai-service/src/cost/rate-limit.service.ts:32-42` — sibling
  fix lands the production fail-closed hard-fail
  (`throw new Error('CRITICAL: AI rate limiting requires Redis in production')`).
- Compare `apps/ai-service/src/cost/token-budget.service.ts:32-39` — same
  fail-closed pattern.

**Rule violated**
multi-tenant-saas-expert.md §"Per-tenant quota & noisy-neighbor isolation" —
*"Fail-CLOSED on Redis outage for billable / auth / impersonation / quota
endpoints — fail-open = CRITICAL"*. Impersonation is the highest-trust
cross-tenant surface in the platform; a Redis blip allows brute-force past
the 5/5min lock on every multi-instance fleet instance.

The architectural decision was already validated and shipped on the AI sibling
two cycles ago — this is not a design question, it is a code-migration debt
on a known pattern.

**Proposed fix direction**
- Tier 1 (make impossible): move the production-gate into the constructor of
  `ImpersonationService` mirroring `RateLimitService:36-42`. Hard-fail bootstrap
  when `NODE_ENV==='production'` and `RedisService` is not injected. Copy the
  shape verbatim.
- Tier 1: remove `localRateLimitMap`, `checkRateLimitLocal`, and
  `cleanupRateLimitMap` entirely. Production must not have an in-memory
  fallback path at all.
- Tier 3: CI invariant `tests/invariants/redis-required-services.spec.ts`
  enumerating services where `RedisService` is `@Optional()` + checking that
  production fail-closed branch exists and a default in-memory path does not.

**Affected surface (ripple set)**
- `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:74-106`
  (constructor + Map declarations)
- `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:148-191`
  (`checkRateLimitLocal` + `cleanupRateLimitMap` — remove entirely on fail-closed)
- `apps/admin-api-service/src/impersonation/impersonation.module.ts`
  (RedisModule must be required, not optional, in production)

**Expected closer**
multi-tenant-saas-expert WRITER (or auth-security-expert; sibling-domain
rate-limit primitive). Pair-review CATCHER must be auth-security-expert.

#### MT-CRITICAL-003 — `event.payload?.…` nested-wrapper read in billing subscription event handler (ADR-006 violation on the Stripe-PIVOT path)
**Severity:** CRITICAL
**Layer:** 3 (ADR-006 — flat event pattern)
**State:** OPEN

**Evidence**
- `apps/billing-service/src/billing/event-handlers/tenant-subscription-requested.handler.ts:189-197` —
  every field reads
  `event.tenantId || event.payload?.tenantId`,
  `event.tier || event.payload?.tier`, etc.
- Same anti-pattern at `:494,522,564,581-582` inside the retry loop.
- The handler routes the resulting `tenantId` into Stripe customer + subscription
  creation; this is the saga's PIVOT step.

**Rule violated**
ADR-006 (layer-3) — *"Events are flat objects. No nested `payload` / `metadata`
wrappers."* The `|| event.payload?.X` fallback CONFIRMS that historical events
were emitted with the wrapper shape and the consumer chose to silently ABSORB
both formats instead of refusing them. This is the fail-open variant of an
event-contract drift: the consumer accepts whichever shape it gets, defeating
the upcaster pipeline (ADR-006 §Versioning).

A tenant-mismatch between `event.tenantId` and `event.payload.tenantId`
(legacy + new shape on the same wire) routes a Stripe customer creation to the
wrong tenant. Combined with MT-HIGH-002 (saga has no PIVOT classification
and no Stripe-void verification), the consequence is **orphan billing on the
wrong tenant** with no automated reconciliation.

**Proposed fix direction**
- Tier 1: remove every `event.payload?.X` fallback and rely exclusively on
  the flat shape. Require the publisher (admin-api `tenant-provisioning.service.ts`
  or whichever emits `TenantSubscriptionRequested`) to emit the flat shape —
  already enforced by `createBaseEvent<T>()` for new code.
- Tier 3: ship the upcaster for the historical shape if v1 ever existed
  (`libs/event-contracts/src/upcasters/tenant-subscription-requested-v1-to-v2.ts`).
  The W6 upcaster-chain invariant test (`tests/invariants/upcaster-chain.spec.ts`)
  catches missing upcasters; verify it covers this event.
- ESLint: ban `event.payload` accessor on objects extending `BaseEvent` outside
  `event-store-service` (the documented boundary file for polymorphic JSON
  storage).

**Affected surface (ripple set)**
- `apps/billing-service/src/billing/event-handlers/tenant-subscription-requested.handler.ts:189-197,494,522,564,581-582`
- `libs/event-contracts/src/billing-events.ts` or wherever
  `TenantSubscriptionRequested` is defined (verify flat shape; add upcaster
  if v1 used wrapper)
- Search `apps/event-store-service/src/event-store/services/event-store.service.ts`
  for legitimate boundary use of `payload:` storage column

**Expected closer**
data-expert (event-contract authority) WRITER. CATCHER must be
platform-services or messaging-expert.

#### MT-CRITICAL-004 — Unbounded `tenant` Prometheus label on shared `MetricsMiddleware` sourced from raw `x-tenant-id` header (cardinality DoS + tenant spoof on telemetry)
**Severity:** CRITICAL (NEW this cycle — confirms platform-kernel-expert PLAT-CRITICAL-001 from the tenant-trust-anchor angle)
**Layer:** 1 (kernel) + 5 (trust-anchor)
**State:** OPEN

**Evidence**
- `libs/backend-common/src/metrics/metrics.service.ts:60,68` — `httpRequestDuration`
  and `httpRequestsTotal` declare `labelNames: ['method','route','status_code','tenant']`.
- `libs/backend-common/src/metrics/metrics.middleware.ts:41-44` — tenant label
  is sourced as
  ```ts
  const tenantId =
    (req as Request & { tenantId?: string }).tenantId
    || (req.headers['x-tenant-id'] as string | undefined)
    || 'system';
  ```
  No JWT trust anchor, no UUID validation, no tenant-registry lookup. The
  `x-tenant-id` header is read from the raw request before any authentication
  guard fires.
- Adopters: `apps/gateway-api/src/app.module.ts:662`,
  `apps/auth-service/src/app.module.ts:334`,
  `apps/sensor-service/src/app.module.ts:412`.
- `metrics.service.ts:111` carries a doc comment claiming "Platform targets
  ~100 tenants max" — a monitoring assumption defeated by the unauthenticated
  sourcing path. Any external caller can emit unique header values to inflate
  cardinality unboundedly.

**Rule violated**
multi-tenant-saas-expert.md §"Per-tenant observability & cost attribution" —
*"Hot-path metrics EXCLUDE `tenant_id` label — per-tenant breakdown via logs/
traces/exemplars, not Prometheus labels. Hot metric with `tenant_id` = HIGH
(cardinality blowup O(tenants × endpoints × status × method)). ... Metric-
label validation: any `tenant_id` value emitted MUST be registry-validated
(prevents cardinality DoS / forgery) — unvalidated = CRITICAL."* This is the
NEGATION of the rule on TWO axes: the label is on the hottest metrics in the
fleet, AND its value is sourced from an unvalidated header.

The same `x-tenant-id`-from-raw-headers pattern that this agent has flagged
for trust-anchor reasons (MT-CRITICAL-001 above and prior MT-MEDIUM-003) is
ALSO being used to populate Prometheus labels. The same fix class applies to
both — the header is not a valid input for trust-bearing fields.

**Proposed fix direction**
- Tier 1 (make impossible): remove the `tenant` label from
  `libs/backend-common/src/metrics/metrics.service.ts:60,68`. Per-tenant
  attribution belongs in a non-Prometheus telemetry sink (TimescaleDB
  hypertable, OTel attribute on traces, structured log exemplar) — exactly
  as `orchestrator-metrics.ts` already documents for the agent telemetry plane
  (which already BANS `tenant_id` labels).
- Tier 3: extend the existing `no-high-cardinality-metric-label` ESLint rule
  (referenced in `orchestrator-metrics.ts` docblock) to reject any metric
  declaration in `libs/backend-common/src/metrics/**` with a label named
  `tenant` / `tenantId` / `tenant_id`.
- If per-tenant cost reporting is genuinely needed, expose it via the bounded-
  cardinality slow-moving allowlist (`tenant_info`, `tenant_storage_used_bytes`,
  `top_n_*{rank, tenant_id}` with rank ≤ 20) per the agent invariant.

**Affected surface (ripple set)**
- `libs/backend-common/src/metrics/metrics.service.ts` (declarations)
- `libs/backend-common/src/metrics/metrics.middleware.ts` (label-source path)
- `apps/gateway-api/src/app.module.ts`,
  `apps/auth-service/src/app.module.ts`,
  `apps/sensor-service/src/app.module.ts` (callers do not change but
  Grafana panels segmented on `tenant` will need migration)
- Any Grafana dashboard or alert rule that selects on `{tenant=...}` label

**Cross-handoff confirmation:** confirms platform-kernel-expert
PLAT-CRITICAL-001 verbatim. The platform-kernel-expert finding catches the
cardinality angle; this finding adds the tenant-trust-anchor angle (a third
unauthenticated-`x-tenant-id` reader on the platform). Pair-review on the
fix MUST include both agents.

**Expected closer**
platform-kernel-expert WRITER (kernel primary). CATCHER must be
multi-tenant-saas-expert + auth-security-expert.

#### MT-CRITICAL-005 — `shared.audit_logs` immutability triggers silently destroyed by realign migration; cross-tenant impersonation audit trail is now mutable
**Severity:** CRITICAL (NEW this cycle — confirms database-reviewer DBR-CRITICAL-001 from the cross-tenant-audit-integrity angle)
**Layer:** 2 (pattern — audit immutability) + 3 (ADR — impersonation forensics)
**State:** OPEN

**Evidence**
- `apps/admin-api-service/src/migrations/1782000000000-AuditLogImmutability.ts:41-58,62-83` —
  installs `audit_logs_prevent_update` + `audit_logs_prevent_legal_hold_delete`
  triggers on `audit_logs`.
- `apps/admin-api-service/src/migrations/1787200000000-RealignSharedAuditLogsSchema.ts:172-202` —
  ```sql
  DROP TABLE shared.audit_logs CASCADE;
  ...
  CREATE TABLE shared.audit_logs ( ... )
  ```
  CASCADE drop wipes the triggers. The recreated table has NO trigger
  declarations and the migration does NOT re-install them.
- The impersonation flow (`apps/admin-api-service/src/impersonation/services/impersonation.service.ts:91 + audit-log.service.ts`)
  writes the dual-identity audit row to `shared.audit_logs`. With triggers
  gone, an attacker (or insider) with `UPDATE shared.audit_logs` privilege
  can rewrite the `actor_user_id` / `acted_on_tenant_id` / `justification`
  fields after the fact, defeating tamper-evidence.

**Rule violated**
multi-tenant-saas-expert.md §"Cross-tenant access & impersonation" —
*"Dual-identity audit on every action during an active impersonation session
... single-identity row = CRITICAL. `recordAwait()` AWAITED before request
proceeds — fire-and-forget audit = CRITICAL."* The implicit corollary of an
"audit-trail" guarantee is that the rows are tamper-evident. With UPDATE no
longer rejected by trigger, the dual-identity audit becomes a soft promise.

**Proposed fix direction**
- Tier 1: re-install both triggers in
  `1787200000000-RealignSharedAuditLogsSchema` immediately after the new
  `CREATE TABLE` (lines 197 and 232 are the natural insertion points, before
  the per-role grants).
- Tier 3: invariant test
  `tests/invariants/audit-immutability-triggers-present.spec.ts` that connects
  to the live test database and asserts both `trg_audit_logs_prevent_update`
  and `trg_audit_logs_prevent_legal_hold_delete` exist on `shared.audit_logs`
  AND are enabled (`pg_trigger.tgenabled = 'O'`). Fails CI loud if any future
  migration drops without re-installing.
- Forward-only restoration migration emitting both triggers; do NOT mutate
  the historical migration (operators may already have applied it).

**Affected surface (ripple set)**
- New migration: `apps/admin-api-service/src/migrations/<ts>-ReinstateAuditLogImmutabilityTriggers.ts`
- `tests/invariants/audit-immutability-triggers-present.spec.ts` (new)
- `libs/backend-common/src/audit/**` — verify no application code attempts
  UPDATE on `shared.audit_logs` (it should not; the triggers raise EXCEPTION
  but app code should not even try)

**Cross-handoff confirmation:** confirms database-reviewer DBR-CRITICAL-001
verbatim. database-reviewer owns the SQL-level fix; this agent owns the
cross-tenant-audit-integrity angle (impersonation surface). Pair-review on
the fix MUST include both agents + auth-security-expert (audit-trail
tamper-evidence is a security guarantee per their contract).

**Expected closer**
data-expert (migration author primary) + database-reviewer (CATCHER) +
multi-tenant-saas-expert (CATCHER for impersonation-audit slice).

### HIGH

#### MT-HIGH-001 — GDPR Art 17 erasure cascade implemented in 1/8 tenant-data-holding services; `TenantPurged` still 0 hits
**Severity:** HIGH (this agent retains the tenant-CONTRACT slice; severity for compliance-expert remains CRITICAL on their side as `COMPLIANCE-CRITICAL-001`)
**Layer:** 3 (ADR — GDPR Art 17 contract)
**State:** OPEN — PARTIAL since W16

**Evidence**
- `apps/farm-service/src/compliance/services/tenant-erasure.service.ts` —
  full implementation, emits `TenantErased` to outbox.
- `apps/observability-service/src/gdpr/handlers/erase-observability-tenant-data.handler.ts` —
  single downstream consumer.
- `libs/event-contracts/src/tenant-events.ts:85-100` —
  `TenantErasedEvent` contract present.
- 0 grep hits for `TenantErased`, `eraseTenantData`, or
  `@EventsHandler(TenantErased)` in: sensor-service, hr-service,
  messaging-service, hydroponics-service, alert-engine, ai-service,
  billing-service, notification-service, auth-service, admin-api-service.
- 0 grep hits for `TenantPurged` ANYWHERE in the repo (no event contract,
  no handler, no audit emit).

**Rule violated**
multi-tenant-saas-expert.md §"Tenant lifecycle saga" — *"PURGED requires
hash-signed `TenantPurged { tenantIdHash, purgedAt, operatorId, method,
schemaDropped, stripeSubscriptionVoided }` audit event — missing = CRITICAL."*
multi-tenant-saas-expert.md §"Tenant data portability & GDPR Art 17/20" §"Erasure" —
*"Every tenant-data-holding service ... MUST expose an `eraseTenantData(tenantId,
{ dryRun })` handler. Missing any service from fan-out = CRITICAL."*

**Proposed fix direction**
- Tier 1: define `TenantPurgedEvent` in `libs/event-contracts/src/tenant-events.ts`
  with the exact fields specified in the agent invariant; require the admin-api
  purge endpoint to emit it.
- Tier 3: CI invariant under `tests/invariants/` (already has
  `_constants.PER_TENANT_SCHEMA_SERVICES`) asserting every entry has both an
  `eraseTenantData` handler and a `TenantErased` event consumer.
- billing-service is the **legal-hold sentinel**: a tenant with active legal
  hold MUST refuse the purge. Add a `legal_hold` boolean to `auth.tenants`
  checked at the saga PIVOT before purge proceeds.

**Affected surface (ripple set)**
- 9 missing handler stubs across the 9 services listed above.
- `libs/event-contracts/src/tenant-events.ts` (add `TenantPurgedEvent`).
- `apps/admin-api-service/src/tenant/handlers/suspend-tenant.handler.ts:347` —
  currently emits `TenantArchived` only; hand off to a future
  `purge-tenant.handler.ts` that emits `TenantPurged`.
- `tests/invariants/tenant-erasure-handler-coverage.spec.ts` (new — proposed name).

**Expected closer**
compliance-expert primary; this agent's tenant-CONTRACT slice (path
derivation from JWT, schema-name validation, cross-tenant guard on the
export endpoint) reviewed in the same PR.

#### MT-HIGH-002 — Provisioning saga still has no `COMPENSABLE | PIVOT | RETRYABLE` classification, no Stripe-PIVOT marker, no persisted idempotency record (third cycle)
**Severity:** HIGH — third cycle unresolved → escalates to CRITICAL on next cycle
**Layer:** 2 (pattern — saga compensation contract)
**State:** OPEN

**Evidence**
- `apps/admin-api-service/src/tenant/services/provisioning-saga.service.ts:6-15` —
  `SagaStep` has only `name`, `status`, `duration`, `error`. No `kind`
  discriminator.
- `:35-39` — `InternalStep { name, execute, compensate }`. No
  `kind: 'COMPENSABLE'|'PIVOT'|'RETRYABLE'`.
- `:59-62` — `private readonly steps: InternalStep[] = []; private executed = false;` —
  saga state is in-memory; on process restart mid-saga, all step state is
  lost.
- `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts:188` —
  `const saga = new ProvisioningSagaService();` instantiated per request.
  No `admin.saga_executions` table writes.

**Rule violated**
multi-tenant-saas-expert.md §"Tenant lifecycle saga" — *"Every step classified
`COMPENSABLE | PIVOT | RETRYABLE` with persisted idempotency key
`(tenant_id, step_name, status, output)`. Unclassified step or missing
idempotency key = HIGH (in-flight tenant stranded on restart). The PIVOT
step is Stripe subscription creation — pre-pivot failures compensate
backward, post-pivot failures retry-forward. Compensation MUST void the
Stripe subscription AND verify the void succeeded before marking the saga
failed (missing verification = CRITICAL, orphan billing)."*

The current saga has no notion of where the PIVOT lives. If the Stripe
subscription creation step succeeded but the next step fails, the
compensation chain runs in reverse and would attempt to void the Stripe
subscription — but there is NO verification that the void succeeded. Orphan
billing risk live.

**Proposed fix direction**
- Tier 1: add `kind: 'COMPENSABLE'|'PIVOT'|'RETRYABLE'` to `InternalStep`.
  The compensation algorithm switches on `kind`: pre-PIVOT steps unwind
  backward, post-PIVOT steps retry forward, PIVOT itself uses two-phase
  commit (reserve, then confirm or revert).
- Tier 1: persist saga state. Schema
  `admin.saga_executions(saga_id uuid, tenant_id uuid, step_name text,
  kind text, status text, input_json jsonb, output_json jsonb,
  idempotency_key text, started_at timestamptz, completed_at timestamptz,
  PRIMARY KEY (saga_id, step_name))`. On reboot, the orchestrator scans for
  `status='IN_PROGRESS'` rows and resumes.
- Verify Stripe void: after compensation calls `stripe.subscriptions.del(subId)`,
  re-read via `stripe.subscriptions.retrieve(subId)` and assert
  `status==='canceled'`.

**Affected surface (ripple set)**
- `apps/admin-api-service/src/tenant/services/provisioning-saga.service.ts`
  (whole file refactor)
- `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts:188`
  (saga construction + Stripe step classification)
- New migration: `apps/admin-api-service/src/migrations/<ts>-CreateSagaExecutionsTable.ts`
- `apps/admin-api-service/src/tenant/__tests__/tenant-provisioning.service.spec.ts`
  (saga-resume-on-restart tests)

**Expected closer**
multi-tenant-saas-expert WRITER (saga is tenant-lifecycle primary). CATCHER
must be billing-expert (Stripe PIVOT) + auth-security-expert (compensation
security).

#### MT-HIGH-003 — PlanTier enum drift now FIVE independent definitions; second SSoT introduced rather than consolidated
**Severity:** HIGH (escalated +1 from W16 MT-HIGH-006; drift WIDENED — `libs/shared-contracts/src/enums/plan-tier.enum.ts` introduced as a 6-valued enum that does not align with any of the existing 4 variants)
**Layer:** 3 (ADR-006 — single-source-of-truth event contract)
**State:** OPEN

**Evidence (5 distinct definitions, all drifted)**
1. `libs/event-contracts/src/base-event.ts:121` —
   `export type PlanTier = 'starter' | 'professional' | 'enterprise';` — 3
   values, no FREE/TRIAL/CUSTOM.
2. `libs/shared-contracts/src/enums/plan-tier.enum.ts:16-37` —
   `enum PlanTier { FREE='free', TRIAL='trial', STARTER='starter',
   PROFESSIONAL='professional', ENTERPRISE='enterprise', CUSTOM='custom' }` —
   6 values. **Doc-comment ADMITS** the drift in lines 7-13.
3. `apps/billing-service/src/billing/entities/subscription.entity.ts:32-37` —
   `enum PlanTier { STARTER, PROFESSIONAL, ENTERPRISE, CUSTOM }` — 4 values,
   no FREE/TRIAL.
4. `apps/admin-api-service/src/tenant/entities/tenant.entity.ts:20-26` —
   `enum TenantPlan { FREE, TRIAL, STARTER, PROFESSIONAL, ENTERPRISE }` — 5
   values, no CUSTOM.
5. `apps/auth-service/src/modules/tenant/entities/tenant.entity.ts:15-20` —
   `enum TenantPlan { TRIAL, STARTER, PROFESSIONAL, ENTERPRISE }` — 4 values,
   no FREE/CUSTOM.

**Rule violated**
multi-tenant-saas-expert.md §"Plan tier & module gating" — *"Plan tier is a
strictly-ordered integer-level enum: STARTER(1) < PROFESSIONAL(2) <
ENTERPRISE(3) < CUSTOM(4). Feature checks MUST use
`tenant.planLevel >= feature.requiredPlanLevel` — strict equality = CRITICAL."*
No code in the repo computes ordinal levels — every gate is string equality
(W16 MT-HIGH-007 rolled into this finding for this cycle).

A tenant on `TRIAL` (admin-api) is unrecognised at the gateway
(`base-event.ts` only knows starter/professional/enterprise) so a feature
gate written `plan === 'trial'` in admin-api correctly fires, but the same
gate at the gateway (`PLAN_FEATURES['trial']`,
`apps/gateway-api/src/middleware/tenant-context.middleware.ts:142-151`)
silently returns the trial featureset because the gateway middleware DOES
define a `trial` row — meaning the gateway and event-contract layers
disagree about whether `trial` is a valid PlanTier.

The W16 audit recommended `libs/event-contracts/src/base-event.ts` as the
SSoT. Instead, a second SSoT (`libs/shared-contracts/src/enums/plan-tier.enum.ts`)
was created — duplicating rather than consolidating. **Two competing SSoTs
is the worst possible outcome.**

**Proposed fix direction**
- Tier 1 — pick exactly ONE SSoT:
  - Recommended: `libs/event-contracts/src/base-event.ts` widens to
    `'free'|'trial'|'starter'|'professional'|'enterprise'|'custom'`
    (matches `shared-contracts` and the gateway middleware features).
  - Add
    `export const PLAN_LEVEL: Record<PlanTier, number> = { free:0, trial:0, starter:1, professional:2, enterprise:3, custom:4 }`.
  - Export `canAccess(tenantPlan, requiredPlan)` helper that returns
    `PLAN_LEVEL[tenantPlan] >= PLAN_LEVEL[requiredPlan]`.
- Tier 3: delete `libs/shared-contracts/src/enums/plan-tier.enum.ts`;
  re-export from `event-contracts`. The duplicated enum is the SSoT-drift
  driver. ESLint rule `no-plantier-redefinition` blocks new local enum
  declarations.
- Migrate every consumer in items 3-5 above to import from
  `@platform/event-contracts`.

**Affected surface (ripple set)**
- The 5 files listed above + every consumer (≥ 30 files via grep on
  `PlanTier|TenantPlan`).
- `libs/event-contracts/src/index.ts` (export the new ordinal map + helper)
- `apps/billing-service/src/billing/entities/subscription.entity.ts`
  (`@Column enum:`)
- `apps/admin-api-service/src/tenant/entities/tenant.entity.ts` (storage
  migration may be needed if FREE rows exist; verify and stage blue-green if so)
- `apps/auth-service/src/modules/tenant/entities/tenant.entity.ts` (same)

**Cross-handoff confirmation:** consistent with database-reviewer DBR-HIGH-003
(TenantPlan enum drift across DB columns).

**Expected closer**
data-expert (event-contracts owner). CATCHER must be billing-expert +
multi-tenant-saas-expert.

#### MT-HIGH-004 — `PLAN_LIMITS` advertised but unenforced beyond `maxUsers` (third cycle unresolved; billing-expert escalated to BILLING-CRITICAL-002)
**Severity:** HIGH from this agent (multi-tenant tenant-CONTRACT slice). The same surface is BILLING-CRITICAL-002 from billing-expert, who is the per-tier-cap enforcement primary. Severity differs deliberately: billing-expert holds the dollar-impact CRITICAL; this agent holds the tenant-contract-shape HIGH on the same surface.
**Layer:** 4 (doc only — runtime gate missing)
**State:** OPEN

**Evidence**
- `apps/gateway-api/src/middleware/tenant-context.middleware.ts:187-233` —
  `PLAN_LIMITS` table.
- `apps/gateway-api/src/services/tenant-lookup.service.ts:109-155` — duplicate
  `PLAN_LIMITS` table (now defined twice with risk of further drift).
- `apps/billing-service/src/billing/dto/create-subscription.input.ts:22-32` —
  `maxFarms`, `maxPonds`, `maxSensors` fields exist on the subscription DTO.
- `apps/billing-service/src/billing/seed/plan-seed.service.ts:39-41,74-76,112-114` —
  limits populated in plan seeds.
- 0 grep hits for any read of `tenant.limits.maxFarms`,
  `subscription.limits.maxPonds`, `subscription.limits.maxSensors`,
  `subscription.limits.maxStorageGb`, or `subscription.limits.maxApiRequests`
  from any **resource-creation command handler** (CreateFarm, CreatePond,
  CreateSensor, …). Only `auth-service` enforces `maxUsers`.

**Rule violated**
multi-tenant-saas-expert.md §"Plan tier & module gating" — *"`PLAN_LIMITS`
advertised but unenforced ... Every resource-creation command MUST read the
limit and reject with `429 PLAN_LIMIT_EXCEEDED`."*

**Proposed fix direction**
- Tier 1: introduce `@PlanLimitedResource('farms'|'ponds'|'sensors'|'storage_gb')`
  decorator on resource-creation command handlers. The decorator reads the
  tenant's subscription limit from billing-service (cached) and rejects with
  `429 PLAN_LIMIT_EXCEEDED` before the handler runs.
- Tier 2: `PlanLimitEnforcementService` injected into farm-service /
  sensor-service (out of scope for this slice but the contract MUST be
  defined here).
- De-duplicate the two `PLAN_LIMITS` tables into a single export from
  `libs/shared-contracts` (depends on MT-HIGH-003 SSoT consolidation).

**Affected surface (ripple set)**
- `libs/shared-contracts/src/plan-limits.ts` (new)
- `libs/backend-common/src/decorators/plan-limited-resource.decorator.ts` (new)
- `apps/farm-service/src/farm/handlers/create-farm.handler.ts` (and pond,
  sensor, etc. — outside this slice but the contract lives here)
- Delete `apps/gateway-api/src/middleware/tenant-context.middleware.ts:187-233`
  AND `apps/gateway-api/src/services/tenant-lookup.service.ts:109-155` once
  consumers migrate.

**Cross-handoff confirmation:** confirms billing-expert BILLING-CRITICAL-002
(escalated from MT-HIGH-002 W16). Pair-review on the fix MUST include both
agents.

**Expected closer**
billing-expert primary; multi-tenant-saas-expert as CATCHER.

#### MT-HIGH-005 — TenantScopedRepository adoption still uneven; auth + admin-api + impersonation surfaces still on raw `Repository<T>`
**Severity:** HIGH (descalated from prior MT-CRITICAL-001 thanks to billing/messaging/sensor/farm progress; remaining gap is HIGH because billing+farm closures cover the largest tenant-data surfaces)
**Layer:** 1 (tech — app-layer isolation primitive adoption)
**State:** PARTIAL

**Evidence**
- 14+ adoption sites across 4 services as of this cycle (billing 8, farm 4,
  messaging 1, sensor 1).
- 0 sites in `apps/auth-service/src/modules/tenant/services/*.ts` despite the
  service being authoritative for `auth.tenants` and `auth.tenant_modules`.
- 0 sites in `apps/admin-api-service/src/{tenant,impersonation}/**` despite
  both modules executing cross-tenant work that the scoped repo is designed
  to BLOCK.
- `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:86-90` —
  uses raw `@InjectRepository(ImpersonationSession)` +
  `Repository<ImpersonationSession>`. Cross-tenant by design (super-admin
  sessions across tenants), but precisely the surface where
  `TenantScopedRepository` + `BypassRlsService` audit-trail is most valuable.
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts:500-764` —
  multiple `dataSource.getRepository(Invitation|User)` calls. Some are pre-auth
  (legitimate), others are post-auth (require scoping).

**Rule violated**
CLAUDE.md §"Code Quality Standards" — *"`getRepository()` is FORBIDDEN → use
`getScopedRepository()` (tenant isolation)"*. multi-tenant-saas-expert.md
§"L1" — TenantScopedRepository is the canonical app-layer guard.

**Proposed fix direction**
- Tier 3: ESLint rule `no-bare-inject-repository-on-tenant-entity` flagging
  `@InjectRepository(T)` on entities that carry a `tenantId` column. The rule
  needs the entity-tenantId mapping which can be derived from a CI-generated
  `tenant-entities.json` allowlist.
- Migrate the auth-service post-auth paths first (highest risk; auth IS the
  trust anchor).
- For impersonation: keep `Repository<T>` because impersonation IS cross-tenant
  by design, but route every read through
  `BypassRlsService.withAuditTrail(actorUserId, ...)` so the cross-tenant
  queries leave a forensic record. Couples to MT-CRITICAL-005 (audit
  immutability triggers must be present for the forensic record to be
  trustworthy).

**Affected surface (ripple set)**
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts`
  (15 sites)
- `apps/auth-service/src/modules/tenant/services/*.ts`
- `apps/admin-api-service/src/tenant/handlers/*.ts`
- HR + alert-engine + hydroponics + ai (out of slice scope; tracked separately
  for Phase 5)

**Expected closer**
data-expert (kernel primary) + multi-tenant-saas-expert (tenant-contract
slice CATCHER).

#### MT-HIGH-006 — RLS migration still 2/7 tenant-schema services (third cycle unresolved)
**Severity:** HIGH — third cycle → escalates to CRITICAL on next cycle
**Layer:** 2 (defense-in-depth)
**State:** OPEN

**Evidence**
- `apps/farm-service/src/database/migrations/1776000000000-EnableRowLevelSecurity.ts` ✓
- `apps/messaging-service/src/migrations/1782400000000-EnableRowLevelSecurity.ts` ✓
- `apps/auth-service/src/migrations/1787000000000-DropRlsFromAuthUsersIdentity.ts` —
  explicitly DROPS RLS from `auth.users` and `auth.tenants` (justified for
  cross-tenant identity tables; this is correct, not a regression).
- `apps/hr-service/src/database/migrations/1786000400000-MoveEmployeesToHr.ts:57` —
  uses `FORCE ROW LEVEL SECURITY` on `hr.employees`. Verify policies installed
  alongside (grep doesn't show `CREATE POLICY` for hr).
- 0 `EnableRowLevelSecurity` migrations in: sensor-service, hydroponics-service,
  alert-engine, ai-service.

**Rule violated**
multi-tenant-saas-expert.md §"L2 RLS hardening" — RLS is the second-to-last
line in the 5-layer defense model. With 4/7 schema-per-tenant services
missing RLS and adoption inconsistent, a search-path leak (the 2026-04-07
incident class) becomes a cross-tenant breach in those services.

**Proposed fix direction**
- Tier 2: `add-rls-policy` skill (deferred from W5-W6 plan) — generates the
  migration scaffolding from `TenantRlsService.generateCreatePolicySql` plus
  per-service `_constants.PER_TENANT_SCHEMA_SERVICES` enumeration.
- Verify hr-service policies match the farm template; if missing, add.

**Affected surface (ripple set)**
- 4 new migrations: sensor, hydroponics, alert-engine, ai.
- Verify: `apps/hr-service/src/migrations/...` actually creates RLS policies
  (FORCE alone is insufficient without a CREATE POLICY).
- `apps/auth-service/src/migrations/1787000000000-DropRlsFromAuthUsersIdentity.ts` —
  verify there is documentation explaining why `auth.users`+`auth.tenants`
  legitimately drop RLS (cross-tenant identity), and that the security-reviewer
  agreed.

**Expected closer**
data-expert primary; multi-tenant-saas-expert + database-reviewer CATCHER.

#### MT-HIGH-007 — Watchdog (CrossTenantProbe / SourceSchemaScanner / SchemaDriftDetector) wired in farm-service only (second cycle)
**Severity:** HIGH (unchanged from W16; second cycle unresolved)
**Layer:** 3 (detection — runtime canary)
**State:** OPEN

**Evidence**
- `apps/farm-service/src/infrastructure/watchdog-cron.service.ts` is the only
  consumer.
- No equivalent under
  `apps/{sensor,hr,messaging,hydroponics,alert-engine,ai}-service/src/**`.

**Rule violated**
multi-tenant-saas-expert.md §"Watchdog" — *"`CrossTenantProbe` +
`SourceSchemaScanner` + `SchemaDriftDetector` run on schedule with fail-closed
alert pipeline."* The watchdog primitives live in
`libs/backend-common/src/database/watchdog/`. They are the only active canary
for cross-tenant leaks; restricting them to farm-service means a leak in any
other schema is invisible until manual review.

**Proposed fix direction**
- Tier 2: extract `WatchdogCronService` into `@aquaculture/backend-common` so
  each tenant-schema service registers it as a single line in `app.module.ts`.
- Tier 3: invariant test asserting `WatchdogCronService` is registered in
  every service in `_constants.PER_TENANT_SCHEMA_SERVICES`.

**Affected surface (ripple set)**
- New file: `libs/backend-common/src/database/watchdog/watchdog-cron.service.ts`
  (move from farm).
- 7 service `app.module.ts` imports.
- `tests/invariants/watchdog-adoption.spec.ts` (new).

**Expected closer**
data-expert (database kernel primary, watchdog is a database-canary primitive).

#### MT-HIGH-008 — `auth.users.tenantId` carries no FK to `auth.tenants` (NEW this cycle — confirms database-reviewer DBR-HIGH-002)
**Severity:** HIGH (NEW this cycle — confirms DBR-HIGH-002 from the tenant-contract angle)
**Layer:** 2 (referential integrity)
**State:** OPEN

**Evidence**
- `apps/auth-service/src/modules/authentication/entities/user.entity.ts:94-95` —
  ```ts
  @Column({ type: 'uuid', nullable: true })
  tenantId?: string | null;
  ```
  No `@ManyToOne`/`@JoinColumn` to `auth.tenants`. TypeORM does not synthesise
  a FK without one.
- `apps/auth-service/src/modules/tenant/entities/tenant.entity.ts:55` — Tenant
  entity has no inverse `@OneToMany` to User either.
- `database/migrations/core/V003__add_user_table.sql:12` — declares
  `tenant_id UUID REFERENCES auth.tenants(id) ON DELETE CASCADE`. This file
  is **dead** per database-reviewer DBR-CRITICAL-003 (sqitch tree obsolete).
- The live droplet schema (per `migrationsRun: true`) has NO FK on
  `auth.users.tenantId`.

**Rule violated**
multi-tenant-saas-expert.md §"Tenant lifecycle saga" — implicit corollary of
the lifecycle invariant: tenant deletion (PURGED state) MUST cascade to user
rows. Without an FK, a `DELETE FROM auth.tenants WHERE id=$X` orphans every
user keyed to that tenant; subsequent JWTs minted against the orphaned
`tenantId` claim resolve to a non-existent tenant — `TenantContextMiddleware`
treats this as 404 (or 403 per the agent rule), and the user is locked out
with no DB-level diagnostic. Worse: if tenant IDs are ever recycled
(prohibited by the agent invariant but not enforced in DB), the orphaned
user rows attach to the new tenant.

**Proposed fix direction**
- Tier 1 — make impossible: forward-only migration adds
  `ADD CONSTRAINT fk_users_tenant FOREIGN KEY (tenantId) REFERENCES auth.tenants(id) ON DELETE RESTRICT`.
  Use `ON DELETE RESTRICT` (not CASCADE) so the saga must explicitly delete
  user rows before the tenant row — eliminates accidental cascade and forces
  the saga to use `eraseTenantData(tenantId)` first.
- Tier 1: add `@ManyToOne(() => Tenant)` + `@JoinColumn({ name: 'tenantId' })`
  to `auth.users.tenantId` so TypeORM emits the FK in future syncs.
- Tier 3: invariant test
  `tests/invariants/tenant-id-foreign-key-coverage.spec.ts` enumerating every
  `tenantId` column in entity files and asserting either a FK exists OR the
  column is documented as cross-tenant in an allowlist.

**Affected surface (ripple set)**
- `apps/auth-service/src/modules/authentication/entities/user.entity.ts`
- `apps/auth-service/src/modules/tenant/entities/tenant.entity.ts` (inverse
  `@OneToMany`)
- New migration: `apps/auth-service/src/migrations/<ts>-AddTenantIdForeignKeyToUsers.ts`
- `tests/invariants/tenant-id-foreign-key-coverage.spec.ts` (new)

**Cross-handoff confirmation:** confirms database-reviewer DBR-HIGH-002.
database-reviewer owns the SQL-level fix; this agent owns the tenant-lifecycle
angle (PURGE saga must rely on the FK to enforce ordering).

**Expected closer**
data-expert (migration author primary). CATCHER must be database-reviewer +
multi-tenant-saas-expert + auth-security-expert.

### MEDIUM

#### MT-MEDIUM-001 — Subdomain-as-tenantId path accepts non-UUID strings on the gateway middleware (slug bypass)
**Severity:** MEDIUM
**Layer:** 5 (request-routing trust anchor)
**State:** OPEN

**Evidence**
- `apps/gateway-api/src/middleware/tenant-context.middleware.ts:384-389` —
  ```ts
  const subdomain = this.extractSubdomain(host);
  if (subdomain && !['www', 'api', 'app'].includes(subdomain)) {
    return subdomain;  // returned WITHOUT UUID validation
  }
  ```
- The hostname-based subdomain branch returns the raw subdomain (slug). The
  platform middleware copy at `libs/backend-common/src/middleware/tenant-context.middleware.ts:128-148`
  DOES UUID-validate (uses regex). The two middleware copies disagree.

**Rule violated**
multi-tenant-saas-expert.md §"L5 guards" + multi-tenant-saas-expert.md
§"Cross-tenant access" — *"Header value UUID-validated + tenant-registry
lookup; non-existent / PURGED tenants return 403"*. Subdomain-as-tenantId
is fine if the registry resolves slug→UUID with a fail-closed path; a raw
string returned from the middleware bypasses the tenant-registry guard chain
that follows.

**Proposed fix direction**
- Tier 1: subdomain branch must call
  `tenantLookupService.resolveBySlug(subdomain)` to convert slug → UUID +
  verify tenant exists + status check; on miss, return undefined → 400
  BadRequestException already lands.
- Or: deprecate the subdomain path entirely if the platform standard is JWT-
  claim only.

**Affected surface (ripple set)**
- `apps/gateway-api/src/middleware/tenant-context.middleware.ts:355-402`
- `apps/gateway-api/src/services/tenant-lookup.service.ts` (add
  `resolveBySlug` if not present)

#### MT-MEDIUM-002 — Provisioning endpoint synchronous (`POST /tenants` returns full provisioning result inline)
**Severity:** MEDIUM
**Layer:** 4 (operational discipline)
**State:** OPEN

**Evidence**
- `apps/admin-api-service/src/tenant/tenant.controller.ts:81-88` —
  the handler awaits the full provisioning saga before returning. No
  `202 Accepted` + jobId pattern.
- `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts:122-…`
  runs schema creation, role setup, admin-user creation, module assignment
  all in the request lifetime.

**Rule violated**
multi-tenant-saas-expert.md §"Onboarding & offboarding runbooks" —
*"Onboarding is an async saga (`202 + jobId`); synchronous wizard = HIGH."*
and §"Tenant lifecycle saga" — *"Provisioning endpoints are async (`202 +
jobId`); synchronous provisioning = HIGH."* Listed as MEDIUM here only because
the saga itself does compensate correctly; the operational issue is that a
long-running tenant provision (schema creation can take 10s+ on a busy
droplet) holds the HTTP socket and risks gateway-timeout-mid-saga.

**Proposed fix direction**
- Tier 2: queue the saga to a Bull/NATS-backed worker and return
  `202 + { jobId, status: 'PROVISIONING' }`. Subsequent
  `GET /tenants/:id/provisioning-status` polls.
- Aligns with MT-HIGH-002 (saga persistence) — same `admin.saga_executions`
  table backs both.

**Affected surface (ripple set)**
- `apps/admin-api-service/src/tenant/tenant.controller.ts:81-88`
- `apps/admin-api-service/src/tenant/handlers/create-tenant.handler.ts`
- `apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts`

#### MT-MEDIUM-003 — Per-tenant cost-attribution telemetry still entirely absent
**Severity:** MEDIUM (unchanged from W16)
**Layer:** 4 (FinOps invariant)
**State:** OPEN

**Evidence**
- 0 grep hits for `tenant_storage_used_bytes`, `tenant_quota_remaining`,
  or `top_n_*` anywhere in `apps/` or `libs/`. The only `tenant`-bearing
  Prometheus labels in the repo are MT-CRITICAL-004 (raw-header sourced
  hot-path label) and an `observability-service` cost rollup migration
  (`1805000000000-AddTenantCostRollup.ts`) without runtime emission.

**Rule violated**
multi-tenant-saas-expert.md §"Per-tenant observability & cost attribution" —
*"Cost-attribution buckets: compute, DB, storage, egress, AI/LLM — missing
any = MEDIUM. Currently ALL buckets absent."*

**Proposed fix direction**
- Tier 3: add bounded-cardinality `tenant_info{tenant_id}`,
  `tenant_storage_used_bytes{tenant_id}`,
  `top_n_compute_cost_seconds{rank, tenant_id}` metrics to observability-
  service per the agent invariant. Couples to MT-CRITICAL-004 — both must
  agree on the bounded-cardinality allowlist.

**Affected surface (ripple set)**
- `apps/observability-service/src/metrics/...` (new tenant cost module)
- billing-service and ai-service emit attributed events.

**Expected closer**
observability-expert primary; multi-tenant-saas-expert tenant-contract
slice CATCHER.

#### MT-MEDIUM-004 — `TenantRedisService` still 0 adoption across `apps/**`
**Severity:** MEDIUM (descalated from MT-CRITICAL-002 W16 because raw
Redis in tenant code paths is bounded by the existing scoped connection
factory and most tenant data is keyed via tenantId-prefixed strings
already; remains a tier-2 isolation gap)
**Layer:** 1 (tech — L3 isolation primitive adoption)
**State:** OPEN

**Evidence**
- `libs/backend-common/src/redis/tenant-redis.service.ts` — primitive defined.
- 0 grep hits for `TenantRedisService` or `tenantRedis.forTenant` across
  `apps/**`.

**Rule violated**
multi-tenant-saas-expert.md §"L3 Redis" — *"every Redis access in tenant code
paths MUST go through `TenantRedisService.forTenant(redis, tenantId)` which
UUID-validates before prefixing `tenant:{uuid}:`."* Today's pattern is ad-hoc
prefix construction on every callsite (e.g. `ai:ratelimit:${tenantId}:...`);
one missed prefix = cross-tenant cache read/write.

**Proposed fix direction**
- Tier 3: ESLint rule `no-raw-redis-on-tenant-data` flagging
  `this.redisService.<op>(...)` where the first argument concatenates
  `tenantId`. Migrate the call-sites; the wrapper is already built.

**Affected surface (ripple set)**
- ~25 call-sites across the 7 tenant-schema services + messaging.

**Expected closer**
auth-security-expert (Redis primary) + multi-tenant-saas-expert (tenant
slice CATCHER).

### LOW

#### MT-LOW-001 — Tenant `synchronize: false` mirror entities duplicated across read-only services without column-shape invariant
**Severity:** LOW
**Layer:** 4
**State:** OPEN

**Evidence**
- `apps/admin-api-service/src/tenant/entities/tenant.entity.ts:48` —
  `@Entity('tenants', { schema: 'auth', synchronize: false })` — admin-api
  reads `auth.tenants`.
- `apps/admin-api-service/src/billing/entities/usage-aggregation-readonly.entity.ts:35` —
  `synchronize: false` mirror of `billing.usage_aggregations`.
- `apps/admin-api-service/src/billing/entities/tenant-usage-metrics-readonly.entity.ts:38` —
  `synchronize: false` mirror of `billing.tenant_usage_metrics`.

**Rule violated**
ADR-011 strictly does not forbid `synchronize:false` mirror entities — but
the pattern proliferates and creates a class of drift where the mirror's
column shape diverges from the canonical entity. A schema-drift validator
only checks the OWNER service, not mirror consumers.

**Proposed fix direction**
Tier 4: add an `OWNER_SCHEMA_TABLES` allowlist + validation that mirror
entities exactly match the owner's column set at boot. Prevents silent
drift like "billing renames `last_seen_at` and admin-api keeps reading the
old column".

## Cross-domain dependencies flagged

- **MT-CRITICAL-001** (query-string tenantId + gateway path-param/raw-subdomain) —
  invoke `auth-security-expert` (trust-anchor primary); BLOCKS deploy.
  Cross-confirms auth-security-expert SEC-CRITICAL-002 (StripInternalHeaders
  missing in auth-service); both fixes ship together.
- **MT-CRITICAL-002** (impersonation rate-limit fail-open) — invoke
  `auth-security-expert` (rate-limit primitive sibling); shape already
  exists in AI rate-limit, copy verbatim.
- **MT-CRITICAL-003** (event payload wrapper) — invoke `data-expert`
  (event-contract authority); cross-link to `messaging-expert` for NATS
  subject parsing.
- **MT-CRITICAL-004** (unbounded `tenant` Prometheus label) — invoke
  `platform-kernel-expert` (kernel primary; PLAT-CRITICAL-001 owner) +
  `auth-security-expert` (the same unauthenticated-header sourcing class);
  ripple across gateway/auth/sensor `app.module.ts` adopters.
- **MT-CRITICAL-005** (audit-log immutability triggers destroyed) — invoke
  `database-reviewer` (DBR-CRITICAL-001 owner) + `data-expert` (migration
  author) + `auth-security-expert` (audit-trail tamper-evidence is a
  security guarantee).
- **MT-HIGH-001** (erasure cascade) — `compliance-expert` (already owns
  `COMPLIANCE-CRITICAL-001`); this report retains tenant-CONTRACT slice
  for cross-review.
- **MT-HIGH-002** (saga PIVOT classification) — `billing-expert` (Stripe
  PIVOT) + `auth-security-expert` (compensation security).
- **MT-HIGH-003** (PlanTier SSoT consolidation) — `data-expert` +
  `billing-expert`; cross-confirms database-reviewer DBR-HIGH-003.
- **MT-HIGH-004** (PLAN_LIMITS enforcement) — `billing-expert` primary
  (BILLING-CRITICAL-002 owner).
- **MT-HIGH-006** (RLS adoption) — `data-expert` + `database-reviewer`.
- **MT-HIGH-007** (watchdog extraction) — `data-expert`.
- **MT-HIGH-008** (auth.users.tenantId FK) — `database-reviewer` (DBR-HIGH-002
  owner) + `data-expert` (migration) + `auth-security-expert`.
- **MT-MEDIUM-003** (cost-attribution metrics) — `observability-expert`.
- **MT-MEDIUM-004** (TenantRedisService adoption) — `auth-security-expert`
  (Redis primary).

## Verdict

**BLOCK** until MT-CRITICAL-001..005 are closed in the same PR or with
explicit `auditor-override:` entries. Any new tenant-touching code merged
to `main` while `req.query.tenantId` is still accepted, or while raw
`x-tenant-id` populates Prometheus labels, or while the audit-log
immutability triggers remain dropped, is a regression vector on a
critical-trust surface.

The four HIGH escalations (MT-HIGH-001 erasure, MT-HIGH-002 saga,
MT-HIGH-004 plan-limits, MT-HIGH-006 RLS) are SYSTEMIC — three or more
cycles unresolved each. Per agent prior-work rule, all four escalate to
CRITICAL on the next cycle without progress. Recommend
`architectural-arbiter` invocation if any of the four cannot land within
two cycles.

Cross-handoff posture: this report's CRITICALs MT-CRITICAL-004 and
MT-CRITICAL-005 are formally co-confirmed with platform-kernel-expert
(PLAT-CRITICAL-001) and database-reviewer (DBR-CRITICAL-001) respectively;
HIGH MT-HIGH-004 cross-confirms billing-expert (BILLING-CRITICAL-002),
HIGH MT-HIGH-008 cross-confirms database-reviewer (DBR-HIGH-002). The
CRITICAL severity differential on MT-HIGH-004 (HIGH from this agent vs.
CRITICAL from billing-expert) is intentional: billing-expert owns the
dollar-impact CRITICAL of unenforced caps, this agent owns the tenant-
contract-shape HIGH on the same surface; both agents agree on the fix.

## References

- Layer-1 cites: `layer-1-typeorm.md` §"Multi-tenant patterns",
  `layer-1-core.md` §"TypeScript 5.3.3 — Branded types",
  `layer-1-nestjs.md` §"Redis patterns".
- Layer-2 cites: `layer-2-patterns.md` §"Tenant isolation", §"Outbox
  pattern", §"Saga compensation", §"Boundary discipline".
- Layer-3 cites: ADR-006 (event flat), ADR-007 (CQRS), ADR-008 (guards
  defense-in-depth), ADR-011 (schema ownership), ADR-012 (drift),
  ADR-014/015 (NATS identity).
- Sibling reviews this cycle:
  - `docs/reviews/auth-security-expert/2026-04-28-core-platform-review.md`
    (SEC-CRITICAL-001..003 cross-confirmed against MT-CRITICAL-001/002).
  - `docs/reviews/billing-expert/2026-04-28-core-platform-review.md`
    (BILLING-CRITICAL-002 cross-confirmed against MT-HIGH-004).
  - `docs/reviews/platform-kernel-expert/2026-04-28-core-platform-review.md`
    (PLAT-CRITICAL-001 cross-confirmed against MT-CRITICAL-004).
  - `docs/reviews/database-reviewer/2026-04-28-core-platform-review.md`
    (DBR-CRITICAL-001 + DBR-HIGH-002 cross-confirmed against MT-CRITICAL-005
    + MT-HIGH-008).
- Prior cycles superseded:
  - W16 MT-CRITICAL-004 → CLOSED this cycle (every reviewed entity declares
    `schema:`).
  - W16 MT-CRITICAL-001 → DESCALATED to MT-HIGH-005 this cycle (4-service
    partial adoption).
  - W16 MT-CRITICAL-002 (AI quota fail-open) → CLOSED this cycle on AI
    sibling; impersonation sibling still OPEN as MT-CRITICAL-002.
  - W16 MT-CRITICAL-003 → OWNERSHIP TRANSFERRED to compliance-expert as
    `COMPLIANCE-CRITICAL-001`; tenant-contract slice retained as MT-HIGH-001.
  - W16 MT-HIGH-006 PlanTier drift → MT-HIGH-003 this cycle (escalated,
    drift WIDENED to 5 variants).
  - W16 MT-HIGH-002/003/004/005 → MT-HIGH-004/006/007/002 (renumbered) this
    cycle, all OPEN.
  - W16 MT-HIGH-007 (no ordinal plan gating) → rolled into MT-HIGH-003 (same
    fix surface).
  - W16 MT-MEDIUM-001 (impersonation Map fallback) → escalated to
    MT-CRITICAL-002 this cycle (third-cycle prior-work rule).
  - W16 MT-MEDIUM-002 → MT-MEDIUM-003 this cycle.
  - W16 MT-MEDIUM-003 (`x-tenant-id` broad acceptance) → folded into
    MT-CRITICAL-001 this cycle (same root cause: middleware accepts non-JWT
    tenant sources unconditionally).
