//! # MtlsMode — 3-stage rollout state machine (plan §5 Faz 2 item 7)

use serde::{Deserialize, Serialize};

/// Maximum leaf cert age in Legacy mode — 60 days. Legacy is the rollout's
/// first stage: any cert older than this is rejected regardless of pinning
/// (prevents v1.6.0 devices carrying year-old certs from entering the
/// v2.0.0 rollout).
#[cfg(not(feature = "suderra-os"))]
pub const MAX_LEAF_CERT_AGE_DAYS_LEGACY: u32 = 60;

/// Maximum leaf cert age in Warn mode — 90 days. Warn stage tightens by
/// extending the validity window as the cert-issuance pipeline stabilises.
#[cfg(not(feature = "suderra-os"))]
pub const MAX_LEAF_CERT_AGE_DAYS_WARN: u32 = 90;

/// EDGE-INFO-005 defense-in-depth ceiling for Strict mode — 398 days
/// (CA/B Forum baseline). Strict mode's primary freshness driver is
/// explicit cert rotation (plan §5 Faz 2 item 7), but this ceiling
/// caps the residual risk of a private-CA-issued long-lived leaf (e.g.
/// 10-year internal cert) being replayed via a compromised-then-rotated
/// path. Above this age a cert cannot be accepted regardless of rotation
/// state.
#[cfg(not(feature = "suderra-os"))]
pub const MAX_LEAF_CERT_AGE_DAYS_STRICT: u32 = 398;

/// Leaf cert age ceiling of `CaAnchored` — 398 days, the CA/B Forum
/// baseline. The broker's issuing CA rotates the leaf; the ceiling caps a
/// long-lived leaf from a compromised-then-rotated issuer.
pub const MAX_LEAF_CERT_AGE_DAYS_CA_ANCHORED: u32 = 398;

/// mTLS enforcement mode. Set by `config.yaml::mtls.mode` + cloud-manifest
/// override with ±30-day staged rollout jitter.
///
/// Batch 27: `Default::default()` returns `Legacy` — the rollout's first
/// stage. Preserves HC-1 v1.6.0 backward compat (operators running
/// pre-Batch-27 configs get the same de-facto behavior without explicit
/// opt-in). Explicit `Warn`/`Strict` migration comes from operator-
/// editable config.yaml.
///
/// ADR-048 DEC-10.6: `CaAnchored` trusts the broker by its CA, never by a
/// pinned leaf: the root store is exactly the trust-anchors bundle's
/// `mqtt-ca` set (no native or embedded webpki roots), hostname
/// verification is always on, and a policy violation (cert age, chain
/// depth) rejects the handshake. It is the only mode the `suderra-os`
/// profile compiles; `Legacy`, `Warn` and `Strict` (leaf pinning) exist in
/// the generic profile alone, since Let's Encrypt leaf and intermediate
/// rotation would lock out offline devices that pin a leaf.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MtlsMode {
    /// Stage 1 (days 0–30). Pinning disabled — fingerprint mismatch logged
    /// as warning but TLS handshake proceeds. Leaf cert max-age 60 days.
    #[cfg(not(feature = "suderra-os"))]
    #[default]
    Legacy,
    /// Stage 2 (days 30–60). Pinning enforced for all NEW sessions but
    /// mismatches still accepted with structured audit event. Leaf cert
    /// max-age 90 days.
    #[cfg(not(feature = "suderra-os"))]
    Warn,
    /// Stage 3 (day 60+). Pinning enforced — mismatches reject the TLS
    /// handshake. Leaf cert max-age unbounded (cert rotation drives
    /// freshness, not config policy).
    #[cfg(not(feature = "suderra-os"))]
    Strict,
    /// CA-anchored server authentication (DEC-10.6): chain to a pinned
    /// platform CA, hostname verified, policy gates enforced, no leaf pin.
    #[cfg_attr(feature = "suderra-os", default)]
    CaAnchored,
}

impl MtlsMode {
    pub const fn wire_tag(self) -> u8 {
        match self {
            #[cfg(not(feature = "suderra-os"))]
            Self::Legacy => 0,
            #[cfg(not(feature = "suderra-os"))]
            Self::Warn => 1,
            #[cfg(not(feature = "suderra-os"))]
            Self::Strict => 2,
            Self::CaAnchored => 3,
        }
    }

    /// Maximum permitted leaf cert age in days. Cert rotation is the
    /// PRIMARY freshness driver in Strict mode; the 398-day ceiling
    /// (EDGE-INFO-005 closure) is defense-in-depth against
    /// private-CA-issued long-lived leaves.
    pub const fn max_leaf_cert_age_days(self) -> Option<u32> {
        match self {
            #[cfg(not(feature = "suderra-os"))]
            Self::Legacy => Some(MAX_LEAF_CERT_AGE_DAYS_LEGACY),
            #[cfg(not(feature = "suderra-os"))]
            Self::Warn => Some(MAX_LEAF_CERT_AGE_DAYS_WARN),
            #[cfg(not(feature = "suderra-os"))]
            Self::Strict => Some(MAX_LEAF_CERT_AGE_DAYS_STRICT),
            Self::CaAnchored => Some(MAX_LEAF_CERT_AGE_DAYS_CA_ANCHORED),
        }
    }

