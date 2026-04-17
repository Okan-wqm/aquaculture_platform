# ADR-003: Sensor-Service Separation from Edge Gateway

**Status:** Accepted (retrodocumented 2026-04-16 during W1 audit)
**Supersedes:** none
**Context note:** this file was 0 bytes until W1 audit flagged it as a phantom canonical ADR.

## Context

Industrial sensor data — Modbus-TCP, MQTT, I2C, Atlas EZO — must be acquired at the farm site, pre-processed, and uploaded to the cloud. Two conflated responsibilities:

1. **Edge acquisition** (hard realtime, on-device): protocol termination, local alarm evaluation, offline buffering during WAN loss, on-device SCADA display, GPIO/I2C/Modbus/Serial access.
2. **Cloud ingestion + analytics**: receive readings from edge, persist to TimescaleDB, calibration, aggregation, emit domain events.

Incompatible runtime constraints: edge on Raspberry Pi / ARM with constrained memory + offline-first; cloud on orchestrator containers with database + NATS.

## Decision

Split across two independent services:

### Cloud: `apps/sensor-service` (NestJS/TypeScript)
- Owns `sensor` schema (tenant-scoped) for sensor definitions, calibration curves, aggregation checkpoints, ingestion audit logs.
- Consumes readings via NATS (`AQUACULTURE_EVENTS.Sensor.*`).
- REST + GraphQL for definition CRUD, calibration, read-side aggregates.
- Emits `SensorCalibrated`, `SensorReadingIngested`, `SensorAlarmTriggered`.

### Edge: `sens-api-gateway/` (Rust with Tokio 1.43 + axum 0.8)
- Protocol gateway: Modbus-TCP, MQTT, I2C, Atlas EZO, serial.
- Local alarm engine + calibration cache for offline operation.
- SQLCipher-backed offline queue (`scada_db.rs`, `offline_queue.rs`) for WAN-loss replay.
- On-device SCADA display (optional `scada-display` feature).
- Outbound-only cloud communication via mTLS.
- IEC 62443 industrial-control-security compliance.

### Boundary contract
- Edge → cloud: NATS subjects + REST upload; payload shapes in `libs/event-contracts/src/sensor/*` (shared with cloud `sensor-service`).
- Cloud → edge: configuration push via MQTT broker (edge subscribes), calibration, alarm policy reload.
- Edge identity: per-device mTLS client cert, CN = `edge-<site-id>-<device-id>` (ADR-015).

## Consequences

**Positive:**
- Offline-capable for hours/days; reconciliation on reconnect idempotent via ingestion audit log.
- Rust gives memory safety + predictable latency; TypeScript gives fast cloud iteration.
- Cloud schema-per-tenant (ADR-011); edge per-site — no tenant confusion at runtime.
- Protocol-specific bugs on cargo release cadence, decoupled from cloud weekly.

**Negative:**
- Two codebases, shared contract surface — drift risk. Mitigated by `libs/event-contracts` SSoT + W7.5 ripple-tracer parsing `services.yaml` (ADR-015).
- On-device key management separate from cloud (see EDGE-CRITICAL-002 SCADA key finding).
- HEAD-compile discipline on the Rust crate must be gated by CI — W1 surfaced EDGE-CRITICAL-001 (compile-broken HEAD). Fix scheduled W2 Day 1 per `docs/reviews/_audit/2026-04-W16-edge-critical-001-fix-proposal.md`.

## References

- `apps/sensor-service/src/`
- `sens-api-gateway/src/main.rs`, `scada_db.rs`, `offline_queue.rs`
- `libs/event-contracts/src/sensor/*`
- `/var/aqua-saas/docs/reviews/_audit/2026-04-W16-edge-rust.md`
- ADR-015 — NATS cert-is-identity SSoT
