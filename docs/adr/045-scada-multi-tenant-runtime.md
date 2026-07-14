# ADR-045 — SCADA runtime multi-tenancy: per-tenant evaluation in the cloud, single-tenant safety authority on the edge

- **Status:** Proposed
- **Date:** 2026-07-14
- **Owner:** sensor-expert + platform operator (Okan)
- **Tracking:** `docs/reviews/orphan-findings.md#ORPHAN-HIGH-340` (SCADA runtime engine is a process-wide singleton, not genuinely multi-tenant); folds in `ORPHAN-HIGH-414` (SCADA policy-class mismatch). Code marker: `RT-011`.
- **Relates to:** ADR-011 (schema-per-tenant), ADR-025 (Rust sensor sidecar), ADR-026 (WASM protocol codec SSoT), ORPHAN-CRITICAL-339 (SCADA persistence tenant isolation — RESOLVED).

## Context

The cloud SCADA runtime (`apps/sensor-service/src/scada-runtime/`) was ported from FUXA — a single-project desktop SCADA — with no tenant dimension. Its evaluation services are `@Injectable()` **process-wide singletons** that hold ONE tenant's in-memory state (alarm rules + eval state, the 1 Hz eval loop, the tag-value cache, scheduler jobs, HMI scripts). One `sensor-service` process can therefore serve **only one tenant at a time**: a second tenant's activation would overwrite the first's bound `tenantId` / rules. The code carries the marker `RT-011` for this conversion (`alarm-engine.service.ts:204`, `script-engine.service.ts:340`).

**Not a live risk today.** ORPHAN-CRITICAL-339 made the persistence layer tenant-fenced and fail-closed (every read/write requires a `tenantId`, `assertTenant` throws on empty); the engine runs UNBOUND (`tenantId=null`) and every 1 Hz tick no-ops. There is no activation path — `setAlarmRules`/`loadScripts`/`setTenantId` have **zero external callers**, so the subsystem is fully dormant. The remaining work is a runtime-architecture conversion PLUS wiring SCADA to run for the first time — done cleanly before any go-live.

### Edge (Rust) vs cloud (TS) boundary — load-bearing

The Rust edge agent (`sens-api-gateway`, crate `suderra-agent`) runs **one physical box = one tenant = one site**. It is the **offline safety authority**: it evaluates the deployed package's alarm rules against the local process image, writes to an encrypted local SQLite (`alarm_history`), and keeps alarming + acting even when the cloud link is down. Its SQLite key is derived from the machine UID; it holds exactly one active package. **The edge stays single-tenant and is out of scope for this redesign.**

The cloud runtime is the **UX / history / notification authority**: it evaluates against the ingestion tag cache, writes per-tenant Postgres (`scada_alarms`/`scada_alarm_chronicle`/`scada_tag_history`), pushes to the HMI over WebSocket, and fires notifications. Both sides share the **same alarm kernel** (`alarm-core` native on the edge, `@platform/alarm-core` = `alarm-core-wasm` in the cloud) so verdicts are drift-zero (1e-4 epsilon); the edge is 2-state (active/clear) offline, the cloud is 4-state + ack modes. This is NOT double-running — it is one math, two scopes/stores. Consequently the cloud engine is **not the life-safety real-time path** (the edge is): the cloud redesign targets industrial-grade goals (per-tenant eval-latency SLO, fairness, observability) but its degradation cannot compromise site safety.

### Current-state map (Explore-verified)

