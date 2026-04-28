//! # UserTokenManifest — cloud-signed OPC UA credential manifest (Batch #243)
//!
//! Parallel wire format to [`super::manifest::SignedRbacManifest`], carrying
//! the **credential** side of operator authentication (UserName/Password +
//! X.509). The RBAC manifest already carries operator PUBKEYS + role names;
//! this manifest carries operator SECRETS (hashed) + trust anchors.
//!
//! ## Why a separate manifest (three reasons)
//!
//! 1. **Key segregation (Plan B R-4 + ADR-021 §9).** The RBAC manifest is
//!    signed with `rbac_manifest_signing_key` (HSM slot 2). Adding a 4th
//!    slot `user_token_manifest_signing_key` keeps credential rotation
//!    authority separate from role-definition authority — a compromised
//!    role-signer cannot enroll arbitrary credentials.
//!
//! 2. **Rotation cadence.** Credentials churn per personnel lifecycle
//!    (hires, terminations, password rotations). Role definitions change
//!    per RBAC evolution. Binding them to the same monotonic version would
//!    force fleet-wide role re-signing on every personnel event.
//!
//! 3. **Backward-compat seal.** `RbacManifest::canonical_bytes()` closes with
//!    the domain tag `b"rbac-manifest-v1"`. Injecting new fields into that
//!    body would invalidate every already-issued RBAC signature in the
//!    fleet and require a v2 bump + re-sign ceremony. A parallel manifest
//!    with its own domain tag (`b"user-token-manifest-v1"`) leaves the RBAC
//!    signature surface untouched.
//!
//! ## Verification gates (fail-closed on ANY failure)
//!
//! Same 7-gate ordering as [`super::verify::verify_manifest`], re-applied
//! here against `user_token_manifest_signing_key`:
//!
//! 1. Validity window sanity (`valid_from <= valid_until`).
//! 2. Clock sanity (`now >= UNIX_EPOCH`).
//! 3. Tenant match (cross-tenant pivot defense — same check as RBAC).
//! 4. Policy version monotonicity — user-token policy_version is tracked
//!    IN A DIFFERENT STORE than RBAC (`UserTokenManifestVersionStore`;
//!    lands in Batch #244+). An attacker who captured an older user-token
//!    manifest must not replay it (ADR-018 §9 rollback defense).
//! 5. Manifest validity window covers `now`.
//! 6. Canonical-bytes serialization well-formedness.
//! 7. Signature verify against `user_token_manifest_signing_key` (caller
//!    injects closure — crypto dep stays out of this module).
//!
//! ## Cross-references
//! - Batch #242 [`crate::opc_ua_server_user_tokens`] — primitive newtypes
//!   (`NormalizedUsername`, `Argon2idHash`, `X509CertDer`,
//!   `UserTokenEnrollment`); consumed by the Batch #244 builder that turns
//!   a verified `UserTokenManifest` into a validated `UserTokenEnrollment`.
//! - ADR-017 §4.2 OPC UA UserName/Password + X.509 typed authz chain.
//! - ADR-018 §9 rollback-replay defense via monotonic policy_version.
//! - ADR-021 §9 HSM key ceremony — new slot for user_token_manifest_signing_key.

use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use super::manifest::CanonicalBytesError;
use super::manifest_common::{run_envelope_gates, ManifestStructuralError};
use super::permission::{OperatorId, TenantId};
use super::policy::{Ed25519SignatureBytes, InvalidSignatureLength};

// =============================================================================
// UserPassManifestBinding — wire-format user/password credential binding
// =============================================================================

/// Binds an operator (`OperatorId`) to a username-password credential pair.
///
/// **Wire format — raw strings.** Username is carried as a plain String so
/// the cloud signer can produce it without needing the edge-side
/// `NormalizedUsername` validator. Edge-side builder (Batch #244
/// `UserTokenEnrollment::from_manifest`) runs every field through the
/// Batch #242 validators at build time — malformed entries reject the
/// whole manifest (fail-closed) rather than silently skipping rows.
///
/// **Hash format — PHC.** `argon2id_phc` MUST be a PHC-format Argon2id
/// string (`$argon2id$v=19$...`). The Batch #242 `Argon2idHash::from_phc`
/// validator catches malformed entries at enrollment build time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserPassManifestBinding {
    pub operator_id: OperatorId,
    /// Operator username (cloud produces NFKC-normalized ASCII-lower form;
    /// edge re-normalizes at build time to catch cloud-side bugs).
    pub username_normalized: String,
    /// PHC-format Argon2id hash string.
    pub argon2id_phc: String,
}

