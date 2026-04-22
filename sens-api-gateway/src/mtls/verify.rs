//! # verify_leaf_cert — fail-closed 6-gate TLS handshake verifier
//!
//! Called by the TLS client verifier (rustls `ServerCertVerifier` in Sprint
//! 6.8) for every inbound TLS handshake. The closure-injection pattern
//! mirrors `authz::verify_manifest` + `updater::verify_firmware_manifest`
//! — Sprint 6.8 plugs in `sha2::Sha256::digest` for the cert DER
//! fingerprint computation.

use super::cipher::{CipherSuite, CIPHER_SUITE_ALLOWLIST};
use super::error::MtlsVerifyError;
use super::mode::MtlsMode;
use super::pinning::{CertRotationStage, LeafCertFingerprint};

/// Maximum cert chain depth. ADR-021 §10 caps at 4 (leaf + 2 intermediates
/// + root) to prevent chain-explosion DoS at handshake time.
pub const MAX_CHAIN_DEPTH: usize = 4;

/// Minimum TLS version (protocol version byte pair). RFC 8446 TLS 1.3 is
/// { 3, 4 } in the legacy_version encoding; anything lower rejected.
pub const MIN_TLS_MAJOR: u8 = 3;
pub const MIN_TLS_MINOR: u8 = 4;

/// Verify a leaf cert presented during a TLS handshake.
///
/// **Inputs:**
/// - `leaf_der_bytes`: the raw DER bytes of the server's leaf cert. The
///   closure `compute_sha256` hashes this to produce the fingerprint.
/// - `cert_not_before_unix_secs` / `cert_not_after_unix_secs`: parsed from
///   the cert Validity extension by the caller (rustls does this already;
///   we avoid re-parsing here).
/// - `chain_depth`: total cert chain length (leaf through root).
/// - `negotiated_cipher`: `Some(suite)` if the suite is in the allowlist;
///   `None` + `negotiated_codepoint` if it is NOT in the allowlist.
/// - `negotiated_codepoint`: IANA cipher-suite codepoint from the
///   ClientHello/ServerHello exchange.
/// - `negotiated_tls_major / minor`: TLS protocol version bytes.
/// - `mode`: current `MtlsMode` state.
/// - `rotation_stage`: the edge's pinned-cert rotation state.
/// - `now_unix_secs`: trusted wall-clock from `ClockAuthority::trustworthy_
///   wall_clock` (Batch 10). Inclusive for freshness window.
/// - `compute_sha256(der_bytes)`: closure producing the 32-byte SHA-256
///   digest.
///
/// **Returns:** `Ok(LeafCertFingerprint)` on success (the fingerprint is
/// handed back so the caller can audit-log the accepted pin). Err with
/// the structured rejection reason on failure.
///
/// **Gate ordering (cheapest-first, crypto-last):**
/// 1. InvalidNow — clock sanity.
/// 2. TlsVersionBelowMinimum — protocol byte compare.
/// 3. ChainTooLong — usize compare.
/// 4. CipherSuiteNotAllowed — enum lookup in allowlist.
/// 5. CertNotYetValid / CertExpired — i64 compare.
/// 6. CertAgeExceedsModeLimit — computed (now - not_before) / days_per_sec.
/// 7. SHA-256 digest over DER bytes (closure-injected — the expensive step).
/// 8. FingerprintNotPinned — set membership check.
#[allow(clippy::too_many_arguments)]
pub fn verify_leaf_cert(
    leaf_der_bytes: &[u8],
    cert_not_before_unix_secs: i64,
    cert_not_after_unix_secs: i64,
    chain_depth: usize,
    negotiated_cipher: Option<CipherSuite>,
    negotiated_codepoint: u16,
    negotiated_tls_major: u8,
    negotiated_tls_minor: u8,
    mode: MtlsMode,
    rotation_stage: &CertRotationStage,
    now_unix_secs: i64,
    compute_sha256: impl FnOnce(&[u8]) -> [u8; 32],
) -> Result<LeafCertFingerprint, MtlsVerifyError> {
    // Gate 1 — clock sanity.
    if now_unix_secs < 0 {
        return Err(MtlsVerifyError::InvalidNow);
    }

    // Gate 2 — TLS version floor.
    if negotiated_tls_major < MIN_TLS_MAJOR
        || (negotiated_tls_major == MIN_TLS_MAJOR && negotiated_tls_minor < MIN_TLS_MINOR)
    {
        return Err(MtlsVerifyError::TlsVersionBelowMinimum);
    }

    // Gate 3 — chain depth cap.
    if chain_depth > MAX_CHAIN_DEPTH {
        return Err(MtlsVerifyError::ChainTooLong {
            depth: chain_depth,
            max: MAX_CHAIN_DEPTH,
        });
    }

    // Gate 4 — cipher suite allowlist.
    let cipher = match negotiated_cipher {
        Some(c) if CIPHER_SUITE_ALLOWLIST.contains(&c) => c,
        _ => {
            return Err(MtlsVerifyError::CipherSuiteNotAllowed {
                negotiated_codepoint,
            });
        }
    };
    let _ = cipher; // consumed for documentation; future expansion may gate per-suite policy

    // Gate 5 — cert validity window.
    if now_unix_secs < cert_not_before_unix_secs {
        return Err(MtlsVerifyError::CertNotYetValid {
            not_before_unix_secs: cert_not_before_unix_secs,
            now_unix_secs,
        });
    }
    if now_unix_secs > cert_not_after_unix_secs {
        return Err(MtlsVerifyError::CertExpired {
            not_after_unix_secs: cert_not_after_unix_secs,
            now_unix_secs,
        });
    }

    // Gate 6 — mode-policy cert age cap.
    if let Some(max_days) = mode.max_leaf_cert_age_days() {
        let age_secs = now_unix_secs.saturating_sub(cert_not_before_unix_secs);
        let age_days = (age_secs / 86_400) as u32;
        if age_days > max_days {
            return Err(MtlsVerifyError::CertAgeExceedsModeLimit {
                cert_age_days: age_days,
                mode_limit_days: max_days,
            });
        }
    }

    // Gate 7 — compute fingerprint (the expensive cryptographic step).
    let digest = compute_sha256(leaf_der_bytes);
    let fingerprint = LeafCertFingerprint::from_bytes(digest);

    // Gate 8 — pinning check, mode-aware.
    let accepted_set = rotation_stage.accepted_fingerprints(now_unix_secs);
    if !accepted_set.accepts(&fingerprint) {
        // Legacy mode: log-only (return Ok but caller audits the violation
        // upstream via the `pinning_violation_audited()` flag). We express
        // this by returning Ok — the caller is responsible for checking
        // `mode.pinning_violation_audited()` and emitting the audit event.
        // Warn + Strict: return Err (Warn's caller downgrades Err → audit
        // log + accept; Strict's caller propagates Err to reject handshake).
        if mode.pinning_enforced() {
            return Err(MtlsVerifyError::FingerprintNotPinned { actual: fingerprint });
        }
        // Legacy / Warn — fall through to Ok. The fingerprint IS returned
        // so the caller can audit the accepted-but-unpinned cert.
    }

    Ok(fingerprint)
}

