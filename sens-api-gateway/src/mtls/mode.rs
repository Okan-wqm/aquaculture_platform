//! # MtlsMode — 3-stage rollout state machine (plan §5 Faz 2 item 7)

use serde::{Deserialize, Serialize};

/// Maximum leaf cert age in Legacy mode — 60 days. Legacy is the rollout's
/// first stage: any cert older than this is rejected regardless of pinning
/// (prevents v1.6.0 devices carrying year-old certs from entering the
/// v2.0.0 rollout).
pub const MAX_LEAF_CERT_AGE_DAYS_LEGACY: u32 = 60;

/// Maximum leaf cert age in Warn mode — 90 days. Warn stage tightens by
/// extending the validity window as the cert-issuance pipeline stabilises.
pub const MAX_LEAF_CERT_AGE_DAYS_WARN: u32 = 90;

/// EDGE-INFO-005 defense-in-depth ceiling for Strict mode — 398 days
/// (CA/B Forum baseline). Strict mode's primary freshness driver is
/// explicit cert rotation (plan §5 Faz 2 item 7), but this ceiling
/// caps the residual risk of a private-CA-issued long-lived leaf (e.g.
/// 10-year internal cert) being replayed via a compromised-then-rotated
/// path. Above this age a cert cannot be accepted regardless of rotation
/// state.
pub const MAX_LEAF_CERT_AGE_DAYS_STRICT: u32 = 398;

/// mTLS enforcement mode. Set by `config.yaml::mtls.mode` + cloud-manifest
/// override with ±30-day staged rollout jitter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MtlsMode {
    /// Stage 1 (days 0–30). Pinning disabled — fingerprint mismatch logged
    /// as warning but TLS handshake proceeds. Leaf cert max-age 60 days.
    Legacy,
    /// Stage 2 (days 30–60). Pinning enforced for all NEW sessions but
    /// mismatches still accepted with structured audit event. Leaf cert
    /// max-age 90 days.
    Warn,
    /// Stage 3 (day 60+). Pinning enforced — mismatches reject the TLS
    /// handshake. Leaf cert max-age unbounded (cert rotation drives
    /// freshness, not config policy).
    Strict,
}

impl MtlsMode {
    pub const fn wire_tag(self) -> u8 {
        match self {
            Self::Legacy => 0,
            Self::Warn => 1,
            Self::Strict => 2,
        }
    }

    /// Maximum permitted leaf cert age in days. Cert rotation is the
    /// PRIMARY freshness driver in Strict mode; the 398-day ceiling
    /// (EDGE-INFO-005 closure) is defense-in-depth against
    /// private-CA-issued long-lived leaves.
    pub const fn max_leaf_cert_age_days(self) -> Option<u32> {
        match self {
            Self::Legacy => Some(MAX_LEAF_CERT_AGE_DAYS_LEGACY),
            Self::Warn => Some(MAX_LEAF_CERT_AGE_DAYS_WARN),
            Self::Strict => Some(MAX_LEAF_CERT_AGE_DAYS_STRICT),
        }
    }

    /// True if pinning violations REJECT the handshake. Legacy = false
    /// (log-only), Warn = false (log-only but count-rate-limited), Strict
    /// = true.
    pub const fn pinning_enforced(self) -> bool {
        matches!(self, Self::Strict)
    }

    /// True if pinning violations produce an audit event. Legacy does NOT
    /// emit (pre-enrollment deployment window); Warn + Strict do.
    pub const fn pinning_violation_audited(self) -> bool {
        matches!(self, Self::Warn | Self::Strict)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_tag_stable() {
        assert_eq!(MtlsMode::Legacy.wire_tag(), 0);
        assert_eq!(MtlsMode::Warn.wire_tag(), 1);
        assert_eq!(MtlsMode::Strict.wire_tag(), 2);
    }

    #[test]
    fn max_leaf_cert_age_policy() {
        assert_eq!(MtlsMode::Legacy.max_leaf_cert_age_days(), Some(60));
        assert_eq!(MtlsMode::Warn.max_leaf_cert_age_days(), Some(90));
        // EDGE-INFO-005: Strict mode now carries the CA/B Forum 398-day
        // ceiling as defense-in-depth. Rotation discipline is primary.
        assert_eq!(MtlsMode::Strict.max_leaf_cert_age_days(), Some(398));
    }

    #[test]
    fn pinning_enforcement_matrix() {
        assert!(!MtlsMode::Legacy.pinning_enforced());
        assert!(!MtlsMode::Warn.pinning_enforced());
        assert!(MtlsMode::Strict.pinning_enforced());
    }

    #[test]
    fn pinning_violation_audited_matrix() {
        assert!(!MtlsMode::Legacy.pinning_violation_audited());
        assert!(MtlsMode::Warn.pinning_violation_audited());
        assert!(MtlsMode::Strict.pinning_violation_audited());
    }

    #[test]
    fn serde_snake_case() {
        assert_eq!(
            serde_json::to_string(&MtlsMode::Legacy).expect("ok"),
            r#""legacy""#
        );
        assert_eq!(
            serde_json::to_string(&MtlsMode::Warn).expect("ok"),
            r#""warn""#
        );
        assert_eq!(
            serde_json::to_string(&MtlsMode::Strict).expect("ok"),
            r#""strict""#
        );
    }

    #[test]
    fn max_age_constants_pinned() {
        assert_eq!(MAX_LEAF_CERT_AGE_DAYS_LEGACY, 60);
        assert_eq!(MAX_LEAF_CERT_AGE_DAYS_WARN, 90);
        assert_eq!(MAX_LEAF_CERT_AGE_DAYS_STRICT, 398);
    }
}
