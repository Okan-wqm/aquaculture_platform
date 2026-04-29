//! OPC UA user-token validator — composes [`UserTokenManifestStore`]
//! hot-reload atom + the Batch #242 [`UserTokenEnrollment`] primitive
//! to mint typed [`AuthenticatedUser`] values (Batch #245, Gap A-3b
//! part 2).
//!
//! ## Role
//!
//! The async-opcua server's `UserTokenValidator` callback runs at
//! session-establish time for every incoming client. It receives the
//! attacker-visible credentials (`(username, password)` or an
//! x509 client cert) and must return either a typed "authenticated"
//! principal or a fail-closed rejection. This module owns the
//! mapping:
//!
//! ```text
//! (raw_username, Secret<Vec<u8>>)      → AuthenticatedUser::UserPass
//! (verified_cn, presented_trust_anchor) → AuthenticatedUser::X509
//! ```
//!
//! Anonymous sessions DO NOT reach this validator — the typed-authz
//! chain (Batch #241 `TypedAuthzPort`) rejects
//! `AuthenticatedUser::anonymous()` before the engine ever sees it,
//! and Batch A-2c's custom NodeManager fails-closed at session-open
//! when `UserIdentityToken::Anonymous` is configured off. Plumbing
//! anonymous through this module would be a Tier-4 mistake (make it
//! impossible → don't provide a "succeeds on anonymous" path at all).
//!
//! ## Hot-reload semantics
//!
//! Every `validate_*` call reads the store's cached enrollment under
//! an RwLock read guard. A concurrent `ingest_verified` (MQTT
//! update_user_token_manifest → verify_user_token_manifest →
//! store.ingest_verified — Batch #246) swaps the cache atomically.
//! Validator callers see EITHER the old enrollment (if they acquired
//! the read guard before the writer) or the new enrollment — never a
//! torn read. No explicit cache invalidation, no restart, no
//! version-aware lookup on the hot path.
//!
//! ## Tier-1 seal composition
//!
//! Success paths call `AuthenticatedUser::user_pass(op)` and
//! `::x509(cn, op)` — both `pub(crate)` ctors from Batch #239 defined
//! on the sealed newtype. External modules cannot bypass this
//! validator to mint an `AuthenticatedUser` from a raw string; the
//! compile-time seal (Batch #240 invariant test) enforces that.
//! Composition: wire credentials → this validator → sealed
//! AuthenticatedUser → Batch #241 typed authz → Batch A-2b custom
//! NodeManager write path. Every hop is typed.
//!
//! ## Error-taxonomy non-leakage
//!
//! [`UserTokenValidatorError`] collapses "unknown username" and
//! "wrong password" into a single `CredentialMismatch` variant —
//! same enumeration defense as the Batch #242 `verify_user_pass`
//! primitive. X.509 paths surface `X509IssuerNotEnrolled` vs
//! `X509TrustAnchorMismatch` as distinct variants because X.509
//! identity is embedded in the cert (not a secret) and an operator
//! diagnosing a cert-trust issue needs to know which leg failed.

// Validator + error enum are primitive-stage infrastructure: the
// live consumer (Batch A-2b custom NodeManager) lands in a follow-up
// batch and will reference every method + variant. Until then the
// dead-code warning would bury the legitimate audit signal.
#![allow(dead_code)]

use secrecy::Secret;

use crate::authz::user_token_manifest_runtime::UserTokenManifestStore;
use crate::opc_ua_server_session::{AuthenticatedUser, MachineIssuerCn};
use crate::opc_ua_server_user_tokens::UserTokenError;

use std::sync::Arc;

/// Adapter that takes raw OPC UA credentials and produces typed
/// [`AuthenticatedUser`] values. Composes the
/// [`UserTokenManifestStore`] atom read-path with the
/// [`crate::opc_ua_server_user_tokens::UserTokenEnrollment`]
/// verification primitives.
///
/// Shared behind `Arc<>` because the async-opcua server handoff is
/// async + multi-threaded.
pub struct UserTokenValidator {
    store: Arc<UserTokenManifestStore>,
}

