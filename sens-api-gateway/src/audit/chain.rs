//! # HMAC chain — `prev_hmac || entry_bytes -> current_hmac` (ADR-020 §2)
//!
//! The audit log is a hash chain. Each entry's `current_hmac` is
//! `HMAC-SHA256(chain_key, prev_hmac || entry.canonical_bytes())`. The
//! first entry uses `prev_hmac = 0u8[32]` (the chain-boundary marker).
//!
//! Tamper-evident property:
//! - Modifying any entry's bytes invalidates every subsequent HMAC.
//! - Inserting an entry invalidates every subsequent HMAC.
//! - Removing an entry breaks the chain on the next entry.
//!
//! Offline `audit-verify` CLI (Sprint 6.2) walks the chain from entry 0 and
//! asserts each `current_hmac` matches the recomputed value. Cloud-side the
//! chain is additionally anchored daily via ed25519 signature over
//! `current_hmac` of the last entry that day (ADR-020 §4).
//!
//! ## Scope of Batch 6 (this file)
//!
//! Types (`HmacChainEntry`, `PrevHmac`, `CurrentHmac`) + pure function
//! `append_entry` with closure-injected HMAC computation. No actual HMAC
//! library call here — Sprint 6.2 plugs in `hmac` + `sha2` crates via the
//! `Keystore::derive_key(KeyPurpose::AuditHmacChain, ...)` chain key.
//!
//! Keeping the HMAC out of this module means Batch 6 types compile without
//! pulling hmac/sha2 into the audit module graph and preserves the
//! closure-injection pattern already used by `verify_manifest` in Batch 5b.

use serde::{Deserialize, Serialize};

use super::entry::{AuditEntry, AuditEntryCanonicalBytesError};

/// 32-byte HMAC output — the "previous" slot of the chain. The first entry
/// of a chain uses `PrevHmac::ZERO` as the boundary marker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PrevHmac([u8; 32]);

impl PrevHmac {
    /// The chain-start / chain-boundary marker — all zeros.
    pub const ZERO: PrevHmac = PrevHmac([0u8; 32]);

    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// 32-byte HMAC output — the "current" slot of the chain. An entry's
/// `current_hmac` becomes the next entry's `prev_hmac`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CurrentHmac([u8; 32]);

impl CurrentHmac {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Convert the current slot into the next prev slot (identity on bytes).
    pub fn to_prev(self) -> PrevHmac {
        PrevHmac(self.0)
    }
}

/// One entry in the persisted audit log: the AuditEntry + its position in
/// the chain + the pair of HMACs that bind it to prev + propagate to next.
///
/// **Tier-1 make-it-impossible seal (EDGE-MEDIUM-003 closure):** fields are
/// `pub(crate)`; `#[non_exhaustive]` blocks external struct-literal
/// construction even via re-export. The only external ctor is
/// [`append_entry`] (which is also the only path that computes a correct
/// `current_hmac`). Reading is via accessors below; serde Deserialize
/// (for audit-verify CLI log-read path) bypasses visibility via derive —
/// that's intentional, audit-verify IS the enforcement boundary for read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct HmacChainEntry {
    pub(crate) sequence: u64,
    pub(crate) prev_hmac: PrevHmac,
    pub(crate) current_hmac: CurrentHmac,
    pub(crate) entry: AuditEntry,
}

impl HmacChainEntry {
    pub fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn prev_hmac(&self) -> PrevHmac {
        self.prev_hmac
    }

    pub fn current_hmac(&self) -> CurrentHmac {
        self.current_hmac
    }

    pub fn entry(&self) -> &AuditEntry {
        &self.entry
    }
}

/// Errors during chain append. Distinct from `AuditEntryCanonicalBytesError`
/// because chain-level issues (HMAC impl failure, sequence overflow) belong
/// in a separate discriminator for audit-verify CLI reporting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HmacChainError {
    /// The entry's canonical_bytes serialization failed upstream.
    EntryCanonicalBytesFailed(AuditEntryCanonicalBytesError),
    /// Sequence counter overflowed `u64::MAX`. Not reachable on real
    /// hardware — 18 quintillion audit entries — but explicit rejection
    /// beats silent wrap.
    SequenceOverflow,
    /// HMAC closure returned None / error — Sprint 6.2 wrappers catch
    /// hmac crate errors and surface here.
    HmacComputationFailed,
}

impl std::fmt::Display for HmacChainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EntryCanonicalBytesFailed(_) => f.write_str("entry_canonical_bytes_failed"),
            Self::SequenceOverflow => f.write_str("sequence_overflow"),
            Self::HmacComputationFailed => f.write_str("hmac_computation_failed"),
        }
    }
}

