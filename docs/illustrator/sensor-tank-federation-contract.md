# Sensor ↔ Tank Federation Contract Specification

> **Status:** OPEN — design specification only; implementation lives in
> sensor-service and is owned by the sensor-team. This document is the
> architectural contract that lets that team start without a back-and-forth
> on shape, semantics, or tenant-isolation expectations.
>
> **Closes (when implemented):** FARM-MEDIUM-006
>
> **Related:** PR #210 (FARM-MEDIUM-004 — `WaterQualityMeasurement.relatedSensorReadingId`),
> PR #213 (FARM-MEDIUM-005 — partial UNIQUE + lookup indexes),
> PR #217 (FARM-MEDIUM-007 — architectural rejection of generic auto-correlation handler)

## Why this contract exists

Phase 7.4 of the farm-module plan calls for a federated GraphQL surface
that lets a single client query `tank(id) { id, code, sensorReadings { ... } }`
and have the gateway round-trip the `sensorReadings` sub-selection to
sensor-service. Without it, every UI that wants to render a tank's recent
sensor data has to make two GraphQL calls (one to farm-service for the
tank, one to sensor-service for the readings) and join on `tankId`
client-side — an N+1 pattern that pushes correlation logic to every
consumer.

The farm-service side is already federation-ready:
`apps/farm-service/src/tank/entities/tank.entity.ts:192` carries
`@Directive('@key(fields: "id")')` so the gateway recognises Tank as a
federated entity and will accept extensions from other services.

This spec defines the contract sensor-service should implement to
extend Tank with the `sensorReadings` field-resolver.

## Scope boundary

