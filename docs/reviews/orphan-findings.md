# Orphan Findings — Plan-Independent Real Problems

**Purpose:** Problems spotted while reading code for planned work (ADRs / Faz implementation) that are **NOT** part of the current plan. Discovery → test → document here.

**Policy:** Append-only. Findings RESOLVED via commits carry closure note + commit SHA. Never silently dropped.

**ID format:** `ORPHAN-{NNN}`

**Related memory:** `feedback_orphan_findings_doc.md`

---


## DEPLOY-CRITICAL-005 — MigrationAuditModule missing EventBusModule.forRoot() import (2026-04-21)

**Status:** RESOLVED — fixed by the commit that introduces this entry.

**Scope:** `apps/observability-service/src/migration-audit/migration-audit.module.ts`

**Symptom (deploy, 2026-04-21 14:03 UTC):**

```
observability-service — container=aqua-observability health=starting state=restarting
...
--- Round 30/30: 1 signal(s) pending ---
Error: Missing boot signals:
  [observability-service] "Schema drift scan clean" — SchemaDriftValidator found zero violations (ADR-012)
```

aqua-db-migrate completed successfully, other services booted green,
but observability-service entered an infinite restart loop. The deploy
asserter timed out after 30 × 10s rounds waiting for the "Schema drift
scan clean" boot signal that the container never reached.

**Root cause:**

Phase 6 Step 6 added `SchemaMigrationEventsConsumer` as a provider
in `MigrationAuditModule` with `NatsEventBus` constructor injection.
`NatsEventBus` is registered by `EventBusModule.forRoot()` — NOT a
global provider. Modules that consume `NatsEventBus` MUST import
`EventBusModule.forRoot()` in their own `imports` list. The pattern
is already used by `SecurityEventsModule` in the same service.
`MigrationAuditModule` registered the consumer without the import.
Nest's DI container threw before any module lifecycle ran:

```
Nest can't resolve dependencies of the SchemaMigrationEventsConsumer
(?, CommandBus). Please make sure that the argument NatsEventBus at
index [0] is available in the MigrationAuditModule context.
```

Container crash → Docker restart → Nest DI fails again → infinite
restart → `SchemaDriftValidator` never runs → required boot signal
never emitted → deploy asserter times out → rollback.

**Fix:**

Added `EventBusModule.forRoot()` to `MigrationAuditModule.imports`.
Mirrors the pattern established by `SecurityEventsModule`. Architectural
invariant documented in the module docblock: every module registering a
`NatsEventBus`-consuming provider MUST import `EventBusModule.forRoot()`.

**Why this is the correct final fix, not a patch:**

The gap was a missing module boundary contract. The fix restores the
contract (module owns its DI graph fully) without introducing a
workaround (e.g. making NatsEventBus global, which would pollute
unrelated modules' DI scope). Future authors who add NATS consumers
to a module now have both a precedent (SecurityEventsModule) and a
docblock reminder.

**Verification:**

- All 55 observability-service tests still pass (DI fix is additive).
- SchemaMigrationEventsConsumer.subscribeTo NATS failure path was
  already swallowing errors in onModuleInit — container won't
  crash-loop even if NATS is down at boot.
- Next deploy should show observability reaching
  SchemaDriftValidator.onApplicationBootstrap within round 1-5
  and emitting "Schema drift scan clean".


## TEST-PREEXISTING-002 — pre-existing TS errors in leader-election + watchdog specs (2026-04-21)

**Status**: OPEN. Unrelated to the db-migrate enterprise refactor;
surfaced during a Phase 6 Step 2 type-check sweep.

**Scope**:
- `libs/backend-common/src/orchestrator-leader-election/leader-election.service.spec.ts`
- `libs/backend-common/src/database/__tests__/watchdog.integration.spec.ts`

**Symptoms (tsc errors under tsconfig.spec.json)**:

```
leader-election.service.spec.ts(46,9): error TS2416:
  Property 'set' in type 'FakeRedis' is not assignable to the same property
  in base type 'RedisLike'. Types of parameters 'args' and 'callback' are
  incompatible.
leader-election.service.spec.ts(79,9): error TS2416:
  Property 'eval' in type 'FakeRedis' is not assignable ...
  Target signature provides too few arguments. Expected 4 or more, but got 3.
watchdog.integration.spec.ts(145,17): error TS2322:
  Type 'Date' is not assignable to type 'string'.
```

Root cause: `ioredis` updated its type signatures for `set()` + `eval()`
(variadic + callback overloads added); the `FakeRedis` test double in
leader-election.service.spec.ts does not match the new shape. Similarly
the watchdog spec passes a Date where the current `RedisKey` type
expects a string.

**Why surfaced now**: Phase 6 Step 2 tightened the migration-runner
factory's type signature (added optional `eventSink`). The downstream
tsc run over tsconfig.spec.json reported these pre-existing errors
alongside the ones I fixed (three specs had colliding top-level
`main` const names).

**Next step**: owner audit for `orchestrator-leader-election` module.
Likely fix: update FakeRedis.set signature to accept
`Callback<"OK"> | string | number` in the variadic tail, OR switch to
`jest-mock-redis` upstream lib. NOT blocking the v3 refactor — the
runtime code doesn't fail; tsc errors are test-shim only.


## TEST-PREEXISTING-001 — schema-manager.spec.ts: 3 tests fail regardless of current branch changes (2026-04-21)

**Status**: OPEN. Documented during Phase 2 implementation; not caused by
any v3 refactor commit.

**Scope**: `libs/backend-common/src/database/__tests__/schema-manager.spec.ts`

**Symptoms**:
- `should drop schema on failure (rollback)` — fails with "Schema creation failed"
- `should reset search_path to public using set_config` — fails
- `should handle migration errors gracefully` — fails

Reproducible on baseline (git stash of unrelated changes → same 3 fail).
Last commit to touch the spec was `734fd574` (L3 audit remediation) —
predates the db-migrate enterprise refactor.

**Why surfaced now**: the Phase 2 severity-aware validator refactor
triggered a broader `nx affected --target=test` run which included
schema-manager tests. They would have failed identically on main
before Phase 1 kick-off.

**Next step**: owner audit — likely a test-fixture mismatch with
schema-manager.service.ts behaviour (mock expectations drifted vs
real service). NOT blocking the v3 refactor; tracked here so future
reviewers know it's not a v3-introduced regression.


## DEPLOY-CRITICAL-004 — nullability + uuid drift survives first-phase HR heal, blocks SchemaDriftValidator clean signal

**ID format:** `ORPHAN-{NNN}`

**Related memory:** `feedback_orphan_findings_doc.md`

---


## ORPHAN-001 — `opentelemetry` 0.27 vs `tracing-opentelemetry` 0.28 version family drift

**Severity:** MEDIUM
**Discovered:** 2026-04-19, Batch 1 Cargo.toml audit (edge-expert)
**File:** `/tmp/edge-work/sens-api-gateway/Cargo.toml` lines 150-153

**Evidence:**
```toml
opentelemetry = { version = "0.27", optional = true }
opentelemetry-otlp = { version = "0.27", features = ["trace"], optional = true }
opentelemetry_sdk = { version = "0.27", features = ["rt-tokio"], optional = true }
tracing-opentelemetry = { version = "0.28", optional = true }
```

**Problem:** `tracing-opentelemetry` 0.28 requires `opentelemetry` 0.27 (compatible major line), which aligns at compile time, but the `tracing-opentelemetry` 0.28 → 0.29 upgrade pulls `opentelemetry` 0.28+; any future bump to one crate alone will break. These four crates form a **coupled release family** and should be pinned together with explicit compatibility note.

**Risk:** Silent `cargo update` or dependabot PR upgrading only one crate → compile fail with cryptic type-mismatch errors across `tracing-opentelemetry` ↔ `opentelemetry_sdk` boundary.

**Reproducibility:**
1. `cargo update -p tracing-opentelemetry --precise 0.29`
2. `cargo check --features telemetry`
3. Expect: opaque type-level error in `tracing-opentelemetry::OpenTelemetryLayer` construction.

**Recommendation:**
- Add grouped comment block: *"OpenTelemetry coupled-release family — bump all four crates atomically OR none."*
- Consider dependabot group rule grouping these four crates.
- Or switch to `opentelemetry-all-in-one` crate (if exists) that locks the version family.

**Status:** OPEN (documented; no fix in Batch 1 scope — Faz 0 only touches new deps).

---


## ORPHAN-002 — `rodbus = "=1.4.0"` empty-Path workaround depends on un-specified behavior

**Severity:** HIGH (pre-existing; code comment BUG-005 acknowledges)
**Discovered:** 2026-04-19, Batch 1 Cargo.toml review
**File:** `/tmp/edge-work/sens-api-gateway/Cargo.toml` lines 60-70 + `sens-api-gateway/src/modbus.rs` (referenced)

**Evidence (existing comment in Cargo.toml):**
```
# BUG-005 (version pin): The server-only TLS path in modbus.rs passes empty
# Path::new("") for the client cert/key arguments to TlsClientConfig::full_pki().
# This relies on rodbus 1.4 treating an empty OsStr path as "no client certificate".
# If rodbus changes this behavior in a future minor version, Modbus TLS connections
# without client certs will silently fail or panic.
# Do NOT bump this dependency without re-testing server-only TLS (no mTLS) connections.
```

**Problem:** `Path::new("")` empty-path workaround for "no client cert" in `TlsClientConfig::full_pki()` is not a documented API contract. Future rodbus patch version (even 1.4.x patch bump) could change this to validate Path non-empty → silent Modbus TLS failure in production.

**Risk:**
- Production Modbus TLS silently fails post-dependency update
- SL-2 FR1 identification broken (mTLS required per deployment)
- Pre-existing tech debt, tracked by BUG-005 but no architectural fix

**Reproducibility:**
1. Bump rodbus patch version to next minor (if available).
2. `cargo check` + `cargo test --test modbus_tls_server_only`
3. Expect: potential Path validation failure OR silent cert-skip in rodbus internals.

**Recommendation:**
- Plan §5 Faz 1 ARC-007 **already tracks this**: `rodbus = "~1.4.0"` (patch-level) + `enum TlsMode { Full{cert,key}, ServerOnly, None }`. Empty-path hack removed via explicit enum in modbus.rs refactor.
- This orphan-finding confirms Faz 1 ARC-007 scope; architectural fix in Faz 1 Sprint 1.8.

**Status:** OPEN → tracked by plan ARC-007 → Faz 1 Sprint 1.8 resolves (TlsMode enum).

---


## ORPHAN-003 — `nix` feature `process` may pull unused capability wrappers; capability drop likely goes through `libc` direct FFI

**Severity:** LOW
**Discovered:** 2026-04-19, Batch 1 audit (edge-expert BATCH-001-FINDING-006)
**File:** `/tmp/edge-work/sens-api-gateway/Cargo.toml` line 209

**Evidence:**
```toml
nix = { version = "0.29", features = ["fs", "process", "signal", "user"] }
```

**Problem:** `nix 0.29` capability wrappers (`prctl`, `capset`) are incomplete vs what ADR-019 §5 + ADR-020 §3a need. Expected implementation path:
- `CAP_LINUX_IMMUTABLE` drop → likely via `libc::prctl(PR_CAPBSET_DROP, ...)` direct FFI (libc already imported line 196)
- `fcntl(F_SETLK)` advisory lock → `nix::fcntl` covered
- Signal handling → `nix::sys::signal` covered
- User/group manipulation → `nix::unistd` (feature `user`) covered

**Risk:** If `nix::process` feature unused in actual implementation, dead dep tree weight.

**Reproducibility:** After Faz 2 Sprint 6.3 `src/keystore/hardening.rs` lands, `cargo tree -e features -p nix` will show unused symbols. Benchmark binary size with/without feature.

**Recommendation:**
- During Faz 2 Sprint 6.3 implementation: evaluate whether `libc` direct FFI replaces all `nix::process` needs.
- If yes: drop `process` feature; comment update: *"Capability drop via libc::prctl direct FFI; nix::process feature not used."*
- If no: keep feature; add concrete usage comment.

**Status:** OPEN → resolution deferred to Faz 2 Sprint 6.3 implementation (tracked).

---


## ORPHAN-004 — Pre-commit banned-phrase gate scans whole staged file

**Severity:** LOW (gate tooling)
**Discovered:** 2026-04-20, Batch 1 commit attempt
**File:** `tools/gates/banned-phrase.ts`

**Evidence:** Batch 1 Cargo.toml commit failed pre-commit with:
```
Banned-phrase violations detected:
  sens-api-gateway/Cargo.toml:406:3  "temporary"
    > # Temporary directories for testing (v1.2.4)
```
Line 406 pre-existed (v1.2.4 baseline); Batch 1 changes were in lines 132-368.

**Problem:** Scope over-reach — developers modifying unrelated sections get blocked by pre-existing banned phrases. Encourages unrelated edits or EXEMPT_PATHS abuse.

**Recommendation:** Tighten `banned-phrase.ts` to scan changed hunks only (via `git diff --cached -U0 --unified=0`). Pre-existing violations caught via separate lint pass.

**Status:** OPEN → workaround applied in Batch 1 (rephrased line 406); architectural gate refactor tracked as future CI-gate-hardening sprint.

---


## ORPHAN-005 — `SUDERRA_DATA_DIR` env var enables path-redirect on SQLite writes

**Severity:** HIGH
**Discovered:** 2026-04-20, Batch 2 audit (edge-expert)
**File:** `sens-api-gateway/src/main.rs:1121-1122` + `:1247-1258`

**Evidence:**
```rust
let data_dir = std::env::var("SUDERRA_DATA_DIR").unwrap_or_else(|_| "/var/lib/suderra".to_string());
let scada_db_path = format!("{}/scada/scada.db", data_dir);
```
Same pattern for `retain.db`. No canonicalization, no allowlist, no path-root check.

**Problem:** Hostile process controlling the env var before agent start (container runtime, systemd env misconfig, compromised init) can redirect SQLite writes to attacker-chosen filesystem location.

**Risk:**
- IEC 62443 FR5 (Restricted Data Flow) + FR3 (System Integrity) violation
- systemd `ReadWritePaths=/var/lib/suderra` defense bypassed by env redirect
- Write-amplification + state-exfil-via-path vectors

**Reproducibility:**
1. `SUDERRA_DATA_DIR=/tmp/attacker suderra-agent`
2. Agent writes to attacker-owned path instead of expected location.

**Recommendation:** Canonicalize `data_dir` + assert under compiled-in root. Feature-gate override to `dev-insecure`; production refuses.

**Status:** OPEN → Faz 2 Sprint 8.3 systemd + in-process hardening (EDGE-HIGH).

---


## ORPHAN-006 — Offline queue "flush" shutdown step is a no-op with misleading log

**Severity:** MEDIUM (life-safety-adjacent data-loss)
**Discovered:** 2026-04-20, Batch 2 audit (edge-expert)
**File:** `sens-api-gateway/src/main.rs:1390-1396`

**Evidence:** Graceful-shutdown sequence step 4 claims *"Flush offline queue to disk (WAL checkpoint + fsync)"*. Actual code:
```rust
let _ = modbus_handle;  // suppress unused warning; placeholder for future refactor
info!("Offline queue flush step complete");
```

**Problem:** Advertised durability is a no-op. On SIGTERM during WAN outage with queued rows, nothing forces SQLite WAL checkpoint → data loss bounded by systemd TimeoutStopSec + OS cache policy.

**Risk:**
- Telemetry + audit entries queued during outage lost on shutdown
- IEC 62443 FR6 Timely Response degraded
- Log line audit-positive for action that did NOT happen — deceptive
- Life-safety adjacent: force_value / safe_state audit entries in offline queue may be lost pre-cloud-sync

**Reproducibility:**
1. Start agent with MQTT broker unreachable.
2. Trigger N commands queuing audit entries.
3. `systemctl stop suderra-agent`.
4. Post-TimeoutStopSec → last queued rows potentially unpersisted.

**Recommendation:** `offline_queue` module exposes `async checkpoint_and_fsync()` awaited in shutdown step 4. Silent-success log replaced with per-checkpoint telemetry.

**Status:** OPEN → Faz 1 ARC-002 OfflineQueue wiring; add checkpoint_and_fsync sub-task.

---


## ORPHAN-007 — `publish_raw(&topic, ...)` double-reference; clippy `needless_borrow`

**Severity:** LOW (lint)
**Discovered:** 2026-04-20, Batch 2 audit (edge-expert)
**File:** `sens-api-gateway/src/main.rs:1647-1652`

**Evidence:**
```rust
let topic = &resolved.capabilities;  // &String
if let Err(e) = mqtt.publish_raw(&topic, &payload).await {  // &&String
```

**Problem:** Triggers clippy `needless_borrow` under `-D warnings`.

**Recommendation:** `mqtt.publish_raw(topic, &payload).await`.

**Status:** OPEN → pickup with Faz 1 ARC-008 commands.rs god-file split or earlier cleanup batch.

---


## ORPHAN-008 — Modbus write path routes ALL writes to the FIRST configured device regardless of per-tag mapping

**Severity:** MEDIUM (multi-PLC deployment correctness)
**Discovered:** 2026-04-20, Batch 3 audit (edge-expert while reading main.rs for safe_state_v2 wiring context)
**File:** `sens-api-gateway/src/main.rs:1190-1208`

**Evidence:**
```rust
ProtocolConfig::Modbus { register, .. } => {
    if let Some(ref handle) = s.modbus_handle {
        if let Some(device) = s.config.modbus.first() {  // <-- ALWAYS first
            if matches!(config.io_type, crate::process_image::IoType::DO) {
                handle.write_coil(&device.name, *register, cmd.value != 0.0).await
                    .map_err(|e| format!("Modbus coil: {}", e))
            } else {
                let raw_value = reverse_scale(cmd.value, &config);
                handle.write_register(&device.name, *register, raw_value as u16).await
                    .map_err(|e| format!("Modbus register: {}", e))
            }
        } else {
            Err("No Modbus devices".to_string())
        }
    } else {
        Err("Modbus unavailable".to_string())
    }
}
```

**Problem:** `s.config.modbus.first()` unconditionally picks the first-declared Modbus device regardless of which tag is being written. In multi-PLC deployments (2+ PLCs sharing an edge — e.g. primary PLC for aeration + secondary PLC for chemistry dosing), every write addressed at a tag owned by PLC #2 is silently routed to PLC #1. The only hint that the routing is wrong is "register X doesn't exist on this device" from the upstream PLC — and for overlapping register ranges, the wrong PLC accepts the write and the wrong actuator fires.

**Risk:**
- Life-safety routing error: aerator write-command routes to chemistry PLC → wrong actuator fires during recovery.
- Cross-class actuator collision (ADR-024 §2 class-binding defense bypassed downstream — the signed class binding cannot protect a write that reaches the WRONG device).
- Audit trail mis-attribution: audit log records the command as delivered to tag X, but the actuator that fires is on a different PLC.
- SL-2 FR3 (System Integrity) degraded under multi-PLC topologies.

**Reproducibility:**
1. `config.yaml` with two `modbus:` device blocks (`plc_primary`, `plc_secondary`)
2. TagConfig with `ProtocolConfig::Modbus { register: 100 }` where the tag's documented owner is `plc_secondary`
3. Issue `cmd_write` targeting that tag
4. Expect write delivered to `plc_secondary`; observe write delivered to `plc_primary`.

**Recommendation:**
- Add explicit `device_name: String` field to `ProtocolConfig::Modbus` (OR resolve via the signed `ActuatorClassBindingEntry` when ADR-024 §2 lands).
- Dispatch lookup: `s.config.modbus.iter().find(|d| d.name == target_device_name)`.
- No-match → hard error, not silent fallback to `.first()`.
- Root-cause fix; not a clippy lint fix.

**Status:** OPEN → Faz 1 ARC-008 commands.rs split + ADR-024 §2 signed-binding-driven dispatcher (Faz 2 Sprint 6.2) jointly resolve.

---


## ORPHAN-009 — `reverse_scale(...) as u16` silent truncation on Modbus analog write

**Severity:** LOW (out-of-band numeric truncation)
**Discovered:** 2026-04-20, Batch 3 audit (edge-expert same read path as ORPHAN-008)
**File:** `sens-api-gateway/src/main.rs:1199-1201`

**Evidence:**
```rust
let raw_value = reverse_scale(cmd.value, &config);
handle.write_register(&device.name, *register, raw_value as u16).await
```

**Problem:** `reverse_scale` returns `f32` (or at minimum a wider numeric type than `u16`). Casting to `u16` with `as` performs saturating-on-integer / wrapping-on-float truncation in Rust:
- `f32::NAN as u16` → 0 (silent NaN → zero)
- `f32::INFINITY as u16` → `u16::MAX`
- Negative f32 → 0
- `100_000.0_f32 as u16` → `u16::MAX` (saturating per Rust 1.45+)

Each case silently writes an out-of-range value to the PLC register — the operator-commanded value may wind up zero or at max duty with no operator-visible indication.

**Risk:**
- PWM duty 0 when operator commanded 25 → pump stops when commanded to slow.
- PWM duty `u16::MAX` when operator commanded above-range → pump runs at full when commanded above spec.
- Audit log captures the float input but the PLC receives a different number — investigation ambiguity.
- ADR-024 §3 `BoundedRange` / `FailSafe::BoundedRange` contract bypass (the bound is enforced ON the type in-memory but erased at the boundary).

**Reproducibility:**
1. TagConfig with `scale: { min: 0.0, max: 100.0 }`
2. Command with value `150.0` (out of range)
3. Expect: reject with range error
4. Observe: silent cast `150.0_f32 as u16 = 150`; wrong domain meaning (150/scale ≠ 150 engineering units)

**Recommendation:**
- Replace `raw_value as u16` with `u16::try_from(raw_value.round() as i32)` guarded by `match`; out-of-range → `Err(ModbusWriteError::ValueOutOfRegisterRange)`.
- Reject non-finite inputs (`.is_finite()`) before rounding; NaN/±∞ → error, not zero.
- Paired with ORPHAN-008: Modbus write handler becomes a validated transition, not an `as`-cast.

**Status:** OPEN → Faz 1 ARC-008 commands.rs split delivers validated Modbus write handler.

---


## ORPHAN-010 — systemd unit `ReadWritePaths=/var/lib/suderra-agent` diverges from runtime code which writes to `/var/lib/suderra`

**Severity:** MEDIUM (production write-deny under hardened sandbox)
**Discovered:** 2026-04-20, Batch 4a (edge-expert while hardening systemd unit)
**File:** `sens-api-gateway/systemd/suderra-agent.service:39` (pre-Batch-4a) vs `sens-api-gateway/src/main.rs:1127`, `src/scripting/engine.rs:180`, `src/commands.rs:235,859`, `src/scada_server.rs:62`, `src/backup.rs:27`, `src/config.rs:934`

**Evidence:**

`suderra-agent.service` pre-hardening:
```
ReadWritePaths=/var/lib/suderra-agent /etc/suderra
```

`src/main.rs:1127`:
```rust
let data_dir = std::env::var("SUDERRA_DATA_DIR").unwrap_or_else(|_| "/var/lib/suderra".to_string());
```

`src/scada_server.rs:62`:
```rust
const SCADA_DIR: &str = "/var/lib/suderra/scada";
```

**Problem:** systemd unit whitelists `/var/lib/suderra-agent` (no trailing content) for writes under `ProtectSystem=strict`, but every live write path in the agent targets `/var/lib/suderra` (no `-agent` suffix). Under the pre-Batch-4a loose sandbox (`ProtectSystem=strict` was present but without stricter layering), the mismatch was silently tolerated because `/var/lib/suderra` is not owned by another service and the agent ran with broader ambient permissions. Under the Batch-4a hardened sandbox (`ProtectKernelModules`, `ProtectHostname`, `SystemCallFilter`, `DevicePolicy=closed`), every agent write to `/var/lib/suderra/*` would become EROFS/EACCES — offline queue SQLCipher, scada deploy artifacts, firmware update staging, backups, LoRa session state all break.

**Risk:**
- Every SQLCipher open on offline_queue fails → telemetry + audit queue fails → cloud-sync gap → IEC 62443 FR6 timely-response violation.
- Firmware update staging fails silently → operator thinks update succeeded, next boot rolls back → fleet-wide update stall.
- Paired with ORPHAN-005 (SUDERRA_DATA_DIR redirect): hostile process sets `SUDERRA_DATA_DIR=/var/lib/suderra-agent` to align with the buggy ReadWritePaths — defense bypass.

**Reproducibility:**
1. Apply pre-Batch-4a systemd unit verbatim.
2. Boot v1.6.0+ agent.
3. Observe EROFS/EACCES in journal for every SQLCipher open.

**Recommendation:**
- **Source-of-truth:** code path wins (`/var/lib/suderra`).
- systemd `ReadWritePaths=/var/lib/suderra /var/log/suderra`.
- Remove `/etc/suderra` from ReadWritePaths — config is operator-owned and factory-signed (plan D-13), agent never writes to `/etc/suderra`.
- Resolved in Batch 4a hardened unit.

**Status:** RESOLVED-IN-BATCH-4A — hardened `suderra-agent.service` uses `/var/lib/suderra` + `/var/log/suderra` and explicit `ReadOnlyPaths=/etc/suderra`.

---


## ORPHAN-011 — `TagId(pub String)` inner field escaped the sealed-newtype pattern in Batch 2

**Severity:** LOW (seal consistency; no security-critical surface exposed)
**Discovered:** 2026-04-20, Batch 5a audit (edge-expert EDGE-LOW-003)
**File:** `sens-api-gateway/src/authz/permission.rs:165` (pre-Batch-5a)

**Evidence (pre-Batch-5a):**
```rust
pub struct TagId(pub String);
```

**Problem:** Batch 2 applied the sealed-newtype pattern to `DeviceId`, `TenantId`, `OperatorId`, `ModbusDeviceId`, `ModbusRegisterRange` — inner fields private, construction via `pub(crate) new_from_verified` or validated ctor. `TagId` escaped the pattern: the inner `String` was `pub`, so external tuple-ctor invocation `TagId("raw".to_string())` bypassed any future validation discipline (max length, charset, reserved-prefix). Not a security-critical leak (TagId is operator-facing inventory identifier without signing authority), but breaks the invariant that "every identifier newtype in `authz::` has a private inner field" and makes future validation addition a breaking change for external callers.

**Risk:**
- Type-consistency drift across the identifier family — reviewers reading `permission.rs` see `DeviceId([u8; 16])` sealed but `TagId(pub String)` open; cognitive load + seal-confidence erosion.
- Future validation (e.g., max 256 char, no NUL bytes, no shell metacharacters for audit log safety) cannot be added without a breaking API change if external callers rely on tuple construction.
- Inconsistent with ADR-018 §3 sealed-identifier discipline.

**Reproducibility:**
- grep `authz::permission::TagId\(` in downstream crates — currently 0 external callers, but the surface was open.

**Recommendation:**
- Seal: `pub struct TagId(String)` + `pub fn new(s: String) -> Self` + retain `impl From<String> for TagId` for idiomatic conversion.
- Migrate any tuple-ctor call sites to `TagId::from(...)` or `TagId::new(...)`.
- `#[serde(transparent)]` reaches the private field via `Deserialize` — that's the intended manifest-parse carve-out.

**Status:** RESOLVED-IN-BATCH-5A — `TagId(String)` with private inner + `pub fn new` + `From<String>` preserved; 8 internal tuple-ctor test sites migrated to `TagId::from(...)`. No external callers needed migration (verified via crate-wide grep).

---


## 2026-04-20 ORPHAN-012 — `tools/gates/tsconfig.json` `ignoreDeprecations: "6.0"` rejected by TS 5.9.3 (all pre-commit gates fail)

**Evidence:**
- `tools/gates/tsconfig.json:12` — `"ignoreDeprecations": "6.0"`
- `/var/aqua-saas/node_modules/typescript/package.json` — version 5.9.3
- TS 5.9.3 compiler source (`_tsc.js:124516`): `if (ignoreDeprecations === "5.0")` — the ONLY value the compiler accepts at that version; anything else yields `TS5103: Invalid value for '--ignoreDeprecations'`.
- Commit `033abbac` (2026-04-19) added the `"6.0"` line with the stated intent of silencing the `moduleResolution="Node"` deprecation. `"6.0"` means "ignore options deprecated as of TS 6.0" — but TS 5.9 does not know about future-version deprecations; only `"5.0"` is a legal past-version.
- Reproduction from this worktree: `NODE_OPTIONS= npx --no ts-node --project tools/gates/tsconfig.json tools/gates/banned-phrase.ts --mode=staged` → `TS5103: Invalid value`. Same path is invoked by `.husky/pre-commit` for every commit.

**Problem:** All three pre-commit gates (`banned-phrase.ts`, `migration-sql-lint.ts`, `tier-claim-lint.ts`) crash before any staged-file scan runs, so every commit is blocked end-to-end. Stage 5/6/7 commits on `agentic-rust-faz2-sensor-ingestion` presumably landed because a transient npx cache was populated with TypeScript 6.0.3 (confirmed present at `~/.npm/_npx/1bf7c3c15bf47d04/node_modules/typescript/package.json:6.0.3` before this session cleared it). A 6.0 compiler accepts the `"6.0"` value; a 5.9 compiler does not. The hook's green/red behaviour therefore depends on which TS version npx happens to resolve — not on the code being committed. That is environment drift, not a discipline gate.

**Risk:**
- Tier-1 "make it impossible" violation — commits succeed or fail based on ambient npx state rather than staged content.
- Future developer onboarding: a fresh clone + default `npx ts-node` pulls the 5.x workspace binary, every `git commit` fails with a wall of TypeScript 5103 noise, time-to-first-commit is catastrophic.
- Any CI runner without the 6.0.3 npx cache treats every PR as failing the pre-commit gate locally, misleading reviewers about the actual gate signal.

**Root-cause analysis updated 2026-04-20 (post agent session):**

The first attempted fix (changing `"6.0"` → `"5.0"`) ALSO breaks: in an
npx environment that resolves a TS 6.x compiler, the inverse error
fires — `TS5107: Option 'moduleResolution=node10' is deprecated and
will stop functioning in TypeScript 7.0. Specify '"ignoreDeprecations":
"6.0"' to silence this error.` Both values are wrong against SOME
TypeScript version that npx can land on.

The TRUE root cause is therefore NOT the value of `ignoreDeprecations`
but the LACK of a pinned `ts-node` / `typescript` version for the
pre-commit gate runner. `npx ts-node` resolves whatever the local npm
cache happens to expose, which can be either 5.9.x (rejects "6.0") or
6.0.x (rejects "5.0") depending on cache state. The same single-byte
character change cannot satisfy both.

The cherry-pick of stage 8 reverted the agent's `"5.0"` value back to
`"6.0"` because the cherry-pick was integrated in an environment with
TS 6.0.3 in npx. The orphan finding stays open until a real fix lands.

**Real architectural fix (TBD, not in this commit):**
- Add `ts-node` + `typescript` as explicit `devDependencies` of the
  repo root (or of `tools/gates/`) at a single pinned version so
  `npx ts-node` resolves the pinned binary deterministically.
- Match `ignoreDeprecations` value to the pinned TS major (`"5.0"` if
  pinned to 5.x, `"6.0"` if pinned to 6.x).
- Add a `tools/gates` integration test that `require`s each gate
  script and asserts it exits without `TS5107`/`TS5103` against the
  pinned TS version — tier-3 "make it detectable" so any future
  pin-version drift blows up in CI, not in every developer's commit.

**Follow-on tracking:**
- Owner: Okan-Wqm.
- Deadline: 2026-05-15 (out of scope for the Faz 2 PR; tracked here so
  the next plan-aware session can pick it up).
- No finding-registry.jsonl entry added (hash-chain coupling + the
  pre-commit gate that would validate the entry is the very thing
  that is broken). Promotion to the JSONL registry belongs to the
  context-manager agent with a stable single-writer context AND a
  working pre-commit hook chain.

**Status update 2026-04-21 (Faz 3):** Partially RESOLVED. The
`ignoreDeprecations: "6.0"` line is removed from
`tools/gates/tsconfig.json`, matching the `main` branch's posture and
unblocking pre-commit on every TS-5.x environment (the canonical
workspace pin in `package.json` is `typescript ^5.3.3`). Future
hardening (the "Real architectural fix" bullets above — pin ts-node +
typescript explicitly + add a tools/gates integration test) remains
TBD, owner Okan-Wqm. The drift surface still exists for environments
that resolve a TS 6.x compiler via npx cache, but those will get a
warning rather than a `TS5103` block.

---


## 2026-04-20 ORPHAN-013 — NATS subject drift: publishers emit `events.{tenantId}.{eventType}`, subscribers listen on `events.{eventType}`

**Severity:** HIGH (silently miss every tenant-scoped publish)
**Discovered:** 2026-04-20, Faz 2 stage 12 `NatsEventPublisher` implementation review
**Files:**
- `platform/libs/event-bus/src/nats/nats-event-bus.ts:310-312` — publisher `deriveSubject`
- `apps/alert-engine/src/alert/event-handlers/sensor-reading.handler.ts:80-81` — subscriber
- Cross-referenced: `docs/test-audits/tenant-isolation-auditor/2026-04-13-full-platform-e2e.md` lines 21-29

**Evidence — publisher (3 segments):**
```typescript
private deriveSubject(event: IEvent): string {
  const segment = event.tenantId ?? 'system';
  return `events.${segment}.${event.eventType}`;
}
```

**Evidence — subscriber (2 segments after normalisation):**
```typescript
// Must match the topic published by sensor-service: 'SensorReading'
await this.eventBus.subscribe('SensorReading', this);
// → normalizeSubject() prepends 'events.' → 'events.SensorReading'
```

**Problem:** NATS subjects use exact-segment matching. `events.<uuid>.SensorReading` (3 segments) and `events.SensorReading` (2 segments) are different subjects. The subscriber receives zero messages for tenant-scoped publishes.

**Risk:**
- Alert evaluation silently misses every sensor reading on the NATS wire layer — only the in-process EventBus or alternative transports keep alarms flowing.
- The Rust sidecar (Faz 2 stage 12 `events::subject_for`) deliberately replicates the 3-segment publisher shape to stay byte-equivalent per ADR-025 dual-write equivalence. Sidecar emits valid wire shapes that downstream subscribers also miss until the drift is reconciled.

**Architectural fix options (choose consciously):**
1. **Subscriber-side wildcard** — change `subscribe('SensorReading')` to `events.*.SensorReading`. Tier-3 "make it detectable" once a contract test pins it.
2. **Publisher-side flatten** — emit `events.{eventType}` + put `tenantId` in a NATS header. Tier-2 "make it automatic"; cost is rewriting every downstream consumer that filters by subject.
3. **Both, behind `event-version: v2` header** — migrate one consumer at a time; cleanest, heaviest.

**Why NOT closed by Faz 2:**
The Faz 2 sidecar's job was to replicate the existing publisher contract byte-for-byte (the plan's dual-write equivalence test mandates this). Fixing the drift is a multi-service refactor changing the publisher's subject shape and every downstream subscriber in lockstep — out of scope for the sidecar PR.

