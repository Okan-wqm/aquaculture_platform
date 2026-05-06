//! Faz 2 D-4 mTLS rotation state machine wire-status
//! invariants (Batch #323 — partial UH-018 D-4 progress).
//!
//! ## Why this file
//!
//! Plan §5 Faz 2 D-4 mandates "mTLS rotation state machine
//! + leaf pinning + staged rollout". The implementation
//! lives in `src/mtls/pinning.rs`:
//!
//!   - LeafCertFingerprint newtype (domain separation
//!     against firmware-digest / audit-HMAC outputs).
//!   - PinnedLeafCert struct (fingerprint + validity
//!     window + operator label).
//!   - CertRotationStage enum with two variants:
//!     * Settled { current } — steady state.
//!     * BridgeRotation { outgoing, incoming, bridge_until_unix_secs }
//!       — 7-day rotation window where BOTH fingerprints
//!       are accepted; after bridge_until expires the
//!       outgoing is silently retired (post-window
//!       collapse).
//!   - accepted_fingerprints(now) helper that gates the
//!     hot-path TLS verify against the current state.
//!
//! The 9 in-tree unit tests in `mtls::pinning::tests`
//! cover the BEHAVIOURAL contracts:
//!
//!   - settled_accepts_only_current_fingerprint
//!   - bridge_rotation_accepts_both_within_window
//!   - bridge_rotation_after_window_rejects_outgoing
//!   - rotation_stage_json_roundtrip
//!   - (5 more — pinning.rs:172 onwards)
//!
//! What's missing (and what THIS file pins) is the
//! WIRE-STATUS detection seam — a refactor that:
//!
//!   - Removes the BridgeRotation variant (collapses to
//!     Settled-only) silently disables 2-phase rotation.
//!   - Renames `bridge_until_unix_secs` to a SystemTime-
//!     bound type drops the i64 wire stability.
//!   - Removes the LeafCertFingerprint newtype lets a
//!     firmware digest accidentally compare-equal to a
//!     cert fingerprint.
//!   - Removes the wire_tag stable u8 mapping breaks the
//!     audit-event correlation.
//!
//! …would let the behavioural tests stay green while the
//! deployment shipped without 2-phase rotation. Tier-3
//! detection per CLAUDE.md hierarchy. Pattern mirrors
//! Batch #319 D-5 + Batch #321 Faz 1 + Batch #322 D-9
//! wire invariants.
//!
//! ## What this file does NOT close
//!
//! UH-018 D-4 parent finding may stay OPEN even after
//! this batch: the "staged rollout" half (cloud → fleet
//! push of new pinning manifest via update_cert_pinning
//! command) is the SECOND pillar of D-4. This batch
//! pins the LOCAL state-machine pillar; the cloud-side
//! orchestration is tracked separately under the
//! Faz 8 G-* gaps (admin-api edge controllers).

fn read_source(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "BUG: mtls_rotation_stage_monotonic invariant cannot read \
             {} — this test runs from sens-api-gateway/ working dir per \
             cargo test convention. err={}",
            path, e
        )
    })
}

const PINNING_RS: &str = "src/mtls/pinning.rs";

/// **D-4 wire-status invariant 1:** `LeafCertFingerprint`
/// newtype MUST exist + wrap `Sha256Digest` (domain
/// separation against firmware-digest / audit-HMAC
/// outputs which are also 32-byte SHA-256 hashes).
///
/// **Why this matters:** all three types are 32-byte
/// SHA-256 hashes; without the newtype an off-by-one
/// type confusion bug could let a firmware digest
/// compare-equal to a cert fingerprint via the bare
/// `[u8; 32]` shape. The newtype is the type-system-
/// enforced firewall.
#[test]
fn d4_leaf_cert_fingerprint_newtype_present() {
    let src = read_source(PINNING_RS);
    assert!(
        src.contains("pub struct LeafCertFingerprint"),
        "D-4 WIRE INVARIANT VIOLATED: {} does not define \
         `pub struct LeafCertFingerprint`. The newtype is the \
         type-system-enforced firewall against firmware-digest \
         / audit-HMAC / cert-fingerprint cross-domain confusion \
         (all 32-byte SHA-256 hashes). Deleting it lets a \
         firmware digest compare-equal to a cert fingerprint via \
         the bare [u8; 32] shape.",
        PINNING_RS
    );
    assert!(
        src.contains("LeafCertFingerprint(Sha256Digest)"),
        "D-4 WIRE INVARIANT VIOLATED: LeafCertFingerprint MUST \
         wrap `Sha256Digest` (the canonical 32-byte hash newtype). \
         Wrapping a bare [u8; 32] would defeat the cross-newtype \
         domain separation that Sha256Digest provides as the \
         intermediate layer."
    );
}

