# API Reference — `sens-api-gateway` (Suderra Edge Agent)

**Scope:** Machine- and human-readable API surface for the Rust edge agent binary (`suderra-agent`) v1.6.0.
**Audience:** Integrators, OT cyber-security reviewers (Siemens VAQ/CSQ), platform engineers.
**Source-of-truth evidence:** Every claim in this chapter cites a `src/*.rs:line` anchor or an ADR ID. Un-cited claims are review defects.
**SoT head:** `3413db47` · **Version:** v1.6.0 · **Date:** 2026-04-24.

## Document Map

Each API surface ships as **two documents** — a narrative Markdown chapter plus a machine schema (OpenAPI 3.1 / AsyncAPI 2.6 / JSON Schema draft 2020-12).

| Surface | Narrative | Machine schema |
|---|---|---|
| Rust crate API | [`rust-api.md`](./rust-api.md) | `cargo doc --no-deps` (regenerate on each release) |
| HTTP endpoints | [`http-api.md`](./http-api.md) | [`openapi.yaml`](./openapi.yaml) (OpenAPI 3.1) |
| MQTT topic tree | [`mqtt-topics.md`](./mqtt-topics.md) | [`asyncapi.yaml`](./asyncapi.yaml) (AsyncAPI 2.6) |
| Remote commands (MQTT) | [`remote-commands.md`](./remote-commands.md) | embedded in `asyncapi.yaml` / AsyncAPI `channels.commands.messages` |
| CLI surface | [`cli-commands.md`](./cli-commands.md) | (single binary — no OpenCLI spec upstream yet) |
| YAML configuration | [`config-schema.md`](./config-schema.md) | [`config-schema.json`](./config-schema.json) (JSON Schema draft 2020-12) |
| Payload events | [`event-schemas.md`](./event-schemas.md) | embedded JSON Schemas per event type |
| RBAC manifest | [`rbac-manifest.md`](./rbac-manifest.md) | `Permission` enum serde contract pinned by `sens-api-gateway/src/authz/permission.rs` tests |

## Today-vs-roadmap status table (authoritative)

| Capability | Status | Evidence | Roadmap reference |
|---|---|---|---|
| HTTP `/health` endpoint **definition** | DEFINED IN CODE | `src/health.rs:670-703` (`start_health_server`, `health_handler`) | Not wired today |
| HTTP server **actually wired into main()** | **NOT WIRED TODAY** | `src/main.rs:30` imports `mod health` but `start_health_server` is never invoked — `grep -n start_health_server src/main.rs` returns only the `mod health;` line | `ORPHAN-EDGE-007` — wiring scheduled under Faz 2 Sprint 6.7 runtime safety |
| `/metrics` format | JSON (NOT Prometheus) | `src/health.rs:731-736` — `metrics_handler` returns `axum::Json(state.metrics())` | `ORPHAN-EDGE-008` — Prometheus text-format migration tracked via `metrics-exporter-prometheus` dep (present in Cargo.toml:311, feature-gated off) |
| MQTT topic root namespace | `tenants/{tenant_id}/devices/{device_id}/...` | `src/config.rs:1294-1324` (9 `default_*_topic` functions) | Stable per config schema v1.1 |
| `TelemetryMessage.metrics` payload | System metrics (CPU / RAM / disk / GPIO / Modbus register values) | `src/mqtt.rs:92-139` (`TelemetryMessage` / `TelemetryMetrics`) | NOT the same shape as cloud `SensorReadingEvent` — see CONTRACT-DRIFT in `event-schemas.md` |
| RBAC manifest runtime **wired** | **Types staged, runtime gate NOT wired today** | `src/authz/permission.rs:458-545` (Permission enum complete) + `src/main.rs:22-23` (`#[allow(dead_code)] mod authz`) | ADR-018 Sprint 6.1 — `AuthorizedContext` sealed constructor + `verify_manifest` gate |
| Ed25519 command signature enforcement | Types staged, runtime gate NOT wired | `src/command_envelope/` module present, `src/main.rs:72-73` `#[allow(dead_code)]` | ADR-018 Sprint 6.4 (`signed-deploy` feature flag) |

## Invariants this chapter MUST preserve

1. **Every endpoint / topic / command maps to a `src/*.rs:line` anchor** or is labelled NOT WIRED TODAY with a finding ID.
2. **AsyncAPI topic tree MUST match `mqtt.rs` / `config.rs` reality.** No invented topics.
3. **RBAC manifest is authoritative.** The `Permission` enum + `ActuatorClass` taxonomy tables in `rbac-manifest.md` are the definitive edge vocabulary; `security-architecture-writer` and `operations-sla-writer` consume from this chapter, not vice versa.
4. **Cross-service parity called out.** Where edge payload names/types diverge from `libs/event-contracts/src/**`, this chapter emits a CONTRACT-DRIFT warning with both sides shown side-by-side.
5. **Machine schema + narrative both present.** Every chapter listed in the Document Map has both columns populated.

## CONTRACT-DRIFT summary (per CONTRACT-CRITICAL-004)

The edge agent's on-the-wire payloads and the cloud's `libs/event-contracts/src/**` interfaces are currently defined **independently** — the edge speaks `device_id` / `device_code` + nested `metrics`, while the cloud publishes `sensorId` / flat `readingXxx` fields after sensor-service enrichment. Drift items are enumerated in [`event-schemas.md`](./event-schemas.md#contract-drift-warnings). The sensor-service MQTT listener is responsible for the translation boundary today; no on-wire contract exists that both sides statically conform to.

## Regeneration

- Rust crate API: `cd sens-api-gateway && cargo doc --no-deps --document-private-items=false`
- OpenAPI: edit `openapi.yaml` in place (hand-maintained against `src/health.rs` route table); validate via `npx @redocly/cli lint openapi.yaml` or any OpenAPI 3.1 validator.
- AsyncAPI: edit `asyncapi.yaml` in place (hand-maintained against `src/config.rs` + `src/mqtt.rs`); validate via `npx @asyncapi/cli validate asyncapi.yaml`.
- Config JSON Schema: edit `config-schema.json` in place; validate via `ajv validate -s config-schema.json -d examples/config.yaml.json`.

## Cross-references

- `sens-api-gateway/docs/security/` — STRIDE threat model + crypto inventory (owns RBAC threat rows; consumes manifest from this chapter).
- `sens-api-gateway/docs/operations/` — SLA, alert catalogue, monitoring runbook (consumes metric cardinality from this chapter's `/metrics` section).
- `sens-api-gateway/docs/protocols/` — wire-level protocol references (Modbus/OPC UA/LoRaWAN/MQTT). This chapter is payload-level; transport-level detail lives there.
- `libs/event-contracts/src/sensor-events.ts`, `libs/event-contracts/src/edge-device-events.ts` — cloud-side event shapes referenced by CONTRACT-DRIFT warnings.
- `docs/adr/014-nats-mtls-only-auth.md`, `docs/adr/015-nats-cert-is-identity-ssot.md` — cross-service auth model; edge-to-cloud transport uses MQTT + mTLS (not NATS), so these ADRs apply to the cloud bus upstream of sensor-service, not the edge boundary itself.
