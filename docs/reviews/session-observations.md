# Session Observations — Architectural Issues Noted During Batches 13+

**Purpose:** Log every architectural problem observed during wiring work.
Problems NOT in scope of current batch are filed as ORPHAN findings in
`orphan-findings.md`. Problems that gate the current batch are fixed
inline and noted here for the audit trail.

**Policy (per user directive 2026-04-20):**
- No patches — every observed problem gets a root-cause architectural
  fix OR is logged here with owner + deadline + fix-path.
- No deferrals without tracked finding IDs.
- Code comments explain WHY + WHAT in the code blocks (per
  `feedback_code_comments_why_what.md`).

---

## BATCH-13 wiring observations (FailoverManager runtime)

### OBS-13-001 — `start_health_check_task` returns bare JoinHandle

**File:** `sens-api-gateway/src/mqtt_failover.rs:419`

**Observation:** `FailoverManager::start_health_check_task(&self) ->
tokio::task::JoinHandle<()>` returns a bare JoinHandle with no hook to
pass shutdown signal. On graceful shutdown, the health check task runs
indefinitely until the tokio runtime drops it — no cooperative cancel.

**Risk:** During Batch 10 `ShutdownPhase::Draining`, the health check
task could still issue broker probes while the supervisor is trying to
close connections. Race potential.

**Proper fix:** health check task accepts a `broadcast::Receiver<()>`
shutdown signal; inner loop `tokio::select!` between the tick interval
and the shutdown receiver. Task exits cleanly on signal.

**Status:** DEFERRED TO SPRINT 6.7 (FailoverManager ownership +
ShutdownCoordinator integration). Tracked as follow-up.
Owner: platform-team. Deadline: Sprint 6.7.

**Why I didn't fix in Batch 13:** Batch 13's scope was the MINIMAL
wire-up to make `cmd_failover_force` dispatch work. Adding cooperative
shutdown requires extending FailoverManager's constructor signature
(breaking change for the existing in-module shutdown_tx which is
private), and reworking the supervisor shutdown path — that's Faz 2
Sprint 6.7 territory, not Faz 1 wire-up.

---

## BATCH-14 wiring observations (HealthServer runtime)

### OBS-14-001 — HealthState counter push-paths NOT wired

**File(s):** `sens-api-gateway/src/mqtt.rs`, `sens-api-gateway/src/modbus.rs`,
`sens-api-gateway/src/scripting/engine.rs`

**Observation:** `HealthState` exposes counter APIs (`increment_mqtt_sent`,
`set_mqtt_connected`, `record_modbus_read`, etc.) but no current code in
the MQTT client / modbus driver / script engine CALLS those methods. The
HTTP server will report 0 for every counter, static forever.

**Risk:** `/metrics` endpoint shows all-zero state at runtime. Operators
watching the endpoint will see MISLEADINGLY healthy-looking output
(zero-errors, zero-traffic) because nothing reports real activity.

**Root cause:** `HealthState` was written in isolation; push-path wiring
was deferred to a later batch. The health.rs module contains the struct
+ HTTP server but no consumer of the counter APIs.

**Proper fix (Sprint 6.2 scope):**
1. Each AppState sub-handle (mqtt_client, modbus_handle, script_storage)
   accepts an optional `HealthState` clone at construction time.
2. Inside those subsystems, counter updates happen at the actual event:
   - `mqtt_client.publish()` → `health_state.increment_mqtt_sent()`
   - modbus actor → `health_state.record_modbus_read()` on every cycle
   - scripting engine → `health_state.record_script_execution()` per tick
3. Connection lifecycle events (`mqtt_connected` / `modbus_connected`)
   wire via event bus to `HealthState::set_mqtt_connected(bool)`.

**Why I didn't fix in Batch 14:** Scope is wire-up of the server itself,
not instrumentation of 4+ subsystems. Instrumentation is a much bigger
change touching every hot path; it deserves its own batch. Logged as
OBS-14-001 → tracked for Sprint 6.2.

**Status:** DEFERRED to Sprint 6.2. Owner: platform-team.
Deadline: Sprint 6.2 (Faz 2 runtime phase).

### OBS-14-002 — HTTP server bind default `127.0.0.1:8080` port collision risk

**File:** `sens-api-gateway/src/config.rs:HealthServerConfig`

**Observation:** Default `bind = "127.0.0.1:8080"`. Port 8080 is
commonly used by other services (dev servers, proxies, admin panels).
On a shared host with multiple services, the bind can EADDRINUSE.

**Risk:** Server fails to bind → `axum::serve` error → health server
task exits → liveness probes fail → orchestrator marks unhealthy +
restarts the agent.

**Proper fix:** The default-port choice is a deployment config issue,
not a code bug. Runbook (docs/runbooks/edge-deployment.md — Sprint
6.6 scope) will document the port convention + override via
`config.yaml::health.bind`. Log as OBS-14-002 → runbook item.

**Status:** NOT A CODE DEFECT — deployment convention issue. Tracked
for Sprint 6.6 runbook. No code change.

### OBS-14-003 — `start_health_server` spawns task inside itself; no outer cancel hook

**File:** `sens-api-gateway/src/health.rs:671-703`

**Observation:** `start_health_server` is an `async fn` that internally
calls `tokio::spawn` + returns the spawned JoinHandle. No
cancellation channel; axum's `serve()` runs until the task is aborted
or the process exits.

**Risk:** On graceful shutdown (`ShutdownPhase::DisconnectingMqtt`), the
health server continues accepting requests; orchestrator probes may
still succeed while other subsystems are draining. The agent appears
"healthy" to probes while it's shutting down.

**Proper fix (Sprint 6.7 scope):** `start_health_server` accepts a
`CancellationToken` (or `broadcast::Receiver<()>`); axum's
`Router::with_graceful_shutdown()` consumes the cancel signal and
stops accepting new requests on shutdown.

**Why I didn't fix in Batch 14:** Requires changing the
`start_health_server` signature (breaking for the existing call) +
wiring the `CancellationToken` from the main supervisor. Belongs in
Sprint 6.7 where the ShutdownCoordinator owns all cancel tokens.

**Status:** DEFERRED to Sprint 6.7. Owner: platform-team.
Deadline: Sprint 6.7 (shutdown coordinator wiring).

---

## Meta-invariants

1. **Every observation carries:** file path + line number + observation
   + risk + proper fix + status (FIXED-IN-BATCH-XX / DEFERRED-TO-SPRINT-XX /
   TRACKED-AS-ORPHAN-XXX).
2. **"Deferred" entries must have:** owner + deadline + exit criteria.
3. **"Fixed-in-batch" entries must cite:** the commit SHA once landed.
4. **Every code comment explaining WHY a problem was observed must
   reference an OBS-XX-NNN id** so the session trail is auditable.
