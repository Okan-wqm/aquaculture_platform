# sens-api-gateway — Feature Matrix

**Version:** 1.6.0 (`Cargo.toml:6`) · **Source-of-truth commit:** `3413db47` · **Date:** 2026-04-29
**Status vocabulary:** `PRESENT` (shipping today in the named evidence file) · `ROADMAP-Q1..Q4` (2026 quarters, with ADR or finding-ID tracker) · `NOT-PLANNED` (explicit product decision, with reason) · `HARDWARE-VENDOR RESPONSIBILITY` (SBC / silicon supplier, owner+deadline per customer contract)

## How to read this table

Every row cites concrete evidence: a Rust source file + line range, a `Cargo.toml` line, a feature-flag gate, an ADR ID, or an orphan-finding ID. Rows marked `ROADMAP-*` name the ADR or finding tracking the work — no silent omissions. Rows marked `NOT-PLANNED` state the reason. This doc is the contractual feature ledger a Siemens vendor-assessment reviewer reads before every other chapter.

Cross-references to deeper chapters use relative paths under `sens-api-gateway/docs/`. Chapter owners are listed in `.claude/agents/edge-docs/README.md`.

---

## A. Connectivity

| Feature | Status | Evidence | Notes / Cross-reference |
|---------|--------|----------|-------------------------|
| Ethernet (cloud uplink) | PRESENT | `Cargo.toml:30` (`reqwest` rustls), `src/provisioning.rs` | → `protocols/mqtt.md` (owned by protocol-reference-writer) |
| Cellular modem (LTE / 5G) | HARDWARE-VENDOR RESPONSIBILITY (owner: SBC supplier, deadline: per customer contract) | Not in crate graph | Customer provisions a modem + routes over the Linux interface; agent is transport-agnostic |
| WiFi STA | HARDWARE-VENDOR RESPONSIBILITY (owner: SBC supplier, deadline: per customer contract) | Not in crate graph | Same — Linux networking layer, not agent code |
| Offline queue (network loss) | PRESENT | `src/offline_queue.rs`, `src/mqtt_failover.rs`, `src/outbound_publisher.rs` | SQLCipher-backed; drain on reconnect. |
| Offline flush on shutdown | PRESENT | `src/offline_queue.rs`, `src/main.rs` | 2026-04-29 shutdown path stops the drain task, checkpoints the WAL, and fsyncs DB/WAL/SHM/parent paths. |

## B. Protocols — wire level

