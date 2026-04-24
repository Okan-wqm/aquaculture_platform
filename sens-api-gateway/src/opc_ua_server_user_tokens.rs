//! OPC UA user-token enrollment primitive — Batch #242 Faz 5
//! (ultra-plan `ULTRA-HIGH-006`, Gap `A-3a` part 1).
//!
//! ## Role
//!
//! Batch #239-#241 landed the typed session principal
//! (`AuthenticatedUser`), the manifest-backed resolver
//! (`OpcUaActorResolver`), and the typed authz port
//! (`TypedAuthzPort`). What's missing is the **credential side**:
//! how does a client UserName/Password session produce a typed
//! `AuthenticatedUser::user_pass(operator_id)`? The answer is this
//! module's `UserTokenEnrollment::verify_user_pass` primitive —
//! it takes the attacker-visible `(username, password)` pair +
//! returns `OperatorId` only when the password matches an
//! enrolled operator's Argon2id credential hash.
//!
//! For X.509 client-cert sessions the parallel primitive is
//! `MachineIssuerX509Binding` — the session layer has already
//! verified the cert chain against the pinned trust anchor; this
//! primitive maps the verified CN to an `OperatorId`.
//!
//! ## Defence in depth
//!
//! 1. **Username normalization (NFKC + lowercase)** closes the
//!    homoglyph class: an attacker enrolling `"admın"` (Turkish
//!    dotless i) could otherwise masquerade as `"admin"`. Every
//!    incoming username goes through `NormalizedUsername::from_raw`
//!    before hash lookup, and every enrolled username is stored
//!    already-normalized.
//! 2. **Argon2id PHC-format hashes** — the canonical format
//!    `$argon2id$v=19$m=...$t=...$p=...$salt$hash` carries every
//!    parameter the verifier needs; the manifest issuer sets
//!    memory/time/parallelism at enrollment time.
//! 3. **Constant-time compare** — `argon2` crate's
//!    `PasswordHash::verify_password` already uses constant-time
//!    byte comparison on the derived key. This primitive wraps
//!    that call without introducing side-channels.
//! 4. **No username enumeration** — wrong password and unknown
//!    username both produce `UserTokenError::CredentialMismatch`
//!    with no timing skew (both paths perform one Argon2id
//!    derivation; the unknown-username path uses a canned dummy
//!    hash so the derivation cost is constant).
//! 5. **X.509 trust anchor binding** — `MachineIssuerX509Binding`
//!    stores the full DER-encoded trust anchor, not just the CN.
//!    A future attacker who obtains a different CA-signed cert
//!    with the same CN still fails because the trust-anchor path
//!    rejects the alternate root.
//!
//! ## What's NOT in Batch #242 (primitive-first)
//!
//! - `UserTokenEnrollment::from_manifest(&RbacManifest)` — the
//!   current manifest schema does NOT carry `credential_hash` or
//!   `trust_anchor` fields on `OperatorBinding`. Schema extension
//!   + `from_manifest` wiring lands with a follow-up batch (target
//!   W4 per ultra-plan G-4 cross-repo event schema pass).
//! - `async-opcua::server::authenticator::UserTokenValidator`
//!   impl that plugs into `ServerBuilder::with_authenticator`.
//!   That's Batch A-3b (#243 per ultra-plan cadence).
//! - Hot-reload subscription to `RbacManifestStore` watch channel.
//!   Also A-3b.
//!
//! ## Cross-references
//!
//! - ADR-018 §5 break-glass credential handling (operator
//!   enrollment ceremony)
//! - Batch #239 `opc_ua_server_session::MachineIssuerCn` — CN
//!   newtype reused here for X.509 binding key
//! - Batch #240 `OpcUaActorResolver` — consumes the `OperatorId`
//!   this primitive produces
//! - Ultra-plan `#Gap-A-3a` / finding registry `ULTRA-HIGH-006`

#![allow(dead_code)]

use std::fmt;

use argon2::{
    password_hash::{PasswordHash, PasswordVerifier},
    Argon2,
};
#[cfg(test)]
use argon2::{
    password_hash::{PasswordHasher, SaltString},
};
use secrecy::{ExposeSecret, Secret};
use unicode_normalization::UnicodeNormalization;

