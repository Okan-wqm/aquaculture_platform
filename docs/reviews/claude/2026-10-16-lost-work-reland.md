# Lost-work re-land: findings registered on main (2026-10-16)

The lost-work audit of 2026-10-16 compared 58 unpushed local branches with `origin/main`. Its
"Re-land first" list names fixes that exist only on those branches. Each one is re-implemented
test-first on current main under a fresh registry id: an id carried by an old branch may name
another defect on main.

Owner: claude (implementation), okan (review).

## INFRA-CRITICAL-233

Ordinary certificate renewal regenerates the internal CA. Lost-work item 1; the old branch
`fix/login-permanent-recovery` (57ca1a0f3, PR #1452 closed unmerged) carried it as
ORPHAN-CRITICAL-820, which is not in main's registry.

- `scripts/deploy/droplet-up.sh:1009` runs `generate-internal-certs.sh --force` when the redis
  server leaf has under 30 days left.
- `infrastructure/docker/scripts/generate-internal-certs.sh:603-626`: `--force` also mints a new
  `ca-key.pem` and `ca-cert.pem`.
- `docker-compose.droplet.yml:631-633`: the NATS broker bind-mounts its server leaf and CA copy
  as single files, and an application rollout recreates it only when `nats.conf` changed.

Failure scenario: the first application rollout after 2027-04-28 (the live leaves expire
2027-05-28) runs `--force`. Restarted services trust the new CA and present leaves it signed.
The running broker keeps the old CA and the old server leaf, so every restarted service fails
the TLS handshake in both directions. A rollback restores the images, not the old CA.

Planned fix: leaf renewal becomes its own mode that keeps, and requires, the validated CA. CA
replacement gets an explicit name of its own that the deploy never passes.

The old row's second half, PostgreSQL mounts from mixed releases, is ORPHAN-CRITICAL-810 (OPEN)
and is not part of this row.

Landed: renewal is the generator's decision. The deploy calls it with no option; once any
managed leaf is inside 30 days of expiry, it re-issues every leaf under the existing, validated
CA, and so does `--renew-leaves`. Neither mints a CA. Before anything is issued, every CA copy
must equal `ca/ca-cert.pem` and every leaf must chain to it. A CA is minted only into a store
that holds no identity issued under another, and no leaf is issued under a CA that expires
first. `--rotate-ca` replaces the CA; `--force` and unknown options exit 2; no deploy path
passes an option. `production-cert-identity-store.spec.ts` runs the deploy's own call.

## INFRA-MEDIUM-234

`validate_certificate_key_pair` and `validate_certificate_authority` end six failure branches
with a bare `return` right after `if ! x=$(...); then`. A bare `return` returns the status of
the last command, the negated test, which is 0. An unparseable certificate or key therefore
logs its error, the generator prints `[skip]`, and the run exits 0. With `garbage` in
`nats/nats-cert.pem` a default run on main does exactly that, so the deploy preflight passes
and NATS fails at container start.

Planned fix: every failure branch returns 1, and the spec refuses the bare-return pattern.

Landed: the six branches return 1. The spec breaks a server leaf, a client key, the CA
certificate and the CA key in turn; each run fails without `[skip]`, and the pattern is refused.

## INFRA-HIGH-235

A renewed leaf never reaches a consumer that the rollout does not recreate. Renewal re-issues
every server and client leaf in one run and publishes each by rename, and every consumer
bind-mounts its files as single files, so it keeps the inode it opened at start.

- The NATS broker: `ensure_nats_acl_loaded` (`scripts/deploy/droplet-up.sh:508-511`) keeps it
  when `nats.conf` is unchanged and compares no TLS file. It keeps serving the old server leaf.
- Application services: a selective rollout recreates only the services it rolls out
  (`scripts/deploy/droplet-up.sh:1479`). Every other service keeps presenting its old client
  leaf.
- PostgreSQL: a production selective rollout runs `up -d postgres redis minio` (`:1438`), which
  keeps an unchanged container, and a development rollout preserves it. The applications run
  `DATABASE_SSL=false`, so this part has low impact.

Each old leaf expires at most 30 days after renewal. Only the full-stack path removes every
container first (`:1162`); a `nats.conf` change recreates only the broker. Without a full-stack
deploy inside those 30 days, the broker presents an expired leaf to every NATS client, and every
service the rollout did not restart presents an expired leaf to the broker.

Not fixed by the INFRA-CRITICAL-233 change: it needs a deploy-path harness for the recreate
decision. The fix must cover every consumer of a renewed leaf, not the broker alone. Deadline
2026-12-16. The row was widened to this scope before merge, after the change's first
verification round.

## INFRA-HIGH-237

An ordinary certificate run into an empty store mints a new CA while the NATS broker and
PostgreSQL still run on the old one. Found by the INFRA-CRITICAL-233 change's security
verification (probe P3, again as P7 in run R12), next to that change and not fixed by it.

- `infrastructure/docker/scripts/generate-internal-certs.sh:881-899`: with no CA and no managed
  leaf, key or CA copy in the store, the no-option run mints a CA and publishes it by rename.
  Nothing compares it with the root the running consumers hold.
- `scripts/deploy/deploy-paths.sh:74` and `:137`: `DEPLOY_CERTS_DIR` follows
  `DEPLOY_SOURCE_REPO`, and `mkdir -p` creates the store, empty, when it is missing.
- `scripts/deploy/droplet-up.sh:1002` runs the generator with no option and continues on exit
  0; a selective rollout then recreates only the services it rolls out (`:1479`).

Failure scenario: `DEPLOY_SOURCE_REPO` or `DEPLOY_CERTS_DIR` is overridden, or the store is
wiped. The generator exits 0 with `[done] CA`. Every restarted service presents a leaf the
running broker does not trust and refuses the broker's leaf, so each fails the NATS handshake.
Certificate expiry cannot reach this path, and a partly wiped store already refuses after the
INFRA-CRITICAL-233 change; only a store with no managed file at all keeps main's behavior.

Suggested direction: `droplet-up.sh` refuses a run whose generator minted a CA while any
`aqua-` container is running, unless it takes the full-stack path. Deadline 2026-12-18. The
finding was first minted as INFRA-HIGH-236 in a commit that never landed; 236 has no row.

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

## SENSOR-CRITICAL-190

The MQTT listener's registered handler swallows a failed metric write, so the ack gate PUBACKs a
reading that was never persisted. Found while re-landing lost-work item 3. It is a regression of
SENSOR-CRITICAL-086: 4504e8abc (2026-09-16, MQTT liveness metrics, SENSOR-MEDIUM-123) wrapped the
handler to count processed and failed messages, and its `.catch` turned the rejection into a
resolved promise.

- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:335-344`: the handler registered on
  the ack gate ends in `.catch(() => recordMessageFailed())`.
- `mqtt-listener.service.ts:534-538` and `:549-552`: a failed `saveReading` becomes
  `DurableWriteError` and is rethrown, only for the registered handler to swallow it.
- `apps/sensor-service/src/shared-mqtt/mqtt-client.service.ts:592-596`: `dispatchDurable`
  releases PUBACK as soon as every handler promise resolves.
- `apps/sensor-service/src/ingestion/__tests__/mqtt-listener.service.spec.ts:276-280`: the spec
  calls `handleMessage` directly and discards the registered handler (`void handler`), so no test
  ran the function the ack gate calls.
- `mqtt-listener.service.ts:1945-1948`: before the write, every message reloads its sensor, and
  `findSensorByTopic`'s catch-all turned a failed reload into null; `handleMessage` then returned
  normally, so the gate PUBACKed before the write was tried (found by the round-1 verification).

Failure scenario: PostgreSQL fails over for 30 s. Each QoS1 reading in that window fails its
metric write, the registered handler counts a failure and resolves, `dispatchDurable` calls
`done()` and mqtt.js sends PUBACK. The broker drops the message from the persistent session and
the reading is gone, while the CRITICAL-086 code and its spec claim redelivery.

Landed: the registered handler counts a failure and rethrows it, so `dispatchDurable` holds PUBACK
and force-reconnects. `mqtt-ack-after-durable-dispatch.spec.ts` drives the real `MqttClientService`
ack gate into the real listener; a failed metric write leaves the message unacked (red on main).
`mqtt-listener.service.spec.ts` now delivers every message through the registered handler.
Round-1 verification: a failed lookup (the tenant-scoped sensor reload, or a resolver that rejects)
now rejects with `DurableWriteError` instead of reading as "no sensor", so the same failover cannot
reach PUBACK through the reload either; two ack-chain cases cover it (red before). The resolver's
own swallow and negative cache stay under SENSOR-HIGH-196. Round-2 verification: a topic mapping
outlives its tenant, so a reload that fails because db-migrate's delete job dropped the schema
(`SCHEMA_MISMATCH`) would have held PUBACK and reconnect-looped the shared connection for every
tenant, for up to the hour the mapping stays cached. A failed reload now asks the platform
mapping whether the tenant is still active; when it is not, the topic cache evicts the tenant's
mappings and the reading is acked and dropped, while a live tenant's failed reload, or one whose
liveness cannot be read, still holds PUBACK. The erasure tombstone is asked before the reload.
`mqtt-listener.rls.postgres.spec.ts` deprovisions a tenant on PostgreSQL with its mapping cached
(red before: `SCHEMA_MISMATCH` rejected the handler).

## SENSOR-CRITICAL-191

MQTT ingestion PUBACKs a committed reading whose SensorReading dispatch was never made durable.
Lost-work item 3. The old branch `feat/100-tenant-readiness-v4` (commit b78251709, refused at merge
4d7cd7ea9) carried it as SENSOR-CRITICAL-087; on main that id is a different, RESOLVED defect (the
writer buffer, 3d784be31). Main recorded the design as Step 1.9 of
`docs/reviews/zcode/2026-08-24-100-tenant-readiness.md` and filed it under 086/087, both RESOLVED,
so nothing tracked it.

- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:189-197`: fan-out failures "stay
  swallow-and-ack until the Task 1.6 disposition/DLQ contract".
- `mqtt-listener.service.ts:529-547`: `saveReading` commits the metric rows, then
  `publishSensorReadingEvent` runs outside that transaction.
- `mqtt-listener.service.ts:1842-1872`: a failed `eventBus.publish` of the SensorReading is
  caught and logged at warn.
- `apps/sensor-service/src/sensor/services/sensor-ingestion.service.ts:242-283`: the GraphQL path
  enqueues the same event into `sensor_outbox` inside the metric transaction (SENSOR-CRITICAL-001);
  the MQTT path does not.

Failure scenario: NATS is restarting, or JetStream refuses the PubAck. A dissolved-oxygen reading
of 2.1 mg/L arrives on MQTT, its metric rows commit, the publish rejects, the error is logged and
the message is PUBACKed. No outbox row or dispatch record exists, so nothing retries: alert-engine
never evaluates the reading, the low-oxygen alarm never fires, and the dashboards never show it.

Landed: `saveReading` enqueues the SensorReading into `sensor_outbox` in the metric transaction,
keyed by its deterministic event id, and the outbox relay publishes it; the listener no longer
publishes it itself. The relay retries a failed publish for about 40-60 s (five attempts, backoff
2/4/8/16 s) and then dead-letters the row, which nothing replays. So this closes the scenario for a
publish failure inside that budget, and past it the obligation no longer vanishes: it stays in
`sensor_outbox` as a dead-lettered row. Delivery across a longer transport outage is the outbox
owner's defect, PLAT-CRITICAL-925. `mqtt-ack-after-durable-dispatch.spec.ts`, all red on main:
with NATS down, PUBACK follows the commit of the metric rows and the outbox row; a failed enqueue
rolls the rows back and holds PUBACK; a redelivery collapses onto the committed row.
`mqtt-listener.rls.postgres.spec.ts` shows the outbox row committing under FORCE RLS on PostgreSQL.

## SENSOR-HIGH-192

The Rust ingestion path acknowledges before dispatch is durable. Lost-work item 3, related half;
the old branch `feat/100-tenant-readiness-v4` (commit 3147dad5a) carried it as SENSOR-CRITICAL-097.

- `apps/sensor-ingestion/src/mqtt.rs:176-177`: `MqttOptions` is built with neither manual acks
  nor `clean_session(false)`, so rumqttc PUBACKs every PUBLISH on receipt.
- `apps/sensor-ingestion/src/mqtt.rs:302-312`: `run_event_loop` forwards each Publish into the
  channel; no ack waits for the tenant COPY, the outbox commit or the PubAck.
- `apps/sensor-service/src/ingestion/nats-ingestion-consumer.service.ts:307-321`: a failed typed
  SensorReading publish is logged and the handler returns ack.
- `docker-compose.droplet.yml:1120-1129`: zero tenants route to the sidecar today.

Latent while no tenant routes to Rust, so HIGH now and CRITICAL in effect once one does. It must
be fixed before any tenant is switched to Rust, and by 2026-12-17 at the latest (owner
okan/claude). Not fixed in the LW-SENSOR-ACK change because it is not small: manual acks with a
persistent session and a stable client id, each Publish carried through decode and batch to an
ack after its batch's tenant commit, and a durable SensorReading enqueue (or NAK) in the consumer.

## SENSOR-HIGH-193

Edge-device MQTT messages are PUBACKed when their persistence fails. Found while re-landing
lost-work item 3: these topics go through the same ack gate as sensor readings, but none of their
durable writes can hold PUBACK.

- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1462-1524`:
  `persistIoDataToMetrics` catches a failed `writeImmediate` and logs it.
- `mqtt-listener.service.ts:1594-1655`: `handleEdgeAlarms` catches a failed `DeviceEvent` save
  (or a failed publish before it) and logs it.
- `mqtt-listener.service.ts:1421-1429`: the per-device io_data throttle runs before persistence,
  so a redelivery inside the throttle window would be dropped unpersisted.

Failure scenario: PostgreSQL is unavailable for 20 s while a gateway reports a high-level alarm.
The `DeviceEvent` save fails, the error is logged and the message is PUBACKed: the alarm is
missing from the device event history and is never redelivered. Owner okan/claude, deadline
2026-12-17.

## SENSOR-HIGH-194

The parent-sensor MQTT adapter path PUBACKs on receipt. It is the per-sensor connection path for
active MQTT parent sensors (`DataIngestionService.startAllActiveSensors`), separate from the shared
listener.

- `apps/sensor-service/src/protocol/adapters/iot/mqtt.adapter.ts:298-313`: `subscribeToData`
  consumes through `client.on('message')`, which mqtt.js acks without waiting for the handler.
- `apps/sensor-service/src/ingestion/data-ingestion.service.ts:244-252`: `handleSensorData` is
  started with `void`; no ack waits for it.
- `data-ingestion.service.ts:410-445` and `:459-463`: the metric write, then a SensorReading
  publish whose failure is logged; any processing error is logged and swallowed.

Failure scenario: NATS restarts while a parent sensor publishes. The metric rows are written, the
SensorReading publish fails and is logged, and the broker has already PUBACKed: alert-engine never
sees the reading. A fix moves this path onto the shared ack gate and the outbox, or retires it.
Owner okan/claude, deadline 2026-12-17.

## SENSOR-MEDIUM-195

No durable record of admitted MQTT source messages. This is the receipt half of Step 1.9, left
open when the LW-SENSOR-ACK change closed its dispatch half through the sensor outbox
(SENSOR-CRITICAL-191). The old branch `feat/100-tenant-readiness-v4` (b78251709) built a per-tenant
`sensor_ingest_receipts` table for it.

- `docs/reviews/zcode/2026-08-24-100-tenant-readiness.md:657-731`: Step 1.9 asks for per-tenant
  source receipts and quarantine of payloads without a producer identity.
- `tools/scripts/evaluate-telemetry-readiness.ts:210-229`: the readiness gate requires
  `acceptedSourceIds` and `committedSourceIds`, which no platform table produces.
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1872-1889`: a payload without
  a usable `ts`, `timestamp` or `producerTs` gets a receive-time identity.

Effect: the readiness gate cannot be passed from platform evidence, and a legacy payload without a
producer timestamp that is redelivered after its commit yields a second SensorReading. Owner
okan/claude, deadline 2027-01-16.

## SENSOR-HIGH-196

The MQTT topic resolver reports a failed lookup as "no sensor". After SENSOR-CRITICAL-190 and -191
the sensor path PUBACKs only after its durable commit, except when the sensor cannot be resolved.
The round-1 verification narrowed this row to the resolver: the listener half (a failed
tenant-scoped reload, or a resolver that rejects) is fixed under SENSOR-CRITICAL-190.

- `apps/sensor-service/src/ingestion/sensor-topic-cache.service.ts:345-355`: a per-tenant read
  error is logged at debug and skipped; the outer error returns null.
- `sensor-topic-cache.service.ts:129-132` and `:391-395`: that null is cached as a negative
  local entry for 60 s (`LOCAL_CACHE_TTL_MS`, `:72`).
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:521-524`: a resolver null returns
  without error, so the gate PUBACKs.

Failure scenario: the topic is cold in the local cache and Redis, and its tenant's read times out
(pool exhausted). This reading and every reading on the topic for the next 60 s are PUBACKed
without persistence. A fix separates "not found" from "lookup failed" in the resolver, never caches
a failure, and lets the failure reject. Owner okan/claude, deadline 2026-12-17.

## PLAT-CRITICAL-925

The outbox relay spends its five-attempt dead-letter budget on transport outages. Raised by the
independent verification of LW-SENSOR-ACK (round 1): SENSOR-CRITICAL-191 makes the MQTT
SensorReading dispatch durable through `sensor_outbox`, and the obligation then rides on this relay,
which every service's outbox shares.

- `platform/libs/outbox/src/outbox-worker.service.ts:450-465`: `markFailed` counts every publish
  failure toward `OUTBOX_MAX_RETRIES` (5, `constants.ts:20`); only tenant-integrity and
  storage-metadata errors are permanent, and a disconnected bus or a PubAck timeout counts like any
  other failure.
- `outbox-worker.service.ts:487-491`: backoff 2/4/8/16 s, so with the 5 s poll the fifth failure
  lands about 40 s after the first (about 60 s when each attempt waits out a PubAck timeout).
- `outbox-worker.service.ts:234-241`: rows are leased without asking `eventBus.isConnected()`.
- `outbox-worker.service.ts:326-332`: the lease predicate skips dead-lettered rows, and no code sets
  `isDeadLettered` back to false.
- `platform/libs/event-bus/src/nats/nats-event-bus.ts:806` and `:921-923`: the bus nulls
  `jetStream` on close, and `publishTo` then throws at once.
- `infrastructure/monitoring/droplet/rules/60-dataflow-integrity.yml:16-19`: the pending-age SLO
  alert reads the pending set, which dead-lettered rows leave; only the warning
  `OutboxDeadLetterGrowing` fires.

Failure scenario: JetStream refuses publishes for 3 minutes. A 2.1 mg/L dissolved-oxygen reading
commits its metric rows and its outbox row and is PUBACKed; the relay fails at about 0, 5, 10, 20
and 40 s and dead-letters the row; when NATS returns nothing selects it, and alert-engine never
evaluates the reading. The same holds for every service's outbox. A fix lives in `@platform/outbox`:
a transport-unavailable failure does not spend the budget, the backoff is capped, dead-lettering
stays for permanent failures, and a relay test keeps NATS down past the old budget. Owner
okan/claude, deadline 2026-11-17.

## SENSOR-HIGH-197

The MQTT ack gate has no disposition for a permanent durable failure. Raised by the round-1
verification: fixing SENSOR-CRITICAL-190 restores the SENSOR-CRITICAL-086 contract, and with it the
loop that contract always had for a deterministic failure. The panel's payload cases (a nanosecond
`ts`, deep nesting, a non-scalar channel value) are fixed in LW-SENSOR-ACK, which makes the listener
code inside the durable leg total; what remains is a permanent database error.

- `apps/sensor-service/src/shared-mqtt/mqtt-client.service.ts:571-579`: any handler rejection, or
  the settle deadline, force-reconnects; there is no attempt bound and no disposition.
- `mqtt-client.service.ts:604-609`: `forceRedelivery` ends the one shared client with `end(true)`.
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:547-551`: every error from the tenant
  transaction becomes `DurableWriteError`, permanent or transient alike.
- `mqtt-listener.service.ts:1966-1981` (the lookup leg, added by the round-2 verification): a
  failed per-message sensor reload of a tenant the platform still lists as active becomes
  `DurableWriteError` the same way, for example 42703 when that tenant's `sensors` table lags a
  column the `Sensor` entity selects.
- `infrastructure/monitoring/droplet/rules/45-mqtt-ingestion.yml:11-16`: the ingestion alert fires
  on received == 0, which a redelivery loop never trips; nothing alerts on
  `sensor_mqtt_messages_failed_total`.

Failure scenario: one tenant's `sensor_metrics` drifts from the columns the writer inserts, or a
channel row breaks a constraint. Its next reading fails the tenant transaction, the gate
force-reconnects, the broker redelivers that message first, and mqtt.js takes the next inbound
packet only after PUBACK, so every tenant's readings queue behind it. The lookup leg loops the
same way when one tenant's per-tenant migration leaves its `sensors` table behind the entity. A
reload that fails because the tenant is gone (schema dropped, tenant not active) is not in this
row: LW-SENSOR-ACK round 2 evicts its mappings and acks the reading. Prod recorded zero
`sensor_mqtt_messages_failed_total` increments over the 15-day Prometheus retention (2026-10-02 to
2026-10-18, about 58,900 messages a week). That zero covers write-leg failures only: on main a
failed lookup returned null and counted as processed, so lookup failures never reached the
counter. SENSOR-HIGH-093 (Step 1.6)
is the NATS-consumer DLQ; this row is the MQTT ack gate's half. A fix sends a permanent failure
(SQLSTATE classes 22, 23, 42) of either leg, lookup or write, to a per-tenant quarantine row and
acks it, keeps transient failures unacked, and alerts on the failure counter. Owner okan/claude,
deadline 2026-11-17.

## SENSOR-MEDIUM-198

Tenant erasure keeps the erased tenant's dead-lettered and still-pending `sensor_outbox` rows.
Raised by the round-1 verification; related to SENSOR-HIGH-097 (published rows).

- `apps/sensor-service/src/compliance/erasure/published-outbox-purge.hook.ts:43-46`: the hook
  deletes only rows with `publishedAt IS NOT NULL`.
- `published-outbox-purge.hook.ts:20-26`: it assumes no unpublished row of the tenant exists then;
  a dead-lettered row, or one pending through a NATS outage, does.
- `platform/libs/outbox/src/outbox-worker.service.ts:509-521`: `cleanupPublished` deletes only
  published rows.

Failure scenario: a NATS outage dead-letters a tenant's SensorReading rows (PLAT-CRITICAL-925); the
tenant is later erased, and its telemetry and farm, pond and tank ids stay in `sensor.sensor_outbox`
indefinitely. The GraphQL path already had the gap; routing every MQTT reading through the outbox
makes it larger. A fix deletes the erased tenant's dead-lettered rows in the hook and settles the
pending case with the erasure saga. Owner okan/claude, deadline 2027-01-16.

## SENSOR-MEDIUM-199

The Task 1.8 erased-tenant tombstone is inert in production. Found by the LW-SENSOR-ACK round-2
verification fix, which asks the tombstone before the per-message sensor reload and gave the
listener's parameter its injection token. Related: SENSOR-HIGH-097, whose closing PR #1338
introduced the tombstone as the ingress control for erased tenants.

- `apps/sensor-service/src/compliance/erasure/erased-tenant-tombstone.service.ts:35-57`: the boot
  rebuild reads `auth.tenants`, which the sensor-service role cannot read. Prod logged "Tombstone
  rebuild query failed ... permission denied for schema auth" at 2026-10-17T21:41:53Z.
- `erased-tenant-tombstone.service.ts:88-112`: `attachEventBus` subscribes `TenantErased`, and
  nothing in the repository calls it.
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:331-338`: until round 2 the listener's
  tombstone parameter had no injection token. A `T | null` parameter is emitted as `Object`, so Nest
  passed `undefined` and the gate was null in every boot.

Today the MQTT sensor path does not depend on it: the erasure deletes the tenant's sensor rows, so a
late message's reload returns no row, and after the schema drop a reload of a tenant that is no
longer active is dropped (round 2). Failure scenario: the control the plan and SENSOR-HIGH-097 count
on answers false for every tenant, so a path that resolves a sensor without reading its row back
would persist an erased tenant's reading with no gate in place. A fix gives the rebuild a
least-privilege source (a SECURITY DEFINER platform function, as
`list_active_tenant_schema_mappings` is), calls `attachEventBus` at module init, and pins both with
a test that boots the module. Owner okan/claude, deadline 2027-01-16.
