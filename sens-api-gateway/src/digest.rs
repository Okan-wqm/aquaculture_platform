//! SHA-256 digest newtype shared by every profile.
//!
//! It began as the firmware manifest's file digest (Batch 8, ADR-019) and
//! is also the config-integrity digest and the certificate-pinning
//! fingerprint's inner value. It lives outside `updater` because the agent's
//! own updater is not compiled when the OS manages updates (ADR-048 DEC-2,
//! feature `os-managed-updates`), while config integrity and pinning are.

use serde::{Deserialize, Serialize};

/// SHA-256 digest — 32 bytes wrapped in a newtype for type-level
/// discipline (same pattern as `CmdHash` in Batch 7). `#[serde(transparent)]`
/// preserves JSON array shape.
///
/// **Domain separation (EDGE-LOW-003 documentation closure):** this type is
/// DELIBERATELY distinct from the other 32-byte wrappers in the codebase:
/// [`crate::audit::PrevHmac`] / [`crate::audit::CurrentHmac`] (audit-log
/// HMAC chain outputs) and [`crate::command_envelope::CmdHash`] (SHA-256
/// of command-envelope canonical params). Collapsing them into a shared
/// `Digest32` would collapse the tier-1 make-it-impossible guarantee that
/// a consumer cannot accidentally pass an audit HMAC where a content
/// digest is expected, or vice versa. Each wrapper carries its domain in
/// the TYPE, not just the value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Sha256Digest([u8; 32]);

impl Sha256Digest {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use super::*;

    #[test]
    fn sha256_digest_serde_transparent() {
        let d = Sha256Digest::from_bytes([0xabu8; 32]);
        let json = serde_json::to_string(&d).expect("ok");
        assert!(json.starts_with("[171,171,171"));
        let back: Sha256Digest = serde_json::from_str(&json).expect("ok");
        assert_eq!(back, d);
    }
}
