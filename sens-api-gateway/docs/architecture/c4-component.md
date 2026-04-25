# C4 Level 3 — Component View

**Document version:** 1.0
**SoT:** HEAD `3413db47`, `suderra-agent` v1.6.0 (`Cargo.toml:3`)
**Date:** 2026-04-24
**Owner:** architecture-writer (Lane-C)

## Purpose

Level 3 zooms inside the single-process container from `c4-container.md` and names the Rust **modules** (files and submodule directories) that implement each container, plus the interactions between them. At this level we may name `struct`, `trait`, and module-path identifiers; we **still do not** name individual functions — that is reserved for `c4-code.md` (Level 4).

Because the Suderra Edge Gateway is a single process, Level 3 is a view inside the `suderra-agent` OS process. We split the view into seven component clusters so each fits on one screen and has a coherent theme. Every module named here has been grep-verified against `src/` at HEAD.

## Diagram 1 — Bootstrap, shutdown, and life-safety cluster

```mermaid
C4Component
    title Component view — Bootstrap, shutdown, life-safety

    Container_Ext(systemd, "systemd unit", "ExecStart=/usr/local/bin/suderra-agent")
    Container_Ext(cloudApi, "Cloud Provisioning API")
    Container_Ext(cloudMqtt, "Cloud MQTT broker")
    Container_Ext(fieldIO, "Field I/O (Modbus/GPIO/I2C)")

    Component(mainRs, "main.rs", "Rust entrypoint", "main() + async_main() + run_agent(). Owns Tokio runtime build, LocalSet, signal handler registration.")
    Component(configMod, "config", "src/config.rs", "AgentConfig, load(), save(), validate(); SIGHUP reload path.")
    Component(provisioningMod, "provisioning", "src/provisioning.rs", "ProvisioningClient — activate() and self_register() against the cloud REST API.")
    Component(shutdownMod, "shutdown", "src/shutdown.rs", "ShutdownCoordinator — broadcast + JoinHandle registry + timeout drain.")
    Component(safeStateMod, "safe_state (v1 runtime)", "src/safe_state.rs", "SafeStateManager — drives Modbus coils, GPIO pins, I2C addresses to fail-safe on boot + shutdown.")
    Component(safeStateV2Mod, "safe_state_v2 (types pre-staged)", "src/safe_state_v2.rs", "ADR-024 §3 FailSafe enum, OutputTag v2, DiversityClass, HardwiredSafetyOverride.")
    Component(healthMod, "health (feature health)", "src/health.rs", "sd_notify READY=1 + WATCHDOG=1 ping + HTTP liveness endpoint.")
    Component(runtimeSafetyMod, "runtime_safety (types pre-staged)", "src/runtime_safety/ — clock, retained_msg, shutdown_phase", "Plan D-7/D-14/D-15 types: ClockAuthority trait, retained-msg guard, ShutdownPhase state machine.")

    Rel(systemd, mainRs, "ExecStart + SIGTERM + SIGHUP", "fork/exec + POSIX signals")
    Rel(mainRs, configMod, "load config, validate, SIGHUP reload", "call")
    Rel(mainRs, provisioningMod, "activate / self_register when creds missing", "call")
    Rel(provisioningMod, cloudApi, "activate / self_register", "HTTPS Bearer")
    Rel(mainRs, shutdownMod, "register tasks, await drain", "call")
    Rel(mainRs, safeStateMod, "apply at boot (post-init) + pre-shutdown", "call")
    Rel(safeStateMod, fieldIO, "drive outputs to fail-safe", "via I/O actor handles")
    Rel(mainRs, healthMod, "notify systemd ready, spawn watchdog task", "call")
    Rel(healthMod, systemd, "sd_notify READY=1 + WATCHDOG=1", "Unix socket (sd-notify crate)")
    Rel(mainRs, runtimeSafetyMod, "ROADMAP — wire ClockAuthority + ShutdownPhase", "call (Faz 2 Sprint 6.7)")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Diagram 2 — I/O actors, process image, LoRaWAN

```mermaid
C4Component
    title Component view — I/O actors and process image

    Container_Ext(fieldIO, "Field devices")

    Component(modbusMod, "modbus", "src/modbus.rs", "ModbusHandle (Send+Sync) + ModbusActor (LocalSet-bound). rodbus 1.4 client. CircuitBreaker wrapped.")
    Component(gpioMod, "gpio (feature gpio)", "src/gpio.rs", "GpioHandle + GpioActor. rppal backend on Linux; simulation fallback off-target.")
    Component(i2cMod, "i2c", "src/i2c.rs", "I2cHandle + I2cActor. Atlas EZO driver delegation.")
    Component(spiMod, "spi", "src/spi.rs", "SpiHandle (ADR-024 slot for MCP3008 / ADS1256 adapters).")
    Component(pwmMod, "pwm", "src/pwm.rs", "PWM actuation for motors / servos.")
    Component(atlasMod, "atlas_ezo", "src/atlas_ezo.rs", "Atlas Scientific EZO probe protocol (I2C transport).")
    Component(ioPollMod, "io_poll", "src/io_poll.rs", "Periodic sampling loop: reads every actor, pushes into process image.")
    Component(processImgMod, "process_image", "src/process_image.rs", "Unified tag table — TagConfig, TagValue, TagQuality, ProtocolConfig. Single source of truth for tag state.")
    Component(hwScannerMod, "hardware_scanner", "src/hardware_scanner.rs", "Platform-aware I/O autodetect (RevPi / RPi / Generic). Boots once.")
    Component(loraMod, "lora (feature lorawan)", "src/lora/ — codec, crypto, mac, session, sx1302, types", "SX1302 concentrator driver + LoRaWAN 1.0.x / 1.1 MAC + AES-128 / AES-CMAC session crypto.")
    Component(interningMod, "interning", "src/interning.rs", "lasso-backed string interner for device IDs, topic names (memory pressure mitigation).")
    Component(boundedMod, "bounded", "src/bounded.rs", "heapless-backed bounded collections (IEC 62443 FR3 memory safety).")

    Rel(ioPollMod, modbusMod, "read_all_parallel()", "handle mpsc")
    Rel(ioPollMod, gpioMod, "read_all()", "handle mpsc")
    Rel(ioPollMod, i2cMod, "read devices", "handle mpsc")
    Rel(ioPollMod, processImgMod, "update_tag(value, quality, source)", "Arc<ProcessImage>")
    Rel(modbusMod, fieldIO, "Modbus-TCP / Modbus-RTU", "TCP 502 / RS-485")
    Rel(gpioMod, fieldIO, "digital pin read/write", "sysfs / gpio-chardev via rppal")
    Rel(i2cMod, fieldIO, "I2C address read/write", "/dev/i2c-*")
    Rel(spiMod, fieldIO, "SPI transfer", "/dev/spidev*")
    Rel(pwmMod, fieldIO, "PWM duty-cycle", "sysfs pwm / hardware PWM")
    Rel(atlasMod, i2cMod, "EZO command protocol", "I2C via I2cHandle")
    Rel(loraMod, fieldIO, "Semtech UDP packet forwarder", "UDP 1700")
    Rel(loraMod, processImgMod, "decoded payloads -> tags", "Arc<ProcessImage>")
    Rel(hwScannerMod, processImgMod, "capabilities report", "struct")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Diagram 3 — Script engine, validators, deploy, alarms

