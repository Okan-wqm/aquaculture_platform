//! CommandEnvelope → CommandMessage adapter (Batch 68
//! Sprint 6.1 FULL WIRE).
//!
//! Runtime shim that PARSES envelope-format payloads + calls
//! the Batch 7 pure `verify_envelope` function with closure-
//! injected primitives (SHA-256 via sha2 crate, clock via
//! SystemClockAuthority, signature verify via ed25519_dalek
//! + RbacManifestStore::lookup_operator_pubkey). On success,
//! surfaces a CommandMessage-equivalent view for the existing
//! `execute_command` dispatch — the envelope's `cmd`/`params`
//! are semantically identical to CommandMessage's
//! `command`/`params`; jti becomes command_id.
//!
//! ## What this shim does
//!
//! - Parses envelope JSON.
//! - Runs verify_envelope's 7 gates (cmd bounds + jti format
//!   + nonce bounds + freshness window + tenant binding +
//!   cmd_hash match + signature-mode rule).
//! - In SignatureMode::Disabled, signature verify closure is
//!   never invoked (verify_envelope's signature-mode gate
//!   short-circuits on signature=None).
//! - In SignatureMode::Permissive/Enforcing WITH signature
//!   present, the verify closure looks up the operator's
//!   ed25519 pubkey in the RBAC manifest store (Batch 67) +
//!   invokes `ed25519_dalek::VerifyingKey::verify_strict`.
//!   On lookup miss OR signature-verify fail, verify returns
//!   false → verify_envelope fails Gate 7 → envelope
//!   rejected.
//!
//! ## Permissive vs Enforcing behavioral parity
//!
//! The signature closure ALWAYS returns the truthful verify
//! result (not a hardcoded accept). Mode gating lives in
//! `verify_envelope`'s Gate 7: Permissive mode with
//! signature=None is accepted; Enforcing mode with
//! signature=None is rejected. With signature=Some, BOTH
//! modes run the real verify; a forged sig fails identically
//! in both — which matches the IEC 62443 SL-2 discipline
//! (Permissive ≠ "accept forged", Permissive = "unsigned OK
//! during rollout").

use serde_json::Value;
use tracing::{info, warn};

use crate::authz::manifest_runtime::RbacManifestStore;
use crate::authz::permission::OperatorId;
use crate::command_envelope::envelope::SignatureMode;
use crate::command_envelope::{CommandEnvelope, EnvelopeVerifyError};

/// Adapter output — the fields execute_command needs to
/// dispatch a verified envelope payload.
pub(super) struct AdaptedCommand {
    pub command_id: String,
    pub command: String,
    pub params: Value,
    pub timestamp: String,
}

/// Decision from `try_parse_and_verify`.
pub(super) enum AdapterOutcome {
    /// Payload was not envelope-format; caller falls back to
    /// legacy CommandMessage parse.
    NotEnvelopeFormat,
    /// Envelope parsed + verified. Dispatch via AdaptedCommand.
    Verified(AdaptedCommand),
    /// Envelope parsed but verify failed. Caller rejects the
    /// command + logs the reason.
    VerifyFailed(EnvelopeVerifyError),
}

