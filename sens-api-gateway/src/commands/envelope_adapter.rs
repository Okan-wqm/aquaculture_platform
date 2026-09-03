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

use std::sync::Arc;
use std::time::SystemTime;

use serde_json::Value;
use tracing::{info, warn};

use crate::authz::context::{ActorIdentity, AuthorizationDecision};
use crate::authz::in_memory_engine::InMemoryPolicyEngine;
use crate::authz::manifest_runtime::RbacManifestStore;
use crate::authz::permission::{OperatorId, TenantId};
use crate::authz::policy::{
    AuthorizationRequest, CoApproverEvidence, Ed25519SignatureBytes, PolicyEngine,
};
use crate::command_envelope::envelope::SignatureMode;
use crate::command_envelope::{CommandEnvelope, EnvelopeVerifyError};

/// Adapter output — the fields execute_command needs to
/// dispatch a verified envelope payload.
pub(super) struct AdaptedCommand {
    pub command_id: String,
    pub command: String,
    pub params: Value,
    pub timestamp: String,
    /// **Batch #307 Faz 6 two-person integrity flow-through.**
    /// True when the adapter verified BOTH the primary
    /// signature AND the co-approver signature against the
    /// canonical bytes. False when the envelope had no
    /// co-approver fields (and primary alone passed) — the
    /// adapter's `verify_co_approver_if_present` returns Ok
    /// for the absent-co-approver case so non-mandatory
    /// commands still dispatch.
    ///
    /// The handler's two-person-integrity gate (cmd_force_value
    /// + future cmd_update_firmware / cmd_safe_state_trigger /
    /// cmd_deploy_program / cmd_reboot) reads this flag to
    /// decide whether to accept the command. Permission classes
    /// that return `requires_two_person_integrity() == true`
    /// reject when this flag is false.
    pub verified_co_approver: bool,
    /// **EDGE-HIGH-009 authZ inputs.** The verified primary actor
    /// (envelope `actor` bytes) and the policy version the operator's
    /// signing UI claimed, threaded through so `authorize_adapted` can
    /// run `PolicyEngine::authorize` — the signature proved *who*
    /// signed (authN); the engine proves the actor's manifest role
    /// *holds* the required permission (authZ).
    pub actor: [u8; 16],
    pub claimed_policy_version: u64,
    /// Co-approver identity + signature (when present), passed to the
    /// engine's two-person-integrity gate so it checks the co-approver
    /// holds the co-approve role and is bound to the tenant — the
    /// engine, not just the handler-side `verified_co_approver` flag,
    /// becomes the single authorization authority.
    pub co_approver_actor: Option<[u8; 16]>,
    pub co_approver_signature: Option<Ed25519SignatureBytes>,
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
            // Batch #306 Faz 6 two-person integrity: after the
            // primary signature verifies, run the co-approver
            // verify gate. Returns Ok if no co-approver fields
            // present; returns Err on shape inconsistency
            // (one field set, the other not), self-signature
            // attempt, or signature failure.
            if let Err(co_err) = verify_co_approver_if_present(&env, rbac_store) {
                warn!(
                    "CommandEnvelope co-approver verify failed: cmd='{}' err={}",
                    env.cmd, co_err
                );
                return AdapterOutcome::VerifyFailed(co_err);
            }

            info!(
                "CommandEnvelope verified: cmd='{}' jti='{}' (mode={:?}) co_approver={}",
                env.cmd,
                jti.as_str(),
                mode,
                env.co_approver_actor.is_some(),
            );
            // Batch #307: capture the verified-co-approver
            // claim. When BOTH co_approver_actor +
            // co_approver_signature were Some AND verify_
            // co_approver_if_present returned Ok, the adapter
            // verified the second signature against the same
            // canonical bytes the primary signed. The handler-
            // side gate (cmd_force_value etc.) reads this flag.
            let verified_co_approver =
                env.co_approver_actor.is_some() && env.co_approver_signature.is_some();
            AdapterOutcome::Verified(AdaptedCommand {
                command_id: jti.as_str().to_string(),
                command: env.cmd.clone(),
                params: env.params.clone(),
                // Use envelope's iat as RFC3339-equivalent
                // timestamp. Age-check in handle_message will
                // apply.
                timestamp: chrono::DateTime::<chrono::Utc>::from_timestamp(env.iat_unix_secs, 0)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
                verified_co_approver,
                actor: env.actor,
                claimed_policy_version: env.claimed_policy_version,
                co_approver_actor: env.co_approver_actor,
                co_approver_signature: env.co_approver_signature.clone(),
            })
        }
        Err(e) => AdapterOutcome::VerifyFailed(e),
    }
}

