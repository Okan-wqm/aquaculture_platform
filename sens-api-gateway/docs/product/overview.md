# sens-api-gateway — Product Overview

**Version:** 1.6.0 (`Cargo.toml:6`)
**Binary name:** `suderra-agent` (`Cargo.toml:448-449`)
**Target market:** industrial edge — aquaculture, general process industry, water utilities, controlled-environment agriculture
**Head commit at document freeze:** `3413db47` on `agentic-audit` (2026-04-24)
**Document owner:** `product-overview-writer` (Lane-C, see `.claude/agents/edge-docs/README.md`)
**Language:** English (Siemens-facing)

---

## 1. What it is (in three sentences)

sens-api-gateway is a pure-Rust industrial edge agent that runs on Linux SBCs (Raspberry Pi 4/5, Revolution Pi, x86 micro-servers) and sits between field-level instruments and the customer's cloud. It speaks the protocols a traditional SCADA HMI and a modern IIoT platform both expect on the same wire — Modbus-TCP/RTU, OPC UA 1.04, S7comm, EtherNet/IP, Beckhoff ADS, Codesys V3, MQTT, I2C, SPI, GPIO, PWM, Atlas EZO, optional LoRaWAN — while running an IEC 61131-3-style Structured Text bytecode VM for deterministic local control and an alarm engine with ISA-18.2-shaped states. The agent is built for environments where network loss must not stop a pond aerator: everything the device has done and signed gets replayed to the cloud when the link returns.

## 2. Value proposition

A Siemens procurement lead evaluating this product against an AWS Greengrass / Azure IoT Edge gateway or a MindConnect Nano should expect: protocol breadth comparable to a Red Lion FlexEdge, a deterministic control plane comparable to a Revolution Pi Core, a cryptographic chain-of-custody (signed commands, HMAC-chained audit log, Ed25519 per ADR-021) comparable to nothing in the hyperscaler edge catalogue. It is not a MindSphere replacement, not a Siemens PROFINET master, and not a PLC — it is the signed, auditable translator between them.

## 3. Target customer

| Segment | Primary pain solved |
|---------|---------------------|
| Aquaculture Tier-1 producer (>5000 t/yr) | Multi-site pond telemetry + compliance report submission + weather-adaptive feeding (see `docs/SCENARIOS_BEYOND_SCADA.md`) |
| Aquaculture Tier-2 RAS operator | Water-quality monitoring, Atlas EZO pH/DO/EC chain, feed-inventory reorder automation |
| Process-industry water treatment | Signed-command actuation on Modbus pumps + audit log for EPA/EU-UWWTD |
| Pharmaceutical cleanroom HVAC | Deterministic ST-bytecode alarm interlock with cloud-side analytics trail |
| Microalgae / controlled-environment ag | Electricity spot-price load shedding, harvest-date prediction, multi-reactor benchmarking |

## 4. Top five differentiators vs a generic IIoT gateway

1. **Signed command envelope + HMAC audit chain** — every mutating command from the cloud (`UpdateFirmware`, `DeployProgram`, `SafeStateTrigger`, `ForceValue`) carries an Ed25519 signature per ADR-018 §7; every audit entry is chained per ADR-020 §1. Evidence: `sens-api-gateway/src/command_envelope/envelope.rs`, `sens-api-gateway/src/audit/chain.rs`, `Cargo.toml:145` (`ed25519-dalek = "2.1"`).
2. **IEC 61131-3 ST bytecode VM on the device** — not a shim over PLC RPC. Deterministic scan cycle, gas-budgeted dispatch, formal Kani harness for `safe_state_reachable` + `rbac_non_bypass` + `gas_budget_saturating` (ADR-023 §8, `Cargo.toml:394-397`). Evidence: `sens-api-gateway/src/st_validator.rs` (3 551 lines), `sens-api-gateway/src/scripting/` (engine, scheduler, persistence, conflict detector).
3. **Cryptographic safe-state manager** — configurable output-tag safe values applied on shutdown or network loss (`src/safe_state.rs:76-130`) — not just a watchdog reboot.
4. **SBOM + reproducible Rust build** — `panic = "abort"`, LTO, `strip = true`, `unwrap_used = "deny"`, `expect_used = "deny"`, `indexing_slicing = "deny"` as Clippy deny-lints (`Cargo.toml:421-442`). Memory-safety posture matches IEC 62443-4-1 SR-5 expectations without a GC language footprint.
5. **Offline-first protocol fabric** — MQTT failover with offline queue (`src/mqtt_failover.rs`, `src/offline_queue.rs`), SQLCipher-encrypted local persistence (`Cargo.toml:94`, `bundled-sqlcipher-vendored-openssl`), zeroize-on-drop secret handling (`Cargo.toml:47, 293-296`).

## 5. Industry posture — honest snapshot

