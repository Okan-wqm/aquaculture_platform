//! # verify_firmware_manifest — the fail-closed gate (ADR-019 §5)
//!
//! Every firmware manifest entering the edge passes through this function.
//! It runs 8 ordered gates (cheapest first, crypto + per-file digest last),
//! matching the same discipline as `authz::verify_manifest` in Batch 5b.
//!
//! ## Scope of Batch 8
//!
//! Types + function signature. Signature verify + per-file SHA-256
//! recompute are closure-injected — Sprint 6.5 wires `ed25519_dalek` + a
//! SHA-256 file-reader that streams the standby partition.

use std::time::SystemTime;

use super::error::ManifestVerifyError;
use super::manifest::{FirmwareManifest, SignedFirmwareManifest, TargetArch};
use crate::authz::permission::TenantId;

// NOTE (EDGE-LOW-001 closure): a prior draft exported a
// `VerifySignatureClosure<'a>` type alias referring to `&'a dyn Fn(...)`.
// It was never used anywhere because `verify_firmware_manifest` takes the
// closure via `impl FnOnce` (monomorphized) — a type-erased trait-object
// alias added noise without value. Removed.

/// Verify a signed firmware manifest. Returns the validated manifest body
/// on success; fail-closed with structured [`ManifestVerifyError`] on any
/// gate rejection.
///
/// **Gate ordering (cheapest-first):**
///
/// 1. Target architecture match (`self.target_arch == TargetArch::compiled_target`)
/// 2. Validity window sanity (`valid_from <= valid_until`)
/// 3. Clock sanity (`now >= UNIX_EPOCH`)
/// 4. Tenant match
/// 5. Firmware version strict monotonic (`version > highest_seen`)
/// 6. Freshness window (`now` within `[valid_from, valid_until]`)
/// 7. Canonical-bytes serialization (structural well-formedness)
/// 8. ed25519 signature verify (closure-injected; most expensive)
///
/// Per-file digest verify is NOT part of this function — it happens AFTER
/// the manifest is validated, inside the `apply_update` flow (Sprint 6.5)
/// which streams each file's bytes from disk and computes SHA-256. Keeping
/// the two verification surfaces separate lets callers verify-once +
/// download-then-digest-verify.
///
/// **Fail-closed discipline:** any Err return leaves the partition state
/// unchanged. Caller MUST NOT write to standby on error.
pub fn verify_firmware_manifest(
    signed: &SignedFirmwareManifest,
    expected_tenant: &TenantId,
    highest_seen_firmware_version: u64,
    now: SystemTime,
    verify_signature: impl FnOnce(&[u8], &[u8; 64]) -> bool,
) -> Result<FirmwareManifest, ManifestVerifyError> {
    // Gate 1 — target arch. Fastest check; rejects wrong-arch manifests
    // before any other work. Reserved in tests via injected compiled target.
    if signed.manifest.target_arch != TargetArch::compiled_target() {
        return Err(ManifestVerifyError::TargetArchMismatch);
    }

    // Gate 2 — validity window sanity.
    if signed.manifest.valid_from_unix_secs > signed.manifest.valid_until_unix_secs {
        return Err(ManifestVerifyError::InvalidValidityWindow {
            valid_from: signed.manifest.valid_from_unix_secs,
            valid_until: signed.manifest.valid_until_unix_secs,
        });
    }

    // Gate 3 — clock sanity.
    let now_unix_secs = match now.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(d) => d.as_secs() as i64,
        Err(_) => return Err(ManifestVerifyError::InvalidNow),
    };

    // Gate 4 — tenant match (cross-tenant firmware pivot defense).
    if &signed.manifest.tenant_id != expected_tenant {
        return Err(ManifestVerifyError::TenantMismatch);
    }

    // Gate 5 — firmware version strict monotonic (ADR-019 §4 rollback
    // defense).
    if signed.manifest.firmware_version <= highest_seen_firmware_version {
        return Err(ManifestVerifyError::StaleFirmwareVersion {
            claimed: signed.manifest.firmware_version,
            highest_seen: highest_seen_firmware_version,
        });
    }

    // Gate 6 — now within validity window.
    if now_unix_secs < signed.manifest.valid_from_unix_secs {
        return Err(ManifestVerifyError::NotYetValid {
            now_unix_secs,
            valid_from: signed.manifest.valid_from_unix_secs,
        });
    }
    if now_unix_secs > signed.manifest.valid_until_unix_secs {
        return Err(ManifestVerifyError::Expired {
            now_unix_secs,
            valid_until: signed.manifest.valid_until_unix_secs,
        });
    }

    // Gate 7 — canonical bytes (structural).
    let canonical = signed.manifest.canonical_bytes()?;

    // Gate 8 — ed25519 verify (most expensive).
    if !verify_signature(&canonical, signed.signature.as_bytes()) {
        return Err(ManifestVerifyError::InvalidSignature);
    }

    Ok(signed.manifest.clone())
}

