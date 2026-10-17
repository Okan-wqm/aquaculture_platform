# Module dashboards (2026-10-17)

Per-module dashboards for the tenant console and the alarm dimension they need. Code changes
only: no production container, Redis or droplet runtime state was touched.

Owner: claude (implementation), okan (review).

## Alarm site and module (closes ALERT-MEDIUM-010)

ALERT-MEDIUM-010 (`docs/reviews/claude/2026-10-16-tenant-console-d6.md`) recorded that alert-engine
counted alarms tenant-wide only, so the workspace menu's per-module counts were a labelled preview.

### What changed (ALERT-MEDIUM-010)

`alert_history` records the module an alarm comes from (`AlertModule`: farm, sensor,
hydroponics) and the farm site its source belongs to. Migration `1801200000000` adds both columns,
nullable and blue-green safe, with an index each. `activeAlertCounts` takes `siteId` and `module`
filters and `groupBy: [SITE | MODULE]`; without arguments its rows keep the annunciator's shape.
`alertHistory` takes the same `siteId` / `module` filters. One helper (`applyAlertHistoryScope`)
applies the scope to both, so a count and the list it opens hold the same rows.

The console's count query groups by module. The annunciator sums every row; the workspace menu
draws each module workspace's P1/P2/P3 from the same response. The preview file
`web/shell/src/console/rail/workspaceAlarms.preview.ts` and its i18n reason are deleted.

### Where each alarm's module and site come from (ALERT-MEDIUM-010)

The consumer states the module of the signal family; the site comes from data the producer
already had. Every event field added is optional: events minted before it still validate.

| Alarm                         | Module | Site source (new field unless noted)              |
| ----------------------------- | ------ | ------------------------------------------------- |
| Rule on a sensor reading      | sensor | `SensorReading.siteId`: the sensor's site         |
| Pre-meal oxygen guard         | sensor | `FeedingWindowReadiness.siteId`: the DO sensor's  |
| Water quality critical        | farm   | `WaterQualityCritical.siteId`: the measurement's  |
| Mortality                     | farm   | `MortalityAlertRaised.siteId`: the tank's         |
| Meal underfed / missed        | farm   | `MealUnderfed` / `MealMissed.siteId`: day plan's  |
| Feed type transitioned (INFO) | farm   | `FeedTypeTransitioned.siteId`: plan or assignment |
| Unfed unit                    | farm   | `UnfedUnitDetected.siteId` (existing)             |
| Feed stockout / gap forecast  | farm   | `siteScopeKey` if a site UUID; `tenant` → none    |
| FCR                           | farm   | none: a batch is not bound to one site            |
| Low stock                     | farm   | none: stock is counted tenant-wide                |

`MortalityRecorded` always declared `siteId`; the mortality handler now fills it from the tank's
site it already resolved for the authorization check. Readings ingested through the GraphQL
mutations and parent routing read the sensor's site from its own row inside the ingest
transaction; a client is never asked for a site. The wire schemas of the farm signals and
`FeedingWindowReadiness` admit the optional UUID; `SensorReading` and `WaterQualityCritical` have
no wire schema.

No hydroponics-service signal reaches alert-engine today, so `module: HYDROPONICS` answers with no
alarms. The greenhouse dashboard's alarm panel reads it as such.

### Backfill (ALERT-MEDIUM-010)

Migration `1801300000000`, separate from the DDL (ALERT-MEDIUM-011), in tenant schemas only.
Exact or nothing (ALERT-LOW-012):

- module from provenance: rows with a `sensor_id` (only rule evaluation sets it) and the oxygen
  guard's rule id → sensor; the listed `system:` farm rule ids → farm; anything else stays NULL.
- site only from the source the live path stamps: the farm signal's own `siteId` / site-UUID
  `siteScopeKey`, the day plan's site for meal rows, the measurement's site for water-quality
  rows. Each sibling table is read only where that module is provisioned in the tenant schema.

Left NULL: rule alarms on sensor readings (the live path stamps the site the sensor had at
reading time; only its current site is on record), oxygen-guard rows (the live path stamps the
DO sensor's site, which the row does not name), mortality, FCR, low stock and feed type
transition rows (no single site, or none recorded), rows whose referenced record is gone, and
rows of a tenant without the module.

### Tests (ALERT-MEDIUM-010)

- The migrations' Postgres specs (`add-alert-history-site-and-module.migration.postgres.spec.ts`
  and `backfill-alert-history-site-and-module.migration.postgres.spec.ts` in alert-engine's
  migration tests) run them as a role without BYPASSRLS on forced-policy tables.
