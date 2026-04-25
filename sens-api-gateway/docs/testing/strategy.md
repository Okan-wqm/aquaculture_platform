# Test Strategy — `sens-api-gateway`

**Source-of-Truth:** HEAD `3413db47`, v1.6.0, 2026-04-24.
**Audience:** IEC 62443-4-1 SVV assessor, internal engineering lead.

## 1. Test pyramid

The crate is a Rust industrial edge gateway. The test strategy layers from the narrowest verification surface (unit) up to the widest (HIL + soak). Each layer has a distinct truth, a distinct tool, and a distinct cost profile. The pyramid is deliberately weighted toward unit tests because edge-device iteration is expensive once hardware is in the loop.

| Layer | What it proves | Tool | Target coverage | Actual status |
|-------|----------------|------|-----------------|---------------|
| **Unit** (`#[cfg(test)]` inside `src/**`) | Function and type contracts, input validation, branch coverage for pure logic | `cargo test`, `cargo nextest` | 80% line coverage for new code; **practical floor 50% for legacy code** | 814 `#[test]` attributes across 88 files (`grep -c`). Coverage never measured via tarpaulin — see [coverage-report.md](./coverage-report.md). |
| **Integration** (`tests/*.rs`, `#[ignore]` opt-in) | Multi-module flows, resource behaviour under a simulated 1000-device load | `cargo test --release -- --ignored`, `tempfile`, `sysinfo` | 20–30 harnesses covering MQTT, Modbus, SQLCipher queue, provisioning, OTA | 2 harnesses (`tests/resource_benchmark.rs`, `tests/stress_test.rs`). Expansion plan Q3 2026. |
| **Property** (`proptest` — `Cargo.toml:419`) | Parser total-correctness over a generated input domain (Modbus, MQTT, config) | `proptest` macro | 1 property per external-input parser | 0 `proptest!` invocations in the crate today. Harness stubs plan Q3. |
| **Fuzz** (`fuzz/fuzz_targets/`) | Parser crash-freeness under adversarial input | `cargo-fuzz` + `libfuzzer-sys 0.4` | Every external-input parser has a fuzz target with a corpus | 3 targets: `config_parse`, `mqtt_payload`, `modbus_response`. Missing: S7, EtherNet/IP CIP, Atlas EZO, LoRa MAC. Plan Q3. |
| **HIL** (Hardware-in-the-loop) | Real SBC + real PLC simulator + real broker, end-to-end command path | RPi 4/5, RevPi Connect 4, libmodbus DSIM, rumqttd, open62501 | Command roundtrip acceptance, OTA A/B switch, watchdog recovery | **NO COVERAGE — plan Q3 2026.** See [hil-rig.md](./hil-rig.md). |
| **Soak** (1000h endurance) | No memory leaks, no file-descriptor leaks, no panic, no watchdog miss over 1000h | `cargo run --release` + Prometheus scrape | RSS growth < 5%, 0 panics, 0 watchdog misses | **NO RUN EXECUTED — plan Q3 2026.** See [soak-endurance.md](./soak-endurance.md). |
| **EMC / environmental** (IEC 60068, IEC 61000-4) | Compliance with cold, heat, vibration, shock, ESD, EFT, surge, radiated RF | Certified test lab | CE / UL / FCC evidence package | **HARDWARE-VENDOR RESPONSIBILITY** (owner: SBC supplier, deadline: per customer contract, `ORPHAN-EDGE-EMC-001 ROADMAP`). See [emc-environmental.md](./emc-environmental.md). |
| **Security** (static + dynamic) | Clippy wall, unsafe audit, `cargo audit`, `cargo deny`, pentest | `clippy`, `cargo audit`, `cargo deny`, third-party pentest | Zero deny-level lint findings, zero open CVEs, IEC 62443 SL2 pentest | Clippy wall present (`Cargo.toml:433–442`). `cargo audit` / `cargo deny` outside CI path filters — `ORPHAN-EDGE-006`. Pentest plan Q2–Q3. |
| **Bench** (`criterion`) | p99 performance tracking, regression gate | `criterion 0.5` dev-dep (`Cargo.toml:418`) | HMAC append p99 < 5 ms, MQTT publish 1k msg/s, SQLCipher enqueue p99 < 5 ms | 0 `[[bench]]` harnesses wired. Volume benches via `tests/resource_benchmark.rs` (`#[ignore]`d). Expansion plan Q3. |

