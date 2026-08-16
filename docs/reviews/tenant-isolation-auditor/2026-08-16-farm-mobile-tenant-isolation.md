# farm-service + AquaMobil tenant isolation audit — 2026-08-16

**Agent:** `tenant-isolation-auditor` · **Mode:** CATCHER (read-only) · **Lane:** farm
**Cycle:** `2026-08-16-farm-mobile-agent-audit` · **Verdict:** CONDITIONAL
**Findings surviving verification:** 5 (CRITICAL 0 · HIGH 0 · MEDIUM 2 · LOW 3) · 2 refuted

> Produced by a 27-agent audit workflow, then verified by a second 25-agent pass.
> **Every** claim — CRITICAL through LOW — was handed to an independent verifier
> instructed to **refute** it by reopening each cited line, with "refuted" as the
> default when the evidence did not clearly hold. Claims that could not be defended
> were dropped into the Refuted section below; claims that proved smaller or larger
> than filed carry a corrected severity.
>
> **Finding IDs** use the `PRODUCT-TENANT-*` prefix this agent's contract in
> `.claude/shared/output-format.md` assigns it. That prefix is **rejected** by the
> `id` pattern in `docs/reviews/_registry/findings.jsonl.schema.json`, so these findings
> cannot be registered at all — see `PROC-MEDIUM-016` in the cycle report.

## Scope

Read the rule SSoT (/home/user/aquaculture_platform/CLAUDE.md, apps/farm-service/CLAUDE.md,
web/CLAUDE.md, web/apps/aquamobil/CLAUDE.md), .claude/shared/output-format.md,
.claude/knowledge/layer-2-patterns.md, layer-1-typeorm.md. Backend tenant plumbing:
libs/backend-common/src/{middleware/tenant-context.middleware.ts,
middleware/tenant-schema.middleware.ts, middleware/strip-internal-headers.middleware.ts,
middleware/verified-user-assertion.middleware.ts, decorators/tenant.decorator.ts,
guards/tenant.guard.ts, database/tenant-scoped-repository.ts,
database/tenant-connection-bootstrap.service.ts, database/tenant-transaction.ts,
database/for-each-tenant-schema.ts, database/rls/{apply-tenant-rls.helper.ts,
rls-connection-bootstrap.service.ts}, database/schema-manager.service.ts
(getRlsExcludeTablesForService), redis/tenant-redis.service.ts, nats/tenant-validating-consumer.ts}.
Gateway: apps/gateway-api/src/federation/authenticated-data-source.ts. Event bus:
platform/libs/event-bus/src/nats/nats-event-bus.ts. farm-service: app.module.ts,
scheduler/{cron-jobs.service.ts, feeding-scheduler.service.ts, scheduler.module.ts},
events/listeners/{farm-stock-projection, sensor-temperature-projection}.listener.ts,
common/cache/{cacheable,cache-evict}.interceptor.ts, mobile-dashboard/mobile-dashboard.resolver.ts,
mobile-command/entities/farm-mobile-command-receipt.entity.ts, outbox/farm-outbox.entity.ts, plus
repo-wide greps for getRepository/@InjectRepository/where:{id}. Invariants:
tests/invariants/{farm-service-tenant-isolation, tenant-context-ssot}.spec.ts,
`apps/farm-service/src/**tests**/e2e/tenant-schema-routing.architecture.spec.ts`. AquaMobil:
src/pwa/{offline-queue.ts, sw-replay.ts}, src/hooks/{useOfflineQueue.tsx, useAuth.tsx},
src/utils/{tenant-query-keys.ts, user-scoped-cache-key.ts}, src/services/authenticated-fetch.ts,
src/types/index.ts, and web/shared-ui/src/utils/tenant-query-keys.ts for mirror comparison.

## Executive summary

The request-path tenant boundary is genuinely strong: JWT/HMAC-assertion is the trust anchor
(VerifiedUserAssertionMiddleware rebuilds req.user from the signed effectiveTenantId), search_path
is re-asserted on every pool checkout, and runInTenantTransaction/runInTenantRead fail closed on
schema+RLS-GUC read-back. Handler-layer tenantId discipline in farm-service is near-total.

The failures are all OUTSIDE the request path. (1) Every per-tenant cron in farm-service pins
search_path but never enters withTenantContext, so RlsConnectionBootstrap leaves app.current_tenant
empty and the FORCEd tenant_isolation_policy denies every row — the maintenance, low-stock, FCR,
feeding-plan, retention-cleanup and MinIO-orphan crons are silent no-ops that log success. The SSoT
fan-out helper forEachTenantSchema has the same hole. (2) NATS consumers re-derive tenant from the
event body; NatsEventBus never passes msg.subject to handle(), and TenantValidatingConsumer has zero
adoption repo-wide. (3) The AquaMobil offline queue is partitioned by tenant but not by
authenticated user, so a session that ends without logout lets the next user's reconnect replay the
prior user's escape/mortality/harvest records under their own identity. (4) farm-service @Cacheable
keys Redis off the raw x-tenant-id header.

## Findings (by severity)

### MEDIUM

### PRODUCT-TENANT-MEDIUM-001

