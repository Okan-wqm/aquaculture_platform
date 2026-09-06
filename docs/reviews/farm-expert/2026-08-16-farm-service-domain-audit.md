# farm-service domain audit — 2026-08-16

**Agent:** `farm-expert` · **Mode:** CATCHER (read-only) · **Lane:** farm
**Cycle:** `2026-08-16-farm-mobile-agent-audit` · **Verdict:** BLOCK
**Findings surviving verification:** 11 (CRITICAL 0 · HIGH 3 · MEDIUM 5 · LOW 3) · 1 refuted

> Produced by a 27-agent audit workflow, then verified by a second 25-agent pass.
> **Every** claim — CRITICAL through LOW — was handed to an independent verifier
> instructed to **refute** it by reopening each cited line, with "refuted" as the
> default when the evidence did not clearly hold. Claims that could not be defended
> were dropped into the Refuted section below; claims that proved smaller or larger
> than filed carry a corrected severity.
>
> **Finding IDs** are allocated above the `FARM` high-water mark in
> `docs/reviews/_registry/findings.jsonl` (FARM was at 299 at cycle time), so
> they do not collide with existing registry entries. They are **not yet registered** —
> `npm run findings:add` is a separate, human-gated append to the hash-chained ledger.

## Scope

Read CLAUDE.md (root \+ apps/farm-service \+ web),
.claude/shared/{output-format,operating-modes,handoff-protocol}.md,
.claude/knowledge/layer-2-{patterns,defect-catalog}.md. Backend: apps/farm-service/src/batch
(entities/batch.entity.ts,
services/{batch-lifecycle-policy,batch-domain,biomass-calculator,sgr-calculator,tank-batch}.service.ts,
handlers/{close-batch,record-mortality,update-batch-status,transfer-batch,allocate-to-tank,record-grading}.handler.ts,
resolvers/batch.resolver.ts, dto/batch-resolver.dto.ts), growth
(handlers/record-growth-sample.handler.ts, services/fcr-calculation.service.ts,
entities/growth-measurement.entity.ts), feeding (handlers/create-feeding-record.handler.ts,
services/feeding-cron.service.ts), harvest
(handlers/{create-harvest-record,get-harvest-statistics}.handler.ts,
services/harvest-policy.service.ts, entities/harvest-record.entity.ts), water-quality (resolver \+
service \+ invariants), tank/services/tank-capacity.service.ts, storage
(update-purchase-order-status.handler.ts, stock-movement/storage-inventory entities), sentinel-hub
(proxy controller, service, settings entity), ai-insights (resolver, ai-insights.service.ts,
mcp-client.service.ts), events/listeners/harvest-completed.listener.ts,
scheduler/cron-jobs.service.ts,
maintenance/task/fish-health/regulatory/finance/compliance/marine-data module \+ resolver surfaces.
Shared: libs/backend-common/src/database/{tenant-transaction,tenant-connection-bootstrap}.ts.
Invariants: `tests/invariants/farm-*.spec.ts` (read-boundary, outbox-publish, rest-cqrs,
batch-policy-transaction, wq-template, no-mock-data). Frontend:
web/modules/farm-module/src/Module.tsx, TransferModal.tsx, query-key scan.

## Executive summary

The core production-biology write paths (batch lifecycle, mortality/cull, transfer, harvest,
feeding, growth) are in strong shape: pessimistic locks, `runInTenantTransaction`, transactional
outbox, `createBaseEvent`, single-writer `TankBatchService.applyBatchDelta`, and
a `TankCapacityService` that checks status+maxBiomass+maxDensity. Sentinel Hub is correctly retired
to server-side CDSE with AES-256-GCM secrets, generation-scoped token cache and in-flight dedup.
Storage PO maker-checker and lot traceability are sound.

The gaps are at the edges. `ai-insights` fabricates its per-batch growth prediction and per-tank
feeding advice from hardcoded
constants (`biomassKg: 500`, `feedKg: 5.0`, `currentQuantity: 10000`) while labelling them as real
AI output, and never passes `tenantId` into the MCP call — a latent overfeeding/IDOR pair one env
flag away. `skipCapacityCheck` is exposed to `MODULE_USER` on `transferBatch` with no role gate and
no audit log. Harvest paths write `batch.status` directly,
bypassing `BatchLifecyclePolicyService`. ~34 write mutations across water-quality, task, maintenance
and fish-health skip the CommandBus entirely; maintenance emits no domain events at
all. `AllocateToTankHandler` is the last stock mutation outside the fail-closed tenant boundary.

## Findings (by severity)

### HIGH

### FARM-HIGH-300

**Title:** AI feeding advice and growth prediction are fabricated from hardcoded constants and
served as per-tank/per-batch AI output

