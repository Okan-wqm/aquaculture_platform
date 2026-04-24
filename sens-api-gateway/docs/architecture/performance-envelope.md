# Performance Envelope — Resource Budgets and Operating Targets

**Document version:** 1.0
**SoT:** HEAD `3413db47`, `suderra-agent` v1.6.0 (`Cargo.toml:3`)
**Date:** 2026-04-24
**Owner:** architecture-writer (Lane-C)

## Purpose

This chapter is the operating-budget reference for the `suderra-agent` edge gateway. It answers:

- What hardware class is the agent designed for?
- What CPU / RAM / disk / network envelope should an integrator size for?
- What throughput (tag reads per second, MQTT publishes per second) can one agent sustain?
- What latency budget applies to life-safety operations (safe-state apply, watchdog heartbeat, alarm publish)?

The discipline for this chapter is explicit: **every number is labelled as `MEASURED` (with source), `TARGET` (design budget with owning constraint), or `NOT MEASURED` (with the finding ID that tracks when the benchmark harness lands).** Where a benchmark harness does not yet exist, the row is marked `NOT MEASURED — benchmark harness pending (ORPHAN-EDGE-012). benches/ not present at HEAD 3413db47; tracked for ROADMAP-Q3.`

Not covered here — alarm-rule KPIs (ISA-18.2) live in `operations/`; EMC / environmental envelopes (IEC 60068 / IEC 61000-4) live in `testing/` (`test-evidence-writer`); SLA percentiles consumed by operations are derived from this document's budgets.

## Target hardware classes

The agent is designed for three hardware classes. Not every class is suitable for every feature-set.

| Class | Representative SKU | CPU | RAM | Storage | Network | Supported feature set |
|---|---|---|---|---|---|---|
| **EdgeLite** | Raspberry Pi 4B 4 GB | ARM Cortex-A72 4-core @ 1.5 GHz | 4 GB LPDDR4 | 32 GB microSD (class A2) | 1 GbE + Wi-Fi 802.11ac | default + `gpio` + `health`; `scada-display` possible; `lorawan` with SX1302 HAT; `tpm` FALSE unless external TPM attached (falls back to Tier 2/3 keystore) |
| **EdgeStandard** (reference) | Raspberry Pi 5 8 GB + Optiga SLM TPM | ARM Cortex-A76 4-core @ 2.4 GHz | 8 GB LPDDR4X | 64 GB microSD or NVMe | 1 GbE | full feature matrix including `tpm` Tier 1, `scada-display`, `lorawan`, `opc-ua-server`, `telemetry`, `signed-deploy` |
| **EdgePro** | Revolution Pi Connect 4 + TPM 2.0 | Intel / ARM variant per model | 8 GB | 32 GB eMMC (industrial) + microSD slot | 2× 1 GbE + RS-485 + RS-232 | full feature matrix; preferred for SL2+ deployments per ADR-023 (SL-3 opt-in) |

Build targets map to these classes as follows (`docs/ARCHITECTURE.md:387-394`):

- `aarch64-unknown-linux-gnu` → EdgeLite (RPi 4) and EdgeStandard (RPi 5)
- `armv7-unknown-linux-gnueabihf` → legacy RPi 3
- `x86_64-unknown-linux-gnu` → EdgePro (Intel variants) + dev VMs

## Tokio runtime budget (hardware-independent)

The agent is explicitly tuned for edge hardware, not for server-class machines. The runtime parameters are compile-time fixed in `src/main.rs:471-477`.

| Parameter | Value | Rationale |
|---|---|---|
| Worker threads | 2 | Edge devices in the EdgeLite class have 4 cores; leaving 2 cores for OS / script engine LocalSet / logging is practical. |
| Max blocking threads | 8 | Upper bound on concurrent SQLite blocking ops (RETAIN DB + SCADA DB + offline queue + backup). |
| Thread stack size | 128 KB | Embedded-friendly; default Tokio stack (2 MB) would exhaust RAM on EdgeLite with 20+ tasks. |
| `LocalSet` | 1 | Hosts non-Send drivers (rodbus 1.4 Modbus client). |