impl UserTokenValidator {
    /// Construct a validator over a shared store.
    pub fn new(store: Arc<UserTokenManifestStore>) -> Self {
        Self { store }
    }

    /// Validate a UserName/Password credential attempt. On success
    /// returns `AuthenticatedUser::user_pass(operator_id)`.
    ///
    /// Failure modes:
    /// - [`UserTokenValidatorError::NoManifestLoaded`] — first boot
    ///   before the cloud pushed an enrollment manifest, or after a
    ///   revocation clear. Surfaces as a distinct variant for
    ///   operator diagnostic — an operator attempting to log in
    ///   BEFORE the first manifest landed needs a different runbook
    ///   than a wrong-password failure.
    /// - [`UserTokenValidatorError::CredentialMismatch`] — unknown
    ///   username OR wrong password (collapsed for enumeration
    ///   defense).
    /// - [`UserTokenValidatorError::BadUsernameFormat`] — the raw
    ///   username failed NFKC + length validation (too short, too
    ///   long, empty after normalization). This is distinct from
    ///   CredentialMismatch because a client sending a zero-length
    ///   username is a protocol-level misbehavior, not a login
    ///   attempt.
    pub fn validate_user_pass(
        &self,
        raw_username: &str,
        password: &Secret<Vec<u8>>,
    ) -> Result<AuthenticatedUser, UserTokenValidatorError> {
        self.store.with_enrollment(|maybe| {
            let enrollment = maybe.ok_or(UserTokenValidatorError::NoManifestLoaded)?;
            match enrollment.verify_user_pass(raw_username, password) {
                Ok(operator_id) => Ok(AuthenticatedUser::user_pass(operator_id)),
                Err(UserTokenError::CredentialMismatch) => {
                    Err(UserTokenValidatorError::CredentialMismatch)
                }
                Err(UserTokenError::UsernameEmpty)
                | Err(UserTokenError::UsernameTooShort { .. })
                | Err(UserTokenError::UsernameTooLong { .. }) => {
                    Err(UserTokenValidatorError::BadUsernameFormat)
                }
                Err(other) => {
                    // The `verify_user_pass` primitive can return
                    // HashFormatInvalid only if a build-time-
                    // validated hash somehow becomes invalid at
                    // runtime — that's an enrollment-build invariant
                    // violation, not an attacker-visible outcome.
                    // Surface as CredentialMismatch to avoid leaking
                    // state-internal details.
                    tracing::error!(
                        "user_token_validator: unexpected verify_user_pass error: {:?}",
                        other
                    );
                    Err(UserTokenValidatorError::CredentialMismatch)
                }
            }
        })
    }

    /// Validate an X.509 machine-issuer credential attempt. The
    /// session layer has already run the cert chain verification;
    /// `cn` is the already-verified CN and `presented_trust_anchor`
    /// is the DER-encoded root the chain terminated at.
    ///
    /// On success returns `AuthenticatedUser::x509(cn, operator_id)`.
    ///
    /// Failure modes:
    /// - [`UserTokenValidatorError::NoManifestLoaded`] — first boot /
    ///   post-clear.
    /// - [`UserTokenValidatorError::X509IssuerNotEnrolled`] — the
    ///   presented CN does not match any enrolled binding.
    /// - [`UserTokenValidatorError::X509TrustAnchorMismatch`] — CN
    ///   matches but the presented trust anchor differs byte-wise
    ///   from the enrolled anchor. Attack signal (same-CN cert
    ///   signed by a different CA).
    pub fn validate_x509(
        &self,
        cn: &MachineIssuerCn,
        presented_trust_anchor_der: &[u8],
    ) -> Result<AuthenticatedUser, UserTokenValidatorError> {
        self.store.with_enrollment(|maybe| {
            let enrollment = maybe.ok_or(UserTokenValidatorError::NoManifestLoaded)?;
            match enrollment.resolve_x509(cn, presented_trust_anchor_der) {
                Ok(operator_id) => Ok(AuthenticatedUser::x509(cn.clone(), operator_id)),
                Err(UserTokenError::X509IssuerNotEnrolled) => {
                    Err(UserTokenValidatorError::X509IssuerNotEnrolled)
                }
                Err(UserTokenError::X509TrustAnchorMismatch) => {
                    Err(UserTokenValidatorError::X509TrustAnchorMismatch)
                }
                Err(other) => {
                    tracing::error!(
                        "user_token_validator: unexpected resolve_x509 error: {:?}",
                        other
                    );
                    Err(UserTokenValidatorError::X509IssuerNotEnrolled)
                }
            }
        })
    }
}