```mermaid
C4Component
    title Component view — Script engine, ST validator, deploy, alarms

    Component(scriptingMod, "scripting", "src/scripting/ — engine, storage, context, triggers, actions, limits, conflict, persistence, parallel, fb_registry, function_blocks/", "IEC 61131-3-inspired runtime. Event-driven + scan-cycle modes.")
    Component(stValidatorMod, "st_validator", "src/st_validator.rs", "IEC 61131-3 Structured Text parser + semantic validator (ADR-017 precursor; bytecode on st-bytecode feature).")
    Component(plcProgMod, "plc_programming", "src/plc_programming/ — codesys, s7comm, opcua, ethernet_ip, ads, common", "PlcProgrammer trait + five protocol implementations. Audit-logged.")
    Component(deployOrchMod, "deploy_orchestrator", "src/deploy_orchestrator.rs", "Unified deploy surface (v2.2). Routes Rust / Codesys / Setpoint deploys.")
    Component(alarmsMod, "alarms", "src/alarms.rs", "AlarmManager — IEC 62682 evaluation, hysteresis, shelving, suppression.")
    Component(alarmEngineMod, "alarm_engine (feature scada-display)", "src/alarm_engine.rs", "SCADA-side alarm state machine: acknowledge, reset, history.")
    Component(trendEngineMod, "trend_engine (feature scada-display)", "src/trend_engine.rs", "Trend sample ring buffer + durable history to scada.db.")
    Component(calibEngineMod, "calibration_engine (feature scada-display)", "src/calibration_engine.rs", "Sensor calibration workflows — span, offset, linearisation.")
    Component(processImgMod, "process_image", "src/process_image.rs", "Tag table — read/write from scripting and alarms.")

    Rel(scriptingMod, processImgMod, "read/write tags, RETAIN semantics", "Arc<ProcessImage> + Arc<ScriptStorage>")
    Rel(scriptingMod, alarmsMod, "trigger alarm events", "in-process")
    Rel(stValidatorMod, scriptingMod, "validated AST -> compiled script", "in-process")
    Rel(deployOrchMod, plcProgMod, "dispatch PLC programming", "trait dispatch")
    Rel(deployOrchMod, scriptingMod, "install Rust/ST script", "call")
    Rel(alarmsMod, processImgMod, "threshold eval on tag update", "in-process")
    Rel(alarmEngineMod, alarmsMod, "bind SCADA state machine", "in-process")
    Rel(alarmEngineMod, trendEngineMod, "alarm-correlated trend window", "in-process")
    Rel(calibEngineMod, processImgMod, "write calibrated tag", "in-process")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Diagram 4 — Cloud communication cluster

```mermaid
C4Component
    title Component view — Cloud communication

    Container_Ext(cloudMqttPrimary, "Cloud MQTT broker (primary)")
    Container_Ext(cloudMqttSecondary, "Cloud MQTT broker (secondary)")
    Container_Ext(cloudApi, "Cloud Provisioning & Config API")
    Container_Ext(cloudAudit, "Cloud audit sink")
    Container_Ext(otlpCollector, "OTLP collector (optional)")

    Component(mqttMod, "mqtt", "src/mqtt.rs", "MqttClient — rumqttc 0.25 wrapper. StatusMessage, TelemetryMessage, CommandMessage, IncomingMessage types.")
    Component(mqttFailoverMod, "mqtt_failover", "src/mqtt_failover.rs", "Primary/secondary broker selection + reconnection state machine.")
    Component(offlineQueueMod, "offline_queue", "src/offline_queue.rs", "OfflineQueue + AsyncOfflineQueue + MessagePriority + IntegrityCheckResult. SQLite WAL-backed durable buffer.")
    Component(commandsMod, "commands", "src/commands.rs", "CommandHandler — MQTT command subject router + dispatch.")
    Component(commandEnvelopeMod, "command_envelope", "src/command_envelope/ — envelope, canonical, jti, mutating", "ADR-018 §7 Zero-Trust envelope: ed25519 verify + jti dedup + canonical-params + mutating-command allowlist. Types present; enforcement gated on signed-deploy feature.")
    Component(telemetryMod, "telemetry", "src/telemetry.rs", "TelemetryCollector — sysinfo-driven periodic publisher. OTLP exporter optional.")
    Component(provisioningMod, "provisioning", "src/provisioning.rs", "REST client for activation + self-registration.")

    Rel(mqttMod, cloudMqttPrimary, "pub/sub", "MQTT / TLS 1.2+ (target mTLS per ADR-015 — ORPHAN-EDGE-003)")
    Rel(mqttFailoverMod, cloudMqttPrimary, "primary connection", "MQTT")
    Rel(mqttFailoverMod, cloudMqttSecondary, "secondary connection", "MQTT")
    Rel(mqttFailoverMod, offlineQueueMod, "enqueue when both brokers down", "in-process")
    Rel(offlineQueueMod, mqttMod, "drain on reconnect", "in-process")
    Rel(commandsMod, mqttMod, "subscribe to command subjects", "in-process")
    Rel(commandsMod, commandEnvelopeMod, "verify envelope (type-present; runtime Enforcing mode on signed-deploy feature)", "in-process — ORPHAN-EDGE-004 until flag flipped")
    Rel(telemetryMod, mqttMod, "publish telemetry", "in-process")
    Rel(telemetryMod, otlpCollector, "OTLP traces (feature telemetry)", "OTLP/gRPC")
    Rel(provisioningMod, cloudApi, "REST activate / self_register", "HTTPS Bearer")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Diagram 5 — Security, keystore, audit, update

