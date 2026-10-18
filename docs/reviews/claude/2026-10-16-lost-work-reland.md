# Lost-work re-land: findings registered on main (2026-10-16)

The lost-work audit of 2026-10-16 compared 58 unpushed local branches with `origin/main`. Its
"Re-land first" list names fixes that exist only on those branches. Each one is re-implemented
test-first on current main under a fresh registry id: an id carried by an old branch may name
another defect on main.

Owner: claude (implementation), okan (review).

## FARM-CRITICAL-444

The 18:00 FCR alert sweep never fires for a live batch. Lost-work item 2, half 601; the old
branch `feat/aquamobil-v4-merge` (commit 826690623, never on main) carried it as
ORPHAN-CRITICAL-601. On main that id names a different defect, an ARIA prompt-projection copy.

- `apps/farm-service/src/feeding-protocol/services/feeding-cron-v2.service.ts:1184-1189`: the
  sweep selects batches that are active, ACTIVE or GROWING, and carry a stored `fcr.actual`
  above zero.
- `apps/farm-service/src/batch/handlers/create-batch.handler.ts:183` and
  `create-cleaner-batch.handler.ts:138`: every batch starts with `fcr.actual = 0`.
- `apps/farm-service/src/batch/handlers/close-batch.handler.ts:207`: the only writer of
  `fcr.actual`, in the block that sets `status = CLOSED` and `isActive = false` (`:194-195`).
- `apps/farm-service/src/feeding-protocol/__tests__/feeding-cron-v2.fcr-sweep.spec.ts:12-23`:
  the spec mocks `manager.query`, so the predicate never ran in any test.

Failure scenario: an ACTIVE batch fed 5 kg that grew 2 kg runs at FCR 2.5 against a target
near 1.2. Its stored `fcr.actual` is still 0, so the sweep selects nothing and alert-engine's
`FcrAlertEventHandler` never receives an `FCRAlert`. A row with `fcr.actual` above zero is
closed and inactive by construction, so the query matches nothing in any tenant.

Planned fix: the sweep selects live batches by lifecycle alone and takes each running FCR from
the single authority, `FCRCalculationService.calculateCumulativeFCR`, in one bulk pass.

Landed: the sweep selects live batches by lifecycle: `isActive` and `OPERATIONAL_BATCH_STATUSES`
(ACTIVE, GROWING, PRE_HARVEST, HARVESTING), bound as a parameter. That constant is also what
`Batch.isOperational()` and `BatchDomainService.isOperational()` read, so the batches
`assertFeedable` lets operators feed are the batches whose FCR is watched. Each batch is judged
at its last weighing, through `calculateFcrAtLastWeighingMany`: feed and the removal ledger up
to the weighing day (`weight.actual.lastMeasuredAt`), against the batch's head count at the end of
that day times the weighed average (`weight.actual.avgWeight`). The count is the live count plus
the fish the same ledger removed after that day, read in the same statement as the ledger cut. A
batch not weighed since stocking (`weight.actual.sampleSize` 0) is not judged, and only a
`converting` verdict carries an FCR. All windows go through one computation,
`computeFcrOverWindows`, which `calculateCumulativeFCR` uses too: three queries per tenant whatever
the batch count. `fcr-alert-sweep.postgres.spec.ts` runs it on real PostgreSQL, weighing through
`RecordGrowthSampleHandler` and recording deaths through `RecordMortalityHandler`; it was red on
main.

Independent verification, round 1, found three defects in the first version of this fix, all
reproduced red on that version and fixed here:

- It judged feed up to today against growth up to the last weighing, so the FCR of a batch
  converting on target rose every day until the next weighing. At a ration of 1.5% of biomass a
  day it crossed the warning threshold about five days after each weighing and the critical one
  about eleven days after. Spec case: on target at the weighing, fed 0.3 kg after it, which
  raised a warning at FCR 1.35.
- It skipped a batch only when its FCR came out as 0, not when it had never been weighed. An
  unweighed batch keeps its stocking weight, so a removal whose ledger biomass differs from the
  count times that weight leaves a tiny "growth". Spec case: 1000 fish at 12.5 g, 20 kg fed,
  3 deaths recorded by count. The ledger stores 0.04 kg for 0.0375 kg of fish, and the sweep
  raised a critical alert at FCR 8000.
