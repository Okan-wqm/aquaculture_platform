//! # verify_config_integrity — startup config-sig gate (plan D-13)
//!
//! Called at systemd agent startup. Fail-closed: any Err return stops the
//! boot via a `std::process::exit(exit_code::CONFIG_VERIFY_FAILED)` in
//! Sprint 6.6 (well before any IO or network listeners are bound).

use super::error::ConfigIntegrityError;
use super::manifest::{ConfigMeta, SignedConfigMeta};
use crate::authz::permission::DeviceId;
use crate::updater::manifest::Sha256Digest;

/// Verify the config-integrity sidecar.
///
/// **Gate ordering (cheapest-first):**
///
/// 1. DeviceMismatch — 16-byte compare of meta.device_id vs
///    provisioning-bound `expected_device`.
/// 2. StaleConfigVersion — monotonic strict-greater-than.
/// 3. ConfigDigestMismatch — 32-byte compare of meta.expected_config_sha256
///    vs caller-computed `actual_config_sha256`. Happens BEFORE ed25519
///    verify so a mismatched sidecar is caught without crypto cost.
/// 4. CanonicalBytesFailure — structural serialization error.
/// 5. InvalidSignature — ed25519 verify (closure-injected).
///
/// Returns the validated `ConfigMeta` on success. Caller then advances
/// `highest_seen_config_version` to `meta.config_version` and boots
/// with the verified config.
///
/// **Closure:** `verify_signature(canonical_bytes, &[u8; 64]) -> bool`
/// — Sprint 6.6 wires `ed25519_dalek::VerifyingKey::verify_strict` against
/// the factory-provisioned config_signing_key public key.
pub fn verify_config_integrity(
    signed: &SignedConfigMeta,
    expected_device: &DeviceId,
    highest_seen_config_version: u64,
    actual_config_sha256: &Sha256Digest,
    verify_signature: impl FnOnce(&[u8], &[u8; 64]) -> bool,
) -> Result<ConfigMeta, ConfigIntegrityError> {
    // Gate 1 — device binding.
    if &signed.meta.device_id != expected_device {
        return Err(ConfigIntegrityError::DeviceMismatch);
    }

    // Gate 2 — strict monotonic version.
    if signed.meta.config_version <= highest_seen_config_version {
        return Err(ConfigIntegrityError::StaleConfigVersion {
            claimed: signed.meta.config_version,
            highest_seen: highest_seen_config_version,
        });
    }

    // Gate 3 — config bytes digest match.
    if signed.meta.expected_config_sha256 != *actual_config_sha256 {
        return Err(ConfigIntegrityError::ConfigDigestMismatch);
    }

    // Gate 4 — canonical bytes structural check.
    let canonical = signed.meta.canonical_bytes()?;

    // Gate 5 — ed25519 verify.
    if !verify_signature(&canonical, signed.signature.as_bytes()) {
        return Err(ConfigIntegrityError::InvalidSignature);
    }

    Ok(signed.meta.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::policy::Ed25519SignatureBytes;

    fn device() -> DeviceId {
        DeviceId::new_from_verified([0xabu8; 16])
    }

    fn other_device() -> DeviceId {
        DeviceId::new_from_verified([0x77u8; 16])
    }

    fn config_sha256() -> Sha256Digest {
        Sha256Digest::from_bytes([0xcdu8; 32])
    }

    fn canned_meta(version: u64) -> ConfigMeta {
        ConfigMeta {
            device_id: device(),
            config_version: version,
            expected_config_sha256: config_sha256(),
            release_tag: "tenant42-prod".to_string(),
        }
    }

    fn signed(m: ConfigMeta) -> SignedConfigMeta {
        SignedConfigMeta {
            meta: m,
            signature: Ed25519SignatureBytes::from_array([0u8; 64]),
        }
    }

    #[test]
    fn accepts_valid_config() {
        let m = canned_meta(5);
        let s = signed(m.clone());
        let verified = verify_config_integrity(&s, &device(), 4, &config_sha256(), |_, _| true)
            .expect("valid");
        assert_eq!(verified, m);
    }

    #[test]
    fn rejects_device_mismatch() {
        let m = canned_meta(5);
        let s = signed(m);
        let err = verify_config_integrity(&s, &other_device(), 4, &config_sha256(), |_, _| true)
            .expect_err("device");
        assert_eq!(err, ConfigIntegrityError::DeviceMismatch);
    }

    #[test]
    fn rejects_equal_config_version() {
        let m = canned_meta(5);
        let s = signed(m);
        let err = verify_config_integrity(&s, &device(), 5, &config_sha256(), |_, _| true)
            .expect_err("equal version");
        assert_eq!(
            err,
            ConfigIntegrityError::StaleConfigVersion {
                claimed: 5,
                highest_seen: 5
            }
        );
    }

    #[test]
    fn rejects_lower_config_version() {
        let m = canned_meta(3);
        let s = signed(m);
        let err = verify_config_integrity(&s, &device(), 10, &config_sha256(), |_, _| true)
            .expect_err("lower version");
        assert_eq!(
            err,
            ConfigIntegrityError::StaleConfigVersion {
                claimed: 3,
                highest_seen: 10
            }
        );
    }

    #[test]
    fn rejects_config_digest_mismatch() {
        let m = canned_meta(5);
        let s = signed(m);
        let wrong = Sha256Digest::from_bytes([0xffu8; 32]);
        let err =
            verify_config_integrity(&s, &device(), 4, &wrong, |_, _| true).expect_err("digest");
        assert_eq!(err, ConfigIntegrityError::ConfigDigestMismatch);
    }

    #[test]
    fn rejects_invalid_signature() {
        let m = canned_meta(5);
        let s = signed(m);
        let err = verify_config_integrity(&s, &device(), 4, &config_sha256(), |_, _| false)
            .expect_err("bad sig");
        assert_eq!(err, ConfigIntegrityError::InvalidSignature);
    }

    #[test]
    fn rejects_empty_release_tag_via_canonical_bytes() {
        let mut m = canned_meta(5);
        m.release_tag = String::new();
        let s = signed(m);
        let err = verify_config_integrity(&s, &device(), 4, &config_sha256(), |_, _| true)
            .expect_err("empty tag");
        assert!(matches!(
            err,
            ConfigIntegrityError::CanonicalBytesFailure(_)
        ));
    }

    #[test]
    fn verifier_receives_canonical_bytes_not_empty() {
        let m = canned_meta(5);
        let s = signed(m);
        let mut received_len = 0usize;
        let _ = verify_config_integrity(&s, &device(), 4, &config_sha256(), |bytes, sig| {
            received_len = bytes.len();
            assert_eq!(sig.len(), 64);
            true
        });
        assert!(received_len > 32);
    }

    /// WHY: Gate ordering check — device mismatch fires BEFORE signature
    ///      verify (cheaper 16-byte compare).
    #[test]
    fn device_mismatch_does_not_run_signature_verify() {
        let m = canned_meta(5);
        let s = signed(m);
        let mut verify_called = false;
        let err = verify_config_integrity(&s, &other_device(), 4, &config_sha256(), |_, _| {
            verify_called = true;
            false
        })
        .expect_err("device");
        assert_eq!(err, ConfigIntegrityError::DeviceMismatch);
        assert!(
            !verify_called,
            "signature verify must not run after device mismatch"
        );
    }

    /// WHY: Gate ordering check — digest mismatch fires BEFORE signature
    ///      verify.
    #[test]
    fn digest_mismatch_does_not_run_signature_verify() {
        let m = canned_meta(5);
        let s = signed(m);
        let wrong = Sha256Digest::from_bytes([0xffu8; 32]);
        let mut verify_called = false;
        let err = verify_config_integrity(&s, &device(), 4, &wrong, |_, _| {
            verify_called = true;
            false
        })
        .expect_err("digest");
        assert_eq!(err, ConfigIntegrityError::ConfigDigestMismatch);
        assert!(
            !verify_called,
            "signature verify must not run after digest mismatch"
        );
    }
}
