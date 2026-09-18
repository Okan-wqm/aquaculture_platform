# sens-api-gateway — End-to-End Audit (2026-07-11)

**Context.** Full-crate review of `sens-api-gateway/` (Suderra Agent `v2.0.0-rc.4`, ~180k LOC, 247
`src/` files, Rust 2024, tokio 1.43, rustls 0.23, targeting ~2-core ARM edge hardware that drives
real industrial actuators — dosing pumps, aerators, VFDs, relays). Requested dimensions: security,
performance, code quality, architecture. Conducted as 11 parallel read-only passes (6 subsystem
deep-reviews + cross-cutting security-posture, performance, memory/lifecycle, supply-chain, and
architecture passes); `#[cfg(test)]` code excluded from findings. The highest-severity findings
(legacy command bypass, scada_db key derivation, keystore acceptance stub) were re-verified by hand
against source before inclusion.

## Scope

`src/**` (all subsystems: protocol adapters, OPC UA server + PLC client, IEC-61131
scripting/bytecode runtime, security core, data path, SCADA/control, infra/runtime, command
dispatch), `Cargo.toml`/`Cargo.lock`/`deny.toml`, `fuzz/`, `vendor/`, `build.rs`, `README.md`,
`docs/security/**`, and the `.github/` CI workflows that gate this crate. Out of scope: backend TS
services, web MFEs.

## Executive summary

The crate is, at the **primitive level**, genuinely well-engineered: a consistent bounded-mpsc actor
pattern on hardware adapters, TLS 1.3-pinned rustls with a real pinning verifier,
`ed25519_dalek::verify_strict` on the manifest/envelope/license/config trust boundaries,
constant-time comparisons in the LoRa/lifecycle/backup paths, sound and documented `unsafe`
(mlock/prctl/memfd_secret/FFI), a bounds-checked bytecode VM that fails to safe-state rather than
panicking, spec-correct IEC-61131 timers/counters, a hash-chained audit ledger with tamper
detection, and a top-decile supply-chain posture (cargo-deny/audit CI gates, fork-hygiene gate,
cosign-signed tag-only releases).

The systemic weakness is uniform across every subsystem and is the through-line of this report:
**security-critical primitives were built ahead of their runtime wiring, and the wiring is where the
safety guarantees leak.** The consequences are not theoretical. Signature enforcement is bypassed by
the legacy command path even in Enforcing mode; role→permission RBAC is computed and then only
logged; the security-posture config enums default fail-open; the acceptance-ceremony signature is
stubbed to `|_,_| true`; the life-safety `safe_state` runtime still runs the v1 implementation that
its own successor documents as containing four CRITICAL bugs while the fix sits dead-coded; blocking
SQLCipher I/O runs directly on the 2-worker runtime on the store-and-forward hot path; and the core
`io_poll` loop plus the SCADA actuator writer are orphaned, un-cancellable tasks that can drive
outputs during the shutdown/safe-state window. A second theme is **claims-vs-reality drift**: the
"no OpenSSL" FR4 statement, the Clippy deny-wall nullified by CI `-A` overrides, seven feature flags
that gate zero code, and a README three minor versions stale.

**Verdict: BLOCK** for any deployment that relies on the documented command-authentication, RBAC,
at-rest confidentiality, or life-safety safe-state guarantees. The defects are concentrated at
integration seams and are individually fixable without a rewrite; none reflect a coding-competence
problem.

## Findings (by severity)

### CRITICAL

#### EDGE-CRITICAL-003 — Legacy (non-envelope) command payloads bypass signature verification

- **Severity:** CRITICAL · **Layer:** 2 · **State:** OPEN · **Category:** security (auth bypass /
  IEC 62443 FR1+FR3)
- **Evidence:** `sens-api-gateway/src/commands/mqtt_dispatch.rs:135-147` — the `NotEnvelopeFormat`
  arm falls straight to an unauthenticated `serde_json::from_slice::<CommandMessage>()` dispatch
  (verified by hand). `envelope_adapter.rs:113-119` returns `NotEnvelopeFormat` for any plain
  `{command_id,command,params,timestamp}` payload. The Enforcing gate
  (`command_envelope/envelope.rs:435`, `SignatureRequiredInEnforcingMode`) is reached **only** for
  payloads that already parsed as an envelope. `commands/catalog.rs:223` defines
  `legacy_policy: DenyUnsignedInEnforcing` for nearly every mutating command, but a repo-wide grep
  for `legacy_policy` outside `catalog.rs` returns zero matches — the gate is defined and never
  wired.
- **Why it matters:** Anyone able to publish to the command topic (a compromised broker, a
  topic-injection foothold, or any authenticated-but-unauthorized MQTT client) sends a plain legacy
  `CommandMessage` for `write_modbus`/`set_output`/`write_gpio` and it dispatches with **zero**
  signature verification regardless of `signature_mode=Enforcing`. Actuator writes are not in the
  5-command two-person set, so pumps/valves/relays/VFD setpoints can be driven out of safe range.
  The pre-provisioning branch (`mqtt_dispatch.rs:170-184`) also falls to legacy parse for all
  commands unconditionally.
- **Rule violated:** FR1/FR3 (authenticate before act; strict schema on all external input); the
  crate's own `catalog.rs` `LegacyPolicy` SSoT.
- **Fix direction:** Wire `legacy_policy_for_command` into `handle_message` so any
  `NotEnvelopeFormat` payload for a `DenyUnsignedInEnforcing` command is rejected in
  Permissive/Enforcing (Tier-1: legacy path structurally cannot reach a mutating handler while
  enforcing); gate the pre-provisioning fallback to bootstrap-only commands; add an invariant test
  asserting every mutating catalog entry is rejected on the legacy path in Enforcing.

#### EDGE-CRITICAL-004 — Offline-queue replay carries no `(device_id, edge_seq)` dedup key

- **Severity:** CRITICAL · **Layer:** 2 · **State:** OPEN · **Category:** data integrity
  (store-and-forward idempotency / FR3)
- **Evidence:** `sens-api-gateway/src/outbound_publisher.rs:358-390` — on drain the stored payload
  bytes are re-published verbatim; `msg.id` (the AUTOINCREMENT `edge_seq`, `offline_queue.rs:663`)
  is used only for local ack and never injected into the payload. Payloads built by
  `publish_helpers`/`io_poll` contain `{timestamp, tags/alarms}` only. The inline comment relies on
  "QoS-1 dedup for typical brokers," which covers only in-session PUBACK retransmission, not
  cross-session application replay.
- **Why it matters:** Any message published-but-not-acked when the process dies (crash mid-drain,
  `ack_batch` failure) is re-published on next drain with no key the backend can dedupe on. After a
  multi-day outage the backlog is thousands of messages including `MessagePriority::Critical`
  alarms; a crash mid-drain re-ingests everything since the last ack as duplicate telemetry and can
  re-fire already-acted-on life-safety alarms. The AUTOINCREMENT half of the `edge_seq` invariant is
  satisfied; the delivery half is not.
- **Rule violated:** Edge rule 2 (replay MUST carry `(device_id, edge_seq)` in the payload).
- **Fix direction:** Stamp `(device_id, edge_seq)` into the payload envelope at enqueue (or inject
  at drain from `msg.id`); coordinate the field with the backend consumer
  (`sensorprotocols/mqtt-protocol.md` contract change, not a pure edge change).

#### EDGE-CRITICAL-002 (re-scoped / escalated) — SQLCipher key derived from machine-id only

- **Severity:** CRITICAL · **Layer:** 1 · **State:** OPEN (re-occurrence of the anchored
  key-derivation finding in a second store) · **Category:** cryptography (FR4)
- **Evidence:** `sens-api-gateway/src/scada_db.rs:70-78` (verified by hand) — `derive_db_key()` =
  `SHA256("suderra-scada-" + machine_uid::get())`, applied at `scada_db.rs:96-98`. Two failures: (1)
  pure machine-id derivation, no TPM/keyring/device-local secret — `/etc/machine-id` is readable off
  a stolen SD card; (2) `machine_uid::get().unwrap_or_else(|_| "default-machine-id")` yields a
  constant, offline-computable universal key (`SHA256("suderra-scada-default-machine-id")`) whenever
  machine-id is absent. No CRITICAL boot telemetry announces the fallback. This store holds trend
  data, `alarm_history`, `calibration_log`, and the `audit_log` tamper-evidence record.
