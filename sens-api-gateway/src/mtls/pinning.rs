//! # Leaf cert pinning + 2-phase rotation (plan §5 Faz 2 item 7 + D-6)
//!
//! The edge pins the SHA-256 fingerprint of each trusted server leaf cert
//! (MQTT broker, cloud API). During a cert rotation, TWO fingerprints are
//! simultaneously accepted — the outgoing and incoming — for a window
//! wide enough for the rotation ceremony + fleet push (typically 7 days).
//! After the window closes, only the new fingerprint is accepted.
//!
//! The [`CertRotationStage`] enum encodes this 2-phase state machine:
//!
//! ```text
//! Settled(current_fp)
//!   → BridgeRotation { outgoing_fp, incoming_fp, bridge_until }
//!   → Settled(incoming_fp)
//! ```
//!
//! `BridgeRotation::bridge_until` is a monotonic-safe UNIX second; the
//! edge rejects any handshake seen after `bridge_until` that matches
//! `outgoing_fp`.

use serde::{Deserialize, Serialize};

use super::super::updater::manifest::Sha256Digest;

/// SHA-256 fingerprint of a leaf cert's DER bytes. Newtype wraps
/// `Sha256Digest` for call-site grepability — a `LeafCertFingerprint`
/// cannot be accidentally compared against a firmware-digest or audit-
/// HMAC output (all 32-byte types but each in its own newtype).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct LeafCertFingerprint(Sha256Digest);

impl LeafCertFingerprint {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(Sha256Digest::from_bytes(bytes))
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        self.0.as_bytes()
    }

    // EDGE-LOW-003 closure: `as_digest()` accessor removed. Exposing the
    // inner `Sha256Digest` was a leaky abstraction — callers that need
    // byte-level equality or hashing use `as_bytes()`; callers that need
    // a `Sha256Digest` for a non-cert domain should be going through a
    // different newtype anyway. The whole point of the wrapping newtype
    // is domain separation between "cert fingerprint" and "firmware file
    // digest"; letting callers unwrap back defeats that.
}

/// A single pinned leaf cert — fingerprint + validity window. Validity
/// window is FROM the cert's NotBefore to NotAfter — independent of the
/// `MtlsMode::max_leaf_cert_age_days` policy cap (which layers ON TOP of
/// this via the mode-policy gate in `verify`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PinnedLeafCert {
    pub fingerprint: LeafCertFingerprint,
    pub not_before_unix_secs: i64,
    pub not_after_unix_secs: i64,
    /// Operator-facing label (e.g. `"broker.suderra.prod.leaf.2026-04"`).
    /// Used for audit trail + rotation-ceremony workflow.
    pub cert_label: String,
}

/// Cert rotation state machine. The edge moves through these states in
/// response to cloud-pushed `update_cert_pinning` commands (itself
/// requiring `Permission::ManageCertPinning` + two-person integrity per
/// ADR-018 §8).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub enum CertRotationStage {
    /// Steady state — exactly one pinned cert active.
    Settled { current: PinnedLeafCert },

    /// Rotation bridge — outgoing + incoming both accepted until
    /// `bridge_until_unix_secs`. After the bridge window closes, the edge
    /// transitions to `Settled { current: incoming }` on the next
    /// config reload.
    BridgeRotation {
        outgoing: PinnedLeafCert,
        incoming: PinnedLeafCert,
        bridge_until_unix_secs: i64,
    },
}

impl CertRotationStage {
    pub const fn wire_tag(&self) -> u8 {
        match self {
            Self::Settled { .. } => 0,
            Self::BridgeRotation { .. } => 1,
        }
    }

    /// Return the set of fingerprints currently accepted. `Settled` yields
    /// one; `BridgeRotation` yields two IF the bridge window has not
    /// expired, else one (only the incoming — outgoing retired).
    ///
    /// **EDGE-INFO-006 observability note:** this function INTENTIONALLY
    /// collapses the post-window `BridgeRotation` state into the same
    /// `PinnedLeafCertSet` shape as `Settled` (both yield `{primary:
    /// incoming, bridge: None}`). Hot-path TLS verify only needs
    /// accept/reject; the state-machine distinction remains observable at
    /// the `CertRotationStage` enum level for supervisors that need to
    /// schedule the `BridgeRotation` → `Settled` transition on next config
    /// reload. Supervisors should `match` on the variant, not rely on the
    /// set-layer collapse to infer rotation state.
    pub fn accepted_fingerprints(&self, now_unix_secs: i64) -> PinnedLeafCertSet {
        match self {
            Self::Settled { current } => PinnedLeafCertSet {
                primary: Some(current.clone()),
                bridge: None,
            },
            Self::BridgeRotation {
                outgoing,
                incoming,
                bridge_until_unix_secs,
            } => {
                if now_unix_secs > *bridge_until_unix_secs {
                    // Bridge window expired — only the incoming (new) cert
                    // is accepted; the outgoing is retired.
                    PinnedLeafCertSet {
                        primary: Some(incoming.clone()),
                        bridge: None,
                    }
                } else {
                    PinnedLeafCertSet {
                        primary: Some(incoming.clone()),
                        bridge: Some(outgoing.clone()),
                    }
                }
            }
        }
    }
}

/// Set of currently-accepted pinned certs. Held by the TLS verifier to
/// decide accept/reject on a handshake fingerprint.
///
/// - `primary` is the incoming (new) cert — the long-term trust anchor.
/// - `bridge` is the outgoing (old) cert — accepted during the rotation
///   window only. `None` in steady state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnedLeafCertSet {
    pub primary: Option<PinnedLeafCert>,
    pub bridge: Option<PinnedLeafCert>,
}

