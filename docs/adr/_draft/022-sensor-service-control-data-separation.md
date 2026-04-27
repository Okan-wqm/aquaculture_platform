# ADR-022: Sensor-Service Control / Data Plane Separation

**Status:** Proposed (Faz 3 stage 1 — 2026-04-21)
**Date:** 2026-04-21
**Deciders:** Okan (platform owner) + sensor-service maintainers + sens-api-gateway maintainer
**Owner:** Okan
**Related ADRs:** ADR-011 (schema-per-tenant), ADR-014/015 (NATS cert-only auth), ADR-025 (Rust sidecar architecture), ADR-027 (per-tenant `IngestBackend` toggle)
**Related plans:** `docs/plans/sensor-rust-migration/PLAN.md` § Faz 3

---

## Context (WHY)

ADR-025 established the Rust ingestion sidecar (`apps/sensor-ingestion`) as the data-plane producer for sensor metrics. Faz 2 shipped the sidecar end-to-end: MQTT subscribe → topic parse → payload validate → batch COPY → NATS publish.

Faz 3 now reduces NestJS `sensor-service` to its **control-plane** responsibilities:

- Sensor / channel / device CRUD (GraphQL).
- Calibration coefficients, alert thresholds, retention policy.
- Continuous-aggregate management (1h / 1d / 7d).
- Sensor metadata cache + cache-miss responder for the sidecar's `sensor.lookup.*` request-reply.
- NATS consumer for the Rust sidecar's `SensorMetricIngested` event → enrich + persist → re-emit typed `SensorReadingEvent` for downstream consumers (alert-engine, AI, audit).

**The architectural problem the split solves:** the existing NestJS path bundles the data-plane hot loop (MQTT subscribe + per-message JSON parse + INSERT VALUES batching) with the control-plane CRUD. Both compete for the 512 MB / 0.5 vCPU container budget, GC-pause amplifies every request, and `as any` clusters in the ingestion path leak typing into the control-plane modules. The split makes each plane a first-class citizen with its own runtime, its own scaling envelope, and its own deploy artefact.

---

## Decision (WHAT)

### 1. Distinct event types at the data ↔ control-plane boundary

`SensorMetricIngested` (NEW) and `SensorReading` (EXISTING) become two distinct event types:

| Event | Producer | Shape | Subject |
|---|---|---|---|
| `SensorMetricIngested` | Rust sidecar | Raw per-channel tuple — `{ tenantId, sensorId, channelId, rawValue, value, qualityCode, producerTs }` | `events.{tenantId}.SensorMetricIngested` |
| `SensorReading` | NestJS sensor-service (NATS consumer enrich path) | Typed water-quality — `{ tenantId, sensorId, readingTemperature?, readingPh?, readingDissolvedOxygen?, ... }` | `events.{tenantId}.SensorReading` (existing) |

**WHY two events instead of one:** the sidecar does not have the sensor-meta cache that maps `channelId → readingXxx`. Forcing the sidecar to publish typed events would couple the ingestion hot path to a control-plane lookup. The split keeps each producer honest about what it owns.

### 2. NestJS NATS consumer service

`apps/sensor-service/src/ingestion/nats-ingestion-consumer.service.ts` (NEW):

1. Subscribe via `@platform/event-bus` to `SensorMetricIngested` events.
2. For each event:
   - Look up sensor metadata in the in-process cache (already exists for the existing MQTT path — reused, no rewrite).
   - Map `channelId → readingXxx` field via the sensor's channel definition.
   - Construct a `SensorMetricInput` from `(time, sensorId, channelId, tenantId, rawValue, value, qualityCode, ...)` plus enriched site/department/equipment/etc.
   - Call `BatchProcessorService.enqueue(metricInput)` — the existing batch path. **NOT rewritten**, just fed from a new source.
   - Construct a typed `SensorReadingEvent` populated from cache + enriched fields, publish via `eventBus.publish` for downstream consumers (alert-engine).

The consumer is the ONLY component that gets to map raw → typed. One owner, one mapping, no drift.

### 3. Module-loader profile: `SENSOR_SERVICE_PROFILE=control-plane`

Env-gated profile that the `app.module.ts` bootstrap reads. Profile values:

| Profile | MQTT listener | Batch processor | Hypertable / continuous-aggregate | NATS consumer | GraphQL CRUD |
|---|---|---|---|---|---|
| `legacy` (default) | enabled | enabled | enabled | disabled | enabled |
| `control-plane` | **disabled** | enabled (fed by NATS consumer) | enabled | **enabled** | enabled |