## 2. Tool choices

The toolchain is pinned to the stable Rust 1.88.0 line (`rust-toolchain.toml`, enforced in `rust-ci.yml`).

- **Unit:** built-in `#[test]` + `cargo test`. `cargo nextest` is the preferred runner for parallel execution speed on the CI hosts but is not yet mandated.
- **Property:** `proptest = "1.5"` (dev-dependency at `Cargo.toml:419`). Present in `Cargo.toml` but no `proptest!` macro invocation exists in the crate — the dependency is a precursor for the Q3 property harness expansion.
- **Fuzz:** `cargo-fuzz` + `libfuzzer-sys 0.4` in `fuzz/Cargo.toml:12`. Three fuzz targets compiled and present.
- **Bench:** `criterion = "0.5"` with `html_reports` feature (`Cargo.toml:418`). No `[[bench]]` target wired — planned harnesses are enumerated in [benchmarks.md](./benchmarks.md).
- **Tempdir scaffolding:** `tempfile = "3.10"` (`Cargo.toml:408`). Used by `src/backup.rs:543` and `src/offline_queue.rs:1488,1510`.
- **Resource measurement:** `sysinfo` crate (imported in `tests/resource_benchmark.rs`).
- **Coverage:** `cargo-tarpaulin` or `cargo-llvm-cov` — neither has been run against this crate. Plan Q3 wires tarpaulin into CI with a coverage gate.
- **Static analysis:** `rustc` deny-wall + `clippy` deny-wall in `Cargo.toml:433–445` (`unwrap_used`, `expect_used`, `indexing_slicing`, `large_stack_arrays`, `todo`, `unimplemented`, `dbg_macro`, `print_stdout`, `print_stderr`, `unsafe_op_in_unsafe_fn`).
- **Supply-chain:** `cargo audit` + `cargo deny` — `deny.toml` present at the crate root; the job executes at workspace level in `rust-ci.yml` but the path filter `crates/**` excludes `sens-api-gateway/**`, see `ORPHAN-EDGE-006`.

## 3. Acceptance criteria

- Every new feature merges with a unit test asserting the happy path and at least one error path.
- Every external-input parser (Modbus, MQTT, config YAML, Atlas EZO, S7, CIP, LoRa MAC) has a fuzz target and a proptest generator (target state; today only 3 of these are covered).
- Every command-execution path from MQTT ingress to actuator write is covered end-to-end by an integration test including the readback-ACK verification loop (today missing, see [integration-tests.md](./integration-tests.md) §Gap).
- Every critical perf path has a `criterion` regression gate with a ±10% bound (today: gate specified per `ADR-020 §8`, harness not yet wired).

## 4. Cost and cadence

- Unit + property + fuzz-smoke: every PR, blocking gate.
- Integration (`#[ignore]` opt-in): nightly on `main`.
- Soak 1000h: quarterly on release candidates.
- HIL full: per release candidate.
- EMC / environmental: per hardware revision of the SBC.
- Pentest: annual, IEC 62443 SL2 cycle.

## 5. Cross-references

- Lane-A authority on test-health: `.claude/agents/test-runner.md`.
- IEC 62443-4-1 SVV clauses driving this strategy: `docs/compliance/iec62443-4-1.md` (owned by `compliance-evidence-writer`).
- Threat-model-driven test derivation (STRIDE → test matrix): `docs/security/threat-model.md`.
