//! # Updater error taxonomy (ADR-019 §5)
//!
//! Structured errors for the firmware manifest verify + A/B partition
//! lifecycle. Distinct variants per gate so audit-verify and operator
//! incident-response flows can discriminate without string matching.

/// Canonical-bytes serialization errors for `FirmwareManifest`. Separate
/// type because these are upstream-invariant errors (fuzzed input, absurd
/// file counts) — distinct from `ManifestVerifyError` which is the
/// verification-decision shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FirmwareManifestCanonicalBytesError {
    /// A length field exceeded `u32::MAX`.
    LengthExceedsU32,
    /// The files vector was empty — a firmware manifest without files is
    /// meaningless.
    EmptyFilesVector,
    /// A file path was empty.
    EmptyFilePath,
    /// A file path exceeded `MAX_FILE_PATH_BYTES`.
    FilePathTooLong(usize),
    /// EDGE-MEDIUM-002 closure: file path contains a path-traversal or
    /// unsafe-shape component. Rejection is at the SIGNING boundary so
    /// Sprint 6.5 `apply_update` never sees a hostile path. Carries the
    /// offending path for audit-trail + operator incident-response.
    UnsafeFilePath { path: String },
}

impl std::fmt::Display for FirmwareManifestCanonicalBytesError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LengthExceedsU32 => f.write_str("length_exceeds_u32"),
            Self::EmptyFilesVector => f.write_str("empty_files_vector"),
            Self::EmptyFilePath => f.write_str("empty_file_path"),
            Self::FilePathTooLong(n) => write!(f, "file_path_too_long:{}", n),
            Self::UnsafeFilePath { .. } => f.write_str("unsafe_file_path"),
        }
    }
}

impl std::error::Error for FirmwareManifestCanonicalBytesError {}

/// Firmware manifest verification errors (ADR-019 §5). Returned by
/// `verify_firmware_manifest`; structured so audit trail can discriminate
/// every failure class.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestVerifyError {
    /// Manifest `tenant_id` does not match device's provisioning-bound
    /// tenant. Cross-tenant firmware pivot defense.
    TenantMismatch,

    /// Claimed `firmware_version` <= `highest_seen_firmware_version`.
    /// Rollback attempt — ADR-019 §4 monotonic defense.
    StaleFirmwareVersion { claimed: u64, highest_seen: u64 },

    /// `now` earlier than UNIX_EPOCH — pre-epoch clock misconfiguration.
    InvalidNow,

    /// Manifest validity window inverted (valid_from > valid_until).
    InvalidValidityWindow { valid_from: i64, valid_until: i64 },

    /// `now` before `valid_from_unix_secs` — future-dated manifest.
    NotYetValid { now_unix_secs: i64, valid_from: i64 },

    /// `now` after `valid_until_unix_secs` — expired manifest.
    Expired {
        now_unix_secs: i64,
        valid_until: i64,
    },

    /// Canonical-bytes serialization failed.
    CanonicalBytesFailure(FirmwareManifestCanonicalBytesError),

    /// ed25519 signature verify returned false.
    InvalidSignature,

    /// Per-file SHA-256 digest did not match the manifest's declaration.
    /// Carries the file path that failed (for audit trail + operator
    /// incident response).
    FileDigestMismatch { file_path: String },

    /// A file's declared size disagreed with the actual on-disk size
    /// (guards against truncated transfers).
    FileSizeMismatch {
        file_path: String,
        expected: u64,
        actual: u64,
    },

    /// Target architecture mismatch — the manifest targets an arch that
    /// is not this device's compile target.
    TargetArchMismatch,
}

