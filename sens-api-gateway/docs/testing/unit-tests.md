# Unit Test Inventory — `sens-api-gateway`

**Source-of-Truth:** HEAD `3413db47`, v1.6.0, 2026-04-24.
**Method:** `grep -c "#\[test\]" sens-api-gateway/src/**/*.rs`, per-file per-module aggregation.

## Global totals

- **Total `#[test]` attributes in `src/**`:** 814
- **Source files carrying `#[cfg(test)]` blocks:** 88 (of 108 `.rs` files in `src/`)
- **Files with 0 tests:** 20 — every file with `0` is a coverage gap; see §4.

## 1. Per-module inventory (sorted by test density)

| Module / file | `#[test]` count | Category | Cov % | Notes |
|---|---|---|---|---|
| `src/st_validator.rs` | 47 | PLC Structured Text grammar validator | N/M | High density; parser surface well exercised |
| `src/plc_programming/opcua.rs` | 45 | OPC UA client | N/M | Namespace / NodeId coverage |
| `src/command_envelope/envelope.rs` | 28 | Signed command envelope (HMAC + JTI) | N/M | Security-critical; audit chain |
| `src/audit/entry.rs` | 25 | Audit log entry | N/M | Chained-HMAC verifier |
| `src/safe_state_v2.rs` | 24 | Safe-state v2 transitions | N/M | Safety-critical (IEC 61508 class) |
| `src/scripting/function_blocks/flipflops.rs` | 22 | IEC 61131-3 function blocks (SR/RS) | N/M | ST library |
| `src/updater/manifest.rs` | 20 | OTA manifest signature verification | N/M | Security-critical |
| `src/mtls/verify.rs` | 19 | mTLS peer cert verify | N/M | Security-critical |
| `src/scripting/function_blocks/timers.rs` | 16 | TON/TOF/TP timers | N/M |  |
| `src/scripting/fb_registry.rs` | 15 | Function-block registry | N/M |  |
| `src/lora/codec.rs` | 15 | LoRaWAN codec | N/M | FHDR / MIC |
| `src/authz/verify.rs` | 15 | Authz policy verify | N/M | Security-critical |
| `src/authz/permission.rs` | 15 | Permission model | N/M |  |
| `src/updater/verify.rs` | 14 | OTA signature verification | N/M | Security-critical |
| `src/authz/manifest.rs` | 14 | Authz manifest | N/M |  |
| `src/audit/chain.rs` | 14 | Audit chain HMAC | N/M |  |
| `src/plc_programming/ethernet_ip.rs` | 13 | EtherNet/IP CIP | N/M | **No fuzz harness yet — see property-fuzz.md** |
| `src/command_envelope/canonical.rs` | 13 | Canonical-form serialisation for HMAC | N/M |  |
| `src/scripting/engine.rs` | 12 | ST runtime | N/M |  |
| `src/lora/session.rs` | 12 | LoRaWAN session | N/M |  |
| `src/keystore/acceptance.rs` | 12 | Keystore acceptance | N/M |  |
| `src/scripting/persistence.rs` | 11 |  | N/M |  |
| `src/scripting/function_blocks/controllers.rs` | 11 | PID / P / PI controllers | N/M |  |
| `src/runtime_safety/shutdown_phase.rs` | 11 | Shutdown state machine | N/M |  |
| `src/plc_programming/s7comm.rs` | 11 | S7 ISO-on-TCP | N/M | **No fuzz harness yet — see property-fuzz.md** |
| `src/modbus.rs` | 11 | Modbus TCP / RTU / TLS | N/M | **Fuzz: yes (`fuzz/fuzz_targets/modbus_response.rs`)** |
| `src/config.rs` | 11 | YAML config loader | N/M | **Fuzz: yes (`fuzz/fuzz_targets/config_parse.rs`)** |
| `src/command_envelope/jti.rs` | 11 | JTI replay tracker | N/M |  |
| `src/security.rs` | 10 | Security module | N/M |  |
| `src/scripting/limits.rs` | 10 | Sandbox resource limits | N/M |  |
| `src/offline_queue.rs` | 10 | SQLCipher offline queue | N/M | `tempfile::tempdir()` used |
| `src/mtls/pinning.rs` | 10 | Cert pinning | N/M |  |
| `src/hardware_scanner.rs` | 10 | Hardware probe | N/M |  |
| `src/config_integrity/verify.rs` | 10 | Config signature verify | N/M |  |
| `src/runtime_safety/clock.rs` | 9 | Monotonic clock | N/M |  |
| `src/lora/mac.rs` | 9 | LoRaWAN MAC | N/M | **No fuzz harness yet** |
| `src/deploy_orchestrator.rs` | 9 | SCADA deploy | N/M |  |
| `src/config_integrity/manifest.rs` | 9 |  | N/M |  |
| `src/alarms.rs` | 9 | Alarm engine | N/M |  |
| `src/updater/partition.rs` | 8 | A/B partition | N/M |  |
| `src/scripting/function_blocks/counters.rs` | 8 | CTU/CTD/CTUD | N/M |  |
| `src/plc_programming/ads.rs` | 8 | Beckhoff ADS | N/M |  |
| `src/scripting/function_blocks/edge_triggers.rs` | 7 | R_TRIG / F_TRIG | N/M |  |
| `src/scripting/conflict.rs` | 7 |  | N/M |  |
| `src/runtime_safety/retained_msg.rs` | 7 |  | N/M |  |
| `src/resilience/rate_limiter.rs` | 7 | Token-bucket | N/M |  |
| `src/lora/crypto.rs` | 7 | LoRaWAN crypto | N/M |  |
| `src/backup.rs` | 7 | Backup archive | N/M | `tempfile::TempDir` used |
| `src/authz/policy.rs` | 7 |  | N/M |  |
| `src/authz/context.rs` | 7 |  | N/M |  |
| `src/plc_programming/mod.rs` | 6 |  | N/M |  |
| `src/plc_programming/common.rs` | 6 |  | N/M |  |
| `src/mtls/mode.rs` | 6 |  | N/M |  |
| `src/error.rs` | 6 |  | N/M |  |
| `src/command_envelope/mutating.rs` | 6 |  | N/M |  |
| `src/scripting/storage.rs` | 5 |  | N/M |  |
| `src/safe_state.rs` | 5 | Legacy safe-state (v1) | N/M | Superseded by `safe_state_v2.rs` |
| `src/resilience/circuit_breaker.rs` | 5 |  | N/M |  |
| `src/provisioning.rs` | 5 |  | N/M |  |
| `src/mtls/cipher.rs` | 5 |  | N/M |  |
| `src/lora/types.rs` | 5 |  | N/M |  |
| `src/keystore/secret.rs` | 5 |  | N/M |  |
| `src/keystore/purpose.rs` | 5 |  | N/M |  |
| `src/interning.rs` | 5 |  | N/M |  |
| `src/health.rs` | 5 |  | N/M |  |
| `src/updater/error.rs` | 4 |  | N/M |  |
| `src/spi.rs` | 4 |  | N/M |  |
| `src/scripting/mod.rs` | 4 |  | N/M |  |
| `src/keystore/error.rs` | 4 |  | N/M |  |
| `src/gpio.rs` | 4 |  | N/M |  |
| `src/config_integrity/error.rs` | 4 |  | N/M |  |
| `src/bounded.rs` | 4 |  | N/M |  |
| `src/scripting/triggers.rs` | 3 |  | N/M |  |
| `src/scripting/parallel.rs` | 3 |  | N/M |  |
| `src/scripting/context.rs` | 3 |  | N/M |  |
| `src/scripting/actions.rs` | 3 |  | N/M |  |
| `src/pwm.rs` | 3 |  | N/M |  |
| `src/plc_programming/codesys.rs` | 3 | CoDeSys gateway | N/M |  |
| `src/lora/sx1302.rs` | 3 |  | N/M |  |
| `src/keystore/mod.rs` | 3 |  | N/M |  |
| `src/i2c.rs` | 3 |  | N/M |  |
| `src/telemetry.rs` | 2 | Prometheus telemetry | N/M |  |
| `src/mtls/error.rs` | 2 |  | N/M |  |
| `src/lora/mod.rs` | 2 |  | N/M |  |
| `src/commands.rs` | 1 |  | N/M | Thin façade |