#[cfg(test)]
mod tests {
    use super::super::manifest::{FileDigest, FileEntry, Sha256Digest};
    use super::*;
    use crate::authz::policy::Ed25519SignatureBytes;
    use std::time::Duration;

    fn tenant() -> TenantId {
        TenantId::new_from_verified([0x42u8; 16])
    }

    fn other_tenant() -> TenantId {
        TenantId::new_from_verified([0x99u8; 16])
    }

    /// Build a canned manifest targeting the compiled arch so Gate 1 passes.
    fn canned(fw_version: u64, valid_from: i64, valid_until: i64) -> FirmwareManifest {
        FirmwareManifest {
            firmware_version: fw_version,
            tenant_id: tenant(),
            target_arch: TargetArch::compiled_target(),
            valid_from_unix_secs: valid_from,
            valid_until_unix_secs: valid_until,
            release_tag: "test".to_string(),
            files: vec![FileEntry {
                path: "bin/suderra-agent".to_string(),
                digest: FileDigest {
                    sha256: Sha256Digest::from_bytes([0xaau8; 32]),
                    size_bytes: 1_000_000,
                    mode: 0o755,
                },
            }],
        }
    }

    fn signed(m: FirmwareManifest) -> SignedFirmwareManifest {
        SignedFirmwareManifest {
            manifest: m,
            signature: Ed25519SignatureBytes::from_array([0u8; 64]),
        }
    }

    fn now_at(unix_secs: i64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(unix_secs as u64)
    }

    #[test]
    fn accepts_valid_manifest() {
        let m = canned(1_000, 1_000, 9_000);
        let s = signed(m.clone());
        let verified = verify_firmware_manifest(&s, &tenant(), 999, now_at(5_000), |_, _| true)
            .expect("valid");
        assert_eq!(verified, m);
    }

    #[test]
    fn rejects_target_arch_mismatch() {
        let mut m = canned(1_000, 1_000, 9_000);
        // Pick a DIFFERENT target arch than compiled_target().
        m.target_arch = match TargetArch::compiled_target() {
            TargetArch::Aarch64UnknownLinuxGnu => TargetArch::X86_64UnknownLinuxGnu,
            TargetArch::Armv7UnknownLinuxGnueabihf => TargetArch::Aarch64UnknownLinuxGnu,
            TargetArch::X86_64UnknownLinuxGnu => TargetArch::Aarch64UnknownLinuxGnu,
        };
        let s = signed(m);
        let err = verify_firmware_manifest(&s, &tenant(), 999, now_at(5_000), |_, _| true)
            .expect_err("arch");
        assert_eq!(err, ManifestVerifyError::TargetArchMismatch);
    }

    #[test]
    fn rejects_tenant_mismatch() {
        let m = canned(1_000, 1_000, 9_000);
        let s = signed(m);
        let err = verify_firmware_manifest(&s, &other_tenant(), 999, now_at(5_000), |_, _| true)
            .expect_err("tenant");
        assert_eq!(err, ManifestVerifyError::TenantMismatch);
    }

    #[test]
    fn rejects_equal_firmware_version() {
        let m = canned(1_000, 1_000, 9_000);
        let s = signed(m);
        let err = verify_firmware_manifest(&s, &tenant(), 1_000, now_at(5_000), |_, _| true)
            .expect_err("equal version");
        assert_eq!(
            err,
            ManifestVerifyError::StaleFirmwareVersion {
                claimed: 1_000,
                highest_seen: 1_000,
            }
        );
    }

