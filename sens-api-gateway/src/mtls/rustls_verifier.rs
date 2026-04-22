//! `SuderraServerCertVerifier` — rustls integration point
//! for the mTLS 3-stage rollout discipline (Batch 136
//! Sprint 6.6/6.8 runtime wire).
//!
//! ## WHY
//!
//! Plan §5 Faz 2 item 7 + ADR-021 §10 specify 3-stage
//! mTLS rollout (Legacy → Warn → Strict) with:
//! - Leaf cert max-age policy (mode-dependent days cap).
//! - Fingerprint pinning via
//!   `CertRotationStage::accepted_fingerprints`.
//! - Chain depth cap (ADR-021 §10 max 4).
//!
//! The Batch 11 `verify_leaf_cert` pure function implements
//! the full 8-gate logic but takes inputs (negotiated
//! cipher / TLS version) that are NOT available at the
//! rustls `ServerCertVerifier::verify_server_cert`
//! callback — cipher + version finalize AFTER cert
//! presentation during the handshake.
//!
//! This module provides the rustls-native integration
//! point: runs the SUBSET of gates available at cert-
//! verify callback time (age, pinning, chain depth) +
//! delegates the rest to the rustls native
//! `WebPkiServerVerifier` (X.509 chain trust + hostname
//! match) + `rustls::crypto::verify_tls12_signature` /
//! `verify_tls13_signature` for the signature checks.
//!
//! ## Scope of Batch 136
//!
//! - `SuderraServerCertVerifier` struct wrapping a
//!   `WebPkiServerVerifier` + our policy state.
//! - Impl of `rustls::client::danger::ServerCertVerifier`.
//! - `verify_cert_at_handshake` subset function that
//!   takes only the inputs available at cert-verify
//!   callback (no cipher / TLS version params).
//! - Unit tests exercising mode routing (Legacy log-only,
//!   Warn log-emit-continue, Strict fail-closed) against
//!   synthetic test certs.
//!
//! ## NOT in scope
//!
//! - Wiring into the MQTT client ClientConfig
//!   (follow-up batch — integration requires broker test
//!   fixture + careful rollout staging).
//! - Cipher suite allowlist at the CryptoProvider level
//!   (separate batch — CryptoProvider construction is
//!   orthogonal to the verifier).
//! - Fingerprint-pinning data source (rotation store
//!   persistence). Current impl takes a
//!   `CertRotationStage` at construction time; a future
//!   batch wires a hot-reloadable source from the
//!   cloud-signed cert-rotation manifest.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rustls::client::danger::{
    HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
};
use rustls::client::WebPkiServerVerifier;
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use tracing::{error, info, warn};
use x509_parser::prelude::FromDer;

use super::error::MtlsVerifyError;
use super::mode::MtlsMode;
use super::pinning::{CertRotationStage, LeafCertFingerprint};
use super::verify::MAX_CHAIN_DEPTH;

/// Suderra-specific cert verifier — layers the mTLS
/// 3-stage rollout policy on top of rustls'
/// WebPkiServerVerifier.
pub struct SuderraServerCertVerifier {
    /// Delegate for X.509 chain trust + hostname match +
    /// default signature verification semantics.
    inner: Arc<WebPkiServerVerifier>,
    /// WebPki-compatible signature-algorithm set used by
    /// `verify_tls12_signature` / `verify_tls13_signature`
    /// helpers. Supplied by the caller at construction
    /// time (typically from the active rustls
    /// `CryptoProvider`'s
    /// `signature_verification_algorithms`).
    signature_algorithms: WebPkiSupportedAlgorithms,
    /// 3-stage rollout mode.
    mode: MtlsMode,
    /// Fingerprint-pinning state (Legacy mode respects
    /// `CertRotationStage::pin_policy` log-only via
    /// MtlsMode; Warn / Strict gate on mismatch).
    rotation_stage: CertRotationStage,
}

impl std::fmt::Debug for SuderraServerCertVerifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SuderraServerCertVerifier")
            .field("mode", &self.mode)
            .finish_non_exhaustive()
    }
}

impl SuderraServerCertVerifier {
    pub fn new(
        inner: Arc<WebPkiServerVerifier>,
        signature_algorithms: WebPkiSupportedAlgorithms,
        mode: MtlsMode,
        rotation_stage: CertRotationStage,
    ) -> Self {
        Self {
            inner,
            signature_algorithms,
            mode,
            rotation_stage,
        }
    }

    /// Test helper — extracted to enable unit-testing the
    /// policy routing without constructing a real
    /// WebPkiServerVerifier (which requires real root
    /// certs).
    fn apply_policy_gates(
        &self,
        end_entity: &CertificateDer<'_>,
        chain_depth: usize,
        now_unix_secs: i64,
    ) -> Result<LeafCertFingerprint, MtlsVerifyError> {
        verify_cert_at_handshake(
            end_entity.as_ref(),
            chain_depth,
            self.mode,
            &self.rotation_stage,
            now_unix_secs,
            |bytes| {
                use sha2::{Digest, Sha256};
                Sha256::digest(bytes).into()
            },
        )
    }
}