`Cov %` column is marked `N/M` (Not Measured) uniformly — `cargo tarpaulin` / `cargo llvm-cov` has never been run against this crate. See [coverage-report.md](./coverage-report.md) for the measurement plan.

## 2. Modules with 0 tests (explicit gaps)

Any file in `src/**` without a `#[test]` attribute or `#[cfg(test)]` module is a coverage gap. Enumerated from `find src -name "*.rs"` minus the 88 files above (total 108 − 88 = 20 files). Candidates — verified as zero-test surfaces: `src/main.rs` (binary entrypoint — arguably N/A), `src/alarm_engine.rs`, `src/atlas_ezo.rs`, `src/calibration_engine.rs`, `src/io_poll.rs`, `src/mqtt_failover.rs`, `src/mqtt.rs`, `src/process_image.rs`, `src/scada_db.rs`, `src/scada_server.rs`, `src/scada_types.rs`, `src/shutdown.rs`, `src/trend_engine.rs`, and module mod.rs stubs.

Each zero-test file is a finding candidate for Lane-B product-audit. The highest-priority gaps among these:

| File | Why it matters | Proposed action |
|---|---|---|
| `src/alarm_engine.rs` | Safety-critical (IEC 61508 class). No branch coverage. | Unit tests for alarm state transitions by Q3. |
| `src/atlas_ezo.rs` | External-input parser (I2C). Feeds process logic. | Unit + fuzz harness by Q3 (no fuzz target today). |
| `src/mqtt.rs` + `src/mqtt_failover.rs` | Ingress path. Broker reconnect / failover logic. | Integration tests with mock broker (rumqttd) by Q3. |
| `src/calibration_engine.rs` | Measurement chain correctness. | Property tests with `proptest` over calibration coefficients by Q3. |
| `src/scada_server.rs`, `src/scada_db.rs`, `src/scada_types.rs` | SCADA storage + server. Queryable surface. | Integration tests with `tempfile::TempDir` by Q3. |
| `src/process_image.rs` | PLC process image representation. | Unit tests for read/write coherence by Q3. |
| `src/trend_engine.rs` | Historian / trending. | Unit tests for sample-rate fidelity by Q3. |
| `src/io_poll.rs` | I/O polling loop. | Integration tests with mock backends by Q3. |

## 3. Observations

- The **highest test density** lives in: ST validator, OPC UA, command envelope, audit, mTLS verify, updater manifest, authz — i.e. the security-critical + safety-critical surfaces. Appropriate posture.
- The **lowest test density** lives in: SCADA server, process image, trend engine, alarm engine, MQTT failover, calibration engine — i.e. the runtime glue between components. These are the gaps that Q3 integration-test expansion (see [integration-tests.md](./integration-tests.md)) targets directly.
- **No test relies on `unwrap_used`-style patterns** in production hot paths; the clippy wall at `Cargo.toml:433–442` denies them at build time.

## 4. Evidence links

- `Cargo.toml:405–419` — `[dev-dependencies]` section (`tempfile = "3.10"`, `criterion = "0.5"`, `proptest = "1.5"`).
- `Cargo.toml:433–442` — clippy deny-wall.
- `src/backup.rs:543` — `tempfile::TempDir` import in test module.
- `src/offline_queue.rs:1488,1510` — `tempfile::tempdir()` calls in test module.
- `.github/workflows/rust-ci.yml:77–88` — `cargo test --workspace --all-features --no-fail-fast` job (note: the `paths:` filter excludes `sens-api-gateway/**` — tracked as `ORPHAN-EDGE-006`).