- **Status of the offline-queue path (anchored EDGE-CRITICAL-002):** contained but not fully closed.
  Production wiring (`main.rs:1438-1475`) now prefers `OfflineQueue::with_keystore_derivation` →
  `db_migration::consumer_key_resolver` (keystore/TPM-aware) and **fails closed** on corrupt
  manifest (`offline_queue.rs:2065-2096`); the silent machine-id demotion on TPM-probe timeout is
  gone. But the keystore-`None` path still falls back to
  `HMAC-SHA256(machine_id, /etc/suderra/db.key)` (`offline_queue.rs:103-140`) with no TPM sealing
  and **no CRITICAL boot telemetry** flagging the unsealed posture. So the rule-4 "machine-id
  fallback must alarm at boot" requirement is unmet on both stores, and `scada_db` reintroduces the
  weakest form.
- **Rule violated:** Edge rule 4 (TPM → keyring → machine-id order; hard-coded/constant keys
  FORBIDDEN; machine-id fallback MUST raise CRITICAL boot telemetry).
- **Fix direction:** Route `ScadaDb` through the same keystore/`consumer_key_resolver` path as the
  offline queue and fail closed on resolver error; delete the `"default-machine-id"` constant
  entirely; emit CRITICAL telemetry at boot whenever any store opens on a non-TPM-sealed key path.
  (See EDGE-HIGH-014 — a shared SQLCipher factory makes this a single fix.)

### HIGH

#### EDGE-HIGH-009 — RBAC role→permission authorization is computed but never enforced

- **Severity:** HIGH · **Layer:** 2 · **State:** OPEN · **Category:** authorization (FR2)
- **Evidence:** `sens-api-gateway/src/commands/dispatch_lifecycle.rs:148-171` —
  `required_perm = permission_for_command(...)` is used only for audit logging and a
  `debug!("RBAC-gate-preview: ... (gate activates Sprint 6.4)")`. Envelope verify proves only
  signature↔pubkey match (`envelope_adapter.rs:147-171`); it never checks the actor's role holds
  `required_perm`. Grep for `authorize|check_permission|has_permission` finds runtime call sites
  only in `opc_ua_server_runtime.rs` and tests — none in MQTT command dispatch.
- **Why it matters:** Any operator enrolled in the RBAC manifest (any valid pubkey) can sign and
  execute any command — a read-only operator can issue `rotate_master`, `apply_signed_manifest`,
  `set_output`. No deny-by-default, no per-command role check. Compounds EDGE-CRITICAL-003: the
  command model is authentication-thin and authorization-absent.
- **Rule violated:** FR2 (single deny-by-default RBAC gate on every command path keyed on
  authenticated role; every allow and deny audit-logged).
- **Fix direction:** Insert a single `PolicyEngine::authorize(actor, required_perm, policy_version)`
  in `execute_command` before dispatch, audited deny on failure; treat unknown command → deny for
  mutating classes.

#### EDGE-HIGH-010 — Security-posture config defaults fail-open; `validate()` is not fail-closed

- **Severity:** HIGH · **Layer:** 2 · **State:** OPEN · **Category:** security (secure-by-default /
  FR1+FR3)
- **Evidence:** `command_envelope/envelope.rs:66-77` (`#[default] SignatureMode::Disabled`, arm
  `(Disabled,_,_) => {}` at `:433`); `mtls/mode.rs:37` (`#[default] Legacy` = pinning log-only);
  `config.rs:271-272,302-352` — `signature_mode`, `rbac_manifest`, `audit`, `keystore`,
  `firmware_update`, `lifecycle_endpoint` are all `#[serde(default)]` → Disabled.
  `config.rs:424-433` `validate()` rejects only `insecure_skip_verify` in release; no coherence
  check on signature/RBAC/mTLS/bind. `main.rs:268-344` `--init` template omits the security stanzas
  entirely.
- **Why it matters:** A fresh deploy or any config missing the security stanzas boots with unsigned
  commands accepted, no RBAC manifest, no audit chain, machine-id-class key fallbacks, and log-only
  pinning — the zero-effort default is the insecure one on a life-safety fleet at rc.4.
- **Rule violated:** Tier-2 make-it-automatic; FR1/FR3 production defaults.
- **Fix direction:** Default to `Enforcing`/`Strict` with an explicit `allow_insecure_dev` (compiled
  out of release); extend `validate()` to fail-closed in release when signature_mode≠Enforcing, RBAC
  disabled, or a non-loopback health bind has no auth. Emit CRITICAL boot telemetry whenever a
  permissive posture runs.

#### EDGE-HIGH-011 — Production keystore acceptance-token verification is stubbed fail-open

- **Severity:** HIGH · **Layer:** 1 · **State:** OPEN · **Category:** security (signed-authorization
  bypass / FR1+FR3)
- **Evidence:** `sens-api-gateway/src/keystore/bootstrap.rs:162-176` (verified by hand) —
  `build_production_keystore_from_config` calls
  `FileBackedAcceptance::try_from_parts(&token, &token.operator_id, &device_id, now, |_,_| true)`.
  The ed25519 acceptance-ceremony signature verify is disabled (`|_,_| true`) and
  `expected_operator_id` is sourced from the token's own claim (a tautology that can never
  mismatch). Comment admits "accept operator-supplied token without crypto verify … Batch 84
  introduces real ed25519 verify."
- **Why it matters:** The acceptance ceremony (ADR-018 §5) is the governance gate keeping the weaker
  file-backed master-key tier unavailable unless a central authority signed off. With `|_,_| true`,
  anyone able to drop `keystore.acceptance.json` (future `expires_at`, any 64 signature bytes,
  `device_id==device_code`) gets a valid acceptance — the entire signed-acceptance rail is
  decorative at runtime.
- **Rule violated:** FR1/FR3 signed-authorization at trust boundary; "no unsigned fallback" (ADR-018
  §5); fail-closed discipline.
- **Fix direction:** Wire real `verify_strict` with a configured ceremony key (fail closed if
  unconfigured); source `expected_operator_id` from provisioning identity; add a boot invariant test
  that a bad-signature token is rejected on the production path.

#### EDGE-HIGH-012 — Live `safe_state` v1 de-energizes every output; v2 polarity fix is dead-coded

- **Severity:** HIGH · **Layer:** 2 · **State:** OPEN · **Category:** life-safety / control
  correctness (FR7)
- **Evidence:** `safe_state.rs:190-218,244-255` — every write-enabled coil/holding register is
  driven to `false`/`0` ("DO safe value = false"). `safe_state_v2.rs:14-18` is `#[allow(dead_code)]`
  "pure type definitions — zero runtime behavior"; its header states it supersedes v1 by fixing four
  CRITICAL life-safety bugs (aerator fail-safe, mutable class-reclassification, `Chemistry` single
  fail-OFF for O2 dosing, dual-Modbus SPOF) but "the v1 SafeStateManager still drives shutdown
  safe-state apply; Faz 2 Sprint 7.2 migrates consumers" — a migration that never landed. Live
  wiring confirmed at `main.rs:4790,4793-4837,5858-5878`.
- **Why it matters:** v1 assumes a single canonical fail-safe (de-energize) for every output. For a
  life-support aerator/O2-injector, de-energize = OFF → O2 depletion and mass mortality — exactly
  the ADR-024 CRITICAL that v2's per-subclass `FailSafe::OnAtPercent` was built to fix. Additionally
  `panic="abort"` means a panic aborts with no safe-state apply at all (outputs hold last-commanded
  state until restart re-runs boot safe-state, still uniform-OFF). There is no per-tag
  fault/stale-triggered safe-state because that logic lives only in unwired v2.
- **Rule violated:** FR7 (safe-state correct per actuator class; life-support fail-ON).
- **Fix direction:** Wire v2 `FailSafe` polarity (from the signed hardware inventory) into
  `SafeStateManager::apply`; add a per-tag stale/fault safe-state path; until migrated, backport the
  four documented fixes into the live v1 path and treat life-support actuators as mis-served by
  uniform-OFF.