// =============================================================================
// X509ManifestBinding — wire-format X.509 machine-issuer credential binding
// =============================================================================

/// Binds an operator to a machine-issuer X.509 certificate (OPC UA client
/// cert path). Used for headless HMI / SCADA integrations where no human
/// operator is at the keyboard — the machine itself authenticates via its
/// embedded certificate.
///
/// **Wire format — issuer CN + trust anchor DER.** The CN is the binding
/// lookup key; the DER bytes are the full trust anchor cert that the
/// incoming client cert chain MUST chain up to. Byte-equal compare on the
/// DER prevents an attacker who obtained a certificate with a matching CN
/// from a different issuer from authenticating.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct X509ManifestBinding {
    pub operator_id: OperatorId,
    /// Issuer Common Name — human-readable identifier, lookup key.
    pub issuer_cn: String,
    /// DER-encoded trust anchor certificate bytes. Edge-side builder
    /// (Batch #244) validates the DER SEQUENCE prefix + min length via
    /// the Batch #242 `X509CertDer::from_der` newtype.
    pub trust_anchor_der: Vec<u8>,
}

// =============================================================================
// UserTokenManifest — the signed body
// =============================================================================

/// The user-token manifest body — the SIGNED content. Excludes the
/// signature; the signature covers `canonical_bytes(self)`.
///
/// Parallels [`super::manifest::RbacManifest`] in shape: policy_version +
/// tenant_id + validity window + a vector of bindings. Distinct wire
/// format (different signer key, different domain tag, different monotonic
/// version space).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserTokenManifest {
    /// Monotonic policy version for the USER-TOKEN manifest stream. Tracked
    /// separately from the RBAC manifest's policy_version (ADR-018 §9
    /// rollback defense per-stream).
    pub policy_version: u64,

    /// Tenant binding — must equal the device's provisioning-bound tenant
    /// (same check as RBAC manifest).
    pub tenant_id: TenantId,

    /// Whole-manifest validity window.
    pub manifest_valid_from_unix_secs: i64,
    pub manifest_valid_until_unix_secs: i64,

    /// All UserName/Password credential bindings.
    pub user_pass_bindings: Vec<UserPassManifestBinding>,

    /// All X.509 machine-issuer bindings.
    pub x509_bindings: Vec<X509ManifestBinding>,
}

// =============================================================================
// SignedUserTokenManifest — the wire-format envelope
// =============================================================================

/// Signed user-token manifest — wire format carrying signed body +
/// ed25519 signature produced by the `user_token_manifest_signing_key`
/// (ADR-021 slot 4 / Batch #243 ceremony addition).
///
/// **Tier-1 seal (same pattern as `SignedRbacManifest`):** `manifest`
/// field is `pub(crate)`. External consumers cannot read the unverified
/// body directly — they MUST go through [`verify_user_token_manifest`],
/// which returns an owned `UserTokenManifest` only after passing all 7
/// verification gates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedUserTokenManifest {
    pub(crate) manifest: UserTokenManifest,
    /// ed25519 signature (64 bytes, validated at parse boundary).
    pub signature: Ed25519SignatureBytes,
}

impl SignedUserTokenManifest {
    /// Construct from manifest body + 64-byte signature slice. Bounces back
    /// `InvalidSignatureLength` on wrong slice length. Use at the wire-parse
    /// boundary (MQTT `user_token_manifest` topic, HTTP publish endpoint).
    pub fn from_body_and_signature_bytes(
        manifest: UserTokenManifest,
        signature_bytes: &[u8],
    ) -> Result<Self, InvalidSignatureLength> {
        Ok(Self {
            manifest,
            signature: Ed25519SignatureBytes::from_slice(signature_bytes)?,
        })
    }
}