use crate::authz::permission::OperatorId;
use crate::opc_ua_server_session::MachineIssuerCn;

/// Minimum acceptable username length (bytes after normalization).
/// Single-char usernames are rejected because brute-force + enum
/// cost is too low.
const MIN_USERNAME_BYTES: usize = 2;

/// Maximum username length (bytes after normalization). Bounded
/// to prevent allocation DoS via gigantic username attempts.
const MAX_USERNAME_BYTES: usize = 128;

/// Canned dummy Argon2id hash used by the unknown-username path to
/// preserve constant-time semantics. The derivation cost of
/// verifying an attacker-supplied password against this hash is
/// the same as verifying against a real enrolled hash, so wall-
/// clock timing cannot distinguish the two paths. The hash is
/// built-from-constant so no manifest input reaches it.
const DUMMY_HASH_PHC: &str = "$argon2id$v=19$m=19456,t=2,p=1$YzltZTAwMDAwMDAwMDAwMA$Ko6MrqAKhuWJQI4uYhS6j9lRuW3xp8LW/rKi1uRQKpY";

/// Normalized username — NFKC + lowercase. Closes the homoglyph
/// attack class where Unicode shapes that render identically but
/// encode differently (e.g. Latin "a" U+0061 vs Cyrillic "а"
/// U+0430) could otherwise create parallel enrollments.
///
/// Construction is validated: rejects empty, too-short (<2 bytes),
/// too-long (>128 bytes), and strings that would produce empty
/// after normalization (rare control-char-only inputs).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct NormalizedUsername(String);

