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
  module workspace's dashboard, in switcher order. Anyone else lands on `/tenant`.
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
| Data freshness (Production)  | Real: newest of `edgeDevices(siteId)` reports and measurements  |
| Lowest DO and its limit      | Real: `waterQualityMeasurements` + `parameterConfigs` (DO)      |
| Temperature, hottest unit    | Real: `effectiveUnitTemperatures` over the day plans' units     |
| Feed today                   | Real: `feedingDayPlans` of the site's local day                 |
| Tank count                   | Real but manual: `systems.tankCount`, labelled as entered       |
| Gateways, sensors, PLCs      | Real: `edgeDevices`, `sensors` total, `plcConnectionsBySite`    |
| PLC alarms per site          | Real: `activePlcAlarms` by connection                           |
| Greenhouse zone rows         | Preview: PRODUCT-MEDIUM-001                                     |
| Active alarms panel          | Real: `alertHistory` open + cleared-unacknowledged, per module  |
| Inbox: seats                 | Real (tenant admin): `tenantBilling.planLimits` + `tenantStats` |
| Inbox: users without 2FA     | Real (`users:view`): `tenantUsers.mfaEnabled`                   |
| Inbox: maintenance           | Real (tenant admin): `myAnnouncements(type: MAINTENANCE)`       |
| Inbox: access requests       | Preview (`roles:view`): RBAC-MEDIUM-020                         |
| Recent activity              | Real (tenant admin): `tenantAuditLogs`                          |
| Member home: unread messages | Real: `totalUnreadMessageCount` (caller's own)                  |
| Member home: announcements   | Preview: RBAC-MEDIUM-021                                        |

The lowest dissolved oxygen comes from water-quality measurements, not from channel latest values.
Measurements hold manual entries and sensor-fed readings, each with its unit and site, and the
tenant's parameter configs give the limit the farm flags critical measurements with. A channel's
latest value carries neither the limit nor the unit. Which store holds more data in production
was not read: no production database or runtime was touched.

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

## PRODUCT-MEDIUM-001

**State:** OPEN. Deadline 2026-10-31, owner okan.

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
