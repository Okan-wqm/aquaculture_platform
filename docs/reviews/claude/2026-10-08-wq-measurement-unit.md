# What a unit's water-quality form asks for, and where a measurement is filed (2026-10-08)

PR-3.0a of the water-chemistry channel-binding plan (rev2, decisions D4 and D5).
It is the farm-side ground the binding owner (PR-3.1/3.2) builds on, and has no
DDL.

## FARM-HIGH-367 — manual entry is refused or misfiled by unit

Every client sends the picked unit as `equipmentId`: RecordTab, BulkRecordTab,
AquaMobil and its offline queue. Farm's equipment list presents tanks (tanks,
ponds, cages, and a legacy `equipment.isTank` row) beside non-tank water
equipment.

- **An unmapped unit refused every value.** With a unit given, the validator
  refused any parameter not mapped to it (`NOT_MAPPED`). A unit nobody mapped
  has an empty plan, so every submitted value was refused. Prod on 2026-10-07
  had no mappings at all.
- **The form and the validator used different rules.** The forms read the
  mapped parameters; the validator read the tenant's configs and the mappings
  on its own.
- **Writers filed the unit in the wrong column.** The temperature writer
  copied the one id into both `tankId` and `equipmentId`; the batch writer set
  only `equipmentId`. Tank readers missed batch rows.
- **The site check read only `tankId`.** An equipment-only submission had no
  site, so a MODULE_USER was denied.

### Fix

- **One unit classifier** (`measurement-unit.ts`). `resolveMeasurementUnit`
  finds the active unit, classifies it as tank or equipment, and resolves its
  site through its department. `measurementUnitColumns` files it as `tankId` or
  `equipmentId`, never both. All three writers (single, batch, temperature) use
  it. A missing or inactive unit is a 404.
- **The unit's site is authoritative and the only one stored.** A client-sent
  `siteId` is a consistency check: refused when it names another site, never
  trusted for a unit without one. A `tankId` that names another unit than
  `equipmentId` is refused.
- **One measurement plan** (`measurement-plan.ts`), read by both the validator
  and the new `unitMeasurementPlan(unitId)` query:
  - a planned unit shows its plan, and the plan's required parameters are
    required;
  - a unit nobody mapped shows every active parameter and requires none;
  - with no unit, every active parameter is shown and the tenant's required
    ones are required;
  - a configured parameter outside the plan is accepted (ad-hoc lab and vet
    samples).
  - The plan's codes come from an inner join, so a mapping whose config row is
    gone names nothing (tenant schemas carry no FK).
- **The forms read the plan.** farm-module's `useEquipmentParameters` and
  AquaMobil's record page query `unitMeasurementPlan`, so the form cannot ask
  for less or more than the server requires.

No queued offline payload changes: the classification is farm's.

## FARM-MEDIUM-368 — the batch input accepted machine sources

The single create already refused machine sources from a person; the batch
input did not, and BulkRecordTab offered them. The batch `source` now carries
the same `@IsHumanMeasurementSource` gate, and the tab offers manual and lab
only. Machine sources come only from the sensor ingest path.

## Readers name a measurement's unit

Filing a unit by kind left a non-tank unit's row with `tankId` NULL; before, RecordTab sent
`tankId` = the picked unit, so a biofilter's rows carried one. A reader keyed on `tankId` alone
drops those rows, and every tank row the old batch writer filed only as `equipmentId`.

One owner: `measurement-unit-reader.ts` (beside the classifier, free of database imports).

- `measurementUnitIdSql(alias)`: `COALESCE(tankId, equipmentId)`, quoted, valid in a query
  builder and raw SQL.
- `measurementUnitMatchSql(alias, rhs)`: the same rows as `COALESCE(...) rhs`, written as
  `tankId rhs OR (tankId IS NULL AND equipmentId rhs)` so both column indexes serve it.
- `measurementUnitIdOf(row)`: `tankId ?? equipmentId` for a loaded row.

`measurement-unit-readers.invariant.spec.ts` scans farm-service and fails on a query builder,
raw SQL or `find` over measurements keyed on `tankId` (selecting the column is allowed).

Readers changed:

- `list-critical-water-quality.handler.ts` (the dashboard's life-safety list): latest row per
  unit. The old join compared unquoted `latest.tankId`/`latest.maxDate`; Postgres folds them to
  lowercase, and on Postgres 16 the generated SQL failed with `column latest.tankid does not
exist` — the list errored on every call. The new SQL was run there too.
- `list-water-quality.handler.ts`: new `unitId` filter. `tankId` and `systemId` match by unit
  too: every caller passes a tank's id, and its batch-entered rows are its rows. Filters AND.
- `get-latest-water-quality`, `get-water-quality-chart`, `get-tank-water-quality-statistics`:
  match the unit. The GraphQL argument stays `tankId` (public API); the queries carry `unitId`.
- `get-system-water-quality-statistics`, `get-system-water-quality-chart`: the system's tanks
  are matched by unit.
- `water-temperature.service.ts`: the per-unit manual reads use the helpers; the site-level
  manual reads join `tanks` on the unit id, so a tank's batch-entered rows count.
- `get-batch-traceability.handler.ts`: its own `tankId OR equipmentId` predicate is replaced
  by the shared one.
- `water-quality.service.ts`: `update()` and the temperature recalc use `measurementUnitIdOf`.
- farm-module: RecordTab's recent entries filter by `unitId`; the create/update mutations
  invalidate every unit's latest/statistics (a key from `data.tankId` missed a non-tank unit).

Readers left, and why:

- `get-water-quality.handler.ts`, `findById`: by measurement id; no unit.
- `get-todays-daily-ops-counts.handler.ts`, `cron-jobs.service.ts`: tenant-wide count,
  retention and view refresh; no unit. `mv_daily_tank_water_quality` has no reader.
- `ai-query.projections.ts`, `get-water-quality-overview.responder.ts`: they drop no row;
  they project the stored `tankId` into the AI contract field `tankId`, so a non-tank row
  reaches the assistant with `tankId` null. Carrying the unit needs a contract field
  (`@platform/event-contracts` and ai-service) — open; needs a tracked finding.
- HistoryTab's unit column shows `m.tankId`; the measurement type exposes no unit field.
  Rows of a tank entered through the old batch form show `-` — open; needs a tracked finding.
- The system readers take a system's units from `tanks.systemId` only (not equipment-table
  tanks nor `equipment_systems`) — pre-existing, open; needs a tracked finding.
- Outside farm-service: alert-engine already reads `tankId ?? equipmentId` from the events
  (which carry both columns); MCP `detect-anomalies` labels rows by `tankId`, and its list
  filter now matches by unit.

## Independent review → fixes

- HIGH — readers keyed on `tankId` dropped non-tank and batch-entered rows: the section above.
- MEDIUM — `update()` validated against `equipmentId`, NULL on a tank row, so the no-unit
  rule required every tenant-required parameter. It validates against the row's unit.
- MEDIUM — `mappedCodesForUnit` counted a mapping to a soft-deleted config (deleting a config
  leaves its mappings active), making the unit planned with no entries. It now joins only
  `config.isActive = true` and `config.tenantId = :tenantId`.
- MEDIUM — the batch writer and the batch `source` gate had no test that fails on revert:
  `water-quality.service.spec.ts` (createBatch files by kind and site, denies a unit at
  another site, refuses a missing unit) and `create-batch-water-quality.source.spec.ts`.
- LOW — `tankId`/`siteId` consistency checks treat GraphQL `null` as absent (`!= null`).
- LOW — AquaMobil's realtime and offline-sync maps invalidated the retired
  `equipment-params` key; they and the record page share `UNIT_MEASUREMENT_PLAN_QUERY_KEY`.

Proof:

- `measurement-unit.spec.ts`: tank vs equipment classification, columns, site.
- `measurement-plan.spec.ts`: the four plan rules, order, and the inner-joined
  plan query (active config of the tenant only).
- `water-quality-validation.service.spec.ts`: an outside-plan parameter is
  accepted, an unmapped unit accepts values, the plan's required ones are still
  required.
- `water-quality.service.spec.ts`: the three writers file the unit by kind, the
  site check uses the unit's site, mismatched `tankId`/`siteId` are refused, a
  tank row's update validates against its tank.
- `create-batch-water-quality.source.spec.ts`: machine sources refused in a batch.
- `water-quality-unit-readers.spec.ts`: each reader's unit predicate is the shared one.
- `measurement-unit-readers.invariant.spec.ts`: no farm reader keys on `tankId` alone.
- farm-module `RecordTab.spec.tsx`: recent entries filter by `unitId`.
- AquaMobil `WaterQualityRecordPage.spec.tsx`: the page reads the plan.