| Protocol | Status | Evidence | Cross-reference |
|----------|--------|----------|----------------|
| Modbus-TCP | PRESENT | `Cargo.toml:70` (`rodbus = "=1.4.0"`), `src/modbus.rs` | → `protocols/modbus.md` · ORPHAN-002 (version pin) · ORPHAN-008 FIXED-IN-CODE (write routing) · ORPHAN-009 OPEN (truncation on analog write) |
| Modbus-RTU (serial) | PRESENT | `Cargo.toml:72` (`tokio-serial = "5.4"`), `src/modbus.rs` | → `protocols/modbus.md` |
| Modbus TLS (server-only, no mTLS) | PRESENT | `Cargo.toml:66-69` (rodbus empty-Path pin), `src/modbus.rs` | → `protocols/modbus.md` — ORPHAN-002 |
| Modbus TLS (full mTLS) | ROADMAP-Q2 | Tracked via ORPHAN-002 removal + rodbus upgrade plan | Not claimed as shipping |
| OPC UA Server (1.04) | PRESENT (feature-gated) | `Cargo.toml:266` (`opcua = "0.12"`), feature `opc-ua-server` (`Cargo.toml:379`), `src/plc_programming/opcua.rs` (5 787 LOC) | → `protocols/opcua.md` — handrolled surface evaluation pending |
| OPC UA Client | PRESENT | `src/plc_programming/opcua.rs` | → `protocols/opcua.md` |
| S7comm (Siemens S7-300/400/1200/1500) | PRESENT | `src/plc_programming/s7comm.rs` | → `protocols/s7comm.md` · → `integration/siemens/` (owned by siemens-integration-writer) |
| EtherNet/IP (CIP) | PRESENT | `src/plc_programming/ethernet_ip.rs` | → `protocols/ethernet-ip.md` |
| Beckhoff ADS/AMS | PRESENT | `src/plc_programming/ads.rs` | → `protocols/ads.md` |
| Codesys V3 Gateway | PRESENT | `src/plc_programming/codesys.rs` | → `protocols/codesys.md` |
| PROFINET (device / IO-Device) | NOT-PLANNED | Not in crate graph | Requires certified stack + GSDML tool-chain; Siemens-integration-writer owns the gap decision |
| PROFINET IRT master | NOT-PLANNED | Not in crate graph | Same reason — vendor-stack dependency |
| HART-IP | NOT-PLANNED | Not in crate graph | Outside current aquaculture + process-water scope |
| MQTT v3.1.1 / v5 | PRESENT | `Cargo.toml:33` (`rumqttc = "0.25"`), `src/mqtt.rs` | → `protocols/mqtt.md` |
| MQTT TLS (broker authentication — user/pass) | PRESENT | `src/mqtt.rs:203-237` | Device-to-broker credential path uses username+password today |
| MQTT mTLS (cert-is-identity) | ROADMAP-Q2 | Tracked via `docs/reviews/edge-expert/2026-04-05-s2-high-findings.md` + ADR-015 as cross-fabric pattern | Not claimed as shipping on device uplink |
| AMQP 1.0 | NOT-PLANNED | Not in crate graph | MQTT is primary; AMQP gap re-assessed per deal |
| LoRaWAN 1.0.x (SX1302 concentrator) | PRESENT (feature-gated) | `Cargo.toml:286-296` (aes/cmac/lorawan), feature `lorawan` (`Cargo.toml:341`), `src/lora/` (codec, crypto, mac, session, sx1302) | → `protocols/lorawan.md` · OFF by default, vendor HAL C-sources required |
| LoRaWAN 1.1 | ROADMAP-Q3 | Incremental on 1.0.x | Not claimed |
| NB-IoT / Cat-M1 | HARDWARE-VENDOR RESPONSIBILITY (owner: SBC supplier, deadline: per customer contract) | Not in crate graph | |

## C. Field-level I/O

| Feature | Status | Evidence | Cross-reference |
|---------|--------|----------|----------------|
| GPIO (Linux ARM) | PRESENT (feature-gated) | `Cargo.toml:315` (`rppal = "0.17"`), feature `gpio` (`Cargo.toml:326`), `src/gpio.rs` | → `protocols/gpio.md` |
| I2C bus | PRESENT | `src/i2c.rs` | → `protocols/i2c.md` |
| SPI bus | PRESENT | `src/spi.rs` (658 LOC) | → `protocols/spi.md` |
| PWM out | PRESENT | `src/pwm.rs` | → `protocols/pwm.md` |
| Atlas Scientific EZO (pH / DO / EC / ORP / RTD) | PRESENT | `src/atlas_ezo.rs` | → `protocols/atlas-ezo.md` |
| 1-Wire | NOT-PLANNED | Not in crate graph | Aquaculture customer set uses Atlas EZO + Modbus — re-assessed per deal |
| CAN bus | NOT-PLANNED | Not in crate graph | Not a target-customer request |

## D. Control & Logic