- It kept the hand-typed `status IN ('ACTIVE','GROWING')`, so a fed PRE_HARVEST or HARVESTING
  batch was never judged. Spec cases: one of each at FCR 2.5, no alert.

A weighed, fed batch with no realized growth is now reported as `not-growing`, but it raises no
alert: the FCRAlert contract cannot carry an undefined FCR. That is FARM-HIGH-449.

Independent verification, round 2, found that the weighed biomass was `weight.actual.totalBiomass`,
the `populationSize` typed on the sample times the average. That count describes the moment the
sample was entered, or whatever the operator typed, not the batch on the weighing day, while the
ledger was cut by calendar day. Three spec cases were red on that version and pass here:

- 30 of 100 fish leave on the weighing day, recorded after the sample: they were in both the
  weighed biomass and the ledger, and a batch 12.5% over target read FCR 0.93 with no alert.
- 40 fish die after the weighing day and are recorded before the backdated sample, which is typed
  with the 60 left: they were in neither, and an on-target batch raised a critical alert at 3.0.
- A batch split 50/50 across two tanks is weighed in one tank and typed with that tank's 50 fish:
  an on-target batch raised a critical alert at 4.8.

A fourth case runs two batches with different weighing days through one sweep, with a death
before one weighing and after the other, so the per-batch pairing of the windows, the ledger cut
and the count add-back are pinned on real PostgreSQL; the split-batch case pins the TRANSFER_IN
sign. Flipping that sign, pairing ledger rows across batches or dropping the day cut each turns one
of these cases red. Registered from the same review:
FARM-HIGH-451 (no client can record a weighing), FARM-MEDIUM-452 (growth inside the sampling
error is judged) and FARM-MEDIUM-453 (an older sample overwrites `weight.actual`).

## FARM-HIGH-445

The bulk FCR target query throws on PostgreSQL. Found while re-landing FARM-CRITICAL-444: with
the sweep selecting live batches, a real database run failed inside the target lookup.

- `apps/farm-service/src/growth/services/fcr-calculation.service.ts:837`: the legacy leg of
  `prefetchTargetFcrContext` filters on the literal `'ACTIVE'`.
- `apps/farm-service/src/feeding/entities/feeding-program.entity.ts:81` and the baseline
  migration (`1800000000000-Baseline.ts:348`): the enum value is `active`.
- `apps/farm-service/src/feeding-protocol/services/feeding-cron-v2.service.ts:1200`: the 18:00
  sweep is the only caller of `getTargetFCRForBatches`.

Failure scenario: once the sweep selects a live batch with realized growth, PostgreSQL rejects
the query with `invalid input value for enum feeding_programs_status_enum: "ACTIVE"`. The tenant
sweep fails and emits no `FCRAlert`. On main this was hidden behind FARM-CRITICAL-444, and the
unit spec mocks `manager.query`. Introduced by f4d5a39fb (W5, FARM-LOW-291).

Planned fix: bind the status from `FeedingProgramStatus.ACTIVE` as a query parameter.

Landed: the legacy leg binds `FeedingProgramStatus.ACTIVE` as `$3`. The same PostgreSQL spec
failed with the enum error before this line changed, and the unit spec pins the bound value.
The rule is applied to every query this change touches: both v2 legs of the target chain bind
`ProtocolAssignmentStatus.ACTIVE` and `FeedingProtocolStatus.ACTIVE`, the sweep binds
`OPERATIONAL_BATCH_STATUSES`, and the FCR ledger query binds its `OperationType` values.

## FARM-MEDIUM-446

Live batches show a stored FCR of 0.00. Found while re-landing FARM-CRITICAL-444, whose fix
decides alerts from the computed running FCR and writes nothing back to `fcr.actual`.

- `apps/farm-service/src/batch/entities/batch.entity.ts:265-267`: GraphQL `Batch.fcr` exposes
  the stored document, and only `close-batch.handler.ts:207` writes `fcr.actual`.
- `web/modules/farm-module/src/pages/production/tabs/BatchOverviewTab.tsx:122` and
  `components/UpdateBatchModal.tsx:262` show 0.00 for every live batch.