**Severity:** HIGH (filed as CRITICAL, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:**

```text
FARM-CRITICAL-001` by `farm-expert` in cycle `2026-08-16-farm-mobile-agent-audit
```

**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/ai-insights/services/ai-insights.service.ts:156
  —
  —
  the `batchId` argument is never used as an input, only echoed into the result at :180

  ```text
  }>('calculate_growth_metrics', { mode: 'projection', currentWeightG: 100, currentQuantity: 10000, sgr: 2.0, projectionDays: 30, mortalityRatePercent: 0.1 })
  ```

- apps/farm-service/src/ai-insights/services/ai-insights.service.ts:280
  —
  — derived
  from those constants

  ```text
  }>('predict_feeding_impact', { feedKg: 5.0, biomassKg: 500, tankVolumeM3: 50, temperature: 22, currentPH: 7.5, salinity: 0, hasBiofilter: true })
  ```

  ```text
  tankId` unused; the returned `recommendedAmount` at :306 is `raw.feedingRate.feedKg
  ```

- apps/farm-service/src/ai-insights/ai-insights.resolver.ts:93 — exposed as `feedingAdvice` with
  description 'AI-driven feeding recommendation for a specific tank';
  :59 `batchGrowthPrediction` 'AI growth prediction for a batch'
- apps/farm-service/src/ai-insights/services/mcp-client.service.ts:81
  — `this.mcpEnabled = ... 'MCP_ENABLED', 'false') === 'true'` is the only thing suppressing this
  today
- `docs/plans/_archive/2026-Q1/2026-03-27-aquamobil-pwa-bugfix-plan.md:293` — the tracked
  remediation for the 'AI insights unavailable' complaint is literally 'Set `MCP_ENABLED=true` in
  the farm-service environment'

**Rule violated:**

CLAUDE.md Architectural Approach (root-cause only; never ship a placeholder as if complete) \+
farm-expert domain invariant 'Feeding engine (schedule / FCR / SGR) and biomass formulas' — a feed
ration must derive from the unit's real `biomassKg = (quantity × avgWeightG)/1000`, never a
constant.

**Proposed fix direction:**

Make it impossible: the MCP insight methods must not compile without the real aggregate.
Change `McpClientService.callTool` to accept a typed, per-tool argument contract whose required
fields are the resolved domain
values (`biomassKg`, `tankVolumeM3`, `avgWeightG`, `currentQuantity`, effective temperature) sourced
from , so a
literal cannot be substituted. Where a required input is genuinely unresolvable (no sample, no
temperature), the method must return `null` with an explicit provenance reason rather than a
synthesised answer — the same `source: 'none'` posture `effectiveUnitTemperatures` already uses.
Gate the `MCP_ENABLED` flip on this landing so AISAFETY-HIGH-010 cannot be 'closed' by activating
the fabricated path.

```text
BatchDomainService.getCurrentBiomass()` / `TankBatch` / `WaterTemperatureService
```

**Affected surface (ripple set):**

- `apps/farm-service/src/ai-insights/services/ai-insights.service.ts`
- `apps/farm-service/src/ai-insights/services/mcp-client.service.ts`
- `apps/farm-service/src/ai-insights/types/ai-insights.types.ts`
- `apps/farm-service/src/ai-insights/ai-insights.module.ts`
- `web/apps/aquamobil/src/hooks/useAiInsights.ts`
- `web/apps/aquamobil/src/components/ai/AiInsightsCard.tsx`

  ```text
  tests/invariants/farm-no-mock-data-growth-ssot.spec.ts (extend the no-fabricated-data ratchet to backend services, not just farm-module mock imports)
  ```

**Expected closer:**

implementation-planner (multi-file); CATCHER review by a different agent instance. Coordinate with
the owner of AISAFETY-HIGH-010 before `MCP_ENABLED` is set true.

**Verifier note:**

Code facts verified exactly at the cited lines: getBatchGrowthPrediction
(ai-insights.service.ts:156) and getFeedingAdvice (:280) pass hardcoded constants to the MCP tools
and never use batchId/tankId as inputs — they are only echoed into the result (:180, :305).
recommendedAmount (:306) is derived from feedKg: 5.0 / biomassKg: 500, not from the unit's real
biomass. Resolver descriptions at :59/:93 do present these as per-batch/per-tank AI output. Severity
is inflated, however: the whole path is dormant. `MCP_ENABLED` appears in NO deployment YAML or env
file (grep over `*.yml` returns nothing; test/e2e-env.ts:12 forces false), so
mcp-client.service.ts:200 returns null before any tool call, and every one of these queries resolves
to null in production today. The dormancy is already an OPEN tracked finding
(docs/reviews/ultracode/2026-07-05-ai-messaging-e2e.md:23, AISAFETY-HIGH-010). CRITICAL implies live
fabricated feed rations reaching operators; that is not reachable in any deployed config. It is a
genuine latent HIGH — the tracked remediation literally instructs flipping `MCP_ENABLED=true`, which
would activate it — but not a live CRITICAL.

### FARM-HIGH-302

**Title:** `skipCapacityCheck` on transferBatch is reachable by `MODULE_USER` with no role gate and
produces no audit-log row

**Registry id:** `FARM-HIGH-300` — allocated by `npm run findings:add` when this defect was
fixed. The cycle-local numbering in this report is not a registry id; the ledger is authoritative.

**Severity:** HIGH
**Layer:** 2
**State:** OPEN
**Raised as:** `FARM-HIGH-002` by `farm-expert` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/batch/dto/batch-resolver.dto.ts:136
  —
  on `TransferBatchInput`

  ```text
  @Field(() => Boolean, { nullable: true, defaultValue: false, description: 'Kapasite kontrolünü atla' }) @IsOptional() skipCapacityCheck?: boolean;
  ```

- apps/farm-service/src/batch/resolvers/batch.resolver.ts:463
  — ; the input
  is spread straight into the payload at :482-489 with no inspection of the flag

  ```text
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)` on `transferBatch
  ```

- apps/farm-service/src/batch/handlers/transfer-batch.handler.ts:228
  —
  —
  the whole welfare gate is skipped, and the handler injects no `AuditLogService`

  ```text
  if (!payload.skipCapacityCheck) { ... this.tankCapacityService.enforce({ mode: 'hard', ... }) }
  ```

- apps/farm-service/schema.graphql:9898 — `skipCapacityCheck: Boolean = false` is published on the
  public supergraph surface

**Rule violated:**

farm-expert domain invariant 'Mixed-batch tank attribution — `skipCapacityCheck` flag usage anywhere
MUST be audit-logged with the originating user and reason; unlogged use (HIGH)'. Over-capacity is a
legitimate admin override (apps/farm-service/CLAUDE.md), the defect is the missing audit trail and
the missing role floor.

**Proposed fix direction:**

Route the override through the existing sanctioned shape instead of a raw boolean escape hatch:
replace object
and switch the handler
from
—
that path already role-checks `SUPER_ADMIN/TENANT_ADMIN` and warns. Then write
an `AuditAction.CAPACITY_OVERRIDE` row
via `auditLogService.logWithManager(queryRunner.manager, ...)` inside the same transaction,
mirroring the `MORTALITY_RECORDED` pattern in record-mortality.handler.ts:382. A boolean with no
reason field cannot carry an audit trail, so the type change is the load-bearing part.

```text
skipCapacityCheck: boolean` with a required `capacityOverride: { reason: string }
```

```text
if (!skip)` to `tankCapacityService.enforce({ mode: 'admin-override', callerRoles, callerUserId })
```

**Affected surface (ripple set):**

- `apps/farm-service/src/batch/dto/batch-resolver.dto.ts`
- `apps/farm-service/src/batch/commands/transfer-batch.command.ts`
- `apps/farm-service/src/batch/handlers/transfer-batch.handler.ts`
- `apps/farm-service/src/batch/resolvers/batch.resolver.ts`
- `apps/farm-service/src/batch/controllers/batch.controller.ts`
- `apps/farm-service/schema.graphql`
- `web/modules/farm-module/src/hooks/useBatches.ts`
- `web/modules/farm-module/src/pages/production/components/TransferModal.tsx`

**Expected closer:**

implementation-planner; GraphQL input shape change also needs frontend-expert (supergraph) \+
data-expert (contract delta) per handoff-protocol.

**Verifier note:**

Every element verified. batch-resolver.dto.ts:136 declares skipCapacityCheck on TransferBatchInput
with only @IsOptional — no role or reason constraint. batch.resolver.ts:463 gates transferBatch
at `@Roles(TENANT_ADMIN`, `MODULE_MANAGER`, `MODULE_USER`) and :472-489 spreads the input straight
into the command payload without inspecting the flag. transfer-batch.handler.ts:228 wraps the entire
tankCapacityService.enforce({mode:'hard'}) welfare gate in if (!payload.skipCapacityCheck) — I
confirmed by grep that this is the ONLY conditional enforce callsite in farm-service
(allocate-to-tank:198, create-batch:413, deploy-cleaner-fish:105 are all unconditional), so the skip
is a complete bypass with no compensating check. The handler injects no audit service, and grep for
AuditedOperation across apps/farm-service/src/batch/ returns zero hits, so no @AuditedOperation
interceptor covers it either; the TankOperation row written at :245+ records performedBy and notes
but never the override flag or a reason. schema.graphql:9898 confirms it is on the published
supergraph. A field-level `MODULE_USER` can silently bypass a LIFE-SAFETY density gate with no
attributable trail. HIGH stands.

### FARM-HIGH-305

**Title:** AllocateToTankHandler — the initial stocking write — is the last stock mutation still
outside the fail-closed tenant transaction boundary

**Severity:** HIGH
**Layer:** 2
**State:** OPEN
**Raised as:** `FARM-HIGH-005` by `farm-expert` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/batch/handlers/allocate-to-tank.handler.ts:114
  —
  with
  no `pinTenantTransactionSearchPath` / `assertTenantTransactionContext` call anywhere in the file

  ```text
  const queryRunner = this.dataSource.createQueryRunner(); await queryRunner.connect(); await queryRunner.startTransaction('SERIALIZABLE');
  ```

- libs/backend-common/src/database/tenant-transaction.ts:301
  — `runInTenantTransaction` pins `search_path` AND asserts `current_schema()` \+
  the `app.current_tenant` RLS GUC before the callback runs
