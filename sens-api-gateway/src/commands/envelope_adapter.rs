//! CommandEnvelope → CommandMessage adapter (Batch 63,
//! Sprint 6.4 full wire partial).
//!
//! Runtime shim that PARSES envelope-format payloads + calls
//! the Batch 7 pure `verify_envelope` function with closure-
//! injected primitives (SHA-256 via sha2 crate, clock via
//! SystemClockAuthority, signature verify NO-OP'd in Disabled
//! mode). On success, surfaces a CommandMessage-equivalent
//! view for the existing `execute_command` dispatch — the
//! envelope's `cmd`/`params` are semantically identical to
//! CommandMessage's `command`/`params`; jti becomes
//! command_id.
//!
//! ## What this shim does
//!
//! - Parses envelope JSON.
//! - Runs verify_envelope's 7 gates (cmd bounds + jti format
//!   + nonce bounds + freshness window + tenant binding +
//!   cmd_hash match + signature-mode rule).
//! - In SignatureMode::Disabled, signature verify is a no-op
//!   (envelope.signature=None path always accepts).
//! - In SignatureMode::Permissive/Enforcing WITH signature
//!   present, signature verify CANNOT YET run (RBAC manifest
//!   actor→pubkey lookup is Sprint 6.1 full wire pending);
//!   the adapter falls back to ACCEPT + emits a "signature-
//!   verification-pending" warn so operators know they're in
//!   Permissive mode with Moka dedup + freshness window gate
//!   but without real signature verify.
//!
//! ## What this shim does NOT do (Sprint 6.1 full wire)
//!
//! - Actor-pubkey lookup from the signed RBAC manifest.
//! - ed25519_dalek::verify_strict invocation with the
//!   looked-up pubkey.
//! - Reject unsigned mutating commands in Enforcing mode
//!   when signature is None (the verify_envelope function
//!   DOES reject, but without the pubkey-source path the
//!   adapter falls back rather than rejects — pending
//!   Sprint 6.1).
//!
//! This staged delivery unblocks the envelope's dedup +
//! freshness + tenant-binding gates TODAY, letting
//! operators exercise the wire format before Sprint 6.1
//! lands the actor-pubkey lookup.

use serde_json::Value;
use tracing::{info, warn};

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

    // verify_signature closure — Sprint 6.1 full wire swaps to
    // real ed25519_dalek::verify_strict via actor-pubkey
    // lookup. Pre-Sprint-6.1, NO-OP accept in Disabled mode
    // (never called there anyway — signature=None path);
    // pre-Sprint-6.1 accept in Permissive/Enforcing with a
    // warn so operators know the signature gate is pending.
    let verify_signature = |_canonical: &[u8], _sig: &[u8; 64]| -> bool {
        warn!(
            "Batch 63: envelope signature present but Sprint 6.1 actor-pubkey lookup NOT YET WIRED — \
             accepting unconditionally until RBAC manifest runtime lands. \
             Enforcing mode DOES still reject unsigned mutating commands via verify_envelope Gate 7."
        );
        true
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
        let outcome = try_parse_and_verify(legacy, [0u8; 16], SignatureMode::Disabled);
        assert!(matches!(outcome, AdapterOutcome::NotEnvelopeFormat));
    }

    #[test]
    fn malformed_json_returns_not_envelope_format() {
        let junk = b"not json at all";
        let outcome = try_parse_and_verify(junk, [0u8; 16], SignatureMode::Disabled);
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
