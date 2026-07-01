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

## FARM-HIGH-099 — recordMortality routed through the shared TankBatch SSoT writer (PR-2)
recordMortality updated TankBatch with a hand-written `totalQuantity -= qty` / `totalBiomassKg -= biomass`
(+ denormalized current*/lastMortalityAt/avg/density) that NEVER touched `batchDetails[]` — so in a
mixed-batch tank the per-batch breakdown drifted from the aggregate (and the farm_stock_batch_snapshots
projection, rebuilt from batchDetails[], went wrong). Migrated to `TankBatchService.applyBatchDelta`
(quantityDelta:-qty, biomassDelta:-biomass, lastMortalityAt) — batchDetails[] is the SSoT, aggregates +
current* derived. Extended applyBatchDelta to maintain the denormalized current*/lastMortalityAt AND to
SELF-HEAL pre-SSoT single-batch rows (empty batchDetails + populated total + primaryBatchId) by
reconstructing the single entry from the totals, so a negative delta is never a silent no-op on a tank
stocked before #776. recordCull + transferBatch follow (PR-2b/2c); then delete the 2 duplicate
updateTankBatchWithManager. Verification: tsc-spec 0, invariants 1682/1682, mortality unit spec 20/20
(batch decrement unchanged), race-conditions + postgres-isolation handler constructions updated.

## FARM-HIGH-100 — recordCull routed through the shared TankBatch SSoT writer (PR-2b)
Same divergence as FARM-HIGH-099 for the cull path: recordCull hand-wrote `totalQuantity/totalBiomassKg -=`
+ current* + avg/density without touching `batchDetails[]` (mixed-batch drift + stale snapshot). Migrated
to `TankBatchService.applyBatchDelta(quantityDelta:-qty, biomassDelta:-biomass)` (no lastMortalityAt — cull
is not mortality). Self-heal (from #777) covers pre-SSoT single-batch rows. tsc-spec 0; cull unit spec 12/12;
batch-level cullCount/currentQuantity decrement unchanged. transferBatch + duplicate-deletion follow.
## FARM-HIGH-101 — transferBatch routed through the SSoT writer; duplicate updateTankBatchWithManager deleted (PR-2c)
transferBatch maintained TankBatch via a private `updateTankBatchWithManager` (a DUPLICATE of the same-named
method in batch.service) that moved totalQuantity by delta WITHOUT touching `batchDetails[]`, and recomputed
dest `isOverCapacity` from a hand-rolled density-only formula (hardcoded 30 kg/m³, maxBiomass ignored — its own
comment admits this). Both legs now route through `TankBatchService.applyBatchDelta` (source −, dest +;
batchDetails[] SSoT + derived aggregates + current* + self-heal), and `isOverCapacity`/`capacityUsedPercent`
are set from `TankCapacityService.calculate` — the single source of truth for capacity — exactly as allocate
does. The private duplicate is DELETED (and the now-unused EntityManager import removed). The SECOND duplicate
(batch.service.updateTankBatchWithManager, reachable only from the DEAD recordOperation shadow path) is deleted
in a follow-up (PR-2d). Verification: build tsc 0, tsc-spec 0, transfer unit spec 3/3, invariants 1684, eslint clean.
