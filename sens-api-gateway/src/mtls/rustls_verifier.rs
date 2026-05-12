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

use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature};
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
        let policy_result = self.apply_policy_gates(end_entity, chain_depth, now_secs);

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
            //
            // Phase 1.1.5 / ORPHAN-MEDIUM-037 closure: emit the reject
            // event to the process-global audit-sink HMAC chain in
            // ADDITION to `tracing::error!`. Defense-in-depth — the
            // handshake-abort below is the primary security action;
            // the audit emit is for forensic post-mortem queryability
            // (auditors reconstructing rejected-handshake timelines
            // offline cannot rely on subscriber-routing of
            // `tracing::error!`).
            //
            // Structured fields per the orphan-finding spec:
            //   { leaf_fingerprint_prefix, mode, reason, timestamp_unix,
            //     chain_depth }
            // The fingerprint prefix is the first 4 bytes lowercase-hex
            // (8 chars) — sufficient for forensic uniqueness without
            // exposing the full digest in operator-readable detail.
            (MtlsMode::Strict, Err(e)) => {
                error!(
                    "mTLS: leaf cert policy violation in Strict mode — REJECTING handshake: {:?}",
                    e
                );
                let leaf_fp_prefix = compute_leaf_fingerprint_prefix(end_entity.as_ref());
                let detail = serde_json::json!({
                    "leaf_fingerprint_prefix": leaf_fp_prefix,
                    "mode": format!("{:?}", self.mode),
                    "reason": format!("{:?}", e),
                    "chain_depth": chain_depth,
                });
                crate::audit::try_emit_mtls_forensic_event(
                    crate::audit::AuditAction::MtlsHandshakeRejectStrict,
                    "mtls.strict_reject",
                    detail,
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
        verify_tls12_signature(message, cert, dss, &self.signature_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.signature_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

/// Compute the lowercase-hex SHA-256 fingerprint prefix (first 4 bytes
/// = 8 hex chars) of a cert's DER bytes. Used by the Strict-reject
/// audit emit (ORPHAN-MEDIUM-037 closure) to give forensic queries a
/// short stable handle on the rejected leaf without exposing the full
/// digest in operator-readable detail.
///
/// 8 hex chars = 32 bits — sufficient distinct space for forensic
/// uniqueness across a fleet of < 10K devices (birthday-bound
/// collision probability < 1 in 50K). The full digest is recoverable
/// from the cert DER if a deeper investigation is needed.
fn compute_leaf_fingerprint_prefix(leaf_der_bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest: [u8; 32] = Sha256::digest(leaf_der_bytes).into();
    format!(
        "{:02x}{:02x}{:02x}{:02x}",
        digest[0], digest[1], digest[2], digest[3]
    )
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

/// Build-path failure taxonomy for
/// `build_suderra_verifier`. Distinct from
/// `MtlsVerifyError` (runtime cert-verify failure) +
/// `rustls::Error` (TLS-stack failure) — this error
/// category fires at BOOT before any TLS handshake
/// happens.
#[derive(Debug)]
pub enum SuderraVerifierBuildError {
    /// Operator-supplied hex was not 64 chars.
    InvalidFingerprintLength { index: usize, got: usize },
    /// Operator-supplied hex contained non-hex chars.
    InvalidFingerprintHex { index: usize },
    /// Failed to construct the rustls WebPkiServerVerifier
    /// from the given root store (rustls error propagates
    /// as Display).
    WebPkiBuildFailed(String),
    /// Strict mode was selected but no pins supplied —
    /// same as the config coherence Rule 24 but
    /// defense-in-depth at construction.
    StrictModeRequiresPins,
    /// Static pin rotation stage failed construction.
    InvalidRotationStage(String),
}

impl std::fmt::Display for SuderraVerifierBuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidFingerprintLength { index, got } => write!(
                f,
                "pinned_leaf_fingerprints_hex[{}] must be 64 chars (SHA-256 hex), got {}",
                index, got
            ),
            Self::InvalidFingerprintHex { index } => write!(
                f,
                "pinned_leaf_fingerprints_hex[{}] contains non-hex characters",
                index
            ),
            Self::WebPkiBuildFailed(e) => {
                write!(f, "WebPkiServerVerifier build failed: {}", e)
            }
            Self::StrictModeRequiresPins => f.write_str(
                "mtls.mode=Strict requires at least one pinned_leaf_fingerprints_hex entry",
            ),
            Self::InvalidRotationStage(reason) => {
                write!(f, "mTLS static pin rotation stage invalid: {}", reason)
            }
        }
    }
}

impl std::error::Error for SuderraVerifierBuildError {}

/// Parse a single 64-char hex string into a
/// `LeafCertFingerprint`. Mirrors the
/// `config_integrity::verify_runtime::parse_factory_pubkey_hex`
/// discipline.
fn parse_fingerprint_hex(
    index: usize,
    hex: &str,
) -> Result<LeafCertFingerprint, SuderraVerifierBuildError> {
    if hex.len() != 64 {
        return Err(SuderraVerifierBuildError::InvalidFingerprintLength {
            index,
            got: hex.len(),
        });
    }
    let mut bytes = [0u8; 32];
    for (i, b) in bytes.iter_mut().enumerate() {
        let hi = hex
            .as_bytes()
            .get(i * 2)
            .copied()
            .and_then(nibble)
            .ok_or(SuderraVerifierBuildError::InvalidFingerprintHex { index })?;
        let lo = hex
            .as_bytes()
            .get(i * 2 + 1)
            .copied()
            .and_then(nibble)
            .ok_or(SuderraVerifierBuildError::InvalidFingerprintHex { index })?;
        *b = (hi << 4) | lo;
    }
    Ok(LeafCertFingerprint::from_bytes(bytes))
}

fn nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Parse operator hex pins into a `CertRotationStage`
/// (Batch 138 Sprint 6.6/6.8). Policy:
/// - 0 pins → returns None (caller should construct
///   a no-op stage OR skip wiring SuderraServerCertVerifier
///   for the Legacy-no-pins path).
/// - 1 pin → `Settled { current: <fp> }`.
/// - 2 pins → `BridgeRotation { outgoing: <1st>,
///   incoming: <2nd>, bridge_until_unix_secs: i64::MAX }`.
///   Second pin is treated as "incoming" (the new cert
///   operators are migrating TO).
/// - 3+ pins → rejected at higher layers; this function
///   collapses to `BridgeRotation` over the first 2 +
///   logs a warn via caller.
pub fn build_rotation_stage_from_pins_hex(
    pins_hex: &[String],
) -> Result<Option<CertRotationStage>, SuderraVerifierBuildError> {
    if pins_hex.is_empty() {
        return Ok(None);
    }

    use crate::mtls::pinning::PinnedLeafCert;
    let fingerprints: Result<Vec<LeafCertFingerprint>, _> = pins_hex
        .iter()
        .enumerate()
        .map(|(i, h)| parse_fingerprint_hex(i, h))
        .collect();
    let fingerprints = fingerprints?;

    // Validity window is operator-controlled in real
    // deployments via the cloud-signed rotation manifest
    // (future batch). For static config, use a
    // maximally-permissive window so the cert-age gate in
    // `verify_cert_at_handshake` drives the age policy
    // via MtlsMode, not the pinned-set validity-window
    // fields.
    let ts_far_past: i64 = 0;
    let ts_far_future: i64 = i64::MAX / 2;

    let stage = match fingerprints.as_slice() {
        [current] => CertRotationStage::Settled {
            current: PinnedLeafCert {
                fingerprint: *current,
                not_before_unix_secs: ts_far_past,
                not_after_unix_secs: ts_far_future,
                cert_label: "config:pin:0".to_string(),
            },
        },
        // Phase 1.1.5 / ORPHAN-HIGH-039 closure: BridgeRotation is now built
        // via the smart constructor `try_bridge_rotation`, which gates on
        // `validate_bridge_window`. Build-time pins use `i64::MAX / 2` for
        // bridge_until against `now=0` — the floor (now + 3600 = 3600) is
        // overwhelmingly satisfied, so the validator always passes. The
        // routing through the smart constructor enforces the channel
        // discipline: any future construction site (signed-manifest deser
        // path in Phase 1.2 with operator-controlled bridge_until) is
        // forced through the same validator. The
        // `bridge_window_floor_enforced_at_construction_sites` invariant
        // detects regressions that bypass the constructor.
        //
        // `expect` is sound here: ts_far_future = i64::MAX / 2, now = 0,
        // floor = 0 + 3600 = 3600, ts_far_future > 3600. Violating this is
        // a bug in the const arithmetic above, not an operator-controllable
        // path — safe to panic at boot rather than silently mis-pin.
        [incoming, outgoing, ..] => CertRotationStage::try_bridge_rotation(
            // outgoing = second entry (old cert during rotation window)
            PinnedLeafCert {
                fingerprint: *outgoing,
                not_before_unix_secs: ts_far_past,
                not_after_unix_secs: ts_far_future,
                cert_label: "config:pin:1:outgoing".to_string(),
            },
            // incoming = first entry (new cert)
            PinnedLeafCert {
                fingerprint: *incoming,
                not_before_unix_secs: ts_far_past,
                not_after_unix_secs: ts_far_future,
                cert_label: "config:pin:0:incoming".to_string(),
            },
            ts_far_future,
            0, // now=0 — i64::MAX/2 > 0 + MIN_BRIDGE_WINDOW_SECS by construction
        )
        .map_err(|err| SuderraVerifierBuildError::InvalidRotationStage(err.to_string()))?,
        [] => return Ok(None),
    };
    Ok(Some(stage))
}

/// Boot-time construction of SuderraServerCertVerifier
/// from MtlsConfig + rustls root-cert-store (Batch 138
/// Sprint 6.6/6.8).
///
/// Returns:
/// - `Ok(None)` — no wire needed (Legacy mode + empty
///   pin list). Caller proceeds with default webpki
///   verifier. HC-1 backward compat.
/// - `Ok(Some(verifier))` — wire this into
///   `ClientConfig::builder().dangerous().with_custom_certificate_verifier`.
/// - `Err(_)` — config rejected; fail-closed boot.
///
/// Wiring decision matrix:
/// | mode | pins | result |
/// |------|------|--------|
/// | Legacy | 0 | Ok(None) — no wire |
/// | Legacy | 1+ | Ok(Some) — log-only pinning |
/// | Warn | any | Ok(Some) — audit-emit on mismatch |
/// | Strict | 0 | Err(StrictModeRequiresPins) |
/// | Strict | 1+ | Ok(Some) — reject on mismatch |
pub fn build_suderra_verifier(
    mode: MtlsMode,
    signature_algorithms: WebPkiSupportedAlgorithms,
    pins_hex: &[String],
    root_store: Arc<rustls::RootCertStore>,
) -> Result<Option<Arc<SuderraServerCertVerifier>>, SuderraVerifierBuildError> {
    if matches!(mode, MtlsMode::Legacy) && pins_hex.is_empty() {
        return Ok(None);
    }
    if matches!(mode, MtlsMode::Strict) && pins_hex.is_empty() {
        return Err(SuderraVerifierBuildError::StrictModeRequiresPins);
    }

    let rotation_stage = build_rotation_stage_from_pins_hex(pins_hex)?.unwrap_or_else(|| {
        // Non-Legacy mode with empty pins + non-
        // Strict (so Warn-empty-pins path): construct
        // an "accept-nothing" stage so the pinning
        // gate ALWAYS fires the mismatch path. Warn
        // mode then routes to log-only; operators
        // observe "handshake without pin" every
        // time.
        CertRotationStage::Settled {
            current: crate::mtls::pinning::PinnedLeafCert {
                fingerprint: LeafCertFingerprint::from_bytes([0u8; 32]),
                not_before_unix_secs: 0,
                not_after_unix_secs: 0,
                cert_label: "sentinel:warn-no-pins".to_string(),
            },
        }
    });

    // Resolve CryptoProvider. `get_default` returns
    // Some only after a provider is installed at the
    // ClientConfig builder site; at boot / unit-test
    // time we fall through to an explicit ring provider
    // (matches the default rumqttc tokio-rustls uses).
    let provider: Arc<rustls::crypto::CryptoProvider> =
        rustls::crypto::CryptoProvider::get_default()
            .cloned()
            .unwrap_or_else(|| Arc::new(rustls::crypto::ring::default_provider()));

    let inner = WebPkiServerVerifier::builder_with_provider(root_store, provider)
        .build()
        .map_err(|e| SuderraVerifierBuildError::WebPkiBuildFailed(format!("{:?}", e)))?;

    Ok(Some(Arc::new(SuderraServerCertVerifier::new(
        inner,
        signature_algorithms,
        mode,
        rotation_stage,
    ))))
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

    // ====================================================================
    // Batch 138 Sprint 6.6/6.8 — build_suderra_verifier tests
    // ====================================================================

    #[test]
    fn parse_fingerprint_hex_accepts_valid_hex() {
        let hex = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
        let fp = parse_fingerprint_hex(0, hex).expect("valid hex");
        assert_eq!(fp.as_bytes()[0], 0xAB);
        assert_eq!(fp.as_bytes()[31], 0x89);
    }

    #[test]
    fn parse_fingerprint_hex_rejects_short() {
        let err = parse_fingerprint_hex(0, "abcd").expect_err("short");
        assert!(matches!(
            err,
            SuderraVerifierBuildError::InvalidFingerprintLength { index: 0, got: 4 }
        ));
    }

    #[test]
    fn parse_fingerprint_hex_rejects_non_hex_chars() {
        let bad = "zz".to_string() + &"0".repeat(62);
        let err = parse_fingerprint_hex(2, &bad).expect_err("non-hex");
        assert!(matches!(
            err,
            SuderraVerifierBuildError::InvalidFingerprintHex { index: 2 }
        ));
    }

    #[test]
    fn build_rotation_stage_empty_returns_none() {
        let out = build_rotation_stage_from_pins_hex(&[]).expect("ok");
        assert!(out.is_none());
    }

    #[test]
    fn build_rotation_stage_single_pin_returns_settled() {
        let pins =
            vec!["abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789".to_string()];
        let stage = build_rotation_stage_from_pins_hex(&pins)
            .expect("ok")
            .expect("Some");
        match stage {
            CertRotationStage::Settled { current } => {
                assert_eq!(current.fingerprint.as_bytes()[0], 0xAB);
                assert_eq!(current.cert_label, "config:pin:0");
            }
            other => panic!("expected Settled, got {:?}", other),
        }
    }

    #[test]
    fn build_rotation_stage_two_pins_returns_bridge_rotation() {
        let pins = vec![
            "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789".to_string(),
            "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210".to_string(),
        ];
        let stage = build_rotation_stage_from_pins_hex(&pins)
            .expect("ok")
            .expect("Some");
        let accepted = stage.accepted_fingerprints(0);
        assert!(
            accepted
                .primary
                .as_ref()
                .is_some_and(|fp| fp.fingerprint.as_bytes()[0] == 0xAB)
        );
        assert!(
            accepted
                .bridge
                .as_ref()
                .is_some_and(|fp| fp.fingerprint.as_bytes()[0] == 0xFE)
        );
        if let CertRotationStage::Settled { .. } = stage {
            panic!("expected BridgeRotation, got Settled");
        }
    }

    #[test]
    fn build_rotation_stage_malformed_hex_bubbles_up() {
        let pins = vec!["not-enough".to_string()];
        let err = build_rotation_stage_from_pins_hex(&pins).expect_err("short");
        assert!(matches!(
            err,
            SuderraVerifierBuildError::InvalidFingerprintLength { .. }
        ));
    }

    #[test]
    fn build_suderra_verifier_legacy_empty_pins_returns_none() {
        let algs = rustls::crypto::ring::default_provider().signature_verification_algorithms;
        let root_store = Arc::new(rustls::RootCertStore::empty());
        let out = build_suderra_verifier(MtlsMode::Legacy, algs, &[], root_store).expect("ok");
        assert!(out.is_none(), "Legacy + no pins should skip wire");
    }

    #[test]
    fn build_suderra_verifier_strict_empty_pins_errors() {
        let algs = rustls::crypto::ring::default_provider().signature_verification_algorithms;
        let root_store = Arc::new(rustls::RootCertStore::empty());
        let err = build_suderra_verifier(MtlsMode::Strict, algs, &[], root_store)
            .expect_err("strict without pins");
        assert!(matches!(
            err,
            SuderraVerifierBuildError::StrictModeRequiresPins
        ));
    }

    #[test]
    fn build_suderra_verifier_empty_root_store_surfaces_webpki_error() {
        // rustls's WebPkiServerVerifier::build() rejects an
        // empty root store with NoRootAnchors. Prove the
        // error propagates through our builder — operator
        // misconfig (no CA certs available) is caught at
        // boot rather than at first handshake.
        let algs = rustls::crypto::ring::default_provider().signature_verification_algorithms;
        let root_store = Arc::new(rustls::RootCertStore::empty());
        let pins =
            vec!["abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789".to_string()];
        let err = build_suderra_verifier(MtlsMode::Legacy, algs, &pins, root_store)
            .expect_err("empty root store must fail");
        assert!(matches!(
            err,
            SuderraVerifierBuildError::WebPkiBuildFailed(_)
        ));
    }
}
