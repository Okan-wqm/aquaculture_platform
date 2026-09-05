//! # FileBackedAcceptance — operator-gated acceptance for file-backed keystore
//!
//! **Problem statement (ADR-018 §5):** file-backed master key storage is
//! strictly less secure than TPM or systemd-creds. It MUST be unavailable by
//! default. But on hardware that lacks TPM (pre-CM4 RPi, certain RevPi models,
//! cost-sensitive deployments) the operator may legitimately accept the risk.
//!
//! **Architectural solution (tier-1 make-it-impossible):** the file-backed
//! backend is unreachable without a successfully-constructed
//! [`FileBackedAcceptance`] value. Construction REQUIRES:
//!
//! 1. Operator's explicit boolean ack (`i_accept_file_backed_keystore_risk: true`)
//! 2. A UTC expiry timestamp that is STRICTLY IN THE FUTURE at keystore init
//!    (stale acceptance after TPM outage + operator rotation → auto-reject)
//! 3. An ed25519 signature by the PLATFORM_KEY_CEREMONY key (ADR-021 §9 slot
//!    for acceptance-token signing), covering the operator_id + acceptance
//!    canonical bytes — operator cannot self-issue an acceptance
//!
//! The struct fields are all private; the only ctor is `try_from_parts()`
//! which validates (1) + (2) + (3). A consumer holding a
//! `FileBackedAcceptance` has a proof-of-acceptance; consumers without one
//! CANNOT use the file-backed backend.
//!
//! **Why we sign the acceptance (not rely on config-integrity D-13):**
//! config integrity covers `config.yaml` as a whole with a factory key.
//! Acceptance tokens are field-serviceable — operators must be able to renew
//! them without round-tripping the factory. Separate signing key (ADR-021
//! "acceptance_token" slot) lets the operator-ceremony quorum sign acceptance
//! without touching the firmware signing key.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Signed acceptance token — the wire-format object delivered to the device.
/// The fields reproduce the operator's act of acceptance and the ceremony
/// signature binding it.
///
/// **Invariants at the struct level (serde-parsed shape):** fields are
/// permitted to take any value; validation happens at
/// [`FileBackedAcceptance::try_from_parts`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcceptanceToken {
    /// Operator identifier — bound into signature. Must match the operator
    /// currently unlocking the device (ADR-021 §8 4-eye quorum lookup).
    pub operator_id: String,

    /// UTC expiry as UNIX seconds. Enforced as strictly in the future at
    /// `try_from_parts` time.
    pub expires_at_unix_secs: i64,

    /// Hardware-specific note (model / deployment identifier). Bound into
    /// signature — an acceptance issued for device A cannot unlock device B.
    pub device_id: String,

    /// ed25519 signature over canonical bytes (operator_id || expires_at_unix_secs
    /// || device_id || `b"file-backed-acceptance-v1"`). 64 raw bytes.
    ///
    /// **Wire format note:** default serde serialization — JSON emits a
    /// number array, bincode emits length-prefixed bytes. No `serde_bytes`
    /// wrapper because the dep graph does not carry that crate; if a CBOR
    /// wire format is introduced later, a dedicated wrapper type is added
    /// at that time rather than implicit polymorphism here.
    pub signature: Vec<u8>,
}