These values are **load-bearing for the RAM budget** — they put a hard ceiling on thread-side memory usage (worker + blocking × 128 KB ≈ 1.3 MB stack overhead).

## Resource budgets — targets (TARGET) and measurements (MEASURED / NOT MEASURED)

### CPU

| Condition | Budget | State | Source |
|---|---|---|---|
| Idle (no scripts, 10 Modbus registers, 30 s telemetry cadence, no SCADA) | < 3 % of 1 core | TARGET | Implied by Tokio "2 worker threads" choice + script engine off (`src/main.rs:471-477`) |
| Nominal (50 tags @ 1 Hz poll, 20 scripts, SCADA HMI with 1 client, alarm eval every cycle) | < 25 % of 1 core sustained | TARGET | NOT MEASURED — benchmark harness pending (ORPHAN-EDGE-012) |
| Burst (deploy a 200-FB ST program, hardware scanner run) | < 80 % of 1 core for < 5 s | TARGET | NOT MEASURED — benchmark harness pending |
| Script execution per run | ≤ `max_execution_time_ms` (default 5 000 ms, `src/main.rs:220-223`) | TARGET — enforced | `src/scripting/limits.rs` |

### RAM (Resident Set Size)

| Condition | Budget | State | Source |
|---|---|---|---|
| Binary size on disk | < 15 MB stripped with `profile.release { opt-level = "z"; lto = true; codegen-units = 1; panic = "abort"; strip = true }` | TARGET | `Cargo.toml:421-426` |
| Idle RSS | < 60 MB | TARGET | Tokio 2-worker + 8 blocking × 128 KB stacks + interning table + tag table |
| Nominal RSS (SCADA off) | < 120 MB | TARGET | NOT MEASURED — benchmark harness pending (ORPHAN-EDGE-012) |
| Nominal RSS (SCADA on, 1 HMI client) | < 200 MB | TARGET | NOT MEASURED |
| Peak RSS (LoRaWAN + SCADA + TPM + signed-deploy + 200 FB ST program) | < 400 MB | TARGET | NOT MEASURED |
| Master-key material | `mlock`-ed; never swappable | TARGET — `Cargo.toml:207` libc for mlock; runtime wiring Faz 2 Sprint 6.3 | ADR-019 §5 |

### Disk — storage footprint

| Store | Idle size | Growth rate | Cap | Source |
|---|---|---|---|---|
| `suderra-agent` binary | < 15 MB | 0 | — | `Cargo.toml:421-426` |
| `/etc/suderra/config.yaml` | < 8 KB | operator-driven | — | — |
| `/etc/suderra/certs/` | < 16 KB | rotation-driven | — | — |
| `/etc/suderra/scripts/` | per-script KB | operator-driven | — | — |
| `/var/lib/suderra/retain.db` (SQLCipher) | KB at first boot | per-FB-state + per-RETAIN-variable | bounded by FB count; vacuum on shutdown (`src/main.rs:1397-1412`) | `Cargo.toml:94` |
| `/var/lib/suderra/scada/scada.db` (feature scada-display) | KB at first boot | trend samples + alarm history | bounded by trend-retention config | `src/scada_db.rs`, `src/trend_engine.rs` |
| `/var/lib/suderra/offline_queue.db` (WAL) | 0 when online | MB/hour when offline depending on telemetry rate | disk-cap + oldest-low-priority eviction | `src/offline_queue.rs` |
| `/var/lib/suderra/backups/` | 0 | per-backup schedule (gzip compressed) | operator-configured | `Cargo.toml:110`, `src/backup.rs` |
| Audit chain local store | KB at first boot | per-entry (ADR-020 §10a retention) | 7-year retention per ADR-020 §10a | ADR-020 |
| journald | systemd-managed | per-event | operator-configured (journalctl --vacuum-size) | `Cargo.toml:234` tracing-journald |