- tests/invariants/farm-batch-policy-transaction-ssot.spec.ts:104
  — `expect(source).not.toMatch(/this\.dataSource\.createQueryRunner\(/)` is asserted only for
  update-status/close/delete, and :141 for mortality/cull; allocate-to-tank appears at :18 only in
  the weaker `rawBatchFindOneHandlers` list
- libs/backend-common/src/database/tenant-connection-bootstrap.service.ts:38 — the docstring records
  the 2026-04-07 schema split-brain incident that pool-checkout routing alone did not prevent

**Rule violated:**

layer-2-patterns Tenant isolation \+ CLAUDE.md `@Entity()` schema discipline (per-tenant tables
route via `search_path`). Sibling stock mutations (mortality, cull, transfer, harvest, close) are
all already migrated; this is the remaining hole in the SSoT.

**Proposed fix direction:**

Migrate the handler onto `runInTenantTransaction(this.dataSource, 'farm', tenantId, ...)`. The
SERIALIZABLE isolation level currently used is the only reason the raw runner was kept — express it
as a parameter on the boundary helper (the helper already parameterises isolation
for `runInTenantRead`) rather than as a reason to stay outside the boundary. Then extend the
invariant's `not.toMatch(createQueryRunner)` assertion to cover every file
under `batch/handlers/`, which closes the class instead of this instance.

**Affected surface (ripple set):**

- `apps/farm-service/src/batch/handlers/allocate-to-tank.handler.ts`
- `libs/backend-common/src/database/tenant-transaction.ts`
- `tests/invariants/farm-batch-policy-transaction-ssot.spec.ts`

  ```text
  apps/farm-service/src/batch/**tests**/handlers/allocate-to-tank.handler.spec.ts
  ```

**Expected closer:**

data-expert (boundary helper signature) \+ farm-expert CATCHER; multi-tenant-saas-expert notified
per handoff-protocol.

**Verifier note:**

Verified by direct grep across every batch/harvest write handler.
allocate-to-tank.handler.ts:114-116 is the last remaining this.dataSource.createQueryRunner() \+
startTransaction('SERIALIZABLE') with no pinTenantTransactionSearchPath /
assertTenantTransactionContext anywhere in the file. Every sibling is migrated: transfer-batch:102,
record-mortality:111, record-cull:87, close-batch:58, update-batch-status:41, update-batch:44, and
harvest/create-harvest-record:138 all call runInTenantTransaction(this.dataSource, 'farm', tenantId,
...), which at tenant-transaction.ts:298-300 pins `search_path` and then
asserts `current_schema(`) plus the `app.current_tenant` RLS GUC before the callback runs —
fail-closed. The pool-checkout patch in tenant-connection-bootstrap.service.ts only
re-asserts `search_path` from AsyncLocalStorage; its own docstring records the 2026-04-07
farm-service split-brain that this fail-open routing did not prevent, so it is not an equivalent
guard. Initial stocking is a real write path, so a lost ALS frame lands rows in the shared 'farm'
source schema instead of `tenant_<uuid>`. One inaccuracy: transfer-batch.handler.ts also sits in the
weaker rawBatchFindOneHandlers list (spec line 21), so that list is not allocate-exclusive — but
transfer is nonetheless already on runInTenantTransaction, so the conclusion holds. HIGH stands.

### MEDIUM

### FARM-MEDIUM-301

**Title:** AI-insights MCP tool calls carry no tenant scope; tenantId is used only as a cache key
and every tenant shares one static JWT

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `FARM-HIGH-001` by `farm-expert` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/ai-insights/services/ai-insights.service.ts:77
  — `const cacheKey = ${CACHE_PREFIX}:risk:tank:${tenantId}:${tankId}` is the ONLY use of tenantId
- apps/farm-service/src/ai-insights/services/ai-insights.service.ts:88
  — —
  user-supplied tankId, no tenant predicate

  ```text
  this.mcpClient.callTool(..., 'assess_risk', { scope: 'tank', entityId: tankId, ... })
  ```

- apps/farm-service/src/ai-insights/services/mcp-client.service.ts:200
  — `async callTool<T>(name: string, params: Record<string, unknown>)` never injects tenant identity
- apps/farm-service/src/ai-insights/services/mcp-client.service.ts:120
  — `MCP_JWT_TOKEN: this.configService.get<string>('MCP_JWT_TOKEN', '')` — one process-wide
  long-lived JWT from env spawns the server for all tenants (also at :157)

**Rule violated:**

farm-expert domain invariant 'Farm-domain multi-tenancy specifics — IDOR prevention: every
fetch-by-ID on Batch, Tank, ... MUST verify the row's tenantId matches the requesting tenant
context'; layer-2-defect-catalog Security → 'Authz / guard gaps — object-level auth absent on a
fetch-by-id (IDOR)' and 'Secret handling — long-lived secret from process.env'.

**Proposed fix direction:**

Thread the caller's tenant context into the MCP boundary as a required argument:
make `callTool` take a `{ tenantId, ...params }` envelope whose type makes tenantId non-optional,
and have the MCP server resolve identity from a per-request short-lived token minted for that tenant
rather than a shared `MCP_JWT_TOKEN`. Independently, validate `tankId` / `batchId` ownership against
the tenant-scoped repository before the tool call, so an unowned id fails closed at the farm-service
edge regardless of what the MCP server does.

**Affected surface (ripple set):**

- `apps/farm-service/src/ai-insights/services/mcp-client.service.ts`
- `apps/farm-service/src/ai-insights/services/ai-insights.service.ts`
- `apps/farm-service/src/ai-insights/services/mcp-sdk.port.ts`
- `mcp/farm-management/src/auth/session-context.ts`
- `apps/farm-service/src/ai-insights/ai-insights.resolver.ts`

**Expected closer:**

auth-security-expert (secret \+ token minting) \+ multi-tenant-saas-expert (per-tenant credential
isolation); farm-expert CATCHER on the domain-side ownership check.

**Verifier note:**

Verified: ai-insights.service.ts:77 is the only tenantId use (cache key); :88-97 passes
user-supplied tankId as entityId with no ownership predicate and no prior tank-belongs-to-tenant
read; mcp-client.service.ts:200 callTool injects no tenant identity; :120 and :157 both pass a
single process-wide `MCP_JWT_TOKEN` from env. I also read
mcp/farm-management/src/auth/session-context.ts and config.ts:84 — the MCP server decodes that token
WITHOUT verifying it and derives tenantId from it, so the failure mode is actually worse than the
claimed IDOR: every tenant's query would resolve against the static token's tenant. But the
same `MCP_ENABLED` gate refutes production impact — callTool returns null before any network/tool
call, `MCP_ENABLED` is set nowhere outside tests, and `MCP_JWT_TOKEN` defaults to '' with no
deployment setting it. The IDOR framing is also imprecise (no per-object authorization is even
attempted because no real data is fetched). Latent design defect in dead code: MEDIUM, not HIGH.

### FARM-MEDIUM-303

**Title:** Harvest write paths mutate `batch.status` directly, bypassing BatchLifecyclePolicyService
— illegal state jumps are reachable

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `FARM-HIGH-003` by `farm-expert` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/batch/handlers/create-harvest-record.handler.ts:376
  —
  —
  the constructor (:76-108) injects no `BatchLifecyclePolicyService`

  ```text
  const isFinalHarvest = batch.currentQuantity <= 0; if (isFinalHarvest) { batch.status = BatchStatus.HARVESTED; ... }
  ```

- apps/farm-service/src/events/listeners/harvest-completed.listener.ts:300
  — `batch.status = BatchStatus.HARVESTING;` on a partial harvest, again with no policy assertion