| Layer | State |
|---|---|
| WS / fanout (`ScadaRuntimeGateway`, `TagManagerService` socket cache) | Already tenant-routed (`tenant:${id}` rooms, `tenantTagKey` composite keys) |
| **Global `tagValueCache`** (`tag-manager.service.ts:102`, keyed by `tagId` only) | **Core blocker** — the alarm/script engines read this; same-fqn tenants collide |
| `AlarmEngineService` | single `tenantId`, single `rules[]`, `evalState` keyed by ruleId (not tenant), one 1 Hz `setInterval` |
| `ScriptEngineService` / `SchedulerService` | single bound tenant / tenant-agnostic jobs |
| Persistence (`AlarmStorage`/`DaqStorage`) | tenant-fenced + fail-closed (339); runtime tables are cross-tenant infra (`tenant_id` column, NOT per-tenant clone) |
| **Activation bridge** | **Absent** — published `scada_packages` never feed the engine |
| Deploy contract (scada_packages → signed artifact → MQTT → edge) | Solid, but only reaches the edge |
| Known correctness gaps | ACK event's `tenantId` ignored (`alarm-engine:440`); `SCRIPT_CONSOLE` raw-broadcast to all sockets (`script-engine:311`) |
| Scale | `sensor-service` runs a **single replica** (512M / 0.5 vCPU) → today's singleton loop is safe because there is exactly one process |

### Reusable platform patterns (no new infrastructure)

- Per-tenant registry: `CircuitBreakerService` (`resilience/circuit-breaker.service.ts:211`, per-tenant keyed `Map`, "a noisy tenant cannot trip the breaker for everyone"); `UsageMeteringService` (`:157`, per-tenant state `Map` + stale-tenant eviction sweep). SCADA's own gateway/tag-manager already use tenant-qualified keys.
- Per-tenant write context: `withTenantContext` (`context/with-tenant-context.ts:43`, AsyncLocalStorage) / `runInTenantTransaction(dataSource, 'sensor', tenantId, fn)` (`database/tenant-transaction.ts:251`) — sets `app.current_tenant` GUC + search_path pin, fail-closed. Precedent: `hr-service` payroll handlers.
- Noisy-neighbor: `runInSandbox(code, bridges, limits)` already takes a `SandboxLimits` 3rd arg (`quickjs-sandbox.ts:253`); per-tenant budget via the ai-service `token-budget.service.ts` (Redis `INCRBY`, fail-closed) pattern; SCADA already has `MAX_CONNECTIONS_PER_TENANT`.
- Scale: `LeaderElectionService` (`orchestrator-leader-election/leader-election.service.ts`, Redis `SET NX PX` lease — interface stable, "not yet wired"); tenant-sharding via lease + `FOR UPDATE SKIP LOCKED` (`tenant-schema-provisioner.ts:224`).
- Observability: NO `tenant_id` metric label (cardinality guard, `prometheus.service.ts:96`); per-tenant load via DB rollup + `getTenantMetrics(tenantId)`.

## Decision

A Faz-0 adversarial architecture review reshaped the eval model, the write path, the activation strategy, and the scale strategy. One of its claims was checked firsthand and rejected (see D3). The resulting architecture:

### D1 — Per-tenant `EngineInstance` registry + ONE driver loop (not a god-engine `Map<tenantId, state>`)

