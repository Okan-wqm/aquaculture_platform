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

/// Minimum bridge-rotation window — 1 hour. ORPHAN-HIGH-039 architectural
/// floor (Phase 1.1.5).
///
/// ## WHY this floor exists
///
/// `BridgeRotation { incoming, outgoing, bridge_until_unix_secs }` is a
/// state-machine intermediate — operators rotate `outgoing → incoming`
/// and the edge accepts BOTH fingerprints until the bridge window closes.
/// `accepted_fingerprints(now)` collapses the stage to "incoming only"
/// once `now > bridge_until_unix_secs` (line 117-126 above).
///
/// Pre-Phase-1.1.5 the construction path placed no floor on
/// `bridge_until_unix_secs`. A signed cloud manifest carrying
/// `bridge_until_unix_secs` in the past (operator typo, malicious push,
/// clock skew on the signing host) would cause the stage to IMMEDIATELY
/// collapse to "accept only `incoming`". If `incoming` is wrong (typo,
/// poisoned manifest, fingerprint mint error), every TLS handshake in
/// Strict mode fails-closed → fleet strands simultaneously. A
/// well-intentioned operator mistake or a cloud-side compromise would
/// brick devices the same way. This is an availability-class lethal
/// failure mode that the type system can rule out structurally.
///
/// ## WHY 3600 seconds
///
/// The cloud-side manifest signing ceremony per ADR-018 §8 is gated on a
/// two-person co-approver workflow that takes at least 30 minutes
/// end-to-end (mint cert + sign manifest + push to operator + co-approver
/// review + push to fleet). 1 hour absorbs the ceremony latency PLUS a
/// safety margin for the fleet to actually pick up the new manifest
/// (some devices on flaky LTE may take tens of minutes to receive a
/// command). A floor any shorter would let a hurry-up manifest sneak
/// through that already-collapsed `bridge_until` past-window arithmetic.
///
/// ## Why `pub` and not module-private
///
/// Future Phase 1.2 will add a signed-manifest deserialization path
/// (`commands/apply_signed_manifest.rs::CertRotationManifestV1`) that
/// accepts an operator-controlled `bridge_until_unix_secs`. The deser
/// path MUST call [`validate_bridge_window`] BEFORE constructing
/// [`CertRotationStage::BridgeRotation`] so the floor applies uniformly
/// across every construction site. Exposing the const + validator at the
/// pinning module level is the single SSoT — adding a new construction
/// site without going through the validator would fail the
/// `bridge_window_floor_enforced_at_construction_sites` invariant test.
pub const MIN_BRIDGE_WINDOW_SECS: i64 = 3600;

/// Outcome of [`validate_bridge_window`]. `Display` impl yields
/// operator-readable text suitable for command-handler error responses
/// + audit-sink emit; the structured fields are preserved for forensic
/// queries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeWindowError {
    /// `bridge_until_unix_secs` is in the past or within
    /// [`MIN_BRIDGE_WINDOW_SECS`] of `now_unix_secs`. Includes the
    /// computed floor and supplied window for forensic queries.
    WindowTooShort {
        bridge_until_unix_secs: i64,
        now_unix_secs: i64,
        floor_secs: i64,
    },
    /// `now_unix_secs` is negative — clock sanity gate. Mirrors the same
    /// gate in `verify_cert_at_handshake` so a corrupted RTC cannot
    /// silently accept a stale `bridge_until` by underflowing the
    /// arithmetic.
    InvalidNow { now_unix_secs: i64 },
}

impl std::fmt::Display for BridgeWindowError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WindowTooShort {
                bridge_until_unix_secs,
                now_unix_secs,
                floor_secs,
            } => write!(
                f,
                "BridgeRotation rejected: bridge_until_unix_secs={bridge_until_unix_secs} \
                 must be > now_unix_secs={now_unix_secs} + MIN_BRIDGE_WINDOW_SECS={floor_secs} \
                 (1-hour fleet-rotation floor — ORPHAN-HIGH-039 architectural guard)"
            ),
            Self::InvalidNow { now_unix_secs } => write!(
                f,
                "BridgeRotation rejected: now_unix_secs={now_unix_secs} is negative — \
                 clock sanity violation (corrupted RTC?)"
            ),
        }
    }
}

impl std::error::Error for BridgeWindowError {}

