//! # ConfigMeta — `/etc/suderra/config.yaml.sig` wire format (plan D-13)
//!
//! The `.sig` sidecar file contains a `SignedConfigMeta`. The signature
//! covers `ConfigMeta::canonical_bytes()` which binds:
//!
//! - Device identity (provisioning-bound `DeviceId`)
//! - Monotonic config version (rollback defense)
//! - SHA-256 of the raw `config.yaml` bytes
//! - Release tag (operator-facing identifier)
//!
//! No timestamp / validity window: the config is applied at boot and
//! doesn't have a natural expiry. Rollback defense uses
//! `highest_seen_config_version` persisted in the keystore's version-
//! tracking SQLCipher table (Sprint 6.3 / 6.6).

use serde::{Deserialize, Serialize};

use super::error::ConfigMetaCanonicalBytesError;
use crate::authz::permission::DeviceId;
use crate::authz::policy::Ed25519SignatureBytes;
use crate::updater::manifest::Sha256Digest;

/// Bound on release_tag — 256 chars accommodates semver + build metadata
/// (`"v2.0.0-rc3+build.456"`) without unbounded growth.
pub const MAX_RELEASE_TAG_BYTES: usize = 256;

/// Signed body. Cloud-side signing tool (operator workstation) produces
/// this struct, computes `canonical_bytes`, signs with the
/// `config_signing_key`, and emits the `SignedConfigMeta` JSON sidecar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfigMeta {
    /// Provisioning-bound device identity. Must match
    /// `ProvisioningBlob::verified_device_id()` — cross-device pivot
    /// defense.
    pub device_id: DeviceId,

    /// Monotonic config version. Edge persists highest-seen value; inbound
    /// signed config with `<=` is rejected.
    pub config_version: u64,

    /// SHA-256 of the raw `config.yaml` file bytes. Sprint 6.6 computes
    /// this on the wire receive path; verifier compares against
    /// `expected_config_sha256` here.
    pub expected_config_sha256: Sha256Digest,

    /// Human-readable release tag (e.g. `"tenant42-prod-v2.0.0"`). Used
    /// for operator-facing display + audit trail attribution.
    pub release_tag: String,
}

/// Signed wire format. The `meta` field seal mirrors the Batch 5b
/// `SignedRbacManifest` + Batch 8 `SignedFirmwareManifest` discipline —
/// external consumers reach the body ONLY through `verify_config_integrity`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedConfigMeta {
    pub(crate) meta: ConfigMeta,
    pub signature: Ed25519SignatureBytes,
}

fn u32_len(n: usize) -> Result<u32, ConfigMetaCanonicalBytesError> {
    u32::try_from(n).map_err(|_| ConfigMetaCanonicalBytesError::LengthExceedsU32)
}

impl ConfigMeta {
    /// Canonical bytes — length-prefix framing. Layout:
    ///
    /// ```text
    /// device_id.as_bytes() (16 fixed) ||
    /// be_u64(config_version) ||
    /// expected_config_sha256.as_bytes() (32 fixed) ||
    /// be_u32(release_tag.len()) || release_tag ||
    /// b"config-meta-v1"
    /// ```
    ///
    /// Domain-separation tag `b"config-meta-v1"` distinct from
    /// acceptance-token / rbac-manifest / audit-entry / command-envelope /
    /// firmware-manifest canonical bytes.
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, ConfigMetaCanonicalBytesError> {
        if self.release_tag.is_empty() {
            return Err(ConfigMetaCanonicalBytesError::EmptyReleaseTag);
        }
        if self.release_tag.len() > MAX_RELEASE_TAG_BYTES {
            return Err(ConfigMetaCanonicalBytesError::ReleaseTagTooLong(
                self.release_tag.len(),
            ));
        }

        let mut out = Vec::with_capacity(64 + self.release_tag.len());
        out.extend_from_slice(self.device_id.as_bytes());
        out.extend_from_slice(&self.config_version.to_be_bytes());
        out.extend_from_slice(self.expected_config_sha256.as_bytes());

        let tag_bytes = self.release_tag.as_bytes();
        out.extend_from_slice(&u32_len(tag_bytes.len())?.to_be_bytes());
        out.extend_from_slice(tag_bytes);

        out.extend_from_slice(b"config-meta-v1");
        Ok(out)
    }
}

