# Farm — sensor water temperature via a farm-side event projection (Phase 2b) — 2026-07-04

Completes the operator's "sensor AND manual" water-temperature requirement.
Phase 2a (`2026-07-04-water-temperature-feed-rate.md`, FARM-HIGH-131) deleted the
prod-broken cross-schema `sensor_readings` query and wired the manual source.
Phase 2b adds the sensor source the healthy way — no synchronous cross-service
call, no cross-schema grant.

## FARM-MEDIUM-136 — sensor water temperature never reached the feed calc; add it via a farm-side projection of the SensorReading event stream — RESOLVED (Phase 2b)

**Architecture.** farm-service owns a small local read model fed by the event the
sensor subgraph already publishes:
- **`SensorTemperatureProjectionListener`** subscribes to `events.*.SensorReading`
  (the same `subscribeWildcard` + `runInTenantTransaction` + idempotent-rethrow
  pattern as `FarmStockProjectionListener`) and upserts the tenant's latest
  temperature per sensor into **`sensor_temperature_latest`** (newest-wins guard in
  the `ON CONFLICT` clause, so redelivery / out-of-order events cannot regress it).
- **`Tank.temperatureSensorId`** + **`Equipment.temperatureSensorId`** (both
  nullable soft references to sensor-service `sensors.id`, both migrations): the
  link an operator sets when creating a tank/pond/cage. Tanks live in the `tanks`
  table (the equipment list maps them into Equipment on read), so the link is on
  the Tank entity and flows through the whole create/update path
  (CreateEquipmentInput → adapter `toCreateTankInput`/`toUpdateTankInput` →
  CreateTank/UpdateTank handlers → Tank; and back via `toEquipmentResponse`).
- **`WaterTemperatureService`** now resolves the linked sensor from EITHER the
  `tanks` or the `equipment` table (a UNION subquery — the container id may belong
  to either) → the latest `sensor_temperature_latest` row, and returns whichever
  of {sensor reading, manual measurement} is MORE RECENT. Every feed-rate path
  (tanks-page DataLoader, selectFeedForBatch, daily-feeding cron) inherits this.
- **Frontend:** a farm-module `useSensors` hook (`useTenantQuery` over the
  federated `sensors` query) + an optional "Temperature Sensor" picker on the
  tank/equipment create+edit form, gated to tank-like categories. The `sensors`
  cross-subgraph field is allowlisted in the FE↔BE parity invariant.

**Why not a synchronous call to sensor-service?** The event projection keeps the
feeding hot path free of a cross-service dependency (sensor-service downtime never
blocks farm reads), is prod-safe (no grant on the `sensor` schema needed), and is
idiomatic (farm-service already runs event-driven read-model projections). The
existing `latestReading` GraphQL query was the sync alternative; the projection is
the healthier default.

## Verification
water-temperature.service 6, sensor-temperature-projection.listener 5, tank +
equipment + water-quality suites (33 in the affected run); farm-module 106; tsc +
eslint clean; `invariants:fast` 142 suites / 1752 tests green (3 new migrations
registered; FE↔BE parity + schema-drift + useTenantQuery ratchet all pass).
