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

Exact or nothing, in tenant schemas only, under a transaction-local `app.bypass_rls` inside one DO
block (the runner binds no tenant and the tenant policy is forced):

- module from provenance: rows with a `sensor_id` (only rule evaluation sets it) and the oxygen
  guard's rule id → sensor; the listed `system:` farm rule ids → farm; anything else stays NULL.
- site from what the row names: the sensor's `site_id`, the farm signal's own `siteId` /
  site-UUID `siteScopeKey`, the day plan's site for meal and oxygen-guard rows, the measurement's
  site for water-quality rows. Each sibling table is read only where that module is provisioned
  in the tenant schema.

Left NULL: mortality, FCR, low stock and feed type transition rows (no single site, or none
recorded), rows whose referenced record is gone, and rows of a tenant without the module. The one
inexact case: a sensor moved to another site since an old alarm keeps that alarm on its current
site, the same binding the live path stamps.

### Tests (ALERT-MEDIUM-010)

- The migration's Postgres spec (`add-alert-history-site-and-module.migration.postgres.spec.ts`
  in alert-engine's migration tests) runs it as a role without BYPASSRLS on forced-policy tables.
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