- `web/modules/farm-module/src/pages/production/tabs/BatchInputTab.tsx:115` averages those
  zeros, and `:213-215` colours 0.00 as on target.
- `apps/farm-service/src/events/listeners/harvest-completed.listener.ts:349`: the harvest
  report's FCR reads the same stored copy.

The registry row's evidence lists the readers above. These read the same stored copy too, and a
fix of this row is not complete until each one moves (verification round 1 of FARM-CRITICAL-444):

- `apps/farm-service/src/equipment/equipment.resolver.ts:380`: the equipment view's batch
  performance `fcr`.
- `apps/farm-service/src/batch/query-handlers/get-batch-traceability.handler.ts:236`: the
  traceability report's `fcrActual`.
- `web/modules/farm-module/src/pages/feeding/components/FeedingSummaryTab.tsx:288-310`: the
  feeding summary's "Actual FCR", its colour and its on-target advice.
- `apps/farm-service/src/feeding/services/daily-feeding-execution.service.ts:1103`: records
  `basedOnFCR = fcr.actual ?? 1.0` on the theoretical weight, which stores 0 for a live batch.
- `apps/farm-service/src/scheduler/feeding-scheduler.service.ts:1425`: the legacy scheduler's
  FCR check (gated) skips every live batch, since `currentFCR` is 0.

The old branch `feat/aquamobil-v4-merge` (826690623) projected the running FCR onto the column
from the sweep. Who owns the displayed value is a separate decision, so it was not re-landed
with FARM-CRITICAL-444. A fix serves the FCR from the authority, as a projection it owns or a
field batched through it, and moves every reader onto it. The value to serve is the FCR at the
last weighing (`calculateFcrAtLastWeighingMany`), not the cumulative FCR to now: see
FARM-MEDIUM-450.

## FARM-HIGH-449

A weighed batch that was fed but did not grow raises no FCRAlert. Raised by the independent
verification of FARM-CRITICAL-444 (round 1, MAJOR, part b).

- `apps/farm-service/src/growth/services/fcr-calculation.service.ts:551`: the authority reports
  such a batch as `not-growing` (feed above 0, realized growth 0 or less). Its FCR is undefined.
- `apps/farm-service/src/feeding-protocol/services/feeding-cron-v2.service.ts:1221`: the sweep
  judges only `converting` batches.
- `libs/event-contracts/src/farm-events.ts:546` and `schemas/farm-events.schema.ts:1355`:
  `currentFCR` is a non-negative number on the wire.
- `apps/alert-engine/src/alert/services/fcr-alert.service.ts:46`: the consumer formats
  `currentFCR.toFixed(2)` into the incident message.

Failure scenario: a batch stocked at 10 g is weighed at 9 g after 30 kg of feed. Its FCR is worse
than any target, and nothing raises it: the sweep emits no FCRAlert, and `GrowthSampleRecorded`,
which carries a performance grade, has no consumer. Any number put in `currentFCR` would be
made up, so the fix is a contract change: `currentFCR` becomes nullable, or the event gains a
realized-growth field. The JSON schema and alert-engine's message change with it, and the
consumer deploys before the producer. It is a cross-service contract change with a
`BREAKING CHANGE:` footer, so it is its own change. `fcr-alert-sweep.postgres.spec.ts` pins the
`not-growing` verdict on real PostgreSQL. Owner okan/claude, deadline 2026-12-16.

## FARM-MEDIUM-450

The cumulative FCR to now divides feed and ledger totals up to today by a biomass from another
moment. Found while fixing the FARM-CRITICAL-444 verification BLOCKER, which was this defect in
the sweep. The sweep now uses the FCR at the last weighing. The other callers of
`calculateCumulativeFCR` keep the old window, which is on main.

- `apps/farm-service/src/growth/services/fcr-calculation.service.ts:499`: every window ends
  today. Its end biomass is the live count times the last weighed average, or the stocked biomass
  when the count is 0.
- `apps/farm-service/src/batch/query-handlers/get-batch-performance.handler.ts:96` and
  `growth/query-handlers/get-growth-analysis.handler.ts:110` show that FCR for live batches.
