# Soak / Endurance Test — `sens-api-gateway`

**Source-of-Truth:** HEAD `3413db47`, v1.6.0, 2026-04-24.

## 1. Status: NO RUN EXECUTED — plan Q3 2026

- **No 1000 h soak has been executed against this crate.** The closest evidence in the tree is `tests/stress_test.rs`, which runs for 30 s by default (`StressConfig::duration_secs: 30`, defaulted in the `impl Default for StressConfig` block). That is a spike test, not an endurance test.
- **Owner:** edge-platform team (lead TBD).
- **Deadline:** Q3 2026 soak run on each HIL target; release-gate for v2.0.
- **Tracked as:** ORPHAN-EDGE-SOAK-001 ROADMAP.

## 2. Protocol

### 2.1 Duration

- **Target:** 1000 h continuous agent run per HIL target (Raspberry Pi 4, Raspberry Pi 5, RevPi Connect 4, Siemens IOT2050, x86 IPC).
- **Rationale:** 1000 h ≈ 42 days, the canonical industrial soak window. Shorter runs miss slow leaks (order of days) and monthly-cycle failures (log-rotation, cert near-expiry).

### 2.2 Workload

The soak workload is a mixed-protocol realistic production shape:

- MQTT publish: 1000 msg/s sustained, QoS 1, against `mosquitto` broker on a second SBC.
- MQTT subscribe: 100 command messages/hour with signed envelope; RBAC policy applied; ~5% rejected by authz (exercises the deny path).
- Modbus TCP read-loop: 50 devices × 20 registers × 1 Hz = 1000 reg/s against `rodbus::server` simulator.
- Modbus TCP write: 10 writes/minute with **readback-ACK** (once the code change lands — see [integration-tests.md](./integration-tests.md) §4).
- Audit chain append: on every command and on every authz decision, ~200 appends/s.
- Offline-queue: randomly induce broker disconnect for 5 min every 4 h — queue must drain on reconnect.
- OTA cycle: one OTA update per week (simulated at HTTP level by `wiremock`).

### 2.3 Metrics watched

| Metric | Acceptance | Source |
|---|---|---|
| **RSS growth** (memory leak) | < 5 % over 1000 h | `sysinfo` scrape every 60 s; pattern from `tests/resource_benchmark.rs` |
| **File-descriptor count** | < 50 steady, no monotonic growth | `/proc/<pid>/fd` count |
| **MQTT reconnect count** | ≤ induced-disconnect count (no spurious reconnects) | `src/mqtt.rs` telemetry counters |
| **Offline-queue high-water mark** | < 100 000 entries; drains fully on reconnect | SQLCipher size; cf. `src/offline_queue.rs` |
| **Panic count** | 0 | Process supervisor restart counter |
| **Watchdog miss count** | 0 | `src/runtime_safety/shutdown_phase.rs` telemetry |
| **Audit chain monotonicity** | No hash jumps, no duplicate JTI | `src/audit/chain.rs` + `src/command_envelope/jti.rs` |
| **CPU utilisation** | < 40 % steady-state on RPi 4 | `top` / `sysinfo` |
| **GPU / thermal** | Under 70 °C throttle line on RPi 4 | `vcgencmd measure_temp` |
| **Disk I/O** | < 10 MB/h steady-state | `iotop` |

### 2.4 Acceptance criteria (go / no-go)

All of the following must hold for a soak run to be declared PASS:

1. RSS growth < 5 % over 1000 h on every HIL target.
2. 0 panics logged at any point.
3. 0 watchdog misses logged at any point.
4. Offline-queue drains to 0 on every reconnect.
5. Audit chain is continuous and passes end-of-run verification.
6. No OTA run left the agent in an indeterminate partition state.
7. No command was silently dropped (tracked via end-to-end sequence numbers).

Any failure of the above triggers a root-cause analysis and a blocker on the next release.

## 3. Failure modes tracked

Historical failure-mode reference; each known mode has a unit test and a soak-level trigger.

| Failure mode | Unit test | Soak-level trigger |
|---|---|---|
| Broker network partition | `src/mqtt.rs` unit tests (10 across `src/mqtt_failover.rs` — gap, see [unit-tests.md](./unit-tests.md) §2) | Induced disconnect every 4 h |
| SQLCipher queue full | `src/offline_queue.rs` (10 tests) | Induce disconnect for 30 min to grow queue |
| Clock skew | `src/runtime_safety/clock.rs` (9 tests) | NTP jump every 24 h |
| Cert near-expiry | `src/mtls/pinning.rs` (10 tests) | Cert with 72 h validity; rotation during run |
| Log rotation | `src/telemetry.rs` (2 tests) | Rotate at 100 MB; soak exceeds rotation |
| OTA rollback | `src/updater/*.rs` (46 tests across manifest/verify/partition/error) | One OTA per week |
| Authz manifest reload | `src/authz/manifest.rs` (14 tests) | Manifest swap every 12 h |
| Audit chain rollover | `src/audit/chain.rs` (14 tests) + `src/audit/entry.rs` (25 tests) | Natural rollover within 1000 h |

## 4. Run cadence (once soak exists)

- **Per release candidate:** full 1000 h run on every HIL target.
- **Annual:** full 1000 h run on each SBC hardware revision.
- **Ad-hoc:** 168 h (1 week) spot-check on firmware changes to safety-critical paths.

## 5. Evidence links

- `tests/stress_test.rs` — 30 s stress harness (present; not a soak replacement).
- `tests/resource_benchmark.rs` — baseline memory measurement pattern.
- `src/runtime_safety/clock.rs` — monotonic-clock abstraction (9 unit tests).
- `src/runtime_safety/shutdown_phase.rs` — watchdog / shutdown state machine (11 unit tests).
- `src/offline_queue.rs` — SQLCipher queue (10 unit tests).
- `src/audit/chain.rs`, `src/audit/entry.rs` — audit chain append + verify (14 + 25 unit tests).