/// Attempt to parse + verify a CommandEnvelope payload.
///
/// INPUTS:
/// - `payload` — raw MQTT message bytes.
/// - `expected_tenant` — [u8; 16] from provisioning-bound
///   AppState.tenant_id. None = provisioning incomplete →
///   adapter falls back to legacy parse.
/// - `mode` — SignatureMode from config.
/// - `rbac_store` — AppState.rbac_manifest_store (Batch 68).
///   Empty-store (Disabled mode OR Permissive load-failure)
///   returns None from lookup_operator_pubkey → signature
///   verify closure returns false → Gate 7 rejects.
///
/// OUTPUT:
/// - AdapterOutcome::NotEnvelopeFormat if JSON doesn't parse
///   as CommandEnvelope.
/// - AdapterOutcome::Verified(cmd) if envelope verifies.
/// - AdapterOutcome::VerifyFailed(err) if envelope parsed but
///   verify rejected.
pub(super) fn try_parse_and_verify(
    payload: &[u8],
    expected_tenant: [u8; 16],
    mode: SignatureMode,
    rbac_store: &RbacManifestStore,
) -> AdapterOutcome {
    let env: CommandEnvelope = match serde_json::from_slice(payload) {
        Ok(e) => e,
        Err(_) => {
            // Parse failed — either legacy CommandMessage OR
            // malformed. Fall back.
            return AdapterOutcome::NotEnvelopeFormat;
        }
    };

    // compute_cmd_hash closure — sha2 crate applied to canonical_params bytes.
    let compute_cmd_hash = |canonical: &[u8]| -> [u8; 32] {
        use sha2::{Digest, Sha256};
        Sha256::digest(canonical).into()
    };

    // verify_signature closure — Batch 68 Sprint 6.1 full
    // wire. Looks up the operator's ed25519 pubkey in the
    // RBAC manifest store (Batch 67) + runs
    // `VerifyingKey::verify_strict` on canonical_params.
    //
    // FAIL-CLOSED DISCIPLINE:
    // - Empty store (Disabled mode never invokes this
    //   closure; Permissive load-failure → empty store →
    //   lookup miss → false → Gate 7 rejects).
    // - Operator not in manifest.operator_bindings → false.
    // - Invalid pubkey bytes → false.
    // - Invalid signature bytes → verify_strict returns Err
    //   → false.
    // - Signature verification fails (forged sig) → false.
    //
    // The closure has NO silent-accept path; every failure
    // mode returns false → verify_envelope Gate 7 rejects →
    // AdapterOutcome::VerifyFailed.
    let actor_bytes = env.actor;
    let verify_signature = |canonical: &[u8], sig_bytes: &[u8; 64]| -> bool {
        let operator_id = OperatorId::new_from_verified(actor_bytes);
        let pk_bytes = match rbac_store.lookup_operator_pubkey(&operator_id) {
            Some(pk) => pk,
            None => {
                warn!(
                    "Envelope signature verify: operator pubkey not in RBAC manifest (actor={:?}) — rejecting",
                    actor_bytes
                );
                return false;
            }
        };
        let pk = match ed25519_dalek::VerifyingKey::from_bytes(&pk_bytes) {
            Ok(k) => k,
            Err(e) => {
                warn!(
                    "Envelope signature verify: manifest pubkey bytes invalid: {} — rejecting",
                    e
                );
                return false;
            }
        };
        let sig = ed25519_dalek::Signature::from_bytes(sig_bytes);
        pk.verify_strict(canonical, &sig).is_ok()
    };

    let now_unix_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    match crate::command_envelope::verify_envelope(
        &env,
        &expected_tenant,
        now_unix_secs,
        mode,
        compute_cmd_hash,
        verify_signature,
    ) {
        Ok(jti) => {
            info!(
                "CommandEnvelope verified: cmd='{}' jti='{}' (mode={:?})",
                env.cmd,
                jti.as_str(),
                mode
            );
            AdapterOutcome::Verified(AdaptedCommand {
                command_id: jti.as_str().to_string(),
                command: env.cmd.clone(),
                params: env.params.clone(),
                // Use envelope's iat as RFC3339-equivalent
                // timestamp. Age-check in handle_message will
                // apply.
                timestamp: chrono::DateTime::<chrono::Utc>::from_timestamp(
                    env.iat_unix_secs,
                    0,
                )
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
            })
        }
        Err(e) => AdapterOutcome::VerifyFailed(e),
    }
}

/// Parse AppState.tenant_id (String UUID form) into [u8; 16]
/// bytes. Returns None when tenant_id is absent or malformed
/// — caller falls back to legacy parse.
pub(super) fn tenant_id_bytes_or_none(tenant_id: Option<&str>) -> Option<[u8; 16]> {
    let s = tenant_id?;
    let uuid = uuid::Uuid::parse_str(s).ok()?;
    Some(*uuid.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_envelope_format_on_legacy_payload() {
        let legacy = br#"{"command_id":"c1","command":"ping","timestamp":"2026-04-21T00:00:00Z","params":{}}"#;
        let store = RbacManifestStore::new();
        let outcome =
            try_parse_and_verify(legacy, [0u8; 16], SignatureMode::Disabled, &store);
        assert!(matches!(outcome, AdapterOutcome::NotEnvelopeFormat));
    }

    #[test]
    fn malformed_json_returns_not_envelope_format() {
        let junk = b"not json at all";
        let store = RbacManifestStore::new();
        let outcome =
            try_parse_and_verify(junk, [0u8; 16], SignatureMode::Disabled, &store);
        assert!(matches!(outcome, AdapterOutcome::NotEnvelopeFormat));
    }

    #[test]
    fn tenant_id_bytes_parses_valid_uuid() {
        let uuid = "fd23af6b-167f-4afd-a62a-ceace2a4046b";
        let bytes = tenant_id_bytes_or_none(Some(uuid));
        assert!(bytes.is_some());
    }

    #[test]
    fn tenant_id_bytes_rejects_invalid_uuid() {
        assert!(tenant_id_bytes_or_none(Some("not-a-uuid")).is_none());
    }

    #[test]
    fn tenant_id_bytes_none_when_absent() {
        assert!(tenant_id_bytes_or_none(None).is_none());
    }
}