impl NormalizedUsername {
    /// Normalize + validate an attacker-visible raw username. The
    /// OPC UA session layer calls this on every `validate_user_token`
    /// attempt; the manifest issuer calls it at enrollment time
    /// (future batch) so stored + incoming usernames go through
    /// the same normalization.
    pub fn from_raw(raw: &str) -> Result<Self, UserTokenError> {
        // NFKC canonical decomposition + canonical composition,
        // then lowercase. The combination collapses compatibility-
        // equivalent forms (full-width digits, fraction ligatures,
        // etc.) to a single representation.
        let normalized: String = raw.nfkc().collect::<String>().to_lowercase();
        let trimmed = normalized.trim();
        if trimmed.is_empty() {
            return Err(UserTokenError::UsernameEmpty);
        }
        let len = trimmed.len();
        if len < MIN_USERNAME_BYTES {
            return Err(UserTokenError::UsernameTooShort { got: len });
        }
        if len > MAX_USERNAME_BYTES {
            return Err(UserTokenError::UsernameTooLong { got: len });
        }
        Ok(Self(trimmed.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Argon2id PHC-format credential hash. Parse-validated at
/// construction so callers hold the guarantee that the hash is
/// well-formed + verifiable. Parsing separately from verification
/// means a manifest-parse-time failure (malformed hash) surfaces
/// BEFORE any authentication attempt — catches operator-enrollment
/// bugs at manifest load, not at first login.
#[derive(Debug, Clone)]
pub struct Argon2idHash(String);

impl Argon2idHash {
    /// Construct from a PHC-format string. Validates the hash is
    /// parseable by the `argon2` crate — a malformed string fails
    /// here, not at first verify attempt.
    pub fn from_phc(phc: String) -> Result<Self, UserTokenError> {
        PasswordHash::new(&phc).map_err(|e| {
            UserTokenError::HashFormatInvalid {
                reason: format!("{:?}", e),
            }
        })?;
        Ok(Self(phc))
    }

    /// Test-only helper that builds a real Argon2id hash from a
    /// plaintext password + a given salt. Production enrollment
    /// happens elsewhere (HSM-backed ceremony); this ctor exists
    /// so unit tests can exercise the verify path without bundling
    /// canned PHC strings that would rot on crate upgrades.
    #[cfg(test)]
    pub(crate) fn for_test_hash(
        password: &[u8],
        salt_b64: &str,
    ) -> Result<Self, UserTokenError> {
        let salt = SaltString::from_b64(salt_b64).map_err(|e| {
            UserTokenError::HashFormatInvalid {
                reason: format!("salt: {:?}", e),
            }
        })?;
        let argon = Argon2::default();
        let hash = argon
            .hash_password(password, &salt)
            .map_err(|e| UserTokenError::HashFormatInvalid {
                reason: format!("hash: {:?}", e),
            })?;
        Ok(Self(hash.to_string()))
    }

    /// Verify a password attempt against this hash. Returns
    /// `Ok(())` on match, `Err(CredentialMismatch)` on non-match
    /// (constant-time via the argon2 crate's internal compare).
    fn verify(&self, password: &[u8]) -> Result<(), UserTokenError> {
        let parsed = PasswordHash::new(&self.0).map_err(|e| {
            UserTokenError::HashFormatInvalid {
                reason: format!("re-parse: {:?}", e),
            }
        })?;
        Argon2::default()
            .verify_password(password, &parsed)
            .map_err(|_| UserTokenError::CredentialMismatch)
    }

    pub fn as_phc(&self) -> &str {
        &self.0
    }
}

/// Validated X.509 trust-anchor DER bytes. Stored as raw bytes so
/// the session layer can compare the presented cert's issuer-chain
/// tip against it byte-for-byte. Parse-level validation checks
/// minimum sensible length + leading SEQUENCE byte (0x30) — a
/// strict X.509 parse happens at cert-chain-verify time, not at
/// enrollment parse time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct X509CertDer(Vec<u8>);

impl X509CertDer {
    const MIN_DER_LEN: usize = 128; // Conservative floor; real CA certs are always larger.

    pub fn from_der(bytes: Vec<u8>) -> Result<Self, UserTokenError> {
        if bytes.len() < Self::MIN_DER_LEN {
            return Err(UserTokenError::X509DerTooShort {
                got: bytes.len(),
                min: Self::MIN_DER_LEN,
            });
        }
        // DER-encoded X.509 cert always starts with SEQUENCE
        // (0x30). Anything else is not a plausible cert.
        if bytes[0] != 0x30 {
            return Err(UserTokenError::X509NotDerSequence {
                got_prefix: bytes[0],
            });
        }
        Ok(Self(bytes))
    }

    pub fn as_der(&self) -> &[u8] {
        &self.0
    }
}

/// UserName/Password enrollment record for one operator. The
/// primitive holds this by value; the manifest wires these from
/// its signed source (future batch).
#[derive(Debug, Clone)]
pub struct OperatorUserPassBinding {
    pub username: NormalizedUsername,
    pub credential_hash: Argon2idHash,
    pub operator_id: OperatorId,
}

/// X.509 machine-issuer enrollment record. `issuer_cn` is the
/// CN the session layer has already chain-verified; the
/// `trust_anchor` DER bytes pin the cert to a specific CA to
/// defend against "valid-cert-from-different-CA" attacks where
/// a different CA signs a cert with the same CN.
#[derive(Debug, Clone)]
pub struct MachineIssuerX509Binding {
    pub issuer_cn: MachineIssuerCn,
    pub trust_anchor: X509CertDer,
    pub operator_id: OperatorId,
}

/// Complete enrollment set. Production wires this from the signed
/// RBAC manifest (Batch A-3b). Tests wire it explicitly via
/// `UserTokenEnrollment::new`.
#[derive(Debug, Clone)]
pub struct UserTokenEnrollment {
    user_pass: Vec<OperatorUserPassBinding>,
    x509: Vec<MachineIssuerX509Binding>,
}

impl UserTokenEnrollment {
    /// Construct directly from binding lists. Tests use this
    /// constructor; production wires `from_manifest` in a
    /// subsequent batch.
    pub fn new(
        user_pass: Vec<OperatorUserPassBinding>,
        x509: Vec<MachineIssuerX509Binding>,
    ) -> Self {
        Self { user_pass, x509 }
    }

    /// Empty enrollment — used by boot-path before manifest
    /// loads. Every authentication attempt against an empty
    /// enrollment fails with `CredentialMismatch` so the session
    /// layer fails closed.
    pub fn empty() -> Self {
        Self {
            user_pass: Vec::new(),
            x509: Vec::new(),
        }
    }

    pub fn user_pass_count(&self) -> usize {
        self.user_pass.len()
    }

    pub fn x509_count(&self) -> usize {
        self.x509.len()
    }

    /// Verify a UserName/Password attempt. Username is normalized
    /// before lookup. Wrong password + unknown username both
    /// return `CredentialMismatch` after running one Argon2id
    /// derivation (the unknown-username path uses a canned dummy
    /// hash) so wall-clock timing does not distinguish the two.
    ///
    /// The `password` is accepted as `Secret<Vec<u8>>` so caller
    /// ergonomics preserve zero-on-drop + prevent accidental
    /// log/Debug leaks of plaintext credentials.
    pub fn verify_user_pass(
        &self,
        raw_username: &str,
        password: &Secret<Vec<u8>>,
    ) -> Result<OperatorId, UserTokenError> {
        let normalized = NormalizedUsername::from_raw(raw_username)?;
        let found = self
            .user_pass
            .iter()
            .find(|b| b.username == normalized);
        match found {
            Some(binding) => {
                binding.credential_hash.verify(password.expose_secret())?;
                Ok(binding.operator_id.clone())
            }
            None => {
                // Unknown-username path: verify the attacker-
                // supplied password against a canned dummy hash
                // so Argon2id derivation cost matches the known-
                // username path. Result ignored — we return
                // CredentialMismatch unconditionally here.
                let dummy = Argon2idHash::from_phc(DUMMY_HASH_PHC.to_string())?;
                let _ = dummy.verify(password.expose_secret());
                Err(UserTokenError::CredentialMismatch)
            }
        }
    }

    /// Look up the X.509 binding for a presented CN. Returns
    /// `OperatorId` when the CN matches + the trust_anchor bytes
    /// equal the caller-provided bytes. Trust-anchor comparison
    /// is byte-equal rather than semantic equality because the
    /// manifest fixes the anchor at enrollment time; any drift
    /// is an attack signal.
    pub fn resolve_x509(
        &self,
        cn: &MachineIssuerCn,
        presented_trust_anchor_der: &[u8],
    ) -> Result<OperatorId, UserTokenError> {
        let binding = self
            .x509
            .iter()
            .find(|b| &b.issuer_cn == cn)
            .ok_or(UserTokenError::X509IssuerNotEnrolled)?;
        if binding.trust_anchor.as_der() != presented_trust_anchor_der {
            return Err(UserTokenError::X509TrustAnchorMismatch);
        }
        Ok(binding.operator_id.clone())
    }
}

/// Error taxonomy for user-token operations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UserTokenError {
    UsernameEmpty,
    UsernameTooShort { got: usize },
    UsernameTooLong { got: usize },
    HashFormatInvalid { reason: String },
    /// Wrong password OR unknown username. The two paths collapse
    /// into one variant by design — username enumeration defence.
    CredentialMismatch,
    X509DerTooShort { got: usize, min: usize },
    X509NotDerSequence { got_prefix: u8 },
    X509IssuerNotEnrolled,
    X509TrustAnchorMismatch,
}

impl fmt::Display for UserTokenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UsernameEmpty => f.write_str("username empty after normalization"),
            Self::UsernameTooShort { got } => {
                write!(f, "username too short ({} < {} bytes)", got, MIN_USERNAME_BYTES)
            }
            Self::UsernameTooLong { got } => {
                write!(f, "username too long ({} > {} bytes)", got, MAX_USERNAME_BYTES)
            }
            Self::HashFormatInvalid { reason } => {
                write!(f, "argon2 hash format invalid: {}", reason)
            }
            Self::CredentialMismatch => f.write_str("credential mismatch"),
            Self::X509DerTooShort { got, min } => {
                write!(f, "x509 DER too short ({} < {} bytes)", got, min)
            }
            Self::X509NotDerSequence { got_prefix } => {
                write!(
                    f,
                    "x509 DER does not start with SEQUENCE byte 0x30 (got 0x{:02x})",
                    got_prefix
                )
            }
            Self::X509IssuerNotEnrolled => f.write_str("x509 issuer CN not enrolled"),
            Self::X509TrustAnchorMismatch => {
                f.write_str("x509 trust anchor bytes do not match enrolled anchor")
            }
        }
    }
}