`control-plane` profile drops the MQTT subscriber + Piscina worker pool + STREAM_PROCESSING worker, freeing the budget the Rust sidecar now uses (192 MB / 0.2 vCPU per the plan). The protocol-adapter classes (`apps/sensor-service/src/protocol/adapters/**`) STAY (their `parse()` method gets `@deprecated` JSDoc, but `validate()` / `schema` / `ProtocolCapabilities` / UI metadata are still consumed by the GraphQL path).

### 4. Strangler-fig coexistence

The two profiles ship in the same binary. Operator picks the profile per env; staging runs `legacy` until the Rust sidecar is healthy, then flips to `control-plane`. Per-tenant `IngestBackend` toggle (ADR-027) gates which tenants the sidecar processes during the rollout window. End state: every tenant on `control-plane`, the legacy MQTT path is deleted in Faz 4.

### Rejected alternatives

| Alternative | Reason rejected |
|---|---|
| **Replace NestJS sensor-service entirely with Rust** | Loses the GraphQL surface, schema migrations, calibration UI, alert-rule editor — re-implementing those in Rust would consume the entire Faz 3-4 budget for zero ingestion gain. |
| **Keep NestJS as the only ingestion path; sidecar drops events** | Wastes the sidecar's persistence work; doubles the COPY load via dual-write; defeats the whole point of Faz 2. |
| **One unified event type carrying both raw + typed fields** | The sidecar would need to emit empty typed fields (it has no cache), polluting the wire shape with always-`null` channels. Consumer-side disambiguation gets ugly fast. |
| **Sensor-service queries the sidecar (reverse direction)** | Inverts the control / data flow; control-plane queries imply the data plane is the SSoT for sensor metadata, which it isn't. |

---

## Consequences

**Positive:**
- Bütçe normalises: Rust sidecar 192 MB / 0.25 vCPU + NestJS 192 MB / 0.2 vCPU = 384 MB / 0.45 vCPU total, well under the 512 / 0.5 ceiling. 128 MB / 0.05 vCPU headroom.
- Mapping concern lives once, in the service that owns the metadata.
- Existing typed `SensorReadingEvent` contract preserved — alert-engine / AI / audit see no change.
- `BatchProcessorService` invariant (500ms / 500-row) preserved (plan invariant 4).
- Continuous-aggregate management invariant preserved (plan invariant 5).
- Alert-engine / AI / audit subscriptions unchanged.

**Negative:**
- Two binaries to operate (Rust sidecar + NestJS control plane) instead of one.
- Two event types where the existing path had one — schema registry has more to track.
- NATS consumer adds one round-trip per metric vs the existing in-process path.

**Neutral:**
- The `parse()` deprecation does not delete adapter code; Faz 4 deletes it. Until then a misconfigured tenant on `legacy` profile still works.
- Per-tenant `IngestBackend` toggle (ADR-027) makes the migration reversible at the tenant level.

---

## Migration Plan (Faz 3 stages)

| Stage | Deliverable | Owner |
|---|---|---|
| 1 | `SensorMetricIngested` event in TS + Rust event-contracts; Rust sidecar publishes it; drain → events_in_tx wired (closes Stage 12 NOT-DONE). | this commit |
| 2 | `nats-ingestion-consumer.service.ts` in NestJS sensor-service; subscribes to `SensorMetricIngested`, enriches, calls `BatchProcessor.enqueue`, re-emits `SensorReadingEvent`. | follow-on |
| 3 | `SENSOR_SERVICE_PROFILE` env-gated module loader; `legacy` (default) vs `control-plane`. Adapter `parse()` `@deprecated` JSDoc. | follow-on |
| 4 | E2E dual-write equivalence test (`e2e/tests/sensor-ingest-equivalence.e2e.ts`) green for 24h soak; deploy compose updates the sensor-service container budget. | follow-on |

---

## References

- ADR-025 — Rust sidecar architecture
- ADR-027 — Per-tenant `IngestBackend` toggle for the Rust sidecar rollout
- `apps/sensor-ingestion/src/events.rs` — Rust publisher
- `crates/event-contracts-rs/src/lib.rs` — `SensorMetricIngestedEvent` definition
- `libs/event-contracts/src/sensor-events.ts` — TS twin definition
- `apps/sensor-service/src/ingestion/batch-processor.service.ts` — preserved (invariant 4)
- `apps/sensor-service/src/timescale/continuous-aggregate.service.ts` — preserved (invariant 5)