- apps/farm-service/src/batch/services/batch-lifecycle-policy.service.ts:10
  — —
  neither HARVESTING nor HARVESTED is a legal successor of ACTIVE (nor of QUARANTINE, :9)

  ```text
  [BatchStatus.ACTIVE]: [BatchStatus.GROWING, BatchStatus.TRANSFERRED, BatchStatus.FAILED]
  ```

- apps/farm-service/src/batch/handlers/update-batch-status.handler.ts:54 — the sanctioned path
  does `this.lifecyclePolicy.assertCanTransitionStatus(batch, newStatus)`

**Rule violated:**

farm-expert domain invariant 'Batch lifecycle state machine — any other direct jump (CRITICAL)';
layer-2-patterns DDD aggregate root: 'external code may only invoke intent-methods
(batch.harvest()), not batch.status = HARVESTED'. Also CLAUDE.md Layer Rules #1 (no layer skipping).

**Proposed fix direction:**

Make it impossible rather than adding a second assertion callsite: remove the public setter path by
moving every status write behind an intent method on the
aggregate (`batch.markHarvesting()` / `batch.markHarvested(closedAt)`) that internally
consults `BatchLifecyclePolicyService`, and add HARVESTING/HARVESTED as legal successors of the
states a real harvest can start from (or force harvest to advance `PRE_HARVEST` first).
Extend `tests/invariants/farm-batch-policy-transaction-ssot.spec.ts` to assert that no file outside
the aggregate assigns `batch.status =`, which converts the whole class into a build-time failure.

**Affected surface (ripple set):**

- `apps/farm-service/src/batch/entities/batch.entity.ts`
- `apps/farm-service/src/batch/services/batch-lifecycle-policy.service.ts`
- `apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts`
- `apps/farm-service/src/events/listeners/harvest-completed.listener.ts`
- `apps/farm-service/src/batch/handlers/update-batch-status.handler.ts`
- `apps/farm-service/src/batch/handlers/close-batch.handler.ts`
- `tests/invariants/farm-batch-policy-transaction-ssot.spec.ts`
- `e2e/tests/modules/farm/batch-status-transitions.spec.ts`

**Expected closer:**

implementation-planner; CATCHER by a different agent instance.

**Verifier note:**

The cited path is wrong — there is no
apps/farm-service/src/batch/handlers/create-harvest-record.handler.ts; the file is
apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts and the write is at :378,
not :376. The substance survives: :377-381 sets batch.status = BatchStatus.HARVESTED directly, the
constructor (:76-108) injects HarvestPolicyService and BatchHarvestEligibilityService but no
BatchLifecyclePolicyService, and harvest-completed.listener.ts:300 sets HARVESTING with no policy
assertion. Severity is inflated, though: no illegal or corrupt state is actually reachable. The end
states are semantically correct (full harvest `->` HARVESTED, partial `->` HARVESTING) and are
explicitly accepted downstream by the same policy service at batch-lifecycle-policy.service.ts:21,
where `BatchCloseReason.HARVEST_COMPLETED` whitelists previous statuses HARVESTED and HARVESTING —
so the batch remains closable and nothing downstream breaks. The real defect is that the
statusTransitions table (:9-17) omits the harvest edges its own domain performs, making the manual
updateBatchStatus path and the harvest path disagree. That is an enforceability/consistency gap (the
policy is not the single gate), not a reachable illegal-state bug: MEDIUM.

### FARM-MEDIUM-304

**Title:** ~34 farm write mutations bypass the CommandBus entirely (water-quality, task,
maintenance, fish-health): resolver `->` service `->` repository

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 3
**State:** OPEN
**Raised as:** `FARM-HIGH-004` by `farm-expert` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/water-quality/water-quality.resolver.ts:299
  — `return this.waterQualityService.create(...)` (also :325 recordManualTemperature, :343
  createBatch, :360 update, :377 delete) while every query on the same resolver goes
  through `this.queryBus.execute`
- apps/farm-service/src/maintenance/resolvers/work-order.resolver.ts:275
  — `return this.workOrderService.create(tenantId, input, user.sub)` — 10 mutations on this
  resolver, plus 8 on maintenance-schedule.resolver.ts and 4 on spare-part.resolver.ts, none using a
  command
- apps/farm-service/src/task/resolvers/task.resolver.ts:170
  — `return this.taskService.create(tenantId, input, user.sub)` — 7 mutations
- apps/farm-service/src/fish-health/resolvers/health-event.resolver.ts:218
  — `return this.healthEventService.create(tenantId, input, user.sub)`; fish-health has
  no `commands/` directory at all (field-capture.resolver.ts:130-190 is the same shape)
- tests/invariants/farm-rest-cqrs-ssot.spec.ts:5 — the CQRS invariant's scope is a single
  file, `apps/farm-service/src/batch/controllers/batch.controller.ts`, so no GraphQL resolver is
  covered

**Rule violated:**

CLAUDE.md Layer Rules #1 'Controller → Service → Command/Query Bus → Handler → Repository. No layer
skipping.' and ADR-007 via layer-2-patterns CQRS discipline: 'Every PR that skips a layer is a HIGH
finding.'

**Proposed fix direction:**

Two moves, in order. (1) Widen the detection so the drift cannot grow:
generalise `farm-rest-cqrs-ssot.spec.ts` from one hardcoded controller path into a scan of
every `*.resolver.ts` under apps/farm-service/src, asserting each `@Mutation` body dispatches
through `commandBus.execute`, with a FROZEN shrink-only allowlist seeded from today's four contexts
— the same ratchet shape already used by farm-read-boundary-ssot.spec.ts. (2) Burn the allowlist
down context by context, starting with water-quality and fish-health because those writes carry
compliance weight (WQ critical alerts, medicine withdrawal periods). The existing services become
the handler bodies; the command classes are the missing layer.

**Affected surface (ripple set):**

- `tests/invariants/farm-rest-cqrs-ssot.spec.ts`

  ```text
  apps/farm-service/src/water-quality/{water-quality.resolver.ts,water-quality.service.ts,commands/,handlers/}
  ```

- `apps/farm-service/src/fish-health/{resolvers/,services/,commands/,handlers/}`
- `apps/farm-service/src/task/{resolvers/,services/}`
- `apps/farm-service/src/maintenance/{resolvers/,services/}`
- `apps/farm-service/src/{water-quality,fish-health,task,maintenance}/*.module.ts`

**Expected closer:**

implementation-planner (phased skill-DAG, one bounded context per package). Not a single-commit
change.

**Verifier note:**

Facts verified and, if anything, understated. I counted @Mutation vs commandBus.execute per
resolver: water-quality 5/0, work-order 11/0, maintenance-schedule 9/0, spare-part 5/0, task 7/0,
health-event 8/0, field-capture 6/0 — 51 mutations, zero CommandBus usage, against the claim's
'~34'. Cited lines are exact (water-quality.resolver.ts:299 create, :325 recordManualTemperature,
:343 createBatch, :360 update, :377 delete; work-order.resolver.ts:275; task.resolver.ts:170;
health-event.resolver.ts:218). fish-health does have handlers/ and queries/ but they are all
read-side (10 list/get handlers) — no commands/, confirmed.
tests/invariants/farm-rest-cqrs-ssot.spec.ts:5 is scoped to the single `BATCH_CONTROLLER` constant,
so no resolver is covered. Severity is inflated to HIGH on a rule citation alone: no correctness,
isolation, or security consequence is demonstrated. The bypassing services still carry tenant
scoping and object-level site authorization (e.g. water-quality.resolver.ts:305-306 threads
sub/roles/assignedSiteIds for the SEC-HIGH-051 check). This is broad architectural-consistency debt
with no production impact: MEDIUM.

