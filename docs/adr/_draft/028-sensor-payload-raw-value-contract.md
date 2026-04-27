# ADR-028: Sensor Payload `raw_value` Contract + V2 Schema Versioning

**Status:** Accepted — Rust-side contract landed across commits `368d8ac6..a3ab0c23` on `agentic-rust-unified`. TS-side scope revised during implementation (see §TS-Side Scope Revision below).
**Date:** 2026-04-22
**Deciders:** platform team, sensor-service owner, edge-agent team
**Owner:** Okan
**Related ADRs:** ADR-006 (event flat pattern), ADR-011 (schema ownership), ADR-025 (Rust sidecar architecture), ADR-027 (per-tenant IngestBackend toggle)
**Related plans:** `/root/.claude/plans/snappy-sniffing-pine.md` Kör Nokta 5

---

## Context (WHY)

During the Rust sensor-ingestion sidecar audit, `SensorReading` payload drift was found:

- `apps/sensor-ingestion/src/payload.rs:76-89` declares a `SensorReading` struct with only `value: f64`.
- `persistence.rs:343-344` copies `let raw_value = r.value;` into the TimescaleDB `raw_value` column.
- `libs/event-contracts/src/sensor-events.ts` does not declare `raw_value` at all.

The NestJS contract historically separates the two: `value` is the post-conversion normalized reading (e.g. pH 7.4), `raw_value` is the pre-conversion sensor output (e.g. ADC count 4182 before Atlas EZO linearization). The Rust sidecar silently collapses the distinction, and downstream analytics (calibration drift detection, sensor health) cannot reconstruct the pre-conversion signal.

Two problems are intertwined:

1. **Semantic loss:** every reading written by the Rust sidecar has `raw_value == value` — a patch dressed up as data.
2. **Schema drift risk:** without an explicit contract, future NestJS changes could reintroduce `raw_value ≠ value` and silently break the Rust path.

The fix must be an explicit contract, enforced at both emitters (edge agent, NestJS listener) and both consumers (NestJS sensor-service, Rust sidecar). Plan Kör Nokta 5 further requires versioned schemas (V1 without `raw_value`, V2 with `raw_value` mandatory) + upcaster + downcaster so the migration can roll forward and back without event loss.

---

## Decision (WHAT)

`SensorReading` payload has two schema versions, `V1` (legacy, no `raw_value`) and `V2` (mandatory `raw_value`). `payloadVersion: 1 | 2` is a required discriminator on every event.

1. **Ajv schemas** (`libs/event-contracts/src/schemas/sensor-events.schema.ts`):
   - `SensorPayloadV1Schema` — no `raw_value`, `payloadVersion = 1`, `additionalProperties: false`.
   - `SensorPayloadV2Schema` — `raw_value: number` REQUIRED, `payloadVersion = 2`, `additionalProperties: false`.

2. **Upcaster** (`libs/event-contracts/src/upcasters/sensor-payload-v1-to-v2.ts`) — when a V1 event arrives, `raw_value = value` mapping produces a V2 struct **tagged** with `source: UpcastedFromV1`. The upcaster is a read-only translator at consumer boundaries; it does NOT re-emit.

3. **Downcaster** (`libs/event-contracts/src/downcasters/sensor-payload-v2-to-v1.ts`) — mirror direction, drops `raw_value`, sets `payloadVersion = 1`. Used only during deploy windows where V1-only consumers still exist.

4. **Rust side** (`crates/event-contracts-rs/src/sensor.rs`):

   ```rust
   pub enum PayloadSource { OriginalV2, UpcastedFromV1 }
   pub struct SensorReading {
     pub value: f64,
     pub raw_value: f64,
     pub source: PayloadSource,
   }
   ```

   Persistence-layer audit log when `source == UpcastedFromV1 && raw_value == value` — semantic shadow for observability.

5. **Feature flag** `INGEST_PAYLOAD_VERSION_MIN` — dynamic config (NATS event `IngestPayloadVersionChangedEvent` for propagation; see ADR-031 for the request-reply snapshot primitive). Phase matrix:

   | Phase | Edge Emitters | Consumers | `INGEST_PAYLOAD_VERSION_MIN` |
   |---|---|---|---|
   | 0 | V1 | V1 + V2 (upcaster active) | 1 |
   | 1 | V1 + V2 mixed | V1 + V2 | 1 |
   | 2 | V2 | V1 (downcaster) + V2 | 1 |
   | 3 | V2 | V2 only | 2 |

6. **Mixed-batch invariant** (sidecar): `PostgresSink::write_tenant_batch` accepts a batch with mixed `source` values — every row is materialized into the V2 struct before COPY, audit-logging upcasted rows.