impl std::fmt::Display for ManifestVerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TenantMismatch => f.write_str("tenant_mismatch"),
            Self::StaleFirmwareVersion { .. } => f.write_str("stale_firmware_version"),
            Self::InvalidNow => f.write_str("invalid_now"),
            Self::InvalidValidityWindow { .. } => f.write_str("invalid_validity_window"),
            Self::NotYetValid { .. } => f.write_str("not_yet_valid"),
            Self::Expired { .. } => f.write_str("expired"),
            Self::CanonicalBytesFailure(_) => f.write_str("canonical_bytes_failure"),
            Self::InvalidSignature => f.write_str("invalid_signature"),
            Self::FileDigestMismatch { .. } => f.write_str("file_digest_mismatch"),
            Self::FileSizeMismatch { .. } => f.write_str("file_size_mismatch"),
            Self::TargetArchMismatch => f.write_str("target_arch_mismatch"),
        }
    }
}

impl std::error::Error for ManifestVerifyError {}

impl From<FirmwareManifestCanonicalBytesError> for ManifestVerifyError {
    fn from(e: FirmwareManifestCanonicalBytesError) -> Self {
        Self::CanonicalBytesFailure(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_bytes_error_display_snake_case() {
        assert_eq!(
            format!("{}", FirmwareManifestCanonicalBytesError::LengthExceedsU32),
            "length_exceeds_u32"
        );
        assert_eq!(
            format!("{}", FirmwareManifestCanonicalBytesError::EmptyFilesVector),
            "empty_files_vector"
        );
        assert_eq!(
            format!(
                "{}",
                FirmwareManifestCanonicalBytesError::FilePathTooLong(513)
            ),
            "file_path_too_long:513"
        );
        assert_eq!(
            format!("{}", FirmwareManifestCanonicalBytesError::EmptyFilePath),
            "empty_file_path"
        );
        assert_eq!(
            format!(
                "{}",
                FirmwareManifestCanonicalBytesError::UnsafeFilePath {
                    path: "/etc/shadow".to_string()
                }
            ),
            "unsafe_file_path"
        );
    }

    #[test]
    fn verify_error_display_snake_case() {
        assert_eq!(
            format!("{}", ManifestVerifyError::TenantMismatch),
            "tenant_mismatch"
        );
        assert_eq!(
            format!(
                "{}",
                ManifestVerifyError::StaleFirmwareVersion {
                    claimed: 1,
                    highest_seen: 2
                }
            ),
            "stale_firmware_version"
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
                ManifestVerifyError::NotYetValid {
                    now_unix_secs: 1,
                    valid_from: 2
                }
            ),
            "not_yet_valid"
        );
        assert_eq!(
            format!(
                "{}",
                ManifestVerifyError::Expired {
                    now_unix_secs: 9,
                    valid_until: 2
                }
            ),
            "expired"
        );
        assert_eq!(
            format!("{}", ManifestVerifyError::InvalidSignature),
            "invalid_signature"
        );
        assert_eq!(
            format!(
                "{}",
                ManifestVerifyError::FileDigestMismatch {
                    file_path: "bin/suderra-agent".to_string()
                }
            ),
            "file_digest_mismatch"
        );
        assert_eq!(
            format!(
                "{}",
                ManifestVerifyError::FileSizeMismatch {
                    file_path: "bin/suderra-agent".to_string(),
                    expected: 1_000_000,
                    actual: 999_999
                }
            ),
            "file_size_mismatch"
        );
        assert_eq!(
            format!("{}", ManifestVerifyError::TargetArchMismatch),
            "target_arch_mismatch"
        );
        assert_eq!(
            format!(
                "{}",
                ManifestVerifyError::CanonicalBytesFailure(
                    FirmwareManifestCanonicalBytesError::EmptyFilesVector
                )
            ),
            "canonical_bytes_failure"
        );
    }

    #[test]
    fn errors_implement_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<FirmwareManifestCanonicalBytesError>();
        assert_err::<ManifestVerifyError>();
    }

    #[test]
    fn canonical_bytes_error_converts_to_verify_error() {
        let e: ManifestVerifyError = FirmwareManifestCanonicalBytesError::EmptyFilesVector.into();
        assert_eq!(
            e,
            ManifestVerifyError::CanonicalBytesFailure(
                FirmwareManifestCanonicalBytesError::EmptyFilesVector
            )
        );
    }
}