impl std::error::Error for HmacChainError {}

impl From<AuditEntryCanonicalBytesError> for HmacChainError {
    fn from(e: AuditEntryCanonicalBytesError) -> Self {
        Self::EntryCanonicalBytesFailed(e)
    }
}

/// Compute the HMAC input bytes: `prev_hmac.as_bytes() || entry.canonical_bytes()`.
/// Exposed as a standalone function so `audit-verify` CLI can reuse the exact
/// same canonicalization without re-implementing the concat.
///
/// **Why length-prefix NOT needed between `prev_hmac` and `entry_bytes`:**
/// `prev_hmac` is a fixed 32 bytes. The first byte of `entry_bytes` lands
/// at a deterministic offset regardless of content. No variable-length
/// ambiguity at the boundary.
pub fn compose_hmac_input(
    prev_hmac: PrevHmac,
    entry: &AuditEntry,
) -> Result<Vec<u8>, HmacChainError> {
    let entry_bytes = entry.canonical_bytes()?;
    let mut out = Vec::with_capacity(32 + entry_bytes.len());
    out.extend_from_slice(prev_hmac.as_bytes());
    out.extend_from_slice(&entry_bytes);
    Ok(out)
}

/// Append one entry to the chain. The HMAC computation is injected as a
/// closure (Sprint 6.2 wires `hmac::Hmac<Sha256>` + the
/// `KeyPurpose::AuditHmacChain` derived key); Batch 6 stays crypto-dep-free.
///
/// Caller provides `prev_sequence` (= previous entry's sequence, or 0 for the
/// first append — the first entry gets sequence 1 by convention so 0 can
/// serve as the "no prev" sentinel).
///
/// Returns the constructed `HmacChainEntry`; caller is responsible for
/// durably persisting it (fsync in Sprint 6.2 sink).
pub fn append_entry(
    prev_hmac: PrevHmac,
    prev_sequence: u64,
    entry: AuditEntry,
    compute_hmac: impl FnOnce(&[u8]) -> Option<[u8; 32]>,
) -> Result<HmacChainEntry, HmacChainError> {
    let sequence = prev_sequence
        .checked_add(1)
        .ok_or(HmacChainError::SequenceOverflow)?;

    let hmac_input = compose_hmac_input(prev_hmac, &entry)?;

    let current_bytes = compute_hmac(&hmac_input).ok_or(HmacChainError::HmacComputationFailed)?;
    let current_hmac = CurrentHmac::from_bytes(current_bytes);

    Ok(HmacChainEntry {
        sequence,
        prev_hmac,
        current_hmac,
        entry,
    })
}

#[cfg(test)]
mod tests {
    use super::super::entry::{
        AuditAction, AuditActor, AuditEntry, AuditOutcome, AuditPhase, AuditResource,
    };
    use super::*;
    use crate::authz::permission::TenantId;

    fn tenant() -> TenantId {
        TenantId::new_from_verified([0x42u8; 16])
    }

    fn canned_entry() -> AuditEntry {
        AuditEntry {
            timestamp_unix_secs: 1_700_000_000,
            timestamp_nanos: 0,
            correlation_id: "cmd-uuid-abc".to_string(),
            phase: AuditPhase::Pre,
            actor: AuditActor::new("op:<operator>"),
            tenant: tenant(),
            policy_version: 1,
            two_person_integrity_verified: false,
            action: AuditAction::TagRead,
            resource: AuditResource::Tag { name: "pond3_temp".to_string() },
            outcome: AuditOutcome::Success,
            detail: "".to_string(),
        }
    }

    fn mock_hmac(tag: u8) -> impl FnOnce(&[u8]) -> Option<[u8; 32]> {
        move |input: &[u8]| {
            // Deterministic mock (Batch 85 fix of pre-existing
            // ORPHAN-HIGH-013 #1): distributes ALL input bytes
            // across bytes 1..32 via position-aware rolling add.
            //
            // Pre-fix: used `input.iter().take(31)` which with a
            // 32-byte ZERO prev_hmac made the first 31 input
            // bytes always zero regardless of canonical entry
            // content -> tamper test couldn't distinguish.
            //
            // Post-fix: mixes position (`i as u8`) + byte value
            // into the output so length + content both
            // contribute. Different entries (different
            // canonical_bytes) produce different mock HMACs
            // under identical prev_hmac — the tamper-detection
            // invariant test now passes.
            //
            // NOT cryptographically secure — this is a Batch 6
            // test-only mock that avoids pulling hmac/sha2 into
            // the pure-types crate-graph. Production uses
            // `hmac::Hmac<Sha256>` via the sink closure (Batch 74).
            let mut out = [0u8; 32];
            out[0] = tag;
            for (i, b) in input.iter().enumerate() {
                let slot = (i % 31) + 1;
                out[slot] = out[slot].wrapping_add(b.wrapping_add(i as u8));
            }
            Some(out)
        }
    }

