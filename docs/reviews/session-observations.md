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

### OBS-14-004 — Pre-existing `State(state)` pattern scope bug revealed by default=["health"]

**File:** `sens-api-gateway/src/health.rs:707,720,733,740`

**Observation:** Batch 14 changed `default = []` → `default = ["health"]`
which compiled the 4 cfg-gated handlers for the first time. Handlers use
`State(state): axum::extract::State<HealthState>` destructuring pattern.
The pattern matching needs `State` as a BARE NAME in scope — a full-path
type annotation doesn't satisfy tuple-struct pattern syntax. The
`use axum::{... extract::State ...}` was inside `start_health_server`'s
function body, so handler functions (which live OUTSIDE that body) never
saw the import.

**Risk:** Pre-existing compile error that was MASKED by the off-by-default
feature. Revealed by Batch 14's default change. Before Batch 14, nobody
building with default features would have seen this.

**Proper fix (applied in Batch 14 CI-FIX-017):**
- Move `use axum::extract::State;` to module level (cfg-gated).
- Remove redundant function-local `use axum::{...}` in `start_health_server`
  (router methods use full paths).
- Also drop the unused `Duration` import in `std::time` (line 27).

**Status:** FIXED-IN-CI-FIX-017. Commit: TBD.

### OBS-14-005 — Pre-existing `scada_server.rs` warnings (Html unused, state param)

**File:** `sens-api-gateway/src/scada_server.rs:42, 1622`

**Observation:** Pre-existing warnings in main branch (not from my
batches). Not reachable by --no-default-features CI build because
`scada-display` feature gates them. Reachable under the current CI
`--features scada-display` build.

**Status:** PRE-EXISTING, NOT MY BATCHES. Tracked as non-blocking for
Batch 14/15. Sprint-owner dead-code cleanup scope.

---

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

## BATCH-15 wiring observations (OfflineQueue runtime)

### OBS-15-001 — SQLCipher key derivation uses machine-id (plan HC-5)

**File:** `sens-api-gateway/src/offline_queue.rs:apply_db_encryption_key`

**Observation:** `OfflineQueue::with_disk_limit()` (line 321) calls
`apply_db_encryption_key(&conn)` which derives the SQLCipher key from
the device's machine-id (existing v1.6.0 behavior). Plan §2 HC-5
explicitly flags this for replacement by HKDF(master_key).

**Risk:**
- Machine-id is reset on OS reinstall → key irrecoverable → queue data
  lost.
- Machine-id is OS-visible (not secret) → any process with read
  permission can reconstruct the key.
- Machine-id is per-HOST, not per-device-identity → migrating a
  provisioned agent to a new physical machine breaks queue persistence.

**Proper fix (Sprint 6.3 keystore runtime):** HKDF-SHA256(master_key,
info="suderra:sqlcipher:offline-queue:v2") per Batch 4b
`KeyPurpose::SqlCipherOfflineQueue`. Migration path: boot detect v1
key → open existing DB → re-encrypt under v2 key → atomic swap.

**Why I didn't fix in Batch 15:** Keystore runtime (Sprint 6.3)
doesn't exist yet; there's no `master_key` to derive from. Using the
v1.6.0 existing derivation preserves HC-1 backward-compat for current
deployments.

**Status:** DEFERRED to Sprint 6.3 (keystore runtime). Owner:
platform-team. Deadline: Sprint 6.3. Tracked via plan §2 HC-5.

### OBS-15-002 — MQTT publish path NOT wired to enqueue on disconnect

**File(s):** `sens-api-gateway/src/mqtt.rs`,
`sens-api-gateway/src/offline_queue.rs`

**Observation:** Batch 15 wires OfflineQueue construction + AppState
field assignment. However, the MQTT `publish_raw()` code path does
NOT currently call `state.offline_queue.as_ref().enqueue_async()` on
publish-failure OR check the queue on reconnect to drain pending
messages. The queue exists but is unused.

**Risk:** Operators who set `offline_queue.enabled=true` expecting
durability will see NO BEHAVIORAL CHANGE — messages still drop on
broker disconnect.

**Proper fix (Sprint 6.2 MQTT integration):**
1. MQTT publish wrapper checks broker connection state:
   - Connected + queue empty → publish directly.
   - Connected + queue has messages → drain queue first (priority
     order), then publish new.
   - Disconnected → `queue.enqueue_async(topic, payload, priority, qos,
     retain)`.
2. Reconnect handler (`mqtt.rs::on_connect`) triggers drain task:
   - `loop { peek_batch_async(100) → publish each → ack_batch_async() }`
     until queue empty OR broker disconnects again.
