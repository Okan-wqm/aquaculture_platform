//! `build_suderra_crypto_provider` — handshake-time cipher allowlist gate.
//!
//! ## WHY
//!
//! The Suderra mTLS plan §5 Faz 2 item 7 + ADR-021 §10 specify an explicit
//! TLS 1.3 cipher allowlist (see [`super::cipher::CIPHER_SUITE_ALLOWLIST`]):
//! `TLS_CHACHA20_POLY1305_SHA256`, `TLS_AES_256_GCM_SHA384`,
//! `TLS_AES_128_GCM_SHA256`. The plan `MtlsVerifyError::CipherSuiteNotInAllowlist`
//! gate that lives in [`super::verify::verify_leaf_cert`] is **dead code in
//! the actual handshake** because rustls finalizes cipher selection AFTER the
//! `ServerCertVerifier::verify_server_cert` callback runs — the verifier never
//! receives the negotiated cipher and so cannot reject on it.
//!
//! The architecturally correct gate sits at the [`rustls::crypto::CryptoProvider`]
//! level: rustls negotiates the cipher suite from the provider's
//! `cipher_suites` slice, so narrowing that slice to the allowlist makes the
//! handshake **structurally** unable to negotiate anything outside it.
//! Tier-1 MAKE-IT-IMPOSSIBLE: a non-allowlisted suite cannot even appear in
//! the ServerHello.
//!
//! ## What this module wires
//!
//! - [`build_suderra_crypto_provider`] — clones `rustls::crypto::ring::default_provider`,
//!   filters its `cipher_suites` to the IANA codepoints in
//!   [`super::cipher::CIPHER_SUITE_ALLOWLIST`], and returns an `Arc<CryptoProvider>`
//!   ready to be passed to `ClientConfig::builder_with_provider(...)`.
//!
//! - [`build_suderra_crypto_provider_or_default`] — non-failing variant for
//!   compatibility with code paths that need to fall back to the default
//!   provider (e.g., a no-op build under HC-1 backward compat). NOT used by
//!   the MQTT transport, which must enforce the allowlist unconditionally.
//!
//! ## Closure of orphan finding ORPHAN-MTLS-003
//!
//! Pre-Phase-0 the cipher gate at `verify_leaf_cert` Gate 4 was an honest-but-
//! unreachable check. This module relocates the gate to the layer where it
//! actually fires.

use std::sync::Arc;

use rustls::CipherSuite as RustlsCipherSuite;
use rustls::crypto::CryptoProvider;

use super::cipher::CIPHER_SUITE_ALLOWLIST;

/// Build a [`CryptoProvider`] whose `cipher_suites` is exactly the suites in
/// [`CIPHER_SUITE_ALLOWLIST`]. Other provider fields (KX groups, signature
/// algorithms, secure_random, key_provider) are inherited from
/// `rustls::crypto::ring::default_provider`.
///
/// # Panics
///
/// Panics only if the underlying ring provider exposes none of the allowlisted
/// suites — which would indicate a rustls / ring API regression rather than
/// configuration error. The constructor is fail-fast on purpose: a provider
/// with zero cipher suites cannot complete a handshake, so misconfiguration is
/// surfaced at boot rather than at first connect.
pub fn build_suderra_crypto_provider() -> Arc<CryptoProvider> {
    let mut provider = rustls::crypto::ring::default_provider();
    let allowed: [u16; CIPHER_SUITE_ALLOWLIST.len()] = {
        let mut out = [0u16; CIPHER_SUITE_ALLOWLIST.len()];
        for (slot, suite) in out.iter_mut().zip(CIPHER_SUITE_ALLOWLIST.iter()) {
            *slot = suite.iana_codepoint();
        }
        out
    };
    provider.cipher_suites.retain(|sc| {
        let suite: RustlsCipherSuite = sc.suite();
        let codepoint: u16 = suite.into();
        allowed.contains(&codepoint)
    });
    assert!(
        !provider.cipher_suites.is_empty(),
        "Suderra cipher allowlist intersect ring default_provider was empty — \
         rustls / ring API regression suspected. Allowlist codepoints: {:#06x?}",
        allowed
    );
    Arc::new(provider)
}