/// Sealed acceptance — constructible ONLY via `try_from_parts` after validation.
/// Holding a `FileBackedAcceptance` is the type-level proof that file-backed
/// keystore is authorized for this boot.
///
/// **Why pub fields forbidden:** every field is hidden; consumers cannot
/// fabricate a `FileBackedAcceptance` from an unsigned `AcceptanceToken`.
///
/// **Why Debug is derived (Batch 69, closes ORPHAN-HIGH-012):** the
/// sealed-construction invariant is enforced by private fields + the
/// `try_from_parts` sole-constructor path — Debug only PRINTS values,
/// it cannot CONSTRUCT. Field values (operator_id, device_id,
/// expires_at) already round-trip through the public `AcceptanceToken`
/// shape, so Debug-printing them leaks nothing that is not already on
/// the wire. Enables `.expect_err(...)` in tests without weakening
/// construction discipline.
#[derive(Debug)]
pub struct FileBackedAcceptance {
    operator_id: String,
    device_id: String,
    expires_at: SystemTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileBackedAcceptanceError {
    /// `expires_at_unix_secs` was in the past at validation time.
    Expired {
        expired_at_unix_secs: i64,
        now_unix_secs: i64,
    },

    /// `expires_at_unix_secs` parses as an impossible `SystemTime`
    /// (negative + before UNIX epoch, or overflow).
    InvalidExpiry,

    /// Signature length != 64 bytes.
    InvalidSignatureLength(usize),

    /// Operator/device binding failed: caller-expected values do not match
    /// the token's claims.
    IdentityMismatch,

    /// Signature verification failed against the expected pubkey.
    InvalidSignature,

    /// Operator ID / device ID fields empty — catches misconfigured tokens
    /// before reaching the signature verify step.
    EmptyIdentity,
}

impl std::fmt::Display for FileBackedAcceptanceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Expired {
                expired_at_unix_secs,
                now_unix_secs,
            } => write!(
                f,
                "acceptance expired: expired_at={} now={}",
                expired_at_unix_secs, now_unix_secs
            ),
            Self::InvalidExpiry => f.write_str("acceptance expiry timestamp invalid"),
            Self::InvalidSignatureLength(n) => {
                write!(f, "acceptance signature length {} != 64", n)
            }
            Self::IdentityMismatch => f.write_str("acceptance operator/device identity mismatch"),
            Self::InvalidSignature => f.write_str("acceptance signature invalid"),
            Self::EmptyIdentity => f.write_str("acceptance operator_id or device_id empty"),
        }
    }
}

impl std::error::Error for FileBackedAcceptanceError {}

impl FileBackedAcceptance {
    /// Canonical bytes fed to ed25519 signing / verify. Fixed order so the
    /// signer and verifier produce identical byte sequences; the ADR-021
    /// ceremony uses this exact canonicalization.
    ///
    /// **Encoding (length-prefix framing, v2 — EDGE-LOW-101 closure):**
    ///
    /// ```text
    /// be_u32(operator_id.len()) || operator_id ||
    /// be_i64(expires_at_unix_secs) ||
    /// be_u32(device_id.len())   || device_id   ||
    /// b"file-backed-acceptance-v2"
    /// ```
    ///
    /// **Why length-prefix (not NUL separator):** the v1 scheme used single
    /// NUL bytes between variable-length fields. Because Rust `String` permits
    /// interior NUL and the attacker controls the full 8-byte BE-encoded
    /// expires field, two inputs differing only in how a substring straddles
    /// the operator/expires/device boundary could hash to identical canonical
    /// bytes. Length-prefix framing makes every field boundary unambiguous
    /// regardless of payload content — a classic collision-resistance pattern.
    ///
    /// **Migration note:** Batch 4b is pre-runtime; no ceremony-signed
    /// acceptance exists in the fleet yet, so bumping the domain tag from
    /// `v1` to `v2` is free. Any future change REQUIRES re-signing every
    /// field-deployed acceptance, so this is the last cheap moment to fix
    /// the framing. After Faz 2 Sprint 6.3 runtime lands, the tag is frozen.
    ///
    /// **Stability contract:** The tag suffix `b"file-backed-acceptance-v2"`
    /// is part of the domain-separation label. Bumping to v3 requires an ADR
    /// + coordinated fleet migration.
    pub fn canonical_bytes(
        operator_id: &str,
        expires_at_unix_secs: i64,
        device_id: &str,
    ) -> Vec<u8> {
        let tag = b"file-backed-acceptance-v2";
        let mut out =
            Vec::with_capacity(4 + operator_id.len() + 8 + 4 + device_id.len() + tag.len());
        out.extend_from_slice(&(operator_id.len() as u32).to_be_bytes());
        out.extend_from_slice(operator_id.as_bytes());
        out.extend_from_slice(&expires_at_unix_secs.to_be_bytes());
        out.extend_from_slice(&(device_id.len() as u32).to_be_bytes());
        out.extend_from_slice(device_id.as_bytes());
        out.extend_from_slice(tag);
        out
    }

