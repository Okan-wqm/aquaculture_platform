//! `build_suderra_https_client_config` — unified rustls `ClientConfig`
//! factory for HTTPS reqwest clients (provisioning, firmware download,
//! scripting webhooks, telemetry posts).
//!
//! ## WHY
//!
//! Pre-Phase-1.1.3 every `reqwest::Client::builder()` call site in the
//! agent inherited the **process-global default** rustls CryptoProvider
//! installed by `mqtt.rs:install_default()` (Phase 0.2 boot wire). That
//! default provider is `rustls::crypto::ring::default_provider()` —
//! UNRESTRICTED — every TLS 1.2 ECDHE suite supported by ring is
//! advertised in the ClientHello. Phase 0.2 narrowed the *MQTT*
//! transport to the 3-suite TLS 1.3 allowlist by passing the
//! Suderra-narrowed provider through `ClientConfig::builder_with_provider(...)`,
//! but every HTTPS callsite (most importantly
//! `provisioning.rs::activate` — the **single-use device-bootstrap token
//! exchange** flagged by edge-expert as the highest-attack-surface site)
//! was left on the unrestricted default. ORPHAN-HIGH-035 documented the
//! gap; this module closes it.
//!
//! ## What this module wires
//!
//! - [`build_suderra_https_client_config`] — returns a fresh
//!   `Arc<rustls::ClientConfig>` whose `crypto_provider` is the Suderra
//!   3-suite TLS 1.3 allowlist and whose `with_protocol_versions` is
//!   pinned to `&[&rustls::version::TLS13]`. Trust anchors come from
//!   `rustls_native_certs::load_native_certs()` so cloud HTTPS endpoints
//!   (Let's Encrypt + DigiCert + AWS Trust Services etc.) chain-trust
//!   normally. No client auth (HTTPS to cloud APIs uses bearer tokens,
//!   not mutual TLS).
//!
//! - The factory is **stateless** — each callsite builds its own
//!   `ClientConfig`. ClientConfig implements `Clone` (Arc-internally),
//!   so callers that re-use across multiple `reqwest::Client::builder()`
//!   calls can clone the result; but the more common pattern is one
//!   reqwest client per subsystem, in which case constructing a fresh
//!   config per init function is fine. Native cert loading is ~10ms on
//!   typical Linux (reads `/etc/ssl/certs/ca-certificates.crt`), well
//!   within boot budget.
//!
//! ## What this module does NOT wire (Phase 1.1.3b — future)
//!
//! Suderra leaf-cert pinning (via `MtlsDelegatingVerifier` + the
//! `Arc<MtlsVerifierState>` shared with the MQTT transport) is NOT
//! installed here. Pinning per-endpoint requires per-endpoint cert
//! knowledge (the cloud API's cert SHA-256 is distinct from the MQTT
//! broker's cert). Phase 1.1.3b will introduce
//! [`build_suderra_pinned_https_client_config`] (placeholder name) for
//! Suderra-cloud-API endpoints once the cloud-side cert-rotation
//! manifest infrastructure lands.
//!
//! Until then, HTTPS endpoints that hit non-Suderra hosts (GitHub
//! firmware releases, operator-defined webhooks) MUST use this module's
//! cipher-allowlist-only path — pinning to a specific cert would break
//! the moment the upstream rotates.
//!
//! ## Closure of ORPHAN-HIGH-035 (cipher-allowlist portion only)
//!
//! Pre-Phase-1.1.3 the install_default() global at `mqtt.rs:1010`
//! advertised TLS 1.2 ECDHE suites on the provisioning bootstrap-token
//! exchange — a successful cipher-suite downgrade on that endpoint
//! compromises a device's identity bootstrap. This module's
//! `use_preconfigured_tls(...)` wire eliminates that attack surface.
//! ORPHAN-HIGH-035 is partially closed (cipher dimension); the pinning
//! dimension follows in Phase 1.1.3b under a separate finding.

use std::sync::Arc;

use rustls::ClientConfig;
use rustls::RootCertStore;

use super::crypto_provider::build_suderra_crypto_provider;

/// Build a fresh rustls `ClientConfig` suitable for cloud HTTPS reqwest
/// clients. The config:
///
/// - Uses the Suderra-narrowed CryptoProvider (3-suite TLS 1.3
///   allowlist; non-allowlisted suites cannot appear in the ClientHello).
/// - Pins protocol version to TLS 1.3 only (no TLS 1.2 fallback).
/// - Uses the system native CA store for trust anchors (Let's Encrypt,
///   DigiCert, etc. — required for non-Suderra endpoints like GitHub
///   firmware releases).
/// - No mutual TLS — cloud HTTPS uses bearer tokens, not client certs.
///
/// Returns `Err` if the system native CA store is empty AND no fallback
/// is wired — operator must install the `ca-certificates` package on
/// Linux. This is fail-fast at boot rather than at first HTTPS call.
///
/// # Cost
///
/// Each call loads native CAs from disk. ~10ms on typical Linux. Callers
/// that build many reqwest clients in a tight loop should clone the
/// returned `Arc<ClientConfig>` rather than re-call.
pub fn build_suderra_https_client_config() -> Result<Arc<ClientConfig>, String> {
    use rustls_native_certs::load_native_certs;

    let provider = build_suderra_crypto_provider();
    let mut root_store = RootCertStore::empty();
    let native_certs = load_native_certs();
    for err in &native_certs.errors {
        tracing::warn!(
            target: "mtls.https_client",
            error = ?err,
            "Native CA load error (non-fatal if some certs still load)"
        );
    }
    for cert in native_certs.certs {
        if let Err(e) = root_store.add(cert) {
            tracing::warn!(
                target: "mtls.https_client",
                error = ?e,
                "Failed to add native CA cert to root store; continuing"
            );
        }
    }
    if root_store.is_empty() {
        return Err(
            "build_suderra_https_client_config: native CA store is empty. \
             Install the `ca-certificates` package (Linux) or equivalent — \
             cloud HTTPS cannot validate certs without trust anchors."
                .to_string(),
        );
    }

    let cfg = ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| format!("ClientConfig::builder_with_provider rejected TLS 1.3 pin: {e:?}"))?
        .with_root_certificates(root_store)
        .with_no_client_auth();
    Ok(Arc::new(cfg))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The factory must produce a non-empty trust anchor set on a host
    /// that has `ca-certificates` installed. This test runs on the CI
    /// host and the dev container, both of which install the package by
    /// default.
    #[test]
    fn builds_with_native_root_store() {
        let cfg = build_suderra_https_client_config()
            .expect("native CA store should be available in CI / dev");
        // Sanity: the cfg's negotiated alpn is empty (we don't pin alpn
        // here — HTTPS callsites pin via reqwest's higher-level API),
        // and the crypto_provider is the Suderra-narrowed one.
        assert!(!cfg.crypto_provider().cipher_suites.is_empty());
        assert_eq!(
            cfg.crypto_provider().cipher_suites.len(),
            crate::mtls::CIPHER_SUITE_ALLOWLIST.len(),
            "ClientConfig should inherit the 3-suite TLS 1.3 allowlist from suderra_provider"
        );
    }

    /// Independent calls produce independent `Arc<ClientConfig>` — the
    /// `OnceLock`-cached pattern was rejected because callsites that need
    /// to bind a different ALPN or per-host header set should not share
    /// mutable state.
    #[test]
    fn each_call_returns_distinct_arc() {
        let a = build_suderra_https_client_config().expect("ok");
        let b = build_suderra_https_client_config().expect("ok");
        assert!(!Arc::ptr_eq(&a, &b));
    }
}