    /// True if pinning violations REJECT the handshake. Legacy = false
    /// (log-only), Warn = false (log-only but count-rate-limited), Strict
    /// = true. `CaAnchored` pins no leaf.
    pub const fn pinning_enforced(self) -> bool {
        match self {
            #[cfg(not(feature = "suderra-os"))]
            Self::Strict => true,
            #[cfg(not(feature = "suderra-os"))]
            Self::Legacy | Self::Warn => false,
            Self::CaAnchored => false,
        }
    }

    /// True if pinning violations produce an audit event. Legacy does NOT
    /// emit (pre-enrollment deployment window); Warn + Strict do.
    /// `CaAnchored` pins no leaf, so there is no pinning violation.
    pub const fn pinning_violation_audited(self) -> bool {
        match self {
            #[cfg(not(feature = "suderra-os"))]
            Self::Warn | Self::Strict => true,
            #[cfg(not(feature = "suderra-os"))]
            Self::Legacy => false,
            Self::CaAnchored => false,
        }
    }

    /// True if the leaf certificate must be in the pinned set.
    pub const fn uses_leaf_pins(self) -> bool {
        !matches!(self, Self::CaAnchored)
    }

    /// True if a policy-gate violation (age, chain depth, pin) rejects the
    /// handshake rather than being logged.
    pub const fn rejects_policy_violation(self) -> bool {
        match self {
            #[cfg(not(feature = "suderra-os"))]
            Self::Strict => true,
            #[cfg(not(feature = "suderra-os"))]
            Self::Legacy | Self::Warn => false,
            Self::CaAnchored => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(feature = "suderra-os"))]
    #[test]
    fn wire_tag_stable() {
        assert_eq!(MtlsMode::Legacy.wire_tag(), 0);
        assert_eq!(MtlsMode::Warn.wire_tag(), 1);
        assert_eq!(MtlsMode::Strict.wire_tag(), 2);
    }

    #[cfg(not(feature = "suderra-os"))]
    #[test]
    fn max_leaf_cert_age_policy() {
        assert_eq!(MtlsMode::Legacy.max_leaf_cert_age_days(), Some(60));
        assert_eq!(MtlsMode::Warn.max_leaf_cert_age_days(), Some(90));
        // EDGE-INFO-005: Strict mode now carries the CA/B Forum 398-day
        // ceiling as defense-in-depth. Rotation discipline is primary.
        assert_eq!(MtlsMode::Strict.max_leaf_cert_age_days(), Some(398));
    }

    #[cfg(not(feature = "suderra-os"))]
    #[test]
    fn pinning_enforcement_matrix() {
        assert!(!MtlsMode::Legacy.pinning_enforced());
        assert!(!MtlsMode::Warn.pinning_enforced());
        assert!(MtlsMode::Strict.pinning_enforced());
    }

    #[cfg(not(feature = "suderra-os"))]
    #[test]
    fn pinning_violation_audited_matrix() {
        assert!(!MtlsMode::Legacy.pinning_violation_audited());
        assert!(MtlsMode::Warn.pinning_violation_audited());
        assert!(MtlsMode::Strict.pinning_violation_audited());
    }

    #[cfg(not(feature = "suderra-os"))]
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

    #[cfg(not(feature = "suderra-os"))]
    #[test]
    fn max_age_constants_pinned() {
        assert_eq!(MAX_LEAF_CERT_AGE_DAYS_LEGACY, 60);
        assert_eq!(MAX_LEAF_CERT_AGE_DAYS_WARN, 90);
        assert_eq!(MAX_LEAF_CERT_AGE_DAYS_STRICT, 398);
    }

    /// DEC-10.6: CaAnchored pins no leaf, rejects policy violations and
    /// is the suderra-os profile's only (and so default) mode.
    #[test]
    fn ca_anchored_policy() {
        let m = MtlsMode::CaAnchored;
        assert_eq!(m.wire_tag(), 3);
        assert_eq!(
            m.max_leaf_cert_age_days(),
            Some(MAX_LEAF_CERT_AGE_DAYS_CA_ANCHORED)
        );
        assert!(!m.uses_leaf_pins());
        assert!(m.rejects_policy_violation());
        assert!(!m.pinning_enforced());
        assert!(!m.pinning_violation_audited());
        assert_eq!(
            serde_json::from_str::<MtlsMode>(r#""ca_anchored""#).ok(),
            Some(MtlsMode::CaAnchored)
        );
        #[cfg(feature = "suderra-os")]
        {
            assert_eq!(MtlsMode::default(), MtlsMode::CaAnchored);
            for gone in [r#""legacy""#, r#""warn""#, r#""strict""#] {
                assert!(serde_json::from_str::<MtlsMode>(gone).is_err(), "{gone}");
            }
        }
    }
}