// =============================================================================
// canonical_bytes — length-prefix framing, domain-separated
// =============================================================================

impl UserTokenManifest {
    /// Canonical bytes fed to ed25519 signing/verify. Length-prefix framing
    /// mirrors [`super::manifest::RbacManifest::canonical_bytes`] — same
    /// discipline, DIFFERENT domain tag.
    ///
    /// **Encoding (v1 — first release):**
    ///
    /// ```text
    /// be_u64(policy_version) ||
    /// tenant_id.as_bytes() (fixed 16 bytes) ||
    /// be_i64(manifest_valid_from_unix_secs) ||
    /// be_i64(manifest_valid_until_unix_secs) ||
    /// be_u32(user_pass_bindings.len()) ||
    ///   for each binding:
    ///     operator_id.as_bytes() (fixed 16 bytes) ||
    ///     be_u32(username_normalized.len()) || username_normalized.as_bytes() ||
    ///     be_u32(argon2id_phc.len()) || argon2id_phc.as_bytes() ||
    /// be_u32(x509_bindings.len()) ||
    ///   for each binding:
    ///     operator_id.as_bytes() (fixed 16 bytes) ||
    ///     be_u32(issuer_cn.len()) || issuer_cn.as_bytes() ||
    ///     be_u32(trust_anchor_der.len()) || trust_anchor_der ||
    /// b"user-token-manifest-v1"
    /// ```
    ///
    /// **Domain-separation tag:** `b"user-token-manifest-v1"` at the END
    /// prevents cross-protocol signature reuse. An attacker who somehow
    /// coerced the `user_token_manifest_signing_key` holder into signing
    /// these bytes would NOT produce a valid `rbac-manifest-v1` signature
    /// or `file-backed-acceptance-v1` signature, because the domain tags
    /// are distinct.
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, CanonicalBytesError> {
        let mut out = Vec::with_capacity(256);
        out.extend_from_slice(&self.policy_version.to_be_bytes());
        out.extend_from_slice(self.tenant_id.as_bytes());
        out.extend_from_slice(&self.manifest_valid_from_unix_secs.to_be_bytes());
        out.extend_from_slice(&self.manifest_valid_until_unix_secs.to_be_bytes());

        out.extend_from_slice(&u32_len(self.user_pass_bindings.len())?.to_be_bytes());
        for binding in &self.user_pass_bindings {
            out.extend_from_slice(binding.operator_id.as_bytes());
            let uname = binding.username_normalized.as_bytes();
            out.extend_from_slice(&u32_len(uname.len())?.to_be_bytes());
            out.extend_from_slice(uname);
            let phc = binding.argon2id_phc.as_bytes();
            out.extend_from_slice(&u32_len(phc.len())?.to_be_bytes());
            out.extend_from_slice(phc);
        }

        out.extend_from_slice(&u32_len(self.x509_bindings.len())?.to_be_bytes());
        for binding in &self.x509_bindings {
            out.extend_from_slice(binding.operator_id.as_bytes());
            let cn = binding.issuer_cn.as_bytes();
            out.extend_from_slice(&u32_len(cn.len())?.to_be_bytes());
            out.extend_from_slice(cn);
            let der = binding.trust_anchor_der.as_slice();
            out.extend_from_slice(&u32_len(der.len())?.to_be_bytes());
            out.extend_from_slice(der);
        }

        out.extend_from_slice(b"user-token-manifest-v1");
        Ok(out)
    }
}

/// Helper: convert a `usize` length to `u32` with overflow rejected. Same
/// defense as the RBAC manifest's `u32_len` — a manifest with more than
/// `u32::MAX` entries is not a sane input.
fn u32_len(n: usize) -> Result<u32, CanonicalBytesError> {
    u32::try_from(n).map_err(|_| CanonicalBytesError::LengthExceedsU32)
}

// =============================================================================
// verify_user_token_manifest — 7-gate fail-closed verifier
// =============================================================================

