//! # Config integrity error taxonomy (plan D-13)

/// Canonical-bytes serialization errors for [`super::manifest::ConfigMeta`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigMetaCanonicalBytesError {
    /// A length field exceeded `u32::MAX`. Not reachable with sensible input.
    LengthExceedsU32,
    /// `release_tag` field empty — every signed config carries a release
    /// label for operator-facing display.
    EmptyReleaseTag,
    /// `release_tag` exceeded `MAX_RELEASE_TAG_BYTES`.
    ReleaseTagTooLong(usize),
}

impl std::fmt::Display for ConfigMetaCanonicalBytesError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LengthExceedsU32 => f.write_str("length_exceeds_u32"),
            Self::EmptyReleaseTag => f.write_str("empty_release_tag"),
            Self::ReleaseTagTooLong(n) => write!(f, "release_tag_too_long:{}", n),
        }
    }
}

impl std::error::Error for ConfigMetaCanonicalBytesError {}

/// Structured verification errors for the config-integrity gate. Matches
/// the Batch 5b / Batch 8 fail-closed pattern: one variant per gate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigIntegrityError {
    /// Meta's `device_id` did not match the device's provisioning-bound
    /// `DeviceId`. Cross-device config pivot defense.
    DeviceMismatch,

    /// Meta's `expected_config_sha256` did not match the SHA-256 of the
    /// on-disk config bytes. Either the config was modified post-sign, or
    /// the sidecar `.sig` file does not belong to the config file.
    ConfigDigestMismatch,

    /// Claimed `config_version` <= `highest_seen_config_version`. Replay /
    /// rollback attempt — a freshly-provisioned device rejects stale
    /// signed configs from earlier deployments.
    StaleConfigVersion { claimed: u64, highest_seen: u64 },

    /// Canonical-bytes serialization failed.
    CanonicalBytesFailure(ConfigMetaCanonicalBytesError),

    /// ed25519 signature verify returned false.
    InvalidSignature,
}

impl std::fmt::Display for ConfigIntegrityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DeviceMismatch => f.write_str("device_mismatch"),
            Self::ConfigDigestMismatch => f.write_str("config_digest_mismatch"),
            Self::StaleConfigVersion { .. } => f.write_str("stale_config_version"),
            Self::CanonicalBytesFailure(_) => f.write_str("canonical_bytes_failure"),
            Self::InvalidSignature => f.write_str("invalid_signature"),
        }
    }
}

impl std::error::Error for ConfigIntegrityError {}

impl From<ConfigMetaCanonicalBytesError> for ConfigIntegrityError {
    fn from(e: ConfigMetaCanonicalBytesError) -> Self {
        Self::CanonicalBytesFailure(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_bytes_error_display_snake_case() {
        assert_eq!(
            format!("{}", ConfigMetaCanonicalBytesError::LengthExceedsU32),
            "length_exceeds_u32"
        );
        assert_eq!(
            format!("{}", ConfigMetaCanonicalBytesError::EmptyReleaseTag),
            "empty_release_tag"
        );
        assert_eq!(
            format!("{}", ConfigMetaCanonicalBytesError::ReleaseTagTooLong(513)),
            "release_tag_too_long:513"
        );
    }

    #[test]
    fn config_integrity_error_display_snake_case() {
        assert_eq!(
            format!("{}", ConfigIntegrityError::DeviceMismatch),
            "device_mismatch"
        );
        assert_eq!(
            format!("{}", ConfigIntegrityError::ConfigDigestMismatch),
            "config_digest_mismatch"
        );
        assert_eq!(
            format!(
                "{}",
                ConfigIntegrityError::StaleConfigVersion { claimed: 1, highest_seen: 2 }
            ),
            "stale_config_version"
        );
        assert_eq!(
            format!("{}", ConfigIntegrityError::InvalidSignature),
            "invalid_signature"
        );
        assert_eq!(
            format!(
                "{}",
                ConfigIntegrityError::CanonicalBytesFailure(
                    ConfigMetaCanonicalBytesError::EmptyReleaseTag
                )
            ),
            "canonical_bytes_failure"
        );
    }

    #[test]
    fn errors_implement_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<ConfigMetaCanonicalBytesError>();
        assert_err::<ConfigIntegrityError>();
    }

    #[test]
    fn canonical_bytes_error_converts_to_integrity_error() {
        let e: ConfigIntegrityError = ConfigMetaCanonicalBytesError::EmptyReleaseTag.into();
        assert_eq!(
            e,
            ConfigIntegrityError::CanonicalBytesFailure(
                ConfigMetaCanonicalBytesError::EmptyReleaseTag
            )
        );
    }
}
