//! Phase B-2 — OPC UA brute-force throttle closure invariant.
//!
//! ## Why this file exists
//!
//! Phase B-2 (Plan §B-2 / Batches #269-#270) closes the brute-force
//! defense gap on the OPC UA session-establish authentication surface
//! by introducing the [`FailedAuthWindow`] primitive + wiring it as a
//! Tier-1 architectural floor on `SensAuthManager`.
//!
//! Three wires are tightly coupled:
//!
//! - `src/opc_ua_server/auth_throttle.rs` — `FailedAuthWindow` primitive
//! - `src/opc_ua_sens_auth_manager.rs` — `SensAuthManager` carries an
//!   `Arc<FailedAuthWindow>` field + `authenticate_username_identity_token`
//!   pre-checks + records.
//! - `src/opc_ua_server_runtime.rs` — production boot path constructs
//!   `FailedAuthWindow::new(config.max_failed_auth_per_60s)` + passes
//!   to `SensAuthManager::new(validator, throttle)`.
//!
//! A regression that "simplifies" `SensAuthManager::new` by dropping
//! the throttle parameter, OR removes the `peek_decision` pre-check,
//! OR hardcodes the cap, would compile + pass higher-level tests but
//! silently regress the brute-force defense. THIS FILE is the Tier-3
//! MAKE-IT-DETECTABLE seam.
//!
//! Pattern mirrors `tests/invariants/opc_ua_leaf_pin_enforced.rs`
//! (Phase B-1) and `tests/invariants/d4_d6_mtls_unified.rs` (Phase 1.1.5).

fn read_source(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "BUG: opc_ua_auth_throttle_enforced invariant cannot read {path} — \
             this test runs from sens-api-gateway/ working dir per cargo \
             test convention. err={e}"
        )
    })
}

/// **Phase B-2 / Batch #269 (FailedAuthWindow primitive presence):** the
/// `FailedAuthWindow` struct + its constructor MUST exist in the
/// auth_throttle module. A regression that removes the primitive
/// collapses every downstream wire — SensAuthManager has nothing to
/// hold; the throttle gate has no mechanism.
#[test]
fn b2_failed_auth_window_struct_present() {
    let src = read_source("src/opc_ua_server/auth_throttle.rs");
    assert!(
        src.contains("pub struct FailedAuthWindow"),
        "B-2 / ULTRA-B-2 WIRE INVARIANT VIOLATED: \
         src/opc_ua_server/auth_throttle.rs does not define \
         `pub struct FailedAuthWindow`. The throttle primitive is the \
         SSoT for sliding-window failure counting; without it, \
         brute-force defense is structurally absent."
    );
    assert!(
        src.contains("pub fn new("),
        "B-2 / ULTRA-B-2 WIRE INVARIANT VIOLATED: \
         src/opc_ua_server/auth_throttle.rs does not define \
         `FailedAuthWindow::new` constructor. The cap-bounded \
         instantiation contract has no entry point."
    );
}

/// **Phase B-2 / Batch #269 (decision API):** the `record_failure` +
/// `peek_decision` + `clear_on_success` triad MUST exist. The
/// `SensAuthManager` calls all three at distinct points in the
/// authenticate flow; removing any breaks the gate.
#[test]
fn b2_throttle_decision_api_present() {
    let src = read_source("src/opc_ua_server/auth_throttle.rs");
    assert!(
        src.contains("pub fn record_failure("),
        "B-2 WIRE INVARIANT VIOLATED: auth_throttle.rs does not expose \
         `record_failure` — failure events have no path to advance the \
         counter."
    );
    assert!(
        src.contains("pub fn peek_decision("),
        "B-2 WIRE INVARIANT VIOLATED: auth_throttle.rs does not expose \
         `peek_decision` — pre-check before Argon2id is the architectural \
         floor against CPU exhaustion; without peek, every failed attempt \
         pays the verifier cost regardless of throttle state."
    );
    assert!(
        src.contains("pub fn clear_on_success("),
        "B-2 WIRE INVARIANT VIOLATED: auth_throttle.rs does not expose \
         `clear_on_success` — operator typos that succeed on retry MUST \
         not leave failure history in the bucket. Without clear, an \
         operator who typoed cap-1 times is one typo away from a 60s \
         lockout on every successful login."
    );
}

