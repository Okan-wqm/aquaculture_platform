# Rust Crate API Reference — `suderra-agent`

**Crate type:** binary (`[[bin]] name = "suderra-agent"` per `Cargo.toml:447-449`).
**Public integration surface:** effectively zero. The crate exposes `pub` items for module-internal use and for `cargo doc` readability; external consumers are NOT expected to depend on this crate as a library today.
**Stability tier:** INTERNAL (all public items) — until a dedicated library crate is split out, no forward-compat promise holds across minor versions.

## Why this chapter exists despite binary-only status

Siemens supplier documentation expects a Rust API reference per module regardless of crate type — it is the acceptance criterion for IEC 62443-4-1 SDLA artefact *R-SD-2.2 Component Interface Specification*. This chapter therefore enumerates the `pub` surface that a future library split would expose, classifies each item by stability tier, and cites the source-of-truth location.

## How to regenerate machine-readable output

```bash
cd sens-api-gateway
cargo doc --no-deps --document-private-items=false
# HTML lands in target/doc/suderra_agent/index.html
```

For CI regeneration, `cargo doc` is already exercised by the nightly build matrix (Cargo.toml `[package.metadata.docs.rs]` not yet configured — tracked as ORPHAN-EDGE docs-hygiene item).

## Stability tier legend

| Tier | Meaning |
|---|---|
| STABLE | Shape, name, semantics pinned across minor versions. Changes require `BREAKING CHANGE:` footer in the commit. |
| UNSTABLE | Public but may change between minor versions. Consumers must vendor the source or pin an exact patch. |
| INTERNAL | Public for cross-module use only; not intended for external consumption. Behaviour may change in any commit. |

Today, **every** `pub` item in this crate is INTERNAL. A future v2.0 library split would elevate the RBAC-manifest and event-payload types to STABLE.

## Module surface (per `src/main.rs:18-116`)

`src/main.rs` declares the following modules. `#[allow(dead_code)]` on a module indicates the module's types are pre-staged but not yet wired into runtime dispatch — see `ORPHAN-EDGE-*` findings for timing.