- `alert-rule.site-module.spec.ts`, `alert.resolver.spec.ts` and each creation path's service spec
  pin the scope, the grouping and the origin of every alarm path.
- Producer specs in sensor-service and farm-service pin the site on each event;
  `libs/event-contracts/src/schemas/__tests__/alarm-site.schema.spec.ts` pins the wire schemas.
- `web/shell/src/console/{data,rail}/__tests__` pin the per-module tallies, the shared request and
  the menu slot without a preview.

## SENSOR-HIGH-186

**State:** OPEN. Deadline 2026-10-31, owner okan.

### Symptom (SENSOR-HIGH-186)

The pre-meal oxygen guard never sees a fresh dissolved-oxygen reading. For a unit with a DO
sensor it reports `no_reading` on every guarded meal, and a real low-oxygen reading is never
flagged.

### Root cause (SENSOR-HIGH-186)

`FeedingWindowReadinessService.loadOxygenObservations` picks each sensor's freshest reading from
`sensor_readings`. SENSOR-HIGH-085 retired that table: every ingest path writes `sensor_metrics`
only. The tenant search_path includes the `sensor` source schema, so the unqualified name
resolves to the stale cross-tenant `sensor.sensor_readings` instead of failing.

### Evidence (SENSOR-HIGH-186)

- `apps/sensor-service/src/feeding-window/feeding-window-readiness.service.ts:172-181`
- `apps/sensor-service/src/sensor/services/sensor-ingestion.service.ts:261`
- `apps/sensor-service/CLAUDE.md:27`
- `libs/backend-common/src/database/tenant-connection-bootstrap.service.ts:132`

Static evidence; not reproduced against a database.

### Fix needed (SENSOR-HIGH-186)

Read the DO sensor's latest value from the tenant `sensor_metrics` hypertable (its dissolved
oxygen channel), inside the same tenant-bound read. Found while adding the guard's site to
`FeedingWindowReadiness`; not fixed there.

## Independent review of PR #1997

An independent review of the ALERT-MEDIUM-010 change raised the findings below. Each is
registered with its own section; the ones fixed in PR #1997 are resolved by the commit that
carries `Closes:` for the ID, the others stay open with an owner and a deadline.

## ALERT-MEDIUM-011

**State:** OPEN. Resolved by the PR whose commit carries `Closes:` for this ID. Deadline
2026-10-24.

### Symptom (ALERT-MEDIUM-011)

Migration `1801200000000` keeps the live alarm table locked for as long as its backfill runs. On
a tenant with a long alarm history every alarm insert, acknowledgement and list read waits for
it, and nothing bounds the wait.

### Root cause (ALERT-MEDIUM-011)

The runners give each migration one transaction. `up()` adds both columns (ACCESS EXCLUSIVE
until commit), builds two indexes without `CONCURRENTLY` and then runs up to seven full-table
UPDATEs in the same transaction. It sets no `lock_timeout` or `statement_timeout`, which 77 of
the repository's migrations do.

### Evidence (ALERT-MEDIUM-011)

- `apps/alert-engine/src/database/migrations/1801200000000-AddAlertHistorySiteAndModule.ts:81-108`
- `apps/alert-engine/src/database/migrations/1801200000000-AddAlertHistorySiteAndModule.ts:146-190`
- `libs/backend-common/src/database/migration-runner/migration-runner.service.ts:600`

### Fix (ALERT-MEDIUM-011)

`1801200000000` is DDL only and sets `SET LOCAL lock_timeout = '2s'` and
`statement_timeout = '30s'` in `up()` and `down()`. Its transaction is short. A live alarm
transaction on the table makes it give up after 2 s and roll back whole instead of queueing; a
queued ACCESS EXCLUSIVE request would block every later reader of the table.

The backfill is `1801300000000-BackfillAlertHistorySiteAndModule`, `transaction = false`. It walks
`alert_history` in primary-key order, 5 000 rows per batch, each batch its own transaction under
the same two timeouts and a transaction-local `app.bypass_rls`. A live acknowledgement waits at
most for one batch's row locks. A batch fills only columns still NULL, so a run stopped midway
keeps its committed batches and a re-run completes the rest. The runner records the migration
only after `up()` returns. It refuses to run inside a transaction it cannot commit batch by
batch.

### Tests (ALERT-MEDIUM-011)

On Testcontainers Postgres:

- `add-alert-history-site-and-module.migration.postgres.spec.ts`: the migration's transaction
  carries both timeouts and the session keeps none. Behind a live reader it fails with `55P03`
  in under 10 s and leaves no half-added column. It writes no row.
