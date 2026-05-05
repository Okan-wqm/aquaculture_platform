//! # Manifest verification — `verify_manifest` function + error taxonomy
//!
//! This file is the one entry point from "wire bytes claiming to be a
//! signed manifest" to "validated [`RbacManifest`] the engine can
//! evaluate against". Every consumer of `SignedRbacManifest` MUST go
//! through [`verify_manifest`]; parsing or trusting the inner body
//! directly is a reviewable bug.
//!
//! ## Verification gates (fail-closed on ANY failure)
//!
//! 1. **Signature length + format** — already enforced at parse boundary
//!    via `Ed25519SignatureBytes` validated newtype (EDGE-LOW-002).
//! 2. **Signature cryptographic verification** — ed25519 verify of
//!    `signature` against `RbacManifest::canonical_bytes()` under the
//!    `rbac_manifest_signing_key` public key (ADR-021 slot 2).
//! 3. **Tenant binding equality** — manifest tenant_id MUST equal the
//!    device's provisioning-bound tenant (`ProvisioningBlob::verified_
//!    tenant_id()`, ADR-019 §4). Mismatch → fail-closed.
//! 4. **Policy version monotonicity** — incoming `policy_version` MUST be
//!    strictly greater than `highest_seen_policy_version`. Less-than-or-
//!    equal → rollback attempt, reject (ADR-018 §9).
//! 5. **Manifest expiry window** — `now` MUST fall within
//!    `manifest_valid_from_unix_secs..=manifest_valid_until_unix_secs`.
//!    Expired / future → fail-closed.
//!
//! ## Scope of Batch 5b (this file)
//!
//! Types + function signature + every gate EXCEPT (2). The cryptographic
//! verify step is injected as a closure — caller passes a function that
//! takes `(&[u8] canonical_bytes, &[u8; 64] signature) -> bool`. Sprint
//! 6.1 plugs in `ed25519_dalek::VerifyingKey::verify_strict`. Keeping the
//! crypto out of this module means Batch 5b compiles without pulling a
//! keystore dependency into the authz module graph.

use std::time::SystemTime;

use super::manifest::{CanonicalBytesError, RbacManifest, SignedRbacManifest};
use super::manifest_common::{run_envelope_gates, ManifestStructuralError};
use super::permission::TenantId;

/// Structured verification errors. Every variant discriminates a distinct
/// gate; audit trail + operator-error messages use these to route responses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestVerifyError {
    /// Cryptographic signature verify failed — verifier closure returned
    /// false. Indicates either tampering or wrong key.
    InvalidSignature,

    /// Manifest `tenant_id` does not match the device's provisioning-bound
    /// tenant. Cross-tenant pivot defense (ADR-018 §3 FINDING-001).
    TenantMismatch,

    /// Incoming `policy_version` <= `highest_seen_policy_version`. Rollback
    /// attempt — reject without processing further gates.
    StalePolicyVersion { claimed: u64, highest_seen: u64 },

    /// `now` is before `manifest_valid_from_unix_secs` — future-dated
    /// manifest. Allowed only at first provisioning if `highest_seen == 0`.
    NotYetValid { now_unix_secs: i64, valid_from: i64 },

    /// `now` is after `manifest_valid_until_unix_secs` — expired manifest.
    Expired {
        now_unix_secs: i64,
        valid_until: i64,
    },

    /// Canonical-bytes serialization failed (e.g., length-prefix overflow,
    /// bincode encode failure on a Permission variant).
    CanonicalBytesFailure(CanonicalBytesError),

    /// `now` is earlier than UNIX_EPOCH — clock skew pre-epoch; impossible
    /// under correct NTS clock. Fail-closed.
    InvalidNow,

    /// Manifest validity window is inverted (`valid_from > valid_until`).
    /// Malformed manifest; signer must re-cut.
    InvalidValidityWindow { valid_from: i64, valid_until: i64 },
}

