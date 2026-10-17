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

Landed: the sweep selects ACTIVE and GROWING live batches by lifecycle and takes each running FCR
from `calculateCumulativeFCRMany` (three queries per tenant; `calculateCumulativeFCR` delegates to
it). `fcr-alert-sweep.postgres.spec.ts` runs it on real PostgreSQL; it was red on main.

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
