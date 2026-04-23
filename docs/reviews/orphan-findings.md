# Orphan Findings — Plan-Independent Real Problems

**Purpose:** Problems spotted while reading code for planned work (ADRs / Faz implementation) that are **NOT** part of the current plan. Discovery → test → document here.

**Policy:** Append-only. Findings RESOLVED via commits carry closure note + commit SHA. Never silently dropped.

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

## 2026-04-23 ORPHAN-SCADA-EDGES-001 — scada-builder/edges diverge materially from process-editor/edges

**Status:** OPEN — kept out of scope for AUDIT-HIGH-006's close because the divergence is structural, not stylistic.

**Scope:**
`web/modules/sensor-module/src/components/scada-builder/edges/{DraggableEdge,MultiHandleEdge,OrthogonalEdge}.tsx` — 378 / 461 / 530 lines respectively, totaling ~1370 lines.

**Why not collapsed to the lib when AUDIT-HIGH-006 was closed:**

The 2026-04-22 cold audit reported node-components edges duplicated across three locations: `libs/node-components/src/edges`, process-editor, and scada-builder. The first two had only one real divergence (ReactFlow `setEdges` vs. a zustand `processStore.updateEdgeData`) which is now handled by the lib's `updateEdgeData?` prop — process-editor shrank to a 3-file, 75-line adapter set.

scada-builder is different. Each of its three edges is 60–90 lines LARGER than the lib counterpart, and the extra lines are not a boilerplate divergence — they implement the SCADA workspace's own controller-driven workflow: `useEdgeStoreContext()` hook (React context, not zustand), edge-level SCADA property panels, a distinct hover/select/drag interaction model, and keyboard-shortcut bindings that process-editor lacks.

Mechanically applying the lib → wrapper refactor would lose those SCADA-specific behaviours OR require pushing them back into the lib (which would make the lib SCADA-coupled and violate ADR-028's lib-rubric for `libs/node-components` — "ReactFlow primitives", not SCADA app behaviour).

**Closure path:**

Before collapsing scada-builder onto the lib, the SCADA-specific behaviours must be decomposed into injectable pieces (e.g. a `useEdgeContextMenuBindings` hook, a `ScadaEdgePropertyPanel` render-prop). Once that split exists, each scada-builder edge file shrinks to a thin wrapper (same pattern as process-editor) that composes the lib edge + scada-specific hooks.

**Follow-on tracking:**
- Owner: frontend-expert + sensor-expert.
- Deadline: next SCADA-workspace feature cycle — the decomposition lands alongside whoever next touches the scada-builder edge interactions.
- Closure path: commit that lands the decomposition deletes these three files and carries `Closes: docs/reviews/orphan-findings.md#ORPHAN-SCADA-EDGES-001`.

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

## 2026-04-23 ORPHAN-DIC-001 — sensor-service child entities have no `tenantId` column

**Status:** OPEN — surfaced during the Phase B.3 cold-audit remediation while trying to migrate sensor-service `manager.getRepository(Entity)` calls to `tenantManagerRepo()`.

**Scope (3 entities):**
1. `apps/sensor-service/src/edge-device/entities/device-io-config.entity.ts` — reachable only via parent `EdgeDevice`.
2. `apps/sensor-service/src/automation/entities/program-variable.entity.ts` — reachable only via parent `AutomationProgram`.
3. (implicit) any future sensor-service child entity that follows the same parent-scoped pattern.

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
