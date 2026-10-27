# Integration Tests — `sens-api-gateway`

**Source-of-Truth:** HEAD `3413db47`, v1.6.0, 2026-04-24.

Integration tests live in `sens-api-gateway/tests/*.rs`. They exercise multi-module flows and resource behaviour. Both present harnesses are `#[ignore]`d and opt-in via `cargo test --release -- --ignored --nocapture` — so they do not slow down the PR gate but are runnable on demand and in the nightly pipeline.

## 1. Present harnesses

### 1.1 `tests/resource_benchmark.rs`

- Purpose: baseline memory footprint, async workload footprint, sustained workload footprint.
- Opt-in: `#[ignore]` attribute on each test, invoked with `--ignored --nocapture`.
- Measurement: `sysinfo` crate — process RSS and CPU snapshot, delta per operation.
- Tests declared:
  - `resource_benchmark_baseline` — empty-process baseline memory footprint.
  - `resource_benchmark_async_workload` — Tokio runtime + channel footprint.
  - `resource_benchmark_sustained_load` — repeated workload footprint over time.
- Acceptance targets (documented inline in the file): baseline < 20 MB, async workload < 50 MB, sustained workload < 80 MB.
- Gap: not wired to a CI regression gate — results are visual-inspection only.

### 1.2 `tests/stress_test.rs`

- Purpose: 1000 simulated devices with configurable readings-per-second, channel-backpressure behaviour.
- Opt-in: `#[ignore]`, invoke with `--ignored --nocapture`.
- Default `StressConfig`: 1000 devices, 30 s duration, 10 readings/s/device = 300 000 messages/run.
- Metrics: `AtomicU64` counters for messages sent, messages received, delta.
- Validates: memory stability under load, channel buffer behaviour, throughput capacity, absence of resource leaks over 30 s.
- Gap: 30 s duration is below the 1000 h soak target — see [soak-endurance.md](./soak-endurance.md).

### 1.3 In-process Modbus transport tests (`src/modbus.rs`)

- Location: the `#[cfg(test)] mod tests` module of `src/modbus.rs` (unit-test target, not `tests/*.rs`).
- Server: in-process `tokio-modbus` TCP server (dev-dependency feature `tcp-server`, `Cargo.toml:538`) — the same crate as the client.
- Covers: plain Modbus/TCP reads + verified writes, device exceptions (transport kept open), automatic re-open of a dropped transport after backoff, retirement of a transport with an abandoned request, server-only TLS and mTLS over `tokio-rustls`, and rejection of a PLC certificate from an unknown CA or for another name, of an agent without a client certificate on an mTLS PLC, and of half-configured mTLS before any socket is opened.
- Not `#[ignore]`d — runs in the default `cargo test`.

## 2. Intended harness inventory (plan)

The full integration suite needed to cover the command-execution pipeline and ingress paths. Missing today; target implementation Q3 2026 (owner: edge-platform team).

| Harness | Mock / simulator | Coverage intent |
|---|---|---|
| `tests/mqtt_roundtrip.rs` | `rumqttd` in-process broker | Publish + subscribe + reconnect + offline-queue flush |
| `tests/modbus_command_ack.rs` | in-process `tokio-modbus` server (`tcp-server` dev feature) | Command execution including **readback-ACK verification** (see §4) |
| `tests/modbus_tls.rs` | in-process `tokio-modbus` server over `tokio-rustls` | Cert pinning, pathological certs (handshake, unknown-CA / wrong-name rejection and reconnect are already covered in-process — §1.3) |
| `tests/s7_roundtrip.rs` | `snap7` simulator or vendored harness | S7 read / write end-to-end |
| `tests/ethernet_ip_roundtrip.rs` | in-process CIP responder | CIP Class 3 read / write |
| `tests/opcua_roundtrip.rs` | `open62541` server | Namespace browse + subscribe |
| `tests/atlas_ezo_i2c.rs` | `i2c-stub` simulator | Atlas EZO command + response parse |
| `tests/provisioning.rs` | `wiremock` HTTP | Device bootstrap, cert rotation |
| `tests/ota_abswitch.rs` | fs fixture | A/B partition flip on OTA |
| `tests/audit_chain.rs` | SQLCipher temp db | Chain HMAC across restart |
| `tests/offline_queue_flush.rs` | SQLCipher temp db (already used in unit tests — `src/offline_queue.rs:1488`) | Queue enqueue, persist, crash, resume, flush |
| `tests/authz_e2e.rs` | loaded manifest fixture | Policy decision over realistic command set |
| `tests/rbac_mqtt_to_modbus.rs` | rumqttd + in-process `tokio-modbus` server + authz manifest | MQTT → RBAC → Modbus write → readback-ACK full path |