A composition-root registry `Map<tenantId, ScadaEngineInstance>`. Each instance **binds its tenant at construction** — preserving the existing fail-closed Tier-1 binding (`alarm-engine.service.ts:183-211`, `assertTenant`) so cross-tenant mixing stays structurally impossible, NOT re-opened as a per-call `tenantId` parameter on every method (which would be a Tier-1→Tier-3 regression and a silent-leak surface). A **single** driver `setInterval` iterates the registry and calls `instance.evaluateOnce(now)` — one timer, no N-timer overhead, per-tenant isolation intact. The `ScriptEngineService`↔`AlarmEngineService` coupling (`script-engine.service.ts:340` reads the engine's bound tenant) resolves naturally: each instance owns its own script/scheduler state, so `SchedulerService.jobs` is re-keyed per tenant by construction (fixes the `scriptId`-only collision at `scheduler.service.ts:394`).

### D2 — Engine-side tag cache tenant-qualified

`tag-manager.service.ts:102` `tagValueCache` (keyed by `tagId` only) is a **cross-tenant DATA bug**, not just a refactor: two tenants sharing an fqn collide, and the engine reads it (`alarm-engine.service.ts:236`, `script-engine.service.ts:329`). Tenant-qualify it (reuse `tenantTagKey`, `:71`) with a per-tenant name→tagId index (replacing the O(n) `getAllTagValues().find` at `script-engine.service.ts:346`).

### D3 — Per-tenant write = coalesced per-tenant-per-tick tenant-context transaction + per-tenant batched multi-row upsert

**Verified firsthand (correcting the review's CRITICAL-1):** the db-migrate post-migration sweep DOES apply `tenant_isolation_policy` to the three SCADA tables — `applyTenantRlsToSchema` (`apply-tenant-rls.helper.ts:442`) runs for `sensor` (`tenantRls: true` hardening), and `discoverTenantScopedTables` (`:288-353`) selects every `tenant_id`-bearing base table except the audit-ledger excludes + identity tables; SCADA is neither, so it gets the policy. The review checked only migrations for `CREATE POLICY` (there are none) and missed the runtime sweep. So the policy IS real → the singleton no-GUC writer's INSERT WOULD be rejected (`WITH CHECK tenantId = current_tenant` fails on a null GUC) → ORPHAN-414's latent write-reject is genuine and the GUC IS required.

The review's efficiency point stands against the NAIVE form — a full `runInTenantTransaction` per *write* (≈5-6 round-trips incl. the context assert, per alarm) is wasteful at N tenants × K active alarms × 1 Hz.

**Correction (Faz 2 implementation, supersedes the review's phrasing):** the engine already loops per tenant per tick, so it BUFFERS each tenant's write-intents (upserts deduped by id, chronicle appends, deletes) and flushes them in ONE `runInTenantTransaction('sensor', tenantId, …)` at the end of that tenant's tick — a *per-tenant-per-tick* transaction, not per-write, and opened ONLY for tenants that actually changed alarm state that tick (most ticks: none), so the transaction rate is far below N/s. Inside it, `tenant_id` is a column, so a per-tenant multi-row `INSERT … VALUES (…),(…) ON CONFLICT (id) DO UPDATE` upserts all of that tenant's dirty alarms at once; the flush is fire-and-forget with a per-tenant in-flight guard so the 1 Hz tick never blocks on DB latency. Per-tick value drift on an unchanged active alarm is NOT persisted (the live value reaches the HMI over the WS fan-out) — the DB record tracks alarm lifecycle.

**Why NOT the review's "connection-scoped GUC + one cross-tenant `INSERT … VALUES (t1,…),(t2,…)`":** it is RLS-INCOMPATIBLE. The FORCED policy's `WITH CHECK tenant_id = current_tenant` admits only rows whose `tenant_id` matches the ONE tenant bound to the connection's `app.current_tenant`, so a single INSERT cannot carry multiple tenants' rows — batching MUST be per-tenant. The genuinely cross-tenant maintenance sweeps that have NO per-row tenant (retention `cleanup*`, `getDataBounds`) instead run under the audited `BypassRlsService.withBypass` (the outbox-worker class), not a tenant context.

This resolves 414 — writes now SATISFY the existing FORCED policy, which ENFORCES them (a mis-stamped `tenant_id` is refused by Postgres — Tier-1) — at near-zero per-tick cost and needs no new policy class.

### D4 — Lazy activation on first operator subscriber (NOT boot-load-ALL)

Boot-loading every PUBLISHED package into one 512 MB / 0.5 vCPU process would OOM (`scada-package.service.ts:57` 1 MB doc + 50×64 KB scripts per tenant × N) and contradicts the eviction it was paired with. SCADA is operator-facing: a tenant with no connected operator socket needs no running engine, and the gateway already tracks connected tenants by room (`scada-runtime.gateway.ts:229-232`). **Activate on first operator subscribe**, cap active tenants per process, LRU-evict idle instances (stale-tenant sweep, `UsageMeteringService:93-118` pattern). Package publish/unpublish/archive updates the active instance's rules/scripts (or is a no-op if inactive).

### D5 — Real scale = tenant-sharding; single-replica needs no leader; actuation gated on fresh ownership

Leader-election alone is HA, not scale — the leader still evaluates every tenant on one 0.5 vCPU replica; the standby reserves 512 MB idle for **2× cost, 0 throughput**. And on a 30 s lease-churn split-brain, two leaders would both fire `setValue` → the physical-actuation path (`alarm-engine.service.ts:630` → `tagManager.writeTagValue` → the gateway-documented "physical-actuation control plane", `:896`) → **double actuation**. So:
- **Real horizontal scale = consistent-hash tenant→replica sharding** (each tenant owned by exactly one replica → linear scale + double-eval structurally impossible). Designed in Faz 5, deploy-later (sensor-service is single-replica today).
- **Single-replica today needs no leader-election** — one process is safe by construction.
- **Every actuation is gated on FRESH ownership/leadership** (re-checked at fire time, never a cached belief), so that whichever guard is active (single-process, leader, or shard-owner) can never double-actuate. `LeaderElectionService` is the interim guard if a 2nd replica is added before sharding.

### D6 — Fail-safe eval: tick budget + watchdog + rule cap + transition-only persist

The single shared loop runs on the same Node event-loop as ingestion fan-out + the socket gateway (`alarm-engine.service.ts:217` synchronous `for`), has **no rule cap** and **no tick-duration watchdog**, and **re-persists every active alarm every tick** (`:285-290`, write amplification). Industrial requirements: a **tick-duration histogram + budget watchdog** (observably shed / grey-out as p99 approaches the period — never a silent `setInterval` overrun), **per-tenant fairness** (round-robin cursor so tenant #999 isn't always last), a **rule-count cap** per package (mirroring the 50-script cap), and **persist on transition + slow heartbeat only** (drop the per-tick re-save). Moving eval to a `worker_threads` pool is a scale lever gated on measured event-loop starvation — deferred, not day-one, given aquaculture's slow process variables (temp/DO/pH) and the single replica.

### D7 — Keep runtime tables cross-tenant (tenant_id + RLS), do NOT clone; static imports; close correctness gaps

The three runtime tables stay cross-tenant single-table with `tenant_id` + `tenant_isolation_policy` (per-tenant clone would explode table count and break the singleton-write + platform-wide alarm dashboard — `schema-manager.service.ts:222-230` rationale is correct). Replace the `require()`-in-try/catch optional-provider loading (`scada-runtime.module.ts:51-70`) with static imports (a swallowed import error silently disables the SCADA control plane). Fix the two correctness gaps: route the ACK event by its `tenantId` (`alarm-engine.service.ts:440` currently ignores it) and scope `SCRIPT_CONSOLE` to the tenant room (`script-engine.service.ts:311` currently raw-broadcasts to all sockets).

## Consequences

- **Preserved (do not regress):** ORPHAN-CRITICAL-339's fail-closed per-tenant binding + `tenant_id`-column cross-tenant tables — the review confirmed this backbone is correct.
- **Positive:** SCADA becomes genuinely multi-tenant AND runs for the first time; ORPHAN-414 resolved by making the writer GUC-correct (no new policy class); per-tenant isolation stays Tier-1 (construction-bound instances); noisy-neighbor bounded; industrial fail-safe (watchdog + fairness + no silent overrun).
- **Costs / risks:** larger surface than a naive per-tenant flag (per-tenant instance lifecycle + activation bridge + budget broker); the eval loop's real ceiling is unmeasured today (no watchdog) — Faz 6 must land the histogram before any load claim; tenant-sharding is designed-not-deployed, so multi-replica scale is a future deploy, not this program.
- **Edge unchanged:** `sens-api-gateway` stays single-tenant offline safety authority — untouched.

## Phasing

Faz 1 evaluation tenant-qualify (RT-011 core) · Faz 2 per-tenant write context (ORPHAN-414) · Faz 3 activation bridge + lifecycle (SCADA goes live) · Faz 4 noisy-neighbor budget · Faz 5 leader-guard + tenant-sharding design · Faz 6 observability + SLO + fail-safe. Each phase is its own PR with its own verification, mirroring the 2026-07-13 migration-seam remediation discipline.
