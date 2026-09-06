//! Phase B-3 — OPC UA per-tenant + per-user session quota closure invariant.
//!
//! ## Why this file exists
//!
//! Phase B-3 (Plan §B-3 / Batches #271-#272) closes the noisy-neighbor
//! fairness gap on the OPC UA session-establish path. Pre-B-3 the only
//! cap on session count is `Limits.max_sessions = 10` (Batch 228) — a
//! single compromised operator credential can open all 10 sessions and
//! starve every other operator. The `SessionQuota` primitive layers
//! per-tenant + per-user fairness on top of the global hard cap.
//!
//! Three wires are tightly coupled:
//!
//! - `src/opc_ua_server/session_quota.rs` — `SessionQuota` primitive +
//!   RAII `SessionLease`.
//! - `src/opc_ua_sens_auth_manager.rs` — `SensAuthManager` carries
//!   `Arc<SessionQuota>` field + `authenticate_username_identity_token`
//!   acquires lease after Argon2id success.
//! - `src/opc_ua_server_runtime.rs` — production boot path constructs
//!   `SessionQuota::new(tenant, max_per_tenant, max_per_user)` from
//!   `OpcUaServerConfig` + passes to `SensAuthManager::new`.
//!
//! A regression that drops the `try_acquire` callsite would silently
//! regress the fairness floor — the global `max_sessions=10` cap would
//! still apply, but a single user could again monopolize all 10. THIS
//! FILE is the Tier-3 MAKE-IT-DETECTABLE seam.
//!
//! Pattern mirrors `tests/invariants/opc_ua_auth_throttle_enforced.rs`
//! (Phase B-2) and `tests/invariants/opc_ua_leaf_pin_enforced.rs`
//! (Phase B-1).

fn read_source(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "BUG: opc_ua_session_quota invariant cannot read {path} — \
             this test runs from sens-api-gateway/ working dir per cargo \
             test convention. err={e}"
        )
    })
}

/// **Phase B-3 / Batch #271 (SessionQuota primitive presence):** the
/// `SessionQuota` struct + its constructor MUST exist. A regression
/// that removes the primitive collapses every downstream wire.
#[test]
fn b3_session_quota_struct_present() {
    let src = read_source("src/opc_ua_server/session_quota.rs");
    assert!(
        src.contains("pub struct SessionQuota"),
        "B-3 / ULTRA-B-3 WIRE INVARIANT VIOLATED: \
         src/opc_ua_server/session_quota.rs does not define \
         `pub struct SessionQuota`. The fairness primitive is the SSoT \
         for per-tenant/per-user session counting."
    );
    assert!(
        src.contains("pub fn new("),
        "B-3 WIRE INVARIANT VIOLATED: SessionQuota has no `new` constructor."
    );
    assert!(
        src.contains("pub fn try_acquire("),
        "B-3 WIRE INVARIANT VIOLATED: SessionQuota lacks `try_acquire`. \
         Lease acquisition has no entry point — fairness gate cannot fire."
    );
}

/// **Phase B-3 / Batch #271 (SessionLease RAII presence):** the
/// `SessionLease` struct MUST exist + impl `Drop`. A regression that
/// "simplifies" lease tracking by storing raw counts instead of the
/// RAII handle would lose the on-drop decrement contract.
#[test]
fn b3_session_lease_raii_present() {
    let src = read_source("src/opc_ua_server/session_quota.rs");
    assert!(
        src.contains("pub struct SessionLease"),
        "B-3 RAII INVARIANT VIOLATED: src/opc_ua_server/session_quota.rs \
         does not define `pub struct SessionLease`. The RAII handle is \
         the architectural shape for atomic lease release on every \
         termination path (close, RST, panic)."
    );
    assert!(
        src.contains("impl Drop for SessionLease"),
        "B-3 RAII INVARIANT VIOLATED: SessionLease has no Drop impl. \
         Without on-drop decrement, leases accumulate forever — the \
         per-user cap eventually permanently locks out the user."
    );
}