/// **D-4 wire-status invariant 2:** `CertRotationStage`
/// enum MUST exist + have BOTH variants (Settled +
/// BridgeRotation). Removing BridgeRotation collapses
/// the state machine to a single-state degenerate form
/// — silent disable of 2-phase rotation.
#[test]
fn d4_cert_rotation_stage_enum_two_variants_present() {
    let src = read_source(PINNING_RS);
    assert!(
        src.contains("pub enum CertRotationStage"),
        "D-4 WIRE INVARIANT VIOLATED: {} does not define \
         `pub enum CertRotationStage`. The enum is the SSoT for \
         the 2-phase rotation state machine; deleting it would \
         either crash every consumer that pattern-matches on it \
         OR (worse) silently restore single-cert pinning with \
         no rotation window.",
        PINNING_RS
    );
    // Both variants MUST appear in the enum body.
    assert!(
        src.contains("Settled { current"),
        "D-4 WIRE INVARIANT VIOLATED: CertRotationStage::Settled \
         variant missing or has wrong shape (expected \
         `Settled {{ current: ... }}`). The Settled state is the \
         steady-state configuration after a rotation completes."
    );
    assert!(
        src.contains("BridgeRotation {"),
        "D-4 WIRE INVARIANT VIOLATED: CertRotationStage::BridgeRotation {{}} \
         variant missing. Without it the 2-phase rotation window \
         (where BOTH outgoing + incoming fingerprints are accepted) \
         is unrepresentable; rotations would have to do an atomic \
         swap with zero overlap, breaking the operational \
         requirement of a 7-day fleet-rollout window."
    );
}

/// **D-4 wire-status invariant 3:** `BridgeRotation` MUST
/// carry `bridge_until_unix_secs: i64` (NOT `SystemTime`,
/// NOT `chrono::DateTime`, NOT `MonotonicDeadline`).
///
/// **Why i64 (not MonotonicDeadline):** the bridge_until
/// is a CALENDAR-time event coordinated with the cloud-
/// side rotation ceremony. Operators schedule against
/// wall-clock dates ("rotate before Q4 close"). Using
/// MonotonicDeadline would lose the timestamp on every
/// reboot — wrong shape for cross-restart cert windows.
/// Same architectural decision as Batch #315
/// KeystoreRotationDeadline's last_rotation_at_unix_secs
/// field (calendar-time event = wall-clock anchor).
#[test]
fn d4_bridge_rotation_bridge_until_is_unix_secs_i64() {
    let src = read_source(PINNING_RS);
    assert!(
        src.contains("bridge_until_unix_secs: i64"),
        "D-4 WIRE INVARIANT VIOLATED: BridgeRotation does not \
         carry `bridge_until_unix_secs: i64`. The field is the \
         deadline anchor for the rotation bridge window; using \
         SystemTime/DateTime/MonotonicDeadline instead would \
         either drop wire stability (the field is JSON-serialized \
         in the cloud-pushed manifest) OR lose the timestamp \
         across reboots (calendar-time events MUST persist as \
         wall-clock anchors, not process-bound monotonic anchors). \
         Same architectural decision as Batch #315 \
         KeystoreRotationDeadline."
    );
}

/// **D-4 wire-status invariant 4:** `wire_tag` method
/// MUST return stable `u8` for each variant (Settled=0,
/// BridgeRotation=1). The wire_tag is the audit-event
/// correlation key that operator dashboards use to
/// distinguish which state the rotation was in at the
/// time of an audit emission.
#[test]
fn d4_cert_rotation_stage_wire_tag_method_present() {
    let src = read_source(PINNING_RS);
    assert!(
        src.contains("pub const fn wire_tag"),
        "D-4 WIRE INVARIANT VIOLATED: CertRotationStage::wire_tag \
         method missing or no longer pub const. The wire_tag is \
         the audit-event correlation key — operator dashboards \
         + log greps key on the u8 to distinguish Settled (0) \
         from BridgeRotation (1) without parsing the full enum \
         JSON. `pub const fn` is required so the call is zero-cost \
         + can appear in const contexts (e.g., metric label \
         arrays)."
    );
    // Both variants must map to their stable u8.
    assert!(
        src.contains("Self::Settled { .. } => 0"),
        "D-4 WIRE INVARIANT VIOLATED: wire_tag does not map \
         Settled to 0. The mapping is wire-stable across audit \
         logs + operator dashboards; renumbering would invalidate \
         every historical audit event keyed on the old number."
    );
    assert!(
        src.contains("Self::BridgeRotation { .. } => 1"),
        "D-4 WIRE INVARIANT VIOLATED: wire_tag does not map \
         BridgeRotation to 1. See Settled comment for wire-stability \
         reasoning."
    );
}

