# Phase 1: Code Quality & Architecture Review

## Code Quality Findings (Phase 1A — superpowers:code-reviewer)

### HIGH
- **H-1** `as unknown as IEvent` cast in `outbox-worker.service.ts:151` — banned by CLAUDE.md. Fix: type `OutboxEntityBase.payload` as `BaseEvent`.
- **H-2** `(socket as unknown as { auth: ... }).auth = { token }` in `useFarmRealtimeStream.ts:158` — banned. Fix: assign `socket.auth = { token }` directly.
- **H-3** Massive boilerplate duplication — 9 handlers repeat the same 11-line `createQueryRunner → connect → startTransaction → try/catch/finally` ceremony. Fix: extract `OutboxTransactionRunner.run(work)` helper.
- **H-4** Every handler hand-builds BaseEvent fields instead of using `createBaseEvent()` from `@platform/event-contracts`. Contract drift risk.
- **H-6** `FarmGateway` broadcast methods accept `Record<string, unknown>` instead of typed contract events. Fix: import typed events.
- **H-7** `FarmDomainEvent` interface in `farm-nats-bridge.service.ts:66-77` re-declares BaseEvent — shadow type drift.

### MEDIUM
- **M-1** `CreateBatchHandler.execute` = 333 lines, 8 responsibilities
- **M-2** `TransferBatchHandler.execute` = 295 lines, duplicates tanks/equipment branching
- **M-3** `CreateHarvestRecordHandler` hand-rolls `parseQualityGrade` + `generateCode`
- **M-4** `findTankOrEquipmentWithManager + isFromTanksTable` polymorphism leak — 5 handlers copy the same if/else
- **M-5** `OutboxPublisher.enqueue` casts payload with misleading comment
- **M-6** `OutboxWorkerService.metricsLabel` untested PascalCase→snake_case regex
- **M-7** Worker polls every 1s regardless of workload — 2 count queries/sec/replica waste
- **M-8** Cleanup job has no metrics — add `outbox_cleanup_deleted_total`
- **M-9** `RecordMortality/Cull` use `MortalityCause[reason.toUpperCase() as keyof typeof X]` — cast hack
- **M-10** `CreateBatch` ships `name: savedBatch.batchNumber` instead of `name` — contract drift
- **M-11** Frontend `INVALIDATION_MAP` has `daily-executions` hyphen key with no compile-time link
- **M-12** `RecordMortality` computes `batch.getMortalityRate()` twice — risk of divergence
- **M-13** `OutboxPublisher.enqueue` does NOT assert `manager` is in active transaction

### LOW
L-1 to L-16 — unused imports, string-typed bigint, no-op generics, useless exports, defensive `?.`, missing stack traces, undocumented reconnect assumption, prom-client global registry, `import.meta as unknown as` cast, undocumented `transferReason`/`reason` DB/wire split, `new Date(alreadyDate)` waste, ~50 unused repository injections across 9 handlers, loose `FarmEventName` type, hardcoded i18n strings.

### Systemic patterns (code quality)
1. **Transactional outbox boilerplate is THE dominant duplication** — fix once (H-3) = ~80 lines saved
2. **Hand-rolled `BaseEvent` bypasses `createBaseEvent()`** — contract drift risk
3. **Defensive `?.` and `as` casts persist despite CLAUDE.md bans** — 3 violations
4. **Tank/Equipment polymorphism leaks into callers** — 5 handlers copy branching
5. **Inconsistent error logging** — no unified pattern
6. **~50 unused repository injections** — dead constructor args

### Positive observations (code quality)
Documentation exceptional; phase commit markers; outbox library well-designed (hard-fail DI, prom-client guards, partial index, dead-letter, latency histogram); pessimistic locks correctly applied; reason-codec shape correct; `FarmNatsBridgeService` preemptively fixes messaging bridge's leak; `vite.config.ts` singleton pin comment explains root cause; migration idempotent with working `down()`.

---

## Architecture Findings (Phase 1B — general-purpose as architect)