/// Architectural floor for [`CertRotationStage::BridgeRotation`].
/// ORPHAN-HIGH-039 Phase 1.1.5 closure.
///
/// Returns `Ok(())` IFF `bridge_until_unix_secs > now_unix_secs +
/// MIN_BRIDGE_WINDOW_SECS` AND `now_unix_secs >= 0`. Every BridgeRotation
/// construction site MUST call this BEFORE constructing the variant —
/// either directly or via [`CertRotationStage::try_bridge_rotation`]. The
/// invariant test `bridge_window_floor_enforced_at_construction_sites`
/// pins this discipline.
///
/// Saturating arithmetic guards against `i64::MAX` overflow — a large
/// `now_unix_secs` (e.g., year 4000+) cannot wrap into a smaller floor.
pub fn validate_bridge_window(
    bridge_until_unix_secs: i64,
    now_unix_secs: i64,
) -> Result<(), BridgeWindowError> {
    if now_unix_secs < 0 {
        return Err(BridgeWindowError::InvalidNow { now_unix_secs });
    }
    let floor = now_unix_secs.saturating_add(MIN_BRIDGE_WINDOW_SECS);
    if bridge_until_unix_secs <= floor {
        return Err(BridgeWindowError::WindowTooShort {
            bridge_until_unix_secs,
            now_unix_secs,
            floor_secs: MIN_BRIDGE_WINDOW_SECS,
        });
    }
    Ok(())
}

impl CertRotationStage {
    /// Smart constructor for [`Self::BridgeRotation`] — Tier-1 architectural
    /// guard for ORPHAN-HIGH-039. Calls [`validate_bridge_window`]
    /// internally; returns the variant only if the floor is satisfied.
    ///
    /// Every NEW BridgeRotation construction site (signed-manifest deser
    /// path in Phase 1.2, future operator surfaces) MUST go through this
    /// constructor rather than direct enum-variant construction. The
    /// `bridge_window_floor_enforced_at_construction_sites` invariant test
    /// detects regressions where a construction site bypasses this floor.
    ///
    /// Build-time call sites (`rustls_verifier::build_rotation_stage_from_pins_hex`)
    /// pass an obviously-future `bridge_until` (e.g., `i64::MAX / 2`) +
    /// `now_unix_secs = 0` — those calls always pass the floor and document
    /// the channel discipline. Runtime call sites (operator command
    /// handlers, future signed-manifest deser) supply the real `now_unix_secs`
    /// from `SystemTime::now()`.
    pub fn try_bridge_rotation(
        outgoing: PinnedLeafCert,
        incoming: PinnedLeafCert,
        bridge_until_unix_secs: i64,
        now_unix_secs: i64,
    ) -> Result<Self, BridgeWindowError> {
        validate_bridge_window(bridge_until_unix_secs, now_unix_secs)?;
        Ok(Self::BridgeRotation {
            outgoing,
            incoming,
            bridge_until_unix_secs,
        })
    }

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

    // ====================================================================
    // ORPHAN-HIGH-039 / Phase 1.1.5 — bridge-window floor validator tests
    // ====================================================================

    /// `now_unix_secs + MIN_BRIDGE_WINDOW_SECS` is the floor; a `bridge_until`
    /// EXACTLY equal to the floor is REJECTED (strict greater-than is the
    /// architectural contract — the operator must commit to *more than*
    /// the floor, not exactly the floor, to absorb fleet propagation
    /// latency).
    #[test]
    fn validate_bridge_window_rejects_exact_floor() {
        let now = 1_750_000_000;
        let floor = now + MIN_BRIDGE_WINDOW_SECS;
        let err = validate_bridge_window(floor, now)
            .expect_err("exact floor must be rejected (strict greater-than)");
        assert!(matches!(
            err,
            BridgeWindowError::WindowTooShort {
                bridge_until_unix_secs,
                now_unix_secs,
                floor_secs: MIN_BRIDGE_WINDOW_SECS,
            } if bridge_until_unix_secs == floor && now_unix_secs == now
        ));
    }

    /// `bridge_until` 1 second above the floor is ACCEPTED — the smallest
    /// legitimate window.
    #[test]
    fn validate_bridge_window_accepts_one_second_past_floor() {
        let now = 1_750_000_000;
        let bridge_until = now + MIN_BRIDGE_WINDOW_SECS + 1;
        validate_bridge_window(bridge_until, now).expect("1 second past floor must be accepted");
    }

