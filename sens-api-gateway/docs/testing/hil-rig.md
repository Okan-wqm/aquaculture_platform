# Hardware-in-the-Loop (HIL) Rig — `sens-api-gateway`

**Source-of-Truth:** HEAD `3413db47`, v1.6.0, 2026-04-24.

## 1. Status: NO COVERAGE — plan Q3 2026

- **No HIL rig exists in production today.** Every protocol claim in the integration chapter is validated by code-level mocks (`rumqttd`, `rodbus::server`, `wiremock`), not by real SBCs talking to real PLCs.
- **Owner:** edge-platform team (lead TBD).
- **Deadline:** Q3 2026, ahead of the IEC 62443 SL2 certification window (Q4 2026).
- **Budget:** capital + per-quarter consumables (sensors, cabling, test PLCs). Detailed BoM in §3.
- **Tracked as:** ORPHAN-EDGE-HIL-001 ROADMAP.

The IEC 62443-4-1 SVV clauses that require HIL coverage (SVV-3 through SVV-5) are currently documented as "plan Q3" in the compliance chapter — closure is the Q3 HIL rig acceptance test.

## 2. Hardware target list (what the rig must exercise)

The agent binary supports the following SBCs and IPCs. The HIL rig must cover each with at least one positive flow.

| Target | Class | Why it matters |
|---|---|---|
| Raspberry Pi 4 Model B (4 GB) | Low-cost SBC | Baseline; community hardware |
| Raspberry Pi 5 (8 GB) | Next-gen SBC | Performance ceiling reference |
| Kunbus RevPi Connect 4 | Industrial SBC | Siemens partner / OT deployment |
| Siemens SIMATIC IOT2050 | Industrial gateway | Siemens-specific partnership |
| x86 IPC (Intel NUC class) | High-end | Data-centre / on-prem variant |

## 3. Peripheral simulators

- **Modbus TCP/RTU server:** `libmodbus` server binary + `DSIM` PLC simulator; or the `rodbus::server` harness running on a second SBC.
- **OPC UA server:** Prosys OPC UA Simulation Server (reference), `open62541` server (OSS), or UA Expert test server.
- **S7 PLC simulator:** Siemens PLCSIM Advanced (licensed) or `snap7` `server` component.
- **EtherNet/IP CIP responder:** Rockwell `RSLogix Emulate` (licensed) or OSS CIP responder.
- **LoRaWAN:** SX1302 reference concentrator (Semtech SX1302 + RPi HAT) + real LoRaWAN sensor node (e.g., Dragino LHT65).
- **MQTT broker:** `mosquitto` in-process (matches production posture).
- **I2C peripherals:** Atlas Scientific EZO pH, EC, DO probes on a real I2C bus.
- **GPIO:** test board with LEDs, relays, digital inputs — exercises `src/gpio.rs`, `src/pwm.rs`.
- **Power:** test bench PSU with programmable rails — exercises the watchdog path under brown-out.

## 4. Coverage scenarios (what the rig must prove)

Each scenario has an acceptance criterion. Failure to meet the criterion is a release blocker.

| # | Scenario | Acceptance |
|---|---|---|
| 1 | Cold boot on each target SBC, agent reaches `healthy` state | < 30 s from power-on to MQTT handshake |
| 2 | MQTT broker disconnect, reconnect, offline-queue drains | No messages lost; queue sized < 10 000 |
| 3 | Modbus TCP read-loop against real PLC for 1 h | 0 decode errors, p99 latency < 100 ms |
| 4 | Modbus write command end-to-end with **readback-ACK** | Write ACKed only after register readback matches; mismatch raises audit entry |
| 5 | OPC UA subscribe over mTLS, 1 h | 0 reconnect, 0 decode errors |
| 6 | S7 DB read/write | Round-trip < 200 ms on RevPi |
| 7 | LoRa sensor reception, payload decode, MQTT publish | < 1% frame loss over 24 h |
| 8 | OTA firmware update, A/B switch | Rollback on watchdog miss within 60 s |
| 9 | Watchdog recovery after induced panic in a worker task | Agent restart within 10 s; audit chain intact |
| 10 | Power cycle (hard cut) during write operation | No SQLCipher queue corruption on restart |
| 11 | Brown-out (rail drop to 3.3 V) during operation | Graceful shutdown, safe-state engaged |
| 12 | Clock-skew injection (NTP jump) during audit-chain append | Chain monotonic; no duplicate JTI acceptance |
| 13 | mTLS cert-rotation over MQTT | Zero dropped commands during rotation window |
| 14 | SCADA deploy (`src/deploy_orchestrator.rs`) against real edge | Deploy, rollback, verify |
| 15 | Atlas EZO I2C probe, calibration, measurement loop | Readings within probe spec ±5% |

## 5. Run frequency

- Per release candidate: full set of 15 scenarios.
- Weekly (once rig lives): scenarios 1–3, 8, 11 — fast smoke.
- Per firmware change to safety-critical paths (`src/safe_state_v2.rs`, `src/alarm_engine.rs`): scenarios 4, 9, 11, 12.

## 6. Data capture

- Every HIL run publishes a structured report: scenarios passed, failed, metrics (latency p50/p99, RSS, CPU%).
- Prometheus scrape into a long-lived time-series DB.
- Artefact attached to the release tag: `sens-api-gateway-vX.Y.Z-hil-report.json`.

## 7. Evidence links (source-side primitives that the rig exercises)

- `src/hardware_scanner.rs` — hardware probe path (10 unit tests); HIL confirms the probe against real devices.
- `src/modbus.rs` — Modbus client (11 unit tests, `rodbus = "=1.4.0"` pinned at `Cargo.toml:70`).
- `src/plc_programming/s7comm.rs` — S7 client (11 unit tests).
- `src/plc_programming/ethernet_ip.rs` — CIP client (13 unit tests).
- `src/plc_programming/opcua.rs` — OPC UA client (45 unit tests).
- `src/lora/*.rs` — LoRaWAN stack (MAC 9, codec 15, session 12, crypto 7, types 5 unit tests).
- `src/deploy_orchestrator.rs` — SCADA deploy (9 unit tests).
- `src/safe_state_v2.rs` — safe-state transitions (24 unit tests).
- `src/updater/*.rs` — OTA A/B (manifest 20, verify 14, partition 8, error 4 unit tests).