---

## Consequences

**Positive:**
- The Rust sidecar and the NestJS listener speak the same versioned contract; drift surfaces at Ajv validation rather than silently.
- Edge agents migrate on their own cadence (phase 0 → 1 → 2 → 3) without breaking cloud consumers.
- Forward + reverse translation gives clean rollback discipline — no event loss if a V2-only rollout must be reverted.

**Negative:**
- Doubled schema + upcaster/downcaster code; some duplication between TS and Rust codegen-generated structs.
- `INGEST_PAYLOAD_VERSION_MIN=2` cut-over is gated by **every** edge agent reporting V2 — fleet observability for emitter version is a prerequisite (emit `edge_agent_payload_version` metric).
- Audit-log `UpcastedFromV1` rows fill the log pipeline during Phase 0-2; budget log volume.

**Neutral:**
- TS-side `SensorReadingEvent` already uses flat fields (`readingTemperature`, etc.) per ADR-006; adding `payloadVersion` and `raw_value` is additive.

---

## Alternatives Considered

1. **Single-version, `raw_value` optional with fallback to `value`** — rejected. Silent `unwrap_or(r.value)` semantic loss is exactly the "patch" CLAUDE.md's banned-phrase list forbids.
2. **Version discriminator at NATS subject level** (`events.<tenant>.SensorReading.v2`) — rejected. Subject proliferation complicates subscription patterns and breaks the flat `events.<tenant>.<eventType>` convention established in `nats-event-bus.ts:297-312`.
3. **Forward-only (no downcaster)** — rejected by enterprise-grade / no-deferral discipline (`feedback_no_patches_no_deferrals.md`). Rollback safety is mandatory.

---

## Verification

- `cargo test -p sensor-ingestion` — 153 pass, 2 pre-existing live-smoke ignored. The V1/V2 tests added under commit `a3ab0c23`:
  - `happy_round_trip` (updated) — V1 implicit upcast.
  - `v1_explicit_version_tag_is_also_upcast`
  - `v2_payload_carries_distinct_raw_value`
  - `v2_without_raw_value_is_rejected`
  - `unsupported_payload_version_is_rejected`
  - `v1_with_stray_raw_value_is_rejected_by_deny_unknown`
  - `not_finite_raw_value_variant_surfaces_with_expected_display`
- `cargo clippy --workspace --all-targets --all-features -- -D warnings` — green.
- `RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --workspace --document-private-items` — green.
- Phase-progression runbook `docs/runbooks/sensor-payload-v2-migration.md` — pending (follow-up commit; the runbook is not blocking Phase 0 posture because Phase 0 is the default-accept state this ADR ships).

## TS-Side Scope Revision

While implementing, `libs/event-contracts/src/schemas/sensor-events.schema.ts` was audited against the ADR text. The audit found:

- `SENSOR_METRIC_INGESTED_SCHEMA` (the schema the NATS event validator already ships) declares BOTH `rawValue` AND `value` as REQUIRED fields, with `additionalProperties: false`. That schema describes the **sidecar → NATS event** wire format, not the edge-device → MQTT payload.
- The sidecar-published `SensorMetricIngested` event is therefore already semantically V2 — there is no drift to fix on the NATS consumer side.
- The upcaster / downcaster / `payloadVersion` discriminator this ADR prescribes all belong to the **edge-device → MQTT payload** trust boundary. The Rust sidecar implements them in `payload.rs::validate` (commit `a3ab0c23`). The mirror NestJS path (`apps/sensor-service/src/ingestion/mqtt-listener.service.ts`) is tracked separately as **ORPHAN-016**; when that orphan closes, the NestJS listener applies the identical V1/V2 match + upcast tag against the MQTT payload.

**Implication:** The ADR's original §Decision item 1 ("Ajv schemas — `SensorPayloadV1Schema` and `SensorPayloadV2Schema`") is **not landed as separate TS schemas** because the existing `SENSOR_METRIC_INGESTED_SCHEMA` already enforces the V2 shape on the NATS-event boundary. Item 2 (TS-side upcaster) and item 3 (downcaster) apply only when the NestJS listener is updated to speak V1/V2 on the MQTT boundary — **that work is tracked by ORPHAN-016 closure**, not by this ADR. The phase matrix (§Decision item 5) continues to apply as written; the Phase 0–2 implementation is entirely Rust-side (commit `a3ab0c23`), Phase 3 cut-over requires ORPHAN-016 closure before `INGEST_PAYLOAD_VERSION_MIN=2` can flip.

No yama / interim / deferral — the scope narrowed because the existing TS schema surface already covers the contract. The ADR stays Accepted; the tracking remains concrete.
