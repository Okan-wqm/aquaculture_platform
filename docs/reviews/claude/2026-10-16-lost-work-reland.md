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

The old branch `feat/aquamobil-v4-merge` (826690623) projected the running FCR onto the column
from the sweep. Who owns the displayed value is a separate decision, so it was not re-landed
with FARM-CRITICAL-444. A fix serves the running FCR from the authority, as a projection it owns
or a field batched through `calculateCumulativeFCRMany`, and moves every reader onto it.