### Network — throughput

| Direction | Condition | Budget | State | Source |
|---|---|---|---|---|
| Edge → Cloud MQTT (telemetry) | 50 tags, 30 s cadence, JSON | < 5 KB/s sustained | TARGET | NOT MEASURED — benchmark harness pending (ORPHAN-EDGE-012) |
| Edge → Cloud MQTT (commands return) | reply-per-command | < 1 KB/s | TARGET | NOT MEASURED |
| Edge ↔ Cloud MQTT (TLS overhead) | per-message | ~100 bytes TLS framing / message | TARGET | TLS 1.2+ ChaCha20-Poly1305 or AES-GCM |
| Edge → OTLP collector (feature telemetry, sample ratio 1.0) | per-span | ~400 bytes/span | TARGET | NOT MEASURED |
| Edge ↔ LAN HMI (feature scada-display, WebSocket live stream) | 1 client, 50 tags @ 1 Hz | < 50 KB/s | TARGET | NOT MEASURED |

### Tag / IO throughput

| Operation | Budget | State | Source |
|---|---|---|---|
| Modbus-TCP read cycle (10 registers, 1 device, local LAN) | < 50 ms round-trip | TARGET | implied by circuit-breaker 5 s timeout; well above actual |
| Modbus-TCP read cycle (10 registers, 5 devices, parallel) | < 150 ms | TARGET — `read_all_parallel()` | `src/main.rs:1593` |
| io_poll tick | 1 Hz default | TARGET — configurable via `scan_cycle_ms` (`src/main.rs:219`) | `src/io_poll.rs` |
| Tag ingestion to process image | < 1 ms per tag | TARGET | in-memory RwLock write |
| Tags sustained per agent (mixed Modbus/GPIO/I2C at 1 Hz) | ~500 tags at default profile | TARGET | NOT MEASURED — benchmark harness pending (ORPHAN-EDGE-012) |
| MQTT publishes per second (sustained, QoS 1, single broker) | ~100 pub/s | TARGET — rumqttc in-flight cap default 100 | NOT MEASURED |

### Latency — life-safety budgets

| Operation | Budget | State | Source |
|---|---|---|---|
| systemd watchdog heartbeat | every `WatchdogSec / 2` (µs-granular) | TARGET — ENFORCED | `src/main.rs:665-709` |
| Safe-state apply per output (Modbus coil / GPIO pin) | < 50 ms | TARGET | NOT MEASURED — benchmark harness pending |
| Safe-state apply total (boot, 20 outputs) | < 1 s | TARGET | bound by `MODBUS_TIMEOUT=5 s` per op; with parallelism achievable |
| Safe-state apply total (shutdown, 20 outputs, degraded bus) | < 5 s | TARGET | `src/main.rs:1414-1430` runs inside 30 s shutdown budget |
| Alarm MQTT publish latency (process-image-change → broker PUBACK, nominal) | < 500 ms p99 | TARGET | NOT MEASURED — benchmark harness pending |
| Boot time, first-provisioned device (cold start to MQTT connected) | < 30 s (network-dependent) | TARGET | implied by 5-attempt activation with exponential backoff 10–160 s; happy path first attempt |
| Shutdown total budget | 30 s (`SHUTDOWN_TIMEOUT_SECS` in `src/main.rs:890`) | TARGET — ENFORCED | `src/main.rs:890`, `:1389-1394` |

### Script engine limits — runtime-enforced

Every number in this block is **MEASURED / ENFORCED at runtime** — exceeding these causes the script to be aborted and logged, not just observed.

