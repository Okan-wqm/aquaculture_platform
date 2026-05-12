// BATCH-001-CI-FIX-015: pre-staged types for Sprint 6.1-6.8 runtime wiring.
// Re-exports are intentionally unused until the runtime consumers land.
#![allow(unused_imports)]

//! # Audit — append-only signed audit log (ADR-020)
//!
//! The audit module is the edge agent's **primary forensic surface**. Every
//! regulated action (command execution, RBAC manifest change, force_value,
//! firmware deploy, safe-state trigger, PII field access) emits a pre-execution
//! audit entry AND a post-execution audit entry. Entries are chained via
//! HMAC-SHA256 so tamper is structurally detectable offline by the
//! `audit-verify` CLI (Sprint 6.2).
//!
//! ## Architectural position
//!
//! | Layer | Concern | File |
//! |-------|---------|------|
//! | 1. AuditEntry data model | What fields belong in one audit record | [`entry`] |
//! | 2. Canonical bytes | Deterministic serialization for HMAC input | [`entry`] `AuditEntry::canonical_bytes` |
//! | 3. HMAC chain | `prev_hmac || entry_bytes -> current_hmac` | [`chain`] |
//! | 4. Sink / rotation | `/var/log/suderra/audit.log` append + fsync | Sprint 6.2 `sink.rs` |
//! | 5. Cloud relay | MQTT `edge/{device_id}/audit` publish | Sprint 6.2 `relay.rs` |
//! | 6. audit-verify CLI | Offline chain integrity re-compute | Sprint 6.2 `cli_verify.rs` |
//!
//! Batch 6 delivers layers 1-3 as pure types + one pure function (HMAC chain
//! append signature with closure-injected HMAC computation). Runtime sink +
//! relay + CLI land in Sprint 6.2.
//!
//! ## Why HMAC chain (not plain signatures)?
//!
//! A per-entry signature would require an online HSM call per event — 100us
//! ARM cost × N hundred events/day = operational friction. HMAC-SHA256 with
//! a master-derived chain key (`KeyPurpose::AuditHmacChain` per Batch 4b) gives
//! O(1) append + tamper-evident chain in O(N) offline verify. Cloud-side
//! correlation with a daily ed25519-signed anchor (ADR-020 §4) gives
//! non-repudiation for regulatory audit.
//!
//! ## Cross-references
//!
//! - ADR-020 §1 Pre+Post audit entry pattern
//! - ADR-020 §2 Master-key-derived HMAC chain
//! - ADR-020 §3 Canonical bytes length-prefix framing (same discipline as Batch 4b/5b)
//! - ADR-020 §4 Daily ed25519 anchor (cloud-side, not edge-side)
//! - ADR-020 §6 Append-only `/var/log/suderra/audit.log` + fsync
//! - Batch 4b `KeyPurpose::AuditHmacChain` hkdf info string

pub mod chain;
pub mod entry;
// Batch 74 Sprint 6.2 Phase 2: runtime sink — file append +
// HMAC chain state + NDJSON serialization. Chain recovery on
// restart (Batch 75) + SIGHUP rotation (Batch 76) land in the
// same module. Cloud relay is follow-up.
pub mod sink;
// Batch 77 Sprint 6.2 Phase 2: offline chain verification —
// pure read + recompute HMAC + linkage assertion. Consumed by
// the `--audit-verify` CLI flag in main.rs + external
// auditors.
pub mod verify;

pub use chain::{
    CurrentHmac, HmacChainEntry, HmacChainError, PrevHmac, append_entry, compose_hmac_input,
};

pub use sink::{AuditHmacKey, AuditSink, AuditSinkError};

pub use verify::{VerifyInput, VerifyOutcome, verify_audit_log};

pub use entry::{
    AuditAction, AuditActor, AuditEntry, AuditEntryCanonicalBytesError, AuditOutcome, AuditPhase,
    AuditResource, MAX_ACTOR_LABEL_BYTES, MAX_CORRELATION_ID_BYTES, MAX_DETAIL_BYTES,
};