impl SignedConfigMeta {
    /// Construct from a ConfigMeta body + raw signature bytes.
    ///
    /// Batch 54 note: the runtime verify path
    /// (config_integrity::verify_runtime) deserializes
    /// SignedConfigMeta directly via `serde_json::from_slice`,
    /// not via this constructor. Kept as a compile-time
    /// fallback for future offline-constructor callers
    /// (e.g., a `suderra-config-sign` CLI that would produce
    /// the meta + sig pair programmatically).
    #[allow(dead_code)]
    pub fn from_body_and_signature_bytes(
        meta: ConfigMeta,
        signature_bytes: &[u8],
    ) -> Result<Self, crate::authz::policy::InvalidSignatureLength> {
        Ok(Self {
            meta,
            signature: Ed25519SignatureBytes::from_slice(signature_bytes)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::permission::DeviceId;

    fn device() -> DeviceId {
        DeviceId::new_from_verified([0xabu8; 16])
    }

    fn canned_meta() -> ConfigMeta {
        ConfigMeta {
            device_id: device(),
            config_version: 42,
            expected_config_sha256: Sha256Digest::from_bytes([0xcdu8; 32]),
            release_tag: "tenant42-prod-v2.0.0".to_string(),
        }
    }

    #[test]
    fn canonical_bytes_deterministic() {
        let m = canned_meta();
        let a = m.canonical_bytes().expect("ok");
        let b = m.canonical_bytes().expect("ok");
        assert_eq!(a, b);
    }

    #[test]
    fn canonical_bytes_ends_with_v1_tag() {
        let m = canned_meta();
        let bytes = m.canonical_bytes().expect("ok");
        assert!(bytes.ends_with(b"config-meta-v1"));
    }

    #[test]
    fn canonical_bytes_sensitive_to_every_field() {
        let base = canned_meta();
        let base_bytes = base.canonical_bytes().expect("ok");

        let mut d = base.clone();
        d.device_id = DeviceId::new_from_verified([0x99u8; 16]);
        assert_ne!(base_bytes, d.canonical_bytes().expect("ok"));

        let mut v = base.clone();
        v.config_version += 1;
        assert_ne!(base_bytes, v.canonical_bytes().expect("ok"));

        let mut h = base.clone();
        h.expected_config_sha256 = Sha256Digest::from_bytes([0xeeu8; 32]);
        assert_ne!(base_bytes, h.canonical_bytes().expect("ok"));

        let mut t = base.clone();
        t.release_tag = "tenant42-prod-v2.0.1".to_string();
        assert_ne!(base_bytes, t.canonical_bytes().expect("ok"));
    }

    #[test]
    fn rejects_empty_release_tag() {
        let mut m = canned_meta();
        m.release_tag = String::new();
        let err = m.canonical_bytes().expect_err("empty");
        assert_eq!(err, ConfigMetaCanonicalBytesError::EmptyReleaseTag);
    }

    #[test]
    fn rejects_oversized_release_tag() {
        let mut m = canned_meta();
        m.release_tag = "x".repeat(MAX_RELEASE_TAG_BYTES + 1);
        let err = m.canonical_bytes().expect_err("too long");
        assert_eq!(
            err,
            ConfigMetaCanonicalBytesError::ReleaseTagTooLong(MAX_RELEASE_TAG_BYTES + 1)
        );
    }

    #[test]
    fn accepts_release_tag_at_exact_bound() {
        let mut m = canned_meta();
        m.release_tag = "a".repeat(MAX_RELEASE_TAG_BYTES);
        m.canonical_bytes().expect("at bound must accept");
    }

    #[test]
    fn signed_meta_rejects_wrong_signature_length() {
        let m = canned_meta();
        let err =
            SignedConfigMeta::from_body_and_signature_bytes(m, &[0u8; 63]).expect_err("short");
        assert_eq!(err.got, 63);
    }

    #[test]
    fn signed_meta_accepts_64_byte_signature() {
        let m = canned_meta();
        SignedConfigMeta::from_body_and_signature_bytes(m, &[0u8; 64]).expect("ok");
    }

    #[test]
    fn signed_meta_json_roundtrip() {
        let signed = SignedConfigMeta {
            meta: canned_meta(),
            signature: Ed25519SignatureBytes::from_array([0x11u8; 64]),
        };
        let json = serde_json::to_string(&signed).expect("ok");
        let back: SignedConfigMeta = serde_json::from_str(&json).expect("ok");
        assert_eq!(back, signed);
    }
}
