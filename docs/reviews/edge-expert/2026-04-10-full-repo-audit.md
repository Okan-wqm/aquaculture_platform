# Edge Expert Review
**Date:** 2026-04-10  
**Reviewer:** edge-expert  
**Scope:** `sens-api-gateway/**`, `sensorprotocols/**`  
**Audit mode:** full-repo current-state audit

## Prior Work Check
There is a prior edge review on 2026-04-05, but this audit rechecked the current tree and found the issues below still present or newly visible in the current startup/runtime paths.

## Deployment Decision
**BLOCK**

| ID | Severity | Area | File(s) |
|---|---|---|---|
| CRITICAL-001 | CRITICAL | Boot-safe-state ordering | `sens-api-gateway/src/main.rs` |
| HIGH-002 | HIGH | SCADA offline/PWA asset strategy | `sens-api-gateway/src/scada_server.rs` |
| HIGH-003 | HIGH | MQTT failover wiring | `sens-api-gateway/src/commands.rs`, `sens-api-gateway/src/mqtt_failover.rs` |

## Findings

### CRITICAL-001 - Boot path starts control runtime before any safe-state application
**Evidence:** `sens-api-gateway/src/main.rs` initializes hardware first, builds `SafeStateManager`, then starts telemetry, I/O polling, SCADA, command handling, persistence, and the script engine at lines 1044, 1048-1051, 1056-1065, 1084-1183, 1186-1250. The only call to `safe_state_manager.apply(...)` is in the shutdown path at lines 1314-1324.

**Problem:** The edge runtime never drives actuator outputs to a known fail-safe state before the scripting engine is armed. That means startup can leave pumps, valves, relays, or other outputs in their prior energized state until some later control loop or operator action changes them. On an industrial aquaculture edge node, that is a life-safety violation, not a cosmetic ordering issue.

**Root cause:** `SafeStateManager` exists, but it is only used as part of shutdown. There is no boot-time safe-state phase before runtime actors and scripts start.

**Remediation:** Apply safe-state immediately after hardware initialization and before any script engine, command handler, or I/O loop is allowed to run. If any output cannot be driven to safe-state, keep the system in degraded/disabled mode and surface a hard fault instead of proceeding normally.

**Cross-domain dependency:** `sensor-expert` for actuator/control-path semantics; `security-reviewer` for life-safety gating.

### HIGH-002 - SCADA PWA install path depends on external CDNs
**Evidence:** `sens-api-gateway/src/scada_server.rs` precaches local paths plus external URLs in `SERVICE_WORKER_JS` at lines 118-128, then installs with `cache.addAll(PRECACHE_URLS)` at lines 131-136.

**Problem:** The embedded SCADA service worker is not self-contained. If any CDN fetch fails, the install step fails as an all-or-nothing operation, and the local HMI loses its offline guarantee. Even when install succeeds, the runtime depends on third-party origins for core UI assets, which is a supply-chain and availability risk on an edge device that may operate without internet access.

**Root cause:** The PWA build relies on public CDN assets instead of bundling all runtime dependencies into the edge image.

**Remediation:** Vendor or build all SCADA UI assets locally, cache only same-origin resources, and remove third-party URLs from the precache list. The service worker should be able to install and function with no network access at all.

**Cross-domain dependency:** `frontend-expert` for HMI asset packaging and offline behavior.

### HIGH-003 - Failover commands report success without actually switching brokers
**Evidence:** `sens-api-gateway/src/commands.rs` marks `cmd_failover_force()` as a TODO for wiring the real failover client, logs a warning, and returns `"failover_initiated"` at lines 3309-3346. `cmd_failover_recover()` repeats the same pattern at lines 3349-3388. `sens-api-gateway/src/mqtt_failover.rs` defines the state machine, but there is no integration in the runtime path that actually constructs or drives it.

**Problem:** Operators can invoke failover/recovery commands and receive a success response, but no broker transition is performed. That turns the failover surface into a no-op API and leaves the system exposed during broker outages.

**Root cause:** The failover module exists as standalone code, but it is not wired into the MQTT client or command handler state.

**Remediation:** Wire a real `FailoverManager` into the runtime, start its health-check task, and have the command handlers call the actual transition methods. If failover is not implemented end-to-end, the commands should fail explicitly instead of claiming initiation.

**Cross-domain dependency:** `security-reviewer` for availability and operational trust boundaries; `architectural-arbiter` if the failover ownership model conflicts with the current MQTT client design.

## Cross-Domain Dependencies
| From | To | Reason | Status |
|---|---|---|---|
| CRITICAL-001 | sensor-expert | Boot safe-state changes actuator behavior and control-path expectations | Open |
| HIGH-002 | frontend-expert | SCADA HMI asset strategy and offline install behavior | Open |
| HIGH-003 | security-reviewer | Broker failover is an availability/security-operational boundary | Open |

