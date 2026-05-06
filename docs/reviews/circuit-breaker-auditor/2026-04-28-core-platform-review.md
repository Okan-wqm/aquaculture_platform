# circuit-breaker-auditor — CATCHER — 2026-04-28-core-platform

## Scope

First-cycle inventory of circuit-breaker discipline across the core/cross-cutting surface (auth/tenant/billing) plus every external-dependency call site reachable from the platform. Repository at HEAD `a958dc66`, clean working tree. No prior `circuit-breaker-auditor` cycle exists, so this report establishes the baseline.

Surfaces reviewed:

- `libs/backend-common/src/**` — searched for canonical breaker library (NONE found).
- `apps/gateway-api/src/proxy/circuit-breaker.service.ts` — sole production breaker implementation.
- `apps/gateway-api/src/opa/opa-client.service.ts` — inline ad-hoc breaker #1 (auth-path).
- `apps/messaging-service/src/shared/redis.provider.ts` — inline ad-hoc breaker #2 (Redis).
- `apps/admin-api-service/src/settings/services/email-sender.service.ts` — inline ad-hoc breaker #3 (SMTP).
- `libs/backend-common/src/orchestrator-rate-limit/claude-api-budget.service.ts` — Claude budget guard, NOT YET WIRED (per file-level comment).
- External-dependency call sites: Stripe (incoming webhook), Anthropic (`apps/ai-service/src/agent/agent-runner.service.ts`), nodemailer/Mattilsynet (`apps/notification-service/src/notification/services/email.service.ts`), Twilio HTTP (`sms.service.ts`), FCM/Firebase (`push.service.ts`), MinIO (`libs/storage/src/minio-client.service.ts`), JWKS (`libs/backend-common/src/guards/jwks.service.ts`), customer webhooks (`notification-dispatcher.service.ts:599`), Maskinporten / Mattilsynet / Sentinel-Hub / Open-Meteo (farm-service), gateway→subgraph signed-fetch (`libs/backend-common/src/http/signed-http-client.ts`).

## Executive summary

The platform has NO canonical circuit-breaker library at `libs/backend-common/src/circuit-breaker/**` (the agent-spec primary-ownership location). Instead there are FIVE incompatible ad-hoc implementations (gateway proxy, OPA client, messaging Redis, admin-email SMTP, claude-budget-stub). Each rewrites state, transition rules, and metric emission differently, with NO Redis-backed shared state and ZERO per-tenant keying anywhere in the platform. Of ~33 production `await fetch(...)` call sites that cross trust boundaries, exactly ONE (`gateway-api/proxy/service-proxy.service.ts:222`) is breaker-wrapped; the rest are raw.

Top 3 blockers:

1. **CIRCUIT-CRITICAL-001** — Anthropic SDK call (`apps/ai-service/.../agent-runner.service.ts:195`) is raw: no breaker, no idempotency on retry, no per-tenant key. One faulty tenant can blow the org-wide Anthropic 429 budget for ALL tenants. Coupled with `BILLING-CRITICAL-003 METER_RACE`: revenue loss directly observable.
2. **CIRCUIT-CRITICAL-002** — `policy-enforcer.service.ts:174` honors `POLICY_FAIL_OPEN=true` in non-OPA-guard authorization paths. The OPA *guard* fixes this for HTTP guards (`opa-policy.guard.ts:316-329`), but every direct `policyEnforcer.isAuthorized()` consumer (e.g., resource access checks called from controllers) still observes `failOpen=true` and grants access. AUTH fail-OPEN is a banned class.
3. **CIRCUIT-HIGH-001** — Stripe webhook idempotency (`stripe-webhook.controller.ts:140`) calls `redisService.setNx` raw. If Redis flickers, the controller logs and re-routes the event to the handler regardless. Combined with `BILLING-CRITICAL-001` (no Stripe SDK), the moment a Stripe outbound client is added it WILL inherit the same un-wrapped pattern unless a canonical breaker library lands first.

Severity counts: CRITICAL = 4, HIGH = 7, MEDIUM = 5, LOW = 2.
Layer distribution: Layer-1 = 0, Layer-2 = 14, Layer-3 = 4, Tier-4-only = 0 (no canonical mechanism currently exists to be Tier-1; first ladder rung is "build the library").

Verdict: **BLOCK** — the core/cross-cutting scope review cannot pass while five incompatible breaker implementations exist with zero per-tenant keying and at least two confirmed fail-OPEN-on-auth/billable paths.

## Pattern usage table

