# ADR-021: Per-Tenant `IngestBackend` Toggle for the Rust Sidecar Rollout

**Status:** Proposed (Faz 2 stage 13 — 2026-04-20)
**Date:** 2026-04-20
**Deciders:** Okan (platform owner) + sensor-service maintainers
**Owner:** Okan
**Deadline:** Faz 3 cutover (target 2026-06-30) — at cutover the `Static` policy is replaced by the NATS-served dynamic policy and this ADR is promoted to **Accepted**.
**Related ADRs:** ADR-025 (Rust sidecar architecture), ADR-014/015 (NATS cert-only), ADR-026 (`protocol-codec` SSoT)
**Related plans:** `docs/plans/sensor-rust-migration/PLAN.md` (Faz 2 — Rollout & Strangler Fig)

---

## Context (WHY)

ADR-025 establishes the Rust sidecar (`apps/sensor-ingestion`) as a co-equal producer of `SensorReading` events alongside the existing NestJS `sensor-service`. Cutting over every tenant in one deploy is unsafe: the NATS pipe and TimescaleDB schema layout change in observable ways (event source CN, COPY vs `INSERT VALUES`, backpressure shape). A bug in the new path would silently break alarms and analytics for every tenant simultaneously.

The strangler fig is the textbook fix: the new path runs alongside the old, an explicit per-unit-of-work flag selects which path serves which unit. The "unit of work" here is a tenant — tenants are the ADR-011 isolation boundary, and the operator already owns a per-tenant config plane.

---

## Decision (WHAT)

A `[ingest_backend]` section in the sidecar's TOML config selects, per tenant, whether the sidecar processes that tenant's stream (`Rust`) or acknowledges-and-drops it because NestJS owns the stream (`Node`). The default is `Node` — every existing tenant continues on the NestJS path until explicitly opted in.

```toml
[ingest_backend]
default_backend = "node"
tenant_overrides = {
  "11111111-1111-1111-1111-111111111111" = "rust",
  "22222222-2222-2222-2222-222222222222" = "rust",
}
```

The gate lives in the drain loop of `apps/sensor-ingestion/src/main.rs`:

1. `topic::parse` extracts the tenant id from the MQTT topic.
2. `policy.backend_for(tenant)` returns `Node` or `Rust`.
3. `Node` → drop the message (broker already received QoS-1 ack at `recv()`); increment `node_routed_count`.
4. `Rust` → continue to `payload::validate` → batch aggregator → COPY → NATS publish.

The policy is an `Arc<dyn IngestBackendPolicy>` so the static (TOML-driven) implementation can be swapped for a NATS-served dynamic policy in Faz 3 without touching the drain loop.

### Rejected Alternatives

| Alternative | Reason rejected |
|---|---|
| **Both backends process every message in parallel ("dual-write")** | Doubles TimescaleDB write load, doubles NATS publish load, requires deduplication on the consumer side. The whole point of the rollout is to PROVE the new path works on a subset before exposing it to every tenant. |
| **Topic-based filter (subscribe only to `tenants/<rust-tenant>/+`)** | Forces a config-driven broker subscription change for every rollout step, which means a sidecar restart per tenant flip. The TOML-driven gate flips a tenant in <1s with zero broker churn. |
| **Single global flag (`backend = "rust"`)** | All-or-nothing rollout — exactly the risk the strangler fig exists to avoid. |

---

## Consequences

**Positive:**
- Safe rollout: every existing tenant continues on the proven NestJS path; one tenant at a time migrates with explicit operator action.
- Reversible: a config edit + restart flips a tenant back to `Node` if the Rust path misbehaves for that tenant.
- Observable: `node_routed_count` (sidecar log) + the existing NestJS ingest metrics tell the operator where each message went.
- The drain loop's gate is one `match` — no overhead on the Rust path, no allocation on the Node path.

**Negative:**
- Two paths in production until cutover; both must stay green.
- A misconfigured `[ingest_backend]` (e.g. wrong tenant UUID) silently leaves a tenant on Node, which is the SAFE direction but still a noise source. Mitigation: log the override list size at boot.

**Neutral:**
- The `StaticBackendPolicy` will be replaced by a dynamic one in Faz 3 (`sensor.lookup.tenant_settings` over NATS). The trait stays stable; only the impl swaps.
- Adding a third backend (e.g. `Rust+EventStore`) is a one-enum-variant change.

---

## References

- ADR-025 — Rust sidecar architecture
- `apps/sensor-ingestion/src/ingest_backend.rs` — `IngestBackendPolicy` + `StaticBackendPolicy`
- `apps/sensor-ingestion/src/config.rs` — `IngestBackend`, `IngestBackendConfig`
- `apps/sensor-ingestion/src/main.rs::drain_mqtt_stream` — gate call site