- `apps/farm-service/src/growth/services/fcr-calculation.service.ts:403`: `calculatePeriodFCR`
  stores a cumulative FCR cut at the new measurement date, over the biomass of the previous
  weighing. `record-growth-sample.handler.ts:187` runs it before the batch weight update.
- `apps/farm-service/src/batch/handlers/close-batch.handler.ts:172` freezes `finalFCR` from it
  after the final harvest. `harvest/handlers/create-harvest-record.handler.ts:380` closes a batch
  once its count reaches 0.

Failure scenarios. (1) A batch of 100 fish stocked at 10 g is weighed at 30 g after 2.4 kg of feed
(FCR 1.2). It is then fed 0.045 kg a day. Ten days later the performance view shows
2.85 / 2 = 1.43. (2) The same batch is harvested in full at 30 g. The ledger holds 3 kg out and
the count is 0, so the end biomass falls back to the stocked 1 kg. Growth reads 1 + 3 - 1 = 3 kg
instead of 2 kg, and `finalFCR` is frozen as 0.8 instead of 1.2, in `fcr.actual` and in the
`BatchClosed` event. A fix gives every caller a window whose end biomass is known at its end:
the last weighing for a live batch, zero for an emptied one. `computeFcrOverWindows` already
takes a per-batch window. Owner okan/claude, deadline 2027-01-15.

## FARM-HIGH-451

No shipped client can weigh a batch. Raised by the independent verification of FARM-CRITICAL-444
(round 2, MAJOR). The sweep judges a batch at its last weighing and leaves a batch never weighed
since stocking unjudged, so its value depends on weighings being recorded.

- `web/modules/farm-module/src/pages/production/tabs/GrowthTab.tsx:502`: the "Ornekleme Ekle"
  button has no `onClick`.
- `web/modules/farm-module/src/hooks/useGrowth.ts:400` and `:430`: `useRecordGrowthSample` and
  `useUpdateBatchWeightFromSample` are exported and imported by no component.
- `web/apps/aquamobil/src/pwa/operation-registry.ts:65`: the offline operation map carries
  mortality, cull, harvest and feeding mutations, and no growth sample.
- `apps/farm-service/src/growth/resolvers/growth.resolver.ts:532` and `:564`: the GraphQL
  mutations are the only callers of the two weighing commands.

Failure scenario: a tenant feeds a batch daily through aquamobil while it converts at FCR 2.5. The
operator clicks "Ornekleme Ekle" and nothing happens. `weight.actual.sampleSize` stays 0, the
authority returns `unweighed`, and the 18:00 sweep emits no `FCRAlert` for it, every day. Until
this lands, alerts start only for batches weighed through the API. A fix wires a weighing form on
the existing button (and an aquamobil operation with the idempotency envelope, if field weighing is
in scope) and proves it with an end-to-end weighing. Owner okan/claude, deadline 2026-12-16.

## FARM-MEDIUM-452

The FCR authority judges any positive growth, however small against the weighing's own sampling
error. Raised by the independent verification of FARM-CRITICAL-444 (round 2, MINOR).

- `apps/farm-service/src/growth/services/fcr-calculation.service.ts:591`: a weighed, fed batch with
  growth above 0 is `converting`, with FCR = feed / growth.
- `apps/farm-service/src/growth/handlers/record-growth-sample.handler.ts:105`: a sample needs only
  3 fish.
- `apps/farm-service/src/growth/entities/growth-measurement.entity.ts:502`: the sample's 95% margin
  of error is computed, and nothing on the FCR path reads it.
- `apps/farm-service/src/batch/entities/batch.types.ts:138`: `weight.actual` stores no spread, so
  the authority cannot bound the weighed biomass.

Failure scenario: 100 fish stocked at 10 g are fed 0.1 kg in their first week (true FCR 1.0). A
3-fish sample a week later averages 10.2 g instead of 11 g, about one standard error at 20%
individual CV. Growth reads 0.02 kg and FCR 5.0, and a critical incident opens. A fix stores the
weighing's margin of error with `weight.actual` (both growth-sample writers) and reports a batch
whose growth is not clearly above count x margin as not yet judgeable, pinned by a real-PostgreSQL
case. Owner okan/claude, deadline 2027-01-15.