#### EDGE-HIGH-013 — SCADA WS commands: unauthenticated None, client-echo Confirm, no RBAC gate

- **Severity:** HIGH (feature `scada-display`) · **Layer:** 2 · **State:** OPEN · **Category:**
  authorization (FR2)
- **Evidence:** `scada_server.rs:1349-1373` — `SecurityLevel::None => execute_command(...)` with no
  auth; `Confirm` sends a `confirmRequest` to the client, satisfied by the client echoing
  `ConfirmResponse{confirmed:true}` (`:1490-1505`) → `execute_command` with no auth. Unknown tags
  default to `Confirm` (`:736-738`). Only `Pin` is server-verified. Origin check allows all RFC-1918
  ranges (`is_private_network_origin`).
- **Why it matters:** `Confirm` looks like an authorization tier but has zero server-side
  enforcement — any script driving the WebSocket bypasses it; `None` tags execute actuator writes
  with no authentication. An attacker passing Origin validation (a page from any private IP, or a
  LAN foothold) can drive any `None`/`Confirm` tag including dosing/aerator/VFD setpoints. This
  local-HMI path does not traverse the deny-by-default command gate. (Loopback-default bind, WS
  Origin check, CSP, connection cap, and no-path-traversal are present and good.)
- **Rule violated:** FR2 (single deny-by-default RBAC gate on every command path).
- **Fix direction:** Make `Confirm` server-enforced (server nonce + authenticated session) or
  collapse into `Pin`; never default unclassified tags to a non-authenticating tier; route SCADA WS
  commands through the same RBAC gate; require an authenticated session before the WS upgrade for
  any mutating capability.

#### EDGE-HIGH-014 — Blocking SQLCipher I/O runs directly on the 2-worker async runtime

- **Severity:** HIGH · **Layer:** 1 · **State:** OPEN · **Category:** performance / real-time
  scheduling (independently reported by 4 passes)
- **Evidence:** Runtime baseline `main.rs:3137-3141` (`worker_threads(2)`,
  `max_blocking_threads(8)`). Bypassing the blocking pool: offline-queue publish/drain during outage
  (`outbound_publisher.rs:227-245,346,384` — sync `enqueue`/`peek_batch`/`ack_batch`, io_poll
  additionally holds the `AppState` read lock across it at `io_poll.rs:413-447`); RETAIN persistence
  per-variable inside the scan tick (`scripting/bytecode_retain.rs:184-233` — K spawn_blocking + K
  autocommit INSERTs/tick, batched API `persistence.rs:293-344` unused); SCADA trend/alarm/cleanup
  (`scada_server.rs:636-672`, `trend_engine.rs:104`, `scada_db.rs:258-263`); jti replay dedup
  (`command_envelope/sqlcipher_dedup.rs:156-219`).
- **Why it matters:** During a broker outage — the exact store-and-forward scenario the device
  exists for — every outbound message synchronously encrypts + writes a WAL frame on one of only two
  worker threads (≥10 blocking INSERTs/sec at 10 Hz io_data = 50% of runtime compute), while io_poll
  holds the `AppState` read lock so config-reload/shutdown writers stall too. RETAIN I/O is awaited
  mid-scan-tick, injecting nondeterministic latency that can trip the task watchdog.
- **Rule violated:** layer-1-rust `spawn_blocking` discipline; edge "bounded latency on constrained
  hardware."
- **Fix direction:** Route all four paths through `spawn_blocking` (or the existing
  `AsyncOfflineQueue` wrappers / a dedicated blocking DB actor); do not hold the `AppState` read
  lock across `publish_*` awaits; batch RETAIN into one transaction per program per tick and persist
  on-change rather than every tick.

#### EDGE-HIGH-015 — `io_poll` and the SCADA executor are un-cancellable tasks racing safe-state

- **Severity:** HIGH · **Layer:** 1 · **State:** OPEN · **Category:** lifecycle / life-safety (FR7)
- **Evidence:** Spawn census: 41 long-lived background spawns / 17 coordinator-tracked / 10
  self-cancelling / **13 orphaned**. `main.rs:4851`
  `tokio::spawn(io_poll::io_poll_loop(state.clone()))` — handle discarded; `io_poll.rs:86-93` loop
  has no shutdown receiver. `main.rs:5581` SCADA executor performs
  `write_coil`/`write_register`/`write_pin` (`:5597-5641`) with no `is_shutting_down` check.
  Shutdown (`main.rs:5832`) waits only on registered tasks, then applies safe-state (`:5864-5878`),
  then disconnects hardware (`:5934+`) — all while io_poll and the SCADA writer keep running.
  `shutdown.rs:108-120` applies the timeout per-task sequentially with no whole-sequence wall-clock
  budget or `process::exit` backstop; the typed `ShutdownPhase`/`DrainState` machine
  (`runtime_safety/shutdown_phase.rs`) is only logged, never driven.
- **Why it matters:** An alarm or HMI write arriving in the window between safe-state apply and
  hardware disconnect overwrites the fail-safe value (the D-15 safe-state-overwrite class). io_poll
  keeps issuing fieldbus reads that race `disconnect_all()` and pins a strong
  `Arc<RwLock<AppState>>` so the graph never `Drop`s (SQLite checkpoint-on-drop, key zeroize-on-drop
  may not run). Worst-case shutdown Σ(per-task timeouts) can exceed systemd `TimeoutStopSec` →
  SIGKILL. Directly contradicts the README TaskTracker/CancellationToken claim.
- **Rule violated:** Crate invariant (every spawn tracked/cancellable); FR7 (safe-state before
  continuing control loops).
- **Fix direction:** Give io_poll and the SCADA executor a shutdown receiver + `tokio::select!`,
  register both with the coordinator, and stop them before the safe-state phase; wrap the whole
  shutdown in one `timeout` with a `process::exit` fallback below `TimeoutStopSec`; migrate the
  coordinator to `tokio_util` `CancellationToken`+`TaskTracker` and drive the typed `DrainState`
  counter.

#### EDGE-HIGH-016 — Bytecode VM watchdog cannot preempt; gas meters opcodes, not wall-clock

- **Severity:** HIGH · **Layer:** 2 · **State:** OPEN · **Category:** scan-cycle determinism /
  resource-limit escape (FR6+FR7)
- **Evidence:** `scripting/bytecode_vm.rs:558-599` — the interpreter is a fully synchronous loop
  with no `.await`; `scripting/bytecode_runner.rs:239` invokes it inside an `async fn` (not
  `spawn_blocking`); `scripting/task_scheduler.rs:605-647` wraps dispatch in `tokio::time::timeout`
  and claims the program "is cancelled" — but with no await point the timeout can only fire at the
  next program boundary, never mid-execution. `StdlibCall` (SQRT/LN/EXP/POW) costs 10 gas but runs a
  real transcendental; `max_gas_per_tick` is operator-signed and unclamped
  (`bytecode_compiler.rs:1691-1702`).
- **Why it matters:** A program with a large signed `max_gas_per_tick` doing transcendental-heavy
  math (or a big loop) runs for real seconds, pinning one of two workers; the "watchdog" only
  records a kill after the program returns. The scan cadence overruns and co-scheduled async work
  (MQTT heartbeat, `sd_notify(WATCHDOG=1)`) is delayed, risking a systemd-watchdog restart of the
  control agent.
- **Rule violated:** FR6/FR7; "no blocking on the async runtime"; scan-cycle determinism.
- **Fix direction:** Run the VM on `spawn_blocking` / a dedicated PLC thread; add an `Instant`-based
  wall-clock deadline checked every N opcodes independent of gas, tripping safe-state on breach;
  clamp `max_gas_per_tick` at a deploy-validated ceiling.

#### EDGE-HIGH-017 — LoRaWAN frame-counter replay protection is bypassable within the counter-flush window

- **Severity:** HIGH (feature `lorawan`) · **Layer:** 2 · **State:** OPEN · **Category:** wire-data
  replay / broken security control (FR3)