```mermaid
C4Component
    title Component view — Security, keystore, audit, update

    Container_Ext(tpm, "TPM 2.0 / Optiga SLM")
    Container_Ext(cloudAudit, "Cloud audit sink")
    Container_Ext(ntpAuth, "NTS / NTP authority")

    Component(keystoreMod, "keystore (types pre-staged; runtime Faz 2 Sprint 6.3)", "src/keystore/ — mod, purpose, secret, acceptance, error", "Keystore trait + KeyPurpose typestate + KeyMaterial sealed secret + FileBackedAcceptance gated newtype. Tier 1 TPM / Tier 2 systemd-creds / Tier 3 file (operator-accepted).")
    Component(authzMod, "authz", "src/authz/ — mod, permission, policy, manifest, context, verify", "ADR-018 §1 Permission enum + ActuatorClass taxonomy + AuthorizedContext sealed type + manifest verifier.")
    Component(auditMod, "audit (types pre-staged; runtime Faz 2 Sprint 6.2)", "src/audit/ — mod, entry, chain", "AuditEntry + HMAC chain appender (ADR-020).")
    Component(updaterMod, "updater (types pre-staged; runtime Faz 2 Sprint 6.5)", "src/updater/ — mod, manifest, partition, verify, error", "A/B firmware partition + ed25519-signed manifest (ADR-019).")
    Component(configIntegrityMod, "config_integrity (types pre-staged; runtime Faz 2 Sprint 6.6)", "src/config_integrity/ — mod, manifest, verify, error", "config.yaml.sig factory-signed integrity gate.")
    Component(mtlsMod, "mtls (types pre-staged; runtime Faz 2 Sprint 6.8)", "src/mtls/ — mod, mode, pinning, cipher, verify, error", "3-stage mTLS rollout + leaf cert pinning + 2-phase rotation + TLS 1.3 allowlist.")
    Component(runtimeSafetyMod, "runtime_safety (types pre-staged; runtime Faz 2 Sprint 6.7)", "src/runtime_safety/ — clock, retained_msg, shutdown_phase", "ClockAuthority (NTS anchor) + retained-msg guard + tier-1 drain-before-safe-state.")
    Component(securityMod, "security", "src/security.rs", "Credential obfuscation (base64), zeroize on drop, MAC pseudonymisation, TLS cert expiry monitor (v1.2.4).")

    Rel(keystoreMod, tpm, "seal/unseal master (feature tpm, Tier 1)", "tss-esapi / libtss2")
    Rel(authzMod, keystoreMod, "resolve signing/verify keys by purpose", "call")
    Rel(auditMod, keystoreMod, "HKDF-derive HMAC chain key", "call (HkdfSha256)")
    Rel(auditMod, cloudAudit, "emit HMAC-chained entry", "MQTT relay")
    Rel(updaterMod, keystoreMod, "ed25519 verify firmware manifest", "call")
    Rel(configIntegrityMod, keystoreMod, "ed25519 verify config.yaml.sig", "call")
    Rel(mtlsMod, keystoreMod, "load leaf cert + rotation state", "call")
    Rel(runtimeSafetyMod, ntpAuth, "wall-clock anchor", "NTS/NTP")
    Rel(securityMod, keystoreMod, "zeroize key material on drop", "trait impl")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Diagram 6 — Local HMI / SCADA cluster (feature scada-display)

```mermaid
C4Component
    title Component view — Local HMI / SCADA display (feature scada-display)

    Person(siteOp, "Local operator / site engineer")
    Container_Ext(browser, "Browser client (HMI / kiosk)")

    Component(scadaServerMod, "scada_server", "src/scada_server.rs", "axum router + WebSocket stream. ScadaState runtime — process_image read, command channel write. build_scada_router, start_scada_server.")
    Component(scadaTypesMod, "scada_types", "src/scada_types.rs", "ScadaCommand, ScadaSensorData, SensorReading, TagMapping.")
    Component(scadaDbMod, "scada_db", "src/scada_db.rs", "SQLite-backed HMI state (configuration, alarm history, trend samples).")
    Component(alarmEngineMod, "alarm_engine", "src/alarm_engine.rs", "Alarm state machine shown to operator.")
    Component(trendEngineMod, "trend_engine", "src/trend_engine.rs", "Trend window sampling + durable history.")
    Component(calibEngineMod, "calibration_engine", "src/calibration_engine.rs", "Sensor calibration workflow endpoints.")
    Component(ioActors, "I/O actors (modbus/gpio/i2c)", "src/modbus.rs, src/gpio.rs, src/i2c.rs", "Write targets for operator commands.")
    Component(processImg, "process_image", "src/process_image.rs", "Tag read source for HMI.")

    Rel(siteOp, browser, "uses", "keyboard/mouse/touch")
    Rel(browser, scadaServerMod, "HTTP + WebSocket", "HTTPS/WSS on LAN (target port 8443; today port per config)")
    Rel(scadaServerMod, processImg, "read tag values for HMI", "Arc<ProcessImage>")
    Rel(scadaServerMod, scadaDbMod, "persist alarm history + trend samples", "rusqlite (ScadaDb::new)")
    Rel(scadaServerMod, ioActors, "operator writes -> ScadaCommand channel -> actor write", "tokio mpsc + oneshot ack")
    Rel(scadaServerMod, alarmEngineMod, "alarm stream to client", "WS")
    Rel(scadaServerMod, trendEngineMod, "trend stream to client", "WS")
    Rel(scadaServerMod, calibEngineMod, "calibration endpoints", "HTTP)")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Diagram 7 — Resilience and error handling