| Limit | Default value | Source |
|---|---|---|
| Max execution time per script run | 5 000 ms (`max_execution_time_ms`) | `src/main.rs:222`, `src/scripting/limits.rs` |
| Max actions per run | 100 (`max_actions_per_run`) | `src/main.rs:223` |
| Max call depth | 10 (`max_call_depth`, infinite-loop protection) | `src/main.rs:221`, `docs/ARCHITECTURE.md:159` |
| Rate limit per script | 60 runs/minute (default) | `src/scripting/limits.rs`, `docs/ARCHITECTURE.md:175-181` |
| Max delay inside script | 60 000 ms (`max_delay_ms`) | `docs/ARCHITECTURE.md:161` |
| Circuit breaker failure threshold (Modbus) | 3 | `docs/ARCHITECTURE.md:131-133` |
| Circuit breaker recovery timeout (Modbus) | 30 s | `docs/ARCHITECTURE.md:131-133` |
| Modbus operation timeout | 5 s (`MODBUS_TIMEOUT`) | `docs/ARCHITECTURE.md:140` |
| Modbus connect timeout | 10 s (`CONNECT_TIMEOUT`) | `docs/ARCHITECTURE.md:141` |
| GPIO operation timeout | 5 s (`GPIO_TIMEOUT`) | `docs/ARCHITECTURE.md:142` |

## MEASURED — what has actually been observed

Today, the MEASURED column is thin because the `benches/` directory is not present at HEAD `3413db47`. A confirmation:

```bash
$ ls sens-api-gateway/benches/  # at HEAD 3413db47
# (directory does not exist)
```

Adjacent test infrastructure that does exist:

| Path | Role |
|---|---|
| `tests/resource_benchmark.rs` | Standalone test — not a criterion bench. Treated as scaffold. |
| `tests/stress_test.rs` | Standalone test — not a criterion bench. Treated as scaffold. |
| `fuzz/fuzz_targets/config_parse.rs`, `modbus_response.rs`, `mqtt_payload.rs` | cargo-fuzz targets — correctness / robustness, not throughput. |

The `Cargo.toml:417-419` already declares `criterion` + `proptest` as `dev-dependencies` and explicitly notes the intended use: "criterion = microbenchmark framework … CI uses ±10% regression gate (Plan §9 Faz 9)". The gap is the `benches/` harness itself. **The gap is tracked as ORPHAN-EDGE-012.**

## TARGET rationale — why each budget is what it is

- **CPU idle budget (< 3 % / core):** The agent must share a device with a browser-based HMI (`scada-display`), a LoRaWAN concentrator driver, and the Linux OS. Anything more than 3 % at idle starves the HMI's render loop on EdgeLite.
- **Binary size (< 15 MB):** Edge firmware updates travel over rural MQTT-cellular links (ADR-019 partition strategy). The A/B partition budget (ADR-019 §3) assumes < 32 MB per slot including overlay; a 15 MB binary leaves headroom for config + certs + scripts within the same partition.
- **Idle RSS (< 60 MB):** OS + SSH + systemd + journald + HMI kiosk already account for 200–400 MB on EdgeLite's 4 GB. The agent's idle budget is 60 MB so there is room for the script engine's peak (+ 100 MB) without touching swap. Swap on SD card is a practical no-go (wear + latency).
- **Shutdown 30 s:** systemd's default `TimeoutStopSec=90s` is the backstop; 30 s is our internal budget so systemd never has to SIGKILL. This gates the safe-state apply + offline queue checkpoint + MQTT disconnect.
- **Script max execution time 5 s:** Aquaculture control loops target sub-second response; a script that takes more than 5 s is almost certainly stuck. The limit doubles as infinite-loop protection alongside `max_call_depth=10`.
- **Master-key mlock:** Master key derived from TPM / systemd-creds / passphrase per ADR-019 §7 must not end up in a swap partition snapshot. mlock + prctl(PR_SET_DUMPABLE, 0) are the architectural defense.

## Benchmark gap — ORPHAN-EDGE-012