| Feature | Status | Evidence | Cross-reference |
|---------|--------|----------|----------------|
| Edge scripting (JSON trigger/action) | PRESENT | `src/scripting/` (engine, triggers, actions, storage, persistence, parallel, conflict, fb_registry, function_blocks, limits) | → `operations/scripting.md` |
| IEC 61131-3 Structured Text (ST) — bytecode VM | PRESENT (feature-gated) | `Cargo.toml:367` feature `st-bytecode`, `src/st_validator.rs` (3 551 LOC), ADR-017 | → `architecture/st-bytecode.md` |
| IEC 61131-3 Ladder Diagram (LD) | NOT-PLANNED | ADR-017 §2 | Customer demand routed to ST; LD exclusion is a product decision recorded in ADR-017 |
| IEC 61131-3 Function Block Diagram (FBD) | NOT-PLANNED | ADR-017 §2 | Same — ST-only by ADR |
| IEC 61131-3 Sequential Function Chart (SFC) | NOT-PLANNED | ADR-017 §2 | Same |
| Function Blocks (PID / MAVG / HYSTERESIS, FB registry) | PRESENT | `src/scripting/fb_registry.rs`, `src/scripting/function_blocks/`, `docs/ARCHITECTURE.md` v1.2.4 | → `architecture/function-blocks.md` |
| Multi-task scheduler (jitter metrics, watch-subscribe) | PRESENT (feature-gated) | `Cargo.toml:372` feature `multi-task-scheduler`, ADR-017 R-3 | → `architecture/scheduler.md` |
| Live debug (force_value / list_forces / unforce) | PRESENT (feature-gated) | `Cargo.toml:385` feature `live-debug`, ADR-017 §13 | force_value is signature-gated even with flag ON |
| Conflict detector (priority-based) | PRESENT | `src/scripting/conflict.rs`, `docs/ARCHITECTURE.md` §5 | |
| Safe-state manager | PRESENT | `src/safe_state.rs:76-130`, `src/safe_state_v2.rs` | → `operations/safe-state.md` |
| Kani formal verification harnesses | PRESENT (feature-gated, dev-only) | `Cargo.toml:394-397` feature `kani`, ADR-023 §8 | Nightly CI; not in production binary |

## E. Alarm Management

| Feature | Status | Evidence | Cross-reference |
|---------|--------|----------|----------------|
| Alarm rules + active-alarm set | PRESENT | `src/alarm_engine.rs:14-245` (AlarmRule, ActiveAlarm, AlarmEngine, evaluate, acknowledge) | → `operations/alarms.md` |
| Priority levels (Low / Normal / High / Critical / Emergency) | PRESENT | `docs/ARCHITECTURE.md` §5 (ScriptPriority), `src/scripting/conflict.rs` | |
| ISA-18.2 state model + KPI reporting | ROADMAP-Q3 | Shape present; KPI evidence (PRIORITY-DIST, FLOOD-RATE, STALE-ALARM) owned by operations-sla-writer | Evidence binding is handoff |
| Alarm flood suppression | ROADMAP-Q2 | Not yet in `src/alarm_engine.rs`; tracked with operations-sla-writer | |
| Multi-channel dispatch (Slack / Teams / PagerDuty / Twilio) | PRESENT | `src/scripting/actions.rs` (webhook), `docs/SCENARIOS_BEYOND_SCADA.md` §6 | Script-layer, not a hardcoded dispatcher |
| Trend engine | PRESENT | `src/trend_engine.rs` | |

## F. Data Management

| Feature | Status | Evidence | Cross-reference |
|---------|--------|----------|----------------|
| Local SQLite persistence (RETAIN + scripts + queue) | PRESENT | `Cargo.toml:94` (`rusqlite` bundled-sqlcipher-vendored-openssl), `src/scada_db.rs` (680 LOC) | → `architecture/persistence.md` |
| SQLCipher AES-256 at rest | PRESENT | `Cargo.toml:89-94` (bundled-sqlcipher feature), key derivation in `src/scada_db.rs init_schema()` | → `security/crypto-inventory.md` |
| SQLite backup (VACUUM INTO) | PRESENT | `src/backup.rs`, `Cargo.toml:110` (`flate2` compression) | → `deployment/backup-restore.md` |
| Process image (watch-subscribe, tokio watch channels) | PRESENT | `src/process_image.rs`, `src/io_poll.rs` | |
| String interning (memory efficiency) | PRESENT | `Cargo.toml:104` (`lasso`), `src/interning.rs` | |
| Bounded caches (moka sync) | PRESENT | `Cargo.toml:97-98` (`moka = "0.12"`) | Memory-bounded to protect SBC RAM |
| Stack-allocated bounded collections | PRESENT | `Cargo.toml:107` (`heapless`), `src/bounded.rs` | IEC 62443 FR3 memory safety |

## G. Security