| Module | Purpose | Wired today? |
|---|---|---|
| `alarms` | IEC 62682 alarm-state machine (`src/main.rs:18`) | YES |
| `authz` | ADR-018 / ADR-024 RBAC types: `Permission`, `ActuatorClass`, newtypes (`src/main.rs:22-23`) | Types staged, runtime gate not wired (Faz 2 Sprint 6.1) |
| `backup` | Backup / restore (`src/main.rs:24`) | YES |
| `bounded` | Bounded collection primitives (heapless wrappers) | YES |
| `commands` | MQTT command dispatcher (`src/commands.rs`) | YES |
| `config` | YAML config schema (`src/config.rs`) | YES |
| `error` | `AgentError` thiserror enum | YES |
| `gpio` | GPIO handle (actor pattern) | YES |
| `health` | HTTP `/health`/`/ready`/`/metrics`/`/diagnostics` types + handlers (`src/health.rs`) | **NOT WIRED** — `start_health_server` never called from `main.rs` (ORPHAN-EDGE-007) |
| `i2c` | I2C handle | YES |
| `interning` | `lasso` string interner | YES |
| `modbus` | Modbus TCP/RTU client (`rodbus =1.4.0`) | YES |
| `mqtt` | Cloud MQTT client + payload types (`src/mqtt.rs`) | YES |
| `mqtt_failover` | FailoverManager, BrokerEndpoint (`src/mqtt.rs:16-18` — infrastructure present, `FailoverMqttClient` wiring is HARDWARE-VENDOR responsibility scheduled under Faz 2) | Infrastructure YES, failover client NOT wired |
| `offline_queue` | Durable outbox for disconnected operation | YES |
| `plc_programming` | PLC upload protocols (Codesys / OPC UA / EtherNet/IP / ADS) | YES |
| `provisioning` | Device self-registration + activation | YES |
| `pwm` | PWM channel control | YES |
| `resilience` | Circuit breaker, retry policy | YES |
| `scripting` | Script engine (JSON-style rule runtime; ST bytecode VM is staged but feature-gated `st-bytecode`) | Partial — JSON runtime YES, ST VM NOT wired (`st-bytecode` feature off by default) |
| `deploy_orchestrator` | Unified deploy (Rust / Codesys / Setpoint) | YES |
| `hardware_scanner` | Platform-aware I/O auto-detection | YES |
| `process_image` | Shared tag/value store for scan cycle | YES |
| `atlas_ezo` | Atlas Scientific EZO I2C sensor driver | YES |
| `io_poll` | I/O poll loop | YES |
| `security` | Security hardening helpers (`src/security.rs`) | YES |
| `st_validator` | IEC 61131-3 Structured Text parser / validator | YES |
| `safe_state` | Actuator safe-state-on-shutdown (v1 schema) | YES |
| `safe_state_v2` | ADR-024 §3-4 FailSafe enum + DiversityClass (`#[allow(dead_code)]` — types staged, Faz 2 Sprint 7.2 migration) | Types staged, NOT wired |
| `keystore` | ADR-018/019 sealed KeyMaterial + FileBackedAcceptance (`#[allow(dead_code)]`) | Types staged, NOT wired (Faz 2 Sprint 6.3) |
| `audit` | ADR-020 AuditEntry + HMAC chain (`#[allow(dead_code)]`) | Types staged, NOT wired (Faz 2 Sprint 6.2) |
| `command_envelope` | Zero-Trust CommandEnvelope + jti dedup (`#[allow(dead_code)]`) | Types staged, NOT wired (Faz 2 Sprint 6.4) |
| `updater` | ADR-019 firmware A/B partition + signed manifest verifier (`#[allow(dead_code)]`) | Types staged, NOT wired (Faz 2 Sprint 6.5) |
| `config_integrity` | D-13 `config.yaml.sig` factory-signed verify (`#[allow(dead_code)]`) | Types staged, NOT wired (Faz 2 Sprint 6.6) |
| `runtime_safety` | ClockAuthority trait + retained-msg guard + ShutdownPhase state machine (`#[allow(dead_code)]`) | Types staged, NOT wired (Faz 2 Sprint 6.7) |
| `mtls` | mTLS 3-stage rollout + leaf cert pinning + 2-phase rotation + TLS 1.3 cipher-suite allowlist + 6-gate `verify_leaf_cert` (`#[allow(dead_code)]`) | Types staged, NOT wired (Faz 2 Sprint 6.8) |
| `shutdown` | `ShutdownCoordinator` (actor shutdown choreography) | YES |
| `spi` | SPI bus driver | YES |
| `telemetry` | `TelemetryCollector` (system metrics gather) | YES |
| `lora` | LoRaWAN SX1302 (feature-gated `lorawan`) | Feature-gated |
| `scada_server` + `scada_types` + `scada_db` + `alarm_engine` + `trend_engine` + `calibration_engine` | Local HMI / SCADA (feature-gated `scada-display`) | Feature-gated |

## Key public types by module (selected — full list via `cargo doc`)

### `config::AgentConfig` (`src/config.rs:144-221`) — STABLE shape, INTERNAL crate status

Tier: INTERNAL at crate level, but the YAML wire format this struct represents is the **public configuration contract** — see [`config-schema.md`](./config-schema.md). The YAML schema IS user-facing; the Rust struct is the parser.

### `mqtt::MqttClient` (`src/mqtt.rs:48-57`) — INTERNAL

Owns the rumqttc `AsyncClient`, resolved topic tree, device identity, inbound-message channel receiver, and event-loop task handle.

Public methods:

| Method | `src/mqtt.rs:line` | Purpose | Stability |
|---|---|---|---|
| `new(&AgentConfig) -> Result<Self>` | `194-310` | Construct + connect + subscribe + publish Online | INTERNAL |
| `publish_status(DeviceStatus, u64) -> Result<()>` | `535-559` | Publish `StatusMessage` at QoS 1 retained=true | INTERNAL |
| `publish_telemetry(TelemetryMetrics) -> Result<()>` | `562-593` | Publish `TelemetryMessage` at QoS 1 retained=false | INTERNAL |
| `publish_response(CommandResponse) -> Result<()>` | `596-613` | Publish command response at QoS 1 retained=false | INTERNAL |
| `publish_io_data(&impl Serialize) -> Result<()>` | `616-622` | Publish I/O tag values at QoS 0 retained=false (`mqtt.rs:619` — QoS 0 chosen because losing an intermediate frame is acceptable when the next frame carries fresher state) | INTERNAL |
| `publish_alarms(&impl Serialize) -> Result<()>` | `625-631` | Publish alarm events at QoS 1 retained=false | INTERNAL |
| `publish_lora_event(&impl Serialize) -> Result<()>` | `634-640` | Publish LoRa event at QoS 0 | INTERNAL |
| `publish_raw(&str, &[u8]) -> Result<()>` | `643-653` | Arbitrary-topic publish (boot-time capabilities report) | INTERNAL |
| `recv() -> Option<IncomingMessage>` | `656-658` | Await next inbound message | INTERNAL |
| `try_recv() -> Option<IncomingMessage>` | `661-663` | Non-blocking poll | INTERNAL |
| `disconnect(self) -> Result<()>` | `666-684` | Publish Offline + disconnect + abort event loop | INTERNAL |
| `topics() -> &ResolvedTopics` | `687-689` | Borrow the resolved topic tree | INTERNAL |

