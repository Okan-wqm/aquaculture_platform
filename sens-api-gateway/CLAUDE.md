# sens-api-gateway — CLAUDE.md (Rust edge gateway)

> Root rules in `/CLAUDE.md` apply where relevant, but this is a SEPARATE Rust runtime — the NestJS/TypeORM/TypeScript-specific root rules (entity `schema:` discipline, `getScopedRepository`, the NATS CONNECT-frame factory, `createBaseEvent`, ESLint bans) DO NOT apply here. This file is the authority for the edge crate.

Crate `suderra-agent` (`sens-api-gateway/Cargo.toml`). Sensor protocol gateway running on edge hardware: Modbus-TCP (`rodbus`), OPC UA (`async-opcua` 0.18, optional), MQTT, I2C, Atlas EZO. Alarm engine, calibration, GPIO, backup, SCADA display/deploy orchestrator (`scada-display` feature → axum + tower-http).

## Invariants
- Memory & async safety: no `unwrap()`/`expect()` on fallible I/O in device/network paths; spawned tasks use a `TaskTracker` / `CancellationToken` for clean shutdown. Offline operation must be reliable — store-and-forward when the cloud link is down.
- Security: IEC 62443 alignment; TLS is mutual where the platform expects it. Supply chain: `cargo deny` (`sens-api-gateway/deny.toml`) gates advisories/licenses; `Cargo.lock` IS committed.
- Optional protocol stacks are feature-gated (`scada-display`, OPC UA server, …) — keep the build compile-clean when a feature is disabled. Protocol contracts live in `sensorprotocols/`.

## ADRs (edge-specific, in `docs/adr/`)
017 (ST bytecode runtime), 018 (edge RBAC/ABAC), 019 (firmware signing / A-B partition), 022 (edge schema placement), 026 (protocol codec SSoT), 034 (edge schema sensor per-tenant ownership).

## Build & test
`cargo build --release` (add `--features scada-display` for the display tier); `cargo test`; fuzz targets under `sens-api-gateway/fuzz/`.