**Title:** Every per-tenant cron in farm-service runs outside tenant context — RLS GUC stays empty
and the tenant_isolation_policy denies all rows, so the crons silently no-op

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-TENANT-HIGH-001` by `tenant-isolation-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/scheduler/cron-jobs.service.ts:316-328 —
  then `queryRunner.manager.find(MaintenanceSchedule, { where: { status: ACTIVE } })` — no
  withTenantContext, no bindTenantRlsContext

  ```text
  const queryRunner = this.dataSource.createQueryRunner(); await queryRunner.connect(); ... SET search_path TO "${schema}", farm, public
  ```

- apps/farm-service/src/scheduler/feeding-scheduler.service.ts:798-801 —
  `SELECT DISTINCT "tenantId" ... FROM "batches_v2" WHERE "isActive" = true` on a bare QueryRunner;
  identical pattern at :861, :937, :1007, :1083, :1162
- libs/backend-common/src/database/rls/rls-connection-bootstrap.service.ts:255-273 —
  readRlsContext(): "No request context (cron job, startup, raw script). Leave defaults — empty
  tenant \+ bypass off → deny-by-default behaviour."
- libs/backend-common/src/database/for-each-tenant-schema.ts:206-213 — runTenantFanout starts the
  transaction and pins search_path transaction-locally but never calls
  set_config('app.current_tenant', …); getRlsExcludeTablesForService('farm')
  (schema-manager.service.ts:1064-1072) excludes only infrastructureTables, so maintenance_schedules
  / batches_v2 / spare_parts / work_orders all carry the policy
- apps/farm-service/src/scheduler/cron-jobs.service.ts:945 —
  `await withTenantContext(tenantId, async () => {` in minioOrphanCleanup proves the correct pattern
  exists in the same file (its own discovery query at :927-928 is still outside it, so that cron
  self-disables too)

**Rule violated:**

