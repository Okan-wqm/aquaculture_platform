# Module dashboards (2026-10-17)

Per-module dashboards for the tenant console and the alarm dimension they need. Code changes
only: no production container, Redis or droplet runtime state was touched.

Owner: claude (implementation), okan (review).

## ADMIN-MEDIUM-161

**State:** OPEN. Deadline 2026-10-31, owner okan. The tenant-admin Modules page opens a module at
its `defaultRoute` or a local map (`/farm/dashboard`, `/sensor/dashboard`, `/hr/dashboard`), routes
the console does not serve. Needed: one owner of each module's home that both the shell and the
tenant-admin remote read (shared-ui), instead of a third copy.

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

### Fix (ALERT-LOW-014)

Both `siteId` arguments carry `new ParseUUIDPipe({ optional: true })`, the pattern of
`apps/auth-service/src/modules/tenant/resolvers/tenant-admin.resolver.ts:167`. A value that is
not a UUID is a bad request before the resolver runs; an absent or null site still means no
filter.

### Tests (ALERT-LOW-014)

`alert.resolver.spec.ts` runs the pipes each method's `siteId` argument registered, as Nest does:
a UUID and an absent or null site pass, `site-1` is a `BadRequestException`. Both failed before
the fix.

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

### Fix (ALERT-LOW-015)

- `alert-rule.site-module.postgres.spec.ts` runs `AlertRuleService`, wired through
  `TypeOrmModule`, on Testcontainers Postgres. It pins the ungrouped and grouped counts with their
  null groups, a site-filtered count against the list it opens, the rows served through the
  code-first GraphQL types as enum names, and Postgres refusing a non-UUID site.
- `feeding-execution-alert.service.spec.ts` builds its FeedingWindowReadiness event with
  `stub<>()`; `sensor-reading.handler.spec.ts` builds the site-carrying event from its typed
  `sensorReadingEvent` helper instead of an `as any` literal.
- The morning sweep pairs each overdue meal with its day plan once (`PlannedMeal`), so the
  missed-meal event reads `plan.unitCode` and `plan.siteId` from a value that is there by type,
  and the finalize, catch-up and settle steps lose their Map-lookup guards. A meal whose day plan
  does not exist is corrupt data: the retention purge deletes a plan's meals before the plan in
  one transaction. Such a meal is logged and left out of the sweep, where it used to be marked
  missed with an empty unit code.

### Tests (ALERT-LOW-015)

The real-SQL spec (6 tests) and the farm `rollup-reconciliation.postgres.spec.ts` (6 tests, it
drives `sweepTenant`) ran on this host. `feeding-cron-v2.sweep.spec.ts` adds the orphan meal: it
stays scheduled, nothing is enqueued and its unit is not locked.

## ALERT-LOW-017

**State:** OPEN until the fix merges. Deadline 2026-10-31, owner okan. Raised by the security
re-review of PR #1999.

### Symptom (ALERT-LOW-017)

`alertHistory` paged by trigger time, or by severity rank then trigger time, with no unique last
key. OFFSET paging over rows that tie on every key may repeat one row and skip another between
pages. `severityRankSql` had no `ELSE`, so a severity it does not name ranked NULL, which Postgres
sorts first under `DESC`, above every CRITICAL.

### Fix (ALERT-LOW-017)

Both orders end on `alert.id DESC`. The rank's `ELSE` is -1, below INFO. Today the column's enum
and `ALERT_SEVERITY_RANK` hold the same six values. The `ELSE` covers a value the database enum
gains before every pod that serves the list ranks it (blue-green).

### Tests (ALERT-LOW-017)

`alert-rule.site-module.postgres.spec.ts` (real Postgres): six alarms with one severity and one
trigger time, paged two at a time in both orders, come back once each in id order. After `ALTER
TYPE … ADD VALUE 'emergency'`, an alarm with that severity ranks after INFO. Both tests failed
before the fix. `alert-rule.history-filter.spec.ts` pins the ORDER BY clauses.

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

### Fix (ALERT-MEDIUM-013)

Both sides parse the site; a site is placement, never a reason to drop an alarm.

- sensor-service: `siteOfSensor` (`apps/sensor-service/src/sensor/utils/sensor-site.util.ts`)
  gives the sensor's site when it is a UUID and nothing otherwise. The four SensorReading builders
  and the pre-meal oxygen guard read the site through it.