- `backfill-alert-history-site-and-module.migration.postgres.spec.ts` runs a 10 001-row table.
  A live row lock in the second batch stops the run at `lock_timeout` with the first batch
  committed. The re-run completes, and the rows carry three distinct `xmin`s, one per batch. The
  spec also covers a re-run writing nothing, the refusal inside a transaction, and no bypass left
  behind.

## ALERT-LOW-012

**State:** OPEN. Resolved by the PR whose commit carries `Closes:` for this ID. Deadline
2026-10-24.

### Symptom (ALERT-LOW-012)

The backfill is documented as exact or nothing, but two of its site sources are not the live
path's. A sensor moved since an old alarm puts that alarm on its new site. An oxygen-guard alarm
gets its day plan's site, while a new one gets its DO sensor's site.

### Root cause (ALERT-LOW-012)

No history of a sensor's site exists: the sensor join can only read the current binding. The
oxygen guard's triggering data names its day plan but not its DO sensor, so the backfill used
the day plan's site, a different source from the live stamp.

### Evidence (ALERT-LOW-012)

- `apps/alert-engine/src/database/migrations/1801200000000-AddAlertHistorySiteAndModule.ts:162-169`
- `apps/alert-engine/src/database/migrations/1801200000000-AddAlertHistorySiteAndModule.ts:67-72`
- `apps/alert-engine/src/alert/services/feeding-execution-alert.service.ts:244`

### Fix (ALERT-LOW-012)

The backfill writes a site only from the source the live path stamps. Sensor-rule and oxygen-guard
rows keep a NULL site: no record states the site the sensor had at reading time, and the
oxygen-guard row does not name its DO sensor. Their module is still exact. The backfill no longer
reads `sensors`.

### Tests (ALERT-LOW-012)

`backfill-alert-history-site-and-module.migration.postgres.spec.ts` seeds a sensor bound to a site
and expects its rule alarm `sensor@NULL`, the oxygen-guard row `sensor@NULL`, and meal rows the day
plan's site. A gone or malformed day-plan reference stays NULL without a cast error, and a row the
new release already stamped is not overwritten.

## ALERT-MEDIUM-013

**State:** OPEN. Resolved by the PR whose commit carries `Closes:` for this ID. Deadline
2026-10-24.

### Symptom (ALERT-MEDIUM-013)

A sensor whose `site_id` holds anything but a UUID raises no rule alarm. The alarm insert fails
with `22P02` (invalid uuid). The Redis cooldown was claimed before the insert, so the redelivered
reading is suppressed as in cooldown and the alarm is lost.

### Root cause (ALERT-MEDIUM-013)

`sensors.site_id` is varchar (SENSOR-MEDIUM-187). Four SensorReading builders stamp it on the
event unchecked; only the oxygen guard parsed it. alert-engine forwards the event's `siteId`
through `sensorOrigin` to the uuid `alert_history.site_id`.

### Evidence (ALERT-MEDIUM-013)

- `apps/sensor-service/src/database/entities/sensor.entity.ts:234`
- `apps/sensor-service/src/ingestion/nats-ingestion-consumer.service.ts:365`
- `apps/sensor-service/src/sensor/services/sensor-ingestion.service.ts:1005`
- `apps/sensor-service/src/ingestion/data-ingestion.service.ts:437`
- `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1864`
- `apps/alert-engine/src/alert/event-handlers/sensor-reading.handler.ts:126`
- `apps/alert-engine/src/alert/services/alert-evaluation.service.ts:299`, `:319`, `:348`
- `apps/alert-engine/src/alert/entities/alert-history.entity.ts:74`

## SENSOR-MEDIUM-187

**State:** OPEN. Deadline 2026-11-14, owner okan.

### Symptom (SENSOR-MEDIUM-187)

The database accepts any label as a sensor's site. Every reader that stores or compares the
site as a uuid has to parse it first, and a reader that does not fails (ALERT-MEDIUM-013).

### Root cause (SENSOR-MEDIUM-187)

`sensors.site_id` was created `character varying` and the entity declares no type. Every site id
is a farm site UUID, and the columns it is copied into (`sensor_metrics.site_id`,
`alert_history.site_id`) are uuid.

### Evidence (SENSOR-MEDIUM-187)

- `apps/sensor-service/src/database/entities/sensor.entity.ts:234`
- `apps/sensor-service/src/database/migrations/1800000000000-Baseline.ts:25`
- `apps/sensor-service/src/database/entities/sensor-metric.entity.ts:153`
- `apps/alert-engine/src/alert/entities/alert-history.entity.ts:74`