/// Convenience wrapper that returns `Some(provider)` when the build succeeds
/// in a fail-soft context. Currently identical to
/// [`build_suderra_crypto_provider`] because the constructor is itself
/// fail-fast on the empty-allowlist edge case; a future revision may relax
/// this for a "log-only" rollout stage.
#[must_use]
pub fn build_suderra_crypto_provider_or_default() -> Arc<CryptoProvider> {
    build_suderra_crypto_provider()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mtls::cipher::CipherSuite as SuderraCipherSuite;

    /// The provider must contain exactly the three TLS 1.3 suites the plan
    /// allows — no fewer (would block legitimate handshakes), no more
    /// (would leak non-allowlist suites into negotiation).
    #[test]
    fn provider_cipher_suites_match_allowlist_exactly() {
        let provider = build_suderra_crypto_provider();
        assert_eq!(
            provider.cipher_suites.len(),
            CIPHER_SUITE_ALLOWLIST.len(),
            "provider cipher_suites len must equal CIPHER_SUITE_ALLOWLIST len"
        );
        let provider_codepoints: Vec<u16> = provider
            .cipher_suites
            .iter()
            .map(|sc| {
                let s: RustlsCipherSuite = sc.suite();
                s.into()
            })
            .collect();
        for allowed in CIPHER_SUITE_ALLOWLIST {
            assert!(
                provider_codepoints.contains(&allowed.iana_codepoint()),
                "provider missing allowlisted suite {:?} (codepoint {:#06x})",
                allowed,
                allowed.iana_codepoint()
            );
        }
    }

    /// TLS 1.2 suites must be absent — Suderra SL-2 baseline rejects TLS 1.2
    /// to prevent cipher-suite downgrade attacks (plaintext-injection on
    /// AES-CBC-SHA1 etc).
    #[test]
    fn provider_excludes_tls12_only_suites() {
        let provider = build_suderra_crypto_provider();
        let provider_codepoints: Vec<u16> = provider
            .cipher_suites
            .iter()
            .map(|sc| {
                let s: RustlsCipherSuite = sc.suite();
                s.into()
            })
            .collect();
        // TLS 1.2 ECDHE suites use codepoints 0xC02B / 0xC02C / 0xC02F / 0xC030 etc.
        // Any 0xCxxx codepoint indicates a non-TLS-1.3 suite.
        for cp in &provider_codepoints {
            assert!(
                (*cp & 0xFF00) == 0x1300,
                "non-TLS-1.3 suite leaked into provider: codepoint {:#06x}",
                cp
            );
        }
    }

    /// Sanity check that the SuderraCipherSuite enum's IANA codepoints actually
    /// resolve to ring-provided suites — guards against an upstream rustls /
    /// ring change that drops a suite we depend on.
    #[test]
    fn all_three_allowlist_suites_resolve_in_ring() {
        let provider = build_suderra_crypto_provider();
        let codepoints: std::collections::HashSet<u16> = provider
            .cipher_suites
            .iter()
            .map(|sc| {
                let s: RustlsCipherSuite = sc.suite();
                s.into()
            })
            .collect();
        assert!(codepoints.contains(&SuderraCipherSuite::Chacha20Poly1305Sha256.iana_codepoint()));
        assert!(codepoints.contains(&SuderraCipherSuite::Aes256GcmSha384.iana_codepoint()));
        assert!(codepoints.contains(&SuderraCipherSuite::Aes128GcmSha256.iana_codepoint()));
    }

    /// Repeated calls return independently-owned providers — important for
    /// hot-reload paths (Phase 1.1.1 MtlsVerifierState rebuild) that must not
    /// share mutable state through aliasing.
    #[test]
    fn each_call_returns_distinct_arc() {
        let a = build_suderra_crypto_provider();
        let b = build_suderra_crypto_provider();
        // Different Arc inner pointers means they are independent allocations.
        assert!(!Arc::ptr_eq(&a, &b));
    }
}