- **IEC 62443-4-1 SDLA:** evidence-building in progress. See `compliance/` chapter (owned by `compliance-evidence-writer`); this overview does **not** claim certification.
- **IEC 62443-4-2 Security Level:** SL1 features PRESENT; SL2 FR1-FR7 gap table is the compliance-evidence-writer's deliverable. This overview does **not** claim SL2 certified.
- **ISA-18.2 Alarm Management:** shape present in `src/alarm_engine.rs:61-245` (rules, states, acknowledge, active-count). KPI evidence (ALARM-PRIORITY-DIST, ALARM-FLOOD-RATE) is owned by `operations-sla-writer`.
- **IEC 61131-3 languages:** Structured Text (bytecode VM under `st-bytecode` feature, `Cargo.toml:367`); LD / FBD / SFC are labelled NOT-PLANNED in `feature-matrix.md`.
- **GDPR / KVKK:** MAC-address pseudonymisation via SHA-256 (`Cargo.toml:130`) and zeroize-on-drop secret discipline in place; DPIA is owned by `compliance-evidence-writer`.
- **Defense-in-depth on Modbus writes:** type-only today — the per-register allow-list is a struct field, runtime enforcement is ROADMAP-Q2 per `docs/reviews/edge-expert/2026-04-05-s2-high-findings.md` §S2-HIGH. This doc does **not** claim the runtime gate as live.
- **MQTT broker authentication:** username + password today (`src/mqtt.rs:203-237`), not mTLS. Migration to cert-is-identity is ROADMAP-Q2 tracked under the edge-expert finding set. The platform NATS fabric already runs mTLS-only (ADR-014, ADR-015) — that discipline is pending on the device-to-broker leg.
- **OPC UA stack:** handrolled surface at 5 787 lines (`src/plc_programming/opcua.rs`) built on the `opcua = "0.12"` crate (`Cargo.toml:266`). A hardened vendor stack (Unified Automation, Prosys) is a ROADMAP-Q3 decision per customer acceptance.

## 6. Quick-start pointer

- Provisioning + install: **Not covered here — see `deployment/install.md`** (owned by `deployment-runbook-writer`).
- Protocol-by-protocol reference: **Not covered here — see `protocols/*.md`** (owned by `protocol-reference-writer`).
- Threat model + crypto inventory: **Not covered here — see `security/threat-model.md`** (owned by `security-architecture-writer`).
- Siemens-specific integration (TIA Portal GSDML export, S7 area-code mapping, MindSphere connector): **Not covered here — see `integration/siemens/`** (owned by `siemens-integration-writer`).

## Evidence

- `Cargo.toml:6` — version `1.6.0`
- `Cargo.toml:15-296` — dependency ledger; every security-critical crate annotated with WHY/WHAT/INVARIANT
- `Cargo.toml:317-397` — feature-flag matrix mapped 1:1 to ADR phases (`signed-deploy`, `tpm`, `st-bytecode`, `multi-task-scheduler`, `opc-ua-server`, `live-debug`, `license-enforce`, `kani`)
- `Cargo.toml:421-442` — release profile + Clippy deny-lints
- `Cargo.toml:448-449` — binary `[[bin]]` `suderra-agent`
- `sens-api-gateway/src/command_envelope/envelope.rs` — signed command envelope
- `sens-api-gateway/src/audit/chain.rs` — HMAC audit chain
- `sens-api-gateway/src/safe_state.rs:76-130` — SafeStateManager
- `sens-api-gateway/src/alarm_engine.rs:61-245` — alarm engine surface
- `sens-api-gateway/src/plc_programming/opcua.rs` — OPC UA handrolled surface
- `sens-api-gateway/src/mqtt.rs:203-237` — MQTT credential path
- `sens-api-gateway/src/st_validator.rs` — ST bytecode validator
- `sens-api-gateway/docs/ARCHITECTURE.md` — version-tracked architecture record (v1.3.0 baseline)
- `sens-api-gateway/docs/SCENARIOS_BEYOND_SCADA.md` — 7 scenario catalogue
- `docs/adr/017-st-bytecode-runtime.md`, `018-edge-rbac-abac-model.md`, `019-edge-firmware-signing-ab-partition.md`, `020-audit-log-hmac-chain.md`, `021-platform-key-ceremony-lifecycle.md`, `022-edge-schema-placement.md`, `023-sl3-upgrade-path.md`
- `docs/reviews/edge-expert/2026-04-05-s2-high-findings.md:141-198` — Modbus defense-in-depth type-only status
- `docs/reviews/orphan-findings.md#ORPHAN-002` — rodbus 1.4 empty-Path pin; `#ORPHAN-018` — OTA documentation gap; `#ORPHAN-008`/`#ORPHAN-009` — Modbus write routing + truncation