| In scope (sensor-service implements) | Outside the sensor-side surface (farm-service owns; do NOT touch) |
|---|---|
| `extend type Tank @key(fields: "id") { sensorReadings: [SensorReading!]!, latestSensorReading(parameter: SensorReadingParameter!): SensorReading }` resolver | The `Tank` GraphQL type itself, `Tank.id` resolution, any farm-domain field on Tank |
| Tenant-scoped query against `sensor_readings` table | The `WaterQualityMeasurement.relatedSensorReadingId` correlation field (already shipped by PR #210) |
| Reading-level retention and aggregation | The Tank-level domain semantics (capacity, density, batch allocation) |
| Pagination semantics for `sensorReadings` | Federation gateway routing — that's already configured |

## Required field-resolver signatures

```graphql
extend type Tank @key(fields: "id") {
  """
  Returns recent sensor readings for this tank, scoped to the
  caller's tenant. Most recent first. Cursor-paginated.

  - `parameter`: optional filter to a single SensorReadingParameter
    (matches the contract enum from libs/event-contracts/src/sensor-events.ts).
  - `since`: optional lower-bound timestamp (inclusive). Default: 24h ago.
  - `first`: page size. Default: 50. Max: 500.
  - `cursor`: opaque pagination cursor from a previous response.
  """
  sensorReadings(
    parameter: SensorReadingParameter
    since: DateTime
    first: Int = 50
    cursor: String
  ): SensorReadingConnection!

  """
  Returns the single most-recent reading for the given parameter on
  this tank. Null when no reading exists in the configured retention
  window (typically 90 days; see sensor-service retention policy).
  """
  latestSensorReading(parameter: SensorReadingParameter!): SensorReading
}
```

`SensorReadingConnection` follows the existing cursor-pagination
primitive from `libs/backend-common/src/pagination/cursor.ts` —
sensor-service should reuse `buildCursorResponse` rather than
inventing a new shape.

## Tenant isolation contract

Every sensor-service resolver field MUST scope its query by the
caller's `tenantId`. The gateway propagates the auth context into the
sensor-service request; the resolver:

1. Reads `tenantId` from the gateway-provided context (NOT from the
   `Tank` reference object — the reference contains only `{ id }`).
2. Filters `WHERE "tenantId" = :callerTenantId AND "tankId" = :tankId`.
3. Per-tenant schema cloning is honoured by the standard farm/sensor
   `TenantConnectionBootstrap` search_path mechanism — the resolver
   uses TypeORM repos against unqualified table names, not raw SQL
   with `${tenantSchemaName}` interpolation. (See
   `libs/backend-common/src/database/typeorm-config.factory.ts:68-80`
   for the canonical reasoning.)

The Tank `@key(fields: "id")` directive intentionally does NOT
include `tenantId` because the federation gateway expects entity keys
to be globally unique. Tank IDs are UUIDs and globally unique by
construction; tenant filtering happens at field-resolver time, not at
key-matching time.

## Performance expectations

Sensor-service operates against `sensor_readings` which is a
TimescaleDB hypertable with continuous aggregates at
`sensor.metrics_1min / 1hour / 1day`. The resolver SHOULD:

- For `since >= now() - 1h`: query the raw `sensor_readings`
  hypertable.
- For `since` between 1h and 24h: query `sensor.metrics_1min`.
- For `since` between 24h and 30d: query `sensor.metrics_1hour`.
- For `since > 30d`: query `sensor.metrics_1day`.

Without this tiering, a 30-day-window query against the raw
hypertable on a tenant with 100 sensors at 1 sample/min would scan
~4M rows. The aggregates are already populated; the resolver just
needs to choose its source based on `since`.

## What this means for the front-end

Once this contract lands, the farm-module front-end can replace the
two-query pattern in `web/modules/farm-module/src/pages/water-chemistry/`
with a single query:

```graphql
query TankWithReadings($tankId: ID!) {
  tank(id: $tankId) {
    id
    code
    name
    # ... existing farm fields
    sensorReadings(first: 50) {
      edges {
        node {
          id
          parameter
          value
          timestamp
        }
      }
    }
    latestSensorReading(parameter: TEMPERATURE) {
      value
      timestamp
    }
  }
}
```

The `relatedSensorReadingId` correlation field on
`WaterQualityMeasurement` (shipped by PR #210) lets a measurement
detail view render a "view source reading" link — federation lets that
link RESOLVE the source reading in a single round-trip rather than
forcing the UI to spawn a second request to sensor-service.

## Architectural decision: rejected alternatives

| Alternative | Why rejected |
|---|---|
| Eager-load all sensor readings on every Tank query | Default fan-out to readings would push 1000s of rows even when the caller doesn't need them. Per-field resolution lets pagination apply only when the field is selected. |
| Implement on farm-service side via cross-service query | Would require farm-service to know about sensor-service's schema, retention tiering, and TimescaleDB internals. Federation extension keeps the knowledge boundary clean — sensor-service owns `sensor_readings`; farm-service owns `Tank`. |
| Add a `WaterQualityMeasurement.sensorReading` resolver instead | Already covered: `relatedSensorReadingId` from PR #210 + the federated `Tank.sensorReadings` give the UI both directions of correlation. Adding a third resolver path would be redundant. |

## Acceptance criteria (sensor-team's PR)

- [ ] `extend type Tank @key(fields: "id")` declared in the sensor-service
      GraphQL schema.
- [ ] `sensorReadings(parameter, since, first, cursor)` field resolver returns
      `SensorReadingConnection` from the appropriate aggregate tier.
- [ ] `latestSensorReading(parameter)` field resolver returns `SensorReading | null`.
- [ ] Both resolvers filter by `tenantId` from the gateway context.
- [ ] Both resolvers reuse `libs/backend-common/src/pagination/cursor.ts`
      primitives (encode/decode, buildCursorResponse).
- [ ] Tests cover: empty result, single-page result, multi-page cursor traversal,
      tenant-isolation (caller tenant A cannot see tenant B's readings).
- [ ] Closing PR carries `Closes: FARM-MEDIUM-006` trailer per
      `tools/gates/commit-msg-validator.ts` rules.

## Why this document instead of code

Writing the resolver in farm-service would put it in the wrong service — it
needs to live where `sensor_readings` lives. Writing a stub in sensor-service
without the sensor-team's review of the contract would lock in design choices
they may have valid reasons to push back on (different pagination shape,
different retention tiering, different parameter enum).

The contract spec is the architecturally correct artifact at this stage:
it lets the sensor-team start with a precise, reviewable target and either
accept the spec verbatim or push back on specific parts before any code lands.

When the sensor-team's PR closes FARM-MEDIUM-006, this document either:
(a) gets archived as the historical contract that the implementation honoured, or
(b) gets edited inline to record the design changes the sensor-team made and
why, so future contributors see the negotiated result rather than this initial
proposal.
