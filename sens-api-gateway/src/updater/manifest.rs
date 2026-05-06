//! # FirmwareManifest — signed A/B partition update manifest (ADR-019 §3)
//!
//! Wire format for a firmware update. The cloud-side release pipeline
//! builds a `FirmwareManifest`, signs it with the `firmware_signing_key`
//! under the 4-eye HSM ceremony (ADR-021 slot 1), and delivers the
//! `SignedFirmwareManifest` to the device via:
//!
//! - MQTT `cmd/deploy_firmware` command (primary path)
//! - HTTP PUT `/api/v1/firmware` for pre-bound edge networks (secondary)
//!
//! The edge verifies (Batch 8 `verify::verify_firmware_manifest`) then
//! writes each file to the standby slot, fsyncs, re-hashes post-fsync
//! (TOCTOU mitigation per ADR-019 §5), and swaps. The bootloader
//! `tryboot` overlay gets updated atomically.

use serde::{Deserialize, Serialize};

use super::error::FirmwareManifestCanonicalBytesError;
use crate::authz::permission::TenantId;
use crate::authz::policy::Ed25519SignatureBytes;

/// Target architecture — narrow set of cross-compile targets the plan
/// commits to (plan §2 hard cross-compile requirements). Adding a variant
/// is an ADR-level decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetArch {
    Aarch64UnknownLinuxGnu,
    Armv7UnknownLinuxGnueabihf,
    X86_64UnknownLinuxGnu,
}

impl TargetArch {
    pub const fn wire_tag(self) -> u8 {
        match self {
            Self::Aarch64UnknownLinuxGnu => 0,
            Self::Armv7UnknownLinuxGnueabihf => 1,
            Self::X86_64UnknownLinuxGnu => 2,
        }
    }

    /// The architecture this binary was compiled for. Sprint 6.5 uses
    /// this to reject manifests targeting a different arch.
    ///
    /// **EDGE-LOW-004 closure:** the `#[cfg(not(any(...)))]` fallback is a
    /// `compile_error!` rather than a silent x86_64 default. A release
    /// engineer cross-compiling to an unexpected arch (riscv64, powerpc64,
    /// mips, wasm32, …) gets a build-time failure forcing an ADR-019
    /// amendment to add the variant, rather than a runtime
    /// `TargetArchMismatch` that could be misdiagnosed as a manifest bug.
    /// Tier-1 make-it-impossible over tier-3 fail-closed fallback.
    pub const fn compiled_target() -> Self {
        #[cfg(target_arch = "aarch64")]
        {
            Self::Aarch64UnknownLinuxGnu
        }
        #[cfg(all(target_arch = "arm", target_pointer_width = "32"))]
        {
            Self::Armv7UnknownLinuxGnueabihf
        }
        #[cfg(target_arch = "x86_64")]
        {
            Self::X86_64UnknownLinuxGnu
        }
        #[cfg(not(any(
            target_arch = "aarch64",
            target_arch = "x86_64",
            all(target_arch = "arm", target_pointer_width = "32")
        )))]
        {
            compile_error!(
                "TargetArch::compiled_target lacks a variant for this target_arch — \
                 add an ADR-019 amendment + new TargetArch variant + wire_tag byte, \
                 or cross-compile to aarch64 / armv7 / x86_64"
            );
        }
    }
}

/// SHA-256 digest — 32 bytes wrapped in a newtype for type-level
/// discipline (same pattern as `CmdHash` in Batch 7). `#[serde(transparent)]`
/// preserves JSON array shape.
///
/// **Domain separation (EDGE-LOW-003 documentation closure):** this type is
/// DELIBERATELY distinct from the other 32-byte wrappers in the codebase:
/// [`crate::audit::PrevHmac`] / [`crate::audit::CurrentHmac`] (audit-log
/// HMAC chain outputs) and [`crate::command_envelope::CmdHash`] (SHA-256
/// of command-envelope canonical params). Collapsing them into a shared
/// `Digest32` would collapse the tier-1 make-it-impossible guarantee that
/// a consumer cannot accidentally pass an audit HMAC where a firmware
/// digest is expected, or vice versa. Each wrapper carries its domain in
/// the TYPE, not just the value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Sha256Digest([u8; 32]);

