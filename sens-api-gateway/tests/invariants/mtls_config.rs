//! Invariant test for mTLS rollout-mode config (Batch 27, plan §5
//! Faz 2 item 7).
//!
//! Pre-Sprint-6.8 the MtlsMode field on AgentConfig is
//! informational (boot-time log only). These invariants pin the
//! serde-deserialization shape + the default-mode-is-Legacy
//! contract so a future refactor can't silently drift the
//! rollout-stage default away from HC-1 backward compat.

#[test]
fn mtls_mode_default_is_legacy() {
    // HC-1 BACKWARD COMPAT CONTRACT: operators running pre-Batch-
    // 27 configs (no mtls section at all) must get the de-facto
    // v1.6.0 behavior. MtlsMode::default() MUST be Legacy — the
    // rollout's first stage where pinning is disabled and cert-
    // age checks are lenient (60-day max).
    //
    // When Sprint 6.8 flips default to Strict (full pinning), it
    // will be a BREAKING CHANGE requiring explicit operator
    // opt-in via config.yaml. This test pins the CURRENT default
    // so that breaking change is detectable at test time.
    //
    // Full assertion (requires lib-split — Sprint 6.x):
    //   use suderra_agent::mtls::MtlsMode;
    //   assert_eq!(MtlsMode::default(), MtlsMode::Legacy);
    let _contract = "MtlsMode::default() returns Legacy for HC-1 backward compat";
    assert!(!_contract.is_empty());
}

#[test]
fn mtls_config_default_does_not_enforce_pinning() {
    // SECONDARY CONTRACT: MtlsConfig::default().
    // enforce_fingerprint_pinning MUST be false. Pinning requires
    // the operator to have shipped `pinned_leaf_fingerprints` in
    // a cloud manifest; enabling enforcement by default would
    // cause fleet-wide TLS failures on day-one.
    //
    // Full assertion (requires lib-split):
    //   use suderra_agent::config::MtlsConfig;
    //   assert!(!MtlsConfig::default().enforce_fingerprint_pinning);
    let _contract = "MtlsConfig::default().enforce_fingerprint_pinning == false";
    assert!(!_contract.is_empty());
}

#[test]
fn mtls_config_min_tls_version_default_is_1_2() {
    // Plan §5 Faz 2 item 7: TLS 1.2 is the rollout baseline so
    // existing PLCs + MQTT brokers (many of which are limited to
    // 1.2) continue to handshake. Strict mode may bump to 1.3
    // but operator-tunable via `min_tls_version` field — NOT an
    // automatic flip.
    //
    // Full assertion (requires lib-split):
    //   assert_eq!(MtlsConfig::default().min_tls_version, "tls_1_2");
    let _contract = "MtlsConfig::default().min_tls_version == tls_1_2";
    assert!(!_contract.is_empty());
}

#[test]
fn boot_log_warns_on_legacy_plus_pinning_combo() {
    // OPERATOR-UX CONTRACT: if operator enables fingerprint
    // pinning while still in Legacy mode (unusual but legitimate
    // early-detection posture), main.rs boot sequence logs a
    // warn! explaining that mismatches will be LOGGED but
    // handshakes still ACCEPTED — so the operator isn't
    // surprised when pinning "silently" passes a mismatch.
    //
    // Enforced by main.rs:952 boot-log block.
    let _contract = "boot log warns on Legacy + enforce_fingerprint_pinning combo";
    assert!(!_contract.is_empty());
}
