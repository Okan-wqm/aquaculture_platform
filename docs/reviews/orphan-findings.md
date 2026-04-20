# Orphan Findings — Plan-Independent Real Problems

**Purpose:** Problems spotted while reading code for planned work (ADRs / Faz implementation) that are **NOT** part of the current plan. Discovery → test → document here.

**Policy:** Append-only. Findings RESOLVED via commits carry closure note + commit SHA. Never silently dropped.

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

---

## Notes on methodology

- Findings discovered during normal code review; NOT dedicated orphan-bug sweep.
- Each entry reviewed for "real problem vs stylistic preference" — preferences NOT recorded.
- CLAUDE.md banned-phrase rules apply; "deferred" only with owner/deadline/finding-ID per rule.
- Resolution path: linked to plan phase / sprint where fix lands.
