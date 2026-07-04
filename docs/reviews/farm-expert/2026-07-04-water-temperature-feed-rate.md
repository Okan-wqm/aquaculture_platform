# Farm — manual water temperature drives the feed rate (Phase 2a) — 2026-07-04

Phase 2 of the protocol-feeding initiative (see `2026-07-04-protocol-batch-feeding-ssot.md`).
The feeding rate's temperature multiplier needs the tank's current water
temperature. Operator wants BOTH manual entry and sensor; Phase 2a delivers the
manual half end-to-end (self-contained in farm-service); Phase 2b adds the sensor
source via a farm-side projection of the sensor-service reading stream.

## FARM-HIGH-131 — feed calc always used the 15°C default; temperature never reached it — RESOLVED (Phase 2a)

**Root cause.** `DailyFeedingExecutionService.getWaterTemperature` raw-queried
`sensor_readings`/`sensors` with columns that do not exist (`sr.value`,
`sr.metric_type` — temperature actually lives in the `readings` JSONB, and
`value`/`channel_id` live on the separate `sensor_metrics` table), UNqualified
across schemas (farm-service runs under the `farm`/tenant search_path, the tables
are in the `sensor` schema), and — decisively — `farm_service` has **no grant on
the `sensor` schema** in production. Every path threw and fell back to
`DEFAULT_TEMP = 15.0`. Manual temperatures recorded in Water Chemistry were never
read by the feed calc at all. So every protocol-driven rate ran at a fixed 15°C
multiplier regardless of the real water temperature.

**Fix (Phase 2a).**
- New `WaterTemperatureService` (farm-service, schema-qualified reads): returns
  the latest manual `WaterQualityMeasurement.temperature` for a tank, or null.
  Cross-module-injectable, no request-context dependency (safe for the cron).
- Wired into every path that computes the tanks-page batch feed columns: the bulk
  `feed-selection.dataloader` and `FeedSelectorService.selectFeedForBatch` (via
  `EquipmentResolver` resolving the tank temperature and threading it through), so
  the protocol's temperature multiplier now applies. `DailyFeedingExecution`'s
  `getWaterTemperature` now delegates to the service — **the broken cross-schema
  raw query is deleted**.
- New `recordWaterTemperature(tankId, celsius)` mutation +
  `WaterQualityService.recordManualTemperature`: a dedicated single-observation
  path that records a MANUAL temperature WITHOUT the full multi-parameter strict
  validation (which rejects unless `temperature` is mapped to the equipment and
  every other required-mapped parameter is supplied). Bounds-checked (-5..45°C),
  gated to tenant-wide roles (TENANT_ADMIN/MODULE_MANAGER, which bypass per-site
  authz). The reading still lands in `water_quality_measurements` (source MANUAL).
- Frontend: a discoverable **Record Water Temperature** quick entry per tank on
  the Tanks page (shared `Modal`), calling the dedicated mutation, then refetching
  so the feed columns recompute.

**Scope boundary (Phase 2b, tracked — the operator wants sensor too).** The sensor
source is intentionally NOT the broken cross-schema query. The healthiest path is
a farm-side projection of the sensor-service `SensorReading` NATS event (which
carries `readingTemperature`) into a local read model, plus a tank↔sensor link on
the Equipment (tank) at creation; `WaterTemperatureService` then prefers the
sensor reading over the manual one. `daily-feeding-execution.getWaterTemperature`
keeps a `_sensorId` param reserved for that wiring.

## Verification
`water-temperature.service.spec` 4 green; `water-quality.service.spec`
recordManualTemperature 2 green; daily-feeding suites 16 green;
equipment/feed/water-quality 77 green; farm-module 106 green; tsc + eslint clean;
`invariants:fast` 142 suites / 1752 tests green.