#[cfg(test)]
mod tests {
    use super::super::pinning::PinnedLeafCert;
    use super::*;

    fn mock_sha256_byte(byte: u8) -> impl FnOnce(&[u8]) -> [u8; 32] {
        move |_: &[u8]| [byte; 32]
    }

    fn canned_pin(byte: u8, label: &str) -> PinnedLeafCert {
        PinnedLeafCert {
            fingerprint: LeafCertFingerprint::from_bytes([byte; 32]),
            not_before_unix_secs: 1_000,
            not_after_unix_secs: 9_000,
            cert_label: label.to_string(),
        }
    }

    fn settled(byte: u8) -> CertRotationStage {
        CertRotationStage::Settled {
            current: canned_pin(byte, "prod"),
        }
    }

    #[test]
    fn accepts_valid_strict_handshake() {
        let fp = verify_leaf_cert(
            b"leaf-der-bytes",
            1_000,
            9_000,
            3,
            Some(CipherSuite::Chacha20Poly1305Sha256),
            0x1303,
            3,
            4,
            MtlsMode::Strict,
            &settled(0x42),
            5_000,
            mock_sha256_byte(0x42),
        )
        .expect("valid strict");
        assert_eq!(fp.as_bytes(), &[0x42u8; 32]);
    }

    #[test]
    fn rejects_tls_version_below_1_3() {
        let err = verify_leaf_cert(
            b"leaf",
            1_000,
            9_000,
            3,
            Some(CipherSuite::Chacha20Poly1305Sha256),
            0x1303,
            3,
            3, // TLS 1.2
            MtlsMode::Strict,
            &settled(0x42),
            5_000,
            mock_sha256_byte(0x42),
        )
        .expect_err("tls 1.2");
        assert_eq!(err, MtlsVerifyError::TlsVersionBelowMinimum);
    }

    #[test]
    fn rejects_cipher_suite_not_in_allowlist() {
        let err = verify_leaf_cert(
            b"leaf",
            1_000,
            9_000,
            3,
            None, // not in allowlist
            0x0035, // TLS_RSA_WITH_AES_256_CBC_SHA — banned
            3,
            4,
            MtlsMode::Strict,
            &settled(0x42),
            5_000,
            mock_sha256_byte(0x42),
        )
        .expect_err("bad cipher");
        assert_eq!(
            err,
            MtlsVerifyError::CipherSuiteNotAllowed { negotiated_codepoint: 0x0035 }
        );
    }