- alert-engine: `farmOrigin`, `sensorOrigin` and `siteOfScopeKey` (`alert-origin.ts`) pass every
  site through one `storableSite`. A value that is not a UUID is recorded as no site, so an event
  from an older producer, or any other one, cannot fail the alarm insert either.

The column stays varchar; converting it is SENSOR-MEDIUM-187.

### Tests (ALERT-MEDIUM-013)

- `alert-evaluation.service.spec.ts` reproduces the loss with a Redis-like cooldown and a `save`
  that refuses a non-UUID site as Postgres does (`22P02`). The first delivery must record the
  alarm with `siteId: null` and enqueue one AlertTriggered; the redelivery is suppressed. Before
  the fix the first delivery failed and no alarm was recorded.
- `alert-origin.spec.ts` pins the parse for both families and the scope key.
- `sensor-site.util.spec.ts` and the NATS, GraphQL-ingest and MQTT producer specs publish no site
  for a label. All of them failed before the fix.

## ALERT-MEDIUM-016

**State:** OPEN until the fix merges. Deadline 2026-10-31, owner okan.

### Fix (ALERT-MEDIUM-016)

`alertHistory` takes `orderBy: AlertHistoryOrder` — `NEWEST_FIRST` (default, every other reader)
or `MOST_SEVERE_FIRST` (severity rank, newest first within one). The rank is
`ALERT_SEVERITY_RANK`, now the one ranking alert-engine reads (the evaluation service's and the
incident service's copies are gone), spelled as SQL by `severityRankSql`. The dashboard panel asks
for the most severe first.

### Tests (ALERT-MEDIUM-016)

`alert-rule.site-module.postgres.spec.ts` (real Postgres): a two-row page keeps the older CRITICAL
and the HIGH, not the two newest; `alert-rule.history-filter.spec.ts` and `alert.resolver.spec.ts`
pin the default and the forwarding.

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

## FARM-LOW-448

**State:** OPEN until the fix merges. Deadline 2026-10-31, owner okan. Raised by the security
re-review of PR #1999.

### Symptom (FARM-LOW-448)

`resolveMeasurementUnits`, the classifier of a many-unit read, read `Equipment`, `Tank` and
`Department` with raw `manager.find`. Each call filtered by tenant by hand. The site step was a
second copy of the bulk unit-site lookup `resolveUnitSiteIds`.

### Fix (FARM-LOW-448)

Equipment and legacy tanks are read through `tenantManagerRepo`, which adds the tenant to every
`where`. The sites come from `resolveUnitSiteIds`, the lookup a single point's read authorizes by
(`siteOfPoint`), so a unit has one site on either read.

### Tests (FARM-LOW-448)

`measurement-unit.spec.ts`: each read goes through the tenant-scoped repository with the tenant in
its `where`; only ids not found as equipment are asked of the legacy tanks; the sites come from one
`resolveUnitSiteIds` call over the found units; an inactive id is absent. The test failed before
the fix. `water-chemistry-reading.postgres.spec.ts` covers the many-unit read on real Postgres.

## FARM-MEDIUM-443

**State:** OPEN. Deadline 2026-10-31, owner okan. Replaces PRODUCT-MEDIUM-001 (see there): the
same gap under the farm-expert prefix. The Greenhouse preview now names this ID.

## FARM-MEDIUM-447

**State:** OPEN until the fix merges. Deadline 2026-10-31, owner okan. Raised by the security
re-review of PR #1999.

### Symptom (FARM-MEDIUM-447)

`resolvedUnitParameterValues` asked the reading resolver for every unit in one call, but the
resolver gathered each location's facts on its own. Each place of a unit's chain cost one
channel-source query and each (place, parameter) one manual-sample query. A loop-homogeneous
parameter cost two farm-arrangement reads per unit, three queries for the unit and one for its
loops. Inside one tenant read, a site of 200 units sent more than a thousand statements.

### Fix (FARM-MEDIUM-447)

`gatherReadingFacts` (`reading-facts.ts`) gathers every asked location at once, in a fixed
number of statements:

- the inheritance chains: two `loadFarmArrangement` reads, the units' tanks, loop links and sites,
  then every loop they and the asked systems are in. They run only when an ask inherits;
- every place's live channel sources: one read, an OR of `liveChannelsAtLocation` per place;
- every place's latest person-taken sample of every asked code: one statement, a `LATERAL`
  newest-first `LIMIT 1` per (point, code) over the measurement indexes. The window is not applied
  in SQL, so a sample older than the window is still reported as passed over (`OLDER_THAN_WINDOW`).

`resolveOne`, `resolveAt` and `resolveAcross` share this body, and a single point is a batch of
one. `liveSystemsOfUnit` applies the same loop rule.

### Tests (FARM-MEDIUM-447)

`parameter-reading-batch.postgres.spec.ts` (real Postgres) counts every statement the resolver sends
with a TypeORM logger (`StatementLog`). Six unit arrangements, each with its own oxygen and
temperature source, are read once (6 units) and four times over (24 units):

| Read                    | Before (6 / 24 units) | After (6 / 24 units) | Table reads after |
| ----------------------- | --------------------- | -------------------- | ----------------- |
| dissolved oxygen        | 31 / 67               | 21 / 21              | 5                 |
| temperature (inherited) | 64 / 199              | 25 / 25              | 9                 |

Two tenant reads of eight framing statements each (transaction, search path, tenant context) make
up the rest. Every answer of the 24-unit read equals `resolveOne` for that unit, for both
parameters. Several parameters at one point (`resolveAt`) equal each read alone and cost no more
statements than one. Each arrangement reads from its expected source. The count test failed before
the fix; the equality tests pass on both. `water-chemistry-reading.postgres.spec.ts`, the
single-point behaviour, passes unchanged.

## FE-HIGH-351

**State:** OPEN until the commits that carry `Closes:` for this ID merge. Deadline 2026-10-31,
owner okan.

### Symptom (FE-HIGH-351)

The Production dashboard's "DO min" read `waterQualityMeasurements` of the last day, at most 100
rows per site, and showed the lowest as the site's oxygen, as if it were live.

### Root cause (FE-HIGH-351)

Measurements are not where live oxygen is: the app writes them as manual entries
(`water-quality.service.ts:192`), and the list is cut at its page size (newest first). Farm's one
reader of "a parameter's value at a point, now" is `ParameterReadingResolver` (live channel first,
then a person's sample, in the parameter's unit, site-authorized), served one point per request
(`resolvedParameterValue`). A site has many units, so the dashboard went around it.

### Fix (FE-HIGH-351)

- farm-service: `resolvedUnitParameterValues(input: { parameterConfigId, unitIds, maxAgeSeconds })`
  answers one parameter at up to 200 units in one request. Farm classifies each unit (tank or
  water equipment, `resolveMeasurementUnits`, three queries), authorizes them as
  `assertPointReadable` authorizes one (`assertUnitsReadable`: 404 for a missing unit, 403 for a
  module user's unassigned site), and asks the resolver once (`resolveAcross`: one tenant read,
  one sensor-directory request, one placement read).
- dashboard: the oxygen cell asks for the units fed today (the day plans' units, the same ones the
  temperature cell reads) with a 24 h window, shows the lowest value in the parameter's unit, and
  says `live · 5 min ago` or `manual entry · 2 h ago`. It says when no dissolved-oxygen parameter
  is configured, when no unit is fed today, and when no unit has a value within the window.
- Data freshness reads the gateways and these readings; the measurement query is gone.

### Tests (FE-HIGH-351)

- `water-chemistry-reading.postgres.spec.ts` (real Postgres): four units in one request, a live
  channel, a person's sample (a machine row never), and none, in the asked order with one
  directory request; refused whole for an unknown unit, an inactive parameter or an unassigned
  site.
- `ModuleDashboards.spec.tsx`: the request's variables, the live and manual source lines, the
  configured unit, and no measurement query.

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

### Fix (FE-LOW-347)

When the menu draws alarm counts, its header adds a line that says what they hold:
`console.workspaceMenu.alarmsScope` ("The counts beside a module are its active alarms from the
alarm list. PLC and SCADA alarms are not included.", and the Turkish equivalent). The line joins
the dialog's accessible description. A menu without an alarm column says nothing about alarm
counts. `alarmWorkspaces.ts` no longer calls the Control & sensors column equipment alarms; it
names the sources it counts and points at SENSOR-MEDIUM-188 for the ones it does not.

### Tests (FE-LOW-347)

`WorkspaceMenu.spec.tsx` pins the line and the accessible description with an alarm column, and
their absence without one.

## FE-LOW-357

**State:** OPEN until the fix merges. Fix: shared-ui `ACTIVE_ALERT_COUNTS_KEY` is the shell
counts' key; a dashboard acknowledgement invalidates it. Test: `ModuleDashboards.spec.tsx`.

## FE-LOW-358

**State:** OPEN until the fix merges. Fix: an alarm row opens the alarm list (where the tenant
holds the sensor module); a CLEARED-unacknowledged row keeps its stripe and tint; the feed bar
marks the share of the day's plan due by now (from the meals' schedule) and turns amber when the
fed share trails it by more than 10 points; a stale site's values are greyed; the footnotes say
to select a site's (or zone's) name. Tests: `ModuleDashboards.spec.tsx`, `production.spec.ts`.