```mermaid
C4Component
    title Component view — Resilience and error handling

    Component(resilienceMod, "resilience", "src/resilience/ — circuit_breaker, timeout, rate_limiter", "Cross-cutting resilience primitives. Wraps every I/O call path.")
    Component(errorMod, "error", "src/error.rs", "Error type hierarchy. anyhow::Error at async boundaries.")
    Component(backupMod, "backup", "src/backup.rs", "VACUUM INTO SQLite backup + gzip compression + rotation (v1.2.4).")
    Component(ioActors, "I/O actor set", "src/modbus.rs + gpio.rs + i2c.rs + spi.rs + pwm.rs", "All I/O actors use the resilience stack.")
    Component(mqttMod, "mqtt", "src/mqtt.rs", "Uses resilience::Timeout on publish, reconnection backoff.")
    Component(scriptEngineMod, "scripting", "src/scripting/", "Uses rate_limiter for script scheduling cadence.")

    Rel(ioActors, resilienceMod, "CircuitBreaker::call + with_timeout", "wrapper")
    Rel(mqttMod, resilienceMod, "Timeout::wrap on publish", "wrapper")
    Rel(scriptEngineMod, resilienceMod, "RateLimiter::check per-script cadence", "call")
    Rel(backupMod, errorMod, "error types", "type")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Module inventory — grep-verified against HEAD

Top-level modules declared in `src/main.rs:18-116`:

```
alarms                   src/alarms.rs
authz                    src/authz/
backup                   src/backup.rs
bounded                  src/bounded.rs
commands                 src/commands.rs
config                   src/config.rs
error                    src/error.rs
gpio                     src/gpio.rs
health                   src/health.rs
i2c                      src/i2c.rs
interning                src/interning.rs
modbus                   src/modbus.rs
mqtt                     src/mqtt.rs
mqtt_failover            src/mqtt_failover.rs
offline_queue            src/offline_queue.rs
plc_programming          src/plc_programming/
provisioning             src/provisioning.rs
pwm                      src/pwm.rs
resilience               src/resilience/
scripting                src/scripting/
deploy_orchestrator      src/deploy_orchestrator.rs
hardware_scanner         src/hardware_scanner.rs
process_image            src/process_image.rs
atlas_ezo                src/atlas_ezo.rs
io_poll                  src/io_poll.rs
security                 src/security.rs
st_validator             src/st_validator.rs
safe_state               src/safe_state.rs
safe_state_v2            src/safe_state_v2.rs
keystore                 src/keystore/
audit                    src/audit/
command_envelope         src/command_envelope/
updater                  src/updater/
config_integrity         src/config_integrity/
runtime_safety           src/runtime_safety/
mtls                     src/mtls/
shutdown                 src/shutdown.rs
spi                      src/spi.rs
telemetry                src/telemetry.rs
```

Feature-gated modules (conditional compilation):

```
lora                     src/lora/                     feature lorawan
scada_server             src/scada_server.rs           feature scada-display
scada_types              src/scada_types.rs            feature scada-display
scada_db                 src/scada_db.rs               feature scada-display
alarm_engine             src/alarm_engine.rs           feature scada-display
trend_engine             src/trend_engine.rs           feature scada-display
calibration_engine       src/calibration_engine.rs     feature scada-display
```

**Total modules: 39 top-level + 6 feature-gated = 45 distinct module roots.** Submodule directories (`src/authz/`, `src/audit/`, `src/command_envelope/`, `src/config_integrity/`, `src/keystore/`, `src/lora/`, `src/mtls/`, `src/plc_programming/`, `src/resilience/`, `src/runtime_safety/`, `src/scripting/`, `src/updater/`) each contain an additional 3–11 files, all of which are listed in the diagrams above by path.

## Cross-cluster invariants

1. **Every I/O actor is handle-fronted.** A consumer (scripting, commands, safe-state, SCADA server, io_poll) never reaches into an actor's state — it holds a `ModbusHandle` / `GpioHandle` / `I2cHandle` and sends a command over mpsc. This isolates the Tokio `LocalSet` from the multi-thread runtime and makes the actor the single panic domain.
2. **The process image is the single tag SSoT.** `src/process_image.rs` is the only place tag values live at runtime. Everything that needs to read or write a tag reads from or writes to it — there is no parallel cache. This invariant is load-bearing for the alarm, SCADA, scripting, and telemetry clusters.
3. **Life-safety comes before runtime in boot.** `main.rs:1118-1151` applies safe-state to every actuator output **before** the script engine, telemetry, command handler, or SCADA server start. This closes CRITICAL-001 (LIFE-SAFETY boot order). Any component that spawns actuator-writing tasks before this point is a regression.
4. **Feature-gated code compiles out, does not hide behind runtime flags.** `opc-ua-server`, `scada-display`, `lorawan`, `tpm`, `telemetry`, `signed-deploy`, `st-bytecode`, `multi-task-scheduler`, `live-debug`, `license-enforce` (`Cargo.toml:325-397`) are compile-time. `tests/invariants/feature_off_no_symbols.sh` (see `Cargo.toml:265`) enforces this for `opc-ua-server`; the same discipline is expected for any new feature.
5. **`#[allow(dead_code)]` on type-pre-staged modules is deliberate.** Modules `authz`, `safe_state_v2`, `keystore`, `audit`, `command_envelope`, `updater`, `config_integrity`, `runtime_safety`, `mtls` all live behind a runtime-wiring sprint (Faz 2 Sprints 6.1 through 6.8). The types are in-tree so reference stability is preserved across the rollout; production behaviour is unchanged until the corresponding sprint flips the gate. This is a staged-rollout discipline, not dead code.