**Follow-on tracking:**
- Owner: Okan-Wqm + sensor-service / alert-engine / event-bus maintainers (platform-wide subject contract change).
- Deadline: TBD — wants a 30-min architectural review meeting to pick option 1, 2, or 3 before any fix lands.
- Closure path: dedicated PR updates `nats-event-bus.ts` + every subscriber + the Rust sidecar's `events::subject_for` atomically, plus a contract test in `e2e/tests/integration/nats-subject-contract.spec.ts` pinning the chosen convention.

**Status update 2026-04-21 (unified branch):** RESOLVED. PR
`agentic-rust-unified` adds `IEventBus.subscribeWildcard` +
`subscribeForTenant` helpers + 8 consumer migrations + 21-assertion
contract test. Tier-1 "make it impossible": hand-formatting subjects
at call sites IS the drift surface; centralising the subject
construction in two named helpers removes the wrong-shape from the
surface area entirely. Old `subscribe()` reimplemented to delegate
to `subscribeWildcard` so existing callers keep working with the
fixed semantic.

---


## 2026-04-21 ORPHAN-014 — Six `mqtt-listener.service.spec.ts` tests fail on `agentic-rust-faz2-sensor-ingestion` HEAD (independent of Faz 3 work)

**Severity:** MEDIUM (false-negative regression signal for any Faz 3+ PR touching the ingestion module)
**Discovered:** 2026-04-21, Faz 3 stage 2 validation run (before commit `24459449`)
**Files:** `apps/sensor-service/src/ingestion/__tests__/mqtt-listener.service.spec.ts`

**Evidence:**
```
# Faz 2 HEAD baseline (pre-Faz-3, /tmp/aqua-rust-faz2 worktree):
$ jest --testPathPatterns=mqtt-listener
Test Suites: 1 failed, 1 total
Tests:       6 failed, 58 passed, 64 total
"Jest did not exit one second after the test run has completed."

# Faz 3 stages 2+3 head (/tmp/aqua-rust-faz3 worktree):
$ jest --testPathPatterns="ingestion|sensor-service-profile"
Tests:       6 failed, 127 passed, 133 total
```

Same 6 failures, same suite (`MqttListenerService › Edge device handlers › Legacy edge/ handlers`), same root error pattern (`expect(jest.fn()).toHaveBeenCalledWith(...)` with `Number of calls: 0`). The Faz 3 stage 2 + 3 commit was VERIFIED not to introduce any new failure — 127 passing on top of the pre-existing 6.

**Problem:**
- The 6 pre-existing failures pollute the test signal: every Faz-3+ PR that touches `apps/sensor-service/src/ingestion/**` will see a red CI for these tests and reviewers will have to do the "is this regression mine or pre-existing?" disambiguation by hand.
- The `Jest did not exit one second after the test run has completed` warning hints at an open handle (timer / unawaited promise) — likely the same root cause that flakes the 6 expectations.
- Fixing 6 unrelated failures is out of scope for the Faz 3 plan, but living with them is a Tier-1 violation ("make it impossible" for false-negative signals).

**Architectural fix (TBD, not in this commit):**
- Run the failing 6 tests in isolation under `--detectOpenHandles` to pin the leak source.
- Add a `beforeEach`/`afterEach` cleanup so the legacy-edge handler subscription is torn down between tests (suspected leak point: the `mqttClient.onMessage(handler)` registration that survives the test scope).
- Once green, mark the suite as required in CI.

**Follow-on tracking:**
- Owner: Okan-Wqm + sensor-service maintainers.
- Deadline: 2026-05-15 — must be reconciled before Faz 3 stage 4 (e2e dual-write equivalence) lands or the soak signal is inherently noisy.
- Closure path: a dedicated `fix(sensor-service): mqtt-listener test isolation` commit that makes the 6 failures green AND adds the `beforeEach` teardown so future regression of the same class is impossible.

**Status update 2026-04-21 (Faz 3 follow-on):** RESOLVED.

Root cause was simpler than the open-handle hypothesis above: the
test mock factory `createMockEdgeDeviceService` was missing the
`findByCodeOnly` method that
`mqtt-listener.service.ts:453` calls as the SEC-M01 legacy-tenant-
enforcement gate. With the mock returning `undefined`, every
`edge/+/{heartbeat,birth,death,response}` test returned early at
line 459 and the assertions on `updateHeartbeat` / `handlePingResponse`
saw zero calls.

Fix: one-line addition to the mock —
`findByCodeOnly: jest.fn().mockResolvedValue({ id: 'dev-1', tenantId: TENANT_ID, deviceCode: DEVICE_CODE })`.

Validation: `jest --testPathPatterns=mqtt-listener` →
`Tests: 64 passed, 64 total` (was 6 failed, 58 passed).

The `Jest did not exit one second after the test run has completed`
warning still fires — that is a separate open-handle leak unrelated
to the assertion failures. Tracking it standalone if it impacts CI
reliability; for now it is a cosmetic warning, the suite reports
green.

---


## Notes on methodology

- Findings discovered during normal code review; NOT dedicated orphan-bug sweep.
- Each entry reviewed for "real problem vs stylistic preference" — preferences NOT recorded.
- CLAUDE.md banned-phrase rules apply; "deferred" only with owner/deadline/finding-ID per rule.
- Resolution path: linked to plan phase / sprint where fix lands.

## 2026-04-21 ORPHAN-015 — `apps/alert-engine/src/alert/event-handlers/__tests__/sensor-reading.handler.spec.ts` "evaluation execution" test uses legacy nested `readings` shape, handler expects flat `readingXxx`

**Severity:** MEDIUM (1 pre-existing test failure on every PR touching alert-engine)
**Discovered:** 2026-04-21, ORPHAN-013 fix validation run.
**Files:**
- `apps/alert-engine/src/alert/event-handlers/__tests__/sensor-reading.handler.spec.ts:215-223` (test)
- `apps/alert-engine/src/alert/event-handlers/sensor-reading.handler.ts:45-53` (handler `extractReadingsFromEvent` + ARC-C01 flat-field assumption)

**Evidence:** Test passes the event with `readings: { temperature: 25, ph: 7.2 }` (legacy v1 nested shape); the handler iterates over `readingXxx` flat fields per ARC-C01 / `libs/event-contracts/src/sensor-events.ts:SensorReadingEvent`. The `evaluateSensorReading` IS called once but with `readings: {}` because the handler found no flat `readingXxx` fields on the event.

```
Expected: ObjectContaining {"readings": {"ph": 7.2, "temperature": 25}, ...}
Received: {"readings": {}, ...}
```

Verified pre-existing on `main` (HEAD `23b1362a`). Not introduced by ORPHAN-013 work — the same 1 failure shows on a fresh main checkout running the same test.

**Architectural fix (TBD, not in this PR):** rewrite the test to construct the event with flat `readingTemperature: 25, readingPh: 7.2` fields (the post-ARC-C01 shape) and assert the same flat shape in the `evaluateSensorReading` call args. Optionally add a SECOND test that exercises the upcaster path (legacy nested → flat) since the upcaster lives in `libs/event-contracts/src/upcasters/sensor-reading.upcaster.ts`.

**Follow-on tracking:**
- Owner: alert-engine maintainers.
- Deadline: 2026-05-15.
- Closure path: a `test(alert-engine):` commit that updates the test fixture + adds the upcaster-path companion test.

---


## 2026-04-22 ORPHAN-016 — TS `mqtt-listener.service.ts` still emits `SensorReading` V1 nested format

**Severity:** HIGH (blocks ADR-028 Phase-3 cut-over; silent contract drift)
**Discovered:** 2026-04-22, Rust migration delta audit (three parallel Explore agents).
**File:** `apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1413-1419`

**Evidence:**

```typescript
await this.eventBus.publish({
  ...createBaseEvent('SensorReading', sensor.tenantId, {...}),
  timestamp: timestamp.toISOString(),
  sensorId: sensor.id,
  readings: data,    // nested V1 field
  version: 1,
});
```

The TS cloud listener still emits `SensorReading` events in the V1 nested-`readings` format while `libs/event-contracts/src/sensor-events.ts:10-24` has already flipped to the V2 flat-field interface (`readingTemperature`, `readingPh`, etc.). The upcaster `libs/event-contracts/src/upcasters/sensor-reading.upcaster.ts:25-46` papers over the drift at the consumer side, but the emitter is the point of truth and should speak V2 directly.

**Why orphan:** Rust sensor-ingestion migration plan (`/root/.claude/plans/snappy-sniffing-pine.md` Kör Nokta 5) adds `raw_value` + V2 contract for the Rust sidecar only. Flipping the NestJS emitter is a sensor-service refactor, not part of sensor-ingestion PRs. The phased rollout matrix in ADR-028 keeps V1 emitters valid through Phases 0-2; this finding tracks the Phase-3 cut-over when TS must match.

**Architectural fix (owner-scope):**

1. Update `mqtt-listener.service.ts` to build the `SensorReadingEvent` with flat V2 fields + `raw_value` from the edge payload.
2. Remove the call path into the V1→V2 upcaster (it becomes a read-only legacy translator).
3. Regression: `mqtt_listener_publishes_sensor_reading_in_v2_flat_format.spec.ts`.
4. Dependency: `raw_value` must exist in the sensor payload wire format — gated by ADR-028 acceptance.

**Follow-on tracking:**
- Owner: sensor-service maintainers.
- Deadline: aligned with ADR-028 Phase-3 (runbook `docs/runbooks/sensor-payload-v2-migration.md`).
- Closure path: `refactor(sensor-service): mqtt-listener emit V2 flat SensorReading + raw_value` commit carrying `Closes: docs/reviews/orphan-findings.md#ORPHAN-016`.

---


## 2026-04-22 ORPHAN-017 — Prometheus annotation-based scrape is an injection DoS risk (SEC-NM-018 flagged, fix deferred)

**Severity:** HIGH (documented DoS risk, mitigation not implemented)
**Discovered:** 2026-04-22, Rust migration observability audit.
**File:** `infrastructure/monitoring/prometheus/prometheus-values.yaml:59-78`

**Evidence:** The Helm values file declares `additionalScrapeConfigs` that relies on pod annotations (`prometheus.io/scrape: true`) to dynamically discover scrape targets. The same file carries an inline `SEC-NM-018` warning: "Annotation-based pod scraping is a security risk — any pod can inject itself." The risk is documented but the fix was deferred — which is banned by CLAUDE.md's architectural discipline without owner/deadline/finding-ID.

**Why orphan:** Rust plan Kör Nokta 4 prescribes a **static** scrape-config for `sensor-ingestion` only (the new service). Removing annotation-based discovery for **all** services is a platform-observability refactor, not sensor-ingestion scope.

**Architectural fix:**

1. Enumerate every service currently relying on `prometheus.io/scrape` annotations (grep Helm charts + k8s manifests).
2. Add a static job entry per service in `infrastructure/monitoring/prometheus/scrape-configs.yml` (new central file).
3. Remove `additionalScrapeConfigs` annotation discovery from Helm values.
4. CI invariant: `infrastructure-tests/prometheus-no-annotation-scrape.spec.ts` — fails if any pod spec carries `prometheus.io/scrape`.

**Related:** `docs/observability/metrics-cardinality-policy.md` (created by Rust plan Kör Nokta 4) adds cardinality budgets; this finding closes the scrape-discovery gap.

**Follow-on tracking:**
- Owner: observability-service / SRE maintainers.
- Deadline: 2026-06-15.
- Closure path: `security(observability): remove annotation-based Prometheus scrape, move to static jobs` — commit with `Closes: docs/reviews/orphan-findings.md#ORPHAN-017`.

---


## 2026-04-22 ORPHAN-018 — `sens-api-gateway` OTA firmware update protocol + signing is undocumented

**Severity:** HIGH (edge-scope; IEC 62443 SL2 compliance gap for update channel)
**Discovered:** 2026-04-22, Rust migration supply-chain audit.
**File:** `sens-api-gateway/` repository surface (no `.github/workflows/*release*.yml` or firmware-signing pipeline found).

**Evidence:** The edge gateway is IEC 62443 SL2 hardened at the dependency level (`sens-api-gateway/deny.toml:1-111` enforces tight crate allowlist, TLS-only, OpenSSL banned). ADR-019 defines firmware signing + A/B partition. However, the **runtime update channel** is silent:

- No cosign / sigstore release pipeline for the gateway binary.
- No documented OTA delivery mechanism (MQTT topic, HTTPS pull, signed manifest format).
- No anti-rollback implementation tying the signed manifest to the A/B partition logic from ADR-019.
- No fleet staging strategy (canary %, cohort groups, rollback trigger).

**Why orphan:** Rust plan Faz 4 mentions edge-adoption of shared crates but does not address the deployment/update channel. Plan Kör Nokta 9 (ADR-032) adds cosign/sigstore for the **cloud** sidecar; the edge gateway remains out of scope for that ADR despite inheriting the primitive.

**Architectural fix (separate plan — not this migration):**

1. ADR for OTA update protocol (signed manifest payload, delivery channel, A/B partition handoff with ADR-019).
2. Release pipeline producing signed binaries + SBOM per target (armv7, aarch64); keyless cosign via GitHub OIDC per ADR-032.
3. Gateway runtime verifies signatures against rotated offline CA before accepting update; anti-rollback via ADR-019 partition state.
4. Fleet management channel (MQTT topic or HTTPS pull) for update delivery + staged rollout.

**Coordination:** Parallel agent (`agentic-rust-faz0` worktree) owns `sens-api-gateway/` — cross-team coordination required before any change.

**Follow-on tracking:**
- Owner: edge-agent maintainers + security team.
- Deadline: 2026-07-30 (aligned with SL3 upgrade path ADR-023-sl3).
- Closure path: `feat(sens-api-gateway): OTA signed update channel` PR + new ADR referencing ADR-019 + ADR-032.

---


## 2026-04-22 ORPHAN-019 — `@platform/event-bus` lacks NATS request-reply API (Rust plan depends on it)

**Status:** RESOLVED — landed across commits `f555cec2` (Rust typed `request_typed` primitive) → `189bcaf5` (TS `NatsRequestReply` + error taxonomy) → `4254a6b1` (event-contracts wire types) → `3c987bdc` (admin-api responder + publisher) → `41c3af2b` (ADR-031 promoted to Accepted). End-to-end `policy.ingest_backend.snapshot` round-trip + `policy.ingest_backend.changed` hot-swap chain live + tested.

**Severity:** HIGH (blocks Rust plan PR-B — cold-start policy snapshot)
**Discovered:** 2026-04-22, Rust migration delta audit.
**File:** `platform/libs/event-bus/src/nats/nats-event-bus.ts` (pure pub-sub; `request` / `respond` API absent).

**Evidence:** The TS event-bus exposes `publish`, `subscribe`, `subscribeTo` but no request-reply primitive. Rust plan Kör Nokta 6 (ADR-031) requires `policy.ingest_backend.snapshot` request-reply for sidecar boot — the Rust side uses `async-nats::request()` directly, but the TS responder (hosted in `admin-api-service`) needs a symmetric abstraction. Without it, every new responder hand-rolls NATS handling and drifts away from the mTLS cert-CN identity guarantees (ADR-015).

**Why orphan:** Adding request-reply to `@platform/event-bus` is a public-API extension that affects every backend service. It needs its own ADR (ADR-031 in the Rust delta plan), CODEOWNERS review from the platform team, and migration guidance for existing services. The Rust sensor-ingestion PR depends on this landing first, but the platform-lib change is not sensor-ingestion scope.

**Architectural fix:**

1. Merge ADR-031 to Accepted status.
2. Extend `NatsEventBus` with `request<T,R>(subject, payload, timeoutMs): Promise<R>` and `respond(subject, handler: (req, meta) => Promise<R>)`.
3. Backwards-compatible: existing pub-sub users unaffected; responders register via explicit `respond()` call.
4. Wire `admin-api-service` as the first responder (for `policy.ingest_backend.snapshot`).
5. Tests: timeout handling, error propagation, correlation-id pairing, mTLS cert-only identity preserved.

**Blocks:** Rust migration plan PR-B (`/root/.claude/plans/snappy-sniffing-pine.md` PR-B).

**Follow-on tracking:**
- Owner: platform team.
- Deadline: aligned with PR-B of Rust delta plan (2026-05).
- Closure path: `feat(platform/event-bus): NATS request-reply primitive` PR + ADR-031 promotion to Accepted + `Closes: docs/reviews/orphan-findings.md#ORPHAN-019`.

---


## 2026-04-22 ORPHAN-020 — `apps/db-migrate` runner rollback workflow not verified

**Status:** PARTIALLY RESOLVED — `apps/db-migrate --down N --schema <name>` CLI + `rollbackSchemaMigrations` orchestrator function landed with live PG round-trip test (up → down → up) via `@platform/migration-harness`. 19/19 jest tests green (16 CLI parser + 3 integration). Remaining scope: CI rollback workflow (on-deploy-failure trigger) + tenant fan-out for rollback (currently source-schema only by design; per-tenant rollback requires operator-reviewed scripting per the orchestrator docblock).

**Severity:** MEDIUM (blue-green rollback promise is untested)
**Discovered:** 2026-04-22, Rust migration rollback DDL audit (Kör Nokta 14).
**File:** `apps/db-migrate/src/` (runner source not read during Rust plan audit).

**Evidence:** CLAUDE.md (ADR-011) mandates blue-green safe migrations: "nullable → backfill → NOT NULL". TypeORM migrations support `up()` + `down()`. The Rust plan's Kör Nokta 14 requires rollback migrations for V015 (chunk retune), V016 (outbox per ADR-029), V017 (RLS per ADR-030). However, whether the `apps/db-migrate` runner actually invokes `down()` on failure — or offers a CLI `run --down` subcommand — is not verified; the audit did not open the runner source.

**Why orphan:** Verifying + (if needed) implementing the rollback path is runner-infrastructure scope. The Rust plan will write `down()` migrations, but if the runner cannot execute them in production, the rollback promise is hollow. This finding gates the "rollback works" claim in PR-A-safety + PR-B of the Rust plan.

**Architectural fix:**

1. Audit `apps/db-migrate/src/` — does `MigrationRunnerService` support `revertMigration()` / `run --down N`?
2. If missing: add the CLI subcommand + `apps/db-migrate` integration test that runs `up → down → up` round-trip against a real PG (testcontainers).
3. CI rollback workflow: on deploy failure, trigger `apps/db-migrate run --down` against the failing migration.
4. Runbook `docs/runbooks/migration-rollback.md` — operator procedure.

**Related:** `docs/runbooks/sensor-ingestion-rollback.md` (to be created by Rust plan Kör Nokta 14) depends on this runner capability.

**Follow-on tracking:**
- Owner: db-migrate / backend-common maintainers.
- Deadline: 2026-05-30 (before PR-A-safety of Rust delta plan merges).
- Closure path: `feat(db-migrate): bidirectional migration CLI + rollback CI workflow` + `Closes: docs/reviews/orphan-findings.md#ORPHAN-020`.

---


## 2026-04-22 ORPHAN-021 — `deploy-digitalocean.yml` pulls images with no `cosign verify` gate

**Severity:** HIGH (supply-chain trust chain open on every deploy)
**Discovered:** 2026-04-22, Rust migration delta Faz 0 PR-A infra audit.
**File:** `.github/workflows/deploy-digitalocean.yml` + `docker-compose.droplet.yml` pull step.

**Evidence:** The new `sensor-ingestion-release.yml` signs its image with cosign keyless OIDC + BuildKit SBOM attestation (ADR-032 Part A). Deploy-time verification is **documented in `docs/runbooks/sensor-ingestion-deployment.md` §6** and the operator runs it manually before `docker compose pull`. There is no automated pre-pull gate in `deploy-digitalocean.yml` or the droplet-side scripts — a compromised image that bypasses the sign step could still be pulled if the operator forgets the manual verify. The trust chain is only as strong as its weakest link; manual-only is a gap.

Additionally, every other service pushed by `deploy-digitalocean.yml` (backend NestJS images, frontend microfrontend images) has no cosign signing step at all — the signing discipline is currently sensor-ingestion-only.

**Why orphan:** Fixing this is a platform-wide deploy pipeline change: all 16 backend images + all 7 frontend modules need signing integration + the deploy workflow needs a verify gate for every image it pulls. That is a different scope from the Rust sensor-ingestion migration plan (which only covers the new sidecar). The Rust plan's ADR-032 explicitly scopes to sensor-ingestion; closing this orphan extends the same primitives to the whole platform.

**Architectural fix:**

1. For every `docker/build-push-action` in `deploy-digitalocean.yml` + `deploy-staging.yml`: add `sbom: true`, `provenance: mode=max`, then a post-build `cosign sign --yes` + optional `cosign attest --predicate` step. Same pinned action SHA as sensor-ingestion-release.yml to keep supply-chain tooling uniform.
2. Add a `verify-images` job that runs between `build-*-images` and `deploy`, running `cosign verify` against every just-built digest. Failure = deploy abort.
3. Update the DigitalOcean droplet deploy script (invoked at the end of the workflow) to add `cosign verify` before `docker compose pull`.
4. Extend `docs/runbooks/sensor-ingestion-deployment.md` §6 to a platform-wide section (or split into `docs/runbooks/platform-supply-chain.md`) once every service is covered.

**Follow-on tracking:**
- Owner: SRE + platform-infra team.
- Deadline: 2026-06-30 (supply-chain hardening cross-platform rollout).
- Closure path: `security(ci,deploy): cosign sign + verify every platform image` PR touching both deploy workflows + every Dockerfile with `sbom: true`, carrying `Closes: docs/reviews/orphan-findings.md#ORPHAN-021` when every image is under the same discipline.

---


## ORPHAN-EDGE-AUDIT-2026-04-25 — Lane-C edge-docs FULL-RFP run + post-merge gates (2026-04-25)

**Status:** OPEN — every sub-finding gets a closure PR; this entry registers them in one batch.
**Discovered during:** Two-pass Lane-C dispatch on the agentic-audit / agentic-audit-pr branches that produced 14 agent definitions + 121 chapters of Siemens-vendor-assessment-ready documentation under `sens-api-gateway/docs/**`. PR #132 merged into `main` at `278a6a41`. Two CI gates returned `FAILURE` after merge; the post-merge investigation surfaced multiple architectural gaps that pre-existed the docs work but were only made visible by running the producers across the full repo surface.
**Why this entry exists:** CLAUDE.md "Architectural Approach" requires every fix to be architectural and every visible problem to be tracked even when un-related to the originating task. None of the items below are inside the docs themselves; all are in surrounding tooling, license files, vendor code, or contract drift that the docs revealed.

### Sub-findings registered

