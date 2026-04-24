# Benchmarks — `sens-api-gateway`

**Source-of-Truth:** HEAD `3413db47`, v1.6.0, 2026-04-24.

## 1. Present harnesses

### 1.1 `criterion` dev-dependency

`criterion = "0.5"` with `html_reports` feature is declared at `Cargo.toml:418`:

```
# WHY: ADR-020 §8 performance bench gate (p99 append < 5ms eMMC; verify > 50k/sec);
#      ADR-017 §10 bytecode dispatch perf; ADR-021 §11 HSM sign roundtrip perf.
#      Criterion emits JSON + HTML; CI uses ±10% regression gate (Plan §9 Faz 9).
# WHAT: criterion = microbenchmark framework; proptest = property-based testing
#       precursor to cargo-fuzz targets (bytecode, envelope, policy, modbus parsers).
criterion = { version = "0.5", features = ["html_reports"] }
```

The dependency is wired but no `[[bench]]` target is declared in `Cargo.toml`, and no file under a (non-existent) `benches/` directory references `criterion_group!` / `criterion_main!`. **Zero `criterion` harnesses live in the crate today.**

### 1.2 `tests/resource_benchmark.rs`

Volume-measurement harness (`#[ignore]`d). Not a `criterion` bench — it uses `sysinfo` to snapshot process RSS, not a statistical distribution framework. Runs with:

```
cargo test --test resource_benchmark --release -- --ignored --nocapture
```

- `resource_benchmark_baseline` — empty-process memory baseline.
- `resource_benchmark_async_workload` — Tokio runtime + channel overhead.
- `resource_benchmark_sustained_load` — sustained-load RSS measurement.

Output: human-readable stdout. Not machine-parseable; no regression gate.

### 1.3 `tests/stress_test.rs`

Throughput harness (`#[ignore]`d). Measures messages-sent / messages-received over 30 s with 1000 simulated devices. Reports throughput in stdout; no regression gate.

## 2. Plan (Q3 2026)

### 2.1 `criterion` harnesses

Planned under a new `benches/` directory, declared in `Cargo.toml` via `[[bench]]` blocks. Each has a documented acceptance target.

| Bench | Target | Plan |
|---|---|---|
| `hmac_audit_append` | Audit chain HMAC-append throughput | p99 < 5 ms on eMMC (ADR-020 §8) |
| `hmac_audit_verify` | Audit chain full-chain verify rate | > 50 000 entries / s (ADR-020 §8) |
| `mqtt_publish_throughput` | MQTT publish loop, QoS 1 | 1000 msg/s sustained on RPi 4 |
| `sqlcipher_enqueue` | Offline-queue enqueue | p99 < 5 ms |
| `modbus_parallel_read` | Multi-device read loop | 1000 reg/s aggregate on RPi 4 |
| `bytecode_dispatch` | Scripting-engine bytecode step | per ADR-017 §10 |
| `hsm_sign_roundtrip` | Signed envelope HSM round-trip | per ADR-021 §11 |
| `opcua_subscribe_notification` | OPC UA subscription notification pipe | p99 < 20 ms |
| `lora_frame_encode_decode` | LoRaWAN frame codec | > 1000 frames/s single-core |

### 2.2 Regression gate

- **Output:** `criterion` emits JSON + HTML under `target/criterion/`.
- **Gate:** CI uses a ±10 % regression gate (documented in the bench comment at `Cargo.toml:413–415`).
- **Artefact:** HTML report attached as a CI artefact on every PR that touches hot paths.
- **Historical tracking:** plan Q4 — ship the JSON into a long-lived store (e.g. criterion-compare GitHub Action or a self-hosted time-series DB).

### 2.3 Hot-path identification

Benchmarks must cover the paths that the threat model flags as high-frequency or latency-sensitive:

- Audit chain (every command, every authz decision).
- MQTT publish / subscribe loops.
- SQLCipher queue enqueue / dequeue.
- Modbus / OPC UA / S7 / CIP request-response.
- Scripting bytecode dispatch.
- HSM / keystore sign round-trip.
- LoRaWAN frame encode / decode.

Paths NOT in this list are either rare (OTA update, cert rotation) or bounded by external resources (disk for backup, network for provisioning) — they live in integration tests rather than microbenchmarks.

## 3. Acceptance for the Q3 work

- All 9 `criterion` harnesses land in `benches/`.
- `[[bench]]` blocks in `Cargo.toml` wire every harness.
- CI job added to `rust-ci.yml` running `cargo bench --no-run` on every PR (compile-check), and `cargo bench` on nightly `main` with a ±10 % regression gate.
- Historical report published under `docs/testing/benchmarks-history.md` on every release.

## 4. Evidence links

- `Cargo.toml:411–419` — bench dev-dependency declaration.
- `Cargo.toml:413–415` — documented ±10 % regression gate, ADR-020 §8 / ADR-017 §10 / ADR-021 §11 anchor.
- `tests/resource_benchmark.rs` — present volume-measurement harness.
- `tests/stress_test.rs` — present throughput harness.
- No `benches/` directory present (verified 2026-04-24 via `ls benches/` → absent).
- No `[[bench]]` blocks present in `Cargo.toml` (verified 2026-04-24 via `grep -n "\[\[bench\]\]" Cargo.toml` → no match).
