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

## Notes on methodology

- Findings discovered during normal code review; NOT dedicated orphan-bug sweep.
- Each entry reviewed for "real problem vs stylistic preference" — preferences NOT recorded.
- CLAUDE.md banned-phrase rules apply; "deferred" only with owner/deadline/finding-ID per rule.
- Resolution path: linked to plan phase / sprint where fix lands.

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

## ORPHAN-MEDIUM-029 — `sens-api-gateway` clippy deny-list violations are widespread but the gate is not enforced in current dev workflow (2026-04-28)

Registry anchor note: `ORPHAN-CRITICAL-029` is the Phase 0.1 mTLS TLSConfiguration finding recorded in `docs/reviews/_registry/findings.jsonl`; this review file carries the canonical anchor for the three-store invariant.

**Discovered by:** Batch #331 v1 legacy-key kernel session. Running `cargo clippy --bin suderra-agent` surfaces dozens of `error: used 'expect()' on a 'Result' value`, `error: indexing may panic`, `error: used 'unwrap()' on a 'Result' value` errors across many files (e.g., `src/lifecycle_auth.rs:357`, multiple files with indexing). All these lints are in the crate's deny-list per the rustc invocation flags (`'--deny=clippy::unwrap_used' '--deny=clippy::expect_used' '--deny=clippy::indexing_slicing'`), yet `cargo check` passes cleanly because clippy lints are not registered in regular rustc — they only fire under `cargo clippy`.

**Why this is an architectural problem (not just lint noise):**

- The deny-list is an architectural CONTRACT that says "this codebase bans `expect`/`unwrap`/`indexing` outside test code". The contract is asserted via rustc flags but not gate-enforced in the current dev workflow — every batch can land violations indefinitely.
- New code conforming to the contract (this session's #329-#333 batches) sits next to legacy code violating it, with no operator-visible signal of which side is "current standard". Future batches don't know whether to follow the deny-list or the precedent.
- `lifecycle_auth.rs:357` uses `.expect()` on the same `HmacSha256::new_from_slice` pattern Batch #331 needed; without an `#[allow(clippy::expect_used)]` annotation the lint would fail clippy. Batch #331 added the annotation explicitly + documented the RFC 2104 unreachability rationale; lifecycle_auth.rs has no such annotation.

**Architectural fix (3-tier hierarchy):**

- **Tier 1 (make it impossible)** — Add `cargo clippy --bin suderra-agent --all-features --deny warnings` to the husky pre-commit + CI gate. Forces every commit to pass clippy. Migration cost: large (need to fix or annotate every existing violation).
- **Tier 2 (make it automatic)** — Add the gate ONLY for files touched in the current diff (clippy on `git diff --name-only`-filtered files). Forces NEW code to comply without forcing a fleet-wide cleanup batch.
- **Tier 3 (make it detectable)** — Document the gap in `docs/runbooks/clippy-deny-list.md` so engineers know clippy is a per-batch optional check, not a CI gate. This finding is the documentation step.

**Severity: MEDIUM** — silent architectural-contract erosion; not a runtime correctness issue. The RFC-2104-justified `.expect()` patterns Batch #331 added with explicit `#[allow]` annotations would not break the codebase; the legacy violations are indistinguishable from intentional ones without per-callsite review.

**Status:** PARTIALLY RESOLVED — Batch #343 callable gate landed; Batch #345 wiring REVERTED after design flaw exposed. The gate at `tools/gates/clippy-affected.ts` filters by FILE-level affected set (any file touched by `git diff --name-only <base>...<head>`) and surfaces ALL error-level diagnostics in those files. Live-fire test on the PR-194 branch (212 affected Rust files vs origin/main) returned **700 error-level diagnostics** — pre-existing legacy violations in files the branch touched even minimally (single-import refactor, doc-comment edit, etc.). This is the very outcome the auditor warned would block dev velocity with the heavier Tier-1 approach.

The architectural fix per CLAUDE.md hierarchy is **per-LINE filtering** (not per-FILE): parse `git diff --unified=0 <base>...<head> -- <file>` to extract the added/modified line ranges per file; filter clippy diagnostics to only those whose primary span's `line_start` falls within the affected-line set. This catches NEW violations introduced by the diff while ignoring legacy debt on lines the diff didn't touch — the auditor's actual Tier-2 intent.

Implementation is non-trivial (~50-80 lines of TypeScript in clippy-affected.ts: hunk-header parser + `Map<file, Set<line>>` + diagnostic-line-range filter) and warrants its own focused batch. Filed as ORPHAN-MEDIUM-034 below (the design-flaw observation).

**Linked plan:** none. Next architectural batch: ORPHAN-MEDIUM-034 (per-line filtering refinement).

## ORPHAN-MEDIUM-034 — `clippy-affected` gate uses per-FILE filtering not per-LINE; flags pre-existing legacy debt the moment a file is touched (2026-04-28)

**Discovered by:** Batch #345 husky pre-push wiring attempt (this session). The Batch #343 gate ships per-FILE filtering — any clippy error in a file touched by `git diff --name-only` triggers the gate. On the PR-194 branch this surfaced **700 errors across 212 affected files**, all pre-existing legacy violations (e.g., `lifecycle_auth.rs:357 .expect()` precedent that's been in the codebase since Batch 129; `process_hardening.rs:824` mmap NonNull expect; `alarms.rs:752` slice indexing; etc.).

**Why this is an architectural problem:**

- The auditor's MEDIUM-029 recommendation explicitly framed the Tier-2 fix as "the per-diff gate prevents NEW debt without forcing a fleet-wide cleanup". The per-FILE shape forces fleet-wide cleanup the moment a file is touched — exactly the failure mode the recommendation was designed to avoid.
- Operators making routine refactors (e.g., extending an import path, fixing a doc typo) would be blocked by unrelated legacy violations in the same file. Either they'd have to fix the legacy debt (scope creep) or skip the gate (defeats enforcement).
- The Batch #345 husky pre-push wiring attempt landed the enforcement before the design flaw was visible — discovered when the hook fired on its own follow-up commit's push and rejected with 700 errors.

**Architectural fix (Tier-1 make-it-impossible):**

Refine `tools/gates/clippy-affected.ts` to per-LINE filtering:

1. Run `git diff --unified=0 <base>...<head> -- <file>` per affected file to get line-precise hunks.
2. Parse hunk headers (`@@ -<old_start>,<old_count> +<new_start>,<new_count> @@`) to extract added/modified line numbers.
3. Build `Map<file_path, Set<line_number>>` of affected lines.
4. Filter clippy diagnostics: keep only those whose primary span's `line_start` (or any of `line_start..=line_end`) intersects the affected-line set for that file.
5. Document the per-line semantic in the gate's module doc + the rationale for choosing it over per-file.

This change makes the gate fire ONLY on violations introduced by the diff — line-precise. Legacy debt on lines the diff didn't touch passes cleanly. Architectural completion of the auditor's MEDIUM-029 Tier-2 intent.

**Severity: MEDIUM** — design correctness; the gate as currently shipped is callable but not auto-enforced (Batch #345 wiring reverted), so dev velocity is not blocked. The per-line refinement makes the gate ready for husky pre-push wiring on the next operations cycle.

**Status:** RESOLVED — closed by Batch #346 (this session). Per-LINE filtering landed:

- `affectedLineRanges()` runs `git diff --unified=0 <base>...<head> -- <file>` per affected Rust file, parses hunk headers (`@@ -<old> +<new_start>,<new_count> @@`) to build `Map<file, Set<line>>`.
- The diagnostic filter now keeps only diagnostics whose primary span's `[line_start..=line_end]` overlaps the affected-line set for that file.
- Module doc + usage notes updated to document the per-LINE semantic + cite the MEDIUM-034 closure rationale.

**Live-fire results:**
- Short-range test (`HEAD~5..HEAD`, includes Batch #344 Rust changes): 3 affected files / 241 affected lines, **0 errors. Gate passed.**
- Full-branch test (`origin/main..HEAD`, 17-batch feature branch): 212 files / 91,025 lines / 69 errors. **Big improvement from per-FILE's 700 errors but real legacy debt remains** — the violations are on lines THIS branch added (e.g., process_hardening.rs is a brand-new file from origin/main's POV; every line in it is "added"). Long-lived feature branches accumulating multi-batch debt is a legitimate architectural concern that the gate now ACCURATELY surfaces.

**Why husky pre-push re-wiring NOT in this batch:** for a pre-push hook the right semantic is "what's new in this PUSH" — git-stdin per-ref `<remote_sha>...<local_sha>` parsing — NOT `origin/main...HEAD` which is "what's new on the branch since main". The git-stdin parsing is a separate batch (filed as ORPHAN-LOW-035 below for visibility).

**Linked plan:** none. Knock-on follow-up captured in ORPHAN-LOW-035.

## ORPHAN-LOW-035 — `clippy-affected` pre-push hook needs git-stdin per-ref parsing for tighter "new in this push" semantic (2026-04-28)

**Discovered by:** Batch #346 (this session). The Batch #346 per-LINE refinement closed ORPHAN-MEDIUM-034's design flaw — the gate now correctly filters by line. But for husky pre-push wiring the natural diff range is "what's being pushed in THIS push event", not `origin/main...HEAD`.

Git's pre-push protocol provides per-ref `<local_ref> <local_sha> <remote_ref> <remote_sha>` lines on stdin. A correct pre-push hook would:

1. Read stdin per-ref.
2. For each ref being pushed compute the range as `<remote_sha>...<local_sha>`.
3. Pass that range to clippy-affected (instead of `origin/main...HEAD`).

Result: a multi-commit push of N new commits sees ONLY those N commits' line changes — not the full branch delta vs main. Long-lived feature branch's accumulated debt no longer fires the gate.

**Architectural fix (Tier-2 make-it-automatic):**

New tooling shape:
- `tools/gates/clippy-affected-prepush.ts` (or extend existing CLI with `--mode=prepush` reading stdin) — reads pre-push stdin lines, computes ranges, dispatches to the existing per-LINE filter.
- `.husky/pre-push` calls the new mode + passes stdin through.

**Severity: LOW** — operations enhancement; the gate is callable today and the per-LINE refinement closes the design correctness concern. The pre-push wiring is a future operations cycle.

**Status:** RESOLVED — closed by Batch #347 (this session). New `--mode=prepush` added to `tools/gates/clippy-affected.ts`:

- `parsePrePushStdin()` reads git's pre-push stdin protocol (`<local_ref> <local_sha> <remote_ref> <remote_sha>` per ref).
- `rangeForPrePushRef()` resolves each ref to a `<base>...<head>` range with edge-case handling: branch deletion (`local_sha = 0…`) skipped; new branch (`remote_sha = 0…`) falls back to `origin/main` if available else skipped with operator log.
- New `gateRange()` helper extracted from `main()` so prepush mode dispatches per-ref independently and aggregates the error count across all refs.
- `.husky/pre-push` re-added with the correct stdin-piping invocation: `clippy-affected.ts --mode=prepush`.

**Live-fire verification:**
- Simulated stdin with `HEAD~3..HEAD` range (no Rust files): gate skipped ✓.
- Simulated stdin with `HEAD~7..HEAD` range (Batch #344's Rust changes): 3 files / 241 lines / 0 errors ✓.

The pre-push hook now scopes the gate to "what's new in THIS push" — long-lived feature branches with accumulated debt no longer fail every push.

**Linked plan:** none.

## DEPLOY-CRITICAL-005 — MigrationAuditModule missing EventBusModule.forRoot() import (2026-04-21)

## DEPLOY-CRITICAL-005 — MigrationAuditModule missing EventBusModule.forRoot() import (2026-04-21)

**Linked plan:** none (cross-cutting hygiene; out-of-band of every active D-arc).

## ORPHAN-LOW-030 — `sens-api-gateway/fuzz/Cargo.lock` regenerates as untracked on every build, polluting `git status` (2026-04-28)

**Discovered by:** Batches #329-#333 D-3 SQLCipher migration arc. Every cargo check / cargo test invocation regenerates `sens-api-gateway/fuzz/Cargo.lock` (the fuzz crate's lockfile). `git status` consistently shows it as `??` untracked across every batch this session. Pre-existed — not introduced by any D-3 batch.

**Why this is a hygiene problem (not a correctness problem):**

- `git add -A` would silently include the lockfile, possibly with stale dependency-version pins from one engineer's local env.
- Modern Rust convention for binary/test crates is to commit Cargo.lock for reproducibility; for library crates (and per-target fuzz harnesses), the convention is mixed. This crate has no explicit policy file.
- The repeated `??` in `git status` increases the surface area for accidental commits AND distracts engineers reviewing the working-tree state.

**Architectural fix (2-tier choice):**

- **Tier 1 — commit `fuzz/Cargo.lock`** — explicit reproducibility for the fuzz harness; matches the convention for binary-producing crates. Single-commit fix; no behavioral change.
- **Tier 1 alternative — add `fuzz/Cargo.lock` to `sens-api-gateway/.gitignore`** — explicit "this lockfile is intentionally local". Single-commit fix; matches the convention for library-style crates. Either way, the file is no longer `??` in status.

The PRESENT state (untracked, no policy file) is the worst of both — engineers don't know if the file SHOULD be committed and may add or omit it inconsistently.

**Severity: LOW** — git hygiene only. No correctness, security, or test-coverage implication. Documented per user policy: *gördüğüm hiçbir problemi senin ilgili olmasa bile not al*.

**Status:** RESOLVED — closed by Batch #334 (this session). Per the workspace `.gitignore`'s explicit "Cargo.lock IS committed" policy (the canonical convention for binary-producing crates), the lockfile is now tracked. `fuzz/Cargo.lock` was 3814 lines + 382 packages at the time of commit — standard cargo-fuzz lockfile shape. The `??` no longer appears in `git status` and the workspace policy is uniformly applied across all binary crates in the repo.

**Linked plan:** none.

## ORPHAN-MEDIUM-031 — `KeyPurpose` enum projects 4 SqlCipher consumers but defines only 2 variants; consumer-migration arc cannot start without ADR for missing variants (2026-04-28)

Registry anchor note: `ORPHAN-HIGH-031` is the Phase 0.2 cipher-allowlist verifier finding recorded in `docs/reviews/_registry/findings.jsonl`; this review file carries the canonical anchor for the three-store invariant.

**Discovered by:** Batch #332 D-3 v2 keystore-derived shim session. The shim's `is_sqlcipher_purpose` predicate centralizes the SSoT for "which purposes are valid for SQLCipher rekey" (today: `SqlCipherOfflineQueue` + `SqlCipherRetainPersistence`). Plan §5 Faz 2 D-3 docs project FOUR SqlCipher consumers requiring per-consumer migration: `offline_queue` + `license_cache` + `scripting/persistence` + `scripting/bytecode_retain`. The keystore enum is short by 2 variants; the per-consumer migration arc cannot start until the new variants land via ADR.

**Evidence:**

- `src/keystore/purpose.rs:33-65` — only `SqlCipherOfflineQueue` (line 33-36) + `SqlCipherRetainPersistence` (line 38-41) defined.
- Per the existing per-variant doc comments, each variant's HKDF info string is a STABILITY CONTRACT: "Changing any value invalidates every deployed derived key for that purpose; such a change requires an ADR + a fleet-wide migration window".
- `src/license_cache.rs` uses `derive_db_encryption_key()` (the v1 path) — would need `KeyPurpose::SqlCipherLicenseCache` for v2 migration.
- `src/scripting/persistence.rs` (if exists) + `src/scripting/bytecode_retain.rs` (if exists) — same gap.

**Why this is an architectural problem:**

- The `is_sqlcipher_purpose` predicate cannot pre-emptively include `SqlCipherLicenseCache` (or other future variants) because they don't exist yet — the predicate is correctly scoped to TODAY's variants. But the per-consumer migration arc (PR-195) needs the variants ADDED before consumer call sites can flip to v2 derivation.
- The HKDF info string contract means each new variant is a fleet-wide change: a typo in the info bytes invalidates every device's derived keys for that consumer. The ADR + migration window is non-negotiable.
- Skipping ADR + adding variants in-line during PR-195 would conflict with the project's stated change-control discipline (`docs/adr/` is the canonical surface for these decisions).

**Architectural fix (clear sequence):**

1. **Tier 1 — write the ADR** that adds `SqlCipherLicenseCache`, `SqlCipherScriptingPersistence`, `SqlCipherBytecodeRetain` (or whatever the consumer-final names land as) to `KeyPurpose` with explicit HKDF info strings + per-variant context-bytes contract. Include the cross-deployment migration plan: every device on the fleet has these consumers' v1 DBs; the ADR + landing batch must include the migration runbook.
2. **Tier 1 — extend `is_sqlcipher_purpose`** in the same batch as the ADR landing so the v2 shim accepts the new variants.
3. **Tier 1 — extend `db_migration_wire_status.rs` invariant 15** (the predicate-coverage check) to assert all NEW variants are members.
4. **Tier 2 — per-consumer flip** — each consumer's call site adopts v2 derivation in the consumer-migration arc. The boot detector (#330) automatically picks up the new manifests; the rekey binary (PR-195) handles the v1→v2 roundtrip.

**Severity: MEDIUM** — blocks the per-consumer migration arc but does not affect any deployed system (current consumers stay on v1 unless migration ships). Tracked in Batch #332's commit body but elevated to a standalone orphan finding for visibility.

**Status:** RESOLVED — closed by Batch #341 (this session). ADR-031 written + landed at `docs/adr/031-keypurpose-sqlcipher-consumer-extension.md`. Two variants added to `KeyPurpose`: `SqlCipherLicenseCache` (hkdf_info `b"suderra:sqlcipher:license-cache:v2"`, deployment-instance UUID context) + `SqlCipherBytecodeRetain` (hkdf_info `b"suderra:sqlcipher:bytecode-retain:v1"`, program-artifact-SHA256 context). `KeyPurpose::is_sqlcipher_variant` extended to match all 4 SqlCipher* variants. Wire-status invariant 15 in `db_migration_wire_status.rs` extended to assert all 4 variants present. PR-195 consumer-migration arc unblocked.

**Linked plan:** Plan §5 Faz 2 D-3 (UH-017 parent finding); PR-195 D-3 closure arc (consumer-migration installment).

## ORPHAN-MEDIUM-210 — ARIA lacked model/effort cost-tiering, multi-judge consensus, belief decay, and autonomous-fix safety gates (Plans 023-031)
Found 2026-06-28 during the ARIA gaps + cost-review sweep. The ARIA meta-system had capability gaps vs its design-of-record: no per-role model/effort tiering with consensus->human escalation (cost-runaway risk); single-judge finding verification (no >=2-judge fan-out / gold-set replay); no time-based belief decay; no proactive Impact x Opportunity prioritization; no runtime-signal bridge; and the autonomous-fix loop lacked a regression anchor, an oscillation guard, a burn-in->ladder bridge, and an expert-reviewer consensus gate. Status: RESOLVED (2026-06-28) — implemented across Plans 023-031 (model/effort tiering + consensus->human escalation; judge calibration; operator-resolution feedback; evidence-gated arbiter; >=2-judge fan-out + gold-set activation/replay; Rust/edge drift enums; belief decay; Impact x Opportunity prioritization; runtime-signal bridge; deterministic acceptance harness + agent lane; Gate A regression anchor + Gate B oscillation guard; burn-in->ladder bridge; expert-reviewer consensus gate). See docs/plans ARIA-023..031. (Inserted mid-file, not at the contended tail, to stay merge-train collision-immune; ID 210 reserved with margin.)

## ORPHAN-MEDIUM-032 — `git rev-parse --short HEAD` after a husky-rejected commit captures STALE HEAD; registry-close shell pipelines record the wrong closing SHA (2026-04-28)

**Discovered by:** Batch #341 (this session) commit cycle. The shell pipeline:
```sh
git commit -m "...batch body..."  # husky-rejected — files stay staged
SHA=$(git rev-parse --short HEAD)  # ← captures PRIOR commit, not the failed one
finding-registry close UH-NNN $SHA
```

When the first `git commit` is rejected by the husky `commit-msg` hook (e.g., trailer-validation failure), the staged files remain in the index but no commit lands. The next `git rev-parse --short HEAD` returns the SHA of the PREVIOUSLY-LANDED commit (often the prior batch's registry-close commit), NOT the would-be Batch SHA. The `finding-registry close <id> $SHA` call then records the WRONG SHA in `closing_commits[]`.

**Symptom (concrete this session):**
- Batch #341's first commit attempted `Closes: docs/reviews/orphan-findings.md#ORPHAN-MEDIUM-031` + `Closes: docs/reviews/orphan-findings.md#ULTRA-HIGH-089` trailers. The commit-msg validator rejected the multi-`Closes:` shape (regex requires UH-`{PREFIX}-(CRITICAL|HIGH|MEDIUM|LOW)-NNN` only — `ORPHAN-` prefix is not in the regex).
- The shell pipeline kept running. `git rev-parse --short HEAD` returned `076d52d0` (Batch #340's registry-close commit, the actual previous HEAD).
- The `finding-registry close ULTRA-HIGH-089 076d52d0` call recorded the wrong SHA.
- The follow-on `git commit -m "chore(registry): close UH-089..."` then committed BOTH the registry-close JSON edit AND the still-staged Batch #341 files in a single commit — under the wrong commit-message header.

**Why this is a process-correctness problem (not a hot data-loss problem):**
- Audit-trail traceability (CLAUDE.md "Review Finding Traceability") requires `closing_commits[]` to point at the commit that contains the actual fix. A wrong SHA breaks `git show <sha>` lookups for future archaeologists.
- The bundled-content-under-wrong-message hides the commit's true scope from `git log` searches by message keyword.
- The batch-body commit-message text is preserved nowhere on the branch — its `WHY` rationale is lost.

**Architectural fix (3-tier):**

- **Tier 1 (make-it-impossible):** make the husky `commit-msg` regex accept the existing `Closes:` shapes including `ORPHAN-MEDIUM-NNN` references. Today the regex at `tools/gates/commit-msg-validator.ts` requires UH-`{PREFIX}-(CRITICAL|HIGH|MEDIUM|LOW)-NNN`; `ORPHAN-` is a valid `{PREFIX}` per the orphan-findings doc convention but not in the validator's allowlist. Updating the validator regex to include `ORPHAN` (and the other documented prefixes — DEPLOY-CRITICAL, AUDIT, etc.) would let multi-`Closes:` commits land cleanly.
- **Tier 2 (make-it-automatic):** restructure the commit pipeline to capture the SHA AFTER the commit succeeds, not after the commit attempt. The ergonomic shell pattern would be a wrapper script `tools/audit/commit-and-close.sh` that does:
  ```sh
  git commit -m "$BODY" || exit 1   # FAIL on rejection
  SHA=$(git rev-parse --short HEAD)  # only reaches here on success
  finding-registry close $UH $SHA
  git add findings.jsonl && git commit -m "chore(registry): close $UH with $SHA"
  ```
- **Tier 3 (make-it-detectable):** add a CI gate that grep-checks every `closing_commits[]` SHA against `git log` and fails if the named commit's message doesn't reference the closed UH ID — surfaces the desync at PR-review time. This is belt-and-suspenders for the Tier-1/Tier-2 fixes.

**Severity: MEDIUM** — process correctness + audit-trail integrity. Recoverable via re-running `finding-registry close` with the correct SHA (which appends, not overwrites — both SHAs end up in `closing_commits[]`, with future readers needing to disambiguate via `git show`). This session's UH-089 has the appended-fix applied; the wrong 076d52d0 entry stays in the array as an audit-trail of the race occurrence.

**Status:** RESOLVED — closed by Batch #342 (this session). Root cause was NOT the regex (which already accepts ORPHAN-* prefixes via `[A-Z][A-Z0-9]+`) but the validator's `loadRegistryIds` only checked `findings.jsonl` — orphan IDs live in `orphan-findings.md` by architectural design. Fix: added `loadOrphanIds()` parsing `## ORPHAN-{SEV}-NNN` markdown headings + per-prefix routing in `validateCommit` so ORPHAN-* trailers validate against the orphan-findings doc while non-ORPHAN trailers continue to validate against the registry. Multi-Closes commits referencing both UH-NNN (registry) AND ORPHAN-NNN (markdown) now validate cleanly. Verified via 3 synthetic test commits: real ORPHAN-MEDIUM-031 passes, bogus ORPHAN-LOW-999 rejected with structured reason, multi-Closes (UH-089 + ORPHAN-031) passes.

**Linked plan:** none (cross-cutting tooling concern).

## ORPHAN-MEDIUM-033 — `machine_uid::get()` has no env-override path; SUDERRA_DB_KEY_PATH pattern is asymmetric across the two v1 derivation inputs (2026-04-28)

**Discovered by:** Batch #335 v1 algorithm SSoT extraction session, while reading `offline_queue::derive_db_encryption_key`. The function takes TWO inputs to the HMAC-SHA256 kernel:

- `secret_key` — read via `load_or_create_db_secret()` which CHECKS `SUDERRA_DB_KEY_PATH` env override (Batch 88 CI-sandbox support, line 156). CI runners + tests CAN sandbox this read.
- `machine_id` — read via `machine_uid::get()` (line 112). NO env override exists. CI runners + tests CANNOT sandbox this read; they get whatever `/etc/machine-id` happens to contain on the host (or an error if the host has no machine-id file).

**Why this is an architectural problem:**

- The test suite for `offline_queue` becomes coupled to host filesystem state. A sandboxed CI runner without `/etc/machine-id` (e.g., a stripped Docker image) cannot exercise the full derivation path.
- The migration tool (future db-migrate-cli, PR-195) will need to override the machine-id read for cross-device DB rekey scenarios where the operator runs the tool on a different host than the device that produced the original DB. Without an env-override, the tool cannot be written without forking machine_uid or shipping per-device.
- The Batch #335 v1 kernel (`derive_v1_legacy_key`) takes `machine_id: &[u8]` as a caller-supplied input — pure-byte injection works at the kernel layer. But the IO wrapper (offline_queue) hard-reads via `machine_uid::get()`, defeating the architectural intent of the kernel's parameter-injectable design.

**Architectural fix (Tier-1 make-it-impossible):**

Create a new wrapper module `crate::machine_id` that:
1. Checks `SUDERRA_MACHINE_ID_PATH` env var (mirrors `SUDERRA_DB_KEY_PATH`).
2. If set: reads the file at that path + trims whitespace + returns the contents as a string.
3. If not set: falls back to `machine_uid::get()` for production parity.
4. Returns a `Result<String, anyhow::Error>` with the same error shape as the current `machine_uid::get().map_err(...)` chain.

Update `offline_queue::derive_db_encryption_key` to call the wrapper instead of `machine_uid::get()` directly. Test discipline (the OnceLock cache) is unchanged — the wrapper's output is fed into the same cache.

**Severity: MEDIUM** — test-isolation gap + future db-migrate-cli prerequisite.

**Status:** RESOLVED — closed by Batch #344 (this session). Wrapper landed at `src/machine_id.rs`, offline_queue refactored to delegate, test sandbox precedent established for the migration tool.

**Linked plan:** Plan §5 Faz 2 D-3 (test-isolation prerequisite for PR-195 db-migrate-cli).

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

**Why it's orphan:**

Rust sensor-ingestion migration plan (`snappy-sniffing-pine.md` Kör Nokta 5) adds the `raw_value` field + V2 contract for the Rust sidecar only. Flipping the NestJS emitter is a sensor-service change and does not belong in the Rust sidecar PRs. The `phased rollout matrix` in the migration runbook keeps V1 emitters valid during Phase 0-2; this finding tracks the Phase-3 cut-over when TS must match.

**Proposed fix (not for this session):**

1. Update `mqtt-listener.service.ts` to build the `SensorReadingEvent` with flat V2 fields + `raw_value` from the edge payload.
2. Remove the call path into the V1→V2 upcaster (it becomes a read-only legacy translator).
3. Add regression: `mqtt_listener_publishes_sensor_reading_in_v2_flat_format.spec.ts`.
4. Dependencies: `raw_value` must exist in the sensor payload wire format — gated by ADR-026 (sensor-payload raw_value contract) acceptance.

**Blocked by:** ADR-026 merge + Phase-3 of `docs/runbooks/sensor-payload-v2-migration.md`.

---

## OBSERVE-HIGH-002 — Prometheus annotation-based scrape is an injection DoS risk (2026-04-22)

**Status:** OPEN — infrastructure-scope, pre-existing before Rust plan.

**Scope:** `infrastructure/monitoring/prometheus/prometheus-values.yaml:59-78`

**Symptom / evidence:**

The Helm values file declares `additionalScrapeConfigs` that relies on pod annotations (`prometheus.io/scrape: true`) to dynamically discover scrape targets. The same file carries an inline `SEC-NM-018` warning flagging the risk: "Annotation-based pod scraping is a security risk — any pod can inject itself." The risk is documented but the fix was deferred.

**Why it's orphan:**

The Rust plan (`snappy-sniffing-pine.md` Kör Nokta 4) prescribes a **static** scrape-config for `sensor-ingestion` and requires the annotation-based discovery to be disabled — the plan's fix for sensor-ingestion covers that one service. The broader migration (remove annotation-based discovery for ALL services, convert every service to a static job entry) is a platform-observability refactor, not sensor-ingestion scope.

**Proposed fix:**

1. Enumerate every service currently relying on `prometheus.io/scrape` annotations.
2. Add a static job entry per service in `infrastructure/monitoring/prometheus/scrape-configs.yml` (new central file).
3. Remove `additionalScrapeConfigs` from Helm values.
4. Add CI invariant `infrastructure-tests/prometheus-no-annotation-scrape.spec.ts` — fails if any pod spec carries `prometheus.io/scrape`.

**Related:** `docs/observability/metrics-cardinality-policy.md` (created by Kör Nokta 4 in the Rust plan).

---

## EDGE-SECURITY-001 — `sens-api-gateway` OTA firmware update protocol + signing is undocumented (2026-04-22)

**Status:** OPEN — edge-scope, parallel agent owns the gateway codebase.

**Scope:** `sens-api-gateway/` repository surface (no `.github/workflows/*release*.yml` or firmware-signing pipeline found).

**Symptom / evidence:**

The edge gateway is IEC 62443 SL2 hardened (`sens-api-gateway/deny.toml:1-111` enforces tight crate allowlist, TLS-only, OpenSSL banned). However, the **update channel** is silent:

- No cosign / sigstore signing of release artifacts.
- No documented firmware update protocol (how a running gateway on a customer tank replaces its binary).
- No anti-rollback mechanism to prevent downgrade attacks.
- No `release.yml` GitHub Actions workflow for binary builds with attestation.

**Why it's orphan:**

Rust plan Faz 4 mentions edge-adoption of shared crates but does not address the deployment/update channel. The Rust plan's Kör Nokta 9 (`snappy-sniffing-pine.md`) adds cosign/sigstore for the **cloud** sidecar; the edge gateway remains out of scope.

**Proposed fix (separate plan):**

1. ADR for firmware update protocol (signed manifest, two-slot A/B, rollback protection).
2. Release pipeline producing signed binaries + SBOM per target (armv7, aarch64).
3. Gateway runtime verifies signatures against rotated offline CA before accepting update.
4. Fleet management channel (MQTT topic or HTTPS pull) for update delivery + staged rollout.

**Scope dependency:** parallel agent (`agentic-rust-faz0` worktree) owns `sens-api-gateway/` — cross-team coordination required before any change.

---

## PLATFORM-HIGH-001 — `@platform/event-bus` lacks NATS request-reply API (2026-04-22)

**Status:** OPEN — the Rust migration plan depends on this API; the platform lib must provide it.

**Scope:** `platform/libs/event-bus/src/nats/nats-event-bus.ts` (pure pub-sub only).

**Symptom / evidence:**

The TS event-bus exposes `publish`, `subscribe`, `subscribeTo` but no `request` / `respond` primitive. Rust plan Kör Nokta 6 (`snappy-sniffing-pine.md`) requires `policy.ingest_backend.snapshot` request-reply for sidecar boot — the Rust side can use `async-nats::request()` directly, but the TS responder (hosted in `admin-api-service`) needs a symmetric abstraction.

**Why it's orphan:**

Adding request-reply to `@platform/event-bus` is a public-API extension that affects every backend service. It needs its own ADR (ADR-029 in the delta plan), CODEOWNERS review from the platform team, and migration guidance for existing services. The Rust sensor-ingestion PR depends on this landing first, but the platform-lib change is not sensor-ingestion scope.

**Proposed fix:**

1. Draft ADR-029 — NATS request-reply pattern adoption.
2. Extend `NatsEventBus` with `request<T,R>(subject, payload, timeoutMs): Promise<R>` and `respond(subject, handler: (req) => Promise<R>)`.
3. Backwards-compatible: existing pub-sub users unaffected; responders register via explicit `respond()` call.
4. Wire `admin-api-service` as the first responder (for `policy.ingest_backend.snapshot`) and `sensor-ingestion` as the first Rust requester (via async-nats).
5. Tests: timeout handling, error propagation, correlation-id pairing, mTLS cert-only identity preserved.

**Blocks:** Rust migration PR-B (`snappy-sniffing-pine.md` PR-B).

---

## MIGRATE-MEDIUM-001 — `apps/db-migrate` runner rollback workflow not verified (2026-04-22)

**Status:** OPEN — investigation pending; plan assumes bidirectional migrations but runner support unclear.

**Scope:** `apps/db-migrate/src/` (not read during Rust plan audit).

**Symptom / evidence:**

CLAUDE.md (ADR-011) mandates blue-green safe migrations: "nullable → backfill → NOT NULL". TypeORM migrations support `up()` + `down()`. The Rust plan's Kör Nokta 14 requires rollback migrations for V015 (chunk retune), V016 (outbox), V017 (RLS). However, whether the `apps/db-migrate` runner actually invokes `down()` on failure — or offers a CLI `run --down` subcommand — is not verified; the audit did not open the runner source.

**Why it's orphan:**

Verifying + (if needed) implementing the rollback path is runner-infrastructure scope. The Rust plan will write `down()` migrations, but if the runner cannot execute them in production, the rollback promise is hollow. This finding gates the "rollback works" claim in PR-A-safety + PR-B of the Rust plan.

**Proposed fix:**

1. Audit `apps/db-migrate/src/` — does `MigrationRunnerService` support `revertMigration()` / `run --down N`?
2. If missing: add the CLI subcommand + `apps/db-migrate` integration test that runs `up → down → up` round-trip.
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

## 2026-04-29 ORPHAN-D3-BOOT-ORDER-001 — `init_keystore` runs AFTER `init_offline_queue` in main.rs; manifest-aware consumer adoption requires re-ordering

**Where surfaced:** PR-195 Batch #16 (D-3 SQLCipher migration arc — manifest-aware consumer adoption planning).

**Where it lives:** `sens-api-gateway/src/main.rs` boot sequence, current order:
- L3209: `state_guard.init_offline_queue().await`
- L3371: `state_guard.init_license_cache()`
- L3383: `state_guard.init_bytecode_registry_store().await`
- L3394: `state_guard.init_retain_persistence()`
- L3405: `state_guard.init_force_registry_store().await`
- L3492: `state_guard.init_keystore().await`  ← runs AFTER all consumers above

**Why this is a real architectural concern (not just stylistic):**

PR-195 Batches #13-#15 landed manifest-aware constructors on all 4 SQLCipher consumers (`OfflineQueue::with_keystore_derivation`, `LicenseCacheStore::open_with_keystore_derivation`, `SqlitePersistence::new_with_keystore_derivation`, `BytecodeRegistryStore::new_with_keystore_derivation`). Each one takes `Arc<dyn Keystore>` as a required arg + uses `consumer_key_resolver::resolve_consumer_pragma_key` to dispatch v1-vs-v2 derivation per the manifest sidecar.

For `init_offline_queue` / `init_license_cache` / etc. to actually USE these new constructors (the next architectural batch — switch the AppState init callsites), `self.keystore` must be `Some(Arc<dyn Keystore>)` at the time those `init_X` functions execute. Currently it's `None` because `init_keystore` runs LATER in the boot sequence.

**Why the boot-order is currently safe (pre-Batch-16):** the legacy v1-only constructors (`OfflineQueue::with_disk_limit`, `LicenseCacheStore::open`, etc.) derive the SQLCipher key via `offline_queue::derive_db_encryption_key` which only needs `/etc/machine-id` + `/etc/suderra/db.key` — no keystore dependency. So pre-D-3 the boot order didn't matter for these consumers.

**Why the boot-order becomes critical post-Batch-16:** once `init_X` switches to the manifest-aware constructors, `self.keystore.as_ref()?` becomes the entry contract. Calling `init_offline_queue` before `init_keystore` would either fail-closed (refusing to boot the agent) or fall back silently to v1-only (defeating the migration ceremony's whole purpose).

**Architectural fix path (Tier-1 MAKE-IT-IMPOSSIBLE):**

Re-order the boot sequence so `init_keystore` runs FIRST, before any SQLCipher consumer init. The relocation is mechanical:

1. Move the `init_keystore` block from the current line (~3492) to immediately after `init_failover_manager` / `init_health_server` (around line 3200, before `init_offline_queue` at L3209).
2. Verify no dependency cycles: `init_keystore` reads `self.config` + `self.clock_authority` (both set at `AppState::new`); it does NOT depend on any other `init_X`. Safe to relocate.
3. Add a Tier-3 wire-status invariant that pins the order: `tests/invariants/boot_order.rs` asserting `init_keystore` line number < `init_offline_queue` line number in main.rs (grep-based detector — fails CI if a future refactor mis-orders).

**Why this is documented as an ORPHAN (not done in Batch #16):**

Batch #16 extracted `build_production_keystore_from_config` — the SSoT for keystore construction usable from BOTH the AppState boot path AND the future `--migrate-db` CLI dispatch. The boot-order relocation is a SEPARATE architectural concern that interacts with two open questions:

1. **Program-bound consumer init lifecycle (ORPHAN-D3-BOOT-ORDER-002 below).** `init_retain_persistence` + `init_bytecode_registry_store` are PROGRAM-BOUND consumers per ADR-031 — they need `program_artifact_sha256` for the v2 derivation path. At AppState boot time, no program is loaded yet (programs deploy via MQTT post-boot). The keystore being available isn't enough; the program SHA isn't either.

2. **CLI subcommand dispatch wiring (ORPHAN-D3-CLI-DISPATCH-001 below).** `--migrate-db` runs PRE-AppState entirely; it doesn't even have access to `self.keystore`. The bootstrap helper extracted in Batch #16 enables that dispatch site to build its own keystore independently. Independent boot path; doesn't share the AppState boot order.

The boot-order fix is separate from both. Tracking it here so a future architectural batch picks it up.

**State:** OPEN. Owner: okan. No deadline pinned (D-3 closure work; not blocking any other PR).

## 2026-04-29 ORPHAN-D3-BOOT-ORDER-002 — `init_retain_persistence` / `init_bytecode_registry_store` need `program_artifact_sha256` at boot but no program is loaded yet

**Where surfaced:** PR-195 Batch #16 (manifest-aware consumer adoption planning — program-bound flow analysis).

**Where it lives:** `sens-api-gateway/src/main.rs:init_retain_persistence` (L2668) + `init_bytecode_registry_store` (~L2480 area).

**The architectural problem:**

Per ADR-031, the four SQLCipher consumers split into two binding shapes:
- DEVICE-BOUND: `OfflineQueue` + `LicenseCacheStore` — context = `deployment_uuid` (always available at boot via `config.device_id`).
- PROGRAM-BOUND: `SqlitePersistence` + `BytecodeRegistryStore` — context = `program_artifact_sha256` of the currently-loaded program.

Programs deploy via the MQTT command path AFTER agent boot completes. At `init_retain_persistence` / `init_bytecode_registry_store` time, no program is loaded yet, so `program_artifact_sha256` is `None`.

For pre-migration hosts (v1 manifest, or no manifest at all), the resolver's v1 path doesn't read program_sha — `init_X` works fine with empty/None program_sha because the v1 fallback ignores it.

For post-migration hosts (v2 manifest):
- The migration ceremony WAS run at some prior point.
- The ceremony itself faced this same chicken-and-egg: which program SHA does the operator pass to the migration tool when migrating program-bound DBs?
- If the migration tool ran with `program_sha = X`, the consumer DBs were rekeyed to a v2 key derived under `X`.
- At runtime boot, the consumer constructor sees v2 manifest + has no program loaded yet + no SHA available → resolver fires `ProgramSha256Required` → fail-closed.

**Three architectural options to resolve:**

1. **Lazy DB-open: defer SqlitePersistence + BytecodeRegistryStore construction until a program loads.** `AppState.retain_persistence` becomes `None` at boot; the MQTT `cmd_deploy_program` handler initializes them with the program's SHA from the deploy payload. Pro: clean "key context = program context". Con: substantial boot-flow refactor; multiple call sites currently expect `state.retain_persistence` to be populated for the bytecode runner.

2. **Delayed-bind constructor: open the DB at boot WITHOUT applying PRAGMA key, then apply the key when program loads.** Pro: existing AppState shape preserved. Con: SQLCipher requires the key BEFORE any read — the DB cannot be opened "later"; the connection itself must carry the key from open time. Architecturally infeasible.

3. **First-program-deploy migration discipline: program-bound DBs cannot be migrated by the offline ceremony; instead, the agent re-creates them under v2 keys WHEN a program first loads after the migration.** The migration ceremony's `KNOWN_SQLCIPHER_CONSUMERS` excludes program-bound entries; the orchestrator emits `Skipped { reason: ProgramBoundDeferredToRuntime }` for those purposes. The consumer constructors at runtime detect "no v2 manifest + program now loaded" and recreate the DB under v2 atomically.

Option 3 is the cleanest architectural shape — separates the DEVICE-bound and PROGRAM-bound migration cadences; matches the natural lifecycle of program-bound state (re-deployable at any time, no migration needed because the new program's SHA produces a fresh key naturally).

**Why this is documented as an ORPHAN (not done in Batch #16):**

The choice between options 1 and 3 affects the migration ceremony's `KNOWN_SQLCIPHER_CONSUMERS` SSoT, the orchestrator's outcome taxonomy, the per-consumer constructors' contract, AND the boot-flow shape. Substantial design work that deserves its own PR with proper architectural review — not a back-pocket decision inside the broader Batch #16 scope.

**State:** OPEN. Owner: okan. No deadline pinned. Blocking: full D-3 end-to-end functionality (ceremony + runtime adoption) cannot land until this is resolved for program-bound consumers.

## 2026-04-29 ORPHAN-D3-CLI-DISPATCH-001 — `main.rs --migrate-db` arm still calls legacy `run_migration_ceremony` (no MigrationContext); operators can't actually invoke the executor

**Where surfaced:** PR-195 Batches #11-#16 (D-3 migration ceremony arc).

**Where it lives:** `sens-api-gateway/src/main.rs:2823` `--migrate-db` dispatch arm.

**Current state (post-Batch-16):**

PR-195 has landed:
- `run_migration_ceremony_with_context(argv, ctx: MigrationContext)` execute-capable CLI entry (Batch #12)
- `crate::keystore::bootstrap::build_production_keystore_from_config(...)` SSoT helper (Batch #16)
- All 4 per-consumer manifest-aware constructors (Batches #13-#15)

The dispatch arm at `main.rs:2823` still calls the LEGACY `run_migration_ceremony(argv)` (no-context version) which refuses execute mode at runtime with the operator-readable "execution requires MigrationContext" message. So the migration tool is FUNCTIONAL but UNREACHABLE — operators run `--migrate-db --execute` and the agent says "use run_migration_ceremony_with_context" without offering them a path to do so.

**Why not done in Batch #16:**

Wiring the dispatch arm requires:
1. Calling `AgentConfig::load()` inside the `--migrate-db` arm (currently config load is at L2987, AFTER the early subcommand dispatch).
2. Building a clock-authority for the keystore (currently AppState owns this; CLI dispatch needs to pick its own).
3. Building the keystore via `crate::keystore::bootstrap::build_production_keystore_from_config(...)`.
4. Constructing `MigrationContext { device_id, program_artifact_sha256: None, keystore, now_unix }` (program_sha = None pending ORPHAN-D3-BOOT-ORDER-002 resolution).
5. Mapping the `ExitCode` to an `i32` for `std::process::exit`.

That's ~80-100 lines of wire-up code. Bundleable but interacts with the parallel session on PR-211 (which may also touch main.rs's early dispatch). Documented here so the next architectural batch picks it up cleanly without colliding with parallel work.

**Architectural shape for the future batch:**

```rust
// sens-api-gateway/src/main.rs --migrate-db arm:
"--migrate-db" => {
    let sub_argv: Vec<&str> = args.get(2..).unwrap_or(&[])
        .iter().map(|s| s.as_str()).collect();

    // Build a per-call tokio runtime to run the async
    // keystore-build + ceremony orchestrator.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all().build().expect("tokio runtime");
    let exit_code = rt.block_on(async {
        let config = AgentConfig::load()
            .map_err(|e| format!("config load: {e}"))?;
        let clock: Arc<dyn ClockAuthority> = Arc::new(
            crate::runtime_safety::SystemClockAuthority::new(),
        );
        let keystore = crate::keystore::bootstrap::
            build_production_keystore_from_config(
                &config, clock, data_dir::data_dir(),
            )
            .await?
            .ok_or_else(|| "keystore.mode=Disabled; cannot run migration".to_string())?;
        let ctx = crate::db_migration::cli::MigrationContext {
            device_id: config.device_id.clone(),
            program_artifact_sha256: None, // see ORPHAN-D3-BOOT-ORDER-002
            keystore,
            now_unix: chrono::Utc::now().timestamp(),
        };
        Ok::<_, String>(
            crate::db_migration::cli::run_migration_ceremony_with_context(
                &sub_argv, ctx,
            ),
        )
    });

    std::process::exit(match exit_code {
        Ok(code) if format!("{code:?}").contains("status(0)") => 0,
        _ => 1,
    });
}
```

**Why this is the right call (Tier-1):** keeping policy concerns separate from transport-config concerns means a future transport (e.g., LoRa, gRPC) can plug in its own CA-path field without mTLS policy knowing or caring. Coupling them would make adding a transport require a Coherence Rule update. Architectural minimalism beats theoretical completeness.

---

## ORPHAN-HIGH-035 — `install_default()` global CryptoProvider state writes the unrestricted ring provider; HTTPS outbound (provisioning, firmware, scripting cloud calls) does not honor the cipher allowlist (Phase 1.1.3 follow-up, 2026-04-30)

**Status:** RESOLVED — Phase 1.1.5 (PR #227, 2026-05-04). `mqtt.rs::install_default()` removed. `commands/firmware.rs::download_file` (the missed 4th reqwest callsite — `fetch_latest_agent_tag` was already wired in Phase 1.1.3a but `download_file` was not) now plumbs `build_suderra_https_client_config` via `use_preconfigured_tls`. Two new invariants pin the closure: `no_install_default_in_non_test_code` (source-grep ban on `default_provider().install_default()`) and `every_reqwest_client_builder_uses_preconfigured_tls` (1:1 callsite parity per file). Tier-1 MAKE-IT-IMPOSSIBLE — a future regression that bypasses the allowlist surfaces as a rustls-panic-at-builder-call rather than silent TLS 1.2 downgrade exposure.

**Scope:** `sens-api-gateway/src/mqtt.rs:963` (install_default), `sens-api-gateway/src/firmware.rs:591`, `sens-api-gateway/src/provisioning.rs:218`, `sens-api-gateway/src/scripting/engine.rs:1963`.

**Severity rationale (HIGH not MEDIUM):** edge-expert reviewer flagged this — `provisioning.rs:218` carries the **single-use device-bootstrap token exchange** (the most security-critical of the four reqwest callsites). A successful TLS 1.2 cipher-suite-downgrade attack on that endpoint compromises a device's identity bootstrap. The other three (firmware download, scripting cloud fetches, telemetry posts) are also material attack surfaces. Severity reflects worst-case attack-surface impact, not just code-locality.

**Impact:** Phase 0.2 narrows the *MQTT* transport to TLS 1.3 + 3-suite allowlist via explicit `builder_with_provider(suderra_provider)`. The `rustls::crypto::ring::default_provider().install_default()` call on line 963 still installs the **unrestricted** ring provider as the process-wide default. Anything that builds a rustls `ClientConfig` without an explicit provider — currently every cloud HTTPS reqwest client — pulls the unrestricted provider's full cipher list, including TLS 1.2 ECDHE suites. Cloud HTTPS does not honor the cipher allowlist or the TLS 1.3 pin.

**WHY this is a finding, not part of Phase 0:** Phase 0 scope is "make Strict + custom-CA reachable" + "fix dead-code cipher gate on the MQTT path". Phase 1.1.3 in the approved plan owns "HTTPS outbound (cloud client) custom verifier wire" — that's the right place to plumb the Suderra provider into the cloud HTTPS path (via `reqwest::ClientBuilder::use_preconfigured_tls(rustls_config)` where the rustls_config is built with `ClientConfig::builder_with_provider(suderra_provider)`).

**HOW to resolve in Phase 1.1.3:** unify the cloud HTTPS path to use the same `MtlsVerifierState::current()` + `build_suderra_crypto_provider()` shared by the MQTT path. Then either remove the `install_default()` call (forcing every callsite to opt in explicitly) or accept it as a fail-soft fallback for any code path that doesn't yet use the AppState-shared verifier. Resolution shape locked to Phase 1.1.3 batches.

---

## ORPHAN-MEDIUM-036 — `parse_errs > 0` on custom CA bundle load is partial-fix logged only; full audit-sink HMAC chain emit deferred (Phase 0.1 partial fix, 2026-04-30)

**Status:** RESOLVED — Phase 1.1.5 (PR #227, 2026-05-04). `mqtt.rs::configure_tls` partial-load arm now calls `crate::audit::try_emit_mtls_forensic_event` with the new `MtlsCaBundleParsePartial` AuditAction (wire_tag 31) alongside the existing `tracing::error!`. Architectural channel: process-global audit-sink accessor (`current_audit_sink`) installed at boot in `state.rs::init_audit_sink` so the cross-cutting forensic-emit surface (which has no AppState reference at configure_tls time) reaches the ADR-020 HMAC chain unconditionally. Invariants `ca_bundle_partial_load_emits_audit_event` + `audit_global_accessors_present` pin the closure.

**Scope:** `sens-api-gateway/src/mqtt.rs` (custom-CA PEM parse loop, around line 1037-1066).

**Phase 0 partial fix (already applied):** per-entry parse failures now emit at `tracing::error!` severity (not `warn!`), and a summary `error!` event `mtls_ca_bundle_partial_load` fires when `parse_errs > 0 && added > 0`. Structured-log subscribers treating error-level as audit-relevant capture this. IEC 62443 FR3 (System Integrity) baseline coverage achieved.

**Remaining work (deferred to Phase 1.1.3):** the full architectural fix is to emit through the ADR-020 audit-sink HMAC chain (not just tracing). That requires importing the audit-sink API (`AuditSink`, `AuditEvent`, `audit.emit(...)`) into `configure_tls`, which currently has no audit-emit dependency. Phase 1.1.3 owns the broader audit-emit completion arc (paired with `ORPHAN-MEDIUM-037` Strict-reject audit emit), so adding the import + wiring there avoids two separate audit-import waves. Add an integration test that injects a 3-cert bundle with the middle entry malformed and asserts the structured event fires.

---

## ORPHAN-MEDIUM-037 — Strict-mode handshake reject relies on `tracing::error!` only; explicit audit-sink emit for HMAC chain coverage is needed (Phase 0 follow-up, 2026-04-30)

**Status:** RESOLVED — Phase 1.1.5 (PR #227, 2026-05-04). `SuderraServerCertVerifier::verify_server_cert` Strict-reject arm now calls `crate::audit::try_emit_mtls_forensic_event` with the new `MtlsHandshakeRejectStrict` AuditAction (wire_tag 30). Structured detail per the orphan-finding spec: `{ leaf_fingerprint_prefix (8 hex chars from SHA-256), mode, reason, chain_depth }`. The handshake-abort below the emit remains the primary security action; audit-sink emit is forensic post-mortem evidence anchored in the HMAC chain. Architectural channel: process-global accessor pattern shared with ORPHAN-MEDIUM-036 — verifier callback has no AppState path; the global is installed once at `init_audit_sink`. Invariants `strict_reject_arm_emits_audit_event` + `audit_global_accessors_present` + `boot_installs_global_audit_accessors` pin the closure end-to-end.

**Scope:** `sens-api-gateway/src/mtls/rustls_verifier.rs:205-213` (Strict-mode reject arm).

**Security-reviewer surfaced:** the Strict-mode reject path emits `tracing::error!` and returns `rustls::Error::General` to abort the handshake. The handshake-abort is correct (security-critical action fires). BUT the `tracing::error!` does NOT automatically flow into the ADR-020 audit-sink HMAC chain. Audit emit is invoked explicitly by code paths that call the audit-sink API; whether a tracing subscriber bridges error-level events to audit is deployment-config-dependent. Operators relying on audit-stream alerting may not see Strict rejections in the chain.

**HOW to resolve (Phase 1.1.4):** add explicit audit-sink emit alongside `tracing::error!` in the Strict-reject arm, with structured fields `{ leaf_fingerprint_prefix, mode, reason, timestamp_unix }` tagged `event_type=mtls_strict_reject`. Defense-in-depth: handshake-abort is still the primary security action; audit-emit is for forensic post-mortem.

---

## ORPHAN-LOW-038 — `cipher.rs` documents why TLS 1.3 CCM-mode suites are intentionally absent (Phase 0.2 doc-comment update, 2026-04-30)

**Status:** RESOLVED — Phase 0 PR-PRE Batch 0.2 doc-comment update.

**Scope:** `sens-api-gateway/src/mtls/cipher.rs` module doc-comment.

**Resolved:** the doc-comment now explains that `ring`'s `default_provider()` does NOT ship CCM-mode AEADs (`TLS_AES_128_CCM_SHA256` 0x1304, `TLS_AES_128_CCM_8_SHA256` 0x1305), so adding them to `CIPHER_SUITE_ALLOWLIST` would not enable them — and that ChaCha20-Poly1305 already covers the no-AES-NI fast path that CCM optimizes for IoT-AES-only-hardware deployments.

---

## ORPHAN-HIGH-039 — `cmd_update_cert_pinning` MUST validate `bridge_until_unix_secs > now + min_bridge_window_secs` to prevent fleet bridge-stranding via past-time bridge windows (Phase 1.1.2, 2026-04-30)

**Status:** RESOLVED — Phase 1.1.5 (PR #227, 2026-05-04). `pinning.rs` now exposes `MIN_BRIDGE_WINDOW_SECS: i64 = 3600` const + `validate_bridge_window(bridge_until, now) -> Result<(), BridgeWindowError>` validator + `CertRotationStage::try_bridge_rotation` smart constructor. `build_rotation_stage_from_pins_hex` routes its 2-pin path through the smart constructor; the architectural channel is established BEFORE the Phase 1.2 signed-manifest deser path that exposes operator-controlled `bridge_until` lands. Invariant `bridge_window_floor_enforced_at_construction_sites` pins the discipline: any future BridgeRotation construction site outside `pinning.rs` (rustls_verifier.rs, commands/cert_pinning.rs, future apply_signed_manifest.rs) MUST go through `try_bridge_rotation` rather than direct enum-variant construction. 7 unit tests cover the validator boundary cases (exact floor rejected, 1s past floor accepted, past-time rejected, negative-now rejected, saturating-add no-wrap, smart-constructor wire integrity, Display contains floor const).

**Scope:** `sens-api-gateway/src/commands/cert_pinning.rs` (TBD — Phase 1.1.2 introduces this file), and `sens-api-gateway/src/mtls/pinning.rs:107-133` (`accepted_fingerprints` BridgeRotation collapse logic).

**Security-reviewer surfaced:** Phase 1.1.2 will add `cmd_update_cert_pinning` MQTT command that accepts an ed25519-signed `CertRotationStage` payload and applies it via `MtlsVerifierState::rebuild`. The `BridgeRotation { incoming, outgoing, bridge_until_unix_secs }` shape collapses to "incoming only" once `bridge_until` has passed (`pinning.rs:107-133`). If `cmd_update_cert_pinning` accepts a manifest with `bridge_until_unix_secs` set in the past, the agent immediately collapses to "accept only `incoming`", and if `incoming` is wrong (operator typo, malicious cloud manifest), every TLS handshake will fail-closed in Strict mode → device strands. A poisoned cloud manifest could brick a fleet simultaneously.

**HOW to resolve (Phase 1.1.2):** in `cmd_update_cert_pinning` parse path, BEFORE applying the new rotation stage, validate: for `Settled { current }` no extra check; for `BridgeRotation { incoming, outgoing, bridge_until_unix_secs }` assert `bridge_until_unix_secs > now_unix + MIN_BRIDGE_WINDOW_SECS` where `MIN_BRIDGE_WINDOW_SECS = 3600` (1 hour floor). Reject with audit event if violated. Defense-in-depth pairing: add the same guard to the cloud-side manifest-signing service.

---

## ORPHAN-LOW-040 — `mqtt.rs` clones the `RootCertStore` instead of threading one `Arc<RootCertStore>` through both arms (Phase 0.1 refactor opportunity, 2026-04-30)

**Status:** RESOLVED — Phase 1.1.4 (organic, before Phase 1.1.5 audit). The unified `mqtt.rs::configure_tls` pipeline now builds `let root_store_arc = Arc::new(root_store)` once + clones the `Arc` (cheap reference-count bump) into BOTH `MtlsVerifierState::new` AND `build_fallback_webpki`. The pre-Phase-1.1.4 HC-1-fallback path that consumed the bare `RootCertStore` (forcing the `root_store.clone()` of all anchors) was eliminated when `MtlsDelegatingVerifier` wrapped both branches under a single delegating verifier. No standalone closure commit — the refactor was load-bearing for Phase 1.1.4 D-6 unified assembly and the `Arc<RootCertStore>` shape fell out as a positive side effect. Verified at Phase 1.1.5 audit (`mqtt.rs::configure_tls` reads as `let root_store_arc = Arc::new(root_store);` then `root_store_arc.clone()` on both wires).

**Scope:** `sens-api-gateway/src/mqtt.rs` configure_tls.

**Edge-expert surfaced:** the unified pipeline does `let root_store_arc = Arc::new(root_store.clone())` to feed the verifier (which needs `Arc<RootCertStore>` for shared ownership), then the HC-1 fallback path consumes the original `root_store` via `with_root_certificates(root_store)`. Two separate copies of identical cert anchors at runtime — for system-CA bundles this can be ~150 certs. Memory overhead is small (a few KB) but architecturally cleaner to thread one `Arc<RootCertStore>` through both arms. Not a security concern; minor refactor.

**HOW to resolve:** restructure so root_store is built once into `Arc<RootCertStore>`, passed by clone-of-Arc (cheap) into both `build_suderra_verifier` and `with_root_certificates_arc` (rustls 0.23 has both `with_root_certificates(RootCertStore)` and `with_root_certificates_arc(Arc<RootCertStore>)`).

## 2026-04-30 ORPHAN-SENS-GATEWAY-LORAWAN-001 — `lorawan` feature coupled portable protocol code to unavailable SX1302 vendor HAL

**Status:** RESOLVED — fixed in `sens-api-gateway` by splitting the hardware build contract from the portable protocol feature.

**Scope:** `sens-api-gateway/Cargo.toml`, `sens-api-gateway/build.rs`, `sens-api-gateway/src/lora/sx1302.rs`, release/clippy jobs that enable `--features lorawan`.

**Observation:**

The `lorawan` feature was serving two incompatible roles:

- enabling portable LoRaWAN protocol code (`aes`, `cmac`, `lorawan` crate);
- enabling the Semtech SX1302 C HAL build (`cc`, `bindgen`, `glob`, `vendor/sx1302_hal`).

That meant CI and portable release builds could not compile the LoRaWAN protocol surface unless the proprietary/externally-provisioned SX1302 HAL source tree was present. The failure mode was not a normal missing optional dependency; `build.rs` attempted to generate bindings for C sources that are intentionally absent from the repository.

**Why this creates production risk:**

The old feature boundary made a pure protocol build depend on local hardware-vendor artifacts. A CI runner, laptop, or non-gateway build host could fail before Rust type checking reached the application layer. The result was a blind spot: protocol changes and release-only regressions were hidden behind an unrelated HAL availability failure.

**Architectural fix:**

The feature boundary is now explicit:

- `lorawan` enables portable protocol support only.
- `sx1302-vendor-hal` enables the real Semtech HAL and fails closed if `vendor/sx1302_hal` is absent.
- `src/lora/sx1302.rs` uses the simulation backend unless `sx1302-vendor-hal` is selected.
- `build.rs` is fallible without `expect()` and documents the hardware-vendor contract at the build boundary.

**Related issue discovered on the same path:**

The same CI pass exposed a second architectural drift: `main.rs` kept using pre-0.27 `opentelemetry-otlp` pipeline helpers (`new_exporter`, `new_pipeline`). That was not caused by LoRaWAN, but it became visible only after validating the full curated feature set. The fix replaces the removed helpers with explicit `SpanExporter` and `TracerProvider` construction so telemetry boot contracts remain visible and type-checked.

**Closure path:**

Future hardware-only work must opt into `sx1302-vendor-hal`; portable protocol CI must keep using `lorawan` without vendor C sources. Re-coupling the features would reintroduce the same build-host dependency leak.

## ORPHAN-HIGH-045 — async-opcua 0.18 has no `ClientCertVerifier` callback hook on `ServerBuilder`; per-handshake `OpcUaCertRejected` audit emit has no insertion point (Phase B-1 gap, 2026-05-04)

**Status:** OPEN — owner: Okan-Wqm. Owner agent: Phase B-2 / future PR (pre-Faz B-2 main batch). Deadline: opportunistic, no hard date — gated on either an upstream async-opcua PR or a session-establishment interceptor at the runtime layer.

**Scope:** `sens-api-gateway/src/opc_ua_server_runtime.rs::build_server` + the `async-opcua = "0.18"` crate's `ServerBuilder` API.

**Edge-expert surfaced:** ADR-031 §4 specifies an `OpcUaCertRejected` AuditAction emitted from the per-handshake reject path — analog of the mTLS module's `MtlsHandshakeRejectStrict` (ORPHAN-MEDIUM-037 closure). Phase B-1 ships the architectural state machine (PkiStore + CertRotation + StrictPinOnly mode) but the per-handshake REJECT EMIT is structurally unreachable at the agent layer because async-opcua 0.18's `ServerBuilder` exposes `pki_dir(&Path)` + `trust_client_certs(bool)` without a custom verifier callback. async-opcua's built-in trust path consumes `<pki_root>/trusted/clients/` + `<pki_root>/rejected/` PEMs and emits its own `tracing::error!` line on reject — but does not call any user-supplied closure that could touch the AuditSink.

**Impact:** in `StrictPinOnly` mode, an unpinned cert IS rejected (handshake abort is the primary security action — load-bearing). The forensic emit on the reject is shimmed via async-opcua's tracing line, NOT a direct ADR-020 audit-sink HMAC chain entry. Operators relying on offline `audit-verify` CLI to reconstruct rejected-handshake timelines would not see OPC UA rejects in the chain. Cross-transport mTLS audit consistency (mTLS module ships per-handshake emit via Phase 1.1.5 ORPHAN-MEDIUM-037) is the comparison point — OPC UA forensic surface lags MQTT.

**HOW to resolve (two architectural paths, decided in Phase B-2):**

1. **Upstream async-opcua PR** — add `with_client_cert_verifier(impl Fn(&Cert) -> ClientCertDecision + Send + Sync)` callback to `ServerBuilder`. Suderra implements the closure to forward `(fingerprint, decision)` pairs to `audit::try_emit_mtls_forensic_event`. Pros: clean architectural shape, contributes upstream. Cons: PR review + merge timeline outside our control.

2. **Session-establishment interceptor at the runtime layer** — wrap the `(server, handle)` returned by `ServerBuilder::build()` with a layer that drives the audit emit BEFORE async-opcua's internal accept/reject. async-opcua 0.18 exposes `ServerHandle::on_session_establish` or similar (verify in the API doc); the wrapper subscribes + emits to the audit chain on every session reject event. Pros: agent-side fully owned. Cons: depends on async-opcua exposing the hook surface; if not, falls back to wrapping the underlying `tokio::net::TcpListener` accept path which is brittle.

The decision is recorded in ADR-031 §5 "Open items"; the upstream-PR path is preferred. If the PR lands within 4 weeks of Phase B-2 start, that's the closure; if not, the interceptor approach is the fallback.

---

## ORPHAN-MEDIUM-046 — PkiStore `initialize_own_keypair` uses hardcoded `suderra-edge.local` SAN; not bound to device_code (Phase B-1 placeholder, 2026-05-04)

**Status:** RESOLVED-NOT-APPLICABLE-NOW (architectural decision documented). The own-cert SAN binding is a Phase B-1.5 / Phase C concern — operator-controlled cert mint via signed manifest infrastructure, not an agent-side change.

**Scope:** `sens-api-gateway/src/opc_ua_server/pki_store.rs::initialize_own_keypair`.

**Edge-expert surfaced:** Phase B-1 mints the OPC UA server's own keypair on first boot via `rcgen::generate_simple_self_signed(vec!["suderra-edge.local".to_string()])`. The SAN string is hardcoded — multiple devices in a fleet would all advertise the same SAN. HMIs that perform hostname verification against the cert's SAN field would either accept all devices as one identity (poor) or reject when the hostname mismatches (also poor).

**Why this is intentional for Phase B-1:** the agent does NOT mint operator-trusted certs via `rcgen`. The pre-B-1 path used `async-opcua::create_sample_keypair(true)` which has the SAME architectural shape (deterministic placeholder SAN). Phase B-1's `rcgen` mint is a like-for-like replacement preserving the pre-B-1 contract — operators who want HMI-verifiable certs ALWAYS provide their own via the `<pki_root>/own/cert.der` + `key.pem` files (the `initialize_own_keypair` path is the bootstrap-fallback for first-boot before operator provisioning).

**HOW to resolve (Phase B-1.5+):**

The cleanest architectural shape is to plumb a cloud-signed `opc_ua_own_cert_manifest_v1` payload through the `cmd_update_opc_ua_pki` MQTT command (Phase C). The manifest carries `(device_code, cert_der, key_blob)` minted by the cloud-side ceremony per ADR-021. The agent's `initialize_own_keypair` becomes a fallback for the unlikely case that the manifest never arrives — the SAN binding moves to the cloud-side ceremony where device_code is the canonical input. Until Phase C, operators continue to provide their own cert via filesystem (the pre-B-1 path).

This finding is filed for completeness — no agent-side change is the right architectural call until Phase C ships. **STATUS RESOLVED via design decision — no further action.**

---

## ORPHAN-LOW-047 — Operator migration tool `suderra-agent --opcua-keypair-migrate` CLI flag deferred (Phase B-1 commit message commitment, 2026-05-04)

**Status:** OPEN — owner: Okan-Wqm. Owner agent: Phase B-1.5 / future PR. Deadline: opportunistic — gated on the first operator upgrade-in-place from a pre-B-1 agent that shipped under `async-opcua::create_sample_keypair(true)` self-generated keys.

**Scope:** Phase B-1 commit message named the migration tool but did not deliver it. Pre-B-1 agents that auto-generated their own keypair via async-opcua's built-in `create_sample_keypair(true)` write to `<config.own_pki_dir>/private/private.pem` + `<config.own_pki_dir>/own/cert.der` (location varies by async-opcua version). Phase B-1's PkiStore writes to `<root>/own/key.pem` + `<root>/own/cert.der` — different filesystem layout. An in-place upgrade boots into PkiStore::open_or_initialize which sees no PkiStore-managed keypair, mints a fresh one, and the OPC UA server presents a DIFFERENT SAN/fingerprint to HMIs across the upgrade — every HMI's pinned-cert config breaks.

**HOW to resolve:**

Add `suderra-agent --opcua-keypair-migrate` flag that:

1. Detects the pre-B-1 keypair location via known variants (async-opcua 0.16 / 0.17 / 0.18 paths).
2. Copies the cert + key into the PkiStore-managed `<root>/own/` location.
3. Records the migration in a new `LedgerEntry::OwnKeypairMigrated { source_path, source_async_opcua_version }` ledger variant.
4. Idempotent — running twice is a no-op.
5. Boot-time check: if `<root>/own/cert.der` is absent AND `--opcua-keypair-migrate` was not run AND the legacy paths exist, agent fails-fast at boot with operator-actionable error message.

The flag is delivered when an operator with a real pre-B-1 fleet asks for it — until then this finding documents the upgrade-in-place gap so operators planning migrations can see the full picture.

---

## ORPHAN-MEDIUM-048 — Phase C `opc_ua_pki_manifest_v1` deser path NOT implemented; `cmd_update_opc_ua_pki` MQTT command absent (Phase B-1 architectural commitment, 2026-05-04)

**Status:** OPEN — owner: Okan-Wqm. Owner agent: Phase C / future PR. Deadline: gated on the cloud-side manifest signing ceremony (ADR-021 §1) being available — an agent-side `cmd_update_opc_ua_pki` handler without the cloud-side signed payload has nothing to verify against.

**Scope:** `sens-api-gateway/src/commands/cert_pinning.rs` analog for OPC UA — does not yet exist. The architectural placeholder is the `CertRotation::transition_to` API that the future command handler will drive.

**Edge-expert surfaced:** Phase B-1 ships the AGENT-side state machine (PkiStore + CertRotation + Tier-1 downgrade gate + Strict-with-empty-pin-set gate). What's missing is the operator-facing surface — an MQTT command with the same envelope-auth + RBAC permission gate + audit emit pattern as Phase 1.1.2's `cmd_update_cert_pinning`. The architectural shape is settled; only the wire is pending.

**HOW to resolve (Phase C):**

1. **Cloud-side first:** mint `opc_ua_pki_manifest_v1` payload format — ed25519-signed JSON with `{ device_code, target_mode, trusted_certs[], revoked_certs[], policy_version }`. HSM key separation: cloud-side OPC UA PKI signing key MUST be a distinct HSM slot from the RBAC manifest signing key (per ADR-021 §1).

2. **Agent-side wire:**
   - New `commands/opc_ua_pki.rs::cmd_update_opc_ua_pki` handler — verify signature against the OPC UA PKI signing pubkey from the running RBAC manifest (or a separate `opc_ua_pki_pubkey_hex` config field), JTI replay defense, parse target_mode + cert lists.
   - Apply: for each cert in `trusted_certs[]`, call `PkiStore::add_trusted_cert`; for each in `revoked_certs[]`, `PkiStore::revoke_cert`; finally `CertRotation::transition_to(target_mode)`.
   - The Tier-1 downgrade gate inside `CertRotation::transition_to` enforces the policy floor — even an authenticated cloud manifest cannot silently roll the fleet back.
   - Audit: ORPHAN-MEDIUM-048 closure emits the cloud-driven manifest application alongside the per-mutation OpcUaCertTrusted / OpcUaCertRevoked / OpcUaPkiPhaseTransition entries (Phase B-1.5 audit-sink wire).

3. **Permission enum:** add `Permission::ManageOpcUaPki` (analog of `Permission::ManageCertPinning` from Phase 1.1.2). HSM-slot separation on the cloud side mirrors at the RBAC layer — operators with `ManageCertPinning` (MQTT mTLS authority) do NOT auto-inherit `ManageOpcUaPki` (OPC UA PKI authority).

The finding is named here so future Phase C planners see the AGENT-side architectural readiness + the cloud-side blocking dependency in one place.

---

## ORPHAN-MEDIUM-049 — 72-hour rollback window primitive deferred from Phase B-1 (ADR-031 §2 commitment, 2026-05-04)

**Status:** OPEN — owner: Okan-Wqm. Owner agent: Phase B-1.5 / future PR. Deadline: paired with the Phase C `cmd_update_opc_ua_pki` handler (a rollback-window primitive without an operator surface that exercises rollback is dead code).

**Scope:** `sens-api-gateway/src/opc_ua_server/cert_rotation.rs` + `pki_store.rs::ledger_entries`.

**Architectural design (ADR-031 §2):** within 72 hours of a failed `PhaseTransition`, an operator can push an out-of-band "emergency rollback" manifest that REVERSES the most recent transition. Beyond 72h, the rollback discipline is "mint a fresh leaf + new rotation" — the ledger never deletes history. The 72h window is a deliberate trade-off: short enough to deter operators from treating downgrades as routine, long enough to absorb a real rollback ceremony's coordination time.

**HOW to resolve (Phase B-1.5 primitive + Phase C wire):**

1. **Primitive:** new `cert_rotation.rs::rollback_window_check(now_unix_secs) -> RollbackEligibility` that walks the ledger via `PkiStore::ledger_entries`, locates the most recent `LedgerEntry::PhaseTransition`, computes elapsed time, returns `Eligible { previous_mode, expires_at_unix }` if `now < transition_ts + 72*3600` else `Expired`.

2. **API:** new `CertRotation::rollback_to_previous(now)` that:
   - Calls `rollback_window_check`; rejects with `RollbackWindowExpired` if not eligible.
   - Computes `previous_mode` from the second-most-recent PhaseTransition (or LegacyAccept if only one transition recorded).
   - **Bypasses** the Tier-1 downgrade gate — rollback IS a downgrade by definition. Architectural justification: the rollback path requires the same envelope-auth + RBAC permission gate as a forward transition AT THE COMMAND-DISPATCH LAYER, so the bypass is auditable + operator-controlled, not silently weakening the floor.
   - Emits a distinct `LedgerEntry::PhaseRollback { rolled_back_to, original_transition_seq }` so audit-stream consumers can distinguish rollbacks from forward transitions.

3. **Wire:** Phase C's `cmd_update_opc_ua_pki` handler accepts an optional `rollback: true` flag in the manifest payload. When set, the handler dispatches to `rollback_to_previous` instead of `transition_to`. The 72h floor is the architectural gate; even a signed manifest cannot rollback past the window.

The finding is named here so the deferred primitive has a tracked target rather than a vague "future Phase B-1.5" comment in the ADR text.

---

## ORPHAN-MEDIUM-050 — Phase B-1 own-cert validity not bounded by SL-2 max-age policy (Phase B-1 review, 2026-05-04)

**Status:** OPEN — owner: Okan-Wqm. Owner agent: Phase B-1.5 / future PR. Deadline: opportunistic.

**Scope:** `sens-api-gateway/src/opc_ua_server/pki_store.rs::initialize_own_keypair`.

**Edge-expert surfaced:** the mTLS module (`mtls/mode.rs`) ships `MAX_LEAF_CERT_AGE_DAYS_LEGACY/WARN/STRICT` policy cap — the rustls verifier rejects leaf certs older than the mode-dependent threshold. The OPC UA `PkiStore::initialize_own_keypair` path uses `rcgen::generate_simple_self_signed` which defaults to a far-future `not_after` (rcgen's default validity is on the order of years). There is no equivalent age-cap policy enforced on the OWN cert.

**Why this matters:** the own-cert is what the OPC UA server presents to HMIs. A long-lived self-signed own-cert means a single key compromise persists for years — the operator has no rotation discipline at the OWN-CERT layer (only at the trusted-clients layer via `add_trusted_cert` / `revoke_cert`). A symmetric architectural shape would require the OWN cert to also age-rotate.

**HOW to resolve (Phase B-1.5):**

1. **Configurable validity:** new `PkiStore::initialize_own_keypair` parameter `validity_days: u32` derived from `OpcUaPkiMode::own_cert_max_age_days()` (analog of `MtlsMode::max_leaf_cert_age_days`). LegacyAccept = 365 days, WarnOnMismatch = 180, StrictPinOnly = 90.

2. **Boot-time age check:** when reloading existing PkiStore (not first-boot), read `<root>/own/cert.der`, parse `not_before` via x509-parser, compare to `now`. If age exceeds the active mode's threshold, log a warn + flip the agent into a "expired-own-cert" state where the OPC UA server refuses to start until the operator runs `--opcua-rotate-own-keypair`. Fail-closed so operators see the rotation requirement.

3. **Architectural symmetry:** the own-cert age policy mirrors the trusted-client age policy (mtls/mode.rs). Same operator mental model spans both transports.

The finding is named here so the Phase B-1.5 batch has a tracked target rather than discovering this gap during a security review of the production OPC UA fleet.

## ORPHAN-MEDIUM-051 — OPC UA brute-force throttle is per-username, NOT per-IP; cross-account credential-spray from a single source not detected (Phase B-2 architectural decision, 2026-05-05)

**Status:** OPEN — owner: Okan-Wqm. Owner agent: Phase B-2.5 / future PR. Deadline: gated on either an upstream `async-opcua` PR exposing `ClientAddr` in the AuthManager trait OR a TCP-listener interceptor at the runtime layer.

**Scope:** `sens-api-gateway/src/opc_ua_server/auth_throttle.rs::FailedAuthWindow` + `sens-api-gateway/src/opc_ua_sens_auth_manager.rs::authenticate_username_identity_token`.

**Edge-expert surfaced:** Plan §B-2 specifies "per `ClientAddr` sliding window". async-opcua 0.18's `AuthManager` trait does NOT expose the client TCP address at the `authenticate_*_identity_token` callsite — only the `username: &str` (UserName/Password path) or the cert thumbprint (X.509 path). Per-IP throttling at this layer is structurally impossible without an upstream API change. This is the same architectural class as ORPHAN-HIGH-045 (per-handshake `ClientCertVerifier` callback hook gap) — both surface async-opcua 0.18 trait limits at agent-side callsites that need richer context.

**What Phase B-2 delivers (per-username throttle):**

- An attacker pounding `admin:wrong-pass` 100 times sees a hard cap at 20/60s, regardless of source IP. Argon2id CPU exhaustion is bounded.
- An operator typoing 3 times and succeeding on the 4th does not get locked out (clear_on_success).

**What Phase B-2 misses (per-IP gap):**

- An attacker rotating through 1000 distinct usernames at 1 attempt each within 60 seconds is NOT throttled per-username (each username has only 1 failure). The CPU exhaustion at 1000 × Argon2id-cost per minute happens despite the throttle.
- The `OpcUaServerConfig.max_failed_auth_per_60s` field name is a misnomer for this case — it's actually per-username, not per-IP.

**HOW to resolve (two architectural paths, same class as ORPHAN-HIGH-045):**

1. **Upstream `async-opcua` PR** — extend the `AuthManager::authenticate_*_identity_token` signatures with a `client_addr: SocketAddr` parameter. Suderra's `SensAuthManager` then consumes it + builds an additional `AuthThrottleKey::for_addr(addr)` bucket. Both per-username + per-IP throttles coexist (independent buckets, both must clear). Pros: clean architectural shape, upstream contribution. Cons: PR review timeline outside our control.

2. **TCP-listener interceptor at the runtime layer** — wrap the `tokio::net::TcpListener` accept path BEFORE `ServerBuilder::build()` consumes it. The interceptor extracts the peer SocketAddr at accept time + stashes it in a `tokio::task_local!` scope that the AuthManager method body can read. Pros: agent-side fully owned. Cons: depends on async-opcua exposing the listener for operator override; if not, requires forking the crate.

**Why this is logged as MEDIUM (not HIGH):**

- Per-username throttle delivers ~80% of the security goal — the most common credential brute-force attack pattern is account-targeted (one username, many password guesses). Cross-account spray is a more sophisticated attacker.
- The per-attempt Argon2id cost + the global `max_sessions=10` cap (Batch 228) provide a coarse upper bound on CPU exhaustion even without per-IP throttling.
- Closure path is the same as ORPHAN-HIGH-045 (async-opcua hook gap class) — fixing one likely fixes both.

The architectural decision is documented in `auth_throttle.rs` preamble + this orphan finding so future planners + auditors see the gap explicitly.

## ORPHAN-MEDIUM-052 — OPC UA SessionLease decrement-on-close depends on TTL fail-safe; no async-opcua session-close callback hook (Phase B-3 architectural decision, 2026-05-05)

**Status:** OPEN — owner: Okan-Wqm. Owner agent: Phase B-3.5 / future PR. Deadline: gated on either an upstream `async-opcua` PR exposing a session-lifecycle callback OR an integration with the existing `ServerHandle` event surface (verify in async-opcua 0.18 API doc).

**Scope:** `sens-api-gateway/src/opc_ua_server/session_quota.rs::SessionLease` lifetime + `sens-api-gateway/src/opc_ua_sens_auth_manager.rs::active_leases` per-token registry.

**Edge-expert surfaced:** Phase B-3 ships the per-tenant + per-user session quota with `SessionLease` RAII Drop decrementing the count. In the ideal world, the lease lives exactly as long as the corresponding async-opcua session — Drop fires on session-close. Reality: async-opcua 0.18's `AuthManager` trait does not pass the lease ownership to async-opcua in a way that ties to the session lifetime. The lease lives in the SensAuthManager-side `active_leases: HashMap<UserToken, SessionLease>` registry, which has no automatic invalidation on session-close.

**Impact:** a session that closes without an explicit lease release (TCP RST, async-opcua silent drop, network interruption) keeps consuming a quota slot until the TTL fail-safe (`LEASE_FAIL_SAFE_TTL = 1 hour`) evicts it. Defense-in-depth: the global `Limits.max_sessions = 10` cap (Batch 228) is the hard floor, so total sessions cannot exceed 10 even if our per-(tenant, user) counter has TTL imprecision. But within that 10-cap, a single user could repeatedly establish + crash-disconnect sessions; each crash-disconnect leaves a stale lease, eventually starving other users for up to 1 hour.

**HOW to resolve (Phase B-3.5 / B-2.5 paired):**

1. **Upstream `async-opcua` PR** — add `ServerHandle::on_session_close(impl Fn(SessionId, UserToken) + Send + Sync)` callback. Suderra's SensAuthManager subscribes + drains `active_leases` keyed by UserToken. Same architectural class as ORPHAN-HIGH-045 (no `ClientCertVerifier` callback) and ORPHAN-MEDIUM-051 (no `ClientAddr` exposure) — these three findings could close together with a single upstream API extension exposing session lifecycle.

2. **`ServerHandle` event subscription** — verify whether async-opcua 0.18 already exposes a session-event stream (e.g., via `ServerHandle::session_events_rx`). If yes, wire an interceptor task in `init_opc_ua_server` that subscribes + drains `active_leases` on session-close events. Pros: agent-side fully owned. Cons: depends on the actual API surface.

3. **Periodic active-session reconciliation** — agent boots a 30s tick task that polls `ServerHandle::active_sessions()` (if exposed) + diffs against `active_leases`; drops leases whose UserToken no longer corresponds to a running session. Pros: works without a callback. Cons: 30s lag between session-close + lease release; race between poll + close that briefly keeps the lease alive.

The TTL=1h fail-safe is the load-bearing release path until one of (1)/(2)/(3) lands. The architectural shape is documented in `session_quota.rs` preamble + this finding.

## ORPHAN-MEDIUM-053 — OPC UA SubscriptionBridge production notifier deferred to Phase B-4.5; LoggingNotifier consumes broadcast but does not propagate to async-opcua subscription state (Phase B-4 architectural decision, 2026-05-05)

**Status:** OPEN — owner: Okan-Wqm. Owner agent: Phase B-4.5 / future PR. Deadline: gated on async-opcua 0.18 subscription notification API verification (locally blocked by 8GB RAM ceiling on the opc-ua-server feature compile; CI compiles the full feature set).

**Scope:** `sens-api-gateway/src/opc_ua_server/subscription_bridge.rs::LoggingNotifier` + the `NodeChangeNotifier` production impl that Phase B-4.5 will introduce.

**Edge-expert surfaced:** Phase B-4 ships the SubscriptionBridge primitive — broadcast consumer + dispatch loop + cancel-token + RAII shutdown. The bridge consumes `ProcessImage::subscribe_changes()` broadcast at production rate, drains the buffer (preventing the producer's Lagged counter from accumulating), and dispatches each TagChange via `LoggingNotifier`. The `LoggingNotifier` records every change via `tracing::trace!` `target = "opc_ua.subscription"` but does NOT propagate to async-opcua's subscription state. HMI subscription latency therefore remains bound by the polling interval (`subscription_polling_interval_ms`, default 100ms) — Phase B-4's architectural primitive lands but the user-visible latency improvement waits for B-4.5.

**Why this is acceptable for Phase B-4:**

- **The architectural seam is established.** `NodeChangeNotifier` trait is the single integration point. Phase B-4.5 swaps in a `SensNodeManagerNotifier` impl that calls async-opcua's `record_value_change` (or whatever 0.18 exposes); zero changes to the bridge or its tests are required.
- **The broadcast::Receiver drains in production.** Without B-4 the producer would log Lagged at every burst > 1024 events; with B-4 the bridge consumes the buffer continuously.
- **HMI freshness for READS is already up-to-date.** The pre-B-4 SensNodeManager virtual-node read path consults `process_image.get_tag()` live on every browse/read — a `Read` request returns fresh data with no staleness. Phase B-4 specifically targets the SUBSCRIPTION path where async-opcua's internal sampling sets the latency floor.
- **Operator-readable observability is delivered.** The LoggingNotifier emits structured trace events with browse_name + value + quality + source + timestamp — operators can audit the change firehose end-to-end while the production notifier is being verified.

**HOW to resolve (Phase B-4.5):**

1. **Verify async-opcua 0.18 subscription notification API.** Likely candidates: `NodeManager::record_value_change(node_id, variant, source_timestamp)`, `ServerHandle::notify_subscription(node_id, variant)`, or a context-bound notifier installed at NodeManager construction. Verification requires an `--features opc-ua-server` compile (locally blocked by RAM; CI runs the full set).

2. **Implement `SensNodeManagerNotifier`** at `sens-api-gateway/src/opc_ua_server/subscription_bridge.rs` (or a new sibling `sens_node_manager_notifier.rs`). Holds an `Arc<SensNodeManager>` (the production NodeManager) + the namespace_index (resolved at boot). `notify(browse_name, change)` looks up the node_id via the registry + namespace_index, builds the OPC UA `Variant` from `change.new_value` (with appropriate type coercion based on the registered `OpcUaTagNode.data_type`), and calls the verified API.

3. **Swap the production wire** in `init_opc_ua_server` — replace `Arc::new(LoggingNotifier)` with `Arc::new(SensNodeManagerNotifier::new(sens_node_manager.clone(), namespace_index))`. The bridge spawn shape is unchanged.

4. **E2E verification** — `tests/e2e/opc_ua_subscription_hmi.rs` (Plan §B-4 E2E entry) drives a real UaExpert client at 100ms publish interval + measures p99 latency from `ProcessImage::write_tag` → DataChangeNotification receipt. SLO: p99 < 50ms (Plan §B-4 invariant).

5. **Update `opc_ua_subscription_freshness.rs` invariant** — add an assertion that the production code path references `SensNodeManagerNotifier` rather than `LoggingNotifier` in the boot wire, so a regression that reverts to LoggingNotifier surfaces at test time.

**Closure path discipline:** this is a clean follow-on, not a yama. The Phase B-4 commit ships the primitive + the trait + the spawn + the lifecycle integration; Phase B-4.5 ships the production notifier impl. Each phase is independently testable + invariant-pinned. The only consequence of B-4 without B-4.5 is that subscription latency stays at the pre-B-4 polling-bound floor — a no-regression baseline rather than a security-active gap.

## ORPHAN-MEDIUM-054 — `cmd_reload_config` MQTT command + SIGHUP handler deferred to Phase B-5.5; OpcUaLifecycle primitive ships in B-5 but operator surface is unreached (Phase B-5 scope decision, 2026-05-05)

**Status:** OPEN — owner: Okan-Wqm. Owner agent: Phase B-5.5 / future PR. Deadline: gated on D-5 config-integrity verify pipeline being available at the command-dispatch layer (the reload command must verify the file's ed25519 signature before applying changes).

**Scope:** `sens-api-gateway/src/commands/reload_config.rs` (does not yet exist) + `sens-api-gateway/src/main.rs::SignalKind::hangup()` listener (not yet wired).

**Edge-expert surfaced:** Phase B-5 ships the AGENT-SIDE primitive: `OpcUaLifecycle` with drain-rebuild-swap discipline + `ReloadOutcome` taxonomy + fail-closed config-validation. What's missing is the operator-facing surfaces — an MQTT command handler + a SIGHUP listener that drive the lifecycle's `reload(...)` method. Without them, the primitive is unreachable from operator code paths; the only consumer is the boot path (`install`) + future test fixtures.

**Why this is acceptable for Phase B-5:**

- **The architectural primitive is the load-bearing piece.** The drain semantics, atomic swap, fail-closed config validation, and four-state machine are the parts that actually enforce FR6 continuity + audit chain ordering. Once the primitive is correct, the operator surfaces are mechanical wiring.
- **The operator surfaces require D-5 integration.** `cmd_reload_config` MUST verify the new config file's ed25519 signature (D-5 integrity verify per ADR-019) before driving the lifecycle. Threading that through the existing command-dispatch envelope-adapter chain is its own batch.
- **No regression vs pre-B-5.** The agent's pre-B-5 path required restart-for-config-change; that path remains. Phase B-5 ADDS the live-reload primitive without removing the restart path. Operators use the restart-for-config-change behavior until Phase B-5.5 ships the operator surfaces.

**HOW to resolve (Phase B-5.5):**

1. **`commands/reload_config.rs::cmd_reload_config`** — analog of Phase 1.1.2 `cmd_update_cert_pinning`. Verify envelope signature + JTI replay defense + RBAC permission (`Permission::ReloadConfig`). Re-parse the agent's full config from disk via `AgentConfig::load_with_d5_verify` (D-5 integrity verify). Diff the parsed config against `lifecycle.last_applied_config().await`; if a delta is detected in `opc_ua_server.*`, call `lifecycle.reload(new_section, builder_fn).await`. Audit emit `ConfigReloadApplied` (success) or `ConfigReloadRejected` (fail-closed validation / build error).

2. **`main.rs` SIGHUP listener** — `tokio::signal::unix::signal(SignalKind::hangup())` task that calls the same reload path on every SIGHUP. Operators triggering reload via `kill -SIGHUP $(pidof suderra-agent)` get the same behavior as `cmd_reload_config`.

3. **Permission enum extension** — `Permission::ReloadConfig` (analog of `Permission::ManageCertPinning`). HSM-slot separation on the cloud-side mirrors at the RBAC layer — operators with cert-pinning authority do NOT auto-inherit config-reload authority.

4. **AppState integration** — `AppState.opc_ua_lifecycle: Arc<OpcUaLifecycle>` field replaces the existing `opc_ua_server: Option<Arc<SuderraOpcUaHandle>>` field. Boot path migrates from direct-store to `lifecycle.install(handle, config).await`. Command handlers reading the running handle migrate to `lifecycle.current().await`.

5. **E2E** — `tests/e2e/opc_ua_live_reload.rs`:
   - happy: port change via SIGHUP → new config validates → drain old → rebuild → HMI reconnects to new port.
   - adversarial: malformed config via cmd_reload_config → D-5 sig fail → old server intact + audit `ConfigReloadRejected`.
   - drain: in-flight write completes audit emit BEFORE `ServerHandle::cancel` returns.

The split is clean: B-5 ships the primitive (architecturally complete + invariant-pinned); B-5.5 ships the operator surfaces (mechanical AppState rewrite + envelope-adapter integration). No yama, no deferral-without-tracking — the gap is documented here with the resolution path.

## ORPHAN-HIGH-055 — Non-ARIA workflows interpolate `${{ github.event.inputs.* }}` directly inside `run:` shell blocks (Plan 024 v3 §B-3 scope-out, 2026-05-09)

**Status:** OPEN — owner: Okan-Wqm. Owner agent: future platform-CI hardening plan. Deadline: prior to next workflow_dispatch operator surface that accepts attacker-controlled input.

**Scope:** Four production GitHub Actions workflow files outside the ARIA scope:

* `.github/workflows/deploy-digitalocean.yml:316, :318, :330` — `${{ github.event.inputs.services }}` interpolated raw four times in the deploy-trigger conditional + IFS-read + branch-equality.
* `.github/workflows/deploy-staging.yml:87, :88` — `${{ github.event.inputs.image_tag_override }}` interpolated raw twice in the image-tag resolver.
* `.github/workflows/edge-agent-release.yml:164` — `${{ github.event.inputs.version }}` interpolated raw inside the workflow_dispatch tag-extract block.
* `.github/workflows/sensor-ingestion-release.yml:74, :75` — `${{ github.event.inputs.tag }}` interpolated raw twice in the image-tag resolver.

**Audited surface:** Plan 024 v3 §B-3 invariant `tests/invariants/aria-workflow-input-injection.spec.ts` reports each of these four files as containing raw `${{ github.event.inputs.<name> }}` interpolations inside a `run:` shell block. Plan 024 §B-3 scope is intentionally limited to ARIA-owned workflows (`aria-*.yml`); the non-ARIA findings are surfaced here for follow-up.

**Why this is acceptable for Plan 024 v3:**

* **Scope discipline.** Plan 024 v3 closes 15 ARIA audit anchors. Extending the workflow-injection fix to non-ARIA production deploy / release pipelines is a different blast-radius batch — operator approval is needed for changes to deploy-digitalocean.yml + deploy-staging.yml because they govern cloud-side rollout.
* **No regression vs pre-Plan-024.** These workflows shipped the raw interpolations long before Plan 024 was scoped; the invariant test is opt-in to the ARIA prefix specifically so the gate doesn't immediately red on baseline state.
* **Operator-protected trigger surface.** The four workflows are gated by branch protection (push to `main`) or operator-approved `workflow_dispatch`. The injection class requires a malicious operator to type `'; rm -rf /` or similar; an operator with workflow_dispatch authority can already do worse via direct repo mutation.

**HOW to resolve (platform-CI follow-up):**

1. **deploy-digitalocean.yml:** wrap the four `${{ github.event.inputs.services }}` interpolations in an `env: SERVICES_INPUT: ${{ github.event.inputs.services }}` block at the step level. Inside the script, validate format (`^[a-z0-9,_-]{1,256}$`) before `IFS=',' read -ra SPECIFIED <<< "$SERVICES_INPUT"`. Branch equality `[ "$SERVICES_INPUT" = "all" ]` is safe with the env var.
2. **deploy-staging.yml:** same pattern with `IMAGE_TAG_INPUT`. Validate as `^[A-Za-z0-9._-]{1,128}$` (Docker tag character set).
3. **edge-agent-release.yml:** `VERSION_INPUT` env var + semver regex `^v?[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$`.
4. **sensor-ingestion-release.yml:** same pattern as deploy-staging — Docker-tag char-set regex.
5. **Extend the invariant** to cover all `.github/workflows/*.yml` (drop the `aria-*` prefix filter) once each fix lands. The invariant guards against future regressions.

The fix shape is mechanical (move interpolation to env: + add regex validate); the discipline is the same as Plan 024 §B-3. Expected effort: one batch per workflow, ≈ 30 min each. Plan-independent so does not block Plan 024 v3 sign-off.

## ORPHAN-HIGH-056 — `aria-tools/` worktree-aware repo binding eksik; ARIA cycle/discovery/spine baseline çalıştırılamıyor worktree'den (Plan 024 v3 sign-off sonrası ARIA runtime smoke, 2026-05-10)

**Status:** OPEN — owner: Okan-Wqm. Owner agent: future ARIA worktree-discipline plan. Deadline: prior to next operator-driven `cycle run` from a worktree (currently HARD-BLOCKED).

**Scope:** `aria-kernel/aria_kernel/tool_registry.py` `ensure_tools_binding` (line ~150) + every entry point that calls `ensure_tools_binding` (cycle.run_enterprise_cycle:89, spine.take_baseline / take_postcheck, discovery.run, etc.).

**Reproducer:**

```bash
# From the worktree at /var/aqua-saas/.worktrees/snowball:
PYTHONPATH=aria-kernel python3 -m aria_kernel --tools-dir aria-tools \
    cycle run --workspace-root . --cycle-id "cyc-smoke-test"

# → GovernanceError: tools_root_repo_hash_mismatch: bound='e5d674a6dc22eb25'
#   current='3b5f62ed337d4bf6'; aria-tools cannot be reused across repos.
#   bound_repo_root='/var/aqua-saas',
#   current workspace_root='/var/aqua-saas/.worktrees/snowball'
```

**Surface evidence:**

* `aria-tools/integrity_index.json` carries `bound_repo_root='/var/aqua-saas'` + a `tools_root_repo_hash` derived from the canonical `/var/aqua-saas` filesystem path.
* When the operator runs ARIA from a git worktree (`/var/aqua-saas/.worktrees/snowball`) the canonical workspace root is the worktree path; `ensure_tools_binding` re-hashes `/var/aqua-saas/.worktrees/snowball` → different hash → `tools_root_repo_hash_mismatch` raise.
* Mathematically the worktree IS the same git repo (shared `.git/common_dir`); `aria-tools/` reuse from a sibling worktree is NOT a cross-repo reuse, but the binding logic does not consult `git rev-parse --git-common-dir` to resolve worktree pointers to the canonical repo root.

**Why this is acceptable for Plan 024 v3:**

* Plan 024 v3 scope is the F-005 audit-anchor closure (15 architectural-quality gaps from the post-push audit). Worktree-aware binding is a runtime-discipline fix that surfaced ONLY when an operator ran the ARIA kernel against the corrective-arc HEAD as a smoke test post-sign-off.
* No regression vs pre-Plan-024: this binding behavior shipped long before Plan 024 was scoped; the binding hash check landed in Plan 014/015 era as the tools-root cross-repo defense.
* Operator workaround: run from the canonical repo root (`/var/aqua-saas/`) instead of the worktree; the binding hash matches the original bound path. ARIA cycle / discovery / spine baseline all work from the canonical root.

**HOW to resolve:**

1. **`ensure_tools_binding` worktree-aware resolution:** before computing the current repo hash, resolve the workspace_root through `git rev-parse --git-common-dir` (or `git worktree list --porcelain` parsing). If the workspace_root is a worktree pointing at a common-dir whose canonical repo root matches `bound_repo_root`, treat the binding as valid.
2. **Backward-compat:** the existing hash mismatch path stays as the genuine cross-repo defense (different git common_dir = real cross-repo reuse = reject). Only add a worktree-resolved alias path; do not loosen the cross-repo check.
3. **Tests:** smoke fixture creates a repo + a worktree, runs `cycle run` from BOTH, asserts both succeed with the SAME `aria-tools/` and the same governance event chain. No new bind row written from the worktree (the canonical repo's bind row is the source of truth).
4. **Invariant:** `tests/invariants/aria-tools-worktree-binding.spec.ts` (or `.py`) — exercises a fixture worktree.

The scope is mechanical: one helper to resolve worktree → canonical repo root, one alias check in `ensure_tools_binding`. Estimated effort ≈ 1 batch (≤ 2h). Plan-independent so does not block Plan 024 v3 sign-off.

## ORPHAN-LOW-057 — `cycles.jsonl` rows persist with `status=None`; cycle finalization status field is never set (Plan 024 v3 sign-off sonrası ARIA runtime smoke, 2026-05-10)

**Status:** OPEN — owner: Okan-Wqm. Owner agent: future ARIA observability hardening plan. Deadline: best-effort.

**Scope:** `aria-kernel/aria_kernel/cycle.py` `record_cycle_metrics` + cycles.jsonl writer. Every recent cycle row in `aria-tools/cycles.jsonl` carries `status=null` (or no `status` key).

**Why this is acceptable for Plan 024 v3:**

* Status field absence is observability degradation, not correctness loss. The cycle-lifecycle integrity check (`integrity verify` returns `cycle_lifecycle.incomplete_count: 0 / valid: true`) does not depend on the per-row status field; it walks the begin/end markers.
* Operator scripts that grep `cycles.jsonl` for `status=ok|fail` see no signal because the field is never persisted.

**HOW to resolve:**

1. **`record_cycle_metrics` writer:** ensure the cycle-row dict carries `status` before append. The function signature already accepts `status='ok'`; the persistence path drops it somewhere in the row construction. Trace + fix in `record_cycle_metrics` + the cycles.jsonl row writer.
2. **Tests:** cycle E2E asserts `status` field present on the persisted row.

Estimated effort ≈ 1 batch (≤ 1h).

## ORPHAN-MEDIUM-058 — `aria-kernel` CLI `--tools-dir` flag inconsistency: 3 distinct patterns across subcommands (Plan 024 v3 sign-off sonrası ARIA runtime smoke, 2026-05-10)

**Status:** OPEN — owner: Okan-Wqm. Owner agent: future ARIA CLI UX hardening plan. Deadline: best-effort.

**Scope:** `aria-kernel/aria_kernel/cli.py` argparse subparser definitions across ~50 subcommands. Three distinct patterns observed during smoke test:

1. **Pattern A — global `--tools-dir` accepted** (operator passes BEFORE the subcommand):
   * `tool list`, `profile get`, `change list` — `python3 -m aria_kernel --tools-dir aria-tools tool list` works.
2. **Pattern B — subcommand-level `--tools-dir TOOLS_DIR` REQUIRED** (operator passes AFTER the subcommand):
   * `spine status`, `metrics dashboard`, `human-required list`, `integrity verify` — `python3 -m aria_kernel spine status --tools-dir aria-tools` works; `python3 -m aria_kernel --tools-dir aria-tools spine status` fails with "unrecognized arguments: --tools-dir aria-tools".
3. **Pattern C — `--tools-dir` NOT accepted at all; workspace_root drives resolution**:
   * `pressure list` — only `--workspace-root` accepted; aria-tools is resolved internally via `workspace_paths`.

**Reproducer matrix:**

| Subcommand | `--tools-dir` BEFORE works | `--tools-dir` AFTER works |
|---|---|---|
| `tool list` | ✅ | ❌ |
| `profile get` | ✅ | ❌ |
| `spine status` | ❌ | ✅ |
| `metrics dashboard` | ❌ | ✅ |
| `human-required list` | ❌ | ✅ |
| `integrity verify` | ✅ | ❌ |
| `pressure list` | ❌ | ❌ (uses --workspace-root) |

**Why this is acceptable for Plan 024 v3:**

* Operator UX degradation, not architectural correctness loss. Each subcommand still works given the right flag placement.
* Pre-Plan-024 baseline carried the same inconsistency; the spec discipline of v1→v2→v3 plan validation did not include CLI surface-uniformity audit.

**HOW to resolve:**

1. **Audit:** grep cli.py for every `add_tools_arg(parser, required=...)` + every subparser definition; map which pattern each subcommand uses.
2. **Normalize:** pick one canonical pattern (recommended: subcommand-level `--tools-dir TOOLS_DIR` required, with a defaulting helper that reads `ARIA_TOOLS_DIR` env var). Every subcommand calls the same `add_tools_arg` helper.
3. **Tests:** invariant test scans cli.py argparse tree, asserts every subcommand exposes `--tools-dir` in the same shape.

Estimated effort ≈ 2-3 batches (≤ 4h, requires touching every subparser definition).

## ORPHAN-MEDIUM-059 — `outbox-adapter` declared_scope captures ~200 hr-service paths outside the adapter's outbox surface (Plan 024 v3 post-sign-off ARIA runtime smoke, 2026-05-10)

**Status:** OPEN — owner: Okan-Wqm. Owner agent: future ARIA adapter-portfolio hardening plan. Deadline: best-effort.

**Scope:** `aria-tools/registry.json` outbox-adapter row + the adapter's manifest under `tools/aria-adapters/outbox-adapter.tool.json`. The declared_scope / allowed_read_globs include patterns that match the entire `apps/hr-service/**` source tree (200+ files: jest.config.ts, src/aquaculture/**, src/training/**, src/scheduling/**, src/leave/**, src/performance/**, src/attendance/**, src/hr/**, src/health/**, src/database/**), even though the adapter's stated purpose is the @platform/outbox transactional outbox surface.

**Reproducer:**

```bash
PYTHONPATH=aria-kernel python3 -m aria_kernel --tools-dir aria-tools \
    cycle run --workspace-root . --cycle-id "cyc-outbox-scope-test"
# → outbox-adapter run row in runs.jsonl carries:
#   status: "scope_violation"
#   scope_violations: [
#     "apps/hr-service/jest.config.ts",
#     "apps/billing-service/jest.config.ts",
#     ... 200+ entries from hr-service/aquaculture, training, scheduling, leave ...
#   ]
```

**Surface evidence:** ARIA cycle dispatch in `cyc-aria-bug-hunt-worktree-20260510T084742Z` produced an outbox-adapter run with `status="scope_violation"` and a 200+ entry `scope_violations` list. The adapter's read_paths included paths that find_scope_violations rejected as outside the adapter's declared_scope. read_paths and scope_violations matched 1:1 for the hr-service sub-tree — every hr-service path the adapter walked is outside its scope.

**Why this is acceptable for Plan 024 v3:**

* Plan 024 v3 scope is the F-005 audit-anchor closure (15 architectural-quality gaps from the post-push audit). Adapter manifest correctness is a separate quality dimension that surfaced ONLY when an operator ran the kernel against the actual codebase post-sign-off.
* The adapter is in SHADOW status; raw findings are not promoted to operator-facing emit. The scope_violation surface IS the architectural defense: tool_health.record_run flags the run, the operator audit chain captures the file list, and the adapter does not contaminate the operator queue.

**HOW to resolve:**

1. **Audit the manifest** at `tools/aria-adapters/outbox-adapter.tool.json` — determine whether the broad scope is intentional (adapter is meant to scan every consumer of the @platform/outbox surface) or accidental (the declared_scope glob is wrong).
2. **If intentional:** narrow the scope to the actual outbox files (`platform/libs/outbox/**`, `apps/**/src/database/migrations/**` for outbox table emit, etc.) + add a comment explaining the broad-vs-narrow tradeoff.
3. **If accidental:** correct the glob; the scope_violation list IS the test fixture (every entry should disappear after the fix).
4. **Tests:** invariant test that walks the adapter portfolio + asserts each adapter's declared_scope matches its stated purpose (operator sign-off on the manifest content, mechanical match on glob patterns).

Estimated effort ≈ 1 batch (≤ 2h).

## ORPHAN-MEDIUM-060 — `agent-harness-security-adapter` declared_scope captures `.claude/agents/**` (every Claude Code agent definition) — non-production source tree (Plan 024 v3 post-sign-off ARIA runtime smoke, 2026-05-10)

**Status:** OPEN — owner: Okan-Wqm. Owner agent: future ARIA adapter-portfolio hardening plan. Deadline: best-effort.

**Scope:** `aria-tools/registry.json` agent-harness-security-adapter row + the adapter's manifest. The declared_scope captures `.claude/agents/**` (~85 agent definition .md files including subdirectories `_maintenance/`, `edge-docs/`, `product-audit/`).

**Reproducer:** ARIA cycle dispatch in `cyc-aria-bug-hunt-worktree-20260510T084742Z` produced an agent-harness-security-adapter run with `status="scope_violation"` and the full `.claude/agents/**` listing in `scope_violations`.

**Why this is acceptable for Plan 024 v3:**

* `.claude/agents/**` is non-production source: it carries the Claude Code agent system prompts that power the agent dispatch lane. The agent-harness-security-adapter's stated purpose is harness security review (auth/authz, sandboxing, secrets handling) which lives in production code paths (auth-service, gateway-api, libs/backend-common/security/**). Including the agent .md files is non-production noise.
* SHADOW status means no operator-facing emit; the scope_violation surface is the architectural defense.

**HOW to resolve:**

1. **Audit the manifest:** narrow the declared_scope to the actual agent-harness production surface (auth + dispatch + security surfaces) and EXCLUDE `.claude/agents/**`.
2. **Pair with ORPHAN-MEDIUM-059** in a single adapter-portfolio audit batch: every adapter's manifest reviewed, declared_scope matches stated purpose.

Estimated effort ≈ 1 batch shared with 059 (≤ 2-3h total for both).

---

## ORPHAN-HIGH-061 — `runs.jsonl` reader pair in `architecture_spine_gate.py` silently skips JSONDecodeError without diagnostic emit (Plan 025 §A.2 planner-validate finding, 2026-05-10)

**Status:** OPEN — owner: Okan-Wqm. Owner agent: Plan 026 (`read_runs_rows` shared helper, parallel to Plan 025 §A.2 `read_governance_rows`). Deadline: post-Plan-025-sign-off.

**Scope:** `aria-kernel/aria_kernel/architecture_spine_gate.py:284, 339` — both readers iterate `aria-tools/runs.jsonl` and on `(OSError, json.JSONDecodeError)` fall back to `latest = None` silently. F-006 evidence pointer originally claimed these were governance.jsonl callsites; Plan 025 §A.2 Planner-B's code-grounded validation corrected the count: `runs.jsonl` is a **separate ledger** with its own integrity contract, NOT inside Plan 025 §A.2 governance-reader scope.

**Reproducer:**
```python
# Direct Read at architecture_spine_gate.py:278-285 (_check_auth_security)
for line in runs_path.read_text(encoding="utf-8").splitlines():
    if not line.strip():
        continue
    row = json.loads(line)
    if row.get("tool_id") == "security-boundary-adapter":
        latest = row
except (OSError, json.JSONDecodeError):
    latest = None        # silent — no emit_ledger_corruption_diagnostic
```

Identical pattern at lines 333-340 (`_check_harness_security`) for `tool_id == "agent-harness-security-adapter"`.

**Why architectural shape parallels §A.2 but ledger differs:**

* `runs.jsonl` is the adapter execution ledger (one row per adapter run); `governance.jsonl` is the audit/integrity-event ledger. Both are append-only and hash-chained, but their criticality and recovery semantics differ — a corrupt `runs.jsonl` row affects invariant measurement (one stale invariant for one cycle), whereas a corrupt `governance.jsonl` row affects audit replayability.
* Single shared `read_*_rows(path, *, on_corruption=...)` API is correct, but the helper module name and default mode SHOULD be ledger-specific (a generic `read_jsonl_rows` would hide which ledger the operator is failing). Hence: parallel `read_runs_rows` helper sibling to `read_governance_rows`, NOT a unified one.

**HOW to resolve (post-Plan-025):**

1. After Plan 025 §A.2 ships `governance_reader.py`, add `runs_reader.py` with `read_runs_rows(path, *, on_corruption='strict', tool_id_filter=None)` matching the governance helper API shape.
2. Migrate the 2 callsites in `architecture_spine_gate.py:278-285` + `:333-340`.
3. Default `on_corruption='strict'` per the same audit-bound integrity argument; tolerant is operator opt-in.
4. AST-scan invariant test asserts no `except (OSError, json.JSONDecodeError)` block remains in any function whose body references `"runs.jsonl"`.

Estimated effort ≈ ½ batch (single helper + 2 callsite + 4 test cases ≤ 2h).

---

## ORPHAN-MEDIUM-062 — `tool_registry._atomic_write_json` shares one tmp filename across processes; concurrent governance writers race on `tmp.replace(path)` (Plan 025 §A.1 implementer finding, 2026-05-10)

**Status:** OPEN — owner: Okan-Wqm. Discovered while implementing Plan 025 §A.1 (`submit_claim_result` envelope-hash drift gate). Out of Plan 025 §A.1 scope; the §A.1 lock is on `agent-invocations/results.jsonl` and the index race lives one ledger over (`integrity_index.json`).

**Scope:** `aria-kernel/aria_kernel/tool_registry.py:268-272`

```python
def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")          # <-- shared filename
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)
```

`tmp` is a single deterministic path per target file (`.{name}.tmp`). Two processes calling `append_tools_governance` (or any caller of `update_tools_index` via `ensure_tools_dir`) at the same time both open the same `.integrity_index.json.tmp` for write. The earlier `tmp.replace(path)` succeeds; the later one races against the now-vanished tmp file and surfaces `FileNotFoundError: [Errno 2] No such file or directory: '<tmp>' -> '<path>'`.

**Reproducer:** spawn ≥3 `multiprocessing.Process` children that each invoke `submit_claim_result` for the same claim with byte-identical envelopes. With Plan 025 §A.1's lock-bound dedup the §A.1 invariants hold (one accepted, exactly one results.jsonl row), but ~1 of 5 children surfaces the rename race from `update_tools_index` (called from `ensure_tools_dir` BEFORE the §A.1 lock acquires) or from `append_tools_governance` (called from outside any results.jsonl lock by other code paths).

**Architectural fix:** make `_atomic_write_json` per-process by namespacing the tmp filename with `os.getpid() + secrets.token_hex(4)`:

```python
tmp = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(4)}.tmp")
```

Each process writes its own tmp file; `tmp.replace(path)` is still atomic per-process, and the LAST renamer wins for the target file (which is the desired semantic — index is a snapshot, not append-only). No cross-process tmp filename collision.

**Why a separate finding (not Plan 025 §A.1 work):** the §A.1 mandate is `submit_claim_result` envelope-hash drift gate on `results.jsonl`. The `integrity_index.json` race surfaces in any caller of `update_tools_index`, which is invoked from many code paths unrelated to §A.1. Folding the tmp-filename fix into §A.1 would expand scope into `tool_registry`, an SSoT change that needs its own architectural-arbiter review.

**Test surface that exposed it:** `test_concurrent_submit_race_5_subprocesses` in `test_submit_claim_result_envelope_drift.py`. The Plan 025 §A.1 invariants assert exactly-one-accepted and exactly-one-results-row; the assertion explicitly tolerates the ORPHAN-062 race outcome (`FileNotFoundError` from one child) as out-of-scope for §A.1. Once ORPHAN-062 lands, the test assertion can tighten back to "all 5 children land in accepted+idempotent".

Estimated effort ≈ ¼ batch (single function + 1 unit test ≤ 1h).

---

## ORPHAN-MEDIUM-063 — full-suite test interdependence: `test_tool_governance` + `test_event_contracts_adapter_integration` flake under shared ARIA_TEST_TMPDIR (Plan 025 sign-off smoke, 2026-05-10)

**Status:** OPEN — owner: Okan-Wqm. Owner agent: future Plan 026 test-isolation hardening batch. Deadline: best-effort.

**Scope:** `aria-kernel/tests/test_tool_governance.py` + `aria-kernel/tests/test_event_contracts_adapter_integration.py`. Both tests last touched at commits PRE-DATING Plan 025 (test_tool_governance at `af2af7f2` Plan 023 era; test_event_contracts older). Plan 025 changes do NOT touch either file.

**Symptom:** `python3 -m unittest discover aria-kernel -p '*test*.py'` with shared ARIA_TEST_TMPDIR sometimes reports 1-4 failures across these two modules; running each module isolated returns 34/34 OK and 1/1 OK respectively.

**Reproducer (intermittent):**
```bash
ARIA_TEST_TMPDIR=/tmp/aria-tests-x ARIA_WORKSPACE_BASE=/tmp/aria-workspaces-x \
  PYTHONPATH=aria-kernel python3 -m unittest discover aria-kernel -p '*test*.py'
# Sometimes: FAILED (failures=4, errors=1)
# Sometimes: FAILED (failures=1)
# Sometimes: OK
```

Isolated runs (deterministic OK):
```bash
PYTHONPATH=aria-kernel python3 -m unittest aria-kernel.tests.test_tool_governance       # 34/34 OK
PYTHONPATH=aria-kernel python3 -m unittest aria-kernel.tests.test_event_contracts_adapter_integration  # 1/1 OK in 87s
```

**Why this is plan-independent:**

* Test fixture state interference between modules — one test's tmpdir or governance.jsonl leaks into the next module's setUp. Module load order under `discover` is non-deterministic, so the flake reproduces or not depending on which module ran before the affected pair.
* Plan 025 confirmed clean by isolated re-run: §E commit `4144f315` reported 1214 OK at a fresh tmpdir; sign-off-time `1ae1cd25` re-run (same tmpdir reused across multiple Plan 025 phases) intermittently reports 1-4 fails. Affected modules contain no Plan 025 surface call.

**HOW to resolve (post-Plan-025):**

1. Audit setUp / tearDown of `test_tool_governance` + `test_event_contracts_adapter_integration` for shared ARIA_TEST_TMPDIR or shared `aria-tools/governance.jsonl` writes that are not cleaned up.
2. Ensure each test class creates its own `tempfile.TemporaryDirectory` (mirror the §A.2 `test_governance_reader.py` pattern that already passes deterministically).
3. If shared writeback is the root cause, gate behind a per-test counter or unique suffix.
4. Add a CI invariant test that runs `discover` 3 times and asserts deterministic OK.

Estimated effort ≈ ½ batch (audit + 2 module setUp rewrites + invariant test ≤ 2-3h).

**Why this is NOT inside Plan 025 sign-off scope:** the affected tests do not exercise any Plan 025 code path; the flake reproduces on pre-Plan-025 HEADs. Closing Plan 025 §E sign-off at HEAD `1ae1cd25` is correct; Plan 026 (or a dedicated test-isolation plan) owns the harness fix.
## ORPHAN-HIGH-055 — auth-service migration history was squashed; baseline `CREATE TABLE auth.*` chain is missing, so fresh-volume bootstraps crash on later ALTER-COLUMN migrations (Phase: bootstrap-restoration, 2026-05-07)

**Status:** OPEN — owner: Okan-Wqm. Owner agent: data-expert / auth-service maintainer. Deadline: gated on this orphan finding being closed by `apps/auth-service/src/migrations/1700000000000-CreateInitialSchema.ts` landing on `main` AND a fresh-volume bootstrap E2E proving the chain replays cleanly.

**Scope:** `apps/auth-service/src/migrations/*` and the legacy `infrastructure/docker/init-scripts/01-init-databases.sql` boundary.

**Root cause:** several earlier `CREATE TABLE` migrations under `apps/auth-service/src/migrations/` were squashed out of source. The init script (`infrastructure/docker/init-scripts/01-init-databases.sql`) covers a partial set only — `auth.users`, `auth.tenants`, `auth.invitations`, `auth.tenant_modules`, `auth.tenant_roles`. Every subsequent `ALTER` migration in the `1711700000000+` range assumes baseline tables / columns that no longer have a creation step. Concrete failure on a fresh DB: `1781100000000-ConvertTimestampToTimestamptz` ALTERs `auth.users.mfaLockedUntil` which was never created.

**Why this is HIGH (not CRITICAL):** existing droplet volumes already have the historical objects populated through the prior (now-deleted) migration entries; the failure surfaces only on fresh-volume bootstraps (new environments, factory-reset, ephemeral CI envs). It is not a runtime fault on populated production volumes — but it blocks every clean-environment bring-up, including disaster-recovery rebuilds.

**Architectural fix landing in this orphan-close commit:**

1. **`apps/auth-service/src/migrations/1700000000000-CreateInitialSchema.ts`** creates 12 missing tables (`refresh_tokens`, `webauthn_credentials`, `user_module_assignments`, `mobile_user_settings`, `modules`, `announcements`, `announcement_acknowledgments`, `message_threads`, `messages`, `support_tickets`, `ticket_comments`, `audit_logs`) and adds 5 missing columns to `auth.users` (`accessType`, `mfaRecoveryCodes`, `mfaFailedAttempts`, `mfaLockedUntil`, `notificationPreferences`).

2. **Idempotent end-to-end** — every DDL statement uses `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, plus `DO $$ ... EXCEPTION WHEN duplicate_object` blocks for enum types and FK constraints. Production replay against an already-populated volume is a no-op; the migration ledger insert occurs once.

3. **Topological order respected** — parents before FK children: `modules` / `mobile_user_settings` (no auth.* FKs) → `user_module_assignments` (FK to users + modules) → `refresh_tokens`, `webauthn_credentials` (FK to users) → `announcements` (FK to tenants) → `announcement_acknowledgments` (FK to announcements) → `message_threads` (FK to tenants) → `messages` (FK to message_threads) → `support_tickets` (FK to tenants) → `ticket_comments` (FK to support_tickets) → `audit_logs` (no FKs; standalone — audit rows must survive deletion of the entities they describe).

4. **Lint-chunk discipline (R3 exemption)** — every CREATE TABLE statement and its sibling CREATE INDEX statements are bundled into a single `queryRunner.query()` template literal. The migration-sql-lint `R3-create-index-not-concurrent` rule scans each `queryRunner.query` call as one independent SQL chunk; an index call without a sibling CREATE TABLE in the same chunk is flagged as "index on pre-existing table — must be CONCURRENTLY". Co-emitting the index with the CREATE TABLE inside one chunk lets R3 recognize the just-created-table exemption (the table is empty at index-creation time so ACCESS EXCLUSIVE is safe).

5. **TIMESTAMPTZ from birth** — every `timestamp` column in the new tables is created as `timestamptz` so the later `1781100000000-ConvertTimestampToTimestamptz` migration sees nothing to convert (it tolerates already-timestamptz columns via its `information_schema` check).

6. **`auth.audit_logs.ipAddress` typed as `inet` from birth** — matches the entity declaration so the later `1787400000000-ConvertAuthAuditIpToInet` migration is a no-op on fresh DBs (it pre-checks for inet via `information_schema`).

7. **`auth.audit_logs.legalHold` created with `NOT NULL DEFAULT false`** — the immutability triggers installed by `1787100000000-AddAuthAuditLogsImmutability` find the column already in place; that later migration's `ADD COLUMN IF NOT EXISTS` step is then a no-op.

**HOW to close the rest of this orphan:**

- **Fresh-volume bootstrap E2E proof.** Spin a fresh postgres volume, run the full auth-service migration chain (`1700000000000` first, then every subsequent migration in timestamp order), assert no failure. Land that test under `e2e/tests/integration/auth-fresh-volume-bootstrap.spec.ts` and reference it from this orphan's closing commit.

- **Init-script boundary documented in code.** Add a top-of-file comment to `infrastructure/docker/init-scripts/01-init-databases.sql` listing exactly the 5 tables it owns, with a note that `1700000000000-CreateInitialSchema.ts` owns the rest. The boundary is currently implicit (knowable only by reading both files); making it explicit prevents future "let's add a table to the init script" drift.

- **Squashed-migration audit.** Walk back through `git log --diff-filter=D -- apps/auth-service/src/migrations/` to enumerate exactly which historical CREATE migrations were deleted and when. The 12 tables this baseline restores match the entity surface today; an audit confirms no other deleted migrations need restoring (e.g. trigger migrations, view migrations).

**Closure path discipline:** this is not a yama. The squashed-history damage is permanent (cannot recover the deleted migration files without rewriting history), so the architectural fix is to write a NEW baseline migration that aligns with the current entity surface. A future entity addition follows the same migration-per-change discipline; this one batch closes the historical gap.

## ORPHAN-MEDIUM-056 — `nats-invariants.spec.ts` cert-CN extraction regex broken since WS1 (commit 0d249dd0); 1:1 invariant `services.yaml ↔ cert CN list` no longer fires (Phase: pre-flight-rewire, 2026-05-08)

**Status:** OPEN — owner: Okan-Wqm. Owner agent: nats-invariants test maintainer. Deadline: gated on `loadCertCnList` being rewritten to match the current loop form AND the rewritten test failing on a deliberately drifted services.yaml entry.

**Scope:** `e2e/tests/integration/nats-invariants.spec.ts` (specifically `loadCertCnList()` and the `services.yaml names ↔ cert CN list are 1:1` test case).

**Root cause:** the cert-script previously hardcoded the per-service NATS CN list as a literal whitespace-separated argument to `for svc in <names>; do` (e.g. `for svc in auth_service farm_service ...; do`). The invariant test extracts that list with the regex `/for svc in\s+([\s\S]+?);\s*do/` and compares the names to `services.yaml`. WS1 (commit 0d249dd0) refactored the loop to read the list from a python3+yaml.safe_load extraction and iterate via `for svc in $SERVICE_NAMES; do`. The regex still matches (capturing `$SERVICE_NAMES`), but `loadCertCnList()` now returns the literal string `["$SERVICE_NAMES"]` instead of the 12 actual CNs. The 1:1 set comparison then yields `onlyInYaml = [12 names]` and `onlyInCerts = ["$SERVICE_NAMES"]` — which SHOULD throw on every CI run, but does not. We have not pinpointed why the spec is currently green on `main`; either the spec is silently skipped on the active CI gate, or it was already failing and the failure is being absorbed by some test-suite split. Investigation is part of the fix.

**Why this is MEDIUM (not HIGH):** the structural SSoT IS still enforced — the cert-script reads `services.yaml` at script-run time via `python3 -c "...yaml.safe_load..."`, so an operator who edits services.yaml will get the corresponding cert minted on the next `generate-internal-certs.sh` run with no possible drift. The integration test was the SECOND-LINE drift detector (catch-it-before-the-script-runs); its silent failure is a defense-in-depth regression, not a correctness regression. The Phase A3 grep assertion in `.github/workflows/ci-affected.yml` (and the pre-flight rewire's mirror of it) is the FIRST-LINE structural guard and remains intact (this orphan is opened in the same commit that restores the Phase A3 guard).

**Architectural fix (HOW to close):**

1. **Rewrite `loadCertCnList()`** to actually invoke the script in a way that exercises the runtime python extraction and capture the printed CN list. Two viable shapes:
   - **Tier-1 (preferred): execute the python extractor inline against `infrastructure/nats/services.yaml`** — the same one-liner the bash script uses, called from the Jest test via `child_process.execFileSync('python3', ['-c', '<one-liner>', SERVICES_YAML])`. This makes the test verify the SAME parsing logic that runs at cert-mint time, eliminating the "test parses regex; script parses yaml" double-implementation that drifted.
   - **Tier-2: source the script via `bash -c "source <script>; echo \"$SERVICE_NAMES\""`** — sources the bash up to the SERVICE_NAMES assignment then emits it. Requires the script to be source-safe (it currently runs cert-generation as a side effect at top-level; would need a `SOURCE_ONLY=1` early-return guard, which is more script churn than Tier-1).

2. **Add a deliberate-drift fixture test** under `e2e/tests/integration/__tests__/nats-invariants-loadCertCnList.spec.ts` that copies services.yaml to a temp file, removes one service entry, points the parser at the temp file, and asserts the 1:1 check throws with both `onlyInYaml` and `onlyInCerts` populated. Without this, "test passes" is uninformative — we need to confirm the test FAILS when drift exists.

3. **Update the test's helper comment** that currently says "The names are whitespace-separated on one or more continuation lines (ending in `\`). Extract the full list." — that comment described the pre-WS1 hardcoded list. The new comment should describe the runtime-extraction model.

4. **Investigate why this is currently green on main** — either (a) the spec is in a `.skip` block somewhere, (b) the e2e job split that runs this spec is non-blocking, or (c) the regex captures something that happens to match by coincidence. Whichever it is, document the finding in the closing commit so the failure mode that hid this for 24 days is itself fixed.

**Why this is documented here (not as part of the PR #236 cert script fix):** the script-side fix (single-line `python3 -c "...yaml.safe_load..."` form) is in scope for the pre-flight-rewire PR. The integration-test-side fix is a separate concern with its own scope (Jest spec rewrite + deliberate-drift fixture + investigation of why it's green) and would balloon the PR. Per `feedback_orphan_findings_doc.md` the right move is documenting the finding here with the fix path, then opening a follow-up commit.

---

## ORPHAN-012 — `FARM-DATAMIG-001` registry id violates `findings.jsonl.schema.json` id pattern

**Severity:** MEDIUM
**Discovered:** 2026-05-10, while implementing /tmp/ci-cleanup-plans/invariants-deferred.md §2 Option A (evidence-pattern relax)
**File:** `docs/reviews/_registry/findings.jsonl` (entry id `FARM-DATAMIG-001`, appended 6b372511 on 2026-04-24)

**Evidence:**
- `docs/reviews/_registry/findings.jsonl.schema.json:22` — id pattern `^(DATA|SEC|PLAT|FE|EDGE|MT|FARM|...)-(CRITICAL|HIGH|MEDIUM|LOW|CVE)-[0-9]{3}$` requires CLASSIFIER ∈ {CRITICAL, HIGH, MEDIUM, LOW, CVE}.
- `docs/reviews/_registry/findings.jsonl` line 97 — entry has `"id":"FARM-DATAMIG-001"` with `"severity":"HIGH"`. The CLASSIFIER segment is `DATAMIG`, a domain tag, not the entry's severity.
- AJV failure observed via `npm run invariants:fast -- --testPathPatterns=finding-registry-integrity`: `instancePath:/id, schemaPath:#/properties/id/pattern, ... must match pattern`.
- Discovered separately from the 94 `evidence/items/pattern` violations addressed by the schema relax in this same batch — Option A's recommended scope was strictly the evidence pattern, so this id-pattern fail is left for a follow-up architectural decision.

**Why this is an orphan, not a yama:**
The entry is in a hash-chained append-only ledger. Editing the id rewrites `content_hash` and breaks every subsequent entry's `prev_hash` pointer — exactly the chain-replay corruption the integrity invariant exists to detect (see `finding-registry-integrity.spec.ts` hash-chain checks). So the cure is on the SCHEMA side (same architectural pattern as the evidence-pattern relax landing in this commit).

**Two architectural options:**

1. **Extend the id pattern enum.** Add `DATAMIG` to the CLASSIFIER alternation:
   ```
   ^(DATA|SEC|PLAT|...)-(CRITICAL|HIGH|MEDIUM|LOW|CVE|DATAMIG)-[0-9]{3}$
   ```
   This admits the existing entry. But CLASSIFIER's whole purpose per the schema description is severity (or `CVE` as a stable upstream identifier). Adding a domain-tag value to the same slot conflates two orthogonal axes (severity vs. domain) and invites more drift later (someone next adds `MIGRATION`, `ROLLOUT`, etc.). Cheap, but architecturally weak.

2. **Append a corrective re-issue.** Treat `FARM-DATAMIG-001` as schema-malformed-on-arrival and append a NEW entry `FARM-HIGH-NNN` (next available HIGH index for FARM) with `override_of: "FARM-DATAMIG-001"` and identical evidence/title/state. The original chain entry stays (cannot be rewritten); the override pointer documents the cure. Still leaves the historical id violating the schema, so the integrity test still fails on the entry's id — meaning option 2 alone does NOT close the test failure.

3. **Hybrid: relax the id pattern at one named carve-out.** Add a single explicit `FARM-DATAMIG-001` exception to the schema (via `if/then` allOf branch grandfathering the one known entry). Documents the malformed entry, doesn't widen the CLASSIFIER enum. Minimum-blast-radius cure. Architecturally tidy: the historical malform is acknowledged exactly once and future entries face the original pattern.

**Recommended:** Option 3 (named carve-out) — preserves the original CLASSIFIER convention for future writers, narrowly grandfathers the one bad entry, doesn't conflate severity with domain. Track and close in a follow-up commit.

**Test coverage to add when closed:**
- AJV must validate `FARM-DATAMIG-001` exactly (and only it) under the named carve-out.
- A different malformed id (e.g. `FARM-FOOBAR-001`) must still fail.
- The integrity test (`every entry conforms to findings.jsonl.schema.json`) must turn green end-to-end.

**Status:** RESOLVED — `properties.id` rewritten as a `oneOf` with two branches: (1) the original CLASSIFIER alternation, (2) a `const: "FARM-DATAMIG-001"` literal grandfathering exactly the one historical malformed entry. AJV passes the entry, the original alternation remains intact for every future writer, and unrelated malformed ids (e.g. `FARM-FOOBAR-001`) still fail because they match neither branch. Closed by the same commit that registered `ajv-formats` (PR #236 invariants-fast green-up). The pre-flight rewire bundle landed Fix 1 (ajv-formats registration) and Fix 2 (this carve-out + a sibling `deadline` `anyOf` admitting both `format: date` and `format: date-time` for ORPHAN-HIGH-035 / ORPHAN-HIGH-039 / ULTRA-HIGH-071, which was a separate format-precision issue unmasked by the same compile-time crash).

## ORPHAN-013 — `aquamobil` Docker build cannot resolve `react/jsx-runtime` from aliased `farm-shared` source

**Severity:** HIGH (blocks droplet auto-deploy: `Deploy to DigitalOcean (Staging)` fails on every push to main)
**Discovered:** 2026-05-10, while operationalising the staging deploy pipeline
**File:** `web/apps/aquamobil/vite.config.ts` (resolve config), `infrastructure/docker/Dockerfile.aquamobil` (build context shape), `libs/farm-shared/src/components/DynamicMeasurementForm.tsx` (the importing module)

**Evidence (Rollup error inside `infrastructure/docker/Dockerfile.aquamobil` build):**
```
[vite]: Rollup failed to resolve import "react/jsx-runtime" from
        "/monorepo/libs/farm-shared/src/components/DynamicMeasurementForm.tsx"
ERROR: process "/bin/sh -c npx vite build" did not complete successfully: exit code: 1
```

Reproduced locally on 2026-05-10:
- Run: `docker build -f infrastructure/docker/Dockerfile.aquamobil .` from a clean `origin/main`.
- Result: identical Rollup error → buildx exits 1 → `build-frontend-images (aquamobil, ...)` job fails → `deploy` job blocked because it `needs: [build-frontend-images]`.

**Root cause:** The aquamobil Dockerfile builds in a STANDALONE context — `npm ci` runs from `/monorepo/web/apps/aquamobil/`, so the only `node_modules/` tree is at `/monorepo/web/apps/aquamobil/node_modules/`. The shared component lib `libs/farm-shared` is `COPY`'d in separately under `/monorepo/libs/farm-shared/` (not installed via npm) and consumed via the Vite alias `@aquaculture/farm-shared`. When Rollup processes a TSX file under `/monorepo/libs/farm-shared/src/...`, the JSX transform emits a bare-specifier import `react/jsx-runtime`. Node's resolution algorithm walks UP from `/monorepo/libs/farm-shared/`, finds no `node_modules/` at `/monorepo/libs/` or `/monorepo/`, and aborts. React is right there — at `/monorepo/web/apps/aquamobil/node_modules/react/jsx-runtime.js` — but the resolver doesn't know to look "sideways" into a sibling package's installed deps.

**Why it doesn't bite the other 8 microfrontends:** they all build OUTSIDE Docker (in the `build-frontend` job on the GHA runner) and then their pre-built `dist/` is COPY-only into `infrastructure/docker/Dockerfile.microfrontend.simple`. On the host runner, `node_modules/` exists at the workspace root and farm-shared resolves React via that tree. Aquamobil is the lone exception that runs `vite build` INSIDE its image's build stage.

**Fix (Tier-1 "make it impossible" per CLAUDE.md):** add `resolve.dedupe: ['react', 'react-dom']` to `web/apps/aquamobil/vite.config.ts`. This is the documented Vite escape hatch for monorepo-aliased React libs: `dedupe` forces every bare `react` / `react-dom` / subpath specifier (including `react/jsx-runtime` and `react/jsx-dev-runtime`) to resolve to the consuming project's `node_modules/react/...`, regardless of which file does the importing. Aquamobil already declares `react@^18.2.0` and `react-dom@^18.2.0` as direct deps in its package.json, so the consuming project already owns the canonical copy. With `dedupe`, no consumer can ever pick up a second React via the aliased boundary.

**Status:** RESOLVED — fixed in branch `chore/aquamobil-react-runtime-fix` via PR. Verified locally with `docker build -f infrastructure/docker/Dockerfile.aquamobil .` succeeding (`vite v7.3.2 ... ✓ built in 21.50s` with no Rollup error).

---

## ORPHAN-HIGH-056 — `deploy-staging.yml` hard-requires `STAGING_DROPLET_*` secrets, then `deploy-digitalocean.yml` permanently blocks prod for single-droplet operators

**Severity:** HIGH (single-droplet operators cannot deploy to production at all without manual `bypass_staging_gate=true` on every push)
**Discovered:** 2026-05-10, while operationalising the staging deploy pipeline (paired with ORPHAN-013)
**File:** `.github/workflows/deploy-staging.yml`, `.github/workflows/deploy-digitalocean.yml`, `docs/adr/016-deploy-resilience-architecture.md` (Phase D contract)

**Evidence (failure shape on a repo without `STAGING_DROPLET_HOST` set):**
```
Run appleboy/ssh-action@0ff4204d59e8e51228ff73bce53f80d53301dee2
  with:
    host:
    username:
    key: ***
    command_timeout: 50m
    envs: IMAGE_TAG
    script: ...
error: missing server host
```

The `deploy` job inside `deploy-staging.yml` fails immediately on the SSH step. No `deployed/staging-<sha>` tag is ever pushed to origin. On the SAME push to main, `deploy-digitalocean.yml`'s `staging-gate` job then enters its 55-minute polling loop, never finds the tag (because staging never produced it), times out, and aborts the prod deploy. The operator has two unappealing options on every push: wait 55min for the timeout then rerun manually with `bypass_staging_gate=true`, or run `workflow_dispatch` from the start with the bypass.

**Root cause:** `deploy-staging.yml` was written with the implicit assumption that a staging droplet is ALWAYS provisioned (ADR-016 Phase D, 2026-04-14). Phase D codifies a "deploy to staging first, then prod" architecture — entirely correct for a multi-droplet operator. But it does not specify the lifecycle BEFORE staging exists, or for operators who never plan to provision staging (single-droplet topology — one droplet running prod only, with PR review + droplet snapshots as the change-management gate). The workflow therefore unconditionally invokes `appleboy/ssh-action` with empty secrets and fails at runtime; the prod-side gate, written with the symmetrical assumption, gates on a tag that will never arrive.

**Why this is architecturally distinct from the existing `STAGING_ENABLED` repo variable:** `deploy-digitalocean.yml`'s `staging-gate` already has a `vars.STAGING_ENABLED` opt-in flag that auto-bypasses the gate when set to `false` (or unset). That signal is human-fallible — an operator can set `STAGING_ENABLED=true` without adding the secrets (or vice versa) and the two workflows can drift relative to each other. The structural truth is "staging cannot deploy without `STAGING_DROPLET_HOST`", which is a function of secret presence, not of operator intent.

**Fix (Tier-1 "make it impossible" per CLAUDE.md):** make secret presence the discriminator on BOTH workflow sides:

1. `deploy-staging.yml` — new top-level `staging-configured` job reads `secrets.STAGING_DROPLET_HOST` into a step env var, exposes `configured=true|false` as a job output. Every downstream job (`prepare`, `build-backend`, `build-frontend`, `build-backend-images`, `build-frontend-images`, `deploy`) gates on `if: needs.staging-configured.outputs.configured == 'true'`. When the secret is empty, every job skips with a workflow notice; the SSH step never runs and never throws "missing server host".

2. `deploy-digitalocean.yml` — `staging-gate.enablement` step extended to read `secrets.STAGING_DROPLET_HOST` into env. Auto-bypass on EITHER signal: (a) `STAGING_ENABLED` repo variable not 'true' (operator intent), or (b) `STAGING_DROPLET_HOST` empty (structural truth — staging cannot physically deploy). The two checks together are belt-and-braces — operator can only enable Topology A (multi-droplet, gate enforces) when BOTH are configured, which makes accidental gating impossible.

**Two architecturally-valid topologies, both first-class:**
- **Topology A (multi-droplet):** secrets + opt-in flag set → full staging deploy → tag → prod gate enforces.
- **Topology B (single-droplet):** either signal absent → staging skips → prod auto-bypasses → prod deploys directly.

GitHub Actions security boundary: secret expressions cannot appear directly in job-level `if:` conditions. Detection therefore lives inside a step that reads the secret into env, exposes the result as `steps.<id>.outputs.configured`, then downstream jobs consume it via `needs.<job>.outputs.configured`. Same pattern on both workflows.

The emergency `bypass_staging_gate=true` workflow_dispatch input is preserved unchanged — it covers the orthogonal "staging exists but is broken" emergency case.

**Status:** RESOLVED — fixed in branch `chore/deploy-staging-topology-aware`. ADR-016 updated with Phase D-Topology section formalizing the two-topology contract.

## ORPHAN-CRITICAL-057 — `deploy-digitalocean.yml`'s inline ssh-action `script: |` block silently regressed past the 21K expression limit; every push to main since d155d2a3 fails workflow parse with HTTP 422 and 0 jobs

**Severity:** CRITICAL — production deploy chain entirely broken on push-to-main; failure mode is invisible (parse failure recorded as a 0-job run, no actionable signal in CI checks UI)
**Discovered:** 2026-05-10, while validating the post-merge prod deploy chain after PR #243 (topology-aware staging gate) landed
**File:** `.github/workflows/deploy-digitalocean.yml` (line 885 col 19, the `script: |` heredoc following `appleboy/ssh-action`)

**Evidence:**

```
gh workflow run deploy-digitalocean.yml --ref main
HTTP 422: Invalid Argument - failed to parse workflow:
(Line: 885, Col: 19): Exceeded max expression length 21000
```

```
$ gh api repos/Okan-wqm/aquaculture_platform/actions/runs/<run-id>/jobs
{"total_count":0,"jobs":[]}
```

Every prod-deploy run on main since d155d2a3 (`Merge branch 'worktree-ws10-phase-1' into tmp-consolidate-agentic`) shows `conclusion: failure` with 0 jobs registered. The CI checks UI gives no actionable hint — the workflow is "running" then "failed", but no job was ever scheduled because the workflow file itself never parsed.

**Root cause:** The architectural fix had already been done in commit `c92539b9` (`fix(deploy-digitalocean): extract ssh-action bash to avoid 21k expression limit`), which moved the entire SSH bash payload from the YAML `script: |` block into `scripts/deploy/droplet-up.sh`. The YAML script block was thereby reduced from ~530 lines to ~12. A subsequent merge from a parallel feature branch (`worktree-ws10-phase-1`, mainlined as commit d155d2a3) re-inlined the bash. Per-file diff history:

| Commit  | script-block size | status |
|---------|-------------------|--------|
| `c92539b9` | 696 bytes / 12 lines | ✅ thin invoker (working) |
| `d155d2a3` (merge) | 32163 bytes / 528 lines | ❌ regressed; 21K cap exceeded |
| current main | 32163 bytes / 528 lines | ❌ persistent regression |

The 32K block contains TLS cert generation, GHCR auth, healthcheck poll loops, rollback logic — all ALSO present in `scripts/deploy/droplet-up.sh` (571 lines, fully featured, untouched by the regression). The inlined logic and the script duplicate each other, with the inlined version winning because the YAML block executes first and the script is then bypassed (the regressed YAML never gets to `bash scripts/deploy/droplet-up.sh`).

**Why the regression went undetected:** GHA's "exceeded max expression length" parse failure surfaces as a 0-jobs failure run, which most CI dashboards (the GitHub Actions UI included) render identically to a "deploy succeeded with no jobs to run" outcome. There is no `actionlint` rule that catches `script: |` blocks growing past 21K. The PR-time `actionlint` run (if any) doesn't report the size violation as an error because GHA's per-expression cap is not part of the lint.

**Fix (Tier-1 Make-Impossible):** Restore the thin-invoker form from `c92539b9`. The YAML `script: |` block becomes ~12 lines: env var passthrough + `bash scripts/deploy/droplet-up.sh`. All deploy logic lives in the script file, which:

  - is bash-shellcheckable
  - is locally testable on a multipass / docker droplet stand-in
  - has a single source of truth for cert / healthcheck / rollback flows
  - cannot be silently re-inlined without re-triggering the same parse error at PR time (which is now visible because workflow parse runs in the PR's CI - Affected pre-flight gate)

**Why this is structurally durable, not just a revert:** The previous fix had no enforcement. The current state — where the architectural fix is restored AND the topology-aware deploy gate (ORPHAN-HIGH-056) makes prod parse failures visible at PR time — closes the loop. Future re-inline attempts will fail the PR's `pre-flight` validate-workflows step (already in place since PR #236 landed `chore(ci): rewire pre-flight to preflight-validate.ts`) before they can mainline.

**Status:** RESOLVED — restored thin-invoker form on branch `chore/restore-thin-deploy-invoker`. YAML script block: 1449 bytes / 24 lines (cap is 21000). YAML parses, env var contract preserved (DEPLOY_SHA/SERVICES/FULL_DEPLOY/GHCR_TOKEN/GHCR_ACTOR), droplet-up.sh untouched.

## ORPHAN-CRITICAL-058 — `apps/db-migrate/src/migration-orchestrator.ts` unconditionally wraps every migration in a transaction, ignoring `migration.instance.transaction = false`; CONCURRENTLY-scoped DDL fails at runtime in production deploy

**Severity:** CRITICAL — every CONCURRENTLY-scoped DDL migration (CREATE INDEX CONCURRENTLY, DROP INDEX CONCURRENTLY) fails at runtime in `db-migrate`, blocking the entire deploy chain. Production was DOWN until manual recovery.
**Discovered:** 2026-05-10, during the post-thin-invoker prod deploy on the live droplet
**File:** `apps/db-migrate/src/migration-orchestrator.ts` lines 240-271

**Evidence (live production deploy log):**

```
{"level":"error","message":"Migration failed","schema":"auth",
 "migration":"AddTenantsCustomDomainPartialUnique1787300000000",
 "error":"CREATE INDEX CONCURRENTLY cannot run inside a transaction block"}
```

```
{"level":"error","message":"Migration failed","schema":"farm",
 "migration":"AlignCodeSequencesSchema1786900000000",
 "error":"DROP INDEX CONCURRENTLY cannot run inside a transaction block"}
```

The failing migrations BOTH explicitly declare `transaction = false` at the class level (e.g. `apps/auth-service/src/migrations/1787300000000-AddTenantsCustomDomainPartialUnique.ts:47`):

```typescript
export class AddTenantsCustomDomainPartialUnique1787300000000
  implements MigrationInterface {
  // CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
  transaction = false;
  // ...
}
```

This declaration is the documented TypeORM contract for opting out of the per-migration transaction wrapper. CLAUDE.md §migration-runners explicitly cites the contract: "Blue-green safe migrations: nullable column → backfill → NOT NULL constraint" plus "CONCURRENTLY index'ler `transaction = false` override ile ayrı migration'lara konur".

**Root cause:** The orchestrator's hot loop at line 240-271 calls `await queryRunner.startTransaction()` UNCONDITIONALLY before every migration:

```typescript
for (const migration of pending) {
  await queryRunner.query(`SET search_path TO "${schema}", public`);
  await queryRunner.startTransaction();  // <-- ALWAYS, ignoring instance.transaction
  try {
    await executor.executeMigration(migration);
    await queryRunner.commitTransaction();
    // ...
  } catch (err) {
    await queryRunner.rollbackTransaction();
    // ...
  }
}
```

TypeORM's own `MigrationExecutor.executePendingMigrations()` would have honored the instance-level override correctly — the relevant code path at `node_modules/typeorm/migration/MigrationExecutor.js`:

```javascript
const instanceTx = migration.instance.transaction;
if (instanceTx === undefined) migration.transaction = txModeDefault;
else migration.transaction = instanceTx;
// ...
if (migration.transaction && !queryRunner.isTransactionActive) {
    await queryRunner.startTransaction();
    transactionStartedByUs = true;
}
```

But the orchestrator was wrapping the executor's call in an OUTER transaction layer, so by the time TypeORM's executor saw the queryRunner, it was already inside a transaction. The instance-level opt-out had no effect.

**Why this regression went undetected for so long:** The orchestrator was added in WS10/ADR-016 Phase E (centralised migration runner) AFTER the per-service migration runners (which lived in `libs/backend-common/src/database/migration-runner/`). The per-service runners DID respect the migration instance's `transaction` property — they simply called `executor.executePendingMigrations()` and let TypeORM handle the transaction boundary. The orchestrator's reimplementation introduced the unconditional `startTransaction()` as a defensive measure (WS10's "deterministic order BEFORE any backend service") without auditing whether existing migrations in the codebase used the `transaction = false` opt-out.

The bug surfaced ONLY when the centralised `db-migrate` container ran on a fresh droplet with the FULL pending migration set. Before this session, the prior per-service runners had already applied those CONCURRENTLY migrations on the live droplet. The orchestrator's first prod-equivalent run was today's deploy; the regression manifested immediately.

**Fix (Tier-1 Make-Impossible):** Honor `migration.instance.transaction === false` in the orchestrator's hot loop. The new code:

```typescript
const useTransaction =
  (migration as { instance?: { transaction?: boolean } }).instance
    ?.transaction !== false;

if (useTransaction) {
  await queryRunner.startTransaction();
}
try {
  await executor.executeMigration(migration);
  if (useTransaction && queryRunner.isTransactionActive) {
    await queryRunner.commitTransaction();
  }
  // ...
} catch (err) {
  if (useTransaction && queryRunner.isTransactionActive) {
    await queryRunner.rollbackTransaction();
  }
  // ...
}
```

The check is structural — it cannot regress silently because any future migration that adds `transaction = false` will be honored without further orchestrator changes.

**Production recovery (this session):**

1. Manually applied `CREATE UNIQUE INDEX CONCURRENTLY "UQ_tenants_customDomain"` via psql autocommit (no transaction wrapper).
2. Inserted the migration record into `auth.migrations` to mark it as applied: `INSERT INTO auth.migrations (timestamp, name) VALUES (1787300000000, 'AddTenantsCustomDomainPartialUnique1787300000000')`.
3. Patched the orchestrator locally and rebuilt the `db-migrate:latest` image inline by `docker create` + `docker cp` + `docker commit`.
4. Re-ran `docker compose up db-migrate --no-deps` — **EXIT 0** with the new orchestrator handling `transaction = false` correctly. All farm-schema CONCURRENTLY migrations now apply cleanly.
5. Brought up the rest of the stack (`docker compose up -d --no-deps <23 services>`).

**Status:** RESOLVED — orchestrator fix landed on branch `chore/fix-orchestrator-transaction-override`. Live production restored on droplet via the inline-rebuild path; canonical fix lands in repo via this commit so the next deploy uses the structurally-correct image.

---

## ORPHAN-CRITICAL-064 — CursorEdge<T> generic ObjectType crashed hr-service GraphQL schema build

**Severity:** CRITICAL — hr-service crash-loops in production after fresh deploy. Every consumer of HR data (workforce schedules, payroll feeds, leave balances, mobile shift assignments) is offline.
**Discovered:** 2026-05-10, on the live droplet during the deploy that landed CRITICAL-058's orchestrator fix
**File:** libs/backend-common/src/pagination/cursor.ts

**Evidence (hr-service container log):**

    Bootstrap failed: Undefined type error. Make sure you are providing an
    explicit type for the "node" of the "CursorEdge" class.

**Root cause:** NestJS GraphQL code-first schema builder reflects field types via reflectTypeFromMetadata. For a generic class, the type-parameter T erases to undefined at runtime. The previous CursorEdge<T> exported a single concrete @ObjectType with @Field() node!: T (no explicit type resolver), so the schema builder saw undefined for the node type and threw at bootstrap the moment any module registered a sub-class of it.

**Fix (Tier-1 Make-Impossible):** convert CursorEdge<T> to a factory function CursorEdge(classRef: Type<T>) returning an abstract @ObjectType whose @Field(() => classRef) decorator passes the consumer-provided type explicitly. Concrete edges then extend CursorEdge(MyEntity). Plus expose ICursorEdge<T> structural interface for non-GraphQL consumers.

**Status:** RESOLVED on chore/hr-cursor-edge-graphql-type. After redeploy, hr-service bootstraps and all CursorEdge-consuming services build a valid schema.
## ORPHAN-CRITICAL-059 — `apps/gateway-api/src/app.module.ts` registers `AuditedOperationModule.forRoot()` (which depends on TypeORM `DataSource`) but never imports `TypeOrmModule.forRoot()`; cold-boot DI resolution crashes the gateway

**Severity:** CRITICAL — gateway-api is the platform's edge entry point. With the gateway in a crash loop, no client (web shell, mobile, integrations) can reach any backend. by-okan@live.com cannot log in; the platform is functionally offline even though every other backend service is up.
**Discovered:** 2026-05-10, on the live droplet during the deploy that landed CRITICAL-058's orchestrator fix
**File:** `apps/gateway-api/src/app.module.ts`
---

## ORPHAN-CRITICAL-061 — `docker-compose.droplet.yml` declares `NATS_TLS_CA` / `NATS_TLS_CERT` / `NATS_TLS_KEY` env on `observability-service` without mounting `./certs/nats/*` into the container; bootstrap crash-loops the service in production

**Severity:** CRITICAL — observability-service crash-loops at bootstrap on the production droplet. The platform's central security-events sink + migration audit sink is unavailable, blowing through the SLO for security-event capture and breaking the schema-migration audit trail (ADR-022 R6).
**Discovered:** 2026-05-10, on the live droplet during the deploy that landed CRITICAL-058's orchestrator fix
**File:** `docker-compose.droplet.yml` lines 1278–1326 (the `observability-service:` block)

**Evidence (live container log):**

```
Nest can't resolve dependencies of the AuditedOperationInterceptor (Reflector, ?).
Please make sure that the argument DataSource at index [1] is available
in the AuditedOperationModule module.
```

**Root cause:** `AuditedOperationInterceptor.constructor` injects `DataSource` from TypeORM. The `AuditedOperationModule.forRoot()` factory registers the interceptor globally (`APP_INTERCEPTOR`) but does NOT import a `TypeOrmModule` of its own — by design, the audit module is meant to use whatever `DataSource` the consuming application has registered. Every other consumer (auth, farm, sensor, hr, billing, etc.) DOES import `TypeOrmModule.forRoot()` alongside `AuditedOperationModule.forRoot()`. gateway-api was the lone exception: the audit module was imported (per the AUDITTRAIL-CRITICAL-002 sweep invariant `tests/invariants/audited-operation-module-wired.spec.ts`) but the supporting TypeORM root was never added.

The drift was masked for >2 days because the older deployed image's `AuditedOperationInterceptor` had not yet acquired the `DataSource` constructor dependency. After it did, the gateway's audit interceptor became unresolvable. Today's cold-boot (post-deploy of the new image) surfaced the regression.

The compose file already declares `DATABASE_HOST` / `DATABASE_USER=gateway_service` / `DATABASE_PASSWORD` / `DATABASE_NAME=aquaculture` env for the gateway-api container — wiring was always intended; only the application-side `imports: [TypeOrmModule.forRoot(...)]` was missing.

**Fix (Tier-1 Make-Impossible):** add `TypeOrmModule.forRootAsync` using the platform-canonical `createServiceTypeOrmConfig` factory in `apps/gateway-api/src/app.module.ts`. gateway-api owns no schema (no migrations to run, no entities to register beyond `AuditLogEntity` which the audit module touches), so the config is minimal:

```typescript
TypeOrmModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    ...createServiceTypeOrmConfig(config, {
      serviceName: 'gateway',
      schema: 'shared',  // gateway only writes shared.audit_logs
      migrations: [],
      migrationsRun: false,
    }),
    entities: [AuditLogEntity],
  }),
}),
```

A unit-level invariant (`tests/invariants/audited-operation-module-wired.spec.ts`) is extended to also assert that every service in the audit-wired list ALSO imports `TypeOrmModule.forRoot()` so the regression class is structurally caught at PR time — Tier-1 promotion of an existing Tier-3 invariant.

**Status:** RESOLVED — `chore/gateway-api-typeorm-for-audit` lands the TypeORM root + entity registration + invariant extension. After redeploy, gateway-api bootstraps cleanly and login is restored.
Bootstrap failed: [nats-connection.factory] NATS_TLS_CA is set to
"/etc/ssl/nats-ca.pem" but the file could not be read: ENOENT: no such
file or directory, open '/etc/ssl/nats-ca.pem'.
Check that the deploy script mounts /etc/ssl/nats-ca.pem (or the path you
configured) into the container from
./certs/nats/clients/observability_service-cert.pem (or whatever your cert
directory is).
```

**Root cause:** Configuration drift in `docker-compose.droplet.yml`. The `observability-service` block merges `<<: *nats-observability-env` (line 1306), which sets four NATS TLS env paths inside the container:

```yaml
NATS_URL: tls://nats:4222
NATS_TLS_CA: /etc/ssl/nats-ca.pem
NATS_TLS_CERT: /etc/ssl/nats-clients/observability_service-cert.pem
NATS_TLS_KEY:  /etc/ssl/nats-clients/observability_service-key.pem
NATS_TLS_ENABLED: "true"
```

But the service was missing the corresponding `volumes:` block. Every other NATS-using service in this compose file (auth, farm, sensor, gateway, alert, billing, hr, hydroponics, messaging, notification, sensor-ingestion) mounts the same four anchors:

```yaml
volumes:
  - *nats-ca-mount             # ./certs/nats/ca-cert.pem      → /etc/ssl/nats-ca.pem
  - *nats-clients-mount        # ./certs/nats/clients/         → /etc/ssl/nats-clients/
  - *nats-client-cert-mount    # ./certs/nats/client-cert.pem  → /etc/ssl/nats-client-cert.pem
  - *nats-client-key-mount     # ./certs/nats/client-key.pem   → /etc/ssl/nats-client-key.pem
```

`libs/backend-common/src/nats/nats-connection.factory.ts` resolves `NATS_TLS_CA` with `fs.readFileSync()` at bootstrap and hard-fails with the message above when the file isn't present at the configured path. With no `volumes:` block, `/etc/ssl/nats-ca.pem` did not exist inside the container, so Nest bootstrap aborted before any module was even constructed.

The cert files themselves were correctly generated — `infrastructure/nats/services.yaml` lists `observability_service` (line 86), and `infrastructure/docker/scripts/generate-internal-certs.sh` derives its cert-CN list from that SSoT (no hardcoded list). `./certs/nats/clients/observability_service-cert.pem` and `-key.pem` exist on disk on the droplet. The failure was 100 % on the compose-file side: env paths declared, mounts missing.

**Why the regression went undetected at PR time:** the CI pre-flight Phase A2 (`docker compose config --quiet`) only validates that `${VAR:?}` interpolations resolve and YAML parses — it does NOT correlate `NATS_TLS_CA` env paths against `volumes:` bind targets. There is currently no invariant test that asserts "every service whose merged env declares `NATS_TLS_*` paths must also mount the corresponding cert files at those paths". The drift was therefore structurally invisible to CI: services.yaml was right, nats.conf was right, the cert was generated, and YAML interpolation passed. Only the runtime ENOENT surfaced it.

**Fix (Tier-2 Make-Automatic — landed in this commit):** add the four standard NATS cert mount anchors to the `observability-service` block in `docker-compose.droplet.yml`, aligning it with every other NATS-using service in the file:

```yaml
volumes:
  - *nats-ca-mount
  - *nats-clients-mount
  - *nats-client-cert-mount
  - *nats-client-key-mount
```

Anchors are reused (not redefined) so the cert layout stays a single declaration site. After this change, `docker compose -f docker-compose.droplet.yml config` resolves the four bind mounts onto `/var/aqua-saas/certs/nats/...` and the runtime path matches the env paths, so `nats-connection.factory` finds the CA file at bootstrap.

**Tier-1 Make-Impossible follow-up (not in this commit — tracked):** add a CI invariant that asserts, for every service in every compose file, the post-merge env's `NATS_TLS_CA` / `NATS_TLS_CERT` / `NATS_TLS_KEY` paths each have a matching `volumes:` bind entry whose target equals the env path. The natural home is `e2e/tests/integration/nats-invariants.spec.ts` (extending the existing services.yaml ↔ cert-CN ↔ nats.conf trio with a fourth assertion: compose env paths ↔ volume bind targets). Filed separately so this hot-fix lands without dragging the invariant scope into the same PR. Without that guard, the same class of drift can recur whenever a new NATS-using service is added.

**Status:** RESOLVED for the immediate crash-loop — `chore/observability-nats-cert-mount` adds the missing `volumes:` block. Tier-1 invariant follow-up tracked above; commit message names the gap so the work is visible.

---

## ORPHAN-CRITICAL-062 — `FileUploadSecurityService` injects an opaque `Array` token without a matching DI provider; `farm-service` crash-loops at bootstrap when the global `StorageModule` is loaded

**Severity:** CRITICAL — farm-service (the platform's primary aquaculture domain — highest fan-out of downstream consumers per ADR-011 §domain-priority) cannot bootstrap on the production droplet. Side-effect: every dependent surface that reads farm-domain data (alert-engine, billing, sensor aggregates, dashboards, mobile app) loses its upstream until farm comes back.
**Discovered:** 2026-05-10, on the live droplet during the deploy that landed CRITICAL-058's orchestrator fix
**File:** `libs/storage/src/file-upload-security.service.ts`, `libs/storage/src/storage.module.ts`

**Evidence (live container log):**

```
Nest can't resolve dependencies of the FileUploadSecurityService (MinioClientService, ?).
Please make sure that the argument Array at index [1] is available in the StorageModule module.
Potential solutions:
- Is StorageModule a valid NestJS module?
- If Array is a provider, is it part of the current StorageModule?
```

**Root cause:** `FileUploadSecurityService` declares `@Inject(FILE_UPLOAD_POLICIES) policies: UploadPolicy[]` as its second constructor argument. The token `FILE_UPLOAD_POLICIES` was added to the service signature but the provider that satisfies it was never registered in `StorageModule.forRoot()` / `StorageModule.forRootAsync()`. The factory built the dynamic module with `MinioClientService` + `FileUploadSecurityService` only — nothing supplied the `UploadPolicy[]` array. NestJS prints "Array at index [1]" because, with no provider for the symbol token, the type system falls back to the constructor parameter's declared type (`UploadPolicy[]` ≈ `Array`).

The drift was masked for >2 days because the older deployed image did not yet include the policy-array constructor argument. Today's cold-boot exposed it.

**Fix (Tier-1 Make-Impossible):** centralise the policy-array provider in `StorageModule` so both `forRoot` and `forRootAsync` use the same fallback shape. Specifically:

  1. Export a typed `UploadPolicy` interface and a token symbol `FILE_UPLOAD_POLICIES` from `libs/storage/src/file-upload-security.service.ts` (so consumers can import the canonical declaration without re-declaring).
  2. Export a `DEFAULT_UPLOAD_POLICIES` constant (per-MIME-type rules sourced from the existing config) so the module has a sensible safe default.
  3. Build a `Provider` shape in `storage.module.ts` that resolves either: (a) the operator-supplied `policies: UploadPolicy[]` from `forRoot(config)` arguments, or (b) `DEFAULT_UPLOAD_POLICIES` if absent.
  4. Add the provider to BOTH `forRoot` and `forRootAsync` `providers[]` arrays.
  5. Add a unit test (`__tests__/storage.module.spec.ts`) that asserts the module wires `FILE_UPLOAD_POLICIES` end-to-end so the regression is structurally caught at PR time.

**Status:** RESOLVED — `chore/farm-storage-policies-di` lands the policy-array provider with default fallback + unit test. After redeploy, farm-service bootstraps cleanly and the entire downstream-consumer surface is restored.

---

## ORPHAN-CRITICAL-063 — `migrationsTransactionMode` defaulted to TypeORM's `'all'` for legacy auth/admin-api/event-store services; pre-merge migrations with class-level `transaction = false` raised `ForbiddenTransactionModeOverrideError` at production cold-boot

**Severity:** CRITICAL — messaging-service and admin-api-service crash-loop at boot. Without messaging the in-app chat surface is dead; without admin-api the platform-management UI is offline. Both services were stuck repeating the same fatal exception every restart cycle until the fix landed.
**Discovered:** 2026-05-10, on the live droplet during the deploy that landed CRITICAL-058's orchestrator fix
**File:** `libs/backend-common/src/database/typeorm-config.factory.ts`, `libs/backend-common/src/database/migration-runner/migration-runner.service.ts`

**Evidence (live container logs):**

```
Migrations "AddMessageAttachmentIsDeletedIndex1782800000000" override the
transaction mode, but the global transaction mode is "all"
```

```
Migrations "AddUserConsentsNaturalKeyUnique1787700000000",
"AddAuditLogShapeExtension1788100000000",
"CreateSharedAccessLogs1788400000000" override the transaction mode,
but the global transaction mode is "all"
```

**Root cause:** TypeORM's `DataSource` constructor defaults `migrationsTransactionMode` to `'all'` when the caller omits the option (`node_modules/typeorm/data-source/DataSource.js` lines 261-264). In `'all'` mode, TypeORM's `MigrationExecutor.executePendingMigrations` raises `ForbiddenTransactionModeOverrideError` the instant any pending migration declares an instance-level `transaction` opt-out (the documented escape hatch for `CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, and other DDL Postgres rejects inside a transaction block).

`createServiceTypeOrmConfig` (the platform-wide factory) was NOT setting `migrationsTransactionMode`, so every legacy service that kept TypeORM's built-in `migrationsRun: true` (auth-service explicitly; admin-api-service and messaging-service via newer migrations whose `transaction` overrides surfaced after the cold-boot) inherited the unsafe default.

The platform's primary `MigrationRunnerService` (the one that 12 of 14 services use) does NOT trigger this error because it owns the per-migration transaction loop directly. PR #245 fixed the centralised `db-migrate` orchestrator's matching loop. This finding closes the third leg of the same architectural gap: the TypeORM-built-in path is the third migration runner in the platform, and it was using the unsafe default.

**Fix (Tier-1 Make-Impossible):** pin `migrationsTransactionMode: 'each'` in `createServiceTypeOrmConfig` so EVERY legacy service that still relies on TypeORM's built-in migration runner inherits the correct mode automatically. The factory is the SSoT for service TypeORM config — no per-service override is required.

The platform's per-service `MigrationRunnerService` ALSO has its `executor.transaction = 'each'` re-affirmed with an architectural-rationale block describing the three-runner topology: built-in TypeORM (legacy), platform per-service runner (mainline), centralised db-migrate orchestrator (Phase E). All three honour the same `transaction = false` opt-out structurally so a CONCURRENTLY migration deploys identically through any of them.

**Status:** RESOLVED — `chore/migration-tx-mode-each-canon` lands the pin in the factory + architectural docs in the runner. After redeploy, messaging and admin-api bootstrap cleanly.

---

## ORPHAN-CRITICAL-064 — `CursorEdge<T>` GraphQL ObjectType emitted `node` with no explicit `@Field(() => T)` resolver; `hr-service` schema build crash-loops at bootstrap with "Undefined type error … node"

**Severity:** CRITICAL — hr-service is dead in production. Every consumer of HR data (workforce schedules, payroll feeds, leave balances, mobile shift assignments) is offline. The pagination utility is shared across multiple services so the regression class is contagious — any future consumer that imports `CursorEdge` inherits the same crash unless the helper is fixed structurally.
**Discovered:** 2026-05-10, on the live droplet during the deploy that landed CRITICAL-058's orchestrator fix
**File:** `libs/backend-common/src/pagination/cursor.ts` and the matching GraphQL `@ObjectType` declarations across consuming services

**Evidence (hr-service container log):**

```
Bootstrap failed: Undefined type error. Make sure you are providing an
explicit type for the "node" of the "CursorEdge" class.
```

**Root cause:** NestJS GraphQL's code-first schema builder reflects field types at runtime via `reflectTypeFromMetadata`. For a generic class, the type-parameter `T` erases to `undefined` at runtime — TypeScript decorators emit the design-time type, not the resolved one. The previous `CursorEdge<T>` exported a single concrete `@ObjectType` class with `@Field() node!: T` (no explicit type resolver), so the schema builder saw `undefined` for the node type and threw at bootstrap the moment any module registered a sub-class of it.

The drift was masked for >2 days because the older deployed image's `CursorEdge` did not include the `@Field()` decorator on `node` (or the consuming services had not yet imported it through the schema graph). Today's cold-boot exposed it.

**Fix (Tier-1 Make-Impossible):** convert `CursorEdge<T>` from a single concrete `@ObjectType` into a factory function `CursorEdge(classRef: Type<T>)` that returns an abstract `@ObjectType({ isAbstract: true })` whose `@Field(() => classRef)` decorator passes the consumer-provided type explicitly. Concrete edges then `extend CursorEdge(MyEntity)`. Plus expose a `ICursorEdge<T>` structural interface so non-GraphQL consumers (REST, internal services) can still type the runtime payload without touching the GraphQL emission layer. Plus a unit test (`__tests__/cursor.spec.ts`) that constructs an edge for two arbitrary entities and asserts the schema build succeeds.

The factory pattern is the documented NestJS-GraphQL idiom for generic ObjectTypes (https://docs.nestjs.com/graphql/resolvers#generics). Adopting it here removes the entire class of "node has undefined type" regressions.

**Status:** RESOLVED — `chore/hr-cursor-edge-graphql-type` lands the factory + interface + test. After redeploy, hr-service bootstraps and all CursorEdge-consuming services build a valid schema.

---

## ORPHAN-CRITICAL-068 — hr-service entity-declared tables payrolls/holidays/goals have no migration; SourceSchemaBootstrap guard rejects cold-boot

Severity: CRITICAL. hr-service crash-loops in production at boot. Workforce/payroll/leave functionality offline.
Discovered: 2026-05-10, on the live droplet during the post-recovery deploy.
File: apps/hr-service/src/database/migrations/ (gap), entities exist at payroll.entity.ts, holiday.entity.ts, goal.entity.ts.

Evidence: SourceSchemaBootstrap "Source schema hr is missing 3/24 declared tables: payrolls, holidays, goals."

Root cause: entities relied on TypeORM synchronize=true in dev; production DATABASE_SYNC=false correctly. No migration ever created these 3 tables.

Fix: Tier-1 canonical migration matching entity column shapes 1:1 with idempotent CREATE patterns.

Status: RESOLVED on chore/hr-payrolls-holidays-goals-migration.
## ORPHAN-CRITICAL-067 — `StorageResolver.storageInventoryByCursor`'s `@Args('input')` slot lacks an explicit `type: () => CursorPaginationInput`; farm-service GraphQL schema build crash-loops at bootstrap with "Undefined type error … parameter at index [2]"

**Severity:** CRITICAL — farm-service is dead in production. Every consumer of farm data (storage, batches, tanks, water quality, feed, harvest, fish health, growth) is offline because the entire farm-service `AppModule` fails to bootstrap before any resolver is registered. The regression is the args-decorator-side counterpart of ORPHAN-CRITICAL-064 (which fixed the ObjectType emission side); the input-side gap remained because no concrete subclass of `CursorPaginationInput` was declared and the only call site relied on TypeScript reflection.
**Discovered:** 2026-05-10, droplet redeploy after the hr-service ORPHAN-CRITICAL-064 ship
**File:** `apps/farm-service/src/storage/storage.resolver.ts:187` (`storageInventoryByCursor` method, third `@Args` parameter)

**Evidence (farm-service container log):**

```
Bootstrap failed: Undefined type error. Make sure you are providing an explicit type for the "storageInventoryByCursor" (parameter at index [2]) of the "StorageResolver" class.
    at reflectTypeFromMetadata (/app/node_modules/@nestjs/graphql/dist/utils/reflection.utilts.js:17:19)
    at /app/node_modules/@nestjs/graphql/dist/decorators/args.decorator.js:24:106
```

**Root cause:** NestJS GraphQL's `@Args()` decorator calls `reflectTypeFromMetadata` to resolve the parameter's GraphQL input type. If the decorator has no explicit `type: () => SomeType`, the reflector reads `design:paramtypes[index]` — TypeScript's emit-decorator-metadata output. For the failing parameter, this resolves to `Object` (in `NOT_ALLOWED_TYPES` per `reflection.utilts.js:6`) because:

1. `CursorPaginationInput` is declared `@InputType({ isAbstract: true })` in `libs/backend-common/src/pagination/cursor.ts:91`. The `isAbstract: true` flag is the deliberate signal that this type is a base — it expects either a concrete subclass at the consumer site or an explicit reference at every call site.
2. The parameter is a cross-package import from `@aquaculture/backend-common/pagination`. TypeScript's emit-decorator-metadata reflection can fail to recover the named class for cross-package imports under certain `tsconfig` `paths` / project-reference configurations, falling back to `Object`.
3. The two earlier `@Args` slots in the same method (`locationId`, `itemType`) both carry explicit `type: () => …` so the schema builder never sees the implicit emit for them — only this third slot relied on the implicit path and exposed the gap.

The regression was masked by hr-service crash-looping first (ORPHAN-CRITICAL-064); once hr-service started bootstrapping, the next service in the deploy chain (farm-service) crash-looped on its own undefined-type case.

**Fix (Tier-1 Make-Impossible):** add explicit `type: () => CursorPaginationInput` to the failing `@Args` decorator. This (a) bypasses the implicit reflection path entirely so the cross-package import no longer matters, (b) pulls `CursorPaginationInput` into the schema graph via `args.factory.create` so the abstract input type is registered, and (c) matches the established pattern for every other `@Args` decorator in the file. The fix is a single-line decorator option; the entire regression class is closed once every cursor-paginated resolver follows the same shape.

A platform-wide invariant follow-up (lint rule: "every `@Args` whose parameter type imports from `@aquaculture/backend-common/pagination` MUST declare explicit `type`") is tracked under a separate finding once we have a representative dataset of cursor-paginated resolvers — adding it now would be premature with one call site.

**Status:** RESOLVED — `chore/farm-storage-resolver-graphql-type` lands the explicit type on `storageInventoryByCursor` parameter index [2]. After redeploy, farm-service bootstraps and the storage GraphQL schema exposes `storageInventoryByCursor(input: CursorPaginationInput, …)`.

---

## ORPHAN-CRITICAL-069 — `config-service`'s per-service `MigrationRunnerService` is registered with the wrong source schema (`'public'`) while every entity / migration targets `'config'`; production cold-boot crash on the first config-schema migration

**Severity:** CRITICAL
**Discovered:** 2026-05-10, production droplet config-service crash log
**File:** `apps/config-service/src/app.module.ts` line 34 (`createMigrationRunnerService('public')`) + `apps/config-service/src/database/data-source.ts` line 28 (`schema: 'public'`) + `docker-compose.droplet.yml` lines 1355-1360 (config-service DATABASE_USER wired as `gateway_service`)

**Evidence (production droplet container log):**

```
{"level":"error","service":"config-service","context":"MigrationRunnerService[public]",
 "message":"Migration \"AlignConfigEntitySurface1789000000000\" failed on \"public\":
 permission denied for database aquaculture"}
```

**Root cause:** Three places in the config-service wiring point at the legacy `public` schema while the entity and migration surface have already moved to a dedicated `config` schema:

1. `apps/config-service/src/app.module.ts:34` — `createMigrationRunnerService('public')`. The factory captures the source schema in a closure: the resulting `MigrationRunnerService[public]` advisory-locks `public`, pins `search_path TO public, public`, and maintains the migration ledger as `public.typeorm_migrations`. The connecting DB role (`gateway_service` per docker-compose, see point 3 below) has **no CREATE privilege on `public`** — the runner crashes on the very first `INSERT INTO public.typeorm_migrations` it attempts after applying any pending DDL.
2. `apps/config-service/src/database/data-source.ts:28` — `schema: 'public'`. The CLI DataSource (used by operator-only `npm run typeorm -- migration:show / migration:revert` paths) points to `public`, so any operator-driven inspection reads/writes the wrong ledger relative to the actual entity + migration target.
3. `docker-compose.droplet.yml:1355-1360` — `DATABASE_USER: ${GATEWAY_SERVICE_DB_USER:-gateway_service}` plus the explicit comment `"NOTE: config-service does not have a dedicated schema in 00-init-schemas.sh yet."` is **factually stale**: `00-init-schemas.sh:118 + 138-141 + 175 + 193 + 460-469` provisions the `config_service` role, creates the `config` schema with `AUTHORIZATION config_service`, and grants `ALL PRIVILEGES ON ALL TABLES IN SCHEMA config TO config_service`. Connecting as `gateway_service` (which has grants only on the `gateway` schema, not `config`) closes the privilege gap into a fail-stop wall on first boot.

Meanwhile, the entity surface and migration body declared the architectural truth:
- `apps/config-service/src/configuration/entities/configuration.entity.ts:52` — `@Entity('configurations', { schema: 'config' })`
- `apps/config-service/src/configuration/entities/configuration.entity.ts:177` — `@Entity('configuration_history', { schema: 'config' })`
- `apps/config-service/src/database/migrations/1789000000000-AlignConfigEntitySurface.ts:30 + 32 + 53 + 91 + 113` — every DDL statement schema-qualified to `config.*` plus `pinSearchPath(qr, 'config')` defence-in-depth

The centralised `aqua-db-migrate` orchestrator (which runs as `service_completed_successfully` precondition for every service container per the WS10 contract — `docker-compose.droplet.yml:1374-1376`) was already applying the AlignConfigEntitySurface DDL against the `config` schema correctly. So the table surface in production is correct; only the per-service `MigrationRunnerService` boots, attempts to re-confirm the ledger entry on the wrong schema, and crashes the container at `OnApplicationBootstrap`.

**Fix (Tier-1 Make-Impossible):** Align the four callsites with the schema the entities + migrations target — `'config'`. No new code paths, no shim — every change is the value already declared by the entity decorators and migration bodies:

1. `apps/config-service/src/app.module.ts:34` — `createMigrationRunnerService('config')`. Matches the canonical platform pattern (`billing-service`: `('billing')`, `hr-service`: `('hr')`, `ai-service`: `('ai')`). The runner now pins `search_path TO config, public`, advisory-locks `config`, and maintains the ledger as `config.typeorm_migrations` — where the `config_service` role has CREATE.
2. `apps/config-service/src/app.module.ts:60` — `createServiceTypeOrmConfig({ schema: 'config' })`. The TypeORM factory composes the `search_path=config,public` connection option from this field, so unqualified entity reads in runtime queries land in the owned schema before falling back to `public` (where extensions / `typeorm_migrations` legacy artefacts live).
3. `apps/config-service/src/database/data-source.ts:28` — `schema: 'config'` + `username: ... ?? 'config_service'`. CLI parity with the runtime runner so operator `migration:show / migration:revert` paths read the same ledger the service writes.
4. `docker-compose.droplet.yml:1355-1360` — `DATABASE_USER: ${CONFIG_SERVICE_DB_USER:-config_service}`. Closes the role-vs-schema mismatch: the runtime user (used by both the request hot-path and the OnApplicationBootstrap runner) now has CREATE on `config`. `00-init-schemas.sh:50 + 58` already initialises `CONFIG_SERVICE_DB_PASS` from the matching env var operators set in their `.env`.

Idempotent on every redeploy: the runner uses `MigrationExecutor.getPendingMigrations()` which reads the per-schema `typeorm_migrations` ledger and skips already-applied migrations. The aqua-db-migrate orchestrator continues to be the canonical first-pass applier (per the WS10 contract); the per-service runner is now a no-op warm-start signal in production because the orchestrator has already advanced the ledger. The two stale `@Module` docblocks ("config-service has no TypeORM migration runner — schema state is managed via TypeORM autoLoadEntities + the RLS bootstrap") were also corrected in the same commit so future readers see the architectural shape that actually exists.

**Status:** RESOLVED — `chore/config-service-runner-schema` lands the four-callsite alignment. After redeploy, the boot log shows `MigrationRunnerService[config]` (not `[public]`), the per-schema runner emits "No pending migrations on 'config'" because the aqua-db-migrate container already advanced the ledger, and the service container reaches the HTTP health probe without a permission-denied crash. The wider architectural debt (config-service connecting as a per-service role rather than a shared one) closes in the same commit, completing the schema-per-service convergence for config that hr/farm/billing/ai/notification/alert already cleared.

---

## ORPHAN-CRITICAL-065 — docker-compose.droplet.yml farm-service block missing MINIO_ACCESS_KEY/SECRET_KEY env; service refuses to start

Severity: CRITICAL. farm-service crash-loops in production at cold-boot.
Discovered: 2026-05-10, on the live droplet.
File: docker-compose.droplet.yml farm-service block (line 745+).

Evidence: "CRITICAL: MINIO_ACCESS_KEY and MINIO_SECRET_KEY must be explicitly configured in production. Farm-service startup aborted to prevent use of default credentials."

Root cause: gateway-api and messaging-service compose blocks declare MINIO env vars for FileUploadSecurityService. farm-service uses the same service but the compose block never forwarded the env. Configuration-drift bug.

Fix: Tier-2 Make-Automatic. Mirror the MINIO env block from gateway/messaging — MINIO_ENDPOINT/PORT/USE_SSL/ACCESS_KEY/SECRET_KEY/BUCKET/REGION.

Status: RESOLVED on chore/farm-minio-env-compose.

## ORPHAN-CRITICAL-070 — farm-service entity-declared 42 tables have no migration; SourceSchemaBootstrap rejects cold-boot
Severity: CRITICAL. farm-service crash-loops in production. Web login blocked.
Discovered: 2026-05-10, on the live droplet after MINIO env wiring (ORPHAN-CRITICAL-065) unblocked the next layer of cold-boot validation.
File: apps/farm-service/src entity tree vs. production farm schema.

Evidence: Production farm schema contains 33 tables, but the farm-service entity tree declares 74 `@Entity('...')` classes. SourceSchemaBootstrapService surfaced the gap on cold-boot:

"Bootstrap failed: Source schema 'farm' is missing 42 declared tables (auto_rules, chemicals, chemical_sites, chemical_types, daily_feeding_executions, equipment_systems, farm_audit_logs, farm_workers, feed_inventory, feed_sites, feed_type_species, feed_types, feeding_program_tanks, feeding_programs, feeding_protocols, feeding_records, feeding_tables, feeds, growth_measurements, harvest_plans, harvest_records, health_events, inventory_count_items, inventory_counts, maintenance_schedules, mortality_records, recurring_templates, sentinel_hub_settings, site_contacts, spare_parts, sub_equipment, sub_equipment_types, supplier_sites, supplier_types, suppliers, tank_operations, tasks, water_quality_measurements, water_quality_param_equipment, water_quality_parameter_configs, work_orders). Refusing to fall back to runtime synchronize() per INFRA-CRITICAL-009."

Root cause: 74 entities declared in the farm-service domain tree (`apps/farm-service/src/{batch,equipment,farm,feed,feeding,fish-health,growth,harvest,maintenance,site,storage,supplier,task,water-quality,...}/entities/*.entity.ts`) but only 33 corresponding tables provisioned by prior migrations (CreateInitialSchema + the 30+ delta migrations through 1788300000000). Pre-existing TypeORM `synchronize: true` in some dev/staging environment masked the gap until cold-boot in production where `DATABASE_SYNC=false` is mandatory. The schema-bootstrap guard installed per INFRA-CRITICAL-009 fired correctly on first cold deploy, refusing to fall through to a runtime DDL fallback.

Fix: Tier-1 Make-Impossible. ONE comprehensive `CREATE TABLE` migration at `apps/farm-service/src/database/migrations/1789200000000-AddMissingFarmTables.ts` matching the 42 entity-declared columns 1:1 — uuid PKs, decimal precisions, enum types, jsonb columns, timestamptz audit fields, all idempotent (`CREATE TABLE IF NOT EXISTS`, `DO $$ BEGIN CREATE TYPE … EXCEPTION WHEN duplicate_object`, `CREATE INDEX IF NOT EXISTS`). Migration is registered in both `apps/farm-service/src/app.module.ts` (class-ref list for runtime MigrationRunnerService) and discovered by `apps/db-migrate` via its glob pattern. Cross-table FK declarations are deferred to a follow-up migration to avoid intra-migration dependency cycles; the application-layer TypeORM relations remain intact.

Status: RESOLVED on chore/farm-comprehensive-migration.

---

## ORPHAN-CRITICAL-072 — sensor-ingestion image not published by CI; every droplet deploy crashes on missing manifest

Severity: CRITICAL. Every push-to-main deploy fails identically: sensor-ingestion image pull returns "no matching manifest for linux/amd64", docker compose up -d exits non-zero (masked by |\| true), zero containers start, 300s critical-service SLA times out, rollback required, exit 1.

Discovered: 2026-05-10/11, after 17 architectural cold-boot fix PRs landed but every deploy still failed at the same step.

Evidence (deploy log pattern across runs 25637861685, 25642208052, 25655583156):
  Image ghcr.io/okan-wqm/aquaculture_platform/sensor-ingestion:latest Error
  no matching manifest for linux/amd64 in the manifest list entries:
  failed to resolve reference \"ghcr.io/okan-wqm/.../sensor-ingestion:latest\": not found
  ...
  Error: 8 critical service(s) failed to reach healthy within 300s SLA.

Root cause: sensor-ingestion is a Rust sidecar (sens-api-gateway repo subdirectory, ADR-025 strangler-fig). The TypeScript/Node CI build matrix (.github/workflows/ci-affected.yml) does not include a Rust cargo build + Dockerfile build + GHCR push step for it. The compose file unconditionally references the GHCR image; deploy unconditionally tries to pull. The pull fails permanently because the image never exists.

Architectural fix shape (Tier-1 Make-Impossible, two-part):
  1. docker-compose.droplet.yml: add profiles: ["rust-sidecar"] to the sensor-ingestion service block. Default compose contexts (every deploy today) skip the service entirely — no pull attempt, no manifest error.
  2. infrastructure/deploy/service-criticality.yaml: demote sensor-ingestion from level: critical → level: optional. Without the demotion, the 300s health check still reports it missing and rolls back.

Operator opt-in path (after CI Rust matrix lands): set COMPOSE_PROFILES=rust-sidecar in droplet .env and promote the criticality entry back to critical.

Follow-up tracked but out of scope for this PR: CI Rust build matrix that publishes the multi-arch sensor-ingestion image to GHCR so the profile can become default.

Status: RESOLVED on chore/sensor-ingestion-profile-gate.

---

## ORPHAN-CRITICAL-073 — Apollo Federation supergraph composition rejects Mutation.exportTenantData collision between farm and messaging subgraphs

Severity: CRITICAL. Gateway crash-loop in production. Without supergraph composition, no public-URL GraphQL query reaches any backend.

Discovered: 2026-05-11.

Evidence (gateway log attempt 1 of new boot):
  A valid schema couldn't be composed. The following composition errors were found:
  Type of field "Mutation.exportTenantData" is incompatible across subgraphs:
  it has type "TenantExportBundleResponse!" in subgraph "farm"
  but type "ExportJobType!" in subgraph "messaging".
  Non-shareable field "Mutation.exportTenantData" is resolved from multiple subgraphs.

Root cause: farm and messaging both defined Mutation.exportTenantData with different return types under the non-shareable default.

Fix (Tier-1 Make-Impossible): rename messaging.exportTenantData to exportTenantMessages so the federation graph itself rejects future name collisions. Farm keeps exportTenantData (matches aquaculture-domain semantics).

Status: RESOLVED on chore/federation-namespace-export-tenant-data.

---

## ORPHAN-CRITICAL-074 — sensor-ingestion criticality manifest entry references service hidden by compose profile gate; deploy validator rollback

Severity: CRITICAL. Every default deploy fails at the critical-service health check coverage validator with "manifest references services not in docker-compose.droplet.yml: sensor-ingestion".

Discovered: 2026-05-11, on the deploy after PR #269 (sensor-ingestion compose profile gate) landed but criticality manifest entry was only demoted rather than removed.

Root cause: PR #269 added profiles: [rust-sidecar] to sensor-ingestion in docker-compose.droplet.yml AND demoted the service-criticality.yaml entry from level: critical to level: optional. Two issues:

  1. level: 'optional' is NOT a valid CriticalityLevel — the validator type union is 'critical' | 'required' | 'warning' | 'ignored'. The yaml-side enum drifted from the code-side type.
  2. Even if level were valid, the coverage check at check-service-health.ts:208-219 calls docker compose config --services WITHOUT any --profile flag, which intentionally hides profile-gated services. The validator then flags sensor-ingestion as referenced-but-missing and exits 2 before any health polling begins. Rollback is triggered.

Fix (Tier-1 Make-Impossible): REMOVE the sensor-ingestion entry from service-criticality.yaml entirely while the service stays profile-gated. The manifest's coverage invariant is "every entry maps to a real default-compose service" — a profile-gated entry violates that invariant by construction. When the operator opts in (COMPOSE_PROFILES=rust-sidecar) AND the CI Rust build matrix publishes the multi-arch GHCR image, the manifest entry is restored as level: critical.

The retained doc comment block documents the restore path so the entry is not added back accidentally with the wrong level (the previous comment said level: optional which would still fail).

Status: RESOLVED on chore/sensor-ingestion-manifest-cleanup.

## ORPHAN-CRITICAL-075 — postgres docker-entrypoint init-scripts cannot re-evaluate after PGDATA non-empty; restart + DROP SCHEMA wipes platform DDL contract

Severity: CRITICAL. Every postgres container restart with a non-empty PGDATA volume leaves the platform's schemas / roles / functions / shared.* tables in whatever state they were last manipulated, with no automatic recovery path. After any `DROP SCHEMA … CASCADE` operation (day-one reset, schema-recovery hand-run, blue-green migration testing) the postgres container's docker-entrypoint silently SKIPS `/docker-entrypoint-initdb.d/*.{sh,sql}` because PGDATA is detected as pre-initialized — the upstream Postgres image's documented contract is "init-scripts run ONCE on initdb, never again."

Discovered: 2026-05-18, during Faz 6 cutover #1. Operator dropped every per-service schema via psql, restarted postgres, manual init-script re-run partially completed, service boot found `auth` schema present but `farm` schema absent. Vault `pg_dump` rollback path also corrupt (stderr stream contaminated the dump file).

Failure surface includes:

  1. **2026-05-18 Faz 6 cutover #1**: postgres restart wiped the DROP-then-recreate state; init-scripts didn't fire; manual psql re-run was racey + partial; 13 schemas baseline-pending after deploy.
  2. **2026-04-19 timescaledb-ha image swap (INFRA-CRITICAL-018)**: image-family PGDATA default divergence triggered the same class — new image's docker-entrypoint detected existing volume as pre-initialized, skipped init-scripts, SHARED_SCHEMA_TABLES freshly-added to `10-shared-schema.sql` never landed.
  3. **2026-04-14 SHARED_SCHEMA_TABLES partial install**: init-scripts ran successfully against empty PGDATA but didn't include `access_logs` in the canonical list at the time. Adding the table later in `10-shared-schema.sql` meant existing environments never picked it up — there was no re-evaluation path.

Root cause: the platform's DDL contract (extensions / roles / schemas / grants / functions / shared.* tables) was placed in `/docker-entrypoint-initdb.d/`, a single-shot mechanism owned by the postgres upstream contract. Mixing one-shot infrastructure (initdb) with restart-survive concerns (the platform DDL) was an architectural type error — the lifetimes were never compatible.

Fix (Tier-1 Make-Impossible): platform DDL is now owned by the **Platform Bootstrap Atom** — Phase 0 of `aqua-db-migrate` (ADR-031). Every aqua-db-migrate container start runs the atom idempotently:

  - 6 extensions (CREATE EXTENSION IF NOT EXISTS)
  - 15 service roles (env-aware password sync, idempotent CREATE/ALTER ROLE)
  - 16 schemas (CREATE SCHEMA IF NOT EXISTS + AUTHORIZATION)
  - schema-level GRANT + ALTER DEFAULT PRIVILEGES (idempotent re-issue)
  - 4 platform functions (CREATE OR REPLACE FUNCTION public.*)
  - 5 SHARED_SCHEMA_TABLES + RLS + immutability triggers
  - `platform.bootstrap_signal` boot-time precondition emitted

`tests/invariants/init-scripts-no-schema-ddl.spec.ts` blocks any future regression — `CREATE SCHEMA / CREATE ROLE / CREATE TABLE / CREATE FUNCTION / CREATE POLICY / GRANT ... ON SCHEMA / ALTER SCHEMA / ALTER DEFAULT PRIVILEGES / ALTER TABLE` anywhere under `infrastructure/docker/init-scripts/*.{sh,sql}` fails CI. `SchemaVersionGate.probePlatformBootstrap()` refuses service boot if the signal row is missing or counts indicate partial-apply state.

Status: RESOLVED on platform-bootstrap-atom branch (this commit).

## ORPHAN-CRITICAL-076 — Phase 0 platform-bootstrap atom silently generates random passwords for missing service-role env vars; downstream services crash-loop with opaque "auth failed"

Severity: CRITICAL. The Phase 0 atom (ADR-031) ships its first prod deploy at run #1113 (SHA `984eb61`) and the aqua-db-migrate container exits non-zero before service containers can start. The droplet log surfaced `aqua-db-migrate failed during full deploy — aborting BEFORE service containers start.` (`scripts/deploy/droplet-up.sh:80–85`). Two architectural gaps surface together:

  1. **Silent random-password fallback.** `apps/db-migrate/src/platform-bootstrap.service.ts:191–207` (pre-fix) caught a missing/empty service-role password env var, generated a random 256-bit password, logged a warning, and continued. Phase 0 reported success but the random secret was NEVER shared with the service container that connects as that role — Phase 1+ services entered `password authentication failed` crash-loop, the criticality-gate dropped them, and the deploy rolled back. The smoking-gun symptom (db-migrate non-zero exit at the next attempt) hides the real cause (missing env var on the host).
  2. **No early-exit diagnostic at Stage 004 GRANT.** `apps/db-migrate/src/sql/platform-bootstrap/004-schema-grants.sql` carries 45+ bare `GRANT … TO <role>` statements. If Stage 002 silently failed to create one of the 15 roles, Stage 004 surfaced an opaque single-line `role "<x>" does not exist` mid-file with no pointer at the upstream stage.

Discovered: 2026-05-18, after deploy run #1113 (manual `workflow_dispatch` against main HEAD `984eb61`). PR #290's commit body explicitly noted "NOT done in this commit: aqua-db-migrate image rebuild + production deploy (separate ops step)" — this finding is the prod-readiness work that gap implicitly tracks.

Root cause: the atom's password-resolution contract was lax-on-write (random fallback) rather than strict-on-write (fail-fast). A single-shot deploy infrastructure component whose preconditions are silently relaxed produces opaque downstream failures far from the cause. The Stage 004 surface compounded the diagnostic loss.

Fix (Tier-1 Make-Impossible + Tier-3 Make-Detectable):

  1. **`buildRolesSql` collects every missing/empty env and throws** with a structured diagnostic that names every offending env var, points at the host file (`/var/aqua-saas/.env`) and the provisioning script (`scripts/deploy/droplet-up.sh:421–424` for full deploy, `:564–570` for selective). Phase 0 now refuses to ship random passwords that no service can ever know.
  2. **Stage 004 carries a role-existence pre-check** — a `DO $platform_bootstrap_stage_004_precheck$` block scans `pg_catalog.pg_roles` for every expected service role BEFORE issuing the first GRANT, and `RAISE EXCEPTION` with a structured message identifying the missing role + the upstream stage to inspect. Wrapping each GRANT in `EXECUTE … EXCEPTION WHEN undefined_object` was rejected as 200+ statement EXECUTE bodies break the SQL-level audit shape ADR-011 reviewers expect.
  3. **Integration spec gains two new contexts:** `platform-bootstrap.integration.spec.ts` now exercises (a) Phase 0 against a database pre-populated with the archived `10-shared-schema.sql` artifacts (the actual prod state at deploy run #1113) and (b) the fail-fast path for missing/empty env vars. The two pre-existing tests had only covered clean apply, idempotent re-run, and `DROP SCHEMA` round-trip.

Status: RESOLVED on `claude/fix-digitalocean-deploy-kL46A` branch (this commit).

## ORPHAN-CRITICAL-077 — `deploy-digitalocean.yml` is a workflow_call subworkflow with no upstream caller; every prod deploy is manual `workflow_dispatch`, breaking the staging-gate audit chain

Severity: CRITICAL. `.github/workflows/deploy-digitalocean.yml`'s `on:` block declares only `workflow_call` + `workflow_dispatch`. The file's header comment (l.27–34) documents the intended trigger model: "invoked from `.github/workflows/ci-affected.yml` as the final job after lint/type-check/test/build all pass on push to main." That invocation never landed in `ci-affected.yml`. The 800-line workflow file has no `deploy:` job, no `uses: ./.github/workflows/deploy-digitalocean.yml` step, and no path that drives the deploy chain on a push event.

Discovered: 2026-05-18, during root-cause investigation of deploy run #1113. The GitHub Actions UI surfaced that EVERY one of the last 10 deploy runs (`#1104` through `#1113`) is tagged "Manually run by Okan-wqm" — the workflow is exclusively operator-triggered. Staging-gate enforcement, the staged-rollout audit trail, and the "main is always deployable" architectural property documented in ADR-016 are all defeated by this gap.

Three concrete consequences:

  1. **Staging-gate by-pass is the default**, not the exception. Operators dispatch prod deploy without waiting for the `deployed/staging-<sha>` tag because there is no automated path that would enforce the gate. The `staging-gate` job's `bypass_staging_gate` input is the safety valve for the rare emergency — without an automated trigger, the safety valve becomes the only path.
  2. **The 2026-04-14 cascade failure mode is reachable again** even though the workflow's staging-gate job would catch it: a manual operator dispatch on a SHA where staging is broken would route the gate's "skip on Topology B" path (operator forgot to set STAGING_ENABLED) or trip the bypass path (operator paste-types `true` to clear a stuck gate).
  3. **The deploy-workflow's own change validation is broken.** A workflow author who pushes a fix to `scripts/deploy/droplet-up.sh` or to `deploy-digitalocean.yml` itself cannot exercise the fix through the merge-driven chain — the chain physically does not exist. PR-level CI green is the only signal until an operator manually dispatches the deploy, by which point the broken commit is already on main.

Root cause: the workflow_call invocation was authored as a comment of intent at file creation (commit `4d87539`) but the matching `ci-affected.yml` `deploy:` job that would call it never landed in any subsequent commit. The header comment claim and the actual trigger graph drifted from day one. Subsequent fixes (workflow_run → workflow_call refactor, staging-gate topology, criticality manifest gate) all assumed the chain existed and patched their own corners of it; nobody re-checked the caller side.

Fix (Tier-1 Make-Impossible): `ci-affected.yml` gets a `deploy:` job that invokes `deploy-digitalocean.yml` via `uses: ./.github/workflows/deploy-digitalocean.yml` + `secrets: inherit`, gated on `github.event_name == 'push' && github.ref == 'refs/heads/main'` and on the upstream `detect-changes` + `install` jobs. `lint/type-check/test/build` are PR-side gates (ARCH-CI-009) so they are NOT in the `needs:` list — that is the documented merge-gate architecture, where PR review is the quality gate before main accepts a commit. Operator `workflow_dispatch` paths are unchanged; only the automation gap closes.

Status: RESOLVED on `claude/fix-digitalocean-deploy-kL46A` branch (this commit).

## ORPHAN-HIGH-078 — `.github/workflows/deploy-digitalocean.yml` has no retry policy on `docker/login-action`; single GHCR network flake aborts the entire deploy matrix

Severity: HIGH. A transient timeout between the GitHub Actions runner and `ghcr.io` during the `docker/login-action` step causes whichever matrix shard hit the flake to fail outright, and because `build-{backend,frontend}-images` runs as a matrix, even a single shard failure blocks the downstream `deploy` job. Two production deploys in the 2026-05-18 → 2026-05-19 window aborted at exactly this point — both with the same root error:

```
Error response from daemon: Get "https://ghcr.io/v2/": ... net/http: request canceled
(Client.Timeout exceeded while awaiting headers)
```

Both attempts had successfully built and pushed every OTHER matrix shard (14 backend + 7 of 8 frontend images); only one frontend image build (`tenant-admin` on 2026-05-18, deploy run 26081565625) hit the GHCR rate limiter or transient TCP-reset and dragged the whole deploy down. Operator workaround was identical both times: re-trigger `deploy-digitalocean.yml --ref main` from a fresh dispatch.

Root cause: `docker/login-action@74a5d142397b4f367a81961eba4e8cd7edddf772` is invoked with no `retries` parameter and no surrounding retry wrapper. The action's default behavior on TCP/HTTP timeout is a single attempt → exit non-zero → step fails. GHA `jobs.<name>.continue-on-error: true` is also absent so the failing matrix shard cancels its peers (`fail-fast` defaults to true). Two control surfaces (`fail-fast: false` + retry-on-transient-class) are both missing.

Fix (Tier 1 Make-Automatic):

  1. Set `strategy.fail-fast: false` on `build-backend-images` + `build-frontend-images` so a single shard's transient failure does NOT abort the entire matrix. (The matrix already has `max-parallel: 6`; fail-fast is the orthogonal toggle.) Already present on `build-backend-images` per the source — verify presence on the frontend matrix.
  2. Wrap the `docker/login-action` invocation in a retry loop or step-level retry. Easiest implementation: use `nick-fields/retry@*` SHA-pinned (already used elsewhere in the workflow per the SHA-pinning audit) with `max_attempts: 3` and `retry_on: error` against the login step. GHA does not have a native step-retry primitive yet (only job-retry via `continue-on-error`), so a wrapper action is the load-bearing path.
  3. Optional Tier-2 add-on: alert on consecutive GHCR-login failures so operators see the class is escalating before it blocks a real deploy.

Status: RESOLVED — `.github/workflows/deploy-digitalocean.yml` now wraps `docker login` in a 3-attempt shell retry loop with 5s/10s/15s backoff. The third-party `docker/login-action` dependency was removed in the same change; the supply-chain surface narrowed by one action. Tier 1 property: single-flake transient is absorbed inside the build step; sustained outage still fails loud with the rc of the third attempt.

Numbering note: this entry was authored as ORPHAN-HIGH-076 on the `fix/ghcr-login-retry` branch before PR #293 introduced ORPHAN-CRITICAL-076 + ORPHAN-CRITICAL-077 on the same numbering line. Renumbered to 078 at rebase time to preserve the monotonic registry contract.

## ORPHAN-HIGH-079 — `cache-to: type=registry` aborts entire build matrix on transient GHCR cache-write 5xx

Severity: HIGH. Deploy run 26084727277 (2026-05-19 main HEAD `f20465b9`) failed at `build-backend-images (billing-service)` with:

```
#20 ERROR: error writing manifest blob: failed to open writer: unexpected status from
HEAD request to https://ghcr.io/v2/okan-wqm/aquaculture_platform/billing-service/manifests/buildcache-main-v2: 502 Bad Gateway
ERROR: failed to build: failed to solve: error writing manifest blob: ...
buildx failed with: ERROR: ...
```

The image had already built + pushed successfully (`docker/build-push-action`'s `--push true` step completed). The error was raised AFTER push, during the `cache-to: type=registry,ref=…:buildcache-main-v2,mode=max` post-build cache-write step. A single GHCR 5xx on a manifest HEAD/PUT during cache write aborted the entire matrix shard and dragged the deploy down.

ORPHAN-HIGH-078's GHCR-login retry wrapper does NOT cover this surface — the login step succeeded; the failure is inside `docker/build-push-action`'s buildkit cache-write phase, which is internal to the action and not externally wrappable with a shell retry.

Root cause: `cache-to: type=registry,...,mode=max` treats cache-write as a build correctness gate. It is not — the buildcache layer is an optimization that accelerates subsequent builds with shared layers. A failed cache-write means the next build runs with one less cached layer (slower); it does NOT mean the current build is invalid (the image is already pushed). Coupling the two surfaces conflates an optimization-class failure with a correctness-class failure.

Fix (Tier 1 Make-Automatic): append `,ignore-error=true` to every `cache-to: type=registry,...` invocation. The flag is supported by `docker/build-push-action` v6 (current SHA `471d1dc4e07e5cdedd4c2171150001c434f0b7a4`) and downgrades cache-write transients from build-fatal to warning. Image push succeeds, matrix shard succeeds, deploy proceeds.

Two call sites in `.github/workflows/deploy-digitalocean.yml`: `build-backend-images` (line 835) + `build-frontend-images` (line ~933). Both updated in the same commit.

Status: RESOLVED on `fix/ghcr-cache-write-ignore-error` branch.

## ORPHAN-HIGH-080 — Service command surfaces had no durable idempotent receipt path across auth, billing, event-store, and notification

Severity: HIGH. Tenant/admin command contracts existed, but the receiving service runtimes did not all share a durable command receipt ledger, v2 service-identity enforcement, and replay-safe notification delivery semantics. A duplicate or retried command could run twice, trust a bare tenant header, or acknowledge an in-flight notification as delivered while the only receipt status was `STARTED`.

Root cause: service commands were added as protocol concepts before the receiving services had the same idempotency and identity spine as gateway calls. Event-store also had a query-hash canonicalization mismatch (`?` stripped from `observedQuery`), and notification command receipts treated every existing `STARTED` row as a successful replay.

Fix: add auth, billing, and notification command receipt ledgers and handlers; require v2 event-store service identity with tenant context from verified signatures; harden event-store ledger/projection surfaces; and make notification command receipts distinguish `SUCCEEDED` replay, `FAILED` retry, fresh `STARTED` in-progress, and stale `STARTED` lease reclaim. Targeted unit specs cover event-store query hash / tenant context / projection FSM and notification receipt lease behavior.

Status: RESOLVED on `feat/service-command-surfaces-20260606`.

## ORPHAN-HIGH-081 — Tenant/admin provisioning still mixed admin-owned runtime writes with owner-service command ownership

Severity: HIGH. Tenant creation, password reset, module catalog mutations, billing admin operations, schema provisioning, and lifecycle rollback paths were not aligned on one admin orchestration contract. Admin-api could still carry raw token material, write or assume ownership of auth/billing state, or proceed before db-migrate/onboarding/billing receipt evidence completed. Rollback and destructive cleanup boundaries were especially risky because create paths and delete paths did not distinguish normal provisioning from cleanup proof.

Root cause: tenant provisioning had been split across admin-api handlers, direct database helpers, UI polling surfaces, NATS subjects, and migration helpers without a single invariant tying the ownership model together. The newer service command receipts existed downstream, but admin orchestration had not been updated to treat auth, billing, db-migrate, notification, and farm onboarding as owner-confirmed steps.

Fix: route tenant creation through operation-based admin provisioning with idempotency, db-migrate wait evidence, owner-service command receipts, onboarding acknowledgement ordering, and tokenless admin surfaces. Admin-api password reset and module catalog mutations become facades over auth-service commands, billing operations require billing receipt evidence, schema cleanup stays behind cleanup proof, and the admin panel polls/retries provisioning operations instead of assuming immediate creation.

Status: RESOLVED on `feat/tenant-admin-orchestration-20260606`.

## ORPHAN-HIGH-082 — Config runtime responses exposed raw storage semantics instead of effective tenant-safe configuration

Severity: HIGH. Config-service public GraphQL responses could expose raw `Configuration` storage rows and did not make tombstone, fallback, cache, and secret-redaction behavior explicit. Tenant runtime callers needed the effective configuration for their tenant, but the API shape could leak whether a value came from system fallback storage, return secret values, or treat deleted tenant overrides as ordinary missing rows.

Root cause: the resolver contract and DTO boundary were coupled to persistence entities. The service had command/query handlers for raw configuration rows, but no public effective DTO that encoded source, requested tenant, tombstone state, and redacted values as runtime behavior.

Fix: add an effective runtime configuration DTO and public resolver contract tests, introduce config tombstone lifecycle columns/migration, and update handlers/query paths to respect tombstones while keeping fallback and redaction explicit. The app module now registers the effective resolver path without exposing raw configuration entities as public runtime output.

Status: RESOLVED on `feat/config-service-runtime-behavior-20260606`.

## ORPHAN-HIGH-083 — Farm setup writes, documents, and batch policies were not bound to tenant transaction, audit, and outbox invariants

Severity: HIGH. Farm setup and batch write paths still had gaps where REST controllers or handlers could bypass CQRS/tenant transaction boundaries, emit events outside the canonical outbox, or rely on runtime schema repair for existing tenants. Document metadata also lacked a canonical tenant table and cleanup provider, and Sentinel proxy access policy was not guarded by focused tests.

Root cause: farm enterprise hardening had been implemented in pieces: batch lifecycle rules, site/system/equipment/tank setup writes, outbox/inbox migrations, document records, metrics, and realtime propagation were not tied together by one invariant-backed contract. That left setup migration status dependent on narrative docs and manual review rather than executable gates.

Fix: add farm outbox/inbox/document/tank setup migrations, CQRS-backed batch write adapters, setup handler transaction/audit/outbox utilities, farm document cleanup registration, Sentinel proxy policy tests, farm event registry/realtime bridge parity, and farm invariants for identity, REST/CQRS, batch policy, and setup eventing. Existing-tenant schema repair remains fail-closed outside explicit e2e bootstrap.

Status: RESOLVED on `feat/farm-service-enterprise-train-20260606`.

## ORPHAN-HIGH-084 — Sensor DDL/RBAC/trust train lacked flat Agent I/O v2 and tenant-bound edge proof

Severity: HIGH. Sensor DDL, edge-device I/O config, PLC control, and Rust gateway trust changes were present as separate hardening pieces, but the executable contract still allowed unsafe gaps: edge I/O mutations had role checks without the tenant permission gate, Agent I/O config could be serialized in a flat v2 shape that the Rust gateway did not parse, orphaned or ambiguous I/O tags could be skipped rather than rejected, and ping responses could complete against the wrong device identifier.

Root cause: the train had runtime and schema changes without one cross-boundary proof tying service-side validation, GraphQL authorization metadata, MQTT payload shape, gateway parsing, and provisioning/trust behavior together. The flat `tags[]` schema was documented by fixtures and tests, but the Rust command parser still only accepted grouped legacy arrays.

Fix: add tenant permission metadata to all edge I/O mutation surfaces, make Agent I/O v2 serialization fail closed for orphaned or ambiguous tags, bind pending pings to both device UUID and device code, add focused sensor-service permission/config/PLC tests, and teach the Rust gateway `update_io_config` parser to accept flat v2 `tags[]` while preserving legacy grouped payload support.

Status: RESOLVED on `feat/sensor-train-ddl-rbac-trust-20260606`.

## ORPHAN-HIGH-085 — Water chemistry leaf train lacked one end-to-end pH-domain and report proof

Severity: HIGH. The Deffeyes DIC/pH engine, farm UI, MCP/AI tool surfaces, report export, and Playwright smoke were split across layers without one leaf-train proof that the visible chart domain, H₂S measurement pH semantics, report export overlays, and MCP schema stayed aligned.

Root cause: chart and solver pH domains were duplicated, `currentPH` and H₂S measured-at-pH semantics were not stabilized as an explicit compatibility boundary, farm-module tests depended on a prebuilt shared-ui package, and the standalone farm module could not run the water smoke because its entrypoint lacked the React Query provider supplied by the shell.

Fix: add shared Deffeyes pH-domain constants, introduce `h2sMeasuredAtPH` while preserving `currentPH` as a deprecated alias, extend engine/UI/report/MCP coverage, add a test-only shared-ui source alias, wrap farm-module standalone startup in a `QueryClientProvider`, and add the Playwright water chemistry release smoke for chart mode, report print, and CSP safety.

Status: RESOLVED on `feat/water-chemistry-leaf-train-20260606`.

## ORPHAN-HIGH-086 — ARIA control-plane proof lacked workflow preflight, evidence trust, and isolated burn-in

Severity: HIGH. ARIA docs, workflows, and runtime helpers described enterprise autonomy proof surfaces, but the control plane did not consistently bind workflow write authority, token provenance, artifact trust, merge authority, and observe-mode burn-in evidence to executable gates. A workflow could claim authority without a real YAML contract, docs could drift from runtime SSoT, and operational proof could run outside an isolated, hash-bound evidence bundle.

Root cause: ARIA hardening had evolved across kernel code, GitHub workflows, runbooks, and docs without one proof slice that made ARIA explicitly non-authoritative for production while still proving its own control-plane preconditions. Existing tests covered pieces of the kernel but not the workflow contract, evidence bundle integrity, genesis lifecycle boundaries, merge authority, and clean burn-in acceptance as one chain.

Fix: add workflow contract/preflight verification, evidence trust and ledger-reference checks, merge authority invariants, enterprise readiness/genesis lifecycle guards, observe burn-in artifact schema and verifier, ARIA operational proof workflow, docs/runtime SSoT cleanup, and hardened automation-report PR helpers. The SSoT invariant now verifies the documented authority target as a reachable ancestor instead of requiring an impossible self-referential commit hash.

Status: RESOLVED on `feat/aria-control-plane-proof-20260606`.

## ORPHAN-063 — main carries a RED test: tenant-update-consolidation.spec asserts the superseded delegation contract

**Severity:** HIGH (broken test on main — the CI gate is dark for this suite)
**Discovered:** 2026-06-10, during Wave-2 auth audit remediation (branched off origin/main).

**Evidence:** `apps/auth-service/src/modules/tenant/__tests__/tenant-update-consolidation.spec.ts` on origin/main expects `resolver.updateTenant` to delegate to `TenantService.update(id, input, role)`, but the resolver (`apps/auth-service/src/modules/tenant/resolvers/tenant.resolver.ts`) was converted by the enterprise-train lineage to REJECT outright (`BadRequestException('… command-receipt owned …')`). The spec and the implementation disagree → 3 failing tests (`should call TenantService.update with role parameter`, `should enforce tenant isolation`, `should allow SUPER_ADMIN`). Verified PRE-EXISTING on clean origin/main via `git stash` A/B.

**Root cause:** the command-receipt/FSM ownership migration changed the resolver behaviour but did not update its consolidation spec — a half-landed migration from a parallel work lineage. CI's `nx affected -t test` did not re-run this suite for the resolver-only change (the same affected-graph gap as AUDIT-CRITICAL-004/006).

**Fix:** rewrite the spec to pin the command-receipt refusal contract (resolver rejects for ALL roles; tenant-isolation 403 still fires first). Applied identically in PR #383 (Wave-1 W1.3) and on the Wave-2 branch — identical content, conflict-free merge. The deeper affected-graph gap is tracked under AUDIT-CRITICAL-004's cross-service watch item.

**Status:** RESOLVED on `fix/auth-audit-wave2-security` (and `security/rate-limit-sec-critical-002` / PR #383).

## ORPHAN-HIGH-087 — Source-schema write-guard triggers (`guard_source_write`) are installed by nothing on main

Severity: HIGH. The DB-level tenant-isolation defense layer (BEFORE-trigger `guard_source_write` + `block_source_writes()` rejecting INSERT/UPDATE/DELETE on source-schema template tables) is no longer installed by any active code path. `SourceSchemaWriteGuardService` was correctly neutered into a no-DDL runtime stub (commit 42695736f, "aqua-db-migrate owns source-schema trigger hardening"), but db-migrate never picked up the install side: `SchemaPostMigrationHardening` supports only `tenantRls` and `auditColumns` — there is no `sourceWriteGuards` step, and a repo-wide grep for `guard_source_write` / `block_source_writes` hits zero active files. Environments provisioned before the neutering retain stale triggers; fresh environments get none.

Root cause: the ownership transfer ("runtime services must not install trigger DDL → db-migrate owns it") shipped only its prohibition half. The PR#363 branch (8706e7a68) contained the missing half as `source-schema-write-guards.helper.ts` (idempotent installer driven by `MODULE_SCHEMAS` tables minus referenceDataTables/infrastructureTables), but that branch was never merged and the 2026-06-11 C-2 port deliberately did not carry it: wiring an install step into `postMigrationHardening` would fire write-blocking triggers on the next production deploy for every hardened schema, and the `MODULE_SCHEMAS` reference/infrastructure classification has not been re-audited against today's runtime write paths (a misclassified outbox/reference table would brick legitimate writes platform-wide).

Fix: (1) re-audit `MODULE_SCHEMAS` per schema against actual runtime write paths (outbox, inbox, reference seeds, ledger tables); (2) port `installSourceSchemaWriteGuards` from 8706e7a68 into `libs/backend-common` and add a `sourceWriteGuards` step to `SchemaPostMigrationHardening` + the db-migrate hardening executor (gated per-schema, staged rollout starting with farm); (3) extend `tests/invariants/authoritative-runtime-ddl-contract.spec.ts` to require the step for schema-per-tenant entries once enabled.

Status: OPEN. Owner: data-expert. Deadline: 2026-07-15 (registry follow-up of DATA-HIGH-004; raised by docs/reviews/data-expert/2026-06-11-runtime-ddl-authority-port.md).

## ORPHAN-HIGH-088 — Tenant-şema runtime yetkilerinin SSOT sahibi yok; production seremoni grant'leriyle ayakta

Severity: HIGH. Stage-008 yalnız adlandırılmış servis şemalarını (15 spec + shared + platform) yönetir; `tenant_<uuid>` şemaları kapsam dışı. Tenant-schema-provisioner şemayı yaratır, tabloları fan-out eder, RLS/audit hardening uygular ve ledger READ erişimi verir — ama runtime rollerine (örn. `messaging_service`) tenant şeması üzerinde USAGE/DML/partition-CREATE GRANT'ini HİÇBİR bileşen vermez (`applyProvisionerHardening` yalnız RLS + audit kolonları; `sql-fragments.ts` grant primitifi taşımıyor).

2026-06-11 production açılışında `tenant_7f6b...` erişimi elle verilen grant'lerle kurtarıldı; bu grant'ler hiçbir SSOT'ta yaşamıyor. Sonuç: (1) yeni provision edilen her tenant şeması runtime erişimsiz doğar — ilk tenant-scoped sorgu runtime'da patlar; (2) seremoni grant'leri bir restore/rebuild'de sessizce kaybolur.

Kök neden: ADR-011 sahiplik modeli servis şemaları için 008'de yürütülürken, tenant şemaları için yetki katmanı provisioner'a hiç bağlanmamış — provisioning akışında `APPLYING_GRANTS` durumu var ama yalnız migration-ledger READ'i kapsıyor.

Düzeltme yönü: provisioner `APPLYING_GRANTS` aşamasına tenant-şema runtime grant SSOT'u eklenir (servis kataloğundan türetilen rol→şema eşlemesiyle USAGE+DML; messaging partition'ları için DATA-HIGH-006 definer-fonksiyon deseni tenant şemalarını da kapsar); mevcut tenant şemaları için idempotent backfill ceremony'si aynı PR'da. Compliance-bootstrap-SSOT yapısal PR'ıyla birlikte ele alınmalı.

Status: OPEN (2026-06-11; sahip: data-expert; kuyruktaki provisioner/compliance yapısal PR kapsamına bağlandı).

Güncelleme (2026-06-11, DATA-HIGH-006 PR'ı): **messaging-partition dilimi SSOT'a bağlandı** — provisioner APPLYING_GRANTS artık `grantTenantMessagingPartitionAuthority` ile her yeni tenant şemasında messaging-domain ilişkilerini `messaging_schema_owner`'a re-own edip şema USAGE+CREATE veriyor; Stage-010 mevcut şemaları idempotent backfill'liyor. Kalan kapsam (diğer servislerin runtime-DML grant SSOT'u) bu bulguda AÇIK durmaya devam ediyor.

## ORPHAN-MEDIUM-089 — messaging-service /metrics serves only the domain registry; http_*/nodejs_* families absent

Severity: MEDIUM. `apps/messaging-service/src/metrics/metrics.controller.ts` serves `MessagingMetricsService`'s private registry only. The platform HTTP families (`http_request_duration_seconds`, `http_requests_total`, `http_requests_in_flight`) and Node.js runtime metrics are never collected or exposed for messaging-service — request-latency SLO dashboards have a blind spot on a criticality-critical service.

Root cause: messaging built its scrape endpoint before the canonical `ServiceMetricsModule` became drop-in (OBS-HIGH-001); two controllers cannot share the GET /metrics route, so it could not simply add the canonical module on top.

Fix direction: replace the bespoke controller with the canonical `ServiceMetricsModule` import and surface the messaging domain registry through `ServiceMetricsService.registerContributor('messaging-domain', registry)` — exactly the farm-service pattern landed in OBS-HIGH-001 (`apps/farm-service/src/common/metrics/farm-metrics.module.ts` is the reference). Scrape path and metric names are unchanged, output becomes a superset; the metrics-endpoint-adoption invariant accepts both shapes throughout the transition.

Status: RESOLVED (2026-06-26 — messaging MetricsModule now imports ServiceMetricsModule (owns /metrics + default http_/nodejs_ collectors) and contributes its domain registry via contributeTo in onModuleInit (mirrors farm OBS-HIGH-001); bespoke MetricsController deleted. Locked by metrics-service-module-ratchet.spec.ts. Systemic siblings (auth/gateway/sensor) tracked as ORPHAN-185) (2026-06-11; owner: messaging-expert; surfaced during OBS-HIGH-001 Wave B1 verification).

## ORPHAN-HIGH-090 — Droplet production runs NO metrics collector; every /metrics endpoint is unscraped

Severity: HIGH. `docker-compose.droplet.yml` ships no Prometheus/agent container, and `infrastructure/monitoring/` (kube-prometheus-stack values, annotation-based discovery) targets a Kubernetes deployment that is not the droplet runtime. After OBS-HIGH-001 every backend exposes GET /metrics, but on the droplet nothing collects them — the series exist only at scrape-time and are lost.

Root cause: the monitoring stack was designed for the K8s topology; the droplet path (ADR-033) never received a collector, and until OBS-HIGH-001 there was no catalog SSoT (`metricsExposure`/`metricsPort`) from which scrape targets could even be generated.

Fix direction: add a Prometheus (or agent-mode) container to the droplet compose with a scrape config GENERATED from the service catalog (`generate-artifacts.ts` gains a scrape-targets artifact derived from `metricsExposure === 'prom-endpoint'` entries + `metricsPort`), including the `x-internal-api-key` header for observability-service's gated endpoint; wire retention/resource limits to droplet capacity constraints. The catalog fields landed in OBS-HIGH-001 are the designed input for exactly this generator.

Status: IN-PROGRESS (2026-06-27 — in-repo scraper landed: added prometheus + cadvisor + node-exporter + alertmanager services to docker-compose.droplet.yml (additive, internal-network-only), consuming the existing infrastructure/monitoring/droplet configs (prometheus.yml + catalog-generated file_sd + rules + alertmanager.yml). 57/57 deploy/monitoring invariants green. NOT yet deployed — infra-owner decisions flagged in-line: Prometheus retention/disk, alertmanager SMTP/webhook receivers, and the observability-service INTERNAL_API_KEY scrape header (its job intentionally left disabled). The droplet still runs no collector until this is deployed + those decisions made) (2026-06-11; owner: observability-expert; natural Wave B2 follow-on of the s1-remediation program).

---

## ORPHAN-MEDIUM-093 — Platform libs lack a selected eslint-project tsconfig; lib files importing exports-only packages can't be type-resolved by @typescript-eslint

Severity: MEDIUM. `.eslintrc.json` `parserOptions.project` lists `tsconfig.base.json` FIRST, then the per-project globs (`apps/*/tsconfig.json`, `platform/libs/*/tsconfig.json`, …). @typescript-eslint resolves each file to the FIRST listed project that includes it; `tsconfig.base.json` has no `include`, so it matches every `.ts` file and always wins. App files resolve modern packages anyway, but a platform LIB file type-checked standalone against bare `tsconfig.base.json` (moduleResolution:node) cannot resolve `@nats-io/*` (exports-only ESM, with a broken `types: ./lib/mod.d.js` field) — its imports widen to `any`/`error` and trip `@typescript-eslint/no-unsafe-*`. Surfaced by A3 (the first platform lib to import @nats-io): `platform/libs/event-bus/src/nats/nats-event-bus.ts` `connect()` is a verified false positive — the platform `type-check`, the `build`, and the event-bus unit tests all PASS (they run in the consumer context where @nats-io resolves). Suppressed via a scoped `.eslintrc.json` override (`no-unsafe-assignment` OFF for that one file) — the in-line `eslint-disable` form is banned by the repo's banned-construct gate, which directs false-positive suppressions to the .eslintrc lint-policy SSoT.

Root cause: eslint project-selection order. Fix (highest tier first): (1) reorder `parserOptions.project` so the per-project globs precede `tsconfig.base.json` (or drop base if every linted file is covered by a project), so lib files type-check against a proper project where node_modules resolves; (2) failing that, give each platform lib a selected `tsconfig.json` (references its lib + spec). A3 created `platform/libs/event-bus/tsconfig.json` + `tsconfig.lib.json` but they were NOT selected (base wins) and were reverted pending the reorder. Cross-cutting eslint-config change — must be validated against the full lint surface, not one lib.

Discovered while driving A3 (NATS v3, PR #424) to green. The `eslint-disable` is removable once the project-order fix lands.

Status: OPEN (2026-06-13; owner: infra-expert). Registered: docs/reviews/_registry/findings.jsonl#ORPHAN-MEDIUM-093.

---

## ORPHAN-HIGH-092 — E2E - Messaging Service chronic cancellation flake (~50%)

Severity: HIGH. The `E2E - Messaging Service` workflow (`E2E Tests` job) cancels on roughly half its runs — sampled last 18 = 9 cancelled / 8 success / 1 failure. Cancellations are the job hitting its own wall-clock after repeated `Exceeded timeout of 60000 ms for a hook` (Jest setup hooks), ending in `##[error]The operation was canceled` — reproduced identically on two consecutive runs of the SAME commit (B2 head 4699f72dc), so it is environmental, not a code regression. The suite is NOT in `branches/main/protection/required_status_checks`; K7 (#410, 807dc90a5) deployed to production with it never green. It therefore masks real messaging-E2E signal behind noise while blocking no merge.

Root cause direction: container/service readiness race — the Jest global setup waits on TimescaleDB + Redis + NATS boot and exceeds 60s under CI load. Fix (highest tier first): (1) automatic readiness gate (healthcheck poll) before Jest starts; (2) detectable — budgeted hook timeout + loud container-state dump on timeout instead of silent cancel; (3) split container-boot out of the per-test hook budget.

Discovered while gating B2 (#411). Pairs with ORPHAN-MEDIUM-055 (same E2E Postgres log surface).

Status: RESOLVED (2026-06-13; #441 b4f484130). The heavy one-time bootstrap moved to Jest `globalSetup` (outside the 60s per-hook budget) behind a Postgres readiness poll with a loud explicit failure; the per-spec beforeAll is now a fast idempotent no-op. Root cause (boot cost inside the hook budget) eliminated. NOTE: flake-RATE reduction confirms over several post-merge E2E runs (the suite was ~50%; one green run is necessary but not sufficient) — re-open if cancellations persist. Registered: docs/reviews/_registry/findings.jsonl#ORPHAN-HIGH-092.

---

## ORPHAN-HIGH-116 — ORPHAN-HIGH-092 successor: messaging E2E still hung after the first closure

Severity: HIGH. `ORPHAN-HIGH-092` was marked resolved by the #441 bootstrap/readiness work, but once `ORPHAN-HIGH-102` restored the messaging E2E suite load path, the suite still self-cancelled in the first `createChannel` flow. The actual hang was in `TenantUserAdmissionService`: `firstValueFrom(natsClient.send(VALIDATE_TENANT_MEMBERSHIP).pipe(timeout()))` waited forever because the E2E `mockNatsClient.send` returned a non-emitting observable-shaped mock. The mocked `.pipe()` also swallowed the RxJS timeout, so the setup hook never failed loudly.

Fix evidence: PR #482 / squash `0d95df9a7f76` changed the E2E NATS request-reply mock to return real `of(...)` observables for `send`/`emit`, making admission resolve. The messaging `E2E Tests` workflow then ran 12 suites / 111 tests green with 0 hook timeouts.

Traceability note: `0d95df9a7f76` legitimately closes `ORPHAN-HIGH-092` in its commit message, not this successor id. The `ORPHAN-HIGH-116` registry row must therefore use a post-merge traceability commit that carries `Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-116` as its `closing_commits` evidence, while keeping `0d95df9a7f76` in the narrative as the real code fix. This avoids amending merged history and avoids a false `closing_commits` edge.

Status: RESOLVED (2026-06-15; post-merge traceability correction). Registered: docs/reviews/_registry/findings.jsonl#ORPHAN-HIGH-116.

---

## ORPHAN-MEDIUM-117 — `tools/quality/format-scope.json` is stale on main

Severity: MEDIUM. `node tools/quality/quality.mjs format-scope check` exits 1 on a clean branch cut from main with `tools/quality/format-scope.json is stale; regenerate it`. A dry regenerate rewrites roughly 1,700 insertions and 300 deletions across the manifest because new migrations, test renames, and removed ESLint config files are not reflected in the committed scope file.

Effect: the quality-format-scope gate is red at the branch base. A gate that is red on main either stops every downstream PR for unrelated drift or becomes ignored as background noise, so it no longer protects new changes.

Fix direction: run `node tools/quality/quality.mjs format-scope generate`, commit the regenerated `tools/quality/format-scope.json` in a dedicated infra/quality-tooling change, and keep the drift check in CI so this file stays synchronized with the source tree.

Status: RESOLVED (2026-06-29) — regenerated `tools/quality/format-scope.json` via `node tools/quality/quality.mjs format-scope generate` (+1984/-22; new migrations/specs + removed eslint configs reconciled), so `format-scope check` is green at HEAD. To stop silent re-drift, the drift check is now a PR gate: a `Run format-scope drift gate` step (`npm run quality:format-scope:check`) in `.github/workflows/quality-gates.yml` (`banned-phrase-gate` job, alongside the ESLint-rules dist drift check), plus the previously-dangling `quality:format-scope:{generate,check}` npm scripts the gate's own error message referenced. Unblocks ORPHAN-MEDIUM-121 (the dead-dir removal can now regenerate the manifest cleanly). Registered: docs/reviews/_registry/findings.jsonl#ORPHAN-MEDIUM-117.

---

## ORPHAN-MEDIUM-055 — messaging-service background sweep queries non-existent `m.embedding` column

Severity: MEDIUM. The messaging-service E2E Postgres logs, on a fixed 5-minute cadence (12:50/12:55/13:00…): `ERROR: column m.embedding does not exist at character 138 … WHERE m."embedding" IS NULL`. A scheduled background worker / projection (an embedding-backfill or semantic-index sweep) filters on `m."embedding" IS NULL`, but the column does not exist in the schema the E2E migrations apply. Independent of B2 (zero embedding code touched); appears on every messaging E2E run.

Query↔migration drift: either the `embedding` column migration is missing from the E2E path (the feature is silently dead) or the sweep must be feature-flag-gated until the column lands (it currently fires blindly every 5 minutes). Investigate why SchemaDriftValidator (ADR-012) does not fail-closed on the missing required column here.

Discovered in the E2E Messaging logs during B2 (#411) gating. Pairs with ORPHAN-HIGH-092.

Status: RESOLVED (2026-06-13; #441 b4f484130). Root cause was query↔migration drift: the E2E migration array stopped at 1800600000000 and omitted `1800700000000-AddMessagesEmbeddingColumn` (#423), so the E2E schema lacked `messages.embedding` while the backfill sweep filtered on it. Added the migration to the E2E path (`e2e-setup.ts`) → E2E schema in lockstep with production, column present, no more `m.embedding does not exist`. Registered: docs/reviews/_registry/findings.jsonl#ORPHAN-MEDIUM-055.

---

## ORPHAN-CRITICAL-094 — Bootstrap-generated service-identity keyring fail-closed every login (verifier ↔ generator contract contradiction)

Severity: CRITICAL. On any droplet provisioned by the deploy secret bootstrap, EVERY login (in fact every gateway→subgraph call) was rejected with `caller-not-allowed` (ServiceIdentityGuard), surfaced to the browser as the misleading "Invalid service identity signature…". Regression: commit `4473d2fc7` "fix(deploy): SERVICE_IDENTITY_KEYRING joins the droplet bootstrap secret SSOT" (#388, 2026-06-11) added `generate_service_identity_keyring()` (`scripts/deploy/lib/required-env-secrets.sh:56-61`) which emits a keyring entry carrying only `{kid,secret,status}`.

Root cause: contract contradiction. The generator's comment (lines 43-48) claimed absent `callers`/`audiences` are "treated as unrestricted," but the verifier `resolveVerificationKey` (`libs/backend-common/src/utils/service-identity.util.ts:642-646`) did the OPPOSITE for a kid-matched entry — `if (!entry.callers …) return 'caller-not-allowed'`, fail-closed with no fallback. The sibling event-store `lookupKeyEntry` (`apps/event-store-service/src/guards/event-store-service-identity.guard.ts:238`) used `entry.callers && …` (absent ⇒ allow), so the two verifiers had contradictory absent-semantics; event-store ALSO routes through `resolveVerificationKey` (guard:126) so it was broken too. Why CI stayed green: every keyring test fixture (`service-identity.util.spec.ts`) and the gateway federation tests (`allowUnscopedDevKey`/`secret`-override path) always set callers/audiences — the production keyring shape was never exercised.

Fix (RESOLVED, Tier-1 per architectural-arbiter): `callers`/`audiences` are NON-secret policy with a single SSoT — the service-catalog. New `serviceIdentityCallers()` (`platform/libs/service-catalog/src/index.ts`); `resolveVerificationKey` now derives the caller allowlist from the catalog when an entry carries no explicit policy (`entry.callers ?? serviceIdentityCallers()`), staying fail-closed (unknown caller rejected). The keyring JSON stays pure secret transport, so policy cannot drift from the catalog. Bridge test added (`service-identity.util.spec.ts`) reproducing the policy-less-entry shape.

Status: RESOLVED (2026-06-13; owner: auth-security-expert; branch `fix/service-identity-keyring-catalog-policy`). Registered: docs/reviews/_registry/findings.jsonl#ORPHAN-CRITICAL-094.

---

## ORPHAN-HIGH-095 — messaging-service is the only active Apollo subgraph missing SERVICE_IDENTITY_KEYRING in droplet compose

Severity: HIGH. `docker-compose.droplet.yml` injects `SERVICE_IDENTITY_KEYRING` + `SERVICE_IDENTITY_SIGNING_KID` into 12 backends but NOT into `messaging-service`. messaging is an active federated subgraph (`infrastructure/apollo-router/subgraphs.json`), so the gateway HMAC-signs every gateway→messaging call; messaging's `ServiceIdentityGuard` hard-throws `SERVICE_IDENTITY_KEYRING is not set… required in production` (`service-identity.guard.ts:79-83`) → every messaging GraphQL query 403s in production. A second latent outage independent of the login outage (ORPHAN-CRITICAL-094).

Fix (RESOLVED): added both vars (`:?`-required, matching the auth/farm pattern) to the `messaging-service` env block, closing the 12-of-13 gap.

Status: RESOLVED (2026-06-13; owner: infra-expert; branch `fix/service-identity-keyring-catalog-policy`). Registered: docs/reviews/_registry/findings.jsonl#ORPHAN-HIGH-095.

---

## ORPHAN-HIGH-096 — Shared-secret service-identity keyring gives no real per-caller authorization (needs per-service keys / mTLS)

Severity: HIGH (architectural / tracked hardening — NOT fixed here, deliberately). `docker-compose.droplet.yml` interpolates the SAME `${SERVICE_IDENTITY_KEYRING}` (one shared HMAC secret, one kid) into all 12+ backends. Under a shared secret, the `callers`/`audiences` allowlist is only a known-name sanity gate (defense-in-depth) — any holder of the shared secret can sign as ANY `serviceName`, so it is NOT a per-caller cryptographic boundary. The real per-receiver check is `matchesExpectedAudience` (catalog-derived); there is no enforced per-caller authZ.

Fix direction: per-service keyrings (distinct kid+secret per signer, narrow `callers`/`audiences`) so possession of one service's secret cannot forge another's identity — meaningful only once identity is unforgeable, i.e. paired with mTLS-bound service identity (cert CN = identity, mirroring ADR-015 for NATS). Large blast radius (TLS termination, cert minting, every signer/verifier) → requires a `proposed` ADR + security review; do NOT mask the gap with a wildcard allowlist.

Status: IN-PROGRESS (2026-06-27 — decision framed in docs/adr/039-http-service-identity-mtls.md (Proposed) — phased: Phase 1 = per-service keyring entries (W3 T2.3, removes cross-service forgery, no infra change), Phase 2 = per-service mTLS (cert-CN-is-identity mirroring ADR-015, Node-native on the single-host droplet, dual-mode cutover, retire HMAC). Phase 2 needs infra (HTTP cert minting from the internal CA) + security review) (2026-06-13; owner: auth-security-expert; escalated from the ORPHAN-CRITICAL-094 fix review). Registered: docs/reviews/_registry/findings.jsonl#ORPHAN-HIGH-096.

---

## ORPHAN-MEDIUM-097 — Divergent absent-policy semantics between resolveVerificationKey and event-store lookupKeyEntry

Severity: MEDIUM. The same `entry.callers`/`entry.audiences` keyring field was read with OPPOSITE absent-semantics by two verifiers: `resolveVerificationKey` (`service-identity.util.ts`) treated absent ⇒ DENY, while `lookupKeyEntry` (`event-store-service-identity.guard.ts:238-243`) treated absent ⇒ ALLOW. Divergent contracts on one shared data shape are how the #388 regression (ORPHAN-CRITICAL-094) slipped through.

Fix (RESOLVED): `resolveVerificationKey` now resolves absent caller policy from the catalog SSoT (fail-closed) and defers absent audience policy to `matchesExpectedAudience`, aligning both verifiers on one coherent semantic (explicit list honored; absent ⇒ catalog/expected-audience derived).

Status: RESOLVED (2026-06-13; owner: auth-security-expert; branch `fix/service-identity-keyring-catalog-policy`). Registered: docs/reviews/_registry/findings.jsonl#ORPHAN-MEDIUM-097.

---

## ORPHAN-MEDIUM-098 — ServiceIdentityGuard collapses all rejection reasons into a misleading "forged/expired/tampered" message

Severity: MEDIUM. `service-identity.guard.ts:130-134` maps every non-`missing-headers` outcome (including `caller-not-allowed` / `audience-not-allowed`, which are AUTHORIZATION/config failures) to the single browser text "Invalid service identity signature. Request may be forged, expired, or fields tampered with." During the ORPHAN-CRITICAL-094 outage this actively misled diagnosis — the real cause was an unauthorized caller, not forgery. The precise reason is already logged server-side (`outcome.reason`), only the client message is collapsed.

Fix direction: keep the generic CLIENT message (no leak), but emit a distinct, non-sensitive operator signal (structured log field already present + a metric label by `reason`) so an authorization/config failure is not indistinguishable from a tamper attempt in dashboards.

Status: RESOLVED (2026-06-26 — ServiceIdentityGuard now emits the raw machine-readable reasonCode (missing-headers/bad-hmac/stale-timestamp/caller-not-allowed/audience-not-allowed/key-not-found/key-not-active) on the publishServiceIdentityRejected security event — a structured field distinct from the human reason sentence, so dashboards/alerts can branch on the exact cause; the client ForbiddenException stays deliberately generic (no info leak). Guard spec proves the reasonCode flows through (5/5). Turning the event into a Prometheus label is downstream observability work) (2026-06-13; owner: auth-security-expert). Registered: docs/reviews/_registry/findings.jsonl#ORPHAN-MEDIUM-098.

---

## ORPHAN-LOW-099 — Stale comments in the service-identity keyring generator

Severity: LOW. `scripts/deploy/lib/required-env-secrets.sh` claimed "five droplet services" interpolate the keyring (it is twelve) and that absent `callers`/`audiences` are "treated as unrestricted" (the verifier fail-closed). The wrong comment is what authorized the #388 regression.

Fix (RESOLVED): corrected both comments to state twelve services and that policy lives in the service-catalog SSoT (verifier-enforced, fail-closed), with an explicit "do not re-add policy fields to this generator" note.

Status: RESOLVED (2026-06-13; owner: infra-expert; branch `fix/service-identity-keyring-catalog-policy`). Registered: docs/reviews/_registry/findings.jsonl#ORPHAN-LOW-099.

---

<!-- Wave-3 (auth-audit) ORPHAN findings restored during #390←main merge. These MEDIUM-0NN IDs were assigned on the W3 lineage before main's canonical HIGH-0NN existed; the {severity}-{number} scheme keeps them unique (see MEDIUM-088 numbering note). They are referenced by W3 commit Closes: trailers, so they must retain headings here. -->

## ORPHAN-MEDIUM-087 — `libs/shared-contracts` is an unwired, zero-consumer "SSoT" lib

**Found while:** wiring the canonical TenantStatus for W3.1 (MT-HIGH-003).

**Problem:** `libs/shared-contracts` advertises itself (its `index.ts` header) as "the single source of truth for cross-cutting domain concepts," but:
- it has NO `tsconfig.base.json` path alias and NO nx `project.json`, so it is not in the affected-graph and backend services cannot import `@aquaculture/shared-contracts` through the normal alias;
- its own `tsconfig.json` is deliberately isolated (`baseUrl: "."`, only `@/*` → `src/*`), so it cannot import any other lib — a re-export from it to `@platform/event-contracts` fails type-check with TS2307;
- a repo-wide grep finds ZERO real importers of `@aquaculture/shared-contracts` / `@platform/shared-contracts` in `apps/`, `web/`, or `libs/` (the one farm-service "reference" is a code comment).

It still declares its own copies of `PlanTier`, `SubscriptionStatus`, `BillingCycle`, `PlanVisibility`, `ImpersonationStatus/Reason`, `DataRequestType/Status` — duplicate definitions that can silently drift from the wired SSoT in `@platform/event-contracts`, exactly the class of bug MT-HIGH-003 / DBR-HIGH-003 exist to kill.

**Root cause:** the lib was created as an aspirational shared-contracts home but never wired into tsconfig paths / the nx graph, and the real platform SSoT consolidated into `@platform/event-contracts` instead. It is now dead weight that looks authoritative.

**Fix (recommended, not done here):** delete `libs/shared-contracts` entirely after confirming each of its enums either already exists in `@platform/event-contracts` or has zero consumers; or, if it must stay, wire it (tsconfig path + project.json + extend the base tsconfig) and make every enum a re-export of the event-contracts canonical. Out of scope for the auth-service audit PR; tracked here so the drift surface is visible. W3.1 removed only its `TenantStatus` duplicate (the immediate type-check blocker).

**Status:** RESOLVED (2026-06-26 — lib is wired+consumed (cross-stack MESSAGING_MEDIA_MIME_ALLOWLIST on messaging+aquamobil) so NOT deleted; instead deleted the 4 dead duplicate enum files (plan-tier/billing/impersonation/data-request — verified zero importers repo-wide) + narrowed index.ts to the media allowlist. Anti-drift lock: tests/invariants/shared-contracts-no-enum-drift.spec.ts forbids any export enum here).

## ORPHAN-MEDIUM-088 — admin-api-service unit-test suite broken at baseline (quarantined)

> Numbering note: this MEDIUM-088 and the unrelated `ORPHAN-HIGH-088` (tenant-schema runtime grants, data-expert) below were assigned `088` on two parallel lineages and merged here. They are distinct findings; the `{severity}-{number}` ID keeps them unique. MEDIUM-088 is referenced by commit e52ba895e, so it is not renumbered.

**Found while:** wiring the admin-api-service consumer of the TenantStatus machine (MT-HIGH-003 W3.1). Running `nx test admin-api-service` at the wave3 base surfaced dozens of failures UNRELATED to the TenantStatus work; confirmed pre-existing via `git stash` A/B at 596e63595.

**Problem (distinct root causes observed):**
- **58×** `Nest can't resolve dependencies of CreateTenantHandler … "EVENT_BUS" at index [1]`. CreateTenantHandler was migrated to `@Inject('EVENT_BUS')` (platform IEventBus) but `create-tenant.handler.spec.ts`, `tenant-creation.spec.ts`, and `tenant.integration.spec.ts` still provide the `EventBus` (cqrs) class token — a spec-vs-production DI drift from the enterprise-train lineage.
- **83×** `Nest can't resolve dependencies of DatabaseExplorerController … "explorer-readonlyDataSource"` — missing custom DataSource token provider in that controller's spec.
- **39×** `EmailSenderService … this.settingsService.getEmailConfigForSending is not a function` — stale mock (the settings service gained a method the spec mock lacks).
- ~30 assorted assertion failures (circuit-breaker `open` vs `closed`, `toBe`/`toHaveBeenCalledWith`) that may include REAL regressions from the same lineage and need per-case triage.

**Why not fixed here:** out of scope for the auth-service audit (Wave 3); it is admin-api-service's own audit surface. It does NOT block this PR — `scripts/ci/affected-target-policy.json` already quarantines the admin-api-service `test` target (and `auth-service`, `gateway-api`, and ~16 others) as known unit-test debt, so these failures are non-gating. The new `suspend-tenant.handler.spec.ts` added here passes in isolation (type-check clean, 0 errors).

**Fix (recommended, tracked for the admin-api-service audit):** repair the DI-drift specs (provide the `'EVENT_BUS'` / `explorer-readonlyDataSource` tokens), refresh the EmailSenderService mock, then triage the assertion failures for real regressions, and remove `admin-api-service` from the test quarantine so the suite gates again.

**Status:** OPEN (quarantined — non-blocking).

## ORPHAN-MEDIUM-090 — auth-service tenant consumer files carry diff-lint regressions (import-order + pre-existing type-safety debt)

**Found while:** running the diff-lint gate (`scripts/ci/lint-changed-files.mjs`) over the Wave-3 branch (W3.4). The gate reported 32 new error-level findings across six auth-service files that the Wave-3 consumer refactors touched: `user-lifecycle.service.ts` (the bulk) plus the `invitation`, `webauthn-credential`, `module`, and `mobile-user-settings` entities and `tenant-update-consolidation.spec.ts`.

**Problem (two lineages, same files):**
- **Branch-introduced (import-order):** the DATA-HIGH-001 outbox migration swapped `@Inject('EVENT_BUS') IEventBus` for `BestEffortEventPublisher` and the MT-HIGH-003/DATA-HIGH-002 entity work changed entity imports — both reshuffled import blocks without re-running `import/order`. 8 import-order errors in `user-lifecycle.service.ts` + one each in the five other files; `tenant-update-consolidation.spec.ts` also imported `Role` from the non-canonical `@platform/backend-common` barrel (no-restricted-imports).
- **Pre-existing type-safety debt surfaced by the diff (type-aware rules):** `require('crypto')` (no-require-imports + 3× unsafe-call/member), a non-null assertion `input.moduleIds!`, an `: boolean` inferrable annotation, an untyped `dataSource.query` result feeding `insertResult[0].id` (unsafe-assignment/member), and four `string === Role` enum comparisons (`no-unsafe-enum-comparison`) that became visible once `Role`/`TenantStatus` were typed as the canonical enums.

**Fix (DONE in this commit — Tier-1/Tier-3, behavior-preserving):**
- import-order auto-fixed across all six files; the spec's `Role` import re-pointed to the canonical `@aquaculture/backend-common/decorators`.
- `require('crypto')` → the file's existing ESM `import * as crypto` (closes the ORPHAN-HIGH-090 adjacent-cleanup note).
- a module-level `isCanonicalRole(value): value is Role` type guard replaces the `(Object.values(Role) as string[]).includes(...)` validation at both invite/create sites; the throwing negative branch narrows `input.role` to `Role`, which structurally removes the four `string === Role` comparisons AND three `as Role` assertions (Tier-1 make-impossible).
- `assertRoleHierarchy(targetRole)` retyped `string → Role` (callers now pass the narrowed value).
- the module-assignment presence check inlined into its `if` so TS narrows `input.moduleIds` (no non-null assertion).
- `dataSource.query<Array<{ id: string }>>()` generic + a fail-loud empty-row guard replaces the untyped result + `insertResult[0].id` member access.
- `sendInvitation: boolean = true` → `sendInvitation = true`.

**Verification:** all six files lint clean (0 errors); auth-service type-check clean (only the pre-existing `@nestjs/apollo` module-resolution noise remains); `user-lifecycle.service.spec.ts` + `tenant-user-management.service.spec.ts` + `tenant-update-consolidation.spec.ts` = 45/45 green (behavior preserved).

**Status:** RESOLVED (this commit). The deeper `createUser` non-transactional dual-write (ORPHAN-HIGH-090) is a separate, still-open finding.

## ORPHAN-MEDIUM-091 — admin-api tenant-detail any-leak query debt surfaced by MT-MEDIUM-002 (+ spec-fixture phantom-field decision)

**Found while:** MT-MEDIUM-002 (W3.4) touched `tenant-detail.service.ts` (real-source farm/sensor counting) and the two tenant provisioning specs (fixture caller-update). The blocking diff-lint gate (`scripts/ci/lint-changed-files.sh`; `ci-affected.yml` line 209 — "lint failures must block PR merge") re-lints any touched file head-vs-base. Its base worktree cannot run type-aware ESLint rules (the TS project is not built there), so it reports `base=0` for every type-aware rule and flags each touched file's FULL pre-existing type-aware debt as "new." Touching these files therefore dragged their unrelated, pre-existing debt into the gate.

**Problem:**
- `tenant-detail.service.ts` (production): `getUserStats` / `getModuleUsage` / `getResourceUsage` used untyped `dataSource.query` (an `any` leak feeding `result[0].x` / `result.map`), two `t.status === 'ACTIVE' | 'SUSPENDED'` string-literal comparisons (`no-unsafe-enum-comparison` vs the canonical `TenantStatus` enum), and two unused `catch (error)` bindings.
- `tenant-api.integration.spec.ts` + `tenant-provisioning.service.spec.ts` (admin-api **quarantined broken test debt — ORPHAN-MEDIUM-088**, one crashes at runtime on an unhandled rejection): deep mock `any` (`as any`, `callback: any`, untyped `jest.fn()`), non-null assertions, and unused imports.

**Fix:**
- `tenant-detail.service.ts` (DONE — Tier-3 type, behavior-preserving): typed all three query results with local row types (`UserStatsRow`, `ModuleUsageRow`, `{ calls_24h; calls_7d }`) via the `dataSource.query<T>()` generic, dropping the field-level `as` casts in the `.map`; `'ACTIVE'`/`'SUSPENDED'` → `TenantStatus.ACTIVE` / `TenantStatus.SUSPENDED`; logged the previously-discarded `getModuleUsage` catch error (consistency with the `getUserStats` BUG-007 pattern) and bare-caught the genuinely-ignored metrics catch. 0 lint errors; admin-api type-check clean.
- the two provisioning specs (REVERTED to origin/main): the MT-MEDIUM-002 fixture edit only removed the now-phantom `farmCount: 0` / `sensorCount: 0` lines from an `Object.assign(tenant, {...})` that tolerates excess props harmlessly. Cleaning their full pre-existing mock-`any` debt is high-churn / high-risk surgery on quarantined broken specs owned by ORPHAN-MEDIUM-088 — out of MT-MEDIUM-002's scope. Reverting returns them to a net-zero diff (out of the gate). The reverted fixtures still set `farmCount`/`sensorCount` via `Object.assign` — a harmless phantom property after the entity drop, to be removed when the admin-api specs are de-quarantined (ORPHAN-MEDIUM-088).

**Status:** RESOLVED for the production service. The spec phantom-fixtures + admin-api mock-`any` debt stay with ORPHAN-MEDIUM-088 (quarantined, non-blocking).

## ORPHAN-MEDIUM-092 — diff-lint gate linted base and head with DIFFERENT configs → a lint-config refactor flagged pre-existing debt as new regressions

**Found while:** resolving the diff-lint cascade that MT-MEDIUM-001 / MT-MEDIUM-002 kept hitting (3× this session). Every time a commit touched a file that already carried lint debt, the blocking diff-lint gate (`scripts/ci/lint-changed-files.mjs`; `ci-affected.yml` line 209 — "lint failures must block PR merge") reported that file's FULL pre-existing debt as "new error-level findings" (e.g. 72 findings across two admin-api specs the MT-MEDIUM-001 entity drop forced me to touch).

**Problem (root cause):** the gate measures whether a change introduces *new* lint errors by linting each changed file at base and at head and diffing the per-rule counts. But it linted the two sides with DIFFERENT configs:
- **head** — in the real repo, with head's `.eslintrc.json` + head's tsconfigs.
- **base** — in a detached worktree checked out at `origin/main`, with **origin/main's** config.

This branch (a) modified `.eslintrc.json` and (b) sits on a `tsconfig.base.json` that advanced on `origin/main` after the branch's merge-base. So base linted these specs with the OLD, looser ruleset and found **0** type-aware errors, while head linted them with the NEW ruleset and found **N** — a pure CONFIG delta the gate mis-attributed to the code. Empirically reproduced: `tenant.integration.spec.ts` base-lint = 0 errors with base config, = 39 with head's config. A lint-config refactor therefore made every newly-linted pre-existing issue look like a regression on whatever commit happened to touch the file.

**Fix (Tier-1, make-the-gate-correct):** `syncLintConfigFromHead()` overlays head's lint configuration onto the base worktree before base-linting — eslint configs (`**/.eslintrc*`, `**/eslint.config.*`, `**/.eslintignore`) + the tsconfigs its type-aware rules resolve (`**/tsconfig*.json`). It uses a **two-dot** `base..head` diff (NOT three-dot): the worktree is checked out at `origin/main` itself, so a config that advanced on base after the merge-base must still be overlaid — a three-dot diff would miss it. Now both sides lint with the SAME ruleset, so the base-vs-head delta isolates CODE changes from CONFIG changes; the gate flags only errors the diff actually introduced.

**Verification:** the same branch HEAD that produced 72 false error-level findings now reports **"No new error-level lint findings relative to origin/main"** (NODE_EXIT=0). The gate's own unit suite (parseArgs / parseDiffHunkLines / range + prepush helpers, 25 tests) stays green. The two admin specs' pre-existing debt is correctly recognised as pre-existing (base=head=39) and left to its ORPHAN-MEDIUM-088 quarantine owner.

**Known residual (tracked, non-blocking):** `@nx/enforce-module-boundaries` needs the cached nx ProjectGraph, which exists in the real repo but not the fresh worktree, so that one rule is base-skipped (it logs "No cached ProjectGraph … rule will be skipped"). It is a **warning**-level rule (report-only, never blocks), so the asymmetry is cosmetic; a complete fix would prime the nx graph in the worktree (`nx graph` / `NX_DAEMON`) — deferred as low-value vs. the blocking-error cascade this finding closes.

**Status:** RESOLVED (this commit).

---

## ORPHAN-CRITICAL-100 — token.service + tenant-role.service query auth-role tables in the OLD per-tenant schema after they were centralized into `auth`

Severity: CRITICAL. Discovered during W4 (PERF-HIGH-001). Migration `apps/admin-api-service/src/migrations/1800500000000-TenantProvisioningTopology.ts` MOVES `user_role_assignments` / `tenant_role_permissions` / `tenant_roles` from per-tenant `tenant_<uuid>` schemas into the shared `auth` schema (INSERT then `DROP TABLE ... tenant_<schema>.*`, lines 311-313) and its post-condition RAISEs if any tenant copy remains (line 333). But two auth-service consumers still query the OLD per-tenant schema:
- `apps/auth-service/src/modules/authentication/services/token.service.ts` `getUserResourcePermissions` — the LOGIN hot path.
- `apps/auth-service/src/modules/tenant/services/tenant-role.service.ts` — ALL 10 methods (read AND write: getTenantRoles/getRoleById/getDefaultRole/createRole/updateRole/deleteRole/seedDefaultRoles/assignRoleToUser/removeRoleFromUser), lines 296-1053, reachable via tenant-role.resolver (GraphQL CRUD) + tenant-user-management/user-lifecycle.

On a fully-migrated DB these queries throw "relation does not exist". In token.service this was MASKED by a silent `catch → return []` (module users silently got EMPTY resource permissions — a covert authorization downgrade); tenant-role.service's role-management surface breaks outright.

Fix (token.service — RESOLVED in W4 / this PR): repointed to `auth.user_role_assignments JOIN auth.tenant_roles JOIN auth.tenant_role_permissions`, **tenant-scoped** via `WHERE tr."tenantId" = $2` (parameter-bound; the schema-interpolation SEC-M13 surface is structurally gone), and the catch is now fail-loud. auth-security-expert reviewed: tenant isolation SAFE (the INNER JOIN + tenantId filter is stronger than the old per-schema boundary; `user.tenantId` is DB-loaded, not request-influenced).

Fix (tenant-role.service — REMAINING): the 10-method read+WRITE surface must be repointed to `auth.*` tenant-scoped in a dedicated, security-reviewed PR — its write paths (createRole/assignRoleToUser/etc.) must enforce tenant ownership or risk cross-tenant role mutation. Too large + write-path-security-critical to safely cram into W4.

Status: PARTIAL — token.service login path RESOLVED (W4 / this PR); tenant-role.service repoint OPEN. Owner: auth-security-expert + platform-services. Deadline: 2026-06-20.

---

## ORPHAN-HIGH-101 — Centralized `auth` role tables have NO database-layer RLS (tenant isolation rests on a single application WHERE clause)

Severity: HIGH (defense-in-depth). Surfaced by the ORPHAN-CRITICAL-100 security review. Collapsing the per-tenant schema boundary into shared `auth` tables removed schema-level isolation but did NOT replace it with row-level security: `auth.user_role_assignments` + `auth.tenant_role_permissions` have no tenant column (the RLS helper discovers tables by `tenantId`/`tenant_id`, so it cannot protect them), and no migration applies RLS to the `auth` schema (the topology RLS sweep only touches `tenant_<uuid>` schemas). Net: cross-tenant isolation for role/permission reads now depends ENTIRELY on every query carrying a `tr."tenantId" = $X` predicate — one forgotten predicate (or a `getRepository()` without scoping) is an instant cross-tenant leak with no DB backstop.

Fix direction: add a denormalized `tenantId` column to `auth.user_role_assignments` (carried at write time / trigger) and install `tenant_isolation_policy` on the three centralized tables via the existing helper; add a CI invariant asserting any SQL touching these tables carries a tenant predicate (Tier-3 detectable) until RLS lands.

Status: IN-PROGRESS (2026-06-27 — decision framed in docs/adr/038-auth-role-table-rls.md (Proposed) — Path A (DB-RLS as defense-in-depth: add tenantId to 2 tables + applyTenantRlsToSchema + per-request GUC on tenant-resolved paths) vs Path B (app-layer-param sufficient + a tenant-scope CI invariant). Recommends Path A iff the pre-tenant login bypass is safely separable. The latent RLS-enabled-no-policy state on auth.tenant_roles must be resolved either way. Implementation pending team ratification + staging validation) (2026-06-13; owner: auth-security-expert + data-expert).

---

## ORPHAN-MEDIUM-104 — Topology migration de-dup picks an arbitrary tenant for a multi-tenant user (silent permission loss)

Severity: MEDIUM. Surfaced by the ORPHAN-CRITICAL-100 security review. The `1800500000000` backfill enforces `UNIQUE(user_id)` on `auth.user_role_assignments` via `NOT EXISTS (... au.user_id = a.user_id)` while iterating tenant schemas in an UNORDERED loop. If the same `user_id` had an active assignment in two tenant schemas (a multi-tenant user), the migration keeps whichever tenant the loop reached first and silently discards the rest — that user then resolves permissions only for the surviving tenant (and the fail-loud catch will NOT surface it: the query succeeds, returns `[]`).

Fix direction: if multi-tenant users are possible, add a pre-migration audit (`GROUP BY user_id HAVING count(distinct schema) > 1`) + explicit conflict resolution (not first-loop-wins); if structurally impossible, assert it post-migration (source row count == inserted count) so a violated invariant fails loudly.

Status: OPEN (2026-06-13; owner: data-expert).

---

## ORPHAN-MEDIUM-105 — Missing index on `auth.tenant_role_permissions(role_id)` (token-mint JOIN seq-scans)

Severity: MEDIUM (perf). The PERF-HIGH-001 token-mint JOIN `auth.user_role_assignments ⋈ auth.tenant_role_permissions ON role_id` has no index on `tenant_role_permissions(role_id)` — the table (created in `1800200000000-CreateAdminEntitySurfaceTables`) has only the PK on `id` + an FK on `role_id` (Postgres FKs are not auto-indexed). `user_role_assignments` already has its indexes (UNIQUE user_id, role_id, is_active). The W4 PERF-HIGH-001 cache (60s TTL) mitigates per-mint cost; the index is the durable fix.

Fix direction: a new auth-schema migration `CREATE INDEX IF NOT EXISTS "idx_tenant_role_permissions_role_id" ON "auth"."tenant_role_permissions" ("role_id");` (idempotent, source-only).

Status: RESOLVED (2026-06-26 — added @Index(idx_tenant_role_permissions_role_id, [roleId]) to the TenantRolePermissions entity (admin-api, auth schema) + migration 1801100000000-AddTenantRolePermissionsRoleIdIndex (CREATE INDEX IF NOT EXISTS, idempotent/blue-green-safe, mirrors idx_tenant_roles_name). Indexes the per-mint token JOIN key. admin-api tsc clean) (2026-06-13; owner: auth-security-expert; pairs with ORPHAN-CRITICAL-100's tenant-role.service repoint PR).

---

## ORPHAN-HIGH-100 — 6 custom `aquaculture/*` architectural-invariant lint kuralı, 31 root:true per-project projede İNERT

Severity: HIGH. A2 (ESLint 8→9 flat migration) sırasında firsthand keşfedildi: `tools/eslint-rules`'deki 6 mimari-invariant kuralı (`require-entity-schema`, `no-bare-tenant-query-key`, `no-direct-event-publish`, `no-high-cardinality-metric-label`, `no-claude-sdk-raw-call`, `no-bare-graphql-query-string`) root `.eslintrc.json`'da **override** olarak tanımlıydı; ama her proje (apps/*, libs/event-contracts, libs/node-components, web/*, mcp/*, scripts, tests/invariants, tools/eslint-rules — 31 dizin) kendi `root: true` `.eslintrc.cjs`'ine sahip olduğundan eslintrc cascade proje sınırında DURUYORDU → bu kurallar proje dosyalarına HİÇ uygulanmadı. ESLint 8 `calculateConfigForFile` ile doğrulandı: `aquaculture/require-entity-schema` + `no-direct-event-publish` 55 proje-probe'unun **0**'ında tanımlı. Kurallar yalnız non-cjs zonlarda (`platform/libs/**`, `libs/backend-common/**`, `web/apps/aquamobil/**`) canlı.

Sonuç: `require-entity-schema` (her `@Entity()` şema disiplinini zorlar — ADR-011) HİÇBİR `apps/*/src/**/*.entity.ts` üzerinde çalışmıyor; tenant-IDOR'a karşı `no-bare-tenant-query-key` hiçbir web modülünde çalışmıyor. PR-1 bu kurallar için RuleTester unit'leri ekledi (izole doğru çalışıyorlar) ama CI lint'inde tetiklenmiyorlar.

Kök neden: nx'in proje-başına `root: true` `.eslintrc.cjs` üretme deseni, root-override-tabanlı custom kuralları yapısal olarak gölgeliyor. A2 flat migration bu davranışı SIFIR-DRIFT korudu (kurallar inert kalır) — aktivasyon bilinçli, ayrı, ölçülü bir değişiklik olmalı (platform genelinde binlerce yeni uyarı potansiyeli; her kural ayrı triyaj ister).

Düzeltme yönü: `eslint.config.mjs`'in `PROJECT_GLOBS`-gated custom-rule bloklarındaki ignore'ı kaldırıp her kuralı tek tek aktive et + çıkan ihlalleri kural-bazında triyaj et (önce `require-entity-schema` — ADR-011 zaten zorunlu kılıyor, ihlal sayısı düşük olmalı). Make-it-detectable: aktivasyon sonrası bir invariant her kuralın ≥1 gerçek dosyada resolve olduğunu assert etsin.

Status: OPEN (2026-06-12; sahip: platform-kernel-expert; A2 PR-2 firsthand bulgusu; aktivasyon ayrı PR).

## ORPHAN-MEDIUM-101 — `no-restricted-syntax` (JWT_SECRET + getRepository + JSON.stringify gate'leri) web modüllerinde ve e2e'de tutarsız

Severity: MEDIUM. A2 firsthand: `no-restricted-syntax` (6 selector: getRepository, JSON.stringify>2, 4×JWT_SECRET) ESLint 8 resolved davranışında zon-bazında tutarsız: apps + 4 web modülü (dashboard/farm-module/hr-module/hydroponics-module) = 6 selector (tam gate); ama **5 web modülü (shell, shared-ui, admin-panel, sensor-module, tenant-admin) = `off`** (cjs'leri `no-restricted-syntax: 'off'` set ediyor) ve **e2e = yalnız 2 selector** (root test override JWT_SECRET'i düşürüyor). Yani JWT_SECRET okuma yasağı 5 web modülünde + tüm e2e'de etkisiz; getRepository IDOR yasağı bu 5 web modülünde etkisiz.

Sonuç: bu surface'lerde `process.env.JWT_SECRET` veya bare `getRepository()` lint'ten geçer. Frontend'de JWT_SECRET düşük risk (web'de secret okunmaz) ama asıl boşluk e2e testlerinde JWT_SECRET (test kodu secret pattern'i kopyalayabilir, sonra prod'a sızabilir).

Kök neden: web modül cjs'leri React-ergonomisi için no-restricted-syntax'i toptan kapatmış (selector'lar AST gürültüsü üretiyordu); e2e override tarihsel olarak JWT_SECRET'i test-kolaylığı için düşürmüş. A2 bunu SIFIR-DRIFT korudu (faithful migration "iyileştirme" yapmaz).

Düzeltme yönü: JWT_SECRET 4 selector'ını web + e2e'de yeniden aktive et; flat config'te ayrı bir "JWT_SECRET-everywhere" bloğu (`files: ['**/*.ts','**/*.tsx']`, ignore yok) tüm zonlarda 4 JWT_SECRET selector'ını zorlar — eslintrc'nin yapamadığı tutarlılık. Ölçülü PR: önce e2e, sonra web.

Status: OPEN (2026-06-12; sahip: auth-security-expert; A2 PR-2 firsthand bulgusu; ORPHAN-HIGH-100 ile aynı aktivasyon dalgasında ele alınabilir).

## ORPHAN-MEDIUM-094 — CI affected-lint step lacks a NODE_OPTIONS heap bump; type-aware ESLint OOMs at the runner default

Severity: MEDIUM. The `Run linter (affected only)` step in `.github/workflows/ci-affected.yml:250` ran type-aware ESLint over the changed-file set with only `NX_DAEMON`/`NX_NO_CLOUD` in its env — no `NODE_OPTIONS`. Type-aware linting builds the full TypeScript project graph, which exceeds the runner's ~4GB default V8 heap: `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`, and the wrapper reports `lint-changed-files: ESLint produced no JSON for HEAD (exit=null, signal=SIGABRT)`. The lint gate then fails with **no code defect**. Every other heavy step in the same workflow (type-check, build, test — lines 316/407/417/431/538/609) already declares `--max-old-space-size=4096`; the lint step was the lone omission, so it sits at the ceiling and OOMs flakily under runner memory pressure.

Root cause: a TS-heavy CI step without a heap ceiling sized for the project-graph build. Fix (highest tier — make-it-automatic): add `NODE_OPTIONS: '--max-old-space-size=6144'` to the lint step env. 6144 matches the B1 wave's measurement (it clears the full-repo lint) and is safe on the 7GB ubuntu runner.

Discovered gating C1 PR-1a (#429): the 10-file federation lint surface (8 `vite.config.ts` + `federationSharedConfig.ts` + a spec) tipped the type-aware lint over the default heap; the prior C1 iteration's lint job failed identically. Fixed in the same C1 commit that surfaced it (C1 is blocked by it); the A2 ESLint flat-config wave owns broader lint configuration but does not modify this step.

Status: OPEN (2026-06-13; owner: infra-expert). Registered: docs/reviews/_registry/findings.jsonl#ORPHAN-MEDIUM-094.

---

## ORPHAN-MEDIUM-100 — messaging unread count disagrees between the Redis HASH counter and the DB subquery on a member's OWN messages

Severity: MEDIUM. Discovered 2026-06-13 while implementing Wave-6 M2 (mobile read-cursor), messaging-expert.

**Problem:** The two unread-count code paths apply different sender semantics:
- `message.service.ts` `incrementUnreadForChannelMembers(channelId, senderId, tenantId)` increments the per-user Redis HASH for all members **except the sender** — so the Redis-backed `getUnreadCount` (total badge, also used for push `badge:`) EXCLUDES the user's own messages.
- `get-channels.handler.ts:60` computes the per-channel badge as `SELECT COUNT(*) FROM messages m WHERE ... AND m."createdAt" > COALESCE(membership."lastReadAt", '1970-01-01')` — **no `senderId` filter** — so it INCLUDES the user's own messages until `lastReadAt` passes them. The DB fallback `getUnreadCountFromDb` shares this no-sender-filter shape.

**Effect:** A user who sends a message can see a non-zero per-channel unread badge (DB subquery counts their own send) while the global Redis badge shows zero, until their read cursor advances past their own message. The two surfaces disagree. Wave-6 M2 masks the user-visible symptom (the mobile client now advances `lastReadAt` to the newest message *including own sends*, so the badge clears on view), but the underlying server-side inconsistency remains: anything that reads the DB subquery without an advanced cursor (e.g. a freshly-sent-then-backgrounded channel, or a non-mobile client) still mis-counts.

**Fix direction (architectural, not masked):** make the two paths agree on sender semantics. Either (a) add `AND m."senderId" <> membership."userId"` to the `get-channels` + `getUnreadCountFromDb` subqueries so the DB matches Redis (own messages never count as unread — the semantically correct choice), or (b) decide own-messages DO count and increment Redis for the sender too. Option (a) is preferred: a user's own message is never "unread" to them. Requires updating both subqueries + a regression test asserting own-message sends do not inflate the per-channel badge.

Status: RESOLVED (2026-06-26 — all three unread paths now share ONE predicate: extracted unreadMessagePredicateSql (message/unread-message.predicate.ts, excludes member-own + soft-deleted + read), consumed by BOTH get-channels.handler badge subquery AND getUnreadCountFromDb; the channel-list subquery previously omitted the senderId exclusion. Locked by messaging-unread-count-ssot.spec.ts + helper unit test) (2026-06-13; owner: messaging-expert). Registered: docs/reviews/_registry/findings.jsonl#ORPHAN-MEDIUM-100.

---

## ORPHAN-MEDIUM-102 — 108 dead FE GraphQL operation contracts shipped across the four frontends

Severity: MEDIUM. Discovered 2026-06-13 while building the dead-contract ratchet gate (Tier-3 follow-up to Wave-6 M2 / MSG-CRITICAL-001), messaging-expert.

**Problem:** A token-frequency scan of `web/**` (`tests/invariants/lib/dead-contract-scan.ts`) found **108 exported GraphQL operation consts (68 mutations + 40 queries) of 584 total that are referenced nowhere** — defined in operation files, shipped to the bundle, reachable by no call site. This is the exact failure mode of M2 (`MARK_MESSAGES_READ` existed + had an offline-replay branch but no trigger, so mobile read state never advanced); M2 was one symptomatic instance of a systemic 108-wide debt. Each dead contract is either (a) a feature wired on the backend but never reachable from the UI (a silent product gap like M2), or (b) genuinely abandoned code (bundle bloat + reviewer noise). Without triage we cannot tell which.

**Effect:** Latent — any of the 108 could be a non-functional feature a user expects to work (the M2 class), and all of them inflate the bundle and obscure which operations are live. Distribution skews to farm-module feedingProgram (15+) and hr-module operations (20+).

**Containment (done):** the dead-contract ratchet invariant (`tests/invariants/dead-contract-fe-operations.spec.ts` + `dead-contract-fe-operations.baseline.json`) FREEZES these 108 and fails CI on any NEW dead contract or any baseline entry that has since been wired/deleted — so the set can only shrink. The bleeding is stopped; this finding tracks the burn-down.

**Fix direction (burn-down, per-module owners):** for each baseline entry, either wire the operation to its intended call site (if it backs a real feature — the M2 fix shape) or delete it (if abandoned), then remove it from the baseline. Owners: farm-module (feedingProgram.mutations), hr-module (attendance/certification/leave/performance operations), aquamobil (messaging-operations residue), sensor-module. No silent baseline padding — the gate's honesty check forbids it.

Status: OPEN (2026-06-13; owner: frontend-expert; burn-down tracked, no deadline). Registry: orphan-findings.md (not dual-registered to findings.jsonl — keeps the gate PR's findings.jsonl footprint zero to avoid the registry chain-conflict cascade).

---

## ORPHAN-MEDIUM-103 — two messaging CI gate scripts are registered but executed by nothing (dead gates)

Severity: MEDIUM. Discovered 2026-06-13 during Wave-2 close-out (verifying the source branch's "CI invariant" slice vs main), messaging-expert.

**Problem:** `scripts/ci/check-messaging-source-outbox.mjs` and `scripts/ci/check-messaging-canary-metrics.mjs` exist on main and are registered as `package.json` scripts (`gates:messaging-source-outbox`, `gates:messaging-canary-metrics`), but **no workflow, deploy script, husky hook, or aggregate gate invokes them** — only `check-messaging-tenant-entity-routing.mjs` is CI-wired (`quality-gates.yml:112`). The workflow that was meant to run them — `messaging-enterprise-release.yml` from `fix/messaging-enterprise-gates-2026-05-29` — was never ported to main (main uses the unified ADR-033 deploy instead). This is the same dead-artifact class as MSG-HIGH-004 (a complete check with no runner) and the Wave-6 M2 dead trigger.

**Effect:** Limited, because the protected invariants are belt-and-suspandered elsewhere: the source-only-outbox contract is enforced at DDL/migration level by `1800400000000-EnforceSourceOnlyMessagingOutboxContract.ts` (`@SourceOnlyMigration`), so the dead `source-outbox` CI check is a redundant early-warning, not the only guard. `canary-metrics` is a post-deploy canary check that simply never runs, so messaging deploys get no canary-metric gate.

**Why not fixed inline:** unlike `tenant-entity-routing` (static-only → runs in the no-DB `quality-gates` job), `check-messaging-source-outbox.mjs` also opens a live `pg.Client` (DATABASE_URL) and `canary-metrics` queries live deploy metrics — so wiring them needs a DB-backed gate job (or a static/live split of the source-outbox script) and a deploy-time canary step. That is a focused CI-infra change, not a safe session-end one-liner; rushing a DB-backed gate risks a broken required check.

**Fix direction:** either (a) add a DB-backed messaging-gates job (postgres service + migrations) that runs `gates:messaging-source-outbox`, and a post-deploy canary step (deploy workflow) that runs `gates:messaging-canary-metrics`; or (b) refactor `check-messaging-source-outbox.mjs` to split its static asserts (runnable in `quality-gates`) from its live-DB asserts. Then remove the dead `package.json` entries if a script is dropped, so no gate is registered-but-unrun.

Status: RESOLVED (2026-06-26 — deleted both dead scripts (check-messaging-source-outbox.mjs + check-messaging-canary-metrics.mjs) + their package.json gate entries + format-scope.json entries — no workflow invoked them. The source-only-outbox contract is enforced at migration DDL (@SourceOnlyMigration) + the live check-messaging-tenant-entity-routing gate; the canary needs a droplet Prometheus (ORPHAN-090) and can be re-added wired to deploy if 090 lands) (2026-06-13; owner: infra-expert; tracked follow-up). Registry: orphan-findings.md only.

## ORPHAN-HIGH-101 — postgres-protocol/tokio-postgres newly-published RustSec advisories red-line all Rust CI

Severity: HIGH. `cargo-audit` and `cargo-deny` (advisories check) fail on every Rust PR because of three newly-published advisories on transitive Postgres crates: **RUSTSEC-2026-0179** (HIGH 8.7 — `postgres-protocol` unbounded SCRAM iteration count, a malicious server can cause CPU-exhaustion DoS), **RUSTSEC-2026-0180** (MEDIUM — `postgres-protocol` panic decoding a malformed `hstore`), **RUSTSEC-2026-0178** (MEDIUM — `tokio-postgres` panic on a `DataRow` with fewer fields than columns). The platform's `.cargo/audit.toml` ignore list is empty, so these are denied. Main's last rust-ci runs are green only because they predate the advisory publication.

Root cause: time-of-publication, not a code change — a fresh RustSec advisory on an already-resident dependency. Fix (highest tier — upgrade to the patched release, not an ignore): `postgres-protocol` 0.6.11 → 0.6.12, `tokio-postgres` 0.7.17 → 0.7.18 (cascades `postgres-types` 0.2.14). The direct dep `tokio-postgres = "0.7"` (crates/outbox-rs + apps/sensor-ingestion) already permits the patched release, so a lockfile bump suffices; no Cargo.toml change.

Discovered gating R1's Rust CI (#450); affects the whole repo. Fixed in branch `security/rustsec-2026-postgres`. Only the root workspace is affected (sens-api-gateway does not use these crates).

Status: OPEN (2026-06-14; owner: infra-expert). Registered: docs/reviews/_registry/findings.jsonl#ORPHAN-HIGH-101.

---

## ORPHAN-CRITICAL-101 — auth role-table consumers (tenant-role / tenant-user-management / user-lifecycle services) query the DROPPED per-tenant role tables

Severity: CRITICAL. Discovered + RESOLVED 2026-06-14 during Wave-5 closeout (auth-service service-audit), lead-verified firsthand. This is the non-token-service half of the schema-centralization defect; the token.service login-path half is ORPHAN-CRITICAL-100 (token.service `getUserResourcePermissions`, repointed by W4 PR #440).

**Problem:** Migration `apps/admin-api-service/src/migrations/1800500000000-TenantProvisioningTopology.ts` MOVES `user_role_assignments` / `tenant_roles` / `tenant_role_permissions` from per-tenant `tenant_<uuid>` schemas into the shared `auth` schema (INSERT then `DROP TABLE ... tenant_<schema>.*`, RAISEs if any tenant copy remains). But three auth-service services still issued `"${schemaName}"."<role table>"` (per-tenant, string-interpolated) queries — ~45 in `tenant-role.service.ts`, ~15 in `tenant-user-management.service.ts`, plus `user-lifecycle.service.ts` `deleteUser` role-revoke + private `createRoleAssignment`. On a migrated DB every role-management operation (create/update/delete role, assign/revoke user role, set default, user delete) throws `relation does not exist`.

**Fix (RESOLVED, this PR):** repointed all role-table SQL to `"auth"."<table>"` tenant-scoped — `tenant_roles` by `AND tr."tenantId" = $x`; child tables (`user_role_assignments`, `tenant_role_permissions`, no tenantId column) by a write-side `JOIN/FROM "auth"."tenant_roles" tr ... AND tr."tenantId" = $x` so every WRITE carries its own tenant guard. Load-bearing corrections from the adversarial review swarm: (a) `assignRoleToUser` re-keyed to the global `UNIQUE(user_id)` (one-row-per-user re-point, never a 2nd INSERT) + a tenant-scoped `SELECT 1 FROM auth.users WHERE id=$1 AND "tenantId"=$2` user pre-validation (blocks attaching a foreign-tenant user to a tenant role); (b) `is_default` unset-writes carry `AND "tenantId"=$x` (else platform-wide default-role corruption); (c) only GROUND-TRUTH columns (auth.user_role_assignments has NO `updated_by`/`removed_by`/`removed_at`); (d) `assertRoleGrantAuthority` actor lookup tenant-pinned; (e) `audit-log.service.log()` gained a manager-aware overload so in-transaction audits are atomic with the mutation. Verified firsthand on every axis (columns, cross-tenant-write guard, interpolation=0, param-index, actor-pin, audit manager-threading) + 121/121 unit/regression tests.

**Tracked follow-ups (NOT this PR):**
- token.service `getUserResourcePermissions` repoint — owned by W4 PR #440 (intentionally not touched here to avoid a merge conflict on the same method).
- Stale-row edge (MEDIUM): `assignRoleToUser`/`createRoleAssignment` existing-row SELECT JOINs `tr."tenantId"`, so a user whose single `user_role_assignments` row points to a non-current-tenant or NULL-tenant role is missed → falls to INSERT → `UNIQUE(user_id)` violation. Fails LOUD on anomalous data (the user pre-validation already blocks the cross-tenant write); robust fix = read the user's row by `user_id` alone. Owner: auth-security-expert.
- DB-layer backstops (data-expert): partial `UNIQUE INDEX ON auth.tenant_roles ("tenantId") WHERE is_default` (single-default invariant is app-enforced only); NULL-tenant (platform-global) role semantics for equality predicates.
- Tier-1 structural hardening (tracked by description — the `ORPHAN-HIGH-101` id is now held by an unrelated postgres-RustSec finding on main): add a `tenantId` column (+ FK/RLS) to `auth.user_role_assignments` so assignments are directly tenant-scoped, replacing the JOIN-laundering. Owner: auth-security-expert + data-expert.

Status: RESOLVED (2026-06-14, this PR — tenant-role/tenant-user-management/user-lifecycle repoint); token.service via W4 #440; sub-items above OPEN. Owner: auth-security-expert. Registry: orphan-findings.md only.

## ORPHAN-HIGH-102 — all messaging-service-e2e suites fail to LOAD with `Class extends value undefined is not a constructor or null`

**Found:** 2026-06-14, while landing Wave-5 D2 (gateway rate-limit SSoT, PR #457). The CI `E2E Tests` job (run 27512311241, head 7a694107e) failed at the **Run E2E tests** step — NOT a test assertion and NOT the gateway/rate-limit change. Every `apps/messaging-service/test/*.e2e-spec.ts` suite (channel-management, messaging-core, compliance, offline-sync, messaging-features, tenant-isolation, content-sanitization, media-upload, ai-chat, gdpr, …) reports **`Test suite failed to run: TypeError: Class extends value undefined is not a constructor or null`**.

**Why this matters (HIGH):** the entire messaging-service E2E safety net is silently disabled — the suites never execute, so any real messaging regression ships undetected. `Class extends value undefined` at import time means a base class / barrel export / module resolves to `undefined` when a subclass is evaluated — almost always a **circular import** (the base module hasn't finished initializing when the subclass `extends` it) or a barrel-ordering issue under the E2E `ts-jest` config.

**NOT a D2 regression:** D2 (#457) only touches `apps/gateway-api` + `libs/backend-common/src/rate-limit` and never imports messaging-service. #457's branch was cut from old `main` (pre-D1/PR-2/Tier-4/D3/#453), so this is pre-existing platform E2E debt that #457's CI surfaced.

**Root-cause TODO (owner: messaging-expert):**
1. Verify whether current `main` (0c2370b04) still reproduces — re-run the `E2E Tests` job or boot one messaging E2E spec locally.
2. If so, find the undefined base: grep the messaging E2E test base class + its import chain for a circular dependency or a barrel (`index.ts`) that re-exports the base before it is defined. The fix is usually to import the base from its concrete module (not the barrel) or break the cycle.

**RESOLVED (2026-06-15, branch `fix/messaging-e2e-orphan-high-102`) — root cause was NOT a circular import.** Empirically reproduced (ephemeral CI-equivalent Postgres+Redis, the exact `e2e-messaging.yml` env) the exact load crash and captured the stack:

```
TypeError: Class extends value undefined is not a constructor or null
  at libs/backend-common/src/nats/nats-v3-server.strategy.ts:47   ← `export class NatsV3Server extends Server`
  at libs/backend-common/src/nats/index.ts:15                     ← barrel re-exports NatsV3Server (fan-out)
  at platform/libs/event-bus/src/nats/nats-event-bus.ts           ← event-bus imports @aquaculture/backend-common/nats
  at platform/libs/event-bus/src/index.ts:9
  at apps/messaging-service/test/e2e-setup.ts:30                   ← e2e-setup imports @platform/event-bus
  at <spec>.e2e-spec.ts
```

It is **mock-completeness drift**, not a cycle: A3 PR-B (#438) added `class NatsV3Server extends Server` (from `@nestjs/microservices`) to the `backend-common/nats` barrel. That barrel is transitively imported by **every** E2E spec via `@platform/event-bus` → `e2e-setup`. But the messaging Jest configs redirected `@nestjs/microservices` (via `moduleNameMapper`) to a hand-written stub `src/__mocks__/@nestjs/microservices.ts` that exported `ClientProxy` but **omitted `Server`** — on a stale, false premise ("not installed in workspace"; the package is a declared dependency at `^11.1.19`). So `Server` resolved to `undefined` and the subclass failed at import.

**Fix (Tier-1, "make it impossible"):** removed the `^@nestjs/microservices$` `moduleNameMapper` entry from **both** `test/jest-e2e.config.ts` and `jest.config.ts` (unit) and **deleted the stub**, so the real installed package loads (real `Server`/`ClientProxy`). NATS stays isolated at the **already-present** DI seam in `e2e-setup.ts` (`.overrideProvider('NATS_SERVICE'|'EVENT_BUS'|NatsEventBus)`) plus `NatsV3Client`'s lazy `connect()`; the harness never calls `connectMicroservice()`, so `NatsV3Server` is never instantiated. A cross-check workflow (messaging + platform-kernel verifiers + adversarial challenger + architectural-arbiter) caught that the unit-config mapper also pointed at the stub — deleting it without removing that mapper would have broken every messaging **unit** spec.

**Verification (CI confirmed):** with this fix + the ORPHAN-HIGH-092 mock fix, the messaging `E2E Tests` job ran **12 suites / 111 tests green, 0 hook timeouts** on a clean CI container (workflow_dispatch run 27571220824). Unit suite 207 green; `tsc -p tsconfig.spec.json` clean.

Status: RESOLVED (PR #473; pending registry close on merge). Owner: messaging-expert. Registry: `ORPHAN-HIGH-102` in `docs/reviews/_registry/findings.jsonl`.

> **D2 / CRITICAL-002 traceability note (not a registry close):** the gateway rate-limit consolidation (PR #457, `0c2370b04`) — which also fixed the gateway's fail-OPEN Redis store — is fully traced by its own commit message + PR. It is NOT seeded as a closable registry finding because the three-store invariant requires a closing commit to carry a `Closes: …#<id>` trailer *at commit time*; a finding seeded post-merge cannot be closed against an already-merged commit (no amend/force-push). The SEC-MEDIUM-001/002 closes in this same registry pass ARE valid because D1's commit (`bc79457d5`) carried their `Closes:` trailers.

## ORPHAN-MEDIUM-106 — platform/configs typed config-schema SSoT is empty; services read process.env ad-hoc

Severity: MEDIUM. Discovered 2026-06-13 during the AquaMobil e2e audit, frontend-expert. Out of scope for the AquaMobil remediation initiative — recorded here per the locked plan decision (config-SSoT is a separate initiative, but every found finding is registered).

**Problem:** `platform/configs/` — intended as the typed configuration SSoT — is effectively empty. Backend services and the gateway read configuration directly from `process.env` ad-hoc (untyped `configService.get<string>(...)` / raw `process.env.X` accesses scattered across bootstrap, NATS, DB, and feature-flag paths), with no central schema, no fail-fast validation at boot, and no single place documenting which variables exist, their types, defaults, and required-ness. A missing or malformed env var surfaces as a late runtime failure (or a silent wrong-default) rather than a boot-time rejection, and there is no compile-time contract binding a consumer to a declared key.

**Effect:** config drift is undetectable until runtime; a typo'd or absent env var can degrade a service silently; there is no typed surface a reviewer can read to know the full configuration contract of a service. This is the configuration analogue of the enum / WS-payload drift this initiative fixes elsewhere — the same SSoT gap on a different axis.

**Fix direction (architectural, separate initiative):** populate `platform/configs/` with a typed, validated config-schema module (a Zod/joi schema per service, or a shared schema with per-service slices) loaded once at bootstrap with fail-fast validation (reject boot on a missing/malformed required key), and replace ad-hoc `process.env` / untyped `configService.get` reads with typed accessors derived from that schema. A CI invariant then asserts no service reads `process.env` outside the config layer. Tier-1 "make-it-impossible": a consumer cannot reference an undeclared key because the typed schema is the only access path.

Status: RESOLVED (2026-06-26 — CONVERGED: the real typed-config SSoT is the already-wired per-concern factory pattern (typeorm-config.factory + event-bus-config.factory), both fail-fast; the empty central platform/configs was an unbuilt aspiration whose resurrection would just rebuild the Potemkin-SSoT anti-pattern. Locked drift growth via tests/invariants/config-env-access-ratchet.spec.ts (raw process.env file count ratcheted at baseline 5, allowlisting the TypeORM-CLI data-source.ts + main.ts). 14/20 raw reads were legit CLI; 1 was comment-only. Per-service migration of the 5 grandfathered boundary reads is ratchet-locked to only shrink. Duplicate of the config ORPHAN-MEDIUM-109) (2026-06-13; owner: frontend-expert → platform; separate initiative). Registered: docs/reviews/_registry/findings.jsonl#ORPHAN-MEDIUM-104.

---

## ORPHAN-MEDIUM-107 — lint-gates husky pre-commit gate is broken under ESLint 9 (eslintrc-format parserOptions fed to a flat-config Linter)

Severity: MEDIUM. Discovered 2026-06-13 while landing the aquamobil-msg-federation merge — the husky pre-commit hook blocked the merge commit (13/19 gate cases threw). RESOLVED in the same merge.

**Problem:** `tools/lint-gates/lint-gates.spec.ts` — the ESLint gate-preservation test wired into `.husky/pre-commit` via the `tools/*gates/*.spec.ts` glob — calls `linter.verify(code, { parserOptions: { ecmaVersion: 2022, sourceType: 'module' }, rules })` against a `new Linter()` instance. The repo migrated to ESLint 9 + flat config (`eslint.config.mjs`; `.eslintrc.json` / `.eslintrc.cjs` deleted), and ESLint 9's `Linter` defaults to flat-config mode, which rejects a top-level `parserOptions` key: "Key 'parserOptions': This appears to be in eslintrc format rather than flat config format." All 13 gate-firing cases threw, so the hook exited 1 and blocked every commit. The test file is byte-identical to `origin/main` (`git diff origin/main` empty) under the repo's pinned `eslint@^9.39.4`, so this is a pre-existing main breakage, not a merge artifact.

**Effect:** the pre-commit gate suite is unrunnable on ESLint 9. Either commits are hard-blocked, or developers bypass with `--no-verify` — which silently disables ALL the other pre-commit gates too (banned-phrase, banned-construct, migration-sql-lint, tier-claim-lint, and the rest of the gate-preservation suite guarding the getRepository() / JWT_SECRET / JSON.stringify bans). The safety net that proves the ESLint config still fires the custom AST-selector rules was dead under the repo's own pinned ESLint.

**Fix (applied, tier-1, flat-config-consistent):** change the gate harness to speak flat config — `languageOptions: { ecmaVersion: 2022, sourceType: 'module' }` instead of the eslintrc-shape top-level `parserOptions`. This aligns the harness with the repo's flat-config SSoT rather than re-enabling an eslintrc compat mode. Verified: 19/19 spec cases pass under ESLint 9.39.4.

Status: RESOLVED (2026-06-13; fixed in the aquamobil-msg-federation merge commit). Registry: orphan-findings.md only.

---

## ORPHAN-HIGH-105 — Varsling events (WelfareEventReported / EscapeReported / DiseaseOutbreakReported) lack JSON Schema validators

Surfaced by FARM-HIGH-013 (Phase 1). The three legally-immediate Mattilsynet varsling events are published over NATS to the notification-service email consumer but have NO AJV JSON Schema validator at the trust boundary (unlike the 4 dead-listeners follow-ups added in FARM-HIGH-012 and the existing farm events). Payload completeness is unproven before a legal filing is emailed — the consensus flagged this as why "provably reaches the regulator" is not yet fully satisfied. Fix: add flat JSON Schema validators for the 3 varsling events in `libs/event-contracts/src/schemas/farm-events.schema.ts` + wire into `FARM_EVENT_SCHEMAS`/`FarmEventType`, mirroring the dead-listeners follow-up schemas. Owner: data-expert (event-contracts). Status: OPEN (2026-06-14). Registry: orphan-findings.md only.

## ORPHAN-LOW-108 — Dead invalidateAllRegulatoryQueries predicate (query-key-factory mismatch)

Surfaced by FARM-HIGH-013 (Phase 1, pre-existing). `useRegulatory.ts` `invalidateAllRegulatoryQueries` tests `query.queryKey[0] === REGULATORY_KEY`, but `createTenantQueryKey` returns `['tenant', tenantId, ...]` so index 0 is always the tenant sentinel — the predicate never matches and regulatory queries are never invalidated after a varsling submit. Pre-existing query-key-factory bug inherited by the new hooks; no correctness dependency for the immediate-report path (the submit itself is durable). Fix: match the REGULATORY_KEY segment at its real index (or use the factory's prefix matcher). Owner: frontend query-key-factory owner. Status: OPEN (2026-06-14). Registry: orphan-findings.md only.

## ORPHAN-MEDIUM-116 — `entity-migration-parity.spec.ts` (MA2/MA3) is a non-functional, CI-unreached invariant

Severity: MEDIUM. Discovered 2026-06-14 while wiring the farm_workers PII-at-rest hardening (auth-security-expert REJECT-REDO item 3b), security-implementer.

**Problem:** `e2e/tests/integration/entity-migration-parity.spec.ts` is supposed to enforce two invariants — MA2 (every `@Entity('<table>')` has a `CREATE TABLE` migration) and MA3 (every entity column appears in the migration's CREATE TABLE body). It currently enforces neither, for three compounding reasons:

1. **`ENTITY_NAME_RE` recognizes zero entities (backreference bug).** The regex is `/@Entity\(\s*(?:(?:['"])([a-z_][a-z0-9_]*)\1|...)/i`. The quote alternation `(?:['"])` is NON-capturing, so capture group 1 is the *table-name* group, and the trailing `\1` therefore demands the table name appear twice consecutively. No real `@Entity('farm_workers')` (or any of the canonical forms, including `@Entity({ name: '...' })`) matches. Verified: the regex returns NO MATCH against every canonical `@Entity` form, so `collectAll()` yields `entities.length === 0`; the "lists at least one entity (sanity)" assertion fails and both `it.each(...)` blocks throw `.each` called with an empty Array. The regex is byte-identical since its introduction in commit 2a1906bba — the spec has been red since birth.

2. **The CREATE TABLE body parser assumes one-column-per-line.** Even with the regex fixed, `parseMigration` splits the captured body on `\n` and matches `"<name>" <type>` per line. The farm baseline (and others) emit each `CREATE TABLE` on a SINGLE 1000+ char line (`farm_workers` CREATE TABLE is 1089 chars on one line), so the parser recognizes only the first column (`id`). A regex-only fix surfaces 215 MA3 "violations" across every service — all pre-existing, none introduced by PII work.

3. **The parser only reads `CREATE TABLE`, never `ALTER TABLE ADD COLUMN`.** The "sanctioned ALTER-column pattern" the REJECT-REDO assumed exists does NOT: `AddTankSetupMetadata1800900000000` adds `tanks.containerKind/equipmentTypeId/equipmentTypeCode` via `ALTER TABLE ADD COLUMN`, and those columns are NOT in the baseline `tanks` CREATE TABLE — so `tanks` would fail MA3 identically to `farm_workers.emailHash`. There is no working mechanism by which any ALTER-added column satisfies MA3 today.

4. **Not wired into CI.** The Nx project `@aquaculture/e2e-tests` exposes only a `lint` target (no `test` target), and no workflow runs `npm run test:integration` / the `e2e/jest.config.ts` integration suite (`db-migration-check.yml` runs only `bootstrap`, `tenant-clone`, `schema-invariants` and the gate scripts by name). The `invariant-reachability.spec.ts` net covers only `tests/invariants/**`, not `e2e/tests/integration/**`, so the orphaned-and-broken state went undetected. This is why a permanently-red spec never blocked a merge.

**Effect:** The intended Tier-1 "make-impossible" guard against "entity shipped, migration forgotten" / camelCase-vs-snake_case drift does not run and could not pass if it did. The two deploy breaks it was written to prevent (event_store 2026-04-16, HR 2026-04-16) are currently unguarded by THIS spec (the `tests/invariants/registry` shard — `farm-service-migration-array-completeness`, `entity-diff-implies-migration`, `tenant-fanout-entity-parity` — provides overlapping but not identical coverage and IS CI-wired and green).

**Why not fixed in the PII PR:** Making MA3 genuinely green requires (a) fixing `ENTITY_NAME_RE` (make the quote group capturing: `(['"])([a-z_][a-z0-9_]*)\1`), (b) parsing single-line CREATE TABLE bodies (split on commas at paren-depth 0, not on `\n`), and (c) merging `ALTER TABLE ... ADD COLUMN` columns into each table's column set so ALTER-added columns (`tanks.containerKind`, `farm_workers.emailHash`) satisfy parity. Steps (a)+(b) then surface 215 pre-existing cross-service violations that must each be triaged (real drift vs parser limitation vs name-override needed). That is a platform-wide parser rewrite plus a 215-item cross-service triage — categorically outside a farm PII-at-rest change, and re-architecting a dead invariant under a security PR would be unbounded scope creep with a large blast radius. Hand-editing the frozen baseline or excluding `farm_workers` was explicitly forbidden and would weaken the invariant.

**Fix direction (minimal correct resolution, dedicated PR):**
1. Fix `ENTITY_NAME_RE` so the closing quote is a backreference to a CAPTURED quote group; re-confirm `collectAll()` finds all ~245 entities.
2. Rewrite `parseMigration` body tokenizer to handle single-line CREATE TABLE bodies (paren-depth-aware comma split).
3. Extend the migration parser to also collect `ALTER TABLE [schema.]"<table>" ADD COLUMN [IF NOT EXISTS] "<name>"` and merge those column names into the matching table's column set — making ALTER-add the sanctioned way an ALTER-added entity column satisfies MA3 (this is what `tanks.containerKind` and `farm_workers.emailHash` both need).
4. Triage the resulting violations; add `@Column({ name })` overrides or real migrations as each requires; only genuine, documented exceptions go in `EXCLUDED_TABLES`.
5. Wire the spec into CI: add a `test` target to the `e2e` Nx project (or fold the integration specs into a CI-run jest config) so the now-functional invariant actually gates PRs. Extend the reachability net to cover `e2e/tests/integration/**`.

Status: OPEN (2026-06-14; owner: platform-architecture-expert; dedicated PR — invariant parser rewrite + cross-service triage). Registry: orphan-findings.md only.

## ORPHAN-MEDIUM-109 — BatchCreated + FeedingCompleted farm listeners also dead (@OnEvent, no in-process producer)

Surfaced by FARM-HIGH-012 (Phase 1). `BatchCreatedListener` (`@OnEvent BATCH_CREATED`) and `FeedingCompletedListener` (`@OnEvent FEEDING_COMPLETED`) have the identical dead-bus disease the mortality/harvest listeners had — their producers publish via outbox->NATS, nothing emits the in-process event. They are FROZEN in the `dead-onevent-listener.invariant.spec` shrink-only baseline so that gate can land; they need the same `subscribeWildcard` migration. Owner: farm-expert. Status: OPEN (2026-06-14). Registry: orphan-findings.md only.

## ORPHAN-MEDIUM-110 — Varsling submissions have no durable per-submission audit row

Surfaced by FARM-HIGH-013 (Phase 1). The 3 immediate reports are delivered purely via outbox->NATS->email with no durable per-submission audit/acknowledgement record. A legally-immediate Mattilsynet/Fiskeridirektoratet report should leave a queryable audit trail independent of email logs (SOC2 / akvakulturloven evidentiary). Fix: persist a varsling-submission audit row (event-as-record) on the regulatory path. Owner: compliance-expert. Status: OPEN (2026-06-14). Registry: orphan-findings.md only.

## ORPHAN-MEDIUM-111 — BatchClosedEvent.closedAt: TS type (Date) vs JSON Schema validator (ISO_DATE_STRING) mismatch

Surfaced by FARM-HIGH-014/FARM-MEDIUM-003 (Phase 2 biomass-fcr-closure data/contract audit). `BatchClosedEvent.closedAt` is typed `Date` in `libs/event-contracts/src/farm-events.ts` and the handler enqueues a `Date` (close-batch.handler.ts), but the AJV validator types `closedAt` as `ISO_DATE_STRING` in `libs/event-contracts/src/schemas/farm-events.schema.ts`. If the outbox validates `BatchClosed` at the trust boundary, a `Date` instance fails ISO-string validation. The mismatch predates Phase 2 (the lane correctly did not touch event-contracts), but Phase 2 is the first to populate real non-zero `finalFCR`/`finalBiomassKg` flowing through that validator at scale — fix before it surfaces as a production outbox-validation failure. Fix: reconcile the contract type and the schema (serialize Date→ISO at enqueue, or type the field as ISO string end-to-end). Owner: data-expert (event-contracts). Status: RESOLVED (2026-06-27 — all 9 event-contract files converged: Date→ISO string via the single toEventIso SSoT; slices farm #666 + small (sensor/alert/ai/notification/task/tenant) + hr/billing. Ratchet flipped to hard-zero (no : Date on any event contract). Verified per slice: line-precise + tsc-guided (no silent multi-occurrence drift), zero new test regressions (pre-existing local-env failures unchanged), zero runtime change (wire was already ISO post-serialization)). Root-cause: event-contract date fields typed `: Date` but the wire (+ JSON schema + BaseEvent.timestamp) is ISO string. Architectural SSoT fix (NOT scattered .toISOString patches): single canonical toEventIso() normaliser in event-contracts (idempotent Date|string→ISO, fail-fast) — all 36 farm-service producers/listeners route through it (line-precise, tsc-guided, verified no silent multi-occurrence drift), farm-events.ts 38 fields → string, the defensive `instanceof Date` consumer checks (notification harvest-regulatory + growth) collapsed into the helper. Locked by event-contract-date-iso-ssot.spec.ts (toEventIso exists + : Date ratchet ≤43, farm pinned at 0). Remaining: hr 22 + billing 11 (ratchet now 33) land in follow-up slices; ratchet drops to 0 = hard ban) (2026-06-14). Registry: orphan-findings.md only.

## ORPHAN-MEDIUM-112 — Final-harvest → CloseBatch dispatch is best-effort with no outbox-backed retry (supersedes FARM-MEDIUM-002)

Surfaced by the FARM-MEDIUM-002 refutation (Phase 2). `FARM-MEDIUM-002` (registry, OPEN) claimed `BatchHarvested.isFinal` had NO closure consumer; firsthand verification REFUTES it — `create-harvest-record.handler.ts` sets `HARVESTED` on a final harvest (currentQuantity≤0) and dispatches `CloseBatchCommand`→CLOSED, freezing final metrics. The real residual is narrower: that `CloseBatchCommand` dispatch is **best-effort post-commit** (create-harvest-record.handler.ts ~417-461) with NO outbox-backed durable retry — a transient CloseBatch failure leaves the batch in HARVESTED (isFinal=true emitted, so monitorable) with no frozen final metrics and no automatic retry; recovery is a manual closeBatch. FARM-MEDIUM-002 as written is SUPERSEDED by the verified closure chain; this durability gap is the true (Tier-2) finding. Fix: route the final-harvest closure through the transactional outbox (or a saga) so it retries durably. Owner: farm-expert. Status: OPEN (2026-06-14). Registry: orphan-findings.md only; FARM-MEDIUM-002 to be superseded in the registry ceremony.

## ORPHAN-MEDIUM-113 — record-mortality.handler.spec.ts fully red (8/8): direct-handler construction omits MobileCommandReceiptService

Surfaced while running the farm-service test target to validate the feed-dual Phase-A remediation (2026-06-15). `apps/farm-service/src/batch/__tests__/handlers/record-mortality.handler.spec.ts` fails 8/8 in isolation, INDEPENDENT of the feed-dual change (the spec, `record-mortality.handler.ts`, and `MobileCommandReceiptService` are all pre-existing on HEAD). Root cause: `RecordMortalityHandler`'s constructor defaults `mobileCommandReceipts` to `defaultMobileCommandReceiptsForDirectHandlerConstruction()`, whose `.begin()` hard-throws `"MobileCommandReceiptService.begin direct-handler default is test-only; production handlers must receive an explicit DI dependency"`. The spec constructs the handler directly without a `MobileCommandReceiptService` double, so every test throws a generic `Error` instead of the asserted `NotFoundException` / `BadRequestException` / commit-rollback. The same direct-construction default exists in `allocate-to-tank`, `record-cull`, `transfer-batch`, and `create-harvest-record` handlers — check their specs too. Fix: pass an explicit `MobileCommandReceiptService` mock into the handler under test (London-school). Owner: farm-expert. Status: OPEN (2026-06-15). Registry: orphan-findings.md only.

## ORPHAN-HIGH-114 — feed-dual-ssot Phase B: single-ledger convergence (table merge + destructive feed_inventory DROP)

Operator-sanctioned deferral (operator chose "safe Phase-A now, full convergence separate" on 2026-06-14). Phase A (FARM-HIGH-058) eliminated the SILENT swallowed-divergence by making the storage OUT deduction transactional + fail-closed-for-storage-feeds / observably-skipped-for-non-storage-feeds, but **two feed-stock ledgers still co-exist**: `feed_inventory.quantityKg` (read by GetFeedInventory) and `StorageInventory.quantity`/`Feed.quantity` (read by feed-consumption-forecast), maintained by different operator workflows. Phase B must collapse to ONE ledger: re-point the read paths + add/consume/adjust-feed-inventory handlers onto the storage ledger, demote `feed_inventory` to a projection or DROP it. A first full-convergence attempt was BLOCKED by consensus for **data-loss** in the destructive migration and is parked in `git stash` (`phase2-feed-dual-BLOCKED-data-loss`) — its migration is NOT safe; the 5 confirmed defects to fix before any DROP: (1) carry `manufacturingDate` + `storageTemperature` into the storage ledger before dropping feed_inventory; (2) make the backfill parity gate BIDIRECTIONAL (equality-within-tolerance); (3) NULL-lot `ON CONFLICT` cannot match without `NULLS NOT DISTINCT` — COALESCE or recreate the unique index; (4) re-key the merge on backfill provenance so re-runs don't double-add; (5) preserve per-site `minStockKg` reorder thresholds (MAX() collapses distinct values). Plus out-of-lane: farm-seed `seedFeedInventory` raw INSERT + 2 e2e postgres specs break once feed_inventory becomes a view/dropped. The DROP is a one-way door requiring operator deploy-time ratification + a verified restorable pg_dump per tenant. Owner: data-expert + database-reviewer + farm-expert. Status: OPEN (2026-06-14; operator-sanctioned, dedicated Phase-B PR). Registry: orphan-findings.md only.

## ORPHAN-MEDIUM-115 — daily-feeding feedability guard is primary-batch-only on mixed-batch tanks

Surfaced by FARM-HIGH-059 (Phase 2 feed-empty, farm-expert audit). `DailyFeedingExecutionService.recordActualFeeding` resolves the feedability guard via `tankBatch.primaryBatchId` and calls `assertFeedable` on that single primary batch. For an `isMixedBatch` tank, a feedable primary lets feed be recorded even if a secondary in `batchDetails[]` is HARVESTED/empty; and if the primary was harvested out leaving only secondaries (`primaryBatchId` null), the `assertFeedable` block is skipped entirely. Strictly an IMPROVEMENT over the prior state (no batch feedability check at all on the daily path), so it did not block Phase A — but the feed-empty guarantee is weaker on mixed tanks than on `CreateFeedingRecordHandler`. A proper fix iterates `batchDetails[]`. Owner: farm-expert. Status: OPEN (2026-06-15). Registry: orphan-findings.md only.

## ORPHAN-MEDIUM-108 — V3.1-F mock-mode smoke stalls after cycle 1 completion

**Severity**: MEDIUM (smoke-mode-only; real-mode V10.3-A 5-cycle smoke completed cleanly per task #113)
**Discovered**: 2026-05-19 during V10.3-B prereq follow-up smoke verification (after V3.1-F2 adapter fix at commit `76455a8a` unblocked adapter init).
**Status**: OPEN (separate from V3.1-F2 fix scope)

**Symptom**: Under `ARIA_DRY_RUN=true CLAUDE_CODE_MOCK=true unshare --net -- python3 -m aria_kernel autonomy run --max-cycles 5 --profile strict` the orchestrator completes cycle 1 (`cycle_started → next_cycle_queued → cycle_completed`) then idles for 25+ minutes without starting cycle 2. `planner_dispatch_iteration_started`/`_completed` events continue ~once/second (mock-mode planner spinning) but `autonomy_state.jsonl` records exactly 1 unique `cycle_id`. The cycle deadline (1800s per cycle × 5 = 9000s max) never elapses because individual cycles complete fast — the orchestrator just doesn't auto-advance.

**Evidence at termination (sandbox `/tmp/aria-smoke-20260519-185437`)**:
- `autonomy_state.jsonl`: 3 entries, all for `cyc-20260519T185510Z-auto` (started/queued/completed).
- `governance.jsonl`: 179 events, 18 kinds. 1 × `autonomy_orchestrator_started` for the new run + 1 × `autonomy_orchestrator_exit` from the PRIOR May-18 run (no new exit fired).
- `next_cycle_queued` event implies cycle 2 should be next, but no new `cycle_started` follows.
- 57 × `planner_dispatch_iteration_started` paired with 57 × `_completed` over the stall — planner daemon healthy, just no work.
- 1 × `planner_dispatch_executor_exit_1` (a planner executor exited code 1 — possibly correlated; no traceback visible).

**Hypothesis**: the orchestrator's cycle-2 trigger depends on either (a) a pressure-source signal that mock-mode never produces, or (b) a planner_dispatch follow-up event that exit_1 short-circuits. The runbook documents `cycle_runner_no_pressure` as the expected dry-run idle signal, but THAT event never fires either — the cycle progression event taxonomy may have drifted since V3.1-F was originally written.

**Why filed as ORPHAN and NOT a V3.1-F2 follow-up commit**:
- Cycle 1 completing end-to-end is sufficient verification that the V3.1-F2 adapter fix works architecturally (was the gate before).
- V10.3-A task #113 already validated 5-cycle smoke under real LLM (strict profile); the regression appears mock-mode-specific.
- V10.3-B endurance runs REAL Claude + REAL gh API; it bypasses the mock-mode stall path entirely.
- Tracing the stall requires reading the entire cycle-progression state machine (CyclePipeline + 5 phase modules per V3.1-0) — multi-hour investigation outside the V10.3-B prereq scope.

**Suggested investigation when prioritized**:
1. Add `cycle_runner_iteration_started` + `_completed` envelope events at the top of `aria_kernel/cycle_pipeline.py` so the next attempt at this smoke shows WHICH phase is stuck.
2. Read `planner_dispatch_executor_exit_1` event payload (currently invisible — likely a process state issue under `CLAUDE_CODE_MOCK=true`).
3. Compare the cycle-progression event taxonomy in `aria_kernel/autonomy_orchestrator.py:run_autonomy_orchestrator()` against the F-5 acceptance script's expected events (`plan_candidate_source_selected`, `cycle_runner_no_pressure`) — those names may have been renamed during V3.1-0 extraction.

**Workaround for V10.3-B unblocking**: V10.3-B endurance runs autonomous profile with real Claude API (no mock-mode), so this orphan does NOT block endurance launch. The fix is needed eventually to make V3.1-F a useful pre-flight smoke, but post-V10.3-B is acceptable.

Status: OPEN. Ported to main 2026-06-14 from `v31-f2-adapter-dry-run-gate@9f291ba4` (renumbered MEDIUM-083 → 104 per origin/main registry max, ARIA→main controlled merge Tranche 1). Registry: orphan-findings.md only.

## ORPHAN-MEDIUM-109 — platform/configs typed config-schema SSoT is empty; services read process.env ad-hoc

Severity: MEDIUM. Discovered 2026-06-13 during the AquaMobil e2e audit, frontend-expert. Out of scope for the AquaMobil remediation initiative — recorded here per the locked plan decision (config-SSoT is a separate initiative, but every found finding is registered).

**Problem:** `platform/configs/` — intended as the typed configuration SSoT — is effectively empty. Backend services and the gateway read configuration directly from `process.env` ad-hoc (untyped `configService.get<string>(...)` / raw `process.env.X` accesses scattered across bootstrap, NATS, DB, and feature-flag paths), with no central schema, no fail-fast validation at boot, and no single place documenting which variables exist, their types, defaults, and required-ness. A missing or malformed env var surfaces as a late runtime failure (or a silent wrong-default) rather than a boot-time rejection, and there is no compile-time contract binding a consumer to a declared key.

**Effect:** config drift is undetectable until runtime; a typo'd or absent env var can degrade a service silently; there is no typed surface a reviewer can read to know the full configuration contract of a service. This is the configuration analogue of the enum / WS-payload drift this initiative fixes elsewhere — the same SSoT gap on a different axis.

**Fix direction (architectural, separate initiative):** populate `platform/configs/` with a typed, validated config-schema module (a Zod/joi schema per service, or a shared schema with per-service slices) loaded once at bootstrap with fail-fast validation (reject boot on a missing/malformed required key), and replace ad-hoc `process.env` / untyped `configService.get` reads with typed accessors derived from that schema. A CI invariant then asserts no service reads `process.env` outside the config layer. Tier-1 "make-it-impossible": a consumer cannot reference an undeclared key because the typed schema is the only access path.

Status: RESOLVED (2026-06-26 — duplicate of ORPHAN-MEDIUM-106 — resolved together (per-concern factory SSoT + config-env-access-ratchet invariant). See 106) (2026-06-13; owner: frontend-expert → platform; separate initiative). Registered: docs/reviews/_registry/findings.jsonl#ORPHAN-MEDIUM-104.

---

## ORPHAN-MEDIUM-110 — lint-gates husky pre-commit gate is broken under ESLint 9 (eslintrc-format parserOptions fed to a flat-config Linter)

Severity: MEDIUM. Discovered 2026-06-13 while landing the aquamobil-msg-federation merge — the husky pre-commit hook blocked the merge commit (13/19 gate cases threw). RESOLVED in the same merge.

**Problem:** `tools/lint-gates/lint-gates.spec.ts` — the ESLint gate-preservation test wired into `.husky/pre-commit` via the `tools/*gates/*.spec.ts` glob — calls `linter.verify(code, { parserOptions: { ecmaVersion: 2022, sourceType: 'module' }, rules })` against a `new Linter()` instance. The repo migrated to ESLint 9 + flat config (`eslint.config.mjs`; `.eslintrc.json` / `.eslintrc.cjs` deleted), and ESLint 9's `Linter` defaults to flat-config mode, which rejects a top-level `parserOptions` key: "Key 'parserOptions': This appears to be in eslintrc format rather than flat config format." All 13 gate-firing cases threw, so the hook exited 1 and blocked every commit. The test file is byte-identical to `origin/main` (`git diff origin/main` empty) under the repo's pinned `eslint@^9.39.4`, so this is a pre-existing main breakage, not a merge artifact.

**Effect:** the pre-commit gate suite is unrunnable on ESLint 9. Either commits are hard-blocked, or developers bypass with `--no-verify` — which silently disables ALL the other pre-commit gates too (banned-phrase, banned-construct, migration-sql-lint, tier-claim-lint, and the rest of the gate-preservation suite guarding the getRepository() / JWT_SECRET / JSON.stringify bans). The safety net that proves the ESLint config still fires the custom AST-selector rules was dead under the repo's own pinned ESLint.

**Fix (applied, tier-1, flat-config-consistent):** change the gate harness to speak flat config — `languageOptions: { ecmaVersion: 2022, sourceType: 'module' }` instead of the eslintrc-shape top-level `parserOptions`. This aligns the harness with the repo's flat-config SSoT rather than re-enabling an eslintrc compat mode. Verified: 19/19 spec cases pass under ESLint 9.39.4.

Status: RESOLVED (2026-06-13; fixed in the aquamobil-msg-federation merge commit). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-111 — hr-module GraphQL fragments drift from the live schema (codegen-blocking)

Severity: MEDIUM. Discovered 2026-06-14 while standing up the AquaMobil graphql-codegen client-contract SSoT (S1-CODEGEN). Out of the S1 scope (S1 is the AquaMobil client contract + messaging enum-casing) — recorded here per the every-found-finding-is-registered rule.

**Problem:** the shell/module GraphQL documents contain operations/fragments that reference fields the composed supergraph no longer exposes. Running `graphql-codegen` against the real supergraph surfaces (at minimum) in `web/modules/hr-module/src/graphql/`:
- `fragments.ts` — `Payroll.earnings` and `Payroll.deductions` do not exist (schema has `deductionsTax`/`deductionsOther`/`deductionsTotal`); `PerformanceGoal.keyResults` and `.milestones` are selected without subfields (they are object lists `[KeyResult!]` / `[GoalMilestone!]`).
- `performance.operations.ts` — operations that spread those broken fragments inherit the same validation errors.

These documents fail GraphQL document validation, so codegen aborts the ENTIRE run (graphql-codegen has no per-output error isolation). At S1 time the only working codegen output was `web/shared-ui/src/generated/graphql-types.ts` (the `typescript` plugin, which needs no documents); the never-emitted `graphql-operations.ts` operations block (added in an earlier commit) was dead because of exactly this drift.

**Effect:** the hr-module client compiles against fields that return nothing at runtime (silent `undefined` mid-response), and the shell/module operations cannot be brought under a codegen TypedDocumentNode contract until the fragments are realigned. S1 removed the dead `shared-ui/graphql-operations.ts` codegen block (no consumers, never emitted) so the AquaMobil codegen run is no longer blocked by this unrelated drift.

**Fix direction (architectural):** realign the hr-module fragments to the live supergraph (`Payroll.deductionsTax|deductionsOther|deductionsTotal`; add explicit subfield selections to `keyResults`/`milestones`), then re-add a `web/shell+modules` operations codegen output (with its own disjoint `documents` set, mirroring the aquamobil block) and bring the shell/module hooks onto the generated TypedDocumentNode constants. Extend the S1 codegen CI gate to cover that output once green.

Status: OPEN (2026-06-14; owner: frontend-expert → hr-module; tracked follow-up). Registry: orphan-findings.md only.

---

## ORPHAN-LOW-107 — AquaMobil leave-balance rows show a generic "Leave" label (no per-type enrichment)

Severity: LOW. Discovered 2026-06-14 during S1-CODEGEN, fixing a client-contract drift the codegen gate caught.

**Problem:** `GET_MY_LEAVE_BALANCES` previously selected a nested `leaveType { id name code category isPaid color }` block, but the HR `LeaveBalance` GraphQL type has NO `leaveType` field (only `leaveTypeId`). The selection returned nothing at runtime, so `balance.leaveType` was always `undefined`; `MyLeavesPage` falls back to a generic `'Leave'` label and a default color. S1 removed the invalid selection (the codegen gate rejects a field the schema does not expose), which keeps the existing fallback behaviour but does not restore the per-type label/color.

**Effect:** purely cosmetic — the leave-balance cards do not show the leave-type name/color. Functionally unchanged from before (the field never resolved). No data-integrity impact.

**Fix direction:** enrich balances client-side by joining `balance.leaveTypeId` against the separately-fetched `leaveTypes` list (already loaded by `useLeaveTypes`) in the `useMyLeaveBalances` selector, or add a `leaveType` field resolver to `LeaveBalance` on the HR subgraph if the backend should own the join. The former is the smaller, client-only change.

Status: OPEN (2026-06-14; owner: frontend-expert; tracked follow-up). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-112 — AquaMobil `eslint src` lint script has a large pre-existing red baseline (~940 errors)

Severity: MEDIUM. Discovered 2026-06-14 during S1-CODEGEN, validating that the codegen migration adds no new lint debt.

**Problem:** the AquaMobil `lint` target (`nx run @aquaculture/aquamobil:lint` → `eslint src`) reports ~940 errors + ~286 warnings on a clean checkout, in files untouched by S1 (e.g. `src/App.tsx` 10 errors, `src/components/ErrorBoundary.tsx`, the storage/water-quality pages, `useWebAuthn.ts`). The dominant rules are `import/order` (import blocks mix external/internal without group separation), `@typescript-eslint/explicit-function-return-type`, `no-floating-promises`, `no-misused-promises`, `@typescript-eslint/no-explicit-any` / `no-unsafe-*` (notably the WebAuthn browser-API code), `no-console`, and `react/no-unescaped-entities` / jsx-a11y. The target is `cache: true` and feeds `nx affected --target=lint`, so the red baseline is effectively unenforced for this app — it can only ever be "already red", never gating.

**Effect:** the AquaMobil lint gate provides no signal — a PR cannot make it RED (it is already red) and cannot be required to make it GREEN. Real new violations hide in the noise; the `no-explicit-any`/`no-unsafe-*` cluster in particular masks genuine type-safety gaps (e.g. the WebAuthn credential handling operates on `any`).

**Why not fixed inline (S1):** out of S1 scope (S1 is the GraphQL client contract + messaging enum-casing). S1 verified it adds NO net-new lint errors of consequence: the only violations it introduced were `import/order` from inserting `import { gql }` lines, which were `eslint --fix`ed; every other reported error in S1-touched files pre-dates S1 (confirmed by rule-category diff and by linting untouched `App.tsx`). Fixing ~940 cross-cutting violations is a separate dedicated cleanup, not a safe rider on a contract migration.

**Fix direction:** run `eslint --fix src` for the mechanical rules (`import/order`, quote/escaping), then triage the semantic clusters per-area: add explicit return types, `await`/`void` the floating promises, replace the WebAuthn `any` accesses with typed wrappers over the Credential Management API, and route `console.*` through the app logger. Land in reviewable slices, then flip the target to `--max-warnings 0` so it gates going forward.

Status: OPEN (2026-06-14; owner: frontend-expert; tracked follow-up). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-109 — `leave.integration.spec.ts` is stale RED (handlers refactored to transactional outbox; spec never updated)

Severity: MEDIUM. Discovered 2026-06-15 during AquaMobil Phase 5 (SEC-MEDIUM-051) cross-review, running `nx test hr-service` on the leave domain.

**Problem:** `apps/hr-service/src/leave/__tests__/leave.integration.spec.ts` is RED on a clean checkout (27/27 tests fail at the `Test.createTestingModule(...).compile()` call, line ~125) — independent of the Phase 5 branch (the file is untouched by it; confirmed by `git stash` + run on HEAD). The spec's module registers only `getRepositoryToken(LeaveRequest)`, `getRepositoryToken(LeaveBalance)` and `EventBus`, but the four handlers under test were refactored (CRITICAL-002 transactional-outbox work) to inject `OutboxPublisher` and `DataSource` and to read/write through `queryRunner.manager.findOne/save` inside a transaction. DI resolution fails for the missing `OutboxPublisher`/`DataSource` providers, and even past that the test bodies assert against `leaveRequestRepository.findOne` mocks that the handlers no longer call (they go through `queryRunner.manager`).

**Effect:** the entire leave-lifecycle integration suite provides no signal — `nx affected --target=test` for hr-service is red on a path unrelated to any current change, masking real regressions in submit/approve/reject/cancel. Phase 5's SEC-MEDIUM-051 invariants are independently covered by the new `leave-ownership.spec.ts` (submit + cancel ownership reject + reflectable @Roles metadata, wired with the correct transactional providers), so the ownership guarantees ARE tested — but the broader lifecycle suite is not.

**Why not fixed inline (Phase 5):** out of Phase 5 scope (authorization, not a test-infra rewrite), and a correct fix is a substantial rewrite of all 27 cases against the transactional `queryRunner.manager` surface (each `leaveRequestRepository.findOne` expectation must move to a mocked manager chain — the `createMockDataSource()` factory from `@platform/testing` is the right tool). Rewriting 27 stale mocks blind on a security branch risks masking a real handler bug behind a green-but-wrong test; it belongs in a dedicated hr-service test-infra slice.

**Fix direction:** rebuild the spec's module with `createMockDataSource()` (provides the `DataSource → QueryRunner → EntityManager` chain) + an `OutboxPublisher` double + the `EventBus` double, register the missing providers, and re-point every `findOne/save` expectation onto `mockManager` instead of the injected repositories. Then assert the outbox `enqueue(event, manager)` atomicity the handlers now guarantee.

Status: OPEN (2026-06-15; owner: hr-service maintainer; tracked follow-up). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-118 — farm tenant-routing architecture spec allowlists only `farm-outbox`, but its regex also matches two other legitimately cross-tenant farm tables

Severity: MEDIUM. Discovered 2026-06-16 during the CLAUDE.md steering-file back-test (multi-tenant-saas-expert lead; lead-verified firsthand).

**Problem:** `apps/farm-service/src/__tests__/e2e/tenant-schema-routing.architecture.spec.ts` allowlists only `outbox/farm-outbox.entity.ts` (lines 14-18) as permitted to declare `@Entity(... schema: 'farm' ...)`, but its discovery regex (`/@Entity\([^)]*schema:\s*'farm'/`, ~line 49) ALSO matches the comma-form decorator on two legitimately cross-tenant farm tables that DO declare `schema: 'farm'`:
- `farm_audit_logs` — `apps/farm-service/src/database/entities/audit-log.entity.ts:45` → `@Entity('farm_audit_logs', { schema: 'farm' })`
- `tenant_erasure_audit` — `apps/farm-service/src/compliance/entities/tenant-erasure-audit.entity.ts:61` → `@Entity('tenant_erasure_audit', { schema: 'farm' })`

Both are correct cross-tenant tables (present in `MODULE_SCHEMAS` farm `infrastructureTables`, `libs/backend-common/src/database/schema-manager.service.ts`). Either the spec is currently red on them or its discovery is not reaching the comma-form — either way the spec's allowlist does NOT actually guard the cross-tenant carve-out it claims to.

**Effect:** the cross-tenant direction of farm's `@Entity()` discipline is under-enforced. The inverse direction (cross-tenant tables MUST carry `schema:`) is covered by `schema-invariants.spec.ts` B.1/B.2, so there is no live data-placement bug today — but the farm architecture spec gives a false sense of bidirectional coverage. The CLAUDE.md back-test deliberately does NOT claim the farm spec guards the cross-tenant carve-out (it cites `schema-invariants.spec.ts` for that direction).

**Fix direction:** extend the farm spec allowlist to include `farm_audit_logs` + `tenant_erasure_audit` (or, better, drive the allowlist from `MODULE_SCHEMAS` farm `infrastructureTables` so the two never drift), and add an explicit assertion that every farm `infrastructureTables` entry's entity DOES declare `schema: 'farm'`.

Status: OPEN (2026-06-16; owner: farm-expert; tracked follow-up). Registry: orphan-findings.md only.

---

## ORPHAN-LOW-119 — AquaMobil tenant-query-keys.ts comment calls a Vite PWA a "React Native bundle"

Severity: LOW. Discovered 2026-06-16 during the CLAUDE.md steering-file back-test (frontend-expert lead; lead-verified firsthand).

**Problem:** `web/apps/aquamobil/src/utils/tenant-query-keys.ts:4` documents the file as belonging to "a standalone **React Native** bundle". AquaMobil is a standalone **Vite PWA** (Konsta UI + `vite-plugin-pwa` injectManifest service worker; `web/apps/aquamobil/vite.config.ts` has no React Native / Metro toolchain). The stale label could mislead an agent into reaching for React-Native idioms when editing this app.

**Effect:** documentation-only; no runtime impact. The duplication rationale the comment carries (aquamobil does not import `@aquaculture/shared-ui`, so `createTenantQueryKey` is duplicated verbatim and must be kept in sync) is correct and load-bearing — only the "React Native" descriptor is wrong.

**Fix direction:** change "standalone React Native bundle" → "standalone Vite PWA (independent toolchain + device bundle size)". The keep-in-sync invariant with the shared-ui copy is also captured in `web/apps/aquamobil/CLAUDE.md` (authored in this cycle).

Status: OPEN (2026-06-16; owner: frontend-expert; tracked follow-up). Registry: orphan-findings.md only.

---

## ORPHAN-LOW-120 — `.claude/settings.json` deny `Read(./.env.*)` does not match a bare `*.env` filename

Severity: LOW. Discovered 2026-06-16 during the CLAUDE.md steering-file back-test (security-reviewer lead; lead-verified firsthand).

**Problem:** the project-scope permission deny rules block `Read(./.env)` and `Read(./.env.*)`. A file named with the bare `*.env` suffix (e.g. `prod.env`, `secrets.env`) does NOT match `./.env.*` (which requires the `.env.` prefix). So such a file is readable by the agent despite being a secret-bearing env file.

**Effect:** low — `.gitignore:72 *.env` still prevents COMMITTING such a file, so it cannot leak into the repo; the gap is only that an agent could `Read` a local `prod.env`. Defense-in-depth, not an active leak. The CLAUDE.md rewrite does not touch `.claude/settings.json`, so this gap is neither widened nor closed by this cycle.

**Fix direction:** add a `Read(./*.env)` deny entry (and consider `Read(**/*.env)`) to `.claude/settings.json` so the deny set matches the `.gitignore` `*.env` pattern.

Status: OPEN (2026-06-16; owner: security-reviewer; tracked follow-up). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-121 — `.claude/agents-enterprise-v2/` dead-dir removal is blocked on the stale generated `format-scope.json` (ORPHAN-MEDIUM-117)

Severity: MEDIUM. Discovered 2026-06-16 during the CLAUDE.md steering-file cleanup (Phase E). Lead-verified firsthand.

**Problem:** `.claude/agents-enterprise-v2/` is dead (3 markdown files: `README.md`, `orchestrator.md`, `prompt-writer.md`; superseded by the 2026-04-18 flatten, not loaded by any agent runner). Two `package.json` scripts (`audit:gdpr`, `audit:perf`, lines 102-103) invoke `.claude/agents-enterprise-v2/runners/{gdpr,perf}-audit.ts` — runner files that **do not exist** (the `runners/` subdir was never present), so the scripts are already broken. `.github/CODEOWNERS:13` still protects the dir. These three (dir + scripts + CODEOWNERS line) are cleanly removable.

**Why deferred (the blocker):** `tools/quality/format-scope.json` — a **generated** manifest — lists the 3 dir files. Removing the dir without updating that manifest leaves it referencing deleted files; updating it correctly means regenerating it (`node tools/quality/quality.mjs format-scope generate`). But that manifest is **already stale and red on main** — a dry regenerate rewrites ~2000 lines (tracked as **ORPHAN-MEDIUM-117**). Hand-editing the 3 entries out of a generated file is a forbidden patch; regenerating it here would pull ~2000 lines of unrelated drift into a steering-file PR. So clean removal is atomic with ORPHAN-117's regeneration.

**Not broken meanwhile:** the dir is currently in a CONSISTENT "managed dead" state — every other reference is a guard (`tests/invariants/_constants.ts` DEAD_TERMINOLOGY_TOKENS + DEAD_EVIDENCE_PATH_PREFIXES; `active-path-hygiene.spec.ts`; `orchestrator-routing-coverage.spec.ts`; `finding-registry-integrity.spec.ts`), a historical citation (`.claude/README.md:60`, docs/plans, docs/reviews), or the append-only registry + `path-corrections.yaml` mapping. None of these break; no jest invariant reads `format-scope.json`.

**Fix direction (atomic, after/with ORPHAN-117):** in one change — delete `.claude/agents-enterprise-v2/`, remove `package.json` `audit:gdpr`/`audit:perf`, remove `.github/CODEOWNERS:13`, and regenerate `tools/quality/format-scope.json` so it drops the 3 entries as part of the full manifest refresh. Keep the guard specs, `_constants.ts` tokens, and `path-corrections.yaml` mapping (historical evidence must still resolve).

Status: OPEN (2026-06-16; owner: infra-expert / context-manager; BLOCKED-BY ORPHAN-MEDIUM-117). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-122 — #490 CLAUDE.md rewrite broke ARIA invariant I-V4-08 (canonical "Phrases BANNED" section) — RESOLVED this commit

Severity: MEDIUM. Discovered 2026-06-16 (operator-reported) after PR #490 merged (`aa7b39241`). Self-inflicted regression; lead-verified firsthand.

**Problem:** PR #490 compressed CLAUDE.md's "Phrases BANNED as gating excuses:" block from a standalone heading + bulleted list into an inline paragraph, AND dropped the phrase "prior solution". This broke `aria-kernel/tests/invariants/v4/test_phase_v4_b_narrative_shape.py::PhaseV4BNarrativeShape::test_i_v4_08_banned_phrase_canonical_drift` ("CLAUDE.md missing 'Phrases BANNED' canonical section"). I-V4-08 regex-extracts the bulleted quoted phrases and asserts set-equality with `tools/gates/banned-phrase.ts`'s canonical 13-phrase docstring. It is an ARIA-kernel **pytest** invariant, NOT one of the Node/cargo PR jobs — so #490's CI was green.

**Verification gap (root cause of the miss):** my #490 validation ran the **jest** invariant suite (1176 green) but never the **aria-kernel pytest** suite. Sweep confirms I-V4-08 was the ONLY #490 regression — the full aria-kernel invariant suite is otherwise green.

**Fix (this commit):** restored the standalone heading + bulleted list carrying the exact 13 canonical phrases (+ allowlisted "follow-up commit will handle it"); reclaimed 3 lines from the Commands block to keep CLAUDE.md ≤200 (the `claude-md-accuracy` guard). Verified GREEN: I-V4-08 + full aria-kernel invariant suite (705 passed) + `claude-md-accuracy` + `invariants:fast` (1176 passed). Process follow-up (tracked): extend `claude-md-accuracy.spec.ts` to assert the I-V4-08 contract (heading-on-own-line + bulleted phrase set == `banned-phrase.ts`) so a CLAUDE.md edit can't silently break the ARIA parser from the Node side again.

Status: RESOLVED (2026-06-16; owner: lead; closed by this commit). Registry: orphan-findings.md only.

---
## ORPHAN-MEDIUM-123 — Tailwind v4 default palette shifts sRGB-hex → oklch (C3 migration accepts it; only custom tokens pinned)

Severity: MEDIUM. Discovered 2026-06-16 by the C3 post-migration adversarial audit (frontend-expert lens).

**Problem:** the C3 Tailwind-4 migration pins every *custom* design-system token (primary/secondary/accent/neutral/status palettes, fonts, type scale, radius, shadows, animations) to its exact v3 value, plus the WCAG-AA `--color-gray-400: #6b7280` override. But the *default* Tailwind palette — `gray-50…900`, `red/green/blue/yellow/orange-*` used pervasively in `@apply bg-green-100 text-green-800` status badges and inline classes — is NOT pinned, so v4 emits it in **oklch** (e.g. `--color-gray-200: oklch(92.8% .006 264.531)`, `--color-red-100: oklch(93.6% .032 17.717)`) where v3 emitted sRGB hex. The two are perceptually close but not pixel-identical, and oklch can render more saturated on wide-gamut (P3) displays.

**Effect:** subtle, repo-wide color drift on default-palette shades. Invisible to `vite build` (the CSS compiles either way). This is the single largest appearance-fidelity gap in the migration and is exactly what the still-pending **plan-S7 Playwright screenshot diff** must adjudicate.

**Why accepted (not pinned):** pinning the entire default palette to v3 hex would (a) defeat v4's deliberate oklch color-space improvement, (b) require maintaining ~80 hardcoded shade overrides in `theme.css` forever, and (c) re-introduce the maintenance burden CSS-first config was meant to remove. The architecturally correct posture is to accept oklch as v4's default and gate the residual delta with the visual-regression screenshot diff — NOT to merge C3 on build-green alone.

**Fix direction:** run the plan-S7 Playwright screenshot gate against C3; if any flow exceeds the visual-diff threshold on a default-palette color, pin ONLY those specific shades in `theme.css @theme`. Otherwise document the oklch shift as accepted and close.

Status: OPEN (2026-06-16; owner: frontend-expert; gated on plan-S7 visual diff before C3 #491 merge). Registry: orphan-findings.md only.

---

## ORPHAN-LOW-124 — hydroponics-module is unstyled standalone + carries unused Tailwind devDeps

Severity: LOW. Discovered 2026-06-16 by the C3 post-migration audit (frontend-expert + supply-chain lenses).

**Problem:** `web/modules/hydroponics-module` renders ~89 Tailwind classNames across its source but has no CSS entry, no `postcss.config.js`, and its `main.tsx` imports no stylesheet — so `npm run dev` / `vite preview` standalone (port 3008) is completely unstyled. It renders correctly only as a federation remote (the shell's `@source '../../../modules'` generates its classes and the shell ships the CSS). The C3 dep-bump added `tailwindcss@4.3.1` + `@tailwindcss/postcss` to its devDeps, which nothing consumes — implying a standalone build path that does not exist.

**Effect:** standalone dev/preview of hydroponics shows unstyled markup (pre-existing — the v3 setup had no config/CSS either). The unused devDeps are dead weight, not a runtime fault.

**Why not fixed in C3:** C3's scope is the federation styling pipeline (shell + remotes-via-shell). Whether hydroponics standalone dev is a supported workflow is a product decision, not a migration step.

**Fix direction:** if standalone hydroponics dev is supported, add a CSS entry mirroring the other remotes (`@import 'tailwindcss'` + shared-ui theme import + `@source` + border compat layer) + a `postcss.config.js` and import it in `main.tsx`. If hydroponics is only ever a shell remote, drop `tailwindcss` + `@tailwindcss/postcss` from its devDependencies.

Status: OPEN (2026-06-16; owner: frontend-expert; tracked follow-up). Registry: orphan-findings.md only.

---

## ORPHAN-LOW-125 — libs/ render Tailwind classes but are in no content/@source glob (works only by class-overlap coincidence)

Severity: LOW. Discovered 2026-06-16 by the C3 post-migration audit (frontend-expert lens).

**Problem:** `libs/farm-shared/src/components/DynamicMeasurementForm.tsx` and `libs/node-components/**` render Tailwind utility classes, but `libs/` was never listed in any v3 `tailwind.config.js` `content` glob and is not in the C3 v4 `@source` set either (the migration faithfully reproduced the v3 globs: shell + modules + shared-ui). Their classes generate only because they coincidentally overlap classes already emitted from scanned source (`bg-gray-*`, `text-gray-*`, etc.).

**Effect:** none today (the overlapping common classes are always present). The latent risk: a lib that introduces a class used *nowhere else* (e.g. an unusual `bg-fuchsia-300`) would silently fail to render. Pre-existing — identical behavior under v3.

**Why not fixed in C3:** C3 is an appearance-preserving migration; adding `libs/` to `@source` would change which classes are emitted vs v3 (scope creep + bundle-size delta), so it is deliberately out of the faithful-migration scope.

**Fix direction:** add `@source` lines for `libs/farm-shared/src` + `libs/node-components` to the consuming remotes' CSS entries (sensor-module + farm-module) and the shell, OR move the shared components into `shared-ui` (already scanned). Pairs naturally with a future shared-component consolidation.

Status: OPEN (2026-06-16; owner: frontend-expert; tracked follow-up). Registry: orphan-findings.md only.

---

## ORPHAN-LOW-126 — agent-prompt path-existence guard deferred; candidate dead code-paths await an output-aware design

Severity: LOW. Discovered 2026-06-17 while building `tests/invariants/agent-prompt-accuracy.spec.ts` (PR-N, the agent-prompt-audit finale).

**Problem:** a naive "every cited repo path in an agent body must pre-exist" guard is unsound for the `.claude/agents/**` corpus. ~40 agents legitimately cite paths that do NOT pre-exist: review/recommendation OUTPUT dirs the agent creates (`docs/reviews/<agent>/`, `docs/recommendations/<agent>/`), the docs the edge-docs writers PRODUCE (`docs/api/*.md`, `docs/architecture/*.md`, `docs/siemens-rfp/*.md`, …), runtime artifacts (`tools/audit/*.jsonl`, `tools/findings.jsonl`, `tools/fixtures/`), illustrative ARIA example paths (`apps/farm-service/src/formatter.ts` — hypothetical-diff reasoning), and to-author specs. So PR-N ships only the no-brittle-counts check; path-existence is deferred.

**Effect:** none today. The path-existence drift class is currently UNGUARDED (the brittle-count guard is in place). Note ownership globs — the form most prone to the drift the 2026-06 audit found (`ai/safety/**`) — are GLOBS the guard skips anyway, so a file-level path-existence guard is lower-value than it first appears.

**Genuine code-path drifts found + disposition:** `billing-expert` decimal-transformer ref (`monetary/decimal.transformer.ts` → real `database/decimal-transformer.ts`) + `implementation-planner` `libs/outbox` (→ `platform/libs/outbox`) — **FIXED in PR-N**. UNVERIFIED candidates needing triage in the follow-on: `contract-parity-enforcer` `sens-api-gateway/src/protocols/modbus_tcp.rs`; `auth-security-expert` `docs/adr/016-deploy-resilience.md`; `edge-docs/architecture-writer` `docs/adr/ADR-032-supply-chain-hardening.md`; assorted `edge-docs/*` `sens-api-gateway/src/*.rs` source refs (e.g. `commands.rs`). (ARIA illustrative example paths are by-design, not drift.)

**Fix direction:** build the output-aware path-existence variant (skip `docs/reviews|recommendations/<agent>/`, edge-docs produced `docs/<subtree>/`, `tools/audit|fixtures/`, `*.jsonl`, and ARIA example paths; check only review-surface code anchors), then triage + fix the genuine code-file refs it surfaces across the ~6 untouched agents. Pairs with the AGENT-PROMPT-006 roster-wide defect-catalog wiring.

Status: OPEN (2026-06-17; owner: prompt-writer / agent-prompt audit; tracked follow-up). Registry: orphan-findings.md only. Relates to `docs/reviews/2026-06-16-agent-prompt-audit/ROLLUP.md` (AGENT-PROMPT-012).

---

## ORPHAN-MEDIUM-127 — libs/shared-contracts canonical tsconfig swept `__tests__` into the production type-check, fail-closing the deploy gate

Severity: MEDIUM. Discovered 2026-06-17 during the production deploy of main `f3069246b` (AquaMobil Phases 1-7 + React 19 + Tailwind 4 + SCADA + agent waves batch). The `deploy-digitalocean.yml` `release-verification` job failed; all downstream jobs (`prepare`, `build-*`, `capacity-preflight`, `deploy`, `verify-images`) skipped fail-closed, so **nothing reached production** (no rollback needed).

**Problem:** `libs/shared-contracts` had no `tsconfig.lib.json`, so its base `tsconfig.json` (`"include": ["src"]`, `"types": []`) was the canonical config the deploy gate's `tools/scripts/type-check-all.mjs` picks (candidate order `tsconfig.app.json` → `tsconfig.lib.json` → `tsconfig.json`). That config compiled `src/__tests__/messaging-media-mime.spec.ts` (added in Phase 7, #506) WITHOUT test-runner types, so every `describe`/`it`/`expect` failed `TS2593`/`TS2304`. Sibling libs (`libs/event-contracts`, `libs/storage`) already carve tests out via a `tsconfig.lib.json` with the canonical `exclude: [src/**/*.spec.ts, src/**/*.test.ts, src/**/__tests__/**]`; shared-contracts lacked that variant.

**Effect:** the production deploy of the entire current-main batch was blocked at the type-check gate until hotfixed. Pre-existing latent risk realized the moment shared-contracts gained its first in-`src` spec file.

**Resolution (this PR):** added `libs/shared-contracts/tsconfig.lib.json` (extends base, `include: ["src/**/*.ts"]`, excludes `*.spec.ts`/`*.test.ts`/`__tests__`), mirroring the event-contracts/storage SSoT pattern. The deploy gate now picks `tsconfig.lib.json` and type-checks production sources only; tests remain governed by the existing `tsconfig.spec.json` (jest types intact — jest suite stays 5/5 green). Verified firsthand: `tsc -p tsconfig.lib.json --noEmit` → exit 0; base config still reproduces the failure (exit 2), confirming root cause. Systemic gate divergence tracked separately as [[ORPHAN-MEDIUM-128]].

Status: RESOLVED (2026-06-17; fix branch `fix/shared-contracts-tsconfig-lib-typecheck-v2`). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-128 — deploy-time `type-check-all.mjs` and PR-CI resolve divergent tsconfigs, so production-config type errors are invisible until deploy

Severity: MEDIUM. Discovered 2026-06-17 (root-causing ORPHAN-MEDIUM-127).

**Problem:** the two type-check gates govern the same file under DIFFERENT tsconfigs, so they can disagree:
- **Deploy gate** (`release-verification` → `npm run type-check` → `tools/scripts/type-check-all.mjs`) type-checks each project's *canonical* config — `tsconfig.app.json`/`tsconfig.lib.json`/`tsconfig.json`, first match. For a lib whose base `tsconfig.json` does `include: ["src"]` and has NO lib/app variant, that canonical config sweeps `src/__tests__/*.spec.ts` *without* test types.
- **PR-CI** never sees this: (a) `nx affected -t type-check` SKIPS any project lacking a `type-check` Nx target (shared-contracts' `project.json` has only `test` + `lint` → the canonical config is never type-checked pre-merge), and (b) `scripts/ci/type-check-changed-files.mjs` resolves a changed `.spec.ts` to `tsconfig.spec.json` (jest types present) → passes.

So a production-tsconfig type error in any lib that (1) lacks a `tsconfig.lib.json`/`tsconfig.app.json` AND (2) lacks a `type-check` Nx target reaches `main` green and only fails at the deploy-only gate — fail-closed, but blocking production until hotfixed (exactly [[ORPHAN-MEDIUM-127]]).

**Effect:** a recurring class of deploy-time-only failures; any future lib that adds an in-`src` spec under a bare-tsconfig project re-triggers it. ORPHAN-MEDIUM-127 fixed the one instance; the divergence itself is unguarded.

**Fix direction (owner: infra-expert):** EITHER (1) run `npm run type-check` (the full `type-check-all.mjs`) as a PR-CI gate in `ci-affected.yml` so deploy-blocking type errors are caught pre-merge in the SAME gate that blocks deploy — the higher-tier (make-it-detectable) option, scoped to affected projects if the 36-project full run is too slow; OR (2) add an explicit `type-check` Nx target to every lib so `nx affected -t type-check` covers them, plus a repo invariant asserting that any project whose canonical tsconfig `include` matches `**/__tests__/**` or `**/*.spec.ts` also carries a `tsconfig.lib.json`/`tsconfig.app.json` that excludes tests (so the canonical config can never sweep test files). Not bundled into the ORPHAN-MEDIUM-127 hotfix because `ci-affected.yml` is a merge-train-contended file and the policy/perf tradeoff is infra-owned.

Status: OPEN (2026-06-17; owner: infra-expert; tracked follow-up). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-129 — C2 React 19 migration left the aquamobil standalone package-lock.json (+ CLAUDE.md) on React 18, breaking the production Docker image build

Severity: MEDIUM. Discovered 2026-06-17 during the production redeploy of main (`66aaa619c` → `b5a61b821`). The `build-frontend-images (aquamobil, Dockerfile.aquamobil)` job failed; `verify-images` / `capacity-preflight` / `deploy` skipped fail-closed → **nothing reached production**.

**Problem:** aquamobil is a STANDALONE Vite PWA with its OWN lockfile. `infrastructure/docker/Dockerfile.aquamobil:26` copies `web/apps/aquamobil/package.json` + `web/apps/aquamobil/package-lock.json` into an isolated WORKDIR (no monorepo workspace context) and runs `npm ci --ignore-scripts` (SEC-015, no-glob explicit lockfile). The C2 React 19 migration bumped `web/apps/aquamobil/package.json` to React 19 (`react`/`react-dom@19.2.7`, `@types/react@^19.2.17`, `@testing-library/react@^16.3.2`, `@testing-library/dom@^10.4.1`) AND regenerated the ROOT monorepo lock, but did NOT regenerate the aquamobil STANDALONE lock — it stayed on `react@18.3.1` / `@types/react@^18.2.47` / `scheduler@^0.23.2` with the new testing-library deps missing. So `npm ci` inside the Docker build fails sync (`npm error EUSAGE ... lock file's react@18.3.1 does not satisfy react@19.2.7; Missing: @testing-library/dom@10.4.1 ...`). The aquamobil `CLAUDE.md` also still read "React 18".

**Why PR-CI didn't catch it:** PR-CI installs via the ROOT workspace lock (React 19, in sync) and never builds `Dockerfile.aquamobil`; the image is built only in the deploy pipeline's `build-frontend-images` matrix. So the standalone-lock drift is invisible until the deploy build — the same deploy-only-visibility class as [[ORPHAN-MEDIUM-128]].

**Resolution (this PR):** regenerated `web/apps/aquamobil/package-lock.json` standalone (`npm install --package-lock-only` against the React 19 package.json; `lockfileVersion: 3` preserved) and updated the aquamobil `CLAUDE.md` "React 18" → "React 19". Verified by replicating the exact Docker step in an isolated context — `npm ci --ignore-scripts` → exit 0, `react@19.2.7` installed (528 packages).

**Systemic note (owner: infra-expert / aquamobil):** the aquamobil standalone lock + its Docker image build are not exercised by PR-CI, so any future `web/apps/aquamobil/package.json` bump that skips regenerating the standalone lock re-breaks the deploy build. Recommend a PR-CI gate that runs `npm ci` against the standalone lock (or builds `Dockerfile.aquamobil`) on changes under `web/apps/aquamobil/`.

Status: RESOLVED (2026-06-17; fix branch `fix/aquamobil-standalone-lock-react19`). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-130 — Phase 7 wired the aquamobil shared-contracts vite alias but Dockerfile.aquamobil doesn't COPY libs/shared-contracts, so the standalone image vite build fails

Severity: MEDIUM. Discovered 2026-06-17 during the production redeploy (`31a5238bb`, deploy #3). The `build-frontend-images (aquamobil)` job's `npx vite build` step failed (after `npm ci` passed, post-[[ORPHAN-MEDIUM-129]]).

**Problem:** aquamobil's `vite.config.ts` aliases `@aquaculture/shared-contracts` → `../../../libs/shared-contracts/src` (path-aliased, NOT npm-installed — mirroring the farm-shared precedent), and `src/hooks/useMediaUpload.ts` imports `MESSAGING_MEDIA_MIME_ALLOWLIST` from it (Phase 7, MSG-MEDIUM-057). But `infrastructure/docker/Dockerfile.aquamobil`'s standalone builder copies only `libs/farm-shared` into the build context (`COPY libs/farm-shared /monorepo/libs/farm-shared`), NOT `libs/shared-contracts`. So inside the container the alias resolves to a missing directory and `vite build` fails: `Could not load /monorepo/libs/shared-contracts/src (imported by src/hooks/useMediaUpload.ts): ENOENT`.

**Why PR-CI didn't catch it:** PR-CI does not build `Dockerfile.aquamobil`; the image builds only in the deploy pipeline. Deploy-only-visible (same class as [[ORPHAN-MEDIUM-128]] / [[ORPHAN-MEDIUM-129]]). Phase 7 added the alias + import but missed the corresponding Dockerfile COPY.

**Resolution (this PR):** add `COPY libs/shared-contracts /monorepo/libs/shared-contracts` to `Dockerfile.aquamobil`, right after the farm-shared COPY. `libs/shared-contracts/src` is pure enums/types (no React/node-only deps), tree-shaken to just the MIME allowlist. Verified firsthand by reproducing the exact CI build locally: `docker build --target builder` → exit 0 (vite `✓ built in 22.21s`, image named).

**Systemic note (owner: infra-expert / aquamobil):** the aquamobil standalone Docker image build is not exercised by PR-CI, so cross-lib import additions, lockfile drift, and Dockerfile-context gaps are ALL deploy-only-visible. The recurring fix is one PR-CI gate that actually builds `Dockerfile.aquamobil` on changes under `web/apps/aquamobil/` (consolidates [[ORPHAN-MEDIUM-129]] + this).

Status: RESOLVED (2026-06-17; fix branch `fix/aquamobil-dockerfile-copy-shared-contracts`). Registry: orphan-findings.md only.

---

## ORPHAN-LOW-131 — pedagogy_lint NARRATIVE_RX matched only colon-OUTSIDE (`**Why**:`), contradicting its own remediation string + the V4 validator + the allowlist's own assertion

Severity: LOW. Discovered 2026-06-17 while planning the ARIA-kernel pedagogy GitHub-Actions red (ARIA-V5 §3e); confirmed firsthand by a 4-agent adversarial review + the architectural-arbiter.

**Problem:** `aria-kernel/aria_kernel/pedagogy_lint.py` `NARRATIVE_RX` / `EXAMPLE_EQUIVALENT_RX` matched the narrative-marker punctuation only OUTSIDE the bold (`**Why**:`), but: (a) the lint's OWN remediation message (`:369-371`) tells authors to write `**Why:**` (colon INSIDE); (b) the authoritative sibling V4 validator `narrative_prompt_validator.py:230-236` matches `**Rule.**` (period INSIDE); (c) `tests/invariants/agent-pedagogy.allowlist.json` entries assert the V4 inside-shape "is accepted by NARRATIVE_RX" — which was FALSE on main. So the two kernel narrative validators disagreed on the marker shape and the lint contradicted its own guidance; a canonical authored narrative was not recognized.

**Effect:** the §3e pedagogy gate was not satisfiable by writing the documented shape, and the allowlist's assertion was aspirational rather than true. (The standing `aria-kernel-fast`/`aria-kernel` red is the EXPIRED 30-day allowlist — a separate, by-design forcing-function — NOT this; but this bug means the follow-on narrative work would not register without the fix.)

**Resolution (Phase 0):** widen both matchers to accept punctuation INSIDE or OUTSIDE (`(?:[:.]\*\*|\*\*\s*[:.])`) — additive (outside still matches; no existing agent breaks). Regression test `test_i_v5_3_04` pins both accept-sides + the reject-side. Measured non-increase: `pedagogy_lint --strict` violation_count 578 → 576 (a DECREASE — false-negative repair; compliant 43 → 44). The §3e forcing function (30-day allowlist expiry, `assert==0` gate, strict-mode policy) is untouched. architectural-arbiter ruling: ALLOW-WITH-CONDITIONS (two-way-door internal-helper fix; no `docs/adr/` ADR required).

Status: RESOLVED (2026-06-17; fix branch `chore/aria-pedagogy-phase0-lint-contract`). Registry: orphan-findings.md only. Part of the approved ARIA-V5 §3e pedagogy plan (Phase 0).

---

## ORPHAN-HIGH-132 — farm cull/mortality enum migration issued UNGUARDED `ALTER TYPE` → tenant fan-out 42704 → production outage; migration unit tests never ran

Severity: HIGH (caused a production app outage). Discovered 2026-06-17 during production deploy #5 of main.

**Problem:** `apps/farm-service/.../1801300000000-AddCullMortalityAuditEnumValues` ran bare `ALTER TYPE "tank_operations_cullreason_enum" ADD VALUE IF NOT EXISTS 'quality'` (+ 4 more). `IF NOT EXISTS` guards the VALUE, NOT the TYPE. The three enum types exist ONLY in the `farm` schema (Baseline creates them `farm`-qualified); each `tenant_<uuid>` clone's `tank_operations` references them CROSS-SCHEMA (column type `farm.<enum>`) with no local copy. db-migrate fans the migration out with search_path pinned per-schema: the `farm` run SUCCEEDED (added all 5 labels), but the per-tenant run (`search_path = tenant_7f6b08ab90e246d3`) hit `42704 type "tank_operations_cullreason_enum" does not exist` → migration failed → `aqua-db-migrate` exited 1.

**Blast radius:** the deploy's `docker compose up` started postgres + db-migrate, but every app service `depends_on: { db-migrate: service_completed_successfully }` — so when db-migrate failed, NONE of the ~28 app services started and the old ones were already replaced. Result: only `aqua-postgres` up = full production app outage. The failure was on the first statement (no partial schema change), and the prod DB schema was ALREADY correct (the `farm` run had added all 5 values — verified read-only: farm has quality/predation/cannibalism/MORTALITY_RECORDED/CULL_RECORDED). So the outage was caused purely by the migration CRASHING on a redundant tenant run, not by any real schema gap.

**Compounding CI gap (why it shipped):** `apps/farm-service/jest.config.ts` `testPathIgnorePatterns` EXCLUDED `src/database/migrations/__tests__/`, so migration unit specs were NEVER executed (only type-checked). The unguarded ALTER shipped with no test exercising it, and an orphaned spec (`1781200000000-ConvertFarmOutboxToIdentity.spec.ts`, importing a migration archived 2026-05-18) sat broken-but-unrun.

**Resolution (this PR):** (1) Guard every ALTER on type-presence in `current_schema()` via the `DO $$ IF EXISTS(pg_type…) THEN ALTER TYPE … END IF $$` pattern that `AlignEquipmentTypesRuntimeContract1800300000000` already uses; postCondition counts a label missing ONLY where its type exists in the active schema (so the `farm` run still fail-closes on a genuinely-missing value, while per-tenant runs pass). Verified read-only against the live prod DB: postCondition `missing=0` for BOTH `farm` and `tenant_7f6b08ab90e246d3`. (2) Removed the `migrations/__tests__/` jest ignore so migration unit tests run; added a regression spec (`never a bare ALTER TYPE`); deleted the orphaned 1781200000000 spec.

**Deeper architecture note (separate — owner: farm-expert / data-expert):** the farm enum types + `tank_operations` are `farm`-schema-qualified (shared) while tenant tables reference them cross-schema. That contradicts the per-tenant schema-isolation model (ADR-011) for these objects and is the latent reason the per-tenant fan-out is a no-op for them. Deliberately not bundled into this outage hotfix (owner: farm-expert / data-expert); flagged for a separate schema-ownership review.

Status: RESOLVED (2026-06-17; fix branch `fix/farm-cull-enum-migration-tenant-guard`). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-133 — auth forms render white text on the light frosted login card → WCAG AA contrast fail

Severity: MEDIUM (accessibility). Discovered 2026-06-24 during the Suderra login rebuild (frontend-expert read of `web/shell/src/pages/LoginPage.tsx`).

**Problem:** the `AuthLayout` card is `backdrop-blur-md bg-white/65` (a light frosted surface over an ocean gradient). `LoginForm` was styled for that light card (`text-blue-700`), but `ForgotPasswordForm`, `ResetPasswordForm`, and `AcceptInvitationForm` — rendered inside the SAME card — use `text-white`/`text-white/70` (8 occurrences) as if they sat on the dark gradient. White text on a ~white card is far below 4.5:1, so three auth screens have unreadable headings/body. Root cause: per-form ad-hoc color choices with no shared foreground token.

**Resolution (Suderra login rebuild plan):** introduce a single glass-surface foreground token set (`--surface-heading-fg`/`--surface-muted-fg`, primary-800/700, AA-verified) consumed by ALL forms via shared `AuthFormShell` chrome, so no form can pick a low-contrast color. Phase 1 lands the tokens; Phase 3 rewrites the forms.

Status: IN-PROGRESS (2026-06-24; branch `feat/login-suderra-rebuild`). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-134 — login surface uses raw blue-* utilities + a global `!important` `.backdrop-blur-md input` hack instead of design tokens

Severity: MEDIUM (design-system integrity / cascade leak). Discovered 2026-06-24 during the Suderra login rebuild.

**Problem:** `LoginPage.tsx` uses 25+ raw `blue-*` Tailwind utilities instead of the `--color-primary-*` SSoT, and `web/shell/src/styles/index.css` (lines ~442-473) force auth field/label/button colors via a global `.backdrop-blur-md input { … !important }` block. The `!important` selector keys off a generic blur utility, so it leaks to ANY `backdrop-blur-md` container app-wide and fights the shared-ui `Input`/`Button` components — exactly the patch-over-architecture pattern the repo forbids.

**Resolution (Suderra login rebuild plan):** a scoped `.surface-glass` component-token block in the design-system SSoT (`theme.css`) + an opt-in `surface="glass"` variant on `Input`/`Button`/`Checkbox`; the page consumes tokens and the `!important` block is deleted. Phase 1 lands the tokens/variants; Phase 3 deletes the hack and removes the raw blue-*.

Status: IN-PROGRESS (2026-06-24; branch `feat/login-suderra-rebuild`). Registry: orphan-findings.md only.

---

## ORPHAN-LOW-135 — "Remember me" checkbox is non-functional (no state, no persistence)

Severity: LOW (dead control / false affordance). Discovered 2026-06-24 during the Suderra login rebuild.

**Problem:** `LoginPage.tsx:320` renders a bare `<input type="checkbox" />` with no `checked`, no `onChange`, and no state binding. It looks like a working "remember me" control but does nothing — the session-persistence behaviour it implies does not exist. Because access tokens are in-memory-only by design and the refresh token is a server-set httpOnly cookie, genuine "stay logged in" requires the server to issue a persistent-vs-session refresh cookie based on a `rememberMe` flag — a full-stack change, not a frontend storage trick.

**Resolution (Suderra login rebuild plan, Phase 2):** thread a `rememberMe` boolean through `LoginInput` → auth-service refresh-cookie `maxAge` branch (persistent vs session), persisted on the refresh-token row so rotation preserves it, and carried across the MFA challenge via the signed mfaToken claim. The checkbox becomes controlled state.

Status: IN-PROGRESS (2026-06-24; branch `feat/login-suderra-rebuild`). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-136 — auth animations have no `prefers-reduced-motion` guard (14-fish rAF loop + wave/kelp)

Severity: MEDIUM (accessibility / vestibular). Discovered 2026-06-24 during the Suderra login rebuild.

**Problem:** `prefers-reduced-motion` appears zero times in `web/shell/src/styles/index.css` and `web/shared-ui/src/styles/theme.css`, yet the login page runs a 14-fish `requestAnimationFrame` swim loop (`FishBackground.tsx`) plus wave/kelp/tail CSS keyframes. Users who request reduced motion get continuous animation with no opt-out — a WCAG 2.3.3 / vestibular concern.

**Resolution (Suderra login rebuild plan, Phase 3):** a single `@media (prefers-reduced-motion: reduce)` block neutralizing the wave/kelp/tail/fade keyframes, plus a `matchMedia` guard in `FishBackground` that renders a calm static spread and never starts the rAF loop (with a live change-listener).

Status: IN-PROGRESS (2026-06-24; branch `feat/login-suderra-rebuild`). Registry: orphan-findings.md only.

---

## ORPHAN-LOW-137 — auth brand copy says "Aquaculture Platform" while the product brand is Suderra

Severity: LOW (brand correctness). Discovered 2026-06-24 during the Suderra login rebuild.

**Problem:** `AuthLayout.tsx:62` (logo alt) and `:88` (footer) hardcode "Aquaculture Platform", but the product brand is **Suderra** (`suderra.theme` storage key, `app.suderra.com`/`aquamobil.suderra.com` origin allowlist). `VITE_APP_NAME` was declared (`vite-env.d.ts:7`) but never defined → `undefined` at runtime, so there is no brand SSoT.

**Resolution (Suderra login rebuild plan):** a typed `BRAND` SSoT (`web/shared-ui/src/config/brand.ts`, name "Suderra") consumed by `AuthLayout` (alt/tagline/footer/support). Phase 1 lands the constant; Phase 3 consumes it.

Status: IN-PROGRESS (2026-06-24; branch `feat/login-suderra-rebuild`). Registry: orphan-findings.md only.

---

## ORPHAN-LOW-138 — WebAuthn login bypasses the new refresh-cookie SSoT (drift + no remember-me)

Severity: LOW (DRY/SSoT drift). Discovered 2026-06-24 by auth-security-expert during the Suderra login-rebuild audit.

**Problem:** the remember-me work introduced a refresh-cookie SSoT (`apps/auth-service/.../utils/refresh-token-cookie.ts`) and routed `auth.resolver.ts` + `mfa.resolver.ts` through it. `webauthn.resolver.ts:48-56` is a THIRD refresh-cookie setter still hand-rolling `res.cookie('refresh_token', …)` with an always-persistent `maxAge` (7d) and no remember-me concept. Future cookie hardening (sameSite:strict, `__Host-` prefix, partitioned cookies) must be applied twice and WebAuthn will lag; and a biometric login is always persistent even when the user wanted a session.

**Why deferred (owner: auth-security-expert; out of login-rebuild scope):** routing WebAuthn through the SSoT requires deciding WebAuthn's persistence semantics (preserve 7d-persistent vs add a real remember-me choice vs session) — a WebAuthn-feature decision, not part of the login-page rebuild. Changing it here would alter WebAuthn login behavior. Tracked for a WebAuthn-scoped follow-up.

**How to fix:** thread `buildRefreshTokenCookieOptions(...)` + `REFRESH_TOKEN_COOKIE_NAME` into `webauthn.resolver.ts` with an explicit persistence choice, and add an invariant asserting every `res.cookie('refresh_token', …)` callsite flows through the SSoT (Tier-3 detectable).

Status: OPEN (2026-06-24). Owner: auth-security-expert. Registry: orphan-findings.md only.

---

## ORPHAN-LOW-139 — MFA challenge-token verify does not assert iss/aud (defense-in-depth)

Severity: LOW (defense-in-depth; NOT exploitable in the single-issuer platform). Discovered 2026-06-24 by auth-security-expert during the Suderra login-rebuild audit.

**Problem:** `mfa.service.ts` verifies the MFA challenge token via `this.jwtService.verify(mfaToken)` with only the module-default `verifyOptions: { algorithms:['RS256'] }`, whereas access-token verification uses `getJwtVerifyOptions()` which also enforces issuer + audience (RFC 9068). The MFA-token verify is the lone auth-service verify path that does not assert the full claim set.

**Why not exploitable today:** the token IS RS256-signature-verified against auth-service's own key (so the carried `rememberMe` cannot be forged), and the endpoint additionally pins `type==='mfa_challenge'` + `purpose` + `sub`-prefix and reads `userId` from the signed payload. iss/aud would only matter for a foreign RS256 issuer trusted under the same key — which does not exist (auth-service is the sole signer).

**How to fix:** sign the challenge in `generateMfaChallenge` with `audience: JWT_AUDIENCE` and verify in `verifyMfaLogin` with explicit `{ algorithms:['RS256'], issuer, audience }`, so all auth-service verifies are symmetric. Note the 5-min-TTL blue-green window (tokens minted pre-deploy lack aud).

Status: OPEN (2026-06-24). Owner: auth-security-expert. Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-149 — auth in-place screen swaps (MFA step, recovery toggle) are not announced to screen readers

Severity: MEDIUM (a11y / WCAG 4.1.3). Discovered 2026-06-24 by accessibility-auditor during the Suderra login-rebuild audit.

**Problem:** after a correct password, `LoginForm` swaps the password screen for the MFA screen in place (no route change); focus moves to the code field (keyboard OK) but no announcement tells a screen-reader user a new step ("Two-Factor Authentication required") appeared. The authenticator↔recovery toggle likewise changes the prompt subtitle with no announced context shift. (The success/error result screens were fixed in this PR via AuthStatusScreen role+focus; the MFA-step transition needs focus-management surgery in LoginForm/AuthFormShell and was scoped separately.)

**How to fix:** on MFA mount, move focus to the `<h2>` step heading (`tabIndex={-1}` + focus) or emit a one-shot assertive status announcing the step; route the recovery-toggle prompt change through the same announced status. Best placed in `AuthFormShell` (it owns the heading) so any multi-step auth form inherits it.

Status: OPEN (2026-06-24). Owner: frontend-expert. Registry: orphan-findings.md only.

---

## ORPHAN-LOW-150 — shared Button "loading" state has no perceivable busy status (only aria-busy)

Severity: LOW (a11y / status communication). Discovered 2026-06-24 by accessibility-auditor during the Suderra login-rebuild audit.

**Problem:** `web/shared-ui/src/components/Button/Button.tsx` sets `aria-busy` + an `aria-hidden` spinner when `loading`, but the accessible name stays the unchanged action text and there is no polite status, so a screen-reader user re-querying an in-flight "Sign In" hears only "Sign In, dimmed" with no in-progress signal. This is a shared-primitive enhancement affecting every loading button platform-wide, so it is scoped as a design-system follow-up rather than a login-only fix.

**How to fix:** add an optional `loadingLabel` to `Button` (swap the accessible name or render an `sr-only` polite status when loading); default it via i18n at the auth callsites. Tier-2: make the busy announcement the zero-effort default of the shared Button.

Status: OPEN (2026-06-24). Owner: frontend-expert. Registry: orphan-findings.md only.

---

## ORPHAN-HIGH-142 — auth error slot nested an assertive Alert inside a polite live region (conflicting announcement)

Severity: HIGH (a11y / WCAG 4.1.3). Discovered 2026-06-24 by accessibility-auditor + frontend-expert during the Suderra login-rebuild audit.

**Problem:** `AuthFormShell` wrapped the error `Alert` (which carries `role="alert"` = assertive) in a `<div aria-live="polite">`. Nesting an assertive live region inside a polite one yields non-deterministic / doubled screen-reader announcements for a security-relevant sign-in error.

**Resolution (this commit):** removed the wrapping `aria-live` div; the `Alert`'s `role="alert"` is now the single live region (assertive is the correct politeness for an auth error). One SSoT surface (`AuthFormShell`) fixes every auth form. Test updated to assert one `role="alert"` region.

Status: RESOLVED (2026-06-24; branch `feat/login-suderra-rebuild`). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-143 — password show/hide toggle lacked aria-controls + a 24px touch target

Severity: MEDIUM (a11y / WCAG 2.5.8 + 4.1.2). Discovered 2026-06-24 by accessibility-auditor + frontend-expert.

**Problem:** the `PasswordInput` toggle had no programmatic binding to its field, so two PasswordInputs on one form (reset: new + confirm) presented two indistinguishable "Show password" buttons; the hit area was ~20px (< 24px AA minimum).

**Resolution (this commit):** added `aria-controls={inputId}` (binds the toggle to its field) and `min-w-[1.5rem] min-h-[1.5rem] justify-center` (≥24px target) on the shared `PasswordInput` toggle — a multiplier fix across login/reset/accept. Also bumped the default-surface caps-lock warning to `text-amber-700` (AA). Test asserts `aria-controls`.

Status: RESOLVED (2026-06-24; branch `feat/login-suderra-rebuild`). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-144 — login password field had a native minLength=8 that mismatched the JS validator (minLength 6) → non-i18n native bubble

Severity: MEDIUM (correctness / i18n). Discovered 2026-06-24 by frontend-expert + accessibility-auditor.

**Problem:** the login password `<PasswordInput>` set the HTML attribute `minLength={8}` while the JS validator used `minLength(6)`; the browser's native constraint fired a non-translated validity bubble for a 6–7-char password, bypassing the i18n error pipeline. (Carried over from the pre-rebuild LoginPage.)

**Resolution (this commit):** removed the native `minLength` from the login password field. Login validates EXISTING credentials (the server is the authority); the JS guard remains for light client feedback, all messaging stays i18n. Reset/invitation keep `minLength(8)` for NEW passwords (policy).

Status: RESOLVED (2026-06-24; branch `feat/login-suderra-rebuild`). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-145 — auth success/error result screens swapped in place with no SR announcement or focus move

Severity: MEDIUM (a11y / WCAG 4.1.3). Discovered 2026-06-24 by accessibility-auditor.

**Problem:** `AuthStatusScreen` (email-sent, password-reset, invitation-invalid) mounted in place of the form with no route change, so no announcement fired and focus fell to `<body>` — a screen-reader user got no feedback that the action succeeded/failed.

**Resolution (this commit):** `AuthStatusScreen` now marks its container `role="status"` (success) / `role="alert"` (error) and moves focus to the heading (`tabIndex={-1}` + focus on mount) so the result is announced. SSoT for all four result screens. (The MFA-step in-place swap is a separate, deeper focus-management item tracked as ORPHAN-MEDIUM-149.)

Status: RESOLVED (2026-06-24; branch `feat/login-suderra-rebuild`). Registry: orphan-findings.md only.

---

## ORPHAN-HIGH-133 - root stabilization gates passed without toolchain, manifest, generated-output, and gate-tool type SSoT coverage

Severity: HIGH. Discovered 2026-06-20 during the 6-agent SSoT stabilization audit.

**Problem:** `gates:all` did not execute a toolchain contract check, did not run a root stabilization manifest invariant, and did not type-check the gate tooling itself. The result was a control-plane false pass: the package scripts claimed root SSoT stabilization coverage while toolchain versions, the implementation-wave manifest, generated-output ownership, and gate TypeScript soundness were not all producer-owned and verified by the aggregate gate. Separately, generated service-catalog artifacts had a stale catalog hash, and `codegen:check` showed `web/shared-ui/src/generated/graphql-types.ts` was stale after the supergraph producer ran. Root `type-check` also depended on farm-module's `react-leaflet` package without a workspace-level dependency, so the full repo gate could fail outside the package-local install path.

**Resolution (this PR):** added `tools/toolchain/versions.json` and `tools/toolchain/check-versions.mjs`, wired `toolchain:check`, `gates:tools-typecheck`, and `gates:root-ssot-stabilization` into `gates:all`, and added the machine-readable stabilization manifest plus invariant tests that enforce explicit finding scope, producer-file existence, non-editable generated outputs, and the final registry sweep as the only pattern-scope escape hatch. Gate-tool TypeScript fixes remove the compile gaps without suppressions. Service-catalog artifacts were regenerated through `npm run service-catalog:generate`; GraphQL types were regenerated through the supergraph producer plus `npm run codegen`; `react-leaflet` is now a root dependency so repo-wide type-check resolves the farm-module tile package from the same workspace dependency graph.

**Verification:** `npm run type-check`, `node scripts/apollo-router/build-supergraph.mjs`, `npm run codegen:check`, `npm run toolchain:check`, `npm run gates:tools-typecheck`, `npm run gates:root-ssot-stabilization`, `npm run service-catalog:check`, `npm run gates:all`, targeted ESLint for the files changed by this PR, and `git diff --check` all passed in the clean control-plane worktree. Full `npx nx affected --target=lint` was also run and correctly failed on broader pre-existing repo-wide lint closure debt outside this slice; that is tracked as [[ORPHAN-HIGH-134]] instead of being hidden or bypassed.

Status: RESOLVED (2026-06-20; fix branch `codex/root-ssot-control-plane`). Registry: orphan-findings.md only.

---

## ORPHAN-HIGH-134 - full affected lint is not a usable merge gate because repo-wide closure debt is already red

Severity: HIGH. Discovered 2026-06-20 while verifying the root SSoT control-plane slice.

**Problem:** `npx nx affected --target=lint` fans out to broad repo scope after root `package.json` / lockfile changes and fails on existing lint debt across multiple owners, including `libs/migration-harness`, `web/modules/sensor-module`, `apps/admin-api-service`, `apps/auth-service`, `apps/billing-service`, `aqua-scripts`, and `e2e`. The failures are not one isolated style issue: they include unsafe `any` access, forbidden non-null assertions, hook-order violations, `Function` constructor usage, stale eslint-disable suppressions, floating promises, structured-logging JSON formatting, forbidden imports, and import-order drift. This means affected lint is fail-closed but currently too red to serve as a clean signal for unrelated root producer changes.

**Immediate containment in this PR:** fixed the lint defects directly touched by this verification pass where the blast radius was small and behavior-preserving: alert-engine floating promises / async timer cleanup / JSON export formatting, hydroponics stale eslint-disable directives, and farm-shared import ordering. Targeted ESLint for those changed files passes.

**Fix direction:** split a dedicated repo-wide closure branch by owner boundary: migration-harness typed test helpers first, sensor-module hook/script execution cleanup second, backend service stale suppressions/floating promises third, then e2e typed fixture/client cleanup. Each slice must remove suppressions and unsafe assertions by replacing them with typed helpers or corrected control flow, not by disabling rules.

Status: OPEN (2026-06-20; owner: repo-wide closure / lint gate). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-140 - opentelemetry dependency family is fragmented across two Rust workspaces (extends ORPHAN-001)

Severity: MEDIUM. Discovered 2026-06-23 while triaging dependabot #576 (opentelemetry 0.27 -> 0.32) during the controlled branch-to-main merge sweep.

**Problem:** The otel crates are pinned at incoherent versions in two separate workspaces. Root `/Cargo.toml` (the workspace that compiles `crates/observability`, which actually uses the OTLP exporter in `trace_propagation.rs`/`lib.rs`): `opentelemetry = 0.27`, `opentelemetry_sdk = 0.32`, `opentelemetry-otlp = 0.27`, `tracing-opentelemetry = 0.33` — the SDK is already two minor lines ahead of `opentelemetry`/`otlp`. The separate `sens-api-gateway/Cargo.toml` workspace is further behind: `opentelemetry = 0.27`, `opentelemetry-otlp = 0.27`, `opentelemetry_sdk = 0.27`, `tracing-opentelemetry = 0.28`. `opentelemetry-otlp 0.27` targets the `opentelemetry 0.27` trait API, so spans/exporters built across the 0.27 and 0.32 lines do not share types — a latent trace-incoherence, exactly what ORPHAN-001 first flagged in April. Dependabot #576 bumped only `opentelemetry` to 0.32 and left `otlp` at 0.27; CI passed because the gap is masked (feature-gating / cargo dedup), not because it is coherent. #576 was closed as a partial bump.

**Fix direction:** One coordinated otel `0.27 -> 0.32` upgrade across BOTH workspaces — move `opentelemetry`, `opentelemetry_sdk`, `opentelemetry-otlp` all to 0.32 and `tracing-opentelemetry` to 0.33 in the same change — and migrate the `crates/observability` OTLP exporter-builder calls to the 0.32 API (the `SpanExporter`/pipeline builder surface changed across 0.27->0.32). Add a `cargo build --features telemetry` job to CI so the otel path is actually exercised by the gate instead of dedup-masked.

Status: OPEN (2026-06-23; owner: edge/observability Rust). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-141 - RustCrypto digest 0.10 -> 0.11 line cannot be bumped piecemeal (sha2/hmac)

Severity: MEDIUM. Discovered 2026-06-23 while triaging dependabot #574 (hmac 0.13) and #575 (sha2 0.11) during the controlled merge sweep.

**Problem:** `sens-api-gateway/Cargo.toml` pins `hmac = "0.12"` and `sha2 = "0.10"`, both built on the `digest 0.10` trait crate. `sha2 0.11` requires `digest 0.11`; `hmac 0.13` requires `digest 0.11`. Bumping either crate in isolation leaves the other on `digest 0.10`, so `Hmac<Sha256>` fails its trait bound (digest 0.10 vs 0.11 are distinct trait crates) — CI red on clippy, `cargo test --workspace`, and the musl cross-builds. This code is load-bearing: ADR-019/ADR-020 master-derived audit-hmac chains (`sqlcipher_db_key`, `audit_hmac_chain_key`, device attestation) and the R1 router-coprocessor HMAC-SHA256 parity contract all depend on it. #574 and #575 were closed (cannot land alone).

**Fix direction:** Migrate the whole RustCrypto `digest 0.10 -> 0.11` set in one coordinated change (`sha2`, `hmac`, `hkdf`, and any other crate sharing the `digest` traits), then re-run golden-vector parity tests for the audit-hmac chain and the coprocessor HMAC-SHA256 vectors before/after to prove byte-for-byte equivalence. Do not bump any single member ahead of the set.

Status: OPEN (2026-06-23; owner: edge/crypto Rust). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-142 - cargo audit advisory RUSTSEC-2026-0185 (quinn-proto) is not in the ignore-list and reds the advisory gate

Severity: MEDIUM. Discovered 2026-06-23 while merging dependabot GHA bumps (#581 etc., which surfaced as UNSTABLE) during the controlled merge sweep.

**Problem:** `cargo audit` fails on `RUSTSEC-2026-0185` in `quinn-proto` (a transitive dependency). The Rust CI ignore-list currently carries `RUSTSEC-2023-0071`, `RUSTSEC-2025-0141`, `RUSTSEC-2024-0388`, `RUSTSEC-2023-0089`, and `RUSTSEC-2026-0173` but not `RUSTSEC-2026-0185`, so the `cargo audit` / "Sens API Gateway summary" checks are red on every PR and on main. These are NON-required checks, so they do not block merges (PRs read UNSTABLE, not BLOCKED), but they degrade the advisory signal to noise.

**Fix direction:** Triage `RUSTSEC-2026-0185` — bump `quinn`/`quinn-proto` to a patched release if one exists (preferred), otherwise add it to the `--ignore` list WITH an inline justification comment and a tracked re-review date. Do not silently suppress; the ignore-list must stay a reviewed, dated allowlist.

Status: OPEN (2026-06-23; owner: edge/supply-chain Rust). Registry: orphan-findings.md only.

---

## ORPHAN-HIGH-143 - `availableTanks` GraphQL query declared by two resolvers → non-deterministic schema → intermittent `Unknown argument "siteId"` 400

Severity: HIGH. Discovered 2026-06-24 from a live browser error reported by the operator: `[useAvailableTanks] GraphQLClientError: Unknown argument "siteId" on field "Query.availableTanks"` (HTTP 400), with the symptom "data sometimes loads, sometimes doesn't".

**Problem:** Two farm-service resolvers registered the same root field name `availableTanks`:
- `apps/farm-service/src/batch/resolvers/batch.resolver.ts:192` `listAvailableTanks(siteId, departmentId, excludeFullTanks) → [AvailableTankResponse!]!` — the complete contract the frontend (`web/modules/farm-module/src/hooks/useBatches.ts` `useAvailableTanks` / `AVAILABLE_TANKS_QUERY`) targets, including the capacity/site fields it selects.
- `apps/farm-service/src/tank/resolvers/tank.resolver.ts:226` `getAvailableTanks(departmentId) → [Tank!]!` — a stale, incomplete duplicate routing to `ListTanksQuery`, with NO `siteId`/`excludeFullTanks`.

NestJS code-first builds the schema by collecting resolver metadata; when a root field name is declared twice, only one definition survives and which one wins depends on module/resolver load order — non-deterministic across rebuilds/restarts. When the stripped-down `tank.resolver` definition won, the runtime schema lost the `siteId` argument, so the gateway rejected the FE document with a 400. The committed `apps/farm-service/schema.graphql` snapshot happened to capture the batch-resolver version, so the FE↔BE parity invariant passed — it folds the backend surface into a `Set<string>`, silently deduping the two declarations and never seeing the conflict.

**Fix:** Removed the duplicate `getAvailableTanks` from `tank.resolver.ts` — `availableTanks` now has exactly one owner (`batch.resolver.listAvailableTanks`), the capacity-rich contract the FE expects (all 15 selected fields match `AvailableTankResponse`; same RBAC roles). Strengthened SSoT enforcement so the wrong state fails CI instead of the user's browser: extracted the resolver-surface scan into a shared SSoT helper (`tests/invariants/helpers/farm-graphql-surface.ts`) consumed by both the parity gate (refactored off its private copy of the extractor) and a new `tests/invariants/farm-graphql-resolver-field-uniqueness.spec.ts` that asserts every root operation (Query/Mutation/Subscription) is declared by exactly one resolver. Verified 0 remaining duplicates across 411 root fields.

Status: RESOLVED (2026-06-24; this commit carries `Closes: ...#ORPHAN-HIGH-143`). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-144 - invariant specs are not strict-type-checked; ts-jest `isolatedModules` hides latent strict-null errors

Severity: MEDIUM. Discovered 2026-06-24 while type-checking `tests/invariants` during the ORPHAN-HIGH-143 fix (`tsc --noEmit -p tests/invariants/tsconfig.spec.json`).

**Problem:** The invariant Jest config (`tests/invariants/jest.config.ts`) runs ts-jest with `isolatedModules` (syntactic transpile only, no full type-check, for the <15s `invariants:fast` SLO). A standalone `tsc --noEmit -p tests/invariants/tsconfig.spec.json` (which IS `strict: true`) is currently RED with strict-null violations in pre-existing specs that the Jest run never surfaces:
- `no-boot-time-tenant-schema-ddl.spec.ts:122` (TS2532)
- `pii-events-mandatory-crypto-shred.spec.ts:125,140,154,164` (TS2322)
- `rls-predicate-canonical.spec.ts:178,182,186,188` (TS18048/TS2345)
- `shared-schema-canonical.spec.ts:90,103,107` (TS2532/TS2345)

These are latent — the specs still assert correctly at runtime — but the gap means a real type regression in an invariant spec would not be caught by the invariant suite itself. NOT introduced by ORPHAN-HIGH-143 (those files are untouched here); the new helper + specs added by that fix type-check clean.

**Fix direction:** Either (a) wire a `tsc --noEmit -p tests/invariants/tsconfig.spec.json` step into CI alongside the Jest run, then fix the strict-null sites above (narrow with guards, not `!`/`as`), or (b) accept ts-jest's transpile-only mode and explicitly document that platform-wide `npm run type-check` is the type authority for these files — and confirm it actually includes `tests/invariants` (verify scope). Option (a) is the stronger SSoT (the suite that owns the invariants also owns their type safety).

Status: OPEN (2026-06-24; owner: invariants/build). Registry: orphan-findings.md only.

---

## ORPHAN-HIGH-145 - admin-api throttler treats every authenticated SUPER_ADMIN as anonymous (20/60s, IP-keyed) → operator 429 storm

Severity: HIGH. Discovered 2026-06-24 from a live operator report: the admin panel (RoleManagementPage, UserManagementPage) failed with HTTP 429 "Too many requests" while ONLY ONE operator was connected — `/api/users/roles/*`, `/api/users/stats`, `/api/users`, `/api/admin/tenants` all 429.

**Problem:** a `request.user` shape contract mismatch between the writer and the reader inside admin-api-service.
- Writer — `apps/admin-api-service/src/guards/platform-admin.guard.ts` set `request.user = { id: payload.sub, ... }` (only `id`, never the canonical `sub`).
- Reader — the shared `libs/backend-common/src/security/throttler/throttler.guard.ts` (global APP_GUARD in admin-api) reads identity as `request.user?.sub ?? request.user?.userId`:
  - `getThrottleConfig`: `isAuthenticated = !!user.sub || !!user.userId` → **false** → applies `THROTTLE_ANONYMOUS_LIMIT` (20) instead of `THROTTLE_DEFAULT_LIMIT` (100).
  - `generateKey`: `userId = user.sub || user.userId` → undefined; SUPER_ADMIN has no `tenantId` either, so the bucket falls back to `throttle:ip:<ip>`.

So every authenticated platform admin was rate-limited at the 20-req/60s ANONYMOUS tier, keyed by IP. The admin panel fans out 6-7 parallel GETs per page across several pages (plus React StrictMode double-invoke + the http-client's retry), so a single operator's normal dashboard load exceeds 20/60s within seconds → sustained 429. "Only I connect but it says too many requests" is exactly this: the bucket is per-user-by-design but the user was never recognized.

**Fix:** PlatformAdminGuard now attaches the canonical `sub` (the JWT subject) alongside admin-api's local `id`. The throttler sees an authenticated user → 100-req/60s default tier, keyed `throttle:user:<sub>`. `id` stays for admin-api controllers that read `req.user.id`. Regression test added to `platform-admin.guard.spec.ts` asserting the guard exposes `sub`.

Status: RESOLVED (2026-06-24; this commit carries `Closes: ...#ORPHAN-HIGH-145`). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-146 - admin-api hand-rolls a non-canonical `request.user` ({id}) instead of the platform user-context shape ({sub}) — the systemic cause of ORPHAN-HIGH-145

Severity: MEDIUM. Discovered 2026-06-24 while root-causing ORPHAN-HIGH-145.

**Problem:** gateway-api populates `request.user` via the shared `UserContextMiddleware` (canonical `{ sub, tenantId, roles, ... }`), but admin-api-service has NO such middleware (its `AppModule` does not implement `configure()`); identity is attached ad-hoc by `PlatformAdminGuard` in a bespoke `{ id, ... }` shape. Because no SHARED type binds the writer (service guard) to the readers (shared ThrottlerGuard, `@CurrentUser('sub')`), the two silently drifted — undetectable at compile time. ORPHAN-HIGH-145 is one symptom; any other backend-common consumer keying off `sub` would misbehave the same way in admin-api.

**Fix (tier-1 make-it-impossible):** the canonical type already existed — `JwtUser` (`libs/backend-common/src/types/tenant-request.interface.ts`, identity = REQUIRED `sub`), the `user` field of the canonical `TenantRequest`. The drift was that neither side consumed it:
- READER: the shared `ThrottlerGuard` redeclared a private `{ sub?, userId?, tenantId? }` request shape. Rebound it to `TenantRequest` (`user: JwtUser`) and dropped the dead `userId` fallback (no runtime writer ever set `userId` — verified across all services; canonical writers like `verified-user-assertion.middleware` set `sub`). The shared READER now keys off the SSoT's `sub`.
- WRITER: admin-api's `shared/authenticated-request.ts` `AuthenticatedUser` now `extends JwtUser` (so `sub` is compiler-REQUIRED) + keeps the admin-api-local `id`/`name`. `PlatformAdminGuard` dropped its bespoke local `AdminRequest` and types `request` as the shared `AuthenticatedRequest`, so its `request.user = { ... }` assignment fails type-check if it omits `sub`. A guard that forgets `sub` can no longer compile.

Verified: admin-api app `tsc --noEmit` clean (10 controllers consuming `AuthenticatedUser` unaffected), backend-common throttler `tsc` clean, `platform-admin.guard.spec` 31/31. ThrottlerGuard's other consumers (messaging, ai, hydroponics) unaffected — they attach `req.user` via shared middleware using `sub`, never `userId`.

**Remaining (separate, NOT throttler-relevant):** admin-api still carries two OTHER `@CurrentUser` decorator user types (`decorators/current-user.decorator.ts` `CurrentUserData`, `tenant.controller.ts` `AdminUser`) distinct from `JwtUser`. Unifying those is a follow-on cleanup; this finding closes the request.user/throttler SSoT drift that caused the 429.

Status: RESOLVED (2026-06-24; this commit carries `Closes: ...#ORPHAN-MEDIUM-146`). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-147 - admin-api contract-validation.spec.ts is RED on main (10 endpoint groups) and does not gate CI

Severity: MEDIUM. Discovered 2026-06-24 while running admin-api tests for ORPHAN-HIGH-145 (failure reproduces with my changes stashed → pre-existing).

**Problem:** `apps/admin-api-service/src/__tests__/contract-validation.spec.ts` fails for System Metrics (`/system/*`), Analytics, Tenants, Users, Billing, Reports, Support, Settings, Impersonation, and Security endpoint groups — i.e. the FE-declared admin contract surface does not match the backend controller routes the spec discovers. It is RED on `main` yet PRs are green, so the admin-api `test` target is effectively non-gating (consistent with the known affected-target quarantine for admin-api unit tests — see ORPHAN-MEDIUM-088). A contract spec that never blocks is audit theater.

**Fix direction:** triage the 10 groups — for each, either the spec's expected route list is stale (update it) or the backend genuinely lacks the route the FE calls (implement it). Then un-quarantine admin-api's `test` target (or add this spec to a gating lane) so the contract drift cannot silently return. Out-of-band from the throttler fix; recorded so the drift is tracked.

Status: OPEN (2026-06-24; owner: admin-api). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-148 - `/api/security/compliance/reports?limit=50` returns 400 (separate from the 429 class)

Severity: MEDIUM. Discovered 2026-06-24 in the same operator console log as ORPHAN-HIGH-145, but a DISTINCT failure (HTTP 400 Bad Request, not 429).

**Problem:** the compliance reports list endpoint rejects the FE's `?limit=50` request with 400 — likely a DTO/validation mismatch (ValidationPipe `whitelist`+`forbidNonWhitelisted` rejecting `limit`, a type-coercion gap on the numeric query param, or a required param the FE omits). Not yet root-caused. Unrelated to the rate-limit identity bug; it would persist after ORPHAN-HIGH-145 is fixed.

**Root cause (confirmed):** `QueryReportsDto` (compliance.controller.ts) declared `@IsNumber()` on `page`/`limit` WITHOUT `@Type(() => Number)`. Query params arrive as strings, so under the global ValidationPipe `@IsNumber` ran against `"50"` and 400'd every request that sent `page`/`limit` — the endpoint never worked with `?limit=50`. The sibling `QueryDataRequestsDto` in the same file carried the IDENTICAL defect (so `/data-requests?limit=` 400'd too); the audit-trail / security-monitoring controllers already use `@Type(() => Number)`, so these two DTOs were the outliers.

**Fix:** added `@Type(() => Number)` to `page` + `limit` on BOTH `QueryReportsDto` and `QueryDataRequestsDto` (class-transformer coercion before validation), matching the sibling-controller pattern. Exported `QueryReportsDto` and added `__tests__/compliance-query-reports.dto.spec.ts` pinning the coercion (`?page=2&limit=50` → numbers, validates clean; non-numeric still rejected; absent stays optional).

Status: RESOLVED (2026-06-24; this commit carries `Closes: ...#ORPHAN-MEDIUM-148`). Registry: orphan-findings.md only.

---

## ORPHAN-LOW-151 — new vitest.config.ts files fatal the eslint typed parser; new spec files carried unused React imports

Severity: LOW (CI/tooling SSoT gap). Discovered 2026-06-24 when the login-rebuild PR's CI `lint` + `type-check` jobs went red.

**Problem (two root causes):**
1. **Lint:** a package-root `vitest.config.ts` is not registered in that package's `tsconfig.node.json` / `tsconfig.eslint.json` the way `vite.config.ts` is, so the eslint typed parser (`parserOptions.project`) cannot find it and emits a FATAL `Parsing error`. The diff-based CI lint flags this for any NEW config.ts; the pre-existing `web/shared-ui/vitest.config.ts` had the same latent fatal but was masked (unchanged → not in the diff). The eslint config-file ignore (`*.config.{js,mjs,cjs}`) does not cover `.ts`.
2. **Type-check:** the new shared-ui spec files imported `React` while using only JSX. Under the automatic JSX runtime (`jsx: react-jsx`) the import is unused, so the changed-files type-check (`scripts/ci/type-check-changed-files.mjs`, `noUnusedLocals`) failed with `TS6133`. Local `tsc -p tsconfig.json` missed it because that config EXCLUDES specs.

**Resolution (this commit):** registered `vitest.config.ts` in `web/shell/tsconfig.node.json` + `web/shell/tsconfig.eslint.json` AND in `web/shared-ui/tsconfig.eslint.json` (closing the shared-ui blind spot too), exactly as `vite.config.ts` is handled — the established repo convention for node-tooling config files. Removed the unused `React` imports from the four shared-ui surface specs (the automatic JSX runtime needs none). Verified: `type-check-changed-files.mjs` exit 0; eslint on the config + spec files exit 0; the 4 specs still pass (11 tests).

**Note (deeper follow-up, not done here):** the eslint config-file exemption could be extended to `*.config.ts` repo-wide so future config.ts files never trip this — a single eslint.config.mjs change, deferred to avoid risking the lint-gates invariant in this PR.

Status: RESOLVED (2026-06-24; branch `feat/login-suderra-rebuild`). Registry: orphan-findings.md only.

---

## ORPHAN-LOW-152 — login logo swap to logo.svg introduced a white box behind the logo (lost transparency)

Severity: LOW (visual regression). Discovered 2026-06-24 (operator-reported) immediately after the login rebuild merged.

**Problem:** the rebuild switched the auth logo from `/logo4.png` to `/logo.svg` for scalability, but `web/shell/public/logo.svg`'s first element is a full-canvas `<path … fill="#F4F5F4">` — a baked-in off-white background. On the frosted glass card this renders as a white box behind the logo. `logo4.png` is true RGBA-transparent (verified: `mode=RGBA`), which the prior design relied on.

**Resolution (this commit):** reverted the auth logo `src` to `/logo4.png` (transparent), keeping the responsive `clamp(8rem,24vw,16rem)` sizing from the rebuild. A 1024×1024 PNG downscaled to ≤256px is sharp enough; the SVG's scalability was not worth the baked-in background. (If a transparent vector is wanted later, strip the `#F4F5F4` full-canvas path from logo.svg.)

Status: RESOLVED (2026-06-24; branch `fix/login-logo-transparent`). Registry: orphan-findings.md only.

---

## ORPHAN-LOW-153 — login presented in browser locale (TR) + the aquarium ambience was thin (operator polish)

Severity: LOW (UX / visual polish). Discovered 2026-06-24 (operator-requested after the rebuild merged).

**Problem:** (1) the login surface rendered in the app's auto-detected locale (Turkish by default for this platform), but the entry screen should be **English** for an international product. (2) The aquarium login background looked unfinished — only fish, thin seaweed, and no other marine life.

**Resolution (this commit):**
- English login: `AuthLayout` now wraps the auth surface in a nested `<I18nProvider locale="en">` (split into a `AuthChrome` inner so chrome + forms both read EN), overriding the locale for the auth subtree ONLY — the rest of the app keeps its auto-detected language.
- Richer, more realistic aquarium (`FishBackground`): rewrote kelp (multi-frond, depth-graded blades + float) and seaweed (branching fronds), added eelgrass (`SeaGrass`) clumps; added floor fauna (`StarFish`, `Crab`); added a drifting/pulsing `Jellyfish` ambient layer and rising `bubbles` (all CSS, added to the `prefers-reduced-motion` opt-out + the FishBackground rAF guard).
- New swimmers: `Shrimp` (aquaculture species) and `BluefinTuna` — the bluefin is drawn to a higher standard (crescent caudal, yellow finlets, sickle pectoral) and given a MUCH faster speed trait (2.45 vs ≤1.12) with a stiff low-wobble body, per operator request.
- Improved the existing five fish SVGs with pectoral (side) fins.

Status: RESOLVED (2026-06-24; branch `fix/login-logo-transparent`). Registry: orphan-findings.md only.

---

## ORPHAN-HIGH-154 - systemic FE<->BE GraphQL contract drift (135 operations) reaches runtime as intermittent HTTP-400

Severity: HIGH. Discovered 2026-06-24 by validating every frontend GraphQL operation against the composed supergraph (`graphql.validate(schema, parse(op))`, mirroring the gateway's runtime validation). Full inventory: `docs/reviews/2026-06-24-graphql-fe-be-contract-drift-audit.md`.

**Problem:** 135 frontend operations reference fields/queries/types the supergraph does not serve, so the gateway 400s them (HTTP-200 GraphQL-error body, invisible in HTTP access logs) — a major contributor to "tenant panel data sometimes loads, sometimes not". Root cause: ~240 hand-written GraphQL STRING queries passed to `graphqlClient.request()` are never validated against the schema until runtime; codegen exists but covers only aquamobil. By module: hr-module 60 (≈28 are backend features that DO NOT EXIST — scheduling/leave/cert/rotation/performance), sensor-module 35, mcp/farm-management 13, tenant-admin 11, aquamobil 5, dashboard 5, farm-module 5, admin-panel 1. Categories: 68 MISSING-ROOT-OP, 43 MISSING-FIELD, 10 SELECTION-SHAPE, 6 BAD-ARGUMENT, 4 VAR-TYPE-MISMATCH, 4 MISSING-INPUT-TYPE.

**Fix (this commit — enforcement wall):** `scripts/ci/validate-graphql-operations.mjs` runs in the apollo-supergraph compose workflow against the freshly composed supergraph, validating EVERY FE operation across all modules (nested fields + args + input types). A VISIBLE, monotonic-shrink baseline (`scripts/ci/graphql-fe-drift.baseline.json`, 135 entries by file+op+category) makes the gate enforce ZERO new drift (hard wall, proven via negative test) while the debt can only shrink — a tracked burn-down, not silencing. Tier-1 codegen+ESLint make-impossible (typed documents → compile error) and the per-module remediation of the 135 are tracked follow-on work (plan: `/root/.claude/plans/deep-humming-panda.md`, Workstream A).

Status: IN-PROGRESS (2026-06-24; enforcement gate landed this commit; 135 burn-down + codegen-tier-1 ongoing per the plan). Registry: orphan-findings.md only.

---

## ORPHAN-HIGH-155 - SUPER_ADMIN act-as tenant never reached subgraphs → non-deterministic empty/wrong-schema reads

Severity: HIGH. Root cause of the operator's "tenant panel data sometimes loads, sometimes not" + "Failed to load X: Tenant ID is required". A SUPER_ADMIN has JWT `tenantId = null` and "acts as" a tenant; the browser sent the selection in `x-tenant-id`, but `StripInternalHeadersMiddleware` deletes it, `/graphql` skipped tenant resolution, and the gateway signed the HMAC user-assertion with `effectiveTenantId = user.tenantId` (null) (`authenticated-data-source.ts`, `service-proxy.service.ts`). With no tenant reaching the subgraph, the per-connection `search_path` + RLS GUC (`app.current_tenant`) were left to whatever the pooled connection last held → ~25-30% of tenant-scoped reads hit the source/empty schema (0 rows, faster) while others succeeded.

**Fix (this commit):** the gateway is now the SINGLE tenant-resolution authority. NEW `apps/gateway-api/src/middleware/effective-tenant.middleware.ts` — `CaptureRequestedTenantMiddleware` (captures the act-as before strip) + `EffectiveTenantMiddleware` (after JWT auth) resolve ONE `req.effectiveTenantId`: regular user → JWT tenantId (a divergent act-as → 403); SUPER_ADMIN → the act-as ONLY after UUID + tenant-ACTIVE (fail-closed in prod) + MFA-step-up validation; else system scope (fail-closed). `authenticated-data-source.ts` + `service-proxy.service.ts` sign `effectiveTenantId` from `req.effectiveTenantId` and forward `x-tenant-id` from it (assertion + wire agree). `request-context.middleware.ts` reads the verified `req.tenantId` (signed-assertion value) BEFORE any header — so the RLS GUC + search_path use the signed effective tenant (MT-CRITICAL-101). Verified by two security audits (no cross-tenant leak; regular users unaffected). Tests: `effective-tenant.middleware.spec.ts` (cross-tenant 403, validated act-as, fail-closed) + invariant `tests/invariants/tenant-context-ssot.spec.ts` (wiring/order/signing).

Status: RESOLVED (2026-06-24; gateway-signed effectiveTenantId SSoT). Registry: orphan-findings.md only.

---

## ORPHAN-HIGH-156 - five tenant-scoped subgraphs do not mount VerifiedUserAssertionMiddleware (SSoT/DiD gap)

Severity: HIGH (no live leak — tracked hardening). Found by the [[ORPHAN-HIGH-155]] security audit. `VerifiedUserAssertionMiddleware` is mounted only on `farm-service` + `config-service`; `sensor-service`, `hr-service`, `hydroponics-service`, `alert-engine`, `messaging-service` do NOT mount it. On those, `req.tenantId`/`req.user` are not set from the signed assertion, so the ORPHAN-155 `request-context.middleware.ts` "verified-first" read is a no-op there and tenant isolation rests entirely on the HMAC-bound `x-tenant-id` header (set + verified by `StripInternalHeadersMiddleware` — safe TODAY, not externally forgeable). The gap: SSoT is not uniform, and `req.user` is undefined on those subgraphs (object-level guards have no user). Fix (own follow-up — needs per-service TenantGuard-behavior testing, must NOT be done blind): mount `VerifiedUserAssertionMiddleware` BEFORE `RequestContextMiddleware` in all five `app.module.ts` (mirror `farm-service/src/app.module.ts`), ideally promoted into the shared bootstrap so a new subgraph cannot omit it.

Owner: platform/tenant-isolation. Deadline: 2026-07-08. Status: RESOLVED (2026-06-26 — VERIFIED ALREADY DONE on main (commit 6a7aaf9b0): all NINE tenant-scoped subgraphs (farm/config/billing/sensor/hr/hydroponics/alert-engine/messaging/ai) mount VerifiedUserAssertionMiddleware, and tests/invariants/verified-user-assertion-mounted.spec.ts enforces both presence AND middleware order (after StripInternalHeadersMiddleware, before UserContextMiddleware). The finding text ("five subgraphs miss it") is stale) (tracked; safe today via HMAC-bound header). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-157 - gateway RequestContextMiddleware seeds ALS tenant from the raw (pre-strip) x-tenant-id header

Severity: MEDIUM (log integrity / latent footgun — no DB leak). At the gateway, `RequestContextMiddleware` runs before `StripInternalHeaders`/`EffectiveTenantMiddleware`, so the ORPHAN-155 "verified-first" read falls through to the raw, attacker-controllable `x-tenant-id` header for the gateway's own AsyncLocalStorage tenant. Harmless today (the gateway has no RLS connection pool / no audited handlers), but it poisons gateway-side log tenant attribution and would silently become a cross-tenant vector if anyone ever adds an RLS pool or audited handler to the gateway. Fix: move `RequestContextMiddleware` after `EffectiveTenantMiddleware` at the gateway, or have `EffectiveTenantMiddleware` update the ALS tenant to the resolved `effectiveTenantId`.

Owner: platform/gateway. Deadline: 2026-07-15. Status: RESOLVED (2026-06-26 — VERIFIED mitigated + tested on main: EffectiveTenantMiddleware.setEffectiveTenant patches the ALS getRequestContext().tenantId to the VERIFIED effectiveTenantId (regular user = own tenant; SUPER_ADMIN act-as = TARGET tenant) before any handler runs, superseding the raw pre-strip host seeded by RequestContextMiddleware. Covered by the existing "A.4 — ALS logging-frame enrichment" tests in effective-tenant.middleware.spec.ts (asserts ALS tenantId == effective tenant, not the raw header). Harmless today (gateway has no RLS pool/audited handlers); the patch keeps it correct if those land later) (tracked; pre-existing log-scope behavior). Registry: orphan-findings.md only.

---

## ORPHAN-LOW-158 - assertion↔signed-service-tenant cross-check is now tautological on the federation path

Severity: LOW (defense-in-depth reduction, not a leak). `verified-user-assertion.middleware.ts` cross-checks `assertion.effectiveTenantId` against the HMAC-signed service tenant; after [[ORPHAN-HIGH-155]] the gateway sources both from the single `req.effectiveTenantId`, so the check always passes and can no longer catch a buggy/compromised gateway emitting inconsistent values. The HMAC still prevents an EXTERNAL party from introducing a mismatch (both are signature-bound), so this is acceptable. Fix (optional): have the subgraph independently recompute/compare, or drop the now-redundant check with a note.

Owner: platform/tenant-isolation. Deadline: 2026-07-22. Status: OPEN (tracked; acceptable). Registry: orphan-findings.md only.

---

## ORPHAN-HIGH-159 - SUPER_ADMIN cannot deterministically view a tenant (token carries no tenant) — the FE half of tenant-context SSoT

Severity: HIGH. Live-trace + DB confirmed root cause of the operator's persistent "tenant panel data sometimes loads, sometimes not": `by-okan` is a SUPER_ADMIN with `tenantId = NULL`, and there is NO tenant-selector — `setTenantId` is only ever called with `user.tenantId` (null), so the FE has no deterministic active tenant. Every tenant hook is gated on `enabled: !!token && !!tenantId` (`useDepartments.ts` et al.), so the queries either never fire (empty) or, when a stale tenant leaks into `localStorage('tenant_id')` across federated remotes, fire inconsistently. The gateway tenant-context SSoT ([[ORPHAN-HIGH-155]]) correctly validates + signs a tenant WHEN one is sent, but a SUPER_ADMIN never reliably sent one — and per-remote active-tenant state would itself race ("bir geliyor bir gelmiyor").

**Fix (Option B — token IS the source of truth):** auth-service `switchTenant` mutation re-mints a tenant-scoped token (`tenantId` = target + `actAsTenantId` claim) after SUPER_ADMIN + tenant-ACTIVE (fail-closed) validation + `SUPER_ADMIN_TENANT_SWITCH` audit. Because the token carries the tenant, EVERY federated remote's `useAuth().tenantId`, the gateway-signed assertion, the RLS GUC and search_path all resolve to one deterministic tenant — no cross-remote state race.

**Backend landed this commit:** `TokenService.generateTokens({ actAsTenantId })` + `AuthenticationService.switchTenant()` + `auth.resolver.switchTenant` mutation (auth-gated, rate-limited, SkipTenantGuard) + 4 unit tests (mint / non-SUPER_ADMIN→403 / suspended→403 / missing→403). **Remaining:** the FE tenant-switcher (SUPER_ADMIN header control that calls the mutation, stores the token, reloads) — the operator-facing half; plus MFA TOTP step-up before the switch.

Owner: platform/tenant-isolation + frontend. Deadline: 2026-07-08. Status: IN-PROGRESS (auth backend + tests landed; FE switcher next). MFA step-up sub-item tracked here. Registry: orphan-findings.md only.

---

## ORPHAN-HIGH-160 - logout on every page refresh + intermittent data — refresh-token cookie ":" URL-encoded, breaking the server-side token split

Severity: HIGH. Operator-reported: a normal browser refresh logs the user out (must re-login), and the tenant panel data "comes and goes". Live-reproduced + root-caused against the TENANT_ADMIN account (`codex-test-…@suderra.test`, tenant 7f6b).

**Root cause:** the refresh-token value is `${userId}:${random}` (`token.service.ts`). Express's default cookie encoder (`encodeURIComponent`) serialises the ':' as '%3A'. Across the browser → nginx → gateway-forward → auth hops the value is NOT decoded symmetrically before it reaches `AuthenticationService.refreshTokenWithHash`, whose `plainToken.indexOf(':')` therefore finds no ':' — it derives the wrong `tokenPart`, and `bcrypt.compare` never matches a (perfectly valid) stored token. PROOF: `decodeURIComponent(cookie).split(':')[1]` bcrypt-matches a live non-revoked stored hash (1 of 6), while the raw '%3A' value matches none. So EVERY silent refresh (`tokenLifecycle.initialize` → `silentRefresh`) fails → the access token (in-memory only) is never restored → logout on refresh; and once the 15-min access token expires mid-session, queries 400 with "Verified user assertion is required" (gateway sends no assertion without `req.user`) until the user re-logs-in — the "bir geliyor bir gelmiyor".

**Fix (this commit):** (1) ROOT — `buildRefreshTokenCookieOptions` sets `encode: (v) => v` (identity), so the ':' (a valid RFC 6265 cookie-octet) is never URL-encoded and the SSoT token survives every transport hop byte-for-byte. (2) Migration/defense — `decodeRefreshTokenTransport()` recovers the canonical token at `refreshToken()` entry (idempotent for a raw token, guarded against malformed escapes), so cookies minted before this fix keep working with no forced re-login. Unit tests for both.

Status: RESOLVED (2026-06-25; cookie-encoding SSoT + canonical-decode). Registry: orphan-findings.md only.

---

## ORPHAN-HIGH-161 - tenant-admin DB table viewer leaks cross-tenant rows for camelCase "tenantId" tables

Severity: HIGH (cross-tenant data exposure). Found while validating the tenant-context stabilization plan against the code.

**Root cause:** `apps/auth-service/src/modules/tenant/services/tenant-admin.service.ts:getTableData` treated ONLY the snake_case `tenant_id` column as the tenant filter (`hasTenantId = columns.includes('tenant_id')`). A table reachable via an allowed *module/shared* schema whose tenant column is the camelCase quoted `"tenantId"` (the TypeORM default for many entities) — or that has no tenant column at all — was read with NO `WHERE` clause, returning EVERY tenant's rows to one tenant-admin.

**Fix (this commit):** detect the tenant column under both names (`tenant_id` | `tenantId`, hard-coded literals so interpolation stays injection-safe); the tenant's DEDICATED `tenant_<uuid>` schema is itself the isolation boundary (no row filter needed); every other (shared module) schema MUST be tenant-filtered and **FAILS CLOSED** (`ForbiddenException`) when no tenant column exists, rather than returning another tenant's data. Unit tests cover camelCase-filtered / snake-filtered / fail-closed / dedicated-schema-unfiltered.

Status: RESOLVED (2026-06-25). Registry: orphan-findings.md only.

---

## ORPHAN-HIGH-162 - gateway→subgraph HMAC body-hash drift between StripInternalHeadersMiddleware and ServiceIdentityGuard (intermittent "assertion required" 400)

Severity: HIGH (intermittent auth/data outage). Found while validating the tenant-context stabilization plan.

**Root cause:** the gateway signs `X-Service-Body-Hash = sha256(wire-bytes)`. `ServiceIdentityGuard.serializeBodyForHash` correctly hashed `req.rawBody` (the wire bytes), but `StripInternalHeadersMiddleware.serializeBodyForHash` independently hashed `JSON.stringify(req.body)` (the re-serialized V8-parsed object). When the two byte strings diverged (key order of numeric-string keys, `1.0` vs `1`, whitespace) the Strip middleware's HMAC verify failed, it stripped `x-verified-user-assertion`, and the subgraph 400'd "Verified user assertion is required" — intermittently. Two independent copies of the body-hash logic were free to drift (and did).

**Fix (this commit):** extract ONE shared `serializeServiceIdentityBodyForHash()` in `service-identity.util.ts` (rawBody-preferred, JSON.stringify fallback) and route BOTH `ServiceIdentityGuard` and `StripInternalHeadersMiddleware` through it — making the two receivers structurally incapable of diverging again (tier-1). Unit tests prove rawBody is preferred over a divergently-stringified body + the fallback path; the guard's existing Path-alpha suite still passes.

Status: RESOLVED (2026-06-25). Registry: orphan-findings.md only.

---

## ORPHAN-HIGH-164 - FE tenant-scoped pages/hooks fire GraphQL before the tenant context is ready

Severity: HIGH (intermittent empty/401 on tenant-scoped pages). Found validating the tenant-context stabilization plan; contributes to the operator's "data comes and goes" on /sites and /sensor/*.

**Root cause:** several tenant-scoped surfaces issue their GraphQL load from a bare mount `useEffect` with NO auth-readiness guard, so they fire BEFORE `token`/`tenantId` resolve — racing the auth lifecycle (401/empty) and querying with a null tenant. The correct pattern (e.g. `web/modules/sensor-module/src/hooks/useEdgeDevices.ts`) gates on `enabled: !!token`. Offenders: `web/modules/farm-module/src/pages/MapViewPage.tsx` (the /sites/map view), and `web/modules/sensor-module/src/hooks/{useSensorList,useScadaPackage(useScadaPackages+useScadaPackageById),useProcess(useActiveProcesses+useProcessById)}.ts`.

**Fix (this commit):** gate each mount `useEffect` on `token && tenantId` (via `useAuth()`) and add `token`/`tenantId` to the dependency array so it (re)runs when the tenant becomes ready or changes; on a null tenant it resets to empty + does not fetch. MapViewPage also guards async setState with a cancelled flag. Minimal change — query strings/filters/pagination/debounce/return shapes unchanged. tsc clean (farm-module + sensor-module).

**Remaining WS-B (tracked, follow-up):** the tenant `|| 'default'` localStorage-key bleed (B2, MEDIUM — only manifests on a null/changing tenant), the tenant-admin custom client → shared lifecycle (B3, MINIMAL for single-tenant TENANT_ADMIN), socket tenant-scoping (B7), and promoting the no-bare-tenant-query-key / no-bare-graphql-query-string ESLint rules warn→error behind a baseline (B4).

Status: RESOLVED for the mount-race surfaces above (2026-06-25); WS-B remainder tracked here. Registry: orphan-findings.md only.

---

## ORPHAN-HIGH-163 - gateway→subgraph verified-user assertion only mounted on 2 of 9 tenant-scoped subgraphs (SEC-HIGH-156)

Severity: HIGH (weaker-than-necessary tenant trust boundary). Found validating the tenant-context stabilization plan.

**Root cause:** only `farm` + `config` mounted `VerifiedUserAssertionMiddleware`; the other seven tenant-scoped subgraphs (`sensor`, `billing`, `hr`, `hydroponics`, `alert-engine`, `messaging`, `ai`) resolved `req.user`/`req.tenantId` from the legacy path (raw JWT via the auth guard + a separately-trusted `x-tenant-id` header) rather than the gateway-signed `x-verified-user-assertion`, which binds the user AND the effective tenant into one HMAC-signed blob. Functionally they worked, but the surface was larger than the SSoT design (SEC-HIGH-156). The shared middleware also carried farm-specific names/messages (`FarmVerifiedIdentity`, "Farm request requires service identity") despite living in `backend-common`.

**Fix (this commit):**
- Mounted `VerifiedUserAssertionMiddleware` on all seven, after `StripInternalHeadersMiddleware` (which sets `req.verifiedIdentity`) and before `UserContextMiddleware`. `sensor` and `billing` use a 3-way split so the middleware is `.exclude()`d from their non-gateway public routes — sensor `/mqtt/*` (Mosquitto go-auth) and billing `/api/v1/webhooks/*` (Stripe) — which carry no gateway service identity and would otherwise 500 (both prefixed + prefix-stripped forms excluded, fail-safe). The other five take a simple insert.
- Genericized the shared contract: `FarmVerifiedIdentity` → `VerifiedUserAssertion`; "Farm request…" / "gateway farm requests" → neutral "Subgraph request…" / "gateway subgraph requests".
- New invariant `tests/invariants/verified-user-assertion-mounted.spec.ts` enforces the mount + order on all nine subgraphs so it cannot regress.

Status: RESOLVED (2026-06-25; closes SEC-HIGH-156). Registry: orphan-findings.md only.

---

## ORPHAN-HIGH-165 - a token could be minted for a non-SUPER_ADMIN principal with no tenant (WS-C / C1)

Severity: HIGH (tenant-isolation invariant). Found validating the tenant-context stabilization plan.

**Root cause:** `TokenService.generateTokens` computed `effectiveTenantId = actAsTenantId ?? user.tenantId ?? null` and minted the token regardless. SUPER_ADMIN is legitimately tenantless, but EVERY other role is tenant-scoped — if such an account ever resolved to a null tenant (data corruption, a bad provisioning path, a future bug), the token would carry `tenantId: null` and downstream tenant routing (search_path / RLS / TenantGuard) would silently fall back to an unscoped context — a cross-tenant hazard. There was no guard enforcing the invariant at the single choke point where every token is minted.

**Fix (this commit):** in `generateTokens`, after resolving `effectiveTenantId`, fail closed when `user.role !== Role.SUPER_ADMIN && !effectiveTenantId` (`ForbiddenException`). SUPER_ADMIN (the only tenantless role, confirmed against the live DB) is unaffected; every tenant-scoped login already resolves a tenant so legitimate logins are untouched. Unit tests: non-SUPER_ADMIN/null → throws; TENANT_ADMIN/null → throws; SUPER_ADMIN/null → still issues (existing test).

**point-5 (tenant-admin backend SUPER_ADMIN-closed) — already satisfied:** `TenantAdminService` methods reject a null-tenant caller (`if (!admin || !admin.tenantId) throw`), and `getTableData` is fail-closed (ORPHAN-HIGH-161), so a SUPER_ADMIN (tenantId=null) cannot read tenant data through the tenant-admin surface — it errors "Admin not found".

**Remaining WS-C (tracked, follow-up):** retire the dormant `switchTenant` mutation + `actAsTenantId` claim (the SUPER_ADMIN tenant-switcher was removed in #627; the backend surface is unused but harmless — a careful security-code removal, not a bug fix).

Status: RESOLVED for C1 + point-5 (2026-06-25); switchTenant retirement tracked. Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-166 — `PLAN_FEATURES` per-plan feature catalog hand-copied (sibling of SSOT-C-13)

**Severity:** MEDIUM
**Discovered:** 2026-06-25, during SSOT-C-13 plan-limit SSoT collapse (ADR-037)
**Note:** renumbered from a transient 160 (merge-train NNN collision with ORPHAN-HIGH-160).
**Files:**
- `apps/gateway-api/src/middleware/tenant-context.middleware.ts` (`PLAN_FEATURES`)
- `apps/gateway-api/src/services/tenant-lookup.service.ts` (`PLAN_FEATURES`, byte-identical copy)

**Problem:** While collapsing the FIVE per-plan *limit* catalogs into the canonical
`PLAN_CATALOG` SSoT (ADR-037, `libs/event-contracts/src/billing/plan-catalog.ts`),
a sibling drift remains: per-plan *feature* booleans (`TenantFeatures`:
`advancedAnalytics`, `alertEngine`, `iotIntegration`, `apiAccess`, `customReports`,
`multiSite`, `whiteLabeling`, `ssoEnabled`) are still hand-copied across the gateway
middleware and tenant-lookup service. Same hand-copied-catalog anti-pattern, one layer
over (features instead of limits).

**Why not fixed in ADR-037:** Different shape and concern. `TenantFeatures` partially
overlaps the canonical `PlanLimits` capability booleans (`apiAccessEnabled`,
`ssoEnabled`, `customBrandingEnabled`) but adds a distinct set. Folding it correctly
means a deliberate features-SSoT design — extend `PLAN_CATALOG` with a typed `features`
sub-object or add a sibling `PLAN_FEATURE_CATALOG` in event-contracts — not an in-scope
side effect of the limit collapse.

**How to fix:** Add a canonical per-plan feature map in `@platform/event-contracts`
(reconcile the overlapping booleans with `PlanLimits` so a capability isn't defined
twice), project the gateway `TenantFeatures` from it, delete both copies, and add the
per-tier-map invariant guard to forbid a future copy.

Owner: platform/multi-tenant + gateway. Status: RESOLVED (2026-06-26 — PLAN_FEATURES consolidated — middleware now exports the single per-plan map, tenant-lookup imports it (identical 2nd copy deleted); locked by tests/invariants/plan-features-ssot.spec.ts (exactly-one-declaration). gateway-api tsc + permission.guard 48/48). Registry: orphan-findings.md only.

---

## ORPHAN-HIGH-166 - logout on EVERY refresh — refresh-token lookup blocked by tenant RLS (the real root; completes ORPHAN-HIGH-160)

Severity: HIGH (every authenticated session logs out on refresh). The operator's #1 reported bug. ORPHAN-HIGH-160 (#629) fixed a real but SECONDARY layer (the cookie `:`→`%3A` encoding); this is the actual root, found by live forensics (HTTPS browser-path reproduction + in-container instrumentation + DB-role simulation).

**Root cause:** `auth.refresh_tokens` has FORCED row-level security (`tenant_isolation_policy`: `current_setting('app.bypass_rls')='on' OR "tenantId" = current_setting('app.current_tenant')::uuid`). The runtime DB role `auth_service` does NOT bypass RLS (`rolbypassrls=f`). A refresh request is **pre-tenant** — the refresh token IS the credential, so the tenant is unknown until the row is found — therefore `app.current_tenant` is unset and no bypass is requested. `AuthenticationService.refreshToken` / `refreshTokenWithHash` ran their lookup transaction with NEITHER GUC, so under RLS the query returned ZERO rows for a perfectly valid token → no bcrypt match → "Authentication failed" → `tokenLifecycle.silentRefresh` could not restore the access token → logout on every refresh.

PROOF (live): the cookie token bcrypt-matches a current non-revoked row when queried as the RLS-bypassing owner (`aquaculture`), but the same query as `auth_service` with no `app.current_tenant` GUC returns 0 rows; in-container instrumentation confirmed `refreshTokenWithHash` received the correct tokenPart yet its query found nothing; `SET ROLE auth_service; SET app.bypass_rls='on'` makes the rows visible again. (`auth.users` RLS was already dropped — `DropRlsFromAuthUsersIdentity` — which is why LOGIN works while REFRESH did not.)

**Fix (this commit):** wrap both refresh paths in `BypassRlsService.withBypass('auth-service:refresh-token-rotation', …)` — the same audited primitive the SUPER_ADMIN platform-session path already uses. `RlsModule.forPoolService({serviceName:'auth'})` + `RlsConnectionBootstrap` then emit `set_config('app.bypass_rls','on', …)` on the transaction's connection. The refresh-token lookup is legitimately cross-tenant (possession of the exact token + the bcrypt match is the authorization), so the audited bypass is the architecturally-correct mechanism. Unit regression guard asserts `refreshToken` runs under `withBypass` with that label; existing refresh tests still pass; auth `tsc` clean.

Status: RESOLVED (2026-06-25; RLS-bypass for pre-tenant refresh rotation). Closes the logout-on-refresh that ORPHAN-HIGH-160 only partially addressed. Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-167 - FE `tenantId || 'default'` localStorage keys bleed UI state across tenants (WS-B B2/B4)

Severity: MEDIUM (cross-tenant UI-state bleed during the null/changing-tenant window). Found validating the tenant-context stabilization plan.

**Root cause:** seven FE surfaces built a localStorage/cache key as `${prefix}_${tenantId || 'default'}` / `getTenantId() || 'default'`. When `tenantId` is briefly null (initial load, tenant switch) every session shares one `default` bucket, so tenant A's persisted UI state (dashboard layout, column visibility, theme, chart-collapse, analytics filters, offline nutrient profiles) bleeds into tenant B. `web/modules/{sensor-module,farm-module,hydroponics-module}` — `SimulationSidebar`, `WidgetDashboardPage`, `ThemeProvider`, `TanksAnalyticsTab` (also a stale empty-dep `useMemo`), `useColumnVisibility`, `TankChartsSection`, `useNutrientProfiles`.

**Fix (this commit):** adopt the existing canonical `tenantScopedStorageKey(baseKey, tenantId)` (web/shared-ui) — it returns `aqua.tss::<tenantId>::<baseKey>` or `null` when tenantId is absent; every call site now skips localStorage on `null` and uses the in-memory default, so no shared `default` bucket can exist. Exported the helper from shared-ui. TanksAnalyticsTab's stale empty-dep tenant memo is made reactive (`useAuth().tenantId`). New invariant `tests/invariants/no-default-tenant-storage-key.spec.ts` (B4) fails the build if any `getTenantId()/tenantId || 'default'` reappears in `web/` (it is at zero now). tsc clean across shared-ui + the 3 modules.

**Tracked WS-B remainder:** B3 (tenant-admin custom client → shared graphqlClient lifecycle/CSRF/401-refresh), B7 (sensor WebSocket pool tenant-scoping + logout cache sweep via `sweepTenantScopedStorage`), and promoting the existing `no-bare-tenant-query-key` / `no-bare-graphql-query-string` ESLint rules warn→error (needs the ~420 + ~50 pre-existing violations migrated first).

Status: RESOLVED for B2 + the B4 default-fallback guard (2026-06-25). Registry: orphan-findings.md only.

---

## ORPHAN-LOW-168 - TanStack Query cache not cleared on logout (cross-tenant cache defence)

Severity: LOW (defence-in-depth; the tenant-scoped query-key factory already isolates most caches by `['tenant', tenantId, …]` — this closes the residual NON-tenant-keyed-query window).

**Root cause:** the shared `AuthProvider`'s SPA logout path (`web/shared-ui/src/contexts/AuthContext.tsx`) calls `logoutCleanup()` but never passed/cleared the in-memory TanStack `QueryClient`. The SPA logout dispatches `LOGOUT` without a full page reload, so the QueryClient survives; a subsequent login on the same browser could read the previous user's cached tenant data for any query that wasn't tenant-keyed. `logoutCleanup` already clears sessionStorage / Zustand / SW caches / indexedDB / tenant-scoped localStorage and invokes registered callbacks, but the QueryClient was never wired in.

**Fix (this commit):** register `queryClient.clear()` as a logout-cleanup callback in the shell bootstrap (`web/shell/src/bootstrap.tsx`, where the QueryClient is created) via the existing `registerLogoutCleanup` mechanism — NOT via `useQueryClient()` inside the shared `AuthProvider`, which would throw for consumers that mount it without a `QueryClientProvider` (e.g. dashboard standalone, aquamobil uses its own AuthProvider). shell `tsc` clean.

Status: RESOLVED (2026-06-25). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-169 - retire the dormant SUPER_ADMIN `switchTenant` act-as surface (WS-C C2)

Severity: MEDIUM (security hygiene — an auth-gated cross-tenant token-mint that no client can reach is latent attack surface). The FE SUPER_ADMIN tenant-switcher was removed in #627 (product rule: a SUPER_ADMIN manages the platform; a TENANT_ADMIN enters data in its own module-scoped panel), leaving the `switchTenant` mutation + the `actAsTenantId` token claim dormant.

**Evidence it is dormant:** no FE `switchTenant` GraphQL mutation call exists anywhere in `web/` (the `useTenant`/`TenantContext` `switchTenant` is a separate unimplemented stub, never invoked); and the `actAsTenantId` JWT claim is WRITE-ONLY — set in `TokenService.generateTokens` but read by NOTHING across apps/libs/platform (the gateway's act-as is header-based via `effective-tenant.middleware`, a separate mechanism, untouched).

**Fix (this commit):** remove `AuthResolver.switchTenant` (the `@Mutation`), `AuthenticationService.switchTenant`, the `generateTokens({ actAsTenantId })` option, the `actAsTenantId` field on `JwtPayload`, and the act-as branch in the JWT payload — `effectiveTenantId` now simplifies to `user.tenantId ?? null`. The `me` effective-tenant behaviour (#625) is KEPT and re-documented: `me` reports the JWT tenant claim (the session SSoT), which for a normal user equals the DB tenant and for a SUPER_ADMIN is null — correct and now independent of any act-as. switchTenant unit tests removed; the `me` tests retained + reworded; auth `tsc` clean; auth spec 33/33 green. The header-based gateway act-as (`x-act-as-tenant` / `effective-tenant.middleware`, #622) is OUT OF SCOPE and untouched.

Status: RESOLVED (2026-06-25; backend act-as token surface retired). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-170 - tenant-admin GraphQL client bypassed the shared auth lifecycle (WS-B B3)

Severity: MEDIUM (the tenant-admin surface — used by a TENANT_ADMIN to manage its own tenant — could fire GraphQL before the access token was restored, and never auto-recovered from a 401, manifesting as the intermittent empty/failed panel loads).

**Root cause:** `web/modules/tenant-admin/src/services/api-client.ts` `TenantApiClient.graphql<T>` did a RAW `fetch('/graphql', { credentials:'include', headers:{Authorization, X-Tenant-Id} })`. It LACKED the three guarantees the shared `graphqlClient` provides: `tokenLifecycle.waitForReady()` (a barrier so no request fires before the in-memory token is restored on page load — directly relevant to the refresh/restore race), `attachCsrfHeader`, and the `401 → refresh → retry-once` recovery.

**Fix (this commit):** `TenantApiClient.graphql` now delegates to the shared `graphqlClient.request<T>(query, variables)` (same signature), inheriting waitForReady + CSRF + 401-retry; the raw fetch, manual headers, and ad-hoc HTTP/GraphQL error handling are removed. The class, its singleton `apiClient`, the public method shape, and all callers (`lib/api.ts`, `services/index.ts`, `tenant-api.service.ts`, `hooks/useTenantData.ts`) are unchanged. tenant-admin `tsc` clean.

**Tracked WS-B remainder:** B7 (sensor WebSocket pool tenant-scoping), and promoting `no-bare-tenant-query-key` / `no-bare-graphql-query-string` ESLint rules warn→error once the pre-existing violations are migrated.

Status: RESOLVED for B3 (2026-06-25). Registry: orphan-findings.md only.

---

## ORPHAN-LOW-171 - gateway ALS logging frame missed the effective tenant for a SUPER_ADMIN act-as (WS-A.4)

Severity: LOW (observability correctness — no data-isolation impact; the gateway does no DB RLS). Raised by the 2nd-agent plan review (point 4).

**Root cause:** in `apps/gateway-api/src/app.module.ts` the middleware order is `RequestContextMiddleware → CaptureRequestedTenant → Strip → … → EffectiveTenantMiddleware`. `RequestContextMiddleware` establishes the AsyncLocalStorage logging frame FIRST, reading the tenant only from the JWT (`x-user-payload`). `EffectiveTenantMiddleware` runs later and computes the EFFECTIVE tenant (which, for a SUPER_ADMIN acting-as a tenant via the still-supported header path, differs from the null JWT tenant) but only wrote `req.effectiveTenantId` — it never updated the ALS frame. So every gateway log line for a SUPER_ADMIN act-as was attributed to the wrong (null/JWT) tenant.

**Fix (this commit):** `EffectiveTenantMiddleware` now enriches the live ALS frame — `getRequestContext().tenantId = effectiveTenantId` — via a `setEffectiveTenant()` helper applied at every effective-tenant assignment. `getRequestContext()` returns the live mutable store and `StructuredLoggerService` reads `ctx.tenantId` at log time, so all subsequent log lines carry the effective tenant. Chosen over REORDERING the critical auth middleware chain (which would establish the correlation frame too late for Capture/Strip/EffectiveTenant). Safe no-op when no ALS frame is active. 3 enrichment unit tests added (regular user, SUPER_ADMIN act-as → target, no-frame no-op); gateway `tsc` clean; spec 15/15.

Status: RESOLVED (2026-06-25; ALS-frame enrichment, no chain reorder). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-172 - sensor Socket.IO pool keyed by URL only → cross-tenant realtime bleed (WS-B B7)

Severity: MEDIUM (realtime cross-tenant bleed). The sensor-module Socket.IO connection pool (`web/modules/sensor-module/src/hooks/socketFactory.ts`) keyed entries by **URL only** (`pool.get(url)`). A connected socket keeps its original `auth` until it disconnects, so after logout → re-login (same browser, different tenant) `getSocket(url)` returned the EXISTING socket still bound to the previous tenant's session — leaking tenant A's realtime stream (sensor readings, alarms, edge I/O, SCADA live data) to tenant B. The pool also never tore down on logout.

**Fix (this commit):** (1) tenant-scope the pool key via a `poolKey(url, tenantId)` SSoT helper (`${url}::${tenantId}`) applied at every get/set/release site, with `getSocket` returning `null` when there is no `tenantId` (mirrors the existing no-token guard — no tenant-scoped realtime socket without a tenant); refcounting stays balanced because the URL+tenant are fixed for a live session. (2) `teardownAllSockets()` (disconnect every pooled socket + clear the Map) registered once via `registerLogoutCleanup`, so logout fully severs all realtime connections before a different user can log in. No `PoolEntry`/signature change; the four callers (`useSensorSocket`, `useEdgeIoSocket`, `useAlarmRuntime`, `useScadaLiveData`) are unchanged. sensor-module `tsc` clean; no new `as any`.

Status: RESOLVED for B7 (2026-06-25). Registry: orphan-findings.md only.

---

## ORPHAN-LOW-173 - E2E regression coverage for the tenant-context intermittency (WS-D)

Severity: LOW (test coverage — locks in the session's tenant-context fixes against regression). Directly reproduces the operator's reported "data comes and goes" (bir geliyor bir gelmiyor).

**Gap:** the existing `e2e/tests/integration/data-isolation-chain.spec.ts` proved single-shot tenant A/B isolation but never exercised the INTERMITTENCY — the operator's symptom was a query that returned data on one request and empty/400 on the next, under the refresh/assertion/schema-routing races now fixed by #622 (gateway effectiveTenantId), #630/#631 (HMAC raw-body SSoT + 9-subgraph verified-user-assertion), and #634 (refresh RLS bypass).

**Fix (this commit):** extend that suite with a `tenant-context stability under repeated load (WS-D)` block that fires the real `tenantUsers` query 30× SEQUENTIALLY and 30× CONCURRENTLY as Tenant A — asserting every response returns A's data with no GraphQL error (no intermittent empty/"assertion required" 400) and never B's rows — plus a 30× INTERLEAVED A/B run asserting no cross-tenant bleed. Reuses the existing harness (`loginAs`, `queryTenantUsers`, `hasGraphQLError`) and the A/B tenants seeded in `beforeAll`; runs in the `e2e-tests.yml` workflow against a live stack.

Status: RESOLVED (2026-06-25; intermittency regression coverage added). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-174 — scheduled plan downgrade does not sync the price at Stripe when the scheduler applies it

**Severity:** MEDIUM. **Discovered:** 2026-06-25 (W1.1 change-subscription-plan Stripe rewrite, SSOT-C-12). PR-3 commit messages reference earlier collision numbers (168/171/172).
**File:** `apps/billing-service/src/billing/billing-scheduler.service.ts` (PENDING scheduled-plan-change apply path).

change-subscription-plan syncs the Stripe price for IMMEDIATE changes via StripeApiService.updateSubscription, but a DOWNGRADE is deferred to period end as a ScheduledPlanChange; the billing scheduler cron applies it WITHOUT calling updateSubscription, so the Stripe subscription keeps billing the OLD price. Fix: in the scheduler apply path, when the subscription has a stripeSubscriptionId and the new plan has stripePriceIds[cycle], call StripeApiService.updateSubscription (idempotencyKey `sub-update:<stripeSubscriptionId>:<newPlanId>`) before the local commit. Owner: billing. Status: RESOLVED (2026-06-26 — billing-scheduler applyScheduledPlanChanges now injects StripeApiService + calls updateSubscription (same deterministic idempotency key as the immediate path) before the local mutation, fail-closed inside the tx; new test proves the Stripe sync. billing tsc clean).

## ORPHAN-MEDIUM-175 — create-subscription hard-deletes a CANCELLED subscription (test expects soft-delete / history preservation)

**Severity:** MEDIUM. **Discovered:** 2026-06-25 (W1.1 create-subscription Stripe rewrite, BILLING-CRITICAL-001). PRE-EXISTING: 2 tests fail on main today (git-stash verified 2 fail / 32 pass with the original handler).
**File:** `apps/billing-service/src/billing/handlers/create-subscription.handler.ts`.

On re-subscribe after a CANCELLED subscription the handler HARD-deletes the old row (avoids the UNIQUE(tenantId) index violation), but create-subscription.handler.spec.ts asserts SOFT-delete (history preservation). Out of SSOT-C-12 scope. Fix is a design call: (a) PARTIAL unique index `WHERE is_deleted=false` then soft-delete (needs migration), or (b) update tests to accept hard-delete. Owner: billing. Status: RESOLVED (2026-06-26 — create-subscription now SOFT-deletes the cancelled row (softDelete + save) instead of hard delete, and the existing-subscription lookup filters isDeleted=false; the partial unique index UQ_subscriptions_tenantId_active (WHERE is_deleted=false) frees the active slot. Previously-RED soft-delete test now green (36/36)).

---

## ORPHAN-MEDIUM-176 — gateway permission.guard hand-copies the canonical ROLE_HIERARCHY (string mirror, drift risk)

**Severity:** MEDIUM. **Discovered:** 2026-06-26, during PR-4 RBAC vocabulary unification (SSOT-H-06).
**File:** `apps/gateway-api/src/guards/permission.guard.ts:87` (`ROLE_HIERARCHY: Record<string, string[]>`).

After PR-4 deleted hr-service's forked Role enum + RolesGuard, the backend has ONE `Role`
enum and ONE `RolesGuard` (locked by `tests/invariants/rbac-vocabulary-ssot.spec.ts`).
But the gateway `permission.guard.ts` still defines its OWN `ROLE_HIERARCHY` as a STRING
mirror (`SUPER_ADMIN: ['TENANT_ADMIN','MODULE_MANAGER','MODULE_USER']`) — a hand-copy of
the canonical `ROLE_HIERARCHY` in `libs/backend-common/src/decorators/roles.decorator.ts`.
It is live (used by `permission.helpers.ts`), so a future edit to the canonical hierarchy
silently diverges from the gateway copy.

**Why not fixed in PR-4:** distinct from SSOT-H-06 (the HR guard fork). The gateway guard
mixes a role hierarchy with a separate permission map (`SUPER_ADMIN: ['*']`) and uses
string keys; re-sourcing needs the canonical `ROLE_HIERARCHY` imported + adapted (enum
values are already the matching strings) and the invariant extended to cover ROLE_HIERARCHY.
Owner: gateway/platform. Status: RESOLVED (2026-06-26 — gateway permission.guard now re-sources ROLE_HIERARCHY from the canonical @aquaculture/backend-common/decorators (string mirror deleted); gateway-api tsc clean). Registry: orphan-findings.md only. Relates: SSOT-H-07.

---

## ORPHAN-MEDIUM-177 - sensor process-editor route drift + redundant required `UpdateScadaPackageInput.id` (P1)

> NUMBERING: renumbered from 176 → 177 at merge time — a concurrent merge-train collision with the RBAC ROLE_HIERARCHY finding (ORPHAN-MEDIUM-176, above) which landed on `main` first. Commit `510c7f0a7`'s `Closes:` trailer was authored against the original #ORPHAN-MEDIUM-176 number.

Severity: MEDIUM (two operator-facing breakages — "New Process" navigation 404s, and SCADA-package update 400s). Validated from the multi-agent tenant-context plan's P1 list; verified firsthand in code.

**P1a — process-editor route drift.** The sensor module mounts the new-process editor at `process/new` (SINGULAR — `web/modules/sensor-module/src/Module.tsx:106`; `processes` plural is the LIST). Three links pointed at the non-existent `processes/new` → blank page: `ProcessTemplatesPage.tsx` (×2: the `handleUseTemplate` navigate + the empty-state Link) used `/sensor/processes/new`, and dashboard `QuickActions.tsx` ("Süreç Başlat") used the un-prefixed `/processes/new` (the sensor module is at `/sensor`, so no route matched at all). Fixed all three to `/sensor/process/new`.

**P1b — `UpdateScadaPackageInput.id` dual-source.** `updateScadaPackage(@Args('id') id, @Args('input') input)` (`process.resolver.ts`) looks the row up by the top-level `id` arg and the service NEVER reads `input.id`, yet `UpdateScadaPackageInput` also declared `@Field(() => ID) id!: string` (REQUIRED). The FE (`useScadaPackage.ts` `useUpdateScadaPackage`) sends only the top-level `$id`, never `input.id` — so the required input field rejected every SCADA-package update. Removed `id` from `UpdateScadaPackageInput` (SSoT = the resolver arg). No backend reader; `ID` import still used by other fields; sensor-service `tsc` clean. (No `codegen:check` CI gate + no sensor FE↔BE-parity invariant; the FE hook uses an inline input type, so the generated `graphql-types.ts` regenerates on the next full codegen — it does not gate this change. The supergraph recomposes at deploy.)

**Investigated, NOT confirmed (no change made):** (i) the alleged "uppercase status enum" drift — `ProcessStatus` backend enum VALUES are lowercase (`'active'`) matching the FE hand-written union, and the FE never round-trips ProcessStatus through GraphQL (not in generated types; only `ScadaPackageStatus`/`VfdChangeSetStatus` are GraphQL-status types), so no break exists. (ii) Map page "renders as empty when sites lack coordinates" — `MapViewPage.tsx` already shows a distinct "Konum bilgisi olan site bulunamadı" empty-state with a Setup link (not a no-data state); correctly handled.

Status: RESOLVED for P1a + P1b (2026-06-25). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-178 — db-migrate schema-registry hand-copies source-schema RLS excludeTables (parallel to the app.module set)

**Severity:** MEDIUM. **Discovered:** 2026-06-26 (PR-6 RLS excludeTables SSoT). Renumbered in the merge-train collision.
**File:** `apps/db-migrate/src/schema-registry.ts` (auth/billing/notification/config postMigrationHardening excludeTables).

PR-6 made service `app.module.ts` RLS excludeTables derive from `getRlsExcludeTablesForService('<svc>')`. db-migrate keeps a PARALLEL set for SOURCE-schema RLS of cross-tenant services (comment: "Mirrors the RlsModule.forPoolService excludeTables"). billing + notification are cleanly derivable and should be repointed; auth (domain tables users/tenants) + config (not in MODULE_SCHEMAS) stay literal. The auth db-migrate copy still carries the phantom audit_log/audit_logs. Owner: platform/db-migrate. Status: RESOLVED (2026-06-26 — dropped phantom audit_log/audit_logs from auth excludeTables in BOTH db-migrate SCHEMA_REGISTRY + auth app.module (synced); billing/notification had no excludeTables copy (only tenantRls). db-migrate+auth tsc clean).

## ORPHAN-LOW-179 — shared-schema canonical table list 4th unguarded copy + stale "4 canonical" docstring (3c)

**Severity:** LOW. **Discovered:** 2026-06-26 (PR-6 cluster 3c, deferred).
**Files:** `e2e/tests/integration/schema-invariants.spec.ts` (4th hardcoded copy; real count is 5: audit_logs, gdpr_data_requests, user_consents, user_permissions, access_logs); `libs/backend-common/.../audited-operation.interceptor.ts` (stale "4 canonical" docstring).

Collapse the unguarded 4th copy to import the `SHARED_SCHEMA_TABLES` SSoT; fix the stale count docstring to reference the SSoT by name. Owner: data/platform. Status: RESOLVED (2026-06-26 — e2e schema-invariants SHARED_SCHEMA_TABLES now derives from the PROTECTED_TABLES SSoT (the 4th unguarded copy collapsed), shared-schema-canonical/critical-infra 24/24. The audited-operation.interceptor cosmetic "4 canonical" docstring count is on a pre-existing eslint-disable line which the banned-construct gate forbids re-touching — left as-is; the real list lives in the SSoT).

---

## ORPHAN-MEDIUM-180 - farm read-through caches never invalidated → stale FCR/survival/growth (SSOT-H-18)

> NUMBERING: renumbered from 178 → 180 at merge time (concurrent merge-train collision with the db-migrate-RLS finding ORPHAN-MEDIUM-178 + ORPHAN-LOW-179 which landed on `main` first). Commits `a1b3eeb35`/`d2198dced` `Closes:` trailers were authored against the original #ORPHAN-MEDIUM-178 number.

Severity: MEDIUM (operator-visible stale data). Resolves SSOT-H-18 from `docs/reviews/2026-06-23-ssot-architecture-audit.md`.

**Root cause (Pattern A — built-but-unwired):** farm-service has exactly two `@Cacheable` read-through caches — `batchPerformance` (`prefix: 'batch:performance'`, 1h TTL — `batch/resolvers/batch.resolver.ts`) and `growthAnalysis` (`prefix: 'growth:analysis'`, 2h TTL — `growth/resolvers/growth.resolver.ts`). The `@CacheEvict` decorator + `CacheEvictInterceptor` are fully built AND registered (`common/cache/cacheable.module.ts` as an `APP_INTERCEPTOR`) but were used by ZERO resolvers. So a stat-mutating write left the cached result stale for the full TTL: `recordMortality`/`recordCull` change survival + biomass that `batchPerformance` (FCR, survival) serves; `recordGrowthSample`/`verifyMeasurement` change the dataset `growthAnalysis` computes from.

**Fix (this commit):** added `@CacheEvict({ prefixes: ['batch:performance'] })` to `recordMortality` + `recordCull`, and `@CacheEvict({ prefixes: ['growth:analysis'] })` to `recordGrowthSample` + `verifyMeasurement` — the interceptor evicts `farm:cache:<prefix>:t:<tenantId>:*` after the mutation commits, so the next read recomputes. **Tier-3 guard:** new invariant `tests/invariants/farm-cacheable-has-evict.spec.ts` fails the build if any farm `@Cacheable` prefix lacks a `@CacheEvict` naming it (closes the never-invalidated-cache class repo-wide; EXEMPT set is empty + documented). farm-service `tsc` clean; invariant + invariant-reachability green.

Status: RESOLVED (2026-06-26; both farm caches now evicted + guarded). Registry: orphan-findings.md only.

---

## ORPHAN-LOW-181 - GraphQL FE↔supergraph drift burndown: farm-module (3 of 5 fixed; 2 backend-gaps tracked)

Severity: LOW (FE GraphQL contract correctness — each drifted op 400s/partially-fails at the gateway). First slice of task #3 (burn down the 130-op `scripts/ci/graphql-fe-drift.baseline.json` per module; audit `docs/reviews/2026-06-24-graphql-fe-be-contract-drift-audit.md`).

**Fixed (FE over-selected fields the schema doesn't have → corrected; baseline 130 → 127):**
- `GetBatchFeedAssignment` (`useBatchFeedAssignments.ts`): removed `version` (not on `BatchFeedAssignmentResponse`) + the dead interface field. No reader.
- `CloseBatch` (`useBatches.ts`): removed `closedAt` (not on `Batch`); only reader was mock report data.
- `UpdateBatch` (`useBatches.ts`, SELECTION-SHAPE): flattened `fcr { target actual }` → `fcr` — `fcr` is a `JSON!` scalar, so sub-selection is invalid; the runtime value is unchanged (the FE's `batch.fcr?.target/.actual` JSON-object access still works). farm-module `tsc` clean.

**Tracked, NOT a simple removal (2 remain in baseline) — backend gap, not FE over-reach:** `ListSubEquipmentByParent` (`useSubEquipment.ts`) + `GetSubEquipmentByParent` (`useTankFeeders.ts`) query `category` on `SubEquipmentTypeResponse` and pass it as a `subEquipmentByParent` arg, but the backend DTO (`apps/farm-service/src/equipment/dto/sub-equipment.response.ts`) has no `category` (only id/name/code/compatibleEquipmentTypeCodes). The FE legitimately needs it — `useTankFeeders.ts:68` filters feeders by `subEquipmentType.category === 'feeder'`. Correct fix is a BACKEND decision: expose `category` (or `isFeeder`) on `SubEquipmentTypeResponse` + the resolver arg, OR derive feeder-ness from `code`. Deferred to a backend slice; left baselined so it stays tracked + shrinking.

**Slice 2 — mcp/farm-management (all 13 fixed; baseline 127 → 114):** the MCP server's hand-written queries selected renamed/removed schema fields. Fixed query + every TS consumer, verified against `apps/farm-service/schema.graphql`, `tsc` clean:
- `batches.ts` (GetBatch/ListBatches): `species`→`speciesId`, `initialAvgWeightG`→`currentAvgWeightG`, `targetFCR`→removed, `tankAllocations{tank{…}}`→`locations{tankId…}` (BatchLocation has no nested tank — consumer joins tankId→name via the fetched tank list).
- `health.ts` (HealthEvents/HealthEventsByBatch/CriticalHealthEvents): `startDate`/`endDate`→`eventDate`, `affectedCount`/`mortalityCount`/`hasMore`→removed (consumers degrade gracefully).
- `maintenance.ts` + `tasks.ts` (WorkOrder): `workOrderType`→`type` (audit's `workOrderCode` was semantically WRONG — type≠code; the MCP's separate `code` field maps to the real `workOrderCode`); `siteId`→`assetId`; `assigneeId`→`assignedTo`; `scheduledStartDate`→`plannedStartDate`; `completedDate`→`completedAt`; `estimatedDurationHours`→`estimatedDurationMinutes` + `actualDurationHours`→`actualDurationMinutes` (UNIT change — metric relabeled minutes, NOT shown as hours); `departmentId`/`startedAt`/`actualCost`→removed.
- `feeding.ts`/`growth.ts`/`water-quality.ts`: `hasMore`→`hasNextPage` (real field; capability preserved); water-quality `limit` arg moved into `filter`, `offset` removed.

**Follow-up (NOT a gate-drift — runtime input bug, filed for a later slice):** the MCP `HealthEventFilter`/feeding/wq/growth filter interfaces use `startDate`/`endDate` keys but the schema's `*FilterInput` use `fromDate`/`toDate` (`detect-anomalies.ts:344-359`). The static op-validation gate does not catch variable VALUES, so it isn't in the baseline, but the gateway would 400 on the input at runtime. Owner: mcp/farm. Tracked here.

**Slice 3 — sensor-module (33 of 35 fixed; baseline 114 → 81):** verified against the sensor backend DTOs/entities (`apps/sensor-service/src/**`). Key SSoT discovery: the `sensor(id)` query composes to entity `Sensor` (has `protocolId`/`protocol`, `connectionStatus` as JSON, `status`, `lastCalibratedAt`) while `sensors` composes to `RegisteredSensorType` (has `protocolCode`, `connectionStatus` as an ObjectType, NO `status`) — the field-map is consistent with that split.
- VFD: `VfdCommandResult` drop `command`/`executionTimeMs` (7 ops); `VfdReading`/brands/protocols/readings JSON scalars → bare (delete sub-selections); `VfdReadResultDto` drop `id`/`quality`; `VfdFilterInput`→`VfdDeviceFilterInput`; drop `latestReading`.
- Sensor registration: drop `status` from `RegisteredSensorType` (5 ops); `protocolCode`→`protocolId`; `SensorFilter`→`SensorFilterInput`, `Pagination`→`SensorPaginationInput`; `byType`/`byProtocol` JSON → bare.
- Channels (RENAMES, not gaps): `createSensorDataChannel`→`createDataChannel` (+ `CreateDataChannelInput`), update/delete likewise.
- Calibration: drop `unitSymbol`/`nextCalibrationDue`/`calibrationPolynomial`. Protocols: `ValidateProtocolConfigInput`→`ValidateConfigInput`, `ApplyProtocolDefaults` arg `code`→`protocolCode`, `CategoryStatsType` reshaped to real `{industrial iot serial wireless}`. DeviceDetailPage: `connectionStatus` JSON→bare, `lastCalibrationDate`→`lastCalibratedAt`, `SensorReading` real `readings{}` + `$startTime/$endTime` `String!`→`DateTime!`, `deleteSensor` `Boolean!`→bare. All consumers updated; sensor-module `tsc` 0 errors + eslint clean.
- FLAGGED (2 left baselined): `CancelVfdChangeSet` (schema has only reject/rollback/approve — semantic, not a safe rename) + `GetSensorChannels` (`Sensor.dataChannels` absent; needs a `dataChannelsBySensor` rework beyond a rename).

**Slice 4 — tenant-admin + aquamobil clean ops (4; baseline 81 → 77):** `EdgeDevice` (×2: device-queries.ts + useDevicePolling.ts) drop `unit` (not on `DeviceIoConfig`); aquamobil `EditMessage`/`DeleteMessage` var `$id: String!` → `ID!` (the mutation arg is `ID!`). tenant-admin + aquamobil `tsc` 0.

**Assessment — the clean FE-fix phase is largely exhausted.** Slices 1-4 burned the easy MISSING-FIELD/SELECTION-SHAPE/clean-rename drifts (53 ops). The remaining 77 are predominantly NOT FE-only fixes:
- **hr-module (60):** mostly MISSING-ROOT-OP — `workArea`/`workRotation`/`leaveType`/`updateShift`/`startTraining` ops the schema does not expose → a BACKEND feature decision (implement the ops or remove the FE features), not a rename.
- **tenant-admin (8):** `communication-queries.ts` uses an entire THREAD-based messaging API (`myThreads`/`thread`/`threadMessages`/`createThread`/`closeThread`/`Message.threadId`/`ThreadStatus`/`CreateThreadInput`) that the schema does not have — the schema is message-based (`messages`/`searchMessages`). Needs rework to the real API OR removal if the feature is dead. + `MyTenantModules` `module { … }`→`moduleId` (consumer needs module details the type lacks).
- **aquamobil (3):** `aiConsentStatus`→`myConsentStatus`?, `toggleAiConsent`→`withdrawConsent`? (toggle≠withdraw), `stockAtLocation`→`storageLocation`? — semantic renames needing per-op verification.
- Plus the prior flags (farm `category` 2, sensor 2). These need product/backend decisions, tracked here + in the baseline.

Status: RESOLVED for slices 1-4 — farm (3) + mcp (13) + sensor (33) + tenant-admin/aquamobil clean (4) = **53 ops, baseline 130 → 77**. Remaining 77 are backend-feature-gaps / thread-API rework / semantic renames (per the assessment above), NOT clean FE fixes. Registry: orphan-findings.md + graphql-fe-drift.baseline.json.

---

## ORPHAN-MEDIUM-182 - tenant-admin support-messaging page was broken (wrong thread API) — reworked to the real `support*` API (slice 5; baseline 77 → 69)

Severity: MEDIUM (operator-facing: the tenant-admin Messages page was non-functional — every op 400'd at the gateway). Slice 5 of the #3 GraphQL drift burndown; resolves the tenant-admin thread-API cluster flagged in ORPHAN-LOW-181.

**Root cause:** `web/modules/tenant-admin/src/graphql/communication-queries.ts` used a generic thread API (`myThreads`/`thread`/`threadMessages`/`messagingStats`/`createThread`/`sendMessage`/`closeThread`/`reopenThread` + types `CreateThreadInput`/`ThreadStatus`/`Message.threadId`/`senderType`/`senderName`) that the supergraph does not expose. The REAL support-thread API lives in **auth-service** (`apps/auth-service/src/modules/messaging/`, registered at `app.module.ts:246`) under `Support`-prefixed GraphQL names — so the page that drove tenant↔platform support conversations was entirely broken (8 drifted ops).

**Fix (this commit):** reworked all 8 ops to the real API — `mySupportThreads`/`supportThread`/`supportThreadMessages`/`supportMessagingStats`/`createSupportThread`/`sendSupportMessage`/`closeSupportThread`/`reopenSupportThread`; input types → `SupportCreateThreadInput` (`{subject, initialMessage, tenantId?}`) + `SupportSendMessageInput` (`{threadId, content, isInternal}`); enums → `SupportThreadStatus`/`SupportSenderType`/`SupportMessageStatus` (real values). FE `content`→`initialMessage`; dropped the input `senderName` (server derives sender from the authed user). Updated `communication-queries.ts` + `lib/api.ts` + `lib/types.ts` + `hooks/useTenantData.ts` + `TenantMessagesPage.tsx`; thread list / open-closed filter / message view / send / create-thread all wired to the real API. tenant-admin `tsc` 0. The page now functions.

Pre-existing (not a regression, out of scope): the page's `MoreVertical` button isn't wired to close/reopen (the API fns are now correct + available); `archiveSupportThread` is SuperAdmin-only, intentionally not exposed to tenant-admin.

Status: RESOLVED (2026-06-26) — 8 ops fixed, baseline 77 → 69. Cumulative #3 burndown: 130 → 69 (61 ops). Registry: orphan-findings.md + graphql-fe-drift.baseline.json.

---

## ORPHAN-MEDIUM-183 — billing-scheduler monthly-invoice totals not rounded to 2dp (33.333 instead of 33.33)
3 pre-existing RED tests in `apps/billing-service/src/billing/__tests__/billing-scheduler.service.spec.ts` (`should round invoice totals to 2 decimal places`, `should multiply base price by cycle months for non-monthly billing`, `should generate an invoice for ACTIVE subscription with expired period`): `generateMonthlyInvoices` produces `total/subtotal/amountDue` as the unrounded string `"33.333"` where the test expects the rounded number `33.33`. Verified pre-existing on HEAD (fail under `git stash`, independent of ORPHAN-174). Likely a Money/decimal-rounding gap in the monthly-invoice path (decimal column read back as string + no `.toFixed(2)`/`Money.round`). Owner: billing. Status: OPEN. Found 2026-06-26 while fixing ORPHAN-174. Why: invoices billed to a financial schema must be exact to the cent; an unrounded total is a revenue-accuracy + reconciliation defect. How to fix: route the monthly-invoice total through the canonical `Money` rounding (as the immediate path does) and assert numeric (not string) equality.

---

## ORPHAN-MEDIUM-184 - hr-module GraphQL drift: backend-op decision (slice 6; 5 fixed → 64; 55 categorized for implement-vs-remove)

Severity: MEDIUM (60 hr FE ops 400 at the gateway — hr feature areas partly non-functional). Slice 6 of the #3 burndown + the requested BACKEND-OP DECISION for the hr feature-gaps. The hr backend (`apps/hr-service`) is rich but uses a DIFFERENT domain model than several FE clusters (no detail-by-id singulars — only paginated plurals; scheduling is `WeeklyPlan`, not a named recurring `Schedule`).

**FIXED — 5 renames (baseline 69 → 64):** `GetAllCertifications`→`allCertifications` (`$ids` `String`→`ID`), `GetMyTrainingEnrollments`→`myTrainingEnrollments` (`offset`→`page`), `GetMyLeaveRequests`→`myLeaveRequests` (`offset`→`page`), `GetAttendanceSummary`→`attendanceSummary` (`totalWorkingDays`→`totalWorkDays`), `GetDepartment`→`employeesByDepartment` (`Department!`→`HRDepartment!`). hr-module `tsc` 0.

**DECISION — REMOVE-FE (dead/superseded, ~16 ops; clean next slice):** the `Schedule`/`ScheduleEntry` set in `attendance.operations.ts` (`GetSchedules`/`GetScheduleEntries`/`GetEmployeeSchedule`/`CreateSchedule`/`UpdateSchedule`/`CreateScheduleEntry`/`BulkCreateScheduleEntries`/`DeleteScheduleEntry`) is SUPERSEDED by the live `scheduling.operations.ts` WeeklyPlan model (0 drift) and unwired → remove. `GetOffshoreHeadcount`/`GetSeaLandSplit` are dead exports (live hooks do client-side aggregation; FE NOTEs already say "does not exist"). `BulkCreateRotations` unused. Safety-training cluster (`CreateSafetyTrainingRecord`/`GetSafetyTrainingRecords`/`GetSafetyCompliance`/`ConfirmSafetyTrainingAttendance`/`BulkCreateSafetyTraining`) is shape-incompatible with the real entity + unwired → remove or re-model.

**DECISION — IMPLEMENT-BACKEND (legit HR features built ahead of the backend; a prioritized roadmap, NOT a blind 40-op sprint):** `UpdateShift` is the quick win — `UpdateShiftInput` DTO already exists (`attendance/dto/create-shift.input.ts:122`), only the `@Mutation updateShift` resolver is missing (~15 LoC) + it's UI-wired (SchedulingSettingsPage). The rest are coherent domain features, mostly unwired today: leave-admin (`CreateLeaveType`/`UpdateLeaveType`/`AdjustLeaveBalance`/`WithdrawLeaveRequest`/`CarryOverLeaveBalances` — routes exist as PlaceholderPages), certification/training-admin (type CRUD, training lifecycle, compliance analytics), performance analytics (`GetTeamPerformanceOverview`/`GetDepartmentKPIs`/`GetReviewCycleStatus`/`BulkCreateReviews`), rotations analytics (occupancy/calendar/upcoming/changeovers), and detail-by-id queries (`GetWorkArea`/`GetWorkRotation`/`GetShift`/`GetCertificationType`/`GetTrainingCourse` — thin singular resolvers). Each needs backend design+tests; track as hr-backend feature-debt and implement by product priority. UpdateShift recommended first.

**EXECUTED (slices 7-8, this PR):**
- **REMOVE-FE (16 dead ops; baseline 64 → 48):** deleted the superseded `Schedule`/`ScheduleEntry` set (8), the dead `GetOffshoreHeadcount`/`GetSeaLandSplit` exports (2; the live client-aggregation hooks preserved), `BulkCreateRotations` (1), and the unwired shape-incompatible safety-training cluster (5) — plus their orphaned hooks/types. 461 LoC removed; hr-module `tsc` + eslint clean.
- **IMPLEMENT-BACKEND `updateShift` (baseline 48 → 47):** added `UpdateShiftCommand` + `UpdateShiftHandler` + the `@Mutation updateShift(input: UpdateShiftInput!)` resolver (guards/audit mirror `createShift`), registered the handler, exported `parseTimeString` as the shared HH:mm SSoT. Tenant-scoped via `tenantManagerRepo` + transactional QueryRunner like create; recomputes `totalMinutes` on time change; `NotFoundException` cross-tenant. 6/6 handler tests pass; hr-service `tsc` + eslint clean. FE was already correctly wired.

Status: RESOLVED for slices 6-8 — 5 renames + 16 dead removed + `updateShift` implemented = **hr 69 → 47** (22 ops). Cumulative #3 burndown: **130 → 47 (83 ops)**. Tracked: 38 hr IMPLEMENT-BACKEND features remain (roadmap — leave/cert/training/performance/rotations analytics + detail-by-id; backend feature-debt by product priority). Registry: orphan-findings.md + graphql-fe-drift.baseline.json.

## ORPHAN-MEDIUM-185 — auth/gateway/sensor metrics served from bespoke @Controller('metrics') miss default http_/nodejs_ series (089-siblings)
Found 2026-06-26 while fixing ORPHAN-089 for messaging. Same defect class: `apps/auth-service/src/metrics/metrics.controller.ts`, `apps/gateway-api/src/metrics/metrics.controller.ts`, and `apps/sensor-service/src/metrics/metrics.controller.ts` each expose `@Controller('metrics')` over a private prom-client Registry and do NOT import the platform `ServiceMetricsModule`, so their `/metrics` scrape omits the default `http_request_duration_seconds` + `nodejs_*` runtime series (verified: these three are absent from the ServiceMetricsModule-importer list). observability-service's `prometheus.controller.ts` is the legitimate aggregator — exempt. Fix (mirror messaging ORPHAN-089 / farm OBS-HIGH-001): add a `contributeTo(serviceMetrics)` to each service's domain metrics service, import `ServiceMetricsModule`, delete the bespoke controller, and plug the domain registry in `onModuleInit`. Ratchet `tests/invariants/metrics-service-module-ratchet.spec.ts` caps bespoke controllers at 4 and drops as each migrates. Owner: observability/platform. Status: OPEN.

---

## ORPHAN-MEDIUM-186 - GraphQL drift flagged-tail: 5 resolved + 4 genuine gaps categorized (slice 9; 47 → 42)

Final slice of the #3 burndown — the 9 hardest "flagged tail" drifts (mixed renames / consumer reworks / dead code / backend gaps). Each was verified against the real backend resolver/DTO SSoT before acting. 4 modules `tsc` 0 (sensor-module, tenant-admin, farm-module, admin-panel); dead-contract ratchet spec green.

**RESOLVED — 5 ops removed from the drift baseline (47 → 42):**
- **`GetSensorChannels`** (sensor) — RENAME: `Sensor.dataChannels` (no such field) → root `dataChannelsBySensor(sensorId: ID!) → [DataChannelType]`; mapped fields (`operationalMin/Max`→`minValue/maxValue`, dropped non-existent `unitSymbol`→`unit`, `alertThresholds`/`displaySettings` scalar→structured subfields); consumer `ChannelManagerPanel.tsx` updated.
- **`MyTenantModules`** (tenant-admin) — REWORK: `TenantModule` exposes scalar `moduleId`, not a nested `module {…}` relation (no `@Field`, and the selection also referenced a non-existent `category`). No component read `.module.*` (catalog details come from the separate `myModules` query). Dropped the nested selection + the dead `Module` type + its re-exports.
- **`ListSubEquipmentByParent`** + **`GetSubEquipmentByParent`** (farm) — REWORK: `SubEquipmentTypeResponse` has no `category` (absent at entity/DTO/schema); `subEquipmentByParent` has no `category` arg. Dropped the `category` selection + the undeclared `$category` arg. Fixed **two latent bugs**: a stray `enabled: !!tenantId` literal inside the GraphQL variables object (syntax), and an always-true filter clause (`!se.subEquipmentType?.category`) that had degenerated `useTankFeeders` into returning ALL sub-equipment instead of feeders — feeder narrowing now matches on `subEquipmentType.name`/`name` containing "feeder".
- **`AdminBulkCreateThreads`** (admin-panel) — REMOVE-FE (dead code): no `bulkCreateThreads` mutation / `BulkCreateThreadsInput` exists in auth-service messaging (only single `createSupportThread`); the `useBulkCreateThreads` hook had zero consumers. Deleted the op const + dead hook + dead input interface + import. Not in the dead-contract baseline (the const was hook-referenced); removal leaves no orphan.

**GAP — 4 ops kept baselined (genuine backend/product decisions, NOT FE-fixable):**
- **`CancelVfdChangeSet`** (sensor) — IMPLEMENT-BACKEND. "Cancel" ≠ "reject": the FE Cancel button is on DRAFT + APPROVED changesets, while `rejectVfdChangeSet` asserts `PENDING_APPROVAL`. Backend has no `cancelVfdChangeSet` + no `CANCELLED` status (the FE enum has it). Wired to a live page. Recommend implementing `cancelVfdChangeSet` + a `CANCELLED` state (DRAFT/APPROVED→CANCELLED) on sensor-service.
- **`GetAiConsentStatus` + `ToggleAiConsent`** (aquamobil) — PRODUCT-DECISION. The GDPR consent API (`user-consent.resolver`) has a fixed `ConsentType` enum with no AI type + no tenant `isAiEnabled` concept; the hook needs both. Shapes incompatible; the hook self-documents this + fails closed. Wired to a live "AI Analysis" toggle. Recommend: add an `AI_ANALYSIS` ConsentType + tenant-AI flag + dedicated resolver, OR remove the mobile AI-consent surface.
- **`StockAtLocation`** (aquamobil) — REWORK-CANDIDATE. No `stockAtLocation(locationId)`; the real inventory query is `farmStockInventory(filter) → FarmStockInventoryConnection`. Re-pointing requires a connection reshape (`items`→`nodes`), a filter-arg mapping, field-parity verification, and adapting the page's offline-cache logic — not a clean rename. Live page (`/operations/stock`). Recommend a dedicated rework PR.

**Orphan observed (separate item, not among the 9) — RESOLVED 2026-06-26:** `ListSubEquipmentTypes` (`useSubEquipment.ts`) also selected the non-existent `SubEquipmentTypeResponse.category` (same root cause as the farm items). Verified `category` is absent from the entire sub-equipment domain (neither `SubEquipmentType`/`SubEquipment` entity nor `SubEquipmentTypeResponse` DTO nor the schema has it — types are distinguished by `code`/`name`/`compatibleEquipmentTypes`), so it is a FE fiction, not a missing-but-needed backend field → removed (not added). Dropped `category` from the query selection + the `SubEquipmentTypeOption` type; the sole consumer (`SubEquipmentModal.tsx` type dropdown, which rendered `{name} ({category})` → `({undefined})`) now shows the real `code`. farm-module `tsc` 0. Not in the drift baseline (the gate had not flagged it), so no baseline change — the fix forecloses a future NEW-drift failure.

Status: RESOLVED for slice 9 — 5 resolved (4 fixed + 1 dead-removed), baseline 47 → 42. **Cumulative #3 burndown: 130 → 42 (88 ops, ~68%).** Remaining 42 = 38 hr IMPLEMENT-BACKEND roadmap + 4 flagged gaps (CancelVfdChangeSet implement-backend, 2 aquamobil AI-consent product-decision, StockAtLocation rework). All FE-fixable + dead-code + clean-rename classes are now exhausted. Registry: orphan-findings.md + graphql-fe-drift.baseline.json.

---

## ORPHAN-HIGH-329 — tenant-scoped services lose AsyncLocalStorage tenant context across Apollo/CQRS async boundaries → intermittent empty / phantom reads on the tenant panel

**Renumbered from the originally-assigned ORPHAN-HIGH-187 during merge-train collision resolution** — main independently claimed that id for an unrelated production-deploy-rollback finding; this heading is the authoritative record for the tenant-context finding.

**Severity:** HIGH
**Discovered:** 2026-06-26, user-reported runtime bug ("data loads then vanishes, data that isn't mine appears" on the tenant panel; data verified present in the database)
**Files:**
- `apps/hr-service/src/app.module.ts`, `apps/sensor-service/src/app.module.ts`, `apps/hydroponics-service/src/app.module.ts`, `apps/messaging-service/src/app.module.ts`, `apps/ai-service/src/app.module.ts`, `apps/alert-engine/src/app.module.ts`
- `libs/backend-common/src/middleware/tenant-schema.middleware.ts:92`
- `libs/backend-common/src/database/tenant-connection-bootstrap.service.ts:116-154`
- `libs/backend-common/src/context/tenant-execution-context.interceptor.ts`

**Problem:** Tenant-scoped services patch the pg pool for per-tenant `search_path` routing via `createTenantConnectionBootstrap(<src>)`, but relied solely on `TenantSchemaMiddleware`'s `requestContextStorage.run(store, () => next())` to carry the tenant schema. That `run()` scope only reliably covers the Express middleware chain. Apollo GraphQL resolver execution and the CQRS QueryBus insert async boundaries BEFORE TypeORM checks out a connection; on those hops the middleware-seeded context can be gone, so `TenantConnectionBootstrap` reads an empty context at checkout and falls back to `SET search_path TO "<src>", public` (the empty source/template schema). Reads then run against the wrong schema: tenant rows intermittently "disappear" and template/seed rows surface as phantom data, request-to-request nondeterministically.

`TenantExecutionContextInterceptor` already cures this (re-enters `withTenantContext` around the resolver/handler pipeline) but was wired into only `farm-service` and `event-store-service`; the other six tenant-scoped services had no equivalent.

**Risk:** Intermittent, panel-wide data-correctness failures for every tenant-scoped read served via GraphQL/CQRS (farm, sensor, hr, hydroponics, messaging, ai, alert). User-visible as data that loads then vanishes.

**Reproducibility:** Repeatedly fetch a tenant-scoped GraphQL query against an affected subgraph (e.g. hr departments) for the same tenant; a fraction of requests resolve `search_path` to the source schema and return empty/template rows instead of the tenant's data.

**Fix (RESOLVED 2026-06-26):** Introduced the SSoT module `TenantExecutionContextModule` (`@aquaculture/backend-common/context`) that owns the single `APP_INTERCEPTOR` registration of `TenantExecutionContextInterceptor`. All seven tenant-scoped services (the six above plus farm via `FarmMetricsModule`) and `event-store-service` now import it once instead of hand-copying a provider block. New invariant `tests/invariants/tenant-execution-context-registered.spec.ts` asserts every `createTenantConnectionBootstrap()` service imports the module so a future service cannot silently ship without it. Frontend cross-tenant query-key scoping (latent; manifests only on tenant-switch/impersonation) is tracked separately as a follow-up. Status: RESOLVED (backend root cause).

---

## ORPHAN-MEDIUM-327 — freshly provisioned tenants can be blocked up to 30s by a stale negative schema-existence cache

**Renumbered from the originally-assigned ORPHAN-MEDIUM-188 during merge-train collision resolution** — main independently claimed that id for an unrelated frontend gateway-502 finding; this heading is the authoritative record.
**Severity:** MEDIUM
**Discovered:** 2026-06-26, while answering "yeni oluşturulan tenant'larda da aynı problem olmamalı" (new tenants must not have the same problem) — extends ORPHAN-HIGH-329.
**Files:**
- `libs/backend-common/src/middleware/tenant-schema.middleware.ts`
- `libs/backend-common/src/database/schema-lru-cache.ts`
- `apps/admin-api-service/src/tenant/services/tenant-provisioning-workflow.service.ts` (publishes `TenantProvisioned`)

**Problem:** `TenantSchemaMiddleware` calls `checkSchemaExists()` and throws `UnauthorizedException('Tenant not provisioned')` when the `tenant_<uuid>` schema is missing. `SchemaLRUCache` caches NEGATIVE results for 30s (`negativeTtlMs = 30_000`). If any tenant-scoped HTTP request for tenant X lands during the provisioning window — before aqua-db-migrate creates the schema — the "does not exist" result is cached for 30s. Even after the schema is created moments later, subsequent requests keep seeing the stale negative entry and the tenant stays blocked for up to 30s. A `invalidate()` method exists on the cache but was NEVER called by provisioning (grep: defined in the middleware, zero call sites). The negative TTL was the only self-healing mechanism — i.e. correctness depended on a timeout, not a structural guarantee.

**Risk:** New tenant's first requests intermittently fail with a hard 401 for up to 30s after the schema exists. Narrow trigger (JWT-gating means a user normally can't request a tenant before it is ACTIVE, which is after schema creation), but not a structural guarantee — so it could surface for impersonation/warmup/internal requests in the provisioning window.

**Reproducibility:** Issue a tenant-scoped request carrying tenant X's id while X is still provisioning (schema not yet created), then create the schema; subsequent requests for X within 30s still receive "Tenant not provisioned" until the negative TTL expires.

**Fix (RESOLVED 2026-06-26):** Root-cause, make-it-automatic — NOT a TTL tweak. Extracted the schema-existence cache into an injectable app-singleton `TenantSchemaCacheService`; `createTenantSchemaMiddleware` now resolves it via DI instead of constructing a private `new SchemaLRUCache`. A new `TenantSchemaCacheInvalidationSubscriber` (in `TenantSchemaCacheModule`) subscribes to `TenantProvisioned` and invalidates the `tenant_<uuid>` entry on the SAME shared instance, so a freshly provisioned tenant's stale negative entry is cleared the instant provisioning completes. All seven tenant-scoped services (farm, sensor, hr, hydroponics, messaging, ai, alert) import the module once; invariant `tests/invariants/tenant-schema-cache-module-registered.spec.ts` enforces the wiring (and catches the runtime-DI coupling statically). End-to-end behavior proven by `libs/backend-common/src/database/tenant-schema-cache/tenant-schema-cache-invalidation.subscriber.spec.ts`. Status: RESOLVED.
## ORPHAN-HIGH-187 - production deploy systemically rolled back (2 critical services miss the 300s health SLA) — dual root cause + SSoT fix

Severity: HIGH (every main deploy since ~#660 failed `deploy-production/deploy` with "2 critical service(s) failed to reach healthy within 300s SLA → rollback"; production kept serving only via per-service rollback to stale images — backend pinned at #664, **billing pinned at #628**, so NO recent code reached prod). Diagnosed via a 9-agent workflow (parallel investigate → synthesize → 3-lens adversarial verify); the adversarial pass corrected the initial design's blind-spots (image-bake gap, a 2nd SLA literal, a fabricated secret-mount, /health/ready coverage) BEFORE implementation.

> **RUNTIME CORRECTION (2026-06-27, after live verification — the static analysis below was partly wrong).** `docker inspect aqua-billing` + `docker logs` on the droplet PROVE billing does **NOT** boot-crash: its env has `NODE_ENV=production` + `STRIPE_API_KEY` + **NO `STRIPE_SECRET_KEY`**, yet the log says "Nest application successfully started" — so the Stripe factory does NOT throw at boot (the provider is lazily resolved, not eager). Both the workflow AND the adversarial review reasoned from CODE and wrongly called billing "the dominant deterministic boot crash"; the running system refutes it. Consequences for this finding: (1) the **dominant active cause is NOT billing** — it is the **GATEWAY composition-blocks-liveness fragility** (cause #2 below: `/health/live` waits for all-or-nothing live supergraph composition → race-prone under deploy load; deploys went green or red by *winning/losing that race* — #666 won at f6437a6bb and the droplet is currently 29/29 healthy on it). (2) The billing change (A) is therefore **latent-bug + hardening, NOT an active-crash fix**: the env-name mismatch is a real repo bug (the factory reads `STRIPE_SECRET_KEY`, compose injects `STRIPE_API_KEY`, so Stripe can never be enabled via compose) and the flag makes the no-Stripe state explicit + crash-proof against the theoretical throw — but billing was already booting fine (Stripe effectively disabled). No deploy was ever pinned by a billing crash; the stale-image observation was the gateway race, not billing. The load-bearing fix is **B (gateway liveness ≠ composition)**; A/C/D are correct hardening/hygiene. Severity effectively MEDIUM (intermittent race + latent bugs), not HIGH-deterministic.

**Root cause = TWO independent defects that reinforce each other (NOT a too-tight SLA):**
1. **BILLING env-name mismatch (latent bug — claimed "dominant boot crash" but RUNTIME-REFUTED, see correction above):** `libs/backend-common/src/billing/stripe-client.factory.ts` *would* throw at module init in prod on a missing `STRIPE_SECRET_KEY`, and `docker-compose.droplet.yml` injects `STRIPE_API_KEY` (wrong name) + Helm too — a real hand-copied env-name SSoT fracture (Stripe can never be enabled via compose). BUT the live container boots fine ("Nest application successfully started" with no key), so the factory is NOT eagerly resolved → no boot crash. This is a latent bug (Stripe is effectively unconfigurable), not the deploy-breaker. The 2026-04-14 "graceful-boot" vs #640 "fail-closed" contract collision is real and worth reconciling regardless.
2. **GATEWAY liveness conflated with composition (secondary, cascades from #1):** `/health/live` only answered after `NestFactory.create()`, which was blocked by `RetryableIntrospectAndCompose` composing all ~11 subgraphs all-or-nothing from the live network (≈83-94s budget). Because composition includes billing, and billing crash-looped, the gateway could never compose → never healthy. Even absent #1, simultaneous cold-boot on the 7GB box raced the window.
3. **Enabler (why it stayed invisible):** the physical invariant `start_period ≤ readiness SLA` was unenforced — the 300s SLA was a Potemkin literal in TWO spots (`generate-artifacts.ts` emitter + `check-service-health.ts` `?? 300` consumer fallback) and per-service `start_period`s were hand-typed, none linked to the catalog.

**Architectural SSoT fix (4 axes, no patch/silencing/duplicate — blind 300s bump, healthcheck-loosening, criticality-demotion, and a defensive try/catch around the fail-closed throw were all explicitly rejected):**
- **A. Stripe env-name + contract SSoT:** ONE canonical secret name `STRIPE_SECRET_KEY` everywhere (factory + `PLATFORM_SECRET_ENV_VARS` + compose + Helm); ONE intent flag `STRIPE_BILLING_ENABLED` (default false) reconciles both contracts — off→billing BOOTS with a disabled client that fails closed at REQUEST time (`StripeNotConfiguredError`), on+key→real client, on+no-key→boot fails closed (#640 honoured). Factory + spec (5/5) + compose + Helm updated.
- **B. Gateway liveness ≠ composition:** `BackgroundCompositionManager` returns a real (composed-via `@apollo/composition`) placeholder supergraph immediately so the listener + `/health/live` bind in <1s, then runs the unchanged `RetryableIntrospectAndCompose` in the BACKGROUND and hot-swaps via Apollo's `update()`. `/health/ready` extended to verify composition + auth + all-subgraph reachability (was auth-only — the deploy already sweeps `/health/ready`). compose gateway `start_period` 120s→30s. NOT the static-SDL migration (review: artifact not baked into the image + separate Apollo-Router ADR). gateway suite 969/969.
- **C. Startup-timing SSoT:** added `startupBudgetSeconds` to the service-catalog (the proven criticality-SSoT pattern); `readiness_sla_seconds` now DERIVED = `max(critical startupBudgetSeconds)+180` (lands at 300, catalog-driven) — both literals collapsed (the `?? 300` consumer fallback now fails loud); new invariant `tests/invariants/deploy-startup-budget-ssot.spec.ts` asserts every critical service's compose `start_period` ≤ the derived SLA (detectable drift). compose start_period codegen-emission left as a guarded follow-up (the invariant is the current guard).
- **D. Disk preflight:** `FULL_WARN_FREE_GIB` 50→45 (the cosmetic warn fired every deploy on a healthy box; non-blocking).

Verification: billing + gateway + service-catalog `tsc` 0; billing factory 5/5; gateway 969/969; registry/catalog invariant shard green incl. the new one. Regenerated provenance artifacts (apollo-router/* + deploy/* + federated-subgraphs.generated.ts) are mechanical hash re-pins (no topology/functional change).

Status: RESOLVED (2026-06-27) — fix implemented + locally verified; greens the deploy by fixing the two real causes and makes the failure class detectable (timing invariant) + impossible-to-misname (Stripe SSoT). Pending merge + live deploy-verify. Registry: orphan-findings.md.

---

## ORPHAN-MEDIUM-188 — frontend amplifies a gateway 502 into data-blanking + reconnect storms
Found 2026-06-27 during the app.suderra.com outage (gateway 502 from the billing-boot/STRIPE_SECRET_KEY drift; backend restore tracked separately as ORPHAN-HIGH-187 / PR #672). The frontend turns a transient/total gateway 502 into "data loads, then disappears, then errors": (1) `web/shared-ui/src/utils/api-client.ts` GraphQL request called `response.json()` with NO status check, so a 502 HTML body threw a bare SyntaxError that callers couldn't classify → react-query marked the query failed → cached UI blanked; (2) two sockets used `reconnectionAttempts: Infinity` (`web/apps/aquamobil/.../useMessageSocket.ts`, `web/modules/sensor-module/.../ScadaSocketService.ts`) → an outage was stormed forever against the dead upstream. **Status: RESOLVED (2026-06-27 — api-client now short-circuits a 5xx to a TYPED GraphQLClientError (BACKEND_UNAVAILABLE) before parsing, so callers keep cached data; both sockets bounded Infinity→20. shared-ui/aquamobil/sensor-module tsc clean; api-client spec 59/59 incl. a new 502→typed-error test).** Follow-up (not in this fix): a shared circuit-breaker/health gate to pause refetchOnWindowFocus/refetchOnReconnect during a detected outage.

## ORPHAN-HIGH-189 — deploy gate never tests the real public /graphql path (let the outage ship)
Found 2026-06-27 during the app.suderra.com outage. The deploy verification (`scripts/deploy/post-deploy-verify.sh`) only ran `docker exec aqua-gateway curl http://localhost:3000/health/live` + `/health/ready` — INSIDE the container, bypassing nginx, and never POSTing a GraphQL query. So a deploy could promote (and did) while `nginx → gateway-api:3000` returned 502 for every real request: `/health/live` passes in-container even when the supergraph never composes (a subgraph like billing down) and the gateway serves no public traffic. **Status: RESOLVED (2026-06-27 — added a real public-path smoke THROUGH nginx in BOTH gates: `droplet-up.sh` runs it pre-promotion (a 502/non-JSON body triggers rollback before `record_release_ledger "promoted"`), and `post-deploy-verify.sh` runs it in the CI post-deploy workflow. The smoke does `POST {Host: app.suderra.com}/graphql {__typename}` and asserts HTTP 200 AND a valid GraphQL JSON body (data.__typename), plus a `/socket.io/?EIO=4` handshake. Configurable via PUBLIC_SMOKE_HOST/PUBLIC_SMOKE_ORIGIN. bash -n + 18/18 deploy-ssot invariants green).** This is the make-it-detectable control: this exact outage now fails the deploy instead of promoting.

---

## ORPHAN-MEDIUM-190 - production deploy blocked at release-verification (monitoring-criticality gap + swc cross-platform lockfile drift)

Severity: MEDIUM (blocked ALL production deploys at the PRE-droplet `deploy-production/release-verification` gate since ~#670 — so even the merged ORPHAN-HIGH-187 gateway fix could not reach the droplet; prod stayed healthy on the last good image via per-service rollback). Two independent, unrelated-to-each-other gate failures, neither from the health-SLA work:

1. **compose-service-without-criticality:** PR #670 added the monitoring scraper stack (`prometheus`, `cadvisor`, `node-exporter`, `alertmanager`) to `docker-compose.droplet.yml` but NOT to the service-catalog SSoT (`platform/libs/service-catalog/src/index.ts`), so `scripts/ci/validate-criticality-manifest.ts` failed ("compose services without a criticality entry"). #670's own deploy hit this too (which is why the droplet was pinned at the pre-#670 image). **Fix:** added a `buildEntry` for each of the 4 as `classification: 'infra'`, `criticality: 'ignored'` (observability plane — a slow/down scraper must never roll back a healthy app deploy; mirrors `mosquitto`/`minio`), `startupBudgetSeconds` 15-30, no `profiles:` (verified always-on); regenerated the manifest + downstream artifacts via the official generators (`service-catalog:generate`, `graphql:generate-registry-artifacts`). Manifest now 35 services, all in compose.

2. **swc cross-platform lockfile integrity:** `.github/actions/install-platform-binaries/action.yml` verifies the `@swc/core-linux-x64-gnu` tarball sha512 against the top-level `package-lock.json` integrity. `package.json` had a stale `optionalDependencies` override pinning `@swc/core-linux-x64-gnu` to `1.15.10` while `@swc/core` had floated to `1.15.41` — so the action downloaded `1.15.41` but verified against the `1.15.10` integrity → mismatch. **Fix:** bumped the override `1.15.10 → 1.15.41` + `npm install --package-lock-only --ignore-scripts` (integrity now byte-matches `npm view @swc/core-linux-x64-gnu@1.15.41 dist.integrity`; 3 lockfile lines + 1 package.json line, no unrelated deps). Known design wart (flagged, not fixed here): the `@swc/core: ^1.7.0` float means this override needs re-pinning each patch bump — a future invariant could assert `override === @swc/core resolved version`.

Verification: `validate-criticality-manifest` OK (35 services); `service-catalog:check` + `graphql:generate-registry-artifacts --check` drift-clean; 99 catalog/criticality/registry invariant tests pass; service-catalog `tsc` 0; swc gate simulation matches. Unblocks the deploy so the ORPHAN-HIGH-187 health-SLA fix can finally reach the droplet.

Status: RESOLVED (2026-06-27) — both release-verification blockers fixed + locally gate-green. Pending merge + the deploy that finally lands #187. Registry: orphan-findings.md.
## ORPHAN-MEDIUM-191 — SCADA real-time has no route to sensor-service (nginx sends all /socket.io to gateway)
Found 2026-06-27 (outage plan P5). The frontend SCADA client connects to the `/scada` Socket.IO namespace, but `/scada` is served by sensor-service (`apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts`, internal-network-only port 3000), while nginx routes ALL default `/socket.io/` traffic to gateway-api — which serves only /farms,/messaging,/sensors,/st-language, NOT /scada. So a SCADA handshake reaches the gateway, finds no /scada namespace, and real-time never reaches the device runtime. (During the gateway-502 outage this was masked; it is a standing gap once the gateway is healthy.) **Status: RESOLVED (2026-06-27 — Option A, dedicated path: the SCADA socket.io now uses engine.io path `/scada-ws/` on BOTH the client (web ScadaSocketService) and the sensor-service @WebSocketGateway, and nginx gained an `upstream sensor-service { server sensor-service:3000 }` + `location /scada-ws/` → sensor-service. nginx + sensor-service share aqua-internal so the proxy resolves. Additive — the gateway's /socket.io/ (/farms,/sensors,/messaging,/st-language) is untouched. sensor-service + sensor-module tsc 0, eslint 0, nginx braces balanced. DEPLOY ORDER: nginx first (backward-compatible), then frontend + sensor-service together (the path must match on both ends)).** Rejected: embedding ScadaRuntimeGateway in the gateway (breaks service autonomy) and reusing /sensors (different protocol — tag subscribe/write vs raw readings).

## ORPHAN-MEDIUM-192 — no frontend circuit-breaker; outages keep storming refetch (ORPHAN-188 follow-up)
Found 2026-06-27 (outage plan P4c; the follow-up ORPHAN-188 flagged). ORPHAN-188 stopped a 502 from BLANKING cached data (typed BACKEND_UNAVAILABLE), but `refetchOnWindowFocus`/`refetchOnReconnect` (web/shell bootstrap QueryClient) still re-fired on every tab focus + network blip during an outage — surfacing an error over loaded data and hammering the dead gateway. No health/circuit gate existed anywhere. **Status: RESOLVED (2026-06-27 — added `backendHealthCircuit` (web/shared-ui/src/utils/backend-health-circuit.ts): a dependency-free 3-state breaker (closed→open after 3 consecutive TRANSPORT failures→half-open after a 15s cooldown so a probe can recover). The GraphQL client records a failure on a 5xx and a success on any parsed 200; the shell QueryClient gates refetchOnReconnect+refetchOnWindowFocus on `refetchWhenBackendHealthy` so the focus/reconnect storm is suppressed during a detected outage and resumes on recovery. Only transport failures count (GraphQL errors on a 200 don't); react-query's retry + refetchInterval still probe so recovery never depends solely on the half-open. shared-ui+shell tsc 0; 64/64 specs (api-client 59 incl. no-regression + 5 new circuit incl. fake-timer cooldown); eslint 0).** HR nested QueryClient + tenant-admin query-key drift remain separately tracked.
## ORPHAN-MEDIUM-193 — billing has no functional provider for keyless demo tenants (BILLING_PROVIDER=mock unwired)
Found 2026-06-27 (app.suderra.com outage P1). After #672 decoupled billing boot from the Stripe key (STRIPE_BILLING_ENABLED → UnconfiguredStripeClient), a keyless droplet BOOTS but every billing call THROWS StripeNotConfiguredError — so demo/test tenants (app.suderra.com, operator-stated) cannot use billing at all. A MockBillingProvider existed only as an UNTRACKED draft (never committed, nothing wired it; the factory consulted only NODE_ENV/STRIPE_BILLING_ENABLED). **Status: RESOLVED (2026-06-27 — BILLING_PROVIDER is now the explicit provider SSoT in stripeClientFactory, reconciled with STRIPE_BILLING_ENABLED: `mock`→a functional local MockBillingProvider (committed; implements all 9 IStripeApiClient methods, empty Stripe ids, NO SDK/network — enforced by stripe-calls-via-canonical-client invariant + a source-level spec assertion), `stripe`→real adapter (implies enabled, key mandatory, fail-closed at boot), unset→#672 fallback. docker-compose.droplet.yml defaults BILLING_PROVIDER=mock for the demo droplet (never makes a real charge; flipping to stripe is a deliberate key-bearing act). billing stays a CRITICAL federation subgraph — mock just lets it serve real GraphQL. factory spec (a)-(h) + mock spec = 12/12 green; backend-common+billing tsc 0; banned-construct clean).** Net effect: app.suderra.com billing works locally without Stripe, gateway composes.

---

## ORPHAN-MEDIUM-194 - public /graphql deploy smoke false-failed every deploy on the http→https 301 redirect

Severity: MEDIUM (the make-it-detectable smoke gate added in #674/ORPHAN-189 false-failed EVERY production deploy → spurious "Initiating rollback", masking the real outcome; verified live as the SOLE reason the #676 deploy reported `deploy-production/deploy` failure even though all services landed on #676 healthy + serving). Found 2026-06-27 verifying the #672/#677 deploy.

**Root cause:** the pre-promotion smoke in `scripts/deploy/droplet-up.sh` + the post-deploy smoke in `scripts/deploy/post-deploy-verify.sh` POSTed to `${PUBLIC_SMOKE_ORIGIN:-http://localhost}/graphql`. nginx correctly 301-redirects http→https, so the smoke received `HTTP 301` + a non-JSON body and concluded "the gateway is not serving public traffic — a subgraph is likely down", triggering rollback — when the gateway in fact served `https POST /graphql` → `{"data":{"__typename":"Query"}}` 200 throughout. Verified live: `http POST /graphql → 301 → https://app.suderra.com/graphql`; `https POST /graphql → 200 + valid JSON`.

**Fix:** both smokes now hit the REAL https public path — default `PUBLIC_SMOKE_ORIGIN=https://${SMOKE_HOST}` pinned to the local nginx via `--resolve ${SMOKE_HOST}:443:127.0.0.1` (exercises the exact public TLS path — valid cert/SNI/Host — without external DNS/hairpin), plus `-L --post301 --post302` so an http override still re-POSTs through the redirect; the socket.io handshake got the same `--resolve` + `-L`. The gate's INTENT is preserved (a real 502/non-JSON still fails the deploy) — only the false-positive on the legitimate TLS redirect is removed. `bash -n` clean; live smoke now returns 200 + valid GraphQL JSON + socket.io 200; deploy-ssot invariants green.

Status: RESOLVED (2026-06-27) — the smoke tests the real https path; deploys stop false-failing/rolling-back on the redirect, so #672/#677 land with a SUCCESS verdict. Registry: orphan-findings.md.

## ORPHAN-MEDIUM-195 — HR nested QueryClient + tenant-admin query keys not tenant-scoped (P4c follow-up)
Found 2026-06-27 (outage P4c follow-up). Two web SSoT violations (web/CLAUDE.md): (1) hr-module Module.tsx created its OWN `new QueryClient` (PERF-002) instead of using the host's — splitting cache from the shell AND silently opting HR out of the new backend-health circuit-breaker (P4c/#679); farm/sensor modules correctly rely on the shell's. (2) tenant-admin query keys were NOT tenant-scoped: TenantDashboard used raw `['dashboard',…]`, useDevicePolling `['edgeDevice', deviceId]`, and the key factories (useTenantData tenantKeys, useTenantRoles role/userKeys, useTenantAuditLog auditLogKeys) prefixed a LITERAL 'tenant'/'tenant-roles'/… not the actual tenantId — the FE-CRITICAL-014/015/016 cross-tenant cache-leak class. **Status: RESOLVED (2026-06-27 — HR Module.tsx drops its nested client (host owns the single QueryClient; PII bounded by logout-cleanup); every tenant-admin key now routes through the createTenantQueryKey SSoT (['tenant', tenantId, …]) — factories' `.all` kept as the bare prefix for broad invalidation where it stays a valid prefix, else converted to a function + call sites updated. tenant-admin tsc 0; 59/59 specs (3 shared-ui test mocks gained createTenantQueryKey/getTenantId; the role-key assertion updated to the scoped shape); hr-module 2/2; eslint 0). Note: lib/query-keys.ts is dead (no importer) and still literal-'tenant' — flagged for deletion, not load-bearing.** 

---

## ORPHAN-MEDIUM-196 - production deploy ran from the session-shared /var/aqua-saas working tree → SSoT isolated checkout

Severity: MEDIUM (architectural; the proximate cause of ORPHAN-194's "droplet checkout mismatch" post-deploy-verify failure, and a standing deploy↔session conflict). The prod deploy used `/var/aqua-saas` — the SAME git working tree interactive Claude sessions checkout feature branches into — as its source of truth: `deploy-digitalocean.yml` (capacity-preflight + deploy SSH blocks) did `cd /var/aqua-saas; git fetch; git checkout -f "$DEPLOY_SHA"`, droplet-up.sh + post-deploy-verify.sh ran from there, and the verify asserted `git rev-parse HEAD == TARGET_SHA`. So the deploy's force-checkout fought sessions (discarding their WIP / switching their branch) AND the verify false-failed whenever a session drifted HEAD after promotion (the live incident: verify `expected=<sha> actual=<feature-branch>` while the deployed images + app were correct).

**Architectural SSoT fix (microservice-appropriate — the deployed artifacts come from ONE immutable, deploy-owned, SHA-pinned source, fully decoupled from interactive scratch):**
- **New SSoT snippet `scripts/deploy/deploy-paths.sh`** (sourced, not executed): single definitions of `DEPLOY_SOURCE_REPO=/var/aqua-saas`, `DEPLOY_CHECKOUT_DIR=/var/lib/aqua/deploy/checkout` (deploy already owns `/var/lib/aqua/deploy`), `DEPLOY_ENV_FILE`, `DEPLOY_CERTS_DIR`, plus an idempotent `materialize_deploy_checkout <sha>` (fetch the shared object store — never the interactive HEAD — then `git worktree add --detach --force` / `checkout -f --detach` the SHA into the dedicated worktree; prune + clear stale index.lock + recreate-if-corrupt; symlink the persistent `.env`/`certs/` in). 6-case sandbox-validated.
- **`COMPOSE_PROJECT_NAME=aqua-saas` pinned in the SSoT (DATA-LOSS GUARD):** compose derives its project name — and every named volume (postgres data, NATS JetStream, MinIO, redis) — from the cwd basename; running from the isolated checkout (basename `checkout`) without the pin would create empty `checkout_*` volumes = catastrophic data loss. Pinned to the live `aqua-saas` identity so volumes/networks/containers are reused. Enforced by the invariant.
- **All deploy entry points run from the isolated checkout:** both `deploy-digitalocean.yml` SSH blocks + droplet-up.sh + post-deploy-verify.sh source the snippet, materialize, and `cd "$DEPLOY_CHECKOUT_DIR"`. `/var/aqua-saas` is now ONLY the persistent secrets/certs SSoT + the fetch source — never force-checked-out, so sessions and the deploy stop colliding and the verify can't false-fail on drift.
- **Tier-3 invariant `tests/invariants/deploy-isolated-checkout-ssot.spec.ts` (8 tests):** single checkout-dir definition, the SSoT vars, the materializer shape (detached pin / prune / lock-clear / recreate / symlinks), no `cd /var/aqua-saas` / `git checkout -f` of the deploy source in the scripts or SSH blocks, the COMPOSE_PROJECT_NAME pin, and preservation of rollback + health-gate + the #681 https smoke.

Verification: `bash -n` clean (all deploy scripts); the new invariant 8/8 + deploy-ssot/repo-hygiene/active-path/reachability regressions green. **CANNOT be validated without a real production deploy** — first-deploy watch items: (1) certs/JWT resolve through the symlinked `DEPLOY_CERTS_DIR` (NATS mTLS / postgres-TLS / JWT handshakes), (2) compose reuses the existing `aqua-saas_*` volumes (the COMPOSE_PROJECT_NAME pin should ensure this — verify no empty `checkout_*` volumes appear), (3) one-time worktree creation disk/time.

Status: RESOLVED (2026-06-27) — implemented + locally gate-green; PR for review, NOT auto-deployed (live-deploy mechanism change needs close first-deploy watching with the rollback net). Registry: orphan-findings.md. **UPDATE (2026-06-28, #686 merged + deployed):** isolated-checkout LIVE-VALIDATED — worktree materialized at `/var/lib/aqua/deploy/checkout` (SHA-pinned), the COMPOSE_PROJECT_NAME pin HELD (canary clean: 0 `checkout_*` volumes, all 9 `aqua-saas_*` data volumes preserved — NO data loss), app healthy on the new images + 200. The deploy job still reported the ORPHAN-187 "critical service health check → rollback" race (services nonetheless landed healthy on the new SHA) — likely amplified by the one-time worktree-creation load on this first isolated deploy; a 2nd deploy (worktree exists → only re-pin) should confirm it's transitional. The 300s-SLA race is NOT fully eliminated by #672 (gateway) alone — tracked as remaining ORPHAN-187 tail.

---

## ORPHAN-MEDIUM-197 - hr leave-admin GraphQL ops built ahead of the backend → implemented (9 ops; #3 burndown 42→33)

Severity: MEDIUM (the hr-module Leave-admin UI defined 9 GraphQL ops + hooks the hr-service never exposed → every call 400s; the "FE built ahead of backend" drift class, IMPLEMENT-BACKEND per ORPHAN-183). The leave domain was already rich (`apps/hr-service/src/leave/`: leave-type/balance/request entities, a create/submit/approve/reject/cancel CQRS lifecycle, `leave-accrual.service`, `leave-state-machine`, queries) — only the admin/management ops were missing.

**Implemented (mirroring the established CQRS + state-machine + accrual SSoT; tenant-scoped like every existing leave handler; no `as any`/`?.`):**
- `CreateLeaveType`/`UpdateLeaveType` (TENANT_ADMIN/MODULE_MANAGER; per-tenant `code` uniqueness; code immutable on update).
- `AdjustLeaveBalance` (signed delta into the entity's `adjustment` accumulator; pessimistic lock; fail-closed below-zero).
- `CarryOverLeaveBalances` — **refactored `leave-accrual.service` to extract `carryOverWithinSchema()` as the SSoT** for year-end rollover, and the existing cron now delegates to it (no duplicated balance math).
- `InitializeLeaveBalances` (idempotent seed from `defaultDaysPerYear`, same as the accrual cron).
- `UpdateLeaveRequest` (DRAFT/PENDING only; re-balances the pending reservation) + `WithdrawLeaveRequest` (the state-machine's first-class `WITHDRAWN` transition, ownership-only — NOT mapped to admin cancel; validated through `LeaveStateMachine`, never bypassed; releases pending balance).
- `CheckLeaveOverlap` + `CalculateLeaveDays` queries (overlap predicate mirrors the create-request guard so FE pre-check + server agree; day calc honors weekends + the tenant `Holiday` entity + half-day flags).

Verification: hr-service `tsc` 0; ESLint 0; new `leave-admin-ops.spec.ts` 29/29 (happy + guard/validation + tenant-scoping per op). Baseline 42 → 33 (cumulative #3 burndown 130 → 33, ~76%). Pre-existing (NOT a regression, confirmed on baseline via stash): `leave.integration.spec.ts` fails on a missing `OutboxPublisher` test provider (untouched handlers) — flagged separately.

Status: RESOLVED (2026-06-28) — 9 ops implemented + tested; the Leave-admin UI (CreateLeaveType/balances pages) now resolves. Remaining #3 tail: 29 hr (cert/training-admin, performance analytics, rotations analytics, detail-by-id) + 3 aquamobil + 1 sensor (CancelVfdChangeSet) — backend-feature-debt by product priority. Registry: orphan-findings.md + graphql-fe-drift.baseline.json.

---

## ORPHAN-MEDIUM-198 - the residual deploy "critical service health check → rollback" race is the gateway, CPU-starved under the cold-boot thundering herd (ORPHAN-187 tail)

Severity: MEDIUM (every recent deploy reports `deploy-production/deploy` failure + "Initiating rollback" — though services nonetheless land healthy on the new SHA, so it is a false/incomplete rollback that masks real outcomes + denies a clean post-deploy-verify; the ORPHAN-187 300s-SLA tail that #672 did not fully close). Root-caused live (gateway boot logs + Docker healthcheck probe history on the #686/#688 deploys).

**Root cause (NOT composition-blocking — #672 works):** the gateway boots fast — `BackgroundCompositionManager` backgrounds composition, `Nest application successfully started` at ~+2s, `/health/live` answers `200 5ms`. BUT the deploy gate measures Docker `healthy`, and the Docker healthcheck (`curl -sf /health/live`, **timeout 10s**) **timed out at ~+70s** (probe exit -1) and the container only flipped `healthy` at ~+100s. During the simultaneous cold-boot of ~14 NestJS services + postgres on the 4-CPU droplet, the gateway process is CPU-starved, so a normally-5ms probe exceeds the 10s curl timeout. The catalog's `startupBudgetSeconds: 40` (set assuming composition-background = fast, on an unloaded box) under-counted the real ~100s under-thundering-herd time → the gate fails the gateway → "rollback".

**Fix (targeted, SSoT, data-driven — reflect the real under-load timing):**
- compose gateway healthcheck `timeout` 10s→30s + `start_period` 30s→60s (tolerate the transient CPU starvation; early storm-probes don't count toward `retries`).
- service-catalog `gateway-api.startupBudgetSeconds` 40→120 (real under-herd time). The derived `readiness_sla_seconds` stays 300 (gateway 120 ties the existing farm 120 max; +180 margin). Regenerated all catalog/registry artifacts.
- The `start_period ≤ SLA` invariant still holds (60 ≤ 300).

**Deeper fix flagged (not in this PR):** the real driver is the thundering-herd cold-boot saturating the 4-CPU box — a staggered/dependency-ordered bring-up in droplet-up.sh (instead of `up -d` all at once) would shrink the storm so no critical service is starved. Tracked for a follow-up; this PR makes the gate tolerate the real timing meanwhile.

Verification: compose YAML valid; catalog/criticality/startup-budget invariants green (11 tests); SLA regen = 300. CANNOT fully validate without a real deploy — first-deploy watch: gateway flips `healthy` within the 30s-timeout probes + the gate passes (no "rollback").

Status: RESOLVED (2026-06-28) — gateway budget + healthcheck reflect the real under-load timing; PR for review (next deploy should pass the gate). Deeper staggered-bring-up tracked separately. Registry: orphan-findings.md.

---

## ORPHAN-MEDIUM-200 — tenant query keys lack a cache-generation epoch (SUPER_ADMIN A→B→A serves stale cache)
Found 2026-06-28 (tenant-panel WS-2 gap audit vs main). `createTenantQueryKey` isolates tenant A's cache from B's via the `['tenant', tenantId, …]` prefix, but does NOT distinguish two SESSIONS of the same tenant: on a SUPER_ADMIN impersonation round-trip (A→B→A), switching back to A reproduces A's exact keys, so React Query serves A's PRE-switch (possibly stale) cache. The 502-resilience / refetch-storm / HR-nested-QC / transport gaps were already closed by #673/#679/#682; this cache-generation gap remained. **Status: RESOLVED (2026-06-28 — added `web/shared-ui/src/utils/session-epoch.ts`: a monotonic counter bumped on every actual tenant change (`api-client.setTenantId`) and on logout (`clearSession`); `createTenantQueryKey` now APPENDS `{ __sessionEpoch }` as the LAST key segment so each tenant (re)entry gets a fresh cache generation (the prior is orphaned/GC'd), while `domain` stays at index 2 — `resolveStaleTime` and prefix invalidations are unaffected. shared-ui is a federation singleton so the epoch is shared across remotes. 3/3 vitest + tsc clean.)** The full unified SessionSnapshot SSoT (token-lifecycle tenant-verified `ready` + `useTenantQuery` hook) remains a larger follow-up; the epoch closes the impersonation cache-freshness hole.

## ORPHAN-MEDIUM-201 — farm DepartmentsTab shows false "Not associated with any site" (2nd-query join, not dept.site)
Found 2026-06-27 (tenant-panel WS-5 gap audit vs main #681). The departments table rendered the site-name cell from a SECOND `useSiteList()` query — `web/modules/farm-module/src/pages/setup/tabs/DepartmentsTab.tsx:341` `sites.find(s => s.id === dept.siteId)` — so whenever that list was still loading, empty, or past its `limit:100`, a department with a valid `siteId` falsely rendered "Not associated with any site", even though `useDepartments` already fetches the nested `site { id name }` on each department row. **Status: RESOLVED (2026-06-27 — the name cell now renders `dept.site?.name` directly from the department's own fetched field; the `sites.find` join is dropped (the `sites`/`useSiteList` list stays for the filter + edit-form dropdowns). The red orphan-row highlight already keyed on `!dept.siteId`, so a genuinely site-less department still shows the red state.)** Tenant-panel WS-5. (Renumbered from ORPHAN-MEDIUM-195 at merge — main's 195 was concurrently taken by the HR/tenant-admin query-key finding.)

## ORPHAN-MEDIUM-202 — equipment_types mixed contract: global @SkipTenantGuard read + tenant-blind in-process cache (cross-tenant leak)
Found 2026-06-28 (tenant-panel WS-5 gap audit vs main). equipment_types is cloned PER-TENANT (the entity omits `schema:`, MODULE_SCHEMAS clones it into each `tenant_<uuid>`), and the EquipmentTypeLookupService reads the per-tenant copy under tenant context — but the GraphQL `equipmentTypes`/`equipmentType` resolvers carried `@SkipTenantGuard` (`apps/farm-service/src/equipment/equipment.resolver.ts:162,176`) and the handler cached results in a process-wide Map keyed by the serialized FILTER ONLY (`get-equipment-types.handler.ts:47`), so the FIRST tenant's result was served to EVERY other tenant. Two read paths (GraphQL global vs lookup per-tenant) hit different physical tables. **Operator decision: per-tenant catalog. Status: RESOLVED (2026-06-28 — removed `@SkipTenantGuard` from both resolvers so they run tenant-scoped (search_path → `tenant_<uuid>.equipment_types`, the same table the lookup service reads); DELETED the tenant-blind in-process cache (the leak's root cause — equipment_types is small reference data and React Query already caches it per-tenant client-side via a tenant-scoped query key); gated the FE `useEquipmentTypes` hook on `!!token && !!tenantId`. The `farm-service-tenant-isolation` invariant already allows equipmentType repo reads without a tenantId where-clause (search_path isolation), so the change is invariant-safe.)** Note: that invariant's allowlist comment still calls equipmentType a "global catalogue" — semantically stale post-change (doc only). (Renumbered from ORPHAN-MEDIUM-196 at merge — main's 196 was concurrently taken by the deploy isolated-checkout finding.)

## ORPHAN-MEDIUM-203 — farm species list silently truncated at 20 (server default limit, no FE pagination)
Found 2026-06-28 (tenant-panel WS-5 gap audit vs main). SpeciesTab called `useSpeciesList()` with no pagination, and the backend `SpeciesFilterInput.limit` defaults to 20 (`list-species.handler.ts:25` `?? 20`), so a tenant with >20 species only ever fetched the first 20 (alphabetical) — the rest silently vanished after a refetch/focus, even though the `speciesList` response already returns `hasNextPage`/`totalPages`. **Status: RESOLVED (2026-06-28 — `useSpeciesList` accepts an explicit `limit`/`offset`; SpeciesTab requests `limit: 100` (the SpeciesFilterInput @Max, which covers a setup catalog) and renders a disclosure banner when `hasNextPage` so any overflow beyond 100 is surfaced, never silently dropped. Client-side search/category/water-type/status filtering is unchanged.)** Follow-up if a tenant exceeds 100 species: promote search/filter to server-side + a full paginator (the input already supports limit/offset). (Renumbered from ORPHAN-MEDIUM-197 at merge — main's 197 was concurrently taken by the hr leave-admin GraphQL finding.)

## ORPHAN-MEDIUM-198 — GraphQL FE-drift baseline has no hard no-grow gate (new 400-drift can be silently baselined)
Found 2026-06-28 (tenant-panel FE-DRIFT gap audit vs main). `scripts/ci/graphql-fe-drift.baseline.json` is a 42-op burn-down ratchet of known FE↔supergraph drifts (FE documents the deployed supergraph rejects → HTTP 400 in the browser — the tenant-panel `/graphql` 400 class). `validate-graphql-operations.mjs` blocks NEW drift not in the baseline, and the baseline's `$schema` says it "MUST only shrink" — but nothing ENFORCED that: `--update-baseline` (intended for after-fix regen) silently absorbs a new drift if one is present, growing the count and re-opening the 400-class. **Status: RESOLVED (2026-06-28 — added `tests/invariants/graphql-fe-drift-baseline-no-grow.spec.ts` (jest layer-1): asserts the baseline `count === operations.length`, `count <= BASELINE_CEILING` (42 high-water mark that may only be LOWERED — a review-visible ratchet edit), and all op keys unique. Growing the baseline now fails CI; the active #655/#663 burn-down keeps shrinking it.)** The full platform-wide farm-style FE↔BE parity INVARIANT (vs the gql:validate-ops script gate) remains a larger follow-up.

## ORPHAN-MEDIUM-204 — frontend enforcement gates: nested-QueryClient ban + raw-fetch ratchet (A7 debt tracked)
Found 2026-06-28 (tenant-panel PR-E). Two regression-proofing invariants added to lock in the merged WS-2 fixes:
1. **`tests/invariants/web-remotes-no-nested-queryclient.spec.ts`** — bans `QueryClientProvider`/`new QueryClient()` in federated remote code (excludes the `main.tsx` standalone dev entry + test dirs). Locks in the hr-module A6 fix (#682): a nested provider gets a SEPARATE cache the shell's tenant-logout `clear()`/invalidation never reach → stale/cross-tenant data after a switch/logout. GREEN on main.
2. **`tests/invariants/web-no-raw-graphql-rest-fetch.spec.ts`** — bans NEW raw `fetch('/graphql'|'/api')` in `web/modules` + `web/shell/src`; raw transport bypasses the shared client's auth-barrier wait / JWT / `x-tenant-id` / 502-handling (the `/graphql` 400 + missing-tenant + refetch-storm class). Shrink-only ratchet over a frozen `KNOWN_OFFENDERS` list; a baselined file that stops offending FAILS the ratchet test until removed (can't go stale).
**A7 DEBT (the 4 baselined offenders — tracked, NOT silenced):** the pre-auth forms (`ForgotPassword`/`Reset`/`AcceptInvitation`, raw `/graphql`) need a sanctioned **`publicGraphqlClient`** (barrier-skipping, no auth/tenant header) which does NOT yet exist in shared-ui; farm `useChemicals` uploads (2× `/api`) need **`restClient` multipart** (restClient is JSON-only today, `api-client.ts:758`). **Status: gates RESOLVED + green; A7 burndown OPEN** — migrate the 4 files through the sanctioned clients, then remove each from `KNOWN_OFFENDERS` (the ratchet forces removal once fixed). The gate makes the debt detectable + regression-proof while A7 lands — make-detectable tier, not a patch.

## ORPHAN-MEDIUM-205 — A7 step 1: pre-auth forms migrated off raw fetch to publicGraphqlClient (ratchet 4→1)
Found 2026-06-28 (tenant-panel A7 — burndown of ORPHAN-204's raw-fetch debt). The 3 shell pre-auth forms (ForgotPassword / ResetPassword / AcceptInvitation) POSTed to `/graphql` via raw `fetch` because no sanctioned pre-auth GraphQL client existed. **Status: RESOLVED (2026-06-28 — added `publicGraphqlClient` (`web/shared-ui/src/utils/api-client.ts`): a barrier-skipping pre-auth client that sends NO `Authorization`/`X-Tenant-Id` header (the ops are unauthenticated + tenant-agnostic) and keeps the typed 5xx transport-error handling — a 502 during forgot-password now surfaces `BACKEND_UNAVAILABLE` instead of a JSON-parse crash. Migrated all 4 pre-auth fetch calls across the 3 forms; removed them from the `web-no-raw-graphql-rest-fetch` ratchet's `KNOWN_OFFENDERS` (4→1). 3/3 vitest + ratchet green + tsc clean.)** A7 step 2 (the last offender — farm `useChemicals` 2× `/api` upload) needs `restClient` multipart support (JSON-only today); tracked, the ratchet still enforces it.

---

## ORPHAN-MEDIUM-206 - GraphQL FE↔supergraph drift burndown COMPLETE (139 → 0; ratchet locked at 0)

The #3 burndown is finished. The audit started at ~139 FE GraphQL ops the FE issued but the composed supergraph could not resolve (every one a 400 in production); the SSoT count is `scripts/ci/graphql-fe-drift.baseline.json`. Burned via #623 (dashboard) → #650/#654/#655/#663/#665 (farm/mcp/sensor/tenant-admin/aquamobil clean-rename + consumer-rework + dead-code + orphan) → #688 (hr leave-admin, 9) → and this final PR which implemented EVERY remaining "FE built ahead of backend" op against its (already rich) backend domain:
- **hr certification/training (15):** create/update/get CertificationType + TrainingCourse, RenewCertification, Start/WithdrawFromTraining, BulkEnrollInTraining, employee/compliance/work-area/mandatory status reports, and **GetTrainingCalendar** — which required a NEW per-tenant `TrainingSession` sub-domain (entity + blue-green migration + MODULE_SCHEMAS clone-list registration + tenant RLS).
- **hr rotation/work-area (8):** GetWorkArea/GetWorkRotation by-id, work-area occupancy (single + all), current/upcoming rotations, rotation calendar + changeovers — computed from existing entities + the rotation-state-machine.
- **hr performance + attendance (6):** GetShift by-id; team-performance overview, department KPIs, review-cycle status, goal-progress trend, BulkCreateReviews.
- **aquamobil (3):** GetAiConsentStatus/ToggleAiConsent + StockAtLocation were FE-invented shapes — reshaped to the REAL backends (`aiSettings`/`updateUserAiConsent` in messaging-service; `storageInventory` in farm-service). No speculative backend.
- **sensor (1):** CancelVfdChangeSet (CANCELLED state) — folded in from PR #691.

Every backend op mirrors its domain's established CQRS + tenant-scoping (search_path / explicit tenantId predicate; no raw getRepository), no unsafe casts / ts-suppressions / defensive optional-chaining-to-hide, explicit return types, guards + @AuditLog on mutations, London-school handler specs (happy + guard/validation + tenant-scoping). Verification: hr-service `tsc` 0 (all clusters together), sensor-service `tsc` 0, drift invariants 72/72 (incl. the no-grow ratchet). Baseline 33 → **0**; `BASELINE_CEILING` lowered 42 → **0** in `graphql-fe-drift-baseline-no-grow.spec.ts` so any NEW FE↔supergraph drift now fails CI (Tier-3, strongest ratchet).

Status: RESOLVED (2026-06-28) — drift count 0, ratchet locked at 0. Registry: orphan-findings.md + graphql-fe-drift.baseline.json. Supersedes/closes the per-cluster work + PR #691 (sensor folded in).

---

## ORPHAN-MEDIUM-207 - pre-existing hr-service integration specs fail under the transactional-handler refactor (stale specs, not a regression)

While implementing ORPHAN-206, four hr-service `*.integration.spec.ts` suites were observed RED on the untouched baseline (confirmed via `git stash` — they fail identically without any of this PR's changes): `training.integration.spec.ts` (28/28), `attendance.integration.spec.ts`, `performance` integration, and `scheduling/conflict-detection.service.spec.ts`. Root cause: handlers were earlier refactored (HR-HIGH-013/014) to transactional `DataSource`/`queryRunner.manager`, and these older specs build a `TestingModule` that mocks repositories but provides no `DataSource` / certain providers (`OutboxPublisher`, `MobileCommandReceiptService`, `HolidayRepository`) → `Nest can't resolve dependencies`. NOT caused by ORPHAN-206 (its new ops ship with their own green London-school specs). Scoped out as self-contained spec rewrites.

Status: RESOLVED (2026-06-28). Surfaced + fixed while landing #697 (which makes hr-service `affected`, so CI runs these — merge-gate requires the `test` job green). All 7 broken suites revived (stale specs only — zero production change): attendance/training/leave integration gained the missing DI providers (MobileCommandReceiptService / a transactional DataSource→queryRunner→manager mock / OutboxPublisher) + migrated event assertions from deprecated class-instances to factory `eventType` + outbox `enqueue`; conflict-detection gained the HolidayRepository provider; approve-payroll gained `repository.create` on its mock; create-employee's ordering assertion corrected to the transactional-outbox contract (enqueue BEFORE commit); payroll.integration rebuilt around the flattened earnings/deductions columns. Full hr-service jest: 25 suites / 344 tests green. Two REAL production bugs surfaced by these specs are filed separately (ORPHAN-208, ORPHAN-209) — NOT fixed in #697 (owned by the hr domain; production untouched here). Registry: orphan-findings.md.

---

## ORPHAN-HIGH-208 - create-payroll silently drops earnings/deductions (writes getter-only virtuals → NOT-NULL violation / lost breakdown)

Severity: HIGH (payroll data correctness). Found 2026-06-28 (surfaced by reviving payroll.integration.spec for #697). `apps/hr-service/src/hr/handlers/create-payroll.handler.ts` (~line 179) builds nested `earnings`/`deductions` objects and passes them to `queryRunner.manager.create(Payroll, { earnings, deductions, … })`. But DB-MEDIUM-004 flattened those breakdowns into typed columns (`earningsBaseSalary`/`earningsGrossPay`/`deductionsTotal`/…) and made `earnings`/`deductions` getter-ONLY virtuals. Verified against TypeORM source: `EntityManager.create` → `PlainObjectToNewEntityTransformer` copies only `metadata.nonVirtualColumns`, so the nested objects are SILENTLY DROPPED — the flattened NOT-NULL columns (`earningsGrossPay!`, `deductionsTotal!`, `earningsBaseSalary!`) are left undefined → a real insert violates NOT NULL, and the getters return undefined. `CreatePayrollHandler` is the only writer; no setter/subscriber/@BeforeInsert maps nested→flat. Architectural fix (production, owner: hr): the handler must write the flattened columns directly (or add a nested→flat @BeforeInsert mapper on the entity). Detectability: payroll.integration.spec marks the breakdown assertions `it.failing(...)` as a Tier-3 tripwire — when the handler is fixed they flip to passing and Jest fails the `it.failing` marker, prompting removal. Status: OPEN (owner: hr domain). Registry: orphan-findings.md.

---

## ORPHAN-MEDIUM-209 - checkMinimumRest never detects conflicts for Date-typed shift times (ISO-string split → NaN)

Severity: MEDIUM (scheduling safety — minimum-rest violations go undetected). Found 2026-06-28 (surfaced by reviving conflict-detection.service.spec for #697). `apps/hr-service/src/scheduling/services/conflict-detection.service.ts` `checkMinimumRest` (~lines 316-334) does `currentEndTime instanceof Date ? currentEndTime.toISOString() : raw` then `currentEndTime.split(':')[0]` as hours. But HR-MEDIUM-003 migrated `WeeklyPlanEntry.plannedStartTime/plannedEndTime` to `timestamptz` → typed `Date`. For a real `Date`, `.toISOString()` = `'2026-01-12T15:00:00.000Z'`, and `'2026-01-12T15'.split(':')[0]` parses to NaN → `restMinutes` = NaN → `NaN < minRestMinutes` is always false → insufficient-rest conflicts are NEVER detected. Only works when the field is a raw `HH:MM` string (which the spec happened to feed). Architectural fix (production, owner: hr/scheduling): derive hours/minutes from the Date via `getUTCHours()/getUTCMinutes()` (accounting for the date component in the rest-window math) instead of string-splitting an ISO timestamp. Status: OPEN (owner: hr/scheduling domain). Registry: orphan-findings.md.

---

## ORPHAN-HIGH-211 - isolated-checkout deploy bootstrap depended on the stale /var/aqua-saas working tree → every deploy failed at capacity-preflight, rolling back to old code

Severity: HIGH (production deploy outage — the droplet was stuck on an old SHA; no new code, incl. the GraphQL burndown + #689 gateway-race fix, could go live). Root-caused live 2026-06-28.

The isolated-checkout SSoT (#686) deliberately stopped the deploy from `git checkout`-ing `/var/aqua-saas` (so engineering/agent sessions and the deploy stop fighting over its HEAD). BUT both deploy SSH blocks (capacity-preflight + deploy) then `source /var/aqua-saas/scripts/deploy/deploy-paths.sh` — reading the SSoT script from that SAME working tree. Since the deploy no longer updates it, `/var/aqua-saas` drifted to whatever a session last left it on (observed: branch `main` at `55972b357`, **190 commits / 9 days behind**, PRE-`deploy-paths.sh`). `source` of a non-existent file → `set -e` abort → **capacity-preflight failed → the deploy job (which `needs` it) was skipped → no deploy → rollback to the last image set (`2de19d365`)**. Every deploy after #686 silently degraded this way; the `rollback-*` image tags on the droplet are the evidence. The gateway-race fix (#689) was moot because the run never reached the deploy job.

**Fix (root cause — the deploy bootstrap must be working-tree-independent):** both SSH blocks now `cd /var/aqua-saas && git fetch --force --prune origin` then extract deploy-paths.sh from the pinned DEPLOY_SHA via `git show "${DEPLOY_SHA}:scripts/deploy/deploy-paths.sh" > /var/lib/aqua/deploy/deploy-paths.sh` and source THAT. `git show <sha>:<path>` reads the blob from the object store, never the working tree — so the deploy is immune to whatever stale branch `/var/aqua-saas` sits on (the very decoupling #686 intended, now completed for the bootstrap too). `materialize_deploy_checkout` already operates on the object store (worktree add/checkout of the SHA), so it was never the problem. YAML re-validated; both blocks stay under the 21k expression limit.

Status: RESOLVED (2026-06-28) — bootstrap reads deploy-paths.sh from the SHA; PR for review + the deploy of this fix re-validates it (GitHub reads the workflow from main, so the fixed bootstrap runs on the next deploy). Registry: orphan-findings.md. Follow-up: a stale `/var/aqua-saas` no longer breaks deploys, but consider a periodic `git fetch` housekeeping so its objects stay warm.

## ORPHAN-MEDIUM-212 — socket lifecycle (PR-B2): tenant-switch teardown + /scada connect tenant-gating
Found 2026-06-28 (tenant-panel PR-B2 vs main). (1) socketFactory pooled Socket.IO connections (keyed `${url}::${tenantId}`) were torn down only on LOGOUT (`registerLogoutCleanup`) — on a tenant switch A→B the leaving tenant's sockets lingered refcounted in the pool, still delivering tenant-A realtime events (sensor / alarm / edge I/O) into the tenant-B session on the same browser. (2) `ScadaSocketService.connect()` gated on token only, not tenant. **Status: RESOLVED (2026-06-28 — socketFactory registers `onTenantChange(teardownTenantSockets)`: on a switch it disconnects + removeAllListeners + evicts every pool entry whose key ends with `::oldTenantId`; `ScadaSocketService.connect()` now also requires `getTenantId()` (silent defer otherwise, matching socketFactory + the sibling sockets). 5/5 vitest (`socketFactory.tenant-teardown` + `ScadaSocketService.connect-gating`) + tsc clean.)** B4 (bounded backoff) was already in place — `reconnectionAttempts: 20`, not `Infinity` (the v4 plan claim was stale). The releaseSocket refcount residual is [[ORPHAN-MEDIUM-213]].

## ORPHAN-MEDIUM-213 — socketFactory releaseSocket re-derives the CURRENT tenant (refcount mis-target after a switch)
Found 2026-06-28 (tenant-panel PR-B2). `releaseSocket(url)` computes its pool key from `getTenantId()` AT RELEASE TIME, not from the tenant the caller acquired under. After a tenant switch, an A-bound hook's cleanup `releaseSocket(url)` targets `::B` (the current tenant) and can decrement — and prematurely tear down — tenant B's socket. ORPHAN-212's `onTenantChange` teardown already severs the LEAK (A's sockets), so this is a narrower refcount-accuracy race, not a residency leak. **Status: RESOLVED (2026-06-29 — `releaseSocket(socket: Socket | null)` now releases by socket IDENTITY (`entry.socket === socket`); the tenant-derived path is REMOVED entirely, so the ambient `getTenantId()` can no longer mis-target. All 7 callsites (useEdgeIoSocket / useSensorSocket / useAlarmRuntime ×4 / useScadaLiveData) thread the socket they hold — tsc-enforced (a string arg is now a type error, so no caller can be missed). A release after an A→B switch tears down A's entry, never B's. Full sensor-module 1249/1249 incl. a switch-immune identity unit test + a null no-op test.)**

---

## ORPHAN-HIGH-214 — admin-api writes/locks `auth.tenants` directly (lifecycle handlers + create duplicate-check), blocking the SEC-015/D14 least-privilege REVOKE; the REVOKE never landed in prod due to in-place migration edit drift

Severity: HIGH (cross-service privilege-boundary breach — `admin_service` currently holds INSERT/UPDATE/DELETE on the authoritative tenant SSoT table). Discovered 2026-06-28 while root-causing the `POST /api/v1/tenants` 500 ("Database operation failed") on app.suderra.com.

**Problem:** Per D14/SEC-015, `auth.tenants` is owned by auth-service and admin-api may only READ it (`admin_service` = SELECT). But admin-api locks/over-reaches `auth.tenants` directly via the `Tenant` entity (`@Entity('tenants', { schema: 'auth' })`):
- `apps/admin-api-service/src/tenant/handlers/suspend-tenant.handler.ts` — the four lifecycle handlers (suspend/activate/deactivate/archive) take `lock: { mode: 'pessimistic_write' }` (`FOR UPDATE`) on `auth.tenants` (lines 61/175/283/369). They mutate the entity **in memory only** (`tenant.status = …`) — there is no `manager.save(Tenant)` on any of the four; the actual status write is delegated to auth-service (`authProvisioningClient.*`) and admin-local lifecycle metadata already persists to `admin.tenant_activities`. So the boundary breach is the **`FOR UPDATE` lock** (which needs the UPDATE privilege), not an actual UPDATE statement.
- `apps/admin-api-service/src/tenant/services/tenant-provisioning-workflow.service.ts` `assertNoDuplicateTenant` took `lock: { mode: 'pessimistic_read' }` (`FOR SHARE`) on `auth.tenants` (FIXED in the create-500 PR — lock removed; uniqueness is enforced by auth-service `reserveTenant` + the `auth.tenants` unique constraints).

PostgreSQL requires the UPDATE privilege to take ANY row lock (`FOR SHARE`/`FOR UPDATE`). So the intended `REVOKE INSERT, UPDATE, DELETE ON auth.tenants FROM admin_service` (SEC-015 least-privilege) cannot be applied while these `FOR UPDATE` locks exist — it would turn every suspend/activate/deactivate/archive into a `permission denied for table tenants` 500.

**Additional latent auth.* over-privilege from the SAME in-place edit (e147c9dfb→42695736f):** the deployed (pre-edit) `1800400000000` ALSO `GRANT`ed `admin_service` full DML on `auth.tenants` and ran `GRANT CREATE ON DATABASE … TO admin_service`; the edit removed both (privilege-tightening) but, like the REVOKE, it never landed. So on the droplet `admin_service` currently holds INSERT/UPDATE/DELETE on `auth.tenants` AND `CREATE ON DATABASE` (verified read-only: `has_table_privilege('admin_service','auth.tenants','UPDATE')` = `t`) — both must be revoked as part of the capstone.

**Dead auth.* writers (re-introduction landmines):** `apps/admin-api-service/src/users/services/tenant-role.service.ts` (raw writes to `auth.tenant_roles` + `auth.tenant_role_permissions`) and `apps/admin-api-service/src/users/services/user-role-assignment.service.ts` (writes to `auth.user_role_assignments`) write auth.* directly. Both are currently dead/unwired (registered in no `*.module.ts`, reached by no controller), so not an active breach — but `auth.tenant_roles` is in the intended REVOKE set, so a future wiring would silently re-breach. Delete these dead services (tier-1 make-it-impossible) as part of the capstone.

**How to fix (capstone of "admin-api read-only on auth.tenants"):**
1. Refactor the four lifecycle handlers: drop the `FOR UPDATE` lock + the dead in-memory `tenant.status` mutation; the auth-service command is already the SSoT write — re-read the snapshot for the return value. No new admin metadata table is needed (`admin.tenant_activities` already holds it).
2. Delete the dead auth.* writer services above; audit for any other admin-api writers/locks of `auth.*`.
3. Ship a NEW forward migration re-applying the full SEC-015 read-only posture on `auth.*` (GRANT SELECT; REVOKE INSERT/UPDATE/DELETE) AND revoking `CREATE ON DATABASE` from `admin_service` — only AFTER (1)+(2) deploy (expand/contract: code first, REVOKE second, so no in-flight old container hits a denied lock).
4. Add a boot-time/CI assertion that `admin_service` has no write privilege on `auth.*` and no `CREATE` on the database.
5. (Optional, cosmetic) Map PG `23505` on the `auth.tenants` slug/customDomain unique constraints to `ConflictException` inside auth-service `reserveTenant` so a true concurrent-insert race surfaces a clean conflict on the status URL rather than a raw `QueryFailedError`.

Status: OPEN (owner: auth-security-expert / multi-tenant-saas-expert / admin-expert). Registry: orphan-findings.md only.

---

## ORPHAN-HIGH-215 — tenant creation 500 ("Database operation failed") on app.suderra.com: in-place edit of an already-shipped migration left the deployed schema frozen pre-edit

Severity: HIGH (production: every `POST /api/v1/tenants` failed). Discovered + fixed 2026-06-28.

**Problem:** Migration `apps/admin-api-service/src/migrations/1800400000000-TenantProvisioningWorkflow.ts` was hand-edited IN PLACE (commit `42695736f` edited the file created by `e147c9dfb`) AFTER it had already been recorded in the deployed `admin.migrations` ledger. TypeORM's `MigrationExecutor` keys the ledger by migration NAME, so an already-recorded migration is never re-run — the edit's DDL silently never landed on the droplet. The deployed `admin.tenant_provisioning_runs` was frozen in its pre-edit shape (missing `leaseToken`/`leasedBy`/`heartbeatAt`/`leaseExpiresAt`, missing `stepOrder` on steps, missing `tenant_onboarding_acks`, missing the `RESERVING` state value, and still carrying `fk_tenant_provisioning_runs_tenant` which breaks the run-before-tenant INSERT). Runtime code (built from the edited source) referenced `leaseToken`, so `createTenantOperation`'s first statement raised `QueryFailedError: column "leaseToken" does not exist` → the admin-api global filter's generic QueryFailedError branch → a redacted 500 "Database operation failed". Confirmed firsthand via live droplet logs (`docker logs aqua-admin-api`) + DB inspection, which disambiguated this (H1, SQLSTATE 42703) from the privilege hypothesis (H2).

**Resolution (this PR):**
1. New forward migration `1801200000000-TenantProvisioningWorkflowLeaseAndOnboardingAcks.ts` idempotently completes the workflow surface (lease columns, RESERVING check, indexes, stepOrder, onboarding-ack ledger, DROP of the run→tenant FK, admin.* grants). Applied to the live droplet DB and verified (replays idempotently; full create path unblocked).
2. Removed the useless cross-boundary `FOR SHARE` lock in `assertNoDuplicateTenant` (uniqueness SSoT = auth-service `reserveTenant` + auth.tenants unique constraints).
3. NEW systemic guard `tools/gates/migration-immutability-witness.ts` + `tests/invariants/migration-immutability.spec.ts` + CI job: an in-place edit of an already-shipped migration now fails CI, closing the bug class.

The remaining least-privilege drift (admin_service over-privileged on auth.tenants) is tracked separately as [[ORPHAN-HIGH-214]].

Status: RESOLVED (2026-06-28; fix branch `fix/tenant-provisioning-schema-drift`). Registry: orphan-findings.md only.

## ORPHAN-MEDIUM-216 — PR-A core start: useTenantQuery / useTenantMutation SSoT hooks (A2) + first adoptions
Found 2026-06-29 (tenant-panel PR-A core). Every tenant-scoped query hand-assembles three things — the `createTenantQueryKey(tenantId, …)` prefix, the `!!token && !!tenantId` enabled gate, and (missing almost everywhere) `placeholderData: keepPreviousData` — so any one is a latent cross-tenant leak / missing-tenant fetch / blank-on-error UX bug. **Status: RESOLVED — hooks landed + first adoptions (2026-06-29 — added `web/shared-ui/src/hooks/useTenantQuery.ts`: `useTenantQuery(segments, queryFn, options)` bakes in the tenant prefix + the auth enabled-gate (ANDed with a caller's `enabled`) + `keepPreviousData` (A5 — stop blanking on a transient error); `useTenantMutation(mutationFn, { invalidate })` standardizes tenant-scoped invalidation (declare DOMAIN segments, the tenant prefix is added automatically). Exported from the barrel; 5/5 renderHook vitest. Adopted in 2 farm hooks (`useEquipmentTypes`, `useSpeciesList`) as real proof — NOT unused machinery; farm-module 44/44 + tsc clean on shared-ui + farm-module. Dropped a redundant double-`tenantId` key segment in useSpeciesList.)** REMAINING (next PR-A pieces, tracked): migrate the rest of the tenant query/mutation callsites incrementally; the **A1** unified SessionSnapshot read-model (+ AuthContext-pushed `tenantStatus` for a tenant-VERIFIED `ready`); an E-series enforcement gate to require `useTenantQuery` over bare `useQuery` + `createTenantQueryKey`.

## ORPHAN-MEDIUM-217 — PR-A migration batch 1: 4 farm query hooks → useTenantQuery (+ latent species-detail invalidation fix)
Found 2026-06-29 (tenant-panel PR-A incremental migration of [[ORPHAN-MEDIUM-216]]). Migrated `useEquipmentList`, `useEquipmentDeletePreview`, `useSpecies` (detail), `useActiveSpecies` from hand-rolled `useQuery` + `createTenantQueryKey` + manual `enabled` to `useTenantQuery` — each now gets `keepPreviousData` (A5) + a consistent tenant gate. **Status: RESOLVED (2026-06-29 — 4 hooks migrated; removed the now-unused `useQuery` + `createTenantQueryKey` imports; farm-module 44/44 + tsc + eslint clean.)** Also fixed a LATENT bug: `useSpecies`/`useActiveSpecies` keys carried a redundant extra `tenantId` segment (`createTenantQueryKey(tid,'species','detail',tid,id)`), so the mutation invalidation `createTenantInvalidationKey(tid,'species','detail',id)` NEVER matched the detail query (position-4 mismatch: `id` vs `tid`) — species detail was not being invalidated after an update. Dropping the redundant segment makes the prefix invalidation match. Remaining migration (other modules + mutations → `useTenantMutation`) continues under ORPHAN-216.

## ORPHAN-MEDIUM-218 — PR-A A1: SessionSnapshot read-model + first consumer (socket-gate consolidation)
Found 2026-06-29 (tenant-panel PR-A A1, continues [[ORPHAN-MEDIUM-216]]). The non-React layers scatter `getAccessToken() && getTenantId()` checks to answer "is there an authenticated tenant session". **Status: RESOLVED — read-model landed + consumed (2026-06-29 — added `web/shared-ui/src/utils/session-snapshot.ts`: `getSessionSnapshot()` composes `accessToken` + `effectiveTenantId` + `sessionEpoch` + `tokenState` from the existing authorities, with `ready = !!accessToken && !!effectiveTenantId`. Exported from the barrel. CONSUMED (not Potemkin): `socketFactory.getSocket` now reads one `getSessionSnapshot()` instead of separate `getAccessToken()`/`getTenantId()` gates (the `getTenantId` import dropped). 3/3 session-snapshot vitest + full sensor-module 1249/1249 + tsc clean.)** SCOPE: the tenant-VERIFIED `ready` (`tenantStatus===ACTIVE`) + `userId`/`role` need AuthContext to PUSH the server-resolved status + a reactive subscribe `tokenLifecycle` doesn't expose — a later piece; backend `EffectiveTenantMiddleware` (PR-C / #667) is the tenant-status authority. Remaining (under ORPHAN-216): consume in the other gates (`ScadaSocketService.connect`, api-client) + the AuthContext push.

## ORPHAN-MEDIUM-219 — PR-E adoption gate: useTenantQuery ratchet (raw createTenantQueryKey may only shrink)
Found 2026-06-29 (tenant-panel PR-E / E-series, completes the A2 SSoT). Tenant hooks should use `useTenantQuery`/`useTenantMutation`, not hand-roll `useQuery` + `createTenantQueryKey` (where the cross-tenant-leak / missing-tenant / blank-on-error bugs hide). **Status: RESOLVED (2026-06-29 — added `tests/invariants/web-usetenantquery-adoption-ratchet.spec.ts` (jest layer-1): counts raw `createTenantQueryKey(` usages in `web/modules` + `web/shell/src` (excl tests), asserts `<= BASELINE_CEILING` 282 — the EXACT current count, so the ratchet is tight. A NEW raw usage fails CI → new tenant hooks must use the SSoT; migrating hooks lowers the count + the ceiling in lockstep. Green at 282/282.)** Complements the existing `aquaculture/no-bare-tenant-query-key` ESLint rule (warn — ensures tenant-SCOPING; this ratchet drives SSoT ADOPTION). The 282-usage migration backlog is tracked under [[ORPHAN-MEDIUM-216]].

## ORPHAN-MEDIUM-252 — ARIA mechanical drift compares TS entities against ARCHIVED (superseded) migrations → 100% phantom drifts
Found 2026-06-29 (while testing the ARIA system end-to-end via the kernel CLI + acceptance harness). `tools/aria-poc/poc.py::detect_sql_enums` extracted `CREATE TYPE ... AS ENUM` from EVERY path containing `/database/migrations/`, including re-baselined migrations parked under `apps/<svc>/src/database/migrations/.archive/<timestamp>/`. Those archived files are git-tracked history but no longer describe the active schema, so the TS-vs-SQL value-set comparison ran against superseded enums and emitted phantom drift. Concretely measured on `origin/main`: 9/9 `drifts_above_threshold` cited a `.archive/` SQL ref; the acceptance harness even graded 5 of them `true_positive` (its deterministic check can only confirm "ref resolves + values differ + no gate", not "the SQL is superseded" — exactly the borderline `aria-accept`'s agent-validator layer is documented to downgrade). Proof: the harness-labelled-TP `goal` drift (`missing_in_ts: partially_completed`) is NOT a drift — the active `1800000000000-Baseline.ts` declares `hr.goals_status_enum` as `{NOT_STARTED,IN_PROGRESS,COMPLETED,CANCELLED,DEFERRED}`, byte-identical to the `GoalStatus` TS entity; `partially_completed` exists only in the archived migration. **Status: RESOLVED (2026-06-29 — added `is_archived_migration_path()` to `tools/shared/excluded_paths.py` as a file-level predicate and a guard in `detect_sql_enums` that skips archived migrations from the drift value-set corpus ONLY (they stay walked + fated by discovery, so git↔fs reconciliation is unaffected; `.archive` deliberately NOT added to `BASE_EXCLUDED_DIRS`). Tier-1: the phantom-drift class is now structurally impossible. Validation: `drifts_above_threshold` 9→0 on origin/main, acceptance harness OVERALL ACCEPT (drift_output_validation checked=0, unverifiable=0), 17/17 poc unit tests incl. 2 new regression tests, find_drifts real-repo bound + 15 shared-exclusion invariants green.)** Note: `aria-kernel/aria_kernel/discovery.py` migration COUNTS (`migration_ts_count`/`migration_sql_count`) also include archived files; that is a descriptive fingerprint stat, not a finding-producer, so it was left unchanged (separate decision if the count should exclude archives).
---

## ORPHAN-HIGH-250 — production deploy health-gate crashes on `ERR_MODULE_NOT_FOUND: js-yaml`: deploy checkout never provisions node_modules → false `critical_health` + `rollback_failed` on every deploy

Severity: HIGH (every production deploy's health verification is broken — masks real failures, leaves `rollback_failed` ledger entries + a stale `deployed/production` baseline tag). Discovered 2026-06-29 while deploying the tenant-create-500 fix (#706). (Numbered 250 to reserve clear of the fast-moving next-free allocation during a hot merge window — 217/218/219 were each taken by concurrent sessions mid-CI.)

**Problem:** The deploy runs `node scripts/deploy/check-service-health.ts` (Node 22 type-stripping, "no tsc/tsx on the droplet") from the SHA-pinned deploy checkout (`DEPLOY_CHECKOUT_DIR=/var/lib/aqua/deploy/checkout`). That script (and `assert-service-signals.ts` / `compose-profile-contract.ts`) does `import yaml from 'js-yaml'`. But `materialize_deploy_checkout` (`scripts/deploy/deploy-paths.sh`) creates a bare git worktree and symlinks only `.env` + `certs/` — it never provisions `node_modules`, and the deploy runs no `npm ci`. Node resolves `node_modules` by walking up from the script dir (`/var/lib/aqua/deploy/checkout/…`), which never reaches the source repo's `node_modules`, so the import dies with `ERR_MODULE_NOT_FOUND: Cannot find package 'js-yaml'`. The deploy treats the crashed gate as "critical service health check failed," triggers a rollback that runs the SAME broken gate → `rollback_failed`. The services are actually healthy; the gate just can't see them. Compounding: `js-yaml` was an UNDECLARED dependency (imported directly but absent from `package.json` — present only transitively). Latent since ~2026-05-17 (the "criticality-aware health gate + TS scripts" WS6 commits 5a5c63d0e / 40485ed44).

**Evidence:** CI-Affected run 28356946480 (merge `4b54997b`) `deploy-production / deploy` failed; job log: `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'js-yaml' imported from /var/lib/aqua/deploy/checkout/scripts/deploy/check-service-health.ts` → `status=rollback_failed phase=critical_health`. Live droplet: services healthy on the new image; `node_modules/js-yaml` ABSENT in the deploy checkout, PRESENT in the source repo.

**Resolution (this PR):** (1) `materialize_deploy_checkout` symlinks the source repo's already-installed `node_modules` into the deploy checkout (gitignored, mirrors the existing `.env`/`certs` symlinks; guarded on `[ -d "${src}/node_modules" ]`) so deploy scripts resolve their deps. (2) Declare `js-yaml` (`^4.1.1`) as an explicit `dependencies` entry so the import is honest and the package is guaranteed present (no longer relying on a transitive provider). The deploy health gate then runs and verifies real service health.

Status: RESOLVED (2026-06-29; fix branch `fix/deploy-checkout-nodemodules-v2`). Registry: orphan-findings.md only.

---

## ORPHAN-MEDIUM-251 — admin-api Scheduler logs `permission denied for schema messaging` every ~5 min (admin_service lacks messaging-schema grant)

Severity: MEDIUM (non-fatal — admin-api stays healthy — but a scheduled job errors every ~5 min, polluting logs and silently not doing its work). Discovered 2026-06-29 after deploying admin-api to current main.

**Problem:** An admin-api scheduled job (log `context: "Scheduler"`) queries the `messaging` schema, but the production DB role `admin_service` has no `USAGE`/`SELECT` grant there → `permission denied for schema messaging` (13 occurrences in 35 min on admin-api; 157 server-side denials in postgres). It is NOT caused by the tenant-create-500 fix (0 occurrences before the new image; surfaced by bringing admin-api up to current main — i.e. #696-era admin-api changes that added/enabled a messaging-touching scheduler). Per the per-service least-privilege model (SEC-015), admin-api reading messaging cross-schema is itself questionable.

**How to fix:** Identify the specific admin-api scheduler + exactly which `messaging.*` objects it needs (read-only analytics/aggregation?), then either (a) grant `admin_service` `USAGE` on schema `messaging` + `SELECT` on the specific tables via a forward migration (if the cross-schema read is intended), or (b) route the data through an admin-owned read-model / a messaging-service query API and disable the direct cross-schema scheduler (preferred per service-boundary discipline). Until then it is noisy-but-harmless.

Status: OPEN (owner: admin-expert / messaging-expert / multi-tenant-saas-expert). Registry: orphan-findings.md only.

## ORPHAN-MEDIUM-252 — #687 epoch regression: createTenantQueryKey-based invalidations match nothing for LIST queries
Found 2026-06-29 (while continuing the PR-A migration backlog). #687 (session-epoch) appended a `{__sessionEpoch}` segment to `createTenantQueryKey`. A hook invalidating a LIST query via `invalidateQueries({ queryKey: createTenantQueryKey(tid, 'domain') })` now produces the prefix `['tenant', tid, 'domain', {epoch}]` — but the list query is `['tenant', tid, 'domain', filter, {epoch}]`, so the epoch lands at the filter's index and the prefix NO LONGER MATCHES: the invalidation silently hits nothing and create/update/delete stop refreshing their lists (detail/exact-match invalidations still work). `createTenantInvalidationKey` (the epoch-less prefix) is the correct helper. ~66 line-based / 68 true such callsites across sensor / tenant-admin / hr / shell. **Status: SSoT + biggest offender fixed + gated (2026-06-29 — (1) `useTenantMutation` now invalidates with `createTenantInvalidationKey`, + a functional regression test (a real list query is now invalidated) + a contract spec `tenant-invalidation-key.contract.spec.ts` pinning createTenantInvalidationKey-matches vs createTenantQueryKey-does-not; (2) fixed the biggest offender `useEdgeDevices` (24 invalidations); (3) added the ratchet gate `tests/invariants/web-no-createtenantquerykey-in-invalidate.spec.ts` (ceiling 44) so NO new broken invalidation lands + the remaining 44 burn down, and tightened the adoption ratchet 282→258. shared-ui 8/8 + sensor 1249/1249 + tsc clean.)** Remaining 44 callsites (sensor usePlcControl / useLoRaDevices / useAlertRules + tenant-admin / hr / shell + automation pages) burn down under the ratchet.

## ORPHAN-MEDIUM-253 — ARIA live LLM runtime migrated from Codex CLI to Claude Code CLI
Found 2026-06-29 (operator directive: ARIA's autonomous executor must run on the Claude Code CLI — the same `claude` binary an operator drives — not Codex). The prior runtime (`tools/aria-poc/codex_runtime.py`, `codex exec --json -c model_reasoning_effort="xhigh"`, ChatGPT-managed Codex auth) is being replaced by a Claude Code CLI runtime (`claude -p --output-format stream-json --verbose --model <opus> --dangerously-skip-permissions`, managed Claude Code session auth, API-key/proxy-billing gated). **Status: IN-PROGRESS — landing in slices, each green.** Slice 1 (this PR): `tools/aria-poc/claude_runtime.py` runtime contract module + `aria-kernel/tests/test_claude_runtime_contract.py`, live-validated against the real Claude Code CLI v2.1.195 stream-json shape (system/assistant/result events; final text in `result`, token usage in `usage`). Model tier resolves from agent frontmatter via `resolve_claude_model` (fail-safe opus, consistent with the ARIA always-opus rule). Follow-up slices: rewire `ci_executor.py`/`worker_executor.py` + the proven-contract doc + GH `aria-agent-executor.yml` + the I-V3-21 argv / cost-record / preflight invariants (atomic, green); then delete `codex_runtime.py`, sweep kernel codex string refs, update CURRENT_STATE.md/CONTRACTS.md, and write the ADR superseding ADR-035. Reverses the 2026-05-25 Codex migration decision; historical Codex plan/review docs are kept as superseded design-history evidence per the ARIA authority chain.

## ORPHAN-MEDIUM-254 — ARIA autonomous-write needs a non-root (or sandboxed) Claude Code runner; preflight now fails closed
Found 2026-06-29 (live-running the post-migration Claude Code CLI runtime). The Claude Code CLI REFUSES `--dangerously-skip-permissions` under root/sudo ("cannot be used with root/sudo privileges for security reasons"). ARIA's autonomous-write executor uses that full bypass to edit its assigned worktree, so on a ROOT runner (e.g. this droplet) every autonomous-write turn died with a cryptic `returncode 1` and empty stream-json. Read-only judge/scout turns (`skip_permissions=False`) are unaffected and worked live. **Status: CODE-SIDE RESOLVED + OPS-SIDE OPEN.** Code (this PR): `claude_runtime` gained `assert_write_runner_ok` (fail-closed at preflight for the full bypass AND `bypassPermissions` under root, with operator-actionable guidance instead of the cryptic exit), a configurable `permission_mode`, and `ARIA_CLAUDE_SANDBOX=1` → passes `IS_SANDBOX=1` to the CLI for a genuine isolated sandbox; documented in ADR-040; 8 contract tests. **Live-verified 2026-06-29:** `--dangerously-skip-permissions` AND `--permission-mode bypassPermissions` are BOTH root-blocked; `--permission-mode acceptEdits` is the root-COMPATIBLE autonomous-write lever — `run_claude_exec(permission_mode='acceptEdits')` autonomously wrote a real file (`ARIA_AUTONOMOUS_WRITE_OK`) as root in an isolated dir, returncode 0. **OPS-SIDE (owner: infra/operator, OPEN):** the production autonomous-write runner MUST be provisioned **non-root** (the recommended path — the flag then works with zero extra config) OR run inside an acknowledged sandbox. This is a deployment/runner-provisioning decision, not a code change. Validation that the non-root path works live is tracked as the follow-up to this finding (a dedicated non-root user + isolated worktree).

## ORPHAN-MEDIUM-255 — ARIA's own seeded beliefs/pressures used a glob evidence_ref → every full cycle failed the memory phase
Found 2026-06-29 (running a full ARIA cycle live on the real repo). `aria-kernel/aria_kernel/memory.py` seeded the belief `repo-has-recurring-typeorm-migration-surface` and `pressure.py` the `migration_surface_repeat` pressure with `evidence(_refs)=["apps/*/src/database/migrations/*.ts"]` — a GLOB. ARIA's own L1 Grounded-Evidence verifier (`evidence_trust.classify_evidence_ref`) resolves a glob to `missing`, so the memory phase raised `evidence_ref_not_repo_verified` and **every full `cycle run` on the real repo ended `status=failed`** (the cycle fail-closed on its OWN unverifiable seed — discipline correct, seed evidence wrong). All sibling seed beliefs (`nx.json`, `package.json`, `web-modules-missing-project-json`) already used concrete refs; the migration belief was the lone glob. **Status: RESOLVED (architectural, this PR).** `discovery._repo_fingerprint` now surfaces `migration_evidence_paths` — a bounded list of CONCRETE active (non-`.archive`) migration `.ts` paths, exactly mirroring the `web_modules_missing_project_json` SSoT pattern; `memory.py` + `pressure.py` seed from those paths (gated on non-empty). Regression made impossible (Tier-3): `test_seed_evidence_concrete.py` asserts the fingerprint paths are concrete + repo-verifiable AND statically forbids any `*`-glob in an `evidence`/`evidence_refs` literal in the kernel seed sites — so no future seed site can reintroduce the class. **Verified live:** the full cycle now `status=completed` (failed_phases=[]); the belief carries real evidence (`apps/ai-service/src/database/migrations/1800000000000-Baseline.ts`, …).

## ORPHAN-MEDIUM-256 — ARIA cycle had no live observability (black box until completion); added --progress live stream
Found 2026-06-30 (operator could not see ARIA's logs while a cycle runs). A `cycle run` computes every phase IN MEMORY and writes its ledgers atomically at the END — empirically verified: during a full run governance.jsonl stays at 2 rows, stderr is empty, and the tools-dir file count never changes until completion, when the final JSON envelope lands on stdout. So an operator watching a ~2.5-minute run (the per-file fate+content-hash scan of ~9553 files dominates) sees nothing but a black box. **Status: RESOLVED (this PR).** New `aria_kernel.cycle_progress.emit_progress` streams one structured JSON line per phase boundary to STDERR (flushed), gated by `ARIA_CYCLE_PROGRESS` / `cycle run --progress`; default OFF → zero behaviour change, and the emitter NEVER raises (observability must not break a cycle). Wired ticks: `cycle_started` → `discovery` (+ `discovery_scan scanned=N/total` every 2000 files during the long walk) → `tools` → `memory` → `pressure` → `reflection` → `cycle_completed{status}`. Stdout still carries ONLY the final envelope, so `2> progress.log` (tail -f / Monitor) gives a live view without corrupting the machine-readable result. **Verified live:** the scan now streams `scanned=0/2000/4000/6000/8000/9553` in real time (was total silence). 5 emitter tests; the snapshot comprehension→loop change keeps fates byte-identical (201 discovery/snapshot/cycle tests green).

## ORPHAN-MEDIUM-257 — per-service impact-graph-ordered analysis primitive (whole-repo-at-once → dependency-ordered service lens)
Found 2026-06-30 (operator design review: ARIA examined the repo as one whole-repo snapshot with no first-class per-service, dependency-ordered examination stage). discovery MUST scan the whole repo once (it builds the snapshot + the project dependency graph), but the examination stage then benefits from a per-service lens walked in TOPOLOGICAL dependency order — upstream foundational layers first — so a downstream service is analysed with its upstream already understood and an upstream change's ripple reaches its dependents. **Status: PRIMITIVE LANDED (this PR); per-service phase-wiring is the next slice.** `impact_graph.build_service_analysis_order(graph)` orders the existing project dependency graph (`{projects, dependencies}` from the nx graph or local import scan) into topological layers (layer 0 = no in-graph deps), name-sorted within a layer for determinism, cycles broken by forcing the smallest stuck node (recorded in `cycle_broken_projects`) so the order is always TOTAL + STABLE; each entry carries `depends_on` (already-understood context) + `dependents` (ripple targets). `plan_service_analysis_order(workspace_root, changed_files=…)` annotates each service with its changed-file count and surfaces `impacted_projects` = changed services ∪ their downstream reverse-closure (the cross-service ripple). Surfaced via `aria-kernel impact service-order [--nx-graph <f>] [--changed-file <p>]` (operator-observable; `--nx-graph` is the authoritative fast source, local import-scan the fallback). NOT wired into the per-cycle path: the import scan is a second full filesystem pass and would roughly double cycle time, and the order only changes when project structure/imports change — so it is on-demand. 6 invariants lock validity (valid topological order, complete, deterministic, cycle-total, self/unknown-edge handling, real-layout ripple). Realizes the operator's "full scan → split per-service in logical order, cross-service ripple via dependents" model; the next slice consumes this order in the pressure/finding examination phases.

## ORPHAN-MEDIUM-258 — cycle now produces a per-service dependency-ordered examination plan (slice 2: consume the order in-cycle)
Found 2026-06-30 (slice 2 of ORPHAN-MEDIUM-257). Slice 1 landed the topological service order primitive but did not consume it in the cycle. Now `run_enterprise_cycle` produces a `service_examination` in its state: when this cycle changed files (`cycle_diff.changed_paths`), it maps changes to services and surfaces the **changed services + their downstream ripple** (`impacted_projects` = changed ∪ reverse-closure) in **dependency (topological) order** so the examination walks upstream-before-downstream (each entry tagged `reason`=changed|downstream_impact). **Status: RESOLVED.** `impact_graph.cycle_service_examination` reuses `cached_service_analysis_order` — the order is cached in a plain `tools/impact/service-order-cache.json` keyed by a cheap `_graph_fingerprint` (sorted project roots + tsconfig.base.json; NO `*.ts` read), so the expensive import scan runs ONLY when the project layout/aliases change (verified: 2nd call hits the cache, no re-scan). No per-cycle regression: skipped on a no-change baseline (so CI `discovery run` and baseline cycles pay nothing), wrapped in try/except (never fails the cycle), and the cache `.json` is NOT a declared ledger so `verify_artifacts`/`integrity verify` ignore it (verified exit 0). **Verified live on the real repo:** an upstream `libs/event-contracts` change ripples to 21 services examined L0→L9 (event-contracts first → … → backend-common L6 → platform-event-bus L7 → leaf apps L9). 10 invariants (cache hit/invalidation, ripple-in-dependency-order, no-change-empty). Next: consume `service_examination` inside the pressure/finding emitters to scope findings per-service.

## ORPHAN-MEDIUM-259 — pressures scoped per-service + grouped in dependency order (slice 3: consume the order in the emitters)
Found 2026-06-30 (slice 3 of ORPHAN-MEDIUM-257/258). Slices 1-2 built the topological service order + a per-service examination plan, but pressures were still whole-repo. Now `cycle_service_examination(pressures=…)` scopes EACH pressure to the service(s) its `evidence` paths map to (`affected_services`) and emits `per_service_pressures` — pressures grouped per-service in the SAME dependency (topological) order (upstream first); a pressure whose evidence maps to no project lands in `global_pressures` (cross-cutting). The cycle passes its pressure-phase output in and runs the scope when there is a change OR a pressure (no per-cycle regression: cached order, skipped on a truly empty cycle, try/except, no new ledger). **Verified live on the real repo:** the `migration_surface_repeat` pressure (concrete ai-service/alert-engine migration evidence from ORPHAN-MEDIUM-255) is now scoped to `ai-service` (L3) + `alert-engine` (L4) and grouped in dependency order; cycle `status=completed`. 14 invariants across slices 1-3. **Status: RESOLVED.** The operator's "full scan → split per-service in logical order, cross-service ripple, scope the findings per-service" model is now realized end-to-end (discovery global → examination per-service-in-dependency-order → pressures scoped per-service). Next natural step: scope tool-emitted findings (finding.py) the same way and let the per-service plan drive WHICH tools run per service.

## ORPHAN-MEDIUM-260 — per-service plan routes to the owning domain agent + flags coverage gaps as genesis candidates (slice 4)
Found 2026-06-30 (slice 4 of the per-service line; ORPHAN-MEDIUM-257/258/259). The per-service examination plan listed services + pressures but did not say WHICH agent should examine each. Now each `examination_order` entry carries `recommended_agents` = {primary, also_notify}, read from the **Lane-A routing SSoT** (`.claude/shared/orchestrator-routing-table.md`) — the SAME table the orchestrator dispatches from, not a new map. A service whose project root matches no routing glob has empty `primary` → it is surfaced in `agent_coverage_gaps`, which is exactly an **agent-genesis candidate** (verified: ARIA can write agents/skills via `agent_genesis.draft_agent_from_gap`→sandbox→DRAFT-PR, gated by genesis_policy: 0.80 existing-coverage threshold, signed operator feedback, real-sandbox lanes, 14-day/5-clean-cycle/10-eval shadow, 0.95 precision, human acknowledge — 78 genesis tests green). **Verified live on the real repo:** an upstream `libs/event-contracts` change → 21 services each routed to its owner (event-contracts→data-expert, alert-engine→alert-engine-expert, backend-common→8 agents, billing→billing-expert, sensor→sensor-expert) in dependency order, with `migration-harness` correctly flagged as a real coverage gap (no owning agent). `agent_routing.py` parses the markdown table (99 rows), strips placeholders/parentheticals, matches project roots to globs (whole-project, sub-area, and broader-surface). **Status: RESOLVED.** The operator's full model is now realized end-to-end: discovery (global) → examination (per-service, dependency-ordered) → pressures (scoped per-service) → recommended agents (routing SSoT) → coverage gaps (genesis candidates). 11 invariants. Next: let the cycle auto-open a genesis request for a confirmed coverage gap (still human-approved per genesis_policy).

## ORPHAN-MEDIUM-261 — coverage-gap → genesis candidate (slice 5: routing coverage gaps feed the human-gated genesis flow)
Found 2026-06-30 (slice 5; continues ORPHAN-MEDIUM-257..260, plan serialized-plotting-flute). Slice 4 surfaced services with no owning routing-table agent (`agent_coverage_gaps`) but did not act on them. Now `capability_gap.detect_capability_gaps` has a new source `_gaps_from_coverage_gaps`: a service whose routing-table `primary` owner is empty (`agent_routing.unowned_projects`, whole-repo, reuses the slice-2 cache — no rescan) AND that carries an active pressure this cycle becomes an agent-genesis candidate. It routes to `existing_agent_extension` when `related_agents_for_paths` finds a neighbour (prefer extension), else `agent_gap`; evidence = the routing table + the service's pressure evidence; score 75 (≥ genesis `pressure_min_score` 70). It feeds the EXISTING human-gated flow (`learning._skill_or_agent_genesis` → `request_agent_genesis` → draft → real sandbox → `approve_agent_pr(operator_approval_ref)` → DRAFT PR → `materialize_agent_draft(AutoActionGate)`), governed by `genesis_policy` (0.80 coverage, ≥3 evidence, 14d/5-clean/10-eval shadow, 0.95 precision, human acknowledge). **Status: RESOLVED.** Requiring active pressure keeps it low-noise (an inert unowned lib files nothing). No new ledger surface, no new cycle plumbing. **Observe-safe by structural proof:** `burn_in.py` calls `triage_policy_apply` (discovery/memory/pressure/triage only) and has ZERO references to `detect_capability_gaps`/`_skill_or_agent_genesis` — the new source is unreachable from a burn-in observe run, so it cannot grow an action-class surface there. Verified: 6 invariants + 111 capability/learning/genesis/routing tests green; full cycle `status=completed`; `integrity verify` exit 0. Next (slice 6): wire burn-in PASS → autonomy unlock ladder + operator CLI for L3 two-stage approval.

## ORPHAN-MEDIUM-262 — burn-in → autonomy unlock ladder bridge (slice 6a)
Found 2026-06-30 (slice 6a; plan serialized-plotting-flute Part 2). The autonomy ladder existed (`autonomy_unlock` acceptance events + L1/L2/L3 thresholds; `policy_approval` L3 two-stage; `merge_authority` 9 gates) but had a documented unwired gap: `run_observe_burn_in` produced an evidence-only `autonomy-burn-in-report.json` and **never called `record_acceptance_event`**, so a passing observe burn-in did not advance the unlock ladder (the `autonomy_ladder.record_clean_cycle` bridge was only exercised in tests). **Status: RESOLVED.** New `autonomy_ladder.record_burn_in_acceptance(report, mode, base_dir)` bridges a PASSED burn-in into the ladder by recording one `observe_success` per valid cycle (each valid cycle IS a harness-accepted clean observe). Safety posture: **fail-closed** (a report whose `acceptance_verdict != "passed"` records nothing), **idempotent** (each event carries reason `burn_in_observe:<cycle_id>`; re-running the bridge skips already-recorded cycles — verified re-run records 0/skips N), and **operator-invoked, NOT auto-called from `run_observe_burn_in`** so advancing the ladder stays an explicit reviewed step. It records ladder PROGRESS only — it never grants autonomous merge: `DEFAULT_PROFILE` stays `standard`, `pr_merge` still needs the `autonomous` profile, and the full ladder (L1 30 observe → L2 → L3 +5 two-stage approvals +3 rollback +0 critical) plus `policy_approval` two-stage human gate remain. This PR touches `aria-kernel/**` (the L3 risk lane) but removes/weakens no gate. 7 invariants + 39 autonomy/burn-in/ladder/unlock tests green. Next (slice 6b): operator CLI for `autonomy unlock status`, `autonomy burn-in accept` (invokes this bridge), and `policy-approval record/verify`.

## ORPHAN-MEDIUM-263 — operator CLI for the autonomy ladder + L3 approval (slice 6b)
Found 2026-06-30 (slice 6b; completes plan serialized-plotting-flute Part 2). The burn-in→ladder bridge (slice 6a) + the L3 two-stage `policy_approval` existed as library functions but had NO operator CLI — the L3 human-approval path was not operable from the command line. **Status: RESOLVED.** Added three operator surfaces to `cli.py`: (1) `aria-kernel autonomy burn-in accept --report <path> [--mode real|mock]` invokes `record_burn_in_acceptance` (fail-closed: rc 2 + records nothing when the report verdict is not `passed`); (2) `aria-kernel autonomy unlock status --lane L1|L2|L3` prints the read-only `evaluate_autonomy_unlock` view (lane, unlocked, counts, requirements, reasons); (3) `aria-kernel policy-approval record/verify` drives the L3 two-stage approval — `record` files one stage (`risk_owner`|`exception_owner`, state=approved), `verify` requires both stages by DISTINCT actors (separation of duties) on a matching pr/head_sha/policy_hash, unexpired. All three are in `_TOOLS_DIR_REQUIRED_COMMANDS` (explicit `--tools-dir`, no walk-up for the autonomy control plane) and their dests registered in `_command_path`. `record` catches `GovernanceError` → clean JSON error + rc 2 (e.g. `policy_approval_head_sha_must_be_full_sha`, `policy_hash` must be `sha256:`-prefixed). **Records ladder progress / approvals only — grants no autonomous merge** (DEFAULT_PROFILE stays `standard`; full ladder + the two-stage gate remain). L3-lane change (`aria-kernel/**`). 8 invariants + 68 cli/autonomy/policy-approval/ladder tests green; live E2E verified (accept→status reflects N; two distinct actors → verify valid; same actor → separation-of-duties fail; invalid input → clean rc 2). The plan's two named thresholds (coverage-gap→genesis #764, burn-in→L3 line #765 + this) are now both wired, every consequential step human-gated and fail-closed.

## ORPHAN-MEDIUM-264 — farm read-boundary stragglers (3 reads bypassed runInTenantRead) — RESOLVED
Found 2026-06-30 by data-readback-auditor (lead-verified firsthand). Three farm reads used `InjectRepository(...).findOne({where:{id,tenantId}})` on the SHARED pool, not the fail-closed `runInTenantRead` boundary — so a lost/wrong pooled-connection `search_path` silently resolves the wrong schema or RLS-denies to empty (the "data appears then disappears" mode): `batch/query-handlers/get-batch-performance.handler.ts:45` (+ its species fallback), `growth/resolvers/growth.resolver.ts:416` (`growthMeasurement(id)`), `feeding/resolvers/feeding.resolver.ts:936` (`feedingRecord(id)`). **Fix:** migrated all three to `runInTenantRead(this.dataSource,'farm',tenantId,qr=>qr.manager.findOne(...))` (canonical pattern `batch/query-handlers/get-batch.handler.ts:30`); removed `get-batch-performance` from the read-boundary deferral allowlist (now enforced). **Make-it-detectable:** extended `tests/invariants/farm-read-boundary-ssot.spec.ts` — the existing invariant only scanned `*.handler.ts`/IQueryHandler, missing resolver-level reads; added a resolver scan flagging any farm `*.resolver.ts` with a direct `this.<x>Repository.find*` tenant read, with growth+feeding now enforced. 4/4 invariant green; tsc + eslint clean. PR fix/farm-read-boundary-stragglers.

## ORPHAN-MEDIUM-265 — 6 farm resolvers still do direct-pool tenant reads (tracked deferral)
Found 2026-06-30 (companion to ORPHAN-MEDIUM-264). The new resolver read-boundary invariant tracks 6 farm resolvers that still read tenant entities directly off `@InjectRepository` instead of `runInTenantRead`/the query bus: `feeding/resolvers/feeding-program.resolver.ts` (36 direct reads), `batch/resolvers/cleaner-fish.resolver.ts` (3), `tank/resolvers/tank.resolver.ts` (2), `feed/feed.resolver.ts` (1), `chemical/chemical.resolver.ts` (1), `supplier/supplier.resolver.ts` (1). They are allowlisted in `farm-read-boundary-ssot.spec.ts` (RESOLVER_READ_BOUNDARY_ALLOWLIST) and the allowlist-honest test forces the list to SHRINK as each migrates. Deepest fix per resolver: route the read through `runInTenantRead` or move it to a CQRS query-handler. Owner: farm; deadline: next farm read-boundary slice.

## ORPHAN-MEDIUM-266 — stock-movement events bypassed the outbox (at-most-once) — RESOLVED
Found 2026-06-30 by farm-expert (lead-verified firsthand). `storage/handlers/record-stock-movement.handler.ts` published `StockMovementRecorded` + `LowStockDetected` via direct `eventBus.publish` in a swallow-catch AFTER the transaction committed — at-most-once: a NATS outage between commit and publish silently drops the event, and for stock-reducing movements that drop includes the LowStockDetected **reorder alert** (a traceability/alerting path the rest of the domain guarantees transactionally). The docstring even claimed "Outbox-pattern principle" while not using the outbox. **Fix:** enqueue both events via `OutboxPublisher.enqueue(event, manager)` INSIDE the movement transaction (canonical pattern `batch/handlers/create-batch.handler.ts:549`), so the outbox row commits atomically with the inventory write (at-least-once; a relay worker delivers them). Removed the `@Optional() EVENT_BUS` dependency + the lossy try/catch; the low-stock feed read moved inside the transaction (`manager.findOne(Feed,…)`). OutboxPublisher is reachable via the `@Global()` FarmOutboxModule (no module change). **Make-it-detectable:** new `tests/invariants/farm-outbox-publish-ssot.spec.ts` (registered in the layer-3 jest project) fails the build if any farm `ICommandHandler` reintroduces a direct `eventBus.publish(` (comments stripped first); all farm command-handlers are now clean. 4-case behavior spec proves the enqueue/idempotent/low-stock paths; tsc + eslint clean. PR fix/farm-stock-movement-outbox.
## ORPHAN-MEDIUM-267 — WQ template "overwrite" was a destructive replace that wiped tenant data — RESOLVED
Found 2026-06-30 by farm-expert (lead-verified firsthand). `water-quality/handlers/bulk-create-from-template.handler.ts` overwrite mode ran `queryRunner.manager.delete(WaterQualityParameterConfig,{tenantId})` then bulk-inserted template defaults — destroying every tenant-tuned per-parameter threshold (optimal/warning/critical Min/Max, speciesLimits) AND every CUSTOM (non-template) parameter. **Fix:** replaced delete-all + insert with **update-or-insert per parameter BY CODE** inside the tenant transaction — an existing row is updated in place (id preserved), a missing one is inserted, and rows whose code is not in the template (custom params) are left untouched. No delete. **Make-it-detectable:** new `tests/invariants/farm-wq-template-nondestructive-ssot.spec.ts` (registered in the layer-3 jest project) fails the build if any water-quality handler reintroduces a tenant-wide `delete(WaterQualityParameterConfig,{tenantId})`. Updated the handler unit spec: the old "deletes existing configs" test → "upserts by code, never deletes, preserves custom params" (asserts delete not called, custom param absent from the save set, existing template-code row keeps its id). 3/3 spec + invariant green; tsc + eslint clean. PR fix/farm-wq-template-nondestructive.
## ORPHAN-MEDIUM-268 — growth performance graded on abs(variance), conflating under/over — RESOLVED
Found 2026-06-30 by farm-expert (lead-verified firsthand). `growth/entities/growth-measurement.entity.ts:586` `evaluatePerformance()` took `Math.abs(variancePercent)` for the middle bands, so a batch 15% BELOW theoretical scored the same band as 15% ABOVE — masking the earliest underperformance signal (e.g. -8% under graded AVERAGE instead of BELOW_AVERAGE). **Fix:** signed bands — over-target is good→excellent, under-target degrades by magnitude: `>10` EXCELLENT, `0..+10` GOOD, `-5..0` AVERAGE, `-15..-5` BELOW_AVERAGE, `<-15` POOR; updated the GrowthPerformance enum comments (the in-code SSoT) to match. **Make-it-detectable:** a logic bug's guard is a regression spec — new `growth-measurement-performance.entity.spec.ts` pins each band + explicitly asserts gradeFor(8) != gradeFor(-8) and gradeFor(15) != gradeFor(-15) (the exact abs() conflation). 4/4 new spec + 8/8 existing record-growth-sample spec green; tsc + eslint clean. PR fix/farm-growth-signed-performance-bands.
## ORPHAN-MEDIUM-269 — Sentinel-Hub had no token cache → per-tile OAuth + DB-write storm — RESOLVED
Found 2026-06-30 by farm-expert (lead-verified firsthand). `sentinel-hub/sentinel-hub.service.ts` `getAccessToken()` did a fresh CDSE `client_credentials` OAuth POST on EVERY call, and the credential read it requires (`getDecryptedCredentialsInternal`) opened a `runInTenantTransaction` that wrote `usageCount`/`lastUsed` each time; the proxy controller invokes it per request, so a single map pan (dozens of WMS tiles) fired dozens of OAuth round-trips + DB write transactions — no tenant-scoped cache, no in-flight dedup, burning the Sentinel Hub rate quota. **Fix:** per-tenant token cache (`Map<tenantId,{accessToken,expiresAt}>`) served until `TOKEN_REFRESH_MARGIN_MS` (60s) before expiry + in-flight refresh dedup (`Map<tenantId,Promise>`) so concurrent refreshes share ONE OAuth call. The expensive path moved to `fetchFreshToken`; `getAccessToken` is the cache/dedup wrapper. Cache invalidated on credential change (`saveSettings`). The per-request `usageCount` write now happens per token-fetch (cache miss), not per tile. **Make-it-detectable:** a perf/cache fix's guard is a regression spec — new `sentinel-hub-token-cache.service.spec.ts` pins cache-hit-serves-without-refetch, concurrent-dedup, invalidate-re-authenticates, and tenant isolation. 4/4 spec green; existing sentinel specs green; tsc + eslint clean. PR fix/farm-sentinel-token-cache.
## ORPHAN-MEDIUM-270 — feedingSummary read-back contract drift (dead feeding-summary tab) — RESOLVED
Found 2026-06-30 by data-readback-auditor (lead-verified firsthand). `feeding/resolvers/feeding.resolver.ts:998` `feedingSummary` returned the flat `FeedingSummaryResult` from the queryBus UNMAPPED, but the GraphQL `FeedingSummaryResponse` requires differently-named/absent non-nullable fields (startDate/endDate, totalFeedGivenKg=totalActualKg, totalFeedings=totalFeedingsCount, avgFeedingKg=avgDailyFeedingKg, totalCost=totalFeedCost, varianceKg=totalVarianceKg, variancePercent=avgVariancePercent, byFeedType=feedTypeDistribution+cost) → GraphQL "Cannot return null for non-nullable field" → the feeding-summary tab errored for every entity though FeedingRecords exist. **Fix (backend-only, no schema change → no codegen/FE ripple):** added a `toFeedingSummaryResponse` mapper in the resolver; extended the handler to carry the effective period (startDate/endDate from the requested range, else the records' own min/max feedingDate) and per-feed-type `cost` (accumulated from `record.feedCost`); added both to `FeedingSummaryResult`. **Make-it-detectable:** new `feeding-summary-response-contract.spec.ts` mocks the queryBus and asserts the resolver returns a FULLY-populated response (every non-nullable @Field defined + correctly renamed, byFeedType[].cost present) — the exact prior failure mode. 2/2 contract spec + 2/2 existing handler spec green; tsc + eslint clean. Companion: growth `growthAnalysis` (ORPHAN A1) is the larger sibling (needs ~10 computed nested fields) — tracked separately. PR fix/farm-feeding-summary-readback.
## ORPHAN-MEDIUM-271 — no cross-surface real-time sync on mobile (stale tank counts) — mobile side RESOLVED
Found 2026-07-01 (operator: mobile app showed 719/83/98 fish while the web tenant panel /sites/tanks showed 900/83/180 for the same tanks; changes on one surface do not reflect on another until a poll/refetch). Two causes: (1) count-SSoT drift (batchDetails[] stale — being fixed by the parallel TankBatch-SSoT stream #776/#777/#778/#779), and (2) NO frontend consumer of the live farm event stream. The backend already broadcasts 23+ farm events to the tenant Socket.IO room `/farms` (command → outbox → NATS → FarmNatsBridge → FarmGateway) but nothing on the frontend listened, so caches stayed stale until the 1-min staleTime. **Mobile side RESOLVED (this PR):** new `web/apps/aquamobil/src/hooks/useFarmRealtimeSync.ts` subscribes to `/farms` (JWT auth, gateway auto-joins tenant room) and, on each farm event, invalidates the mapped React Query keys via `farm-realtime-invalidation.ts` (the cross-surface analogue of `offline-sync-invalidation.ts`: mortalityRecorded/cullRecorded/batchTransferred/batchAllocatedToTank/feedingRecorded → ['tanks'],['dailyOpsCounts'],['stockEventsSummary'], etc.); reconnect invalidates the whole farm namespace to catch missed events. Mounted in MobileLayout so it is active on all farm screens. Now any mutation anywhere → outbox event → /farms broadcast → this app refetches within ~1s (mobile↔mobile + web→mobile). 5 vitest cases pin the event→queryKey map + tenant-prefix + reconnect union; tsc + eslint clean. **Sibling still open:** the web farm-module needs the same `/farms` listener for web↔web + mobile→web (follow-up PR). Depends on deploy (prod is stale) + the parallel count-SSoT fix for the numbers to fully converge. PR feat/farm-realtime-sync-mobile.


## ORPHAN-HIGH-272 — harvest bypassed the TankBatch SSoT writer (stale batchDetails, mobile↔web count drift) — RESOLVED
Found 2026-07-01 while completing the tank-count SSoT (operator: web /sites/tanks showed 900, mobile 719). The parallel TankBatch-SSoT stream routed allocate/mortality/cull/transfer through TankBatchService.applyBatchDelta (#776/#777/#778/#779), but **harvest was missed**: `create-harvest-record.handler.ts` and `delete-harvest-record.handler.ts` still decremented/incremented `TankBatch.totalQuantity`/`currentQuantity`/`totalBiomassKg` by hand and never touched `batchDetails[]` — the per-batch SSoT the web (batchDetails[].quantity) + mobile (projection) read models render. So harvesting fish left batchDetails stale = the same 719-vs-900 divergence class, for harvested tanks. **RESOLVED (this PR):** both handlers route through `applyBatchDelta` (signed delta — negative on harvest, positive on the cancellation reversal); it decrements/restores batchDetails[] and derives every aggregate in lock-step, removing the batch from the composition at zero. Regression specs assert each handler calls applyBatchDelta with the correct signed delta (create 9/9, delete 7/7 green). Reuses the parallel stream's SSoT writer — no duplicate writer.
**Coordinated follow-up (NOT done here, harmony):** a systemic make-it-detectable invariant that NO farm HANDLER mutates TankBatch.totalQuantity/currentQuantity/batchDetails/totalBiomassKg directly (all count writes through TankBatchService) — deferred to the TankBatch-SSoT stream owner because it must allowlist the legitimate initial-creation sites (create-batch.handler, batch.service.ts) + the service-level biomass update in daily-feeding-execution.service.ts:890 (a separate biomass-drift finding). Owner: farm TankBatch-SSoT stream; the guard locks in #776-779 + this PR.
## ORPHAN-MEDIUM-273 — carbonic-acid K1/K2 used a seawater-only fit → Deffeyes chart wrong in fresh/brackish water — RESOLVED
Found 2026-07-01 (verified firsthand: ran the water-chemistry SSoT reference — the desktop PyQt `wq`/`carbon` classes — against the repo TS engine on an identical (T,S,pH,ALK) grid via a tsx harness). `libs/aquaculture-engines/src/water-chemistry/water-quality.ts` `getK1`/`getK2` used a linear-in-S ("Millero 2010 Table 2") fit with NO √S term — a seawater-calibrated parameterization. It matched the reference at S≈35 (Δp*K* ≈ 0.004/0.01) but drifted badly toward freshwater: at S=0.5 p*K*₂ was ~0.9 LOW (K₂ ~8× too high), and at S=0 it gave p*K*₁=6.12/p*K*₂=9.41 vs the thermodynamic pure-water 6.35/10.33. This propagated to α₀/α₁/α₂, phLineSlope, DIC, and CO₂ — i.e. every Deffeyes isoline / operating-point DIC / CO₂ readout was materially wrong in fresh & brackish water (measured downstream error at S=0.5: DIC 11%, CO₂ 35%; at S=5: CO₂ 9%). All OTHER constants (KS, KF, Kw, KB, activity coeff, all pH-scale conversions, KNH4/NH₃) already matched the reference exactly. **Fix:** replaced both bodies with the genuine Millero (2010) estuarine √S fit (pure-water term `-126.34048 + 6320.813/T + 19.568224·lnT` + √S salinity terms), valid S=0–50 — the exact formulation the SSoT desktop app uses. SWS-scale return + the existing `swsToFree` conversion chain are unchanged, so no scale semantics move. Post-fix the tsx harness shows TS==reference to ≤1e-7 at ALL salinities (freshwater downstream error 35% → 0.00%). **Make-it-detectable:** new `__tests__/k-constants.spec.ts` — literature-anchored p*K* at S=0/35, a REGRESSION GUARD asserting p*K*₂(25,0.5) > 9.9 + monotonic-in-salinity (fails loudly if a linear-in-S seawater fit is reintroduced), and end-to-end freshwater speciation goldens (α₂, DIC, CO₂) pinned to the reference. 11/11 engine tests + tsc + eslint clean.
## ORPHAN-MEDIUM-274 — hydroponics PID-simulator carbonate engine is a hand-copied duplicate (SSoT drift) — TRACKED
Found 2026-07-01 (companion to ORPHAN-MEDIUM-273). `web/modules/hydroponics-module/src/pages/pid-simulator/engine/carbonate-chemistry.ts` is a self-described "fully self-contained" hand-copy of the `@platform/aquaculture-engines` water-quality core (getK1/getK2/calcKw/ionic-strength/pH-scale/alphas/Deffeyes calcs). It carried the SAME wrong seawater-only K1/K2 as 273 — worse here because hydroponics runs at S≈0, exactly where the fit fails. Its K1/K2 have been corrected in place to match the fixed SSoT (verified via tsx: p*K*₂(25,0.5)=10.008). Two residual drifts remain in this copy: (a) the duplication itself — a web module CAN import the engine (farm-module's WaterChemistryPage and ai-service already do; the engine is browser-safe), so the copy should be deleted and re-exported from `@platform/aquaculture-engines` (tier-1 "make it impossible" — kills the drift class + inherits the engine's tests); (b) its `calcKw` constant reads `148.9802` vs the SSoT/reference `148.9652` (small pKw drift, not touched this pass to keep the change K1/K2-scoped). The module has NO vitest target wired, so it currently has no test guard. Deepest fix: dedupe against the engine (which brings the k-constants guard with it). Owner: hydroponics/frontend; deadline: next hydroponics chemistry slice.
## ORPHAN-MEDIUM-275 — dosing recipes: uncurated hard cap dropped practical recipes — RESOLVED
Found 2026-07-01 (verified firsthand: ran the reference desktop tool's recipe formulas against the repo TS `calculateDosingRecipes` on identical DIC/ALK operating points). The per-recipe dosing MATH is exact — TS reproduces every reference recipe to the gram (CO₂+NaHCO₃ 42.004/22.005, CO₂+Na₂CO₃ 26.497/33.008, CO₂+NaOH 19.998/44.010, CO₂+CaCO₃ 25.022/33.008, CO₂+Ca(OH)₂ 18.523/44.010, CO₂+CaO 14.019/44.010). The defect was enumeration/curation: `reagents.ts` enumerated all reagent pairs and returned `recipes.slice(0, 6)` with NO ranking, so when the operator also selected HCl, geometrically-feasible-but-counter-productive recipes (add a base to overshoot ALK, then HCl to trim the excess: NaHCO₃+HCl, Na₂CO₃+HCl) consumed cap slots and DISPLACED the practical lime recipes (CaO, Ca(OH)₂). The reference never shows these because it only pairs each base with CO₂. **Fix (tier-2, make the practical default): `isCounterProductiveRecipe` drops any two-reagent recipe whose steps push alkalinity in OPPOSITE directions (one adds, one removes — CO₂ is ALK-neutral so base+CO₂/acid+CO₂ are never flagged), UNLESS it is the only feasible option (fallback so the operator still gets an answer); the survivors are ranked by `recipePriority` (reagent position in the curated REAGENTS list, NaHCO₃-first) BEFORE the 6-cap.** Removed the dead `pairKey` no-op. **Make-it-detectable:** new `__tests__/reagents.spec.ts` (6 cases) — asserts no counter-productive HCl recipe survives when practical ones exist, CaO+Ca(OH)₂ are kept, NaHCO₃+CO₂ ranks first, the per-recipe goldens are unchanged, the sole-option fallback still returns a recipe, and at-target returns []. 21/21 engine tests + tsc + eslint clean. Note: the newer PyQt reference does NOT compute acid/alkalinity-LOWERING recipes (`else: "work continues"`) whereas TS does (geometric) — TS is the superset there; and H₃PO₄ + acid-SPGR density conversion existed only in an older reference snippet, absent from both the current reference and TS (a feature add, not a parity gap).
## ORPHAN-MEDIUM-276 — water-chemistry page had two pH knobs; H₂S must use the single realtime pH — RESOLVED
Found 2026-07-01 (operator report on app.suderra.com/sites/water-chemistry, verified in code). The Realtime panel exposed TWO pH inputs: the water `pH` and a separate `h2sMeasuredAtPH` ("H₂S pH", default 7.0), resolved via `resolveH2SMeasuredAtPH`. Every H₂S calc (toxic-zone boundary, `calcTotalSulfide`, `currentH2S`, status, critical pH) ran off that separate pH, while CO₂ and NH₃ ran off `inputs.pH` — so H₂S could silently diverge from the rest of the chart. H₂S is measured in-situ, so its measurement pH IS the tank's current pH. **Fix:** removed the separate `h2sMeasuredAtPH` input + `resolveH2SMeasuredAtPH`; `WaterChemistryPage` now sets `h2sMeasuredAtPH = inputs.pH` so H₂S/CO₂/NH₃ all share the single realtime pH. Dropped the redundant "H₂S measured at pH" readout row + `ResultsPanel` prop; simplified the "@ pH" subtitle annotations; updated README. The engine's `ToxicLimits.h2sMeasuredAtPH` param is unchanged (still general for library callers) — only the page always feeds the one pH. **Make-it-detectable:** the spec that exercised the old input was rewritten to assert the separate 'H₂S pH' input and its readout are GONE. farm-module water-chemistry specs green; tsc + eslint clean. (See also the H₂S scale analysis: the engine computes H₂S on the FREE scale correctly — this finding is about the UI having one vs two pH knobs, not the scale.)
## ORPHAN-MEDIUM-277 — NH₃ (UIA) safety-zone shading vanished when critical pH left the chart domain — RESOLVED
Found 2026-07-01 (operator report: the UIA-N (NH₃) vs pH chart's red/yellow/green shading "no longer colors"; a background sub-agent ruled out deploy-lag — the feature ships in the live bundle `Module-C9OeNU8n.js` — and pinned the cause). Unlike the H₂S chart (which clamps its bands via `getVisibleH2SChartZones`), the UIA chart inlined its `<ReferenceArea>` zones with raw `toxicNH3pH ± 0.2` and hardcoded `x1={6.0} x2={9.5}`. When the critical NH₃ pH falls OUTSIDE the [6.0, 9.5] chart domain (reachable via high TAN / low NH₃-limit / high salinity-temp — e.g. crit < 6 makes the danger band `x1 > x2`, crit > 9.5 pushes the safe band off-domain), Recharts' default `ifOverflow="discard"` silently drops the off-domain areas and the chart renders UNSHADED — exactly the reported symptom. **Fix:** added `getVisibleNH3ChartZones` (mirror of the H₂S helper, but danger-on-the-high-pH-side since NH₃ is toxic ABOVE crit) that clamps to [6.0, 9.5] and returns full-range danger (crit ≤ floor) or full-range safe (crit ≥ ceiling); the UIA chart now renders `nh3ChartZones.{safe,alert,danger}` and gates the critical line on `nh3ChartZones.showCriticalLine`. **Make-it-detectable:** 3 unit tests on `getVisibleNH3ChartZones` (absent/above → full safe; below → full danger; in-domain → safe/alert/danger split) mirroring the existing H₂S zone tests. farm-module water-chemistry specs green (22/22); tsc + eslint clean. **Companion observation (NOT a code bug):** the reported dosing-arrow disappearance (#3) is neither deploy-lag nor a reproducible main bug — `createOnDemandArrowLayer` + the `<Line>` `od-seg` path are present in the live bundle and correct; the On-Demand arrows are user-gated (enter a gram amount in the InputPanel "Simulator" tab, with the chart's "On-Demand" layer toggle on) and the checkbox reagent-direction wedge only draws for exactly 1–2 selected reagents. Most likely a stale browser cache or a page-level runtime error on specific inputs; live check (hard-refresh + DevTools console) recommended before any code change.


## ORPHAN-HIGH-273 — reconcile existing stale tank_batches.batchDetails (A3) — RESOLVED
Found 2026-07-01 (data-repair follow-up to ORPHAN-HIGH-272). The write-side SSoT (applyBatchDelta) now keeps batchDetails[] in lock-step going forward (#776-779 + #784, deployed 8ddf96465), but rows mutated BEFORE that landed carry stale batchDetails (the live 719-vs-900 tank: totalQuantity=719 decremented, batchDetails[].quantity=900 stale). applyBatchDelta self-heals only EMPTY batchDetails on the next mutation; stale-POPULATED rows never touched again stay wrong. **RESOLVED (this PR):** migration `1801700000000-BackfillStaleTankBatchDetails` — per-tenant (search_path-pinned, to_regclass-guarded), single-batch EXACT reconciliation (the lone detail = the live totals; quantity/biomass/avgWeightG/percentageOfTank derived), idempotent (only rows where sum≠totalQuantity), down=no-op. **Multi-batch stale rows are NOT guessed** (the migration cannot know which batch a past mortality removed fish from) — counted + RAISE NOTICE for coordinated domain review. 4 London-school shape specs (per-tenant guard, single-batch-only, no multi-batch UPDATE, idempotent WHERE, down no-op). **COORDINATION: must merge + deploy BEFORE #782 (event-driven projection rebuild) so the snapshot derives from reconciled batchDetails, not stale (per the parallel-stream agent's note).**
## ORPHAN-HIGH-274 — boot-signal window (120s) false-failed the deploy gate into rollback — RESOLVED
Found 2026-07-01 deploying 8ddf96465. All 25 containers booted HEALTHY (app.suderra.com 200) but the deploy recorded status=rolled_back phase=boot_signal: farm-service emitted its schema_drift_clean + nats_auth_mode_mtls boot signals ~220s in (the 77-entity × per-tenant schema-drift scan under a contended single-droplet cold-start + gateway supergraph composition retrying while auth-service warmed) — PAST the 120s default window in infrastructure/deploy/required-signals.yaml → "Missing boot signals" → rollback, despite every service being healthy (the boot drift-check itself was status:ok, warningViolations:49, error:0). assert-service-signals.ts POLLS and passes the instant all signals appear, so the window is only a MAX-wait ceiling — widening it is free for fast services and only stops false-fails for healthy-but-slow boots. **RESOLVED (this PR):** raised the generated default window_seconds 120→300 (the value db-migrate already used) in the GENERATOR scripts/service-catalog/generate-artifacts.ts (required-signals.yaml is generated — "do not edit by hand"), regenerated, removed the now-redundant db-migrate special-case. service-catalog:check + validate-signals-manifest green (14×3 consistent). Perf follow-up (separate): the schema_drift_clean scan taking ~220s on the heaviest service is slow — worth profiling, but not a deploy blocker once the window fits reality.
## ORPHAN-MEDIUM-278 — per-tank / per-loop water-chemistry MONITORING (customer-driven flexible model) — IN-PROGRESS (mock frontend)
Found 2026-07-01 (customer feedback: the water-chemistry model assumed a single tank — one pH/salinity/temp for the whole system — but real farms are multi-tank RAS with shared treatment ("3 biofilters"): each tank needs its own view, parameters mixed between shared-loop and tank-specific with per-tank overrides). Feature-tracking finding for a net-new LIVE, multi-scope, provenance-annotated MONITORING view under sensor-module (plan `/root/.claude/plans/sprightly-chasing-creek.md`, 3-agent validated: farm + sensor + frontend). **Design:** a "chart" is the projection of a RESOLVED parameter set for a scope (tank | loop | site) through the reused `@platform/aquaculture-engines` engine (unchanged). Flexibility = cascade (`tank → loop(System) → site`, most-specific-non-null; Site=`department.siteId`; loop-sharing gated on `System.type ∈ {ras,biofloc,aquaponics}`) + source binding (`sensor|manual|inherit|derived`, inherit non-terminal) + provenance/staleness. **Delivered this PR (P0+P1, MOCK frontend only, `web/modules/sensor-module/src/pages/water-chemistry/`):** contract types; real-entity-shaped mock fixtures; async `resolveScope`/`resolveTanks` cascade resolver via `useTenantQuery`; engine-adapter (resolved-set→engine inputs, **engineReady guard so a loop's non-self-consistent tuple never feeds the engine** — the critical farm-expert fix); tank-status grid (recharts-free DOM badges); tank drill-down (lean Deffeyes isolines+operating-point + UIA/CO₂ charts from engine data); provenance table; lazy route + engine vite alias. 10 vitest cases lock the cascade/override/System.type-gate/freshness/engineReady invariants; lint + isolated type-check green. **Real-phase follow-ups (NOT this PR, flagged in the plan):** promote DeffeyesChart→shared-ui (full zone-shaded chart, no fork); backend shared-water-loop model + config-driven `sharingScope` + GraphQL `resolveScope` extending WaterQualityParamEquipment; cross-service federation resolver; architectural-arbiter on the monitoring-vs-calculator ownership split. alkalinity/TAN/H₂S stay manual/derived (not in the sensor pipeline; no fabricated live values).


## ORPHAN-HIGH-275 — harvest handlers injected TankBatchService but HarvestModule didn't provide it → farm-service DI crash-loop → deploy rollback — RESOLVED
Found 2026-07-01 root-causing why two prod deploys (8ddf96465, 812da3885) rolled back at the boot-signal gate. #784 added `TankBatchService` to `CreateHarvestRecordHandler` (index 11) + `DeleteHarvestRecordHandler` (index 6) constructors, but `HarvestModule` did not import/provide it — `TankBatchService` was a NON-exported provider of `BatchModule`. So farm-service crash-looped at boot ("Nest can't resolve dependencies of the CreateHarvestRecordHandler ... TankBatchService at index [11] is available in the HarvestModule"), never emitted its boot signals, and the deploy false-failed → rollback (prod ran the rolled-back pre-#784 image; the harvest SSoT-write fix was NOT live; the #786 backfill DID apply — forward-only). The handler UNIT specs passed because they construct the handler directly with a mocked TankBatchService; nothing compiled the module DI graph. **NOTE: #787 (boot-signal window 120→300) MISDIAGNOSED this crash-loop as a slow boot — harmless robustness, but not the fix.** **RESOLVED (this PR):** extracted TankBatchService into `apps/farm-service/src/batch/tank-batch.module.ts` (providers+exports, dep-free, mirrors RestoreModule/BackdatePolicyModule) — the SSoT writer as one shared instance; BatchModule + HarvestModule both import it. Make-it-detectable: new static invariant `batch/__tests__/tank-batch-module-di.spec.ts` — every farm module registering a TankBatchService-consuming handler MUST import TankBatchModule (proven red-before/green-after, exact #784 message). tsc-spec (release-verification gate) + eslint + 16/16 handler specs green. After merge+redeploy farm boots cleanly, the boot-signal gate passes, and the harvest SSoT write goes live.

## ORPHAN-MEDIUM-279 — ARIA writer agents carry no repo coding standards; contract prose drifted from kernel truth — RESOLVED (PR #799, 292e28c77)
Found 2026-07-01 (operator-commissioned ARIA modernization audit; detail: docs/reviews/aria-acceptance-gap-hunter/2026-07-01-aria-agent-system-modernization.md#ORPHAN-MEDIUM-279). implementer/gap-fixer/drafter reference no per-diff repo standards; safety-contract prose contradicts agent_contract.SATISFACTION_VERDICTS (boolean vs enum), counts 15 vs the 16-entry HARD_FAIL_CHECKS registry, mentions Codex CLI (runtime is Claude Code per ADR-040), hardcodes the per-cycle cap dollar value. **Remediation:** slice B1 — shared `_shared/aria-code-writing-standards.md` + writer wiring + prose corrections.

## ORPHAN-MEDIUM-280 — challenger-planner claims cross_review/implementation_review roles the kernel never routes to it — RESOLVED (PR #800, d2dd2a98c)
Found 2026-07-01 (ARIA modernization audit; detail: docs/reviews/aria-acceptance-gap-hunter/2026-07-01-aria-agent-system-modernization.md#ORPHAN-MEDIUM-280). cross_review single mint point is aria-cross-reviewer (cross_review_bridge.py:48); the challenger-planner body still documents both pre-V8 run modes — dead prompt weight + dual-ownership audit hazard; body at 2750/2800 of the Tier-2 token budget. **Remediation:** slice B2.

## ORPHAN-LOW-281 — banned-phrase discipline and refusal sections missing from judge/acceptance bodies — RESOLVED (PR #800, d2dd2a98c)
Found 2026-07-01 (ARIA modernization audit; detail: docs/reviews/aria-acceptance-gap-hunter/2026-07-01-aria-agent-system-modernization.md#ORPHAN-LOW-281). Judges constrain banned phrases only in refusal text (agent_contract._check_banned_phrases also scans rationale/notes); the 4 acceptance-lane agents document no refusal/stop conditions. **Remediation:** slice B2.

## ORPHAN-MEDIUM-282 — no end-to-end ARIA pipeline SSoT; prompt-writer mandate stale — RESOLVED (PR #802, bad35ebda)
Found 2026-07-01 (ARIA modernization audit; detail: docs/reviews/aria-acceptance-gap-hunter/2026-07-01-aria-agent-system-modernization.md#ORPHAN-MEDIUM-282). Lane flows reconstructable only from kernel source; prompt-writer roster paragraph stale, model render rule hardcoded (bypasses tier registry), lacks code-writing-standards + prompt-shape-economy clauses for agents/skills ARIA authors itself. **Remediation:** slice B3 (PIPELINES.md + mandate clauses 12/13 + authoring rules).

## ORPHAN-HIGH-283 — kernel model set frozen pre-Fable; frontmatter effort never delivered to the CLI — RESOLVED (PR #803, 39f92174a)
Found 2026-07-01 (ARIA modernization audit; detail: docs/reviews/aria-acceptance-gap-hunter/2026-07-01-aria-agent-system-modernization.md#ORPHAN-HIGH-283). VALID_MODELS={opus,sonnet,haiku} → `model: fable` parses default_invalid; resolved effort: computed then dropped (CLI 2.1.197 ships --effort); REQUIRED_CLAUDE_VERSION=2.1.0 predates the fable alias. **Remediation:** slice K1.

## ORPHAN-HIGH-284 — no refusal detection on the ARIA CLI executor path — RESOLVED (PR #804, 7255595c3)
Found 2026-07-01 (ARIA modernization audit; detail: docs/reviews/aria-acceptance-gap-hunter/2026-07-01-aria-agent-system-modernization.md#ORPHAN-HIGH-284). parse_claude_jsonl never inspects stop_reason; a Fable safety-classifier refusal surfaces as a generic failure — no audited fallback, no HUMAN_REQUIRED, no ledger row distinguishing it from an outage. **Remediation:** slice K2 (detect + one audited opus retry + HUMAN_REQUIRED on double refusal).

## ORPHAN-HIGH-285 — kernel dispatches two agents that have no agent files; WRITE_TIER sets diverge — RESOLVED (PR #806, cce2c9508)
Found 2026-07-01 (ARIA modernization audit; detail: docs/reviews/aria-acceptance-gap-hunter/2026-07-01-aria-agent-system-modernization.md#ORPHAN-HIGH-285). aria-autonomy-planner + aria-worker are whitelisted envelope targets with no .md files (silent default_missing_file fallback, zero invariant coverage); jest ARIA_WRITE_TIER contains aria-acceptance-gap-fixer while python WRITE_TIER_AGENTS does not. **Remediation:** slice K3.

## ORPHAN-MEDIUM-286 — ARIA budget caps and estimates are opus-calibrated, not model-aware — RESOLVED (PR #807, 3ee3e2c9a)
Found 2026-07-01 (ARIA modernization audit; detail: docs/reviews/aria-acceptance-gap-hunter/2026-07-01-aria-agent-system-modernization.md#ORPHAN-MEDIUM-286). _estimate_envelope_cost_usd hardcodes opus-priced estimates; the $1.50 per-cycle cap assumes opus decision nodes — at fable 2× pricing the reservation math undercounts and the cap fires mid-cycle. **Remediation:** slice K4.

## ORPHAN-MEDIUM-287 — acceptance lane outside the canonical envelope profile; drafter refusals bypass the refusal ledger — RESOLVED (PR #810, 7e8b227c5)
Found 2026-07-01 (ARIA modernization audit; detail: docs/reviews/aria-acceptance-gap-hunter/2026-07-01-aria-agent-system-modernization.md#ORPHAN-MEDIUM-287). The 4 dispatch:ad-hoc acceptance agents emit results in no documented envelope profile; DRAFTER_REFUSAL sentinels never render as aria/agent-refusal/v1 ledger rows. **Remediation:** slice K6.

## ORPHAN-MEDIUM-288 — ARIA tier assignments predate the operator capability policy — RESOLVED (PR #809, e2aab7dae)
Found 2026-07-01 (ARIA modernization audit; detail: docs/reviews/aria-acceptance-gap-hunter/2026-07-01-aria-agent-system-modernization.md#ORPHAN-MEDIUM-288). Operator policy 2026-07-01: decision nodes fable, judge layer opus; current frontmatter 12 opus + 6 sonnet; dispatcher_factory defaults opus + 600s subprocess timeout (too tight for fable turn lengths). **Remediation:** slice K5 (tier flip, single-revert unit).

## ORPHAN-LOW-289 — build-validator body cites a repo-external memory file — RESOLVED (PR #801, 0beecb4e3)
Found 2026-07-01 (ARIA modernization audit; detail: docs/reviews/aria-acceptance-gap-hunter/2026-07-01-aria-agent-system-modernization.md#ORPHAN-LOW-289). build-validator.md:66 cites feedback_webpack_nestjs.md — an operator-session memory file absent from the repo; the webpack/NestJS-DI claim is correct but must anchor to in-repo evidence. **Remediation:** wave W-A.

## ORPHAN-MEDIUM-290 — orchestrator roster describes database-reviewer as primary schema owner while the routing table dispatches it secondary-only — RESOLVED (PR #801, 0beecb4e3)
Found 2026-07-01 (wave W-A of the ARIA modernization roster verification; detail: docs/reviews/aria-acceptance-gap-hunter/2026-07-01-aria-agent-system-modernization.md#wave-w-a-verification-record). orchestrator.md roster row read "All schema sources — state health audit" (primary-ownership phrasing) while orchestrator-routing-table.md — the authoritative primary-ownership registry per agent-ownership-uniqueness.spec.ts — routes database-reviewer as SECONDARY on all four schema globs. An operator reading the roster would expect a primary dispatch that never fires. **Remediation:** align the roster row to secondary-only phrasing (same PR).

## ORPHAN-LOW-291 — contract-parity-enforcer cites the dead infra/openapi path — RESOLVED (PR #812, 24f7f483e)
Found 2026-07-02 (wave W-B1 roster verification; detail: docs/reviews/aria-acceptance-gap-hunter/2026-07-01-aria-agent-system-modernization.md#wave-w-b-verification-record). Agent body (lines 32/45) and orchestrator-routing-table.md glob route `infra/openapi/**`, but the OpenAPI specs live at `docs/api/openapi/*.yaml` — spec changes never dispatched the parity reviewer. **Remediation:** path + glob corrected to docs/api/openapi (same PR); the forward-declared `contract-parity.spec.ts` Phase-4 deliverable markers stay (honest declarations, not dead refs).

## ORPHAN-LOW-292 — security-reviewer pins a brittle research-file count — RESOLVED (PR #812, 24f7f483e)
Found 2026-07-02 (wave W-B1). Body claimed "7 research files" in docs/research/security-reviewer/ while the directory holds 8 — the drift class agent-prompt-accuracy.spec.ts exists to prevent. **Remediation:** count-free phrasing (same PR).

## ORPHAN-MEDIUM-293 — product-audit routing anchors job-queue-auditor to a non-existent shared queue lib — RESOLVED (PR #812, 24f7f483e)
Found 2026-07-02 (wave W-B2). product-audit-orchestrator-routing.md:38 routed `libs/backend-common/src/queue/**`, which does not exist; the real shared async-work surface is `platform/libs/outbox/**`. **Remediation:** glob corrected (same PR).

## ORPHAN-MEDIUM-294 — ORPHAN-EDGE finding ids are cited 240+ times but no ledger defines them — RESOLVED (PR #812, 24f7f483e)
Found 2026-07-02 (wave W-B3). ORPHAN-EDGE-001..014 are a live cross-reference system across the 13 edge-docs agents AND the delivered Siemens documentation package (SOC2 Type-II blocker anchors, protocol roadmap tracking), minted during the Lane-C 12-producer run (ed8184ead), but the defining ledger never landed — an auditor following a citation finds nothing. Renaming is wrong (breaks 121 delivered docs + auditor-facing anchors). **Remediation:** reconstruct the ledger at `sens-api-gateway/docs/reviews/edge-orphan-findings.md` from the inline usage contexts (same PR); protocol-reference-writer also gains the missing dispatch anchor.

## ORPHAN-MEDIUM-295 — aria-operational-proof summary heredoc lacks PYTHONPATH; proof lane fails after a successful burn-in — RESOLVED (PR #814, 9e8367c81; green-lane proof: run 28554897185 SUCCESS on the flipped runtime)
Found 2026-07-02 during the supervised post-flip run (run 28553640728 — the workflow's FIRST-ever invocation): the 30-cycle observe burn-in completed (18 min) but the proof-summary heredoc (`python3 - <<PY` importing aria_kernel.burn_in) runs without the per-invocation `PYTHONPATH=aria-kernel:.` prefix the sibling CLI calls carry → ModuleNotFoundError, job red, proof bundle never verified. **Remediation:** PYTHONPATH moved to the step env block so every invocation (heredocs included) inherits it (same PR); re-run proves the lane green.

## ORPHAN-MEDIUM-296 — ARIA has no scheduled cycle producer; the executor cron drains an always-empty queue — RESOLVED (PR #816, 73f1458f2)
Found 2026-07-02 (operator-approved operationalization plan, item 1). aria-agent-executor runs nightly at 02:00 UTC but only DRAINS the agent-request queue; nothing ever schedules `aria-kernel autonomy run` (the producer: discovery → pressure → triage → planner/bridge/worker drains), so the queue is permanently empty and the enterprise acceptance ledger never accumulates ladder evidence. **Remediation (same PR):** new `.github/workflows/aria-auto-cycle.yml` — 01:00 UTC nightly standard-profile cycle ($3.00/cycle + $20.00/run caps, no auto-merge) with full ADR-036 WorkflowContract registration, executor-parity preflights (CLI floor, managed-auth, cross-host lease, kill-switch), aria-tools-state artifact round-trip for cross-night state, and a `mode=burn-in-observe` dispatch branch that runs a REAL 30-cycle observe burn-in and bridges `record_burn_in_acceptance(mode="real")` into the L1 unlock ladder.

## ORPHAN-MEDIUM-297 — proven-drift seed pool was stale worktree pollution; no tool derives aria-findings from repo truth — RESOLVED (PR #816, 73f1458f2)
Found 2026-07-02 (plan item 2). The May PoC artifact claimed 126 above-threshold enum drifts, but 112 of them referenced `.worktrees/` checkouts and a fresh scan at HEAD (6ca2c91b7) yields 0 TS<->SQL drifts + 1 promoted UI dropdown drift (leaverequest filter missing draft/withdrawn) — seeding from the stored file would have manufactured ~125 phantom findings. **Remediation (same PR):** `tools/aria-poc/seed_drift_findings.py` re-runs the mechanical scanner at HEAD (staleness structurally impossible), emits deterministic `aria-findings/F-1XX.json` + `_index.json` in the exact shape `cycle_guard._open_finding_count` reads, and is wired as a nightly workflow step (aria-findings is gitignored by design — runtime cycle writes must not dirty the discovery tree — so seeds are re-derived, not committed).

## ORPHAN-MEDIUM-298 — no operator lever biases cycles toward a drift class; pressure source weights are hardcoded — RESOLVED (PR #817, 31b4a886a)
Found 2026-07-02 (plan item 2, permanent lever). SOURCE_WEIGHTS in pressure.py is a hardcoded constant; the operator had no way to say "weight schema-drift 2x this month" without a code change. **Remediation (same PR):** `drift_class_weights` block in the genesis policy (neutral 1.0 defaults — behaviour bit-identical), `DRIFT_CLASS_BY_SOURCE` total mapping (every source has a class, pinned by test so new sources cannot escape the lever), `_apply_drift_class_weights` post-scoring multiplier (re-capped at 100, applied multiplier recorded on the row for audit), threaded from `run_enterprise_cycle` via the existing fail-soft policy loader; operator override via `aria-config/genesis_policy.json`.

## ORPHAN-MEDIUM-299 — daily anchor has no merged-value-per-dollar metric; cost and merge ledgers were never joined — RESOLVED (PR #818, dd5356b61)
Found 2026-07-02 (plan item 1, metric leg). The runtime writes per-invocation cost rows (cost-attribution monthly shards, V10.4) and merged-PR rows (pr-lifecycle.jsonl, Plan 025 §E) but nothing joins them — the operator cannot see what a cycle costs against what it merges. **Remediation (same PR):** `roi` block in `build_daily_anchor` (day + month-to-date cost, LLM calls, cycles-with-spend, merged PRs, `usd_per_merge` — null until the day's first merge), rendered into the daily anchor markdown; additive frontmatter key, I-26 parseability untouched; fail-soft on missing ledgers.

## ORPHAN-MEDIUM-300 — narrow autonomous-merge lane lacked a decision record, activation ceremony, and executable inactive-today proof — RESOLVED (PR #819, ae7c6941f)
Found 2026-07-02 (plan item 3). Implementation review showed the executable policy surface already correct — risk-policy L1 lane = exactly the approved docs/test scope, `auto_merge_candidate_lanes=["L1"]`, master switch shipped off, L3→L2→L1 precedence routes `docs/aria/policy/**` to the control-plane lane — but a draft runbook had conflated the autonomy-unlock LADDER L1/L2/L3 with the risk-lane L1/L2/L3 (opposite meanings of "L3"), and nothing pinned the closed gates. **Remediation (same PR):** ADR-041 (terminology table, decision, 5-step activation ceremony, rollback) + `test_narrow_lane_inactive_until_unlock.py` (8 pins: lane routing, precedence, mixed-lane block, secrets block, empty-ladder refusal, master switch off, no runtime globs).

## ORPHAN-LOW-301 — git fixture repos spawn background auto-gc racing TemporaryDirectory cleanup — RESOLVED (PR #819, ae7c6941f)
Found 2026-07-02 (CI run 28558877068, burn-in suite): detached `git gc --auto` still writing `.git/objects/pack` while teardown rmtree ran → flaky "Directory not empty" OSError. **Remediation (same PR):** `make_local_git_repo` sets `gc.auto=0`, `gc.autoDetach=false`, `maintenance.auto=false` — the background writer is structurally impossible for every fixture consumer.


## ORPHAN-HIGH-276 — tank_batches.currentQuantity drifted from totalQuantity (the ACTUAL live 719-vs-900) — RESOLVED
Found 2026-07-02 by live read-only forensics of the reported tank (verifying the harvest fix). The divergence was NOT batchDetails (NULL on these rows) — it was two SCALAR columns: tank 30f0a5dc had `totalQuantity=719` but `currentQuantity=900` (and f642e76a 98-vs-180). Batch-level proof: batch B-2026-00001 currentQuantity=900 (initial 1000, QUARANTINE); sum(totalQuantity) over its 3 tanks = 719+98+83 = 900 = the batch's live count → **totalQuantity(719) is CORRECT; currentQuantity(900) is a stale batch-total leak.** The web resolver reads `currentQuantity ?? totalQuantity` (equipment.resolver.ts:404) → showed the wrong 900; the mobile projection reads totalQuantity → showed the correct 719. currentQuantity/currentBiomassKg are denormalized MIRRORS — applyBatchDelta always sets `currentQuantity = totalQuantity` — so any divergence is legacy drift from the pre-applyBatchDelta handlers. **#786's batchDetails backfill did NOT cover these (their batchDetails is NULL, not populated-stale) — the gap.** **RESOLVED (this PR):** migration `1801800000000-BackfillTankBatchCurrentQuantityMirror` sets currentQuantity:=totalQuantity + currentBiomassKg:=totalBiomassKg for every divergent row (per-tenant to_regclass-guard, idempotent IS-DISTINCT-FROM incl. NULL mirrors, down no-op). Fixes the live 719-vs-900 → web now shows 719 (aligned with mobile + the batch truth). 4 shape specs; drift-repair-naming + tsc-spec + eslint green. Note: a live harvest test was infeasible (all 3 tanks hold the QUARANTINE batch → harvest-eligibility rejects); the read-only batch reconciliation gave the definitive answer instead.

## ORPHAN-LOW-302 — aria-auto-cycle omits the kernel dependency-install step; fresh tool-cache Python lacks yaml — RESOLVED (PR #821, 334158b7d)
Found 2026-07-02: the first live run on the freshly registered self-hosted runner (28572191761) failed at "Persist enterprise workflow preflight" with ModuleNotFoundError: yaml — setup-python provisions a bare tool-cache interpreter and the workflow never installed the kernel's pyproject dependencies (the operational-proof workflow does). **Remediation (same PR):** the same "Install aria-kernel dependencies" step (pip install from aria-kernel/pyproject.toml) inserted before the first kernel import.

## ORPHAN-LOW-303 — artifact restore forwards the GitHub auth header into the 302 blob redirect — RESOLVED (PR #822, 5f4710054)
Found 2026-07-02 (second live run of aria-auto-cycle): the Actions artifact download endpoint answers 302 to blob storage, and urllib's default redirect handler re-sent the `Authorization: Bearer` header to the storage host, which rejects it — restore fails exactly when a prior artifact EXISTS (first-night bootstrap masked it). **Remediation (same PR):** manual redirect resolution — authorized first hop with redirects suppressed, bare second hop to the presigned blob URL.

## ORPHAN-LOW-304 — burn-in-observe mode passed a workspace-internal tools dir; kernel isolation guard refuses — RESOLVED (PR #823, e3354e7c7)
Found 2026-07-02 (third live run): `autonomy burn-in observe` fail-closed with `observe_burn_in_tools_dir_must_be_outside_workspace_root` — the workflow handed it the workspace `aria-tools/` tree, but the kernel requires burn-in isolation from the workspace root (the operational-proof lane always used RUNNER_TEMP). **Remediation (same PR):** burn-in gets its own RUNNER_TEMP tools root; the ladder bridge (`record_burn_in_acceptance(mode="real", base_dir="aria-tools")`) keeps writing acceptance events into the artifact-persisted workspace tree, and the evidence bundle is copied alongside the ledger.

## ORPHAN-LOW-305 — burn-in output dir must live under the burn-in tools root; second layout guard refused — RESOLVED (PR #825, ac8bb6ae2)
Found 2026-07-02 (fourth live run): after the tools-root isolation fix, `observe_burn_in_output_dir_must_be_under_tools_burn_in` refused the RUNNER_TEMP-adjacent output dir. **Remediation (same PR):** output moves to `$BURN_TOOLS/burn-in/run-<id>` (operational-proof layout); a local 3-cycle probe validated the full layout pre-PR — only the 30-cycle count guard remains, which CI satisfies.

## ORPHAN-LOW-306 — committed .gitignore lacks top-level aria-tools/ and aria-findings/ rules; runtime state dirties the CI worktree — RESOLVED (PR #826, 80f6f0d15)
Found 2026-07-02 (fifth live run): `observe_burn_in_pre_worktree_not_clean: 2 path(s)` — the design treats both trees as gitignored runtime state (cycle_guard reads them, cycles write them, discovery/burn-in guards demand a clean tree), but the committed .gitignore listed only SUBPATHS (`aria-tools/.archive/`, `impact-graphs/`, ...); local checkouts masked the gap via ad-hoc state. **Remediation (same PR):** top-level `aria-tools/` + `aria-findings/` ignore rules, `PYTHONDONTWRITEBYTECODE` job env (kernel-workflow parity), and a pre-burn-in `git status --porcelain` printout so any future dirty path names itself in the log.

## ORPHAN-MEDIUM-307 — kernel debt-index refresh clobbers the committed audit index when the uncommitted events ledger is absent — RESOLVED (PR #827, 6889d511e)
Found 2026-07-02 (sixth live run of the burn-in lane; pre-existing kernel defect the fresh CI checkout exposed): `aria-debts/_index.json` is COMMITTED audit content (6 real debts), but `_refresh_index` derives it from the UNCOMMITTED `debt-events.jsonl` — on a fresh checkout the ledger is absent, so any kernel command touching the debt surface (here: `handoff snapshot`) silently truncated the committed index to `[]`, mutating a tracked file and tripping the burn-in clean-tree guard (`1 path(s)`). **Remediation (same PR):** absent-ledger + existing-index is now read-only (returns the committed truth, writes nothing); empty-fresh repos still derive; present-ledger rebuild unchanged. Proven by 3 pinned tests + an end-to-end fresh-clone sim (handoff no longer dirties the tree).

## ORPHAN-HIGH-308 — pre-auth security events lost: auth.audit_logs INSERT violates RLS on locked-account login — IN-PROGRESS (fix in the ORPHAN-HIGH-318 PR)

**Discovered:** 2026-07-02, live prod (while diagnosing a test-account lockout during the tank-count reconcile verification).
**Evidence:** `aqua-auth` logs — `AuthenticationService.logSecurityEvent(LOGIN_BLOCKED_ACCOUNT_LOCKED)` →
`QueryFailedError: new row violates row-level security policy for table "audit_logs"` (stack:
`AuditLogService.log` → `AuthenticationService.logSecurityEvent` → `login`, auth.resolver). The login itself
fails closed correctly; the SECURITY AUDIT ROW is silently dropped (error swallowed as
"Failed to log security event").
**Root cause:** the lockout branch of `login` runs BEFORE an authenticated tenant context exists, so the
RLS tenant GUC is unset/mismatched while the audit row carries the user's `tenantId` — the auth.audit_logs
RLS policy rejects the INSERT. Every pre-auth security event on this branch (account-locked, likely also
other pre-auth denials writing tenant-scoped audit rows) is lost.
**Why it matters:** lockout/brute-force events are exactly the rows a SOC-2 / forensic review needs
(audit-trail completeness, CC4); the failure is silent, so coverage gaps are invisible.
**How to fix (architectural):** pre-auth security events must be written through a path that satisfies RLS
by construction — either run the audit INSERT with the system/audit-writer role that auth-service already
uses for cross-tenant audit writes, or set the tenant GUC for the audit transaction from the resolved user
row before the INSERT (the user row IS resolved — its tenantId is in the payload). No swallow-and-continue:
the audit write failing should surface as an ERROR metric, not a debug log.
**Owner:** auth-security-expert. **Deadline:** 2026-07-24.
**Remediation (2026-07-02, shipped with the ORPHAN-HIGH-318 PR):** additive INSERT-only permissive policy `audit_append_system` on `auth.audit_logs` (migration `1801900000000-AllowSystemInsertsOnAuditLogs`). PostgreSQL ORs permissive policies per command, so appends succeed from pre-auth and SUPER_ADMIN (tenantId NULL) paths while SELECT/UPDATE/DELETE stay governed solely by `tenant_isolation_policy` (tenant-scoped reads + tamper posture unchanged). This matches the RLS installer's own design intent — `applyTenantRlsToSchema` documents audit logs under `excludeTables`; the auth migrations never excluded this table. See ORPHAN-MEDIUM-324 for the platform-wide sweep of the same class.
**Completion addendum (2026-07-02 evening, this PR):** the INSERT policy is necessary but NOT sufficient — post-deploy live verification showed standalone audit writes STILL failing: TypeORM `save()` always emits `INSERT … RETURNING` (to reload generated columns) and PostgreSQL applies the SELECT policy's USING clause to rows read back via RETURNING, so a pre-auth/SUPER_ADMIN session (no tenant GUC) was rejected at the RETURNING step (probe under `SET ROLE auth_service`: bare INSERT passes, `INSERT … RETURNING` fails). Completed by running the standalone `AuditLogService.log` path in a transaction whose first statement is `set_config('app.bypass_rls','on', true)` — the same audited system primitive the outbox dispatcher uses (ORPHAN-HIGH-321). Manager-passed (caller-transaction) writes are unchanged.

## ORPHAN-MEDIUM-309 — aria-auto-cycle burn-in mode killed by a flat 50-minute job timeout; the workload>timeout class was structurally undetectable — IN-PROGRESS
Found 2026-07-02 (seventh live run of the burn-in lane): run 28577469404 passed every guard for the first time, executed ~17/30 REAL observe cycles (~2.5 min/cycle measured) and was cancelled at the flat 50-minute job limit copied from single-cycle precedents (executor/proof: 35 min). Because the acceptance verdict is all-or-nothing (kernel pins 30 cycle attempts), the truncation produced ZERO ladder evidence — ~50 minutes of runner work silently destroyed, L1 unlock blocked. **Remediation (same PR):** mode-aware timeout expression (`burn-in-observe && 150 || 50`) in the workflow + `WorkflowJobContract.burn_in_timeout_floor_minutes` (aria-auto-cycle: 120, aria-operational-proof mock: 30) enforced by the contract verifier in BOTH directions — a burn-in step in a job whose contract declares no floor rejects, a declared floor without a burn-in step rejects, and both int and mode-expression timeout forms are parsed against the floor. An unexamined inherited timeout can no longer reach a burn-in job.

## ORPHAN-MEDIUM-308 — admin-panel TenantManagementPage.spec.tsx is 16/33 red independent of jest-dom wiring — IN-PROGRESS (wiring fix done, pending merge; 16 residual failures untouched)
Found 2026-07-02 while completing an orphaned untracked `web/modules/admin-panel/src/test-setup.ts` (jest-dom matcher registration, left uncommitted since ~2026-06-21 with nothing wiring it into `vite.config.ts`'s `test.setupFiles`). Wiring it in is a genuine fix — `TenantManagementPage.spec.tsx` went from 31/33 failing to 16/33 failing, since `toBeInTheDocument()`/`toHaveClass()` etc. were previously undefined matchers — but 16 tests remain red for an unrelated reason: `waitFor(() => screen.getByText('Ocean Farms Ltd'))`-style assertions across Search/Filter, Tenant Actions, Bulk Operations, Tenant Detail Modal, and Stats Display never see the fixture tenant row render, suggesting the test's data-fetch mock (MSW handler or fetch mock) no longer matches what `TenantManagementPage` actually calls — a genuine pre-existing component/test drift, confirmed unrelated to jest-dom (same 16 tests are the SUBSET that survives once matcher-registration errors are removed). Root cause not yet diagnosed. Owner: whoever next touches admin-panel tenant management or its test suite.

## ORPHAN-MEDIUM-314 — gateway-api reimplements unknown-rejection normalization ad hoc at 9 sites, one variant losing the object case — IN-PROGRESS
Found 2026-07-02 while completing an orphaned untracked `apps/gateway-api/src/common/error-normalization.ts` (a `toError()` helper, left uncommitted since ~2026-06-21, never wired to any call site). Repo-wide grep confirmed no equivalent existed in gateway-api or backend-common. 9 call sites across `upload.controller.ts` (5x), `circuit-breaker.service.ts`, `timeout.middleware.ts`, and `redis-io.adapter.ts` (2x) each independently reimplemented `error instanceof Error ? error : new Error(String(error))` (or the log-message variant `error instanceof Error ? error.message : String(error)`) — the latter loses information for non-Error/non-string rejections (`String({...})` → `"[object Object]"`) where `toError`'s `JSON.stringify` fallback preserves the payload. **Remediation:** adopted `toError()` at all 9 sites; added `error-normalization.spec.ts`. **Renumbered from ORPHAN-MEDIUM-309 during merge-train collision resolution** — PR #831 (merged before this branch) independently claimed ORPHAN-MEDIUM-309 for an unrelated ARIA finding (see above). Commit `b622d2366`'s `Closes:` trailer still cites the original id; this heading is the authoritative record.

## ORPHAN-MEDIUM-310 — RedisService.keyPrefix uses `||` instead of `??`, silently discarding an explicit empty-string prefix — IN-PROGRESS
Found 2026-07-02 while completing an orphaned untracked `libs/backend-common/src/redis/redis-options.builder.spec.ts` + `redis.service.spec.ts`. `RedisModuleOptions.keyPrefix?: string` explicitly types empty string as a valid "I own my own key namespacing" signal, but `redis.service.ts`'s constructor did `this.keyPrefix = options.keyPrefix || 'aqua:'` — a falsy check, not a nullish check — so `keyPrefix: ''` silently became the default `'aqua:'` prefix. No current `RedisService` consumer hits this in production (checked all `buildRedisOptions(...)` call sites across every service; none pass an empty override, and `apps/messaging-service` uses a separate raw-ioredis client unaffected by this class), but it's a live trap for any future consumer needing an owned namespace, and the untracked spec had already pinned the correct behavior. **Remediation:** `options.keyPrefix ?? 'aqua:'`.

## ORPHAN-MEDIUM-311 — e2e TestDatabase hardcoded DEFAULT_DATABASE_URL silently drifted from the actual docker-compose port — IN-PROGRESS
Found 2026-07-02 while completing an orphaned untracked `e2e/helpers/env.helper.ts` (a `.env`/docker-compose credential resolver, left uncommitted since ~2026-06-21, never wired into `db.helper.ts`). `db.helper.ts`'s `TestDatabase` fell back to a hardcoded `postgresql://aquaculture:aquaculture@localhost:5432/aquaculture` whenever `DATABASE_URL` wasn't already set in the environment. Live verification against the actual `docker-compose.infra.yml` showed the real mapping is `"5433:5432"` (host:container) — the hardcoded default's port 5432 was WRONG relative to the compose file actually in use. **Remediation:** `db.helper.ts` now resolves via `env.helper.ts`'s `getRequiredE2eDatabaseUrl()` (env var → `.env`/`.env.local` → docker-compose-derived) before falling back to the hardcoded literal, so the default can no longer silently diverge from the running compose file.

## ORPHAN-MEDIUM-312 — aquamobil silently swallowed 9 background-operation failures with zero observability — IN-PROGRESS
Found 2026-07-02 while completing an orphaned untracked `web/apps/aquamobil/src/utils/async-action.ts` (a logging fire-and-forget wrapper, left uncommitted since ~2026-06-21, never imported anywhere). 9 sites across `useAuth.tsx` (6, spanning the Promise.all logout-cleanup array, push teardown, and the server logout-notify fetch), `useChannels.ts`, `useMessages.ts`, and `messaging-sw.ts` did `.catch(() => undefined)` — permissions-cache cleanup failures, offline-fallback caching failures, push teardown failures, and SW background cache-revalidation failures were all invisible to field support with no way to diagnose a report of "logout left stale data" or "offline mode showed nothing." **Remediation:** 8 sites (which stay `await`ed / part of `Promise.all`) got inline `logger.error(...)` catches preserving their existing control flow; the 1 genuinely fire-and-forget site (logout server-notify) now uses `runAsyncAction()`. A much larger, separate surface (~65 `void asyncCall()` sites across ~25 files) was found during the same sweep but intentionally NOT touched — different shape, different risk profile, flagged to the operator as a distinct decision rather than swept blind.

## ORPHAN-MEDIUM-322 — aquamobil: 10 of ~65 void-wrapped async calls were genuinely unguarded (2 broke their own "never throws" contract) — IN-PROGRESS
Found 2026-07-02 during a follow-up sweep of the ~65-site `void asyncCall()` surface flagged (but intentionally not touched) in ORPHAN-MEDIUM-321. Systematically checked every site's underlying function for internal error handling: 55 are genuinely safe (27 are `queryClient.invalidateQueries`/`refetch`/`fetchNextPage` — TanStack Query does not propagate query-fetch errors through those promises, confirmed via the app's QueryClient config carrying no `throwOnError`; the rest already have their own try/catch). 10 were not: `InstallPrompt.tsx`'s `handleInstall`, `NotificationsPage.tsx`'s `markAllAsRead`/`handleNotificationPress`, `RecordFeedingPage.tsx`'s cached-seed load, `ChatRoomPage.tsx`'s `sendMessage`, and `AiChatPage.tsx`'s `handleSend` (×2 call sites) had no guard at all. Two were worse: `useMarkRead.ts` and `useEditMessage.ts` both explicitly document "never throws — degrades to the offline queue" in their own JSDoc/inline comments, but their offline path and catch-fallback path both called `addToQueue()` (which throws when `tenantId` is missing) completely unguarded — the documented contract was false. `AccountPage.tsx`'s "Clear Offline Queue" action had no error handling or user-facing error message at all, unlike its sibling "Log Out" dialog (MT-MEDIUM-050) which does. **Remediation:** `useMarkRead`/`useEditMessage` now genuinely honor their "never throws" contract (internal try/catch around every `addToQueue` call, logged on failure); `handleClearQueue` now follows the same try/catch + `errorMessage` state pattern as `handleLogout`; the other 6 call sites use the (already-adopted) `runAsyncAction()` helper. `sendMessage`'s failure path was left as `onError`-driven UI state (already correct — `_status: 'failed'` on the optimistic message) with only the separate unhandled-promise-rejection gap closed via `runAsyncAction` at the call site. **Renumbered from the originally-assigned ORPHAN-MEDIUM-313 during merge-train collision resolution** — main independently claimed ORPHAN-MEDIUM-313 for an unrelated ARIA finding (see below).

## ORPHAN-MEDIUM-315 — 5 real CI failures surfaced by PR #830 (registry state-machine violation + 2 tsconfig-scope gaps + 1 finding-registry hygiene issue) — IN-PROGRESS
Found 2026-07-02 from PR #830's own CI run. (1) `docs/reviews/_registry/findings.jsonl`: 6 findings (ORPHAN-MEDIUM-308,310-314) were created with `state: RESOLVED` and empty `closing_commits` before merge — the registry's own `close` CLI refuses branch-local SHAs specifically because RESOLVED requires a merged, main-reachable commit; corrected to IN-PROGRESS, `docs/plans/2026-06-18-enterprise-grade-debt-closure/manifest.json`'s pinned counts recomputed from the rechained registry. (2) `e2e/helpers/env.helper.ts`'s `loadYaml` call tripped `no-unsafe-call`/`no-unsafe-assignment` in CI specifically — the lint job never runs `npm --prefix e2e ci`, so `@types/js-yaml` (declared but not installed there) was absent; the ambient declaration was added to the already-in-scope `e2e/types.d.ts` instead of a repo-root `types/` directory e2e's tsconfig never included. (3) `tools/testing/vitest-resource-policy.ts` had no tsconfig owner (every `tools/*` subdir needs one); added `tools/testing/tsconfig.json` with ESNext/bundler module (its siblings are CommonJS, but this file needs `import.meta.url`). (4) aquamobil's `tsconfig.sw.json` scopes `types` to `vite-plugin-pwa/client` only; importing the shared `logger` util (which reads `import.meta.env.DEV`) into the service worker broke under that narrow config even though the value is real at runtime — added `vite/client` to the SW config's types.
## ORPHAN-MEDIUM-316 — e2e/project.json registration silently exposed live-infra-dependent test scripts to the generic nx affected test sweep — IN-PROGRESS
Found 2026-07-02 from PR #830's own CI run. Nx auto-infers a target from every `package.json` script for any recognized project — registering `e2e/project.json` (bringing e2e into `nx affected` for the first time, per ORPHAN-MEDIUM-315's sibling Nx-backfill work) therefore also exposed `test`, `test:security`, `test:node`, etc. as Nx targets, even though only `lint` was explicitly declared. The generic CI `test` job (no Postgres provisioned — only the dedicated `farm-water-chemistry-e2e` job provisions e2e's infra) then ran `@aquaculture/e2e-tests:test`, which failed immediately: `global-setup.ts` can't reach `localhost:5433`. **Remediation:** `"nx": { "includedScripts": [] }` in `e2e/package.json` disables Nx's package.json-script auto-inference entirely, leaving only the explicit `lint` target from `project.json`. The dedicated e2e CI job is unaffected — it invokes `npm --prefix e2e run test:water-chemistry` directly, never through Nx.

## ORPHAN-HIGH-310 — ARIA plan convergence measures agreement, not coverage; the impact closure was never kernel-verified — RESOLVED (PR #832, 3afc83e8f)
Found 2026-07-02 (operator question: "both planners can under-read the codebase — how is end-to-end plan coverage guaranteed?"). Verified: the planner prompts demand recursive-impact tracing "to the most extreme affected node", but NOTHING in the kernel checks it — `_validate_plan_content` is shape-only, and the primary + challenger share model and search habits, so two planners routinely share one blind spot and CONVERGE on it. **Remediation (PR-1 of the coverage initiative, same PR):** deterministic impact-closure witness `tools/gates/plan-coverage-witness.ts` (nx reverse-dependent BFS + NATS consumer matching from services.yaml + entity→migration coupling; exit 0/1/2 contract) + `aria_kernel/plan_coverage.py` fail-closed wrapper (toolchain/timeout/garbage → `environment_unable`, never a silent pass) + `coverage_computed` annotation event + verdict-driven gate in `_evaluate_cross_review_state` for `schema_version >= 2` plans (missing verdict / environment_unable → HUMAN_REQUIRED; gaps → round loop with round-scoped `COV-R{N}-*` material risks and `coverage:<node>` must_satisfy feed-forward) + `request_implementation` defense-in-depth closing the critique-only-path bypass. PR-2 (completeness-critic adjudicating waivers; PR-1 machine-accepts non-empty waiver reasons as a documented staged loosening) follows in the same initiative.

## ORPHAN-HIGH-311 — cost attribution hardcodes estimated_usd=0.0 under managed auth; USD caps toothless, ROI reads $0 — RESOLVED (PR #833, f3faac619)
Found 2026-07-02 on the FIRST real production cycle (run 28586601819): a claude-fable-5 dispatch consumed 15,801 input + 27,294 output tokens and was attributed as `estimated_usd: 0.0` — `_record_claude_cli_usage` hardcoded the zero by design comment ("managed-session auth, not API-key billing"). Consequence: the operator's $3/cycle + $20/run budget caps can never bind on real dispatches, and the daily-report ROI metric (usd_per_merge) reads $0 forever — a governance control that exists but cannot fire. **Remediation (same PR):** `budget.MODEL_PRICING_USD_PER_MTOK` notional-pricing SSoT + `estimate_tokens_usd` (prefix-matches dated model ids); executor resolution order = actual CLI `total_cost_usd` (billed accounts) > notional token pricing (subscription capacity is rate-limited, not free) > LOUD zero (`cost_pricing_unknown_model` governance event — a silent zero is the defect class). The defective dispatch reprices to ~$1.52 notional, comfortably under the $3 cycle cap.

## ORPHAN-MEDIUM-312 — first real challenger dispatch cited repo-unverifiable evidence (.cargo/*); rejected fail-closed, prompt/evidence-contract mismatch to diagnose — OPEN
Found 2026-07-02, run 28586601819: seeded finding F-101 (leaverequest UI drift) drove the first real plan; the challenger (claude-fable-5, 27k output tokens) submitted a plan whose evidence_refs cited `.cargo/audit.toml` + `.cargo/config.toml` → `evidence_ref_not_repo_verified:worktree_candidate` → result REJECTED, `challenger_drafted_poll_timeout` (300s), convergence failed closed (CORRECT posture — zero merge risk, full audit trail). Open question: why a UI-drift plan cites Rust workspace config — prompt scoping, envelope evidence availability, or validator strictness on gitignored-but-present paths. Diagnose from the stored transcript (`agent-invocations/outputs/plan-cyc-20260702T113123Z-auto/`) before relying on nightly convergence throughput. **Owner:** aria-acceptance-gap-hunter. **Deadline:** 2026-07-16.

## ORPHAN-MEDIUM-321 — aquamobil silently swallowed 9 background-operation failures with zero observability — IN-PROGRESS
Found 2026-07-02 while completing an orphaned untracked `web/apps/aquamobil/src/utils/async-action.ts` (a logging fire-and-forget wrapper, left uncommitted since ~2026-06-21, never imported anywhere). 9 sites across `useAuth.tsx` (6, spanning the Promise.all logout-cleanup array, push teardown, and the server logout-notify fetch), `useChannels.ts`, `useMessages.ts`, and `messaging-sw.ts` did `.catch(() => undefined)` — permissions-cache cleanup failures, offline-fallback caching failures, push teardown failures, and SW background cache-revalidation failures were all invisible to field support with no way to diagnose a report of "logout left stale data" or "offline mode showed nothing." **Remediation:** 8 sites (which stay `await`ed / part of `Promise.all`) got inline `logger.error(...)` catches preserving their existing control flow; the 1 genuinely fire-and-forget site (logout server-notify) now uses `runAsyncAction()`. A much larger, separate surface (~65 `void asyncCall()` sites across ~25 files) was found during the same sweep but intentionally NOT touched — different shape, different risk profile, flagged to the operator as a distinct decision rather than swept blind. **Renumbered from the originally-assigned ORPHAN-MEDIUM-312 during merge-train collision resolution** — main independently claimed ORPHAN-MEDIUM-312 for an unrelated ARIA finding (see above). Commit `b41dc13f3`'s `Closes:` trailer still cites the original id.
## ORPHAN-MEDIUM-313 — plan-coverage PR-1 staged loosening: waivers machine-accepted on any non-empty reason — RESOLVED (PR #834, 2336b5669)
Documented in ORPHAN-HIGH-310's remediation as the PR-1/PR-2 split: PR-1 (#832) machine-accepts any non-empty `coverage.waivers` reason, so a planner can dress a blind spot as a waiver and pass the gate. **Remediation (same PR):** the `aria-completeness-critic` role (Read/Grep/Glob-only) adjudicates EVERY waived node — accept only with repo-verified grounds, reject with a concrete `path:line` reason; the drainer mints the critic envelope only when a round computes `covered_with_waivers`, folds the verdict into the `coverage_computed` payload BEFORE recording, and every failure mode (omission, timeout, refusal, malformed response, ARIA_STOP) fails closed to `gaps` via `waiver_unadjudicated` with fresh round-scoped `COV-R{N}-*` material risks. Role plumbing is annotation-only by design (NOT a planner-bridge role — no plan-state mutation on submit). 17th HardFailCheck (`plan_coverage_witness_verified`) catalogs the implementation-seam enforcement.

## ORPHAN-LOW-314 — challenger independence was read-order-only; correlated blindness unaddressed — RESOLVED (PR #834, 2336b5669)
Companion to ORPHAN-HIGH-310: the challenger planner's independence rested on reading the same evidence in a different ORDER with the same model and the same code-forward habits — so both planners routinely shared one blind spot and converged on it. **Remediation (same PR):** the independence discipline now assigns an explicit REVERSED LENS — the challenger starts from the consumer/contract end (event subscribers, API consumers, migration surfaces, frontend usage) and meets the changed code last. Cheapest arm against correlated blindness; the deterministic coverage witness (ORPHAN-HIGH-310) remains the enforcement layer.

## ORPHAN-MEDIUM-323 — CURRENT_STATE.md's pinned ARIA authority hash went stale after merging main's ARIA changes, breaking invariants-fast + aria-merge-authority — IN-PROGRESS
Found 2026-07-02 from PR #830's own CI run. `tests/invariants/aria-doc-runtime-ssot.spec.ts`'s `ariaAuthorityHash()` computes a sha256 over every tracked file under `docs/aria`, `aria-kernel`, `tools/aria-poc`, plus `.github/workflows/aria-*.yml`, and asserts it matches the hash pinned in `docs/aria/CURRENT_STATE.md`. Merging main's concurrent ARIA landings (#832 coverage witness, #834 completeness critic, #833 cost attribution) into this branch changed files inside that authority set, so the branch's pinned hash (still the pre-merge value) no longer matched the merged tree's freshly-computed hash — failing both `invariants-fast` and `aria-merge-authority` identically (same assertion, two CI jobs). **Remediation:** regenerated the pinned hash from the current merged tree (`ade7ed09e20c398c834d61c510242678d8da2a0f02510bcc3a05f5646a7facba`), matching the documented per-PR regen requirement for this SSoT.

## ORPHAN-HIGH-321 — farm outbox dispatcher is RLS-blind: forced tenant_isolation_policy on the outbox tables hides every pending row from the worker, so domain events are written but NEVER dispatched — IN-PROGRESS (this PR)

**Discovered:** 2026-07-02, live prod (event-backbone census during the ORPHAN-HIGH-317 diagnosis).
**Evidence:** `farm.outbox_events` held 28 rows, ALL `publishedAt IS NULL`, `retryCount = 0`, `lastError` empty, `leasedAt/leasedBy` null — newest 2026-07-02 07:44 (BatchHarvested, BatchTransferred ×3, MortalityRecorded, WaterQualityMeasurementCreated…). The worker WAS running (OutboxNotifyListener LISTEN connected; @Cron every 5s) yet zero dispatch attempts ever happened. `pg_class`: `relrowsecurity = t, relforcerowsecurity = t` with `tenant_isolation_policy USING (app.bypass_rls = 'on' OR "tenantId" = app.current_tenant)` — and the same policy sits on EVERY service's outbox table (10 tables, see ORPHAN-MEDIUM-324). The worker polls with no tenant GUC and never set the bypass → its gauge counts read 0 (metrics lied AND the `pendingCount === 0` early exit skipped leasing), its lease SELECT saw nothing, and its mark/cleanup UPDATEs would have matched nothing.
**Root cause:** the outbox tables received fail-closed tenant RLS (correct hardening) but the BY-DESIGN cross-tenant infrastructure sweeper was never given an RLS system path — the `applyTenantRlsToSchema` helper's own docs place outbox tables in `excludeTables`, which the per-service migrations ignored. Fail-closed + system-path-not-provisioned = silent total outage of the transactional-outbox guarantee, invisible in every log and metric.
**Remediation (this PR, library-level — fixes all 10 services' outboxes at once):** `OutboxWorkerService.runAsOutboxSystem()` wraps EVERY table access (gauge counts, lease SELECT … FOR UPDATE SKIP LOCKED, markPublished/markFailed UPDATEs, nightly cleanup DELETE) in a transaction whose first statement is `set_config('app.bypass_rls','on', true)` — the same audited primitive BypassRlsService uses, `is_local = true` so it can never leak through the pool. And the silent-stall CLASS is made detectable: new `outbox_oldest_pending_age_seconds` gauge + an ERROR-level pending-age alarm (`OUTBOX_PENDING_AGE_ALARM_MS`, 10 min) that fires every poll cycle while the oldest unpublished row exceeds the threshold — a dead pipeline can never again be quiet. Pinned by a new worker spec (every transaction opens with the bypass; gauges computed in system context; alarm fires/holds correctly; failure bookkeeping under bypass).
**Residual:** the 28 stuck farm rows will drain on the first post-deploy poll; verify with the stream census. ORPHAN-MEDIUM-324 tracks the audit-ledger side of the same table class.
**Owner:** platform-kernel-expert + farm-expert. **Deadline:** 2026-07-16.

## ORPHAN-HIGH-317 — NATS grants SSoT drifted platform-wide onto the legacy AQUACULTURE_EVENTS.* subject scheme; every auth/hr/billing/notification/hydroponics domain-event publish and 10+ RPC subjects denied at the broker — IN-PROGRESS (this PR)

**Discovered:** 2026-07-02, live prod (while diagnosing the codex-test tenant-admin lockout; every successful login logged `Permissions Violation for Publish to "events.system.UserLoggedIn"`).
**Evidence (live):** `aqua-auth` — publish denials on every LOGIN_SUCCESS; `aqua-billing` — `Permissions Violation for Subscription to "request.billing.tenant.provisionSubscription"` (tenant provisioning cannot create subscriptions); `aqua-messaging` — subscription denial on `request.messaging.getMessageForBroadcast` (WS broadcast bridge dead); `aqua-sensor` — subscription denial on `sensor.lookup.by-topic` (Rust-sidecar cache-miss responder dead). JetStream census: the AQUACULTURE_EVENTS stream contains **4 messages EVER (last 2026-06-07)** while 54 durable consumers wait at delivered≈4 — the platform event backbone is dark.
**Root cause:** `infrastructure/nats/services.yaml` grants were written in an `AQUACULTURE_EVENTS.<Type>.>` scheme. `AQUACULTURE_EVENTS` is the JetStream STREAM NAME — the event bus (`NatsEventBus.deriveSubject`) publishes to `events.{tenantId|system}.{EventType}`; no code has ever published to an AQUACULTURE_EVENTS-prefixed subject. Services partially migrated (farm/messaging/alert/gateway have some `events.*` grants); auth, notification, billing, hr, hydroponics had ZERO. RPC subjects drifted the same way (grants ≠ `@MessagePattern`/ClientProxy truth). The advertised CI invariant never ran (ORPHAN-MEDIUM-325), so nothing detected it.
**Remediation (this PR):** services.yaml rewritten to the canonical scheme with per-service publish grants derived from code truth (createBaseEvent/eventType extraction per app), RPC grants aligned both sides (billing `request.billing.tenant.>`, messaging `getMessageForBroadcast` + its 7 caller-side RPC publishes incl. the AI bridge, sensor `sensor.lookup.by-topic` both sides), legacy prefix STRUCTURALLY banned in services.schema.json, nats.conf regenerated, messaging's 2-segment `@EventPattern('events.TenantProvisioned')` fixed to the canonical 3-segment shape, and the whole class made detectable: rewritten `nats-invariants.spec.ts` (publish-coverage + RPC-coverage + shape checks, 54 tests) wired into CI for the first time (`.github/workflows/nats-invariants.yml`) with a generator-idempotency gate.
**Dead-RPC residue (superseded — the original claim was partly wrong):** (a) `request.auth.verifyPassword` genuinely had NO responder → messaging's GDPR `anonymizeMyData` was broken end-to-end → RESOLVED as **ORPHAN-HIGH-337** (this initiative). (b) `request.farm.getTankRegistry` DOES have a live responder in farm-service (Faz 3a); messaging just sends the wrong payload key (`{tenantSchema}` vs the required `{tenantId}` UUID) → tracked as **ORPHAN-MEDIUM-336**, not a missing responder.
**Owner:** platform-kernel-expert / infra-expert. **Deadline:** 2026-07-16.

## ORPHAN-HIGH-318 — handleFailedLogin misreads TypeORM UPDATE…RETURNING result shape: audit always records "attempt 0" and the CRITICAL ACCOUNT_LOCKED event never fires — IN-PROGRESS (this PR)

**Discovered:** 2026-07-02, live prod (codex-test lockout investigation — audit payload said `Invalid password (attempt 0)` while `auth.users.failedLoginAttempts` was 6).
**Evidence:** `apps/auth-service/src/modules/authentication/services/authentication.service.ts` `handleFailedLogin()` — `dataSource.query('UPDATE … RETURNING …')` with TypeORM's PostgresQueryRunner returns `[rows, affectedCount]` for UPDATE statements, but the code read `result[0]?.failedLoginAttempts` (the ROWS ARRAY, not the first row) → `undefined ?? 0`. Consequences, both confirmed live: (1) every LOGIN_FAILED_INVALID_PASSWORD audit event logged `attempt 0`; (2) `isNowLocked` required `updatedAttempts >= maxFailedAttempts` → `0 >= 5` always false, so the `ACCOUNT_LOCKED` AuditLogSeverity.CRITICAL event and its operator-visible `logger.warn` NEVER fired (2026-07-02's two live lockouts produced zero ACCOUNT_LOCKED events). The DB-side lock itself worked — the SQL is correct; only the return-value read was wrong.
**Root cause:** untyped raw-query result — a hand-written `Array<{…}>` annotation asserted the wrong driver shape; the type system cannot catch a wrong `as`-shaped annotation on `any`-returning `query()`.
**Remediation (this PR):** new runtime-asserted reader `updateReturningRows<T>()` in `libs/backend-common/src/database/update-returning.util.ts` (throws loudly on any non-`[rows, affected]` shape — a raw UPDATE…RETURNING result can no longer be misread silently), `handleFailedLogin` rewired through it, unit tests pin the attempt count AND the CRITICAL ACCOUNT_LOCKED emission on the threshold-crossing attempt, and the spec's dataSource mock now mirrors the REAL driver tuple (the old mock had encoded the same wrong shape as the bug). Ships together with the ORPHAN-HIGH-308 fix (audit INSERT policy) so the restored events actually persist.
**Owner:** auth-security-expert. **Deadline:** 2026-07-24.

## ORPHAN-MEDIUM-319 — real client IP never reaches auth-service: gateway forwards no client-IP header and the resolver prefers the socket peer, so every audit row and users.lastLoginIp record the gateway container IP — IN-PROGRESS (this PR)

**Discovered:** 2026-07-02, live prod (codex-test lockout investigation — every LOGIN_* audit payload and `users.lastLoginIp` showed `::ffff:172.18.0.25`, the gateway container; the actual actors — a Windows/Chrome browser at 193.212.164.37 and a curl client at 104.248.134.38 — were only recoverable from nginx access logs by timestamp correlation).
**Evidence:** `apps/gateway-api/src/federation/authenticated-data-source.ts` `willSendRequest()` forwarded authorization/cookie/x-tenant-id/correlation/trace headers but no client-IP header; `apps/auth-service/src/modules/authentication/resolvers/auth.resolver.ts` computed `request.ip || x-forwarded-for` — the socket peer (always the gateway) won even if a forwarded header had been present. The subgraph-side `user-agent` header is likewise the gateway's internal fetcher (minipass-fetch), not the browser's.
**Root cause:** the client network identity was never made part of the gateway→subgraph contract; the resolver's fallback ordering hid the omission instead of failing loudly.
**Remediation (this PR):** two trust tiers, chosen to require NO change to the fixed 14-field v2 signing canonical (whose byte-layout is pinned by the R1 Rust coprocessor golden vectors): (1) authenticated requests carry `clientIp`/`clientUserAgent` INSIDE the gateway assertion — integrity-protected by `X-Service-Assertion-Hash` exactly like assignedSiteIds/planLevel; (2) EVERY forwarded request (pre-auth login/refresh included) carries gateway-minted `x-client-ip`/`x-client-user-agent` headers — the gateway sets them itself (overwrite semantics on the federation path; inbound copies are in BLOCKED_FORWARDED_HEADERS on the REST-proxy path), and `StripInternalHeadersMiddleware` deletes them from any request lacking a verified service identity, so an external sender can never plant them. New SSoT reader `resolveClientNetworkContext()` (`@aquaculture/backend-common/http`) applies the precedence signed-assertion → gateway-gated-header → direct socket, and all four auth resolver sites (login, acceptInvitation, forgotPassword, resetPassword) consume it — audit rows and lastLoginIp now record the true actor. Pinned by unit specs on the helper, the assertion middleware round-trip/fail-closed validation, and the gateway data-source (header minted pre-auth; claim bound into the assertion when authenticated).
**Owner:** auth-security-expert + platform-kernel-expert. **Deadline:** 2026-07-31.

## ORPHAN-MEDIUM-320 — account lockout is invisible to the legitimate account owner: generic "Authentication failed" during the lock window, no lockout notification, no operator unlock surface — IN-PROGRESS (this PR)

**Discovered:** 2026-07-02, live prod — the operator spent the morning unable to log in as a tenant-admin test account with the CORRECT password (verified: peppered bcrypt compare matches; the same credentials succeed end-to-end once unlocked) because earlier wrong-password submissions from a browser had tripped the 5-attempt/30-minute lock, and every subsequent correct-password attempt returned the same generic `GENERIC_AUTH_ERROR_MSG` as a wrong password. The only remediation was raw SQL against auth.users.
**Root cause:** the anti-enumeration posture was applied without a compensating legitimate-owner channel — the design conflated "don't tell the ATTACKER" with "don't tell ANYONE".
**Remediation (this PR — the wire response deliberately stays generic):**
1. **Owner notification:** new `UserAccountLockedEvent` contract (no PII; audit-log-backed → best-effort path, allowlisted) emitted on the threshold-crossing attempt; notification-service consumes it cross-tenant and emails the owner (address resolved at delivery time via the authenticated internal PII endpoint, CRITICAL-001/002 discipline): unlock instant + "wasn't you → reset your password" guidance. NATS publish grant `events.*.UserAccountLocked` added (canonical scheme; full grant migration is ORPHAN-HIGH-317).
2. **Operator unlock surface:** `unlockTenantUser` mutation (`@TenantAdminOrHigher`) → `TenantAdminService.unlockUser` — tenant-scoped, clears `failedLoginAttempts`/`lockedUntil`, audit-logs `USER_UNLOCKED` (who/whom/previous lock). TENANT_ADMIN targets deliberately allowed: lockout is an availability incident and a locked admin cannot unlock themselves. `users.lockedUntil` exposed to GraphQL; tenant-admin user management shows a "Locked" badge and a one-click Unlock action.
3. **Reset clears lock:** verified pre-existing — `resetPassword` already zeroes `failedLoginAttempts`/`lockedUntil`; the notification email points owners at that self-service path.
**Depends on:** ORPHAN-HIGH-318 (this PR stacks on it — the lock-trigger hook only fires once the RETURNING misread is fixed).
**Owner:** auth-security-expert + admin-expert. **Deadline:** 2026-07-31.

## ORPHAN-MEDIUM-324 — 24 audit/outbox infrastructure tables carry forced tenant RLS contrary to the installer's own excludeTables design intent — RESOLVED (audit-ledger side, this PR; outbox side #841)

**Discovered:** 2026-07-02 (RLS census during the ORPHAN-HIGH-308/318 fix): `pg_class` shows FORCED `tenant_isolation_policy` RLS on every service's outbox (`billing_outbox`, `farm_outbox`, `farm.outbox_events`, `hr_outbox`, `messaging_outbox`, `notification_outbox`, `sensor_outbox`, `hydroponics_outbox`, `ai_outbox`, `alert_outbox`) and audit ledger (`auth.audit_logs`, `farm.farm_audit_logs`, `farm.tenant_erasure_audit`, `alert.alert_audit_log`, `hr.payroll_audit`, `messaging.compliance_audit_log`, `sensor.sensor_audit_logs`, `sensor.vfd_parameter_audit_logs`, `sensor.audit_archive_v1`, `ai.tool_execution_audit`, `shared.audit_logs`, …) — 24 tables.
**Root cause:** `applyTenantRlsToSchema` (libs/backend-common) explicitly documents that outbox and audit-log tables belong in `excludeTables` ("deliberately cross-tenant infrastructure tables"), but the per-service RLS migrations never excluded them. These tables ARE the `MODULE_SCHEMAS[].infrastructureTables` cross-tenant set (ADR-011) — tenant-scoped RLS on them breaks their system access paths fail-closed and silently.
**Why it matters:** two confirmed production outages from this one class: the auth security-audit trail (ORPHAN-HIGH-308, fixed for auth.audit_logs) and the farm outbox dispatcher (ORPHAN-HIGH-321 — worker sees zero rows, domain events never leave the service; the same worker code serves EVERY service's outbox, so all 10 outbox tables are presumptively dead). The remaining audit ledgers need per-service write/read-path verification: any writer without tenant GUC (cron, system, pre-auth) is silently dropping rows today.
**How to fix (architectural):** per class, not per table — outbox tables: worker-side audited bypass (ORPHAN-HIGH-321); audit ledgers: additive INSERT-only `WITH CHECK (true)` policy (the ORPHAN-HIGH-308 pattern) via each owning service's migration, after verifying each ledger's writer contexts; then extend the schema-invariants suite so a table listed in `MODULE_SCHEMAS[].infrastructureTables` with tenant-RLS-without-system-path fails CI (make the class detectable).
**Owner:** platform-kernel-expert. **Deadline:** 2026-08-07.
**Resolution (2026-07-07, this PR) — SSoT-driven infrastructure-ledger RLS architecture:**
The root cause is categorical: cross-tenant append-only AUDIT LEDGERS (in `infrastructureTables` by design) were swept into `tenant_isolation_policy` by the authoritative db-migrate installer, which passed NO `excludeTables` (the SSoT bridge `getRlsExcludeTablesForService` was only wired into the runtime bootstrap, which is fail-fast-disabled in prod). A cross-tenant table can never satisfy a per-tenant predicate from a no-tenant-context writer, so every system/pre-auth/NULL-tenant/webhook INSERT was silently RLS-denied (auth = ORPHAN-HIGH-308; the confirmed AT-RISK set: `alert.alert_audit_log`, `hr.payroll_audit` [rolled back the whole payroll txn], `sensor.sensor_audit_logs`, `ai.tool_execution_audit`, `shared.audit_logs` [billing Stripe webhook]).
Fixed with ONE canonical policy, SSoT-driven, applied by the authoritative installer so it self-heals every deploy — NOT six hand-copied write-side bypass patches:
- **SSoT**: `INFRASTRUCTURE_AUDIT_LEDGERS` (`libs/backend-common/src/database/rls/infrastructure-ledger.ssot.ts`) — the cross-tenant append-only ledgers per schema, coupled by `tests/invariants/infrastructure-ledger-ssot.spec.ts` to `PROTECTED_TABLES` (immutability) + `MODULE_SCHEMAS[].infrastructureTables` (cross-tenant), with a `/audit/`-name DRIFT CATCH so a new ledger cannot ship without the policy.
- **Canonical helper**: `applyInfrastructureLedgerRls` — ENABLE+FORCE RLS, DROP `tenant_isolation_policy` + the prior `audit_append_system`, CREATE `infra_ledger_append` (INSERT WITH CHECK true) + `infra_ledger_read` (SELECT USING `bypass OR no-tenant-context OR tenantCol=GUC` — system writes incl. `INSERT … RETURNING` land, tenant reads keep defense-in-depth), and NO update/delete policy (immutable, RLS + trigger). db-migrate-authority-gated, idempotent.
- **Wiring**: db-migrate `runSchemaPostMigrationHardening` derives the ledgers from the SSoT (`getInfrastructureAuditLedgers`) and runs the pass AFTER the tenant sweep (which now excludes them) for every hardened schema (auth/farm/hr/alert/ai/sensor); `shared.audit_logs` (platform-bootstrap Phase 0, raw SQL) gets a byte-identical policy in `006-shared-schema-tables.sql`.
- **Closed a real gap surfaced by the invariant**: `sensor.sensor_audit_logs` ships an immutability trigger naming "protected-tables-guard" but was never in `PROTECTED_TABLES` — added.
- **NOT touched (documented)**: `admin.audit_logs` (never had tenant_isolation_policy — append trigger + REVOKE only; admin writes bypass via AdminBypassRlsInterceptor); per-tenant audit tables (`messaging.compliance_audit_log`, `sensor.vfd_parameter_audit_logs`, `sensor.audit_archive_v1` — fan-out cloned, schema-isolated, correctly tenant-RLS'd); outbox/inbox/DLQ (ORPHAN-HIGH-321 worker bypass).
- **Now-redundant (follow-up)**: auth's #845 write-side `set_config('app.bypass_rls')` in AuditLogService is superseded by `infra_ledger_read` (which permits the RETURNING re-read). Left in place as harmless defense-in-depth to avoid deploy-ordering coupling; can be simplified once the policy has deployed. Tracked as ORPHAN-LOW-337b.
Validation: helper unit spec 5/5 (exact DDL + authority guard), SSoT invariant 6/6, platform-bootstrap integration updated to assert `shared.audit_logs` carries the infra pair and NOT `tenant_isolation_policy`. Live droplet verification after deploy.

## ORPHAN-MEDIUM-325 — the advertised NATS SSoT CI invariant never ran in any workflow AND was 16/18 red against the artifacts it was meant to pin — RESOLVED (this PR)

**Discovered:** 2026-07-02 (wiring check during ORPHAN-HIGH-317). **Renumbered from the originally-assigned ORPHAN-MEDIUM-323 during merge-train collision resolution** — main independently claimed that id for the unrelated ARIA authority-hash finding (see above); PR #837's commit trailer still cites the original id, this heading is the authoritative record.
**Evidence:** `nats-invariants` appears in ZERO `.github/workflows/*` files and no package.json script; running it on main yields 16/18 failures — its user-entry regex expects `user: <name>` while the generator has emitted `user: "CN=<name>"` since ADR-015, and its cert-CN extraction expects a literal `for svc in <names>` list while `generate-internal-certs.sh` long ago switched to deriving `$SERVICE_NAMES` from services.yaml. CLAUDE.md cites this spec as "CI invariant … runs every PR" — the classic Potemkin-SSoT anti-pattern (built, advertised, unwired) documented by the 2026-06-23 SSoT audit.
**Remediation (this PR):** spec rewritten against the real artifact formats, extended with the publish-coverage/RPC-coverage/shape checks that would have caught ORPHAN-HIGH-317 years early, and wired into CI via `.github/workflows/nats-invariants.yml` (pull_request + main push, generator-idempotency gate included). services.schema.json now structurally rejects the legacy prefix, so the ban does not depend on the spec alone.
**Owner:** infra-expert. **Deadline:** closed by this PR's merge.

## ORPHAN-MEDIUM-326 — migration-runner and security-event sinks build non-canonical subjects that NatsEventBus.normalizeSubject rejects; observability's consumers listen on `events.`-prefixed variants nothing could ever emit — IN-PROGRESS (this PR)

**Discovered:** 2026-07-02 (grants rewrite for ORPHAN-HIGH-317 — the observability subscribe grants name subjects no publisher could produce).
**Evidence:** `SCHEMA_MIGRATION_SUBJECT_PREFIX` was `platform.schema-migration` and `SecurityEventService` published to the bare `SecurityEventType` enum value (`security.events.<...>`) — `NatsEventBus.normalizeSubject` THROWS for any subject outside `events.`/`commands.`/`queries.`, both sinks swallow the error as best-effort, and the JetStream stream only captures the canonical spaces. Meanwhile observability-service consumes `events.platform.schema-migration.>` and `events.security.events.>` — built to receive what nothing could send. The security consumer's comment even claimed normalizeSubject "will prepend events. if necessary" — it never prepends.
**Renumbered from the originally-assigned ORPHAN-MEDIUM-322 during merge-train collision resolution** — main independently claimed that id for an unrelated aquamobil finding; PR #842's commit trailer still cites the original id, this heading is the authoritative record.
**Root cause:** two shared-lib publishers written against a pre-normalization subject convention; the consumer side written against the canonical one; no contract test spanning the pair.
**Remediation (this PR):** `SCHEMA_MIGRATION_SUBJECT_PREFIX` → `events.platform.schema-migration` (and the observability consumer now DERIVES its subscribe subject + getEventType label from that same constant — publisher and consumer structurally cannot drift); `SecurityEventService` forms the wire subject as `events.${enumValue}` at the publish boundary (enum values stay the semantic identifiers carried in payloads/metrics); the misleading consumer comment corrected. Contract pins: sink spec asserts all four `events.platform.schema-migration.*` subjects, the prefix-pin spec asserts the canonical value, and a new `security-event-subject-contract.spec.ts` asserts the wire subject and that every enum value maps inside the consumer wildcard space. Publish grants for both spaces were provisioned platform-wide by ORPHAN-HIGH-317 (PR #837), so this lands against a ready broker. Pre-existing lint errors in the touched sink spec (import order, require-await, non-null assertions) fixed in passing.
**Owner:** platform-kernel-expert. **Deadline:** 2026-07-24.

## ORPHAN-HIGH-327 — main deploy pipeline blocked since #830: alert-engine __tests__ support mocks leak into the app tsconfig and fail release-verification — IN-PROGRESS (this PR)

**Discovered:** 2026-07-02 during the event-backbone merge train: every `ci-affected` run on main since 8d1b342ed (#830) fails at `deploy-production / release-verification`, so NO merged commit has deployed to the droplet since — including the #837/#838/#839/#841/#842 remediation train.
**Root cause:** #830 committed the previously-untracked jest support mocks under `apps/alert-engine/src/__tests__/support/` (`*.mock.ts` — deliberately not `*.spec.ts`). `tsconfig.app.json` excludes only `*.spec.ts`/`*.test.ts`, so the strict release-verification type-check compiled the mocks WITHOUT jest types → `TS2503/TS2304 Cannot find namespace/name 'jest'`. Silent-severity mismatch: the PR's own CI was green (per-PR jobs don't run release-verification), so the breakage only manifests on main pushes.
**Remediation (this PR):** exclude `src/**/__tests__/**` from the app tsconfig; the spec tsconfig (`types: ["jest","node"]`) keeps the mocks in the strict-tsc test gate. Verified: `tsc --noEmit` clean for both alert-engine tsconfigs.
**Owner:** infra-expert. **Deadline:** 2026-07-09.

---

# Sensor domain enterprise plan (Faz 1–6) — SENSOR-HIGH-001 … SENSOR-HIGH-006

Deep read of the sensor domain (backend + frontend + Rust edge) surfaced six HIGH structural findings, closed across the six-phase enterprise plan on PR #811 (branch `claude/sense-sensor-module-arch-oguq01`). Registry entries carry the authoritative state; this section is the human-readable cross-reference the review-anchor invariant requires. Registry close ceremony runs post-merge.

## SENSOR-HIGH-001 — `program_variables` has no `tenant_id` column (ORPHAN-DIC-001 class) — RESOLVED (Faz 1)
**Evidence:** automation `program_variables` rows were tenant-scoped only transitively through their parent program, so RLS and scoped repositories could not act on variables directly.
**Rule:** per-tenant rows must carry a first-class `tenantId` so isolation is enforceable without joining through the parent.
**Remediation:** blue-green-safe migration (nullable → backfill from parent program → NOT NULL); `ProgramVariable` entity + scoped queries updated. Owner: sensor-expert.

## SENSOR-HIGH-002 — SCADA package serializer data loss + builder/operator tag-binding key mismatch — RESOLVED (Faz 2)
**Evidence:** `toScadaPackageJSON` dropped widget-level `name/visible/zIndex/permissions`; the builder read `config.tagName` while the operator read `config.tagId`, so one widget bound different tags in the two runtimes.
**Rule:** persistence roundtrip must be lossless and one widget must resolve one tag binding in every runtime.
**Remediation:** serializer fix + 54-widget roundtrip spec; single `getWidgetTagBinding` accessor (canonical `tagRef` → legacy keys); `ScadaPackageDocV2` schema + V1→V2 upcaster + save-time validation + upcast-on-read. Owner: sensor-expert.

## SENSOR-HIGH-003 — deploys retain no artifact snapshot; rollback is a label; process deploys unlogged + hardcoded version 1 — RESOLVED (Faz 3)
**Evidence:** rollback flipped a status with nothing to restore; process deploys wrote no log and shipped `version: 1`.
**Rule:** deploy pipeline must be auditable and reversible — every payload retained as an immutable checksummed snapshot; rollback restores a concrete artifact.
**Remediation:** content-addressed `deploy_artifacts` per-tenant table (sha256, append-only, dedupe); all deploy paths snapshot; deploy logs carry `artifact_id` + `checksum`; `rollbackScadaPackageDeploy` republishes a retained artifact. Owner: sensor-expert.

## SENSOR-HIGH-004 — cloud→edge deploy contract unpinned (TS↔Rust drift; SCADA/process shipped unsigned) — RESOLVED (Faz 4)
**Evidence:** no publish-boundary validation; hand-mirrored TS↔Rust shapes drifted (camelCase `fbType/onError/intervalSecs/ptMs/delayMs` silently dropped or parse-failed on the edge); SCADA/process deploys unsigned while ST bytecode required ed25519.
**Rule:** trust-boundary payloads need a canonical machine-enforced contract on both sides + integrity protection matching the platform signing posture.
**Remediation:** canonical JSON Schemas AJV-enforced at every MQTT publish boundary; shared fixtures consumed by both a TS spec and a Rust in-crate test + parity CI script; ed25519 deploy signatures (`deploy_sig.rs`, domain tags `scada-pkg-v1`/`process-v1`, tenant-bound canonical bytes, cross-language pinned vector). Owner: sensor-expert / edge-expert.

## SENSOR-HIGH-005 — unified SCADA+automation deploy is N+1 fire-and-forget MQTT with no atomicity/staging/confirmation — RESOLVED (Faz 5)
**Evidence:** a crash or broker outage mid-sequence left a device half-deployed with no record.
**Rule:** multi-artifact industrial deploys must be transactional end-to-end — transactional dispatch (outbox), edge verify-before-apply staging, atomic apply, operator-visible confirmed/failed lifecycle.
**Remediation:** `release_bundles` per-tenant table + guarded `PENDING→STAGED→CONFIRMED(→ROLLED_BACK)/FAILED` machine; `deployScadaWithAutomation` → bundle builder with signed manifest (ed25519 `bundle-v1`, signature required) committed transactionally with a `DeployBundleRequested` outbox event; edge `cmd_deploy_bundle` pure verify → staged ack → atomic apply → confirmed/failed. Owner: sensor-expert / edge-expert.

## SENSOR-HIGH-006 — two parallel live-data generations + skeleton unified editor — IN-PROGRESS (Faz 6, PR #811)
**Evidence:** the builder preview canvas ran the legacy `/sensors` device-code path while operator/runtime ran the canonical `/scada` tag path; `UnifiedEditorPage` HMI mode was an iframe-overlay skeleton whose layout never persisted and whose Deploy menu was a no-op; the `/scada` gateway accepted any subscribe key un-tenant-scoped.
**Rule:** a product surface must have ONE live-data plane and ONE canvas — builder, operator and unified editor share the registry-gated `/scada` path and the real ScreenCanvas, and the unified shell persists HMI layout + deploys through the canonical dialog.
**Remediation (landed):** tenant-fenced `/scada` subscribe gate (registry-validated TagRefs); builder preview migrated to Layer-B and Layer A deleted (empty guard); unified HMI mounts the real ScreenCanvas with dual-target save + canonical deploy; idempotent V2 backfill; builder⇄operator binding-parity spec.
**Remaining (deferred, gated):** make Unified the default editor after it reaches ProcessEditor feature parity (attachments, data-channel widgets, automation-deploy); delete the flag-gated iframe viewer after one release bake; unify the scada-builder URL; simplify upcast-on-read post-backfill. Owner: sensor-expert. Deadline: 2026-07-22.

# Sensor edge deploy_bundle path review — EDGE-HIGH-007 … EDGE-HIGH-008

Reading the Faz-5 edge `cmd_deploy_bundle` path end-to-end (the command dispatch, RBAC/audit catalog, and the stage→apply loop) surfaced two HIGH findings. Registry entries carry the authoritative state; this section is the human-readable cross-reference the review-anchor invariant requires.

## EDGE-HIGH-007 — `deploy_bundle` had a dispatch arm but no catalog entry, so it lost its RBAC class and audit taxonomy to the fallback — RESOLVED (this PR)
**Evidence:** `cmd_deploy_bundle` is routed by an explicit match arm (`dispatch_lifecycle.rs:317`) so it always executed, but it was absent from `COMMAND_CATALOG`. `permission_for_command` therefore returned the `.unwrap_or(Some(SafeStateTrigger))` fallback (`catalog.rs:889`) and — critically — `audit_action_for_command` returned `None` (`catalog.rs:914`), so a bundle apply produced no `ProgramDeploy` audit record. `SafeStateTrigger` also requires two-person integrity, so the security floor held, but the permission class was wrong for a deploy.
**Rule:** every wire command with a dispatch arm must carry an explicit catalog entry so its permission class, signature legacy-policy and audit taxonomy are declared, not inherited from the fail-safe fallback (dispatch audit SSoT; ADR-018 edge RBAC/ABAC).
**Remediation:** `deploy_bundle` catalog entry mirroring sibling `deploy_scada_package` exactly (`DeployProgram` permission, `ProgramDeploy` audit actions, `DenyUnsignedInEnforcing`); added to `MUTATING_WIRE_NAMES` (keeps the mutating-name invariants green); `deploy_bundle_resolves_like_deploy_scada_package` regression test pins permission + audit + legacy-policy parity with the artifacts the bundle groups. Owner: edge-expert.

## EDGE-HIGH-008 — bundle apply phase is not all-or-nothing on a runtime apply fault — RESOLVED (this PR, Option A rollback)
**Evidence:** the verify/stage phase is genuinely pure (a bad checksum/signature/tenant-binding fails staging and applies nothing — SENSOR-HIGH-005's "broken checksum applies nothing" holds), but once staged the apply loop (`bundle_deploy.rs`) wrote each artifact and, on the first `Err`, returned `{ phase: "failed", stage: "apply", applied* }` WITHOUT restoring the already-applied artifacts (old comment: "instead of pretending atomicity"). SENSOR-HIGH-005 is RESOLVED with a note claiming "atomic apply", so that claim was overstated for the apply-phase-fault case, and the Faz-5 plan's "FAILED → hiçbir şey uygulanmaz" was not met when a fault hit mid-apply.
**Rule:** a release bundle billed as an atomic edge apply must be all-or-nothing — after a mid-apply fault the device is rolled back to its pre-bundle state; honest partial-apply reporting is not atomicity.
**Remediation (Option A — true rollback):** before the apply loop `cmd_deploy_bundle` captures a pre-image of exactly the sinks the bundle touches (program `ProgramState`, process, package — nothing else is read or written); on the first apply `Err` it restores each touched sink to its pre-image in reverse apply order (`deploy_package`/`deploy_process` for a `Some` pre-image, new `ScadaState::clear_package`/`clear_process` for a `None` pre-image i.e. a program-/scada-less device, and `CommandHandler::restore_program_state` re-materialising the prior program's script). It then acks `phase: "rolled_back"` when every restore succeeds (device at exact pre-bundle state, nothing applied net) or `phase: "failed"` (stage `rollback`, offending sinks named) when a restore itself faults and the device is in a mixed state needing operator intervention. `deploy_program_locked` remains self-atomic on its own failure; the pre-images cover the cross-artifact case (earlier artifact applied, later one faulted). The `rolled_back`/`failed` ack decision is a pure `summarize_apply_rollback` helper, unit-pinned. Operates at the same persistence layer as `deploy_program_locked`'s existing rollback-on-persist-failure precedent. Owner: edge-expert.

# Sensor domain review MEDIUM findings — SENSOR-MEDIUM-001 … SENSOR-MEDIUM-002

## SENSOR-MEDIUM-001 — V2 packageData backfill had a lost-update race — RESOLVED (this PR)
**Evidence:** `backfillPackageDocsToV2` did `find({tenantId})` to load every package, then per row upcast and `scadaPackageRepository.save(pkg)`. A user editing a package (`updateScadaPackage` bumps `version` + `save`) in the window between the backfill's read and its write was overwritten by the upcast of the STALE snapshot — a silent lost update during a maintenance run. `ScadaPackage.version` is a manual counter, not a TypeORM `@VersionColumn`, so `save()` is a blind PK update with no concurrency check.
**Rule:** a read-modify-write over rows that can be concurrently edited must be serialized (row lock / optimistic version guard) so a maintenance batch cannot overwrite a user's in-flight edit.
**Remediation:** enumerate ids only, then per-row `scadaPackageRepository.manager.transaction` with `manager.findOne(ScadaPackage, { where:{id,tenantId}, lock:{ mode:'pessimistic_write' } })` — the authoritative read + upcast + save all happen under the row lock, so a concurrent user update either lands before (re-read: already V2 → skip, or still V1 → migrate the user's latest) or is blocked until our txn commits. Mirrors the codebase's existing tenant-safe `manager.transaction` idiom (release-bundle PENDING write). Row deleted between enumeration and lock counts as skipped. New unit tests pin the locked re-read, the concurrent-edit-not-clobbered case, and the deleted-row case. Owner: sensor-expert.

## SENSOR-MEDIUM-002 — `openWidgetConfig` canvas message handled but never emitted — OPEN (tracked)
**Evidence:** both editors handle `case 'openWidgetConfig'` from the iframe and render `WidgetConfigModal` (a deploy-test simulates the message so the receive side is proven), but a grep of all `web/` finds NO `postMessage` that emits `openWidgetConfig` — only the two receive-side handlers. The center canvas is a ReactFlow app loaded via `getCanvasUrl()` into an iframe; the emitter lives in that iframe's source, which is not in `web/` (likely a separate/bundled canvas asset), so the modal is correct-and-ready but unreachable through the real canvas.
**Rule:** a receive-side handler + modal wired for a canvas event is dead unless the canvas actually emits it — wire the emitter or remove the misleading dead surface.
**Resolution (tracked):** either wire the P&ID canvas source to emit `openWidgetConfig` on a widget's config action, or — if that canvas is retired for the real ScreenCanvas HMI path — remove the handler. Owner: sensor-expert. Deadline: 2026-07-22.

## EDGE-MEDIUM-003 — deploy_bundle has no version-monotonicity floor (signed-but-stale replay downgrade) — OPEN (tracked)
**Evidence:** `verify_bundle` (`bundle_deploy.rs`) gates manifest-hash + ed25519 signature + tenant binding + per-artifact checksum + bundleId, but performs NO version check — the manifest carries per-artifact `version` yet the edge never compares it to what is already deployed. Near-term replay is defended by the envelope JTI dedup table (bounded VecDeque, `mod.rs`), so a fresh replay within the window is rejected; but a validly-signed OLDER bundle replayed AFTER its JTI evicts is applied, downgrading the device.
**Rule:** a signed deploy artifact carrying a version must be gated by a monotonic floor (highest-applied ≥ incoming) — signature validity attests authorship, not freshness.
**Resolution (design-laden, tracked):** the same shape `cert_pinning.rs` already documents for cert-pinning manifests ('Cloud-signed manifest version monotonicity', Phase 1.2 defense-in-depth). Needs a persisted highest-applied version floor on the edge (mirror of `RbacManifestStore::version_store`) + a monotonic gate, plus a cloud-side decision on the version authority (bundle-level vs per-artifact). Owner: edge-expert. Deadline: 2026-07-22.

## EDGE-MEDIUM-004 — the Faz-4 deploy-contract parity gate script is wired into no CI workflow — RESOLVED (this PR)
**Evidence:** `tools/scripts/check-sensor-contract-parity.ts` is the Faz-4 gate that fails CI when the shared fixtures diverge between the TS AJV canonical schemas and the Rust serde structs, but a grep of `.github/workflows` + `package.json` + nx targets found it referenced only in nx's internal file-map and the ephemeral changed-files typecheck tsconfigs — NO workflow step ran it. Its sibling `check-codec-drift.ts` IS wired (`rust-ci.yml` drift job). So the plan's Faz-4.2 deliverable ("parity CI job must go red on a deliberate Rust struct change") was dormant.
**Rule:** a gate script authored to fail CI on contract drift must be invoked by a workflow — a gate no job runs is dead assurance.
**Remediation:** added a `sensor deploy-contract parity` step to the `rust-ci.yml` drift job (Rust toolchain + Node 22 already present), invoking the script the identical way as codec-drift. Verified the script passes locally (exit 0, both TS and Rust legs) before wiring, so activation does not red the pipeline. Owner: edge-expert.

## SENSOR-MEDIUM-003 — process-editor canvas crashed on load (missing react/jsx-runtime dep + unpinned CDN versions) — RESOLVED (this PR)
**Evidence:** the P&ID canvas iframe (`process-editor-canvas.html`) crashed with `Cannot read properties of undefined (reading 'jsx')` inside the `@xyflow/react@12.11.0` UMD. The file is byte-identical to main (pre-existing, not introduced by this branch). xyflow's UMD factory reads `t(…, e.jsxRuntime, e.React, e.ReactDOM)` — four declared deps — but the HTML provided only `React` + `ReactDOM` globals, never `jsxRuntime` (react/jsx-runtime); the unpinned `react@18` is why it surfaced now (a patch drifted the UMD).
**Rule:** a hand-managed CDN `<script>` dependency graph must be complete and version-pinned, or it is nondeterministic and silently breaks.
**Remediation (tier-2 root-cause):** pin every CDN version exactly (react/react-dom/react-is 18.3.1, prop-types 15.8.1; xyflow already 12.11.0), and materialise the genuinely-missing `react/jsx-runtime` global from the already-loaded React (`jsx`/`jsxs` = `React.createElement` with the key hoisted out of props — faithful to react/jsx-runtime's production contract, not a behavioural shim), plus a loud guard that throws a clear message if the graph is ever incomplete again. Unverifiable in the headless env (no browser, proxy blocks unpkg) — requires in-browser confirmation. Owner: sensor-expert.

## SENSOR-MEDIUM-004 — process-editor canvas hand-managed its dep graph via CDN scripts instead of a build — RESOLVED (this PR, supersedes the SENSOR-MEDIUM-003 CDN patch)
**Evidence:** `process-editor-canvas.html` was a ~1300-line hand-authored HTML whose React app loaded all deps via ordered CDN `<script>` tags with no build-time resolution; it also shipped `cdn.tailwindcss.com` in production and ran the iframe `sandbox=allow-scripts allow-same-origin`. A deep investigation (headless-Chromium repro + build-artifact diff) proved the actual "still broken after the tier-2 fix" cause was a STALE `dist/` artifact: the CDN html lived in `public/`, copied to `dist/` only by a build, and no build had run after the tier-2 edit — so `/remotes/sensor-module/process-editor-canvas.html` served the pre-fix file. The `public/`↔`dist/` copy split + CDN graph is the structural flaw.
**Rule:** a shipped React app's dependency graph must be resolved + pinned at build time by the bundler, not hand-ordered CDN scripts — build-time resolution makes it complete-by-construction, deterministic, offline-capable, and CSP-clean, and eliminates the stale hand-copied artifact.
**Remediation (tier-1, verified):** the inline app moved to a bundled Vite entry (`canvas/main.jsx` + `canvas.css`, entry `process-editor-canvas.html`) that imports React 19, `@xyflow/react`, `recharts`, and `@aquaculture/node-components` from `node_modules` — NO CDN, no jsx-runtime shim, no hand-managed globals; a missing dep is now a BUILD error, not a runtime crash. Built by `vite.canvas.config.ts` (relative base → dev+prod-symmetric asset URLs) into `public/` (gitignored, regenerated), run before both `vite build` and `vite` (dev) via the `package.json` scripts and gated by a `@aquaculture/node-components:build` `dependsOn` — so the served canvas can never be a stale hand-copied file. Verified in headless Chromium against the real `nx build` dist: the ReactFlow canvas renders (`.react-flow` present, `#root` populated) with **0 external/CDN requests** and no errors; `nx build sensor-module` emits both `remoteEntry.js` (MF intact) and the bundled canvas. Owner: sensor-expert.
**Remaining sibling (tracked under this ID):** `scada-viewer-canvas.html` (the legacy flag-gated `ScadaViewer`) has the same CDN-UMD pattern; convert it the same way or delete it when the `VITE_SENSOR_LEGACY_SCADA_VIEWER` retirement flag is removed.

## SENSOR-MEDIUM-005 — host↔canvas iframe boundary had no contract SSoT — RESOLVED (this PR)
**Evidence:** THREE hand-rolled `getCanvasUrl()` copies (`UnifiedEditorPage.tsx:579`, `ProcessEditorPage.tsx:389`, `ScadaViewer.tsx:32`) — two carrying a dead `localhost:3006` port sniff that matched no real dev port (module dev is 3005, shell 3000), so the "dev" branch never executed and all real traffic used the prod path anyway (the module's Vite `base` is `/remotes/sensor-module/` in BOTH dev and prod) — plus FOURTEEN stringly-typed `'process-editor-host'`/`'process-editor-canvas'` postMessage literals across six files on both sides of the wire. Renaming any one silently broke the ready/setNodes handshake.
**Rule:** a cross-boundary wire contract (URLs + message envelope source tags) must have a single machine-enforced source of truth consumed by both sides.
**Remediation:** `src/canvas-contract.ts` is now the one contract SSoT (`CANVAS_SOURCE`/`HOST_SOURCE`, `SENSOR_MODULE_BASE`-derived canonical URLs, `CanvasMessageEnvelope`), imported by BOTH worlds — the TS host side (UnifiedEditorPage, ProcessEditorPage, ScreenManager, processStore, ScadaViewer) and the bundled canvas app (`canvas/main.jsx`) through the same Vite build. Enforced by `src/__tests__/canvas-contract.spec.ts` (URL constants pinned to the actual `vite.config.ts` base; zero protocol literals or hand-rolled URL builders outside the contract; canvas app free of window-global dep reads and CDN hosts; entry HTML a pure module entry; build+dev scripts run the canvas pre-build) and by `assert-canvas-artifact.mjs`, a post-build gate that makes a dist without a bundled CDN-free canvas unproducible through the build target CI and the Docker image consume (closing the stale-dist class at the pipeline level). Wire behavior re-verified in headless Chromium after the swap: ready handshake, setNodes round-trip, node render, nodesChange feedback — zero errors, zero external requests. Owner: sensor-expert.

## Not investigated / dropped this cycle
- **Bundle apply order** (candidate): NOT a defect — the cloud builder pushes program refs before the package ref (`scada-package.service.ts:919-959`) and the edge applies in manifest order, so programs-before-package holds by design (documented "enforced by manifest order + edge apply"). No independent edge re-sort is needed given the rollback (EDGE-HIGH-008) makes any order safe on failure. Dropped.

## ORPHAN-HIGH-328 — INFRA-CRITICAL-029 registry-closeout PR (#713) left one of 217 state flips unapplied: its own closing evidence only satisfies the sibling-trailer pattern, not the automated reachability/trailer check

**Discovered:** 2026-07-02, reconciling PR #713 (`chore/registry-closeout-schema-drift`) onto main's registry, which had grown from 517 to 587 entries (70 new findings from unrelated work) while the PR sat open. 216 of the branch's 217 RESOLVED state flips were re-validated against current `origin/main` using `tools/gates/finding-registry.ts`'s own `commitReachableFrom` + `commitHasFindingCloseTrailer` helpers and re-applied cleanly (see `chore(registry): rebase the 216-finding closeout onto main's current 587-entry chain`). `INFRA-CRITICAL-029` is the 1 exception.
**Evidence:** `INFRA-CRITICAL-029` is an umbrella finding ("hr AND admin-api schema-drift"); no merged commit's message carries a `Closes:` trailer naming it directly — the fix landed as two child findings instead (`INFRA-CRITICAL-031` via `5df001792`, hr; `INFRA-CRITICAL-032` via `39cbfaeff`, admin-api). The branch's own diff to `tests/invariants/three-store-invariants.spec.ts` already carries a `LEGACY_TRAILER_DRIFT` allowlist entry for this exact sibling-trailer shape (identical precedent to the existing `RUST-CVE-001` entry in that same list) — but applying it requires deliberately hand-mutating the registry outside the CLI's own validation path, which this reconciliation pass declined to self-authorize without a dedicated review.
**Why it matters:** `INFRA-CRITICAL-029` remains OPEN in the registry and in `docs/plans/2026-06-18-enterprise-grade-debt-closure/finding-truth-table.md` even though both of its functional halves are independently resolved and merged — the registry currently understates true closure by exactly 1 CRITICAL.
**How to fix (architectural):** land the `LEGACY_TRAILER_DRIFT` addition (`['INFRA-CRITICAL-029', '5df001792']` + `['INFRA-CRITICAL-029', '39cbfaeff']`) to `tests/invariants/three-store-invariants.spec.ts` in its own reviewed commit, then hand-mutate the registry entry to `RESOLVED` with `closing_commits: ['5df001792', '39cbfaeff']`, rechain, and verify — the same mechanism already used for `RUST-CVE-001`. A generalized fix would let `finding-registry.ts close` accept an explicit `--via-sibling <child-id>` flag that checks the CHILD's trailer instead of the parent's, making this class of closure a first-class CLI path instead of a hand-mutation escape hatch.
**Owner:** data-expert. **Deadline:** 2026-07-16.

## ORPHAN-MEDIUM-329 — Fable credit exhaustion silently stalls the autonomous loop; no automatic fallback to a separate-pool tier — IN-PROGRESS
Operatör 2026-07-03: Fable 5 kredisi tükendi. Fable birincil tier kalırsa gece cron'u her dispatch'te yetersiz-kredi hatası alır ve bu EXTERNAL_OUTAGE requeue yoluna gider (aynı boş havuzu N kez dener) — döngü sessizce durur. Kredi-tükenmesi refusal gibi *deterministik + havuz-özel*: yalnız farklı tier'ın havuzu çözer. **Remediation (same PR):** `claude_runtime.extract_credit_exhaustion` (detection-only, `extract_refusal` kardeşi; `returncode!=0` + konservatif `CREDIT_EXHAUSTION_MARKERS` SSoT, transient sinyaller — overloaded/429/network — hariç) + `ClaudeRunResult.credit_exhaustion` alanı; `ci_executor` + `worker_executor` refusal dalının yanına kredi-fallback dalı — tek denetimli fable→opus retry @ xhigh ("ultra code") effort (opus ayrı kredi havuzu), governance-audited (`model_credit_fallback_attempted` eşleşen marker'ı taşır → operatör seti üretimden ayarlar), opus'ta fail-closed (guard `model=="fable"`), refusal ile paylaşılan tek-retry bütçesi (`_fell_back_to_opus`). Fable birincil kalır; frontmatter/default/invariant pinleri değişmez. Takip: circuit-breaker (N ardışık kredi-fallback sonrası effektif default'u opus'a çevir) ayrı izlenir.

## ORPHAN-HIGH-330 — credit-fallback detection missed the real CLI usage-limit message; loop stalled on live Fable exhaustion — IN-PROGRESS
Canlı kanıt (manuel cycle 28647813607, 2026-07-03): ARIA'nın managed Fable havuzu **tükendi**; challenger dispatch'i **"You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."** mesajını **exit 0'da temiz-tamamlandı içeriği** olarak döndürdü (0 token, terminal_reason=completed) → aşağı akışta reddedildi (doğrulanamaz kanıt), kredi-fallback'e YÖNLENDİRİLMEDİ. #849 detection iki şekilde kaçırdı: (a) marker'lar API sözcüklerini (credit balance/insufficient/quota) varsaydı ama gerçek mesaj usage-credits/reached-your-limit/switch-models; (b) `returncode!=0` gate'i exit-0'da gelen mesajı atladı. **Remediation (same PR):** `extract_credit_exhaustion` artık TÜM cevap metnini (stderr + final_message + assistant blokları + result event) tarıyor ve `USAGE_LIMIT_MARKERS` (usage-credits, switch models with /model) + reached-your-…-limit birlikte-oluşumunu `returncode`'dan BAĞIMSIZ eşliyor; API-hata marker'ları returncode!=0-gate'li kalıyor (temiz koşuda "billing" bahsine false-positive yok). Ayrıca fable→opus fallback'i `claude_runtime.run_with_model_fallback` SSoT helper'ına DRY'lanıp **davranışsal** test süitiyle (fable+kredi→opus@xhigh, tek-retry bütçesi, opus-primary-fallback-yok, kredi-önceliği) kaynak-pinleri değiştirildi. Bu, #849 kredi-fallback'inin gerçek failure-mode'da fiilen ateşlenmesini sağlar.

## ORPHAN-HIGH-331 — convergence envelopes carry no target_sha; evidence-validator rejects every real ref (worktree_candidate) — IN-PROGRESS
Canlı katman-4 blokör'ü (ORPHAN-312 düzeltilir düzeltilmez ortaya çıktı, cycle 28656402488): challenger doğru şekilde `web/modules/hr-module/src/pages/leaves/LeavesPage.tsx:346` gösterdi (gerçek kod, 437 satırlık dosya, geçerli satır) ama evidence-validator yine reddetti — `evidence_ref_not_repo_verified:...:worktree_candidate`. KÖK: `evidence_trust.classify_evidence_ref` bir ref'i ancak içerik-hash'i **çözülmüş bir target_sha**'daki git blob'uyla eşleşince `repo_verified` notlar; challenger request `target_sha=None` taşıyordu (envelope mint'leri hiç set etmiyordu), `_resolve_target_sha` None döndü, her gerçek dosya `worktree_candidate`'e düştü, `require_repo_verified` reddetti. Bu, kanıt ne kadar doğru olursa olsun convergence'ı **yapısal olarak imkânsız** kılıyordu. **Remediation (same PR):** convergence drainer workspace HEAD sha'sını bir kez çözüyor (`_resolve_workspace_head_sha`) ve `target_sha`'yı 4 envelope mint'ine threadliyor (challenger/primary/cross_review/completeness_critic; `create_agent_invocation_request`'in target_sha alanı zaten vardı, hiç doldurulmuyordu). Davranışsal kanıt: target_sha=HEAD → repo_verified; None → worktree_candidate.

## ORPHAN-HIGH-332 — re-dispatched planner request refuses to overwrite its prior on-disk output (cross_review requeue-loop → human_required) — IN-PROGRESS
Canlı katman-6 blokör'ü (cycle 28659464267, ORPHAN-331 sonrası evidence-gate'i GEÇEN ilk cycle): cross-reviewer'ın İLK dispatch'i geçerli bir cross_review üretti (opus, challenger revizyonunu onaylayan doğru verdict) ama poll timeout requeue etti. Re-dispatch'te opus (Read tools + expected output path söylenmiş) önceki attempt'in `status:submitted` envelope'unu diskte buldu ve repo'nun "look before you write / don't overwrite existing work" disiplinine uyarak yeniden üretmeyi REDDETTİ — `agent_text`: "The expected output file already exists on disk ... the work is already done and submitted", cross_review JSON'unu top-level obje yerine prose içine gömdü → `plan_content_invalid:cross_review:absent_or_not_object` → requeue (count 3) → `agent_human_required`, cycle max_cycles'te takıldı. **Fix (same PR):** `invoke_claude_cli` her dispatch'ten önce stale output+transcript'i temizliyor (`_clear_stale_dispatch_artifacts`) → her attempt taze schema-geçerli envelope yazıyor; worker lane `worker-result` ile submit ediyor, etkilenmiyor. **İKİNCİL (izlenen, bu PR'da değil):** 300s `--challenger-timeout-seconds` default'u kredi→opus fallback altında (opus yavaş) sıkışık; canlı doğrulama valid-ama-geç sonuçların hâlâ requeue olduğunu gösterirse eşleşen cycle-deadline/job-timeout ile büyüt.

## ORPHAN-LOW-333 — sensor-temperature projection opens a per-event tenant transaction platform-wide — OPEN
`SensorTemperatureProjectionListener` subscribes to `events.*.SensorReading` across all tenants and, per temperature-bearing reading, runs a full `runInTenantTransaction` (connection + BEGIN + upsert + COMMIT) to refresh one cache row. Bounded today by temperature-probe reporting frequency; a large frequently-reporting fleet would generate sustained farm-service write/transaction load solely for cache refresh. Remediation when load materializes: per-sensor coalescing/debounce (≥1/min) or a single autocommit upsert (statement is already idempotent newest-wins). Owner: farm-expert. Found by 2026-07-05 final-sweep audit (FARM-LOW-003).

## ORPHAN-LOW-334 — NATS payload tenantId is not bound to the delivery subject's tenant token — OPEN
Wildcard consumers (`FarmStockProjectionListener`, `SensorTemperatureProjectionListener`) route writes off `event.tenantId` (payload) without asserting it equals the `events.{tenantId}.*` subject segment; `isValidUUID` proves format, not provenance. Only reachable via a compromised/buggy AUTHENTICATED publisher (NATS is mTLS cert-is-identity), hence LOW. Proper fix needs the event-bus handler interface to expose the delivery subject (platform/libs/event-bus change) so consumers can assert subject↔payload equality — aligns with the gateway→subgraph HMAC tenant-binding principle. Owner: platform-kernel-expert. Found by 2026-07-05 security sweep (GSEC-LOW-004).

## ORPHAN-LOW-335 — recordManualTemperature does not verify tankId belongs to the tenant — OPEN
A bogus/foreign tankId creates an orphan measurement INSIDE the caller's own tenant (write carries JWT tenantId on the tenant-pinned connection; reads filter tenantId+tankId — no cross-tenant impact, confirmed). Data-quality gap only. Remediation: resolve tankId via the tank lookup used by the full create() path and reject unknown ids. Owner: farm-expert. Found by 2026-07-05 security sweep (GSEC-LOW-005).

## ORPHAN-MEDIUM-336 — request.farm.getTankRegistry responder is tenantId-keyed, but KnowledgeExtractionService still calls it with tenantSchema — RESOLVED (this PR)
Faz 3a built the `request.farm.getTankRegistry` responder (`apps/farm-service/src/tank/responders/get-tank-registry.responder.ts`) tenantId(UUID)-keyed, using the fully-sanctioned RLS-safe `runInTenantRead`. The ai-service `get_farm_tanks` read tool calls it correctly (ctx.tenantId). But messaging-service `KnowledgeExtractionService.fetchTankRegistry` (`apps/messaging-service/src/ai/services/knowledge-extraction.service.ts:352`) still sends `{tenantSchema}` — a lossy `tenant_<16hex>` it cannot map back to a tenantId (it iterates `listTenantSchemas`, which returns schema strings; the tenant record lives cross-service in `auth.tenants`). The responder validates the payload and returns [] for a non-UUID, so knowledge-extraction degrades exactly as before (it was already non-functional — no responder existed) — this change does NOT regress it, but it does NOT yet enable it either. **Proper fix (Faz 3 focused effort):** add a `runInTenantReadBySchema(dataSource, sourceSchema, tenantSchema, fn)` helper to `libs/backend-common/src/database` — build on `validateTenantSchemaName` (schema-manager.service.ts:841) + a validated `search_path` pin + the RLS session context — so schema-iterating callers (knowledge-extraction, and the AI tool via ctx.schemaName) share ONE read path; then point both consumers at it. This touches the tenant-isolation-guarded surface (farm-service-tenant-isolation.spec, tenant-transaction) so it warrants dedicated review. Owner: platform-kernel-expert + data-expert. Found while building Faz 3a farm read tools 2026-07-06.
**Resolution (2026-07-07, this PR):** the prescribed `runInTenantReadBySchema` bypass primitive turned out to be unnecessary AND weaker than the existing path — `KnowledgeExtractionService` already has the AUTHORITATIVE tenant UUID in hand: every message row it sweeps carries `Message.tenantId` (MSG-HIGH-010, NOT NULL), and all rows in a pinned `tenant_<uuid>` schema share it. So the sweep now selects `m."tenantId"` and passes that canonical UUID to `fetchTankRegistry`, feeding the responder's UNCHANGED, fully fail-closed `runInTenantRead` (which ASSERTS the RLS GUC == tenantId). This is strictly stronger than a schema-keyed bypass read (which would trade the GUC assertion for schema-boundary-only isolation) and adds no speculative isolation surface — the responder stays tenantId-keyed by design (the UUID is the canonical tenant key; a `tenant_<16hex>` name lossily truncates it). A defensive guard skips the fetch if a swept schema somehow yields a null tenantId (data-integrity break). Pinned by a new payload-shape test (`knowledge-extraction.tank-registry.spec.ts`) + the existing responder contract spec.


## ORPHAN-HIGH-337 — GDPR self-service anonymization was broken end-to-end: request.auth.verifyPassword had no responder — RESOLVED (this PR)

**Discovered:** 2026-07-07 (NATS RPC-responder audit of the event-backbone remediation follow-ups).
**Evidence:** messaging's `GdprService.verifyPassword` (`apps/messaging-service/src/gdpr/gdpr.service.ts`) issues `natsClient.send('request.auth.verifyPassword', {userId, password})` as the FIRST step of `anonymizeMyData` (the GraphQL mutation `message.resolver.ts` exposes to users, rate-limited caller-side). No `@MessagePattern('request.auth.verifyPassword')` existed anywhere in auth-service (or any service) — `git log -S` shows the subject literal was only ever added on the messaging side; the responder was written speculatively and never built. Consequently every `anonymizeMyData` call timed out at the password-confirmation step and threw `BadRequestException('Unable to verify password…')` — the Article-17 self-erasure right was unusable in production.
**Root cause:** a cross-service credential-confirmation contract with a caller but no responder. Not dead code (the caller gates an irreversible action correctly) and not a wrong subject (no existing auth subject verifies a current password — the `request.auth.user.*` surface is deliberately no-credential/no-PII).
**Remediation (this PR):** implemented the responder in auth-service (the credential SSoT):
- SSoT contract `AUTH_CREDENTIAL_SUBJECTS.VERIFY_PASSWORD` + `VerifyPasswordQuery` + AJV trust-boundary schema in `@platform/event-contracts` (replaces the messaging-local hardcoded literal + interface).
- `AuthCredentialNatsHandler` responder: AJV validation → per-user Redis sliding-window rate limit (defence-in-depth vs a compromised caller) → `AuthenticationService.confirmUserPassword` → security audit → **bare boolean** reply. Errors/rate-limit surface as an `RpcException` so the caller fails CLOSED (blocks the erasure), never a `false` indistinguishable from a wrong password. Bare-boolean reply is also the rollout-safety lock (the existing caller does `send<boolean>` + `result === true`; a result OBJECT would make `!!obj` true for a wrong password during any deploy skew).
- `confirmUserPassword` is a RE-confirmation, not a login: timing-equalized (dummy-hash verify + min-duration → no user enumeration), lazily migrates a legacy hash on match, and does NOT touch `failedLoginAttempts`/`lockedUntil` (locking an account on a mistyped GDPR confirmation would turn a data-subject right into a self-DoS).
- messaging caller repointed to the SSoT constant + typed query.
**No-oracle controls:** NATS cert-CN (only messaging can publish) + AJV shape gate + per-user rate limit + timing-safe verify + boolean-only reply + no lockout mutation.
**Validation:** responder spec 9/9 (match/no-match, fail-closed on malformed/rate-limit/internal, TTL window, Redis-absent degrade), `confirmUserPassword` service spec 3/3 (no-lockout + enumeration-safe), messaging gdpr spec 9/9 unchanged. Grants already present (messaging publish + auth `request.auth.>` subscribe, #837).
**Owner:** auth-security-expert. **Deadline:** closed by this PR's merge.
## ORPHAN-LOW-337b — auth AuditLogService write-side RLS bypass is now redundant given the infra-ledger policy — OPEN (intentional — owner+deadline+ID tracked)

Once ORPHAN-MEDIUM-324's `infra_ledger_read` policy is deployed on `auth.audit_logs`, the transaction-scoped `SELECT set_config('app.bypass_rls','on',true)` that `apps/auth-service/src/audit/audit-log.service.ts` runs before a standalone audit write (added by #845 to make `INSERT … RETURNING` pass under the old `tenant_isolation_policy`) is no longer load-bearing — the policy itself now permits the RETURNING re-read from any context. It is left in place ON PURPOSE as harmless defense-in-depth: removing it in the same change would couple correctness to db-migrate-runs-before-auth-boot deploy ordering. Simplify it (drop the bypass, keep the manager-passed path) in a follow-up once the policy has been live for one deploy cycle. **Owner:** auth-security-expert. **Deadline:** 2026-08-14.

## ORPHAN-HIGH-338 — No owned end-to-end audit coverage for the durable data surface (column provenance, dead/orphan/duplicate schema, FE↔BE reachability) — RESOLVED (this PR)

**Discovered:** 2026-07-11 (operator-requested platform-wide database audit planning).
**Evidence:** No agent lane owned exhaustive column-level coverage of the ~359 `@Entity` classes (334 under `apps/`, 25 under `libs/`). Lane-B `schema-surface-parity-auditor` samples product↔schema parity but does not produce per-column provenance (which code writes each column, from what source class), does not reconcile every service against `MODULE_SCHEMAS` (`libs/backend-common/src/database/schema-manager.service.ts`) — leaving the recorded gaps unswept: `billing` registered in neither the tenant-scoped nor platform-level set, several services with entities absent from the registry entirely, and the `@Entity()`-without-`schema:` violations recorded in `tests/invariants/_constants.ts` — and does not cover the uncontracted admin-panel REST boundary (hand-written types in `web/modules/admin-panel/src/services/types/*.ts`, no OpenAPI codegen) or the codegen-unvalidated module GraphQL operations (root `codegen.ts`).
**Root cause:** audit ownership was organized around product behavior (Lane-B) and code diffs (Lane-A); no lane owned the durable data surface itself as a first-class audit object.
**Remediation (this PR):** Lane-D `db-audit` — 8 partition auditors under `.claude/agents/db-audit/` + method SSoT `.claude/agents/_shared/db-audit-methodology.md` (compact provenance matrix, trace recipes, incidental-findings mandate, report contract), `DB-{AREA}-*` finding prefixes registered in `.claude/shared/output-format.md`, lane bound to the 200-line agent cap in `tests/invariants/agent-size-limit.spec.ts`. Audit partition runs write to `docs/reviews/db-audit/**`; defects they surface enter the registry through the remediation workstream that closes them.
**Owner:** operator session (Lane-D dispatch) + `data-expert`/`database-reviewer` as Lane-A primaries for resulting fixes. **Deadline:** the coverage gap itself closes with this PR's merge; audit execution is the operator plan's next tracked phase.

## ORPHAN-CRITICAL-339 — SCADA alarm/history persistence had no tenant isolation (cross-tenant leak) — RESOLVED (this PR)

**Discovered:** 2026-07-11 (Lane-D db-audit, `db-audit-sensor` partition — DB-SENSOR-CRITICAL-001, `docs/reviews/db-audit/db-audit-sensor/2026-07-11-sensor-industrial.md`).
**Evidence:** `apps/sensor-service/src/database/migrations/1800200000000-CreateScadaAlarmStorage.ts` created `sensor.scada_alarms` and `sensor.scada_alarm_chronicle` in the shared `sensor` schema with NO `tenant_id`. `apps/sensor-service/src/scada-runtime/services/alarm-storage.service.ts` read them with unfiltered `SELECT * FROM scada_alarms` / `SELECT … FROM scada_alarm_chronicle` (`getActiveAlarms`, `getAlarmHistory`), so any tenant's operator would read every tenant's SCADA alarms and history. `DaqStorageService.addValues`/`queryValues` wrote/read `scada_tag_history` with no tenant column either, and no migration ever created that table (SENSOR-HIGH-004 — same root defect). Latent-not-live: the alarm engine is a process-wide singleton whose `setTenantId`/`setAlarmRules` are never called, so it runs unbound (`tenantId='default'`, `rules=[]`) and these tables are empty in practice — the structure guaranteed the leak the moment the subsystem is activated.
**Root cause:** the SCADA runtime was ported from single-project FUXA without a tenant dimension; its persistence is written by singleton services with no per-request `search_path`, so a per-tenant schema clone (the usual ADR-011 route) can never receive their rows.
**Remediation (this PR, Tier-1 make-it-impossible):** `1806000000000-ScadaTenantIsolation` adds a mandatory `tenant_id` discriminator to `scada_alarms` + `scada_alarm_chronicle` (tenant-leading indexes) and creates `scada_tag_history` with `(tenant_id, tag_id, timestamp)` as PK — closing SENSOR-HIGH-004 in the same change. The three tables are registered as cross-tenant infrastructure in `MODULE_SCHEMAS['sensor'].infrastructureTables` (like `edge_device_directory`). `AlarmStorageService` and `DaqStorageService` now take a required `tenantId` on every read/write, stamp it on inserts, fence every query with `WHERE tenant_id = $n`, and **fail closed** (`assertTenant` throws) on an empty tenant. `AlarmEngineService` and `ScriptEngineService` start UNBOUND: `setTenantId` validates a real tenant, `requireTenant()` gates every persist/broadcast, `evaluateTick` no-ops while unbound, and the hardcoded `'default'` broadcast bucket is removed. Pinned by `apps/sensor-service/src/scada-runtime/__tests__/scada-storage-tenant-isolation.spec.ts` (16 tests: tenant stamped/fenced on every path + fail-closed on empty tenant).
**Validation:** new spec 16/16; sensor scada-runtime suite 23/23; sensor-service type-check clean; full `tests/invariants` suite 1858/1858.
**Owner:** sensor-expert. **Deadline:** closed by this PR's merge. **Follow-on:** [[ORPHAN-HIGH-340]].

## ORPHAN-HIGH-340 — SCADA runtime engine is a process-wide singleton, not genuinely multi-tenant — OPEN (owner+deadline+ID tracked)

**Discovered:** 2026-07-11 (surfaced while closing ORPHAN-CRITICAL-339).
**Evidence:** `AlarmEngineService` (`apps/sensor-service/src/scada-runtime/services/alarm-engine.service.ts`) is an `@Injectable()` singleton with ONE 1 Hz eval loop, ONE `rules` set, and ONE bound `tenantId`; `ScriptEngineService` likewise binds a single tenant. After ORPHAN-CRITICAL-339 the persistence layer is tenant-safe and fail-closed, so no data can cross tenants — but the engine can only be *activated* for one tenant per process at a time. Serving multiple concurrent tenants from one sensor-service process would require the second tenant's activation to overwrite the first's `setTenantId`/`setAlarmRules`.
**Root cause:** the FUXA-derived single-project runtime shape was never converted to the platform's multi-tenant model (per-tenant engine instances or tenant-routed evaluation).
**Why deferred:** genuinely multi-tenant SCADA evaluation is a subsystem redesign well beyond the CRITICAL leak fix; the storage layer is now safe-by-construction and the engine fails closed rather than defaulting to a shared tenant, so there is no correctness/security risk in the interim — only a single-active-tenant activation limitation. **Owner:** sensor-expert. **Deadline:** 2026-09-30.

## ORPHAN-HIGH-341 — admin-api DebugToolsController had no PlatformAdminGuard (unguarded super-admin debug surface) — RESOLVED (this PR)

**Discovered:** 2026-07-11 (surfaced while closing ORPHAN-HIGH-342 — the debug-tools controller spec was failing because the guard it asserts was absent).
**Evidence:** `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts` `@Controller('debug')` carried NO `@UseGuards(PlatformAdminGuard)`, unlike its sibling `ImpersonationController` (`impersonation.controller.ts:273`). Every `/debug/*` endpoint — debug dashboard, impersonation debug sessions, the query inspector that echoes captured SQL, cache inspection — was reachable by any caller the global pipeline admitted. The controller's own spec (`controllers/__tests__/debug-tools.controller.spec.ts`) asserts class-level `PlatformAdminGuard` and that a denying guard yields 403/401; those 13 assertions were failing (guard absent → 200).
**Root cause:** the guard decorator was never applied to this controller (regression/omission); the passing sibling proves the intended contract.
**Remediation (this PR):** added `@UseGuards(PlatformAdminGuard)` to `DebugToolsController`, matching `ImpersonationController`. The 13 pre-existing failing guard-metadata tests now pass.
**Validation:** admin-api impersonation suite 120/120 (was 13 failing).
**Owner:** admin-expert. **Deadline:** closed by this PR's merge.

## ORPHAN-HIGH-342 — impersonation GET endpoints serialized session/impersonation tokens — RESOLVED (this PR)

**Discovered:** 2026-07-11 (Lane-D db-audit, `db-audit-platform-admin` partition — DB-ADMIN-HIGH-002, `docs/reviews/db-audit/db-audit-platform-admin/2026-07-11-platform-admin-notification.md`).
**Evidence:** `ImpersonationSession` stores `originalSessionToken` (plaintext, `entities/impersonation-session.entity.ts:101`) and `impersonationToken` (credential hash, `:104`). `ImpersonationService.getSession`/`getActiveSessions`/`querySessions` returned the raw entity and `getAuditSummary.recentSessions` embedded raw entities, so `GET /impersonation/sessions/:id`, `/sessions`, `/sessions/active`, `/audit/summary` all serialized both secrets. The start response (`startImpersonation`) additionally echoed the stored plaintext `originalSessionToken` via `{...saved}`.
**Root cause:** read paths returned the persistence entity directly with no response projection; admin-api registers no global `ClassSerializerInterceptor`, so `@Exclude()` would be inert.
**Remediation (this PR, Tier-1/2):** added `IMPERSONATION_SESSION_SECRET_FIELDS` (SSoT) + `SafeImpersonationSession` type + `toSafeImpersonationSession()` mapper in the entity file; every read path (`getSession`, `getActiveSessions`, `querySessions`, `getAuditSummary.recentSessions`) now returns the safe view, so a token can never leave the service on a read. The start path returns the safe view plus ONLY the raw impersonation token (revealed once to the initiator), never the stored plaintext session token. Pinned by `services/__tests__/impersonation.service.token-redaction.spec.ts`.
**Validation:** token-redaction spec 4/4; admin-api impersonation suite 120/120; admin-api type-check clean.
**Owner:** admin-expert. **Deadline:** closed by this PR's merge.

## ORPHAN-HIGH-343 — VFD runtime control commands had no durable audit record — RESOLVED (this PR)

**Discovered:** 2026-07-11 (Lane-D db-audit, `db-audit-sensor` partition — DB-SENSOR-HIGH-003).
**Evidence:** `apps/sensor-service/src/vfd/services/vfd-command.service.ts` `executeCommand` (START/STOP/SET_FREQUENCY/EMERGENCY_STOP/…) fired `adapter.writeControlWord`/`writeSpeedReference` and returned a result; the only trace was `logger.log`. No INSERT — an actuator command against industrial equipment left no durable who/when/what/result, a forensic + IEC 62443 gap. A parameter-programming audit (`vfd_parameter_audit_logs`) existed but NOT for runtime commands (which do not mutate the `vfd_devices` row, so `@Auditable()` row-CRUD does not see them).
**Root cause:** the runtime command path was never given an audit ledger, unlike the parameter path.
**Remediation (this PR):** new immutable cross-tenant `vfd_command_audit_logs` audit ledger (`entities/vfd-command-audit-log.entity.ts` declares `schema:'sensor'` + `1807000000000-CreateVfdCommandAuditLog`, registered in `MODULE_SCHEMAS['sensor'].infrastructureTables` — one table discriminated by `tenant_id`, the platform convention for audit ledgers, enforced by entity-schema-declaration + tenant-fanout-entity-parity invariants). `executeCommand` now takes a `VfdCommandActor` and writes an audit row (who/email/command/value/success/error/latency/source) on success AND failure; the write is best-effort (`recordCommandAudit` never throws) so an audit-store outage can never block an actuator command — critically EMERGENCY_STOP. The 7 command mutations capture `@CurrentUser`, and a `vfdCommandAuditLog(vfdDeviceId)` query surfaces the trail (parity — not write-only). Pinned by `services/__tests__/vfd-command.audit.spec.ts` (5/5).
**Follow-on:** the SCADA operator TAG_WRITE surface is tracked separately — [[ORPHAN-HIGH-344]].
**Owner:** sensor-expert. **Deadline:** closed by this PR's merge.

## ORPHAN-HIGH-344 — SCADA operator tag-writes still have no durable command audit — OPEN (owner+deadline+ID tracked)

**Discovered:** 2026-07-11 (second surface of DB-SENSOR-HIGH-003).
**Evidence:** `apps/sensor-service/src/scada-runtime/scada-runtime.gateway.ts:384-433` — the operator `TAG_WRITE` handler is role-checked then calls `tagManager.writeTagValue(...)` with only a `logger.debug`; no durable command record. Unlike the VFD command service (ORPHAN-HIGH-343), the SCADA gateway is a WebSocket gateway with no persistence layer wired in.
**Why deferred:** giving the SCADA gateway a durable command audit needs a persistence dependency added to the (currently DB-less, and dormant — see ORPHAN-HIGH-340) SCADA runtime; it is a distinct wiring change from the VFD command audit and lands cleanest alongside the SCADA runtime multi-tenant activation work. The VFD path — the live actuator surface — is fully closed. **Owner:** sensor-expert. **Deadline:** 2026-09-30.

## ORPHAN-MEDIUM-345 — vfd-command.service.spec asserts throw where the service returns a failure result (stale test drift) — OPEN

**Discovered:** 2026-07-11 (while adding the VFD command audit; these 9 failures are PRE-EXISTING — confirmed by a baseline run with the audit change stashed: 9 failed / 10 passed both before and after).
**Evidence:** `apps/sensor-service/src/vfd/services/__tests__/vfd-command.service.spec.ts` — 9 tests (e.g. "should handle connection error", "should reject SET_FREQUENCY without value", "should throw if device is not connected") assert `.rejects.toThrow()`, but `executeCommand` intentionally CATCHES and RETURNS a `{ success: false, error }` result (the resolver forwards it to GraphQL). The tests are stale against the service's actual return-failure contract.
**Root cause:** the spec was written against an earlier throw-based contract; the service moved to returning failure results without updating the spec.
**Why not fixed here:** deciding throw-vs-return is a VFD command API-contract question unrelated to the audit feature; folding it into a security fix would conflate concerns. **Owner:** sensor-expert. **Deadline:** 2026-08-31.

## ORPHAN-MEDIUM-346 — ai-service tool_execution_audit swallowed write failures for actuation tools (fail-open) — RESOLVED (this PR)

**Discovered:** 2026-07-11 (Lane-D db-audit, `db-audit-people-messaging` partition — DB-PEOPLE-MEDIUM-003).
**Evidence:** `apps/ai-service/src/audit/audit.service.ts:38-43` — `logToolExecution` wrapped `auditRepo.save` in a try/catch that logged and SWALLOWED any storage failure. `ToolExecutorService.executeTool` audits every branch (`tool-executor.service.ts`), but under a DB/grant error on the cross-tenant `ai.tool_execution_audit` table an autonomous actuation tool (e.g. dosing, which runs under an 'allowed' policy) executed with NO durable audit row, silently — the rows are safety-load-bearing.
**Root cause:** a single best-effort audit path used for both read-only and actuation-class tools.
**Remediation (this PR):** `logToolExecution` gains a `strict` flag — read-only tools stay best-effort (swallow, never break the chat flow); actuation-class tools (`metadata.requiresConfirmation`) pass `strict=true` so the write re-throws. `ToolExecutorService` writes the actuation audit strictly and, on failure, SURFACES the gap (`ToolResult.auditFailed=true` + CRITICAL log) rather than swallowing it. It surfaces-and-continues rather than refusing post-hoc: the actuation has already run, so a false failure would risk a double-actuation (and refusing to dose when the audit DB is down could itself cause a water-quality incident). Pinned by `tool-executor.service.spec` (auditFailed surfaced; read-only stays best-effort) + `audit.service.strict.spec` (swallow vs re-throw).
**Follow-on:** a hard Tier-1 durability guarantee (audit row in the same transaction/outbox as the tool effect) remains the ideal — tracked with the AI cost-ledger gap (DB-PEOPLE-MEDIUM-002).
**Owner:** ai-safety-auditor. **Deadline:** closed by this PR's merge.

## ORPHAN-MEDIUM-348 — hr employee contact PII exposed to the broad MODULE_USER role with no object-level scoping — RESOLVED (this PR)

**Discovered:** 2026-07-11 (Lane-D db-audit, `db-audit-people-messaging` partition — DB-PEOPLE-MEDIUM-001).
**Evidence:** `Employee.contactInfo` (email/phone/emergencyContact/emergencyPhone) and `Employee.address` (full home address) are `@Field`-exposed (`entities/employee.entity.ts:207-213`) on the `employee(id)`/`employees`/`employeesByDepartment`/`activeEmployees` queries, all gated to `TENANT_ADMIN, MODULE_MANAGER, MODULE_USER` (`hr.resolver.ts`). The lowest role (MODULE_USER) could fetch ANY employee by id and read every colleague's home address, personal phone, and emergency contacts, unmasked. (The truly sensitive columns — nationalId/bankDetails AES-256-GCM + `@HideField`, dateOfBirth/baseSalary `@HideField` — were already protected, which is why this is MEDIUM not CRITICAL.)
**Root cause:** role-gate only, no object-level (self/manager) authz or field-level masking on the PII columns.
**Remediation (this PR):** the four employee read resolvers now take `@CurrentUser` and mask `contactInfo`/`address` for viewers who are neither a workforce manager (TENANT_ADMIN/MODULE_MANAGER) nor the subject themselves — a redacted directory projection keeps the work email (already public via the top-level `email` field) and name/department but redacts personal + emergency phone and the full home address. Pinned by `hr.resolver.employee-pii.spec` (5/5: admin/manager/self see full PII; other MODULE_USER redacted; list masking).
**Follow-on:** [[ORPHAN-MEDIUM-347]] — direct-supervisor visibility for a MODULE_USER line manager.
**Owner:** hr-expert + multi-tenant-saas-expert. **Deadline:** closed by this PR's merge.

## ORPHAN-MEDIUM-347 — MODULE_USER line managers cannot see their direct reports' contact PII (over-masking refinement) — OPEN (owner+deadline+ID tracked)

**Discovered:** 2026-07-11 (while closing ORPHAN-MEDIUM-348).
**Evidence:** ORPHAN-MEDIUM-348 grants full employee contact PII to {TENANT_ADMIN, MODULE_MANAGER, self}. A line manager who holds only `MODULE_USER` (not `MODULE_MANAGER`) is therefore masked from their own direct reports' contact info even though `Employee.supervisorId` records the reporting line.
**Why deferred:** the supervisor check needs the viewer's own employee id (a by-userId employee lookup that does not exist yet — no `GetEmployeeByUserIdQuery`), so it is a distinct read-model addition rather than a masking tweak. Over-masking is fail-safe (it withholds PII, never leaks it), so there is no security risk in the interim — only a usability gap for MODULE_USER supervisors. Fix: add the by-userId lookup + a `supervisorId === viewerEmployee.id` branch (and an optional HR-staff resource-permission capability) to `canViewEmployeeContactPii`. **Owner:** hr-expert. **Deadline:** 2026-09-15.

## ORPHAN-HIGH-349 — every tenant-erasure target except farm lacked the NATS publish grant for its own proof events (GDPR-cascade broken at the broker) — RESOLVED (this PR)

**Discovered:** 2026-07-11, while scoping the config-service NATS onboarding for DB-INFRA-HIGH-003 (Lane-D db-audit) — a systemic pre-existing bug the audit itself did not surface.
**Evidence:** the shared `TenantErasureTargetExecutor` (`libs/backend-common/src/compliance/tenant-erasure/`) enqueues `TenantDataErased`/`TenantDataErasureFailed`/`TenantErasureBlocked` proof events to the target service's outbox; the per-service `OutboxWorker` publishes them via that service's OWN `IEventBus.publish()` (own mTLS cert). In `infrastructure/nats/services.yaml`, ONLY `farm_service` carried `events.*.TenantDataErased`/`…ErasureFailed`/`…ErasureBlocked` publish grants (farm builds those literals in its own `src`, so the `nats-invariants` publish-coverage scan — which reads per-app `src` only — flagged just farm). All 9 `TenantErasureTargetModule.forService(...)` targets — sensor, hr, messaging, ai, billing, notification, hydroponics, alert-engine, and admin-api (via the shared `gateway_service` cert) — had NO such grant. Under NATS `verify_and_map`, their outbox workers' proof publishes would be rejected (Permissions Violation), so a tenant erasure could never confirm completion for those services — a live GDPR-erasure-cascade break platform-wide (the ORPHAN-HIGH-317 failure class, one layer down).
**Root cause:** the publish-coverage invariant scans each app's own `src` for `eventType` literals; events emitted by a shared lib the app wires via `forService` are a blind spot.
**Remediation (this PR):** added the 3 proof-event publish grants to all 9 target services in `services.yaml` (additive — widens each existing cert's ACL, cannot narrow any) and regenerated `infrastructure/docker/nats/nats.conf` via `scripts/nats/generate-nats-conf.py`. Closed the invariant blind spot with a new `nats-invariants` guard that keys off the `TenantErasureTargetModule.forService` wiring (not app-src literals) and asserts each target grants all 3 proof events — 10 new assertions, all green (they would have failed pre-fix). No new cert minted; no service onboarded.
**Validation:** `nats-invariants` 64/64 (was 54 + 10 new); `generate-nats-conf.py` clean (13 services).
**Owner:** platform-kernel-expert / multi-tenant-saas-expert. **Deadline:** closed by this PR's merge.

## ORPHAN-HIGH-350 — config-service persisted per-tenant config with no GDPR erasure cascade (DB-INFRA-HIGH-003, config half) — RESOLVED (this PR)

**Discovered:** 2026-07-11 (Lane-D db-audit, `db-audit-ops-infra` — DB-INFRA-HIGH-003).
**Evidence:** `config-service` registered only `SchemaDriftModule`; `configurations.tenantId` (and `configuration_history`) persisted after tenant deletion with no `TenantErased` consumer — config-service was not connected to the NATS event backbone at all (no cert in `infrastructure/nats/services.yaml`, no EventBusModule, no outbox).
**Root cause:** config-service was never onboarded to the erasure cascade; doing so is not a module toggle — it required onboarding the service to the event backbone.
**Remediation (this PR, full platform pattern — mirrors billing):** onboarded config-service as a platform-level (`source-schema-tenant-column`) tenant-erasure target. (1) NATS: added `config_service` to `services.yaml` (JetStream pull-consumer base grants + the 3 proof-event publish grants) + regenerated `nats.conf`; (2) `EventBusModule` + `RedisModule` + a `ConfigOutboxModule` (`config_outbox` entity/table) + `TenantErasureTargetModule.forService('config-service')` wired into `app.module`; (3) migrations `CreateConfigOutbox` + `EnsureConfigTenantErasureProofLedger`; (4) registered in `MODULE_SCHEMAS['config']` + `PLATFORM_LEVEL_MODULES`, the erasure registry, the `TenantErasureTargetService` union (now 11), and the `tenant-erasure-ssot` invariant's proof-ledger list; (5) `APP_TO_SERVICE['config-service']` flipped from null → `config_service` in `nats-invariants`. On `TenantErasureRequested`, the executor now deletes config rows by tenantId + writes a proof.
**Validation:** full `tests/invariants` suite 1858/1858; `nats-invariants` 66/66; `tenant-erasure-ssot` 18/18; config-service + event-contracts type-check clean; migration SQL-lint clean (2 files).
**Follow-on:** the event-store half of DB-INFRA-HIGH-003 (crypto-shred for the immutable `stored_events` payload + onboarding its deletable tables) remains — see `docs/plans/2026-07-11-infra-high-003-gdpr-erasure-cascade.md` Part B.
**Owner:** multi-tenant-saas-expert / data-expert. **Deadline:** closed by this PR's merge (config half).

## ORPHAN-HIGH-351 — event-store-service persisted per-tenant projection data with no GDPR erasure (DB-INFRA-HIGH-003, event-store deletable-tables half) — RESOLVED (this PR)

**Discovered:** 2026-07-11 (Lane-D db-audit, `db-audit-ops-infra` — DB-INFRA-HIGH-003).
**Evidence:** `event-store-service` registered only `SchemaDriftModule`; `event_streams`, `snapshots`, `projection_rebuilds` (and `stored_events`) carry raw `tenantId` and survived tenant deletion — no `TenantErased` consumer, not connected to NATS.
**Root cause:** never onboarded to the erasure cascade (same class as ORPHAN-HIGH-350).
**Remediation (this PR — mirrors the config-service onboarding):** onboarded event-store-service as a platform-level (`source-schema-tenant-column`) tenant-erasure target — NATS `event_store_service` identity + regenerated `nats.conf`; `EventBusModule` + `RedisModule` + `EventStoreOutboxModule` (`event_store_outbox`) + `TenantErasureTargetModule.forService('event-store-service')` in `app.module`; migrations `CreateEventStoreOutbox` + `EnsureEventStoreTenantErasureProofLedger`; registered in `MODULE_SCHEMAS['event_store']` + `PLATFORM_LEVEL_MODULES`, the erasure registry, the union (now 12), the `tenant-erasure-ssot` invariant, and `APP_TO_SERVICE['event-store-service']`. On `TenantErasureRequested` the executor deletes the tenant-column projection tables and writes a proof.
**Deliberately EXCLUDED — the remaining architectural work:** `stored_events` is an immutable append-only event log; deleting a tenant's rows would break event-sourcing, and its jsonb `payload` can embed PII. It is in the registry `excludedTables`, so it is NOT row-deleted. The GDPR-correct treatment is **crypto-shred** (per-tenant envelope encryption of the payload + key destruction on erasure) — a distinct encryption-at-rest design requiring a STRIDE threat model. Tracked as the last open piece of DB-INFRA-HIGH-003; blueprint Part B (`docs/plans/2026-07-11-infra-high-003-gdpr-erasure-cascade.md`).
**Validation:** full `tests/invariants` 1858/1858; `nats-invariants` 68/68; `tenant-erasure-ssot` 18/18; type-check clean; migration SQL-lint clean.
**Owner:** data-expert / security-architecture. **Deadline:** deletable-tables half closed by this PR's merge; `stored_events` crypto-shred is a tracked follow-on (2026-10-15).

## ORPHAN-HIGH-352 — event-store stored_events crypto-shred: tested core built; live-path wiring gated on review — RESOLVED-CORE (this PR)

**Discovered:** 2026-07-11 (Lane-D db-audit — the immutable-log half of DB-INFRA-HIGH-003; see [[ORPHAN-HIGH-351]]).
**Context:** `stored_events` is an immutable append-only event log whose `payload`/`metadata` jsonb can embed PII; it cannot be row-deleted (breaks event-sourcing). GDPR erasure = crypto-shred (per-tenant key destruction).
**Remediation (this PR — the tested, isolated core + design):**
- Design + STRIDE threat model + staged-rollout/backfill plan: `docs/plans/2026-07-12-event-store-crypto-shred-design.md`.
- `event_store.tenant_payload_keys` key store (entity + `CreateTenantPayloadKeys` migration; registered in `MODULE_SCHEMAS['event_store'].infrastructureTables`) — one KEK-wrapped per-tenant DEK per row.
- `TenantPayloadCryptoService` (envelope encryption; AES-256-GCM matching the platform primitive): `encrypt`/`decrypt`/`shred`/`isShredded`, per-tenant DEKs, fail-closed on a shredded/absent key. Pinned by `tenant-payload-crypto.service.spec` (6/6: roundtrip, cross-tenant isolation, shred→permanently-unrecoverable, idempotent+scoped shred, legacy-plaintext passthrough, fresh-instance refuses a shredded tenant).
- `CryptoShredModule` registered in event-store `app.module` — inert (not called by the live path yet).
**DELIBERATELY NOT DONE (gated on security review — stated per CLAUDE.md):** wiring `encrypt` into `appendToStream`, `decrypt` (+ shredded-tombstone) into the read path, the erasure handler `shred` step, and the one-time backfill of existing plaintext events. Mis-encrypting a live event-sourcing write path corrupts replay irrecoverably, so the core is proven in isolation first; the design doc sequences the reviewed rollout (steps 2–4).
**Validation:** crypto spec 6/6; full `tests/invariants` 1858/1858; type-check + migration SQL-lint clean.
**Owner:** security-architecture / data-expert. **Deadline:** rollout steps 2–4 tracked (2026-10-15).

## ORPHAN-HIGH-353 — tank fish-count read from the stale currentQuantity mirror (5 read paths) instead of the totalQuantity SSoT (DB-FARMPROD-HIGH-001) — RESOLVED read-side (this PR)

**Discovered:** 2026-07-11 (Lane-D db-audit, `db-audit-farm-production` — DB-FARMPROD-HIGH-001). See [[project_batch_lifecycle_ssot]].
**Context:** the tank fish-count is persisted in four places — `tank_batches.totalQuantity` (the SSoT, derived from `batchDetails[]` by the single writer `TankBatchService.applyBatchDelta`), the `tank_batches.currentQuantity` mirror, `tanks.currentCount`, and `equipment.currentCount`. The write side is already single-writer (`applyBatchDelta` derives currentQuantity + currentCount = totalQuantity; guarded by [[farm-count-single-writer.spec]]) and self-heals pre-SSoT rows via `TankCountReconcileService`.
**Evidence (the read side — the actual live bug):** five read paths preferred the `currentQuantity` mirror (`currentQuantity ?? totalQuantity`), so when the mirror lagged the SSoT the operator saw 900 on one surface and 719 on another for the same tank —
- `tank/resolvers/tank.resolver.ts:362` (`batchMetrics.pieces`, mobile),
- `equipment/equipment.resolver.ts:444` (`pieces`, web equipment panel — a second divergence channel),
- `tank/handlers/get-tank-batches.handler.ts:61`,
- `tank/handlers/get-tank-capacity.handler.ts:45`,
- `feeding/services/daily-feeding-execution.service.ts:955` (fed the WRONG count into growth accrual).
**Root cause:** the count mirror is redundant, but readers preferred it over the SSoT; nothing forbade the mirror-preference so it spread to five call sites.
**Remediation (this PR — read-side collapse):** every fish-COUNT read now reads `tankBatch.totalQuantity` directly. New CI guard `tests/invariants/farm-tank-count-ssot.spec.ts` (Tier-3 make-detectable) fails the build if any farm-service read reintroduces `currentQuantity ?? …totalQuantity`, and asserts the writer keeps deriving the count mirrors from the SSoT.
**Deliberate ASYMMETRY (NOT a bug — do not "fix"):** biomass reads keep `currentBiomassKg ?? totalBiomassKg`. Unlike count, `currentBiomassKg` is the growth-tracked live value (`daily-feeding-execution` accrues feeding weight-gain into it) while `totalBiomassKg` is only the batchDetails baseline; collapsing it would drop growth and under-report capacity. The invariant guards this asymmetry so a future cleanup cannot mistake biomass for the count mirror. Biomass-SSoT unification (flow growth into batchDetails) is separately tracked.
**DELIBERATELY NOT DONE (blue-green phased — stated per CLAUDE.md):** the physical drop of the now-write-only `tank_batches.currentQuantity`/`currentBiomassKg` columns. Dropping a still-written column in the same deploy that stops writing it is not blue-green safe (rolling old pods would read/write the missing column). The correct sequence is: (1) this PR — all reads → SSoT + invariant (done); (2) a follow-up after this deploys — stop the mirror writes in `applyBatchDelta` and simplify the reconcile service's stale-mirror heal (now moot); (3) a final migration drops the columns. Also deferred: consolidating the derive-from-SSoT `currentCount` writers in `allocate-to-tank`/`create-batch` (already correct, not drift — noted by [[farm-count-single-writer.spec]]).
**Validation:** `farm-tank-count-ssot` 5/5; `farm-count-single-writer` 3/3; `invariant-reachability` green; zero `currentQuantity ?? …totalQuantity` remain in farm-service.
**Owner:** farm-expert / data-expert. **Deadline:** read-side closed by this PR's merge; the phased column drop (steps 2–3) is a tracked follow-on (2026-10-15).
**STEPS 2–3 RESOLVED (Faz 5, feat/a1-mirror-retirement):** the read-side fix deployed with #939, so the retirement completed — (2) `applyBatchDelta` no longer writes the count mirror (`currentBiomassKg` deliberately still written: growth-tracked live biomass, re-baselined per delta until the biomass unification); `TankCountReconcileService` lost its stale-mirror diagnostics/heal (`mirrorQuantity` removed from the GraphQL row; the zero-delta heal remains for missing batchDetails); (3) migration `1805400000000-DropTankBatchCurrentQuantityMirror` (current_schema-relative fan-out, no data guard — the column is redundant by design and `totalQuantity` is the truth on every environment) drops the column; the `TankBatch.currentQuantity` entity field + GraphQL field removed (BREAKING CHANGE footer on the commit); supergraph re-composed + generated types regenerated. `farm-tank-count-ssot.spec` now asserts the mirror is NEVER written. NOTE: `currentBiomassKg` intentionally survives (the asymmetry guard covers it); its unification into batchDetails growth-flow stays separately tracked.

## ORPHAN-LOW-354 — admin `GlobalConfig` dead undecorated entity class removed (DB P3 dead-code cleanup) — RESOLVED (this PR)

**Discovered:** 2026-07-11 (Lane-D db-audit, `db-audit-platform-admin` synthesis §B — "admin `GlobalConfig` (dead undecorated class)").
**Context:** `apps/admin-api-service/src/system-management/entities/global-config.entity.ts` exported a `GlobalConfig` class carrying `@Column`/`@PrimaryGeneratedColumn`/`@Index` decorators but NO `@Entity()` — so TypeORM never registered it: no table, no repository, no live migration (only the archived `1780000000000-CreateInitialSchema` ever named `global_configs`). The admin-api global-config write surface was already retired in favour of config-service (`GlobalSettingsService.createConfig`/`updateConfig`/`bulkUpdateConfigs`/`updateProvisioningConfig` return 410 Gone; `queryConfigs` returns empty). The class survived only as a phantom return type (`queryConfigs(): { items: GlobalConfig[] }`) plus dead test wiring (a `getRepositoryToken(GlobalConfig)` provider the service never injects).
**Remediation (this PR):** removed the dead `GlobalConfig` class + the unused `ConfigValidation`/`ConfigHistory` interfaces + the now-unused TypeORM imports from the file (kept the live `ConfigCategory`/`ConfigValueType` enums, which `GlobalSettingsController`'s DTO/query surface still types against); retyped `queryConfigs` return as `{ items: never[]; total: number }`; removed the dead `globalConfigRepo` mock + provider from `provisioning-config.spec.ts` and re-pointed its "retired write path touches no repo" assertions at the service's real injected repos.
**NOT DONE (trivial, tracked here):** the file is still named `global-config.entity.ts` although it now holds only enums (no `@Entity`). Renaming to a non-`.entity` name touches four import sites (barrel + service + controller + spec); left as an optional cosmetic follow-up to keep this cleanup minimal-churn. A header comment documents the misnomer.
**Validation:** `provisioning-config.spec` 7/7; admin-api `tsc --noEmit` clean; eslint clean on the three touched files.
**Owner:** admin-expert. **Deadline:** dead class removed this PR; the optional rename is unscheduled (cosmetic).

## ORPHAN-MEDIUM-355 — INFRA-HIGH-002 "drop `alert_incidents`, keep `alert_history`" is a FALSE POSITIVE — corrected, NOT dropped (this PR)

**Discovered:** 2026-07-12 (Lane-D db-audit P3 verification — the CLAUDE.md "look at the target before deleting" gate caught this). Corrects [[docs/reviews/db-audit/2026-07-11-database-e2e-audit-synthesis]] rows A10 + §B.
**Original (incorrect) finding:** INFRA-HIGH-002 classified `alert_incidents` as a no-FE orphan duplicate of `alert_history` and proposed dropping it, collapsing the "fired-alert lifecycle" onto `alert_history`.
**What the code actually shows (verified firsthand):**
- `alert_incidents` (`apps/alert-engine/src/database/entities/alert-incident.entity.ts`, `@Entity('alert_incidents')` + `@ObjectType`) is a rich **incident-lifecycle** model: `IncidentStatus` NEW→ACKNOWLEDGED→INVESTIGATING→RESOLVED→CLOSED/SUPPRESSED, a timeline, assignment, escalation.
- It is **read AND written** by the live pipeline: `alert-evaluation.service.ts:390` `findOne(AlertIncident)` (dedup of an open incident) → `:402/:448/:611` create/update; `escalation-manager.service.ts` injects `Repository<AlertIncident>` and transitions status on escalation. Also written by mortality/water-quality alert services.
- It is **FK-referenced** by the farm domain: `web/modules/farm-module/src/hooks/useHealthEvents.ts` carries `alertIncidentId` on health events (5 sites).
- `alert_history` (`alert/entities/alert-history.entity.ts`, "records triggered alerts for audit and tracking") is a SEPARATE concern: the triggered-alert audit + cooldown log (`@Index(['ruleId','triggeredAt'])` for the cooldown query), and it IS the resolver-exposed one (`alert.resolver.ts`).
- The two are **complementary, not duplicates**. Dropping `alert_incidents` would break incident dedup + escalation and orphan the farm `alertIncidentId` references.
**Correct classification:** `alert_incidents` is a live, internally-consumed model whose only true gap is that its `@ObjectType` is **not exposed by any resolver** — i.e., there is no incident-read GraphQL surface + no incident-management UI. That is a **feature gap** (build the read resolver + FE), NOT a dead-table cleanup. Tracked as such; out of scope for a cleanup pass (needs product direction on the incident-management UX).
**Action this PR:** did NOT drop anything. Annotated the synthesis (A10 + §B) so neither this session's nor a future engineer's "cleanup" acts on the wrong remediation.
**Owner:** alert-engine-expert (incident-read resolver/FE, feature-gap) / data-expert (finding hygiene). **Deadline:** correction landed this PR; the incident-read surface is an unscheduled feature (needs product direction).

## ORPHAN-HIGH-356 — P3 orphan-table verification pass: the remaining "drop these" candidates are NOT safe unilateral drops (verified) (this PR)

**Discovered:** 2026-07-12 (Lane-D db-audit P3 verification — firsthand, per the CLAUDE.md "look at the target before deleting" gate). Verifies the synthesis §B orphan-table list beyond `GlobalConfig` ([[ORPHAN-LOW-354]], dropped) and `alert_incidents` ([[ORPHAN-MEDIUM-355]], false positive). None of the below was dropped; each needs a decision above a cleanup pass.

**1. `shared.access_logs` (IDENT-HIGH-002) — CONFIRMED dead-but-canonical; do NOT drop unilaterally.** A COMPLETE access-logging subsystem exists — `libs/backend-common/src/audit/`: `access-log.entity.ts`, `access-log.service.ts` (`.record`, PII-masked + path-truncated), `access-log.middleware.ts` (fire-and-forget, one row/HTTP request), `access-log.module.ts` — and the table is a **canonical `shared` table** (SHARED_SCHEMA_TABLES, `PROTECTED_TABLES`, created by `db-migrate` platform-bootstrap). BUT it is **never mounted**: no app imports `AccessLogModule`, no `consumer.apply(AccessLogMiddleware)` outside doc comments, no `.record` caller, no reader anywhere. So the table is permanently empty — a FALSE sense of request-level audit coverage (a compliance/forensics gap, hence HIGH). Two resolutions, both needing sign-off: (a) **wire-up** (mount the middleware in the shared bootstrap) — the architecture's evident intent, but per-request DB writes + 90d retention need security/ops sign-off + a rotation job; (b) **drop** the subsystem + table — but a canonical `shared` table drop requires ADR + architectural-arbiter approval + SHARED_SCHEMA_TABLES/`shared-schema-canonical.spec` SSoT surgery (count 5→4). Recommend (a). NOTE the finding's "cited invariant test absent" sub-claim: `shared-schema-canonical.spec.ts:16` comments that access_logs was "added via…" — the referenced justification test does not assert active use.

**2. `farm_documents` (FARMPLAT-HIGH-001) — CONFIRMED orphan DMS; do NOT drop unilaterally.** A full document-management surface — `document/entities/farm-document.entity.ts` + `document/document.module.ts` + migration `1800800000000-CreateFarmDocuments` + MinIO orphan-file cleanup integration (`common/file-cleanup/*`, `scheduler/cron-jobs.service.ts`) — but **no resolver/controller and no FE** reference it; only the file-cleanup cron reads it. So it is a built-but-unwired DMS. Decision (needs product direction): **keep-and-wire** (build the document upload/list API + FE) vs **drop** (remove the DMS + table + cleanup wiring). Not a unilateral cleanup.

**3. config `configurations`/`effectiveConfiguration` engine (INFRA-HIGH-001) — ADJUDICATED: CONFIRMED built-but-unconsumed; needs an architecture decision (do NOT drop unilaterally).** config-service has a full engine — `configuration.entity` + CQRS handlers (create/update/upsert/delete/get) + `configuration.resolver.ts` exposing `@Query effectiveConfiguration` + `@Query effectiveConfigurationsByService` + `@Mutation setConfiguration` + validation. But firsthand call-by-call verification shows the READ surface is called by NOBODY: zero GraphQL operations invoke `effectiveConfiguration`/`effectiveConfigurationsByService` anywhere in `web/**` or `apps/**`. `setConfiguration` appears only in `web/shared-ui`'s GENERATED supergraph types (schema presence, not a real call) — no hand-authored FE operation or service invokes it. The apparent "consumers" from the first pass are all name-matches: admin-api's `tenant-configuration.service` GoneException string ("use config-service effective configuration APIs"), an observability metrics service-name list, a farm `// TODO: source from config-service`, and alert-engine's unrelated local `AssetConfiguration`. So the finding is essentially correct — this is the SAME "built-but-unwired" pattern as `access_logs` ([[ORPHAN-HIGH-357]]) and `farm_documents`: a complete config-as-a-service that no runtime client reads or writes. Resolution is an architecture decision, NOT a cleanup drop: (a) **wire consumers** — make services read effective config from config-service to drive dynamic configuration (config-service's stated purpose), a real feature needing direction on WHICH values go dynamic; or (b) **retire** the engine — major, and it would undo config-service's GDPR erasure onboarding ([[project_infra_ledger_rls_ssot]] era work). No code change this pass.

**4. `feeding_tables` (FARMOPS-MEDIUM-002) — NOT verified this pass.** It sits in the feed-inventory→storage-ledger convergence surface (synthesis A2), which is another session's active untracked WIP; left untouched to avoid collision.

**Action this PR:** verification + documentation only — zero tables dropped (correct in a no-local-DB environment where drop migrations cannot be validated, and where two of the candidates need governance/product sign-off). Turns the audit's unverified "drop these" list into a verified, decision-ready state.
**Owner:** data-expert (finding hygiene) + per-item: auth-security/compliance (access_logs wire-up-vs-drop), farm-expert/product (farm_documents), config-service owner (config engine adjudication). **Deadline:** decisions unscheduled (each needs an owner sign-off); no CLAUDE.md deadline because nothing here is a shippable code change this pass.

## ORPHAN-HIGH-357 — access_logs wired up: activated the dormant access-log subsystem + registered 90d retention (resolves the access_logs half of [[ORPHAN-HIGH-356]]) (this PR)

**Decision:** platform owner chose wire-up over drop for `shared.access_logs` (the architecture's evident intent — a canonical, protected, bootstrapped table with a complete PII-masked writer subsystem that was simply never mounted, leaving a false sense of request-level audit coverage).
**Remediation (this PR):**
- **Mount at the single external ingress (gateway-api):** imported `AccessLogModule.forRoot()`, added `AccessLogEntity` to the gateway's explicit TypeORM `entities` (so `getRepository` resolves on its `search_path='shared'` connection — `gateway_service` already holds shared DML via `006-shared-schema-tables.sql`'s `GRANT … ON ALL TABLES IN SCHEMA shared TO PUBLIC`), and applied `AccessLogMiddleware` in `configure()` right after security headers. One authoritative row per external request — including the 401/403/CSRF/throttle rejections that never reach a subgraph — fire-and-forget so a persistence blip never surfaces into a response.
- **Retention (prevents the newly-active writer from growing unbounded):** registered a `shared.access_logs.90d` policy in admin-api's `AdminApiRetentionBootstrapModule` alongside the existing `shared.audit_logs.7y` — reuses the canonical single `RetentionEnforcementService` daily cron (03:00 UTC), no new cron. 90-day observability horizon, no legal-hold clause (access logs are not SOC 2 evidence).
- **Closed the "cited invariant test absent" gap:** created `tests/invariants/access-log-middleware-mounted.spec.ts` (the exact path `AccessLogModule`/`AccessLogEntity` docstrings had cited but never shipped). It asserts the barrel re-exports the middleware, the gateway imports+lists+applies it, and the access_logs retention policy is registered — so the wiring can never silently regress. Also exported `AccessLogMiddleware` from the middleware barrel.
**Validation:** `access-log-middleware-mounted` 3/3 + `invariant-reachability` green; gateway-api + admin-api `tsc --noEmit` clean. NOTE: repo-wide `eslint` could not be run locally this session — the droplet is under memory pressure from multiple concurrent Claude sessions (system OOM-kills eslint's type-aware pass); the changes are import/export/registration-shape only (no new constructs) and CI lint validates on the PR.
**Remaining under [[ORPHAN-HIGH-356]]:** `farm_documents` (keep-and-wire vs drop — product) and the `config` engine adjudication are still open; `feeding_tables` remains another session's WIP.
**Owner:** auth-security / observability. **Deadline:** wire-up + retention + invariant landed this PR; the retention DELETE runs nightly once deployed.

## ORPHAN-HIGH-358 — hr Payroll subgraph exposes nested earnings/deductions again (resolves the payroll half of DB-PEOPLE-HIGH-001) (this PR)

**Discovered:** 2026-07-11 (Lane-D db-audit, `db-audit-people-messaging` — DB-PEOPLE-HIGH-001). P2 FE-BE contract repair.
**Defect:** `payroll.entity.ts` flattened earnings/deductions into typed columns (`earningsBaseSalary…earningsGrossPay`, `deductionsTax…deductionsTotal` — DB-MEDIUM-004, for type-safety + column aggregation). The entity kept `get earnings()`/`get deductions()` getters returning the legacy `EarningsBreakdown`/`DeductionsBreakdown` shapes — whose docstrings say "GraphQL resolvers can use this to maintain the nested response structure" — but the `@Field` decorator was never added. So the `hr` subgraph `Payroll` type exposed only the flat columns, while hr-module's `PAYROLL_FRAGMENT` (`web/modules/hr-module/src/graphql/fragments.ts:603-618`) selects nested `earnings { baseSalary … grossPay }` / `deductions { tax … totalDeductions }` → gateway validation 400 on all 4 payroll operations (the payroll UI is non-functional against the gateway).
**Fix (BE, minimal, zero FE change):** added `@Field(() => EarningsBreakdown)` / `@Field(() => DeductionsBreakdown)` to the two getters. `EarningsBreakdown`/`DeductionsBreakdown` are already registered `@ObjectType`s whose fields match the FE fragment selections **field-for-field** (verified: baseSalary/overtime/bonus/commission/allowances/grossPay and tax/socialSecurity/healthInsurance/retirement/otherDeductions/totalDeductions). This completes the getters' documented intent; storage stays flat (no DB-MEDIUM-004 regression). The `hr.graphql` SDL is build-generated (not committed), so it regenerates from the decorators.
**Validation:** hr-service `tsc --noEmit` clean. The subgraph now exposes `Payroll.earnings`/`Payroll.deductions` matching the fragment by inspection; no hr FE-BE parity invariant exists to assert it locally (farm has one; hr does not), and a full build+SDL regen could not run in this memory-constrained session — CI composition + gateway validation confirm on the PR. eslint likewise CI-only (droplet OOM).
**REMAINING under DB-PEOPLE-HIGH-001 (NOT this commit):** the performance/goal operations — now addressed for the GOAL fragment in [[ORPHAN-HIGH-359]]; a broader "which of the flagged ops are real" audit of the other performance operations still needs hr-expert judgment.
**Owner:** hr-expert / frontend-expert. **Deadline:** payroll half closed this PR; the performance/goal fragment repair is a tracked follow-on (2026-10-15).

## ORPHAN-HIGH-359 — hr-module GOAL fragment sub-selects keyResults/milestones (resolves the goal-fragment part of DB-PEOPLE-HIGH-001) (this PR)

**Discovered:** 2026-07-11 (Lane-D db-audit, `db-audit-people-messaging` — DB-PEOPLE-HIGH-001, the `PerformanceGoal.keyResults` drift). Continues [[ORPHAN-HIGH-358]].
**Defect:** `Goal.keyResults` is `@Field(() => [KeyResult])` and `Goal.milestones` is `@Field(() => [GoalMilestone])` — object arrays (jsonb-backed) on the `hr` subgraph. hr-module's `GOAL_FRAGMENT` (`web/modules/hr-module/src/graphql/fragments.ts`) selected both as SCALARS (`keyResults`, `milestones` with no sub-selection) → GraphQL "field of object type must have a selection of subfields" validation error, breaking the goal operations against the gateway.
**Fix (FE, mechanical):** replaced the two scalar selections with full sub-selections of every `KeyResult` @ObjectType field (`id, description, targetValue, currentValue, unit, isCompleted`) and `GoalMilestone` field (`id, title, targetDate, completedDate, isCompleted`) — verified field-for-field against the entity `@ObjectType`s. Every other `GOAL_FRAGMENT` field was confirmed a valid `Goal` @Field (id/tenantId/employeeId/employee/title/description/category/priority/status/startDate/targetDate/completedDate/progressPercent/alignedReviewId/parentGoalId/createdAt/updatedAt), so this fully validates the fragment.
**Validation:** by-inspection field match (the fragment is a `gql` template string, so `tsc` is contract-neutral and no hr FE-BE parity invariant exists to assert it locally — same constraint as [[ORPHAN-HIGH-358]]); CI composition + gateway validation confirm on the PR.
**STILL REMAINING under DB-PEOPLE-HIGH-001:** the broader "which of the flagged performance ops are real" audit (the other performance/review operations beyond the GOAL fragment) — needs hr-expert field-by-field judgment; not in scope here.
**Owner:** hr-expert / frontend-expert. **Deadline:** goal fragment closed this PR; the remaining performance-ops audit is a tracked follow-on (2026-10-15).

## ORPHAN-HIGH-360 — admin-panel P2 verification: HIGH-002 already resolved; HIGH-001/003/004/005 need decisions, not clean fixes (this PR)

**Discovered:** 2026-07-12 (Lane-D db-audit P2 verification, `db-audit-platform-admin` DB-ADMIN-HIGH-001..005 — firsthand). Turns the admin-panel REST-drift findings into a verified, decision-ready state.

**DB-ADMIN-HIGH-002 (impersonation GET leaks session tokens) — ALREADY RESOLVED this session; the finding is STALE.** The earlier P0 impersonation safe-view (`impersonation-session.entity.ts` `IMPERSONATION_SESSION_SECRET_FIELDS` + `SafeImpersonationSession` + `toSafeImpersonationSession`) is applied on every read path the finding names — `getSession` (`:952` returns `SafeImpersonationSession`), `querySessions` (`:949`), `getImpersonationStats.recentSessions` (`:1040`), `getActiveSessions` (`:1133`), `getAuditSummary` — so `originalSessionToken`/`impersonationToken` are excluded from all read responses. No further action.

**DB-ADMIN-HIGH-001 (impersonation FE contract mismatch) — CONFIRMED open; needs a contract decision, not a mechanical map.** The read paths return `SafeImpersonationSession` (entity field names: `superAdminId`/`targetTenantId`/`createdAt`/`actionCount`) but the FE types expect `adminId`/`tenantId`/`startedAt`/`actionsPerformed:number`. Mapping is NOT 1:1: the FE also types `sessionToken` and `lastActivityAt`, which have no safe entity source — and `sessionToken` MUST NOT be returned (that is exactly HIGH-002). So the FE contract itself is partly wrong; reconciling it is a decision (rename FE to the safe-entity contract + drop `sessionToken`, or add a real `lastActivityAt` column + a curated DTO), not a blind mapper. Natural extension point: the existing `toSafeImpersonationSession` mapper.

**DB-ADMIN-HIGH-003 (suspension metadata written to transient fields) + HIGH-004 (admin dual-writes auth.tenants) — CONFIRMED; both are the DEFERRED auth.tenants-ownership work (P1-A4).** `tenant.entity.ts:132-140` declares `suspendedAt/suspendedReason/suspendedBy/lastActivityAt` with NO `@Column` (commented "NOT in the database"); `suspend-tenant.handler` assigns them then `save(Tenant)` — TypeORM drops the unmapped props, so they never persist and always read `undefined`. The correct fix adds real columns on `auth.tenants` **routed through auth-service** (auth owns that table — admin's `Tenant` is a read model, and HIGH-004 is the same handler directly `save(Tenant)`-ing into `auth` schema = an SSoT fork) or hydrates from `tenant_activities`. This is precisely the auth/RBAC-adjacent A4 work the platform owner chose to DEFER in this hostile-environment session; not safe to do unilaterally here.

**DB-ADMIN-HIGH-005 (tenant list omits tier/farmCount/sensorCount) — CONFIRMED; the counts introduce an N+1 that needs a design decision.** `tier` is a getter → `this.plan` (trivial to materialize in a list DTO), but `farmCount`/`sensorCount` are NOT columns — `/detail` computes them via `countTenantResource(tenantId, 'farms'|'sensors')`, which runs a per-tenant, per-schema `information_schema` existence check + `SELECT COUNT(*)` (2 queries × 2 resources = 4 queries PER tenant). Applying that to a paginated list is a 4N N+1 (a 50-tenant page ≈ 200 queries). A correct fix needs a batched count (a `tenant_resource_usage` read model updated by events, or one cross-schema aggregate), not a naive per-row loop — a design decision. Materializing `tier` alone is clean but partial (the FE marks all three required), so it does not close the finding on its own.

**Action this PR:** verification + documentation only — corrected the stale HIGH-002, and confirmed HIGH-001/003/004/005 each need a decision or design (contract reconciliation, deferred auth-ownership, batched-count read model) rather than a clean unilateral fix that this memory-constrained session (no local build/eslint) could safely validate. Zero code changed.
**Owner:** admin-expert (HIGH-001/005) + auth-security (HIGH-003/004). **Deadline:** HIGH-002 already closed; the rest are tracked decisions (auth-ownership A4 explicitly deferred by the platform owner this session).

## ORPHAN-MEDIUM-361 — 13 admin-schema tables registered in MODULE_SCHEMAS['admin'] + a make-detectable parity guard (DB-ADMIN-MEDIUM-002) — RESOLVED (this PR)

**Discovered:** 2026-07-11 (Lane-D db-audit, `db-audit-platform-admin` — DB-ADMIN-MEDIUM-002). P3 governance / registry-completeness.
**Defect:** 13 `@Entity(..., { schema: 'admin' })` tables were absent from `MODULE_SCHEMAS['admin']` (`schema-manager.service.ts`): `discount_codes`, `module_pricing`, `plan_definitions`, `plan_module_assignments`, `threat_intelligence`, `retention_policies`, `retired_schema_backups`, `database_metrics`, `slow_query_logs`, `ingest_backend_policy_state`, `announcements`, `job_queues`, `system_versions`. The ADR-012 drift validator + orphan-drop presence checks iterate that registry, so an unregistered real table is neither reconciled nor protected — and no invariant covered platform-service entity↔registry parity, so the drift went undetected.
**Fix (this PR):**
- **Data:** added all 13 to the admin registry — 12 domain tables to `tables`, and `retired_schema_backups` to `infrastructureTables` (same schema-lifecycle class as `schema_backups`/`schema_restores`). Verified COMPLETE: a full diff of every `schema:'admin'` `@Entity` table name (58) against the registry is now empty — these 13 were the exact missing set.
- **Make-detectable (Tier-3):** new `tests/invariants/admin-entity-registry-parity.spec.ts` asserts every admin-schema entity table is in the admin registry block, so this drift cannot silently recur. The finding recommended exactly this guard.
**Validation:** the new parity spec + `entity-schema-declaration` + `tenant-fanout-entity-parity` + `platform-service-catalog-parity` + `admin-api-schema-boundaries` + `entity-diff-implies-migration` + `tenant-erasure-ssot` + `invariant-reachability` all green (51 tests); the registry change is string-literal additions only (tsc-neutral, exercised by the specs that compile schema-manager).
**Follow-on (noted, not done):** extend the parity guard to the other platform-level services (billing/auth/notification/config/event_store/observability/gateway) — DB-ADMIN-MEDIUM-002 named only admin; a general platform-service parity invariant would catch the same drift class elsewhere.
**Owner:** admin-expert / data-expert. **Deadline:** admin registry + guard closed this PR; the cross-service parity extension is a tracked follow-on (2026-10-15).

## ORPHAN-MEDIUM-362 — generalized the registry-parity guard across platform services + fixed billing's 2 gaps; observability tracked (extends [[ORPHAN-MEDIUM-361]]) (this PR)

**Discovered:** 2026-07-12 (Lane-D db-audit, continuation of DB-ADMIN-MEDIUM-002 — the "extend to other platform services" follow-on of [[ORPHAN-MEDIUM-361]]).
**What the generalization found:** running the same entity↔registry diff across every platform-level service surfaced more drift of the same class —
- **billing:** `plans` + `stripe_webhook_events` were absent from `MODULE_SCHEMAS['billing']`. Added both to `tables` (stripe_webhook_events is a webhook-idempotency ledger, same class as `command_receipts`). Verified: billing entity↔registry parity is now complete.
- **notification / config / event_store:** already complete (config + event_store were registered earlier this session during the GDPR-erasure onboarding).
- **observability:** has `schema: 'observability'` entities (`emergency_overrides`, `migration_backfill_progress`, `migration_events`, `schema_object_history`) but **NO `MODULE_SCHEMAS['observability']` entry at all** — a larger fix (a whole new registry entry + drift-validator wiring + boot validation of observability-service, which this memory-constrained no-run session cannot safely validate). Tracked as a follow-on, NOT done.
**Fix (this PR):** replaced the admin-only guard (ORPHAN-MEDIUM-361) with `tests/invariants/platform-entity-registry-parity.spec.ts`, a per-schema `it.each` over admin/billing/notification/config/event_store that fails listing any entity whose table is unregistered. It also carries a `KNOWN_UNREGISTERED = ['observability']` list with an assertion that those services genuinely still lack an entry — so the exclusion is honest and the guard fails the moment observability gains an entry without being moved into coverage.
**Validation:** `platform-entity-registry-parity` 8/8 (5 services + the honest-exclusion check) + `invariant-reachability` green.
**Follow-on (tracked):** give observability-service a `MODULE_SCHEMAS['observability']` entry (classify its 4 tables — they look like schema/migration infra) + wire its drift validator, then move it from KNOWN_UNREGISTERED into COVERED.
**Owner:** observability-expert / data-expert. **Deadline:** billing + platform-wide guard closed this PR; the observability registry entry is a tracked follow-on (2026-10-15).

## ORPHAN-INFO-363 — LIVE-VERIFIED against the running droplet database (read-only) — findings + fixes confirmed with real data (this PR)

**Discovered:** 2026-07-12. This session runs ON the droplet (`aqua-postgres` container, PG16, DB `aquaculture`); the deployed image is `c7edad031` (this branch is NOT deployed). Read-only queries as superuser confirm the audit findings + that the fixes target real gaps. NOTE: the droplet holds ONE nearly-empty E2E/staging tenant (`tenant_7f6b08ab90e246d3`, tanks named `E2E-Cage-*`), so "0 rows" means "unused in THIS env", weaker than a busy-prod signal.

**Fixes/findings confirmed live:**
- `shared.access_logs` = **0 rows** → the canonical table is genuinely never written (built-but-unmounted, IDENT-HIGH-002 / [[ORPHAN-HIGH-357]]) — the gateway wire-up addresses a real gap.
- admin registry: all **13/13** added tables exist in `admin` schema; billing: both `plans` + `stripe_webhook_events` exist ([[ORPHAN-MEDIUM-361]]/[[ORPHAN-MEDIUM-362]]) — the registry additions are for REAL tables, not phantom.
- `auth.tenants` has **no `suspendedAt`/`suspended_at` column** → DB-ADMIN-HIGH-003 confirmed: the suspend handler writes a transient prop TypeORM drops (data goes nowhere).
- A1 tank count: all live `tank_batches` rows have `currentQuantity == totalQuantity` and `equipment.currentCount == totalQuantity` (0 mismatches) → the deployed single-WRITER fix keeps all four count locations in lock-step; the A1 READ-side fix + invariant ([[ORPHAN-HIGH-353]]) is correctly PREVENTIVE, not fixing active corruption.
- Decision-pending tables are empty in this env: `config.configurations`=0 (INFRA-HIGH-001 built-but-unconsumed — also unwritten), `farm_documents`=0 (FARMPLAT-HIGH-001 orphan DMS), `feeding_tables`=0 → dropping any of these is data-loss-safe HERE, but confirm against a data-bearing tenant before a real drop.
- `shared.user_permissions` = 1 row (A3 "dead parallel RBAC catalogue" — essentially unused; live RBAC rides `auth.tenant_role_permissions`).

**NEW incidental observation — INVESTIGATED, benign:** `shared.audit_logs` = **0 rows** while `admin.audit_logs` = **213 rows**. Unlike access_logs, the semantic-action stream IS wired: `@AuditedOperation()` is used at 11 call sites (7 real billing handlers — create-subscription, record-payment, void-invoice, finalize-invoice, refund-payment, create-invoice, change-subscription-plan), and `AuditedOperationInterceptor` writes `shared.audit_logs` via `save(AuditLogEntity)` (`audited-operation.interceptor.ts:290/295`). So the 0 rows means no audited billing operation has fired in this low-activity E2E tenant (likely seeded / `BILLING_PROVIDER=mock`), NOT an unmounted-writer gap. Capability confirmed wired — no action. (Distinct from access_logs, which had ZERO mount points.)
**Owner:** data-expert. **Deadline:** informational (live confirmation of already-tracked findings); the shared.audit_logs coverage question is a new tracked follow-on (2026-10-15).

## ORPHAN-HIGH-364 — REVERSE-DRIFT (live-DB-only discovery): 6 admin tables exist in the DB with NO entity AND NO registry entry (this PR)

**Discovered:** 2026-07-12, by a reverse-drift check the code-only audit structurally could not do — enumerating actual DB tables (running droplet) and diffing against entities + registry. The forward checks (entity→registry, [[ORPHAN-MEDIUM-361]]/[[ORPHAN-MEDIUM-362]]) can't see a table that has no entity. The live DB can.
**Clean checks first (both hold):** `public` schema has **0** tables (CLAUDE.md "no domain tables in public" holds live); `shared` schema has **exactly the 5** canonical tables (access_logs, audit_logs, gdpr_data_requests, user_consents, user_permissions) — no unauthorized shared table.
**The gap — `admin` schema has 72 base tables but only 58 entities; 6 have neither an `@Entity` nor a `MODULE_SCHEMAS['admin']` entry** (registry=0 for all six), so the drift validator + orphan-drop presence checks are blind to them (and under `strictOwnership` they would be DROP targets):
- `global_configs` — **0 rows, RETIRED.** The physical remnant of the `GlobalConfig` entity removed this session ([[ORPHAN-LOW-354]]); the class went, the table stayed. Empty → safe to drop in an admin-api migration (blue-green: the write path is already a 410 Gone).
- `tenant_configurations` — **1 row, RETIRED.** admin-api direct writes were retired to config-service (the GoneException in `tenant-configuration.service`); the table lingers. Drop or hydrate-from-config-service — a decision.
- `system_settings` — **35 rows, DATA-BEARING, no entity, unregistered.** The most concerning: a live-data table managed outside the entity/registry system entirely (raw SQL). Needs investigation — what reads/writes it, and should it get an entity + registration (protect it) or is it legacy?
- `tenant_provisioning_runs` (2 rows) / `tenant_provisioning_steps` (0) / `tenant_onboarding_acks` (0) — the TenantProvisioningWorkflow tables (migrations 1800400/1800500/1801200), legitimately raw-SQL/migration-managed with no TypeORM entity. Should be added to `MODULE_SCHEMAS['admin'].infrastructureTables` so the drift validator + orphan-drop recognize them (same protection gap, but these are legitimate infra, not dead).
**Why not fixed here:** dropping `global_configs`/`tenant_configurations` needs an admin-api migration (prod DDL, blue-green, migration-lint) this hostile-environment no-build session should not author blind; registering the provisioning tables risks the entity↔registry-parity invariant unless verified (they have no entity, so adding them to `tables` could trip a reverse check) — needs a run to confirm. And `system_settings` needs a code investigation first. All are safe to LEAVE (nothing is actively broken); this records the reverse-drift so it is not lost.
**Follow-ons:** (1) admin-api migration dropping `global_configs` (empty, retired) — completes ORPHAN-LOW-354; (2) decide `tenant_configurations` drop-vs-hydrate; (3) investigate + classify `system_settings` (35 rows); (4) register the 3 provisioning tables in `infrastructureTables`; (5) consider a periodic live-DB reverse-drift check (can't be a static CI invariant — needs a database).
**Owner:** admin-expert / data-expert. **Deadline:** discovery recorded this PR; each follow-on is a tracked migration/decision (2026-10-15).
**RESOLUTION UPDATE (Faz 2a, feat/legacy-config-store-drop):** follow-ons 1-3 CLOSED by migration `1801400000000-DropRetiredLegacyConfigStores` — archive-before-drop into `admin.retired_config_backups` (jsonb, per-table idempotent, count-asserted; registered in `MODULE_SCHEMAS['admin'].infrastructureTables`), then guarded DROP of `global_configs` + `system_settings` + `tenant_configurations` (+ the two `system_settings_*` enums behind a pg_depend gate). `system_settings` needed NO further investigation: `SystemSetting` was another undecorated class with a GoneException service (same family). Code: the dead `SystemSetting` class removed; `TenantConfiguration` converted from an undecorated class to a plain interface (its read path legitimately serves synthesized defaults at runtime — contract kept, ORM illusion gone). Follow-on 4 (provisioning tables) closed by [[ORPHAN-HIGH-366]]. Incidental: `settings/__tests__/reliability/email-circuit-breaker.spec.ts` fails 10/14 on the UNMODIFIED base too (pre-existing, quarantined-suite class — unrelated to this change; needs its own pass).

## ORPHAN-HIGH-365 — reverse-drift, cross-schema: `compliance` + `platform` schemas exist in the live DB with NO MODULE_SCHEMAS entry (this PR)

**Discovered:** 2026-07-12, extending the [[ORPHAN-HIGH-364]] reverse-drift scan across every non-tenant schema on the running droplet. Per-schema table counts flagged two schemas absent from the service registry entirely:
- **`compliance` schema — `legal_holds` table, HAS an `@Entity('legal_holds', { schema: 'compliance' })`, but NO `MODULE_SCHEMAS['compliance']` entry** (same class as observability [[ORPHAN-MEDIUM-362]]). This is the "register `compliance` in the schema registry" gap the audit plan named. It matters more than observability: `legal_holds` is litigation/GDPR-critical (legal-hold precedence gates every destructive path). Unregistered → the drift validator + orphan-drop are blind to it; under a strictOwnership sweep it could even be a DROP target. It needs a proper `MODULE_SCHEMAS['compliance']` entry + PLATFORM_LEVEL_MODULES membership + drift-validator wiring.
- **`platform` schema — 3 tables (`bootstrap_signal`, `release_ledger`, `tenant_schema_jobs`), no entity, no registry entry.** These are db-migrate/bootstrap-managed platform infrastructure (the bootstrap signal, the release ledger, the tenant-schema-provisioner job queue) — legitimately raw-SQL, but likewise invisible to the registry. Lower concern (bootstrap owns them), but worth an explicit `platform`-schema registry entry (infrastructureTables) for completeness.
**Positive confirmations from the same scan:** `public`=0 tables, `shared`=exactly 5 canonical; ai/alert/auth/billing/config/event_store/notification/sensor table counts are consistent with their entity+infra surface (no obvious extra-table hotspot beyond admin's 6 and these 2 schemas).
**Why not fixed here:** registering a whole schema (compliance/platform) is a new MODULE_SCHEMAS entry + PLATFORM_LEVEL_MODULES + drift-validator wiring + boot validation — the same larger, must-run-to-verify fix deferred for observability; unsafe to author blind in this no-build session.
**Follow-ons:** (1) add `MODULE_SCHEMAS['compliance']` (legal_holds + its outbox/infra) — HIGH, litigation-critical; (2) add `MODULE_SCHEMAS['platform']` for the 3 bootstrap tables; (3) fold both into the observability registry-onboarding follow-on so the platform-service registry is finally complete.
**Owner:** compliance-expert / data-expert (compliance) + platform-kernel-expert (platform). **Deadline:** discovery recorded this PR; the registry entries are tracked follow-ons (2026-10-15).

## ORPHAN-HIGH-366 — registry completeness sweep: compliance + platform + observability MODULE_SCHEMAS entries, admin provisioning tables, billing classification (resolves [[ORPHAN-HIGH-365]] + the ORPHAN-MEDIUM-362 observability follow-on + part of [[ORPHAN-HIGH-364]]) — RESOLVED (this PR)

**Source:** Faz 1 of the DB-audit remediation plan (post-#939). Live-DB verified: every registered table name exists in `information_schema`.
**Delivered:**
- **`MODULE_SCHEMAS['compliance']`** — `legal_holds` (litigation/GDPR-critical, previously invisible to the drift validator + orphan-drop). Owner facts: the `LegalHold` entity is a backend-common shared-lib entity (`libs/backend-common/src/compliance/legal-hold/legal-hold.entity.ts`); admin-api's migration created the physical schema; admin-api's boot validator covers it.
- **`MODULE_SCHEMAS['observability']`** — the 4 migration/schema-observability infra tables (`emergency_overrides`, `migration_backfill_progress`, `migration_events`, `schema_object_history`) + `migrations`. observability-service already registers `SchemaDriftModule.forRoot`; the registry surface now matches.
- **`MODULE_SCHEMAS['platform']`** — the 3 db-migrate/bootstrap raw-SQL tables (`bootstrap_signal`, `release_ledger`, `tenant_schema_jobs`); no entities/service by design, entry documents ownership so no sweep mistakes them for orphans.
- **`MODULE_SCHEMAS['admin'].infrastructureTables`** += `tenant_provisioning_runs`, `tenant_provisioning_steps`, `tenant_onboarding_acks` (the raw-SQL TenantProvisioningWorkflow tables from ORPHAN-HIGH-364 item 4).
- **`PLATFORM_LEVEL_MODULES`** += `billing` (the audit's "billing in NEITHER classification set" A-item), `compliance`, `observability`, `platform`.
- **Guards updated:** `platform-entity-registry-parity.spec` — observability + compliance moved into COVERED (compliance scans `libs/backend-common/src`), platform asserted as a registered raw-SQL schema with zero entities (the KNOWN_UNREGISTERED escape hatch is gone — the guard now covers every platform schema); e2e `schema-invariants` `PLATFORM_LEVEL_SCHEMAS` += compliance/platform (B.5b zero-tenant-clone check now covers them).
- **`tenant-isolation-static.spec` redesigned to its actual subject (tenant isolation):** the old spec hard-required `tables.length>0` on every entry, forbade same-named tables across ALL modules, and pinned a whole-registry total of 170 — all three had drifted (total was actually 250+ before this sweep; the suite appears CI-quarantined so nobody saw it fail). Now: every entry must declare tables OR infrastructureTables; duplicate-name checks scope to the tenant-scoped fan-out namespace (platform schemas are schema-qualified — `admin.messages` vs per-tenant `messages` is legitimate); pins cover the TENANT-SCOPED surface only (fan-out total 183; per-module counts updated sensor 46 / farm 86 / hr 29).
**Validation:** full invariants 1876/1876; parity spec 8/8 (8 schemas); tenant-isolation-static 17/17; admin-api tsc clean; live-DB `information_schema` existence for all 11 newly-registered tables.
**Deferred (unchanged):** runtime cold-start drift-validator confirmation on the droplet happens with this PR's deploy (services boot with the new entries — verify `schema_drift_clean` emits for admin/observability).
**Owner:** data-expert. **Deadline:** closed this PR; deploy-time validator check rides the release.

## ORPHAN-HIGH-367 — access_logs INSERTs blocked by RLS tenant_isolation_policy in prod (live deploy verification of [[ORPHAN-HIGH-357]]) — RESOLVED via INFRASTRUCTURE_AUDIT_LEDGERS (this PR)

**Discovered:** 2026-07-12, minutes after the #939 deploy landed on the droplet, by live verification: the gateway's `AccessLogMiddleware` fired on real requests (wire-up works) but every INSERT failed — `ACCESS_LOG_FAILURE [count=N]: GET /health/live — new row violates row-level security policy for table "access_logs"` in the gateway logs; `shared.access_logs` stayed at 0 rows.
**Root cause:** the platform-bootstrap gave `shared.access_logs` the standard `tenant_isolation_policy` (ALL, `tenantId = current_setting('app.current_tenant')`, FORCE RLS). But access_logs is an **infrastructure append ledger**: the gateway writes rows for ALL tenants + anonymous (tenantId NULL) requests on one connection with no tenant GUC — the same write shape as `shared.audit_logs`, which already carries the correct `infra_ledger_append` (INSERT, check=true) + `infra_ledger_read` (tenant-scoped/operator) policies from the ORPHAN-324 (#915) `INFRASTRUCTURE_AUDIT_LEDGERS` SSoT + db-migrate self-heal.
**Fix (Tier-1, one line into the purpose-built SSoT):** added `access_logs` to `INFRASTRUCTURE_AUDIT_LEDGERS.shared` (`libs/backend-common/src/database/rls/infrastructure-ledger.ssot.ts`). The db-migrate hardening pass (invoked from `apps/db-migrate/src/main.ts` every deploy) DROPs `tenant_isolation_policy` and CREATEs the infra-ledger pair on the live table — the fix self-heals prod on this PR's deploy. No hand-DDL against prod (single-writer db-migrate discipline). Fail-open middleware means zero user impact in the interim (only lost observability rows, counted by `getFailureCount`).
**Also settles the shared.audit_logs=0 question ([[ORPHAN-INFO-363]]):** live `pg_policies` shows `shared.audit_logs` ALREADY carries `infra_ledger_append`/`infra_ledger_read` — its writes work; 0 rows is genuinely low activity (no audited billing op in this E2E tenant). The "benign" verdict stands at the RLS layer too.
**Validation:** `infrastructure-ledger-ssot` + `rls-exclude-tables-ssot` + `rls-predicate-canonical` + `protected-tables-guard` + `shared-schema-canonical` 17/17; helper verified to DROP the old policy (`infrastructure-ledger-rls.helper.ts:177`). **Post-deploy check (rides this release):** `SELECT count(*) FROM shared.access_logs` > 0 after any HTTP request, and gateway logs free of `ACCESS_LOG_FAILURE`.
**Owner:** auth-security / data-expert. **Deadline:** SSoT line landed this PR; live policy swap + row-growth verification on this PR's deploy.

## ORPHAN-HIGH-368 — event-store crypto-shred rollout Step 2: wire `shred()` into the tenant-erasure handler (design-doc rollout #2) — RESOLVED (this PR)

**Scope:** `docs/plans/2026-07-12-event-store-crypto-shred-design.md` rollout step 2 (the only step the platform owner approved for this initiative; steps 3-4 stay a separate security-review initiative). Add a `TenantPayloadCryptoService.shred(tenantId)` step to event-store's tenant-erasure execution (proof-carrying, idempotent — `shred` is already idempotent+tenant-scoped per its 6/6 spec). Only affects erased tenants; the live append/read path is untouched (crypto stays inert there).
**RESOLVED (this PR, lead-verified):** the erasure lib had no extension mechanism, so one was added architecturally: `TenantErasurePostErasureHook` interface + optional `postErasureHooks` executor dependency — hooks run INSIDE the erasure transaction after all table deletions and BEFORE the proof is recorded (a hook throw rolls back and lands on the existing `TenantDataErasureFailed` path — fail-closed, identical to a table-deletion failure); executed hook names are folded into the proof hash; dry-run skip is EXECUTOR-enforced. `TenantErasureTargetModule.forService(service, { imports, postErasureHooks })` wires them via an always-bound token (12 existing callsites unchanged). Event-store registers `StoredEventsCryptoShredHook` → `shred(tenantId)`. **Defect found+fixed en route:** `tenant_payload_keys` was NOT in event-store's `excludedTables` — row-deletion would have destroyed the shred tombstone (a later `encrypt()` would mint a fresh DEK for an erased tenant) and deadlocked against the hook's UPDATE; now excluded with WHY. Validation: lib hook spec 4/4 + structural-exclusion spec, event-store crypto 9/9, tenant-erasure-ssot + reachability 20/20, event-store+config tsc clean.
**Owner:** security-architecture / data-expert. **Deadline:** closed by this PR's merge; steps 3-4 remain the separate security-review initiative (2026-10-15).

## ORPHAN-HIGH-371 — source-schema erasure deleted the tenant's PRIOR erasure proofs (erasure-history loss) — RESOLVED structurally (this PR)

**Discovered:** 2026-07-12, by the Faz 6 lane while wiring the shred hook: `eraseSourceSchemaRows` deletes tenant rows from EVERY registered table carrying a tenant column — including `tenant_erasure_target_proofs` itself (it has `tenantId` and no service's registry excluded it). A NEW erasure operation therefore erased the proof rows of the tenant's PRIOR operations across every source-schema service (event-store, billing, notification, config, admin) — GDPR/audit evidence loss; the erasure ledger must be append-forever.
**Fix (Tier-1, executor-structural — not a registry convention):** the executor's exclusion set now ALWAYS unions `options.proofLedger.table` + `options.outbox.table` on top of any registry `excludedTables` (`tenant-erasure-target-executor.ts` `eraseSourceSchemaRows`) — the proof ledger survives structurally, and outbox rows pending publish (including the erasure events this very flow enqueues) survive to publication. Spec proves it: with `excludedTables: []` the delete set still never contains the proof ledger. `tenant-schema-module` mode is structurally unaffected (it deletes only cloned `tables` inside the tenant schema; ledgers/outboxes are source-schema `infrastructureTables`).
**Validation:** executor spec 5/5; event-store + config tsc clean; tenant-erasure-ssot + reachability 20/20.
**Owner:** security-architecture / data-expert. **Deadline:** closed by this PR's merge.

## ORPHAN-HIGH-369 — farm_documents DROP (FARMPLAT-HIGH-001; owner decision: drop) — RESOLVED (this PR)

**Scope:** platform owner chose DROP over wire ([[ORPHAN-HIGH-356]] item 2; live DB: 0 rows). Remove the orphan DMS: `document/` domain dir (entity+module), farm_documents references in `common/file-cleanup/*` + scheduler cron wiring, `MODULE_SCHEMAS['farm']` registration if present, and a NEW drop migration (never edit `CreateFarmDocuments` — immutability) with a 0-row guard (ABORT if any environment has data) + tenant-fanout drop across tenant schemas.
**RESOLVED (this PR, lead-verified):** migration `1805300000000-DropFarmDocuments` — `current_schema()`-relative (no cross-schema DDL; avoids the #926 outage class — db-migrate fan-out delivers the farm pass + each tenant pass), guards: skip-if-absent, `RAISE EXCEPTION` if ANY rows (data-loss guard for other environments), `DROP TABLE IF EXISTS` with DESTRUCTIVE marker, per-type pg_depend zero-dependents probe for the three `farm_documents_*` enums (live catalog showed they are per-schema-LOCAL — each tenant clone references its own copies), `postCondition()` refuses the ledger row unless the table is gone. **The exact shipped SQL was exercised in a throwaway pg16 container** (row-guard abort, farm-pass isolation, dependent-enum skip, idempotent replay, postCondition — all verified; live DB untouched). Code: `document/` dir + farm-document cleanup provider removed; file-cleanup framework intact (BatchDocument + Chemical providers live); cron tenant-discovery re-anchored; `MODULE_SCHEMAS['farm']` entry removed; tenant-isolation pins 86→85 / 183→182. Validation: full invariants 1876/1876; farm + backend-common tsc clean; file-cleanup/minio-orphan specs 9/9.
**Owner:** farm-expert. **Deadline:** closed by this PR's merge.

## ORPHAN-HIGH-370 — admin-panel P2 contract repairs: impersonation FE rename + tenant list tier/counts (DB-ADMIN-HIGH-001/005) — IN PROGRESS (parallel lane)

**Scope (evidence in [[ORPHAN-HIGH-360]] + the plan's Faz 4):**
- HIGH-001: rename the FE impersonation types to the backend `SafeImpersonationSession` contract — surface is ONE page (`ImpersonationPage.tsx`) + `services/api/impersonation.ts` + `services/types/impersonation.ts`; status `'revoked'→'terminated'`; UI's numeric `actionsPerformed` → `actionCount`; DELETE unused `sessionToken`/`originalUserId`/`lastActivityAt` from the FE types (sessionToken must never be expected on reads — HIGH-002).
- HIGH-005: `ListTenantsHandler` maps to the existing `TenantListItemDto` with `tier` (from `plan`) and `farmCount`/`sensorCount` via ONE batched round-trip (single SQL across the page's tenant schemas with information_schema existence guards — the batched form of `countTenantResource`; no per-row N+1).
**Owner:** admin-expert. **Deadline:** this parallel-lane PR; updated to RESOLVED on merge.
