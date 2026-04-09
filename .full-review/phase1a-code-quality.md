# Phase 1A — Code Quality Review (superpowers:code-reviewer)

> Full output from the code-reviewer agent. Consolidated into
> `01-quality-architecture.md` after Phase 1B completes.

## Executive Summary

The end-to-end pipeline (handler outbox enqueue → worker → NATS → gateway bridge → Socket.IO → React Query invalidation) is well-architected and the documentation in the code is unusually high quality — almost every file has a top-of-file block explaining "why this exists" and most non-trivial sections have inline rationale. The transactional outbox library is genuinely well-designed: clean DI surface, proper isolation, prom-client guards against double-registration, and a hard-fail boundary that ships a deterministic crash at startup if a service forgets to register an entity. The biggest quality issues are (a) heavy duplication across the nine handlers (transaction setup, event construction, post-write metric ribbon — each handler reinvents the same 30 lines), (b) two banned `as unknown as` casts that the rules explicitly forbid, and (c) handler functions that have grown to 200–340 lines and are clearly past the implicit "function should fit on a screen" budget.

There are no Critical findings. Several High findings around banned casts and SOLID violations, and a long tail of Medium / Low items.

## HIGH findings

- **H-1** `as unknown as IEvent` cast in `outbox-worker.service.ts:151` — banned by CLAUDE.md. Fix: type `OutboxEntityBase.payload` as `BaseEvent` directly.
- **H-2** `(socket as unknown as { auth: { token: string } }).auth = { token }` in `useFarmRealtimeStream.ts:158` — banned. Fix: assign `socket.auth = { token }` directly (socket.io-client types accept it).
- **H-3** **Massive boilerplate duplication** — 9 handlers repeat the same 11-line `createQueryRunner → connect → startTransaction → try/catch/finally` ceremony. Fix: extract `OutboxTransactionRunner.run(work)` helper in the outbox library; each handler collapses to ~50% of its current size.
- **H-4** **Every handler hand-builds BaseEvent fields** instead of using `createBaseEvent()` from `@platform/event-contracts` — contract drift risk when schema bumps. Fix: use the factory everywhere.
- **H-6** `FarmGateway` broadcast methods accept `Record<string, unknown>` payloads instead of the typed contract events. Fix: import `MortalityRecordedEvent` etc. and use them as parameter types.
- **H-7** `FarmDomainEvent` interface in `farm-nats-bridge.service.ts:66-77` **re-declares BaseEvent** instead of importing `FarmEvent` — shadow type drift risk.

## MEDIUM findings (summary)

- **M-1** `CreateBatchHandler.execute` = 333 lines, 8 responsibilities — extract 3 private methods
- **M-2** `TransferBatchHandler.execute` = 295 lines, duplicates tanks/equipment branching — extend `updateTankBatchWithManager`
- **M-3** `CreateHarvestRecordHandler` hand-rolls `parseQualityGrade` + `generateCode` — move to DTO transformer / `CodeGeneratorService`
- **M-4** `findTankOrEquipmentWithManager + isFromTanksTable` leak — 5 handlers copy the same if/else block; encapsulate in `LocationRef.updateBiomass(manager, ...)`
- **M-5** `OutboxPublisher.enqueue` type-casts payload to `Record<string, unknown>` with misleading comment — fix via the typed base
- **M-6** `OutboxWorkerService.metricsLabel` uses untested regex for PascalCase→snake_case — allow explicit override
- **M-7** Worker polls every 1s regardless of workload — 2 count queries per second per replica. Refresh gauges on slower cadence (30s)
- **M-8** Cleanup job lacks metrics — add `outbox_cleanup_deleted_total` counter + `last_run_timestamp` gauge
- **M-9** `RecordMortality/RecordCullHandler` use `MortalityCause[payload.reason.toUpperCase() as keyof typeof X] ?? UNKNOWN` — another cast hack. Move to `reason-codecs.ts`
- **M-10** `CreateBatchHandler` ships `name: savedBatch.batchNumber` to the event, but entity has `name` field — contract says `name: string` — sends the wrong value
- **M-11** Frontend `INVALIDATION_MAP` has hyphenated key `['feeding', 'daily-executions']` with no compile-time link to actual `useFeeding` query keys — export constants
- **M-12** `RecordMortalityHandler` computes `batch.getMortalityRate()` twice — once for the entity, once for the event — risk of divergence
- **M-13** `OutboxPublisher.enqueue` does NOT assert the `manager` is in an active transaction — silent contract violation if a future handler passes `dataSource.manager` by mistake

## LOW findings (summary)

L-1 through L-16 — unused `randomUUID` imports (once H-4 lands), string-typed bigint `id` needs comment, no-op generic on `OutboxModule.forFeature`, useless `exports: [OutboxModule]` in `FarmOutboxModule`, defensive `payload?.tenantId` ?. check violates "no defensive ?.", missing stack trace in bridge catch, EventBus reconnect assumption undocumented, prom-client global registry (test isolation risk), `import.meta as unknown as` cast, `transferReason` vs `reason` undocumented DB/wire split, `new Date(alreadyDate)` waste, `new Date(row.createdAt)` waste, unused repository injections in every handler (~50 dead DI args), `FarmEventName` type too loose, i18n string hardcoding.

## Systemic patterns

1. **Transactional outbox boilerplate is THE dominant duplication** — fix once (H-3) = ~80 lines saved + whole class of bugs gone.
2. **Hand-rolled `BaseEvent` fields bypass the official factory** — contract drift risk.
3. **Defensive `?.` and `as` casts persist despite CLAUDE.md bans** — 3 violations in-scope.
4. **Tank/Equipment polymorphism leaks into callers** — 5 handlers copy the same branching.
5. **Inconsistent error logging** — some log message only, some log stack, some log nothing.
6. **~50 unused repository injections** across 9 handlers — dead constructor args.

## Positive observations

1. Documentation is exceptional — every file has a "why" block
2. Phase commit markers in code comments (Phase A/B/C/D/E) enable chronological reading
3. Outbox library: hard-fail injection, prom-client guards, partial index, dead-letter, cleanup job, latency histogram with sensible buckets
4. At-least-once + msgID dedup via JetStream = effective exactly-once; comment is accurate
5. Pessimistic locks correctly applied everywhere a TOCTOU race existed
6. `reason-codecs.ts` is the right shape — narrow conversion at the event boundary
7. `FarmNatsBridgeService` preemptively fixes the `MessagingNatsBridgeService` reconnect leak from day one
8. Frontend `invalidateQueries` (not optimistic patching) is the right robustness call
9. `vite.config.ts` singleton pin comment is the most useful comment in the diff — root-cause explanation
10. `CreateFarmOutboxTable` migration is idempotent with working `down()`

## Recommended fix order

1. H-1, H-2, L-9 — banned cast violations (mechanical)
2. H-3 — extract `OutboxTransactionRunner` (largest single win)
3. H-4 — adopt `createBaseEvent()` everywhere
4. M-13 — assert active transaction in publisher (3 lines, prevents future bug)
5. M-9 — move `MortalityCause[...]` lookups into `reason-codecs.ts`
6. M-4 — encapsulate `LocationRef.updateBiomass`
7. M-1, M-2, M-3 — decompose oversized `execute` methods
8. L-13 — drop unused repository injections
9. H-7, H-6 — type-narrow bridge → gateway boundary