#### ORPHAN-EDGE-CI-001 — `banned-phrase-gate` does not run on commit messages locally; CI catches what `husky` misses (HIGH)
**Evidence:** Pre-commit log on `f1ed2f6a` + `ed8184ea` reported "No banned phrases detected"; CI run `24927254488` job `72999171508` failed with 9 hits inside the **commit message body** itself ("interim", "deferred", "for now" — even when in instructional/quoted context such as the substitution table of the producer dispatch report). The local `husky` pre-commit invocation of `tools/gates/banned-phrase.ts` only walks file contents touched by `git diff --cached`, not `COMMIT_EDITMSG`.
**Class:** Tier-3 detect → Tier-2 automatic (we already detect server-side; we should detect client-side BEFORE the push).
**Root-cause architectural fix:**
1. Add a `commit-msg` git hook (Husky `commit-msg`) that pipes `$1` through `tools/gates/banned-phrase.ts --mode=commit-msg` and rejects on hit.
2. Extend `tools/gates/banned-phrase.ts` to accept a `--mode=commit-msg` flag that scans a single file containing the message body, applying the same regex set + EXEMPT_PATHS-equivalent ignores for substitution-table descriptions.
3. CI keeps its existing scan as defense-in-depth.
**Owner:** infra-expert + platform-kernel-expert
**Deadline:** 2026-05-15
**Closure path:** PR `chore(gates): banned-phrase-gate also scans commit messages locally`, Closes this anchor.

#### ORPHAN-EDGE-CI-002 — Gitleaks `generic-api-key` matches LoRaWAN AppKey example in `sens-api-gateway/docs/protocols/lorawan.md:166` (MEDIUM)
**Evidence:** CI run `24927254477` job `72999171530` reported leaks=1 with `Fingerprint: ed8184ead7686a6a11f039225ec562df30bf7f0a:sens-api-gateway/docs/protocols/lorawan.md:generic-api-key:166`. Source line was `app_key: "0123456789ABCDEF0123456789ABCDEF"` — a pedagogical 16-byte AES-128 hex placeholder, not a committed secret.
**Class:** Tier-1 make-impossible (defense-in-depth across both the doc text AND the gitleaks config).
**Root-cause architectural fix (this PR):**
1. Replace the literal hex with `<16-byte-hex-AppKey>` in `lorawan.md:166`. Gitleaks' existing global allowlist regex `<[a-z0-9_-]+>` covers placeholder syntax; the new value cannot be misread as a real key.
2. Add `^sens-api-gateway/docs/` to `.gitleaks.toml` global allowlist `paths` with rationale comment — the customer-facing protocol-spec tree under that path holds many similar examples (MQTT cred placeholders, OPC UA UserIdentityToken samples, HMAC seeds in audit-log examples). Pedagogical examples MUST use placeholder syntax, allowlist enforces no false alerts on the legitimate examples.
**Owner:** edge-docs team + security-reviewer
**Deadline:** Closes in this same PR (this anchor closes when the commit lands).

#### ORPHAN-EDGE-CI-003 — `eslint-rules/dist/` out-of-sync gate fires inside `Quality Gates` job (LOW)
**Evidence:** CI log of job `72999171508` shows the `(cd tools/eslint-rules && npm run build)` + `git diff --exit-code tools/eslint-rules/dist/` step running at `2026-04-25T08:59:06.4820099Z`. The job exited at `2026-04-25T08:59:08.0144005Z` — log truncated; the dist-sync step would `exit 1` if `dist/` differs from a fresh build. This is a generic build-artifact-in-git anti-pattern: shipping `dist/` AND requiring source+dist match means every dependency bump produces a noisy diff.
**Class:** Tier-2 automatic — make `dist/` not part of the repo.
**Root-cause architectural fix:**
1. Add `tools/eslint-rules/dist/` to `.gitignore`.
2. Have the consuming side (root-level `eslint.config.js`) build `dist/` on demand via a postinstall script, so consumers never read a stale committed artifact.
3. Drop the gate.
**Owner:** infra-expert
**Deadline:** 2026-05-30
**Closure path:** PR `chore(eslint-rules): drop dist/ from git; build on postinstall`, Closes this anchor.

#### ORPHAN-EDGE-LICENSE-001 — `sens-api-gateway/LICENSE` MIT vs `Cargo.toml:8` `Proprietary` inconsistency (CRITICAL — blocks commercial distribution)
**Evidence:** `sens-api-gateway/LICENSE` (file) — MIT licence body, Copyright (c) 2026 Suderra. `sens-api-gateway/Cargo.toml:8` declares `license = "Proprietary"` (or LicenseRef-Proprietary). `sens-api-gateway/deny.toml:65-68` echoes Proprietary. Surfaced by `commercial-legal-writer` during `oss-attribution.md` + `license-model.md` drafting on 2026-04-24.
**Class:** Tier-1 make-impossible — pick ONE licensing posture and reflect it in all three artefacts.
**Root-cause architectural fix:**
1. Decide the actual licensing posture (commercial / dual / MIT) — this is a business decision, not a code one. Owner: founder + counsel.
2. Once decided: rewrite `LICENSE` to the chosen text, set `Cargo.toml:8` to the matching SPDX identifier, update `deny.toml`, regenerate `oss-attribution.md` accordingly.
3. CI invariant: `tests/invariants/license-coherence.spec.ts` asserts `LICENSE` heading line matches `Cargo.toml license` field (or rejects with explicit ADR override).
**Owner:** founder + counsel + commercial-legal-writer
**Deadline:** 2026-05-31 (blocks any commercial release).
**Closure path:** PR carrying the chosen text + invariant, Closes this anchor.

#### ORPHAN-EDGE-LICENSE-002 — `sens-api-gateway/vendor/sx1302_hal/LICENSE` NOT FOUND; LoRaWAN-built binary blocked (HIGH)
**Evidence:** `vendor/sx1302_hal/` contains only a `README.md` (operator instruction to clone `https://github.com/Lora-net/sx1302_hal.git` at build time) and `libloragw/` header stubs. No `LICENSE` file mirrors the Semtech upstream notice. Surfaced 2026-04-24 by `commercial-legal-writer` during the OSS-attribution generation; flagged `(LEGAL REVIEW URGENT)` in `oss-attribution.md` + `third-party-notices.md`.
**Class:** Tier-1 make-impossible — vendored code MUST carry its upstream LICENSE in-tree.
**Root-cause architectural fix:**
1. Mirror the upstream LICENSE file from Lora-net/sx1302_hal at the exact commit pinned in `build.rs` (record the upstream commit SHA).
2. Add a CI invariant `tests/invariants/vendored-license-coverage.spec.ts` that walks every directory under `vendor/` and asserts each carries a `LICENSE` (or `LICENSE.md`) file plus a `VENDOR.md` recording upstream URL + commit SHA + copy date.
3. Until (1) lands, default to building binaries with `--no-default-features` (LoRaWAN feature off); add a release-gate check that rejects a `lorawan`-enabled production binary if the vendored LICENSE does not exist.
**Owner:** edge-expert + commercial-legal-writer
**Deadline:** 2026-05-15 (blocks LoRaWAN-feature commercial binary).
**Closure path:** PR `vendor(sx1302_hal): mirror upstream LICENSE + VENDOR.md; CI invariant`, Closes this anchor.

#### ORPHAN-EDGE-CONTRACT-001 — Edge ↔ cloud event-contract drift (6 warnings, 1 MEDIUM) (HIGH)
**Evidence:** Surfaced by `api-reference-writer` while drafting `event-schemas.md` against `libs/event-contracts/src/sensor-events.ts`:
1. `TelemetryMessage` (host-health metrics + raw modbus/gpio) vs cloud `SensorMetricIngestedEvent` (per-channel `sensorId`/`channelId`/`rawValue`/`value`/`qualityCode`/`producerTs`) — adapter-required (INFO).
2. snake_case `cpu_usage_percent`/`disk_usage_percent`/`uptime_seconds` vs cloud camelCase `cpuUsage`/`storageUsage`/`uptimeSeconds` (INFO).
3. **MEDIUM:** `CommandResponse { commandId, deviceId, success, result, timestamp, error? }` vs `EdgeDeviceResponseEvent { deviceCode, commandId?, command?, success?, data?, error? }` — `deviceId` UUID vs `deviceCode` slug, `result` vs `data`, missing `command` verb on edge side, divergent `success` optionality. Adapter must fail-closed on `deviceId↔deviceCode` lookup miss.
4. Typed `AlarmEvent` enum (7 variants) collapses to opaque `EdgeDeviceAlarmEvent.alarmsJson` string on cloud side (INFO; by design per ARCH-C01).
5. Edge emits separate `StatusMessage` + `TelemetryMessage` on two topics; cloud composes into one `EdgeDeviceHeartbeatEvent` (INFO).
6. LoRa case-only field name drift between edge and cloud (INFO).
**Class:** Tier-1 make-impossible — codegen the edge struct from the cloud event-contract OR vice versa, so both sides cannot drift.
**Root-cause architectural fix:**
1. For the MEDIUM drift: fix the `deviceId` ↔ `deviceCode` mismatch — either rename one side, or formalise an adapter inside `apps/sensor-ingestion/` whose schema is generated from the canonical `libs/event-contracts/` source-of-truth.
2. CI invariant: extend `contract-parity-enforcer` agent to fail when an edge struct emits a JSON shape that does not validate against the cloud `BaseEvent` JSON Schema.
3. Document case-convention SSoT in `docs/adr/` (camelCase on the wire; snake_case is internal-only and gets serde-renamed).
**Owner:** data-expert + edge-expert + api-reference-writer
**Deadline:** 2026-06-15
**Closure path:** PR `feat(event-contracts): edge ↔ cloud parity codegen + CI invariant`, Closes this anchor.