| Field | Value |
|---|---|
| Finding ID | ORPHAN-EDGE-012 |
| Classification | Process gap (not a runtime defect) |
| Description | Performance envelope targets are unmeasured. No `sens-api-gateway/benches/` exists. `tests/resource_benchmark.rs` and `tests/stress_test.rs` are standalone tests, not criterion benches, and do not produce regression-gated JSON output. |
| Impact | Every TARGET row above is a design intent, not a field-verified number. A Siemens reviewer asking "what's the sustained MQTT publish rate?" cannot be given a measurement today. |
| Resolution plan | Build a `benches/` harness with criterion harness + ±10% regression gate (Plan §9 Faz 9, already scoped in `Cargo.toml:417-419` comment block). First three benches to land: (a) offline-queue append + drain, (b) audit-chain HMAC append, (c) ST bytecode dispatch (under `st-bytecode` feature). |
| Owner | edge-platform team |
| Target milestone | ROADMAP-Q3 |
| Consequence of miss | Operations SLA (`operations-sla-writer`) cannot commit to percentile latencies; Siemens VAQ for "throughput" remains a qualitative answer. |

## Observability surface for these budgets

The metrics that would report these numbers at runtime are published through these channels (when features are enabled):

- **sysinfo-driven TelemetryMessage** (`src/telemetry.rs`): cpu, memory, disk, temperature — at `telemetry.interval_seconds` (default 30 s).
- **OTLP traces** (feature `telemetry`, `Cargo.toml:330`): spans for I/O calls, script runs, command dispatches. Sample ratio operator-configured.
- **Prometheus metrics** (feature `metrics`, `Cargo.toml:333`): retained for future observability integration; not live in default builds.
- **Offline queue stats** (`QueueStats`, `src/offline_queue.rs`): count, oldest age, disk bytes — surfaced via health endpoint.
- **Script engine stats** (`ScanCycleStats`, `src/scripting/engine.rs`): per-cycle execution count, duration, conflict count.
- **journald structured logs** (`Cargo.toml:234`): every lifecycle event, hardware init, safe-state apply count, shutdown phase transition.

## Evidence

- `sens-api-gateway/Cargo.toml:3` (version), `:70` (rodbus pin), `:94` (SQLCipher), `:110` (flate2 gzip), `:207` (libc for mlock), `:234` (tracing-journald), `:310-311` (Prometheus metrics deps, feature), `:417-419` (criterion + proptest), `:421-426` (release profile)
- `sens-api-gateway/src/main.rs:471-477` (Tokio runtime parameters), `:559` (`LocalSet`), `:665-709` (systemd watchdog heartbeat), `:890` (shutdown timeout), `:1118-1151` (boot safe-state), `:1414-1430` (shutdown safe-state), `:1432-1447` (offline queue checkpoint), `:1499-1502` (offline status publish)
- `sens-api-gateway/src/scripting/engine.rs` (ExecutionResult, ScanCycleStats types)
- `sens-api-gateway/src/scripting/limits.rs` (limit enforcement types)
- `sens-api-gateway/src/offline_queue.rs` (QueueStats)
- `sens-api-gateway/src/resilience/circuit_breaker.rs`, `timeout.rs`, `rate_limiter.rs`
- `sens-api-gateway/docs/ARCHITECTURE.md:109-181` (circuit breaker + script limits constants), `:387-394` (build targets)
- `sens-api-gateway/tests/resource_benchmark.rs`, `tests/stress_test.rs` (existing scaffolds — not a bench harness)
- `sens-api-gateway/fuzz/fuzz_targets/config_parse.rs`, `modbus_response.rs`, `mqtt_payload.rs` (cargo-fuzz targets — correctness)
- `docs/adr/019-edge-firmware-signing-ab-partition.md` §5 (in-process hardening + mlock), §7 (keystore tier hierarchy)
- `docs/adr/020-audit-log-hmac-chain.md` §8 (performance bench gate plan), §10a (retention target)

Not covered here — alarm / observability SLA definitions (`operations-sla-writer`); EMC environmental envelopes (`test-evidence-writer`); air-gap deployment's bandwidth envelope (`deployment-runbook-writer`).