/// Verification-error taxonomy. One variant per gate — parallel to
/// [`super::verify::ManifestVerifyError`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UserTokenManifestVerifyError {
    /// Cryptographic signature verify failed — verifier closure returned
    /// false. Indicates tampering or wrong key.
    InvalidSignature,

    /// Manifest `tenant_id` does not match the device's provisioning-bound
    /// tenant. Cross-tenant pivot defense.
    TenantMismatch,

    /// Incoming `policy_version` <= `highest_seen_policy_version` for the
    /// user-token stream (per-stream rollback defense). Rollback attempt
    /// — reject without processing further gates.
    StalePolicyVersion { claimed: u64, highest_seen: u64 },

    /// `now` is before `manifest_valid_from_unix_secs` — future-dated
    /// manifest.
    NotYetValid { now_unix_secs: i64, valid_from: i64 },

    /// `now` is after `manifest_valid_until_unix_secs` — expired manifest.
    Expired { now_unix_secs: i64, valid_until: i64 },

    /// Canonical-bytes serialization failed.
    CanonicalBytesFailure(CanonicalBytesError),

    /// `now` is earlier than UNIX_EPOCH — clock skew pre-epoch.
    InvalidNow,

    /// Validity window is inverted (`valid_from > valid_until`).
    InvalidValidityWindow { valid_from: i64, valid_until: i64 },
}

impl std::fmt::Display for UserTokenManifestVerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidSignature => f.write_str("invalid_signature"),
            Self::TenantMismatch => f.write_str("tenant_mismatch"),
            Self::StalePolicyVersion { .. } => f.write_str("stale_policy_version"),
            Self::NotYetValid { .. } => f.write_str("not_yet_valid"),
            Self::Expired { .. } => f.write_str("expired"),
            Self::CanonicalBytesFailure(_) => f.write_str("canonical_bytes_failure"),
            Self::InvalidNow => f.write_str("invalid_now"),
            Self::InvalidValidityWindow { .. } => f.write_str("invalid_validity_window"),
        }
    }
}

impl std::error::Error for UserTokenManifestVerifyError {}

impl From<CanonicalBytesError> for UserTokenManifestVerifyError {
    fn from(e: CanonicalBytesError) -> Self {
        Self::CanonicalBytesFailure(e)
    }
}

/// Map the shared structural-gate error taxonomy into this module's local
/// error enum. Keeps user-token-specific audit-log formatting intact while
/// sourcing the actual gate logic from `manifest_common`.
impl From<ManifestStructuralError> for UserTokenManifestVerifyError {
    fn from(e: ManifestStructuralError) -> Self {
        match e {
            ManifestStructuralError::InvalidValidityWindow {
                valid_from,
                valid_until,
            } => Self::InvalidValidityWindow {
                valid_from,
                valid_until,
            },
            ManifestStructuralError::InvalidNow => Self::InvalidNow,
            ManifestStructuralError::TenantMismatch => Self::TenantMismatch,
            ManifestStructuralError::StalePolicyVersion {
                claimed,
                highest_seen,
            } => Self::StalePolicyVersion {
                claimed,
                highest_seen,
            },
            ManifestStructuralError::NotYetValid {
                now_unix_secs,
                valid_from,
            } => Self::NotYetValid {
                now_unix_secs,
                valid_from,
            },
            ManifestStructuralError::Expired {
                now_unix_secs,
                valid_until,
            } => Self::Expired {
                now_unix_secs,
                valid_until,
            },
        }
    }
}