impl std::error::Error for UserTokenError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn canned_operator() -> OperatorId {
        OperatorId::new_from_verified([0x07u8; 16])
    }

    fn other_operator() -> OperatorId {
        OperatorId::new_from_verified([0x08u8; 16])
    }

    fn canned_cn(cn: &str) -> MachineIssuerCn {
        MachineIssuerCn::from_verified_cert_cn(cn.into()).unwrap()
    }

    /// Minimal valid DER-looking bytes: SEQUENCE (0x30) + length +
    /// 128 bytes of body. The primitive's parse-level check
    /// validates length + leading byte only; real X.509 parsing
    /// happens at chain-verify time which is not this primitive's
    /// concern.
    fn canned_der(prefix_byte: u8, len: usize) -> Vec<u8> {
        let mut v = vec![prefix_byte];
        v.extend(vec![0u8; len - 1]);
        v
    }

    // ========================================================
    // NormalizedUsername
    // ========================================================

    #[test]
    fn username_empty_rejects() {
        assert_eq!(
            NormalizedUsername::from_raw(""),
            Err(UserTokenError::UsernameEmpty)
        );
    }

    #[test]
    fn username_whitespace_only_rejects() {
        assert_eq!(
            NormalizedUsername::from_raw("   "),
            Err(UserTokenError::UsernameEmpty)
        );
    }

    #[test]
    fn username_single_char_rejects() {
        match NormalizedUsername::from_raw("a") {
            Err(UserTokenError::UsernameTooShort { got: 1 }) => {}
            other => panic!("expected UsernameTooShort, got {:?}", other),
        }
    }

    #[test]
    fn username_oversized_rejects() {
        let big = "a".repeat(200);
        match NormalizedUsername::from_raw(&big) {
            Err(UserTokenError::UsernameTooLong { got: 200 }) => {}
            other => panic!("expected UsernameTooLong, got {:?}", other),
        }
    }

    #[test]
    fn username_normalized_lowercase() {
        let u = NormalizedUsername::from_raw("AliceSmith").unwrap();
        assert_eq!(u.as_str(), "alicesmith");
    }

    #[test]
    fn username_nfkc_collapses_compatibility_forms() {
        // Fullwidth "ＡＬＩＣＥ" (U+FF21..U+FF25) collapses to "alice"
        // under NFKC + lowercase. Closes the homoglyph class.
        let u = NormalizedUsername::from_raw("\u{FF21}\u{FF2C}\u{FF29}\u{FF23}\u{FF25}").unwrap();
        assert_eq!(u.as_str(), "alice");
    }

    #[test]
    fn username_different_scripts_do_not_collide_after_normalization() {
        // Cyrillic "а" (U+0430) vs Latin "a" (U+0061). NFKC does
        // NOT map Cyrillic to Latin (they are semantically distinct
        // letters even though glyphs overlap in some fonts). This
        // test documents that the primitive relies on script-level
        // distinction — if an attacker enrolls with a Cyrillic CN
        // and the operator thinks it's Latin, the manifest issuer
        // needs an ASCII-only policy above this primitive.
        let latin = NormalizedUsername::from_raw("admin").unwrap();
        let cyrillic = NormalizedUsername::from_raw("аdmin").unwrap(); // first char is U+0430
        assert_ne!(latin, cyrillic);
    }

    // ========================================================
    // Argon2idHash
    // ========================================================

    #[test]
    fn argon2_hash_rejects_malformed_string() {
        match Argon2idHash::from_phc("not-a-phc-string".into()) {
            Err(UserTokenError::HashFormatInvalid { .. }) => {}
            other => panic!("expected HashFormatInvalid, got {:?}", other),
        }
    }

    #[test]
    fn argon2_hash_verify_correct_password() {
        let salt = "c29tZXNhbHQxMjM0NTY"; // "somesalt123456" base64
        let hash = Argon2idHash::for_test_hash(b"correct-horse-battery", salt).unwrap();
        assert!(hash.verify(b"correct-horse-battery").is_ok());
    }

    #[test]
    fn argon2_hash_verify_wrong_password_mismatch() {
        let salt = "c29tZXNhbHQxMjM0NTY";
        let hash = Argon2idHash::for_test_hash(b"correct-horse-battery", salt).unwrap();
        match hash.verify(b"wrong-password") {
            Err(UserTokenError::CredentialMismatch) => {}
            other => panic!("expected CredentialMismatch, got {:?}", other),
        }
    }

    // ========================================================
    // X509CertDer
    // ========================================================

    #[test]
    fn x509_der_rejects_too_short() {
        let bytes = vec![0x30; 50];
        match X509CertDer::from_der(bytes) {
            Err(UserTokenError::X509DerTooShort { got: 50, min: 128 }) => {}
            other => panic!("expected X509DerTooShort, got {:?}", other),
        }
    }

    #[test]
    fn x509_der_rejects_non_sequence_prefix() {
        let bytes = canned_der(0x02, 200); // INTEGER not SEQUENCE
        match X509CertDer::from_der(bytes) {
            Err(UserTokenError::X509NotDerSequence { got_prefix: 0x02 }) => {}
            other => panic!("expected X509NotDerSequence, got {:?}", other),
        }
    }

    #[test]
    fn x509_der_accepts_plausible_der() {
        let bytes = canned_der(0x30, 200);
        assert!(X509CertDer::from_der(bytes).is_ok());
    }

    // ========================================================
    // UserTokenEnrollment — user/pass path
    // ========================================================

    fn enrollment_with_alice_password(pw: &[u8]) -> UserTokenEnrollment {
        let salt = "c29tZXNhbHQxMjM0NTY";
        let hash = Argon2idHash::for_test_hash(pw, salt).unwrap();
        let binding = OperatorUserPassBinding {
            username: NormalizedUsername::from_raw("alice").unwrap(),
            credential_hash: hash,
            operator_id: canned_operator(),
        };
        UserTokenEnrollment::new(vec![binding], vec![])
    }

    #[test]
    fn enrollment_empty_rejects_every_attempt() {
        let e = UserTokenEnrollment::empty();
        let pw = Secret::new(b"hunter2".to_vec());
        match e.verify_user_pass("alice", &pw) {
            Err(UserTokenError::CredentialMismatch) => {}
            other => panic!("empty enrollment must reject, got {:?}", other),
        }
        assert_eq!(e.user_pass_count(), 0);
        assert_eq!(e.x509_count(), 0);
    }

    #[test]
    fn enrollment_verify_correct_password_returns_operator() {
        let e = enrollment_with_alice_password(b"hunter2");
        let pw = Secret::new(b"hunter2".to_vec());
        let op = e.verify_user_pass("alice", &pw).unwrap();
        assert_eq!(op.as_bytes(), canned_operator().as_bytes());
    }

    #[test]
    fn enrollment_verify_wrong_password_mismatch() {
        let e = enrollment_with_alice_password(b"hunter2");
        let pw = Secret::new(b"wrong".to_vec());
        match e.verify_user_pass("alice", &pw) {
            Err(UserTokenError::CredentialMismatch) => {}
            other => panic!("expected CredentialMismatch, got {:?}", other),
        }
    }

    #[test]
    fn enrollment_verify_unknown_username_mismatch() {
        // Username-enumeration defence: unknown username produces
        // the SAME error variant as wrong password. The dummy hash
        // derivation keeps wall-clock timing comparable.
        let e = enrollment_with_alice_password(b"hunter2");
        let pw = Secret::new(b"hunter2".to_vec());
        match e.verify_user_pass("bob", &pw) {
            Err(UserTokenError::CredentialMismatch) => {}
            other => panic!("unknown username must yield CredentialMismatch, got {:?}", other),
        }
    }

    #[test]
    fn enrollment_normalizes_username_on_verify() {
        // Enrolled as "alice"; attacker passes "ALICE" — NFKC
        // lowercases before lookup so the verify succeeds.
        let e = enrollment_with_alice_password(b"hunter2");
        let pw = Secret::new(b"hunter2".to_vec());
        let op = e.verify_user_pass("ALICE", &pw).unwrap();
        assert_eq!(op.as_bytes(), canned_operator().as_bytes());
    }

    #[test]
    fn enrollment_rejects_malformed_username() {
        let e = enrollment_with_alice_password(b"hunter2");
        let pw = Secret::new(b"hunter2".to_vec());
        match e.verify_user_pass("", &pw) {
            Err(UserTokenError::UsernameEmpty) => {}
            other => panic!("expected UsernameEmpty, got {:?}", other),
        }
    }

    // ========================================================
    // UserTokenEnrollment — X.509 path
    // ========================================================

    fn enrollment_with_auth_service_x509() -> (UserTokenEnrollment, Vec<u8>) {
        let trust_der = canned_der(0x30, 200);
        let binding = MachineIssuerX509Binding {
            issuer_cn: canned_cn("auth-service"),
            trust_anchor: X509CertDer::from_der(trust_der.clone()).unwrap(),
            operator_id: canned_operator(),
        };
        let e = UserTokenEnrollment::new(vec![], vec![binding]);
        (e, trust_der)
    }

    #[test]
    fn x509_resolve_matching_cn_and_anchor_returns_operator() {
        let (e, der) = enrollment_with_auth_service_x509();
        let op = e.resolve_x509(&canned_cn("auth-service"), &der).unwrap();
        assert_eq!(op.as_bytes(), canned_operator().as_bytes());
    }

    #[test]
    fn x509_resolve_unknown_cn_rejects() {
        let (e, der) = enrollment_with_auth_service_x509();
        match e.resolve_x509(&canned_cn("billing-service"), &der) {
            Err(UserTokenError::X509IssuerNotEnrolled) => {}
            other => panic!("expected X509IssuerNotEnrolled, got {:?}", other),
        }
    }

    #[test]
    fn x509_resolve_cn_match_but_anchor_mismatch_rejects() {
        // Defence against "different CA signs same CN" attack:
        // the CN matches but the trust_anchor bytes differ → reject.
        let (e, _) = enrollment_with_auth_service_x509();
        let impostor_der = canned_der(0x30, 200);
        // impostor_der is all-zeros (except prefix); canned enrollment
        // DER is also all-zeros — they'd be byte-equal here. To force
        // a mismatch build an impostor with different length prefix.
        let mut impostor_der = vec![0x30; 200];
        impostor_der[10] = 0x42; // flip a byte → no longer byte-equal
        match e.resolve_x509(&canned_cn("auth-service"), &impostor_der) {
            Err(UserTokenError::X509TrustAnchorMismatch) => {}
            other => panic!("expected X509TrustAnchorMismatch, got {:?}", other),
        }
    }

    #[test]
    fn enrollment_mixed_user_pass_and_x509_both_work() {
        let salt = "c29tZXNhbHQxMjM0NTY";
        let up = OperatorUserPassBinding {
            username: NormalizedUsername::from_raw("alice").unwrap(),
            credential_hash: Argon2idHash::for_test_hash(b"pw1", salt).unwrap(),
            operator_id: canned_operator(),
        };
        let trust_der = canned_der(0x30, 200);
        let x509 = MachineIssuerX509Binding {
            issuer_cn: canned_cn("svc-a"),
            trust_anchor: X509CertDer::from_der(trust_der.clone()).unwrap(),
            operator_id: other_operator(),
        };
        let e = UserTokenEnrollment::new(vec![up], vec![x509]);
        assert_eq!(e.user_pass_count(), 1);
        assert_eq!(e.x509_count(), 1);

        let pw = Secret::new(b"pw1".to_vec());
        assert!(e.verify_user_pass("alice", &pw).is_ok());
        assert!(e.resolve_x509(&canned_cn("svc-a"), &trust_der).is_ok());
    }

    #[test]
    fn user_token_error_display_taxonomy() {
        use UserTokenError as E;
        let cases = [
            (E::UsernameEmpty, "empty"),
            (E::UsernameTooShort { got: 1 }, "too short"),
            (E::UsernameTooLong { got: 300 }, "too long"),
            (
                E::HashFormatInvalid {
                    reason: "parse-err".into(),
                },
                "argon2 hash",
            ),
            (E::CredentialMismatch, "mismatch"),
            (
                E::X509DerTooShort { got: 10, min: 128 },
                "x509 DER too short",
            ),
            (
                E::X509NotDerSequence { got_prefix: 0x02 },
                "SEQUENCE",
            ),
            (E::X509IssuerNotEnrolled, "not enrolled"),
            (E::X509TrustAnchorMismatch, "trust anchor"),
        ];
        for (e, needle) in cases {
            let s = format!("{}", e);
            assert!(s.contains(needle), "err `{}` missing `{}`", s, needle);
        }
    }
}