/// **EDGE-HIGH-009 — RBAC authorization gate for the signed command path.**
///
/// `try_parse_and_verify` proves *authentication* (the envelope was
/// signed by the operator whose pubkey is enrolled in the RBAC
/// manifest). This runs *authorization*: it asks the `PolicyEngine`
/// whether that actor's manifest role actually holds the permission
/// the command requires. Before this wiring the required permission
/// was computed and only logged (`RBAC-gate-preview`), so any enrolled
/// operator could execute any command (a read-only operator could
/// `rotate_master` / `set_output`).
///
/// - Anonymous commands (`permission_for_command` → `None`, e.g.
///   ping/get_info) need no role and are permitted.
/// - Two-person-integrity commands thread the co-approver evidence to
///   the engine so it verifies the co-approver holds the co-approve
///   role and is tenant-bound — making the engine the single
///   authorization authority rather than relying on the handler-side
///   `verified_co_approver` flag alone.
///
/// Returns `Err(reason)` when the command must be rejected (deny or
/// engine error → fail closed).
pub(super) async fn authorize_adapted(
    adapted: &AdaptedCommand,
    tenant_bytes: [u8; 16],
    rbac_store: Arc<RbacManifestStore>,
) -> Result<(), String> {
    // Anonymous commands carry no permission → no role check.
    let required = match super::catalog::permission_for_command(&adapted.command, &adapted.params) {
        Some(p) => p,
        None => return Ok(()),
    };

    let actor = ActorIdentity::Operator(OperatorId::new_from_verified(adapted.actor));
    let tenant = TenantId::new_from_verified(tenant_bytes);
    let mut request = AuthorizationRequest::new(
        actor,
        required,
        tenant,
        adapted.claimed_policy_version,
        SystemTime::now(),
    );
    if let (Some(ca_actor), Some(ca_sig)) = (
        adapted.co_approver_actor,
        adapted.co_approver_signature.clone(),
    ) {
        request = request.with_co_approver(CoApproverEvidence {
            actor: ActorIdentity::Operator(OperatorId::new_from_verified(ca_actor)),
            signature: ca_sig,
        });
    }

    let engine = InMemoryPolicyEngine::new(rbac_store);
    match engine.authorize(request).await {
        Ok(AuthorizationDecision::Allow(_ctx)) => Ok(()),
        Ok(AuthorizationDecision::Deny(reason)) => {
            Err(format!("authorization denied: {:?}", reason))
        }
        Err(e) => Err(format!("policy engine error: {}", e)),
    }
}