/// Validator-level error taxonomy — distinct from
/// [`UserTokenError`] so the session-establish path can emit
/// appropriately-scoped audit events without leaking enrollment-
/// primitive internals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UserTokenValidatorError {
    /// Store has never ingested a manifest (first boot before cloud
    /// push) OR was explicitly cleared. Fail-closed — no credentials
    /// are enrolled.
    NoManifestLoaded,

    /// Unknown username OR wrong password. Enumeration defense
    /// collapses both into one variant.
    CredentialMismatch,

    /// Username failed NFKC + length validation. Protocol-level
    /// client misbehavior, not a login attempt.
    BadUsernameFormat,

    /// The X.509 CN matched no enrolled binding.
    X509IssuerNotEnrolled,

    /// The X.509 CN matched but the presented trust anchor differs
    /// from the enrolled anchor. Attack signal.
    X509TrustAnchorMismatch,
}

impl std::fmt::Display for UserTokenValidatorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoManifestLoaded => f.write_str("no_manifest_loaded"),
            Self::CredentialMismatch => f.write_str("credential_mismatch"),
            Self::BadUsernameFormat => f.write_str("bad_username_format"),
            Self::X509IssuerNotEnrolled => f.write_str("x509_issuer_not_enrolled"),
            Self::X509TrustAnchorMismatch => f.write_str("x509_trust_anchor_mismatch"),
        }
    }
}