impl std::fmt::Display for ManifestVerifyError {
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

impl std::error::Error for ManifestVerifyError {}

impl From<CanonicalBytesError> for ManifestVerifyError {
    fn from(e: CanonicalBytesError) -> Self {
        Self::CanonicalBytesFailure(e)
    }
}

/// Map the shared structural-gate error taxonomy into this module's local
/// error enum. Keeps RBAC-specific audit-log formatting intact while
/// sourcing the actual gate logic from `manifest_common`.
impl From<ManifestStructuralError> for ManifestVerifyError {
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

/// Verify a signed manifest. Returns the validated [`RbacManifest`] on
/// success; fail-closed with a structured [`ManifestVerifyError`] on any
/// gate rejection.
///
/// **Gate ordering:** cheapest checks first, crypto last. Most attacks
/// bounce off tenant mismatch / rollback / expiry before reaching ed25519.
///
/// 1. Validity window sanity (valid_from <= valid_until)
/// 2. `now` >= UNIX_EPOCH (clock sanity)
/// 3. Tenant match (`manifest.tenant_id == expected_tenant`)
/// 4. Policy version monotonicity (`policy_version > highest_seen_policy_version`)
/// 5. `now` within `[valid_from, valid_until]`
/// 6. Canonical bytes serialization (structural well-formedness)
/// 7. Signature verify (inject closure; Sprint 6.1 wires `ed25519_dalek`)
///
/// **Fail-closed discipline:** any `Err` return leaves the caller's
/// manifest store unchanged. Caller MUST NOT proceed to atomic manifest
/// swap on error.
pub fn verify_manifest(
    signed: &SignedRbacManifest,
    expected_tenant: &TenantId,
    highest_seen_policy_version: u64,
    now: SystemTime,
    verify_signature: impl FnOnce(&[u8], &[u8; 64]) -> bool,
) -> Result<RbacManifest, ManifestVerifyError> {
    // Gates 1-5 (validity window, clock, tenant, version, expiry) are
    // the SHARED envelope contract every signed edge manifest runs —
    // delegated to `manifest_common::run_envelope_gates` per Batch #243
    // refactor (zero duplication with `user_token_manifest::verify_
    // user_token_manifest`). The helper returns `now_unix_secs` on
    // success so the audit path doesn't recompute it.
    let _now_unix_secs = run_envelope_gates(
        expected_tenant,
        &signed.manifest.tenant_id,
        signed.manifest.manifest_valid_from_unix_secs,
        signed.manifest.manifest_valid_until_unix_secs,
        signed.manifest.policy_version,
        highest_seen_policy_version,
        now,
    )?;

    // Gate 6: canonical-bytes serialization (surface structural errors).
    // Manifest-specific — different domain tag per manifest type; stays
    // in this module.
    let canonical = signed.manifest.canonical_bytes()?;

    // Gate 7: signature verify. Closure-injected to keep crypto dep out
    // of this module. Sprint 6.1 wires `ed25519_dalek::VerifyingKey::
    // verify_strict`. A false return = fail-closed InvalidSignature.
    if !verify_signature(&canonical, signed.signature.as_bytes()) {
        return Err(ManifestVerifyError::InvalidSignature);
    }

    Ok(signed.manifest.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::manifest::{
        CustomRole, Ed25519PublicKeyBytes, OperatorBinding, RbacManifest,
    };
    use crate::authz::permission::{OperatorId, Permission, TagId};
    use crate::authz::policy::Ed25519SignatureBytes;
    use std::time::Duration;

    fn tenant() -> TenantId {
        TenantId::new_from_verified([0x42u8; 16])
    }

    fn other_tenant() -> TenantId {
        TenantId::new_from_verified([0x99u8; 16])
    }

    fn canned_manifest(policy_version: u64, valid_from: i64, valid_until: i64) -> RbacManifest {
        RbacManifest {
            policy_version,
            tenant_id: tenant(),
            manifest_valid_from_unix_secs: valid_from,
            manifest_valid_until_unix_secs: valid_until,
            operator_bindings: vec![OperatorBinding {
                operator_id: OperatorId::new_from_verified([0x07u8; 16]),
                pubkey: Ed25519PublicKeyBytes::from_bytes([0xaau8; 32]),
                role_names: vec!["operator".to_string()],
            }],
            roles: vec![CustomRole {
                name: "operator".to_string(),
                permissions: vec![Permission::ReadTag],
                valid_from_unix_secs: valid_from,
                valid_until_unix_secs: valid_until,
                is_emergency_role: false,
            }],
        }
    }

    fn signed(m: RbacManifest) -> SignedRbacManifest {
        SignedRbacManifest {
            manifest: m,
            signature: Ed25519SignatureBytes::from_array([0u8; 64]),
        }
    }

    fn now_at(unix_secs: i64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(unix_secs as u64)
    }

    /// WHY: Happy path — all gates pass, returns the inner manifest.
    #[test]
    fn accepts_valid_manifest() {
        let m = canned_manifest(10, 1_000, 9_000);
        let signed = signed(m.clone());
        let verified =
            verify_manifest(&signed, &tenant(), 5, now_at(5_000), |_, _| true).expect("valid");
        assert_eq!(verified, m);
    }

    /// WHY: Gate 3 — tenant mismatch is the cross-tenant pivot defense.
    ///      Must fire BEFORE signature verify (cheapest crypto-free check).
    #[test]
    fn rejects_tenant_mismatch() {
        let m = canned_manifest(10, 1_000, 9_000);
        let signed = signed(m);
        let err = verify_manifest(&signed, &other_tenant(), 5, now_at(5_000), |_, _| true)
            .expect_err("tenant mismatch");
        assert_eq!(err, ManifestVerifyError::TenantMismatch);
    }

    /// WHY: Gate 4 — strictly-greater policy version; equal is rollback.
    #[test]
    fn rejects_equal_policy_version() {
        let m = canned_manifest(10, 1_000, 9_000);
        let signed = signed(m);
        let err = verify_manifest(&signed, &tenant(), 10, now_at(5_000), |_, _| true)
            .expect_err("stale: equal version");
        assert_eq!(
            err,
            ManifestVerifyError::StalePolicyVersion {
                claimed: 10,
                highest_seen: 10
            }
        );
    }

    #[test]
    fn rejects_lower_policy_version() {
        let m = canned_manifest(10, 1_000, 9_000);
        let signed = signed(m);
        let err = verify_manifest(&signed, &tenant(), 15, now_at(5_000), |_, _| true)
            .expect_err("stale: lower version");
        assert_eq!(
            err,
            ManifestVerifyError::StalePolicyVersion {
                claimed: 10,
                highest_seen: 15
            }
        );
    }

    /// WHY: Gate 5 — not-yet-valid (now before valid_from).
    #[test]
    fn rejects_not_yet_valid() {
        let m = canned_manifest(10, 5_000, 9_000);
        let signed = signed(m);
        let err =
            verify_manifest(&signed, &tenant(), 0, now_at(1_000), |_, _| true).expect_err("future");
        assert_eq!(
            err,
            ManifestVerifyError::NotYetValid {
                now_unix_secs: 1_000,
                valid_from: 5_000
            }
        );
    }

    #[test]
    fn rejects_expired() {
        let m = canned_manifest(10, 1_000, 5_000);
        let signed = signed(m);
        let err = verify_manifest(&signed, &tenant(), 0, now_at(9_000), |_, _| true)
            .expect_err("expired");
        assert_eq!(
            err,
            ManifestVerifyError::Expired {
                now_unix_secs: 9_000,
                valid_until: 5_000
            }
        );
    }

    /// WHY: Gate 1 — malformed validity window. Surface BEFORE other gates
    ///      because it's a signer-side bug we want to scream about.
    #[test]
    fn rejects_inverted_validity_window() {
        let m = canned_manifest(10, 9_000, 1_000);
        let signed = signed(m);
        let err = verify_manifest(&signed, &tenant(), 0, now_at(5_000), |_, _| true)
            .expect_err("inverted");
        assert_eq!(
            err,
            ManifestVerifyError::InvalidValidityWindow {
                valid_from: 9_000,
                valid_until: 1_000
            }
        );
    }

    /// WHY: Gate 7 — signature verify closure returns false → InvalidSignature.
    #[test]
    fn rejects_invalid_signature() {
        let m = canned_manifest(10, 1_000, 9_000);
        let signed = signed(m);
        let err = verify_manifest(&signed, &tenant(), 0, now_at(5_000), |_, _| false)
            .expect_err("bad sig");
        assert_eq!(err, ManifestVerifyError::InvalidSignature);
    }

    /// WHY: The verifier closure receives the canonical bytes, not the
    ///      raw body. Double-check via a closure that asserts length > 0.
    #[test]
    fn verifier_receives_canonical_bytes_not_empty() {
        let m = canned_manifest(10, 1_000, 9_000);
        let signed = signed(m);
        let mut received_len = 0usize;
        let mut received_sig_len = 0usize;
        let _ = verify_manifest(&signed, &tenant(), 0, now_at(5_000), |canonical, sig| {
            received_len = canonical.len();
            received_sig_len = sig.len();
            true
        });
        assert!(
            received_len > 32,
            "canonical bytes must have substantial content"
        );
        assert_eq!(received_sig_len, 64);
    }

    /// WHY: Display format is audit-surface; pin Display for each variant.
    #[test]
    fn verify_error_display_snake_case() {
        assert_eq!(
            format!("{}", ManifestVerifyError::InvalidSignature),
            "invalid_signature"
        );
        assert_eq!(
            format!("{}", ManifestVerifyError::TenantMismatch),
            "tenant_mismatch"
        );
        assert_eq!(
            format!(
                "{}",
                ManifestVerifyError::StalePolicyVersion {
                    claimed: 1,
                    highest_seen: 2
                }
            ),
            "stale_policy_version"
        );
        assert_eq!(
            format!(
                "{}",
                ManifestVerifyError::NotYetValid {
                    now_unix_secs: 0,
                    valid_from: 1
                }
            ),
            "not_yet_valid"
        );
        assert_eq!(
            format!(
                "{}",
                ManifestVerifyError::Expired {
                    now_unix_secs: 2,
                    valid_until: 1
                }
            ),
            "expired"
        );
        assert_eq!(
            format!("{}", ManifestVerifyError::InvalidNow),
            "invalid_now"
        );
        assert_eq!(
            format!(
                "{}",
                ManifestVerifyError::InvalidValidityWindow {
                    valid_from: 9,
                    valid_until: 1
                }
            ),
            "invalid_validity_window"
        );
        assert_eq!(
            format!(
                "{}",
                ManifestVerifyError::CanonicalBytesFailure(CanonicalBytesError::LengthExceedsU32)
            ),
            "canonical_bytes_failure"
        );
    }

    /// WHY: `ManifestVerifyError` implements std::error::Error for `?` interop.
    #[test]
    fn verify_error_implements_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<ManifestVerifyError>();
    }

    /// WHY: `From<CanonicalBytesError>` propagation — the `?` operator
    ///      inside verify_manifest surfaces canonical serialization errors
    ///      without manual mapping.
    #[test]
    fn canonical_bytes_error_converts_to_verify_error() {
        let e: ManifestVerifyError = CanonicalBytesError::PermissionEncodeFailed.into();
        assert_eq!(
            e,
            ManifestVerifyError::CanonicalBytesFailure(CanonicalBytesError::PermissionEncodeFailed)
        );
    }

    /// WHY (EDGE-LOW-001 closure): Gate 2 InvalidNow fires when SystemTime
    ///      is earlier than UNIX_EPOCH. Prevents a clock-misconfigured host
    ///      from sneaking by expiry checks with a negative `now`.
    #[test]
    fn rejects_now_before_unix_epoch() {
        let m = canned_manifest(10, 1_000, 9_000);
        let signed = signed(m);
        let pre_epoch = SystemTime::UNIX_EPOCH - Duration::from_secs(1);
        let err = verify_manifest(&signed, &tenant(), 0, pre_epoch, |_, _| true)
            .expect_err("pre-epoch now");
        assert_eq!(err, ManifestVerifyError::InvalidNow);
    }

    /// WHY (EDGE-LOW-002 closure — inclusive lower bound pin): `now ==
    ///      valid_from` is the FIRST moment the manifest is active. Docstring
    ///      contract says `valid_from..=valid_until`; code uses `<` (strict
    ///      less-than) which gives inclusive lower bound. A future refactor
    ///      to `<=` would silently invert the boundary and reject a manifest
    ///      on its activation instant.
    #[test]
    fn accepts_now_exactly_at_valid_from() {
        let m = canned_manifest(10, 5_000, 9_000);
        let signed = signed(m.clone());
        verify_manifest(&signed, &tenant(), 0, now_at(5_000), |_, _| true)
            .expect("inclusive lower bound: now == valid_from must pass");
    }

    /// WHY (EDGE-LOW-002 closure — inclusive upper bound pin): `now ==
    ///      valid_until` is the LAST moment the manifest is active. Same
    ///      contract + refactor-regression guard as above.
    #[test]
    fn accepts_now_exactly_at_valid_until() {
        let m = canned_manifest(10, 1_000, 5_000);
        let signed = signed(m.clone());
        verify_manifest(&signed, &tenant(), 0, now_at(5_000), |_, _| true)
            .expect("inclusive upper bound: now == valid_until must pass");
    }
}