### `mqtt::TelemetryMessage` / `mqtt::StatusMessage` / `mqtt::CommandMessage` / `mqtt::CommandResponse` (`src/mqtt.rs:70-192`) — wire contract

These four `#[derive(Serialize/Deserialize)]` types define the on-wire JSON MQTT payload contract. See [`event-schemas.md`](./event-schemas.md) for field-by-field JSON Schemas.

### `authz::permission::Permission` (`src/authz/permission.rs:458-545`) — STABLE wire contract (closed enum, additive-only)

The canonical edge vocabulary. 24 variants enumerated in [`rbac-manifest.md`](./rbac-manifest.md). Serde JSON wire format is pinned by `permission_golden_json_pinning` test at `src/authz/permission.rs:842-864`.

Public helpers:

| Fn | `src/authz/permission.rs:line` | Purpose |
|---|---|---|
| `Permission::requires_two_person_integrity(&self) -> bool` | `568-577` | Returns true for the ADR-018 §7 MANDATORY subset: `UpdateFirmware`, `DeployProgram`, `ForceValue`, `SafeStateTrigger`, `Reboot` |
| `Permission::is_mutating(&self) -> bool` | `586-588` | Returns false for read-only variants (`ReadTag`, `ReadAuditLog`, `WatchSubscribe`); used by signature-enforcement router |

### `authz::permission::ActuatorClass` (`src/authz/permission.rs:407-432`) — STABLE wire contract

11 variants enumerated in [`rbac-manifest.md`](./rbac-manifest.md#actuatorclass-taxonomy). Three variants (`Aeration`, `Chemistry`, `Thermal`) carry inner subclass tags (`AerationSubClass`, `ChemistrySubClass`, `ThermalSubClass`).

### `health::HealthState` / `health::HealthResponse` / `health::ReadinessResponse` / `health::MetricsResponse` / `health::DiagnosticsResponse` (`src/health.rs:31-233`)

Response shapes consumed by `openapi.yaml`. See [`http-api.md`](./http-api.md).

## Typestate + sealed-newtype patterns

The following type-system-level invariants (Tier-1 *make it impossible* per CLAUDE.md Architectural Approach) are in force in the `authz` / `keystore` / `command_envelope` / `updater` / `mtls` / `config_integrity` modules:

- `DeviceId`, `TenantId`, `OperatorId`: tuple-private UUID newtypes; constructor is `pub(crate) new_from_verified(bytes) -> Self` at `src/authz/permission.rs:72-86, 106-116, 137-147`. External code cannot mint. Deserialization via `#[serde(transparent)]` is a Batch 2 carve-out closed fully in Sprint 6.1 (BATCH-002-FINDING-003-FU).
- `ModbusRegisterRange` validates `start <= end` at `try_from` deserialization boundary (`src/authz/permission.rs:233-254`). Malformed ranges cannot flow through the system.
- `AuthorizedContext` (to land Sprint 6.1) — module-boundary invariant: constructed ONLY from inside `authz::` per `src/authz/mod.rs:21-27`.
- `KeyMaterial` sealed secret + `FileBackedAcceptance` gated newtype (Sprint 6.3).
- `CommandEnvelope` — attacker-controlled bincode deserialize MUST use `bincode::options().with_limit(MAX_ENVELOPE_BYTES)` per Cargo.toml:183-193 invariant.

## `cargo doc` regeneration integration

The crate's public API surface is inspected by:

1. `cargo doc --no-deps` — emits `target/doc/suderra_agent/`
2. `scripts/check-public-api.sh` (not yet wired — tracked as ORPHAN-EDGE docs-hygiene) — would `cargo public-api` diff against a pinned baseline

A future `api-reference-writer` regeneration should re-run this chapter against the module table any time `src/main.rs:18-116` changes.