### FARM-MEDIUM-307

**Title:** The maintenance bounded context emits zero domain events — work orders, schedules and
spare-part stock movements are invisible downstream

**Severity:** MEDIUM
**Layer:** 3
**State:** OPEN
**Raised as:** `FARM-MEDIUM-002` by `farm-expert` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/maintenance/services/work-order.service.ts:309 — opens a transaction for the
  write with no `outboxPublisher.enqueue`; a repo-wide grep
  for `OutboxPublisher|createBaseEvent|eventBus` across apps/farm-service/src/maintenance returns
  zero matches
- apps/farm-service/src/maintenance/resolvers/spare-part.resolver.ts:325
  — `return this.sparePartService.recordStockMovement(tenantId, input, user.sub)` — an inventory
  mutation with no event, unlike storage/handlers/record-stock-movement.handler.ts which enqueues
  one
- apps/farm-service/src/maintenance/resolvers/work-order.resolver.ts:322 — `approve` (a
  maker-checker spend decision) emits nothing
- apps/farm-service/src/scheduler/cron-jobs.service.ts:352 — the only maintenance signal that leaves
  the service is `this.eventEmitter.emit('maintenance.overdue', ...)` on the in-process bus,
  re-published by events/listeners/maintenance-schedule-due.listener.ts:80

**Rule violated:**

layer-2-patterns Outbox pattern \+ ADR-006 event contracts; CLAUDE.md Event Contract Rules. A
command that writes state and emits no contract event leaves notification-service and every
read-model projection blind to it.

**Proposed fix direction:**

Fold this into the FARM-HIGH-004 CQRS migration rather than bolting events onto the services: once
maintenance writes are command handlers, the handler is the natural place
for `outboxPublisher.enqueue(event, queryRunner.manager)`. Define the contracts
first
() in
libs/event-contracts/src/farm-events.ts with data-expert, since the notification-service fan-out is
the consumer that makes them worth emitting. Prioritise `SparePartStockMoved` — it is the only stock
ledger in the service with no event at all.

```text
WorkOrderApproved`, `WorkOrderCompleted`, `SparePartStockMoved`, `MaintenanceScheduleDue
```

**Affected surface (ripple set):**

- `libs/event-contracts/src/farm-events.ts`

  ```text
  apps/farm-service/src/maintenance/services/{work-order,spare-part,maintenance-schedule}.service.ts
  ```

- `apps/farm-service/src/maintenance/maintenance.module.ts`
- `apps/farm-service/src/events/listeners/maintenance-schedule-due.listener.ts`
- `apps/notification-service consumers`

**Expected closer:**

data-expert owns the contract addition (per handoff-protocol: libs/event-contracts changes route to
data-expert, notify alert-engine-expert \+ messaging-expert); farm-expert CATCHER on the emit sites.

**Verifier note:**

Verified and, if anything,
understated.
returns
ZERO non-test matches across services/, resolvers/, handlers/.
work-order.service.ts:309 `complete()` opens a raw transaction with no enqueue;
spare-part.resolver.ts:325 returns `this.sparePartService.recordStockMovement(...)` with no event,
in direct contrast to storage/handlers/record-stock-movement.handler.ts:130-150 which builds
a `StockMovementRecordedEvent` via `createBaseEvent` and
calls `outboxPublisher.enqueue(movementEvent, manager)` inside the caller's transaction;
work-order.resolver.ts:316-323 `approveWorkOrder` emits nothing. Nothing named
WorkOrder/SparePart/Maintenance exists in libs/event-contracts/src at all. The one detail the claim
gets wrong is in its favour: the `eventEmitter.emit('maintenance.overdue', ...)` at
cron-jobs.service.ts:352 does NOT leave the service — maintenance-schedule-due.listener.ts:80
re-emits `notification.send` / `alert.maintenanceOverdue`, and there is
no `@OnEvent('notification.send')` anywhere in farm-service and no wildcard/outbox bridge in
backend-common or platform/libs, so overdue-maintenance notifications terminate in-process. So
maintenance state changes reach no consumer at all. MEDIUM holds.

```text
grep -rn 'OutboxPublisher|outboxPublisher|createBaseEvent|eventBus|eventEmitter' apps/farm-service/src/maintenance
```

### FARM-MEDIUM-309

**Title:** BatchProductionCompleted publishes the pre-close FCR — the final metric is frozen only
inside CloseBatchHandler, which runs in a separate post-commit transaction

**Severity:** MEDIUM
**Layer:** 2
**State:** OPEN
**Raised as:** `FARM-MEDIUM-004` by `farm-expert` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/events/listeners/harvest-completed.listener.ts:355
  — `fcr: batch.fcr?.actual || 0` inside `generateHarvestReport`, fed
  into `BatchProductionCompletedEvent.fcr` at :469
- apps/farm-service/src/batch/handlers/close-batch.handler.ts:207
  — `batch.fcr.actual = finalFCR;` is the ONLY writer of the authoritative value, computed at :172
  from `this.fcrCalculation.calculateCumulativeFCR(...)`
- apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts:493 — the
  auto-close `commandBus.execute(new CloseBatchCommand(...))` runs AFTER the harvest transaction
  commits, and the BatchHarvested outbox row (:460) is already released to NATS at that point
- apps/farm-service/src/batch/handlers/close-batch.handler.ts:166 — the code comment records that
  reading `batch.fcr.actual` before the close 'returned whatever the shadow updateBatchMetrics path
  last persisted (often 0 / stale)'

**Rule violated:**

farm-expert domain invariant 'Close-batch command MUST compute final FCR, mortality rate, and
days-in-production inside the same transaction that writes ARCHIVED'. The value is computed
correctly at close; the terminal production event is emitted from a racing path that reads it before
it exists.

**Proposed fix direction:**

Move the terminal-production signal to where the authoritative metrics are
frozen: `BatchProductionCompleted` should be enqueued by `CloseBatchHandler` inside the same
transaction that writes `fcr.actual`, alongside `BatchClosed`, rather than derived by the harvest
listener from a possibly-unwritten field. That removes the race by construction. If the listener
must keep emitting it, it has to consume `BatchClosed` (which already
carries `finalFCR`, `mortalityRate`, `daysInProduction`) instead of `BatchHarvested`.

**Affected surface (ripple set):**

- `apps/farm-service/src/events/listeners/harvest-completed.listener.ts`
- `apps/farm-service/src/batch/handlers/close-batch.handler.ts`

  ```text
  libs/event-contracts/src/farm-events.ts (BatchProductionCompletedEvent producer change)
  ```

- `apps/event-store-service projections consuming BatchProductionCompleted`

**Expected closer:**

data-expert (producer relocation on a contract event) \+ farm-expert CATCHER.

**Verifier note:**