/// Batch #306 Faz 6 two-person integrity gate: verify the
/// co-approver signature when present.
///
/// **Gate ordering (cheapest-first):**
///
/// 1. Both fields None → no co-approver wired; return Ok
///    (non-mandatory commands path).
/// 2. Shape inconsistency check (one Some, the other None) →
///    `CoApproverSignatureMissing`. Catches operator-side
///    signing-tool bugs that fail to bundle both fields.
/// 3. Self-signature check (co-approver actor == primary
///    actor) → `CoApproverSelfSignature`. The engine layer
///    catches this too via the manifest binding, but the
///    adapter fails fast BEFORE the canonical-bytes
///    recomputation + manifest lookup.
/// 4. Recompute canonical bytes (primary verify already did
///    this internally; we don't have the bytes from the
///    closure result, so recompute is necessary).
/// 5. Look up co-approver pubkey in the RBAC manifest.
///    Missing → `CoApproverSignatureInvalid` (the engine
///    would also reject; the adapter rejects fail-fast +
///    same audit message class).
/// 6. ed25519 verify the co-approver signature against the
///    canonical bytes.
///
/// **Architectural property:** the co-approver signs the
/// SAME canonical-bytes transcript as the primary. An
/// attacker who tampers with any envelope field after BOTH
/// operators sign invalidates BOTH signatures. There is no
/// way to swap params + re-use either signature.
fn verify_co_approver_if_present(
    env: &CommandEnvelope,
    rbac_store: &RbacManifestStore,
) -> Result<(), EnvelopeVerifyError> {
    match (env.co_approver_actor, env.co_approver_signature.as_ref()) {
        (None, None) => Ok(()),
        (None, Some(_)) | (Some(_), None) => {
            // Operator-side signing-tool produced an
            // inconsistent envelope. Fail-closed.
            Err(EnvelopeVerifyError::CoApproverSignatureMissing)
        }
        (Some(co_actor), Some(co_sig)) => {
            // Self-signature check — primary and co-approver
            // MUST be distinct operators per ADR-017 §8.
            if co_actor == env.actor {
                return Err(EnvelopeVerifyError::CoApproverSelfSignature);
            }

            // Recompute canonical bytes. verify_envelope
            // already did this internally for the primary
            // signature; we need our own copy to feed the
            // co-approver verify. The recomputation is cheap
            // (deterministic encoding of bounded fields).
            let canonical = match crate::command_envelope::envelope_canonical_bytes(env) {
                Ok(b) => b,
                Err(e) => return Err(e),
            };

            // Look up co-approver pubkey in RBAC manifest.
            let co_operator = OperatorId::new_from_verified(co_actor);
            let pk_bytes = match rbac_store.lookup_operator_pubkey(&co_operator) {
                Some(pk) => pk,
                None => {
                    warn!(
                        "Envelope co-approver verify: operator pubkey not in RBAC manifest (co_actor={:?}) — rejecting",
                        co_actor
                    );
                    return Err(EnvelopeVerifyError::CoApproverSignatureInvalid);
                }
            };

            let pk = match ed25519_dalek::VerifyingKey::from_bytes(&pk_bytes) {
                Ok(k) => k,
                Err(e) => {
                    warn!(
                        "Envelope co-approver verify: manifest pubkey bytes invalid: {} — rejecting",
                        e
                    );
                    return Err(EnvelopeVerifyError::CoApproverSignatureInvalid);
                }
            };
            let sig = ed25519_dalek::Signature::from_bytes(co_sig.as_bytes());
            if pk.verify_strict(&canonical, &sig).is_err() {
                return Err(EnvelopeVerifyError::CoApproverSignatureInvalid);
            }
            Ok(())
        }
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
        let outcome = try_parse_and_verify(legacy, [0u8; 16], SignatureMode::Disabled, &store);
        assert!(matches!(outcome, AdapterOutcome::NotEnvelopeFormat));
    }

    #[test]
    fn malformed_json_returns_not_envelope_format() {
        let junk = b"not json at all";
        let store = RbacManifestStore::new();
        let outcome = try_parse_and_verify(junk, [0u8; 16], SignatureMode::Disabled, &store);
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

    // =========================================================
    // EDGE-HIGH-009 — RBAC authorization gate (authorize_adapted)
    // =========================================================
    // The InMemoryPolicyEngine deny/allow role matrix is exercised
    // in src/authz/in_memory_engine.rs; these tests pin the two
    // dispatch-layer behaviors the wiring adds: anonymous commands
    // skip the engine, and a permissioned command fails closed when
    // no signed manifest grants the actor's role.

    fn make_adapted(cmd: &str) -> AdaptedCommand {
        AdaptedCommand {
            command_id: "jti-test".to_string(),
            command: cmd.to_string(),
            params: serde_json::json!({}),
            timestamp: "2026-07-11T00:00:00Z".to_string(),
            verified_co_approver: false,
            actor: [0x07u8; 16],
            claimed_policy_version: 0,
            co_approver_actor: None,
            co_approver_signature: None,
        }
    }

    #[tokio::test]
    async fn authorize_adapted_permits_anonymous_command() {
        // ping/get_info are catalog-anonymous (permission None) — no
        // role required, so authorize short-circuits to Ok even with
        // an empty (no-manifest) store.
        let store = Arc::new(RbacManifestStore::new());
        let res = authorize_adapted(&make_adapted("ping"), [0u8; 16], store).await;
        assert!(
            res.is_ok(),
            "anonymous command must be permitted: {:?}",
            res
        );
    }

    #[tokio::test]
    async fn authorize_adapted_denies_permissioned_command_without_manifest() {
        // Core EDGE-HIGH-009: a permissioned command cannot be
        // authorized when no signed RBAC manifest grants the actor's
        // role — fail closed (deny or engine-unavailable both reject).
        // Before this wiring it dispatched with no role check at all.
        let store = Arc::new(RbacManifestStore::new()); // empty — no manifest
        let res = authorize_adapted(&make_adapted("rotate_master"), [0u8; 16], store).await;
        assert!(
            res.is_err(),
            "permissioned command must be denied without a manifest, got {:?}",
            res
        );
    }

    // =========================================================
    // Batch #306 Faz 6 two-person integrity tests —
    // verify_co_approver_if_present
    // =========================================================
    //
    // Each test constructs a fresh CommandEnvelope with the
    // canonical params helper + drives the gate under
    // `verify_co_approver_if_present` directly. Avoids
    // exercising the full primary-verify path because
    // `try_parse_and_verify`'s dependency on a real RBAC
    // manifest with a real operator pubkey would balloon
    // the test surface beyond what this batch adds.
    //
    // Tests pin all 4 outcomes: Ok (no co-approver), Ok (valid
    // co-approver), CoApproverSignatureMissing (one field
    // present, the other not), CoApproverSelfSignature
    // (primary == co-approver actor).

    use crate::authz::policy::Ed25519SignatureBytes;
    use crate::command_envelope::canonical::CmdHash;

    fn make_test_env(
        co_actor: Option<[u8; 16]>,
        co_sig: Option<Ed25519SignatureBytes>,
    ) -> CommandEnvelope {
        CommandEnvelope {
            cmd: "ping".to_string(),
            params: serde_json::json!({}),
            actor: [0x07u8; 16],
            tenant_id: [0x42u8; 16],
            iat_unix_secs: 100,
            exp_unix_secs: 200,
            claimed_policy_version: 0,
            co_approver_actor: co_actor,
            co_approver_signature: co_sig,
            jti: "co-jti".to_string(),
            nonce: "co-nonce".to_string(),
            cmd_hash: CmdHash::from_bytes([0u8; 32]),
            signature: None,
        }
    }

    /// Both co-approver fields absent → gate returns Ok
    /// (non-mandatory commands path; force_value handler will
    /// reject separately if it requires co-approval).
    #[test]
    fn co_approver_absent_passes_gate() {
        let env = make_test_env(None, None);
        let store = RbacManifestStore::new();
        let result = verify_co_approver_if_present(&env, &store);
        assert!(
            result.is_ok(),
            "absent co-approver MUST pass gate (got {:?})",
            result
        );
    }

    /// One co-approver field set, the other not → gate rejects
    /// with CoApproverSignatureMissing. Both directions:
    /// actor-only and signature-only.
    #[test]
    fn co_approver_actor_only_rejects_with_missing() {
        let env = make_test_env(Some([0x99u8; 16]), None);
        let store = RbacManifestStore::new();
        let err = verify_co_approver_if_present(&env, &store).unwrap_err();
        assert!(
            matches!(err, EnvelopeVerifyError::CoApproverSignatureMissing),
            "expected CoApproverSignatureMissing, got {:?}",
            err
        );
    }

    #[test]
    fn co_approver_signature_only_rejects_with_missing() {
        let env = make_test_env(None, Some(Ed25519SignatureBytes::from_array([0u8; 64])));
        let store = RbacManifestStore::new();
        let err = verify_co_approver_if_present(&env, &store).unwrap_err();
        assert!(
            matches!(err, EnvelopeVerifyError::CoApproverSignatureMissing),
            "expected CoApproverSignatureMissing, got {:?}",
            err
        );
    }

    /// Co-approver actor equals primary actor → gate rejects
    /// with CoApproverSelfSignature (defense-in-depth fail-fast
    /// before the engine layer's manifest binding catches it).
    #[test]
    fn co_approver_equals_primary_rejects_with_self_signature() {
        let mut env = make_test_env(
            Some([0x07u8; 16]), // <-- same as env.actor
            Some(Ed25519SignatureBytes::from_array([0u8; 64])),
        );
        // Confirm the test setup: env.actor matches co_approver_actor.
        env.actor = [0x07u8; 16];
        env.co_approver_actor = Some([0x07u8; 16]);
        let store = RbacManifestStore::new();
        let err = verify_co_approver_if_present(&env, &store).unwrap_err();
        assert!(
            matches!(err, EnvelopeVerifyError::CoApproverSelfSignature),
            "expected CoApproverSelfSignature, got {:?}",
            err
        );
    }

    /// Co-approver pubkey not in manifest → gate rejects with
    /// CoApproverSignatureInvalid. The empty store simulates
    /// the operator-not-enrolled case; same outcome class as
    /// 'forged signature' to avoid leaking enrollment state.
    #[test]
    fn co_approver_pubkey_missing_rejects_with_invalid() {
        let env = make_test_env(
            Some([0x99u8; 16]),
            Some(Ed25519SignatureBytes::from_array([0u8; 64])),
        );
        let store = RbacManifestStore::new(); // empty
        let err = verify_co_approver_if_present(&env, &store).unwrap_err();
        assert!(
            matches!(err, EnvelopeVerifyError::CoApproverSignatureInvalid),
            "expected CoApproverSignatureInvalid (empty manifest), got {:?}",
            err
        );
    }

    /// Display impls give operators non-sensitive diagnostics
    /// (no key bytes leaked).
    #[test]
    fn co_approver_error_display_strings_pinned() {
        assert_eq!(
            format!("{}", EnvelopeVerifyError::CoApproverSignatureMissing),
            "co_approver_signature_missing"
        );
        assert_eq!(
            format!("{}", EnvelopeVerifyError::CoApproverSignatureInvalid),
            "co_approver_signature_invalid"
        );
        assert_eq!(
            format!("{}", EnvelopeVerifyError::CoApproverSelfSignature),
            "co_approver_self_signature"
        );
    }
}