impl PinnedLeafCertSet {
    /// Return true if the given fingerprint matches ANY accepted pin.
    pub fn accepts(&self, fp: &LeafCertFingerprint) -> bool {
        self.primary
            .as_ref()
            .map(|c| &c.fingerprint == fp)
            .unwrap_or(false)
            || self
                .bridge
                .as_ref()
                .map(|c| &c.fingerprint == fp)
                .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canned_cert(fp_byte: u8, label: &str) -> PinnedLeafCert {
        PinnedLeafCert {
            fingerprint: LeafCertFingerprint::from_bytes([fp_byte; 32]),
            not_before_unix_secs: 1_700_000_000,
            not_after_unix_secs: 1_800_000_000,
            cert_label: label.to_string(),
        }
    }

    #[test]
    fn fingerprint_newtype_wraps_32_bytes() {
        let fp = LeafCertFingerprint::from_bytes([0xabu8; 32]);
        assert_eq!(fp.as_bytes(), &[0xabu8; 32]);
    }

    #[test]
    fn fingerprint_serde_transparent_roundtrip() {
        let fp = LeafCertFingerprint::from_bytes([0xcdu8; 32]);
        let json = serde_json::to_string(&fp).expect("ok");
        assert!(json.starts_with("[205,205,205"));
        let back: LeafCertFingerprint = serde_json::from_str(&json).expect("ok");
        assert_eq!(back, fp);
    }

    #[test]
    fn settled_accepts_only_current_fingerprint() {
        let cert = canned_cert(0x01, "prod-leaf-2026-04");
        let stage = CertRotationStage::Settled {
            current: cert.clone(),
        };
        let set = stage.accepted_fingerprints(1_750_000_000);
        assert_eq!(
            set.primary.as_ref().expect("primary").fingerprint,
            cert.fingerprint
        );
        assert!(set.bridge.is_none());
        assert!(set.accepts(&cert.fingerprint));
        assert!(!set.accepts(&LeafCertFingerprint::from_bytes([0xffu8; 32])));
    }

    #[test]
    fn bridge_rotation_accepts_both_within_window() {
        let out = canned_cert(0x01, "prod-leaf-2026-03");
        let inc = canned_cert(0x02, "prod-leaf-2026-04");
        let stage = CertRotationStage::BridgeRotation {
            outgoing: out.clone(),
            incoming: inc.clone(),
            bridge_until_unix_secs: 1_760_000_000,
        };
        let set = stage.accepted_fingerprints(1_750_000_000);
        assert!(set.accepts(&out.fingerprint));
        assert!(set.accepts(&inc.fingerprint));
    }

    #[test]
    fn bridge_rotation_after_window_rejects_outgoing() {
        let out = canned_cert(0x01, "prod-leaf-2026-03");
        let inc = canned_cert(0x02, "prod-leaf-2026-04");
        let stage = CertRotationStage::BridgeRotation {
            outgoing: out.clone(),
            incoming: inc.clone(),
            bridge_until_unix_secs: 1_700_000_000,
        };
        let set = stage.accepted_fingerprints(1_800_000_000);
        assert!(
            !set.accepts(&out.fingerprint),
            "outgoing rejected after window"
        );
        assert!(set.accepts(&inc.fingerprint), "incoming still accepted");
    }

    #[test]
    fn stage_wire_tags_stable() {
        let settled = CertRotationStage::Settled {
            current: canned_cert(0x01, "x"),
        };
        let bridge = CertRotationStage::BridgeRotation {
            outgoing: canned_cert(0x01, "x"),
            incoming: canned_cert(0x02, "y"),
            bridge_until_unix_secs: 0,
        };
        assert_eq!(settled.wire_tag(), 0);
        assert_eq!(bridge.wire_tag(), 1);
    }

    #[test]
    fn pinned_leaf_cert_json_roundtrip() {
        let cert = canned_cert(0x42, "prod-2026");
        let json = serde_json::to_string(&cert).expect("ok");
        let back: PinnedLeafCert = serde_json::from_str(&json).expect("ok");
        assert_eq!(back, cert);
    }

    #[test]
    fn rotation_stage_json_roundtrip() {
        let stage = CertRotationStage::BridgeRotation {
            outgoing: canned_cert(0x01, "out"),
            incoming: canned_cert(0x02, "inc"),
            bridge_until_unix_secs: 1_760_000_000,
        };
        let json = serde_json::to_string(&stage).expect("ok");
        let back: CertRotationStage = serde_json::from_str(&json).expect("ok");
        assert_eq!(back, stage);
    }

    #[test]
    fn pinned_set_accepts_matches_primary_and_bridge() {
        let out = canned_cert(0x01, "out");
        let inc = canned_cert(0x02, "inc");
        let set = PinnedLeafCertSet {
            primary: Some(inc.clone()),
            bridge: Some(out.clone()),
        };
        assert!(set.accepts(&out.fingerprint));
        assert!(set.accepts(&inc.fingerprint));
        assert!(!set.accepts(&LeafCertFingerprint::from_bytes([0xffu8; 32])));
    }

    #[test]
    fn pinned_set_empty_accepts_none() {
        let set = PinnedLeafCertSet {
            primary: None,
            bridge: None,
        };
        assert!(!set.accepts(&LeafCertFingerprint::from_bytes([0x01u8; 32])));
    }
}
