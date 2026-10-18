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

Failure scenario: PostgreSQL fails over for 30 s. Each QoS1 reading in that window fails its
metric write, the registered handler counts a failure and resolves, `dispatchDurable` calls
`done()` and mqtt.js sends PUBACK. The broker drops the message from the persistent session and
the reading is gone, while the CRITICAL-086 code and its spec claim redelivery.

Landed: the registered handler counts a failure and rethrows it, so `dispatchDurable` holds PUBACK
and force-reconnects. `mqtt-ack-after-durable-dispatch.spec.ts` drives the real `MqttClientService`
ack gate into the real listener; a failed metric write leaves the message unacked (red on main).
`mqtt-listener.service.spec.ts` now delivers every message through the registered handler.

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
publishes it itself. `mqtt-ack-after-durable-dispatch.spec.ts`, all red on main: with NATS down,
PUBACK follows the commit of the metric rows and the outbox row; a failed enqueue rolls the rows
back and holds PUBACK; a redelivery collapses onto the committed row.
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

- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1455-1517`:
  `persistIoDataToMetrics` catches a failed `writeImmediate` and logs it.
- `mqtt-listener.service.ts:1587-1648`: `handleEdgeAlarms` catches a failed `DeviceEvent` save
  (or a failed publish before it) and logs it.
- `mqtt-listener.service.ts:1414-1422`: the per-device io_data throttle runs before persistence,
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
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1883-1891`: a payload without
  `ts`, `timestamp` or `producerTs` gets a receive-time identity.

Effect: the readiness gate cannot be passed from platform evidence, and a legacy payload without a
producer timestamp that is redelivered after its commit yields a second SensorReading. Owner
okan/claude, deadline 2027-01-16.

## SENSOR-HIGH-196

The MQTT topic resolver reports a failed lookup as "no sensor". After SENSOR-CRITICAL-190 and -191
the sensor path PUBACKs only after its durable commit, except when the sensor cannot be resolved,
and that today includes a failed lookup.

- `apps/sensor-service/src/ingestion/sensor-topic-cache.service.ts:316-326`: a per-tenant read
  error is logged at debug and skipped; the outer error returns null.
- `sensor-topic-cache.service.ts:129-132` and `:362-366`: that null is cached as a negative
  local entry for 60 s (`LOCAL_CACHE_TTL_MS`, `:72`).
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1945-1948` and `:502-507`: a failed
  sensor reload also returns null, and null returns without error, so the gate PUBACKs.

Failure scenario: the topic is cold in the local cache and Redis, and its tenant's read times out
(pool exhausted). This reading and every reading on the topic for the next 60 s are PUBACKed
without persistence. A fix separates "not found" from "lookup failed", never caches a failure, and
lets a failed lookup reject. Owner okan/claude, deadline 2026-12-17.