## FARM-MEDIUM-453

A growth sample dated before the batch's last weighing overwrites `weight.actual`. Raised by the
independent verification of FARM-CRITICAL-444 (round 2, MINOR, writer contract).

- `apps/farm-service/src/growth/handlers/record-growth-sample.handler.ts:224` and
  `update-batch-weight-from-sample.handler.ts:64`: either writer replaces the average, the day and
  the sample size with any sample's, whatever its date (the growth backdate window is 30 days).
- `apps/farm-service/src/batch/entities/batch.entity.ts:455`: `getCurrentAvgWeight` reads
  `weight.actual.avgWeight` first, and `getCurrentBiomass` multiplies it by the live count.
- `apps/farm-service/src/batch/handlers/record-mortality.handler.ts:225` and
  `transfer-batch.handler.ts:224`: removals and transfers are valued at that weight.

Failure scenario: a batch weighed on day D at 50 g gets a sample dated D-10 at 30 g entered
afterwards. The displayed biomass drops by 40%, the next mortality is valued at 30 g a fish, and
the FCR sweep judges the D-10 weighing. The FARM-CRITICAL-444 window stays consistent (the average
and the day come from one sample, and the count on that day from the ledger), so its alerts are
older, not wrong; the defect is in the writers. A fix makes both writers refuse to move
`weight.actual` backwards inside their locked update. Owner okan/claude, deadline 2027-01-15.

Landed with FARM-CRITICAL-454: both writers apply a sample through `GrowthSampleApplierService`,
which leaves `weight.actual` alone when it holds a weighing from a later day (the stocking
placeholder, `sampleSize` 0, never holds one back). The tank's share has its own stamps in
`batchDetails[]`: the day it was last weighed (`weighedOn`) and the last feeding day whose growth it
holds (`grownThrough`). `TankBatchService` carries both into the destination share of a transfer,
so moved fish keep them. A sample dated before either stamp does not move the share.
`weighing-reaches-ration.postgres.spec.ts` records two samples out of order, and a sample older than
a weighing made before a transfer; both were red on main.

## FARM-CRITICAL-454

A growth weighing never reaches the feeding ration. Lost-work item 2, half 600; the old branch
`feat/aquamobil-v4-merge` (commit 826690623, never on main) carried it as ORPHAN-CRITICAL-600.
On main that id names a different defect, an ARIA prompt-hash mismatch.

- `apps/farm-service/src/growth/handlers/record-growth-sample.handler.ts:224-242` and
  `update-batch-weight-from-sample.handler.ts:64-78`: both writers put the sample on
  `Batch.weight.actual` and stop. Nothing writes `tank_batches`.
- `apps/farm-service/src/feeding-protocol/services/feeding-cron-v2.service.ts:525-527`,
  `day-plan-recalc.service.ts:135-137` and `protocol-feed-forecast.service.ts:529-536`: the
  06:00 plan, the intra-day recalc and the feed forecast size the ration from the tank's
  `tank_batches` count, biomass and average weight.
- `apps/farm-service/src/feeding-protocol/services/biomass-growth-applier.service.ts:152-165`:
  the FCR projection (`biomass += fed / expected FCR`) is the only writer of a stocked unit's
  weight, and it never reads a measurement.
- `apps/farm-service/src/batch/entities/tank-batch.entity.ts:210-212`: `lastSamplingAt` has no
  writer.

Failure scenario: a tank holds 1000 fish stocked at 10 g (10 kg) on a protocol whose band below
25 g feeds 3% a day. The fish are weighed at 30 g. The batch says 30 g, the tank still says 10 g
and 10 kg, so today's remaining meals stay at 0.3 kg a day, the band never moves to the grower
feed, and tomorrow's 06:00 plan is 0.3 kg again instead of 0.45 kg. The fish are fed for a third
of their weight until the projection happens to catch up, and nothing ever corrects it.

Planned fix: both writers apply a weighing through one service. It re-bases the weighed batch's
share of its tank onto the measured average through the unit growth writer, under the unit lock,
and reprices the tank's live day plan in the same transaction. The old branch's weight-provenance
column, branded band weight and legacy-writer deletion are not part of this root cause.