    /// Validate + construct. On success the caller holds the proof-of-acceptance
    /// required to unlock the file-backed keystore backend.
    ///
    /// **Ordering:** identity non-empty → expiry future → signature length →
    /// signature verify → construct. Earlier checks fail fast to avoid
    /// unnecessary verify work; the signature verify step is the last gate.
    ///
    /// `now`: injected monotonic-safe SystemTime (tests override; runtime
    /// passes `SystemTime::now()` after verifying it is NTS-synced per
    /// plan D-7 clock authority).
    ///
    /// `verify_signature`: closure that ed25519-verifies the canonical bytes
    /// against the ceremony pubkey. Injected so Batch 4b stays pure types —
    /// Faz 2 Sprint 6.3 plugs in `ed25519_dalek::VerifyingKey::verify_strict`.
    pub fn try_from_parts(
        token: &AcceptanceToken,
        expected_operator_id: &str,
        expected_device_id: &str,
        now: SystemTime,
        verify_signature: impl FnOnce(&[u8], &[u8]) -> bool,
    ) -> Result<Self, FileBackedAcceptanceError> {
        if token.operator_id.is_empty() || token.device_id.is_empty() {
            return Err(FileBackedAcceptanceError::EmptyIdentity);
        }

        if token.operator_id != expected_operator_id || token.device_id != expected_device_id {
            return Err(FileBackedAcceptanceError::IdentityMismatch);
        }

        let now_unix_secs = now
            .duration_since(UNIX_EPOCH)
            .map_err(|_| FileBackedAcceptanceError::InvalidExpiry)?
            .as_secs() as i64;

        if token.expires_at_unix_secs <= now_unix_secs {
            return Err(FileBackedAcceptanceError::Expired {
                expired_at_unix_secs: token.expires_at_unix_secs,
                now_unix_secs,
            });
        }

        if token.signature.len() != 64 {
            return Err(FileBackedAcceptanceError::InvalidSignatureLength(
                token.signature.len(),
            ));
        }

        let expires_at = UNIX_EPOCH
            .checked_add(Duration::from_secs(token.expires_at_unix_secs as u64))
            .ok_or(FileBackedAcceptanceError::InvalidExpiry)?;

        let canonical = Self::canonical_bytes(
            &token.operator_id,
            token.expires_at_unix_secs,
            &token.device_id,
        );

        if !verify_signature(&canonical, &token.signature) {
            return Err(FileBackedAcceptanceError::InvalidSignature);
        }

        Ok(Self {
            operator_id: token.operator_id.clone(),
            device_id: token.device_id.clone(),
            expires_at,
        })
    }