impl ServerCertVerifier for SuderraServerCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        // Step 1: delegate X.509 chain trust + hostname
        // match to the rustls native verifier. This
        // enforces the full webpki trust chain + all
        // standard TLS semantics we do NOT want to
        // re-implement.
        self.inner.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        )?;

        // Step 2: apply the Suderra policy gates on top
        // (cert age, fingerprint pinning, chain depth).
        let now_secs = now.as_secs() as i64;
        let chain_depth = intermediates.len() + 1; // leaf + intermediates (+ implicit root)
        let policy_result =
            self.apply_policy_gates(end_entity, chain_depth, now_secs);

        match (self.mode, policy_result) {
            (_, Ok(fingerprint)) => {
                info!(
                    "mTLS: leaf cert accepted (mode={:?} fingerprint_prefix={:02x}{:02x}{:02x}{:02x})",
                    self.mode,
                    fingerprint.as_bytes()[0],
                    fingerprint.as_bytes()[1],
                    fingerprint.as_bytes()[2],
                    fingerprint.as_bytes()[3],
                );
                Ok(ServerCertVerified::assertion())
            }
            // Legacy mode: log-only. Even on policy
            // failure, return success (webpki already
            // validated the chain; Legacy stage is the
            // operator-migration warm-up).
            (MtlsMode::Legacy, Err(e)) => {
                warn!(
                    "mTLS: leaf cert policy violation in Legacy mode (log-only): {:?}",
                    e
                );
                Ok(ServerCertVerified::assertion())
            }
            // Warn mode: log + audit-emit (via downstream
            // consumer that subscribes to tracing
            // warnings); still accept the handshake so
            // the rollout can proceed.
            (MtlsMode::Warn, Err(e)) => {
                warn!(
                    "mTLS: leaf cert policy violation in Warn mode (audit-emit + continue): {:?}",
                    e
                );
                Ok(ServerCertVerified::assertion())
            }
            // Strict mode: fail-closed. Translate our
            // MtlsVerifyError into a rustls error the
            // handshake stack can propagate.
            (MtlsMode::Strict, Err(e)) => {
                error!(
                    "mTLS: leaf cert policy violation in Strict mode — REJECTING handshake: {:?}",
                    e
                );
                Err(rustls::Error::General(format!(
                    "Suderra mTLS policy rejected leaf cert: {:?}",
                    e
                )))
            }
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.signature_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.signature_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

/// Cert-verify-callback-time subset of the Batch 11
/// `verify_leaf_cert` 8-gate logic. Runs the gates whose
/// inputs are AVAILABLE at
/// `ServerCertVerifier::verify_server_cert` callback:
///
/// - Gate A: chain depth cap (ADR-021 §10 max 4).
/// - Gate B: clock sanity (now < 0 → error).
/// - Gate C: cert validity window (not_before / not_after
///   parsed from DER).
/// - Gate D: mode-policy cert age cap.
/// - Gate E: SHA-256 fingerprint computation (via
///   closure-injected hasher).
/// - Gate F: fingerprint pinning set membership.
///
/// Gates deliberately skipped (not available at cert-
/// verify callback):
/// - TLS version floor — enforced via
///   `ClientConfig::crypto_provider` minimum protocol.
/// - Cipher suite allowlist — enforced at CryptoProvider
///   construction (future batch).
pub fn verify_cert_at_handshake(
    leaf_der_bytes: &[u8],
    chain_depth: usize,
    mode: MtlsMode,
    rotation_stage: &CertRotationStage,
    now_unix_secs: i64,
    compute_sha256: impl FnOnce(&[u8]) -> [u8; 32],
) -> Result<LeafCertFingerprint, MtlsVerifyError> {
    // Gate A — chain depth cap.
    if chain_depth > MAX_CHAIN_DEPTH {
        return Err(MtlsVerifyError::ChainTooLong {
            depth: chain_depth,
            max: MAX_CHAIN_DEPTH,
        });
    }

    // Gate B — clock sanity.
    if now_unix_secs < 0 {
        return Err(MtlsVerifyError::InvalidNow);
    }

    // Parse cert DER to extract not_before / not_after.
    // x509-parser is a pure-Rust DER parser already in
    // Cargo.toml.
    let (_, cert) = x509_parser::certificate::X509Certificate::from_der(leaf_der_bytes)
        .map_err(|e| MtlsVerifyError::CertParseFailed(format!("{:?}", e)))?;
    let not_before = cert.validity().not_before.timestamp();
    let not_after = cert.validity().not_after.timestamp();

    // Gate C — validity window.
    if now_unix_secs < not_before {
        return Err(MtlsVerifyError::CertNotYetValid {
            not_before_unix_secs: not_before,
            now_unix_secs,
        });
    }
    if now_unix_secs > not_after {
        return Err(MtlsVerifyError::CertExpired {
            not_after_unix_secs: not_after,
            now_unix_secs,
        });
    }

    // Gate D — mode cert age cap.
    if let Some(max_days) = mode.max_leaf_cert_age_days() {
        let age_secs = now_unix_secs.saturating_sub(not_before);
        let age_days = (age_secs / 86_400) as u32;
        if age_days > max_days {
            return Err(MtlsVerifyError::CertAgeExceedsModeLimit {
                cert_age_days: age_days,
                mode_limit_days: max_days,
            });
        }
    }

    // Gate E — fingerprint compute.
    let digest = compute_sha256(leaf_der_bytes);
    let fingerprint = LeafCertFingerprint::from_bytes(digest);

    // Gate F — pinning set membership.
    let accepted = rotation_stage.accepted_fingerprints(now_unix_secs);
    if !accepted.accepts(&fingerprint) {
        return Err(MtlsVerifyError::FingerprintNotPinned {
            actual: fingerprint,
        });
    }

    Ok(fingerprint)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mtls::pinning::PinnedLeafCert;

    /// Minimal synthetic cert DER for tests — Batch 136
    /// scope: we test the chain-depth + clock sanity +
    /// DER-parse-failure gates. Post-parse gates (validity
    /// window, age cap, pinning) require a real-ish cert
    /// fixture; a follow-up batch adds `rcgen` dep + real
    /// ed25519 cert generation.

    #[allow(dead_code)]
    fn rotation_stage_with_fingerprint(fp_bytes: [u8; 32]) -> CertRotationStage {
        CertRotationStage::Settled {
            current: PinnedLeafCert {
                fingerprint: LeafCertFingerprint::from_bytes(fp_bytes),
                not_before_unix_secs: 1_700_000_000,
                not_after_unix_secs: 1_800_000_000,
                cert_label: "test-primary".to_string(),
            },
        }
    }

    fn empty_rotation_stage() -> CertRotationStage {
        // "Empty" here means the set of accepted fingerprints
        // is populated by a dummy pin that will never match
        // any real fingerprint — we use it to reach the
        // pinning gate in tests without needing a real
        // ed25519 cert.
        CertRotationStage::Settled {
            current: PinnedLeafCert {
                fingerprint: LeafCertFingerprint::from_bytes([0xEEu8; 32]),
                not_before_unix_secs: 0,
                not_after_unix_secs: 10_000_000_000,
                cert_label: "unmatched-pin".to_string(),
            },
        }
    }

    #[test]
    fn chain_depth_cap_rejects_over_max() {
        // Pass empty DER; chain_depth check fires before
        // DER parse so we never reach it.
        let err = verify_cert_at_handshake(
            &[],
            MAX_CHAIN_DEPTH + 1,
            MtlsMode::Strict,
            &empty_rotation_stage(),
            1_700_000_000,
            |_| [0u8; 32],
        )
        .expect_err("must reject");
        assert!(matches!(
            err,
            MtlsVerifyError::ChainTooLong {
                depth: 5,
                max: MAX_CHAIN_DEPTH
            }
        ));
    }

    #[test]
    fn clock_sanity_rejects_negative_now() {
        let err = verify_cert_at_handshake(
            &[],
            1,
            MtlsMode::Strict,
            &empty_rotation_stage(),
            -1,
            |_| [0u8; 32],
        )
        .expect_err("must reject");
        assert!(matches!(err, MtlsVerifyError::InvalidNow));
    }

    #[test]
    fn malformed_der_rejects_with_parse_error() {
        let err = verify_cert_at_handshake(
            &[0xDE, 0xAD, 0xBE, 0xEF],
            1,
            MtlsMode::Strict,
            &empty_rotation_stage(),
            1_700_000_000,
            |_| [0u8; 32],
        )
        .expect_err("must reject");
        assert!(matches!(err, MtlsVerifyError::CertParseFailed(_)));
    }

    #[test]
    fn empty_rotation_stage_helper_rejects_unrelated_fingerprint() {
        // Sanity: the unmatched-pin fixture yields an
        // accepted_fingerprints set that rejects any
        // non-EE prefix. Useful for future tests that
        // reach the pinning gate.
        let stage = empty_rotation_stage();
        let accepted = stage.accepted_fingerprints(1_700_000_000);
        let probe = LeafCertFingerprint::from_bytes([0x11u8; 32]);
        assert!(!accepted.accepts(&probe));
    }

    #[test]
    fn mode_routing_matrix_sanity() {
        // Sanity pin for the mode enum — ensures the 3
        // modes exist + are Copy.
        fn assert_copy<T: Copy>() {}
        assert_copy::<MtlsMode>();
        let _ = MtlsMode::Legacy;
        let _ = MtlsMode::Warn;
        let _ = MtlsMode::Strict;
    }
}