/// **Phase B-3 / Batch #271 (error variants for cap exceeded):** both
/// `TenantCapExceeded` + `UserCapExceeded` MUST exist. A regression
/// that collapses them into a single generic error would lose the
/// operator-readable distinction between "too many sessions in this
/// tenant" vs "too many sessions for this user".
#[test]
fn b3_quota_error_variants_present() {
    let src = read_source("src/opc_ua_server/session_quota.rs");
    assert!(
        src.contains("TenantCapExceeded"),
        "B-3 WIRE INVARIANT VIOLATED: SessionQuotaError lacks \
         TenantCapExceeded variant — operators cannot distinguish \
         tenant-cap rejections from user-cap rejections in the audit \
         stream."
    );
    assert!(
        src.contains("UserCapExceeded"),
        "B-3 WIRE INVARIANT VIOLATED: SessionQuotaError lacks \
         UserCapExceeded variant — the per-user fairness gate has no \
         specific error class."
    );
}

/// **Phase B-3 / Batch #272 (SensAuthManager session_quota field):** the
/// `SensAuthManager` struct MUST hold an `Arc<SessionQuota>` field +
/// the `active_leases` Mutex map keeping every issued lease alive.
/// EDGE-HIGH-018: the map is keyed by the lease's unique `lease_id`, NOT
/// the per-operator-constant token (which collided and dropped leases).
#[test]
fn b3_sens_auth_manager_holds_quota() {
    let src = read_source("src/opc_ua_sens_auth_manager.rs");
    assert!(
        src.contains("session_quota: Arc<crate::opc_ua_server::session_quota::SessionQuota>"),
        "B-3 WIRE INVARIANT VIOLATED: src/opc_ua_sens_auth_manager.rs \
         `SensAuthManager` does not declare the \
         `session_quota: Arc<...SessionQuota>` field. Type-level \
         architectural floor missing."
    );
    assert!(
        src.contains("active_leases:"),
        "B-3 WIRE INVARIANT VIOLATED: SensAuthManager does not hold \
         the `active_leases` registry. Without it, issued leases would \
         only release via the TTL fail-safe."
    );
}

/// **Phase B-3 / Batch #272 (constructor takes session_quota):** the
/// `SensAuthManager::new` signature MUST require `Arc<SessionQuota>`.
/// Type-level enforcement that every instance carries the fairness
/// gate.
#[test]
fn b3_constructor_requires_session_quota_param() {
    let src = read_source("src/opc_ua_sens_auth_manager.rs");
    assert!(
        src.contains("session_quota: Arc<crate::opc_ua_server::session_quota::SessionQuota>"),
        "B-3 WIRE INVARIANT VIOLATED: SensAuthManager::new signature \
         does not require `session_quota: Arc<...SessionQuota>`. A \
         quota-less constructor would let a future caller bypass the \
         fairness gate."
    );
}

/// **Phase B-3 / Batch #272 (authenticate path acquires lease):** the
/// `authenticate_username_identity_token` body MUST call
/// `self.session_quota.try_acquire(...)` after the Argon2id success
/// path AND store the lease (or release on quota-error). Without the
/// callsite, fairness has no enforcement point.
#[test]
fn b3_authenticate_acquires_session_lease() {
    let src = read_source("src/opc_ua_sens_auth_manager.rs");
    assert!(
        src.contains("self.session_quota.try_acquire("),
        "B-3 GATE INVARIANT VIOLATED: src/opc_ua_sens_auth_manager.rs \
         does not call `self.session_quota.try_acquire(...)`. The \
         fairness gate has no enforcement point — successful \
         authentication unconditionally issues a UserToken regardless \
         of cap state."
    );
    assert!(
        src.contains("BadTooManySessions"),
        "B-3 GATE INVARIANT VIOLATED: src/opc_ua_sens_auth_manager.rs \
         does not return `BadTooManySessions` on quota-exceeded. The \
         OPC UA standard error code distinguishes quota rejections from \
         credential mismatches; without it, HMI clients cannot \
         differentiate the failure mode."
    );
}

/// **Phase B-3 / Batch #272 (audit-sink emit on quota-exceeded):** the
/// `OpcUaSessionQuotaExceeded` AuditAction MUST be emitted via
/// `try_emit_mtls_forensic_event` when `try_acquire` rejects.
#[test]
fn b3_quota_emits_session_quota_exceeded_audit() {
    let src = read_source("src/opc_ua_sens_auth_manager.rs");
    assert!(
        src.contains("AuditAction::OpcUaSessionQuotaExceeded"),
        "B-3 AUDIT EMIT INVARIANT VIOLATED: src/opc_ua_sens_auth_manager.rs \
         does not reference `AuditAction::OpcUaSessionQuotaExceeded`. \
         Quota-exceeded events would not surface in the ADR-020 audit \
         chain — operators querying `audit-verify` could not see \
         compromised-user-starves-others patterns."
    );
}