    pub fn operator_id(&self) -> &str {
        &self.operator_id
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn expires_at(&self) -> SystemTime {
        self.expires_at
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_token(future_secs: i64) -> AcceptanceToken {
        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        AcceptanceToken {
            operator_id: "op-42".to_string(),
            device_id: "dev-123".to_string(),
            expires_at_unix_secs: now_secs + future_secs,
            signature: vec![0u8; 64],
        }
    }

    /// WHY: Identity match is the first sanity gate; must fire before any
    ///      cryptographic verify work.
    #[test]
    fn rejects_operator_mismatch() {
        let token = valid_token(3600);
        let err = FileBackedAcceptance::try_from_parts(
            &token,
            "op-different",
            "dev-123",
            SystemTime::now(),
            |_, _| true,
        )
        .expect_err("mismatch must fail");
        assert_eq!(err, FileBackedAcceptanceError::IdentityMismatch);
    }

    #[test]
    fn rejects_device_mismatch() {
        let token = valid_token(3600);
        let err = FileBackedAcceptance::try_from_parts(
            &token,
            "op-42",
            "dev-different",
            SystemTime::now(),
            |_, _| true,
        )
        .expect_err("mismatch must fail");
        assert_eq!(err, FileBackedAcceptanceError::IdentityMismatch);
    }

    /// WHY: Empty operator_id / device_id is a misconfiguration signal —
    ///      reject before signature verify.
    #[test]
    fn rejects_empty_identity() {
        let mut token = valid_token(3600);
        token.operator_id = String::new();
        let err = FileBackedAcceptance::try_from_parts(
            &token,
            "",
            "dev-123",
            SystemTime::now(),
            |_, _| true,
        )
        .expect_err("empty must fail");
        assert_eq!(err, FileBackedAcceptanceError::EmptyIdentity);
    }

    /// WHY: Past expiry MUST be rejected — "acceptance never expires"
    ///      defeats the whole safety rail.
    #[test]
    fn rejects_expired_token() {
        let token = valid_token(-10); // 10 seconds in the past
        let err = FileBackedAcceptance::try_from_parts(
            &token,
            "op-42",
            "dev-123",
            SystemTime::now(),
            |_, _| true,
        )
        .expect_err("past expiry must fail");
        assert!(matches!(err, FileBackedAcceptanceError::Expired { .. }));
    }

    /// WHY: Signature length invariant is a cheap pre-check.
    #[test]
    fn rejects_wrong_signature_length() {
        let mut token = valid_token(3600);
        token.signature = vec![0u8; 63];
        let err = FileBackedAcceptance::try_from_parts(
            &token,
            "op-42",
            "dev-123",
            SystemTime::now(),
            |_, _| true,
        )
        .expect_err("short sig must fail");
        assert_eq!(err, FileBackedAcceptanceError::InvalidSignatureLength(63));
    }

    /// WHY: A failing verify closure must map to InvalidSignature — tier-1
    ///      make-it-impossible: no path from an unverified token to an
    ///      accepted acceptance.
    #[test]
    fn rejects_invalid_signature() {
        let token = valid_token(3600);
        let err = FileBackedAcceptance::try_from_parts(
            &token,
            "op-42",
            "dev-123",
            SystemTime::now(),
            |_, _| false,
        )
        .expect_err("bad sig must fail");
        assert_eq!(err, FileBackedAcceptanceError::InvalidSignature);
    }

    /// WHY: Happy path — valid token + matching identity + future expiry +
    ///      good sig → construction succeeds AND preserves token fields.
    #[test]
    fn accepts_valid_token_and_preserves_fields() {
        let token = valid_token(3600);
        let acc = FileBackedAcceptance::try_from_parts(
            &token,
            "op-42",
            "dev-123",
            SystemTime::now(),
            |_, _| true,
        )
        .expect("valid acceptance must succeed");
        assert_eq!(acc.operator_id(), "op-42");
        assert_eq!(acc.device_id(), "dev-123");
        // expiry = UNIX_EPOCH + expires_at_unix_secs; sanity-check > now.
        assert!(acc.expires_at() > SystemTime::now());
    }

    /// WHY (EDGE-HIGH-011): the production boot path (bootstrap.rs)
    /// injects a real `verify_strict` closure over the ceremony
    /// verifying key. Prove that wiring end-to-end: a signature over
    /// the canonical bytes is accepted, and a token whose canonical
    /// bytes differ from what was signed is rejected as
    /// InvalidSignature. Before EDGE-HIGH-011 the closure was
    /// `|_,_| true` and this distinction did not exist.
    #[test]
    fn real_ed25519_verify_strict_round_trip() {
        use ed25519_dalek::{Signer, SigningKey};

        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let verifying = signing.verifying_key();

        let mut token = valid_token(3600);
        let canonical = FileBackedAcceptance::canonical_bytes(
            &token.operator_id,
            token.expires_at_unix_secs,
            &token.device_id,
        );
        token.signature = signing.sign(&canonical).to_bytes().to_vec();

        let verify = |c: &[u8], s: &[u8]| {
            let arr: [u8; 64] = match s.try_into() {
                Ok(a) => a,
                Err(_) => return false,
            };
            verifying
                .verify_strict(c, &ed25519_dalek::Signature::from_bytes(&arr))
                .is_ok()
        };

        // Genuine signature over the token's canonical bytes → accept.
        assert!(
            FileBackedAcceptance::try_from_parts(
                &token,
                "op-42",
                "dev-123",
                SystemTime::now(),
                verify
            )
            .is_ok(),
            "genuine ceremony signature must be accepted"
        );

        // Same signature, but a token whose canonical bytes differ
        // (different expiry) → verify_strict fails → InvalidSignature.
        let mut tampered = valid_token(7200);
        tampered.signature = token.signature.clone();
        let verify2 = |c: &[u8], s: &[u8]| {
            let arr: [u8; 64] = match s.try_into() {
                Ok(a) => a,
                Err(_) => return false,
            };
            verifying
                .verify_strict(c, &ed25519_dalek::Signature::from_bytes(&arr))
                .is_ok()
        };
        let err = FileBackedAcceptance::try_from_parts(
            &tampered,
            "op-42",
            "dev-123",
            SystemTime::now(),
            verify2,
        )
        .expect_err("tampered token must fail signature verify");
        assert_eq!(err, FileBackedAcceptanceError::InvalidSignature);
    }

    /// WHY: Canonical bytes must be deterministic across invocations and
    ///      must embed the v2 domain-separation tag (length-prefix framing).
    #[test]
    fn canonical_bytes_deterministic_with_v2_tag() {
        let a = FileBackedAcceptance::canonical_bytes("op-42", 1_800_000_000, "dev-123");
        let b = FileBackedAcceptance::canonical_bytes("op-42", 1_800_000_000, "dev-123");
        assert_eq!(a, b);
        let tag = b"file-backed-acceptance-v2";
        assert!(
            a.windows(tag.len()).any(|w| w == tag),
            "canonical bytes missing v2 tag"
        );
    }

    /// WHY (EDGE-LOW-101 regression guard): length-prefix framing must
    ///      prevent NUL-straddle collisions between (operator_id, device_id)
    ///      pairs where a substring migrates across the field boundary.
    ///      Under the v1 NUL-separator scheme, the v1 canonical bytes for
    ///      ("foo", exp=E1, "bar\0qux") and ("foo\0bar", exp=E2, "qux")
    ///      could be made byte-identical by choosing E1/E2 appropriately.
    ///      Under v2 length-prefix framing that collision is impossible.
    #[test]
    fn canonical_bytes_framing_resists_nul_straddle_collision() {
        // Pair #1 — baseline operator_id = "foo"; device_id contains NUL.
        let a = FileBackedAcceptance::canonical_bytes("foo", 0, "bar\0qux");
        // Pair #2 — operator_id absorbs the "bar" substring that was in
        // device_id; device_id shrinks to "qux". Under v1 single-NUL
        // separator this was a plausible collision with a carefully chosen
        // expires encoding. Under v2 length-prefix framing the byte
        // sequences cannot match because the length fields differ
        // (3 vs 7 for operator_id; 7 vs 3 for device_id).
        let b = FileBackedAcceptance::canonical_bytes("foo\0bar", 0, "qux");
        assert_ne!(a, b);
    }

    /// WHY: Length-prefix framing places a big-endian u32 length before each
    ///      variable-length field. Pin the first 4 bytes as the BE-encoded
    ///      operator_id length so any future encoder change is caught.
    #[test]
    fn canonical_bytes_first_four_bytes_are_operator_id_len_be() {
        let canon = FileBackedAcceptance::canonical_bytes("xy", 0, "z");
        assert_eq!(&canon[..4], &2u32.to_be_bytes());
        assert_eq!(&canon[4..6], b"xy");
    }

    /// WHY: Different inputs produce different canonical bytes — ensures the
    ///      signer cannot reuse a single signature across operators.
    #[test]
    fn canonical_bytes_differ_on_input_change() {
        let a = FileBackedAcceptance::canonical_bytes("op-42", 1_800_000_000, "dev-123");
        let b = FileBackedAcceptance::canonical_bytes("op-43", 1_800_000_000, "dev-123");
        let c = FileBackedAcceptance::canonical_bytes("op-42", 1_800_000_001, "dev-123");
        let d = FileBackedAcceptance::canonical_bytes("op-42", 1_800_000_000, "dev-124");
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, d);
    }

    /// WHY: AcceptanceToken must serde-roundtrip via serde_json for the
    ///      wire format (config delivery uses JSON).
    #[test]
    fn acceptance_token_serde_roundtrips() {
        let token = valid_token(3600);
        let json = serde_json::to_string(&token).expect("serialize");
        let back: AcceptanceToken = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, token);
    }
}