impl std::error::Error for UserTokenValidatorError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::permission::{OperatorId, TenantId};
    use crate::authz::user_token_manifest::{
        UserPassManifestBinding, UserTokenManifest, X509ManifestBinding,
    };
    use crate::opc_ua_server_user_tokens::Argon2idHash;

    fn tenant() -> TenantId {
        TenantId::new_from_verified([0xAA; 16])
    }

    fn op(b: u8) -> OperatorId {
        OperatorId::new_from_verified([b; 16])
    }

    fn cn(s: &str) -> MachineIssuerCn {
        MachineIssuerCn::from_verified_cert_cn(s.into()).unwrap()
    }

    fn canned_der(byte: u8) -> Vec<u8> {
        let mut v = vec![0u8; 256];
        v[0] = byte;
        v
    }

    fn phc(password: &[u8], salt: &str) -> String {
        Argon2idHash::for_test_hash(password, salt)
            .unwrap()
            .as_phc()
            .to_string()
    }

    fn manifest_alice_plus_hmi() -> UserTokenManifest {
        UserTokenManifest {
            policy_version: 1,
            tenant_id: tenant(),
            manifest_valid_from_unix_secs: 1_700_000_000,
            manifest_valid_until_unix_secs: 1_800_000_000,
            user_pass_bindings: vec![UserPassManifestBinding {
                operator_id: op(0x01),
                username_normalized: "alice".to_string(),
                argon2id_phc: phc(b"pw-alice", "c2FsdHNhbHRzYWx0"),
            }],
            x509_bindings: vec![X509ManifestBinding {
                operator_id: op(0x02),
                issuer_cn: "hmi-01".to_string(),
                trust_anchor_der: canned_der(0x30),
            }],
        }
    }

    fn make_validator_with(
        manifest: UserTokenManifest,
    ) -> (Arc<UserTokenManifestStore>, UserTokenValidator) {
        let store = Arc::new(UserTokenManifestStore::new());
        store.ingest_verified(manifest).unwrap();
        let v = UserTokenValidator::new(store.clone());
        (store, v)
    }

    // ========================================================
    // validate_user_pass
    // ========================================================

    #[test]
    fn user_pass_happy_path_returns_authenticated_user_pass() {
        let (_s, v) = make_validator_with(manifest_alice_plus_hmi());
        let result = v.validate_user_pass("alice", &Secret::new(b"pw-alice".to_vec()));
        let user = result.unwrap();
        // Verify the minted AuthenticatedUser carries the right
        // operator_id via its audit-label accessor (the label
        // includes the operator_id hex digest).
        let label = user.audit_label();
        assert!(
            label.contains("user_pass"),
            "audit label should flag variant: {}",
            label
        );
    }

    #[test]
    fn user_pass_wrong_password_surfaces_credential_mismatch() {
        let (_s, v) = make_validator_with(manifest_alice_plus_hmi());
        let err = v
            .validate_user_pass("alice", &Secret::new(b"wrong-password".to_vec()))
            .unwrap_err();
        assert_eq!(err, UserTokenValidatorError::CredentialMismatch);
    }

    #[test]
    fn user_pass_unknown_username_surfaces_credential_mismatch() {
        let (_s, v) = make_validator_with(manifest_alice_plus_hmi());
        let err = v
            .validate_user_pass("mallory", &Secret::new(b"pw-alice".to_vec()))
            .unwrap_err();
        // Same error as wrong-password — enumeration defense.
        assert_eq!(err, UserTokenValidatorError::CredentialMismatch);
    }

    #[test]
    fn user_pass_empty_username_surfaces_bad_format() {
        let (_s, v) = make_validator_with(manifest_alice_plus_hmi());
        let err = v
            .validate_user_pass("", &Secret::new(b"anything".to_vec()))
            .unwrap_err();
        assert_eq!(err, UserTokenValidatorError::BadUsernameFormat);
    }

    #[test]
    fn user_pass_nfkc_match_succeeds() {
        // "ALICE" → NFKC + lowercase → "alice" → hit.
        let (_s, v) = make_validator_with(manifest_alice_plus_hmi());
        let r = v.validate_user_pass("ALICE", &Secret::new(b"pw-alice".to_vec()));
        assert!(r.is_ok());
    }

    #[test]
    fn user_pass_no_manifest_surfaces_no_manifest_loaded() {
        let store = Arc::new(UserTokenManifestStore::new());
        let v = UserTokenValidator::new(store);
        let err = v
            .validate_user_pass("alice", &Secret::new(b"pw-alice".to_vec()))
            .unwrap_err();
        assert_eq!(err, UserTokenValidatorError::NoManifestLoaded);
    }

    // ========================================================
    // validate_x509
    // ========================================================

    #[test]
    fn x509_happy_path_returns_authenticated_user_x509() {
        let (_s, v) = make_validator_with(manifest_alice_plus_hmi());
        let user = v.validate_x509(&cn("hmi-01"), &canned_der(0x30)).unwrap();
        let label = user.audit_label();
        assert!(
            label.contains("x509"),
            "audit label should flag variant: {}",
            label
        );
        assert!(
            label.contains("hmi-01"),
            "audit label should contain CN: {}",
            label
        );
    }

    #[test]
    fn x509_unknown_cn_surfaces_issuer_not_enrolled() {
        let (_s, v) = make_validator_with(manifest_alice_plus_hmi());
        let err = v
            .validate_x509(&cn("ghost-hmi"), &canned_der(0x30))
            .unwrap_err();
        assert_eq!(err, UserTokenValidatorError::X509IssuerNotEnrolled);
    }

    #[test]
    fn x509_wrong_anchor_surfaces_trust_anchor_mismatch() {
        let (_s, v) = make_validator_with(manifest_alice_plus_hmi());
        // Different first-byte on trust anchor DER → byte-equal
        // comparison rejects.
        let mut bad = canned_der(0x30);
        bad[10] = 0xFF;
        let err = v.validate_x509(&cn("hmi-01"), &bad).unwrap_err();
        assert_eq!(err, UserTokenValidatorError::X509TrustAnchorMismatch);
    }

    #[test]
    fn x509_no_manifest_surfaces_no_manifest_loaded() {
        let store = Arc::new(UserTokenManifestStore::new());
        let v = UserTokenValidator::new(store);
        let err = v
            .validate_x509(&cn("hmi-01"), &canned_der(0x30))
            .unwrap_err();
        assert_eq!(err, UserTokenValidatorError::NoManifestLoaded);
    }

    // ========================================================
    // Hot-reload — load-bearing integration test
    // ========================================================

    #[test]
    fn hot_reload_mid_session_swaps_enrollment_atomically() {
        // Start with the canned manifest (alice + hmi-01).
        let (store, v) = make_validator_with(manifest_alice_plus_hmi());

        // Alice auth works initially.
        assert!(
            v.validate_user_pass("alice", &Secret::new(b"pw-alice".to_vec()))
                .is_ok()
        );

        // Cloud publishes a new manifest where alice is revoked
        // (removed from bindings) and bob is added.
        let v2 = UserTokenManifest {
            policy_version: 2,
            tenant_id: tenant(),
            manifest_valid_from_unix_secs: 1_700_000_000,
            manifest_valid_until_unix_secs: 1_800_000_000,
            user_pass_bindings: vec![UserPassManifestBinding {
                operator_id: op(0x03),
                username_normalized: "bob".to_string(),
                argon2id_phc: phc(b"pw-bob", "c2FsdHNhbHRib2I"),
            }],
            x509_bindings: vec![], // HMI-01 also revoked
        };
        store.ingest_verified(v2).unwrap();

        // Alice is now rejected (revocation visible without restart).
        assert_eq!(
            v.validate_user_pass("alice", &Secret::new(b"pw-alice".to_vec()))
                .unwrap_err(),
            UserTokenValidatorError::CredentialMismatch
        );

        // Bob is accepted.
        assert!(
            v.validate_user_pass("bob", &Secret::new(b"pw-bob".to_vec()))
                .is_ok()
        );

        // HMI-01 cert is rejected.
        assert_eq!(
            v.validate_x509(&cn("hmi-01"), &canned_der(0x30))
                .unwrap_err(),
            UserTokenValidatorError::X509IssuerNotEnrolled
        );
    }

    #[test]
    fn clear_causes_subsequent_validate_to_fail_no_manifest_loaded() {
        let (store, v) = make_validator_with(manifest_alice_plus_hmi());

        // Works first.
        assert!(
            v.validate_user_pass("alice", &Secret::new(b"pw-alice".to_vec()))
                .is_ok()
        );

        // Revocation clear.
        store.clear();

        assert_eq!(
            v.validate_user_pass("alice", &Secret::new(b"pw-alice".to_vec()))
                .unwrap_err(),
            UserTokenValidatorError::NoManifestLoaded
        );
    }

    #[test]
    fn validator_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<UserTokenValidator>();
    }

    // ========================================================
    // Display
    // ========================================================

    #[test]
    fn error_display_strings_are_stable() {
        assert_eq!(
            UserTokenValidatorError::NoManifestLoaded.to_string(),
            "no_manifest_loaded"
        );
        assert_eq!(
            UserTokenValidatorError::CredentialMismatch.to_string(),
            "credential_mismatch"
        );
        assert_eq!(
            UserTokenValidatorError::BadUsernameFormat.to_string(),
            "bad_username_format"
        );
        assert_eq!(
            UserTokenValidatorError::X509IssuerNotEnrolled.to_string(),
            "x509_issuer_not_enrolled"
        );
        assert_eq!(
            UserTokenValidatorError::X509TrustAnchorMismatch.to_string(),
            "x509_trust_anchor_mismatch"
        );
    }
}
