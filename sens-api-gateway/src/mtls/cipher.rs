//! # CipherSuite — explicit TLS 1.3-only allowlist (plan SL-2 baseline)
//!
//! The plan mandates "cipher suite explicit" — no silent defaults. Under
//! SL-2 adversarial baseline, TLS 1.2 is REJECTED to prevent cipher-suite
//! downgrade attacks (plaintext-injection vulnerabilities on older ciphers
//! like AES-CBC-SHA1).
//!
//! Allowed cipher suites (TLS 1.3 IANA allocations):
//! - `TLS_CHACHA20_POLY1305_SHA256` — preferred on ARM (no AES hardware
//!   dependency, fastest on RPi4 without AES-NI).
//! - `TLS_AES_256_GCM_SHA384` — preferred on x86_64 with AES-NI.
//! - `TLS_AES_128_GCM_SHA256` — fallback for constrained clients.
//!
//! Why TLS 1.3 CCM-mode suites are intentionally absent (ORPHAN-LOW-038):
//! - `TLS_AES_128_CCM_SHA256` (0x1304) and `TLS_AES_128_CCM_8_SHA256`
//!   (0x1305) are RFC 8446 §B.4 OPTIONAL suites. `ring`'s
//!   `default_provider()` does NOT ship CCM-mode AEADs, so adding them
//!   to the allowlist would not enable them — only confuse readers.
//! - The Suderra fleet runs on RPi4/x86_64 hardware that has either
//!   AES-NI (x86_64) or fast ChaCha20 (RPi4) — the no-AES-NI fast path
//!   is already covered by ChaCha20-Poly1305. CCM is an
//!   IoT-AES-only-hardware optimization the fleet does not need.
//!
//! Sprint 6.8 wires rustls `CipherSuite` constants to these enum variants
//! and rejects any handshake that negotiates outside the allowlist.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CipherSuite {
    /// TLS_CHACHA20_POLY1305_SHA256 (IANA 0x1303).
    Chacha20Poly1305Sha256,
    /// TLS_AES_256_GCM_SHA384 (IANA 0x1302).
    Aes256GcmSha384,
    /// TLS_AES_128_GCM_SHA256 (IANA 0x1301).
    Aes128GcmSha256,
}

impl CipherSuite {
    pub const fn wire_tag(self) -> u8 {
        match self {
            Self::Chacha20Poly1305Sha256 => 0,
            Self::Aes256GcmSha384 => 1,
            Self::Aes128GcmSha256 => 2,
        }
    }

    /// IANA codepoint for wire-compat with TLS libraries.
    pub const fn iana_codepoint(self) -> u16 {
        match self {
            Self::Chacha20Poly1305Sha256 => 0x1303,
            Self::Aes256GcmSha384 => 0x1302,
            Self::Aes128GcmSha256 => 0x1301,
        }
    }
}

/// The complete allowlist. Sprint 6.8 wires rustls `CipherSuite::ALL`
/// intersection with this list — any suite NOT here is explicitly denied.
pub const CIPHER_SUITE_ALLOWLIST: &[CipherSuite] = &[
    CipherSuite::Chacha20Poly1305Sha256,
    CipherSuite::Aes256GcmSha384,
    CipherSuite::Aes128GcmSha256,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_tag_stable_and_contiguous() {
        assert_eq!(CipherSuite::Chacha20Poly1305Sha256.wire_tag(), 0);
        assert_eq!(CipherSuite::Aes256GcmSha384.wire_tag(), 1);
        assert_eq!(CipherSuite::Aes128GcmSha256.wire_tag(), 2);
    }

    #[test]
    fn iana_codepoints_match_rfc8446() {
        // Per RFC 8446 Appendix B.4.
        assert_eq!(CipherSuite::Chacha20Poly1305Sha256.iana_codepoint(), 0x1303);
        assert_eq!(CipherSuite::Aes256GcmSha384.iana_codepoint(), 0x1302);
        assert_eq!(CipherSuite::Aes128GcmSha256.iana_codepoint(), 0x1301);
    }

    #[test]
    fn allowlist_contains_all_three_suites() {
        assert_eq!(CIPHER_SUITE_ALLOWLIST.len(), 3);
        assert!(CIPHER_SUITE_ALLOWLIST.contains(&CipherSuite::Chacha20Poly1305Sha256));
        assert!(CIPHER_SUITE_ALLOWLIST.contains(&CipherSuite::Aes256GcmSha384));
        assert!(CIPHER_SUITE_ALLOWLIST.contains(&CipherSuite::Aes128GcmSha256));
    }

    #[test]
    fn serde_snake_case() {
        assert_eq!(
            serde_json::to_string(&CipherSuite::Chacha20Poly1305Sha256).expect("ok"),
            r#""chacha20_poly1305_sha256""#
        );
    }

    #[test]
    fn iana_codepoints_pairwise_distinct() {
        let cps = [
            CipherSuite::Chacha20Poly1305Sha256.iana_codepoint(),
            CipherSuite::Aes256GcmSha384.iana_codepoint(),
            CipherSuite::Aes128GcmSha256.iana_codepoint(),
        ];
        for (i, a) in cps.iter().enumerate() {
            for b in &cps[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }
}