// =====================================================================
// Phase 1.1.5 / ORPHAN-MEDIUM-036/037 closure — process-global audit
// sink accessor for cross-cutting forensic emit.
// =====================================================================
//
// ## WHY a global accessor instead of struct-injection
//
// Most audit emits originate inside command-handler code paths that
// already carry an `Arc<AppState>` reference; those paths reach the
// sink via `state.audit_sink.as_ref()` and there is no need for a
// global. The Phase 1.1.5 ORPHAN-MEDIUM-036/037 closure surfaces TWO
// emit sites where AppState is structurally unreachable:
//
// 1. `SuderraServerCertVerifier::verify_server_cert` — invoked by
//    rustls inside the TLS handshake state machine, no AppState/
//    AsyncRuntime access. Threading `Arc<AuditSink>` through
//    `MtlsVerifierState::new` + `build_suderra_verifier` +
//    `MqttClient::new` would require mutating five public function
//    signatures + every test fixture — and the verifier is ALSO
//    constructed in test contexts that have no AuditSink. The result
//    would be `Option<Arc<AuditSink>>` plumbed through every layer
//    with `None` in 90% of callsites.
//
// 2. `mqtt.rs::configure_tls` — runs inside `MqttClient::new` BEFORE
//    the MqttClient stores any `Arc<AppState>` reference. The CA
//    bundle parse loop has no obvious carrier for the sink without
//    the same five-layer surgery as (1).
//
// A process-global accessor is the cleanest architectural shape for
// these two surfaces. It mirrors the `tracing::Subscriber` /
// `rustls::CryptoProvider::install_default` pattern: the audit sink
// is a cross-cutting concern (every part of the agent might emit)
// installed once at boot. Emit sites call `current_audit_sink()`,
// which returns `None` in test contexts and `Some(Arc<AuditSink>)`
// after `init_audit_sink` has run.
//
// ## Why `OnceLock` and not `RwLock`
//
// The audit sink is constructed once at boot (`init_audit_sink` in
// `state.rs`) and never replaced. `OnceLock<Arc<AuditSink>>` gives
// lock-free read on the hot path (per-handshake reject, per-CA-parse
// loop) and a single atomic write at install time. Tests that do not
// need audit emit simply do not install — `current_audit_sink()`
// returns `None` and the emit helper short-circuits to `tracing::error!`.
//
// ## Reload semantics
//
// The sink itself supports `reload_hmac_key` for key rotation
// (`AuditSink::reload_hmac_key` in `sink.rs`); the global pointer is
// stable across rotations because the same `Arc<AuditSink>` lives in
// the OnceLock and the sink mutates its own internal state. Replacing
// the sink wholesale (e.g., reopening the underlying file on logrotate)
// would require an explicit `RwLock` instead — Phase 1.1.5 scope is
// the install-once contract, not hot-swap.

use std::sync::{Arc, OnceLock};

use crate::authz::permission::TenantId;

static AUDIT_SINK_GLOBAL: OnceLock<Arc<AuditSink>> = OnceLock::new();

/// Process-global agent tenant identity for forensic audit emit.
///
/// The edge agent is single-tenant per ADR-018: every audit entry
/// carries a `TenantId` field, populated from `AgentConfig.tenant_id`
/// at boot. Command-dispatch paths read `state.config.tenant_id`
/// directly; the cross-cutting forensic-emit surfaces (mTLS handshake
/// reject, CA bundle parse partial) have no AppState access and need
/// a process-global anchor to satisfy the AuditEntry contract.
///
/// Installed alongside the audit sink in `state.rs::init_audit_sink`.
static AUDIT_AGENT_TENANT_GLOBAL: OnceLock<TenantId> = OnceLock::new();

/// Install the process-global audit sink. Called exactly once at boot
/// from `state.rs::init_audit_sink` after the file has opened + the
/// HMAC chain has recovered. Returns `Err(installed)` if the global
/// is already populated — should never happen in production but is
/// surfaced so unit tests that double-init see the failure rather
/// than silent overwrite.
///
/// The `Arc<AuditSink>` returned by `init_audit_sink` is also stored
/// on `AppState.audit_sink` for command-handler paths that already
/// have AppState access; the global is the ALSO-emit channel for
/// surfaces (mTLS handshake reject, CA bundle parse) that do NOT.
pub fn install_global_audit_sink(sink: Arc<AuditSink>) -> Result<(), Arc<AuditSink>> {
    AUDIT_SINK_GLOBAL.set(sink)
}

/// Retrieve the process-global audit sink. Returns `None` if
/// `install_global_audit_sink` has not been called (test contexts,
/// pre-init paths, deployments where audit is disabled). Callers
/// MUST handle `None` gracefully — typically by falling through to
/// `tracing::error!` so the event is at least visible in structured
/// logs.
pub fn current_audit_sink() -> Option<Arc<AuditSink>> {
    AUDIT_SINK_GLOBAL.get().cloned()
}

/// Install the process-global agent tenant identity. Called once at
/// boot from `state.rs::init_audit_sink` after AgentConfig is loaded.
/// Returns `Err(installed)` if already populated.
pub fn install_global_agent_tenant(tenant: TenantId) -> Result<(), TenantId> {
    AUDIT_AGENT_TENANT_GLOBAL.set(tenant)
}

/// Retrieve the process-global agent tenant. Returns `None` if
/// `install_global_agent_tenant` has not been called. Forensic-emit
/// helpers fall back to a zero-tenant placeholder so the AuditEntry
/// can still be appended (chain integrity is the security boundary;
/// the tenant field on a pre-init forensic event is informational).
pub fn current_agent_tenant() -> Option<TenantId> {
    AUDIT_AGENT_TENANT_GLOBAL.get().copied()
}