/// Verify a signed user-token manifest. Returns the validated
/// [`UserTokenManifest`] on success; fail-closed with a structured
/// [`UserTokenManifestVerifyError`] on any gate rejection.
///
/// **Gate ordering** — cheapest checks first, crypto last. Most attacks
/// bounce off tenant mismatch / rollback / expiry before reaching ed25519.
///
/// 1. Validity window sanity (`valid_from <= valid_until`).
/// 2. `now` >= UNIX_EPOCH (clock sanity).
/// 3. Tenant match.
/// 4. Policy version monotonicity (user-token stream).
/// 5. `now` within `[valid_from, valid_until]`.
/// 6. Canonical bytes serialization.
/// 7. Signature verify (injected closure; caller wires `ed25519_dalek::
///    VerifyingKey::verify_strict` against `user_token_manifest_signing_
///    key`).
///
/// **Fail-closed discipline:** any `Err` return leaves the caller's
/// manifest store unchanged. Caller MUST NOT proceed to atomic manifest
/// swap on error.
pub fn verify_user_token_manifest(
    signed: &SignedUserTokenManifest,
    expected_tenant: &TenantId,
    highest_seen_policy_version: u64,
    now: SystemTime,
    verify_signature: impl FnOnce(&[u8], &[u8; 64]) -> bool,
) -> Result<UserTokenManifest, UserTokenManifestVerifyError> {
    // Gates 1-5 (validity window, clock, tenant, version, expiry) are
    // the SHARED envelope contract every signed edge manifest runs —
    // delegated to `manifest_common::run_envelope_gates` per Batch #243
    // refactor (zero duplication with `verify::verify_manifest`). The
    // helper returns `now_unix_secs` on success so any audit-path
    // consumer can reuse the timestamp without recomputing it.
    let _now_unix_secs = run_envelope_gates(
        expected_tenant,
        &signed.manifest.tenant_id,
        signed.manifest.manifest_valid_from_unix_secs,
        signed.manifest.manifest_valid_until_unix_secs,
        signed.manifest.policy_version,
        highest_seen_policy_version,
        now,
    )?;

    // Gate 6: canonical-bytes serialization (structural well-formedness).
    // Manifest-specific — different domain tag per manifest type; stays
    // in this module.
    let canonical = signed.manifest.canonical_bytes()?;

    // Gate 7: signature verify. Closure injected.
    if !verify_signature(&canonical, signed.signature.as_bytes()) {
        return Err(UserTokenManifestVerifyError::InvalidSignature);
    }

    Ok(signed.manifest.clone())
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::permission::{OperatorId, TenantId};
    use std::time::Duration;

    fn op(b: u8) -> OperatorId {
        OperatorId::new_from_verified([b; 16])
    }

    fn tenant(b: u8) -> TenantId {
        TenantId::new_from_verified([b; 16])
    }

    fn canned_manifest() -> UserTokenManifest {
        UserTokenManifest {
            policy_version: 42,
            tenant_id: tenant(0xAA),
            manifest_valid_from_unix_secs: 1_700_000_000,
            manifest_valid_until_unix_secs: 1_800_000_000,
            user_pass_bindings: vec![UserPassManifestBinding {
                operator_id: op(0x01),
                username_normalized: "alice".to_string(),
                argon2id_phc:
                    "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$abcdef"
                        .to_string(),
            }],
            x509_bindings: vec![X509ManifestBinding {
                operator_id: op(0x02),
                issuer_cn: "ignition-hmi-01".to_string(),
                trust_anchor_der: vec![0x30; 256],
            }],
        }
    }

    fn sign(manifest: &UserTokenManifest) -> SignedUserTokenManifest {
        // Deterministic test-only "signature" — not a real ed25519 output;
        // the tests inject a closure that returns true/false based on what
        // they want to assert. The signature bytes here just satisfy the
        // `Ed25519SignatureBytes` newtype length check.
        let sig = Ed25519SignatureBytes::from_slice(&[0u8; 64])
            .expect("64 zeros is a valid signature *length*");
        SignedUserTokenManifest {
            manifest: manifest.clone(),
            signature: sig,
        }
    }

    fn now_inside() -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_750_000_000)
    }

    #[test]
    fn canonical_bytes_is_deterministic() {
        let m1 = canned_manifest();
        let m2 = canned_manifest();
        assert_eq!(
            m1.canonical_bytes().unwrap(),
            m2.canonical_bytes().unwrap()
        );
    }

    #[test]
    fn canonical_bytes_includes_domain_tag() {
        let m = canned_manifest();
        let bytes = m.canonical_bytes().unwrap();
        assert!(
            bytes.ends_with(b"user-token-manifest-v1"),
            "canonical_bytes must end with the domain tag"
        );
    }

    #[test]
    fn canonical_bytes_differs_from_rbac_manifest_domain() {
        // Domain-tag separation: our trailer must NOT be the RBAC trailer.
        // Protects against cross-protocol signature reuse.
        let m = canned_manifest();
        let bytes = m.canonical_bytes().unwrap();
        assert!(!bytes.ends_with(b"rbac-manifest-v1"));
    }

    #[test]
    fn canonical_bytes_changes_on_any_field_edit() {
        let base = canned_manifest().canonical_bytes().unwrap();

        let mut edit_version = canned_manifest();
        edit_version.policy_version += 1;
        assert_ne!(base, edit_version.canonical_bytes().unwrap());

        let mut edit_username = canned_manifest();
        edit_username.user_pass_bindings[0].username_normalized =
            "alice2".to_string();
        assert_ne!(base, edit_username.canonical_bytes().unwrap());

        let mut edit_phc = canned_manifest();
        edit_phc.user_pass_bindings[0].argon2id_phc.push('!');
        assert_ne!(base, edit_phc.canonical_bytes().unwrap());

        let mut edit_cn = canned_manifest();
        edit_cn.x509_bindings[0].issuer_cn = "ignition-hmi-02".to_string();
        assert_ne!(base, edit_cn.canonical_bytes().unwrap());

        let mut edit_anchor = canned_manifest();
        edit_anchor.x509_bindings[0].trust_anchor_der[0] ^= 0xFF;
        assert_ne!(base, edit_anchor.canonical_bytes().unwrap());
    }

    #[test]
    fn signed_ctor_rejects_wrong_signature_length() {
        let m = canned_manifest();
        let err = SignedUserTokenManifest::from_body_and_signature_bytes(
            m.clone(),
            &[0u8; 63], // off-by-one short
        )
        .unwrap_err();
        // Any error is acceptable; the important bit is the ctor rejects.
        // InvalidSignatureLength is the canonical shape; pin it loosely.
        assert_eq!(format!("{:?}", err).contains("63"), true);
    }

    #[test]
    fn signed_ctor_accepts_valid_signature_length() {
        let m = canned_manifest();
        SignedUserTokenManifest::from_body_and_signature_bytes(m, &[0u8; 64])
            .expect("valid length");
    }

    // -------------------------------------------------------------------------
    // verify_user_token_manifest — 7-gate coverage
    // -------------------------------------------------------------------------

    #[test]
    fn verify_accepts_well_formed_current_manifest() {
        let signed = sign(&canned_manifest());
        let r = verify_user_token_manifest(
            &signed,
            &tenant(0xAA),
            0, // highest_seen: 0 — any claimed > 0 is progress
            now_inside(),
            |_, _| true,
        );
        assert!(r.is_ok());
    }

    #[test]
    fn verify_rejects_inverted_validity_window() {
        let mut m = canned_manifest();
        m.manifest_valid_from_unix_secs = 1_800_000_000;
        m.manifest_valid_until_unix_secs = 1_700_000_000;
        let signed = sign(&m);
        let err = verify_user_token_manifest(
            &signed,
            &tenant(0xAA),
            0,
            now_inside(),
            |_, _| true,
        )
        .unwrap_err();
        match err {
            UserTokenManifestVerifyError::InvalidValidityWindow { .. } => {}
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn verify_rejects_cross_tenant_manifest() {
        let signed = sign(&canned_manifest());
        let err = verify_user_token_manifest(
            &signed,
            &tenant(0xBB), // wrong tenant
            0,
            now_inside(),
            |_, _| true,
        )
        .unwrap_err();
        assert_eq!(err, UserTokenManifestVerifyError::TenantMismatch);
    }

    #[test]
    fn verify_rejects_stale_policy_version_equal_to_highest_seen() {
        let signed = sign(&canned_manifest()); // policy_version = 42
        let err = verify_user_token_manifest(
            &signed,
            &tenant(0xAA),
            42, // equal — STRICTLY greater required
            now_inside(),
            |_, _| true,
        )
        .unwrap_err();
        match err {
            UserTokenManifestVerifyError::StalePolicyVersion {
                claimed,
                highest_seen,
            } => {
                assert_eq!(claimed, 42);
                assert_eq!(highest_seen, 42);
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn verify_rejects_rollback_below_highest_seen() {
        let signed = sign(&canned_manifest()); // policy_version = 42
        let err = verify_user_token_manifest(
            &signed,
            &tenant(0xAA),
            100, // replay attack — claimed 42 <= 100
            now_inside(),
            |_, _| true,
        )
        .unwrap_err();
        match err {
            UserTokenManifestVerifyError::StalePolicyVersion { .. } => {}
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn verify_rejects_not_yet_valid() {
        let signed = sign(&canned_manifest());
        let err = verify_user_token_manifest(
            &signed,
            &tenant(0xAA),
            0,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000),
            |_, _| true,
        )
        .unwrap_err();
        match err {
            UserTokenManifestVerifyError::NotYetValid { .. } => {}
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn verify_rejects_expired() {
        let signed = sign(&canned_manifest());
        let err = verify_user_token_manifest(
            &signed,
            &tenant(0xAA),
            0,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_900_000_000),
            |_, _| true,
        )
        .unwrap_err();
        match err {
            UserTokenManifestVerifyError::Expired { .. } => {}
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn verify_rejects_invalid_signature() {
        let signed = sign(&canned_manifest());
        let err = verify_user_token_manifest(
            &signed,
            &tenant(0xAA),
            0,
            now_inside(),
            |_, _| false, // signer rejects
        )
        .unwrap_err();
        assert_eq!(err, UserTokenManifestVerifyError::InvalidSignature);
    }

    #[test]
    fn verify_signature_receives_canonical_bytes_and_signature_bytes() {
        let signed = sign(&canned_manifest());
        let expected_canon =
            signed.manifest.canonical_bytes().unwrap();
        let expected_sig = *signed.signature.as_bytes();

        let r = verify_user_token_manifest(
            &signed,
            &tenant(0xAA),
            0,
            now_inside(),
            |canon, sig| {
                assert_eq!(canon, expected_canon.as_slice());
                assert_eq!(sig, &expected_sig);
                true
            },
        );
        assert!(r.is_ok());
    }

    #[test]
    fn verify_gate_ordering_tenant_before_version() {
        // Ordering test: a cross-tenant manifest with a stale version
        // should surface TenantMismatch (gate 3) before StalePolicyVersion
        // (gate 4). Gate ordering is load-bearing for audit-log clarity.
        let signed = sign(&canned_manifest());
        let err = verify_user_token_manifest(
            &signed,
            &tenant(0xBB),
            100, // also stale
            now_inside(),
            |_, _| true,
        )
        .unwrap_err();
        assert_eq!(err, UserTokenManifestVerifyError::TenantMismatch);
    }

    #[test]
    fn verify_gate_ordering_signature_last() {
        // A good manifest under a false signer → InvalidSignature (gate 7),
        // last. Any structural failure must surface before signature check.
        let signed = sign(&canned_manifest());
        let mut called = false;
        let r = verify_user_token_manifest(
            &signed,
            &tenant(0xAA),
            0,
            now_inside(),
            |_, _| {
                called = true;
                false
            },
        );
        assert!(r.is_err());
        assert!(
            called,
            "signer closure must be called on a well-formed manifest"
        );
    }

    #[test]
    fn verify_returns_cloned_manifest_on_success() {
        let signed = sign(&canned_manifest());
        let verified = verify_user_token_manifest(
            &signed,
            &tenant(0xAA),
            0,
            now_inside(),
            |_, _| true,
        )
        .unwrap();
        assert_eq!(verified, signed.manifest);
    }

    #[test]
    fn verify_error_display_strings() {
        // Stable display strings for audit-log routing.
        assert_eq!(
            UserTokenManifestVerifyError::InvalidSignature.to_string(),
            "invalid_signature"
        );
        assert_eq!(
            UserTokenManifestVerifyError::TenantMismatch.to_string(),
            "tenant_mismatch"
        );
        assert_eq!(
            UserTokenManifestVerifyError::StalePolicyVersion {
                claimed: 1,
                highest_seen: 2
            }
            .to_string(),
            "stale_policy_version"
        );
        assert_eq!(
            UserTokenManifestVerifyError::Expired {
                now_unix_secs: 0,
                valid_until: 0
            }
            .to_string(),
            "expired"
        );
    }
}