/// **D-4 wire-status invariant 5:** `accepted_fingerprints`
/// method MUST handle the post-window collapse (after
/// bridge_until_unix_secs the BridgeRotation state
/// returns ONLY the incoming fingerprint, not both).
///
/// **Why this matters:** the post-window collapse is the
/// architectural property that prevents an attacker from
/// holding a stale outgoing cert past its retirement
/// window. Without the collapse, an attacker who
/// captured the outgoing private key BEFORE the rotation
/// could keep using it indefinitely.
#[test]
fn d4_accepted_fingerprints_handles_post_window_collapse() {
    let src = read_source(PINNING_RS);
    assert!(
        src.contains("pub fn accepted_fingerprints"),
        "D-4 WIRE INVARIANT VIOLATED: CertRotationStage::accepted_fingerprints \
         method missing. This is the hot-path TLS verify gate — \
         every server-cert handshake calls it to determine which \
         fingerprints are currently accepted. Deleting it forces \
         consumers to roll their own state-machine inspection, \
         introducing the post-window-collapse bug class."
    );
    // The behavioural unit tests in pinning.rs::tests
    // (bridge_rotation_after_window_rejects_outgoing) verify
    // the collapse is correct. Here we just pin the method
    // signature exists.
    assert!(
        src.contains("now_unix_secs"),
        "D-4 WIRE INVARIANT VIOLATED: accepted_fingerprints does \
         not take `now_unix_secs` argument. The post-window \
         collapse is gated by comparing the bridge_until against \
         a now-unix-secs argument; without the parameter the \
         method cannot determine whether the bridge window has \
         expired."
    );
}

/// **D-4 wire-status invariant 6:** `PinnedLeafCert`
/// MUST carry the `cert_label: String` field for
/// operator-readable rotation-ceremony tracking.
///
/// **Why this matters:** operators reading audit logs
/// during a rotation see entries like
/// `cert_rotation_started: outgoing="broker.suderra.prod.leaf.2026-01"
/// incoming="broker.suderra.prod.leaf.2026-04"` — the
/// labels are the diagnostic anchor. Without the field
/// the audit entry would carry only the SHA-256 hashes,
/// useless for human review.
#[test]
fn d4_pinned_leaf_cert_carries_operator_label() {
    let src = read_source(PINNING_RS);
    assert!(
        src.contains("pub cert_label: String"),
        "D-4 WIRE INVARIANT VIOLATED: PinnedLeafCert does not \
         carry `cert_label: String`. The label is the operator-\
         readable rotation-ceremony diagnostic anchor; without \
         it audit entries would carry only opaque SHA-256 hashes \
         which are useless for human review during incident \
         response."
    );
    assert!(
        src.contains("not_before_unix_secs: i64"),
        "D-4 WIRE INVARIANT VIOLATED: PinnedLeafCert does not \
         carry `not_before_unix_secs: i64`. The validity window \
         start is the architectural lower-bound for the \
         max_leaf_cert_age_days policy gate (mode-policy in \
         verify.rs)."
    );
    assert!(
        src.contains("not_after_unix_secs: i64"),
        "D-4 WIRE INVARIANT VIOLATED: PinnedLeafCert does not \
         carry `not_after_unix_secs: i64`. The validity window \
         end is the architectural upper-bound; expired certs \
         MUST be rejected even if the fingerprint matches."
    );
}

/// **D-4 wire-status invariant 7:** the in-tree
/// behavioural test
/// `bridge_rotation_after_window_rejects_outgoing` MUST
/// exist in `pinning.rs::tests`. This test is the
/// regression-detection seam for the post-window
/// collapse (invariant 5 pinned the SHAPE; this pins the
/// BEHAVIOURAL CONTRACT).
#[test]
fn d4_post_window_rejects_outgoing_test_present() {
    let src = read_source(PINNING_RS);
    assert!(
        src.contains("bridge_rotation_after_window_rejects_outgoing"),
        "D-4 WIRE INVARIANT VIOLATED: pinning.rs::tests does not \
         contain `bridge_rotation_after_window_rejects_outgoing`. \
         This is the BEHAVIOURAL regression-detection seam for \
         the post-window collapse property — without it a \
         refactor that breaks accepted_fingerprints() (e.g., \
         returns both fingerprints regardless of bridge_until) \
         would silently reintroduce the stale-outgoing-cert \
         vulnerability."
    );
}