/// Build an [`AuditEntry`] for a cross-cutting forensic-surface event
/// and emit it via the process-global audit sink + tracing as
/// defense-in-depth.
///
/// Calling pattern at the cross-cutting emit sites — any code path
/// that needs to emit an audit-chain entry without an AppState reference:
/// - Strict-mode handshake reject in [`crate::mtls::SuderraServerCertVerifier`].
/// - Custom CA bundle partial parse in [`crate::mqtt::MqttClient::configure_tls`].
/// - OPC UA `PkiStore` mutations (cert trusted, cert revoked, phase
///   transition).
///
/// All these sites have NO command-correlation-id (the events are not
/// tied to an inbound MQTT command); the helper synthesizes a UUIDv4 so
/// the `correlation_id` REQUIRED-field invariant of
/// `AuditEntry::canonical_bytes` is satisfied. Operators correlate the
/// synthesized id with the associated `tracing::error!` line by
/// timestamp + label.
///
/// **Function name retained for `mtls` prefix despite generic intent**
/// — the original Phase 1.1.5 closure named it specifically; renaming
/// would churn 4+ callsites + 4 invariant assertions for marginal
/// value. The doc comment establishes the intent (forensic surface,
/// not mTLS-specific) so future readers don't think this function is
/// scoped to mTLS only.
///
/// Failure handling — audit emission MUST NOT abort the caller's
/// security path. If the sink rejects the entry (chain-failed,
/// write-failed, lock-poisoned), the helper logs `tracing::error!` with
/// the structured fields and returns `Ok(())` to the caller. The
/// handshake-abort or boot-fail-fast surface remains the primary
/// security action; audit is forensic post-mortem.
pub fn try_emit_mtls_forensic_event(
    action: AuditAction,
    label: &str,
    detail_json: serde_json::Value,
) {
    // Tenant resolution: prefer the installed global; fall back to a
    // zero-tenant placeholder so a pre-init test fixture can still
    // exercise the helper. The tenant field is informational on
    // forensic events — the chain HMAC + the action discriminator are
    // the load-bearing fields.
    let tenant = current_agent_tenant().unwrap_or_else(|| TenantId::new_from_verified([0u8; 16]));
    let Some(sink) = current_audit_sink() else {
        // Test / pre-init context — emit through tracing as the only
        // available channel. Operators reading structured logs still
        // see the event with `target=audit.mtls.forensic`.
        tracing::error!(
            target: "audit.mtls.forensic",
            audit_sink_installed = false,
            action = ?action,
            label = label,
            detail = %detail_json,
            "mTLS forensic event suppressed: global audit sink not installed"
        );
        return;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok();
    let (ts_secs, ts_nanos) = match now {
        Some(d) => (d.as_secs() as i64, d.subsec_nanos()),
        None => (0, 0),
    };
    let detail = detail_json.to_string();
    let truncated_detail = if detail.len() > MAX_DETAIL_BYTES {
        // Defense-in-depth — sink will reject on canonical_bytes.
        // Truncate at the boundary to keep the event in the chain
        // even when the caller emits a verbose payload.
        let mut buf = detail;
        buf.truncate(MAX_DETAIL_BYTES);
        buf
    } else {
        detail
    };
    // System-initiated forensic event — no authenticated actor. Use a
    // short code-constant label per `AuditActor::new` doc-comment.
    let actor = AuditActor::new("system:mtls.forensic");
    // Generate a synthetic correlation_id that is short + UUIDv4-like so
    // operators can grep both the audit-log entry and the paired
    // `tracing::error!` line by the same id. uuid crate is already a
    // workspace dependency for envelope JTI generation.
    let correlation_id = uuid::Uuid::new_v4().to_string();
    let entry = AuditEntry {
        timestamp_unix_secs: ts_secs,
        timestamp_nanos: ts_nanos,
        correlation_id,
        phase: AuditPhase::Post,
        actor,
        tenant,
        policy_version: 0, // Forensic events are not policy-scoped.
        two_person_integrity_verified: false,
        action,
        resource: AuditResource::Other {
            label: label.to_string(),
        },
        outcome: AuditOutcome::Failure, // Both sites emit on a reject/partial-load failure path.
        detail: truncated_detail,
    };
    match sink.append(entry) {
        Ok(seq) => {
            tracing::info!(
                target: "audit.mtls.forensic",
                action = ?action,
                label = label,
                sequence = seq,
                "mTLS forensic event emitted to audit chain"
            );
        }
        Err(e) => {
            tracing::error!(
                target: "audit.mtls.forensic",
                action = ?action,
                label = label,
                error = %e,
                "mTLS forensic audit emit FAILED — sink rejected entry"
            );
        }
    }
}