### CRITICAL
- **C1** `expect: { lastMsgID: undefined }` in `nats-event-bus.ts:327-330` breaks multi-replica publishing. JetStream's `expect.lastMsgID` is CAS-style and only succeeds on the FIRST publish to an empty stream. Any subsequent publish fails with "wrong last msg ID". Outbox rows accumulate retry count and dead-letter despite NATS being healthy. **Fix: remove `expect`; dedup is already handled by `msgID + duplicate_window`.**
- **C2** Outbox worker double-publish risk — SELECT-then-UPDATE with no row-level locking. Two farm-service replicas both select the same pending rows, both publish, both update. Relies on NATS `duplicate_window` (2 min) which under load fills and evicts legitimate dedup IDs. **Fix: add `leasedAt TIMESTAMPTZ NULL` column + `SELECT ... FOR UPDATE SKIP LOCKED` lease pattern.**
- **C3** `BaseEvent.timestamp` declared as `Date` but stored as ISO string after JSONB serialization. All nested Date fields (`mortalityDate`, `harvestedAt`, `culledAt`, `transferDate`, `closedAt`, `stockedAt`) have the same lie — no recursive Date stringification. Contract is dishonest at the wire boundary. **Fix: declare `timestamp: string` (ISO 8601), bump to `version: 2`, register upcaster; or add recursive serializer in `OutboxPublisher.enqueue`.**

### HIGH
- **H1 (arch)** Bridge `switch` statement duplicates the event-type → broadcast-method map across 4 files: contract interface, `FARM_SUBJECTS` array, `handleEvent()` switch, `broadcastXxx` methods, frontend `INVALIDATION_MAP`. No compile-time sync guarantee. **Fix: derive `FARM_EVENT_TYPES` from `@platform/event-contracts` and use `emitFarmEvent(tenantId, camelCaseName, payload)` generically.**
- **H2 (arch)** Frontend `INVALIDATION_MAP` keys not typed against contracts — silent drift if event renamed. **Fix: import `FARM_EVENT_NAMES_CAMEL` from contracts.**
- **H3 (arch)** Events emitted at `version: 1` literal — no versioning governance. `EventUpcasterRegistry` exists but no upcaster registered. **Fix: define `EVENT_VERSIONS` constants in contracts, type `version` as `EventVersion<'X'>`, add validator in `OutboxPublisher.enqueue`.**
- **H4 (arch)** `record-mortality.handler.ts` triple-normalizes reason: entity cause, tank operation reason, event codec — three near-identical transformations with subtly different fallbacks. **Fix: normalize once at command boundary (Phase 5 per the comment in `reason-codecs.ts:18-22`).**
- **H5 (arch)** 7 of 10 events declare optional `farmId`/`siteId` fields that are NEVER populated. Consumers receiving `undefined` either group into null bucket or drop silently. **Fix: either populate from `tank.siteId`/`equipment.siteId` inside the transaction OR remove from the contract.**
- **H6 (arch)** Dead-lettered rows have no alerting hook. Only Grafana gauge signals the problem; no Sentry trap or webhook. **Fix: log warn + emit counter on dead-letter transition with full event payload JSON for manual replay.**

### MEDIUM
- **M1 (arch)** `OutboxModule.forFeature` re-imports `ScheduleModule.forRoot()` — wrong lifecycle scope
- **M2 (arch)** No cross-check between NATS subject tenantId and `event.tenantId` field at the bridge. If publisher bug sends `events.tenantA.BatchCreated` with `payload.tenantId = tenantB`, event lands in wrong tenant's room
- **M3 (arch)** Events lack `aggregateVersion` — cannot rebuild state from events. Document as "event notification, not event sourcing"
- **M4 (arch)** `FarmOutbox.payload` JSONB is untyped — single source of contract enforcement is `OutboxPublisher.enqueue` typing. Add runtime Zod validation
- **M5 (arch)** `BatchCreatedEvent.species: string` is underspecified — handler sends `species.commonName` which is translation-dependent. Rename to `speciesId` + add `speciesCommonName` as display hint
- **M6 (arch)** `BatchCreatedEvent.name` receives `savedBatch.batchNumber` not `savedBatch.name` — downstream renders "B-2024-00123" instead of user's display name
- **M7 (arch)** `BatchClosedEvent.closeReason: string` free-text — should be typed literal union `BatchCloseReasonCode`

