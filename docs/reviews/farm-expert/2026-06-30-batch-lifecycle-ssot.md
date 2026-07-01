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
## FARM-HIGH-102 — cleaner-fish mortality never decremented the cleaner batch currentQuantity (PR-3)
record-cleaner-mortality.handler bumped `cleanerBatch.totalMortality += quantity` but never dropped
`cleanerBatch.currentQuantity` — so the live cleaner-fish count drifted permanently above the true stock
(the regular record-mortality.handler decrements both). Added
`cleanerBatch.currentQuantity = Math.max(0, currentQuantity - quantity)` (the tank-level
cleanerFishQuantity + the cleaner-fish batchDetail were already decremented; only the batch aggregate was
missed). New unit test asserts 900 → 890 alongside totalMortality 100 → 110. spec 10/10, tsc-spec 0.
## FARM-HIGH-103 — mobile↔web stock drift: event-driven farm-stock read-model projector (mobile fix)
The mobile `farmStockInventory` read model (farm_stock_container_snapshots/batch_snapshots) was refreshed by
a `FarmStockProjectionService.refreshContainers` call HAND-ENUMERATED inside ~10 write handlers. Any handler
that omitted the call left mobile stale: CreateBatchHandler.initialLocations (a freshly-stocked tank's fish —
the "180 fish in Cage-1 don't show in the app" report), DailyFeedingExecutionService, and every cleaner-fish
handler had no call, so their mutations never reached the app while web (which reads tank_batches live) showed
them. Root cause = the fragile per-handler obligation, not any one missing call.
FIX (Tier-2, automatic): new `FarmStockProjectionListener` (events/listeners) reuses the SHARED IEventHandler +
subscribeWildcard pattern (identical to MortalityRecordedListener) and the SHARED refreshContainers SSoT, and
subscribes to all 7 stock-mutation events (BatchCreated, BatchAllocatedToTank, BatchTransferred,
MortalityRecorded, CullRecorded, CleanerFishMortalityRecorded, FeedingRecorded — every one already emitted via
the transactional outbox). It extracts the affected tank id(s) (tankId / tankIds[] / source+dest) and refreshes
inside runInTenantTransaction (pinned search_path + RLS, fail-closed) — so a NEW stock path is covered
automatically and no handler can silently forget. Idempotent + rethrow-on-error → the read model converges via
bounded redelivery. The tank-CONFIG handlers keep their sync refreshContainers (tank metadata changes emit no
stock event); the batch-stock handlers' sync calls become defense-in-depth (immediate + event-driven, both
idempotent). Verification: listener unit spec 10/10, tsc-spec 0, invariants 1684, eslint clean; module wired
into app.module (boots + subscribes).

## FARM-HIGH-104 — tank fish-COUNT single-writer (mobil↔web 900-vs-719 root cause)
Same physical tank stock had TWO independently-maintained count fields: tank_batches.totalQuantity (SSoT,
mobile batchMetrics.pieces) vs equipment/tank.currentCount (web equipmentList.currentCount). Each handler did a
compute-then-write on currentCount independently of tank_batches → drift (prod 900 vs 719). Made
TankBatchService.applyBatchDelta the SINGLE currentCount writer: it derives tank/equipment.currentCount =
totalQuantity (count-only QueryBuilder, same tx) via findTankOrEquipmentWithManager. Removed the independent
currentCount compute-then-write from record-mortality/record-cull/transfer-batch/create-harvest/delete-harvest;
their currentBiomass write is preserved as a biomass-ONLY UPDATE (never a full-entity save, which would clobber
the derived count). currentBiomass unification deferred to FARM-HIGH-105 (needs feeding→batchDetails growth
model; deriving it now would drop weight-gain → capacity under-report). Existing drift is corrected by the
ledger-reconcile (FARM-HIGH-106). tsc 0, 6 specs 55/55, invariants 1684.

## FARM-MEDIUM-107 — single-writer invariant for tank fish-count (locks in FARM-HIGH-104)
Codifies the Phase-1 fix as a build-time guard (tests/invariants/farm-count-single-writer.spec.ts, layer-3):
the stock-mutation handlers (mortality/cull/transfer/create-harvest/delete-harvest) MUST route the count
change through applyBatchDelta and MUST NOT write Tank/Equipment.currentCount themselves (comments stripped).
A future handler reintroducing a compute-then-write currentCount fails the build — the 900-vs-719 drift class
cannot regress. Passes on main post-#790; all layer-3 green (1022 tests).

## FARM-HIGH-106 — ledger-reconcile for existing tank-count drift (fixes the current 900-vs-719)
Phase-1 (FARM-HIGH-104) stops FUTURE drift; existing rows are still off. TankCountReconcileService recomputes
each tank-batch's TRUE count from the operation ledger — trueQty = Σ tank_allocations(initial_stocking+split+
transfer_in − transfer_out) − Σ tank_operations(mortality+cull+harvest, not-deleted) — the auditable source,
not either drifted denormalization (verified no double-count: transfers live in allocations, mortality/cull/
harvest only in operations). Exposed as the TENANT_ADMIN mutation reconcileTankCounts(dryRun=true default,
tankIds?): DRY-RUN reports the per-tank-batch diff (current vs ledger vs delta) WITHOUT writing so the operator
reviews first; apply routes every non-zero delta through applyBatchDelta (the single writer) so batchDetails +
totalQuantity + currentCount all land on the ledger truth. Service spec 4/4 (dry-run no-write, apply-via-single-
writer, delta-0 no-op, tankIds filter); tsc 0, tsc-spec 0, invariants 1686.


## FARM-MEDIUM-110 — central-only invariant (no BatchService bypass caller). See FARM-HIGH-109 for physical deletion.
## FARM-HIGH-109 — DELETE the ~586-line BatchService write-shadow + migrate its tenant-isolation e2e spec. Owner farm-expert, deadline 2026-07-15.