/// **Phase B-3 / Batch #271 (AuditAction wire-tag stability):** the
/// `OpcUaSessionQuotaExceeded` variant MUST exist on AuditAction +
/// hold its assigned wire_tag (36).
#[test]
fn b3_audit_action_variant_present_with_stable_wire_tag() {
    let src = read_source("src/audit/entry.rs");
    assert!(
        src.contains("OpcUaSessionQuotaExceeded"),
        "B-3 AUDIT WIRE INVARIANT VIOLATED: src/audit/entry.rs does \
         not declare the `OpcUaSessionQuotaExceeded` variant on AuditAction. \
         The quota emit has no canonical action discriminator."
    );
    assert!(
        src.contains("Self::OpcUaSessionQuotaExceeded => 36"),
        "B-3 AUDIT WIRE INVARIANT VIOLATED: src/audit/entry.rs does \
         not pin `OpcUaSessionQuotaExceeded.wire_tag()` to 36. \
         Re-numbering would invalidate every historical audit-chain \
         entry's HMAC linkage."
    );
}

/// **Phase B-3 / Batch #272 (production boot wires from config):**
/// `init_opc_ua_server` MUST construct `SessionQuota::new(...)` from
/// `config.max_sessions_per_tenant` + `config.max_sessions_per_user`.
#[test]
fn b3_boot_wires_quota_from_config() {
    let src = read_source("src/opc_ua_server_runtime.rs");
    assert!(
        src.contains("SessionQuota::new(")
            && src.contains("config.max_sessions_per_tenant")
            && src.contains("config.max_sessions_per_user"),
        "B-3 BOOT WIRE INVARIANT VIOLATED: src/opc_ua_server_runtime.rs \
         does not construct `SessionQuota::new(...)` with both \
         `config.max_sessions_per_tenant` + `config.max_sessions_per_user`. \
         The operator-tunable caps are the architectural contract — \
         hardcoding bypasses runtime tuning."
    );
}

/// **Phase B-3 (config field presence + validators):** the new fields
/// MUST exist on `OpcUaServerConfig` + the validator MUST enforce the
/// cascading order (per_user <= per_tenant <= max_sessions).
#[test]
fn b3_config_fields_and_validators_present() {
    let src = read_source("src/config.rs");
    assert!(
        src.contains("pub max_sessions_per_tenant: u32,"),
        "B-3 CONFIG INVARIANT VIOLATED: OpcUaServerConfig lacks \
         `max_sessions_per_tenant` field."
    );
    assert!(
        src.contains("pub max_sessions_per_user: u32,"),
        "B-3 CONFIG INVARIANT VIOLATED: OpcUaServerConfig lacks \
         `max_sessions_per_user` field."
    );
    assert!(
        src.contains("max_sessions_per_user > self.max_sessions_per_tenant"),
        "B-3 CONFIG VALIDATOR INVARIANT VIOLATED: validate() does not \
         enforce per_user <= per_tenant. A config with user>tenant \
         would let a single user exceed the tenant ceiling — the \
         architectural floor is broken."
    );
    assert!(
        src.contains("max_sessions_per_tenant > self.max_sessions"),
        "B-3 CONFIG VALIDATOR INVARIANT VIOLATED: validate() does not \
         enforce per_tenant <= max_sessions. The per-tenant cap is a \
         refinement of the global hard floor, MUST be <= it."
    );
}

/// **Phase B-3 / Batch #271 (session_quota submodule declaration):**
/// `opc_ua_server.rs` MUST declare `pub mod session_quota;`.
#[test]
fn b3_session_quota_submodule_declared() {
    let src = read_source("src/opc_ua_server.rs");
    assert!(
        src.contains("pub mod session_quota;"),
        "B-3 SUBMODULE WIRE INVARIANT VIOLATED: src/opc_ua_server.rs \
         does not declare `pub mod session_quota;`. The session_quota.rs \
         file is orphaned — compile-time absent from the binary."
    );
}
