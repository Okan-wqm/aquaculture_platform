# EMC and Environmental Testing — `sens-api-gateway`

**Source-of-Truth:** HEAD `3413db47`, v1.6.0, 2026-04-24.

## 1. Status: HARDWARE-VENDOR RESPONSIBILITY

EMC (electromagnetic compatibility) and environmental (temperature, humidity, vibration, shock) compliance are properties of the physical enclosure and the SBC / IPC choice. The `sens-api-gateway` crate is a firmware payload; it runs on whichever SBC the customer deploys (Raspberry Pi 4 / 5, Kunbus RevPi Connect 4, Siemens SIMATIC IOT2050, or an x86 industrial PC). Consequently:

- **Owner:** SBC supplier (RevPi / Raspberry Pi Foundation / Siemens Industry / the customer's chosen hardware vendor).
- **Deadline:** per customer contract — compliance evidence is delivered by the SBC vendor as part of their CE / UL / FCC declaration for the end product that embeds this firmware.
- **Tracked as:** ORPHAN-EDGE-EMC-001 ROADMAP.

This chapter documents (a) the standards the downstream hardware must satisfy, (b) the firmware-level behaviour the hardware test will observe, and (c) the acceptance criteria for the firmware under test.

## 2. Standards — environmental (IEC 60068 family)

Each SBC vendor typically provides evidence against a subset. The minimum set for an industrial OT deployment:

| Standard | Test | Condition |
|---|---|---|
| IEC 60068-2-1 | Cold | −25 °C for 16 h; firmware must boot after warm-up |
| IEC 60068-2-2 | Dry heat | +70 °C for 16 h; firmware stable |
| IEC 60068-2-6 | Sinusoidal vibration | 10–150 Hz, 1 g, 10 sweeps/axis; no panic |
| IEC 60068-2-27 | Shock | 15 g, 11 ms half-sine, 3 shocks/axis; no panic |
| IEC 60068-2-30 | Damp heat, cyclic | 25–55 °C, 95 % RH, 6 cycles; no data loss |
| IEC 60068-2-64 | Random vibration | 10–500 Hz, 0.04 g²/Hz, 1 h/axis; no panic |

## 3. Standards — EMC (IEC 61000-4 family)

| Standard | Test | Level (Industrial Zone B) |
|---|---|---|
| IEC 61000-4-2 | ESD | ±8 kV contact, ±15 kV air |
| IEC 61000-4-3 | Radiated RF immunity | 10 V/m, 80 MHz–6 GHz |
| IEC 61000-4-4 | Electrical fast transient / burst | ±2 kV on power, ±1 kV on signal |
| IEC 61000-4-5 | Surge | ±2 kV line-to-line, ±4 kV line-to-earth |
| IEC 61000-4-6 | Conducted RF immunity | 10 Vrms, 150 kHz–80 MHz |
| IEC 61000-4-8 | Power-frequency magnetic field | 100 A/m, 50 Hz |
| IEC 61000-4-11 | Voltage dips / short interruptions | 0 % for 1 cycle, 40 % for 10 cycles |

## 4. Regulatory declaration

- **CE marking:** SBC supplier's responsibility. Firmware-side compliance documentation is delivered by the supplier as part of their Declaration of Conformity.
- **UL listing:** SBC supplier's responsibility. Firmware does not affect UL classification.
- **FCC Part 15:** SBC supplier's responsibility.
- **RED (Radio Equipment Directive, EU 2014/53/EU):** SBC supplier's responsibility where the deployment includes LoRaWAN (see `src/lora/*`); firmware-side compliance is reflected in the LoRaWAN-stack conformance (which we do validate at integration level — see [integration-tests.md](./integration-tests.md)).

## 5. Firmware behaviour under test

The firmware-level claims the hardware-vendor test must observe:

| Claim | Evidence source |
|---|---|
| Watchdog-recovery time after EFT/burst induced panic: < 30 s | `src/runtime_safety/shutdown_phase.rs` (11 unit tests) + HIL scenario 9 |
| Graceful shutdown on brown-out: safe-state engaged | `src/safe_state_v2.rs` (24 unit tests) + HIL scenario 11 |
| SQLCipher offline queue intact across power cycle | `src/offline_queue.rs` (10 unit tests) + HIL scenario 10 |
| Audit chain monotonic across temperature excursions | `src/audit/chain.rs` (14 unit tests) + HIL scenario 12 |
| MQTT reconnect after RF-induced link flap | `src/mqtt_failover.rs` + HIL scenario 2 |

## 6. Acceptance criteria — firmware-side

For each hardware test pass, the firmware must:

1. Boot to healthy within 30 s of power-on restoration.
2. Produce no panic log entries across the environmental cycle.
3. Drain any offline queue accumulated during the test.
4. Preserve audit-chain monotonicity (end-of-test chain-verify passes).
5. Maintain Modbus / MQTT mean latency within ±20 % of the pre-test baseline.

## 7. Run cadence

- **Per new SBC target:** full IEC 60068 + IEC 61000-4 set, commissioned from a certified EMC lab by the SBC supplier.
- **Per major firmware release:** firmware-side acceptance re-run on the reference SBC, not a full EMC re-run.

## 8. Evidence links

- `src/runtime_safety/shutdown_phase.rs` — watchdog state machine.
- `src/safe_state_v2.rs` — safe-state transitions.
- `src/offline_queue.rs` — SQLCipher queue persistence.
- `src/audit/chain.rs` — audit chain HMAC.
- `src/mqtt_failover.rs` — broker failover.
- [hil-rig.md](./hil-rig.md) — scenarios 9 / 10 / 11 / 12 observe the behaviours above.