CLAUDE.md "Tenant-ID sourcing" \+ layer-2-patterns.md §Tenant isolation (RLS defense-in-depth); the
fail-closed boundary contract documented in
libs/backend-common/src/database/tenant-transaction.ts:127-143 ("turns those two silent failure
modes into a hard TenantContextError") is bypassed entirely

**Proposed fix direction:**

Make the tenant fan-out the only way to touch a tenant schema off-request: fold
`withTenantContext(tenantId, …)` \+ `bindTenantRlsContext` (or the full
`assertTenantTransactionContext`) INTO runTenantFanout/forEachTenantSchema so no caller can obtain a
QueryRunner that is search_path-routed but RLS-unbound (Tier 2 make-it-automatic). Promote the
fan-out to `forEachVerifiedTenantSchema`, which already carries the ledger-proven {schemaName,
tenantId} pair, and delete the hand-rolled createQueryRunner loops in cron-jobs.service.ts and
feeding-scheduler.service.ts. Add a Postgres-backed integration spec that seeds two tenants and
asserts each cron observes exactly its own rows — the current absence of any such test is why a
whole cron suite can be inert without a single red signal (Tier 3).

**Affected surface (ripple set):**

- `apps/farm-service/src/scheduler/cron-jobs.service.ts`
- `apps/farm-service/src/scheduler/feeding-scheduler.service.ts`
- `libs/backend-common/src/database/for-each-tenant-schema.ts`
- `libs/backend-common/src/database/tenant-transaction.ts`
- `apps/farm-service/src/common/file-cleanup/farm-orphan-cleanup.service.ts`
- `apps/farm-service/src/maintenance/services/maintenance-schedule.service.ts`
- `tests/invariants/farm-service-tenant-isolation.spec.ts`

**Expected closer:**

multi-tenant-saas-expert WRITER mode, with data-expert review on the RLS-GUC binding inside
runTenantFanout

**Verifier note:**

Mechanism verified, severity inflated and evidence set partly dead code. VERIFIED:
apps/farm-service/src/scheduler/cron-jobs.service.ts:316-328 is exactly as quoted (bare
createQueryRunner \+ raw `SET search_path`, no withTenantContext);
libs/backend-common/src/database/for-each-tenant-schema.ts:200-213 pins search_path
transaction-locally and never sets app.current_tenant;
libs/backend-common/src/database/rls/rls-connection-bootstrap.service.ts:176-202,255-273 sets the
GUC pair on EVERY pool checkout and falls through to ('' , 'off') when there is no ALS frame. RLS
really is armed on the tenant tables the crons read: apps/farm-service/src/app.module.ts:484-492
registers RlsModule.forPoolService, and apps/db-migrate/src/schema-registry.ts:200-207 gives farm
TENANT_SCHEMA_POST_MIGRATION_HARDENING (tenantRls:true) which runs
applyTenantRlsToSchema(schemaOverride: `tenant_<uuid>`) in
apps/db-migrate/src/tenant-schema-provisioner.ts:303-314 with ENABLE+FORCE.
maintenance_schedules/batches_v2/spare_parts/work_orders all declare `@Column('uuid') tenantId`, so
they are discovered by the helper and are NOT in getRlsExcludeTablesForService('farm')
(infrastructureTables only). farm-service connects as the non-superuser farm_service role
(docker-compose.yml:308), so FORCE applies. WHAT THE CLAIM OVERSTATES: (a) the failure is
fail-CLOSED — zero rows, no cross-tenant read or write; there is no isolation breach, only a
silently no-op cron, i.e. a correctness/availability defect misfiled as a tenant-isolation HIGH; (b)
5 of the 6 feeding-scheduler citations (:798-801 generateDailyFeedingPlan, :861
sendFeedingReminders, :937 dailyFeedingSummary, :1007 analyzeFCR, :1083 checkFeedStock) sit inside
methods that return early via legacyFeedingEngineEnabled()
(apps/farm-service/src/feeding/constants/legacy-engine-gate.ts:24-26 — requires
FEEDING_LEGACY_ENGINE_ENABLED==='true', off by default), so those are dead code in a default
deployment; only :1162 weeklyFeedForecast is live. The live surface is cron-jobs.service.ts (overdue
maintenance/work orders, low stock, work-order generation, the minioOrphanCleanup discovery query at
:923-937) plus weeklyFeedForecast. MEDIUM.

### PRODUCT-TENANT-MEDIUM-003

**Title:** AquaMobil offline queue is partitioned by tenant but NOT by authenticated identity — a
replay drains the previous user's queued writes under the next user's credentials

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `PRODUCT-TENANT-HIGH-003` by `tenant-isolation-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/pwa/offline-queue.ts:338 —
  `await set(${QUEUE_PREFIX}${tenantId}_${id}, stored, queueStore);` the key and the StoredOperation
  carry tenantId only, no userId
- web/apps/aquamobil/src/types/index.ts:421-426 —
  `interface QueuedOperation { id; tenantId; type; payload; createdAt … }` — the comment names
  tenant partitioning as the whole isolation story
- web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:366,478-493 —
  `syncAllOperations(tenantId, executeGraphQL)` filters by tenant prefix only, and the reconnect
  effect auto-fires 1s after `isOnline && pendingCount > 0` for whoever is logged in
- web/apps/aquamobil/src/hooks/useAuth.tsx:265-268 and :318-381 — a failed silent restore returns
  without any wipe, and `login`/`loginWithToken` never call clearAllUserData; only explicit `logout`
  (:427-516) wipes, so an app-kill or refresh-token expiry leaves the prior user's queue resident
- web/apps/aquamobil/src/utils/user-scoped-cache-key.ts:1-27 — MT-CRITICAL-051 already established
  that tenant-only partitioning is insufficient on shared field devices and fixed the CACHE half
  with a branded UserScopedCacheKey; the QUEUE half was left tenant-only

**Rule violated:**

tenant-isolation-auditor domain rule: "mobile local-storage, offline queue, or persisted-query state
must be partitioned by tenant AND authenticated identity"; CLAUDE.md Security (identity is the trust
anchor)

**Proposed fix direction:**

Extend the MT-CRITICAL-051 branding to the queue: make the queue key and StoredOperation carry a
REQUIRED userId (`pending_${tenantId}_${userId}_${id}`) produced by a branded builder, so an
enqueue/drain that omits the authenticated principal cannot compile (Tier 1). syncAllOperations must
take {tenantId, userId} and refuse any op whose principal differs from the live session — the
sw-replay lane (sw-replay.ts:219-225) already mints its identity from the refresh cookie and can
pass the subject through. Separately, make session ESTABLISHMENT wipe residue: run the same
clearAllUserData teardown on login/restore whenever the incoming principal differs from the
last-known one, so an un-logged-out session end is not a silent carry-over. Ops belonging to another
principal must surface in the UI as blocked-for-review, never be silently discarded — they are
regulated escape/mortality records.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/pwa/offline-queue.ts`
- `web/apps/aquamobil/src/pwa/sw-replay.ts`
- `web/apps/aquamobil/src/hooks/useOfflineQueue.tsx`
- `web/apps/aquamobil/src/hooks/useAuth.tsx`
- `web/apps/aquamobil/src/types/index.ts`
- `web/apps/aquamobil/src/utils/user-scoped-cache-key.ts`
- `web/apps/aquamobil/src/pwa/**tests**/offline-queue.spec.ts`

  ```text
  apps/farm-service/src/mobile-command/entities/farm-mobile-command-receipt.entity.ts
  ```

**Expected closer:**

mobile-app-auditor WRITER mode; hand off the server-side receipt attribution question to
form-write-auditor

**Verifier note:**

Facts verified, but this is same-tenant write misattribution, not a tenant-isolation break.
VERIFIED: web/apps/aquamobil/src/pwa/offline-queue.ts:337-338 keys records
`pending_${tenantId}_${id}` and StoredOperation (:325-335) carries no userId; the AES key is
DURABLE, not per-session (offline-queue.ts:55-69 persists it in the keyStore), so a later user on
the device can decrypt A's payloads; web/apps/aquamobil/src/hooks/useOfflineQueue.tsx:348-368 and
the reconnect effect at :478-493 drain everything under the active tenant 1s after coming online;
web/apps/aquamobil/src/hooks/useAuth.tsx:419-516 wipes via clearAllUserData only on explicit logout,
while the silent-restore failure path (:264-300) and login/loginWithToken (:318-412) never wipe.
WHAT THE SEVERITY OVERSTATES: cross-tenant replay is structurally impossible — syncNow returns early
without a tenantId and every read/drain filters on the `${QUEUE_PREFIX}${tenantId}_` prefix, so a
different tenant's residue is left resident but never sent. The realizable harm is user A's queued
op replayed under user B's JWT within the SAME tenant, i.e. misattributed writes (worst case
ClockInInput/ClockOutInput at web/apps/aquamobil/src/types/index.ts:274-287, whose employeeId is
optional so the server falls back to the JWT subject → wrong person clocked in). No cross-tenant
data flow and no disclosure of A's data to B in the sync path. Real but MEDIUM, not HIGH.