Landed: `GrowthSampleApplierService.applySample` is the one path for both writers. It finds the
unit the sample weighed (its tank, else its pond unit, else the one unit holding fish of the
batch), takes the unit lock itself (`lockUnitForGrowth`; every caller wraps its transaction in
`withUnitLockRetry`, which the `unit-growth-lock-composition` gate checks for lock delegates), and
proves under the lock that the unit holds fish of the batch. It writes `weight.actual`, then
`BiomassGrowthApplierService.applyMeasuredWeight` re-bases the weighed batch's share (count x
measured average) and stamps `lastSamplingAt`. It refreshes the farm-stock read model and reprices
the live day plan (`growth_sample`) for the locked unit. A sample being recorded is refused if it
names no unit for a batch held in several, whether it is applied at once or kept as history, and a
sample applied at once is refused if it names a unit that holds no fish of the batch (one kept as
history may name a unit the batch has left). A sample that names none is stamped with the unit it
was resolved to (`tankId`, or `pondId` for a pond unit), on the row and on `GrowthSampleRecorded`. A
sample kept as history and applied later cannot be corrected any more: when its unit can no longer
be re-based (the batch left the unit it names, or it names none and the batch is in several), it
still becomes `weight.actual` and no unit moves. The record handler takes the unit lock before it
inserts the measurement, whose foreign key would otherwise lock the sampled batch out of order.

`TankBatchService` writes `null` to an emptied tank's primary batch. It wrote `undefined`, which
TypeORM's UPDATE skips, so a tank emptied by mortality, cull or harvest kept naming the departed
batch. A weighing naming that tank wrote a zero-fish share back into it, and a weighing naming no
tank was refused as "stocked in 2 tanks". A transfer hid this, because its handler saves the row a
second time. `BackfillTankBatchPrimaryAndShareStamps1822100000000` clears the leftover primaries.
It also gives every existing share a `grownThrough` (the day its row was last written). A unit
holds a batch when it has a share of it with fish in it: in memory `stockedShareOf`, in SQL
`tankHoldsBatchSql` (`batch/utils/tank-membership.util.ts`), which `unitsHoldingBatch` and the
regulatory site scope read. Protocol assignment, the FCR target lookup and batch traceability keep
their own "primary, or any detail" predicate, which agrees with it on every row the writer produces.

Three readers used the leftover primary as history, and now read the data that records it. The
harvest handler enqueues `TankCleared` in its own transaction when the harvest takes the last fish
out of the tank; the BatchHarvested listener had looked the tank up by `primaryBatchId`. The
biomass draft's stockings scope a batch to the site through the `tank_allocations` ledger, or a
site tank that holds it now. The disease draft does the same for a batch with no fish left
anywhere (`regulatory/assembly/batch-site-scope.ts`). Every other `primaryBatchId` reader asks
what a tank holds now, so the leftover was a wrong answer there.

A sample dated before the last feeding day whose growth a share holds does not re-base the share:
re-basing would throw that growth away and underfeed the tank. Such a sample is kept as
`weight.actual` and history. Carrying it forward by the growth since its day is FARM-HIGH-456. It
is the part of this defect that remains: a weighing entered after the next feeding day's first
meal still does not reach the ration. Growth of a feeding day before a share's weighing does not
land on that share, because the weighing measured it.

Red/green: `weighing-reaches-ration.postgres.spec.ts` had 8 cases at the first fix, and 7 of them
failed on main. The verification rounds grew it to 29 cases: 8 of the first 25 failed against the
first fix (be5546536), and 4 of the 29 against the round-1 fix (1070bf1c5).
`emptied-tank-history.postgres.spec.ts` (4 cases) failed 3 against the round-1 fix. The v1 feeding
writer that bypasses this path is FARM-HIGH-455.

## FARM-HIGH-455

The legacy daily feeding execution (feeding programs v1) writes a tank's weight around the unit
weight writer. Found while re-landing FARM-CRITICAL-454; the old branch deleted this writer as a
legacy duplicate, and that part was not re-landed with the weighing fix.

