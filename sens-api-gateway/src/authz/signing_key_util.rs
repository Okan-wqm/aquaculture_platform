//! Shared ed25519 pubkey hex parsing (Batch #249a refactor).
//!
//! Three places need to parse a 64-char hex ed25519 VerifyingKey at
//! the wire-ingress boundary:
//!
//! - [`super::manifest_runtime::RbacManifestStore`] — RBAC manifest
//!   signing key (ADR-021 slot 2).
//! - [`super::user_token_manifest_runtime::UserTokenManifestStore`] —
//!   user-token manifest signing key (ADR-021 slot 4, Plan B R-4
//!   3-key segregation).
//! - `config_integrity::verify_runtime::parse_factory_pubkey` —
//!   factory signing key (separate module tree + slightly different
//!   error taxonomy; historical reasons).
//!
//! Batch #249a lifts the first two into a single helper so the
//! 64-char-length check + hex→bytes conversion + VerifyingKey ctor
//! exists in ONE place. Config-integrity's variant stays separate
//! because its caller consumes a different error shape; converting
//! that would be a separate refactor and is NOT load-bearing for
//! the Gap A-3 closure.
//!
//! ## Non-duplicated error mapping
//!
//! Each caller owns its own error enum (RbacManifestStore returns
//! `String`, UserTokenManifestStore returns a typed
//! `HotReloadError`). This helper returns a flat `SigningKeyHexError`
//! taxonomy; callers map via `.map_err` into their local shape. The
//! narrow coupling keeps this helper decision-free — it neither
//! prepends "manifest_signing_pubkey_hex" to error messages (that's
//! caller context) nor knows WHICH manifest family needs the key.

use ed25519_dalek::VerifyingKey;

/// Structured error for [`parse_ed25519_pubkey_hex`]. Callers map
/// into their own error enum.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SigningKeyHexError {
    /// Hex string is not 64 characters (raw ed25519 pubkey is 32
    /// bytes → 64 hex chars).
    WrongLength { got: usize },

    /// Character at byte index N is not a valid hex digit.
    InvalidHexAt { byte_index: usize, reason: String },

    /// Bytes parsed cleanly but `ed25519_dalek::VerifyingKey::
    /// from_bytes` rejected them (not a valid curve point).
    InvalidCurvePoint { reason: String },
}

impl std::fmt::Display for SigningKeyHexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WrongLength { got } => {
                write!(f, "ed25519 pubkey hex must be 64 chars, got {}", got)
            }
            Self::InvalidHexAt { byte_index, reason } => write!(
                f,
                "invalid hex at byte {}: {}",
                byte_index, reason
            ),
            Self::InvalidCurvePoint { reason } => {
                write!(f, "ed25519 key construction failed: {}", reason)
            }
        }
    }
}

impl std::error::Error for SigningKeyHexError {}

/// Parse a 64-char hex string into an ed25519 [`VerifyingKey`].
/// Used at the wire-ingress boundary for every signed-manifest
/// verifier (RBAC + user-token + future signed-config streams).
pub fn parse_ed25519_pubkey_hex(
    hex: &str,
) -> Result<VerifyingKey, SigningKeyHexError> {
    if hex.len() != 64 {
        return Err(SigningKeyHexError::WrongLength { got: hex.len() });
    }
    let mut bytes = [0u8; 32];
    for (i, b) in bytes.iter_mut().enumerate() {
        let byte_idx = i * 2;
        let hex_byte = hex.get(byte_idx..byte_idx + 2).ok_or_else(|| {
            SigningKeyHexError::InvalidHexAt {
                byte_index: byte_idx,
                reason: "hex slice out of bounds".to_string(),
            }
        })?;
        *b = u8::from_str_radix(hex_byte, 16).map_err(|e| {
            SigningKeyHexError::InvalidHexAt {
                byte_index: i,
                reason: e.to_string(),
            }
        })?;
    }
    VerifyingKey::from_bytes(&bytes).map_err(|e| {
        SigningKeyHexError::InvalidCurvePoint {
            reason: e.to_string(),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_64char_hex() {
        // The all-zeros pubkey is NOT accepted by VerifyingKey::from_bytes
        // — it's not a valid curve point (it's the identity). Pick a
        // real test pubkey instead by signing-key derivation below.
        // Here we just assert SOME 64-char hex parses; concrete
        // cryptographic validity is caller responsibility.
        use ed25519_dalek::{SigningKey, SECRET_KEY_LENGTH};
        let sk = SigningKey::from_bytes(&[7u8; SECRET_KEY_LENGTH]);
        let pk_bytes = sk.verifying_key().to_bytes();
        let hex: String = pk_bytes
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        assert_eq!(hex.len(), 64);
        let parsed = parse_ed25519_pubkey_hex(&hex).unwrap();
        assert_eq!(parsed.to_bytes(), pk_bytes);
    }

    #[test]
    fn rejects_wrong_length() {
        let err = parse_ed25519_pubkey_hex("abcd").unwrap_err();
        match err {
            SigningKeyHexError::WrongLength { got } => assert_eq!(got, 4),
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn rejects_non_hex_character() {
        // 64 chars but one is 'g' (not hex).
        let mut s: String = "0".repeat(63);
        s.push('g');
        let err = parse_ed25519_pubkey_hex(&s).unwrap_err();
        match err {
            SigningKeyHexError::InvalidHexAt { byte_index, .. } => {
                assert_eq!(byte_index, 31); // last byte is index 31
            }
            other => panic!("wrong variant: {:?}", other),
        }
    }

    #[test]
    fn display_strings_are_stable() {
        assert_eq!(
            SigningKeyHexError::WrongLength { got: 0 }.to_string(),
            "ed25519 pubkey hex must be 64 chars, got 0"
        );
    }

    #[test]
    fn valid_curve_point_round_trips_through_parser() {
        // Round-trip test: mint a VerifyingKey via a SigningKey,
        // hex-encode + parse, and ensure we got back the same pubkey.
        // Avoids the ed25519_dalek version-sensitive "invalid curve
        // point" taxonomy check (earlier library versions rejected
        // the all-zeros identity; newer versions accept it and
        // reject at verify-time instead — we do not gate on which
        // library version is linked).
        use ed25519_dalek::{SigningKey, SECRET_KEY_LENGTH};
        let sk = SigningKey::from_bytes(&[13u8; SECRET_KEY_LENGTH]);
        let hex: String = sk
            .verifying_key()
            .to_bytes()
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect();
        let parsed = parse_ed25519_pubkey_hex(&hex).unwrap();
        assert_eq!(parsed.to_bytes(), sk.verifying_key().to_bytes());
    }
}