/// **Phase B-2 / Batch #269 (ThrottleDecision variants):** the two
/// architectural decision states (`Counted` + `Throttled`) MUST exist.
/// A regression that collapses them into a single `bool` would lose
/// the `retry_after` operator-facing field + the count-at-cap forensic
/// detail.
#[test]
fn b2_throttle_decision_variants_present() {
    let src = read_source("src/opc_ua_server/auth_throttle.rs");
    assert!(
        src.contains("Counted") && src.contains("Throttled"),
        "B-2 WIRE INVARIANT VIOLATED: auth_throttle.rs does not define \
         the `ThrottleDecision::Counted` + `Throttled` variants. The \
         decision shape is the operator-readable contract."
    );
}

/// **Phase B-2 / Batch #270 (SensAuthManager throttle field):** the
/// `SensAuthManager` struct MUST hold an `Arc<FailedAuthWindow>` field.
/// Type-level architectural floor — a regression that removes the
/// field would have to also remove every callsite, which is detected
/// by the `b2_authenticate_consults_throttle` invariant below.
#[test]
fn b2_sens_auth_manager_holds_throttle() {
    let src = read_source("src/opc_ua_sens_auth_manager.rs");
    assert!(
        src.contains("throttle: Arc<crate::opc_ua_server::auth_throttle::FailedAuthWindow>"),
        "B-2 WIRE INVARIANT VIOLATED: src/opc_ua_sens_auth_manager.rs \
         `SensAuthManager` does not declare the \
         `throttle: Arc<...FailedAuthWindow>` field. Type-level \
         architectural floor missing — the throttle has no carrier on \
         the auth handler."
    );
}

/// **Phase B-2 / Batch #270 (constructor takes throttle):** the
/// `SensAuthManager::new` signature MUST require `Arc<FailedAuthWindow>`.
/// Type-level enforcement that every instance is constructed with a
/// throttle — there is no escape hatch.
#[test]
fn b2_constructor_requires_throttle_param() {
    let src = read_source("src/opc_ua_sens_auth_manager.rs");
    assert!(
        src.contains(
            "throttle: Arc<crate::opc_ua_server::auth_throttle::FailedAuthWindow>,"
        ),
        "B-2 WIRE INVARIANT VIOLATED: src/opc_ua_sens_auth_manager.rs \
         `SensAuthManager::new` signature does not require \
         `throttle: Arc<...FailedAuthWindow>`. A throttle-less constructor \
         would let a future caller bypass the brute-force defense."
    );
}

/// **Phase B-2 / Batch #270 (authenticate path consults throttle):** the
/// `authenticate_username_identity_token` body MUST call
/// `peek_decision` BEFORE running the validator AND `record_failure`
/// on every error path AND `clear_on_success` on the success path.
/// A regression that drops any of these collapses the brute-force
/// defense semantics.
#[test]
fn b2_authenticate_consults_throttle() {
    let src = read_source("src/opc_ua_sens_auth_manager.rs");
    assert!(
        src.contains("self.throttle.peek_decision("),
        "B-2 GATE INVARIANT VIOLATED: src/opc_ua_sens_auth_manager.rs \
         `authenticate_username_identity_token` does not call \
         `self.throttle.peek_decision(...)`. Pre-check before Argon2id \
         is the architectural floor; without it, every failed attempt \
         pays the verifier cost."
    );
    assert!(
        src.contains("self.throttle.record_failure("),
        "B-2 GATE INVARIANT VIOLATED: src/opc_ua_sens_auth_manager.rs \
         does not call `self.throttle.record_failure(...)`. Failure \
         events have no path to advance the counter — throttle never \
         engages."
    );
    assert!(
        src.contains("self.throttle.clear_on_success("),
        "B-2 GATE INVARIANT VIOLATED: src/opc_ua_sens_auth_manager.rs \
         does not call `self.throttle.clear_on_success(...)`. Operator \
         typos that succeed on retry would carry stale failure history \
         into the next typing burst."
    );
}