- `apps/farm-service/src/feeding/services/daily-feeding-execution.service.ts:656-665`: the new
  biomass is the plan-time snapshot (`execution.calculations.biomassKg`) plus this feeding's growth.
- `daily-feeding-execution.service.ts:1085-1087`: `updateTankBiomassWithManager` sets
  `avgWeightG`, `totalBiomassKg` and `currentBiomassKg` directly and never touches `batchDetails[]`.
  `recordActualFeeding` (`:722`) calls it, reached by the live `recordDailyFeeding` mutation
  (`feeding-program.resolver.ts:1073`).
- `apps/farm-service/src/batch/services/tank-batch.service.ts:209-212`: every stock delta
  re-derives the aggregates from `batchDetails[]`.

Failure scenario: a v1 tank's 06:00 plan snapshots 10 kg. At 10:00 the fish are weighed at 30 g
and the tank is re-based to 30 kg. At 14:00 a v1 feeding of 0.3 kg at FCR 1.2 sets the tank to
10.25 kg, below the weighing, for every ration reader. `batchDetails[]` still says 30 kg, so the
next mortality, transfer or v2 growth re-derives about 30 kg and drops the v1 growth. A fix routes
the v1 growth through `BiomassGrowthApplierService.applyGrowth` under the unit lock, from the
locked unit rather than the snapshot, or retires the v1 path. Owner okan/claude, deadline
2026-12-17.

## FARM-HIGH-456