impl Sha256Digest {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// File digest + size + mode triple — the per-file contract.
///
/// `mode` carries the Unix permission bits (e.g. `0o755` for `bin/`
/// executables, `0o644` for configs). EDGE-MEDIUM-001 closure: fixed at
/// v1 canonical-bytes time so Sprint 6.5 `apply_update` cannot infer
/// permissions from directory convention. A manifest declaring `0o755`
/// for `etc/shadow` would still be rejected by the fs-boundary writer —
/// this field is the AUTHORITY for the target permission set.
///
/// **Why `u32` not `u16`:** Linux `stat.st_mode` is `u32`. Although the
/// setuid/setgid/sticky+permission bits fit in 12 low bits, keeping the
/// full 32-bit width preserves compatibility with future extended-mode
/// bits (e.g. capabilities) without a v2 bump.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileDigest {
    pub sha256: Sha256Digest,
    pub size_bytes: u64,
    pub mode: u32,
}

/// Bound on file path length in the manifest. 512 accommodates deep
/// pathnames without unbounded growth — typical paths are under 128
/// characters.
pub const MAX_FILE_PATH_BYTES: usize = 512;

/// One file in the firmware bundle. Paths are relative to the A/B slot
/// root (e.g. `bin/suderra-agent`, `etc/suderra/config.defaults.yaml`,
/// `lib/libssl.so.3`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub digest: FileDigest,
}

/// Signed manifest body (ADR-019 §3). Cloud release pipeline produces this;
/// `canonical_bytes()` below is fed to the HSM ceremony for signing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FirmwareManifest {
    /// Monotonic version. `highest_seen_firmware_version` persisted on-
    /// device; inbound manifest with `<=` is rejected as rollback attempt.
    pub firmware_version: u64,

    /// Tenant binding. Must equal provisioning-bound tenant (ADR-019 §4).
    pub tenant_id: TenantId,

    /// Target architecture — rejected if != `TargetArch::compiled_target()`.
    pub target_arch: TargetArch,

    /// Validity window (UNIX seconds). Firmware outside this window fails
    /// verify. Typical 30-day rolling window tied to the release cadence.
    pub valid_from_unix_secs: i64,
    pub valid_until_unix_secs: i64,

    /// Human-readable release tag (e.g. "v2.0.0-rc3"). For audit +
    /// operator-facing display.
    pub release_tag: String,

    /// Every file in the bundle. Non-empty (enforced at canonical_bytes).
    pub files: Vec<FileEntry>,
}

/// The wire-format signed manifest — body + signature.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedFirmwareManifest {
    /// `pub(crate)` seal — consumers reach the body ONLY through
    /// `verify::verify_firmware_manifest`. Same discipline as Batch 5b
    /// `SignedRbacManifest` (EDGE-HIGH audit finding closure).
    pub(crate) manifest: FirmwareManifest,
    pub signature: Ed25519SignatureBytes,
}

fn u32_len(n: usize) -> Result<u32, FirmwareManifestCanonicalBytesError> {
    u32::try_from(n).map_err(|_| FirmwareManifestCanonicalBytesError::LengthExceedsU32)
}

/// Tier-1 make-it-impossible path-traversal defense (EDGE-MEDIUM-002 closure).
///
/// Rejects:
/// - Absolute paths (leading `/`).
/// - Paths containing `..` component (traversal).
/// - Paths containing `.` component (current-dir shorthand, ambiguous).
/// - NUL bytes anywhere (Unix path syscalls truncate at NUL).
/// - Backslash `\` (Windows path separator; not valid in Unix firmware
///   paths and a common cross-platform smuggling vector).
/// - Empty components (`foo//bar` leading to apply_update ambiguity).
///
/// Accepts normal relative paths like `bin/suderra-agent`,
/// `etc/suderra/config.defaults.yaml`, `lib/systemd/system/suderra.service`.
fn file_path_is_safe(path: &str) -> Result<(), FirmwareManifestCanonicalBytesError> {
    if path.starts_with('/') {
        return Err(FirmwareManifestCanonicalBytesError::UnsafeFilePath {
            path: path.to_string(),
        });
    }
    if path.as_bytes().contains(&0) {
        return Err(FirmwareManifestCanonicalBytesError::UnsafeFilePath {
            path: path.to_string(),
        });
    }
    if path.contains('\\') {
        return Err(FirmwareManifestCanonicalBytesError::UnsafeFilePath {
            path: path.to_string(),
        });
    }
    for component in path.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err(FirmwareManifestCanonicalBytesError::UnsafeFilePath {
                path: path.to_string(),
            });
        }
    }
    Ok(())
}

