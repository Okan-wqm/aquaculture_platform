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

**Status:** TRIAGE-PENDING — 6 sub-findings to be split into individual batches after current plan Sprint 6.x deep-wire run.

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