| Feature | Status | Evidence | Cross-reference |
|---------|--------|----------|----------------|
| Ed25519 signing (local artefacts) | PRESENT | `Cargo.toml:145`, ADR-021 §1 | → `security/crypto-inventory.md` |
| HKDF-SHA256 key derivation | PRESENT | `Cargo.toml:158`, ADR-019 §7 + ADR-020 §2 | → `security/pki.md` |
| Argon2id passphrase KDF (Tier 3) | PRESENT | `Cargo.toml:171`, ADR-019 §7 | |
| TPM 2.0 keystore Tier 1 (NV counter + PCR-sealed) | PRESENT (feature-gated) | `Cargo.toml:284` (`tss-esapi = "8"`), feature `tpm` (`Cargo.toml:361`), ADR-018 §4 + ADR-019 §11 | HW-dependent; graceful fallback Tier 2/3 — operator-gated |
| systemd-creds keystore Tier 2 | PRESENT | ADR-019 §7 | Linux-native; fallback when TPM absent |
| File-backed keystore Tier 3 (operator-gated) | PRESENT | ADR-019 §7, `src/keystore/acceptance.rs` | `i_accept_file_backed_keystore_risk` required |
| Command-envelope signing (Enforcing mode) | PRESENT (feature-gated) | `Cargo.toml:355` feature `signed-deploy`, `src/command_envelope/` (canonical, envelope, jti, mutating), ADR-018 §7 | Permissive without flag, rejecting with flag |
| HMAC audit chain (append-only, 7-yr retention) | PRESENT | `src/audit/chain.rs`, `src/audit/entry.rs`, ADR-020 §1, `Cargo.toml:116` (`hmac = "0.12"`) | → `security/audit-chain.md` |
| fcntl advisory-lock + CAP_LINUX_IMMUTABLE drop on audit log | PRESENT | `Cargo.toml:220` (`nix` fs+process features), ADR-020 §3a | |
| mTLS for cloud-uplink HTTPS | PRESENT | `Cargo.toml:30` (`reqwest` rustls-tls-manual-roots), `src/mtls/` (cipher, mode, pinning, verify) | → `security/mtls.md` |
| MQTT broker mTLS | ROADMAP-Q2 | Present crate supports it; device uplink currently user/pass per `src/mqtt.rs:203-237` | Closure = migrate broker leg to cert-is-identity per ADR-015 pattern |
| OTA firmware update (signed manifest, A/B partition) | PRESENT | `src/updater/` (error, manifest, partition, verify, mod), ADR-019 | → `deployment/ota.md` |
| OTA protocol documentation | ROADMAP-Q2 + ORPHAN-018 | Tracked in `sens-api-gateway/docs/reviews/orphan-findings.md#orphan-018` | Closure = deployment-runbook-writer delivery |
| License JWT (edge verify-only) | PRESENT (feature-gated) | `Cargo.toml:252` (`jsonwebtoken = "9"`), feature `license-enforce` (`Cargo.toml:392`), ADR-018 §2 | Algorithm pinned `EdDSA`; `default()` forbidden |
| Zeroize-on-drop secrets | PRESENT | `Cargo.toml:47, 293-296` (`secrecy`, `zeroize`) | IEC 62443 FR4 |
| Constant-time MIC + PIN compare | PRESENT | `Cargo.toml:291` (`subtle = "2"`) | |
| Modbus write allow-list (per-register) | PRESENT | `src/config.rs` validates explicit all-address acceptance or non-empty ranges; `src/modbus.rs` enforces ranges at write time | Empty write range no longer means implicit all-address writes |
| Modbus write routing correctness | FIXED-IN-CODE + ORPHAN-008 | `sens-api-gateway/docs/reviews/orphan-findings.md#orphan-008` | Writes route through named device lookup |
| Modbus analog-write truncation | ROADMAP-Q1 + ORPHAN-009 | `sens-api-gateway/docs/reviews/orphan-findings.md#orphan-009` | `reverse_scale(..) as u16` silent truncation — tracked |
| systemd hardening path divergence | ROADMAP-Q1 + ORPHAN-010 | `sens-api-gateway/docs/reviews/orphan-findings.md#orphan-010` | `/var/lib/suderra` vs `/var/lib/suderra-agent` |
| prctl / mlock / memfd_secret in-process hardening | PRESENT | `Cargo.toml:207` (`libc`), `src/keystore/` hardening path, ADR-019 §5 | |
| Structured journald logging (tracing layer) | PRESENT | `Cargo.toml:234` (`tracing-journald`), ADR-019 §5 | Forward-Secure Sealing-compatible |
| Device fingerprint (MAC SHA-256 pseudonymised) | PRESENT | `Cargo.toml:130` (`sha2 = "0.10"`) | GDPR / LOW-45 closure |
| SBOM (CycloneDX) | ROADMAP-Q2 | CI build pipeline | Owned by `compliance-evidence-writer` |
| CVD policy (ISO/IEC 30111) | ROADMAP-Q2 | Owned by `security-architecture-writer` | |