### Fix needed (SENSOR-MEDIUM-187)

A per-tenant audit of non-UUID values (reported, then cleared), `ALTER COLUMN site_id TYPE uuid`
and the entity's `@Column('uuid')`. The parse in `siteOfSensor` then reduces to the column's
type. PR #1997 adds that parse at every event reader (ALERT-MEDIUM-013) and leaves the column as
it is. Related: SENSOR-MEDIUM-161 (the site is never checked against farm).

The sensor's other location columns (`department_id`, `system_id`, `equipment_id`, `tank_id`,
`pond_id`, `farm_id`) are varchar too. The MQTT and data-ingestion paths copy them, with
`site_id`, into the uuid columns of `sensor_metrics`
(`apps/sensor-service/src/ingestion/mqtt-listener.service.ts:2048`,
`apps/sensor-service/src/ingestion/data-ingestion.service.ts:381`). There a value that is not a
UUID fails the metric write, and the reading is lost before any event is built (read from the
code, not reproduced). This predates ALERT-MEDIUM-010. The same migration converts them together.

## SENSOR-MEDIUM-188

**State:** OPEN. Deadline 2026-10-31, owner okan.

### Symptom (SENSOR-MEDIUM-188)

With a PLC alarm or a SCADA runtime alarm active, the console's annunciator and the workspace
menu's Control & sensors column show no alarm.

### Root cause (SENSOR-MEDIUM-188)

PLC alarms and SCADA runtime alarms live in sensor-service's own stores and never reach
`alert_history`. The annunciator and the menu count `activeAlertCounts`, which reads
`alert_history` only. The menu's per-module column came with ALERT-MEDIUM-010; the annunciator's
gap predates it.

### Evidence (SENSOR-MEDIUM-188)

- `apps/sensor-service/src/plc-control/resolvers/plc-control.resolver.ts:538-586`
- `apps/sensor-service/src/scada-runtime/services/alarm-engine.service.ts:138`
- `web/shell/src/console/rail/alarmWorkspaces.ts:28-32`
- `web/shell/src/console/data/useActiveAlertCounts.ts:33-35`

### Fix needed (SENSOR-MEDIUM-188)

A design decision: PLC and SCADA alarm transitions recorded in alert-engine as sensor-module
alarms, or the console reading both sources. Until then the menu says what its counts hold
(FE-LOW-347).

## FE-LOW-347

**State:** OPEN. Resolved by the PR whose commit carries `Closes:` for this ID. Deadline
2026-10-24.

### Symptom (FE-LOW-347)

The workspace menu describes Control & sensors as devices, PLC and SCADA and draws an alarm count
beside it. Nothing on the menu says the count holds alert-engine alarms only, so with a PLC or
SCADA alarm active the row reads as no alarms.

### Evidence (FE-LOW-347)

- `web/shared-ui/src/i18n/locales/en.ts:1383`
- `web/shared-ui/src/components/Layout/console/WorkspaceMenu.tsx:175-178`
- `web/shell/src/console/rail/alarmWorkspaces.ts:4`

## ALERT-LOW-014

**State:** OPEN. Resolved by the PR whose commit carries `Closes:` for this ID. Deadline
2026-10-24.

### Symptom (ALERT-LOW-014)

`alertHistory(siteId: "x")` and `activeAlertCounts(siteId: "x")` answer with a database error
(`22P02`, invalid uuid) instead of a validation error.

### Evidence (ALERT-LOW-014)

- `apps/alert-engine/src/alert/resolvers/alert.resolver.ts:103`
- `apps/alert-engine/src/alert/resolvers/alert.resolver.ts:137`
- `apps/alert-engine/src/alert/services/alert-history-scope.ts:26`

## ALERT-LOW-015

**State:** OPEN. Resolved by the PR whose commit carries `Closes:` for this ID. Deadline
2026-10-24.

### Symptom (ALERT-LOW-015)

The grouped alarm count (`getRawMany` aliases, the null group, enum values) is proven only
against mocks. A spec casts a `FeedingWindowReadiness` literal, another adds the site inside an
`as any` event, and the missed meal's site is read through `?.` on a Map lookup.

### Evidence (ALERT-LOW-015)

- `apps/alert-engine/src/alert/services/alert-rule.service.ts:306-341`
- `apps/alert-engine/src/alert/services/__tests__/feeding-execution-alert.service.spec.ts:205`
- `apps/alert-engine/src/alert/event-handlers/__tests__/sensor-reading.handler.spec.ts:256-257`
- `apps/farm-service/src/feeding-protocol/services/feeding-cron-v2.service.ts:874`
