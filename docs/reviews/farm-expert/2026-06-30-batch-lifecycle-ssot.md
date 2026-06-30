# Batch-lifecycle count/stock SSoT consolidation

Workflow audit (2026-06-30) of createBatch/allocate/mortality/cull/transfer confirmed the production
single-batch path is correct, but the tank-composition write is split across divergent hand-written
paths that drift in mixed-batch tanks. This is the program tracker; PR-1 below.

## FARM-HIGH-098 — allocateBatchToTank returned the wrong type + TankBatch batchDetails was not a true SSoT (PR-1)
**Severity:** HIGH · **Layer:** 2 · **Owner:** farm-expert
- `AllocateToTankHandler` declared `ICommandHandler<…, TankAllocation>` and returned the saved
  `TankAllocation`, but the `@Mutation(() => Batch)` and the web/mobile clients read
  `Batch{currentQuantity,…}` — so after stocking the client got a malformed object and the tank/batch
  counts did not refresh.
- The tank composition (`TankBatch`) was updated by allocate's INLINE logic which discarded
  `batchDetails[]` for single-batch tanks (`length>1 ? details : undefined`) — hiding a just-stocked
  single batch from the snapshot read model — while transfer/mortality/cull used a DIVERGENT
  hand-written `updateTankBatchWithManager` (duplicated in transfer-batch.handler AND batch.service)
  that mutated `totalQuantity` without touching `batchDetails[]`, so the per-batch breakdown drifted.

### Fix (SSoT, shared, no-duplicate)
New `TankBatchService.applyBatchDelta` — `batchDetails[]` is the single source of truth, ALWAYS
persisted, and `totalQuantity`/`totalBiomassKg`/avg/density/percent are DERIVED from it. allocate now
routes through it and returns the `Batch`. (PR-1b: convert allocate's manual SERIALIZABLE transaction
to `runInTenantTransaction` — fail-closed — keeping its pessimistic locks. PR-2: route
mortality/cull/transfer/createBatch through `applyBatchDelta` + delete the two duplicate
`updateTankBatchWithManager`.)

### Verification
`tsc -p tsconfig.spec.json` → 0; `invariants:fast` 1680/1680; allocate spec 5/5; new
TankBatchService spec 4/4 (single-batch persisted, mixed derive, zero-removes, partial-decrement).
