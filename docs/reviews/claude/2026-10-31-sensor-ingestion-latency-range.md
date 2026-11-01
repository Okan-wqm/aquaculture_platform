# Ingestion latency outside the integer column — 2026-10-31

Found on 2026-10-31 while running the sensor-service suite for the repository simulator's move
(ADR-047): `sensor-ingestion-paths.rls.postgres.spec.ts` turned red on `main` that morning, with
no change to the code it tests.

## SENSOR-HIGH-208

Defect. The metric writer stores `Date.now() - sourceTimestamp` in `ingestion_latency_ms`, a
PostgreSQL `integer` served as a GraphQL `Int`. A reading sampled more than 2^31 ms
(about 24.8 days) before it is written overflows the column, and the INSERT fails: the reading
and every other row of the same batch are lost.

Severity HIGH. Owner Okan-wqm, deadline 2026-11-14.

Where.

- `apps/sensor-service/src/ingestion/sensor-metric-writer.service.ts` `marshalParams`: the
  delay is computed without a bound.
- `ingestion_latency_ms` is `integer` (migrations 1800000000000, 1815000000000) and
  `@Field(() => Int)` on `SensorMetric`.

Failure. The Postgres spec's fixed `2026-10-06T10:0xZ` sample times crossed 2^31 ms on
2026-10-31 around 06:30Z: `value "2160979393" is out of range for type integer`. Since then
`sensor-service:test` is red for every pull request that touches sensor-service. In
production, a backfill (GraphQL `ingestBatch` of older readings, or an edge queue flushed
after a long outage) fails whole.

Fix. One function decides the value: the delay when it fits the 32-bit column, else null. A
reading written that long after it was sampled is a backfill, not a delivery delay. Widening
the column would not help, because the GraphQL `Int` that serves it is 32-bit too.