    /// WHY: First entry of a chain starts from PrevHmac::ZERO with
    ///      prev_sequence=0, producing sequence 1. Pin this convention.
    #[test]
    fn first_entry_uses_zero_prev_hmac_and_sequence_one() {
        let e = canned_entry();
        let appended = append_entry(PrevHmac::ZERO, 0, e.clone(), mock_hmac(0x01))
            .expect("first append ok");
        assert_eq!(appended.sequence, 1);
        assert_eq!(appended.prev_hmac, PrevHmac::ZERO);
        assert_eq!(appended.entry, e);
        assert_eq!(appended.current_hmac.as_bytes()[0], 0x01);
    }

    /// WHY: Second append links to first via current->prev roll-forward.
    #[test]
    fn second_entry_links_to_first_via_current_to_prev() {
        let first = append_entry(PrevHmac::ZERO, 0, canned_entry(), mock_hmac(0x01))
            .expect("first ok");
        let mut e2 = canned_entry();
        e2.correlation_id = "cmd-uuid-xyz".to_string();
        let second =
            append_entry(first.current_hmac.to_prev(), first.sequence, e2, mock_hmac(0x02))
                .expect("second ok");
        assert_eq!(second.sequence, 2);
        assert_eq!(second.prev_hmac, first.current_hmac.to_prev());
        assert_eq!(second.current_hmac.as_bytes()[0], 0x02);
    }

    /// WHY: Sequence overflow is rejected explicitly (never wraps silently).
    #[test]
    fn rejects_sequence_overflow() {
        let err = append_entry(PrevHmac::ZERO, u64::MAX, canned_entry(), mock_hmac(0x01))
            .expect_err("overflow");
        assert_eq!(err, HmacChainError::SequenceOverflow);
    }

    /// WHY: HMAC closure returning None surfaces as HmacComputationFailed.
    #[test]
    fn hmac_failure_surfaces_as_error() {
        let err = append_entry(PrevHmac::ZERO, 0, canned_entry(), |_| None).expect_err("hmac fail");
        assert_eq!(err, HmacChainError::HmacComputationFailed);
    }

    /// WHY: Canonical bytes error propagates via From into HmacChainError.
    #[test]
    fn canonical_bytes_error_propagates_into_chain_error() {
        let mut e = canned_entry();
        e.timestamp_unix_secs = -1;
        let err = append_entry(PrevHmac::ZERO, 0, e, mock_hmac(0x01))
            .expect_err("negative ts");
        match err {
            HmacChainError::EntryCanonicalBytesFailed(inner) => {
                assert_eq!(inner, AuditEntryCanonicalBytesError::NegativeTimestamp);
            }
            other => panic!("wrong error: {:?}", other),
        }
    }

    /// WHY: compose_hmac_input starts with 32 prev bytes, then entry bytes.
    ///      Pin the layout so audit-verify CLI produces matching input.
    #[test]
    fn compose_hmac_input_layout_is_prev_then_entry() {
        let prev = PrevHmac::from_bytes([0xabu8; 32]);
        let e = canned_entry();
        let input = compose_hmac_input(prev, &e).expect("ok");
        assert_eq!(&input[..32], &[0xabu8; 32]);
        let entry_bytes = e.canonical_bytes().expect("ok");
        assert_eq!(&input[32..], &entry_bytes[..]);
    }

    /// WHY: Changing the prev_hmac (tamper upstream) changes the HMAC input
    ///      to the closure — so any tamper cascades through current_hmac.
    ///      Mock HMAC captures this by mixing input bytes.
    #[test]
    fn different_prev_hmac_produces_different_current_hmac() {
        let e = canned_entry();
        let a = append_entry(PrevHmac::ZERO, 0, e.clone(), mock_hmac(0x42))
            .expect("ok a");
        let b = append_entry(PrevHmac::from_bytes([0xffu8; 32]), 0, e, mock_hmac(0x42))
            .expect("ok b");
        assert_ne!(a.current_hmac, b.current_hmac);
    }

    /// WHY: PrevHmac::ZERO is truly all zeros.
    #[test]
    fn prev_hmac_zero_const_is_all_zero() {
        assert_eq!(PrevHmac::ZERO.as_bytes(), &[0u8; 32]);
    }