    /// `bridge_until` in the past is rejected with `WindowTooShort`.
    /// This is the primary attack vector ORPHAN-HIGH-039 documents:
    /// cloud manifest with past-time bridge window collapses BridgeRotation
    /// to "incoming only" immediately, stranding the fleet if `incoming`
    /// is wrong.
    #[test]
    fn validate_bridge_window_rejects_past_time() {
        let now = 1_750_000_000;
        let past = now - 86_400; // 1 day in the past
        let err =
            validate_bridge_window(past, now).expect_err("past bridge_until must be rejected");
        assert!(matches!(
            err,
            BridgeWindowError::WindowTooShort {
                bridge_until_unix_secs,
                ..
            } if bridge_until_unix_secs == past
        ));
    }

    /// Negative `now_unix_secs` is the clock-sanity gate. A corrupted RTC
    /// reading -1 cannot silently let a small positive `bridge_until` look
    /// like the future via integer-arithmetic underflow.
    #[test]
    fn validate_bridge_window_rejects_negative_now() {
        let err = validate_bridge_window(1_000_000, -1).expect_err("negative now must be rejected");
        assert!(matches!(
            err,
            BridgeWindowError::InvalidNow { now_unix_secs: -1 }
        ));
    }

    /// `i64::MAX` saturating add does not wrap. A future-dated `now`
    /// (year 4000+) plus the 1-hour floor cannot wrap to a tiny number
    /// that a small `bridge_until` would coincidentally satisfy.
    #[test]
    fn validate_bridge_window_saturating_add_no_wrap() {
        let now = i64::MAX - 100; // saturating_add yields i64::MAX
        // bridge_until = i64::MAX is NOT > i64::MAX (strict greater-than),
        // so this is rejected — the floor is unreachable. Operators with
        // legitimate use cases at year-9999 must replace the saturating
        // arithmetic with a wider type; until then the contract is "year
        // 9999 is not supported".
        let err = validate_bridge_window(i64::MAX, now)
            .expect_err("saturated floor must reject equal bridge_until");
        assert!(matches!(err, BridgeWindowError::WindowTooShort { .. }));
    }

    /// Smart constructor `try_bridge_rotation` propagates the validator.
    #[test]
    fn try_bridge_rotation_rejects_short_window() {
        let now = 1_750_000_000;
        let out = canned_cert(0x01, "out");
        let inc = canned_cert(0x02, "inc");
        let too_short = now + 60; // 1 minute, well below the 1-hour floor
        let err = CertRotationStage::try_bridge_rotation(out, inc, too_short, now)
            .expect_err("60-second window must be rejected");
        assert!(matches!(
            err,
            BridgeWindowError::WindowTooShort {
                bridge_until_unix_secs,
                ..
            } if bridge_until_unix_secs == too_short
        ));
    }

    /// Smart constructor success path — produces an indistinguishable
    /// `CertRotationStage::BridgeRotation` to a valid direct construction
    /// (defense-in-depth: the constructor adds the validator gate without
    /// changing the wire format).
    #[test]
    fn try_bridge_rotation_accepts_valid_window_and_yields_bridge_variant() {
        let now = 1_750_000_000;
        let out = canned_cert(0x01, "out");
        let inc = canned_cert(0x02, "inc");
        let valid = now + 86_400; // 1 day window
        let stage = CertRotationStage::try_bridge_rotation(out.clone(), inc.clone(), valid, now)
            .expect("1-day window must be accepted");
        match stage {
            CertRotationStage::BridgeRotation {
                outgoing,
                incoming,
                bridge_until_unix_secs,
            } => {
                assert_eq!(outgoing, out);
                assert_eq!(incoming, inc);
                assert_eq!(bridge_until_unix_secs, valid);
            }
            other => panic!("expected BridgeRotation, got {:?}", other),
        }
    }

    /// `Display` impl yields operator-readable text including the floor
    /// constant. Audit-sink emit + command-handler error responses use
    /// this — the message must name the architectural floor explicitly so
    /// operators reading logs can reason about the boundary.
    #[test]
    fn bridge_window_error_display_names_floor_explicitly() {
        let err = BridgeWindowError::WindowTooShort {
            bridge_until_unix_secs: 100,
            now_unix_secs: 50,
            floor_secs: MIN_BRIDGE_WINDOW_SECS,
        };
        let msg = format!("{err}");
        assert!(
            msg.contains("MIN_BRIDGE_WINDOW_SECS=3600"),
            "Display must name the floor constant: {msg}"
        );
        assert!(
            msg.contains("ORPHAN-HIGH-039"),
            "Display must reference the closure finding ID: {msg}"
        );
    }
}