    #[test]
    fn rejects_chain_too_long() {
        let err = verify_leaf_cert(
            b"leaf",
            1_000,
            9_000,
            5, // > MAX_CHAIN_DEPTH
            Some(CipherSuite::Chacha20Poly1305Sha256),
            0x1303,
            3,
            4,
            MtlsMode::Strict,
            &settled(0x42),
            5_000,
            mock_sha256_byte(0x42),
        )
        .expect_err("chain");
        assert_eq!(err, MtlsVerifyError::ChainTooLong { depth: 5, max: 4 });
    }

    #[test]
    fn rejects_cert_not_yet_valid() {
        let err = verify_leaf_cert(
            b"leaf",
            10_000, // not_before in future
            20_000,
            3,
            Some(CipherSuite::Chacha20Poly1305Sha256),
            0x1303,
            3,
            4,
            MtlsMode::Strict,
            &settled(0x42),
            5_000,
            mock_sha256_byte(0x42),
        )
        .expect_err("not yet valid");
        assert!(matches!(err, MtlsVerifyError::CertNotYetValid { .. }));
    }

    #[test]
    fn rejects_cert_expired() {
        let err = verify_leaf_cert(
            b"leaf",
            1_000,
            4_000, // not_after < now
            3,
            Some(CipherSuite::Chacha20Poly1305Sha256),
            0x1303,
            3,
            4,
            MtlsMode::Strict,
            &settled(0x42),
            5_000,
            mock_sha256_byte(0x42),
        )
        .expect_err("expired");
        assert!(matches!(err, MtlsVerifyError::CertExpired { .. }));
    }

    #[test]
    fn rejects_cert_age_exceeds_legacy_limit() {
        // Legacy mode 60-day limit. Set not_before = 0 (epoch), now =
        // 61 * 86400 = 5_270_400 (61 days later).
        let err = verify_leaf_cert(
            b"leaf",
            0,
            9_999_999_999,
            3,
            Some(CipherSuite::Chacha20Poly1305Sha256),
            0x1303,
            3,
            4,
            MtlsMode::Legacy,
            &settled(0x42),
            61 * 86_400,
            mock_sha256_byte(0x42),
        )
        .expect_err("age exceeds legacy");
        assert!(matches!(
            err,
            MtlsVerifyError::CertAgeExceedsModeLimit {
                cert_age_days: 61,
                mode_limit_days: 60
            }
        ));
    }

    #[test]
    fn accepts_cert_age_at_exact_legacy_limit() {
        // 60 days = 5_184_000 seconds — exactly at limit, should accept.
        verify_leaf_cert(
            b"leaf",
            0,
            9_999_999_999,
            3,
            Some(CipherSuite::Chacha20Poly1305Sha256),
            0x1303,
            3,
            4,
            MtlsMode::Legacy,
            &settled(0x42),
            60 * 86_400,
            mock_sha256_byte(0x42),
        )
        .expect("at limit accept");
    }

    /// WHY (EDGE-INFO-005 closure): Strict mode now enforces the
    ///      398-day CA/B Forum ceiling. Private-CA 10-year leaves are
    ///      no longer admissible.
    #[test]
    fn rejects_cert_age_exceeds_strict_398_day_ceiling() {
        let err = verify_leaf_cert(
            b"leaf",
            0,
            i64::MAX / 2,
            3,
            Some(CipherSuite::Chacha20Poly1305Sha256),
            0x1303,
            3,
            4,
            MtlsMode::Strict,
            &settled(0x42),
            399 * 86_400,
            mock_sha256_byte(0x42),
        )
        .expect_err("age exceeds strict ceiling");
        assert!(matches!(
            err,
            MtlsVerifyError::CertAgeExceedsModeLimit {
                cert_age_days: 399,
                mode_limit_days: 398
            }
        ));
    }

    #[test]
    fn accepts_cert_age_at_exact_strict_ceiling() {
        verify_leaf_cert(
            b"leaf",
            0,
            i64::MAX / 2,
            3,
            Some(CipherSuite::Chacha20Poly1305Sha256),
            0x1303,
            3,
            4,
            MtlsMode::Strict,
            &settled(0x42),
            398 * 86_400,
            mock_sha256_byte(0x42),
        )
        .expect("at ceiling accept");
    }

    #[test]
    fn strict_mode_rejects_fingerprint_mismatch() {
        let err = verify_leaf_cert(
            b"leaf",
            1_000,
            9_000,
            3,
            Some(CipherSuite::Chacha20Poly1305Sha256),
            0x1303,
            3,
            4,
            MtlsMode::Strict,
            &settled(0x42),
            5_000,
            mock_sha256_byte(0x99), // different from pinned 0x42
        )
        .expect_err("pinning");
        assert!(matches!(
            err,
            MtlsVerifyError::FingerprintNotPinned { .. }
        ));
    }