3. Backpressure: if queue overflow (`max_size` reached), apply
   `drop_oldest_low_priority` policy so critical messages (audit,
   alarm) survive sustained outages.

**Why I didn't fix in Batch 15:** MQTT integration touches the hot-
path publish code across 4+ call sites in mqtt.rs / commands.rs /
scripting/engine.rs. That's a larger refactor deserving its own
batch. Queue construction is the prerequisite; this batch provides
it. Sprint 6.2 integrates.

**Status:** DEFERRED to Sprint 6.2 (MQTT client integration). Owner:
platform-team. Deadline: Sprint 6.2.

### OBS-15-003 — ORPHAN-006 offline queue flush shutdown no-op still unresolved

**File:** `sens-api-gateway/src/main.rs:1390-1396` (graceful shutdown
step 4)

**Observation:** `ORPHAN-006` (orphan-findings.md) noted that shutdown
step 4 logs "Offline queue flush step complete" but the code is a
no-op placeholder. Batch 15 wires the queue; the shutdown flush is
still a no-op.

**Risk:** On SIGTERM during broker outage, SQLite WAL may not be
checkpointed + fsync'd within the systemd `TimeoutStopSec` window →
last queued audit/telemetry rows potentially lost.

**Proper fix (Sprint 6.7 shutdown coordinator):** `offline_queue`
module exposes `async checkpoint_and_fsync()` awaited in shutdown
step 4. Per ORPHAN-006 recommendation.

**Status:** DEFERRED to Sprint 6.7 (shutdown coordinator). Links to
ORPHAN-006 closure. Owner: platform-team. Deadline: Sprint 6.7.

---

## BATCH-16 observations (ARC-009 WHITELIST decisions)

### OBS-16-001 — 3 utility modules marked WHITELIST-with-rationale

**Files:** `bounded.rs`, `error.rs`, `interning.rs`

**Observation:** Plan §5 Faz 1 Step 8 ARC-009 requires an explicit
WIRE/REMOVE/WHITELIST decision for each dead-code file. Pre-Batch-16
these three had generic `#![allow(dead_code)]` with no architectural
rationale — future reviewers can't tell if they're kept intentionally
or forgotten.

**Fix:** Replace the generic header with a decision block citing:
1. ARC-009 decision: WHITELIST (with "pre-staged for Faz X" note).
2. Why not REMOVE + why not immediate WIRE.
3. Re-evaluation trigger (specific future Sprint landing).
4. Plan reference.

**Status:** FIXED-IN-BATCH-16. Each file's module-level docstring now
carries the decision block. `#![allow(dead_code)]` retained with
pointer to the activation sprint.

**Remaining ARC-009 items:** alarms.rs (WIRE, 968 lines), backup.rs
(WIRE, 715 lines), pwm.rs (ADR-019 envelope), spi.rs (ADR-019
envelope), security.rs (WIRE expand). Each deserves its own batch
given size + coordination needs.

---

## BATCH-17 observations (pwm/spi inventory-pending decisions)

### OBS-17-001 — pwm.rs + spi.rs marked WHITELIST-PENDING-INVENTORY

**Files:** `pwm.rs`, `spi.rs`

**Observation:** Plan §5 Faz 1 Step 8 explicitly flags these two as
"ADR-019 envanter sonrası" — their WIRE-or-REMOVE decision depends on
ADR-019 §5 Hardware Adapter Inventory which enumerates deployed
hardware per device. Pre-Batch-17 no marker; future reviewers couldn't
tell this was intentional deferral.

**Fix:** Module docstrings now carry **WHITELIST-PENDING-INVENTORY**
marker with:
- Per-use-case WIRE/REMOVE matrix (pwm: LED diurnal WIRE / aerator
  REMOVE per ADR-024 §3; spi: MAX31865 RTD WIRE / ADS1256 REMOVE /
  MFRC522 REMOVE per ADR-024 §6 RFID auth ban).
- Why this state (fleet inventory blocks the decision).
- Re-evaluation trigger: Faz 2 Sprint 7.1 hardware-inventory.yaml
  loader, at which point each gets split/wired/removed per the
  inventory truth.
- Plan cross-references.

**Critical safety note (pwm.rs):** Wiring PWM for aerator speed
control would structurally bypass the Batch 3 `FailSafe::OnFull`
life-safety contract (ADR-024 §3 — aerator LifeSupport class requires
digital on/off + hardwired safety override, NOT PWM). The aerator
REMOVE decision is not optional — it's a safety-architectural
constraint.