Confirmed on every cited line. harvest-completed.listener.ts:355
reads `fcr: batch.fcr?.actual || 0` from a plain `batchRepository.findOne` (:320) and feeds it
to `BatchProductionCompletedEvent.fcr` at :469. `grep 'fcr.actual ='` over apps/farm-service/src
returns exactly ONE non-test writer: close-batch.handler.ts:207, fed by `calculateCumulativeFCR` at
:172, and the :160-167 comment explicitly records that the pre-close value 'returned whatever the
shadow updateBatchMetrics path last persisted (often 0 / stale)'.
create-harvest-record.handler.ts:460 enqueues BatchHarvested inside the tx and :493
dispatches `CloseBatchCommand` only AFTER commit (the code comment at :477-487 says so deliberately,
to avoid self-deadlock on the `pessimistic_write` lock). The race is live rather than theoretical:
outbox-worker.service.ts:150-155 publishes via LISTEN/NOTIFY within ~5ms of commit, while
CloseBatchHandler still has to take its row lock and run the cumulative-FCR aggregate; a plain
SELECT is not blocked by that lock, so the listener can and does read the pre-close value, and if
the close is skipped (BatchWithdrawalBlockedError compliance gate) it is permanently wrong. Impact
is real but bounded to a metric: the event is consumed only by
gateway-api/src/websocket/farm-nats-bridge.service.ts:462 → `broadcastBatchProductionCompleted` to
the tenant room, i.e. a possibly-0 FCR on a dashboard, while the persisted batch row and BatchClosed
stay correct. MEDIUM is the right level.

### LOW

### FARM-MEDIUM-306

**Title:** WaterQualityService.create/createBatch write measurements and critical-alert outbox rows
on a raw QueryRunner outside the tenant boundary

**Severity:** LOW (filed as MEDIUM, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `FARM-MEDIUM-001` by `farm-expert` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/water-quality/water-quality.service.ts:266
  —
  then
  saves `WaterQualityMeasurement` and enqueues `WaterQualityCriticalEvent` at :372

  ```text
  const queryRunner = this.dataSource.createQueryRunner(); await queryRunner.connect(); await queryRunner.startTransaction();
  ```

- apps/farm-service/src/water-quality/water-quality.service.ts:450 — same raw pattern
  in `createBatch`
- apps/farm-service/src/water-quality/water-quality.service.ts:175 — `recordManualTemperature` in
  the SAME class DOES use `runInTenantTransaction(this.dataSource, 'farm', tenantId, ...)`, so the
  correct form is already present and understood
- tests/invariants/farm-read-boundary-ssot.spec.ts:60 — the boundary ratchet matches
  only `*.handler.ts` and `*.resolver.ts`, so a `*.service.ts` write path is invisible to it

**Rule violated:**

layer-2-patterns Tenant isolation; the fail-closed boundary contract in
libs/backend-common/src/database/tenant-transaction.ts:288. An un-provisioned tenant schema silently
falls through to the source `farm` schema, which is exactly the `SCHEMA_MISMATCH` case the assertion
exists to turn into a hard error.

**Proposed fix direction:**

Move both methods onto `runInTenantTransaction`, matching `recordManualTemperature` two methods
above. Then close the detection gap: widen `farm-read-boundary-ssot.spec.ts` (or add a write-side
sibling) to include `*.service.ts` files that
call `createQueryRunner()` or `this.repository.save/remove`, with a shrink-only allowlist —
otherwise the whole service layer stays a blind spot for this class.

**Affected surface (ripple set):**

- `apps/farm-service/src/water-quality/water-quality.service.ts`
- `tests/invariants/farm-read-boundary-ssot.spec.ts`
- `apps/farm-service/src/water-quality/**tests**/water-quality.service.spec.ts`

**Expected closer:**

farm-expert-scoped fix via implementation-planner; data-expert secondary on the boundary invariant.

**Verifier note:**

Cited lines are accurate: water-quality.service.ts:266 and :450 do open a
raw `this.dataSource.createQueryRunner()` \+ `startTransaction()`, while
:175
(`recordManualTemperature`)
uses `runInTenantTransaction(this.dataSource, 'farm', tenantId, ...)`; grep confirms only those two
raw sites in the file. tests/invariants/farm-read-boundary-ssot.spec.ts:60-63 does only
collect `*.handler.ts` files, so a service write path is invisible to it. HOWEVER the claimed harm
mechanism is refuted by two guards the claimer missed. (1)
apps/farm-service/src/app.module.ts:69,566
registers `createTenantConnectionBootstrap('farm')`, which monkey-patches `pool.connect` so EVERY
checkout (which is exactly what `queryRunner.connect()` does)
re-asserts `search_path` to `"tenant_<uuid>", farm, public` from AsyncLocalStorage — so the raw
runner is still tenant-routed; `RlsConnectionBootstrap` similarly sets `app.current_tenant` per
checkout. (2) If context were missing, the write would NOT 'silently fall through to the source farm
schema': `water_quality_measurements` is
in `MODULE_SCHEMAS` farm `tables` (schema-manager.service.ts:474) and is neither
in `referenceDataTables` nor `infrastructureTables` (lines 376-405),
so `guard_source_write` / `block_source_writes` (source-schema-write-guard-reconciler.ts:1-33,
ERRCODE P0999) aborts the INSERT — fail-closed at the DB, loudly. Additionally the only callers are
water-quality.resolver.ts:299 and :343, i.e. always inside an HTTP request context. What actually
remains is defence-in-depth/consistency debt (no transaction-local pin, no typed TenantContextError,
and a genuine ratchet blind spot for `*.service.ts`), not a tenant-isolation defect: LOW.

### FARM-MEDIUM-308

**Title:** Harvest report economics use a hardcoded `estimatedPricePerKg = 50` with no currency,
while the harvest record itself books revenue from tenant finance settings

**Severity:** LOW (filed as MEDIUM, downgraded by adversarial verification)
**Layer:** 1
**State:** OPEN
**Raised as:** `FARM-MEDIUM-003` by `farm-expert` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/events/listeners/harvest-completed.listener.ts:333
  —
  `const estimatedPricePerKg = 50; // TODO: source from config-service`
  then `const estimatedRevenue = harvestedBiomass * estimatedPricePerKg;` at :334, surfaced
  as `report.economics.estimatedRevenue` (:362) and logged with `costPerKg` at :371
- apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts:133 — the authoritative
  write path already
  does and
  books `totalRevenue: input.pricePerKg ? biomassKg * input.pricePerKg : undefined` at :326

  ```text
  const defaultCurrency = await this.financeSettings.getDefaultCurrency(tenantId);
  ```

- apps/farm-service/src/finance/services/finance-settings.service.ts — the tenant currency SSoT the
  listener does not consult

**Rule violated:**

layer-2-defect-catalog Hygiene ('TODO/FIXME without a tracked finding \+ owner') and Correctness
('Money / time'); CLAUDE.md banned-phrase discipline — an untracked TODO is not an acceptable
resting state for a money figure. Contradicts the FARM-HIGH-151 currency SSoT already applied one
module away.

**Proposed fix direction:**

Delete the fabricated figure rather than sourcing a better
constant. `HarvestRecord.totalRevenue` \+ `currency` are already persisted by the write path for
exactly this batch; the listener should read them (or
drop at
:455-473 does not carry it). Removing the field is the highest-tier fix — it makes the wrong number
unrepresentable instead of merely better-sourced.

```text
estimatedRevenue` from `HarvestReport` entirely, since `BatchProductionCompletedEvent
```

**Affected surface (ripple set):**

- `apps/farm-service/src/events/listeners/harvest-completed.listener.ts`
- `appsts/farm-service/src/harvest/entities/harvest-record.entity.ts (read path)`
- `apps/farm-service/src/finance/services/finance-settings.service.ts`

**Expected closer:**

farm-expert-scoped fix via implementation-planner.

**Verifier note:**

The literal evidence checks out: harvest-completed.listener.ts:333
is `const estimatedPricePerKg = 50; // TODO: source from config-service`, :334 multiplies it
into `estimatedRevenue`, and :359-363 puts it
in `report.economics.estimatedRevenue`; create-harvest-record.handler.ts:133 does
resolve `this.financeSettings.getDefaultCurrency(tenantId)` and :326
books
. But the
severity is inflated: the fabricated figure is dead. A repo-wide grep
shows `report.economics.estimatedRevenue` is written at :362 and read NOWHERE
— `generateHarvestReport` (:211) feeds only `publishFollowUps` (:214),
and `BatchProductionCompletedEvent` (:455-473) carries no revenue field; the log line at :368-373
prints FCR/survival/days/costPerKg, and `costPerKg` is derived
from `batch.totalFeedCost + batch.purchaseCost`, not from the 50 constant. So no wrong money number
is ever persisted, published, logged, or shown. What is left is an untracked TODO plus dead
computation — real, but cosmetic: LOW.

```text
totalRevenue: input.pricePerKg ? biomassKg * input.pricePerKg : undefined` with `currency
```

### FARM-LOW-311

**Title:** The batch status-transition table is duplicated verbatim on the persistence entity,
competing with the policy service the invariant declares as SSoT

**Severity:** LOW
**Layer:** 2
**State:** OPEN
**Raised as:** `FARM-LOW-001` by `farm-expert` in cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/batch/entities/batch.entity.ts:491 — `canTransitionTo(newStatus)` declares
  its own literal `transitions: Record<BatchStatus, BatchStatus[]>` map at :492-503
- apps/farm-service/src/batch/services/batch-lifecycle-policy.service.ts:8
  — `private readonly statusTransitions` holds the identical map
- apps/farm-service/src/batch/services/batch-domain.service.ts:141 — the domain service correctly
  delegates: `return this.lifecyclePolicy.canTransitionStatus(batch.status, newStatus);`
- tests/invariants/farm-batch-policy-transaction-ssot.spec.ts:78
  — `expect(updateStatusSource).not.toMatch(/\.canTransitionTo\(/)` — the invariant already treats
  the entity method as the wrong path, but does not delete it

**Rule violated:**

layer-2-defect-catalog Duplication/DRY — 'the same constant/list maintained in two places (drift
risk — point both at one source)'; CLAUDE.md 'Keep domain entities separate from persistence
entities' (a TypeORM `@Entity()` carrying the lifecycle rulebook).

