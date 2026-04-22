# Runbook: Sensor-Reading Payload V1 → V2 Migration (Forward-Only)

**Owner:** platform team (Okan-Wqm + sensor-service + alert-engine maintainers)
**Related ADRs:** ADR-006 (event flat pattern), ADR-028 (sensor-payload raw_value contract + V2 versioning)
**Plan reference:** `/root/.claude/plans/snappy-sniffing-pine.md` Kör Nokta 5
**Related commits:** `a3ab0c23` (Rust V2 contract + upcast tag), upcaster `libs/event-contracts/src/upcasters/sensor-reading.upcaster.ts`
**Related orphan findings:** `ORPHAN-016` (TS `mqtt-listener.service.ts` still emits V1 nested) — this runbook operationalises ORPHAN-016's eventual fix.

## Purpose

Migrate the `SensorReading` event wire shape from V1 (nested `readings` object + `version: 1`) to V2 (flat `readingXxx` fields + `rawValue` + `payloadVersion: 2`). The migration is **forward-only**: consumers that only understand V1 are upgraded to the upcaster-aware event bus BEFORE any V2 publisher flips, so no downcaster is needed on the NATS wire.

The architectural alternative (maintain a V2→V1 downcaster) was rejected per ADR-028 because:

1. Every TS consumer already reads through `EventUpcasterRegistry` (`libs/event-contracts/src/upcasters/sensor-reading.upcaster.ts` is active). Consumers see V2 whether the wire is V1 or V2.
2. The Rust sidecar's `SensorMetricIngested` event is structurally disjoint from `SensorReading` — sidecar boots never hit the V1/V2 decision.
3. Dual-emit (V1 + V2 side by side on separate subjects) was also rejected: it doubles the broker traffic + forces every consumer to dedup by `eventId`, which is strictly worse than migrating consumers first.

---

## Pre-migration checklist

Confirm ALL before the first V2 emitter flips:

- [ ] **V1 upcaster is active platform-wide.** Every service importing `@platform/event-bus` pulls `createDefaultRegistry()` via the module's default provider. Grep for any service that overrides `EVENT_UPCASTER_REGISTRY` — those need explicit review before the flip.
      ```bash
      grep -rn "EVENT_UPCASTER_REGISTRY" apps/ platform/libs/ \
        | grep -v "createDefaultRegistry\|.d.ts"
      ```
      Expected output: zero lines. Any match → review the provider, confirm it chains `SensorReadingUpcaster`.

- [ ] **Dashboards + alerts on V2 fields exist.** The new `rawValue` field is load-bearing for recalibration; alert rules that watch `value` must also be aware of `rawValue` drift. Owner: alert-engine team.

- [ ] **Rust sidecar accepts both V1 + V2 at the payload validator.**
      Already landed in `apps/sensor-ingestion/src/payload.rs` (V1 auto-upcasts to V2 with `PayloadSource::UpcastedFromV1` tag). No change needed; this is the verification gate, not a new step.

- [ ] **Staging soak with V2 emitter enabled.** Deploy `sensor-service` with the V2 emitter feature flag on + monitor for 72 hours:
      - `sensor_ingestion_upsert_rows_attempted_total{payload_source="upcasted_from_v1"}` should drop to zero as the TS emitter moves to V2.
      - Alert-engine's `SensorReading` handler error rate should NOT increase.
      - Upcaster cache-miss counter should drop.

---

## Phased rollout matrix

Rollout is gated on two orthogonal producers — the NestJS `mqtt-listener.service.ts` (TS) and the Rust sidecar — each of which can independently emit V1 or V2.

| Phase | Producers (TS listener + Rust sidecar) | Consumers | Publisher feature flag | Rollback |
|---|---|---|---|---|
| **0 (current)** | TS listener → V1 nested; Rust sidecar → SensorMetricIngested (disjoint event) | ALL via upcaster → see V2 | `FEATURE_SENSOR_EMIT_V2=false` | N/A — steady state |
| **1** | TS listener dual-writes: V1 + V2 on `events.{tenantId}.SensorReading` (same eventId, two publishes, JetStream dedup via msgID windows one in) | Any single consumer sees either V1 or V2; upcaster normalises | `FEATURE_SENSOR_EMIT_V2=true` + `FEATURE_SENSOR_EMIT_V1=true` | Flip V2 flag off → Phase 0 |
| **2** | TS listener → V2 only; Rust sidecar unchanged | ALL see V2; V1 upcaster dead but present | `FEATURE_SENSOR_EMIT_V2=true` + `FEATURE_SENSOR_EMIT_V1=false` | Flip V1 flag on → Phase 1 |
| **3 (end state)** | TS listener removed — sensor-service no longer MQTT-subscribes; every tenant on Rust sidecar | ALL see V2; V1 upcaster can be deleted | N/A — ADR-025 Phase 2 cut-over complete | Revert to Phase 2 by redeploying sensor-service with the MQTT listener module enabled |

### Per-phase exit criteria

**Phase 0 → 1** (V2 emitter available but off):

- [ ] `sensor-service` deployed with `FEATURE_SENSOR_EMIT_V2` env var wired through `ConfigService`.
- [ ] Flag default OFF in production manifests.
- [ ] Smoke: flip flag on in dev, verify JetStream `events.*.SensorReading` subject receives both V1 and V2 messages with distinct `eventId`s per physical MQTT packet.

**Phase 1 → 2** (V1 emission retired):