- **Evidence:** `lora/mac.rs:695-737` — the uplink replay check reads the last **persisted** counter
  (`sessions.get_session` → SQLite, `lora/session.rs:236-263`) but the successful update writes only
  the in-memory `pending_counters` cache (`lora/session.rs:326-334`), flushed to SQLite every 10 s
  (`lora/mod.rs:258`). For a fresh session (`f_cnt_up==0` in SQLite) the `!= 0` guard disables the
  check entirely until first flush.
- **Why it matters:** An attacker with RF proximity who captures one valid uplink (valid MIC, valid
  FCnt) can retransmit it for up to ~10 s and every replay passes both the FCnt check (SQLite value
  stale) and MIC verification (genuine frame). Each replay emits a fresh `UplinkData` event →
  duplicated sensor values into `ProcessImage` and republished over MQTT, injecting stale
  DO/pH/temperature that can mask a real excursion.
- **Rule violated:** FR3 anti-replay; LoRaWAN 1.0.x §4.3.1.5 strictly-increasing FCnt.
- **Fix direction:** Make the replay comparison authoritative against the freshest counter (max of
  cache and SQLite, or keep the authoritative counter in the MAC layer); advance-and-check
  atomically before emitting any event; treat a fresh-session first frame as a distinct one-shot.

#### EDGE-HIGH-018 — OPC UA per-user session quota is silently defeated by an operator-keyed lease map

- **Severity:** HIGH (feature `opc-ua-server`) · **Layer:** 2 · **State:** OPEN · **Category:**
  security (resource availability / FR7)
- **Evidence:** `opc_ua_sens_auth_manager.rs:394-401` —
  `active_leases: HashMap<String, SessionLease>` keyed by `format_operator_token(&op)` =
  `sens:operator:<hex(operator_id)>`, identical for every session of one operator. A 2nd session's
  `insert` returns the prior `SessionLease`, dropped at statement end, whose `Drop` calls
  `SessionQuota::release`, decrementing the count `try_acquire` just incremented.
- **Why it matters:** The per-user count oscillates at ~1 and never reaches `max_sessions_per_user`
  (default 2). A single compromised operator credential can open sessions up to the global
  `max_sessions` (10) and starve every other operator — the exact "compromised credential
  monopolizes sessions" threat the module claims to prevent. On a life-safety HMI this locks
  legitimate operators out during an incident.
- **Rule violated:** FR7 (per-principal fairness); the module's own architectural contract.
- **Fix direction:** Key `active_leases` on a per-session id (or store `Vec<SessionLease>` per
  operator, never overwrite); add a test opening N>cap sessions for one operator and asserting
  rejection at the cap.

#### EDGE-HIGH-019 — Legacy firmware OTA trusts a co-located checksum instead of a signature

- **Severity:** HIGH · **Layer:** 2 · **State:** OPEN · **Category:** security (integrity / FR3)
- **Evidence:** `commands/firmware.rs:349-364` — integrity is a plain equality against a hash
  downloaded from the same URL base as the artifact; `:178-195` takes `repo` from MQTT command
  params (default overridable to any `owner/repo`); `:310-476` builds the URL, `tar xzf`-extracts,
  `chmod +x`, copies to `/opt/suderra/edge-agent`, `systemctl restart`. The code admits it "does NOT
  run the 8-gate SignedFirmwareManifest verify pipeline" (`:143-144`); `Permissive` mode
  allows-with-warn (`:92-101,132-139`).
- **Why it matters:** A SHA-256 next to the artifact proves non-corruption, not authenticity —
  anyone who can serve the release (attacker-controlled `repo`, compromised GitHub release, or a
  `update_firmware` command in Permissive mode) supplies a matching hash trivially → unauthenticated
  native-code install + service restart = RCE as the agent. `tar xzf` additionally allows
  symlink-member writes outside the extract dir. Fenced by default (`Disabled`) but a fail-open in
  Permissive.