## H. Operations

| Feature | Status | Evidence | Cross-reference |
|---------|--------|----------|----------------|
| systemd service unit + watchdog + ready notify | PRESENT | `Cargo.toml:101` (`sd-notify = "0.4"`) | → `deployment/install.md` |
| Graceful shutdown coordinator | PRESENT | `src/shutdown.rs`, `docs/ARCHITECTURE.md` §6 | |
| Circuit breaker (Modbus) | PRESENT | `src/resilience/circuit_breaker.rs`, `docs/ARCHITECTURE.md` §2 | |
| Timeout wrappers (Modbus / Connect / GPIO) | PRESENT | `src/resilience/timeout.rs` | |
| Script execution limits (time / actions / depth / rate) | PRESENT | `src/scripting/limits.rs` | |
| Health check HTTP endpoint | PRESENT (feature-gated) | `Cargo.toml:299` (`axum = "0.8"`), feature `health` (`Cargo.toml:328`), `src/health.rs` | → `operations/health.md` |
| SCADA display server (local HMI / kiosk) | PRESENT (feature-gated) | feature `scada-display` (`Cargo.toml:338`), `src/scada_server.rs` (2 145 LOC), `src/scada_types.rs` | → `operations/scada-display.md` |
| Prometheus metrics | ROADMAP-Q3 | `Cargo.toml:310-311` crates present but unused (`metrics` feature flagged unused), `src/telemetry.rs` | Not yet wired |
| OpenTelemetry OTLP traces | PRESENT (feature-gated) | `Cargo.toml:304-307`, feature `telemetry` (`Cargo.toml:330`) | → `operations/observability.md` |
| System telemetry (CPU / mem / disk / temp) | PRESENT | `Cargo.toml:50` (`sysinfo = "0.33"`), `src/telemetry.rs` | |
| Calibration engine | PRESENT | `src/calibration_engine.rs` | |
| Hardware scanner (auto-discovery) | PRESENT | `src/hardware_scanner.rs` | |
| Runtime safety module | PRESENT | `src/runtime_safety/` | → `security/runtime-safety.md` |
| Deploy orchestrator (edge-side) | PRESENT | `src/deploy_orchestrator.rs` | → `deployment/orchestration.md` |

## I. Compliance & Industry posture

| Framework | Status | Evidence | Cross-reference |
|-----------|--------|----------|----------------|
| IEC 62443-4-1 SDLA | ROADMAP-Q3 | Evidence build owned by `compliance-evidence-writer` | Not certified — no claim made |
| IEC 62443-4-2 SL1 | ROADMAP-Q2 | Posture snapshot in this doc §5; FR1-FR7 gap table owned by `compliance-evidence-writer` | |
| IEC 62443-4-2 SL2 | ROADMAP-Q3/Q4 | Same | Not certified — no claim made |
| IEC 62443-4-2 SL3 | ROADMAP-tracked | ADR-023 (SL3 upgrade path) | Path-of-intent, not a promise |
| IEC 61131-3 ST language | PRESENT | `src/st_validator.rs` (3 551 LOC), ADR-017 | |
| IEC 61131-3 LD/FBD/SFC | NOT-PLANNED | ADR-017 §2 | ST-only product decision |
| ISA-18.2 alarm management | PRESENT (shape) / ROADMAP-Q3 (KPI evidence) | `src/alarm_engine.rs` | Owned by operations-sla-writer |
| ISO/IEC 30111 CVD policy | ROADMAP-Q2 | Owned by `security-architecture-writer` | |
| CE / UL / FCC / RED | HARDWARE-VENDOR RESPONSIBILITY (owner: SBC supplier, deadline: per customer contract) | — | Hardware marking is SBC-vendor responsibility; mapping owned by `compliance-evidence-writer` |
| GDPR / KVKK DPIA | ROADMAP-Q2 | SHA-256 MAC pseudonymisation PRESENT (`Cargo.toml:130`); DPIA doc owned by `compliance-evidence-writer` | |
| EU Cyber Resilience Act posture | ROADMAP-Q3 | Owned by `commercial-legal-writer` + `compliance-evidence-writer` | |
| Export control (ECCN classification) | ROADMAP-Q2 | Owned by `commercial-legal-writer` | Crypto-bearing — 5A002 likely |