### LOW

### PRODUCT-TENANT-MEDIUM-005

**Title:** The farm-service tenant-isolation invariant claims absolute discipline but only scans
`*.handler.ts` — service-layer id-only lookups are structurally undetected

**Severity:** LOW (filed as MEDIUM, downgraded by adversarial verification)
**Layer:** 3
**State:** OPEN
**Raised as:** `PRODUCT-TENANT-MEDIUM-005` by `tenant-isolation-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- tests/invariants/farm-service-tenant-isolation.spec.ts:60 —
  `} else if (entry.endsWith('.handler.ts') && !entry.endsWith('.spec.ts'))` — resolvers,
  query-handlers named `*.service.ts`, dataloaders and services are never walked
- tests/invariants/farm-service-tenant-isolation.spec.ts:20-24 — "The discipline is absolute: every
  findOne / find / findBy that targets a tenant-scoped entity carries tenantId in the where clause"
  — the stated contract is wider than the enforcement
- apps/farm-service/src/scheduler/feeding-scheduler.service.ts:1763-1765 — `markFeedingCompleted`:
  `this.feedingRecordRepository.findOne({ where: { id: feedingId } })` with no tenantId, then
  mutates and saves the row
- apps/farm-service/src/scheduler/feeding-scheduler.service.ts:699-701 —
  `this.feedRepository.findOne({ where: { id: currentFeedId } })` with no tenantId
- apps/farm-service/src/sentinel-hub/sentinel-credential-cutover.service.ts:448 —
  `repository.findOne({ where: { id: rowId } })` with no tenantId

**Rule violated:**

CLAUDE.md Layer Rules §6 (getScopedRepository / tenant-scoped queries) and the invariant's own
stated contract; apps/farm-service/CLAUDE.md §Domain invariants names this spec as the guard

**Proposed fix direction:**

Widen the walker to every non-spec .ts under apps/farm-service/src (services, resolvers,
dataloaders, listeners), not just `*.handler.ts` — the leak class is file-name-independent. Then
make the residual sites impossible rather than merely detected: convert the remaining raw
, which
injects tenantId on every method, so a forgotten filter cannot be written. Any genuinely
global-catalogue read must go through the sanctioned `runInSourceRead` boundary
(tenant-transaction.ts:436) so cross-tenant reads stay auditable in one place.

```text
Repository<T>` injections in these services to `TenantScopedRepository`/`tenantManagerRepo
```

**Affected surface (ripple set):**

- `tests/invariants/farm-service-tenant-isolation.spec.ts`
- `apps/farm-service/src/scheduler/feeding-scheduler.service.ts`
- `apps/farm-service/src/sentinel-hub/sentinel-credential-cutover.service.ts`
- `apps/farm-service/src/equipment/services/tank-equipment-adapter.service.ts`
- `apps/farm-service/src/batch/services/sgr-calculator.service.ts`

**Expected closer:**

test-runner WRITER mode for the invariant widening; farm domain expert for the repository
conversions

**Verifier note:**

The scanner-scope half is true: tests/invariants/farm-service-tenant-isolation.spec.ts:60 walks only
'`*.handler.ts`', so services/resolvers/dataloaders are never scanned, while the header prose at
:19-24 calls the discipline absolute (:5-8 does scope it to handlers, so the overreach is partial).
But every cited leak site collapses. sentinel-credential-cutover.service.ts:445-455 is flatly wrong:
the repository is tenantManagerRepo(queryRunner.manager, SentinelHubSettings,
canonicalIdentity.tenantId) which is a TenantScopedRepository injecting tenantId on every call
(libs/backend-common/src/database/tenant-scoped-repository.ts:545-556), plus an explicit tenant
assertion at :451-453. feeding-scheduler.service.ts:1755-1787 (markFeedingCompleted) has zero
callers anywhere in the repo (grep across all non-node_modules .ts returns only the definition) \-
dead code, no request path. feeding-scheduler.service.ts:699-701 looks up a feed id taken from
batch.feedingSummary.currentFeedId where the batch was already tenant-filtered at :657-660 \- the id
is not caller-supplied. On top of that both tables are per-tenant (@Entity('feeding_records')
feeding-record.entity.ts:110 and @Entity('feeds') feed.entity.ts:162 omit schema:), so per-request
queries run under search_path '`tenant_<uuid>`', farm, public
(tenant-connection-bootstrap.service.ts:110-135) and cannot see another tenant's rows \- the spec's
own rationale at :12-17 (isolation is ORM-filter-only) is stale. Real as a guard-coverage/dead-code
gap, not the tenant-leak class filed.

### PRODUCT-TENANT-MEDIUM-006

**Title:** AquaMobil's tenant query-key mirror omits the session-epoch segment its own header claims
to copy verbatim — cache generation is not reset on principal re-entry

**Severity:** LOW (filed as MEDIUM, downgraded by adversarial verification)
**Layer:** 1
**State:** OPEN
**Raised as:** `PRODUCT-TENANT-MEDIUM-006` by `tenant-isolation-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- web/apps/aquamobil/src/utils/tenant-query-keys.ts:4 — "Mirrors
  web/shared-ui/src/utils/tenant-query-keys.ts verbatim." and :44 —
  `return [TENANT_QUERY_KEY_ROOT, tenantId, ...segments] as const;`