**Critical security note (spi.rs):** MFRC522 is on the permanent BAN
list per ADR-024 §6 (RFID auth cloneable). If the spi.rs module stays
WIRE after Sprint 7.1, consumers MUST NOT include an MFRC522 driver
path. Safer alternative: split into `src/spi/max31865.rs` purpose-
specific driver that can't re-introduce MFRC522.

**Status:** FIXED-IN-BATCH-17. Decision re-evaluation scheduled for
Sprint 7.1 hardware-inventory landing.

---

## BATCH-18 wiring observations (BackupManager runtime)

### OBS-18-001 — BackupManager constructed but no trigger path

**File:** `sens-api-gateway/src/main.rs` (init_backup_manager) +
`sens-api-gateway/src/backup.rs` (create_backup)

**Observation:** Batch 18 wires `AppState.backup_manager: Option<Arc<
BackupManager>>` and calls `init()` (mkdir backup_dir) at boot, but
there is NO path from operator → `BackupManager::create_backup(..)`
invocation. The instance sits idle. GDPR Art 20 portability requires
an export mechanism; Batch 18 only lands the runtime handle.

**Risk:** Operators may believe backup is active because
`config.backup.enabled=true` + successful mkdir logs "BackupManager
wired", but no actual backup file will ever be written without a
trigger. False confidence is the same failure mode OBS-14-005
(HealthState push-paths) flagged for health telemetry.

**Proper fix:** Sprint 6.x wires two trigger paths:
1. HTTP POST `/admin/backup` — auth via `BACKUP_AUTH_SECRET` +
   `BackupManager::validate_auth()` — returns binary `.sdb` stream OR
   writes to backup_dir.
2. `suderra-agent backup-create [--description STR]` CLI subcommand —
   operator-initiated local snapshot without HTTP exposure.

Scheduled/periodic backup is OUT of scope — Sprint 6.x owners decide
based on operator UX research whether automatic snapshots are wanted
(GDPR doesn't require them; disaster-recovery operators often prefer
manual control to avoid backup-flood).

**Status:** DEFERRED TO SPRINT 6.x (HTTP + CLI wire-up).
Owner: platform-team. Deadline: Sprint 6.x.

**Why I didn't fix in Batch 18:** Batch 18's scope per plan §5 Faz 1
Step 8 is the WIRE decision + constructor invocation so BackupManager
is no longer dead code. HTTP endpoint wiring requires admin-api route
design + CSRF/auth integration + OpenAPI contract — that's Sprint 6.x
territory, outside ARC-009 scope.

---

### OBS-18-002 — BACKUP_AUTH_SECRET loaded but no auth boundary exists

**File:** `sens-api-gateway/src/backup.rs:118-121`

**Observation:** `BackupManager::new()` loads
`BACKUP_AUTH_SECRET` from environment at construction time and stores
it in `backup_auth_secret: Option<String>`. `validate_auth(provided)`
constant-time-compares provided key against stored secret. But no
HTTP endpoint currently invokes `validate_auth()` — the secret is
loaded and held in memory without consumer.

**Risk:** An operator reading the code might assume BACKUP_AUTH_SECRET
is actively enforcing something post-Batch-18. It isn't. The secret
only becomes load-bearing once Sprint 6.x HTTP endpoint lands.

**Proper fix:** Sprint 6.x HTTP endpoint reads `Authorization:
Bearer <secret>` header → calls `backup_manager.validate_auth(token)`
→ returns 401 on mismatch BEFORE streaming any backup bytes. CLI path
does not use the secret (local UNIX socket / systemd-gated binary is
the auth boundary there).

**Additional concern:** Secret-in-memory lifetime. `BackupManager` is
Arc-shared; the secret lives in process memory for the agent's entire
lifetime. Sprint 6.x should consider wrapping in `secrecy::Secret<
String>` + zeroize-on-drop per ADR-018 §5 master-key hygiene.

**Status:** DEFERRED TO SPRINT 6.x (HTTP endpoint + secrecy wrap).
Owner: platform-team. Deadline: Sprint 6.x.

---

## BATCH-19 wiring observations (alarms.rs WIRE-FULL reveal)

### OBS-19-001 — Stale blanket `#![allow(dead_code)]` masked wired code

**File:** `sens-api-gateway/src/alarms.rs:13-14` (pre-Batch-19)

**Observation:** The module carried a blanket
`#![allow(dead_code)]` with a comment `"API reserved for alarms
feature"`. Pre-Batch-19 this was stale: alarms.rs has been runtime-
invoked since io_poll v1.x. Verification paths:
- `AppState.alarm_manager: Arc<RwLock<AlarmManager>>` (main.rs:315)
  constructed in `AppState::new()` (main.rs:432).
