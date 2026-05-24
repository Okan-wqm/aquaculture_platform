# Remote Command Catalogue

**Transport:** MQTT topic `tenants/{tenant_id}/devices/{device_id}/commands` (QoS 1; retained REJECTED — see [`mqtt-topics.md`](./mqtt-topics.md#subscribe-patterns)).
**Dispatcher:** `CommandHandler::execute_command` (`src/commands.rs:364-475`).
**Reply topic:** `tenants/{tenant_id}/devices/{device_id}/responses` (QoS 1, retained=false) via `MqttClient::publish_response` (`src/mqtt.rs:596-613`).
**Message shape:** `CommandMessage` (inbound) → `CommandResponse` (outbound). See [`event-schemas.md`](./event-schemas.md).

## Current authorisation posture (HONEST)

### RC4 release posture

`agent-v2.0.0-rc4` does not change the dispatcher authorization behavior documented below. Signed envelope enforcement, replay cache enforcement, and permission-backed dispatch remain follow-up runtime work for the ADR-025-aligned implementation PR.

**Today:** All commands accept invocation based solely on broker ACL (topic filter authorisation). The edge agent does NOT cryptographically verify the invoker; it does NOT check per-operator permissions; the RBAC permission enum (`src/authz/permission.rs`) is defined but NOT consulted by the dispatcher.

**Partial mitigation in place:** a text-based log tag `AUDIT:` is emitted before executing any command in the safety-critical allowlist (`src/commands.rs:380-397`). The allowlist today: `deploy_program`, `deploy_script`, `deploy_to_codesys`, `deploy_auto`, `rollback_program`, `plc_upload`, `plc_start`, `plc_stop`, `plc_delete`, `write_modbus`, `write_gpio`, `reboot`, `restart_agent`, `delete_script`, `update_io_config`, `set_output`, `deploy_process`, `deploy_scada_package`, `update_firmware`.

**Roadmap wiring:**
- Ed25519 `CommandEnvelope` with `jti` dedup + canonical params hash + mutating-command allowlist — types staged in `src/command_envelope/` (`src/main.rs:72-73` `#[allow(dead_code)]`), runtime gate lands in Faz 2 Sprint 6.4 behind `signed-deploy` feature flag.
- Per-operator `OperatorId` + ed25519 signing key minted from `RbacManifest.custom_roles[].operators[].pubkey` — manifest types staged in `src/authz/manifest.rs` and `src/authz/verify.rs`, runtime `verify_manifest` gate in Sprint 6.1.
- Two-person integrity enforcement (`Permission::requires_two_person_integrity` at `src/authz/permission.rs:568-577`) — ADR-018 §7 MANDATORY subset: `UpdateFirmware`, `DeployProgram`, `ForceValue`, `SafeStateTrigger`, `Reboot`.

## Command catalogue

Source: `src/commands.rs:399-470`. Every entry below maps `command` value → handler → `src/commands.rs:line`.

Four columns below describe the **roadmap** authorisation decision (the `Permission` variant that will gate this command once Sprint 6.4 wiring lands). Today those gates are NOT enforced — the "Today" column reports the actual runtime gating.

Legend:
- **Audit class**: `AUDIT` = in the safety-critical allowlist; `NONE` = not logged today.
- **Idempotency**: `YES` = handler is naturally idempotent (read, or write with idempotent target state); `CID` = dispatcher echoes `commandId` so the cloud can dedupe but the edge handler itself is not idempotent; `NO` = each invocation has a distinct side effect.
- **Two-person (roadmap)**: derived from `Permission::requires_two_person_integrity` at `src/authz/permission.rs:568-577`.

### Core read / info

| Command | Handler | `src/commands.rs:line` | Roadmap `Permission` | Today | Audit | Idempotency | Two-person |
|---|---|---|---|---|---|---|---|
| `ping` | `cmd_ping` | 400 | (none — infra liveness) | open | NONE | YES | — |
| `get_info` | `cmd_get_info` | 401 | `ReadTag` (coarse) | open | NONE | YES | — |
| `get_config` | `cmd_get_config` | 402 | `ReadTag` | open | NONE | YES | — |
| `get_hardware` | `cmd_get_hardware` | 403 | `ReadTag` | open | NONE | YES | — |
| `scan_hardware` | `cmd_scan_hardware` | 404 | `ReadTag` | open | NONE | YES | — |

### Modbus I/O

| Command | Handler | Line | Roadmap `Permission` | Today | Audit | Idempotency | Two-person |
|---|---|---|---|---|---|---|---|
| `read_modbus` | `cmd_read_modbus` | 405 | `ReadTag` | open | NONE | YES | — |
| `write_modbus` | `cmd_write_modbus` | 406 | `ModbusWrite { device_id, register_range }` AND `AffectActuator { class }` | open | AUDIT | CID | roadmap: `safety_tagged: true` in `hardware_inventory.yaml` forces two-person |

### GPIO I/O

| Command | Handler | Line | Roadmap `Permission` | Today | Audit | Idempotency | Two-person |
|---|---|---|---|---|---|---|---|
| `read_gpio` | `cmd_read_gpio` | 407 | `ReadTag` | open | NONE | YES | — |
| `write_gpio` | `cmd_write_gpio` | 408 | `GpioWrite { pin }` AND `AffectActuator { class }` | open | AUDIT | CID | roadmap: same as write_modbus |

### Script / rule engine

| Command | Handler | Line | Roadmap `Permission` | Today | Audit | Idempotency | Two-person |
|---|---|---|---|---|---|---|---|
| `list_scripts` | `cmd_list_scripts` | 410 | `ReadTag` | open | NONE | YES | — |
| `get_script` | `cmd_get_script` | 411 | `ReadTag` | open | NONE | YES | — |
| `deploy_script` | `cmd_deploy_script` | 412 | `DeployProgram` | open | AUDIT | NO | MANDATORY |
| `delete_script` | `cmd_delete_script` | 413 | `DeployProgram` | open | AUDIT | CID | MANDATORY |
| `enable_script` | `cmd_enable_script` | 414 | `DeployProgram` | open | NONE | CID | MANDATORY |
| `disable_script` | `cmd_disable_script` | 415 | `DeployProgram` | open | NONE | CID | MANDATORY |

### IEC 61131-3 / ST Program (v2.1)

| Command | Handler | Line | Roadmap `Permission` | Today | Audit | Idempotency | Two-person |
|---|---|---|---|---|---|---|---|
| `deploy_program` | `cmd_deploy_program` | 417 | `DeployProgram` | open | AUDIT | NO | MANDATORY |
| `get_program` | `cmd_get_program` | 418 | `ReadTag` | open | NONE | YES | — |
| `rollback_program` | `cmd_rollback_program` | 419 | `DeployProgram` | open | AUDIT | NO | MANDATORY |

### PLC Programming (v1.3.0)

| Command | Handler | Line | Roadmap `Permission` | Today | Audit | Idempotency | Two-person |
|---|---|---|---|---|---|---|---|
| `plc_upload` | `cmd_plc_upload` | 421 | `DeployProgram` | open | AUDIT | NO | MANDATORY |
| `plc_status` | `cmd_plc_status` | 422 | `ReadTag` | open | NONE | YES | — |
| `plc_start` | `cmd_plc_start` | 423 | `DeployProgram` | open | AUDIT | CID | MANDATORY |
| `plc_stop` | `cmd_plc_stop` | 424 | `DeployProgram` | open | AUDIT | CID | MANDATORY |
| `plc_list` | `cmd_plc_list` | 425 | `ReadTag` | open | NONE | YES | — |
| `plc_download` | `cmd_plc_download` | 426 | `ReadTag` | open | NONE | YES | — |
| `plc_delete` | `cmd_plc_delete` | 427 | `DeployProgram` | open | AUDIT | CID | MANDATORY |

### Deploy Orchestrator (v2.2)

| Command | Handler | Line | Roadmap `Permission` | Today | Audit | Idempotency | Two-person |
|---|---|---|---|---|---|---|---|
| `deploy_to_codesys` | `cmd_deploy_to_codesys` | 429 | `DeployProgram` | open | AUDIT | NO | MANDATORY |
| `deploy_auto` | `cmd_deploy_auto` | 430 | `DeployProgram` | open | AUDIT | NO | MANDATORY |
| `validate_st` | `cmd_validate_st` | 431 | (none — pure parser) | open | NONE | YES | — |

### System

| Command | Handler | Line | Roadmap `Permission` | Today | Audit | Idempotency | Two-person |
|---|---|---|---|---|---|---|---|
| `reboot` | `cmd_reboot` | 433 | `Reboot` | open | AUDIT | NO | MANDATORY |
| `restart_agent` | `cmd_restart_agent` | 434 | `Reboot` | open | AUDIT | NO | MANDATORY |
| `update_firmware` | `cmd_update_firmware` | 435 | `UpdateFirmware` | open | AUDIT | NO | MANDATORY |
| `set_log_level` | `cmd_set_log_level` | 436 | `ManagePolicy` | open | NONE | CID | — |

### Failover (v1.3.4)

| Command | Handler | Line | Roadmap `Permission` | Today | Audit | Idempotency | Two-person |
|---|---|---|---|---|---|---|---|
| `failover_status` | `cmd_failover_status` | 438 | `ReadTag` | open | NONE | YES | — |
| `failover_force` | `cmd_failover_force` | 439 | `FailoverControl` | open | NONE | NO | — |
| `failover_recover` | `cmd_failover_recover` | 440 | `FailoverControl` | open | NONE | NO | — |

### I/O config + output

| Command | Handler | Line | Roadmap `Permission` | Today | Audit | Idempotency | Two-person |
|---|---|---|---|---|---|---|---|
| `update_io_config` | `cmd_update_io_config` | 442 | `ManagePolicy` | open | AUDIT | NO | — |
| `set_output` | `cmd_set_output` | 443 | `WriteTag { tag_id }` AND `AffectActuator { class }` | open | AUDIT | CID | roadmap: `safety_tagged` → MANDATORY |

### SCADA display (feature = `scada-display`)

| Command | Handler | Line | Roadmap `Permission` | Today | Audit | Idempotency | Two-person |
|---|---|---|---|---|---|---|---|
| `deploy_process` | `cmd_deploy_process` | 446 | `DeployProgram` | open | AUDIT | NO | MANDATORY |
| `deploy_scada_package` | `cmd_deploy_scada_package` | 448 | `DeployProgram` | open | AUDIT | NO | MANDATORY |
| `display_on` | `cmd_display_on` | 450 | (none — local HMI only) | open | NONE | YES | — |
| `display_off` | `cmd_display_off` | 452 | (none) | open | NONE | YES | — |
| `get_display_status` | `cmd_get_display_status` | 454 | `ReadTag` | open | NONE | YES | — |

### LoRaWAN (feature = `lorawan`)

| Command | Handler | Line | Roadmap `Permission` | Today | Audit | Idempotency | Two-person |
|---|---|---|---|---|---|---|---|
| `update_lora_devices` | `cmd_update_lora_devices` | 457 | `ManagePolicy` | open | NONE | NO | — |
| `lora_downlink` | `cmd_lora_downlink` | 459 | `WriteTag { tag_id }` (roadmap — attached to specific LoRa device tag) | open | NONE | NO | — |

### Unknown / catch-all

Any `command` value not matched in the dispatcher returns:

```json
{
  "success": false,
  "result": null,
  "error": "Unknown command: <sanitised-command-name>"
}
```

with a WARN log (`src/commands.rs:460-472`). User-provided strings are passed through `sanitize_for_log` to prevent log-injection (`src/commands.rs:462`).

## Total commands today: 42

- 5 core read/info
- 2 Modbus
- 2 GPIO
- 6 script
- 3 ST program
- 7 PLC programming
- 3 deploy orchestrator
- 4 system
- 3 failover
- 2 I/O config
- 5 SCADA display (feature-gated)
- 2 LoRaWAN (feature-gated)

Feature-gated counts depend on build flags; 35 commands are always available on the default build.

## Command response shape

Every handler returns `(success: bool, result: serde_json::Value, error: Option<String>)`. These are packed into `CommandResponse` (`src/mqtt.rs:182-192`):

```json
{
  "commandId": "<echoed from request>",
  "deviceId": "<edge's own device_id>",
  "success": true,
  "result": { /* handler-specific body */ },
  "timestamp": "2026-04-24T12:34:56+00:00",
  "error": null
}
```

On failure: `success=false`, `result=null`, `error="<human-readable message>"`.

## Idempotency + retry semantics

- MQTT QoS 1 guarantees at-least-once delivery. The cloud MAY receive duplicate `CommandMessage` entries on broker reconnect; the edge MAY process the same command twice.
- `commandId` is an unopaque echo field today — the cloud can deduplicate responses but the edge does NOT deduplicate requests.
- Roadmap: `jti` field + replay cache in `src/command_envelope/` (Sprint 6.4) is the architectural solution — the cache rejects any `jti` seen within its TTL window.

## Command size limits

- Max MQTT payload size: 1 MiB, enforced at both agent and broker (`src/mqtt.rs:241-245, 349-357`).
- `deploy_program` / `plc_upload` / `update_firmware` ship binary artefacts that may approach this limit — the cloud is expected to chunk larger payloads across multiple commands with an orchestration state machine.