| Surface | Breaker present? | Per-tenant key? | Fail-mode | Half-open semantics? | State observability |
|---|---|---|---|---|---|
| `gateway-api/proxy/service-proxy.service.ts` (subgraph fetch) | YES (in-memory, per-pod) | NO (per-service-name only) | Throws BadGateway → effectively fail-CLOSED | YES (config-driven) | EventEmitter only — no Prometheus |
| `gateway-api/proxy/service-proxy.service.ts:363` (SSE) | NO (bypasses breaker) | NO | implicit fail-OPEN (raises BadGateway only on response.ok=false) | n/a | none |
| `gateway-api/opa-client.service.ts` | YES (inline, separate from above) | NO | Throws → guard returns 403 (fail-CLOSED in production via guard, fail-OPEN possible via direct enforcer) | YES | EventEmitter only |
| `gateway-api/opa/policy-enforcer.service.ts:156-188` | inherits OPA-client breaker | NO | **fail-OPEN if `POLICY_FAIL_OPEN=true`** (no production override here) | n/a | none |
| `gateway-api/services/http-pool.service.ts` (health checks) | NO | n/a | log+ignore | n/a | none |
| `gateway-api/health/health.service.ts` (downstream health) | NO | n/a | log+report unhealthy | n/a | none |
| `libs/backend-common/src/guards/jwks.service.ts` (auth-service JWKS) | NO | n/a | throws (cache extends life) → fail-CLOSED-with-degraded | n/a | none |
| `libs/backend-common/src/http/signed-http-client.ts` (every internal HMAC fetch) | NO (caller-responsibility) | NO | depends on caller | n/a | none |
| `apps/ai-service/.../agent-runner.service.ts:195` (Anthropic) | **NO** | **NO** | propagates throw | n/a | none |
| `apps/billing-service/.../usage-metering.service.ts:332` (Redis sync of meters) | hand-rolled exponential backoff (NOT a breaker) | NO | fail-OPEN-degraded (in-memory state held → revenue loss on pod restart) | no | logger.warn only |
| `apps/billing-service/.../stripe-webhook.controller.ts:140` (idempotency setNx) | NO | n/a | log+continue → fail-OPEN (will re-process on Redis flicker) | n/a | none |
| `apps/notification-service/.../email.service.ts:169` (nodemailer; INCLUDES Mattilsynet regulatory) | NO | NO | throw → caller-dependent | n/a | none |
| `apps/notification-service/.../sms.service.ts:250` (Twilio) | NO | NO | throw | n/a | none |
| `apps/notification-service/.../push.service.ts:152` (FCM) | NO | NO | throw | n/a | none |
| `apps/notification-service/.../notification-dispatcher.service.ts:599` (customer webhook) | NO | NO (customer URL only) | throw | n/a | none |
| `apps/admin-api-service/.../email-sender.service.ts` (SMTP, invitation) | YES (inline #3) | NO | open=throw → fail-CLOSED | YES | logger only |
| `apps/messaging-service/src/shared/redis.provider.ts` (REDIS, all messaging) | YES (inline #4, singleton) | NO (process-global) | fail-OPEN-degraded | YES | logger only |
| `apps/messaging-service/.../messaging-rate-limit.interceptor.ts:130` | depends on Redis above | NO | **fail-OPEN explicit** | n/a | metricsService |
| `libs/storage/.../minio-client.service.ts` (every MinIO op) | NO | NO | throw | n/a | none |
| `apps/farm-service/.../maskinporten.service.ts:232/335` (Norwegian gov auth) | NO | n/a | throw | n/a | none |
| `apps/farm-service/.../mattilsynet-api.service.ts:457` | NO | n/a | throw | n/a | none |
| `apps/farm-service/.../sentinel-hub.service.ts:336` | NO | NO | throw | n/a | none |
| `apps/farm-service/.../open-meteo.service.ts:197` | NO | NO | throw | n/a | none |
| `libs/backend-common/.../orchestrator-rate-limit/claude-api-budget.service.ts` | "NOT YET WIRED" per docstring lines 50-54 | n/a (cycle-keyed not tenant-keyed) | fail-CLOSED if Redis down (correct) | n/a | Prometheus counter |

Five distinct breaker implementations, one orphan budget guard, zero canonical library. Per-tenant keying does not exist anywhere in the platform.

## Findings (by severity)

### CRITICAL

#### CIRCUIT-CRITICAL-001 — Anthropic SDK call has no breaker, no per-tenant key, no idempotency

**Severity:** CRITICAL
**Layer:** 2 (architectural pattern violation — agent file §"Mandatory breaker coverage" + §"Per-tenant keying for isolation" + §"Retry + jitter discipline")
**State:** OPEN
**Sub-kind tag:** `BREAKER_MISSING` + `GLOBAL_KEYED` + `RETRY_NO_IDEMPOTENT`

**Evidence**

- `apps/ai-service/src/agent/agent-runner.service.ts:53` — `this.anthropic = new Anthropic({ apiKey: ... })` — direct SDK construction.
- `apps/ai-service/src/agent/agent-runner.service.ts:195` — `const response = await this.anthropic.messages.create(...)` — raw call inside the agent loop (max 10 iterations per chat, line 56).
- `libs/backend-common/src/orchestrator-rate-limit/claude-api-budget.service.ts:50-54` — file-level comment confirms: *"The orchestrator-runner + Claude SDK wrapper (apps/ai-service/src/agent/agent-runner.service.ts) do NOT yet call these methods. Wiring is Phase 12.4 completion work."*
- No Anthropic 429 handling, no exponential-backoff-with-full-jitter, no `Idempotency-Key` header equivalent.

**Rule violated**

Agent spec §"Mandatory breaker coverage": *"Every external API call MUST be wrapped in a circuit breaker keyed by `(service, operation)`."*
Agent spec §"Per-tenant keying for isolation": tenant-isolated AI conversation MUST include `tenantId` in the breaker key.
Agent spec §"Retry + jitter discipline": *"Idempotency MANDATORY for any retried operation. Missing idempotency on retry = CRITICAL (double-charge risk)"* — same class applies to AI: a tenant prompt retried during a Claude 429 burst can be processed twice, charging the tenant twice for the same input tokens.
Cross-handoff: `ai-safety-auditor` and `tenant-cost-attribution-expert` overlap on this finding.

**Proposed fix direction**

- Tier-1: extend `ClaudeApiBudgetService` with breaker semantics keyed by `(model, tenantId)` and route ALL `this.anthropic.messages.create(...)` through it. Wire from the agent-runner per the docstring's "Phase 12.4 completion" plan that has been pending.
- Tier-2: ESLint rule `no-claude-sdk-raw-call` already exists in `tools/eslint-rules/rules/no-claude-sdk-raw-call.ts` — promote from warn to error AND extend to require the call go through the breaker-wrapped facade.

**Affected surface (ripple set)**

- `apps/ai-service/src/agent/agent-runner.service.ts`
- `libs/backend-common/src/orchestrator-rate-limit/claude-api-budget.service.ts`
- new `libs/backend-common/src/circuit-breaker/**`
- `tools/eslint-rules/rules/no-claude-sdk-raw-call.ts`

**Expected closer**

`ai-safety-auditor` WRITER mode after the canonical breaker library lands. Pair-review invariant: this finding's WRITER MUST NOT be `circuit-breaker-auditor`.

#### CIRCUIT-CRITICAL-002 — `policy-enforcer.service.ts` honors `POLICY_FAIL_OPEN=true` without production override

**Severity:** CRITICAL
**Layer:** 2 (auth fail-mode discipline)
**State:** OPEN
**Sub-kind tag:** `FAIL_OPEN_BILLABLE` (auth path is in the same banned class)

**Evidence**

- `apps/gateway-api/src/opa/policy-enforcer.service.ts:128-136` — `private readonly failOpen: boolean = configService.get<boolean>('POLICY_FAIL_OPEN', false)`.
- `apps/gateway-api/src/opa/policy-enforcer.service.ts:174-180` — when `failOpen` is true and OPA evaluation throws, `isAuthorized()` returns `{ allowed: true, reason: 'Policy evaluation failed, defaulting to allow' }`.
- Compare with `apps/gateway-api/src/guards/opa-policy.guard.ts:316-329` — the **guard** rejects `failOpen` in production via explicit `isProduction` check. The enforcer does NOT.
- `enforce()` (line 193) and `canAccessResource()` (line 219) are public APIs callable from any service — they inherit the unsafe path.

**Rule violated**

Agent spec §"Fail-mode discipline": *"Fail-CLOSED mandatory for: Auth (token refresh, JWT verification dependency), Impersonation (cross-tenant authorization). Fail-open in any of these = CRITICAL (security/financial/safety integrity violation)."*
Layer-3 ADR-008 (Guard Strategy Defense-in-Depth) — defense-in-depth implies the *enforcer* is also a defense layer; one layer fail-OPEN defeats the chain.

**Proposed fix direction**

- Tier-1: delete the `failOpen` config branch entirely from `PolicyEnforcerService`. Auth decisions cannot be configurably permissive. The fallback heuristics (`FALLBACK_POLICIES`) at `policy-enforcer.service.ts:107-118` are the legitimate degraded-mode for OPA outage; they evaluate deny-by-default unless system_admin / tenant_isolation / ownerAccess matches. That set IS fail-CLOSED. The current code uses fallback first (line 166) AND THEN if fallback throws, applies `failOpen` — the second branch is the bug.
- Tier-2: rename env var to `POLICY_FAIL_OPEN_DEV_ONLY` and hard-fail at boot if the var is set in `NODE_ENV=production`.

**Affected surface (ripple set)**

- `apps/gateway-api/src/opa/policy-enforcer.service.ts`
- env-var documentation in operator runbooks
- `tests/invariants/` — new invariant: assert no service has `POLICY_FAIL_OPEN=true` in production helm/compose.

**Expected closer**

`auth-security-expert` WRITER mode.

#### CIRCUIT-CRITICAL-003 — METER_RACE — Redis sync of metering state is not breaker-wrapped, causing in-flight revenue loss on outage

**Severity:** CRITICAL (escalates `BILLING-CRITICAL-003 METER_RACE` from billing-expert with breaker-discipline angle)
**Layer:** 2 (mandatory breaker on billable signal)
**State:** OPEN
**Sub-kind tag:** `BREAKER_MISSING` + `FAIL_OPEN_BILLABLE`

**Evidence**

- `apps/billing-service/src/modules/metering/usage-metering.service.ts:332` — `await this.redisService.setJson(...)` raw, wrapped only in try/catch with exponential backoff.
- `apps/billing-service/src/modules/metering/usage-metering.service.ts:343-345` — on persistent failure, the tenant is *re-queued* (`this.dirtyTenants.add(tenantId)`) but state remains in-process memory.
- `onModuleInit` enforces RedisService presence (line 172-177) but `syncToRedis` does NOT enforce that the state was successfully persisted before allowing further `recordUsage()` calls. A pod restart while `syncRetryState` is non-empty silently drops the unflushed metered events — billable but un-billed.

**Rule violated**

Agent spec §"Fail-mode discipline": Billing → fail-CLOSED. Current behaviour is fail-OPEN (continues accepting `recordUsage` without confirmed persistence).
Sibling finding `BILLING-CRITICAL-003 METER_RACE` documents the race; this finding is the breaker-discipline angle: there is no upstream-failure detection that would refuse new mutations once the unflushed-tenant queue exceeds a threshold.

**Proposed fix direction**

- Tier-1: route `syncToRedis` through a breaker keyed by `(service:redis, operation:metering-sync)`. When the breaker is open, `recordUsage` MUST short-circuit with a SERVICE_UNAVAILABLE response; calling tenants will retry their billable action and the platform never silently absorbs revenue.
- Tier-3: alert (already-existing Prometheus path) on `dirtyTenants.size > N` AND breaker-open simultaneously — operator SLA escalation.

**Affected surface (ripple set)**

- `apps/billing-service/src/modules/metering/usage-metering.service.ts`
- new `libs/backend-common/src/circuit-breaker/**`
- the call-site of `recordUsage` in every quota-enforcement path (must propagate the SERVICE_UNAVAILABLE).

**Expected closer**

`billing-expert` WRITER mode after canonical breaker lands.

#### CIRCUIT-CRITICAL-004 — Five incompatible breaker implementations + zero per-tenant keying = no canonical library

**Severity:** CRITICAL (architectural class)
**Layer:** 2 (architectural pattern absent)
**State:** OPEN
**Sub-kind tag:** `BREAKER_MISSING` (the canonical library itself is missing)

**Evidence**

- `apps/gateway-api/src/proxy/circuit-breaker.service.ts` — generic per-service breaker, in-memory only, EventEmitter-based.
- `apps/gateway-api/src/opa/opa-client.service.ts:73-77,103-107,410-462` — different state machine, hand-rolled, in-memory.
- `apps/messaging-service/src/shared/redis.provider.ts:23-99` — third state machine, singleton process-global.
- `apps/admin-api-service/src/settings/services/email-sender.service.ts:36-101` — fourth state machine, instance-scoped.
- `libs/backend-common/src/orchestrator-rate-limit/claude-api-budget.service.ts` — fifth implementation, NOT WIRED, but adds `(cycle, model)` keying without `tenantId`.
- `libs/backend-common/src/circuit-breaker/` — directory does NOT exist (the canonical home named in the agent spec primary-ownership section).
- Per-tenant keying does not exist in ANY of the five implementations. Per agent spec, AI conversation, bulk export, large file upload all REQUIRE tenant-key.

**Rule violated**

Agent spec §"Primary Ownership": *"`libs/backend-common/src/circuit-breaker/**` (new or existing — first-cycle inventory) — primary"* — the directory is empty.
Agent spec §"Per-tenant keying for isolation": *"Global-only breaker = HIGH (one faulty tenant trips breaker for ALL tenants)."* — escalated to CRITICAL because EVERY breaker in the platform is global-only AND multi-tenant operation is the platform's defining scale.
ADR-007 (CQRS strategy) implicitly requires shared resilience primitives; ADR-008 (defense-in-depth) requires consistent fail-mode contracts.

**Proposed fix direction**

- Tier-1: build `libs/backend-common/src/circuit-breaker/` as a Redis-backed (so multi-pod-consistent) per-key breaker primitive. Key shape: `{ service, operation, tenantId? }`. Default config per agent spec (50% failure threshold, 60s window, 30s open, half-open probe). API: `breaker.execute({ service, operation, tenantKey? }, fn, options)` returning the result OR throwing `CircuitOpenError`.
- Tier-1: deprecate the five existing implementations one by one — rip each out and replace with the canonical lib in same PR (CLAUDE.md "no breakage / update callsites" rule).
- Tier-3: ESLint rule `no-direct-external-fetch` (companion to existing `no-direct-event-publish`) bans `await fetch(...)` outside breaker-wrapped facades, with allowlist for already-wrapped paths.
- Tier-3: invariant test asserts every external-API call site in `apps/**` resolves to a `breaker.execute(...)` call within 3 layers up the call tree.

**Affected surface (ripple set)**

This is platform-wide. The library lands first; migration is staged across at least 4 PRs (gateway-api, opa-client, messaging-redis, admin-email + claude-budget wire-up + ALL raw-fetch call sites). Estimate: 33 fetch sites × per-site review.

**Expected closer**

`platform-kernel-expert` WRITER mode for the canonical library; per-domain-expert WRITER for migration of each existing breaker. THIS agent (`circuit-breaker-auditor`) becomes CATCHER on every migration commit.

### HIGH

#### CIRCUIT-HIGH-001 — Stripe webhook idempotency setNx not breaker-wrapped (Redis flicker = duplicate processing)

**Severity:** HIGH
**Layer:** 2
**State:** OPEN
**Sub-kind tag:** `BREAKER_MISSING`

**Evidence**

- `apps/billing-service/src/billing/controllers/stripe-webhook.controller.ts:138-151` — `redisService.setNx(idempotencyKey, ...)` raw. Comment at line 137 reads *"Idempotency check (Redis)"* — there is none on outage.
- If Redis transient outage occurs while a Stripe retry is in flight, `setNx` may throw or return stale; the controller has `if (this.redisService)` guard, but no defense against the SET succeeding to one Redis replica and being lost on failover.

**Rule violated**

Agent spec §"Retry + jitter discipline": *"Idempotency MANDATORY for any retried operation (Stripe `Idempotency-Key` header, business-level dedup token). Missing idempotency on retry = CRITICAL (double-charge risk)."* — Stripe DOES retry; if our idempotency Redis check fails, we double-process. Marked HIGH (not CRITICAL) only because Stripe webhook handlers themselves contain handler-level dedup via DB unique constraint in many cases — but `handleSubscriptionDeleted` and `handleChargeRefunded` do NOT all have business-level dedup.

**Proposed fix direction**

- Tier-1: wrap `setNx` in breaker `{ service: 'redis', operation: 'webhook-idempotency' }`; on breaker-open, REJECT the webhook (return 503), letting Stripe retry rather than risk duplicate.

**Expected closer**

`billing-expert` WRITER mode.

#### CIRCUIT-HIGH-002 — JWKS fetch has no breaker; auth-service outage degrades through cache then collapses

**Severity:** HIGH
**Layer:** 2
**State:** OPEN
**Sub-kind tag:** `BREAKER_MISSING`

**Evidence**

- `libs/backend-common/src/guards/jwks.service.ts:149` — raw fetch on auth-service `/.well-known/jwks.json`.
- Cache TTL = 1 hour (line 55), proactive refresh at 75% TTL — IF auth-service is down for >15 min, refresh keeps failing silently (line 73-77 just logs `warn`). On the FIRST cache miss after outage, every subsequent JWT validation throws `Signing key not found for kid` → all gateway requests deny.

**Rule violated**

Agent spec §"Fail-mode discipline": Auth → fail-CLOSED. Current behaviour is fail-CLOSED-with-degraded (cache extends life), which IS the right intent — but without a breaker the gateway burns 10s timeout budget per JWT validation during outage, cascading latency-induced 503s upstream.

**Proposed fix direction**

- Tier-1: wrap the fetch in breaker `{ service: 'auth-service', operation: 'jwks' }`. On breaker-open, `getSigningKey` falls through to cached entry even if expired (extend grace period during outage); if no cache entry exists for that kid, fail-CLOSED (correct).

**Expected closer**

`auth-security-expert` WRITER mode.

#### CIRCUIT-HIGH-003 — Customer-supplied webhook dispatcher has no breaker, no per-tenant key

**Severity:** HIGH
**Layer:** 2
**State:** OPEN
**Sub-kind tag:** `BREAKER_MISSING` + `GLOBAL_KEYED`

**Evidence**

- `apps/notification-service/src/notification/services/notification-dispatcher.service.ts:599` — outbound webhook to customer-controlled URL.
- A single tenant configuring a slow/down webhook can saturate the notification dispatcher's HTTP pool. 10s timeout (line 594) means at 100 concurrent alerts to that tenant, the pool is exhausted.

**Rule violated**

Agent spec §"Per-tenant keying for isolation": *"For tenant-isolated expensive operations ... breaker key MUST include `tenantId`. Global-only breaker = HIGH (one faulty tenant trips breaker for ALL tenants)."* — applies to outbound customer webhooks even more strongly because the operator does NOT control the URL's responsiveness.

**Proposed fix direction**

- Tier-1: wrap with breaker keyed on `(service: 'webhook', operation: 'dispatch', tenantId)`. On breaker open, queue to NATS retry stream (idempotent — webhook payloads already carry `alertId` so the customer can dedup).
- Fail-mode: fail-OPEN-with-degraded (webhook is non-critical compared to email/SMS; primary email still fires per agent spec).

**Expected closer**

`platform-kernel-expert` (notification slice) WRITER mode.

#### CIRCUIT-HIGH-004 — Mattilsynet regulatory email send has no breaker; statutory reporting failure invisible

**Severity:** HIGH
**Layer:** 2
**State:** OPEN
**Sub-kind tag:** `BREAKER_MISSING` + `STATE_NO_METRIC`

**Evidence**

- `apps/notification-service/src/notification/services/email.service.ts:169` — `transporter.sendMail(...)` raw.
- The same `sendEmail()` is used for Mattilsynet regulatory urgent reports (line 448) — disease outbreak, escape incident, welfare event. Norwegian regulatory mandate; failure to deliver is a compliance event.

**Rule violated**

Agent spec §"Fail-mode discipline": *"Life-safety alert dispatch ... fail-CLOSED."* Mattilsynet reports for disease/escape are biosecurity-critical. Current behaviour: throws on send failure but caller (`sendRegulatoryReportEmail`) does not retry, no DLQ.
Agent spec §"Observability of breaker state": *"Every breaker state change emits structured event ... Missing = HIGH (incident blind spot)."*

**Proposed fix direction**

- Tier-1: wrap with breaker `{ service: 'smtp', operation: 'mattilsynet-urgent', tenantId }`. fail-CLOSED with mandatory retry queue. Open-state alert = PagerDuty SEV-1 (regulatory).

**Expected closer**

`platform-kernel-expert` (notification slice) + `farm-service-expert` cross-handoff.

#### CIRCUIT-HIGH-005 — Twilio HTTP call has no breaker; SMS alert path single-tenant DoS-able

**Severity:** HIGH
**Layer:** 2
**State:** OPEN
**Sub-kind tag:** `BREAKER_MISSING`

**Evidence**

- `apps/notification-service/src/notification/services/sms.service.ts:250` — direct `fetch(url, ...)` to Twilio. 15s timeout (line 247).
- Agent spec calls out Twilio explicitly in §"Mandatory breaker coverage" → external API examples.

**Rule violated**

Agent spec §"Mandatory breaker coverage": Twilio listed as required.

**Proposed fix direction**

Tier-1 breaker keyed `(service:'twilio', operation:'sms', tenantId)`. Fail-mode = fail-CLOSED (alert-engine path is life-safety-adjacent).

**Expected closer**

`platform-kernel-expert` (notification slice).

#### CIRCUIT-HIGH-006 — FCM/Firebase push has no breaker

**Severity:** HIGH
**Layer:** 2
**State:** OPEN
**Sub-kind tag:** `BREAKER_MISSING`

**Evidence**

- `apps/notification-service/src/notification/services/push.service.ts:152` — `sendViaFirebase` invocation. Firebase Admin SDK does not expose a circuit-breaker primitive; raw call.

**Rule violated**

Agent spec §"Mandatory breaker coverage": FCM listed.

**Proposed fix direction**

Tier-1 wrap with breaker keyed on `(service:'fcm', operation:'send', tenantId)`. Fail-mode = fail-OPEN-degraded (push is supplementary; email/SMS primary).

**Expected closer**

`platform-kernel-expert` (notification slice).

#### CIRCUIT-HIGH-007 — MinIO/S3 calls platform-wide have no breaker (esp. presigned URL generation)

**Severity:** HIGH
**Layer:** 2
**State:** OPEN
**Sub-kind tag:** `BREAKER_MISSING`

**Evidence**

- `libs/storage/src/minio-client.service.ts` — every method (`uploadFile`, `uploadStream`, `getPresignedUrl`, `downloadFile`, `getFileStream`, `listObjects`) is a raw MinIO SDK call.
- A MinIO outage burns N concurrent uploads × per-request timeout before backpressure kicks in.

**Rule violated**

Agent spec §"Mandatory breaker coverage": *"MinIO / S3 (object storage)"* listed.

**Proposed fix direction**

Tier-1: wrap each MinIO operation in breaker `{ service:'minio', operation:'<op>', tenantId }`. Per-tenant keying (one tenant uploading a malformed multi-part can trip breaker — must isolate). Fail-mode varies per operation: presigned-URL = fail-OPEN with cached recent URLs; upload = fail-CLOSED (refuse rather than lose data).

**Expected closer**

`platform-kernel-expert` (storage slice).

### MEDIUM

#### CIRCUIT-MEDIUM-001 — Five incompatible breaker config defaults (failure-threshold, reset-timeout)

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Sub-kind tag:** none specific (config drift)

**Evidence**

- `apps/gateway-api/src/proxy/circuit-breaker.service.ts:351-358` — failureThreshold=5, timeout=30000, halfOpenRequests=3.
- `apps/gateway-api/src/opa/opa-client.service.ts:132-133` — `OPA_CIRCUIT_THRESHOLD=5`, `OPA_CIRCUIT_RESET=30000`.
- `apps/messaging-service/src/shared/redis.provider.ts:30-33` — `FAILURE_THRESHOLD=5`, `OPEN_COOLDOWN_MS=30_000`.
- `apps/admin-api-service/src/settings/services/email-sender.service.ts:60-61` — `FAILURE_THRESHOLD=5`, `RECOVERY_TIMEOUT_MS=60_000`.

The numbers happen to converge on 5 / 30s today but two of four use environment overrides and two use literals. New breakers will diverge.

**Rule violated**

Agent spec §"Breaker config discipline": *"Per-(service, operation) overrides allowed; documented in `circuit-breaker.config.ts` with rationale. Config drift between similar operations ... = MEDIUM."*

**Proposed fix direction**

Subsumed by CIRCUIT-CRITICAL-004 — canonical lib carries one config schema.

#### CIRCUIT-MEDIUM-002 — Service-proxy SSE path bypasses the breaker

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Sub-kind tag:** `BREAKER_MISSING` (SSE path)

**Evidence**

- `apps/gateway-api/src/proxy/service-proxy.service.ts:363` — `fetch(targetUrl, ...)` raw inside `proxySSE`. No `circuitBreaker.execute(...)` wrapper, unlike sibling `proxy()` (line 222).

**Rule violated**

Agent spec §"Mandatory breaker coverage" — same external-call rule as standard HTTP proxy.

**Proposed fix direction**

Tier-1: wrap `proxySSE` fetch in `circuitBreaker.execute(...)` with idle-timeout-aware fail mode.

**Expected closer**

`platform-kernel-expert` (gateway slice).

#### CIRCUIT-MEDIUM-003 — Maskinporten / Mattilsynet API / Sentinel-Hub / Open-Meteo fetches in farm-service have no breaker

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Sub-kind tag:** `BREAKER_MISSING`

**Evidence**

- `apps/farm-service/src/regulatory/maskinporten.service.ts:232,335` — raw fetch (gov auth).
- `apps/farm-service/src/regulatory/mattilsynet-api.service.ts:457` — raw fetch.
- `apps/farm-service/src/sentinel-hub/sentinel-hub.service.ts:336` — raw fetch (token endpoint).
- `apps/farm-service/src/sentinel-hub/sentinel-hub-proxy.controller.ts:122,232,322` — raw fetch (3 sites).
- `apps/farm-service/src/weather/services/open-meteo.service.ts:197` — raw fetch.

Farm-service has 7 raw external fetches. Maskinporten outage cascades into regulatory submission failures.

**Rule violated**

Agent spec §"Mandatory breaker coverage" — third-party external APIs.

**Proposed fix direction**

Tier-1 per-API breakers; fail-mode varies (Maskinporten = fail-CLOSED for any submission; weather/sentinel = fail-OPEN with cache).

**Expected closer**

`farm-service-expert` WRITER mode.

#### CIRCUIT-MEDIUM-004 — Internal `signedFetch` helper does not wrap in breaker; every caller responsible

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Sub-kind tag:** `BREAKER_MISSING`

**Evidence**

- `libs/backend-common/src/http/signed-http-client.ts:113-143` — `signedFetch(...)` is the canonical internal-HTTP helper. It attaches HMAC + tenant headers but performs the raw fetch with NO resilience layer.
- Only `gateway-api/proxy/service-proxy.service.ts` wraps; every other caller (admin-api → auth-service, billing → admin-api, notification → auth, …) gets a raw fetch.

**Rule violated**

Agent spec §"Mandatory breaker coverage" — internal microservice cross-pod calls listed as required.

**Proposed fix direction**

Tier-2: extend `signedFetch` to take optional `circuitBreaker` parameter; ESLint rule blocks raw `fetch` in `apps/**` requiring `signedFetch` AND requiring breaker arg.

**Expected closer**

`platform-kernel-expert` (kernel-shared HTTP slice).

#### CIRCUIT-MEDIUM-005 — `messaging-rate-limit.interceptor.ts` is fail-OPEN on Redis outage but applies to billable mutations too

**Severity:** MEDIUM (escalates to HIGH if any of these mutations turn out to be billable)
**Layer:** 2
**State:** OPEN
**Sub-kind tag:** `FAIL_OPEN_BILLABLE`

**Evidence**

- `apps/messaging-service/src/shared/interceptors/messaging-rate-limit.interceptor.ts:129-131` — explicit fail-OPEN comment + behaviour.
- `DEFAULT_RULES` (referenced from same file) covers actions like `send_message`, `upload_attachment`. Once messaging metering is wired (BILLING-CRITICAL-003 follow-up), these become billable.

**Rule violated**

Agent spec §"Fail-mode discipline": Quota enforcement → fail-CLOSED.

**Proposed fix direction**

Tier-1: split the interceptor's fail-mode by action class. Read-side actions = fail-OPEN (UX); billable mutations = fail-CLOSED. Use the canonical breaker so behaviour is consistent.

**Expected closer**

`messaging-expert` WRITER mode.

### LOW

#### CIRCUIT-LOW-001 — Health-check fetches in admin-api / observability are unbreakered

**Severity:** LOW
**Layer:** 2
**State:** OPEN
**Sub-kind tag:** `BREAKER_MISSING`

**Evidence**

- `apps/admin-api-service/src/metrics/system-metrics.service.ts:248` — fetch to monitored endpoints.
- `apps/admin-api-service/src/system-management/services/performance-monitoring.service.ts:431` — fetch to performance endpoints.
- `apps/observability-service/src/metrics/metrics-aggregator.service.ts:448` — fetch to health URL.

These are observability flows; their downstream-failure does not affect business critical paths but still consumes thread budget.

**Rule violated**

Agent spec §"Mandatory breaker coverage" — even observability fetches qualify.

**Proposed fix direction**

Tier-1: wrap with the canonical breaker; fail-mode = fail-OPEN-degraded (observability gap is preferable to cascade).

#### CIRCUIT-LOW-002 — Sensor-service IoT HTTP-REST adapter and channel-detection fetches unbreakered

**Severity:** LOW
**Layer:** 2
**State:** OPEN
**Sub-kind tag:** `BREAKER_MISSING`

**Evidence**

- `apps/sensor-service/src/protocol/adapters/iot/http-rest.adapter.ts:188,250` — third-party IoT vendor fetch.
- `apps/sensor-service/src/sensor-type/channel-detection.service.ts:258` — sensor-type detection fetch.

Sensor-ingestion will likely move to the Rust sidecar per the Rust hybrid migration plan, so wrapping these in TS may be deprecated in 1-2 phases. LOW-rated to avoid duplicating work.

**Rule violated**

Agent spec §"Mandatory breaker coverage".

**Proposed fix direction**

Re-evaluate after Phase 1 of `project_rust_migration.md`. If sensor-ingestion remains TS, Tier-1 wrap. Otherwise, defer to the Rust crate's tower-style breaker.

## Cross-domain dependencies flagged

- **CIRCUIT-CRITICAL-001** (Anthropic): recommend also invoking `ai-safety-auditor` (overlap on Anthropic SDK discipline) and `tenant-cost-attribution-expert` (per-tenant budget attribution requires per-tenant breaker keying — same primitive).
- **CIRCUIT-CRITICAL-002** (POLICY_FAIL_OPEN): recommend invoking `auth-security-expert` (primary owner of auth fail-mode discipline).
- **CIRCUIT-CRITICAL-003** (METER_RACE): recommend invoking `billing-expert` (sibling-finding `BILLING-CRITICAL-003` is the primary record; this finding extends with breaker-discipline angle).
- **CIRCUIT-CRITICAL-004** (canonical library): recommend invoking `platform-kernel-expert` for the library design + `architectural-arbiter` for the fail-mode contract resolution across teams.
- **CIRCUIT-HIGH-001** (Stripe webhook): coordinates with `BILLING-CRITICAL-001` (no Stripe SDK yet) — when SDK is added, the breaker contract MUST be in place first.
- **CIRCUIT-HIGH-005** / **HIGH-006** (Twilio/FCM): overlap with `alert-engine-expert` since alert dispatch path threads through these.
- **CIRCUIT-MEDIUM-005** (messaging rate-limit fail-OPEN): coordinates with `multi-tenant-saas-expert` per-tenant rate-limit pattern.

## Verdict

**BLOCK** — core/cross-cutting scope cannot pass. Four CRITICAL findings, two of which (CIRCUIT-CRITICAL-002 and CIRCUIT-CRITICAL-003) are confirmed fail-OPEN-on-billable-or-auth-path violations of the banned class. CIRCUIT-CRITICAL-004 is the architectural root cause: the absence of a canonical library is what permits the other three to exist. Resolution sequence MUST be:

1. Build `libs/backend-common/src/circuit-breaker/**` (canonical lib) — closes CIRCUIT-CRITICAL-004 and unblocks the others.
2. Migrate the four ad-hoc breakers + wire `claude-api-budget` — closes CIRCUIT-CRITICAL-001.
3. Delete `failOpen` branch from `policy-enforcer.service.ts` — closes CIRCUIT-CRITICAL-002.
4. Wrap `usage-metering.service.ts` Redis sync — closes CIRCUIT-CRITICAL-003.

Steps 2-4 may parallelise once step 1 lands. The CRITICAL-001 → CRITICAL-002 → CRITICAL-003 sequencing is independent only after the canonical lib exists.

## References

- Layer-1: `.claude/knowledge/layer-1-core.md` (TS 5.3.3, no `as any`, branded types).
- Layer-2: `.claude/knowledge/layer-2-patterns.md` §"Outbox pattern" (sibling discipline — atomic publish), §"Tenant isolation" (per-tenant keying mandate), §"CI invariant discipline" (where the new invariant test should land).
- Layer-3: ADR-007 (CQRS), ADR-008 (defense-in-depth), ADR-014/015 (NATS — explicitly out of scope per agent file).
- Sibling cycle findings:
  - `BILLING-CRITICAL-001` (no Stripe SDK) — once added, must inherit canonical breaker.
  - `BILLING-CRITICAL-003 METER_RACE` — extended by CIRCUIT-CRITICAL-003 with breaker-discipline angle.
  - `BILLING-HIGH-005` (outbox absence) — every external publish path needs breaker; outbox + breaker are paired.
  - `DATA-CRITICAL-001` (pg_advisory_lock leak) — pool saturation is an upstream-failure pattern; breaker on advisory-lock-acquire would catch it.
- Plan reference: `/root/.claude/plans/abstract-brewing-mochi.md#Phase-10.5` (per agent file footer).
- Existing assets: `apps/gateway-api/src/proxy/circuit-breaker.service.ts` is the strongest of the five existing implementations — it is a candidate base for the canonical extraction (subject to Redis-backing rework for multi-pod consistency and per-tenant key support).
