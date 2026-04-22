# ADR-026: Sensor Payload `raw_value` Contract + V2 Schema Versioning

**Status:** Proposed
**Date:** 2026-04-22
**Deciders:** platform team, sensor-service owner, edge-agent team
**Related:** ADR-006 (event flat pattern), ADR-011 (schema ownership), Rust migration plan `snappy-sniffing-pine.md` Kör Nokta 5

## Context

During the Rust sensor-ingestion sidecar audit, `SensorReading` payload drift was found: `apps/sensor-ingestion/src/payload.rs:76-89` declares a `SensorReading` struct with only `value: f64`, and `persistence.rs:343-344` copies `let raw_value = r.value;` into the TimescaleDB `raw_value` column. The NestJS contract historically separates the two: `value` is the post-conversion normalized reading (e.g. pH 7.4), `raw_value` is the pre-conversion sensor output (e.g. ADC count 4182 before Atlas EZO linearization).

The Rust sidecar silently collapses the distinction, and the event contract `libs/event-contracts/src/sensor-events.ts` does not declare `raw_value` at all. Two problems:

1. **Semantic loss:** every reading written by the Rust sidecar has `raw_value == value` — downstream analytics (calibration drift detection, sensor health) cannot reconstruct the pre-conversion signal.
2. **Schema drift risk:** without an explicit contract, future NestJS changes could reintroduce `raw_value ≠ value` and break the Rust path silently.

The fix must be an explicit contract, enforced at both emitters (edge agent, NestJS listener) and both consumers (NestJS sensor-service, Rust sidecar). Plan Kör Nokta 5 further requires versioned schemas (V1 without `raw_value`, V2 with `raw_value` mandatory) + upcaster + downcaster so the migration can roll forward and back without event loss.

## Decision

`SensorReading` payload has two schema versions, `V1` (legacy, no `raw_value`) and `V2` (mandatory `raw_value`). `payloadVersion: 1 | 2` is a required discriminator on every event.

1. **Ajv schemas** `libs/event-contracts/src/schemas/sensor-events.schema.ts`:
   - `SensorPayloadV1Schema` — no `raw_value`, `payloadVersion = 1`, `additionalProperties: false`.
   - `SensorPayloadV2Schema` — `raw_value: number` REQUIRED, `payloadVersion = 2`, `additionalProperties: false`.
2. **Upcaster** `libs/event-contracts/src/upcasters/sensor-payload-v1-to-v2.ts` — when a V1 event arrives, `raw_value = value` mapping produces a V2 struct **tagged** with `source: UpcastedFromV1`. The upcaster is a read-only translator at consumer boundaries; it does NOT re-emit.
3. **Downcaster** `libs/event-contracts/src/downcasters/sensor-payload-v2-to-v1.ts` — mirror direction, drops `raw_value`, sets `payloadVersion = 1`. Used only during deploy windows where V1-only consumers still exist.
4. **Rust side** `crates/event-contracts-rs/src/sensor.rs`:
   ```rust
   pub enum PayloadSource { OriginalV2, UpcastedFromV1 }
   pub struct SensorReading {
     pub value: f64,
     pub raw_value: f64,
     pub source: PayloadSource,
   }
   ```
   Persistence-layer audit log when `source == UpcastedFromV1 && raw_value == value`.
5. **Feature flag** `INGEST_PAYLOAD_VERSION_MIN` — dynamic config (NATS event `IngestPayloadVersionChangedEvent` for propagation; cf. ADR-029 for the request-reply snapshot primitive). Gate phases:

    | Phase | Edge Emitters | Consumers | `INGEST_PAYLOAD_VERSION_MIN` |
    |---|---|---|---|
    | 0 | V1 | V1 + V2 (upcaster active) | 1 |
    | 1 | V1 + V2 mixed | V1 + V2 | 1 |
    | 2 | V2 | V1 (downcaster) + V2 | 1 |
    | 3 | V2 | V2 only | 2 |

6. **Mixed-batch invariant** (sidecar): `PostgresSink::write_tenant_batch` accepts a batch with mixed `source` values — every row is materialized into the V2 struct before COPY, audit-logging upcasted rows for observability.

## Consequences

**Positive:**
- The Rust sidecar and the NestJS listener speak the same versioned contract; drift surfaces at Ajv validation rather than silently.
- Edge agents migrate on their own cadence (phase 0 → 1 → 2 → 3) without breaking cloud consumers.
- Forward + reverse translation gives clean rollback discipline — no event loss if a V2-only rollout must be reverted.

**Negative:**
- Doubled schema + upcaster/downcaster code; some duplication between TS and Rust codegen-generated structs.
- `INGEST_PAYLOAD_VERSION_MIN=2` cut-over is gated by **every** edge agent reporting V2 — fleet observability for emitter version is a prerequisite (emit `edge_agent_payload_version` metric).
- Audit-log `UpcastedFromV1` rows fill the log pipeline during Phase 0-2; must budget log volume.

**Neutral:**
- TS-side `SensorReadingEvent` already uses flat fields (`readingTemperature`, etc.) per ADR-006; adding `payloadVersion` and `raw_value` is additive.

## Alternatives Considered

1. **Single-version, `raw_value` optional with fallback to `value`**  — rejected. Silent `unwrap_or(r.value)` semantic loss is exactly the "patch" this ADR prevents (CLAUDE.md banned-phrase list).
2. **Version discriminator at NATS subject level** (`events.<tenant>.SensorReading.v2`) — rejected. Subject proliferation complicates subscription patterns and breaks the flat `events.<tenant>.<eventType>` convention established by `nats-event-bus.ts:297-312`.
3. **Forward-only (no downcaster)** — rejected by enterprise-grade / no-deferral discipline (`feedback_no_patches_no_deferrals.md`). Rollback safety is mandatory.

## Verification

- `nx test event-contracts --testPathPattern=sensor-payload-upcaster`
- `nx test event-contracts --testPathPattern=sensor-payload-downcaster`
- `cargo test -p sensor-ingestion --test mixed_version_batch_handling`
- Phase-progression runbook `docs/runbooks/sensor-payload-v2-migration.md` walks operators through each phase cut-over.