### LOW
- **L1 (arch)** `OutboxMetricsService` uses `client.register` global — breaks service-specific registries
- **L2 (arch)** `row.id` update bypass — string/bigint type hint lost
- **L3 (arch)** `FarmGateway.buildWsCorsConfig()` dual config sources (module-load env vs constructor ConfigService)
- **L5 (arch)** Unhandled event types silently dropped at `debug` log — should be warn + counter
- **L6 (arch)** `allocate-to-tank.handler.ts` uses SERIALIZABLE + pessimistic_write redundantly

### Contract drift audit (Phase 1B table)

| Handler | Event | Issue |
|---|---|---|
| `create-batch` | `BatchCreated` | `name` ← `batchNumber` (wrong); `species` ← `commonName` (display-only); `farmId`/`siteId` unset |
| `record-mortality` | `MortalityRecorded` | `farmId`/`siteId` unset |
| `record-cull` | `CullRecorded` | `farmId`/`siteId` unset |
| `transfer-batch` | `BatchTransferred` | `farmId`/`siteId` unset |
| `close-batch` | `BatchClosed` | `closeReason` untyped string |
| `update-batch-status` | `BatchStatusChanged` | `farmId`/`siteId` unset |
| `allocate-to-tank` | `BatchAllocatedToTank` | OK (biomassKg recomputed wastefully at line 261) |
| `create-feeding-record` | `FeedingRecorded` | `plannedAmountKg ?? 0` creates 100% variance if payload omits planned |
| `create-harvest-record` | `BatchHarvested` | `farmId`/`pondId`/`siteId` unset |

### Tenant isolation chain audit

Steps 1-7 are clean. **Step 8 gap:** `FarmGateway.emitFarmEvent` uses `event.tenantId` from the payload, NOT the NATS subject segment. A publisher bug that mis-sets `event.tenantId` to another tenant would leak. The bridge's `isValidEvent` doesn't cross-check subject vs payload. Fix by comparing `msg.subject.split('.')[1] === event.tenantId` in `farm-nats-bridge.service.ts:172`.

### Systemic architectural risks
- **R1** Outbox publisher↔worker JSONB handshake has no schema. Add Zod runtime validation.
- **R2** Dependency direction correct (no cycles) but bridge re-declares `BaseEvent` instead of importing `FarmEvent` — single source of truth broken.
- **R3** Queue group `gateway-farm` correct but untested against JetStream semantics. Add CI smoke test.
- **R4** **No end-to-end contract test** — every link unit-tested in isolation; the drift findings (H5, M2, M5, M6, M7) would all be caught by a single E2E per handler. **Highest-value test to add.**
- **R5** Handler transaction boilerplate (~135 lines across 9 files)
- **R6** `OutboxPublisher` validates only `eventType + tenantId`, not `version`/`eventId`/`timestamp`/`aggregateId`
- **R7** Dead letters never cleaned up — accumulate forever
- **R8** `OUTBOX_ENTITY_CLASS` is a global `Symbol` — second outbox in same Nest app will collide

---

## Critical Issues for Phase 2 Context

### Security-relevant from Phase 1
- **C2** (worker double-publish) — multi-replica race condition → potential duplicate NATS messages and at-least-once violation under load
- **M2 (arch)** — bridge does NOT cross-check NATS subject tenantId segment against `event.tenantId` — theoretical cross-tenant leakage if publisher is buggy
- **H-2 / L-9** — banned `as unknown as` casts in security-sensitive auth paths (frontend socket token handling)
- **H1 (arch)** — switch-statement duplication → adding new event types without updating every branch could result in silent drops OR unintended broadcasts

### Performance-relevant from Phase 1
- **M-7** — worker polls 2 count queries/sec/replica forever, even on idle systems
- **C1** — JetStream `expect: { lastMsgID }` causes every post-first publish to fail with "wrong last msg ID", outbox rows accumulate, retry burns CPU and DB
- **C2** — double-publish under multi-replica deployment doubles NATS load and DB UPDATE contention
- **C3** — `new Date(row.createdAt)` and serialization cost on every poll cycle
- **M-1 to M-3** — oversized `execute()` methods (333, 295, 230 lines) are hard-to-optimize monoliths
- **R5** — uncached transaction boilerplate repeated per call

### Testability gaps for Phase 3 Context
- **R4** — no E2E test across the 8-step pipeline
- **M-13** — missing active-transaction assertion makes unit tests of publisher misleading
- **M-11** — frontend `INVALIDATION_MAP` untyped → no typed assertion possible in tests