/// **Phase B-2 / Batch #270 (audit-sink emit on Throttled decision):** the
/// `OpcUaAuthThrottled` AuditAction MUST be emitted via
/// `try_emit_mtls_forensic_event` from the SensAuthManager throttle
/// path. Forensic post-mortem queryability for brute-force attempts;
/// the cross-cutting audit-sink chain (ADR-020) anchors the throttle
/// events alongside MtlsHandshakeRejectStrict + OpcUaCertTrusted.
#[test]
fn b2_throttle_emits_opc_ua_auth_throttled_audit() {
    let src = read_source("src/opc_ua_sens_auth_manager.rs");
    assert!(
        src.contains("AuditAction::OpcUaAuthThrottled"),
        "B-2 AUDIT EMIT INVARIANT VIOLATED: src/opc_ua_sens_auth_manager.rs \
         does not reference `AuditAction::OpcUaAuthThrottled`. The \
         throttle path must emit through the ADR-020 audit-sink HMAC \
         chain so brute-force forensic queries surface in offline \
         `audit-verify` runs."
    );
}

/// **Phase B-2 / Batch #269 (AuditAction wire-tag stability):** the
/// `OpcUaAuthThrottled` variant MUST exist on the AuditAction enum +
/// hold its assigned wire_tag (35). Wire stability is the
/// canonical-bytes invariant per `audit/entry.rs` doc comment.
#[test]
fn b2_audit_action_variant_present_with_stable_wire_tag() {
    let src = read_source("src/audit/entry.rs");
    assert!(
        src.contains("OpcUaAuthThrottled"),
        "B-2 AUDIT WIRE INVARIANT VIOLATED: src/audit/entry.rs does \
         not declare the `OpcUaAuthThrottled` variant on AuditAction. \
         The throttle emit has no canonical action discriminator."
    );
    assert!(
        src.contains("Self::OpcUaAuthThrottled => 35"),
        "B-2 AUDIT WIRE INVARIANT VIOLATED: src/audit/entry.rs does \
         not pin `OpcUaAuthThrottled.wire_tag()` to 35. Re-numbering \
         would invalidate every historical audit-chain entry's HMAC \
         linkage."
    );
}

/// **Phase B-2 / Batch #270 (production boot wires throttle from config):**
/// `init_opc_ua_server` MUST construct `FailedAuthWindow` from
/// `config.max_failed_auth_per_60s` AND pass it into
/// `SensAuthManager::new`. A regression that hardcodes the cap to a
/// constant would silently bypass operator-tunable throttling.
#[test]
fn b2_boot_wires_throttle_from_config() {
    let src = read_source("src/opc_ua_server_runtime.rs");
    assert!(
        src.contains("FailedAuthWindow::new(")
            && src.contains("config.max_failed_auth_per_60s"),
        "B-2 BOOT WIRE INVARIANT VIOLATED: src/opc_ua_server_runtime.rs \
         init path does not construct `FailedAuthWindow::new(config.max_failed_auth_per_60s)`. \
         The operator-tunable cap is the architectural contract — \
         hardcoding bypasses runtime tuning."
    );
}

/// **Phase B-2 / Batch #269 (auth_throttle submodule declaration):**
/// `opc_ua_server.rs` MUST declare `pub mod auth_throttle;` so Rust
/// resolves the new file. A regression that removes the declaration
/// orphans the file (compile-time absent from the binary).
#[test]
fn b2_auth_throttle_submodule_declared() {
    let src = read_source("src/opc_ua_server.rs");
    assert!(
        src.contains("pub mod auth_throttle;"),
        "B-2 SUBMODULE WIRE INVARIANT VIOLATED: src/opc_ua_server.rs \
         does not declare `pub mod auth_throttle;`. The auth_throttle.rs \
         file is orphaned — compile-time absent from the binary."
    );
}
