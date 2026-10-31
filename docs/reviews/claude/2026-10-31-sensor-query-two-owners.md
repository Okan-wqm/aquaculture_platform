# One root field, two resolvers: `sensor(id)` — 2026-10-31

Found on 2026-10-31 when the supergraph contract gate (`compose`) failed on PR #2191: the
device page's `GetSensor` operation asked for `activatedByData`, and the composed schema
answered `Cannot query field "activatedByData" on type "Sensor"`.

## SENSOR-MEDIUM-209

Defect. Two sensor-service resolver methods declared the root field `Query.sensor`:
`SensorResolver.getSensor` (the raw `Sensor` entity) and `RegistrationResolver.getSensor` (the
registration read model `RegisteredSensorType`, which masks protocol secrets and carries the
ADR-047 `activatedByData` and `mqttUsername`). NestJS code-first keeps one declaration's type
and arguments in the schema, while the runtime resolver map can call the other, so one name
answered with two shapes, and load order decided which. The schema served `Sensor`; the web
operations, the sensor-module contract fixture and the read model all assumed
`RegisteredSensorType`.

Severity MEDIUM. Owner Okan-wqm, deadline 2026-11-14.

Where.

- `apps/sensor-service/src/sensor/resolvers/sensor.resolver.ts` `getSensor`
  (`@Query(() => Sensor, { name: 'sensor' })`).
- `apps/sensor-service/src/registration/resolvers/registration.resolver.ts` `getSensor`
  (`@Query(() => RegisteredSensorType, { name: 'sensor' })`).
- `web/modules/sensor-module/src/__fixtures__/sensor-subgraph.excerpt.graphql` declares
  `sensor(id: ID!): RegisteredSensorType`; the emitted subgraph SDL said `Sensor`.

Failure. Any field only the read model has fails validation (the device page's
`activatedByData`), and a field only the entity has (`status`, `isActive`) would be asked of an
object that does not carry it. Farm had the same defect in `availableTanks` on 2026-06-24.

Fix. `sensor(id)` is the registration read model alone: the raw-entity copy is deleted, and
every web operation on it selects read-model fields only (the contract gate passes with zero
drift). `tools/scripts/emit-subgraph-sdl.ts` now refuses to emit a subgraph in which two
resolver methods declare one Query, Mutation or Subscription field, reading the metadata the
schema is built from, so the check covers every subgraph whose resolvers a pull request changes.
This replaces the farm-only static scan `farm-graphql-resolver-field-uniqueness.spec.ts`.