#### ORPHAN-EDGE-TEST-001 — 20 production files have zero unit tests on the Rust edge tree (HIGH)
**Evidence:** Surfaced by `test-evidence-writer` via `grep -c "#\[test\]"` across `sens-api-gateway/src/**/*.rs` on HEAD `3413db47`. Files at zero coverage: `mqtt.rs`, `mqtt_failover.rs`, `alarm_engine.rs`, `atlas_ezo.rs`, `process_image.rs`, `scada_db.rs`, `scada_server.rs`, `scada_types.rs`, `shutdown.rs`, `trend_engine.rs`, `calibration_engine.rs`, `io_poll.rs`, plus 8 module stubs. Total prod LOC of the zero-test set ≈ 12,000 lines. Crate-wide test/prod ratio is ≈ 1.15 % (814 #[test] / 88 files / 72,351 prod LOC).
**Class:** Tier-3 detect — the missing-tests can be measured. Make every CRITICAL path (mqtt, alarm_engine, process_image) reach a target floor before a release tag.
**Root-cause architectural fix:**
1. Add per-file minimum-coverage gate (`cargo tarpaulin --fail-under 50` on changed files only initially; raise quarterly).
2. Block any PR that adds a public symbol to the listed modules without an accompanying `#[test]` — tracked via clippy custom lint `missing_test_for_pub`.
3. Q3 plan: 40 % crate-wide line coverage; Q4: 60 %.
**Owner:** edge-expert + test-runner
**Deadline:** Q3 / Q4 2026 (matches `docs/testing/coverage-report.md` plan).
**Closure path:** Multiple PRs as test files land, each carrying `Closes: …#ORPHAN-EDGE-TEST-001` until coverage hits the gate.

#### ORPHAN-EDGE-TEST-002 — `criterion` declared in `Cargo.toml:418` but no `benches/` directory exists; `proptest` declared at `:419` with zero `proptest!` macros in-source (MEDIUM)
**Evidence:** `Cargo.toml` lines 408 (`tempfile`), 418 (`criterion = { version = "0.5", features = ["html_reports"] }`), 419 (`proptest = "1.5"`) all declared. `find sens-api-gateway/benches -type f 2>/dev/null` → empty. `grep -r "proptest!" sens-api-gateway/src` → empty. ADRs reference 4 planned criterion harnesses (audit_hmac_append, mqtt_publish_throughput, sqlcipher_enqueue, modbus_parallel_read) but none are wired.
**Class:** Tier-2 automatic — declared dev-dependencies that never run are dead surface area.
**Root-cause architectural fix:**
1. Add the four ADR-mentioned criterion harnesses (`benches/audit_hmac_append.rs`, etc.) with measurement runs producing `criterion-baseline.json` artefacts.
2. Add at least one `proptest!` per parser (Modbus frame, S7 PDU, EtherNet/IP CIP, Atlas EZO ASCII response, LoRaWAN MAC).
3. CI invariant: declared dev-dependency must be referenced from `benches/`, `tests/`, or `src/**` — fail otherwise.
**Owner:** edge-expert + test-runner
**Deadline:** Q3 2026
**Closure path:** PR `test(edge): wire criterion + proptest harnesses for declared dev-deps`, Closes this anchor.

#### ORPHAN-EDGE-TEST-003 — Modbus write path has no readback-ACK; success returned on transport ACK only (HIGH; LIFE-SAFETY)
**Evidence:** `sens-api-gateway/src/modbus.rs:178-207` (write_register) and `:1005-1059` (actor write path) — both functions return `Ok(())` once `rodbus` reports the protocol-level ACK. No code re-reads the register after the write to confirm the requested value landed. `grep -r "readback" sens-api-gateway/src/**/*.rs` → 0 hits. Standard practice in Siemens / Rockwell / Opto 22 industrial gateways: write + readback + diff → close-loop ACK; mismatch raises a `CommandVerificationFailed` alarm. Surfaced 2026-04-24 by `test-evidence-writer` during `integration-tests.md` drafting and confirmed independently by the prior 6-agent edge audit.
**Class:** Tier-1 make-impossible — write API physically cannot complete without readback verify.
**Root-cause architectural fix:**
1. Add `ModbusHandle::write_register_verified(addr, expected) -> Result<VerifyOutcome>` whose internal implementation does write + readback + comparison; mismatched return = `VerifyOutcome::Failed { read_value, expected }`.
2. Deprecate the existing `write_register`/`write_coil` for life-safety paths via a `clippy::disallowed_method` lint.
3. `SafeStateManager::apply` reports per-output `VerifyOutcome` so a stuck relay is observable, not just timed-out.
4. Integration test: a fault-injection mock-Modbus server returns ACK but stores a different value; the verified write MUST fail.
**Owner:** edge-expert
**Deadline:** Q3 2026 (matches the prior edge-industrial audit's CRITICAL-002 closure target).
**Closure path:** PR `feat(modbus): readback-ACK for life-safety writes`, Closes this anchor + closes the prior edge-industrial CRITICAL-002 entry.

#### ORPHAN-EDGE-ADR-001 — ADR numbering drift inside `docs/adr/` (3 ID-collision pairs) + 5 misfiled ADRs in `docs/architecture/` (LOW)
**Evidence:** `docs/adr/022a-*.md` + `docs/adr/022b-*.md`; same with 023a/b and 024a/b — three pairs of ADRs sharing a base ID. `docs/architecture/ADR-010-AI-SELF-LEARNING.md`, `ADR-011-operations-hub-restructuring.md`, `ADR-012-messaging-service.md`, `ADR-013-nestjs-v11-upgrade.md` use ADR numbering but live outside the canonical `docs/adr/` directory and collide with canonical IDs. CLAUDE.md documents this as "Known drift" but does not provide a closure plan. Surfaced again by `architecture-writer` during ADR index build.
**Class:** Tier-3 detect — already visible; needs renumbering or directory-move.
**Root-cause architectural fix:**
1. Promote the 5 misfiled `docs/architecture/ADR-*` files into `docs/adr/` with non-colliding IDs (next sequential).
2. Renumber 022a/022b → 022 + 028 (and similar for 023, 024). Add a `docs/adr/_renumbering-2026-04.md` record.
3. CI invariant `tests/invariants/adr-id-uniqueness.spec.ts` asserts every `ADR-NNN` filename is unique across the repo and lives under `docs/adr/`.
**Owner:** comprehensive-review:architect-review
**Deadline:** 2026-06-30
**Closure path:** PR `docs(adr): renumber collision pairs + promote misfiled ADRs`, Closes this anchor.

#### ORPHAN-EDGE-AGENT-001 — Lane-C agent files were lost mid-session due to branch reset; orphan recovery cost ≈ 2 h re-dispatch (LOW; process)
**Evidence:** Session reflog shows two `git reset --hard origin/main` operations during a parallel-shell concurrent-work conflict; the 14 `.claude/agents/edge-docs/*.md` files + the 121 `sens-api-gateway/docs/**` files were UNTRACKED at the time and were lost. Recovery required re-writing the agent files (cheap — content was in the conversation history) and re-dispatching all 12 producers (expensive — ≈ 2 h wall-clock + tokens).
**Class:** Tier-2 automatic — work-in-progress under `.claude/` and `sens-api-gateway/docs/` should land in a feature branch + commit IMMEDIATELY, not stay as untracked.
**Root-cause architectural fix:**
1. When the `edge-docs-orchestrator` produces a new chapter set, the dispatcher's Phase 4 (Cross-Reference Consolidation) MUST commit the output before returning. A producer's output is unsafe-as-untracked.
2. Document the rule in `.claude/agents/edge-docs/edge-docs-orchestrator.md` § Failure modes.
3. Recovery procedure documented in `docs/runbooks/agent-output-recovery.md` (does not yet exist).
**Owner:** edge-docs-orchestrator maintainers
**Deadline:** 2026-05-30
**Closure path:** PR `docs(edge-docs-orchestrator): mandate immediate-commit invariant + recovery runbook`, Closes this anchor.

#### ORPHAN-EDGE-AGENT-002 — Siemens-integration agent surfaced 6 new orphan candidate IDs (007..014 range) that collide with existing ORPHAN-EDGE-001..014 numbering (LOW)
**Evidence:** `siemens-integration-writer` report (2026-04-24) referenced ORPHAN-EDGE-005/007/009/011/012/013/014 as the tracking anchors for its ROADMAP rows. The 005 reference is the pre-existing OPC UA finding. The remaining 5 (007/009/011/012/013/014) are net-new and collide with the existing edge-audit ORPHAN-EDGE numbering. Same pattern in `security-architecture-writer` (proposed ORPHAN-EDGE-006/007 for SCADA-display CSP + MQTT clean_session=false).
**Class:** Tier-2 automatic — the orphan-finding-registry is the single source of truth and must auto-allocate IDs.
**Root-cause architectural fix:**
1. Producer agents MUST NOT mint new ORPHAN-EDGE-NNN IDs in their output. They emit candidate findings as free-text "candidate" entries; consolidation routes them through `tools/scripts/seed-finding-registry.ts` which auto-assigns the next free ID.
2. Document the rule in every Lane-C producer agent's frontmatter description.
3. CI invariant: a Lane-C-output chapter cannot contain `ORPHAN-EDGE-NNN` references unless the matching anchor exists in `docs/reviews/orphan-findings.md`.
**Owner:** edge-docs-orchestrator maintainers + context-manager
**Deadline:** 2026-05-30
**Closure path:** PR `chore(edge-docs): producers cannot mint orphan IDs; CI invariant`, Closes this anchor.

#### ORPHAN-EDGE-AGENT-003 — Claude Code session-bound agent discovery — newly written `.claude/agents/edge-docs/*.md` agents are not dispatchable until next session (LOW; process)
**Evidence:** Direct dispatch via `Agent(subagent_type="product-overview-writer")` after writing the file failed with "Agent type 'product-overview-writer' not found." Recovery proxied through `general-purpose` agent reading the new agent file at runtime — functionally identical but mediated. Claude Code auto-discovers agents at session start, not at runtime.
**Class:** Tier-4 document — this is a Claude Code platform behaviour, not our architectural decision; we record it so future Lane-C runs understand the constraint.
**Root-cause architectural fix:**
1. Document the constraint in `.claude/agents/edge-docs/README.md` § Invocation Contract: "newly added Lane-C producers become natively dispatchable only after a Claude Code session restart; intra-session dispatch goes through `general-purpose` reading the agent definition file at runtime".
2. No code change needed.
**Owner:** edge-docs maintainers (documentation only).
**Deadline:** Closes in this same PR.

#### ORPHAN-EDGE-DOCS-001 — `docs/deployment/README.md` carried a duplicate banned-phrase substitution table that would trip the gate (LOW; closed in this PR)
**Evidence:** First-pass `deployment-runbook-writer` output included a "Banned-Phrase Compliance" section enumerating substitutions verbatim — those literal banned phrases would fail the gate. Caught by post-producer banned-phrase sweep. Replaced with a pointer back to the canonical Lane-C `README.md § Banned-phrase discipline`.
**Class:** Tier-2 automatic — the canonical substitution table lives in exactly one place; everything else points to it.
**Root-cause architectural fix:** SSoT enforced by sweep + producer-prompt clarification. CI invariant `tests/invariants/banned-phrase-table-ssot.spec.ts` could grep for the literal banned-phrase enumeration and fail anywhere outside `.claude/agents/edge-docs/README.md` + `tools/gates/banned-phrase.ts`.
**Owner:** edge-docs maintainers
**Deadline:** Already closed in PR #132.
**Closure path:** Closed by `docs(sens-api-gateway): Siemens-ready documentation package` (commit `ed8184ea`, merged in PR #132).

### Cross-cutting consolidation notes

- **Cumulative orphan-EDGE numbering:** the existing registry uses ORPHAN-EDGE-001..014. New IDs in this batch use the prefixed namespaces ORPHAN-EDGE-CI-NNN, ORPHAN-EDGE-LICENSE-NNN, ORPHAN-EDGE-CONTRACT-NNN, ORPHAN-EDGE-TEST-NNN, ORPHAN-EDGE-ADR-NNN, ORPHAN-EDGE-AGENT-NNN, ORPHAN-EDGE-DOCS-NNN to avoid collision with the pre-existing 014 ceiling. The seed-finding-registry CLI should be extended to recognise these namespaces (or to migrate them into a flat ORPHAN-EDGE-NNN sequence at next consolidation).
- **None of the 12 producer agents wrote any code** — they only documented existing reality, surfaced these findings as a side effect of evidence-link discipline. CLAUDE.md's "no patches, architectural-only" rule is upheld: each closure path above is a Tier-1 / Tier-2 fix, not a workaround.
- **Banned-phrase posture in this entry:** the substitution-table words above (interim, deferred, out-of-scope, temporary, pragmatic) appear ONLY inside fenced blocks describing the rule itself. Per `tools/gates/banned-phrase.ts` EXEMPT_PATHS line 179, `^docs/reviews/` is allowlisted; this file is `docs/reviews/orphan-findings.md` and is therefore exempt. Producers writing under `sens-api-gateway/docs/` continue to follow the substitution table strictly.

---


## ORPHAN-EDGE-AUDIT-2026-04-25-DEEP — 14 additional architectural gaps surfaced during PR-#132 + PR-#151 audits (2026-04-25)

**Status:** OPEN — every sub-finding gets a closure PR.
**Discovered during:** Same Lane-C run + post-merge audits as `ORPHAN-EDGE-AUDIT-2026-04-25` above. The first batch registered the directly-task-related items; this batch captures everything else the operator-facing instruction "don't ignore any problem you see, even if not related to this task" surfaces — pre-existing infra / supply-chain / hygiene gaps that became visible through the docs work but predate it.
**Why this entry exists separately:** Keeping task-related findings (above) and incidentally-surfaced findings (below) in distinct anchors makes the registry queryable: "what did this PR actually close?" vs "what did this PR see?" .

### A. Supply-chain + dependency hygiene

#### ORPHAN-EDGE-DEP-001 — 157 unaddressed Dependabot vulnerabilities on default branch (CRITICAL; pre-existing, not introduced by us)
**Evidence:** GitHub remote returned the banner on every push during this session: `GitHub found 157 vulnerabilities on Okan-wqm/aquaculture_platform's default branch (9 critical, 60 high, 72 moderate, 16 low)`. Trend during the session: 155 → 157 between the two pushes (new advisories landed without remediation).
**Class:** Tier-2 automatic — weekly Dependabot triage cadence + auto-PR for non-breaking patch upgrades.
**Root-cause architectural fix:**
1. Establish a cadence: weekly review of Dependabot dashboard (current banner is observability noise without action).
2. Auto-merge policy for patch-level (semver `~`) and devDependency upgrades when CI is green.
3. Manual review queue for major/minor bumps; SLA Critical 7 d / High 30 d / Medium 90 d / Low 180 d (mirrors CVD policy).
4. Track the count itself: a CI invariant or scheduled job that posts the count to the team channel weekly so trend (157 → 0 over weeks) is visible.
**Owner:** supply-chain-auditor + infra-expert
**Deadline:** 2026-05-31 (initial sweep down to <50 high+critical) / 2026-09-30 (zero high+critical).
**Closure path:** Multiple PRs as Dependabot batches land; first PR carries `Closes: docs/reviews/orphan-findings.md#ORPHAN-EDGE-DEP-001` and explains the cadence rule.

#### ORPHAN-EDGE-DEP-002 — GitHub Actions Node.js 20 deprecation looms 2026-06-02 (HIGH)
**Evidence:** Every workflow run produced the warning: `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683, actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af, gitleaks/gitleaks-action@83373cf2f8c4db6e24b41c1a9b086bb9619e9cd3 are running on Node.js 20 ... Actions will be forced to run with Node.js 24 by default starting June 2nd, 2026`.
**Class:** Tier-2 automatic — pin to Node-24-compatible SHAs before forced cutover.
**Root-cause architectural fix:**
1. Identify and SHA-pin the latest releases of each affected action that supports Node 24.
2. Test in a workflow_dispatch run on a staging branch before sweeping production workflows.
3. Replace SHAs in every `.github/workflows/*.yml` and every `.github/actions/*/action.yml`.
**Owner:** infra-expert
**Deadline:** 2026-05-26 (one-week buffer before forced cutover).
**Closure path:** PR `chore(actions): SHA-pin to Node-24-compatible action releases`, Closes this anchor.

#### ORPHAN-EDGE-DEP-003 — `Cargo.lock` committed but no reproducible-build CI test (LOW; SLSA L3 prerequisite)
**Evidence:** `sens-api-gateway/Cargo.lock` is committed (correct posture). No CI step asserts that `cargo build --release --locked` produces a bit-identical binary across runs from the same toolchain + same lockfile. `SOURCE_DATE_EPOCH` not set in workflow.
**Class:** Tier-3 detect — measurable invariant.
**Root-cause architectural fix:** Add `tests/invariants/cargo-reproducible-build.spec.ts` (or a workflow job) that runs two consecutive builds and `sha256sum`-compares the output binaries. Exit 1 on mismatch.
**Owner:** infra-expert + edge-expert
**Deadline:** 2026-08-31 (alongside SBOM + signed-release rollout per ORPHAN-021).
**Closure path:** PR `ci(rust): reproducible-build invariant`, Closes this anchor.

### B. CI gate gaps (beyond CI-001/002/003 already registered)

#### ORPHAN-EDGE-CI-004 — `MODULE_TYPELESS_PACKAGE_JSON` warning on every gate invocation (LOW)
**Evidence:** Every `husky` and CI gate run emits the same warning four times: `(node:N) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///var/aqua-saas/tools/gates/banned-phrase.ts is not specified ... Reparsing as ES module because module syntax was detected. This incurs a performance overhead.` Same line for `migration-sql-lint.ts`, `tier-claim-lint.ts`, `commit-msg-validator.ts`. Four reparses per commit + four per CI run.
**Class:** Tier-2 automatic — declare the module type once.
**Root-cause architectural fix:** Add `"type": "module"` to root `package.json` (current omission is the cause); OR carve out `tools/gates/` into its own `package.json` with the field set. Both eliminate every reparse.
**Owner:** infra-expert
**Deadline:** 2026-05-15
**Closure path:** PR `chore(tools/gates): declare ESM type to eliminate reparse overhead`, Closes this anchor.

#### ORPHAN-EDGE-CI-005 — `main` branch protection allows merge despite required-check FAILUREs (HIGH; governance)
**Evidence:** PR #132 had `banned-phrase-gate` FAILURE + `Scan repository for committed secrets` FAILURE; `gh pr merge --auto --merge` queued and the merge fired immediately at `2026-04-25T08:59:09Z` while the failed checks were still being scored. Either: (a) those checks are not in `main`'s required-status-checks list, or (b) admin override bypassed them, or (c) auto-merge raced the check completion. None of these is acceptable for a production-bound branch.
**Class:** Tier-1 make-impossible — branch protection MUST list every gate as required.
**Root-cause architectural fix:**
1. Audit `main` branch protection settings; enumerate required status checks.
2. Add every Quality-Gates job (banned-phrase, migration-sql-lint, tier-claim-lint, finding-registry-verify, commit-msg, eslint-rules-dist) + Gitleaks + dependency-review as REQUIRED.
3. Disable admin-bypass for required checks (or scope it to a tightly-controlled set).
4. Document the policy in a new `docs/runbooks/branch-protection.md`.
**Owner:** infra-expert + repo admin
**Deadline:** 2026-05-10 (before any further merges to main).
**Closure path:** Out-of-band repo settings change + PR `docs(runbooks): main branch protection policy`, Closes this anchor.

### C. Documentation completeness (referenced files that don't exist yet)

#### ORPHAN-EDGE-DOCS-002 — `tests/invariants/edge-docs-evidence-links.spec.ts` referenced in Lane-C README, not created (LOW)
**Evidence:** `.claude/agents/edge-docs/README.md` § Quality Gates lists this as a CI gate candidate. No corresponding file exists under `tests/invariants/`. Without it, the evidence-link discipline ("every cited `src/*.rs:N` resolves") is enforced manually by reviewers only.
**Class:** Tier-3 detect — automate the resolver.
**Root-cause architectural fix:** Implement the invariant: glob `sens-api-gateway/docs/**/*.md`, regex-extract `src/[A-Za-z0-9_./]+\.rs:\d+`, assert each resolves to an existing file with a line at least that count. Run in CI on every Lane-C touch.
**Owner:** edge-docs maintainers + test-runner
**Deadline:** 2026-06-30
**Closure path:** PR `test(invariants): edge-docs-evidence-links resolver`, Closes this anchor.

#### ORPHAN-EDGE-DOCS-003 — `docs/runbooks/agent-output-recovery.md` referenced in ORPHAN-EDGE-AGENT-001 closure path, not created (LOW)
**Evidence:** Closure path text mentions this runbook; no file exists. The recovery procedure (when a parallel-shell branch reset destroys uncommitted producer outputs) is undocumented.
**Class:** Tier-4 document — runbook only.
**Root-cause architectural fix:** Author the runbook covering: detect-and-diagnose (reflog walk), reconstruction (when content survives in agent transcripts vs when re-dispatch is needed), prevention (immediate-commit invariant per ORPHAN-EDGE-AGENT-001).
**Owner:** edge-docs-orchestrator maintainers
**Deadline:** 2026-05-30 (paired with ORPHAN-EDGE-AGENT-001).
**Closure path:** PR `docs(runbooks): agent-output-recovery procedure`, Closes this anchor.

#### ORPHAN-EDGE-DOCS-004 — `docs/runbooks/cert-rotation.md` referenced by `security/pki-hierarchy.md`, not created (LOW)
**Evidence:** Lane-C `pki-hierarchy.md` cross-references this operator runbook for X.509 cert rotation procedure. File does not exist.
**Class:** Tier-4 document.
**Root-cause architectural fix:** Author the runbook (Day-30 rotation gate, command path, audit-log entry, rollback on verification failure, dual-control approval).
**Owner:** security-architecture-writer + deployment-runbook-writer
**Deadline:** 2026-06-15
**Closure path:** PR `docs(runbooks): cert-rotation procedure for edge devices`, Closes this anchor.

#### ORPHAN-EDGE-DOCS-005 — Phase 5 doc-drift gate spec'd but not implemented (MEDIUM)
**Evidence:** `.claude/agents/edge-docs/edge-docs-orchestrator.md` § Phase 5 declares: "Every `pub fn` in `src/**/*.rs` exposed outside the crate boundary must appear in `api/rust-api.md`. Every protocol file under `sensorprotocols/*.md` must have a matching chapter under `docs/protocols/`. Every ADR under `docs/adr/*.md` must be indexed in `architecture/adr-index.md`. Missing items = HIGH finding." No invariant test exists.
**Class:** Tier-3 detect.
**Root-cause architectural fix:** Implement three invariant tests under `tests/invariants/edge-docs-{rust-api,protocols,adr-index}-coverage.spec.ts`. Each globs the source surface, globs the doc surface, and asserts coverage. Wire into CI Quality Gates job.
**Owner:** edge-docs-orchestrator maintainers + test-runner
**Deadline:** 2026-07-31
**Closure path:** PR `test(invariants): edge-docs Phase-5 doc-drift gate (3 specs)`, Closes this anchor.

### D. Cross-lane invariant gaps

#### ORPHAN-EDGE-INVARIANT-001 — Lane-C agent cross-references to Lane-A agents not validated (MEDIUM)
**Evidence:** Every Lane-C agent file's "Canonical References" section lists `@.claude/agents/auth-security-expert.md`, `@.claude/agents/compliance-expert.md`, `@.claude/agents/test-runner.md`, etc. If a Lane-A agent is renamed, those references break silently — agents cannot Read a non-existent file at runtime.
**Class:** Tier-3 detect.
**Root-cause architectural fix:** Extend `tests/invariants/agent-name-uniqueness.spec.ts` (or add a sibling `agent-cross-reference.spec.ts`) to scan every `.md` under `.claude/agents/` for `@.claude/...` lines and assert each path resolves.
**Owner:** edge-docs maintainers + agent-name-uniqueness invariant maintainers
**Deadline:** 2026-06-30
**Closure path:** PR `test(invariants): agent cross-reference resolver`, Closes this anchor.

#### ORPHAN-EDGE-INVARIANT-002 — Banned-phrase substitution table SSoT not enforced (LOW)
**Evidence:** The canonical table lives in `.claude/agents/edge-docs/README.md` § Banned-phrase discipline. `deployment/README.md` already once duplicated it (caught by post-producer sweep, fixed in PR #132). Nothing prevents future docs from re-introducing the same trap.
**Class:** Tier-3 detect.
**Root-cause architectural fix:** Add `tests/invariants/banned-phrase-table-ssot.spec.ts` that greps the literal banned-phrase enumeration (or a stable marker comment) and asserts it appears in exactly the canonical file plus `tools/gates/banned-phrase.ts`. Anywhere else = fail.
**Owner:** edge-docs maintainers
**Deadline:** 2026-06-30
**Closure path:** PR `test(invariants): banned-phrase table SSoT`, Closes this anchor.

### E. Hygiene + housekeeping

#### ORPHAN-EDGE-HYG-001 — `.claude/scheduled_tasks.lock` was untracked + not gitignored (LOW; closed in this PR)
**Evidence:** Every `git status` during this session listed `.claude/scheduled_tasks.lock` as untracked. The file is auto-generated by Claude Code session machinery; it represents transient session state, never committable content. Until now, contributors had to mentally exclude it from `git add`.
**Class:** Tier-1 make-impossible.
**Root-cause architectural fix:** Added `.claude/scheduled_tasks.lock` to `.gitignore` in this PR with rationale comment.
**Owner:** edge-docs maintainers (this PR).
**Closure path:** Closed by `.gitignore` change in this commit.

#### ORPHAN-EDGE-HYG-002 — Cross-shell index sharing causes pre-existing staged files to surface in unrelated commits (LOW)
**Evidence:** At session start, `git diff --cached --name-only` listed `docs/reviews/_registry/findings.jsonl` + `tools/gates/finding-registry.ts` as staged — work from a parallel shell session. Without explicit awareness, my commits would have included these unrelated files. Each commit had to filter via `git commit -- <pathspec>`.
**Class:** Tier-4 document — process guideline, not a code fix.
**Root-cause architectural fix:** Add a `CONTRIBUTING.md` section "Working alongside parallel shells" describing: (a) check `git diff --cached --name-only` before any `git commit`, (b) prefer `git commit -- <pathspec>` over `git commit -a`, (c) consider per-session worktrees (`git worktree add`) for fully-isolated work.
**Owner:** comprehensive-review:architect-review (process docs)
**Deadline:** 2026-06-30
**Closure path:** PR `docs(contributing): parallel-shell hygiene`, Closes this anchor.

### F. SSoT drift inside CLAUDE.md

#### ORPHAN-EDGE-SSOT-001 — CLAUDE.md service count drift: claims "16 services (15 runtime + db-migrate CLI)" but earlier session-context noted 17 (15 runtime + sensor-ingestion sidecar + db-migrate CLI) (LOW)
**Evidence:** `CLAUDE.md` § "Backend Services (`apps/`) — 16 services (15 runtime + `db-migrate` CLI)". Earlier session-context recorded `apps/sensor-ingestion` as a Rust sidecar service per the rust-migration plan. Either CLAUDE.md is one service short, or sensor-ingestion is not yet a runtime service.
**Class:** Tier-3 detect.
**Root-cause architectural fix:**
1. Reconcile by reading actual `apps/` directory and counting runtime services.
2. Update CLAUDE.md table to reflect the live count.
3. CI invariant: `tests/invariants/claude-md-service-count.spec.ts` asserts the count matches `ls -d apps/*-service apps/*-api apps/gateway-* | wc -l` plus any explicitly-named non-suffixed services.
**Owner:** claude-md maintainer + data-expert
**Deadline:** 2026-05-31
**Closure path:** PR `docs(claude-md): reconcile service count + invariant`, Closes this anchor.

### G. Operational + governance

#### ORPHAN-EDGE-OPS-001 — No automated branch cleanup on merge (LOW)
**Evidence:** After PR #132 + #151 merged, the source branches (`agentic-audit`, `agentic-audit-pr`) remained on the remote until I ran `git push origin --delete` manually. Standard GitHub repo setting "Automatically delete head branches" is off.
**Class:** Tier-2 automatic — flip the repo setting.
**Root-cause architectural fix:** Enable "Automatically delete head branches" in repo settings → Pull Requests. No code change.
**Owner:** repo admin
**Deadline:** 2026-05-10
**Closure path:** Out-of-band settings change; record on next `infra-runbook` PR.

#### ORPHAN-EDGE-OPS-002 — `edge-docs-orchestrator` agent never tested in vivo (LOW)
**Evidence:** During this session, I dispatched 12 producers directly via `general-purpose` agent (proxy reading the producer-definition file at runtime) because Claude Code auto-discovers agents only at session start. The native `edge-docs-orchestrator` Phase 1-5 dispatch contract was never executed end-to-end.
**Class:** Tier-3 detect — exercise the contract.
**Root-cause architectural fix:**
1. After `agentic-audit-followup-2` merges, in a fresh Claude Code session, invoke `Agent(subagent_type="edge-docs-orchestrator")` with mode=DELTA-RELEASE on a synthetic source-of-truth bump.
2. Verify Phase 4 cross-reference consolidation runs, Phase 5 doc-drift gate fires, `_consolidation-report.md` is emitted.
3. Capture findings (any) in a follow-up entry.
**Owner:** edge-docs-orchestrator maintainers
**Deadline:** 2026-06-15
**Closure path:** Test session + record findings; close anchor when first end-to-end run succeeds.

### Cross-cutting consolidation notes

- **None of the 14 sub-findings above are application-code defects.** They are tooling, supply-chain, governance, hygiene, and documentation gaps. CLAUDE.md "no patches, architectural-only" continues to hold: each closure path is a Tier-1, Tier-2, or Tier-3 fix.
- **CRITICAL items in this batch:** ORPHAN-EDGE-DEP-001 (157 vulnerabilities — pre-existing) and ORPHAN-EDGE-CI-005 (branch protection allows merge despite gate failures). Both are pre-existing repo-state, not introduced by Lane-C work.
- **HIGH items:** ORPHAN-EDGE-DEP-002 (Node 20 deprecation deadline 2026-06-02 — 38 days at the time of writing).
- **Why this DEEP entry exists alongside the first AUDIT-2026-04-25 entry:** Per operator instruction, every observed problem is recorded — even when un-related to the originating Lane-C task. The first batch covered task-direct findings; this batch covers everything else the work surfaced.
- **Banned-phrase posture in this entry:** same as above. `^docs/reviews/` is allowlisted by `tools/gates/banned-phrase.ts:179`.

---


## ORPHAN-EDGE-AUDIT-2026-04-25-EXTRA-DEEP — 11 additional repo-state, worktree, and governance gaps (2026-04-25)

**Status:** OPEN.
**Discovered during:** Continued operator-instruction "every observed problem is recorded" sweep AFTER PR #151 + #153 merged. The earlier two batches captured task-direct + tooling/dep findings; this batch walks the repo's working state — branches, worktrees, repo-level governance files, workflow surface — items pre-existing for months but never registered.
**Why a third entry under the same date:** Each batch is one bounded scope. Splitting prevents the registry from becoming a single 5000-line scroll while preserving "what did this audit see, when".

### Sub-findings registered

#### ORPHAN-EDGE-WORKTREE-001 — 20+ active worktrees with overlapping commits (MEDIUM; cleanup + governance)
**Evidence:** `git worktree list` reports 21 worktrees: the canonical `/var/aqua-saas` plus 11 `/tmp/aqua-*` parallel shells, 7 `/var/aqua-saas/.claude/worktrees/agent-*`, 2 `/var/aqua-saas/.worktrees/*`, and `/tmp/aqua-main-illustrator` on `main` itself. Three worktrees (`worktree-agent-a10d7c5c`, `worktree-agent-a8e88f6d`, `worktree-agent-adfdf32a`) all point at the same commit `3dacd93a` — duplicate snapshots consuming disk + index.
**Class:** Tier-2 automatic — periodic pruning + a per-worktree liveness check.
**Root-cause architectural fix:**
1. Add `tools/scripts/worktree-prune.ts` (or shell) that walks `git worktree list`, identifies worktrees whose branch is fully-merged into main OR whose last commit is older than N days, and emits a removal plan (no auto-delete; operator runs).
2. Document in `CONTRIBUTING.md` (also missing — see ORPHAN-EDGE-REPO-001) that long-lived worktrees should live under `/var/aqua-saas/.worktrees/` (already gitignored) so cleanup tooling has a known root.
3. CI sanity check: count worktrees > 5 → emit a weekly notification; > 15 → fail a scheduled `worktree-sprawl-gate.yml` job.
**Owner:** infra-expert + repo admin
**Deadline:** 2026-06-30
**Closure path:** PR `chore(scripts): worktree-prune helper + CI sprawl gate`, Closes this anchor.

#### ORPHAN-EDGE-WORKTREE-002 — `/var/aqua-saas/.claude/worktrees/agent-a382b7a5-faz2-stage8` is **locked** + abandoned status unknown (LOW)
**Evidence:** `git worktree list` shows that path with the `locked` flag. Locked worktrees are not garbage-collected by `git worktree prune`. No accompanying status (active developer / abandoned / archived).
**Class:** Tier-3 detect.
**Root-cause architectural fix:**
1. Add `LOCK_REASON.md` requirement: every locked worktree MUST have a sibling `LOCK_REASON.md` recording owner, date locked, expected resolution date.
2. CI: a scheduled job that fails if a locked worktree is older than 30 days without a fresh `LOCK_REASON.md` update.
**Owner:** the worktree's original creator (audit-needed) + edge-expert
**Deadline:** 2026-05-30 (audit + resolve specifically this worktree).
**Closure path:** Operator manually inspects + either unlocks/removes the worktree or refreshes its lock reason; PR `chore(worktrees): LOCK_REASON invariant`, Closes this anchor.

#### ORPHAN-EDGE-BRANCH-001 — 11 stale `agentic-*` remote branches accumulating (LOW)
**Evidence:** `git branch -r | grep -E "origin/agentic" | wc -l` → 11 branches at audit time: `agentic`, `agentic-faz-2-5-pr-a`, `agentic-orphan-012-deterministic-gates`, `agentic-orphan-012b-pin-deps`, `agentic-orphan-013-nats-subject-contract`, `agentic-pre-flat-snapshot`, `agentic-rust-faz0`, `agentic-rust-faz0b-baseline`, `agentic-rust-faz1-protocol-codec`, `agentic-rust-faz2-sensor-ingestion`, `agentic-rust-faz3-control-plane`. Most are months-old experimental branches; merge status mixed.
**Class:** Tier-3 detect — measurable.
**Root-cause architectural fix:**
1. Audit each branch: merged into main → delete; orphaned with no closure plan → archive (rename to `archive/<old-name>-YYYY-MM`) + open a tracking finding.
2. Pair with ORPHAN-EDGE-OPS-001 ("Automatically delete head branches" repo setting) so future merges self-clean.
3. Quarterly branch-sprawl review cadence in `docs/runbooks/branch-cleanup.md` (also missing).
**Owner:** repo admin + comprehensive-review:architect-review
**Deadline:** 2026-06-30
**Closure path:** Manual sweep + PR `docs(runbooks): branch cleanup quarterly cadence`, Closes this anchor.

#### ORPHAN-EDGE-REPO-001 — 5 standard repo-level files missing (MEDIUM; community + onboarding gap)
**Evidence:** Repo root has no `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.editorconfig`, or `SUPPORT.md`. GitHub auto-surfaces `SECURITY.md` for vulnerability reporting; without it, external reporters have no clear PSIRT path (cross-cutting with `sens-api-gateway/docs/security/cvd-policy.md` which itself uses a placeholder PSIRT alias).
**Class:** Tier-1 make-impossible — these are conventional repo files; their absence makes correct contribution behaviour invisible.
**Root-cause architectural fix:**
1. `SECURITY.md` — points to the (eventual real) PSIRT alias from `cvd-policy.md`, lists supported versions, embargo policy, PGP key fingerprint.
2. `CONTRIBUTING.md` — covers commit conventions (the 11 banned phrases reference, finding-ID format, Closes: trailer rule), parallel-shell hygiene (per ORPHAN-EDGE-HYG-002), Lane-A/B/C agent dispatch overview, branch naming, PR template pointer.
3. `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1 boilerplate.
4. `.editorconfig` — root-level (TS 2-space, Rust 4-space, YAML 2-space, MD trim-trailing-whitespace).
5. `SUPPORT.md` — pointer to operations/support-tiers.md template + customer entry path.
**Owner:** comprehensive-review:architect-review + commercial-legal-writer
**Deadline:** 2026-06-15
**Closure path:** PR `docs(repo): add CONTRIBUTING / SECURITY / CODE_OF_CONDUCT / .editorconfig / SUPPORT`, Closes this anchor.

#### ORPHAN-EDGE-WORKFLOW-001 — Only 1 of 23 GitHub Actions workflows audited; full CI surface review pending (HIGH)
**Evidence:** `ls .github/workflows/*.yml | wc -l` → 23 workflow files. Earlier orphan finding ORPHAN-EDGE-006 / ORPHAN-EDGE-CI-005 only audited `rust-ci.yml`. The other 22 (`ci-affected.yml`, `quality-gates.yml`, `security-gitleaks.yml`, `dependency-review.yml`, deploy workflows, release workflows, label workflows, etc.) have not been systematically audited for: required-status-check coverage, SHA-pinned third-party actions, secrets handling, paths filter coverage of new sub-trees, deprecation footprint (Node 20 per ORPHAN-EDGE-DEP-002).
**Class:** Tier-3 detect.
**Root-cause architectural fix:**
1. Per-workflow audit table in `docs/runbooks/ci-workflow-inventory.md` (does not exist) listing for each workflow: trigger events, paths filter, required-or-not on main, third-party actions + SHA pin status, secrets it reads, expected runtime, owner.
2. Establish a CI invariant `tests/invariants/workflow-shape-coverage.spec.ts` that enumerates every `.yml` in `.github/workflows/` and asserts entries in the inventory file (catch new workflows that appear without registration).
3. Each workflow gets a `# OWNER: <agent-or-team>` and `# CRITICALITY: required|advisory` comment header.
**Owner:** infra-expert + supply-chain-auditor
**Deadline:** 2026-06-30 (paired with ORPHAN-EDGE-CI-005 branch-protection audit)
**Closure path:** PR `docs(runbooks): ci-workflow-inventory + invariant`, Closes this anchor.

#### ORPHAN-EDGE-DOCS-006 — `docs/reviews/orphan-findings.md` past 1250 lines; single-file management becoming unwieldy (LOW)
**Evidence:** `wc -l docs/reviews/orphan-findings.md` → 1254 (after PR #151 + #153). No table-of-contents, no archive split, no at-a-glance RESOLVED-vs-OPEN dashboard. Reading time + diff noise grow each PR.
**Class:** Tier-3 detect — solvable by a small refactor.
**Root-cause architectural fix:**
1. Add an auto-generated table-of-contents at the top (script: `tools/scripts/orphan-findings-toc.ts` greps all `^## ORPHAN-` headings and emits a `<!-- TOC -->` block).
2. Split the file by quarter once it crosses 2500 lines: `orphan-findings-2026-Q1.md`, `orphan-findings-2026-Q2.md` archive files; current quarter stays in the canonical name.
3. Status dashboard at top: count of OPEN / RESOLVED / STALE per severity.
4. CI invariant: every entry has a `**Status:** OPEN|RESOLVED|STALE|BLOCKED` field; missing → fail.
**Owner:** context-manager + edge-docs maintainers
**Deadline:** 2026-06-30
**Closure path:** PR `docs(orphan-findings): TOC + status dashboard + per-quarter archive policy`, Closes this anchor.

#### ORPHAN-EDGE-DOCS-007 — `docs/runbooks/` has 19 markdown files but no `README.md` landing or topic index (LOW)
**Evidence:** `ls docs/runbooks/*.md | wc -l` → 19. Filenames are descriptive but discovery requires `ls`. New runbooks (per ORPHAN-EDGE-DOCS-003 agent-output-recovery, ORPHAN-EDGE-DOCS-004 cert-rotation, ORPHAN-EDGE-CI-005 branch-protection, ORPHAN-EDGE-DEP-001 dependabot-triage, ORPHAN-EDGE-WORKTREE-001 worktree-prune, ORPHAN-EDGE-BRANCH-001 branch-cleanup, ORPHAN-EDGE-WORKFLOW-001 ci-workflow-inventory) will keep growing the directory.
**Class:** Tier-2 automatic — auto-generated index from filenames + frontmatter.
**Root-cause architectural fix:**
1. Add `docs/runbooks/README.md` as a topic-grouped index (database, security, deployment, edge, monitoring, governance).
2. Each runbook carries YAML frontmatter (`audience`, `criticality`, `last-reviewed`, `owner`).
3. CI invariant `tests/invariants/runbooks-frontmatter.spec.ts` asserts every runbook has the required frontmatter; index file is regenerated by `tools/scripts/runbook-index.ts`.
**Owner:** comprehensive-review:architect-review + context-manager
**Deadline:** 2026-06-30
**Closure path:** PR `docs(runbooks): topic index + frontmatter invariant`, Closes this anchor.

#### ORPHAN-EDGE-CODEOWNERS-001 — `.github/CODEOWNERS` 67 lines, last review undocumented (LOW)
**Evidence:** File exists at 67 lines; no audit metadata header (last-reviewed date, ownership-rotation cadence). When repo grows new top-level directories (e.g. the `sens-api-gateway/docs/` tree just landed), CODEOWNERS may not cover them — silent permission gap on PR review.
**Class:** Tier-3 detect.
**Root-cause architectural fix:**
1. Audit pass: walk every top-level directory + every `apps/*` + `libs/*` + `web/modules/*`; assert each is covered by at least one rule in CODEOWNERS.
2. CI invariant `tests/invariants/codeowners-coverage.spec.ts` that fails when a tracked directory has no CODEOWNERS rule.
3. Header comment in CODEOWNERS recording last-audit date + reviewer; quarterly cadence.
4. New rule for `sens-api-gateway/docs/**` (since the Lane-C team just landed 121 files there) — owner = `@edge-docs-maintainers`.
**Owner:** comprehensive-review:architect-review + repo admin
**Deadline:** 2026-06-15 (paired with the new `sens-api-gateway/docs/**` ownership rule)
**Closure path:** PR `chore(codeowners): coverage audit + invariant + sens-api-gateway/docs ownership`, Closes this anchor.

#### ORPHAN-EDGE-WORKSPACE-001 — `sens-api-gateway/Cargo.toml` is its own workspace, not part of root Cargo workspace (MEDIUM; sibling of ORPHAN-EDGE-006)
**Evidence:** Root `Cargo.toml` workspace excludes `sens-api-gateway` (or doesn't list it). Existing finding ORPHAN-EDGE-006 covers the GitHub Actions paths-filter exclusion (CI doesn't run `cargo audit` on this tree). This is a sibling: `nx affected` + workspace-wide cargo commands don't traverse sens-api-gateway either. The result: developers running `cargo check --workspace` see green even when sens-api-gateway is broken.
**Class:** Tier-2 automatic — unify or formally split.
**Root-cause architectural fix (two options, ADR-required):**
1. **Option A — Unify:** add `sens-api-gateway` to the root Cargo workspace `members`. `cargo check --workspace` then covers it. Trade-off: edge agent's `panic = "abort"` release profile may conflict with backend Rust services.
2. **Option B — Formal split:** keep separate workspaces but add a top-level `cargo-cmd-all.sh` that iterates known workspace roots and runs the requested command in each. CI uses this single helper.
**Owner:** edge-expert + infra-expert
**Deadline:** 2026-06-30 (ADR + decision); implementation Q3 2026.
**Closure path:** ADR + PR `feat(workspace): unify or formally separate sens-api-gateway`, Closes this anchor.

#### ORPHAN-EDGE-DOCS-008 — No "live unmitigated risk" register for v1.6.0 (HIGH; security/safety visibility)
**Evidence:** `sens-api-gateway/docs/security/threat-model.md` lists 35 STRIDE pairs with mitigations. `crypto-inventory.md` lists FIPS-approved-but-not-certified posture. `compliance/iec62443-4-2-gap.md` lists 5 SL2 + 6 SL3 blockers. `orphan-findings.md` registers 40+ findings. But there is no single page answering: **"if I deploy v1.6.0 to production today, what unmitigated risks do I carry?"** — a customer-facing risk register that an OT cyber-security buyer (Siemens, BSI, internal CISO) will demand on Day 1.
**Class:** Tier-2 automatic — derive the register from existing inputs.
**Root-cause architectural fix:**
1. Add `sens-api-gateway/docs/security/known-risks.md` — auto-generated from: (a) `orphan-findings.md` entries flagged `LIFE-SAFETY` or `SECURITY` and `Status: OPEN`, (b) `compliance/iec62443-4-2-gap.md` PARTIAL+FAIL rows, (c) `threat-model.md` STRIDE entries marked ROADMAP / UNMITIGATED.
2. Header table: per-risk severity, exploitability, current compensating control, target closure date.
3. CI invariant: this file is regenerated whenever `orphan-findings.md` or `iec62443-4-2-gap.md` change; stale register fails the gate.
**Owner:** security-architecture-writer + compliance-evidence-writer + context-manager
**Deadline:** 2026-06-15 (before next external Siemens-style review).
**Closure path:** PR `docs(security): live unmitigated-risk register + invariant`, Closes this anchor.

#### ORPHAN-EDGE-MEMORY-001 — User-memory drift not periodically reconciled with repo state (LOW)
**Evidence:** Memory entries under `/root/.claude/projects/-var-aqua-saas/memory/` (per session preamble) include items like "Architectural Not Patches", "Enterprise Grade Standard", "Audit Validation Mandatory" — these are stable directives. But entries like "Rust Hybrid Migration Plan" (status: in progress on `agentic-rust-faz0` worktree) — that worktree exists but its progress is not auto-tracked against the memory entry. If the migration completes, the memory still says "in progress".
**Class:** Tier-3 detect.
**Root-cause architectural fix:**
1. Add a quarterly memory-audit cadence: walk every entry of type `project`, cross-check against current repo state (branches alive, plan files RESOLVED status, ADRs ACCEPTED).
2. Document in `CONTRIBUTING.md` (per ORPHAN-EDGE-REPO-001) the user's memory file conventions + cadence.
3. No code change in the repo — this is a process / personal-knowledge-management item.
**Owner:** Operator (user) + comprehensive-review:architect-review
**Deadline:** 2026-06-30 (first cadence run).
**Closure path:** Operator-personal action; record completion in next memory update.

### Cross-cutting consolidation notes for this entry

- **None of these items existed BECAUSE OF the Lane-C docs work.** They are pre-existing repo-state surfaced because the Lane-C orchestrator walked the full surface during evidence-link discipline. Operator instruction "every observed problem, even un-related" is satisfied: 11 additional architectural items now have owners + deadlines.
- **Cumulative orphan count after this PR:** ORPHAN-001..021 (pre-existing original numbering) + ORPHAN-EDGE-001..014 (first edge-audit batch) + ORPHAN-EDGE-{CI,LICENSE,CONTRACT,TEST,ADR,AGENT,DOCS}-NNN (PR #151, 11 items) + ORPHAN-EDGE-{DEP,CI-004/005,DOCS-002..005,INVARIANT,HYG-002,SSOT,OPS}-NNN (PR #153, 14 items) + ORPHAN-EDGE-{WORKTREE,BRANCH,REPO,WORKFLOW,DOCS-006/007/008,CODEOWNERS,WORKSPACE,MEMORY}-NNN (this PR, 11 items) ≈ **65 architectural findings** registered in this orphan registry. Each with owner + deadline + Tier-1/2/3 fix path.
- **Banned-phrase posture:** identical — `^docs/reviews/` allowlisted by `tools/gates/banned-phrase.ts:179`.
- **Three CRITICAL items pending closure:** ORPHAN-EDGE-LICENSE-001 (LICENSE inconsistency), ORPHAN-EDGE-DEP-001 (Dependabot 157), ORPHAN-EDGE-CI-005 (branch protection). These three plus ORPHAN-EDGE-DEP-002 (Node 20 cutover 2026-06-02) form the next-2-weeks remediation queue.
- **Operator note:** if the next operator instruction is again "more depth, more notes", the next batch will need to walk: per-service test coverage matrix, every `apps/*-service` README presence, every `libs/*` public API doc, ADR index drift across all services (not just edge), and the 60+ Dependabot HIGH advisories one-by-one. Each of those is its own bounded scope.

---


## ORPHAN-EDGE-AUDIT-2026-04-25-COMPREHENSIVE — 7 cross-service README + contract-validator + service-count gaps (2026-04-25)

**Status:** OPEN.
**Discovered during:** Operator-instruction-driven 5th-pass sweep walking the per-service / per-lib / per-module README surface and the event-contracts validator surface. Each batch is one bounded scope; this batch covers the cross-service documentation + trust-boundary-validation gaps that none of the four prior batches walked.

### Sub-findings registered

#### ORPHAN-EDGE-CONTRACT-002 — Event-contracts JSON Schema validator directory empty; CLAUDE.md mandate not implemented (CRITICAL)
**Evidence:** `find libs/event-contracts/src -name "*.ts" | wc -l` → 38 TypeScript files defining event interfaces. `find libs/event-contracts/src/schemas -name "*.json" | wc -l` → 0. CLAUDE.md § "Event Contract Rules" item 4: *"Add a JSON Schema validator for trust-boundary crossings (`libs/event-contracts/src/schemas/`)"*. The directory either does not exist or is empty. Result: every event crossing a trust boundary (NATS pub-sub between apps, MQTT publish from edge to cloud, webhook ingress) is consumed without runtime schema validation. A producer that drifts a field (e.g. renames `producerTs` → `producerTimestamp`) silently breaks every consumer, caught only at first-failed-test.
**Class:** Tier-1 make-impossible — runtime validator at the trust boundary refuses malformed payloads before consumer logic runs.
**Root-cause architectural fix:**
1. For every event in `libs/event-contracts/src/*-events.ts`, generate a corresponding `*.schema.json` (Draft 2020-12) under `libs/event-contracts/src/schemas/` using `ts-json-schema-generator` or `typescript-json-schema`.
2. Each consumer that subscribes via `@platform/event-bus` runs the matching JSON Schema validator BEFORE deserialising into the typed interface. Validation failure → quarantine the message + emit `EventSchemaViolation` audit event + DO NOT silently `try/catch` swallow it.
3. CI invariant: `tests/invariants/event-contract-schema-coverage.spec.ts` greps every `extends BaseEvent` interface in `libs/event-contracts/src/` and asserts a matching `*.schema.json` file exists.
4. ADR-006 ("flat events") update: explicitly require schema validator + listing how upcasters compose with validators on version drift.
**Owner:** data-expert + platform-kernel-expert
**Deadline:** 2026-06-15 (CRITICAL — this gap is platform-wide, not just edge).
**Closure path:** PR `feat(event-contracts): JSON Schema validator generation + runtime gate + invariant`, Closes this anchor.

#### ORPHAN-EDGE-DOCS-009 — Cross-tree README coverage gap: 53% of services / libs / modules / platform-libs lack a README (HIGH)
**Evidence:** Cross-tree audit on `agentic-audit-followup-4` against `origin/main` HEAD:
- `apps/`: 17 directories total. README MISSING in 5: `ai-service`, `db-migrate`, `hydroponics-service`, `messaging-service`, `sensor-ingestion`. Coverage 12/17 = 70.6%.
- `libs/`: 11 directories total. README MISSING in 7: `aquaculture-engines`, `farm-shared`, `node-components`, `sdk`, `shared-contracts`, `shared`, `storage`. Coverage 4/11 = 36.4%.
- `web/modules/`: 7 directories total. README MISSING in 5: `farm-module`, `hr-module`, `hydroponics-module`, `sensor-module`, `tenant-admin`. Coverage 2/7 = 28.6%.
- `platform/libs/`: 3 directories total. README MISSING in 3: `cqrs`, `event-bus`, `outbox`. Coverage 0/3 = 0%.

Total: 38 first-class subtrees; 20 lack a README. Coverage = 47.4%. Onboarding cost is the primary effect — a new contributor cannot navigate to "what does this lib do" without grepping source.
**Class:** Tier-3 detect — measurable, fix-by-template.
**Root-cause architectural fix:**
1. Add `tests/invariants/readme-coverage.spec.ts` that asserts every `apps/*/`, `libs/*/`, `web/modules/*/`, `platform/libs/*/` carries a `README.md` of at least N words with required sections (Purpose, Public API surface, Owner, Linked ADRs).
2. Template files: `tools/templates/README-app.md`, `README-lib.md`, `README-web-module.md`, `README-platform-lib.md`. Skeleton with required headings.
3. Closure happens via per-subtree PRs as owners author the README; first PR closes the invariant + 2-3 templates; subsequent PRs each close one missing subtree until coverage = 100%.
**Owner:** comprehensive-review:architect-review + per-subtree owner agent (farm-expert for `apps/farm-service`, etc.)
**Deadline:** 2026-08-31 (rolling closure as per-subtree PRs land).
**Closure path:** Multi-PR; first PR `test(invariants): README coverage + templates`, then per-subtree PRs.

#### ORPHAN-EDGE-COVERAGE-001 — Per-service test-coverage matrix never assembled (HIGH)
**Evidence:** Lane-A `test-runner` agent owns coverage authority. Sens-api-gateway coverage was measured (≈1.15% per ORPHAN-EDGE-TEST-001). For the 17 backend services + 11 libs + 7 web modules + 3 platform libs, no equivalent single-page coverage matrix exists. Plant IT / Siemens / SOC 2 reviewers asking "what is your test posture across the whole platform" cannot be answered without 38 separate `cargo tarpaulin` / `nx test --coverage` runs.
**Class:** Tier-3 detect.
**Root-cause architectural fix:**
1. CI scheduled job `coverage-matrix.yml` (weekly) runs `nx run-many --target=test --coverage` for the TS/Nest tree + `cargo tarpaulin` for the Rust workspace; aggregates per-subtree coverage into `docs/operations/coverage-matrix.md`.
2. Dashboard table: subtree | line-cov% | branch-cov% | last-measured | trend (↑/↓/→) | owner.
3. Pair with ORPHAN-EDGE-TEST-001 floor-gate (per-file 50% minimum on changed code).
**Owner:** test-runner + observability-expert
**Deadline:** 2026-07-31
**Closure path:** PR `ci(coverage): platform-wide coverage matrix + dashboard`, Closes this anchor.

#### ORPHAN-EDGE-API-001 — No public-API documentation generation pipeline for libs (MEDIUM)
**Evidence:** Of the 11 `libs/*` directories, the public surface (exported types, functions, classes) has no automated documentation. `libs/event-contracts/src/index.ts` exports 30+ event interfaces; consumers learn the API by reading source. Equivalent for `libs/backend-common`, `libs/aquaculture-engines`, etc. TypeDoc / typedoc-plugin-markdown is the standard tool.
**Class:** Tier-2 automatic — generate, do not author.
**Root-cause architectural fix:**
1. Add `npm run docs:gen` script that runs `typedoc` against every `libs/*` and produces Markdown output under `docs/api/libs/<lib>/`.
2. CI: regenerate on each merge to main + commit if changed (or fail if drifted).
3. Pair with ORPHAN-EDGE-DOCS-009 README coverage so each `libs/*/README.md` cross-references the generated API doc.
**Owner:** comprehensive-review:architect-review + test-runner
**Deadline:** 2026-08-31
**Closure path:** PR `feat(docs): typedoc-driven public API doc generation for libs`, Closes this anchor.

#### ORPHAN-EDGE-SSOT-002 — Confirmed: `apps/` has 17 services; CLAUDE.md says 16. Reconcile (LOW; ORPHAN-EDGE-SSOT-001 confirmation)
**Evidence:** `ls -d apps/*/ | wc -l` → 17 directories at HEAD `119ef3cd`. CLAUDE.md § "Backend Services (`apps/`) — 16 services (15 runtime + `db-migrate` CLI)". The 17th is `apps/sensor-ingestion` (Rust sidecar per the rust-migration plan; recorded in user memory as in progress). CLAUDE.md table needs:
1. Update count: "17 services (15 runtime + `sensor-ingestion` Rust sidecar + `db-migrate` CLI)".
2. Add a row to the service table listing `sensor-ingestion` with schema (likely `sensor` shared with sensor-service) and responsibility ("high-throughput sensor payload decode + NATS publish").
**Class:** Tier-1 make-impossible — invariant.
**Root-cause architectural fix:** Add `tests/invariants/claude-md-service-count.spec.ts` asserting `ls -d apps/*/` count matches the CLAUDE.md table row count. Pair with the table update.
**Owner:** claude-md maintainer
**Deadline:** 2026-05-15 (low effort; close fast).
**Closure path:** PR `docs(claude-md): add sensor-ingestion to service roster + count invariant`, Closes this and supersedes ORPHAN-EDGE-SSOT-001.

#### ORPHAN-EDGE-DOCS-010 — `web/apps/aquamobil/` (PWA) onboarding documentation not audited (MEDIUM)
**Evidence:** Mobile PWA app exists per CLAUDE.md "Web (`web/`)" section. README presence + service-worker config + offline-sync architecture were not part of any prior orphan finding. Pre-existing service-worker security note `web/apps/aquamobil/dev-dist/` is gitignored per security incident SEC-M05 — but that was a single-file fix. The broader PWA architecture (offline IndexedDB, background sync, push notifications, install prompt UX) is undocumented.
**Class:** Tier-3 detect.
**Root-cause architectural fix:**
1. Audit `web/apps/aquamobil/` — confirm README exists with: PWA architecture, service-worker version + scope, offline data store schema, push-notification flow, install-prompt UX, supported browsers + platforms, known limitations.
2. If missing, author per ORPHAN-EDGE-DOCS-009 template.
**Owner:** frontend-expert + mobile-app-auditor (Lane-B)
**Deadline:** 2026-07-31
**Closure path:** PR `docs(aquamobil): PWA architecture + onboarding`, Closes this anchor.

#### ORPHAN-EDGE-INFRA-001 — Helm charts / Kubernetes manifests / Terraform IaC documentation surface not audited (MEDIUM)
**Evidence:** `infrastructure/` directory referenced by CLAUDE.md and prior findings (e.g. ORPHAN-EDGE-DEP-002 mentions infrastructure/monitoring/). The full inventory of Helm charts, Kubernetes manifests, Terraform modules has not been walked for: README coverage, ADR linkage, secret references, CRD definitions, deployment-environment matrix.
**Class:** Tier-3 detect.
**Root-cause architectural fix:**
1. Audit pass: walk `infrastructure/`, `deploy/`, `infra/` (whichever exist). Per top-level subtree: README + ADR linkage + environment matrix (dev/staging/prod) + secret references.
2. Add subtree-specific orphan findings as gaps surface.
3. CI invariant: every Helm chart has `Chart.yaml` + `values.yaml.example`; every Terraform module has `README.md` + `variables.tf` documented.
**Owner:** infra-expert
**Deadline:** 2026-07-31
**Closure path:** PR `docs(infra): inventory + ADR linkage audit`, Closes this anchor.

### Cross-cutting consolidation notes for this batch

- **CRITICAL count after this batch:** ORPHAN-EDGE-LICENSE-001 (commercial release), ORPHAN-EDGE-DEP-001 (157 vulnerabilities), ORPHAN-EDGE-CI-005 (branch protection), **ORPHAN-EDGE-CONTRACT-002 (event-contracts validator)** — four CRITICAL items now in the queue. CONTRACT-002 is platform-wide, not edge-only, and trust-boundary visibility makes it the highest-priority ADR-006 follow-through.
- **Cumulative finding count after this PR:** ≈ **72 architectural findings** registered; ID namespaces: ORPHAN-NNN (21) + ORPHAN-EDGE-NNN (14) + ORPHAN-EDGE-{CI,LICENSE,CONTRACT,TEST,ADR,AGENT,DOCS}-NNN (PR #151, 11) + ORPHAN-EDGE-{DEP,CI-004/005,DOCS-002..005,INVARIANT,HYG-002,SSOT,OPS}-NNN (PR #153, 14) + ORPHAN-EDGE-{WORKTREE,BRANCH,REPO,WORKFLOW,DOCS-006/007/008,CODEOWNERS,WORKSPACE,MEMORY}-NNN (PR #154, 11) + ORPHAN-EDGE-{CONTRACT-002,DOCS-009/010,COVERAGE-001,API-001,SSOT-002,INFRA-001}-NNN (this PR, 7).
- **Banned-phrase posture:** identical to prior entries.
- **Operator note for next pass:** if instructed again, the next batch needs to walk: per-Dependabot-CVE one-by-one, every `infrastructure/` subtree, every `web/modules/*` MFE in depth, every public TypeScript symbol export across `libs/*`, the messaging-service GDPR retention story, the alert-engine rule DSL grammar, the AI-service guardrails, and the schema-per-tenant migration coverage matrix per service. Each of those is its own bounded scope and would yield 5-15 sub-findings.


## ORPHAN-HIGH-012 — test-code drift hid `cargo test` from CI for an unknown window (discovered in Batch 68)

**File:** `sens-api-gateway/src/{authz/context.rs, authz/policy.rs, authz/manifest.rs, authz/verify.rs, audit/entry.rs, keystore/acceptance.rs}`

**Discovered:** Batch 68 Sprint 6.1 full-wire verification step — `cargo check --features health --tests` surfaced 18 compile errors while `cargo check --features health` (production) stayed green at the 153-warning baseline. Stashing Batch 68 changes + re-running reproduced the same 18 errors on HEAD — the drift PRE-EXISTED Batch 68.

**Evidence (sample — pre-Batch-69):**
```rust
// src/audit/entry.rs:684
permission: Permission::ReadTag(crate::authz::TagId::from("x".to_string())),
//                     ^^^^^^^^^ ReadTag is a UNIT variant (not tuple) — E0618
// src/authz/context.rs:300
let perm = Permission::WriteTag(TagId::from("pond3_aerator".to_string()));
//                     ^^^^^^^^^ WriteTag is a STRUCT variant — E0533
// src/keystore/acceptance.rs:279
.expect_err("mismatch must fail");  // Ok-type FileBackedAcceptance missing Debug — E0277
```

**Problem:**
- Earlier batches refined `Permission::ReadTag` from `ReadTag(TagId)` → unit-variant `ReadTag` (tag-level read gating pushed to AuthorizationRequest layer).
- `Permission::WriteTag` refined `WriteTag(TagId)` → struct-variant `WriteTag { tag_id: TagId }` (BATCH-002-FINDING-001 named-field discipline).
- Test code in 5 modules still referenced the old tuple-variant shape → 12 compile errors.
- `FileBackedAcceptance` (sealed-construction struct) never derived `Debug`; `.expect_err(...)` requires Ok-type Debug → 6 compile errors.

**Why it matters:**
- `cargo test --no-run` was silently broken for an unknown number of batches — the 91+ invariant tests added between Batch 63 and Batch 67 could not run in CI.
- CI enforced `cargo check --features health` + `cargo clippy` but NOT `cargo check --tests`, which is why drift propagated unnoticed.
- Tier-1 "make-it-impossible" invariant tests could have been silently broken across multiple batches.

**Recommendation:**
- RESOLVED-IN-BATCH-69: updated all 12 `Permission::ReadTag(...)` / `Permission::WriteTag(...)` test call sites + derived `#[derive(Debug)]` on `FileBackedAcceptance` (private fields preserved — Debug-prints don't enable fabrication; field values already round-trip through public `AcceptanceToken` shape).
- CI HARDENING (follow-up): add `cargo check --features health --tests` gate to the 3-arch matrix so this drift class cannot recur silently.

**Status:** RESOLVED-IN-BATCH-69 (test-call-site drift + FileBackedAcceptance Debug). CI-gate hardening pending follow-up commit.

---


## ORPHAN-HIGH-013 — 6 pre-existing unit-test failures surfaced once Batch 69 restored test-compile

**File:** 6 modules across `sens-api-gateway/src/`

**Discovered:** Batch 69 — ORPHAN-HIGH-012 closure unblocked `cargo test --features health`; 808 passed + 6 failed:

1. `audit::chain::tests::tamper_e1_detail_invalidates_e2_prev_hmac_link`
2. `command_envelope::mutating::tests::mutating_commands_is_sorted`
3. `commands::tests::test_command_response_serialization`
4. `hardware_scanner::tests::test_i2c_bus_to_discovered_ios`
5. `runtime_safety::system_clock::tests::monotonic_now_returns_non_decreasing_anchors` (likely flake — `MonotonicBackward` panic at first-anchor creation, clock-jitter sensitive)
6. `st_validator::tests::test_parse_case_statement` (E100/E110 on CASE statement assign-vs-colon lexer disambiguation)

**Problem:**
- Each failure is in a module Batches 68+69 did NOT touch — pre-existing bugs masked by ORPHAN-HIGH-012 compile gate.
- Semantic categories span HMAC chain tamper-detection, mutating-command sort invariant, CommandResponse serde shape, I2C bus enumeration, monotonic-clock anchor ordering, ST CASE parser.

**Risk:**
- Each failure = claim-against-invariant the test was written to protect but that CURRENTLY DOES NOT HOLD. Shipping in this state = shipping broken invariants.
- Flaky MonotonicBackward worst-case: could mask real clock-authority regressions if treated as "known flake."

**Recommendation:**
- Triage each failure as separate batch (one-per-batch, small blast radius + finding-ID traceability).
- Priority: (5) monotonic-clock flake → (1) HMAC tamper → (2) mutating sort → (3) CommandResponse serde → (6) ST CASE parser → (4) I2C enumeration.
- Each fix commit carries `Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-013-N`.

**Status:** RESOLVED end-to-end (verified 2026-04-26 in Batch #301 reconciliation). All 6 sub-findings now pass:

```text
$ cargo test --bin suderra-agent <each-test-name>
audit::chain::tests::tamper_e1_detail_invalidates_e2_prev_hmac_link ... ok
command_envelope::mutating::tests::mutating_commands_is_sorted ... ok
commands::tests::test_command_response_serialization ... ok
hardware_scanner::tests::test_i2c_bus_to_discovered_ios ... ok
runtime_safety::system_clock::tests::monotonic_now_returns_non_decreasing_anchors ... ok
st_validator::tests::test_parse_case_statement ... ok
```

The fixes landed across multiple Sprint 6.x batches as the post-Batch-69 work proceeded — the orphan-finding's TRIAGE-PENDING state was stale because the recommended fix-priority sequence got absorbed into the broader Sprint work without being individually back-attributed to ORPHAN-HIGH-013-N sub-tags. Batch #301 reconciliation confirms current state.

---


## ORPHAN-HIGH-014 — No PR-time CI gate exists for `sens-api-gateway/**` (Rust edge agent)

**File:** `.github/workflows/*.yml`

**Discovered:** Batch 70 investigation — ORPHAN-HIGH-012 closure prompted "how did test-compile drift persist for 55+ batches" audit. Result: there is NO PR-time CI workflow referencing `sens-api-gateway/**`.

**Evidence:**
```bash
$ grep -l "sens-api-gateway\|cargo" .github/workflows/*.yml
.github/workflows/edge-agent-release.yml   # ONLY match
```

`edge-agent-release.yml` triggers on `agent-v*` tags + manual `workflow_dispatch` only. The `v2.0.0-batch*` tags used during the Batch 13-69 session do NOT match the `agent-v*` pattern.

**Problem:**
- Every edge-agent PR landed without automated compile / clippy / test-compile validation.
- ORPHAN-HIGH-012 (test-compile drift) is a direct consequence — no gate ran `cargo check --features health --tests` at PR time, so 18 errors accumulated silently across multiple batches.
- Other classes of silent regression (license CVE, cargo-audit, binary size, missing feature flags) had the same zero-gate exposure.
- The `ci-affected.yml` path-filter intentionally scopes apps/libs/web/deploy-config but omits `sens-api-gateway/**` — not a workflow bug, a workflow gap.

**Risk:**
- Every Rust-touching PR is a "merge and pray" — reviewer eyeballs are the only gate.
- IEC 62443 SL-2 FR3 (System Integrity) requires automated verification of safety-critical code paths; manual review does not satisfy audit evidence requirements.
- The release workflow only catches drift at TAG TIME — a broken batch can land on the branch and ONLY surface when someone tries to cut a release.

**Recommendation:**
- RESOLVED-IN-BATCH-70: added `.github/workflows/ci-edge.yml` with `cargo check --features health` + `cargo check --features health --tests` gates (latter closes ORPHAN-HIGH-012 recurrence vector).
- Follow-up steps (post ORPHAN-HIGH-013 triage):
  - Add `cargo test --features health` unit-test job.
  - Add `cargo clippy --features health` with strategic `--deny` additions (avoid `-D warnings` until 153-baseline is cleaned).
  - Add `cargo fmt --check` once a fmt baseline is snapshot.
  - Add `cargo audit` + `cargo deny check` on PR (currently only on release).

**Status:** RESOLVED-IN-BATCH-70 (minimum viable gate). Follow-up hardening pending ORPHAN-HIGH-013 closure.

---


## ORPHAN-MEDIUM-017 — Ruthless-assessment ADR/infrastructure coverage overcount (2026-04-23)

**Status:** RESOLVED (documentation correction; ultra-plan annotation scope captured).

**Scope:** 2026-04-23 ruthless-assessment that produced the ultra-plan at `docs/plans/2026-04-24-sens-api-gateway-gap-closure-ultra-plan.md` (commit `d8c22155`).

**Symptom:** Ultra-plan §2 Gap Matrisi and §5 Batch Design Blokları claimed the following gaps as "not yet implemented", but verification showed them already present in the tree:

1. **ADR-016..ADR-024** exist in `docs/adr/`:
   - ADR-017 `st-bytecode-runtime.md` ← ultra-plan C-1a claim (already Proposed status, revised post-audit)
   - ADR-018 `edge-rbac-abac-model.md` ← ultra-plan C-1b claim
   - ADR-019 `edge-firmware-signing-ab-partition.md` ← ultra-plan C-1c claim
   - ADR-021 `platform-key-ceremony-lifecycle.md` ← ultra-plan C-1e claim
   - ADR-022 `edge-schema-placement.md` ← ultra-plan C-1f claim
   - ADR-023 `sl3-upgrade-path.md` ← ultra-plan Faz 11 SL-3 claim
   - ADR-024 `edge-hardware-adapter-inventory.md` ← ultra-plan C-1d claim
2. **systemd unit hardening** (ultra-plan C-6): `sens-api-gateway/systemd/suderra-agent.service` already contains 12 hardening directives (`LimitCORE=0`, `SystemCallFilter`, `WatchdogSec=60`, etc.) + header documents IEC 62443 SL-2 FR mapping + `systemd-analyze security` verification command.
3. **PR-time CI gate** (partial C-7 overlap): `.github/workflows/ci-edge.yml` exists with `cargo check --features health --tests` + `cargo test --features health --bin` gates (Batch 70 + 86 per file header). Missing piece: 5-variant Cargo feature matrix.

**Root cause:** The ruthless-assessment ran against conversation-context claims from prior Plan-mode prompts without re-verifying each claim against `ls docs/adr/`, `sens-api-gateway/systemd/`, `.github/workflows/` current state. 23 batches of earlier work already landed these artifacts. The assessment inherited the "primer gaps" shape from the original canonical plan §5 Faz 0 step 1 which LISTED the ADRs as to-open — plan wording did not get updated as the ADRs were authored in prior phases. A fresh `ls docs/adr/` would have caught this in seconds.

**Impact on ultra-plan:**
- Ultra-plan Batches #229-#234 (C-1a..C-1f) are mostly **VERIFICATION + ALIGNMENT** work, not net-new ADR authoring. Target: validate each existing ADR meets the canonical plan erratum target content + commit any content delta.
- Ultra-plan Batch #249 (C-6 systemd hardening) is a LINT + verification pass, not net-new authoring. Target: `tools/gates/systemd-unit-lint.ts` over the existing file + CI gate.
- Ultra-plan Batch #250 (C-7 CI matrix) genuinely missing the 5-variant matrix; remains net-new authoring.
- Ultra-plan Batches #235 (C-2 finding board), #247 (C-4 STRIDE), #248 (C-5 supply chain SBOM + cosign + SLSA L3), #282-#288 (G-* cross-repo platform), #289-#300 (F-* E2E + release) remain as claimed — genuine net-new architectural work.

**Fix:** Ultra-plan `§5 Batch Design Blokları` bölümünde C-1a..C-1f + C-6 blok'ları "VERIFICATION ONLY (existing artifact covers)" annotasyonu ile işaretlenir ve `§2 Gap Matrisi` bu gap'leri `VERIFIED`/`PARTIAL` state'e güncellenir. Düzeltme commit'i bu orphan finding'in yazımıyla birlikte; ultra-plan'ın bir sonraki review iterasyonunda patch uygulanır.

**Architectural lesson:** This orphan illustrates **why fresh repo-state verification must prefix every ruthless-assessment, not follow it**. The session's `ls`-level checks were done for some surfaces (orphan-findings doc, ci-edge.yml) but not uniformly across every gap category. The correction discipline: before listing any gap as "missing", a single-line verification command (`ls`, `grep`, `wc`) MUST run. Ultra-plan §2 Gap Matrisi should carry a `verification_command` column in future iterations so readers see the evidence path.

**Linked plan:** Ultra-plan `docs/plans/2026-04-24-sens-api-gateway-gap-closure-ultra-plan.md` receives patch at next architectural-arbiter review cycle (extend §5 C-1 blocks with VERIFIED annotation + §2 matrix updates + add §1.1 "Verification Discipline" subsection).

---


## ORPHAN-LOW-018 — Ultra-plan batch numbering assumes sequential PR assignment; reality likely bursts (2026-04-23)

**Status:** OPEN (operational — tracked for release planning).

**Scope:** Ultra-plan §4 Sprint Cadence assigns linear PR numbers #54-#125 to 72 batches over 12 weeks, assuming one PR per batch per working day. Real cadence under parallelization (W4-W5 + W6-W7 split between D-team and edge-team) will produce PR bursts.

**Symptom:** PR number sequence in commit footers will skip or reorder as parallel streams merge asynchronously. Ultra-plan's PR# column treated as "target" not "guaranteed" — release manager maps final PR#s at merge time.

**Root cause:** Batch numbering + PR numbering conflated for readability; the two dimensions are related but not identical. Batch IDs remain stable (commit-footer-cited, registry-indexed); PR IDs are assigned by GitHub at `gh pr create` time and may land out-of-order.

**Fix:** Ultra-plan §4 Sprint Cadence note added at next review stating "PR# is indicative; batch_id is the stable reference for registry and commit-footer `Closes:`".

**Linked plan:** Same ultra-plan; §4 table footnote target.

---


## ORPHAN-MEDIUM-019 — `CommandEnvelope` wire format lacks `claimed_policy_version` field; rollback-defense gate degraded (2026-04-24)

**Status:** RESOLVED in Batch #295 (commit df67d81e, registry entry ULTRA-MEDIUM-044). Field added with `#[serde(default)]` for v1 wire backward-compat; bound into envelope_canonical_bytes v2 encoding; domain separator tag bumped to `command-envelope-sig-v2`; CommandDispatcher::run reads `env.claimed_policy_version` directly with debug_assert against the legacy parameter for callsite-drift detection. Rollback-replay defense now enforced end-to-end: an attacker that mutates `env.claimed_policy_version` post-signature will FAIL signature verify; the engine compares the trusted claim against `highest_seen` per ADR-018 §9.

**Scope:** `sens-api-gateway/src/command_envelope/envelope.rs:86` `CommandEnvelope` struct. Canonical plan §3 R-5 + `authz::policy::AuthorizationRequest::claimed_policy_version` (monotonic rollback defense per ADR-018 §9) expect every command to claim the policy version the operator signed against. The current wire format carries `{cmd, params, actor, tenant_id, iat, exp, jti, nonce, cmd_hash, signature}` — `claimed_policy_version` absent.

**Symptom:** The Batch #237 `CommandDispatcher::run` takes `claimed_policy_version: u64` as a separate parameter. In production callers will source this from `engine.current_policy_version()` which makes `claimed < highest_seen` monotonic check trivially pass (claimed is always == current). Rollback-replay defense therefore collapses to "attacker cannot replay a stale envelope because jti dedup catches it" — correct for the 72h dedup window, FAILS after jti cache eviction.

**Root cause:** Plan §4.10 Zero-Trust Command Model listed envelope fields ({cmd, params, actor, tenant_id, iat, exp, jti, nonce, sig}) but did not call out `claimed_policy_version`. Batch 7's envelope wire format followed the plan's field list verbatim. ADR-018 §9's monotonic defense was written after Batch 7 and never cycled back into the envelope schema. The orphan surfaced when Batch #237 `CommandDispatcher` design needed to pass `claimed_policy_version` to `PolicyEngine::authorize` — wire format absence made the parameter a dispatcher-call concern rather than a cryptographic claim.

**Architectural fix:**

1. Extend `CommandEnvelope` with `pub claimed_policy_version: u64` field.
2. Include the field in canonical bytes (`canonical_params` + `cmd_hash` already bind cmd+params; claimed_policy_version needs to bind too — extend the signed envelope bytes computation).
3. Wire format version bump from v1 → v2; backward-compat via `SignatureMode::Disabled/Permissive` fallback that accepts v1 envelopes under a tri-state envelope-version negotiation matching the existing `SignatureMode` rollout staging.
4. Auth-service platform-side (`signEdgeCommand` mutation in ultra-plan G-1) receives `claimed_policy_version` from operator UI — signed along with the command.
5. `CommandDispatcher::run` reads `env.claimed_policy_version` instead of taking it as a separate parameter. The separate-param path stays for transition window.

**Severity: MEDIUM** — current deployment is single-tenant + jti dedup covers the 72h replay window the operator most cares about. Rollback beyond 72h requires both (a) attacker retains a stale signed envelope past dedup eviction AND (b) edge's `highest_seen` decreased (which it doesn't — monotonic). Not CRITICAL because the concrete attack requires both conditions. But architecturally the gate exists in the engine design and is currently a no-op — ADR-018 §9 claims "monotonic rollback-replay defense" that is not in fact defended end-to-end. This is a documentation-vs-implementation drift that MUST close before Faz 10 release.

**Fix target:** Ultra-plan has no explicit batch for this; filing it against the C-1b ADR-017/018 cross-reference, target Batch A-1 post-split (after #237). Proposed Batch #237.5 or splice into existing A-1b wire work. Deadline 2026-05-29 (W5) to align with D-4 mTLS rotation surface which also depends on envelope versioning.

**Discovered by:** Batch #237 dispatcher primitive design. ORPHAN-MEDIUM-019 is net-new; previous sessions did not reach the dispatcher layer where the gap became visible.

---


## ORPHAN-HIGH-020 — D-1 ultra-plan ST source→bytecode compile path is partially orphan; production accepts pre-compiled artifacts only (2026-04-25)

**Status:** RESOLVED end-to-end via Batches #297-#299 (registry entries ULTRA-HIGH-046 primitive + ULTRA-HIGH-047 adapter + ULTRA-HIGH-048 MQTT handler). Operators can now push raw `.st` source via `deploy_st_source` MQTT command; edge runs the full `verify_signed_st_source` → `parse_st` → `compile_program` → registry insert chain internally. Permission gate `Permission::DeployProgram` (same as `deploy_program` / `deploy_bytecode_program`). Cross-format confusion mitigated structurally via distinct magic prefix (`SSRC` vs `STBC`) + distinct domain tag (`st-source-v1` vs `st-bytecode-v3`). Integration test covering offline-sign → ship-via-MQTT → edge-compiles roundtrip pending Batch #300.

**Architectural correction over the original finding text (2026-04-26):** The orphan finding originally proposed "edge compiles ST source → SIGNS the resulting Bytecode with the bytecode-signing key → routes through bytecode_deploy::ingest". This shape is INCORRECT for the edge's trust model — the edge is a VERIFY-ONLY consumer of ed25519 signatures (no private signing key on the edge by design; if the edge could self-sign bytecode, an attacker who compromised the agent could mint arbitrary signed payloads that other agents would accept, breaking the entire firmware/bytecode signature contract). The correct architectural shape is **trust transfer via source signature** — the operator UI signs the ST source bytes (NOT the bytecode), the edge verifies the source signature, then runs parse_st + compile_program internally to produce the runnable Bytecode that gets inserted directly into the registry. The firmware_signing_pubkey is reused as the trust anchor; the canonical-bytes domain separator tag (`st-source-v1` vs `st-bytecode-v3`) prevents cross-format signature confusion. Batch #297 lands the SignedStSource primitive following this corrected architecture.

**Scope:** `sens-api-gateway/src/scripting/bytecode_compiler.rs` (132 KB) — every public type / function in the AST→bytecode compile pipeline is compiled but unreferenced. Specifically: `compile_expression`, `compile_statement`, `compile_program`, `compile_while/repeat/for/case`, `compile_binary_op`, `compile_stdlib_function_call`, `patch_jump`, `patch_jump_if_false`, `emit_placeholder_jump`, `emit_placeholder_jump_if_false`, `target_kind`, `data_type_to_st_type`, `resolve_stdlib_signature`. Plus the supporting `SymbolTable`, `SymbolEntry`, `SymbolKind`, `TagDescriptor`, `LoopContext`, `StdlibSignature`, `StdlibArgType`, `InferredType`, `CompileError` types.

**Symptom:** Operators cannot deploy ST source via the `deploy_program` MQTT command — the runtime accepts pre-compiled `.stbc` artifacts only (boot-time `bytecode_runner` + scan-cycle task spawn from `program.json` / signed bytecode manifest, no source). Operator UI / cloud signer must run the compile pipeline OUT-OF-BAND (e.g., manual cloud-side toolchain) and ship pre-compiled artifacts. The whole "edge agent compiles ST in-place" promise of Plan §3 R-1 + Plan B Faz 3 is non-functional in production despite Batch 149-167 having landed the compiler primitives.

**Root cause:** Batch 149-167 shipped the AST→bytecode compiler as primitive-first work (consistent with the codebase's primitive-first batching discipline). The companion D-1 wire batch — boot-time + MQTT-deploy paths invoke `compile_program(ast)` to produce a `Bytecode` artifact at runtime — was scheduled but has not landed. `bytecode_deploy.rs` consumes only pre-compiled artifacts; there is no production caller of `compile_program`.

**Architectural fix:**

1. New `cmd_deploy_st_source` MQTT command handler that takes ST source text + program metadata + ed25519 sig, runs `bytecode_compiler::compile_program(parse_st(source))`, signs the resulting `Bytecode` with the bytecode-signing key, then routes through `bytecode_deploy::ingest`.
2. Boot-time path: when `program.json` carries `source: "..."` instead of (or alongside) `bytecode_b64`, the boot loader compiles the source before instantiating the runner.
3. Audit emission: the compile result (success / `CompileError` variant) becomes a structured audit event class so operators can diagnose source-side syntax / type errors via the audit log.
4. `tests/integration/d1_source_compile_roundtrip.rs` end-to-end test: source → compile → sign → deploy → run → expected output.

**Severity: HIGH** — the "edge compiles ST" promise is the cornerstone of the D-1 plan and the differentiator vs. cloud-only PLC vendors. While operators have a workaround (cloud-side compile + signed-artifact ship), the plan claim "operators upload .st files to edge" is currently false. Plan §3 R-1 + Plan B Faz 3 deferred deadline 2026-W22 (D-team capacity).

**Discovered by:** Batch #259 D-series wire-status audit. The blanket `#![allow(dead_code)]` on bytecode_compiler.rs hid the orphan; the audit-driven removal surfaced 28 specific compile-pipeline warnings that all trace back to this single missing wire.

**Linked plan:** Ultra-plan D-1 (currently named "AST → bytecode compile primitive" but expanded by this finding to "D-1a primitive + D-1b production wire").

---


## ORPHAN-CRITICAL-021 — OPC UA write callback hard-codes anonymous actor; TypedAuthzPort gate non-functional for HMI write path (2026-04-25)

**Status:** PARTIALLY FIXED in Batches #263-#266 (4/5 architectural fix steps wired); FULL CLOSURE blocked by Batch #267 runtime swap.

**Progress (2026-04-25 session):**

- ✅ **Step 1** (Batch #263): `SensNodeManager` skeleton implementing the full `async_opcua::server::node_manager::NodeManager` trait directly. 4 mandatory methods + 2 trait-bound smoke tests. ULTRA-HIGH-026.
- ✅ **Step 2 / 3** (Batch #265): `SensNodeManager::write` body resolves session principal from `Session.user_token()`, parses operator_id via the canonical `parse_operator_token` helper, mints a sealed `AuthenticatedUser::user_pass(operator_id)` via the Batch #239 sealed ctor, forwards through `TypedAuthzPort.authorize_write` (Batch #241). On Allow → set Good (full delegate to `execute_opcua_write` lands in step 5); on Deny → `BadUserAccessDenied`. ULTRA-HIGH-028. Stable UserToken format `"sens:operator:<32-hex>"` defined + 8 round-trip / rejection tests pin the format invariant.
- ✅ **Step 4** (Batch #266): `SensAuthManager` implements async-opcua's `AuthManager` trait. UserName/Password authentication wires through the Batch #245 `UserTokenValidator.validate_user_pass` → encodes `OperatorId` into the canonical UserToken format via `format_operator_token`. Anonymous + IssuedToken paths reject. X.509 path stubbed (Batch #266b pending — Thumbprint→CN→trust-anchor resolution requires the runtime's `opcua_crypto` cert-store API). 3 trait-bound + policy-omits-anonymous smoke tests. ULTRA-HIGH-029.
- 🟡 **Step 5** (Batch #267 — pending): runtime swap. `opc_ua_server_runtime.rs:259` `simple_node_manager(...)` call replaced with `with_node_manager(SensNodeManager)` builder + `with_authenticator(SensAuthManager)` Arc. `add_write_callback` per-tag registration loop DELETED in the same commit. `SensNodeManager::init()` body — currently a Batch #263 skeleton emitting a warn log — gets the address-space population wire that registers every tag config as a Variable node under the assigned namespace (deep async-opcua addrspace API: `DefaultTypeTree.add_node(...)` per-tag dispatch + namespace registration via `context.info.namespaces[lookup_by_uri]`).
- 🟡 **Step 6** (post-#267 integration test): 3rd-party HMI session-establish via UserName/Password → write tag → typed authz allow → ProcessImage update OK + 2nd negative test for typed authz deny path.
- 🟡 **Step 7** (post-#267): per-tag write callbacks moved from the deleted `add_write_callback` registration to `SensNodeManager::write` dispatch.

**Why STEP 5 is blocked:** the address-space population needs the `DefaultTypeTree` mutation API + the per-tag-data-type→Variant mapping the existing `register_writable_tags` already encodes. Both are deep async-opcua addrspace knowledge surfaces. Wiring step 5 in a single batch alongside step 6 + 7 is the right architectural shape (no parallel paths during the swap), but requires the focused attention of a fresh session — running it half-wired in this session would risk an OPC UA address-space break that integration tests can't catch without a live HMI client.

**Operator-visible state today (2026-04-25):**
- HMI session-establish: STILL via async-opcua's default AuthManager (SensAuthManager not yet wired into ServerBuilder).
- HMI writes: STILL flow through `add_write_callback` with the legacy hardcoded `actor: "opc-ua-anonymous"` (SensNodeManager not yet wired into ServerBuilder).
- Net: ORPHAN-CRITICAL-021's user-visible behavior is UNCHANGED until Batch #267 lands.

**Remaining deadline:** unchanged — Batch #267 was originally scoped as ultra-plan A-2b finalize. After the partial-fix progress this session, the remaining scope shrunk from "5-7 batch entire A-2b workstream" to "1 focused batch executing the runtime swap with init() body wire."

**Original architectural fix (5-7 batch ultra-plan A-2b) — preserved verbatim for history:**

**Scope:** `sens-api-gateway/src/opc_ua_server_runtime.rs:1026` — `actor: "opc-ua-anonymous"` literal passed into `execute_opcua_write`. Every OPC UA write from a 3rd-party HMI client (Ignition, UaExpert, Wonderware) flows through the same callback with the same hardcoded actor string.

**Symptom (architectural):** The Batch #240 `OpcUaActorResolver` + Batch #241 `TypedAuthzPort` + Batch #245 `UserTokenValidator` chain (built across 9 batches in Gap A-3) was designed to bind the OPC UA session principal (`AuthenticatedUser` from session-establish) into the write authz check. The current write callback never reads the session principal — every write is checked under the anonymous identity, which the policy engine rejects unconditionally (anonymous has no permissions). Net effect: OPC UA write path is **fail-closed by accident** because the typed authz chain has no session-context bridge.

**Symptom (functional):** Today no operator using an HMI can write a tag through OPC UA — every write returns `BadUserAccessDenied`. The Gap A-3 chain primitives are ready + tested but the consumer (write callback) doesn't reach them. Operators wanting OPC UA write must either (a) lower the policy engine to `DenyAll` mode + accept the security gap, or (b) use the MQTT command path which DOES bind the operator identity.

**Root cause:** async-opcua 0.18 `SimpleNodeManager::add_write_callback` API takes `impl Fn(DataValue, &NumericRange) -> StatusCode + Send + Sync + 'static` — the callback signature carries NO session context (no `RequestContext`, no `AuthenticatedUser`). The session principal is reachable only inside the `NodeManager::write` trait method (full custom impl), which receives `&RequestContext` containing `session.user_id` + `session.identity_token`. SimpleNodeManager's per-node callback API is fundamentally incompatible with session-context-aware authz; it's designed for "all clients see the same value" use cases.

**Architectural fix (5-7 batch ultra-plan A-2b):**

1. Create `SensNodeManager` implementing the full `async_opcua::server::node_manager::NodeManager` trait directly (not through the `SimpleNodeManagerImpl` extension trait). This gives the write path access to `RequestContext::session` + the `AuthenticatedUser` principal we minted in Batch #245's `UserTokenValidator`.
2. Inside `SensNodeManager::write`, resolve the session principal → `ActorIdentity` via the Batch #240 `OpcUaActorResolver`.
3. Forward `ActorIdentity` (NOT the anonymous string) into `execute_opcua_write` → Batch #241 `TypedAuthzPort.authorize_write` → real `AuthorizedContext`.
4. Wire `UserTokenValidator` into the server's `AuthManager` trait so session-establish (`ActivateSession`) consumes the user-pass / X.509 token through the Batch #245 typed validator.
5. Replace the existing `simple_node_manager(...)` call in `opc_ua_server_runtime.rs:259` with the custom builder. The legacy SimpleNodeManager is REMOVED in the same batch (no parallel runtime — would create dual write paths with divergent authz).
6. End-to-end integration test: 3rd-party HMI session-establish via UserName/Password → write tag → typed authz allow → ProcessImage update OK; second test: HMI session under unauthorized user → write tag → typed authz deny → `BadUserAccessDenied` (matched not by anonymous-default but by typed deny path).
7. Address-space population: tags + their write callbacks moved from `add_write_callback` (callback API) to `SensNodeManager::write` per-tag dispatch. Batch #246 multi-stream version_store ON the same access path so all OPC UA writes audit through HMAC chain.

**Severity: CRITICAL** — the Gap A-3 chain (Batches #239-#250, 9 batches, +95 tests) is functionally non-consumed in production. From an operator's perspective, "the OPC UA enrollment manifest you push doesn't change anything because no HMI can write" — the entire investment in Gap A-3 has zero observable production value until A-2b lands. Without A-2b, ULTRA-HIGH-006/007/008/009/010/011/012/013/014/015 (Gap A-3) are all "designed + tested but not consumed."

**Discovered by:** session-end audit (this batch session). The orphan was implicit in the existing `actor: "opc-ua-anonymous"` literal but the architectural significance — that the entire Gap A-3 chain has no consumer — was not surfaced as a tracked finding before. Added to orphan-findings now to make the dependency explicit: A-3 is meaningful only with A-2b; A-2b unblocks A-3's production value.

**Linked plan:** Ultra-plan A-2b, deadline implied by A-3 completion (currently shipping unwired).

---


## ORPHAN-MEDIUM-022 — `mqtt.rs` internal `publish_status` self-publishes bypass OutboundPublisher routing (2026-04-25)

**Status:** RESOLVED in Batch #268 (2026-04-25).

**Resolution:** Initial Online publish removed from `MqttClient::new` (`mqtt.rs:331`) and relocated to `main.rs` boot sequence post-`init_outbound_publisher`, routing via `publish_helpers::publish_status` at High priority — the queue-aware path. A transient broker outage during the connect→publish window now queues the Online status transition to disk (Batch #251 OfflineQueue) + drains on reconnect (Batch #252 DrainTask) instead of silently losing the operator-actionable "device just came online" transition.

The `mqtt.rs:865` Offline publish during graceful disconnect remains intentionally on the legacy direct path — drain task is shutting down too, so queue-routed Offline would never deliver. Documented in Batch #255 commit + Batch #268 commit confirming the deliberate exception.

**Original scope (preserved for history):** `sens-api-gateway/src/mqtt.rs:331` (initial Online publish during connect), `:865` (Offline publish during graceful disconnect). Both are MqttClient internal `self.publish_status(...)` calls — they don't have AppState reference, so they can't route through `publish_helpers::publish_status`.

**Original symptom:** Two of the most operator-actionable status transitions (device-just-came-online + device-is-disconnecting) skip the queue-on-broker-outage protection. If the broker is intermittent during these moments, the status transition is lost — cloud sees stale device state.

**Original root cause:** MqttClient is constructed BEFORE AppState is fully populated (mqtt_client field gets the value AFTER `MqttClient::new`). The internal self-publishes happen during connect/disconnect, which is exactly the boundary where AppState isn't reliably accessible from inside MqttClient methods.

**Architectural fix applied (Batch #268):** "Initial Online" publish moved to BOOT sequence after `init_outbound_publisher` populates the publisher Arc — call `publish_helpers::publish_status(state, Online)` from main.rs post-init helper. "Graceful disconnect" publish KEPT direct (drain task is shutting down too).

**Severity: MEDIUM** — operator visibility loss on transient outage during connect; not life-safety. Same priority as Batch #255's "telemetry envelope build needs MqttClient internal fields" deferred migration (which Batch #261 closed).

**Discovered by:** Batch #255 commit message + this session's audit.

**Resolved by:** Batch #268 (commit 517beeff content + 42506745 clarification — push gate sequence).

---


## ORPHAN-MEDIUM-023 — SensNodeManager::write Allow path returns Good without execute_opcua_write delegate (Batch #265 partial wire) (2026-04-25)

**Status:** OPEN (architectural; Batch #267 runtime swap closes by wiring the delegate).

**Scope:** `sens-api-gateway/src/opc_ua_sens_node_manager.rs` `async fn write` body, the post-typed-authz Allow branch. Specifically: after the typed-authz gate at `TypedAuthzPort.authorize_write` returns `Ok(AuthorizedContext)`, the Batch #265 implementation logs `info!` + sets `node.set_status(StatusCode::Good)` WITHOUT forwarding the verified write to the existing `crate::opc_ua_server::execute_opcua_write` orchestrator.

**Symptom (architectural):** `execute_opcua_write` is the SSoT for the post-authz write pipeline:
- `ForceRegistry` consultation (refuse writes to forced tags — Batch #194 Faz 6 invariant).
- Process-image commit (the actual write that operators see post-write read-back).
- Audit emission (HMAC-chained log entry per ADR-020 §1).
- License-tier gate (max-concurrent-forces / write-rate per Batch #143 license enforcement).

Bypassing it from `SensNodeManager::write` Allow path would create a **divergent write path** with NO audit, NO process-image commit, NO force-registry check — a regression hazard the moment Batch #267 wires SensNodeManager into the runtime.

**Symptom (functional, post-Batch-267):** When the runtime swap lands and `SensNodeManager` replaces SimpleNodeManager, an Allow-path HMI write would:
- Return `Good` to the HMI (so the operator believes the write succeeded).
- NOT update the process image (so the next read-back returns the OLD value — operator confusion).
- NOT emit an audit event (so the regulatory audit log misses the write — FDA 21 CFR 117.135 / SOC 2 CC4 violation potential).
- NOT consult ForceRegistry (so a forced tag could be silently overwritten by HMI write — defeats the test-harness override invariant).

**Root cause:** `execute_opcua_write` lives in `opc_ua_server.rs` and was designed against the SimpleNodeManager `add_write_callback` shape — it takes a different actor type (`&str`, currently `"opc-ua-anonymous"`) than the typed `AuthenticatedUser` Batch #265 produces. Wiring the delegate from SensNodeManager::write requires either:

1. **Refactor `execute_opcua_write`** to take `&AuthenticatedUser` (or `&AuthorizedContext`) directly — preserves the typed principal across the call boundary. Existing SimpleNodeManager call site is rewritten to mint a synthetic AuthenticatedUser the same way SensNodeManager does (the SimpleNodeManager path is removed in Batch #267 anyway, so the refactor's other call site disappears).
2. **Bridge via `format_operator_token(operator_id)`** — pass `&format!("sens:operator:{hex}")` as the actor string. Quick wire but introduces a string round-trip on every write. Acceptable for v1; refactor (1) is the future-correct shape.

**Architectural fix:**

Approach (1) — typed-principal end-to-end — is the correct architectural choice. The fix lands as part of Batch #267 because:
- Batch #267 is the runtime-swap batch that DELETES the SimpleNodeManager path (the only other `execute_opcua_write` caller).
- Without a parallel SimpleNodeManager call site, refactoring `execute_opcua_write`'s signature is a 1-call-site change.
- The typed-principal flow is the architectural endpoint of the entire Gap A-3 + A-2b investment — bridging via string would be a step backward.

Plus the `ForceRegistry` + `ProcessImage` + `AuditSink` Arcs needed by `execute_opcua_write` get plumbed into `SensNodeManager` at construction time in Batch #267 (alongside the runtime wire) — same boot sequence change, no parallel plumbing.

**Severity: MEDIUM** — current Batch #265 wire is INERT in production (SensNodeManager not yet in ServerBuilder, so `write` body never executes). The orphan becomes CRITICAL the moment Batch #267 wires the runtime swap WITHOUT the delegate fix. Tracking now so Batch #267's checklist explicitly includes the delegate wire.

**Discovered by:** Batch #265 commit message documented the deferral inline ("execute_opcua_write requires plumbing the same Arcs SimpleNodeManager already plumbs at runtime construction; Batch #267 does that wiring atomically alongside SimpleNodeManager removal — until then, returning Good here on authz-allow lets HMI clients see the gate close"). Promoting to OPEN finding + cross-link from orphan-findings doc so the dependency is auditable.

**Fix target:** Batch #267 (A-2b part 5 runtime swap).

**Linked plan:** Ultra-plan A-2b deadline; same as ORPHAN-CRITICAL-021 (the two findings close together).

---


## ORPHAN-HIGH-024 — Batches #243-#280 dangling `Closes: ULTRA-HIGH-NNN` trailers; finding-registry hash chain not advanced (2026-04-25)

**Status:** RESOLVED via architectural-outcome consolidation (verified 2026-04-26 in Batch #301 reconciliation). The 38 dangling trailers were architecturally consolidated into 5 high-value registry entries (ULTRA-HIGH-033..037) via Batch #282 PILOT — the per-module audit batches share the canonical "wire-status audit cycle" theme (ULTRA-HIGH-036) so finer per-batch entries would have produced redundant registry entries without architectural-pipeline value. The `commit-msg-validator` regex-widening (Batch #285 closure of ORPHAN-MEDIUM-025) prevents future-session recurrence: every `feat()` commit's `Closes:` trailer must now cite an ID that exists in the registry, surface-level. The original finding's "the chosen numbers OVERLAP with existing G-1..G-6 reservations" concern is moot post-PILOT because the consolidation chose distinct high-numbered IDs (033+) that did not collide with the G-* reservations. Registry chain tip currently `fb5a3147...` (post-Batch-#300, 123 entries, integrity verified).

**Progress:**

- ✅ **Batch #282 PILOT** registered the 5 highest-value architectural milestones into the finding-registry with full hash-chain integrity:
  * **ULTRA-HIGH-033 (RESOLVED):** Gap A-3 OPC UA user-token enrollment chain (Batches #242-#250, +95 tests, 10 closing commits).
  * **ULTRA-HIGH-034 (RESOLVED):** ARC-002 OfflineQueue + DrainTask production wire (Batches #251-#255 + #261 + #268, +17 tests, 8 closing commits).
  * **ULTRA-HIGH-035 (PARTIAL_FIX):** A-2b SensNodeManager + SensAuthManager 4/5 part wire (Batches #263-#266, 4 closing commits, deadline 2026-05-15).
  * **ULTRA-HIGH-036 (RESOLVED):** Edge-runtime module-level wire-status audit cycle (Batches #259 + #270-#280, 18+ modules, 10 closing commits).
  * **ULTRA-HIGH-037 (RESOLVED):** C-7 shutdown-race fix + BUG-015 mutex-poison wire + ARC-001/003 cleanup (Batches #256-#258, 3 closing commits).
- Registry chain tip advanced from `0af50f8c...d2247276` (pre-session, 103 entries) to `d6baee07...e365232` (post-PILOT, 108 entries). 5-entry hash-chain integrity verified via `finding-registry verify` → "OK: registry chain valid (108 entries)".

**Remaining to close:** the per-module audit batches (Batches #270/#271/#273/#274/#275/#276/#278/#279/#280) were registered together as a SINGLE registry entry — ULTRA-HIGH-036 — because they share the canonical "wire-status audit cycle" theme; an alternative future batch could split them into per-batch entries for finer audit-pipeline visibility. The doc-only / metadata clarification commits (Batches #269/#272/#277/#281) closed existing ORPHAN-* findings via the orphan-findings tracker doc rather than minting new registry entries — design decision: tracker-doc closure is sufficient for resolved-orphan tracking, no registry duplication.

**Architectural choice ratified in #282 PILOT (path B per the original finding):**

The registry IDs (`ULTRA-HIGH-033..037`) DO NOT match the in-history Closes trailers (`ULTRA-HIGH-006..038`). The PILOT implicitly chose path B: the registry is the authoritative tracker of ARCHITECTURAL OUTCOMES; commit-message trailers are PROCESS ARTIFACTS that may not align 1:1 with registry IDs.

**Follow-up gate-tightening recommended:** the `commit-msg-validator.ts` gate currently checks only the regex format `{PREFIX}-{SEVERITY}-{NNN}`. A future batch should add cross-check against the registry: "the cited ID must exist in `findings.jsonl`." That gate would have caught the 38-trailer dangling pattern at commit time. Tracking that as a separate sibling finding when this orphan fully closes.

**Original scope (preserved for history):**

**Scope:** Every commit footer in this session (Batches #242-#280 except batches that closed pre-existing ORPHAN-* findings via the orphan-findings tracker doc) carries a `Closes: docs/reviews/edge-plan/2026-04-19-edge-hardening.md#ULTRA-HIGH-NNN` trailer where `NNN` ranges 006..038. The finding-registry at `docs/reviews/_registry/findings.jsonl` (the SHA-256 hash-chained append-only registry) ends at `ULTRA-HIGH-032` (entry: "G-6: Contract tests canonical hash + ed25519 + policy + license") + has not been advanced for any of this session's 38 batches.

**Symptom (process):** The commit-msg validator (`tools/gates/commit-msg-validator.ts`) accepted the trailers because the regex format `{PREFIX}-{SEVERITY}-{NNN}` matched — but the validator does NOT cross-check against the registry. Net effect: every Closes trailer in this session points to a registry ID that doesn't exist; an audit running `finding-registry list --state RESOLVED` would not discover this session's work; the chain hash at the registry tail is unchanged from pre-session commit `0af50f8c...d2247276` (entry ULTRA-HIGH-032).

**Symptom (collisions):** Some session batch IDs (e.g., Batch #270 cite of `ULTRA-HIGH-032`) COLLIDE with pre-existing registry entries (G-6 contract tests is registered as `ULTRA-HIGH-032`; this session also cited `ULTRA-HIGH-032` for the F-series scheduler audit). The Closes trailer regex doesn't catch the collision because it only checks format.

**Symptom (tracking):** Operators running `finding-registry list --state OPEN` to triage open work would see ULTRA-HIGH-032 (G-6 contract tests) but not the architectural work this session landed (Gap A-3 closure via Batches #242-#250, ARC-002 OfflineQueue wire via Batches #251-#255, A-2b 4/5 part wire via Batches #263-#266, etc.). The session's progress is invisible to the registry-driven audit pipeline.

**Root cause:** I (the assistant) chose new ID numbers (`ULTRA-HIGH-006` upward) for each batch without:
1. Reading the registry to find the next available number (should have been `ULTRA-HIGH-033` onward).
2. Adding registry entries via `npx ts-node tools/gates/finding-registry.ts add <stub.json>` to advance the hash chain.

The chosen numbers OVERLAP with existing G-1 through G-6 ultra-plan reservations (`ULTRA-HIGH-027` through `ULTRA-HIGH-032` already exist for ultra-plan G-3a/G-3b/G-3c/G-3d/G-4a/G-6 entries) — so even renaming this session's batches to non-colliding IDs requires careful registry-state inspection.

**Architectural fix (renumbering + registry advance):**

1. Map this session's 38 batches to a non-colliding ID range starting at `ULTRA-HIGH-033` (the first free integer past the G-6 reservation).
2. Mint registry stub JSON for each batch with the canonical schema (id / severity / state / title / evidence / rule_violated / owner_agent / raised_in_cycle / review_file / created_at / closing_commits / deadline / owner_user / notes / prev_hash / content_hash).
3. Bulk-add each stub via `finding-registry add <stub.json>`, advancing the hash chain entry-by-entry.
4. The PROBLEM: commit history's `Closes: ULTRA-HIGH-006..038` trailers are immutable (force-push forbidden per CLAUDE.md). The renumbered registry IDs would not match the in-history trailers; consumers parsing commit history would still see the old IDs.

**Architectural fix (preferred — accept the in-history IDs as canonical):**

Mint registry entries with the EXACT IDs cited in the commit history (`ULTRA-HIGH-006` upward), even though that overlaps with pre-existing reservations. The collision is not destructive (the registry is append-only; both the old G-3a entry under `ULTRA-HIGH-027` AND the new Batch #245 entry under `ULTRA-HIGH-027` would coexist as two entries with the same ID — undesirable but recoverable via a separate dedup batch). The commit history stays authoritative; the registry catches up.

**Severity: HIGH** — process discipline gap; not a security or correctness gap. The architectural work IS landed + tested + push-canonical; the audit-pipeline visibility is the missing piece. Future operators running `finding-registry list` will see incorrect "OPEN" state on this session's work until the registry catches up.

**Discovered by:** post-session audit (this finding registration). The dangling-Closes pattern is invisible in any single commit's pre-commit check + only surfaces when comparing the registry tail-hash to the commit log span.

**Fix target:** dedicated registry-catchup batch session. Estimated 1-2 hours focused work to mint 38 stub JSON files + run `finding-registry add` for each + verify chain integrity via `finding-registry verify`. The renumbering vs. accept-collision question is itself an architectural decision the next session should make explicitly.

**Linked plan:** ultra-plan ARC-009 + meta-tracking discipline. The orphan-findings doc + the finding-registry are TWO TRACKERS that should agree; this session's work was added to the orphan-findings doc but not to the registry — the divergence is the orphan.

---


## ORPHAN-MEDIUM-025 — `commit-msg-validator.ts` does not cross-check `Closes:` trailer IDs against finding-registry; format-only check leaks dangling pointers (2026-04-25)

**Status:** RESOLVED in Batch #285 (2026-04-25, registry entry ULTRA-MEDIUM-026).

**Resolution narrative:**

When implementing the proposed fix in Batch #285, source inspection of `tools/gates/commit-msg-validator.ts` revealed a different architectural shape than this finding's original "no registry-existence check" claim:

- **Line 223 of the validator ALREADY contains the registry-existence check** (`if (!registryIds.has(findingId)) { ... }`).
- **The actual root cause** of ORPHAN-HIGH-024's 38-batch dangling pattern was that `REQUIRE_CLOSES_TYPES` regex `/^(fix|security|refactor\(agentic,phase-)/` did NOT match `feat()` subjects. Every dangling commit was `feat(edge,...): Batch #NNN — ...` shape, so the validator's `needsCloses` flag was `false` for those commits — the registry-existence check was bypassed entirely because the gate didn't even look for trailers.

The architectural fix delivered in Batch #285:

```text
Before: const REQUIRE_CLOSES_TYPES = /^(fix|security|refactor\(agentic,phase-)/;
After:  const REQUIRE_CLOSES_TYPES = /^(fix|security|refactor\(agentic,phase-|feat)/;
```

Every architectural change in this codebase (whether bug-fix, security hardening, refactor, or new feature) is now traced to a finding in the registry — the regex was historically narrow, Batch #285 widens it to match the universal `Review Finding Traceability` discipline (CLAUDE.md MANDATORY).

**Original finding text (preserved for history; the OPEN claim was partially incorrect about the validator's behavior — see RESOLUTION above for the actual root cause):**

**Scope:** `tools/gates/commit-msg-validator.ts` — the pre-commit / commit-msg gate validates the `Closes:` trailer's REGEX FORMAT (`{PREFIX}-{SEVERITY}-{NNN}`) but does NOT validate that the cited ID EXISTS in `docs/reviews/_registry/findings.jsonl`. This is the root cause of ORPHAN-HIGH-024's 38-batch dangling-trailer pattern: every trailer matched the regex, every commit landed, but 38 IDs pointed to registry rows that didn't exist.

**Symptom (gate effectiveness):** The gate's stated purpose (per CLAUDE.md "Review Finding Traceability (MANDATORY)") is to enforce that "Every fix commit must formally reference the review finding it closes." The current implementation enforces only the FORMAT of the reference, not the EXISTENCE — a spelling-correctness check, not a referential-integrity check. Trailers can cite phantom IDs indefinitely without gate intervention.

**Symptom (audit pipeline):** Operators running registry-driven audit queries (`finding-registry list --state OPEN`, `finding-registry list --owner okan`, etc.) get incomplete state because dangling trailers' "Closes" don't actually close any registry row. The pipeline silently misses architectural progress.

**Architectural fix:**

The `commit-msg-validator.ts` gate should add a registry-existence check after the format check:

```typescript
// Pseudocode for the new gate step
const registry = loadRegistry(); // existing helper from finding-registry.ts
const ids_in_registry = new Set(registry.map(e => e.id));
for (const id of citedClosesIds) {
  if (!ids_in_registry.has(id)) {
    console.error(`Closes trailer cites unknown ID: ${id} (not in findings.jsonl)`);
    process.exit(1);
  }
}
```

The check is O(N) on registry size + O(M) on trailer count per commit; both bounded by reasonable caps (registry ~hundreds; trailers per commit ~1-5). Negligible overhead on the commit-msg path.

**Severity: MEDIUM** — gate-discipline gap; not a security or correctness gap. Architecturally significant because the gate's documented purpose is referential integrity but the implementation only enforces format. The gap was hidden until ORPHAN-HIGH-024 surfaced 38 cumulative violations.

**Discovered by:** Batch #283 commit message draft naming the gate-tightening recommendation. Promoted to OPEN finding so the gap is auditable + future commit-msg validator improvement work has a concrete tracking target.

**Fix target:** dedicated commit-msg-validator gate-hardening batch. Estimated 1 batch (gate code + unit test against canned good-trailer + bad-trailer fixtures + integration test against current registry).

**Linked plan:** Plan §3.1 ARC-009 review-finding traceability discipline + ORPHAN-HIGH-024 (the 38-batch dangling pattern this gate would have caught).

---


## ORPHAN-HIGH-027 — Ultra-plan A-2b step 5b spec ("address-space populate per-tag VariableNode") is architecturally wrong-shape vs canonical async-opcua NodeManager pattern (2026-04-25)

**Status:** OPEN at filing time → re-spec landed in Batch #288 (registry entry ULTRA-HIGH-040 RESOLVED).

**Scope:** `docs/reviews/_registry/findings.jsonl` ULTRA-HIGH-039 `notes` field + the historical ultra-plan A-2b step 5 sub-step taxonomy.

**Pre-Batch-#288 spec (wrong-shape):** ULTRA-HIGH-039's `notes` enumerated the remaining A-2b part 5 sub-steps as:

```text
5b (SensNodeManager.init() address-space populate per-tag VariableNode)
5c (opc_ua_server_runtime.rs:259 simple_node_manager → with_node_manager swap)
5d (with_authenticator(SensAuthManager) wire)
5e (add_write_callback loop DELETE)
5f (execute_opcua_write actor: &str → &AuthenticatedUser refactor)
```

The 5b wording assumed that completing the SensNodeManager runtime swap requires a per-tag VariableNode population step against `DefaultTypeTree` (or against an internal AddressSpace). This is architecturally incorrect for the chosen NodeManager pattern.

**Architectural fact (discovered via async-opcua source-of-truth read):**

In async-opcua 0.18, `DefaultTypeTree` stores ONLY type-definitions (ObjectTypes, VariableTypes — the metaclasses of the OPC UA type system). Variable INSTANCE nodes (the actual data nodes that HMIs read) are NEVER stored in DefaultTypeTree. There are exactly two canonical patterns for a NodeManager to expose instance nodes:

1. **In-memory AddressSpace pattern (SimpleNodeManager / InMemoryNodeManager):** the NodeManager owns a `RwLock<AddressSpace>`; nodes get `address_space.add_folder(...)` / `address_space.insert(...)` calls at boot; the trait's default browse/read service implementations look nodes up by NodeId. Trade-off: rigid (every node must exist before service calls) + per-node read/write callbacks LOSE `RequestContext` (the entire reason A-2b chose to abandon this pattern in Batch #225+).

2. **Virtual nodes / dynamic resolution pattern (DiagnosticsNodeManager):** the NodeManager registers ONLY the namespace + carries no per-node storage; the trait methods `browse()` / `read()` / `write()` resolve the node FROM the NodeId at request time (via opaque NodeId encoding + per-namespace ownership filter). Trade-off: requires explicit per-method implementations; benefits include `RequestContext` access on every call (load-bearing for A-2b's session-aware authz gate) + zero state duplication between `tag_registry` (catalog) and address-space (which would also be a catalog).

**SensNodeManager already chose pattern (2)** — Batch #263 skeleton + Batch #264 (read) + Batch #265 (write) all resolve nodes from the incoming `NodeId.identifier` against `OpcUaTagRegistry.find_by_browse_name(...)`. The catalog IS the address-space; populating an additional in-memory AddressSpace would create a second catalog that drifts from the first.

**Therefore the original step 5b spec was internally inconsistent with the architectural choice of step 5a:** step 5a registered the namespace via `type_tree.namespaces_mut().add_namespace(...)` (canonical to pattern 2); step 5b's "address-space populate" assumed pattern 1's storage model. Either step 5a needed to be different (lock the type_tree and call address_space.insert), OR step 5b needed to be different (implement browse() per the canonical pattern-2 path). Step 5a is correct + canonical; step 5b is the side that needs re-specification.

**Architectural re-spec (Batch #288):**

```text
5b (was): SensNodeManager.init() address-space populate per-tag VariableNode
5b (now): SensNodeManager.browse() trait method implementation per canonical
          DiagnosticsNodeManager pattern — virtual node resolution covering
          the 4 entry points HMIs use:
          (a) Browse from ObjectsFolder → add HasComponent ref to Suderra root
          (b) Browse from Suderra root → add HasComponent ref to Tags folder
          (c) Browse from Tags folder → add HasComponent ref per tag in registry
          (d) Browse from a tag node → add HasTypeDefinition ref to BaseDataVariableType
              + Inverse HasComponent ref back to Tags
```

The remaining sub-steps 5c / 5d / 5e / 5f are unaffected — they correctly target opc_ua_server_runtime.rs wiring + execute_opcua_write signature. Only step 5b's verb (`populate` → `implement browse`) and target (`type_tree` → trait method override) change.

**Severity: HIGH** — without the architectural correction, completing 5b per the original wording would have either:
(a) Forced a SensNodeManager refactor to pattern 1, throwing away Batches #263-#266's pattern 2 commitments (months of work re-architected for an internally inconsistent spec).
(b) Surfaced a compilation error at first attempt (DefaultTypeTree has no `add_variable_node` method) and triggered a session-blocking architectural re-derivation under user-facing time pressure.

**Discovered by:** Batch #288 implementation prep — read of `async-opcua-server-0.18.0/src/diagnostics/node_manager.rs` revealed the canonical pattern-2 shape; cross-checked against `async-opcua-nodes-0.18.0/src/type_tree.rs` (DefaultTypeTree only exposes `add_type_node` / `add_namespace` / `add_type_property`, no instance-node API).

**Fix target:** Batch #288 (this batch) implements browse() trait method per re-spec. Subsequent batches (5c-5f) proceed unchanged.

**Linked plan:** Ultra-plan §A-2b part 5 sub-step taxonomy. Linked findings: ULTRA-HIGH-039 RESOLVED (5a namespace registration), ULTRA-HIGH-035 PARTIAL_FIX (overall A-2b part 5), ORPHAN-CRITICAL-021 (anonymous-actor hardcode — closed by 5c+5f wiring), ORPHAN-MEDIUM-023 (Allow-path skips delegate — closed by 5f).

**Architectural lesson:** When a multi-step plan is written, every step's choices must be internally consistent with every other step's. Step 5a's choice (namespace registration via DefaultTypeTree) IMPLIED pattern 2 commitment; step 5b should have followed the implication forward. Future ultra-plan steps should cite the canonical-pattern source explicitly (e.g., "5b: implement per DiagnosticsNodeManager.browse pattern at `async-opcua-server-0.18.0/src/diagnostics/node_manager.rs:619-667`") so a later reader can re-derive the full architectural trajectory from the spec alone.

---


## ORPHAN-LOW-028 — `sens-api-gateway/src/main.rs.disabled-test` is a 37-byte dead stub referencing a module that does not exist (2026-04-27)

**Discovered by:** Batch #307 in-flight environment scan (Faz 6 force_value two-person integrity gate session). The file appears in `git status` as an `??` untracked entry — predates this session (`stat` mtime `Apr 23 18:12`).

**File contents (full):**

```rust
mod opc_ua_type_debug; // diagnostic
```

**Why this is a hygiene problem (not a correctness problem):**

- The file name `main.rs.disabled-test` is a non-standard convention: it is neither a Rust source (`*.rs`), a doc fixture (`tests/...`), nor a documented "renamed" file. The `.disabled-test` suffix suggests a developer wanted to gate a debug-only module without the cargo build picking it up, but the chosen mechanism is a manual filename rename rather than a Rust-native gate (`#[cfg(feature = "opcua-type-debug")]` or `#[cfg(test)]`).
- The referenced module `opc_ua_type_debug` does not exist anywhere in the workspace (verified via `grep -rn opc_ua_type_debug --include="*.rs"`). So even if the file were renamed back to `main.rs` and included via `mod`, the build would fail.
- Untracked files in a long-running git checkout drift over time and pollute every fresh `git status` invocation, increasing the surface area for accidental commits via `git add -A`.

**Architectural fix (single tier 1 candidate):**

- Tier 1 (make it impossible) — DELETE the stub entirely. If a future developer needs an OPC UA type-introspection diagnostic, the canonical shape is a `#[cfg(feature = "opcua-type-debug")]`-gated module under `src/opc_ua/`, not a quarantine file outside the build graph. This finding documents the intent to delete; deletion is itself a 1-byte change in a future hygiene batch and does not need to block any plan-aligned arc.

**Severity: LOW** — repo hygiene only. No correctness, security, or test-coverage implication. Documented per user policy: *gördüğüm hiçbir problemi senin ilgili olmasa bile not al*.

**Status:** OPEN. Slated for the next no-arc hygiene batch (no firm deadline; trigger-based rather than time-based — fold into the next session that already touches `sens-api-gateway/src/` for an unrelated reason).

**Linked plan:** none (out-of-band of every active arc).


## 2026-04-23 NX-CONVENTION-001 — Nx generator scaffolding duplication is intentional (pre-empt future jscpd noise)

**Status:** DOCUMENT-ONLY — this is a classification rule for future audits, not a bug.

**Scope:** `apps/*/tsconfig.build.json`, `apps/*/jest.config.ts`, per-project lint/test config files created by Nx generators.

**Observation (2026-04-22 cold audit):**

jscpd reported per-service `tsconfig.build.json` as a duplicate cluster (e.g. `apps/admin-api-service/tsconfig.build.json` ≡ `apps/sensor-service/tsconfig.build.json`, ~64 lines). Similar overlap for `jest.config.ts`. Over 17 services this accounts for >1000 lines of "duplication" that would inflate any code-smell metric.

**Why this is not a finding:**

These files are generated by Nx workspace generators (`nx generate @nx/nest:app <svc>` and friends). The template is uniform by design — every service gets the same build/test bootstrap so Nx cache keys are stable across projects. Deviating from the template requires a documented override in `nx.json` `targetDefaults` or a per-project override in that service's `project.json`. Extracting the template content to a shared file (e.g. via `"extends"`) is explicitly NOT how Nx wants this — the generators re-emit the full config on regeneration, so an extends-chain would drift the moment a scaffolded service is re-generated.

**Classification rule for future audits:**

jscpd clusters where EVERY participating file is one of:
- `tsconfig.build.json` with only `extends` + `compilerOptions.outDir` differing
- `jest.config.ts` with only `displayName` + `coverageDirectory` differing
- `project.json` Nx target definitions sharing the same `executor` with only `options.projectName` differing

…are classified **NX-INTRINSIC DUPLICATION** and SHOULD NOT be raised as extraction candidates. Future audit cycles (and the `02-jscpd-clusters.md` artifact generator) must filter them out.

**Closure:**

This orphan entry is the architectural tier-4 "document" fallback for `AUDIT-LOW-001` from the 2026-04-22 cold audit. The audit-tool `tools/audit/aggregate-hotspots.ts` does NOT currently filter these — a follow-up improvement (not tracked as a separate finding because the noise is informational only) would add an ignore glob.

**Follow-on tracking:**
- Owner: orchestrator.
- No deadline — this is an informational classification, not an actionable fix.
- Closure path: commit that adds this note carries `Closes: docs/reviews/_audit/2026-04-22-cold-audit/03-explore-findings.md#AUDIT-LOW-001`.


## 2026-04-23 MONITOR-HOTSPOT-001 — churn-only findings archived until next audit cycle

**Status:** DOCUMENT-ONLY. Closes `AUDIT-MEDIUM-001`, `AUDIT-MEDIUM-004`, `AUDIT-MEDIUM-010` as Tier-4 monitor markers.

**Scope:** Three 2026-04-22 cold-audit findings that surfaced as hotspot-score signals (high commit frequency + large surface area) but do not carry a structural defect claim:

- `AUDIT-MEDIUM-001` — `web/modules/sensor-module` (319 pts): automation editor, SCADA builder, package-builder pages.
- `AUDIT-MEDIUM-004` — `apps/hr-service` (225 pts): `app.module.ts` + `employee.entity.ts` + `hr.resolver.ts` churn.
- `AUDIT-MEDIUM-010` — `web/modules/tenant-admin` (86 pts): TenantDashboard / TenantUsers / TenantSettings pages.

**Why Tier-4 document is the correct tier:**

Churn is a leading indicator, not a defect. All three surfaces are actively under feature development in this cycle per `git log --since="3 months ago" --name-only`. No ADR violation, no tenant-isolation bypass, no schema drift, no lint-rule violation attaches to these files — only high edit frequency.

Applying Tier 1–3 (make-impossible / make-automatic / make-detectable) would mean freezing the surfaces or adding artificial rate-limits on commit frequency. That is over-correction; active feature development SHOULD produce churn hotspots.

**Escalation rule (the Tier-3 half of this entry):**

The next cold-audit cycle (2026-06 or earlier on a triggered audit) inspects these three surfaces AGAIN. If ANY of them shows:
- churn *and* a correlated failing e2e test suite, OR
- churn *and* a spike in open AUDIT-* findings on the same files, OR
- churn *and* a rise in lint-warning count for the service,

the relevant MEDIUM-NNN escalates to a HIGH-severity finding with the specific defect class it correlates with. The MONITOR classification is automatic — no human-review handoff needed — because the audit tooling (`tools/audit/aggregate-hotspots.ts`) can compute the correlation deterministically.

**Follow-on tracking:**
- Owner: orchestrator.
- Deadline: next cold-audit cycle (tracked by the audit tooling itself, not a date).
- Closure path: commit that adds this note carries `Closes: docs/reviews/_audit/2026-04-22-cold-audit/03-explore-findings.md#AUDIT-MEDIUM-001` + `#AUDIT-MEDIUM-004` + `#AUDIT-MEDIUM-010` trailers on separate lines.


## 2026-04-23 ORPHAN-DIC-001 — parent-scoped child entities have no `tenantId` column (cross-service architectural class)

**Status:** OPEN — surfaced during the Phase B.3 cold-audit remediation while trying to migrate `manager.getRepository(Entity)` calls to `tenantManagerRepo()`. Architectural class is cross-service (sensor-service was the first instance; PR #159's audit surfaced billing-service `SubscriptionModuleItem` as a second instance of the same class).

**Scope (now 4+ entities across 2 services):**

sensor-service:
1. `apps/sensor-service/src/edge-device/entities/device-io-config.entity.ts` — reachable only via parent `EdgeDevice`.
2. `apps/sensor-service/src/automation/entities/program-variable.entity.ts` — reachable only via parent `AutomationProgram`.

billing-service (added 2026-04-27 during PR #159 audit):
3. `apps/billing-service/src/billing/entities/subscription-module-item.entity.ts` — reachable only via parent `Subscription` (scoped by `subscriptionId` FK).

(implicit) Any future child entity in any service that follows the same parent-scoped pattern. The architectural class is "child entity reachable only via parent FK; tenantId is inherited via JOIN, not stored locally."

None of these declare a `@Column` for `tenantId`. Rows are reachable only via the parent relationship, whose row does carry `tenantId`.

**Why the entity can't be wrapped by `tenantManagerRepo()`:**

The scoped repo auto-injects `{ ..., tenantId }` into every save / update / create / delete. DeviceIoConfig has no `tenantId` column → the INSERT would fail at runtime with a `column "tenantId" does not exist` Postgres error. Wrapping with `tenantManagerRepo()` is therefore *structurally incorrect* until the column exists.

**Current state:**

`bulkAddIoConfigs()` in `edge-device.service.ts` still calls `manager.getRepository(DeviceIoConfig)` directly, with an `// eslint-disable-next-line no-restricted-syntax -- ORPHAN-DIC-001` comment pointing at this entry.

**The architectural question:**

Should `DeviceIoConfig` gain a `tenantId` column?

- **Pro:** explicit tenant scoping at every repository call; no reliance on parent-row traversal; RLS policies would work without JOINs; matches the pattern every other sensor-service entity follows.
- **Con:** denormalizes the tenantId (stored twice — on EdgeDevice and again on each of its DeviceIoConfig rows). Adds a migration touching every live DeviceIoConfig row. Adds an index-maintenance cost.

**Closure path:**

A follow-up PR that lands the `tenantId` column migration + entity update can delete the eslint-disable comment in `bulkAddIoConfigs` AND rewrite the line to `tenantManagerRepo(manager, DeviceIoConfig, tenantId)`, carrying `Closes: docs/reviews/orphan-findings.md#ORPHAN-DIC-001`.

Until then this ORPHAN documents why the getRepository rule has a single sensor-service exception with a traceable reference — an architectural acknowledgement, not a patch.


## 2026-04-23 ORPHAN-DOCS-001 — Untracked top-level `CONTRIBUTING.md` + `SECURITY.md` in working tree

**Status:** OPEN — surfaced during the SEC-REVIEW-003 invariant landing on `cold-audit/pr-8-security-hardening`.

**Scope:**
- `/var/aqua-saas/CONTRIBUTING.md` — 6070 bytes, Apr 25 timestamp, untracked.
- `/var/aqua-saas/SECURITY.md` — 3120 bytes, Apr 25 timestamp, untracked.

**Observation:**

`git log --all --source --remotes -- CONTRIBUTING.md SECURITY.md` returns empty across every branch. The two files exist locally but have never been committed on any remote ref. Their content is well-formed:
- `CONTRIBUTING.md` references CLAUDE.md as the platform invariant playbook, walks through the trunk-based dev model + commit format + finding traceability rules.
- `SECURITY.md` documents an ISO/IEC 30111 + 29147 vulnerability handling policy, with a `security@suderra.example` placeholder address that must be replaced before external publication.

**Why this is plan-independent:**

These files were created out-of-band by a prior session (likely a docs-pass agent) and never staged. They block no work — `git status` simply shows them as untracked indefinitely. The risk is that someone runs `git add -A` and silently commits them into an unrelated PR, or that they drift further from the CLAUDE.md they reference until they become misleading.

**Closure path (architecturally clean — separate PR):**

1. Decide on the `security@suderra.example` placeholder. The `SECURITY.md` itself flags the placeholder for replacement; mint an actual PSIRT alias before the file goes public.
2. Open a docs-only PR: `docs(community): add CONTRIBUTING.md + SECURITY.md` carrying both files unchanged from the working-tree copies (they are well-aligned with CLAUDE.md already).
3. Reference this entry in the commit body: `Closes: docs/reviews/orphan-findings.md#ORPHAN-DOCS-001`.

Until then they remain untracked but **not destroyed** — relocating untracked files out of the worktree without explicit user authorization is forbidden by sandbox policy and would lose the prior session's draft. The files survive in `/var/aqua-saas/` until the docs PR lands.


## 2026-04-23 ORPHAN-TEST-INFRA-001 — `ts-jest` `isolatedModules` deprecation warning chronic in invariants suite

**Status:** OPEN — informational; does not break any test, but every invariants invocation prints the same warning.

**Scope:** `tests/invariants/jest.config.ts` + `tests/invariants/tsconfig.spec.json`.

**Observation:**

Every `npx jest --config tests/invariants/jest.config.ts ...` invocation begins with:

```
ts-jest[config] (WARN)
    The "ts-jest" config option "isolatedModules" is deprecated and will be
    removed in v30.0.0. Please use "isolatedModules: true" in
    /var/aqua-saas/tests/invariants/tsconfig.spec.json instead, see
    https://www.typescriptlang.org/tsconfig/#isolatedModules
```

The warning is correct: `isolatedModules: true` lives in the ts-jest transformer config (`jest.config.ts:73`) where ts-jest no longer wants it; the upstream-recommended location is the spec `tsconfig.json`. The current config still works, but each warning costs cognitive overhead and the upgrade to ts-jest v30 will hard-fail.

**Why this is plan-independent:**

Pre-existing on `main` since the invariants suite was first sharded (Phase 14.3 — see `tests/invariants/jest.config.ts:11-54` rationale block). Independent of any current planned work.

**Closure path:**

Single-line, mechanical fix:
1. Add `"isolatedModules": true` to `tests/invariants/tsconfig.spec.json` `compilerOptions`.
2. Remove `isolatedModules: true` from the ts-jest `transform` block in `jest.config.ts:73`.
3. Re-run `invariants:fast`; the warning disappears and behaviour is byte-identical.

Carry `Closes: docs/reviews/orphan-findings.md#ORPHAN-TEST-INFRA-001` on the commit.


## 2026-04-23 ORPHAN-CI-PROVISIONING-001 — PR #158 UNSTABLE blocked on Nx Cloud token provisioning + cache substrate

**Status:** OPEN — meta-finding for the campaign maintainer.

**Scope:** GitHub repo settings (secrets) + `.github/workflows/ci-full.yml` cache namespace + Nx Cloud account.

**Observation:**

PR #158 ("Lossless main refresh: 13 PRs (4 CI fix + 9 dependabot bumps)") is `MERGEABLE` per `git merge-tree` but `mergeStateStatus: UNSTABLE` per the GH API: `lint`, `type-check`, `test`, `build` are all FAILURE while every other gate (banned-phrase, schema-validation, dependency-review, cargo-deny, cargo-audit, secrets scan, k6 benchmark) is SUCCESS.

The four failing checks are the same 35-min cold-cache timeout class that AUDIT-CRITICAL-002 named on 2026-04-22. The architectural fix exists in three forms inside PR #158 itself:
- `9323a6f1` — `nx.json` templating fix (removes `nxCloudAccessToken: ${NX_CLOUD_ACCESS_TOKEN}` which Nx does not interpolate).
- `ed851d3f` — cache namespace unification (`nx-full-` → `nx-ci-` plus a missing 4th `Cache Nx` step in the test job).
- `bdefb510` — `main-deletion-witness` gate (silent-regression detector — orthogonal to the timeout class but part of the same campaign).

The remaining piece is **manual** and cannot be performed by an agent: provisioning the `NX_CLOUD_ACCESS_TOKEN` GitHub secret per ADR-030 §5 (5-step browser runbook). Once the secret is set + PR #158 lands, the cold-cache window collapses to ~3-5 min and PR #159 (this campaign's consolidation) inherits the green substrate.

**Why this is plan-independent:**

This entry exists to prevent the campaign from getting stuck in a recursive "PR #159 fails CI → reopen PR #158 → still fails CI" loop. The blocker is human-in-the-loop, not architectural.

**Closure path:**

1. Maintainer follows ADR-030 §5: nx.app sign-in → Connect existing repo → copy access token → GitHub repo Settings → Actions → New repository secret named `NX_CLOUD_ACCESS_TOKEN`.
2. Re-run PR #158 CI; expect green.
3. Squash-merge PR #158.
4. Re-run PR #159 CI on top of the new main; expect green.
5. Squash-merge PR #159.
6. Carry `Closes: docs/reviews/orphan-findings.md#ORPHAN-CI-PROVISIONING-001` on the squash-merge commit message of PR #158 (closes the meta-finding when the substrate is in place; the cold-audit content closure happens on PR #159's merge).


## 2026-04-23 ORPHAN-CAMPAIGN-LIFECYCLE-001 — Cold-audit train (PRs #121-#130) closed-then-reopened pattern

**Status:** RESOLVED — documents the lifecycle transition on this branch's commits, no further action.

**Scope:** PRs #121, #122, #123, #124, #125, #126, #127, #130 (cold-audit train) and PR #159 (consolidation landing).

**Observation:**

The cold-audit campaign was originally landed as 8 stacked PRs (`#121` through `#130`, with `#128/#129` skipped by gh numbering quirk). All 8 carried `state: CLOSED, mergedAt: null` after a parallel "Lossless main refresh" PR (#158) absorbed the 4 CI-fix branches into a single integration branch via `--no-ff` merges. The cold-audit train was preserved on `claude/cold-audit-pr-130-isolated` because:

> `findings.jsonl` hash-chain conflict requires registry rebuild before merge; train is preserved verbatim for separate landing
> — PR #158 body, "NOT included" table

The PR #158 body explicitly identifies the cold-audit train as deferred-to-later, not abandoned. PR #159 is the deferred landing — same content as `claude/cold-audit-pr-130-isolated` plus the SEC-REVIEW-003 invariant (commit `1ff67716`) added during the 2026-04-23 follow-up session.

**Why this is plan-independent:**

The closed-then-reopened pattern is a structural artefact of two parallel agent sessions resolving the same backlog with different strategies. Documenting the lifecycle here prevents future archaeology.

**Closure path:**

This entry serves as the historical record. No action needed once PR #159 merges.


## 2026-04-23 ORPHAN-SEC-007-COVERAGE-001 — SEC-REVIEW-007 6-Playwright-test recommendation: already covered by existing 6-layer defence

**Status:** RESOLVED — coverage analysis below. No additional E2E tests warranted.

**Scope:** SEC-REVIEW-007 (post-cold-audit security review of the tenantManagerRepo wrapper contract). The original review recommended adding 6 Playwright E2E tests covering tenant-leak-on-write paths; PR #159's commit `b1e425c4` delivered only the unit-level factory contract.

**Why no additional E2E tests are needed:**

The architectural surface SEC-REVIEW-007 names (handler accepts an arbitrary `tenantId` in body / header → wrapper writes a row with the wrong tenant) is already covered by SIX independent detection layers, each catching a different failure mode:

| # | Layer | Defends against |
|---|-------|-----------------|
| 1 | ESLint `no-restricted-syntax` rule (`.eslintrc.json:101-128`) | direct `.getRepository(` at compile-time, on every changed file |
| 2 | `no-direct-getrepository-call.spec.ts` invariant (PR #159) | direct `.getRepository(` at PR-time, on every file (bypasses Nx affected scope) |
| 3 | `eslint-disable-annotation-positional-binding.spec.ts` invariant (SEC-REVIEW-003) | drifted / orphaned annotations that no longer bind to a real callsite |
| 4 | `tenant-scoped-repository.spec.ts` unit contract tests (SEC-REVIEW-007 unit, in commit `b1e425c4`) | regression of the wrapper's `tenantId` auto-injection logic |
| 5 | 4 Playwright tests at `e2e/tests/security/tenant-isolation.spec.ts` (already on `main`) | gateway-level X-Tenant-Id spoofing + cross-tenant query rejection |
| 6 | 6 integration-level tests at `e2e/tests/integration/data-isolation-chain.spec.ts` (already on `main`) | end-to-end write-then-read cross-tenant invisibility |

**The proposed 6th-set of Playwright tests would have covered:**

- "Authenticate as Tenant A; POST a body with `tenantId: <Tenant-B's-id>`; assert the row lands under Tenant A's scope, not B's."

**Why that scenario is already moot:**

The mismatch case is structurally rejected at the gateway layer (Layer 5 test 4: "Invalid tenant ID format in X-Tenant-Id header is rejected" + JWT-vs-header reconciliation in `TenantContextMiddleware`). The `tenantManagerRepo` wrapper itself reads tenantId from AsyncLocalStorage (set by the gateway middleware), not from the request body. Layer 4's unit contract proves the wrapper IGNORES any `tenantId` value in the entity payload and OVERRIDES it with the AsyncLocalStorage-resolved value.

The 6 originally-recommended Playwright tests would re-verify what Layer 5 + Layer 4 already prove — strict redundancy, not additional coverage.

**Closure path:**

This entry serves as the architectural decision record. Future reviewers asking "why didn't we add the 6 E2E tests SEC-REVIEW-007 recommended?" find this entry and the layer table here.

The recommendation is closed-without-implementation because re-running the same assertion through a slower test surface adds latency to CI without adding signal. Re-opening this finding would require a NEW failure class that none of layers 1-6 catch.


## 2026-04-27 ORPHAN-LINT-SCOPE-002 — `no-restricted-imports` (root-barrel ban) shares the same affected-vs-all CI gap as `no-restricted-syntax`

**Status:** RESOLVED — closed in PR #159 by `tests/invariants/no-root-barrel-import.spec.ts` + 14-file root-barrel cleanup (commits `fce98510` + auth-service `user-lifecycle.service.ts` split). Same architectural class as ORPHAN-CI-PROVISIONING-001 / AUDIT-MEDIUM-014, scoped to a different ESLint rule.

**Scope:** `.eslintrc.json:86-99` (`no-restricted-imports` rule banning `@aquaculture/backend-common` + `@platform/backend-common` root paths). 13 unmigrated files surfaced in PR #159 commit `fce98510` were the visible symptom; the invisible class is "any future commit can re-introduce the root-path import without ci-affected catching it."

**Why this is plan-independent:**

The AUDIT-MEDIUM-005 codemod (`810eae97`) migrated then-existing root-barrel users into per-subtree imports + added the lint rule. CI's `nx affected -t lint` only ran on projects whose dependency graph the diff touched, so 13 unmigrated files outside that scope were missed. The 2026-04-27 cleanup commit fixed the 13 files but did NOT add a Tier-3 detector that would have caught them at PR-time.

**Architectural fix (Tier-3 invariant — mirrors the no-direct-getrepository pattern):**

Add `tests/invariants/no-root-barrel-import.spec.ts` that walks every tracked .ts file via `git ls-files` and asserts no `import ... from '@aquaculture/backend-common'` (root) AND no `import ... from '@platform/backend-common'` (root) appears. The exemption set is the per-subtree `/<name>` form (`/database`, `/auth`, `/audit`, etc.).

The pattern mirrors `no-direct-getrepository-call.spec.ts` exactly:
- Walks tracked source via `git ls-files`
- Skips test/__tests__/__mocks__/migrations
- Runs in `invariants:fast` (the always-on PR gate per AUDIT-CRITICAL-003)
- Bypasses Nx affected scope entirely

**Closure (same PR, no follow-up):**

The invariant + cleanup landed together in PR #159:

1. `fce98510` — migrated 13 root-barrel imports across farm-service / billing-service / sensor-service.
2. (auth-service follow-up edit) — `user-lifecycle.service.ts` split its 3-symbol root import into per-subtree `/database` (SchemaManagerService + tenantManagerRepo) + `/decorators` (Role enum).
3. `tests/invariants/no-root-barrel-import.spec.ts` (Tier-3 detector) — walks tracked .ts/.tsx via git ls-files, asserts no bare `from '@aquaculture/backend-common'` or `from '@platform/backend-common'` outside test paths. Wired into layer-1 `invariants:fast` shard so the always-on gate catches future drift.

Smoke-tested: invariant FAILED on the auth-service file before the split, PASSED once split. Layer-1 went 102 → 103 tests; no regression.

**Why a parallel-pattern detector matters:**

The `nx affected -t lint` scope class will keep producing instances of "rule fires correctly on a clean PR but silently accumulates violations in unrelated services." Each orphan we surface (AUDIT-MEDIUM-014 for `no-restricted-syntax`, this entry for `no-restricted-imports`) is one more case where the always-on invariants:fast shard catches what affected-lint misses. Until the platform either (a) provisions Nx Cloud + flips ci-affected to ci-all on every PR, OR (b) builds an invariants-shard equivalent for every gating ESLint rule, this class will keep producing surface area.


## 2026-04-23 ORPHAN-COMMIT-TRAILER-001 — `SEC-REVIEW-NNN` IDs not registrable; `Closes:` trailers are decorative on `test()` subjects

**Status:** OPEN — informational; documents an existing pattern, no action required.

**Scope:** `docs/reviews/_registry/findings.jsonl.schema.json` + 3 commits using SEC-REVIEW-NNN identifiers (`6f5450a5`, `b1e425c4`, `1ff67716`, `69abfdfb`).

**Observation:**

The registry schema's `id` pattern admits prefixes `DATA|SEC|PLAT|FE|EDGE|MT|FARM|SENSOR|HR|MSG|ADMIN|...` — i.e., `SEC-` is allowed but **`SEC-REVIEW-`** is not. The format strictly enforces `^{PREFIX}-{CRITICAL|HIGH|MEDIUM|LOW|CVE}-NNN$`, so `SEC-REVIEW-003` cannot be a registry entry without first registering `REVIEW` as an additional severity classifier (it is not).

Three campaign commits (`6f5450a5`, `b1e425c4`, `1ff67716`) use SEC-REVIEW-NNN identifiers as informal labels for findings raised during the **post-cold-audit security review** of the campaign itself. These IDs appear in commit subjects, in inline rationale comments next to `eslint-disable-next-line` directives, and in test-name strings — but they are NOT registry entries. The commit-msg-validator only enforces `Closes:` trailers on `^(fix|security|refactor\(agentic,phase-)` subjects, so the `test(invariants):` and `test(security):` subjects on these commits pass even though their trailers reference non-registry IDs.

**Why this is plan-independent:**

The pattern works for the campaign — SEC-REVIEW IDs are traceable via grep across commits + comments + tests. But future tooling (e.g. `findings:list --include-informal-ids`) cannot surface them because no central index exists. The dangling `Closes: ...#SEC-REVIEW-NNN` trailers are decorative metadata, not registry-enforced traceability.

**Closure path (Tier-3 make-detectable, NOT urgent):**

Two architectural options, neither required for current PR landing:

1. **Extend the schema**: add `REVIEW` to the severity-classifier enum so `SEC-REVIEW-NNN` becomes a valid registry id. Pro: heals dangling trailers retroactively. Con: dilutes the severity field's semantics (REVIEW is not a severity).
2. **Index file alongside the registry**: `docs/reviews/_registry/sec-review-index.md` with one markdown anchor per SEC-REVIEW-NNN. Pro: keeps the registry's severity invariants intact; trailers become resolvable. Con: requires a new gate to prevent drift between commits + the index.

Until either is done, this orphan entry is the canonical record of the pattern's known limits.


---

## ORPHAN-EVENT-CONTRACT-001..018 — 20 createBaseEvent emits without interface (2026-04-28)

**Status:** OPEN — discovered during W0.E (event-contract type integrity) work; allowlisted in `tests/invariants/event-contract-emit-has-interface.spec.ts` until the matching domain audit cycle lands the missing interfaces.

**Scope:** `apps/messaging-service/` + `apps/sensor-service/automation/`

**Discovery:** The new invariant test `event-contract-emit-has-interface.spec.ts` (added in W0.E to enforce DATA-HIGH-002 / DATA-HIGH-004 / COMPLIANCE-CRITICAL-003 / CONTRACT-CRITICAL-002 closures) walks every `createBaseEvent('<EventType>', …)` call site and asserts a matching `<EventType>Event` interface exists in `libs/event-contracts/src/`. The walk surfaced 20 eventType literals that have NO interface anywhere in the contracts library — a producer-side field bump on any of these would not surface as a consumer compile break, inviting the same silent-consumer-crash regression class the audit captured for `SubscriptionPastDue`.

**The 20 orphan eventTypes (messaging + sensor automation):**

| EventType | Domain | Emitted from |
|-----------|--------|--------------|
| `ChannelCreated`, `ChannelUpdated`, `ChannelArchived`, `ChannelMemberAdded`, `ChannelMemberRemoved` | messaging | `apps/messaging-service/src/channel/...` |
| `MessageUpdated`, `MessageDeleted`, `MessagePinned`, `MessageUnpinned`, `MessageForwarded`, `ReactionAdded`, `ReactionRemoved` | messaging | `apps/messaging-service/src/message/...` |
| `RetentionPolicyChanged`, `LegalHoldToggled` | messaging compliance | `apps/messaging-service/src/compliance/...` |
| `SentimentAlert`, `StorageWarning` | messaging | `apps/messaging-service/src/message/services/...` |
| `AutomationProgramSaved`, `AutomationProgramDeployed`, `AutomationTagsUpdated`, `AutomationFBDefinitionsChanged` | sensor automation | `apps/sensor-service/src/automation/events/automation-events.publisher.ts` |

**Why plan-independent:**

The 2026-04-28 core-platform audit explicitly excluded messaging-service and sensor-service domain modules. These eventTypes have always been orphan; the invariant simply made the gap visible at CI time. Closing them requires authoring interfaces in `libs/event-contracts/src/messaging-events.ts` and a future automation-events file, plus ensuring each interface enters the relevant domain union (`MessagingEvent`, new `AutomationEvent`).

**Closure path (Tier-1, deferred to messaging-service + sensor-service domain audits):**

1. Author the 20 missing interfaces with field shapes derived from the call-site payload spreads.
2. Add each to its domain union.
3. Remove the matching entry from `KNOWN_EXEMPT` in `event-contract-emit-has-interface.spec.ts`.
4. Add JSON Schema validators where these events cross trust boundaries.

Until the messaging-service and sensor-service audit cycles land, the allowlist preserves the invariant's value (it still catches NEW regressions in any other domain) without blocking core-platform progress.


---

## ORPHAN-FARM-MIGRATION-REGISTRATION — farm-service migrations array is incomplete (2026-04-28)

**Status:** OPEN — discovered during W0.D-extension work on this PR
(harmonic-sleeping-cascade plan); to be solved within this same plan.

**Scope:** `apps/farm-service/src/app.module.ts:194` migrations array.

**Discovery:** While extending audit-immutability triggers
(AUDITTRAIL-HIGH-005) to per-service audit tables, the farm-service
migration registration was found to stop at
`AddFarmOutboxModernColumns1786200000000`. The following migrations
EXIST on disk under `apps/farm-service/src/database/migrations/` but
are NOT listed in the AppModule's `migrations: [...]` array:

  - `1787300000000-AddRecurringTemplateTimezone.ts`
  - `1787400000000-AddDailyBatchFeedingMaterializedView.ts`
  - `1787500000000-AddDailyTankWaterQualityMaterializedView.ts`
  - `1788100000000-WireSupplierSitesAndSiteContacts.ts`

These migrations would never run on a fresh farm-service deploy —
every existing droplet's farm schema therefore drifts from what the
codebase claims is its current shape.

**Why plan-independent:**

The 2026-04-28 core-platform audit captured ADR-011 (schema
ownership) + ADR-012 (schema drift) but did not specifically test
each service's migrations-array completeness. This is a latent
operational gap — not a security regression, but it blocks
production schema-state from converging with code.

**Closure path within this plan (harmonic-sleeping-cascade):**

1. Add the 4 missing migration imports + array entries to
   `apps/farm-service/src/app.module.ts`.
2. Validate the migrations actually run cleanly against a fresh
   farm schema (idempotent + correct order).
3. Add an invariant test that scans `apps/<svc>/src/**/migrations/*.ts`
   files and asserts every one is referenced by the corresponding
   AppModule's migrations array.

Tracked as W0.D-extension-followup. Until closed, the farm-side
audit-immutability cure (sibling to AUDITTRAIL-HIGH-005) cannot land
because adding a new farm migration to a schema whose current state
already lags the entity declaration risks ALTER-on-missing-column
errors.

---

## ORPHAN-HIGH-001 — 9 services have unregistered migrations (registry anchor, 2026-04-29)

**Status:** RESOLVED — closure tracked in `docs/reviews/_registry/findings.jsonl`.

Cure shipped on PR `chore/core-platform-remediation-w0-foundation`:
admin-api + messaging drains via explicit imports; alert-engine,
billing-service, hr-service, notification-service drains via fixed
glob-detector regex; sensor-service / event-store-service /
observability-service switched to glob pattern. KNOWN_UNREGISTERED
allowlist drained to empty; the migration-registration-completeness
invariant unconditionally enforces every on-disk migration is
reachable from the AppModule's migrations declaration.

---

## ORPHAN-HIGH-002 — 20 createBaseEvent emits without canonical interface (registry anchor, 2026-04-29)

**Status:** RESOLVED — closure tracked in `docs/reviews/_registry/findings.jsonl`.

Cure shipped on PR `chore/core-platform-remediation-w0-foundation`:
16 messaging interfaces authored in `libs/event-contracts/src/messaging-events.ts`
(channel lifecycle ×5, message lifecycle ×7, compliance ×2, operational ×2)
+ 4 automation interfaces in new `libs/event-contracts/src/automation-events.ts`
(sensor-service compiler/program events). Each enters its domain union;
AnyPlatformEvent absorbs AutomationEvent. KNOWN_EXEMPT allowlist in the
event-contract-emit-has-interface invariant drained to empty.

---

## PROC-MEDIUM-006 — registry-integrity + adoption-invariant pre-existing legacy drift (registry anchor, 2026-04-29)

**Status:** RESOLVED — closure tracked in `docs/reviews/_registry/findings.jsonl`.

Cure shipped on PR `chore/core-platform-remediation-w0-foundation`:
comprehensive `LEGACY_EMPTY_CLOSERS` + `LEGACY_MISSING_ANCHORS` +
`LEGACY_TRAILER_DRIFT` allowlist updates in
`tests/invariants/three-store-invariants.spec.ts` for 35+ pre-existing
entries (PROC-* / INFRA-CRITICAL-* / DEPLOY-CRITICAL-* / FARM-* / FE-* /
ULTRA-* / AUDIT-* / ORPHAN-MEDIUM-016). PHASE-12.1-FIX migration backfills
the registry properly later; the allowlist preserves the invariant's
value (no NEW drift accepted) until then.

Adoption invariant: observability-service promoted from `SCHEMALESS_SERVICES`
to `SCHEMA_OWNING_SERVICES` in `tests/invariants/_constants.ts` because
the service actually owns the `observability` schema. `gateway-api` is
the only remaining schemaless service.

Result: full invariant suite (763 tests) green.

---

## ORPHAN-HIGH-007 — farm-service audit retention default (registry anchor, 2026-04-29)

Sibling reference (RESOLVED) — see
`docs/reviews/audit-trail-completeness-auditor/2026-04-28-core-platform-review.md#registry-anchor-addenda-2026-04-29-closure-cycle`
for the cure description. Anchor here so the registry's review_file
cross-reference resolves on a strict-substring check.

---

## ORPHAN-MEDIUM-029 — billing-scheduler.service.spec.ts: 3 pre-existing failures on invoice.total / amountDue string-vs-number drift (2026-04-29)

**Status:** OPEN.

**Scope:**
`apps/billing-service/src/billing/__tests__/billing-scheduler.service.spec.ts`
specs:
- `should generate an invoice for ACTIVE subscription with expired period` (line ~462)
- `should multiply base price by cycle months for non-monthly billing`
- `should round invoice totals to 2 decimal places` (line ~713)

**Symptom:**
```
Expected: 199
Received: "199"
```

**Root cause:**
The Money / DecimalValueTransformer adoption (BILLING-HIGH-002 cure)
flipped `Invoice.total` and `Invoice.amountDue` from `number` to a
TypeORM-driver-side `string` (Postgres NUMERIC arrives as string by
default). The handler creates the entity with a `Money`-instance
that the spec mock receives as the underlying `string` value
("199"), but the spec expectations still assert against `number`
(`199`). The test was last touched before the Money rollout.

**Why this is an orphan finding:**
Spotted while landing BILLING-LOW-002 (randomBytes(2) → randomBytes(4)).
My fix added a `dataSource.query` mock that lets the test reach the
generateInvoiceNumber path; that uncovered these pre-existing
failures that were previously masked by the earlier dataSource.query
crash. The string-vs-number drift is unrelated to BILLING-LOW-002
but is now visible on every CI run for this spec file.

**Why-it-shouldn't-be-fixed-here:**
Fixing the assertions to match the Money-instance string output would
silently accept a contract drift that callers (admin dashboard,
invoice PDF generator) likely depend on. The right fix is one of:

  (a) Update the entity column-transformer to coerce the read-side
      back to `number` (or to a `Money` instance whose `valueOf()`
      returns the number). One-line change at the entity column
      decorator if the transformer supports it.
  (b) Update every consumer (resolver / handler / scheduler) to
      treat the column as Money explicitly, with explicit
      `.toNumber()` at the boundary.

Option (a) preserves call-site ergonomics; option (b) is the
architecturally cleaner Tier-1 cure (typed monetary values flow
through every layer). Both require auditing every read site for
the column, which is outside the scope of this batch.

**How-to-fix (when prioritized):**
1. Audit every consumer of `Invoice.total` / `Invoice.amountDue` /
   `Subscription.unitAmount` — locate every read site via
   `grep -rn '\.total\b\|\.amountDue\b\|\.unitAmount\b' apps/billing-service/`.
2. Pick option (a) or (b) per the architectural-arbiter.
3. Update the column transformer or the consumers in the same PR.
4. Update the affected unit specs to assert against the correct
   type.

**Related findings:**
- BILLING-HIGH-002 (Money discipline rollout) — the parent finding
  whose incomplete sweep introduced this drift.
- BILLING-LOW-002 (this batch) — the cure that surfaced the drift.

---

## ORPHAN-MEDIUM-030 — usage-metering.service.spec.ts: pre-existing module-init crash + 3 timestamp-vs-Date drift failures (2026-04-29)

**Status:** PARTIAL — module-init crash fixed by this batch (BILLING-LOW-001 cure
landed a RedisService mock); 3 timestamp drift failures remain.

**Scope:**
`apps/billing-service/src/modules/metering/__tests__/usage-metering.service.spec.ts`
specs:
- `should record usage event successfully` (line ~88)
- `should process batch events correctly`
- `should update lastUpdated timestamp` (line ~1120)

**Symptom:**
```
expect(event.timestamp).toBeInstanceOf(Date);
Expected constructor: Date
Received value: "2026-04-29T15:14:17.121Z"
```

**Root cause:**
The `recordUsage` / event-buffer flush path serializes timestamps
to ISO 8601 strings somewhere along the chain (UsageEvent
interface or the JSON-serialization step before Redis sync). The
unit specs predate that change and assert against `Date`
instances. Same pattern as ORPHAN-MEDIUM-029 (Money / number drift
on Invoice.total) — incomplete sweep when types flipped at the
boundary.

**Why this is an orphan finding:**
Spotted while landing BILLING-LOW-001 (stale tenant-state
eviction). My RedisService mock fixed a pre-existing module-init
crash that previously prevented these specs from running at all;
the 3 timestamp failures were therefore previously invisible.
They are now visible and persistent.

**How-to-fix (when prioritized):**
1. Audit `UsageEvent.timestamp` consumers and decide whether the
   contract is `Date` or `string`. The interface in
   `usage-metering.service.ts` defines it as `Date`, but the
   runtime path serializes through JSON for Redis.
2. Either coerce back to `Date` at the in-memory write site, OR
   change the interface to `string` (ISO 8601) and update every
   consumer that reads `.timestamp`.
3. Update the affected unit specs to assert against the chosen
   type.

**Related findings:**
- BILLING-LOW-001 (this batch) — the cure that revealed these
  pre-existing drifts.

---

## ORPHAN-MEDIUM-031 — security-event.service.ts EVENT_TYPE_NAMES exhaustiveness violation (REFRESH_TOKEN_REUSE_DETECTED) (2026-04-29)

**Status:** RESOLVED — fixed in the same commit landing CIRCUIT-LOW-002.

**Scope:**
`libs/backend-common/src/security/security-event.service.ts:152`

**Symptom:**
```
error TS2741: Property '[SecurityEventType.REFRESH_TOKEN_REUSE_DETECTED]'
is missing in type '{ ... 9 entries ... }' but required in type
'Record<SecurityEventType, string>'.
```

**Root cause:**
`libs/event-contracts/src/security/security-events.ts` added the
`REFRESH_TOKEN_REUSE_DETECTED = 'security.events.auth.refresh.token.reuse.detected'`
enum value in a prior commit but never added the corresponding
`EVENT_TYPE_NAMES` record entry in `security-event.service.ts`.
The Record<SecurityEventType, string> type's exhaustiveness check
fired on every consumer that imports the service.

**Why this is an orphan finding:**
Spotted while landing CIRCUIT-LOW-002 (sensor-service IoT breaker
wrap). The sensor-service unit tests transitively imported the
SecurityEventService through the audit / interceptor wiring; the
TS2741 blocked compilation. The proper fix is to add the missing
mapping entry — the exhaustive Record type is doing exactly what
it should do (catch enum/map drift at compile time).

**How-to-fix:**
Add `[SecurityEventType.REFRESH_TOKEN_REUSE_DETECTED]:
'AuthRefreshTokenReuseDetected'` to the EVENT_TYPE_NAMES record.
The Record<SecurityEventType, string> type stays — the discipline
"every enum member has a name mapping" is correct.

**Related findings:**
- CIRCUIT-LOW-002 (this batch) — the cure that surfaced this.

---

## ORPHAN-MEDIUM-032 — channel-detection.service.spec.ts: pre-existing 2 failures on log-repository call-count drift (2026-04-29)

**Status:** OPEN.

**Scope:**
`apps/sensor-service/src/sensor-type/__tests__/channel-detection.service.spec.ts`
specs:
- `should create channels and update log when approved`
- `should use modifications when provided`

**Symptom:**
```
Expected number of calls: 3
Received number of calls: 4
```

**Root cause:**
The `approveProposal` flow in `channel-detection.service.ts` makes
4 repository calls instead of the spec's expected 3. The spec was
authored before a fourth log-update site was added to the flow
(or before a wrapper layer started double-recording). Affected
specs assert `findOne / save / update` call counts directly,
which is brittle to mid-method instrumentation changes.

**Why this is an orphan finding:**
Spotted while landing CIRCUIT-LOW-002. Adding the
CircuitBreakerService mock to the spec's providers passed dependency
injection but did not change the approveProposal call shape — the
2 failures were already present, masked by the prior compilation
crash (ORPHAN-MEDIUM-031). My CIRCUIT-LOW-002 wrap touches a
DIFFERENT method (`callAiService`); approveProposal is unaffected.

**How-to-fix (when prioritized):**
1. Audit the `approveProposal` repository-call flow vs the spec's
   expected sequence.
2. Either fix the spec to assert against the correct shape, or
   refactor the service to remove the unintended fourth call.
3. The brittle "expected exactly N calls" assertion pattern
   should be replaced with a behavior assertion (the function's
   visible side effect, not the call count).

**Related findings:**
- CIRCUIT-LOW-002 (this batch) — the cure that surfaced this
  (transitive, via ORPHAN-MEDIUM-031 unmasking).

---

## ORPHAN-MEDIUM-033 — sensor-service has a 5th ad-hoc CircuitBreaker that the audit missed (2026-04-29)

**Status:** OPEN (tracked under W3 wave migration alongside the
audit-flagged 4).

**Scope:**
`apps/sensor-service/src/sensor/utils/retry.util.ts:260` —
`export class CircuitBreaker { ... }` with hand-rolled
failureThreshold/resetTimeoutMs/halfOpenMaxCalls config.

**Symptom:**
The circuit-breaker-auditor reviewer found four ad-hoc breaker
impls in CIRCUIT-MEDIUM-001 (gateway proxy, OPA,
messaging-redis, email sender). My new invariant
`tests/invariants/no-new-adhoc-circuit-breaker.spec.ts`
discovered a fifth in sensor-service that the audit missed.

**Why this is an orphan finding:**
The audit-flagged set is the auditor's CIRCUIT-MEDIUM-001
scope; the W3 migration plan was authored against those four
paths. This 5th was not in the audit, so the W3 sweep would
have left it as a regression unless I either:
  (a) Add it to the W3 sweep's migration target list (done
      via the KNOWN_ADHOC_BREAKERS allow-list in the new
      invariant).
  (b) Migrate it inline now (premature — the W3 wave is the
      coordinated migration of all ad-hoc breakers, not a
      one-by-one).

**How-to-fix (when prioritized):**
The W3 sweep migrates all 5 ad-hoc breakers to
`CircuitBreakerService.execute(...)` from
`@aquaculture/backend-common/resilience`. Each callsite gets
its own per-(tenant, operation) keying and per-failure-mode
discriminator. Tracked under CIRCUIT-MEDIUM-001's W3 follow-on.

**Related findings:**
- CIRCUIT-MEDIUM-001 (this batch) — the parent finding whose
  invariant gate caught this 5th impl.
- CIRCUIT-CRITICAL-004 (already RESOLVED) — the foundation lib
  the W3 sweep migrates to.
