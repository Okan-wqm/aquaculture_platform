// BATCH-001-CI-FIX-015: pre-staged types for Sprint 6.1-6.8 runtime wiring.
// Re-exports are intentionally unused until the runtime consumers land.
#![allow(unused_imports)]

//! # mTLS 3-stage rollout + leaf cert pinning (plan §5 Faz 2 item 7 + D-6)
//!
//! Edge-to-broker MQTT + edge-to-cloud HTTPS both require mutual TLS. Plan
//! §5 Faz 2 item 7 specifies a 3-stage rollout discipline so the fleet
//! migration from v1.6.0 (no pinning) to v2.0.0 (strict pinning) is
//! operator-coordinated rather than big-bang:
//!
//! | Mode | Leaf cert max-age | Pinning | Rollout window |
//! |------|-------------------|---------|----------------|
//! | `Legacy`  | 60 days  | Disabled — fingerprint reject logged but allowed | First 30 days of rollout |
//! | `Warn`    | 90 days  | Enforced — logs violation but accepts | Days 30–60 |
//! | `Strict`  | unbounded  | Enforced — rejects on mismatch | Day 60+ |
//!
//! Cloud-manifest-driven staged rollout ±30-day jitter prevents fleet-
//! wide outage if the pinning data ships with a bug.
//!
//! ## Module contents
//!
//! - [`mode`] — `MtlsMode` 3-variant state machine + `max_leaf_cert_age`
//!   policy table.
//! - [`pinning`] — `LeafCertFingerprint([u8; 32])` sealed newtype +
//!   `PinnedLeafCert` bundle + `CertRotationStage` 2-phase rotation
//!   state machine.
//! - [`cipher`] — explicit `CipherSuite` allowlist (TLS 1.3 only per
//!   SL-2 adversarial baseline; TLS 1.2 REJECTED to prevent downgrade).
//! - [`verify`] — `verify_leaf_cert` 6-gate pure function with closure-
//!   injected SHA-256-over-DER.
//! - [`error`] — `MtlsVerifyError` structured taxonomy.
//!
//! ## Scope of Batch 11
//!
//! Types + one pure function. No actual rustls / openssl integration, no
//! system CA resolution, no socket-level TLS handshake. Sprint 6.8 wires
//! the real TLS stack using `tokio-rustls` + the injected closures.
//!
//! ## Cross-references
//!
//! - Plan §5 Faz 2 item 7 (3-stage + staged rollout)
//! - Plan R-D-6 (cert rotation discipline)
//! - ADR-021 §10 TLS leaf cert signing ceremony
//! - Batch 5a `Ed25519SignatureBytes` (reused for cert chain signature)
//! - Batch 8 `Sha256Digest` (reused for cert DER fingerprint)

pub mod cipher;
// Phase 0.2: handshake-time CryptoProvider that narrows rustls' default
// cipher_suites to the Suderra TLS 1.3 allowlist. Closes orphan finding
// ORPHAN-HIGH-031 — the verify_leaf_cert cipher gate is dead code at the
// verifier-callback layer; the architecturally correct gate sits at
// CryptoProvider construction so non-allowlist suites cannot even appear
// in the ClientHello.
pub mod crypto_provider;
pub mod error;
pub mod mode;
pub mod pinning;
// Batch 136 Sprint 6.6/6.8: rustls ServerCertVerifier impl
// that plumbs the mTLS 3-stage mode logic into the real
// TLS handshake. Runs cert-age + fingerprint pinning at
// the verify callback; delegates X.509 chain trust +
// hostname match to the rustls WebPkiServerVerifier.
pub mod rustls_verifier;
pub mod verify;

pub use cipher::{CIPHER_SUITE_ALLOWLIST, CipherSuite};
pub use crypto_provider::{
    build_suderra_crypto_provider, build_suderra_crypto_provider_or_default,
};
pub use error::MtlsVerifyError;
pub use mode::{
    MAX_LEAF_CERT_AGE_DAYS_LEGACY, MAX_LEAF_CERT_AGE_DAYS_STRICT, MAX_LEAF_CERT_AGE_DAYS_WARN,
    MtlsMode,
};
pub use pinning::{CertRotationStage, LeafCertFingerprint, PinnedLeafCert, PinnedLeafCertSet};
pub use rustls_verifier::{
    SuderraServerCertVerifier, SuderraVerifierBuildError, build_rotation_stage_from_pins_hex,
    build_suderra_verifier, verify_cert_at_handshake,
};
pub use verify::verify_leaf_cert;