    #[test]
    fn legacy_mode_accepts_fingerprint_mismatch_log_only() {
        let fp = verify_leaf_cert(
            b"leaf",
            1_000,
            9_000,
            3,
            Some(CipherSuite::Chacha20Poly1305Sha256),
            0x1303,
            3,
            4,
            MtlsMode::Legacy,
            &settled(0x42),
            5_000,
            mock_sha256_byte(0x99),
        )
        .expect("legacy accepts mismatch");
        assert_eq!(fp.as_bytes(), &[0x99u8; 32]);
    }

    #[test]
    fn warn_mode_accepts_fingerprint_mismatch_log_only() {
        let fp = verify_leaf_cert(
            b"leaf",
            1_000,
            9_000,
            3,
            Some(CipherSuite::Chacha20Poly1305Sha256),
            0x1303,
            3,
            4,
            MtlsMode::Warn,
            &settled(0x42),
            5_000,
            mock_sha256_byte(0x99),
        )
        .expect("warn accepts mismatch");
        assert_eq!(fp.as_bytes(), &[0x99u8; 32]);
    }

    #[test]
    fn bridge_rotation_accepts_outgoing_within_window() {
        let stage = CertRotationStage::BridgeRotation {
            outgoing: canned_pin(0x01, "out"),
            incoming: canned_pin(0x02, "inc"),
            bridge_until_unix_secs: 9_999,
        };
        // Verifier presenting outgoing fingerprint (0x01) within window.
        let fp = verify_leaf_cert(
            b"leaf",
            1_000,
            9_000,
            3,
            Some(CipherSuite::Chacha20Poly1305Sha256),
            0x1303,
            3,
            4,
            MtlsMode::Strict,
            &stage,
            5_000,
            mock_sha256_byte(0x01),
        )
        .expect("outgoing accepted in window");
        assert_eq!(fp.as_bytes(), &[0x01u8; 32]);
    }

    /// WHY (EDGE-LOW-002 closure): end-to-end verify path test for
    ///      BridgeRotation post-window outgoing-cert rejection. Guards
    ///      against a future refactor that decouples verify_leaf_cert
    ///      from the `rotation_stage.accepted_fingerprints(now)` call.
    #[test]
    fn bridge_rotation_rejects_outgoing_after_window_strict() {
        let stage = CertRotationStage::BridgeRotation {
            outgoing: canned_pin(0x01, "out"),
            incoming: canned_pin(0x02, "inc"),
            bridge_until_unix_secs: 3_000,
        };
        // now > bridge_until → outgoing retired → fingerprint 0x01 rejected.
        let err = verify_leaf_cert(
            b"leaf",
            1_000,
            9_000,
            3,
            Some(CipherSuite::Chacha20Poly1305Sha256),
            0x1303,
            3,
            4,
            MtlsMode::Strict,
            &stage,
            5_000,
            mock_sha256_byte(0x01),
        )
        .expect_err("post-window outgoing must reject");
        assert!(matches!(
            err,
            MtlsVerifyError::FingerprintNotPinned { .. }
        ));
    }

    #[test]
    fn rejects_negative_now() {
        let err = verify_leaf_cert(
            b"leaf",
            1_000,
            9_000,
            3,
            Some(CipherSuite::Chacha20Poly1305Sha256),
            0x1303,
            3,
            4,
            MtlsMode::Strict,
            &settled(0x42),
            -1,
            mock_sha256_byte(0x42),
        )
        .expect_err("neg now");
        assert_eq!(err, MtlsVerifyError::InvalidNow);
    }

    #[test]
    fn verifier_receives_leaf_der_bytes() {
        let mut received_len = 0usize;
        let _ = verify_leaf_cert(
            b"leaf-der-content",
            1_000,
            9_000,
            3,
            Some(CipherSuite::Chacha20Poly1305Sha256),
            0x1303,
            3,
            4,
            MtlsMode::Strict,
            &settled(0x42),
            5_000,
            |der| {
                received_len = der.len();
                [0x42u8; 32]
            },
        );
        assert_eq!(received_len, b"leaf-der-content".len());
    }

    /// WHY: MAX_CHAIN_DEPTH pinned at 4 per ADR-021 §10.
    #[test]
    fn max_chain_depth_pinned() {
        assert_eq!(MAX_CHAIN_DEPTH, 4);
    }

    #[test]
    fn min_tls_version_pinned_at_1_3() {
        assert_eq!(MIN_TLS_MAJOR, 3);
        assert_eq!(MIN_TLS_MINOR, 4);
    }
}
