# Initial stocking and the single writer — farm-expert, 2026-09-08

FARM-HIGH-139 asked for one thing: route `CreateBatchHandler`'s `initialLocations`
branch through `TankBatchService.applyBatchDelta` instead of hand-mutating the
`tank_batches` row. Doing that closed four data defects at once (recorded in the fix
commit, proven red-before-green against a real PostgreSQL 16 cluster).

Reading the branch to fix it surfaced five further gaps between this handler and
`AllocateToTankHandler`, which performs the same kind of write correctly. They are
recorded here rather than absorbed into that change, because each is a behaviour
change an operator would notice and none is what the finding asked for.

## FARM-HIGH-323 — initial stocking holds no lock and runs at READ COMMITTED

`create-batch.handler.ts` opens `runInTenantTransaction(...)`, which calls
`queryRunner.startTransaction()` with no isolation argument. There is not one
`lock: { mode: 'pessimistic_write' }` in the file, and its three bulk pre-fetches
(Equipment, Tank fallback, TankBatch) are unlocked reads.

`allocate-to-tank.handler.ts:117` starts `SERIALIZABLE` and takes
`pessimistic_write` on the Batch (`:143`), the Equipment (`:153`) and the legacy
Tank row (`:160`); `applyBatchDelta` locks the `tank_batches` row itself
(`tank-batch.service.ts:77`). Two concurrent stockings into the same tank can
therefore interleave on the create path in a way they cannot on the allocate path.

Note the comment at `create-batch.handler.ts:266` claims this loop runs "inside the
handler's pessimistic-lock transaction". It does not, and did not. The fix commit
corrects the comment; the behaviour is this finding.

## FARM-MEDIUM-324 — a stocked batch stays QUARANTINE

`:142` pins `BatchStatus.QUARANTINE` and nothing flips it, even though the same call
writes `AllocationType.INITIAL_STOCKING` ledger rows. `allocate-to-tank:322-326`
transitions `QUARANTINE + INITIAL_STOCKING -> ACTIVE` with `statusChangedAt`. A batch
stocked at creation therefore reads as quarantined until something else moves it.

## FARM-MEDIUM-325 — an unknown tank is skipped, not refused

`:376-385` logs a warning and `continue`s past a location whose tank cannot be
resolved, so the batch commits having stocked fewer tanks than the caller asked for
and nothing tells the caller. `allocate-to-tank:167-169` throws `NotFoundException`.
Partial success on a stocking command is the more dangerous of the two.

## SEC-HIGH-167 — no site authorization on the stocking path

`allocate-to-tank:178-183` resolves the tank's site and calls
`siteAuth.assertSiteAssignment(...)` (the SEC-HIGH-051 gate). `CreateBatchCommand`
carries only `tenantId`, `payload` and `createdBy` — no `userRoles`, no
`callerAssignedSiteIds` — so the equivalent check cannot even be written without
changing the command and its resolver signature. A caller who may not touch a site
can still stock fish into that site's tank by creating a batch with
`initialLocations` instead of allocating.

## FARM-LOW-326 — no mobile command receipt idempotency

`allocate-to-tank:120-138` begins a `MobileCommandReceiptService` receipt and
short-circuits a replay, completing it at `:348-354`. Create-batch has no receipt, so
a retried stocking command re-stocks. Lower severity than the others: batch creation
is not currently a mobile write path, and `stock-mutating-handlers-reject-legacy`
does not list this handler.