The last row is the single most important missing harness: it is the proof-of-end-to-end the IEC 62443-4-1 SVV assessor looks for. The **readback-ACK** step is the verification loop that reads the register back after a write and asserts the value matches the command; without it a write can silently succeed on the transport while the PLC rejected the value. Today the `src/modbus.rs` write path has no readback loop — the acknowledgement is transport-level only. See §4 Gap.

## 3. Mock / simulator choices

When the harnesses land, the recommended stack:

- **Mock MQTT broker:** `rumqttd` in-process. Already transitively in the workspace for other services; pulling it as a dev-dep is low-risk.
- **Mock Modbus server:** in-process `tokio-modbus` server (`tcp-server` dev feature, `Cargo.toml:538`) — same crate as the client (`Cargo.toml:88`), already used by the §1.3 transport tests. Ensures protocol parity.
- **Mock OPC UA server:** `open62541` binary started via `std::process::Command`, or the `opcua` crate's in-process server.
- **Mock HTTP (provisioning / webhook):** `wiremock = "0.6"` (add as dev-dep).
- **In-memory DB:** `tempfile::TempDir` already used (`src/offline_queue.rs:1488,1510`, `src/backup.rs:543`). SQLCipher file created per test and deleted on drop.
- **Arbitrary input corpora for Modbus / MQTT / config:** generated by the `proptest` or the `cargo-fuzz` corpora — see [property-fuzz.md](./property-fuzz.md).

## 4. Gap — Modbus write readback-ACK

**Finding:** the Modbus write path in `src/modbus.rs` acknowledges on transport return (the `tokio-modbus` `write_single_*` request resolves), not on a verification read of the target register. A PLC that accepts-then-discards a write, a PLC with a coil-clamp, or an intermediate gateway that rewrites the value, will all look like successful writes from the agent's perspective.

**Why this is an integration-test concern and not a unit-test concern:** readback-ACK is the contract between the agent and the downstream PLC. The unit test of `write_single_register` proves the command is serialised and sent; it does not prove the value landed. Only an integration test with a Modbus server simulator reading back the register can prove the round-trip.

**Architectural fix (out of this chapter's scope — see `src/modbus.rs` audit):** the write path should issue a read-one-shot after the write and assert equality; mismatch should raise a `ModbusError::ReadbackMismatch` and propagate to the audit log. That is a code change, tracked as a separate finding; this chapter documents the test-coverage side: **no integration test asserts readback-ACK today** because the production code does not implement it. Once the architectural fix lands, a `tests/modbus_command_ack.rs` harness must assert the verification loop.

**Tracked as:** cross-cited from prior audit; this chapter's job is the evidence record.

## 5. Evidence links

- `tests/resource_benchmark.rs` — baseline / async / sustained harness; `sysinfo` import at the top of the file.
- `tests/stress_test.rs` — 1000-device stress harness; `AtomicU64` counters, `StressConfig::default()` specifying the 30 s window.
- `Cargo.toml:88` — `tokio-modbus = "~0.17"` client; `Cargo.toml:538` — the same crate's `tcp-server` feature as a dev-dependency (in-process server for the `src/modbus.rs` transport tests).
- `Cargo.toml:408` — `tempfile = "3.10"` dev-dep already used.
- `src/offline_queue.rs:1488,1510` — existing `tempfile::tempdir()` usage, proof of pattern.
- `.github/workflows/rust-ci.yml:77–88` — the workspace test job; note the `paths:` filter excludes `sens-api-gateway/**` (`ORPHAN-EDGE-006`).