- web/shared-ui/src/utils/tenant-query-keys.ts:106 —
  `return ['tenant', tenantId, ...segments, sessionEpochSegment()] as const;` plus
  hasSameTenantSessionBoundary (:54-67) which fails closed on epoch-less keys
- web/apps/aquamobil/CLAUDE.md §Invariants — "the aquamobil mirror has no epoch segment, so it still
  serves stale cache after tenant re-entry. That gap is open; the file's own 'Mirrors … verbatim'
  header comment is wrong too."
- web/apps/aquamobil/src/hooks/useAuth.tsx:489-496 — the logout wipe is the only thing standing
  between two principals' React Query caches; the un-logged-out session-end path (:265-268) has no
  equivalent

**Rule violated:**

web/CLAUDE.md §Data fetch (createTenantQueryKey is the cross-module SSoT, FE-CRITICAL-014/015/016);
the aquamobil file's own stated contract

**Proposed fix direction:**

Stop maintaining a hand-copied security primitive. Either publish the key factory (and
sessionEpochSegment) as a tiny dependency-free module both surfaces import — the standalone-lockfile
argument does not justify duplicating a cross-tenant-leak control — or, if the standalone bundle
boundary must hold, add an invariant that diffs the two files' exported behaviour and fails on drift
(Tier 3). Until parity exists, the header comment asserting equality must go; a false SSoT claim is
worse than no claim.

**Affected surface (ripple set):**

- `web/apps/aquamobil/src/utils/tenant-query-keys.ts`
- `web/shared-ui/src/utils/tenant-query-keys.ts`
- `web/shared-ui/src/utils/session-epoch.ts`
- `web/apps/aquamobil/src/hooks/useAuth.tsx`
- `tests/invariants/`

**Expected closer:**

frontend-expert WRITER mode with mobile-app-auditor review

**Verifier note:**

The factual drift is confirmed: web/apps/aquamobil/src/utils/tenant-query-keys.ts:4 claims it
mirrors shared-ui verbatim while :44 returns [root, tenantId, ...segments] with no epoch, and
web/shared-ui/src/utils/tenant-query-keys.ts:106 appends sessionEpochSegment()
(session-epoch.ts:24-49). So the header comment is false and there is no drift guard. The impact
filed is inflated. aquamobil has no impersonation or tenant-switch path (grep for
switchTenant/impersonat/actAs in web/apps/aquamobil/src returns nothing outside unrelated test
helpers) and no sessionEpoch usage, so the `A->B->A` re-entry case the epoch exists for cannot occur
there. There is no query-cache persister (no persistQueryClient/persister anywhere in aquamobil src;
the QueryClient is created in main.tsx), so cache is in-memory and dies with the tab \- which also
defeats the cited useAuth.tsx:265-268 path, since that block is inside the mount-time restoreSession
where the cache is empty by construction. Every mid-session session-end funnels through logout()
(useAuth.tsx:541, 571), which does removeQueries on the tenant key space plus queryClient.clear()
(:489-496). Residual is a false SSoT header comment and a hand-copied primitive with no parity test
\- already recorded as an open gap in web/apps/aquamobil/CLAUDE.md. Cosmetic/documentation scope,
hence LOW not MEDIUM.

### PRODUCT-TENANT-LOW-007

**Title:** refreshAnalyticsViews cron refreshes source-schema-qualified matviews that no longer
exist in the active migration manifest, once per tenant schema