impl FirmwareManifest {
    /// Canonical bytes — length-prefix framing. Layout:
    ///
    /// ```text
    /// be_u64(firmware_version) ||
    /// tenant_id.as_bytes() (16 fixed) ||
    /// u8(target_arch.wire_tag()) ||
    /// be_i64(valid_from_unix_secs) ||
    /// be_i64(valid_until_unix_secs) ||
    /// be_u32(release_tag.len()) || release_tag.as_bytes() ||
    /// be_u32(files.len()) ||
    ///   for each file:
    ///     be_u32(path.len()) || path.as_bytes() ||
    ///     digest.sha256.as_bytes() (32 fixed) ||
    ///     be_u64(size_bytes) ||
    ///     be_u32(mode) ||
    /// b"firmware-manifest-v1"
    /// ```
    ///
    /// Domain-separation tag distinguishes from acceptance-token,
    /// rbac-manifest, audit-entry, and command-envelope canonical bytes.
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, FirmwareManifestCanonicalBytesError> {
        if self.files.is_empty() {
            return Err(FirmwareManifestCanonicalBytesError::EmptyFilesVector);
        }
        for f in &self.files {
            if f.path.is_empty() {
                return Err(FirmwareManifestCanonicalBytesError::EmptyFilePath);
            }
            if f.path.len() > MAX_FILE_PATH_BYTES {
                return Err(FirmwareManifestCanonicalBytesError::FilePathTooLong(
                    f.path.len(),
                ));
            }
            // EDGE-MEDIUM-002 closure: tier-1 path-traversal defense at the
            // signing boundary. Sprint 6.5 apply_update writes these paths
            // relative to the standby slot root; a traversal would escape.
            file_path_is_safe(&f.path)?;
        }

        let mut out = Vec::with_capacity(64 + self.files.len() * 64);

        out.extend_from_slice(&self.firmware_version.to_be_bytes());
        out.extend_from_slice(self.tenant_id.as_bytes());
        out.push(self.target_arch.wire_tag());
        out.extend_from_slice(&self.valid_from_unix_secs.to_be_bytes());
        out.extend_from_slice(&self.valid_until_unix_secs.to_be_bytes());

        let tag_bytes = self.release_tag.as_bytes();
        out.extend_from_slice(&u32_len(tag_bytes.len())?.to_be_bytes());
        out.extend_from_slice(tag_bytes);

        out.extend_from_slice(&u32_len(self.files.len())?.to_be_bytes());
        for f in &self.files {
            let path_bytes = f.path.as_bytes();
            out.extend_from_slice(&u32_len(path_bytes.len())?.to_be_bytes());
            out.extend_from_slice(path_bytes);
            out.extend_from_slice(f.digest.sha256.as_bytes());
            out.extend_from_slice(&f.digest.size_bytes.to_be_bytes());
            out.extend_from_slice(&f.digest.mode.to_be_bytes());
        }

        out.extend_from_slice(b"firmware-manifest-v1");
        Ok(out)
    }
}