    /// WHY: CurrentHmac::to_prev preserves bytes (identity on bytes).
    #[test]
    fn current_to_prev_preserves_bytes() {
        let current = CurrentHmac::from_bytes([0x77u8; 32]);
        let prev = current.to_prev();
        assert_eq!(prev.as_bytes(), current.as_bytes());
    }

    /// WHY: JSON serde roundtrip for persistence.
    #[test]
    fn hmac_chain_entry_json_roundtrip() {
        let entry = append_entry(PrevHmac::ZERO, 0, canned_entry(), mock_hmac(0x01))
            .expect("ok");
        let json = serde_json::to_string(&entry).expect("serialize");
        let back: HmacChainEntry = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, entry);
    }

    /// WHY: HmacChainError Display format — audit-verify CLI surface.
    #[test]
    fn hmac_chain_error_display_snake_case() {
        assert_eq!(format!("{}", HmacChainError::SequenceOverflow), "sequence_overflow");
        assert_eq!(
            format!("{}", HmacChainError::HmacComputationFailed),
            "hmac_computation_failed"
        );
        assert_eq!(
            format!(
                "{}",
                HmacChainError::EntryCanonicalBytesFailed(
                    AuditEntryCanonicalBytesError::NegativeTimestamp
                )
            ),
            "entry_canonical_bytes_failed"
        );
    }

    /// WHY: HmacChainError implements std::error::Error for `?` interop.
    #[test]
    fn hmac_chain_error_implements_std_error() {
        fn assert_err<E: std::error::Error>() {}
        assert_err::<HmacChainError>();
    }

    /// WHY (EDGE-HIGH-003 regression guard): the core chain property —
    ///      tampering an earlier entry's content invalidates every later
    ///      entry's HMAC input. Simulated by:
    ///      1. Append E1 with detail "original" → capture E1.current_hmac.
    ///      2. Chain E2 using E1.current_hmac as prev → E2_original.
    ///      3. Tamper E1's detail to "tampered" + recompute E1's HMAC with
    ///         the same closure → E1_tampered.current_hmac.
    ///      4. E1_tampered.current_hmac != E1.current_hmac (entry bytes
    ///         changed → HMAC input changed → HMAC changed).
    ///      5. E2_original's prev_hmac (= E1.current_hmac) is therefore
    ///         unequal to E1_tampered.current_hmac — audit-verify CLI
    ///         would fail chain-walk at E2.
    #[test]
    fn tamper_e1_detail_invalidates_e2_prev_hmac_link() {
        let mut e1 = canned_entry();
        e1.detail = "original".to_string();
        let chain_e1 = append_entry(PrevHmac::ZERO, 0, e1.clone(), mock_hmac(0x10))
            .expect("e1 ok");

        let mut e2 = canned_entry();
        e2.correlation_id = "cmd-uuid-e2".to_string();
        let chain_e2 = append_entry(
            chain_e1.current_hmac.to_prev(),
            chain_e1.sequence,
            e2,
            mock_hmac(0x20),
        )
        .expect("e2 ok");

        // E2's prev_hmac points at the ORIGINAL E1 current_hmac.
        assert_eq!(chain_e2.prev_hmac, chain_e1.current_hmac.to_prev());

        // Simulate a post-hoc tamper on E1: swap detail to "tampered".
        let mut e1_tampered = e1.clone();
        e1_tampered.detail = "tampered".to_string();
        let chain_e1_tampered =
            append_entry(PrevHmac::ZERO, 0, e1_tampered, mock_hmac(0x10)).expect("ok");

        // The tampered E1's current_hmac differs from the original E1's.
        assert_ne!(chain_e1.current_hmac, chain_e1_tampered.current_hmac);

        // E2's prev_hmac (bound to ORIGINAL E1) no longer matches the
        // tampered E1's current_hmac — chain break detectable by CLI.
        assert_ne!(
            chain_e2.prev_hmac,
            chain_e1_tampered.current_hmac.to_prev(),
            "tamper must invalidate the E1→E2 chain link"
        );
    }

    /// WHY (EDGE-MEDIUM-003 closure): HmacChainEntry accessors return the
    ///      correct sealed fields. Pinned so a future refactor that
    ///      accidentally swaps accessor bodies is caught.
    #[test]
    fn hmac_chain_entry_accessors_return_constructed_values() {
        let e = canned_entry();
        let chain =
            append_entry(PrevHmac::ZERO, 0, e.clone(), mock_hmac(0x33)).expect("ok");
        assert_eq!(chain.sequence(), 1);
        assert_eq!(chain.prev_hmac(), PrevHmac::ZERO);
        assert_eq!(chain.current_hmac().as_bytes()[0], 0x33);
        assert_eq!(chain.entry(), &e);
    }
}