- [ ] Production runs Phase 1 for ≥ 7 days.
- [ ] Dashboards show `FEATURE_SENSOR_EMIT_V1=true` traffic decays to ≤ 0.1% (just dedup wins from the V2 path — no V1-only messages).
- [ ] Zero alert-engine errors correlated to `SensorReading` handling.
- [ ] Operator flips `FEATURE_SENSOR_EMIT_V1=false` in the staging environment first; monitor for 24h; then production.

**Phase 2 → 3** (full cut-over to Rust sidecar):

- [ ] Every tenant registered in `apps/sensor-ingestion/config.toml` `[ingest_backend.tenant_overrides]` → `rust`.
- [ ] `default_backend = "rust"` flipped in the policy snapshot via
      `admin-api-service` call (ADR-031 publishing path).
- [ ] `sensor-service` deployment with the MQTT listener module disabled — follow `docs/runbooks/sensor-ingest-rust-rollout.md` § "Full cut-over" block for the hand-off.
- [ ] V1 upcaster removal (a SEPARATE PR after Phase 3 has been stable for ≥ 30 days).

---

## Rollback

Each phase is independently reversible by the feature flag listed in the matrix. The SoT for rollout state is:

1. **Phase 0–2 flags:** environment variables on `sensor-service` deployment. Editable via the compose file + rolling restart.
2. **Phase 3 (Rust cut-over) rollback:** per-tenant flip via `policy.ingest_backend.set_tenant` change event (ADR-031 publisher path — admin-api-service HTTP endpoint once the operator UI lands; direct NATS publish from ops tooling in the interim).

### Rollback decision tree

- **Alert-engine sees increased error rate correlated with SensorReading handling.** → If Phase 1: flip V2 off, keep V1; investigate upcaster. If Phase 2: flip V1 back on (Phase 1). If Phase 3: no change (the Rust sidecar emits `SensorMetricIngested`, not `SensorReading`; the symptom is sensor-service's MQTT path being dark — redeploy sensor-service with MQTT enabled + flip policy to Node per tenant).

- **Upcaster cache-miss counter spikes post-flip.** → Phase 1 → 0: V2 payload shape drift. Review `sensor-reading.upcaster.ts` contract. Phase 2 → 1: same root cause; flip V1 on to restore dual-emit while investigating.

- **JetStream dedup window overflows (rare — 2 minute window, same msgID).** → Phase 1 dual-emit scenario only. Confirm both publishes use the SAME `eventId` (they share a `createBaseEvent` call). If they drift: two distinct eventIds → stream thinks they're two different events. Bug in the emitter. Rollback to Phase 0.

---

## Why no downcaster

The ADR-028 decision (and the plan's KN 5 §3 open question, resolved forward-only) rests on four pillars:

1. **Upcaster is a read-side primitive.** Every consumer that imports `@platform/event-bus` gets the `SensorReadingUpcaster` via `createDefaultRegistry()`. A V1 payload is normalised to V2 at deserialise time — the consumer never knows the wire version.

2. **V2 is a strict superset.** Every V1 field maps unambiguously into V2 (`readings.temperature` → `readingTemperature`, etc.). The upcaster is injective + lossless. There is no scenario where a V2 consumer, handed a V1 payload, would miss information.

3. **Dual-emit is cheap during Phase 1.** JetStream's `duplicate_window: 2 * 60s` (`nats-event-bus.ts:getStreamConfig`) drops the second publish of the same `eventId`. One physical MQTT packet → two NATS publishes with identical `msgID` → stream delivers exactly one. The wall-clock cost is two encode-and-publish operations on the emitter; the broker + consumer cost is unchanged.

4. **A downcaster would be dead code from Phase 3 onward.** Once Phase 3 completes (sensor-service's MQTT listener removed), only the Rust sidecar emits sensor data, and it emits `SensorMetricIngested`, not `SensorReading`. Any downcaster would have zero production callers and its tests would be the ONLY reason it stays in the codebase.

---

## Observability

Counters + gauges that gate the rollout:

- `sensor_ingestion_upsert_rows_attempted_total{payload_source}` — labelled `original_v2` / `upcasted_from_v1`. Phase 1→2 exit criterion: `upcasted_from_v1` ≤ 0.1%.
- `sensor_payload_upcast_total{upcaster="sensor-reading"}` (TS side, emitted by `EventUpcasterRegistry` when `upcast()` succeeds) — Phase 2→3 exit criterion: ratio of upcasted / total → zero over 7 days.
- Alert-engine's `SensorReading` handler error rate (per-tenant).

Dashboards: add `payload_source` as a facet on the existing sensor-ingest dashboard. JSON patch lives in `infrastructure/monitoring/grafana/` (outside this runbook's scope).

---

## Acceptance

This runbook is complete (for the purposes of the Rust-migration delta plan) when:

- [x] The forward-only decision is documented (this file).
- [x] The phased matrix + per-phase exit criteria are pinned.
- [x] The no-downcaster rationale is co-located with the rollout procedure.
- [ ] Phase 0 → Phase 1 is operationally executed (separate PR — scope is ORPHAN-016 resolution).
- [ ] Phase 1 → Phase 2 is operationally executed (separate PR — after 7 days of Phase 1).
- [ ] Phase 2 → Phase 3 is operationally executed (separate PR — bundled with `docs/runbooks/sensor-ingest-rust-rollout.md` full cut-over).

The first three are satisfied by this commit landing. The last three are operational executions, tracked under the respective PRs that carry out each phase flip.