A growth sample dated before growth its tank already holds never reaches the ration. Raised by the
independent verification of FARM-CRITICAL-454 (round 1, two MAJORs on the sample's age). Registered
as FARM-MEDIUM-456 and re-graded to HIGH by round 2: it is FARM-CRITICAL-454's own failure for every
weighing entered after the next feeding day's first meal, and typing a paper record the next morning
is a common way samples arrive.

- `apps/farm-service/src/feeding-protocol/services/biomass-growth-applier.service.ts:309-310`:
  `applyMeasuredWeight` holds back a sample dated before the share's `grownThrough` or `weighedOn`.
- `biomass-growth-applier.service.ts:241`: `applyGrowth` stamps the feeding day, but nothing
  records how much growth each day added.
- `apps/farm-service/src/growth/services/growth-sample-applier.service.ts:223-228`: the held-back
  sample stays `weight.actual` and history; no day plan is repriced.
- `apps/farm-service/src/common/services/backdate-policy.service.ts:77`: growth samples may be
  dated up to 30 days back.

Failure scenario: fish are weighed on the morning of day D, and the sample is entered on day D+1
after D+1's first meal. The share's `grownThrough` is D+1, so the weighing becomes `weight.actual`
and history only, and the tank and its meals stay on the projection until a newer weighing. The
FARM-CRITICAL-454 fix is the safe half: such a sample can no longer throw growth away. A fix keeps
the growth each feeding day added to each share, re-bases the share at the sample's day and adds
the growth of the later days. TankBatchService carries that ledger through transfers. A
real-PostgreSQL case proves it. Owner okan/claude, deadline 2026-12-17.

## FARM-MEDIUM-457

Mortality and cull value a removal at the batch-wide `weight.actual`, not at the weight of the tank
share the fish leave. Raised by the same verification (MINOR). The fault exists on main, and
FARM-CRITICAL-454 makes the per-share weight the ration authority, so a split batch whose tanks
weigh differently is now the expected state.

- `apps/farm-service/src/batch/handlers/record-mortality.handler.ts:225` and
  `record-cull.handler.ts:190`: `payload.avgWeightG || batch.getCurrentAvgWeight()`.
- `apps/farm-service/src/batch/handlers/transfer-batch.handler.ts:220`: a transfer reads the
  source share's weight first.
- `apps/farm-service/src/batch/services/tank-batch.service.ts:167-171`: a removal larger than the
  share's biomass is refused.

Failure scenario: tank T1 holds 60 fish of a split batch at 10 g (0.6 kg). T2 is weighed at 30 g,
which sets `weight.actual` to 30 g. A 25-fish mortality in T1 with no weight is valued at 0.75 kg,
more than T1's share, so it is refused and cannot be recorded. A smaller mortality removes three
times the biomass the dead fish had. A fix values the removal from the share's `avgWeightG`, as
transfer does, and proves it with a real-PostgreSQL case. Owner okan/claude, deadline 2027-01-16.

## FARM-HIGH-458

`StockReconstructionService`'s replay selects `species.name`, a column the species table does not
have, so every biomass (FD-0001) draft for a period older than the previous month fails. Found by
the FARM-CRITICAL-454 verification round 2, whose real-PostgreSQL case assembled the April draft on
the entity schema and got `column s.name does not exist`. Present on main.

- `apps/farm-service/src/batch/services/stock-reconstruction.service.ts:230`: the species name is
  read from `s.name`.
- `apps/farm-service/src/database/migrations/1800000000000-Baseline.ts:202`: species has
  `scientificName`, `commonName` and `localName`, no `name`.
- `apps/farm-service/src/regulatory/assembly/biomass.assembler.ts:111`: the replay runs for every
  stale period, inside the `Promise.all` that assembles the draft.
- `apps/farm-service/src/__tests__/e2e/stock-reconstruction.postgres.spec.ts:87`: the replay's
  real-PostgreSQL spec hand-creates species with a `name` column.

Failure scenario: the August draft is opened in October. The period is stale, the replay runs,
PostgreSQL rejects it, and the draft cannot be assembled, where an incomplete replay should fall
back to a blocking MANUAL_REQUIRED. A fix selects the display name the live calculator uses
(`commonName`, else `scientificName`) and moves the spec onto the entity schema. Owner okan/claude,
deadline 2026-12-17.

## FARM-MEDIUM-459

A tank share `TankBatchService` creates without carried weight stamps has no `weighedOn` or
`grownThrough`, so a sample dated before its fish arrived can re-base it. Raised by the
FARM-CRITICAL-454 verification round 2 (MINOR).

- `apps/farm-service/src/batch/services/tank-batch.service.ts:57` and `:197`: a new share takes
  stamps only from the optional `weightStamps`, which only the transfer passes.
- `apps/farm-service/src/harvest/handlers/delete-harvest-record.handler.ts:118` and
  `apps/farm-service/src/batch/handlers/allocate-to-tank.handler.ts:243`: shares created with no
  stamps.

Failure scenario: a full-tank harvest is recorded by mistake on day D and deleted; the re-created
share has no stamps, so a sample dated D-10 naming the tank re-bases it to the old weight and cuts
today's meals. Stamping a new share with the write day, as suggested, is wrong for new fish: a
stocking can be backdated and samples can be dated 30 days back, so it would hold back the samples
of a backdated batch (the FARM-HIGH-456 failure). A fix makes the day the fish entered the unit a
required part of a positive delta, and restores a deleted harvest's share stamps. Owner
okan/claude, deadline 2027-01-16.

## FARM-MEDIUM-460

A growth sample's day is cut from the instant the client sends, and the share stamps it is ordered
against are site-local plan days. Raised by the FARM-CRITICAL-454 verification round 2 (MINOR).

- `apps/farm-service/src/growth/dto/create-growth-measurement.input.ts:139`: `measurementDate` is a
  DateTime instant.
- `apps/farm-service/src/growth/entities/growth-measurement.entity.ts:260-262`: it is stored in a
  `date` column, so the server cuts the day from the instant.
- `apps/farm-service/src/feeding-protocol/services/biomass-growth-applier.service.ts:93`:
  `calendarDay` reads the UTC day, the day the row stores.
- `apps/farm-service/src/feeding-protocol/services/feeding-cron-v2.service.ts:510`: `planDate`,
  which `applyGrowth` stamps as `grownThrough`, is the site-local day.

Failure scenario: on a UTC+3 site the 07:00 meal of 10-19 is finalized and the fish are weighed
that morning; a client that sends local midnight (10-18T21:00Z) stores the sample on 10-18, before
the share's 10-19, so it is held back. Converting only the unit comparison to site time would make
the share disagree with the stored row and with `weight.actual`. A fix fixes the sample's day at
entry, as the unit's site-local day, and orders every reader by it. No shipped client records
samples yet (FARM-HIGH-451). Owner okan/claude, deadline 2027-01-16.