## J. Release and build posture

| Feature | Status | Evidence | Notes |
|---------|--------|----------|-------|
| Rust edition 2024 / rustc 1.85 MSRV | PRESENT | `Cargo.toml:4-5` | |
| Release profile `opt-level=z`, LTO, panic=abort, strip | PRESENT | `Cargo.toml:421-426` | |
| Clippy deny-lints (unwrap, expect, indexing_slicing, todo, unimplemented, dbg, print_stdout/stderr) | PRESENT | `Cargo.toml:433-442` | |
| `unsafe_op_in_unsafe_fn = deny` | PRESENT | `Cargo.toml:445` | |
| `cargo-fuzz` targets (bytecode, envelope, policy, modbus parsers) | PRESENT | `Cargo.toml:12` `[workspace] exclude = ["fuzz"]`, test hints in `Cargo.toml:413-419` | Fuzz corpus owned by `test-evidence-writer` |
| Criterion + proptest benches | PRESENT | `Cargo.toml:418-419` | |
| Cross-compile aarch64 / armv7 | PRESENT | `docs/ARCHITECTURE.md` §Build Targets | |
| Default build = no security-escape features enabled | PRESENT (invariant-tested) | `Cargo.toml:317-325` + `tests/invariants/default_build_no_security_escape.rs` | HC-1 fleet backward-compat |
| Feature-OFF leaks no symbols (e.g. `opc-ua-server`) | PRESENT (invariant-tested) | `Cargo.toml:265-266` invariant note, `tests/invariants/feature_off_no_symbols.sh` | |

## K. Commercial / licensing

| Item | Status | Evidence | Cross-reference |
|------|--------|----------|----------------|
| Source-available / Proprietary | PRESENT | `Cargo.toml:8` (`license = "Proprietary"`) | → `commercial/license.md` (owned by `commercial-legal-writer`) |
| OSS attribution (dependencies) | ROADMAP-Q2 | Owned by `commercial-legal-writer` + SBOM pipeline | |
| Source-code escrow | ROADMAP-Q2 | Owned by `commercial-legal-writer` | |
| Indemnification terms | ROADMAP-Q2 | Owned by `commercial-legal-writer` | |

---

## Evidence

- `Cargo.toml` (root) — feature flags + dependency ledger
- `sens-api-gateway/src/**` — every PRESENT row resolves to a named file
- `sens-api-gateway/docs/ARCHITECTURE.md` — v1.3.0 architecture baseline
- `sens-api-gateway/docs/SCENARIOS_BEYOND_SCADA.md` — capability scenarios
- `docs/adr/017-st-bytecode-runtime.md`, `018-edge-rbac-abac-model.md`, `019-edge-firmware-signing-ab-partition.md`, `020-audit-log-hmac-chain.md`, `021-platform-key-ceremony-lifecycle.md`, `022-edge-schema-placement.md`, `023-sl3-upgrade-path.md`
- `docs/reviews/edge-expert/2026-04-05-s2-high-findings.md:141-198` — Modbus defense-in-depth status
- `docs/reviews/orphan-findings.md#ORPHAN-002`, `#ORPHAN-006`, `#ORPHAN-008`, `#ORPHAN-009`, `#ORPHAN-010`, `#ORPHAN-018` — tracked defects referenced above