## Evidence

- `sens-api-gateway/src/main.rs:18-116` — full module graph
- `sens-api-gateway/src/main.rs:124-136` — concrete `use` imports proving cross-module wiring
- `sens-api-gateway/src/main.rs:295-337` — `AppState` field inventory (ties Level 2 containers to Level 3 modules)
- `sens-api-gateway/src/main.rs:1118-1151` — boot safe-state enforcement
- `sens-api-gateway/src/main.rs:1154-1165` — shutdown coordinator registration
- `sens-api-gateway/src/main.rs:1168-1284` — scada-display feature conditional block
- `sens-api-gateway/src/offline_queue.rs` — public surface: `OfflineQueue`, `AsyncOfflineQueue`, `QueuedMessage`, `QueueStats`, `IntegrityCheckResult`, `MessagePriority`
- `sens-api-gateway/src/mqtt.rs` — public surface: `MqttClient`, `IncomingMessage`, `StatusMessage`, `DeviceStatus`, `TelemetryMessage`, `CommandMessage`, `TelemetryMetrics`, `ModbusDeviceData`, `ModbusRegisterData`, `GpioPinData`
- `sens-api-gateway/src/scada_server.rs` — public surface: `ScadaState`, `build_scada_router`, `start_scada_server`, `build_scada_sensor_data`, `ScadaProcess`, `ScadaSensorData`, `SensorReading`, `TagMapping`
- `sens-api-gateway/src/scripting/engine.rs` — public surface: `ScriptEngine`, `ExecutionResult`, `ScanCycleStats`
- `sens-api-gateway/Cargo.toml:325-397` — feature-gate matrix
- `docs/adr/017-st-bytecode-runtime.md`, `docs/adr/018-edge-rbac-abac-model.md`, `docs/adr/019-edge-firmware-signing-ab-partition.md`, `docs/adr/020-audit-log-hmac-chain.md`, `docs/adr/021-platform-key-ceremony-lifecycle.md`, `docs/adr/024-edge-hardware-adapter-inventory.md` — type-pre-staged module roadmap

Not covered here — actor-pattern internals (channel shapes, scan-cycle state machine) go in `c4-code.md`; sequence flows go in `data-flow.md`; zone topology goes in `deployment-topology.md`.