- `cmd_register_atlas_alarms` handler (commands.rs ~3456) registers
  pH/DO/temperature high_limit/low_limit alarm definitions.
- `io_poll::poll_atlas_sensors()` (io_poll.rs:147) calls
  `AlarmManager::process_source(tag_name, value)` on EVERY Atlas
  tag read — hot-path invocation.

**Risk:** The blanket allow masked potential legitimate dead-code
warnings. If Sprint 6.x alarms-related code were added and then
later removed without a consumer, the allow would have silently
hidden the newly-orphaned symbols. Defensive suppressions that
aren't routinely re-evaluated become invisibility cloaks.

**Fix applied in Batch 19:** Removed the blanket allow. Module now
has ARC-009 WIRE-FULL decision block in its docstring. `cargo check
--features health` reports ZERO new warnings specific to alarms.rs
— confirming every `pub fn` has a consumer and the module is
legitimately full-wired.

**Audit opportunity:** Grep-search the rest of `sens-api-gateway/
src/` for blanket `#![allow(dead_code)]` and audit each for staleness.
Current inventory (Batch 19 sweep):
- `backup.rs` — KEEP (Batch 18 documented WIRE-PARTIAL; Sprint 6.x
  triggers pending).
- `bounded.rs`, `error.rs`, `interning.rs` — KEEP (Batch 16
  documented WHITELIST).
- `pwm.rs`, `spi.rs` — KEEP (Batch 17 documented WHITELIST-
  PENDING-INVENTORY).
- `alarms.rs` — REMOVED in Batch 19 (this batch).

**Status:** FIXED-IN-BATCH-19.

---

### OBS-19-002 — Optional alarm-class hierarchy deferred to Faz 10

**File:** `sens-api-gateway/src/alarms.rs` + plan §5 Faz 1 Step 8

**Observation:** Plan §5 Faz 1 Step 8 says: `alarms.rs → WIRE
(mevcut basit alarm path genişletilir — opsiyonel alarm class
hiyerarşi Faz 10'a)`. The "optional alarm class hierarchy"
(IEC 61508 SIL-aligned alarm class taxonomy — lifecritical /
routine / diagnostic) is EXPLICITLY deferred to Faz 10 per plan.

**Current Batch 19 state:** `AlarmPriority` enum exists with
Diagnostic/Low/Medium/High/Critical. That is a PRIORITY taxonomy,
NOT a safety-integrity-class taxonomy. Faz 10 §4.3 "IEC 61508 /
IEC 61511 SIL Alignment" adds SIL-2 classification (PFDavg 10⁻³ ≤
PFD < 10⁻²) + diagnostic coverage (DC) ≥ 90% + proof-test interval
6 months + fail-safe documentation per output.

**Risk:** Priority ≠ safety class. An operator reading "CRITICAL"
priority alarm might assume SIL-2 guarantees apply (proof-test,
diagnostic coverage). Pre-Faz-10 the alarm path does NOT make those
guarantees. Misinterpretation could gate a life-safety decision on
an unverified signal.

**Proper fix (Faz 10 §4.3):** Add `AlarmSafetyClass` enum
(SIL0 | SIL1 | SIL2 | SIL3) orthogonal to `AlarmPriority`.
Alarm definitions for life-safety outputs (O2/pH/temp per ADR-024
§3 LifeSupport class) MUST declare a safety class that matches
their output's FailSafe contract. Plan §4.3 outputs: diagnostic
coverage self-test, periodic reference-voltage check, proof-test
runbook per output.

**Status:** DEFERRED TO FAZ 10. Owner: platform-team. Deadline:
Faz 10 §4.3 IEC 61508 SIL alignment.

**Why I didn't fix in Batch 19:** Plan explicitly scopes Batch 19
to "WIRE — existing simple alarm path extended". SIL alignment
requires ADR-019 §5 hardware-inventory-driven safety-class
assignment per output, which is blocked on Sprint 7.1 hardware-
inventory.yaml loader (same Faz 2 gating as OBS-17-001 pwm/spi).

---

## Meta-invariants

1. **Every observation carries:** file path + line number + observation
   + risk + proper fix + status (FIXED-IN-BATCH-XX / DEFERRED-TO-SPRINT-XX /
   TRACKED-AS-ORPHAN-XXX).
2. **"Deferred" entries must have:** owner + deadline + exit criteria.
3. **"Fixed-in-batch" entries must cite:** the commit SHA once landed.
4. **Every code comment explaining WHY a problem was observed must
   reference an OBS-XX-NNN id** so the session trail is auditable.