**Proposed fix direction:**

Delete `Batch.canTransitionTo` and re-point its remaining
callers
(,
)
at `BatchLifecyclePolicyService`. One table, one owner — a second copy that no production path reads
is pure drift surface. Note this is a precondition for FARM-HIGH-003's aggregate intent-methods,
which must not resurrect a third copy.

```text
apps/farm-service/src/batch/**tests**/integration/batch-lifecycle.integration.spec.ts:126-134
```

```text
apps/farm-service/src/batch/**tests**/handlers/update-batch-status.handler.spec.ts:57
```

**Affected surface (ripple set):**

- `apps/farm-service/src/batch/entities/batch.entity.ts`

  ```text
  apps/farm-service/src/batch/**tests**/integration/batch-lifecycle.integration.spec.ts
  ```

  ```text
  apps/farm-service/src/batch/**tests**/handlers/update-batch-status.handler.spec.ts
  ```

  ```text
  apps/farm-service/src/batch/commands/update-batch-status.command.ts (stale docstring reference at :5)
  ```

**Expected closer:**

Bundle with FARM-HIGH-003 in the same implementation package.

**Verifier note:**

Every cited line holds. apps/farm-service/src/batch/entities/batch.entity.ts:491
declares `canTransitionTo(newStatus)` with its own
literal `transitions: Record<BatchStatus, BatchStatus[]>` at :492-503;
apps/farm-service/src/batch/services/batch-lifecycle-policy.service.ts:8 holds a byte-for-byte
identical `statusTransitions` map at :8-18;
apps/farm-service/src/batch/services/batch-domain.service.ts:141
delegates
(`return this.lifecyclePolicy.canTransitionStatus(batch.status, newStatus);`); tests/invariants/farm-batch-policy-transaction-ssot.spec.ts:78
does assert `expect(updateStatusSource).not.toMatch(/\.canTransitionTo\(/)` — the invariant bans the
entity path in the handler but nothing deletes the method. A repo-wide grep
for `.canTransitionTo(` finds NO production caller of the Batch method (the only production hit,
apps/farm-service/src/tank/handlers/tank-status.policy.ts:26, is the unrelated Tank entity); the
remaining callers are exactly the two test files named in the finding, including the
prototype-splice at
update-batch-status.handler.spec.ts:57 (`canTransitionTo: Batch.prototype.canTransitionTo`), which
is the one place the dead copy still gates assertions. The stale docstring at
apps/farm-service/src/batch/commands/update-batch-status.command.ts:5 ('Status geçişleri batch
entity'deki canTransitionTo metoduyla valide edilir') is also real and now points at the wrong
owner. The two maps are currently in sync, so there is no live behavioral bug — pure drift surface
plus a misleading docstring and a test that validates the non-authoritative copy. LOW is the right
calibration; not higher.

## Refuted by adversarial verification

These did **not** survive independent re-checking. They are recorded so the same
claim is not re-raised next cycle.

### ~~FARM-MEDIUM-005~~

**Title:** Scheduler cron jobs set a session-scoped, string-interpolated `search_path` on pooled
connections instead of the transaction-local canonical form

**Raised as:** MEDIUM · **Result:** REFUTED

Both legs of the claim fail. (1) Injection leg:
apps/farm-service/src/scheduler/cron-jobs.service.ts:321 does interpolate `${schema}`, but the value
comes from listTenantSchemas (libs/backend-common/src/database/tenant-schema.utils.ts:90-96), whose
SQL is `WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'`. The result set is regex-anchored by the query
itself, so the interpolated token can only ever be `tenant_<16` `hex>`. A validateTenantSchemaName
call would be a no-op; this is structurally safe, not merely 'catalog-derived, capped at MEDIUM'.
(2) Pool-contamination leg: the quote at tenant-connection-bootstrap.service.ts:44 is from the
docblock explaining WHY the bootstrap patch exists — it describes the 2026-04-07 incident that the
patch cured, not a live hazard. farm-service
registers `createTenantConnectionBootstrap('farm')` (apps/farm-service/src/app.module.ts:69 and
providers at :566), which monkey-patches pool.connect so EVERY checkout re-asserts `search_path` —
tenant branch at tenant-connection-bootstrap.service.ts:124-138, non-request
default `SET search_path TO "farm", public` at :145-153 (and the promise-style twin at :158-190). A
connection released with a tenant `search_path` is repaired before the next consumer ever sees it;
the file's own words are 'every connection checked out of the pool MUST have
its `search_path` re-asserted before the caller receives it, regardless of context'. On top of that,
6 of the 8 raw sites already `RESET search_path` in finally (:380, :459, :534, :622, :683, :935).
(3) The proposed fix is not applicable to all sites: forEachTenantSchema opens a transaction per
tenant (for-each-tenant-schema.ts:203 `startTransaction`, `search_path` via `set_config(`..., true)
at :208), and refreshAnalyticsViews (cron-jobs.service.ts:861-866)
runs `REFRESH MATERIALIZED VIEW CONCURRENTLY`, which PostgreSQL forbids inside a transaction block —
so that loop cannot be routed through the helper as filed. What genuinely remains is a
style/fairness duplication (8 hand-rolled serial loops next to the sanctioned helper at :253), which
is the already-tracked cron-fairness item FARM-MEDIUM-061 cited in the helper's own docblock, not
a `search_path` safety defect.

## Inventory — what exists / what is missing

