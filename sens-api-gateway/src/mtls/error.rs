//! # MtlsVerifyError — leaf cert verification error taxonomy

use super::pinning::LeafCertFingerprint;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MtlsVerifyError {
    /// Negotiated cipher suite is not in [`super::cipher::CIPHER_SUITE_ALLOWLIST`].
    /// SL-2 adversarial baseline rejects any suite outside the 3-entry TLS 1.3
    /// list. The offending suite's IANA codepoint is captured for audit.
    CipherSuiteNotAllowed { negotiated_codepoint: u16 },

    /// TLS protocol version < 1.3 — downgrade rejection.
    TlsVersionBelowMinimum,

    /// Leaf cert NotBefore is in the future (future-dated cert — clock bug
    /// or operator error).
    CertNotYetValid {
        not_before_unix_secs: i64,
        now_unix_secs: i64,
    },

    /// Leaf cert NotAfter has passed.
    CertExpired {
        not_after_unix_secs: i64,
        now_unix_secs: i64,
    },

    /// Cert age exceeds `MtlsMode::max_leaf_cert_age_days` policy cap.
    /// Distinct from `CertExpired` — a cert might still be within its
    /// NotAfter window but older than the mode's policy threshold.
    CertAgeExceedsModeLimit {
        cert_age_days: u32,
        mode_limit_days: u32,
    },

    /// Fingerprint mismatch — in `Strict` mode, handshake is rejected.
    /// In `Warn` mode, logged but accepted (audit gate upstream); in
    /// `Legacy` mode, logged only if `pinning_violation_audited()`.
    FingerprintNotPinned { actual: LeafCertFingerprint },

    /// Cert chain length exceeds the configured maximum. ADR-021 §10 caps
    /// at 4 (leaf + 2 intermediates + root) to prevent chain-explosion DoS.
    ChainTooLong { depth: usize, max: usize },

    // EDGE-LOW-004 closure: `NonPreferredCipherSuite` variant removed —
    // `verify_leaf_cert` never returned it, and a preferred-cipher-drift
    // monitor is a Sprint 6.9+ telemetry concern rather than a verifier
    // error shape. Re-add with owner + sprint when the monitor is wired.

    /// Clock skew — `now_unix_secs` is negative (pre-epoch).
    InvalidNow,

    /// Cert DER failed to parse via x509-parser (Batch 136
    /// Sprint 6.8 wire — cert-verify-callback subset fn
    /// uses this when rustls hands us malformed DER bytes).
    /// Normally webpki chain-verify catches this first, but
    /// defense-in-depth surfaces the error shape so our
    /// audit pipeline records structured reason.
    CertParseFailed(String),
}

impl std::fmt::Display for MtlsVerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CipherSuiteNotAllowed { .. } => f.write_str("cipher_suite_not_allowed"),
            Self::TlsVersionBelowMinimum => f.write_str("tls_version_below_minimum"),
            Self::CertNotYetValid { .. } => f.write_str("cert_not_yet_valid"),
            Self::CertExpired { .. } => f.write_str("cert_expired"),
            Self::CertAgeExceedsModeLimit { .. } => f.write_str("cert_age_exceeds_mode_limit"),
            Self::FingerprintNotPinned { .. } => f.write_str("fingerprint_not_pinned"),
            Self::ChainTooLong { .. } => f.write_str("chain_too_long"),
            Self::InvalidNow => f.write_str("invalid_now"),
            Self::CertParseFailed(_) => f.write_str("cert_parse_failed"),
        }
    }
}

impl std::error::Error for MtlsVerifyError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_snake_case_all_variants() {
        assert_eq!(
            format!(
                "{}",
                MtlsVerifyError::CipherSuiteNotAllowed { negotiated_codepoint: 0x0035 }
            ),
            "cipher_suite_not_allowed"
        );
        assert_eq!(
            format!("{}", MtlsVerifyError::TlsVersionBelowMinimum),
            "tls_version_below_minimum"
        );
        assert_eq!(
            format!(
                "{}",
                MtlsVerifyError::CertNotYetValid {
                    not_before_unix_secs: 2,
                    now_unix_secs: 1
                }
            ),
            "cert_not_yet_valid"
        );
        assert_eq!(
            format!(
                "{}",
                MtlsVerifyError::CertExpired {
                    not_after_unix_secs: 1,
                    now_unix_secs: 2
                }
            ),
            "cert_expired"
        );
        assert_eq!(
            format!(
                "{}",
                MtlsVerifyError::CertAgeExceedsModeLimit {
                    cert_age_days: 100,
                    mode_limit_days: 60
                }
            ),
            "cert_age_exceeds_mode_limit"
        );
        assert_eq!(
            format!(
                "{}",
                MtlsVerifyError::FingerprintNotPinned {
                    actual: LeafCertFingerprint::from_bytes([0u8; 32])
                }
            ),
            "fingerprint_not_pinned"
        );
        assert_eq!(
            format!("{}", MtlsVerifyError::ChainTooLong { depth: 5, max: 4 }),
            "chain_too_long"
        );
        assert_eq!(format!("{}", MtlsVerifyError::InvalidNow), "invalid_now");
    }

    #[test]
    fn implements_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<MtlsVerifyError>();
    }
}