    #[test]
    fn rejects_lower_firmware_version() {
        let m = canned(100, 1_000, 9_000);
        let s = signed(m);
        let err = verify_firmware_manifest(&s, &tenant(), 1_000, now_at(5_000), |_, _| true)
            .expect_err("lower version");
        assert_eq!(
            err,
            ManifestVerifyError::StaleFirmwareVersion {
                claimed: 100,
                highest_seen: 1_000,
            }
        );
    }

    #[test]
    fn rejects_not_yet_valid() {
        let m = canned(1_000, 5_000, 9_000);
        let s = signed(m);
        let err = verify_firmware_manifest(&s, &tenant(), 999, now_at(1_000), |_, _| true)
            .expect_err("future");
        assert!(matches!(err, ManifestVerifyError::NotYetValid { .. }));
    }

    #[test]
    fn rejects_expired() {
        let m = canned(1_000, 1_000, 5_000);
        let s = signed(m);
        let err = verify_firmware_manifest(&s, &tenant(), 999, now_at(9_000), |_, _| true)
            .expect_err("expired");
        assert!(matches!(err, ManifestVerifyError::Expired { .. }));
    }

    #[test]
    fn rejects_inverted_validity_window() {
        let m = canned(1_000, 9_000, 1_000);
        let s = signed(m);
        let err = verify_firmware_manifest(&s, &tenant(), 999, now_at(5_000), |_, _| true)
            .expect_err("inverted");
        assert_eq!(
            err,
            ManifestVerifyError::InvalidValidityWindow {
                valid_from: 9_000,
                valid_until: 1_000,
            }
        );
    }

    #[test]
    fn rejects_invalid_signature() {
        let m = canned(1_000, 1_000, 9_000);
        let s = signed(m);
        let err = verify_firmware_manifest(&s, &tenant(), 999, now_at(5_000), |_, _| false)
            .expect_err("bad sig");
        assert_eq!(err, ManifestVerifyError::InvalidSignature);
    }

    #[test]
    fn rejects_now_before_unix_epoch() {
        let m = canned(1_000, 1_000, 9_000);
        let s = signed(m);
        let pre_epoch = SystemTime::UNIX_EPOCH - Duration::from_secs(1);
        let err = verify_firmware_manifest(&s, &tenant(), 999, pre_epoch, |_, _| true)
            .expect_err("pre-epoch");
        assert_eq!(err, ManifestVerifyError::InvalidNow);
    }

    #[test]
    fn accepts_now_at_exact_valid_from() {
        let m = canned(1_000, 5_000, 9_000);
        let s = signed(m);
        verify_firmware_manifest(&s, &tenant(), 999, now_at(5_000), |_, _| true)
            .expect("inclusive lower");
    }

    #[test]
    fn accepts_now_at_exact_valid_until() {
        let m = canned(1_000, 1_000, 5_000);
        let s = signed(m);
        verify_firmware_manifest(&s, &tenant(), 999, now_at(5_000), |_, _| true)
            .expect("inclusive upper");
    }

    #[test]
    fn verifier_receives_canonical_bytes_not_empty() {
        let m = canned(1_000, 1_000, 9_000);
        let s = signed(m);
        let mut received_len = 0usize;
        let _ = verify_firmware_manifest(&s, &tenant(), 999, now_at(5_000), |canon, sig| {
            received_len = canon.len();
            assert_eq!(sig.len(), 64);
            true
        });
        assert!(received_len > 32);
    }

    #[test]
    fn rejects_empty_files_vector_via_canonical_bytes_failure() {
        let mut m = canned(1_000, 1_000, 9_000);
        m.files.clear();
        let s = signed(m);
        let err = verify_firmware_manifest(&s, &tenant(), 999, now_at(5_000), |_, _| true)
            .expect_err("empty files");
        assert!(matches!(err, ManifestVerifyError::CanonicalBytesFailure(_)));
    }
}