## FE-LOW-359

**State:** OPEN until the fix merges. Fix: each audit action auth-service writes into a tenant's
log has a phrase (en and tr; an unknown code is shown as recorded); the actor is the tenant's user
by name, else the recorded e-mail, else "someone outside your users", never an id. Tests:
`activity.spec.ts`, `ModuleDashboards.spec.tsx`.

## FE-LOW-360

**State:** OPEN until the fix merges. Fix: the oxygen value is printed in the unit the resolver
answered in (the parameter's). Test: `ModuleDashboards.spec.tsx` (a `ppm` parameter).

## FE-LOW-361

**State:** OPEN until the fix merges. Fix: `flatMapCell` reads the units' temperatures and oxygen
only once the plans answered, and fails with them. Test: `ModuleDashboards.spec.tsx`.

## FE-LOW-362

**State:** OPEN until the fix merges. Fix: an alarm at a site the loaded site list does not hold
says "a site outside your list"; while that list is loading or failed, an alarm with a site says
"site name unavailable"; "no site" is for an alarm that records none. Test:
`ModuleDashboards.spec.tsx`.

## FE-LOW-363

**State:** OPEN until the fix merges. Fix: specs for a `users:view` delegate (the 2FA notice, no
seat, maintenance or audit request) and a `roles:view` delegate (the access-request preview, no
admin request). Test: `ModuleDashboards.spec.tsx`.

## FE-LOW-365

**State:** OPEN until the fix merges. Deadline 2026-10-31, owner okan. Raised by the security
re-review of PR #1999.

### Symptom (FE-LOW-365)

The Production dashboard sent every unit a site's day plans name in one `resolvedUnitParameterValues`
request and one `effectiveUnitTemperatures` request. Neither was capped, but farm refuses more than
200 units, so a larger site's oxygen and temperature cells failed. One unit retired or deleted
since its plan was made answered the whole oxygen read with a 404, and the site lost every unit's
value.

### Fix (FE-LOW-365)

Decided at the server. `resolvedUnitParameterValues` returns one `UnitParameterReading`
(`unitId`, `reading`) per asked unit, in the asked order. A unit with no active row is answered
with `reading: null`, and the other units are still read. For a module user, one found unit at an
unassigned site, or at no site, still refuses the whole read (403). A not-found answer means the
id has no active row, so it says nothing about any site. The field was added in this PR, so no
client outside it reads the old shape.

The bound is one number, `MAX_UNITS_PER_READ` (`@aquaculture/shared-contracts`). farm's input
validation and `effectiveUnitTemperatures` refuse more than it, and the dashboard batches by it
(`unitBatches`). Each site's oxygen and temperature reads send one request per batch, in parallel,
and join the answers. The client cannot send a larger batch than the server takes.

### Tests (FE-LOW-365)

- `water-chemistry-reading.postgres.spec.ts` (real Postgres): a deactivated unit and an unknown id
  are answered as not found beside a read unit, and with nothing active nothing is resolved. An
  inactive parameter is a 404. A unit at an unassigned site is a 403, even beside a not-found
  unit. The old test asserted the whole-read 404 this replaces.
- `ModuleDashboards.spec.tsx`: a retired planned unit leaves the oxygen cell reading the others.
  401 planned units are asked in batches of 200, 200 and 1 for oxygen and for temperature, and the
  lowest value, alone in the last batch, is the one shown. The batching test failed against the
  previous hook.
- `production.spec.ts`: `unitBatches`; a not-found unit counts nowhere in `lowestOxygen` or the
  freshness times.

## FE-MEDIUM-346

**State:** OPEN until the module-dashboards change merges with `Closes:` for this ID. Deadline
2026-10-31, owner okan.

### Symptom (FE-MEDIUM-346)

Production, Greenhouse and Control & sensors all opened on one tenant-wide KPI page at
`/dashboard`, which the Company workspace listed too. A member without the tenant-admin role had
no company page, and `/` sent every non-admin to the KPI page whatever modules they held.

### Root cause (FE-MEDIUM-346)

`moduleOverviewArea` gave every module workspace the same `/dashboard` page. The dashboard remote
had one index page, and the tenant panel wrapped the company dashboard with every admin page.

### Fix (FE-MEDIUM-346)

- Nav: each module workspace lists its own dashboard first: Production `/dashboard`, Control &
  sensors `/dashboard/control`, Greenhouse `/dashboard/greenhouse`. Trends stay in each module
  overview. Company lists the company dashboard, messages and the AI chat, and no `/dashboard*`.
- Landing (`rootLanding`): a tenant admin lands on `/tenant`. A module user lands on the first
  module workspace's dashboard, in switcher order. Anyone else lands on `/tenant`. Sign-in
  navigates to `/` and nowhere else (FE-MEDIUM-355).
- Dashboard remote: three pages over one layout (`ModuleDashboard`). They show the module's Site
  status table, Active alarms (alert-engine `alertHistory` filtered by module, acknowledge via
  `acknowledgeAlert`), the Inbox, and Recent activity for a tenant admin. The KPI page and its
  widgets are deleted; Analytics is kept.
- Company dashboard: the `/tenant` index opens to every member (`RequireTenantMember`, and the
  shell's `TenantPanelRoute` with no role requirement at the index only). A tenant admin sees the
  unchanged `TenantDashboard`. Anyone else sees `MemberCompanyHome`: unread messages, the users
  card for a `users:view` delegate, and announcements as a preview (RBAC-MEDIUM-021). Every other
  `/tenant/*` page keeps its shell and remote guards.

### Real or preview (FE-MEDIUM-346)

| Element                      | Source                                                          |
| ---------------------------- | --------------------------------------------------------------- |
| Site list (all dashboards)   | Real: farm `activeSites`, scoped to a module user's sites       |
| Site alarms per priority     | Real: `activeAlertCounts(module, groupBy: [SITE])`              |
| Data freshness (Production)  | Real: newest of `edgeDevices(siteId)` reports and DO readings   |
| Lowest DO, limit, unit       | Real: `resolvedUnitParameterValues` + `parameterConfigs` (DO)   |
| Temperature, hottest unit    | Real: `effectiveUnitTemperatures` over the day plans' units     |
| Feed today                   | Real: `feedingDayPlans` of the site's local day                 |
| Tank count                   | Real but manual: `systems.tankCount`, labelled as entered       |
| Gateways, sensors, PLCs      | Real: `edgeDevices`, `sensors` total, `plcConnectionsBySite`    |
| PLC alarms per site          | Real: `activePlcAlarms` by connection                           |
| Greenhouse zone rows         | Preview: FARM-MEDIUM-443                                        |
| Active alarms panel          | Real: `alertHistory`, most severe first, per module             |
| Inbox: seats                 | Real (tenant admin): `tenantBilling.planLimits` + `tenantStats` |
| Inbox: users without 2FA     | Real (`users:view`): `tenantUsers.mfaEnabled`                   |
| Inbox: maintenance           | Real (tenant admin): `myAnnouncements(type: MAINTENANCE)`       |
| Inbox: access requests       | Preview (`roles:view`): RBAC-MEDIUM-020                         |
| Recent activity              | Real (tenant admin): `tenantAuditLogs`                          |
| Member home: unread messages | Real: `totalUnreadMessageCount` (caller's own)                  |
| Member home: announcements   | Preview: RBAC-MEDIUM-021                                        |

Correction (FE-HIGH-351): this section first said the lowest dissolved oxygen came from
water-quality measurements, which "hold manual entries and sensor-fed readings". That was wrong:
the app writes only manual entries there, and the read was capped at 100 rows. The cell now reads
farm's reading resolver (`resolvedUnitParameterValues`) over the units fed today: a live channel
first, else a person's latest sample, in the parameter's unit, with its source and age.

Each source is fetched only for a viewer whose role the resolver admits. Seats, maintenance and
the audit are the tenant admin's, the 2FA list needs `users:view`, and nothing admin-only is sent
for anyone else. No backend permission was widened.

### Tests (FE-MEDIUM-346)

- `web/modules/dashboard/src/__tests__/ModuleDashboards.spec.tsx` runs all three dashboards over
  a fake gateway, including role gating and what is never requested.
- `web/modules/dashboard/src/model/__tests__` pins each row rule.
- `web/shell/src/routing/__tests__/TenantPanelRoute.spec.tsx` covers the index for members and
  the unchanged gate below it. `nav/__tests__/rootLanding.spec.ts` covers the landing.
- `web/modules/tenant-admin/src/__tests__/Module.spec.tsx` covers the member view at `/tenant`
  and every other page refused as before. `MemberCompanyHome.spec.tsx` covers the member view.
- `tests/invariants/web-console-nav-coverage.spec.ts` allows exactly one member route, `/tenant`.

## FE-MEDIUM-352

**State:** OPEN until the fix merges. Deadline 2026-10-31, owner okan.

### Symptom (FE-MEDIUM-352)

`feedProgress` skipped plans whose status is `'cancelled'`; the API sends `'CANCELLED'`, so a
cancelled plan's kilograms counted as planned.

### Fix (FE-MEDIUM-352)

The dashboard's records are `Pick`s of the generated supergraph types: day-plan and meal status,
`SiteType` (`SITE_TYPE_KEYS: Record<SiteType, MessageKey>`), `PlcConnectionStatus`, alarm and user
records. `DashboardOperationResults` names each operation's result, and the spec fixtures are
typed with it, so a lower-case enum no longer type-checks. Skipped plans (a fasting window, an
operator's call) feed nothing either and count nowhere.

### Tests (FE-MEDIUM-352)

`production.spec.ts` feeds `CANCELLED` and `SKIPPED` plans; `tsc` checks the fixtures.

## FE-MEDIUM-353

**State:** OPEN until the fix merges. Deadline 2026-10-31, owner okan.

### Fix (FE-MEDIUM-353)

`SiteStatusTable` passes `searchable={false}`, `sortable={false}` and `hoverable={false}`: the
rows are a status board of composed cells, which DataTable's search and sort cannot honour.

### Tests (FE-MEDIUM-353)

`ModuleDashboards.spec.tsx` finds no text box and no button in the site table.

## FE-MEDIUM-354

**State:** OPEN until the fix merges. Deadline 2026-10-31, owner okan.

### Fix (FE-MEDIUM-354)

- The dashboard remote gates each route with the guard family's `RequireRole requiredModule`:
  Production `farm`, Control & sensors `sensor`, Greenhouse `hydroponics`. Trends stay open to
  every member. An unknown path goes to `/`, the member's own landing.
- `MODULE_MOUNTS` is keyed by route pattern: `/sites/*` gates its subtree, `/dashboard/control`
  only itself. `moduleForPath` takes the most specific gate.
- The nav-coverage invariant derives the table from App.tsx's mounts and the gated pages below
  them, so a gate and its nav entry cannot drift apart.

### Tests (FE-MEDIUM-354)

`ModuleDashboards.spec.tsx` (module gates), `match.spec.ts` (`moduleForPath`), and
`web-console-nav-coverage.spec.ts`.

## FE-MEDIUM-355

**State:** OPEN until the fix merges. Deadline 2026-10-31, owner okan.

### Fix (FE-MEDIUM-355)

One owner decides where a signed-in user starts: the shell's `/` route (`RoleBasedRedirect` →
`rootLanding`). Sign-in and MFA verification resolve `{ signedIn: true }` and name no
destination; `LoginForm` navigates to `LANDING_PATH`. shared-ui no longer selects `redirectUrl`
or `me.redirectPath`, keeps no `redirectPath` in its state, and its `getDefaultRedirect` is gone;
an open redirect through that value is no longer possible at all. Outside `AuthProvider`, login
fails closed instead of claiming a redirect.

The backend still computes those values from the seeded `defaultRoute`s (SEC-LOW-204). The
tenant-admin Modules page still opens modules at unserved routes (ADMIN-MEDIUM-161). The
Analytics page still asks for the tenant admin's `tenantStats` for every member (FE-MEDIUM-364).

### Tests (FE-MEDIUM-355)

`AuthContext.spec.tsx` (any `redirectUrl` is ignored; no document selects one), `LoginForm.spec.tsx`
(password and MFA sign-in land on `/` only).

## FE-MEDIUM-356

**State:** OPEN until the fix merges. Deadline 2026-10-31, owner okan.

### Fix (FE-MEDIUM-356)

Each alarm row carries its priority's name for assistive technology (`annunciator.label.p1`–`p3`,
`sr-only` beside the hidden glyph). Each acknowledge button is named by the alarm's message, rule,
site and time.

### Tests (FE-MEDIUM-356)

`ModuleDashboards.spec.tsx`: the priority names, and distinct button names for two alarms of one
rule at one site.

## FE-MEDIUM-364

**State:** OPEN. Deadline 2026-10-31, owner okan. The Analytics page's KPI request includes the
tenant admin's `tenantStats` in one `Promise.all`, so for a module user the whole request fails.
Needed: request it only for a tenant admin and draw the KPIs that remain.

## Independent review of PR #1997

An independent review of the ALERT-MEDIUM-010 change raised the findings below. Each is
registered with its own section; the ones fixed in PR #1997 are resolved by the commit that
carries `Closes:` for the ID, the others stay open with an owner and a deadline.

## Independent review of PR #1999

An independent review of the module-dashboards change raised the findings below. Each is
registered with its own section. The fixed ones are resolved by the commit that carries `Closes:`
for the ID; the others stay open with an owner and a deadline.

## PRODUCT-MEDIUM-001

**State:** OPEN. Deadline 2026-10-31, owner okan. Superseded by FARM-MEDIUM-443: the schema
reserves `PRODUCT-*` for Lane-B, and `apps/hydroponics-service/**` is farm-expert's in the routing
table. The registry CLI has no supersede transition (only `close`, which needs a merged fix, and
`reopen`), so this row stays OPEN for the same gap; the fix closes both IDs.

### Gap (PRODUCT-MEDIUM-001)

hydroponics-service stores one JSON configuration per tenant
(`apps/hydroponics-service/src/setup/entities/hydroponics-config.entity.ts`). It has no greenhouse
zones, no EC, pH or air-temperature readings against targets, and no dosing state. The Greenhouse
dashboard's site table renders the design's zones as a labelled preview
(`web/modules/dashboard/src/preview/greenhouseZones.preview.ts`). Its alarm panel is real and
filters `module: HYDROPONICS`, which returns nothing today because no hydroponics signal reaches
alert-engine.

### Needed (PRODUCT-MEDIUM-001)

Greenhouse zones bound to farm sites, live EC, pH and air temperature with targets, dosing state,
and the alarms raised from them.

## RBAC-MEDIUM-020

**State:** OPEN. Deadline 2026-10-31, owner okan.

### Gap (RBAC-MEDIUM-020)

No access-request flow exists. A member cannot ask for a capability or a site, and no approver has
requests to review. The dashboard inbox's access-request item (design D6) renders as a labelled
preview for `roles:view` holders (`web/modules/dashboard/src/preview/accessRequests.preview.ts`).

### Needed (RBAC-MEDIUM-020)

An auth-service access-request record (requester, capability or site, status) and a query of the
requests a viewer may approve.

## RBAC-MEDIUM-021

**State:** OPEN. Deadline 2026-10-31, owner okan.

### Gap (RBAC-MEDIUM-021)

`myAnnouncements` is documented as the current user's announcements but is gated
`@TenantAdminOrHigher` (auth-service `announcement.resolver.ts:30-34`).
A member never sees a platform announcement, a maintenance window included. The member company
dashboard shows announcements as a labelled preview. The gate was not widened in this change.

### Needed (RBAC-MEDIUM-021)

A member-readable announcements query scoped to the caller.

## RBAC-MEDIUM-022

**State:** OPEN. Deadline 2026-10-31, owner okan.

### Gap (RBAC-MEDIUM-022)

sensor-service and alert-engine apply no site scope for a module user. Edge devices, sensors, PLC
connections and alarms, alarm history and alarm counts all return the whole tenant. farm-service
limits the same user to their assigned sites (`SiteAuthorizationService.resolveSiteScope`). The
dashboards' site rows come from the scoped `activeSites`. Their alarm panel, like the console
annunciator, lists the module's alarms tenant-wide, as alert-engine serves them.

### Needed (RBAC-MEDIUM-022)

The same caller site scope in the sensor-service and alert-engine reads.

## SEC-LOW-204

**State:** OPEN. Deadline 2026-10-31, owner okan. auth-service still computes login `redirectUrl`
and `me.redirectPath` from seeded `defaultRoute`s that name unserved routes; no web client reads
them since FE-MEDIUM-355. Needed: remove both fields (breaking API: supergraph and AquaMobil
checked first) or correct the seeds with a data migration.

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