| Status          | Area                                                                           | Note                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PARTIAL**     | AI insights (MCP)                                                              | Wiring, caching and circuit breaker are real, but two of the five insights fabricate their inputs from constants and none pass tenantId into the tool call. Disabled by default (`MCP_ENABLED=false`), so it currently returns null in production — a latent, not live, defect.                                                           |
| **PARTIAL**     | Batch stocking / allocate-to-tank                                              | Fully implemented with SERIALIZABLE isolation, capacity enforcement and idempotency receipts, but it is the only stock mutation still on a raw QueryRunner outside the fail-closed tenant boundary.                                                                                                                                       |
| **PARTIAL**     | Fish health (events, lice, welfare, treatment, escape)                         | Rich entity/service/query-handler coverage and a working harvest-eligibility gate, but there is no `commands/` directory at all — 14 mutations go `resolver->service`. Only escape incidents emit a domain event; lice counts, welfare assessments and treatment start/end emit none.                                                     |
| **PARTIAL**     | Harvest (record, plan, statistics)                                             | Strong: withdrawal-period gate, plan-mandatory policy above thresholds, locked lot-number sequence, isFinal on the contract, auto-close chain. Gap: status writes skip the lifecycle policy (FARM-HIGH-003). Statistics correctly aggregate ALL non-cancelled harvest rows, and qualityClass is enum-validated with qualityGrade derived. |
| **PARTIAL**     | Maintenance (work orders, schedules, spare parts)                              | Complete CRUD \+ approval workflow behind GraphQL, but 22 mutations bypass the CommandBus and the entire bounded context emits zero domain events, including spare-part stock movements.                                                                                                                                                  |
| **PARTIAL**     | Scheduler cron jobs                                                            | Per-tenant fan-out with advisory locks is in place, but `updateTemperatureReadings` is a registered hourly @Cron that early-returns unconditionally, and several loops set a session-scoped interpolated `search_path`.                                                                                                                   |
| **PARTIAL**     | Task / recurring / auto-rules                                                  | Outbox events are emitted correctly from TaskService, but the 7 resolver mutations bypass the CommandBus and auto-rule-trigger publishes directly to the event bus rather than the outbox (at-most-once).                                                                                                                                 |
| **PARTIAL**     | Water quality — measurement write path                                         | Outbox-backed critical alerts and site authorization are correct, but all five mutations skip the CommandBus (FARM-HIGH-004) and create/createBatch run outside the tenant boundary (FARM-MEDIUM-001).                                                                                                                                    |
| **IMPLEMENTED** | Batch lifecycle (create / status / close)                                      | Full CQRS with pessimistic locks, `runInTenantTransaction`, outbox events. Close freezes finalFCR/mortalityRate/daysInProduction in-transaction and gates on medicine-withdrawal eligibility. Transition table is duplicated on the entity (FARM-LOW-001).                                                                                |
| **IMPLEMENTED** | Batch transfer / grading                                                       | Transfer validates source quantity and destination capacity on both maxBiomass and maxDensity via TankCapacityService; grading composes TransferBatchCommand per output so it inherits the same gates. `skipCapacityCheck` bypass is unaudited (FARM-HIGH-002).                                                                           |
| **IMPLEMENTED** | Biomass formula SSoT                                                           | `(quantity × avgWeightG)/1000` derive-on-read from the live count in both the aggregate and the calculator service; no competing formula found in resolvers or handlers.                                                                                                                                                                  |
| **IMPLEMENTED** | Consumable / supplier / chemical / species / site / department / farm / worker | Uniform CQRS shape — resolver dispatches CreateX/UpdateX/DeleteX commands through the bus, with restore paths and role gates. No layering violations found in these contexts.                                                                                                                                                             |
| **IMPLEMENTED** | FCR calculation                                                                | Single authority `calculateCumulativeFCR` corrects realized growth with the TankOperation ledger (mortality/cull/harvest/transfer net), and target FCR resolves through the v2 protocol chain honouring per-batch `tank_batches` proportions.                                                                                             |
| **IMPLEMENTED** | Feeding (record \+ ledger \+ storage deduction)                                | Single write path `FeedingLedgerService.recordFeed`; feed inventory decrement, batch aggregate and outbox event are atomic, with backdate policy and an assertFeedable gate that blocks feed against an emptied batch.                                                                                                                    |
| **IMPLEMENTED** | Feeding-protocol v2 (day plans, meals, recalc)                                 | Day-plan recalculation is invoked in-transaction from mortality, harvest, transfer and temperature writes, so remaining meals re-price against the new biomass same-day.                                                                                                                                                                  |
| **IMPLEMENTED** | Finance (categories, entries, settings, derived costs)                         | Full command/query handler set, tenant default currency as SSoT consumed by the harvest revenue path, decimal mapper for exact wire values.                                                                                                                                                                                               |
| **IMPLEMENTED** | Growth sampling \+ variance alerting                                           | Signed variance vs theoretical weight with correctly-ordered performance bands; under-target beyond −15% raises a suggested action and the band ships on GrowthSampleRecorded for downstream alerting.                                                                                                                                    |
| **IMPLEMENTED** | Mixed-batch tank attribution (TankBatch.batchDetails)                          | `TankBatchService.applyBatchDelta` is the single writer; totalQuantity/totalBiomassKg/avgWeightG/densityKgM3 are all re-derived from batchDetails on every mutation, with self-healing for pre-SSoT rows.                                                                                                                                 |
| **IMPLEMENTED** | Mortality / cull                                                               | Atomic decrement of quantity and biomass in one transaction, mandatory idempotency envelope, site authorization, aggregate-within-initial ceiling, durable audit row and outbox event.                                                                                                                                                    |
| **IMPLEMENTED** | Regulatory (Mattilsynet / Altinn) \+ compliance                                | The deepest surface in the service: eight per-report assemblers with provenance, Maskinporten token cache, schema-registry validation, deadline engine, draft/submission services with a circuit breaker, plus tenant erasure/export.                                                                                                     |
| **IMPLEMENTED** | SGR calculation                                                                | Natural-log form `((ln(Wf) − ln(Wi))/days)×100` in all three implementations (calculator service, aggregate, growth handler). No linear-percent approximation found.                                                                                                                                                                      |
| **IMPLEMENTED** | Sentinel Hub / marine-data / weather                                           | Browser-directed proxy retired to a 410 Gone; CDSE client-credentials runs server-side only with config-service as credential SSoT, generation-scoped (tenant+version) token cache, in-flight refresh dedup, bounded JSON reads, redirect: manual, and AES-256-GCM for the retained legacy row.                                           |
| **IMPLEMENTED** | Storage (PO, inventory count, stock movement, lot trace)                       | PO state machine forbids skips and carves `SUBMITTED->APPROVED` out to a dedicated maker-checker command; stock rows carry lotNumber \+ expiryDate with FEFO ordering and a trace-lot read path.                                                                                                                                          |
| **IMPLEMENTED** | Tank / equipment / capacity                                                    | TankCapacityService is the single capacity authority across allocate/transfer/deploy, checking status \+ maxBiomass \+ maxDensity with hard/soft/admin-override modes and metrics.                                                                                                                                                        |
| **IMPLEMENTED** | Water quality — tenant-configurable parameters & templates                     | No hardcoded parameter enum; dynamicParameters is the sole ingress, strictly validated against per-equipment mappings, and template application is guarded non-destructive by a dedicated invariant.                                                                                                                                      |

## Verdict

BLOCK

## References

- Cycle report: `docs/reviews/orchestrator/2026-08-16-farm-mobile-audit-cycle.md`
- Finding format: `.claude/shared/output-format.md`
- Agent definition: `.claude/agents/**/farm-expert.md`
- Rule SSoT: `CLAUDE.md`