impl SignedFirmwareManifest {
    /// Construct from body + signature bytes. Validates signature length
    /// at the parse boundary via `Ed25519SignatureBytes::from_slice`.
    pub fn from_body_and_signature_bytes(
        manifest: FirmwareManifest,
        signature_bytes: &[u8],
    ) -> Result<Self, crate::authz::policy::InvalidSignatureLength> {
        Ok(Self {
            manifest,
            signature: Ed25519SignatureBytes::from_slice(signature_bytes)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::permission::TenantId;

    fn tenant() -> TenantId {
        TenantId::new_from_verified([0x42u8; 16])
    }

    fn canned_manifest() -> FirmwareManifest {
        FirmwareManifest {
            firmware_version: 2_000_000,
            tenant_id: tenant(),
            target_arch: TargetArch::Aarch64UnknownLinuxGnu,
            valid_from_unix_secs: 1_700_000_000,
            valid_until_unix_secs: 1_800_000_000,
            release_tag: "v2.0.0".to_string(),
            files: vec![FileEntry {
                path: "bin/suderra-agent".to_string(),
                digest: FileDigest {
                    sha256: Sha256Digest::from_bytes([0xaau8; 32]),
                    size_bytes: 10_000_000,
                    mode: 0o755,
                },
            }],
        }
    }

    #[test]
    fn canonical_bytes_deterministic() {
        let m = canned_manifest();
        let a = m.canonical_bytes().expect("ok");
        let b = m.canonical_bytes().expect("ok");
        assert_eq!(a, b);
    }

    #[test]
    fn canonical_bytes_ends_with_v1_tag() {
        let m = canned_manifest();
        let bytes = m.canonical_bytes().expect("ok");
        assert!(bytes.ends_with(b"firmware-manifest-v1"));
    }

    #[test]
    fn canonical_bytes_sensitive_to_every_top_level_field() {
        let base = canned_manifest();
        let base_bytes = base.canonical_bytes().expect("ok");

        let mut v = base.clone();
        v.firmware_version += 1;
        assert_ne!(base_bytes, v.canonical_bytes().expect("ok"));

        let mut t = base.clone();
        t.tenant_id = TenantId::new_from_verified([0x99u8; 16]);
        assert_ne!(base_bytes, t.canonical_bytes().expect("ok"));

        let mut arch = base.clone();
        arch.target_arch = TargetArch::Armv7UnknownLinuxGnueabihf;
        assert_ne!(base_bytes, arch.canonical_bytes().expect("ok"));

        let mut vf = base.clone();
        vf.valid_from_unix_secs += 1;
        assert_ne!(base_bytes, vf.canonical_bytes().expect("ok"));

        let mut vu = base.clone();
        vu.valid_until_unix_secs += 1;
        assert_ne!(base_bytes, vu.canonical_bytes().expect("ok"));

        let mut tag = base.clone();
        tag.release_tag = "v2.0.1".to_string();
        assert_ne!(base_bytes, tag.canonical_bytes().expect("ok"));

        let mut files = base.clone();
        files.files[0].digest.size_bytes += 1;
        assert_ne!(base_bytes, files.canonical_bytes().expect("ok"));

        // EDGE-MEDIUM-001 regression guard: mode changes canonical bytes.
        let mut mode = base.clone();
        mode.files[0].digest.mode = 0o644;
        assert_ne!(base_bytes, mode.canonical_bytes().expect("ok"));
    }

    /// WHY (EDGE-MEDIUM-002 closure): absolute paths rejected.
    #[test]
    fn rejects_absolute_file_path() {
        let mut m = canned_manifest();
        m.files[0].path = "/etc/shadow".to_string();
        let err = m.canonical_bytes().expect_err("absolute");
        assert!(matches!(
            err,
            FirmwareManifestCanonicalBytesError::UnsafeFilePath { .. }
        ));
    }

    #[test]
    fn rejects_parent_dir_traversal() {
        let mut m = canned_manifest();
        m.files[0].path = "bin/../../etc/shadow".to_string();
        let err = m.canonical_bytes().expect_err("traversal");
        assert!(matches!(
            err,
            FirmwareManifestCanonicalBytesError::UnsafeFilePath { .. }
        ));
    }

    #[test]
    fn rejects_current_dir_component() {
        let mut m = canned_manifest();
        m.files[0].path = "bin/./agent".to_string();
        let err = m.canonical_bytes().expect_err("dot component");
        assert!(matches!(
            err,
            FirmwareManifestCanonicalBytesError::UnsafeFilePath { .. }
        ));
    }

    #[test]
    fn rejects_path_with_nul_byte() {
        let mut m = canned_manifest();
        m.files[0].path = "bin/agent\0malicious".to_string();
        let err = m.canonical_bytes().expect_err("NUL");
        assert!(matches!(
            err,
            FirmwareManifestCanonicalBytesError::UnsafeFilePath { .. }
        ));
    }

    #[test]
    fn rejects_path_with_backslash() {
        let mut m = canned_manifest();
        m.files[0].path = "bin\\windows\\agent".to_string();
        let err = m.canonical_bytes().expect_err("backslash");
        assert!(matches!(
            err,
            FirmwareManifestCanonicalBytesError::UnsafeFilePath { .. }
        ));
    }

    #[test]
    fn rejects_empty_component_double_slash() {
        let mut m = canned_manifest();
        m.files[0].path = "bin//agent".to_string();
        let err = m.canonical_bytes().expect_err("empty component");
        assert!(matches!(
            err,
            FirmwareManifestCanonicalBytesError::UnsafeFilePath { .. }
        ));
    }

    #[test]
    fn accepts_deeply_nested_valid_path() {
        let mut m = canned_manifest();
        m.files[0].path =
            "lib/systemd/system/multi-user.target.wants/suderra-agent.service".to_string();
        m.canonical_bytes().expect("nested OK");
    }

    #[test]
    fn rejects_empty_files_vector() {
        let mut m = canned_manifest();
        m.files.clear();
        let err = m.canonical_bytes().expect_err("empty");
        assert_eq!(err, FirmwareManifestCanonicalBytesError::EmptyFilesVector);
    }

    #[test]
    fn rejects_empty_file_path() {
        let mut m = canned_manifest();
        m.files[0].path = String::new();
        let err = m.canonical_bytes().expect_err("empty path");
        assert_eq!(err, FirmwareManifestCanonicalBytesError::EmptyFilePath);
    }

    #[test]
    fn rejects_oversized_file_path() {
        let mut m = canned_manifest();
        m.files[0].path = "a".repeat(MAX_FILE_PATH_BYTES + 1);
        let err = m.canonical_bytes().expect_err("too long");
        assert_eq!(
            err,
            FirmwareManifestCanonicalBytesError::FilePathTooLong(MAX_FILE_PATH_BYTES + 1)
        );
    }

    #[test]
    fn accepts_path_at_exact_max_length() {
        let mut m = canned_manifest();
        m.files[0].path = "a".repeat(MAX_FILE_PATH_BYTES);
        m.canonical_bytes().expect("at bound must accept");
    }

    #[test]
    fn signed_manifest_rejects_wrong_signature_length() {
        let m = canned_manifest();
        let err = SignedFirmwareManifest::from_body_and_signature_bytes(m, &[0u8; 63])
            .expect_err("short");
        assert_eq!(err.got, 63);
    }

    #[test]
    fn signed_manifest_accepts_64_byte_signature() {
        let m = canned_manifest();
        SignedFirmwareManifest::from_body_and_signature_bytes(m, &[0u8; 64]).expect("ok");
    }

    #[test]
    fn target_arch_wire_tag_stable() {
        assert_eq!(TargetArch::Aarch64UnknownLinuxGnu.wire_tag(), 0);
        assert_eq!(TargetArch::Armv7UnknownLinuxGnueabihf.wire_tag(), 1);
        assert_eq!(TargetArch::X86_64UnknownLinuxGnu.wire_tag(), 2);
    }

    #[test]
    fn target_arch_serde_snake_case() {
        assert_eq!(
            serde_json::to_string(&TargetArch::Aarch64UnknownLinuxGnu).expect("ok"),
            r#""aarch64_unknown_linux_gnu""#
        );
    }

    #[test]
    fn sha256_digest_serde_transparent() {
        let d = Sha256Digest::from_bytes([0xabu8; 32]);
        let json = serde_json::to_string(&d).expect("ok");
        assert!(json.starts_with("[171,171,171"));
        let back: Sha256Digest = serde_json::from_str(&json).expect("ok");
        assert_eq!(back, d);
    }

    #[test]
    fn signed_manifest_json_roundtrip() {
        let m = canned_manifest();
        let signed = SignedFirmwareManifest {
            manifest: m,
            signature: Ed25519SignatureBytes::from_array([0x11u8; 64]),
        };
        let json = serde_json::to_string(&signed).expect("ok");
        let back: SignedFirmwareManifest = serde_json::from_str(&json).expect("ok");
        assert_eq!(back, signed);
    }
}