- **Rule violated:** FR3 system integrity; ADR-019 firmware-signing intent.
- **Fix direction:** Remove the legacy tarball path or require an Ed25519 signature over the
  artifact (reuse `apply_signed_manifest`'s verifier); pin `repo` to a compiled-in allowlist; harden
  extraction (reject symlink/`..` members) and verify against a pinned key before install.

#### EDGE-HIGH-020 — Anonymous `/metrics` + `/diagnostics`; health bind not constrained to loopback

- **Severity:** HIGH · **Layer:** 2 · **State:** OPEN · **Category:** security (FR1 anonymous
  metrics / FR5 least functionality)
- **Evidence:** `health.rs:1127-1150` — router registers
  `/health /ready /metrics /metrics/prometheus /diagnostics` with plain `get(...)`; only the
  lifecycle POST route has HMAC auth; no auth layer on the base router. `/diagnostics` is
  "comprehensive diagnostics for remote troubleshooting" (`health.rs:10`). `config.rs:564-573`
  default bind `127.0.0.1:8080` but the doc comment invites `0.0.0.0:8080` and `validate()` does not
  reject a non-loopback bind.
- **Why it matters:** Default is safe (localhost + disabled), but there is no auth option at all,
  and an operator who binds externally exposes comprehensive device internals and topology
  anonymously on the OT VLAN — enabling sensor impersonation and attack planning.
- **Rule violated:** FR1 (no anonymous metrics); FR5 (health bound to localhost/mgmt VLAN).
- **Fix direction:** Require bearer token or mTLS on `/metrics*` and `/diagnostics`, deny by
  default; reject a non-loopback bind in `validate()` unless auth is configured.

#### EDGE-HIGH-021 — Per-scan deep-clone of bytecode programs and tag snapshot causes scan jitter

- **Severity:** HIGH · **Layer:** 1 · **State:** OPEN · **Category:** performance (scan-cycle
  determinism)
- **Evidence:** `scripting/bytecode_registry.rs:203-220` — `list_enabled()` → `list()` does
  `inner.values().cloned().collect()` (clones every `ProgramEntry` incl. full `Bytecode` opcode
  vectors with owned `String`s) then sorts, once per scan tick (`bytecode_runner.rs:182`).
  `bytecode_runner.rs:204` — `SnapshotTagIo::new(snapshot.clone(), declared_types.clone())` clones
  both maps once per program per tick; the snapshot is itself built by a double-allocation in
  `process_image_tagio.rs:292-314`. Freewheeling tasks fire at 100 Hz (`task_scheduler.rs:833-848`).
- **Why it matters:** 10 programs × ~200 string-operand opcodes cloned + sorted 100×/sec, plus N×T
  String clones/sec for the snapshot (≈100k/sec at N=10,T=100), all immediately freed — pure churn
  that varies per-tick wall-clock and undermines deterministic scan timing on 2-core hardware.
- **Rule violated:** IEC-61131 scan-cadence determinism; allocation discipline.
- **Fix direction:** Return `Arc<ProgramEntry>`/`Arc<Bytecode>` from the registry; keep a pre-sorted
  enabled snapshot updated on deploy/enable, not rebuilt per tick; wrap the tag snapshot in `Arc`
  and share one read-only copy across all programs; filter to the task's program subset before
  cloning.

#### EDGE-HIGH-022 — LoRa `downlink_queue` is an unbounded global FIFO (no cap / TTL / eviction)

- **Severity:** HIGH (feature `lorawan`) · **Layer:** 1 · **State:** OPEN · **Category:** memory
- **Evidence:** `lora/mac.rs:130` `downlink_queue: VecDeque<DownlinkItem>`; `:247` `queue_downlink`
  = bare `push_back` with no size/age check; the only removal is a per-`dev_addr` match on an
  inbound uplink (`:850-859`). Fed from cloud/operator via `commands/lora.rs:248` →
  `lora/mod.rs:424`.
- **Why it matters:** Class-A downlinks drain only when the target device sends an uplink. Any
  downlink queued for an offline/de-provisioned/never-responding `dev_addr` is retained forever →
  steady RAM climb → OOM on a 256 MB edge box over months of operation.
- **Rule violated:** FR7 (bounded collections); crate invariant on unbounded growth.
- **Fix direction:** Add a per-item enqueue timestamp and drop items older than the RX-window
  budget; add a hard `MAX_DOWNLINK_QUEUE` cap and/or per-`dev_addr` depth cap.

#### EDGE-HIGH-023 — The Clippy "deny" safety wall is nullified at the merge gate

- **Severity:** HIGH · **Layer:** 3 · **State:** OPEN · **Category:** code-quality / CI integrity
- **Evidence:** `Cargo.toml:533-542` declares `unwrap_used`, `expect_used`, `indexing_slicing`,
  `todo`, `unimplemented`, `dbg_macro`, `print_stdout` and `print_stderr` as `"deny"`.
  The only Clippy CI job (`.github/workflows/sens-api-gateway-ci.yml:210-230`) appends
  `-A clippy::unwrap_used -A clippy::expect_used -A clippy::indexing_slicing …`, overriding the
  manifest deny; other CI jobs run `cargo check`/`test` (no Clippy-only lints). README documents the
  same lints as `"warn"` (`README.md:979-990`) — a third contradictory value.
- **Why it matters:** With `panic="abort"`, any stray `unwrap`/`expect`/OOB-index on malformed
  device or MQTT input aborts the process on a life-safety device. Advertising a deny wall no CI job
  enforces is worse than none — reviewers and the SSoT assume it holds.
- **Rule violated:** Tier-3 make-it-detectable (the gate exists but is disarmed); documentation
  truthfulness.
- **Fix direction:** Remove the `-A` downgrades from the CI Clippy job (or scope to `--tests` only);
  regenerate/delete the stale README lint table; add a CI assertion that the Clippy invocation
  carries no `-A` for the safety lints.

#### EDGE-HIGH-024 — Seven feature flags gate zero code, incl. `signed-deploy` and `live-debug`

- **Severity:** HIGH · **Layer:** 3 · **State:** OPEN · **Category:** code-quality /
  least-functionality (FR5)
- **Evidence:** `Cargo.toml:392-497` declares 20 features; grep for `#[cfg(feature="…")]` finds
  usage only for
  `health/scada-display/lorawan/opc-ua-server/tpm/telemetry/strict-security/sx1302-vendor-hal`. Zero
  `#[cfg]` for `signed-deploy` ("rejects unsigned mutating commands," `:455`), `live-debug`
  ("enables watch_subscribe/force_value," `:485` — but
  `force_commands.rs`/`watch_commands.rs`/`force_registry.rs` compile unconditionally),
  `st-bytecode`, `multi-task-scheduler`, `license-enforce` (pulls `jsonwebtoken`, used nowhere),
  `metrics`, `kani`. CI enables all of them (`:44`) so they compile-check but change nothing.
- **Why it matters:** `live-debug` is meant to keep the force/watch diagnostic surface out of
  release (FR5) — it gates nothing, so the surface is always compiled in; `signed-deploy` is meant
  to be the FR3 unsigned-command rejection gate — inert. Operators/auditors reading the manifest
  believe posture is toggled per tier when the flags are decorative.
- **Rule violated:** FR5; feature-flag hygiene.
- **Fix direction:** For each inert flag, wire the `#[cfg]` gates the comment promises or delete the
  flag + dep + comment; confirm the force/watch/signature surfaces are genuinely gated; add an
  invariant test that every non-alias feature appears in a real `#[cfg]`/`dep:`.

#### EDGE-HIGH-025 — Flat god-module topology, four >4k-line files, an `AppState` god-struct

- **Severity:** HIGH · **Layer:** 2 · **State:** OPEN · **Category:** architecture / maintainability
- **Evidence:** ~55 flat sibling modules (`main.rs:38-211`), no protocol/domain/infra layering.
  God-modules: `main.rs` 6238, `plc_programming/opcua.rs` 6026, `config.rs` 4682 (69 top-level
  types), `st_validator.rs` 4198. `AppState` (`main.rs:390`) is a 20+-field struct referenced 224×
  across 57 files; every subsystem takes `Arc<RwLock<AppState>>` (hub-and-spoke). `main.rs` mixes
  boot orchestration, CLI subcommands, the state struct, and the ~1700-line shutdown/`run_agent`
  sequence; the codebase's own ≤500-line ceiling ("ULTRA-HIGH-013") is violated ~12×.
  `plc_programming/opcua.rs` is a 6026-line hand-rolled OPC UA client stack duplicating
  `async-opcua` with by-hand (and incomplete) message security.
- **Why it matters:** No layer boundaries means any `AppState`/`config.rs` change ripples across 57
  files; the boot order — the single most safety-relevant ordering (keystore before SQLCipher
  consumers, safe-state before control loops, hardening first) — is a 1700-line linear function with
  invariants encoded only in comments, exactly where a reordering regression silently reintroduces a
  hazard. The shared `Arc<RwLock<AppState>>` invites lock-across-await and coarse contention on the
  real-time path.
- **Rule violated:** Root architectural approach (root-cause / no parallel shims); the crate's own
  module-size ceiling.
- **Fix direction:** Introduce explicit layers and demote `AppState` to a thin composition root
  handing each subsystem only its handles; extract an ordered typed `boot::sequence()`; evaluate
  replacing the hand-rolled OPC UA client with `async-opcua`; add a module-dependency arch lint.

#### EDGE-HIGH-026 — No SQLCipher factory: key/pragma ceremony hand-rolled across 19 modules

- **Severity:** HIGH · **Layer:** 2 · **State:** OPEN · **Category:** architecture (root-cause
  enabler of EDGE-CRITICAL-002)
- **Evidence:** 19 modules open their own `rusqlite::Connection`;
  `journal_mode|kdf_iter|PRAGMA key|synchronous|auto_vacuum` appears 73× across them with no shared
  `open_encrypted_db()`/`apply_pragmas()` helper. The sequence is copy-pasted and divergent:
  `offline_queue.rs:179-193` has its own key application; `scripting/persistence.rs:595,698-724`
  re-formats `PRAGMA key` inline and applies a different pragma set (missing `auto_vacuum`). Key
  derivation is partly centralized (`db_secret.rs`, `consumer_key_resolver.rs`) but key
  application + pragma ordering is not.
- **Why it matters:** Rule-4 correctness (PRAGMA key first, kdf_iter re-applied,
  auto_vacuum=INCREMENTAL, TPM→keyring→machine-id ordering) must be identical in all 19 openers;
  with no factory, one module omitting `auto_vacuum`, dropping `kdf_iter`, or mis-ordering the key
  is a per-file regression no single test catches — the exact class that produced EDGE-CRITICAL-002.
- **Rule violated:** DRY / single-source-of-truth for the SQLCipher open sequence; ADR-011/012
  SQLCipher discipline.
- **Fix direction:** Introduce one `SqlCipherDb::open(path, KeyPurpose)` factory owning key
  resolution + full pragma sequence + kdf_iter; make raw `Connection::open`+`PRAGMA key` private to
  it; add an invariant test that no `PRAGMA key` literal exists outside the factory.

### MEDIUM

- **EDGE-MEDIUM-005 — Command freshness / envelope iat-exp / audit timestamps use unauthenticated
  wall-clock, not the initialized `ClockAuthority`.** `commands/envelope_adapter.rs:173-176`
  (`SystemTime::now()`), `mqtt_dispatch.rs:210-212` (`Utc::now()`), `updater/watchdog.rs:223-226`;
  `main.rs:3379-3382` inits `clock_authority` but no path consults it ("wires in Sprint 6.7"). A
  device booting pre-NTP or whose clock steps backward mis-evaluates the replay window and skews
  audit timestamps. → Route freshness/replay/rollback checks through `ClockAuthority::now()` with a
  fail-closed staleness gate; anchor durations on a monotonic source.
- **EDGE-MEDIUM-006 — DB rekey crash-window leaves the DB unopenable with no automatic recovery.**
  `db_migration/rekey_swap.rs:208-229` handles a manifest-write _error_ but not a crash after
  `pragma_rekey` commits and before the manifest write; `consumer_key_resolver.rs:205-238` derives
  strictly from the manifest with no fallback probe. The file itself rejects the 2-phase fix as
  "scope creep." A power cut mid-`--migrate-db` bricks the DB (restore-from-backup only). → Write a
  transitional `V1ToV2InProgress` marker before the rekey; boot-detector probes both keys and
  completes/rolls-back idempotently.
- **EDGE-MEDIUM-007 — `PartitionStore::persist` omits parent-directory fsync after rename, bypassing
  the crate's own atomic-JSON SSoT.** `updater/partition_store.rs:640-667` does
  tmp+`sync_all`+`rename` but never fsyncs the dir;
  `shared_io::atomic_json_sidecar::write_atomic_json` (the 6-step helper) exists and is unused. A
  lost A/B state write after `rename` can disagree with the bootloader flags → boot-loop/bricking
  risk. → Use `write_atomic_json`.
- **EDGE-MEDIUM-008 — Alarm state is not durable across restart (duplicate IDs, orphaned open rows,
  lost acks).** `alarm_engine.rs:74-82,130` constructs empty in-memory state and mints a fresh uuid
  per trigger; no rehydrate from `alarm_history`. On restart a still-true condition re-triggers with
  a new id (duplicate row + re-notify); a cleared condition leaves a phantom open row; acks are
  lost. Deadband hysteresis itself is correct. → Rehydrate active alarms + ack state from
  `alarm_history where cleared_at is null` keyed by rule_id; reconcile conditions cleared during
  downtime.
- **EDGE-MEDIUM-009 — Disk-full / backlog silently drops telemetry and life-safety alarms; disk
  limit is soft; oldest Critical evictable.** `offline_queue.rs:714-742` proceeds with the INSERT
  after `MAX_EVICTION_ROUNDS=10` even if still over `max_disk_bytes`; eviction orders
  `priority ASC, created_at ASC` so a full queue of Criticals evicts the oldest Critical; on a full
  FS the INSERT errors → `publish_helpers.rs:85-96` warn-logs and drops. → Emit CRITICAL telemetry
  (not `warn!`) on enqueue failure / Critical eviction; enforce the disk limit as a hard pre-INSERT
  gate reserving Critical headroom.
- **EDGE-MEDIUM-010 — Systemd watchdog is fed by an independent timer, not gated on runtime
  liveness.** `main.rs:4234-4243` pings `WATCHDOG=1` unconditionally from a standalone task; if the
  control loop wedges but this timer runs, systemd never restarts. → Gate the ping on an `AtomicU64`
  last-poll timestamp updated by the control loop.
- **EDGE-MEDIUM-011 — Program/bytecode/firmware deploy gates use non-strict `ed25519_dalek::verify`
  while every other boundary uses `verify_strict`.** `commands/deploy_bytecode_program.rs:215-219`,
  `deploy_st_source.rs:282-286` (also `bundle_deploy.rs:348,585`, `system.rs:237`). Non-strict
  accepts non-canonical `R` / small-order keys / malleable signatures on exactly the paths that
  flash executable logic onto controllers. → Replace with `verify_strict`; add a grep invariant
  forbidding `.verify(` on ed25519 keys in runtime gates.
- **EDGE-MEDIUM-012 — Reboot rehydration of deployed bytecode is not re-verified against its ed25519
  signature; no upfront structural verification either.** `scripting/bytecode_deploy.rs:214-240`
  verifies once at deploy; the registry store (`bytecode_registry_store.rs:255-264,352-443`)
  persists `bytecode_json` with no signature column and re-runs it after reboot with only
  tenant/version checks. Combined with EDGE-CRITICAL-002, an attacker who rewrites `bytecode_json`
  drives actuators from unsigned opcodes. Structural checks (jump target / local index / stack
  balance) are all runtime-lazy. → Persist `SignedBytecode` and re-`verify_signed_bytecode` at load,
  fail-closed; add a one-pass structural verifier at deploy/rehydrate.
- **EDGE-MEDIUM-013 — PLC OPC UA client sends credentials in cleartext; "secure" modes are
  unimplemented but suppress the warning.** `plc_programming/opcua.rs:2103-2112` sends the UserName
  password as a raw ByteString with null EncryptionAlgorithm; client/UserToken signatures are
  hardcoded null regardless of `security_mode`; `OpcUaConfig::default()` is `None/None` (`:462-478`)
  contradicting the "secure-by-default" doc; the cleartext warning fires only for `mode==None`. →
  Refuse to send credentials unless encrypted; make the default match the docs or delete them;
  warn/reject when a secure mode is selected but not implemented.
- **EDGE-MEDIUM-014 — PLC connection passwords are plaintext `String` with `Debug`/`Serialize`
  derive.** `plc_programming/codesys.rs:59-98`, `opcua.rs:362-384` — no
  `secrecy`/`zeroize`/redaction; `encrypted` toggle accepted but ignored. Any `Debug`-format prints
  the password to logs; `Serialize` round-trips it into config exports. → Wrap in
  `secrecy::Secret`/redacting `Debug`, exclude from `Serialize`, zeroize after use, enforce/reject
  `encrypted`.
- **EDGE-MEDIUM-015 — OPC UA server auth surface is internally incoherent (endpoint advertises only
  anonymous, which the authenticator rejects; X.509 is a permanent stub; `auth_mode` is never
  read).** `opc_ua_server_runtime.rs:329-336` vs `opc_ua_sens_auth_manager.rs:195-252,525-541`;
  `config.rs:2437` `auth_mode` unread. Outcome ranges from "no client can authenticate" to
  "advertised anonymous dead-end"; no end-to-end auth test exists. → Derive endpoint `user_tokens`
  from `user_token_policies`; wire or remove `auth_mode`; add a UserName connect integration test;
  track the X.509 stub as an open gap.
- **EDGE-MEDIUM-016 — Reachable panic in `S7Address::parse` (`split_at(1)` on empty field) from the
  PLC command surface.** `plc_programming/s7comm.rs:399-400` — address `"DB1.DB"` panics; reachable
  from `read_variable`/`write_variable`. With `panic="abort"`+`Restart=always` a
  crafted/fat-fingered address is a crash-loop DoS. (Adjacent: `download_program`
  `program_name[..2]` on non-ASCII, `:1408`.) → Guard `is_empty()` / use `split_at_checked`/`.get`;
  fuzz `S7Address::parse`.
- **EDGE-MEDIUM-017 — VM stack has no depth cap; growth bounded only by an unclamped
  operator-controlled gas budget.** `bytecode_vm.rs:486-491` unbounded `Vec`, push sites never check
  length; `max_gas_per_tick` (u32, ~4e9) unclamped. A `PushConst; Jump 0` loop reaches hundreds of
  MB→GB before gas exhausts → OOM-abort → crash loop. → `MAX_STACK_DEPTH` on every push;
  clamp/validate `max_gas_per_tick`.
- **EDGE-MEDIUM-018 — Torn RETAIN write: multi-variable retain sets are persisted one transaction
  per variable.** `scripting/bytecode_retain.rs:220-233` loops `save_async` per var;
  `save_batch_async` exists (`persistence.rs:293-344`) but is unused. Power loss mid-loop leaves a
  program's RETAIN set half-updated with no generation marker → rehydrates internally-inconsistent
  control state. → One transaction per program per tick + a per-program generation counter.
- **EDGE-MEDIUM-019 — Silent numeric error propagation to actuator tags: `POW` domain NaN, Real Inf,
  and integer wrap bypass the safe-state fault path.** `bytecode_vm.rs:1057-1061` (`POW` no domain
  check) vs `SqrtReal`/`LnReal` which trip `SafeStateTripped` (`:995-1051`); int ops use
  `wrapping_*` (`:628-630`). A NaN/wrapped setpoint reaching a dosing/VFD tag is an undefined
  actuator command with no operator-visible fault. → Uniform NaN/Inf/POW-domain fault handling;
  decide+document integer-overflow policy; reject NaN/Inf at `WriteTag`.
- **EDGE-MEDIUM-020 — Scheduler mutex held across full task dispatch starves the event-trigger
  listener (priority inversion).** `task_scheduler.rs:854-866` holds the scheduler lock across the
  awaited dispatch of all fired tasks; the event listener (`:741-745`) needs the same lock to
  register a `SafetyCritical` trigger. Low-tier execution blocks high-tier triggering. → Snapshot
  the fire list under the lock then release before awaiting; enqueue triggers via a lock-free
  channel.
- **EDGE-MEDIUM-021 — LoRa session store `cleanup_stale` never wired; `sessions`/`used_dev_nonces`
  grow per join forever.** `lora/session.rs:456` exists but only tests call it; the actor loop wires
  `flush`/`cleanup_interval` (tracker) but not `cleanup_stale`. Unbounded disk growth over device
  churn. → Add a `cleanup_interval` arm calling `cleanup_stale`; retention-cap `used_dev_nonces`.
- **EDGE-MEDIUM-022 — SCADA command executor + typed `ShutdownPhase`/`DrainState` machine not wired
  to the runtime.** `main.rs:5581` executor has no `is_shutting_down` check (folds into
  EDGE-HIGH-015); `runtime_safety/shutdown_phase.rs` `apply_transition`/`DrainState` only logged,
  never driven, so drain ordering rests on a single AtomicBool. → Drive the real sequence through
  `apply_transition` + a live in-flight counter around every actuator-write handler.
- **EDGE-MEDIUM-023 — Blocking hardware I/O (I2C/SPI/SX1302 FFI) executed directly on the async
  runtime.** `i2c.rs:498,562,622`, `spi.rs:506,554`, `lora/mod.rs:455,573,591` invoke blocking
  ioctls/C-HAL from `async` actor loops with no `spawn_blocking`. Clock-stretching / SPI FIFO stalls
  a worker. → `spawn_blocking` or a dedicated thread; confine the `!Send` SX1302 HAL to one OS
  thread.
- **EDGE-MEDIUM-024 — `hkdf_expand_32` zeroizes a copy, leaving the real master-key stack copy
  un-scrubbed (both keystore backends).** `keystore/file_backed.rs:657-662` +
  `tpm_backed.rs:659-662` — `let mut mb = master_bytes` copies `[u8;32]:Copy`; `mb.zeroize()` clears
  the copy, original stays live. On the hot derive path, contradicting the function's own comment. →
  `let mut master_bytes` + direct `zeroize()`, or `Zeroizing::new`; fix both backends; add a
  regression test.
- **EDGE-MEDIUM-025 — `DeployCommand` accepts `serde_json::Value` passthrough at the MQTT control
  boundary.** `deploy_orchestrator.rs:59-63,90-95,131-139` —
  `script`/`function_blocks`/`SetpointWrite.value` are untyped; setpoint value not validated against
  `data_type` nor range-checked against safe actuator bounds. → Typed, range-validated structs at
  the boundary.
- **EDGE-MEDIUM-026 — Predictable AppNonce (millisecond timestamp) and non-persistent DevAddr
  allocation weaken OTAA.** `lora/mac.rs:1014-1021` (author comment already flags "use a CSPRNG in
  production"); DevAddr counter resets to `0x0001` on restart (`:171,999-1009`) and `get_session`
  matches by non-unique DevAddr → wrong-device key return after restart. → CSPRNG AppNonce with
  non-repetition tracking; persist/derive DevAddr.
- **EDGE-MEDIUM-027 — Error taxonomy mixes typed per-module enums with stringly-typed escape
  hatches.** `error.rs:178-238` — `AgentError` carries both `Modbus(#[from] ModbusError)` and
  `ModbusLegacy(String)` plus `Config/Mqtt/Gpio/Serialization/Unknown(String)`; the
  `*Legacy`/`Unknown(String)` variants defeat exhaustive matching and let
  `is_recoverable`/`is_security_violation` decisions be bypassed. → Delete the `String` escape
  hatches; typed sub-enum with `#[from]` per domain; `anyhow` at the boundary only.
- **EDGE-MEDIUM-028 — Supply-chain edge gaps (5 items, none contaminating the default shipped
  binary).** (a) `fuzz/Cargo.lock` has no `[patch.crates-io]` so it resolves upstream
  `rumqttc 0.25.1` → `rustls-webpki 0.102.8` + `rustls-pemfile` — reintroducing the five tombstoned
  advisories the main gates forbid, and CI never runs cargo-deny against `fuzz/`. (b) `"no OpenSSL"`
  FR4/threat-model claim is inaccurate — OpenSSL 3.6.2 (`openssl-src 300.6.0`) is statically
  vendored via `rusqlite bundled-sqlcipher-vendored-openssl`, invisible to RUSTSEC. (c)
  `rodbus =1.5.0-RC1` — a release candidate on the primary untrusted-PLC input path. (d) vendored
  SX1302 C HAL has no committed commit/checksum provenance, no LICENSE, and is absent from the SBOM.
  (e) `jsonwebtoken 9.3.1` ships GHSA-h395-gr6q-cpjc (RUST-CVE-002) allow-listed in
  `dependency-review.yml` but with no matching `findings.jsonl` entry (its own rule requires one). →
  Patch the fuzz lock + gate it; reword the OpenSSL claims + track `openssl-src` CVEs; re-evaluate
  the rodbus RC; pin+checksum+SBOM the HAL; register RUST-CVE-002.

### LOW

- **EDGE-LOW-001 — Non-constant-time HMAC comparison in the audit-chain verifier.**
  `audit/verify.rs:205-207` uses `!=` on `[u8;32]` while every other MAC comparison uses
  `subtle::ct_eq`. Offline forensic CLI, limited exposure. → `ct_eq`.
- **EDGE-LOW-002 — OPC UA session AuthenticationToken + SessionId logged at debug.**
  `plc_programming/opcua.rs:2042,2051` `debug!("Auth Token: {:?}")`. With `RUST_LOG=debug` the
  bearer token lands in journald. → Drop or log a short hash prefix.
- **EDGE-LOW-003 — Backup HTTP auth fails open when `BACKUP_AUTH_SECRET` is unset (latent; endpoint
  not yet wired).** `backup.rs:208-224`. → Fail closed for any network-exposed caller; require the
  secret at boot if the endpoint is enabled.
- **EDGE-LOW-004 — SCADA display CSP permits `style-src 'unsafe-inline'`.** `scada_server.rs:851`
  (`script-src` is nonce+strict-dynamic, good). → Nonce/hash the inline styles.
- **EDGE-LOW-005 — SX1302 TX descriptor `size` set from full payload length while only 256 bytes are
  copied.** `lora/sx1302.rs:305-309` — latent OOB read in the C HAL if a downlink ever exceeds 256
  bytes. → `pkt.size = copy_len`; reject oversized payloads pre-FFI.
- **EDGE-LOW-006 — MQTT reconnect backoff has no floor; `mqtt_reconnect_min_secs=0` yields a
  zero-delay reconnect storm.** `mqtt.rs:558-587`, config default 1 but unvalidated. → Clamp to a
  nonzero floor or reject 0.
- **EDGE-LOW-007 — Width-dependent integer overflow in ADS wire-length bounds check (32-bit slice
  panic).** `plc_programming/ads.rs:644-648` — `8 + length` can wrap on 32-bit ARM (RevPi/older Pi)
  → `response[8..7]` panic. → `checked_add`/`.get(offset..)` uniformly.
- **EDGE-LOW-008 — Boot-time process hardening is best-effort (non-fatal) even in release.**
  `main.rs:2968-2978` — if `PR_SET_DUMPABLE=0` silently fails a later crash can coredump key
  material. → Fatal in release, or gate keystore init on hardening success.
- **EDGE-LOW-009 — `#[allow(dead_code)]` debt (146 sites) is overwhelmingly blanket module-level,
  now masking newly-dead code in partially-wired modules.** Nine module-level allows in `main.rs`;
  `bounded.rs:57-188` (13) on a headline FR3/FR7 feature that is unused; `ads.rs:55-123` (23) on
  unused constants. → Per-item allows with tracked IDs; sweep now-wired modules.
- **EDGE-LOW-010 — SQLite hygiene: missing `auto_vacuum=INCREMENTAL`, `is_empty`/`len` return empty
  on lock poison, `synchronous=NORMAL` power-loss window, calibration tolerance advisory-only.**
  `offline_queue.rs:654-680,1017-1043,1126-1153`; `scada_db.rs:100-107`;
  `calibration_engine.rs:402-411` (div-by-zero IS guarded, good). → Add the pragma; error on poison;
  reject out-of-tolerance calibration; require `stable` on confirm.
- **EDGE-LOW-011 — Documentation truthfulness: README headlines v1.3.4 while the crate is
  2.0.0-rc.4, lists 4 of 20 features; ADR numbers collide (031 resolves to 4 documents);
  `strict-security` self-labeled "unused" but used.** `README.md:9,402-421,979-990`; `docs/adr/*`
  collisions; `Cargo.toml:419` vs `security.rs:219,231`. → Regenerate README sections from
  `Cargo.toml`; renumber/date-prefix ADRs before code cites them.
- **EDGE-LOW-012 — String interner effectively unwired and its one call site is net-negative.**
  `interning.rs` is `#![allow(dead_code)]`; `telemetry.rs:282-327` does `intern→resolve→to_string`
  (a hash op + a fresh alloc, worse than `.clone()`). → Wire interned keys through hot-path structs
  or delete the module; fix the telemetry round-trip.
- **EDGE-LOW-013 — Hardware-actor singletons (gpio/pwm/spi/modbus) untracked and never sent their
  `Shutdown` command; `ForceRegistry.last_apply_unix_ms` never pruned.** `gpio.rs:152`,
  `pwm.rs:178`, `spi.rs:211`, `modbus.rs:123` (only I2C/LoRa get `shutdown()`);
  `force_registry.rs:161` grows one entry per distinct forced tag. Bounded, not growth leaks. → Send
  `Shutdown` symmetrically; prune `last_apply_unix_ms` in the 1 Hz sweep.
- **EDGE-LOW-014 — Test architecture: ~26 of 42 invariant files are source-grep "detection seams"
  (refactor-brittle, assert shape not behavior); `stress_test`/`resource_benchmark` are `#[ignore]`
  and never run in CI (thresholds bit-rot).** → Convert the highest-value grep detectors (mTLS
  pinning, OPC UA throttle/quota, cipher allowlist) to behavioral tests; wire the stress/benchmark
  suite into a nightly CI job with thresholds.

## Status of the anchored findings

- **EDGE-CRITICAL-001 (FailoverManager handle lifecycle) — keep OPEN, re-scope.** The acute leak
  symptom is gone (the health-check `JoinHandle` is held in a named binding `main.rs:3346`, the task
  captures only inner `Arc`/`watch` clones, single call site). But it is not closed: the handle is
  explicitly not registered with the `ShutdownCoordinator` ("future work"),
  `FailoverManager::shutdown()` has zero callers, and the manager is not wired into the live broker
  path (`mqtt.rs:17` "to be wired in a future release" — the real event loop never calls
  `record_failure`/`record_success`), so automatic failover does not occur and the lifecycle cannot
  be exercised end-to-end. Re-scope to "complete the FailoverManager wiring (live path +
  shutdown-coordinated handle)." Residual: non-exhaustive `_ => {}` state matches
  (`mqtt_failover.rs:321,371`) and double recovery accounting (`:356,474`).
- **EDGE-CRITICAL-002 (SQLCipher key derivation) — see the CRITICAL section above:** contained on
  the offline-queue path (fails closed on corrupt manifest) but reintroduced in its most dangerous
  form in `scada_db.rs`, and the "machine-id fallback must alarm at boot" requirement is unmet on
  both stores.

## IEC 62443 FR1–FR7 (claim vs code)

| FR                                  | Claim                                                 | Verdict                                                                                                                                                                                                                                             |
| ----------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR1 Identification & Authentication | MQTT mTLS, device certs, Ed25519 command auth         | **Partial** — mTLS + `verify_strict` genuine, but legacy command path bypasses signature (EDGE-CRITICAL-003), keystore acceptance stubbed (EDGE-HIGH-011), anonymous `/metrics`+`/diagnostics` (EDGE-HIGH-020)                                      |
| FR2 Use Control                     | RBAC command authz, tenant isolation                  | **Not enforced on the MQTT path** — RBAC computed then only logged (EDGE-HIGH-009); SCADA WS `None`/`Confirm` bypass (EDGE-HIGH-013)                                                                                                                |
| FR3 System Integrity                | Input validation, signed artifacts, clippy/deny, fuzz | **Partial** — signing/fuzz real, but legacy firmware OTA trusts a checksum (EDGE-HIGH-019), deploy gates use non-strict verify (EDGE-MEDIUM-011), rehydrated bytecode not re-verified (EDGE-MEDIUM-012), Clippy wall disarmed in CI (EDGE-HIGH-023) |
| FR4 Data Confidentiality            | TLS 1.2+, rustls (no OpenSSL)                         | **Partial / misleading** — network TLS is genuinely TLS 1.3-pinned rustls; "no OpenSSL" is false (vendored OpenSSL 3.6.2 statically linked for SQLCipher, EDGE-MEDIUM-028); at-rest key derivation weak (EDGE-CRITICAL-002)                         |
| FR5 Restricted Data Flow            | Rate limiting, circuit breakers, least functionality  | **Partial** — limiters/breakers present; `live-debug` least-functionality gate is inert (EDGE-HIGH-024); non-loopback health bind unrejected (EDGE-HIGH-020)                                                                                        |
| FR6 Timely Response                 | Watchdog, health, graceful shutdown                   | **Partial** — watchdog fed by an independent timer not gated on liveness (EDGE-MEDIUM-010); VM watchdog cannot preempt (EDGE-HIGH-016)                                                                                                              |
| FR7 Resource Availability           | Bounded collections, offline queue, safe-state        | **Partial** — most caches bounded, but LoRa `downlink_queue` unbounded (EDGE-HIGH-022), disk-full drops alarms (EDGE-MEDIUM-009), safe-state uniform-OFF wrong for life-support (EDGE-HIGH-012), orphaned control loops (EDGE-HIGH-015)             |

## Cross-domain dependencies flagged

- **EDGE-CRITICAL-004** (replay dedup) requires a `sensorprotocols/mqtt-protocol.md` envelope change
  coordinated with the backend consumer (**sensor-expert**).
- **EDGE-HIGH-022 / heap growth** has no observability signal — no `process_heap_bytes`-equivalent
  gauge exists for this Rust daemon (**observability-expert**).
- **EDGE-CRITICAL-002 / EDGE-HIGH-026** (SQLCipher factory) and **EDGE-HIGH-015 / EDGE-MEDIUM-022**
  (shutdown coordinator → TaskTracker) are each single root-cause fixes that close multiple
  findings; sequence the factory and the coordinator migration first.

## Verdict

**BLOCK.** The gateway's cryptographic and protocol primitives are strong, but four CRITICAL and
multiple HIGH findings sit on the command-authentication, RBAC, at-rest-confidentiality, and
life-safety-safe-state paths — the guarantees the product is sold on. The unifying cause is
"primitives built ahead of runtime wiring," so the remediation is high-leverage rather than a
rewrite: wire the legacy-command deny + RBAC gate (EDGE-CRITICAL-003 / EDGE-HIGH-009), invert the
fail-open security defaults (EDGE-HIGH-010) and the keystore acceptance stub (EDGE-HIGH-011), route
`scada_db` through the keystore + a shared SQLCipher factory (EDGE-CRITICAL-002 / EDGE-HIGH-026),
stamp the replay dedup key (EDGE-CRITICAL-004), activate v2 safe-state polarity (EDGE-HIGH-012),
coordinate the orphaned control loops through the shutdown coordinator (EDGE-HIGH-015), and re-arm
the Clippy gate (EDGE-HIGH-023). Do not ship a build that advertises the FR1–FR7 posture until at
least the CRITICALs and the fail-open-default HIGHs are closed.

## References

- `.claude/shared/output-format.md`, `.claude/shared/tier-claim-syntax.md`
- `sens-api-gateway/CLAUDE.md` (crate invariants), `sens-api-gateway/README.md` (FR1–FR7 table, HA
  changelog)
- `docs/reviews/edge-expert/2026-04-10-full-repo-audit.md`,
  `docs/reviews/_audit/2026-04-W16-edge-rust.md` (prior cycles; anchored EDGE-CRITICAL-001/002)
- `docs/reviews/_registry/findings.jsonl` (persistent finding state)