**Severity:** LOW
**Layer:** 1
**State:** OPEN
**Raised as:** `PRODUCT-TENANT-LOW-007` by `tenant-isolation-auditor` in cycle
`2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/scheduler/cron-jobs.service.ts:841 —
  executed inside the per-tenant `for (const schema of tenantSchemas)` loop at :857-878, i.e. the
  same source-schema object is refreshed N times and no tenant's own object ever is

  ```text
  const viewsToRefresh = ['farm.mv_daily_batch_feeding', 'farm.mv_daily_tank_water_quality'];
  ```

- apps/farm-service/src/database/migrations/.archive/2026-05-18T09-42-08-277Z/1787400000000-AddDailyBatchFeedingMaterializedView.ts:113
  and .../1787500000000-AddDailyTankWaterQualityMaterializedView.ts:88 — the CREATE MATERIALIZED
  VIEW statements live only under .archive/
- apps/farm-service/src/database/migrations/manifest.ts — grep for
  AddDailyBatchFeedingMaterializedView / AddDailyTankWaterQualityMaterializedView returns 0 matches,
  so FARM_MIGRATIONS never creates these objects
- apps/farm-service/src/scheduler/cron-jobs.service.ts:866-873 — the failure is swallowed as
  `this.logger.warn(… refresh skipped …)`, so the permanent no-op is indistinguishable from a
  legacy-tenant gap

**Rule violated:**

apps/farm-service/CLAUDE.md §Schema (per-tenant objects must not be source-schema-qualified;
search_path controls tenant isolation) \+ CLAUDE.md Architectural Approach (no dead paths kept alive
by a swallowed warning)

**Proposed fix direction:**

Delete the cron together with the read path it was built for, or re-land the matviews as per-tenant
objects created by TenantSchemaSyncService and refresh them UNQUALIFIED so search_path routes them —
a `farm.`-qualified object inside a per-tenant loop is the exact anti-pattern
tenant-schema-routing.architecture.spec.ts forbids for entities. Whichever way it goes, replace the
blanket warn-and-continue with a fail-loud check that the target object exists for the tenant, so a
dead scheduled job cannot masquerade as a healthy one.

**Affected surface (ripple set):**

- `apps/farm-service/src/scheduler/cron-jobs.service.ts`
- `apps/farm-service/src/database/migrations/manifest.ts`
- `apps/farm-service/src/feeding/services/feeding-ledger.service.ts`
- `apps/farm-service/src/**tests**/e2e/tenant-schema-routing.architecture.spec.ts`

**Expected closer:**

farm domain expert WRITER mode

**Verifier note:**

Verified as filed. apps/farm-service/src/scheduler/cron-jobs.service.ts:841 lists
'farm.mv_daily_batch_feeding' and 'farm.mv_daily_tank_water_quality', and :855-878 runs REFRESH
MATERIALIZED VIEW CONCURRENTLY on those source-schema-qualified names inside the per-tenant loop
after SET search_path TO tenant schema, farm, public \- so the qualification defeats the routing and
the same object is targeted once per tenant. The CREATE statements exist only under
.archive/2026-05-18T09-42-08-277Z/ (1787400000000:113 and 1787500000000:88); the active manifest
(apps/farm-service/src/database/migrations/manifest.ts, FARM_MIGRATIONS from Baseline1800000000000)
contains no matview migration and grep for MATERIALIZED across the active migrations directory
returns zero hits including the Baseline, so a database built from the current chain never has these
objects. The failure is swallowed at :866-873 as logger.warn, making a permanent no-op look like a
legacy-tenant gap, and nothing reads the views (only comments at feeding-ledger.service.ts:117 and
cron-jobs.service.ts:825). No tenant-isolation harm \- dead scheduled work plus nightly log noise,
so LOW is the correct severity.

## Refuted by adversarial verification

These did **not** survive independent re-checking. They are recorded so the same
claim is not re-raised next cycle.

### ~~PRODUCT-TENANT-HIGH-002~~

**Title:** NATS consumers derive tenant from the event body; the subject envelope is structurally
unavailable to handlers and TenantValidatingConsumer has zero adoption repo-wide

**Raised as:** HIGH · **Result:** REFUTED

The proposed control is tautological, so the missing-guard claim does not hold. The NATS subject is
not an independent envelope: platform/libs/event-bus/src/nats/nats-event-bus.ts:848-856 derives the
publish subject FROM the body (deriveSubject → buildTenantEventSubject(event.tenantId,
event.eventType)), and publishTo at :872-874 already calls assertSubjectMatchesEvent(subject, event)
(platform/libs/event-bus/src/subjects/tenant-event-subject.ts:131-152), which rejects any publish
whose subject tenant segment differs from payload.tenantId. A consumer-side cross-check would
therefore compare a value against itself — it carries no authority the body lacks. Publisher
authority is the mTLS cert CN (ADR-015), not the subject. Moreover
TenantValidatingConsumer.validateTenantFromSubject
(libs/backend-common/src/nats/tenant-validating-consumer.ts:88-104) explicitly returns valid for
'`*'/'>`' and for `<3-segment` subjects, so even if the cited listeners adopted it, their deliberate
`events.*.{eventType}` wildcard subscriptions would short-circuit to valid=true — zero behavioural
change. The handlers themselves are fail-closed on identity:
apps/farm-service/src/events/listeners/farm-stock-projection.listener.ts:113-120 and
sensor-temperature-projection.listener.ts:63-70 reject missing/non-UUID tenantId and then write
through runInTenantTransaction, which pins search_path and the RLS GUC to that tenant. The only true
residual is hygiene — TenantValidatingConsumer has no runtime adopters (grep confirms only the file
\+ libs/backend-common/src/nats/index.ts:11), i.e. a dead abstraction worth deleting or wiring, not
a HIGH isolation gap.

### ~~PRODUCT-TENANT-MEDIUM-004~~

**Title:** farm-service @Cacheable / @CacheEvict derive the Redis key's tenant segment from the raw
x-tenant-id header instead of the JWT/guard-validated tenant

**Raised as:** MEDIUM · **Result:** REFUTED

Cited lines read as claimed (cacheable.interceptor.ts:116-131, cache-evict.interceptor.ts:111-126
use only headers['x-tenant-id']), but the claimed divergence is unreachable and the header is not
attacker-controlled there. (1) apps/farm-service/src/app.module.ts:587-597 mounts
StripInternalHeadersMiddleware first on '`*`';
libs/backend-common/src/middleware/strip-internal-headers.middleware.ts:76-89,111-129 deletes
x-tenant-id (and x-user-payload) on any request without a valid v2 service-identity signature, so a
forged header never reaches the interceptor and both interceptors fail closed
(cacheable.interceptor.ts:63-72; cache-evict.interceptor.ts:91-98 skips eviction rather than
wiping). (2) On the signed gateway path the header is HMAC-bound: service-identity.util.ts:203-219
puts tenantId in the signed canonical string and the strip middleware verifies it with
expectedTenantId = the wire header (:147-161), so tampering invalidates the signature and the header
is stripped. (3) libs/backend-common/src/middleware/verified-user-assertion.middleware.ts:53-66
rejects with 400 unless assertion.effectiveTenantId equals verifiedIdentity.tenantId (the
x-tenant-id header) and then sets req.user.tenantId to that same effectiveTenantId, which is
precisely what @CurrentTenant returns (decorators/tenant.decorator.ts:42-51) and what the gateway
minted (federation/authenticated-data-source.ts:214-216, 276). Cache-key tenant == query tenant is
therefore enforced by an HMAC plus an explicit equality check. The app.module.ts:539-551
direct-subgraph comment does not help the claim: verified-user-assertion.middleware.ts:29-37 with
:261-267 rejects any non-probe production request that lacks a gateway service identity. The only
residual is a silently skipped cache when no signed header exists (a caching/perf gap in dev, logged
as a warn) \- no tenant-isolation defect.

## Inventory — what exists / what is missing

| Status          | Area                                                             | Note                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MISSING**     | AquaMobil offline queue identity partitioning                    | No userId dimension on the key or the record; the drain is tenant-only. A session that ends without explicit logout lets the next user of the same tenant replay the prior user's queued escape/mortality/harvest writes under their own JWT. See PRODUCT-TENANT-HIGH-003.                                                                                         |
| **MISSING**     | AquaMobil session-establishment residue wipe                     | login / loginWithToken / a failed silent restore never clear prior-session local state, so the logout teardown is the only barrier and it is skipped whenever the app is killed or the refresh cookie expires.                                                                                                                                                     |
| **MISSING**     | Cron / scheduler tenant-isolation tests                          | No isolation spec covers any cron path. The only scheduler test is minio-orphan-cleanup.spec.ts, and nothing asserts that a per-tenant cron observes exactly its own tenant's rows — which is why PRODUCT-TENANT-HIGH-001 can be inert with a green suite.                                                                                                         |
| **MISSING**     | FeedingSchedulerService public API (execute/mark/skip/calculate) | executeFeedingSchedule, updateFeedingStatus, markFeedingCompleted, skipFeeding, calculateFeedAmount, getFeedingSchedules, getUpcomingFeedings and triggerFeedingPlanGeneration have no caller anywhere in apps/ — no controller, resolver or command handler reaches them. Dead surface that still carries the unscoped lookup cited in PRODUCT-TENANT-MEDIUM-005. |
| **MISSING**     | NATS consumer envelope↔payload tenant cross-check                | TenantValidatingConsumer exists and is exported but has zero runtime consumers; IEventHandler.handle() never receives the delivered msg.subject, so the check is not implementable at any consumer. All farm-service listeners trust event.tenantId. See PRODUCT-TENANT-HIGH-002.                                                                                  |
| **PARTIAL**     | Per-tenant cron / scheduler fan-out                              | search_path is pinned per tenant but the RLS tenant GUC is never bound, so the FORCEd tenant_isolation_policy denies every row: maintenance, work-order, low-stock, weekly-summary, compliance, feeding-plan, FCR, stock, retention and MinIO-orphan crons are all inside this blast radius. See PRODUCT-TENANT-HIGH-001.                                          |
| **PARTIAL**     | Per-tenant cron enable/disable flags (TenantCronConfig)          | loadTenantConfigs populates the map from a repository read taken at onModuleInit with no tenant context (source schema \+ empty RLS GUC), so the map is empty and every `if (config && !config.xEnabled)` gate is structurally inert. Same shape in both schedulers.                                                                                               |
| **PARTIAL**     | Redis / cache key tenant namespacing                             | TenantRedisService prefixes `tenant:{uuid}:` with UUID validation and is the correct primitive, but farm-service's @Cacheable/@CacheEvict build their own key and take the tenant from the raw x-tenant-id header instead of the JWT/guard value. See PRODUCT-TENANT-MEDIUM-004.                                                                                   |
| **PARTIAL**     | Tenant-schema-routing architecture invariant                     | The spec only rejects tenant-owned entities that pin schema:'farm', with an allowlist naming just the outbox; farm_audit_logs and tenant_erasure_audit legitimately declare schema:'farm' and are not listed (already tracked in apps/farm-service/CLAUDE.md as ORPHAN-MEDIUM-118).                                                                                |
| **PARTIAL**     | farm-service tenant-isolation invariant coverage                 | Walks only `*.handler.ts` although its docblock claims absolute coverage; service, resolver, dataloader and listener files are unscanned. See PRODUCT-TENANT-MEDIUM-005.                                                                                                                                                                                           |
| **IMPLEMENTED** | AquaMobil IndexedDB cache partitioning                           | cache_${tenantId}:${key} with a mandatory tenantId, AES-GCM at rest with a non-extractable key, plaintext TTL metadata only, legacy-plaintext entries purged rather than served; `my*` resolvers additionally carry the branded user partition.                                                                                                                    |
| **IMPLEMENTED** | AquaMobil logout teardown                                        | logout awaits push teardown, cancelQueries, full IndexedDB queue+cache+blob+AES-key wipe, biometric and unscoped-localStorage wipe, SW Cache Storage purge, tenant-keyspace removeQueries \+ clear(), and auth-barrier re-arm — a wipe failure rejects rather than presenting as a clean logout.                                                                   |
| **IMPLEMENTED** | AquaMobil offline queue tenant partitioning                      | Keys are `pending_${tenantId}_${id}`; enqueue/count/list/update/remove/clear and syncAllOperations all filter by the tenant prefix, dedup is tenant-local, and the SW closed-app lane drains only the cookie-refreshed identity's tenant. Cross-TENANT replay is not reachable.                                                                                    |
| **IMPLEMENTED** | Event-listener tenant fail-closed guards                         | Every farm listener rejects a missing/invalid event.tenantId before writing and wraps the write in runInTenantTransaction, so once the tenant value is trusted the routing is provably correct.                                                                                                                                                                    |
| **IMPLEMENTED** | Fail-closed tenant transaction boundary                          | runInTenantTransaction / runInTenantRead pin search_path transaction-locally, bind both RLS GUCs, and READ BACK current_schema() \+ the GUC, converting silent-empty-result failures into TenantContextError. runInSourceRead is the sanctioned cross-tenant counterpart.                                                                                          |
| **IMPLEMENTED** | Gateway→subgraph HMAC tenant binding                             | The gateway forwards and signs the resolved effectiveTenantId; StripInternalHeadersMiddleware deletes x-tenant-id / x-user-payload / x-act-as-tenant on any request lacking a valid v2 service-identity signature, and the signature binds the tenant header.                                                                                                      |
| **IMPLEMENTED** | NATS subject tenant scoping (publish side)                       | Publishers emit `events.{tenantId}.{eventType}` and the subject builder is centralised in NatsEventBus (subscribeWildcard / subscribeForTenant) so segment-count drift cannot recur.                                                                                                                                                                               |
| **IMPLEMENTED** | Postgres-backed cross-tenant isolation E2E suites                | Real two-tenant Postgres specs exist for feeding records, sites, batch allocation, mortality/cull/harvest and the per-tenant code sequence — this is genuine coverage of the request-path read/write surface.                                                                                                                                                      |
| **IMPLEMENTED** | RLS deny-by-default on per-tenant tables                         | applyTenantRlsToSchema uses NULLIF(...)::uuid so an unset GUC yields UNKNOWN (no rows), FORCE ROW LEVEL SECURITY removes the owner escape hatch, and RlsConnectionBootstrap explicitly clears the GUC outside request context. The behaviour is correct — it is the crons that fall into the deny branch.                                                          |
| **IMPLEMENTED** | Request-path tenant derivation (JWT trust anchor)                | TenantContextMiddleware prefers req.user.tenantId; @Tenant/@CurrentTenant reads only JWT \+ guard-set values; query-param source was removed. VerifiedUserAssertionMiddleware rebuilds req.user from the HMAC-signed effectiveTenantId and rejects a mismatch against the signed service tenant.                                                                   |
| **IMPLEMENTED** | SUPER_ADMIN impersonation / cross-tenant admin path              | TenantGuard accepts a target tenant only from the verified gateway assertion or verified gateway service identity, enforces MFA step-up, awaits a persistent audit append, and fails closed in production when the audit capability is unavailable.                                                                                                                |
| **IMPLEMENTED** | TenantScopedRepository / tenantManagerRepo                       | Every read/write method injects tenantId; createQueryBuilder pre-applies the predicate and hard-disables where()/orWhere(); update() strips tenantId from the payload; remove() refuses a foreign-tenant entity. Two audited eslint-disabled getRepository callsites at the library boundary only.                                                                 |
| **IMPLEMENTED** | Transactional outbox tenant placement                            | FarmOutbox declares schema:'farm' with synchronize:false — correct cross-tenant infrastructure placement per MODULE_SCHEMAS[].infrastructureTables, and it is in the RLS exclude set via getRlsExcludeTablesForService('farm').                                                                                                                                    |
| **IMPLEMENTED** | farm-service handler-layer tenantId discipline                   | A repo-wide grep of apps/farm-service/src shows tenantId present in essentially every service/handler where clause (batch, storage, feeding-protocol, fish-health, maintenance, marine-data). Only one direct dataSource.getRepository in non-test code (equipment/services/tank-equipment-adapter.service.ts:106, a global EquipmentType catalogue).              |
| **IMPLEMENTED** | schema-per-tenant search_path routing                            | TenantConnectionBootstrap re-asserts search_path on EVERY pool checkout (tenant branch and non-request branch), closing the 2026-04-07 pool-contamination class. TenantSchemaMiddleware re-runs the request inside a fresh AsyncLocalStorage store carrying schemaName.                                                                                            |

## Verdict

CONDITIONAL

## References

- Cycle report: `docs/reviews/orchestrator/2026-08-16-farm-mobile-audit-cycle.md`
- Finding format: `.claude/shared/output-format.md`
- Agent definition: `.claude/agents/**/tenant-isolation-auditor.md`
- Rule SSoT: `CLAUDE.md`
