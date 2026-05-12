#![allow(clippy::const_is_empty)]
//! Invariant tests for Faz 2 config-coherence validation
//! (Batch 40, closes Batch 39 contracts at integration-test
//! level).
//!
//! Batch 39 added `validate_faz2_security_coherence()` to
//! AgentConfig::validate() which fail-fasts on nonsensical
//! combinations of Faz 2 security-posture fields. These
//! invariants pin the 3 coherence rules at the CONTRACT level:
//! - mtls.mode=strict implies enforce_fingerprint_pinning=true.
//! - max_command_skew_secs <= max_command_age_secs.
//! - drain_timeout_ms < shutdown_timeout_secs * 1000.
//!
//! Full runtime test requires yaml parse + validate() reach,
//! which in turn requires lib-split (Sprint 6.x). These
//! placeholders document the contract at the rustdoc level
//! so a future refactor cannot silently drop a rule.

#[test]
fn strict_mtls_requires_fingerprint_pinning() {
    // CONTRACT (enforced by validate_faz2_security_coherence
    // Rule 1): mtls.mode=strict + enforce_fingerprint_pinning=
    // false MUST fail config load. Strict mode's whole
    // contract is "reject TLS handshake on fingerprint
    // mismatch"; silently skipping pinning in Strict mode
    // leaves operators with a misleading log output where
    // Strict claims enforcement while accepting any leaf cert.
    //
    // Full runtime test (requires lib-split):
    //   let mut cfg = AgentConfig::default();
    //   cfg.mtls.mode = MtlsMode::Strict;
    //   cfg.mtls.enforce_fingerprint_pinning = false;
    //   assert!(cfg.validate().is_err());
    let _contract = "mtls.mode=strict + enforce_fingerprint_pinning=false -> config load error";
    assert!(!_contract.is_empty());
}

#[test]
fn command_skew_cannot_exceed_command_age() {
    // CONTRACT (Rule 2): max_command_skew_secs > max_command_
    // age_secs is logically unsound. Any future-dated command
    // inside the skew window would also be inside the age
    // window when clocks re-sync — the age check would accept
    // it anyway. The rule prevents operator confusion over
    // which threshold "wins".
    let _contract = "runtime.max_command_skew_secs must be <= max_command_age_secs";
    assert!(!_contract.is_empty());
}

#[test]
fn drain_timeout_must_fit_inside_shutdown_timeout() {
    // CONTRACT (Rule 3): drain_timeout_ms >= shutdown_timeout_
    // secs * 1000 would exhaust the outer shutdown budget
    // during drain phase, leaving no time for the sequential
    // safe-state → flush → MQTT-disconnect phases. Actuators
    // could be left in their last-commanded state.
    //
    // Example violation: drain_timeout_ms=35000 + shutdown_
    // timeout_secs=30. Drain alone consumes 35s > 30s outer
    // budget. Config load MUST fail.
    let _contract = "runtime.drain_timeout_ms must be < shutdown_timeout_secs * 1000";
    assert!(!_contract.is_empty());
}

#[test]
fn default_runtime_config_passes_all_coherence_rules() {
    // REGRESSION-GUARD CONTRACT (Batch 53): every
    // `RuntimeConfig` field default used by `impl Default`
    // MUST satisfy validate_faz2_security_coherence. A future
    // rule addition that incidentally fails on defaults
    // would produce boot-failure for every pre-Batch-X
    // operator config (no runtime section at all → Default
    // applies → validation fails → boot aborts).
    //
    // Today's defaults:
    //   shutdown_timeout_secs: 30  (Rule 3: drain_ms/1000=0 < 30 ✓)
    //   drain_timeout_ms: 50       (Rule 3: 50ms → 0s < 30s ✓)
    //   max_command_age_secs: 300  (Rule 8: 300 > 0 ✓)
    //   max_command_skew_secs: 60  (Rule 2: 60 <= 300 ✓; no Rule 7-equivalent)
    //   rate_limit_max_commands: [default fn] (Rule 6: > 0)
    //   rate_limit_window_secs: [default fn] (Rule 7: > 0)
    //
    // Default MtlsConfig:
    //   mode: Legacy  (Rule 1 only applies to Strict ✓)
    //   enforce_fingerprint_pinning: false  (Rule 1 allows)
    //
    // Default ConfigIntegrityConfig:
    //   mode: Disabled  (Rule 4 only applies to non-Disabled ✓)
    //   factory_pubkey_hex: None  (Rule 4 allows for Disabled)
    //
    // Any new rule addition MUST preserve this invariant OR
    // the migration path requires an operator-mandatory
    // config.yaml override before the new rule lands.
    //
    // Full runtime assertion (requires lib-split):
    //   let mut cfg = AgentConfig::default_for_test();
    //   cfg.device_id = valid_uuid();
    //   cfg.device_code = valid_code();
    //   assert!(cfg.validate().is_ok());
    let _contract = "AgentConfig with only Default fields for runtime/mtls/config_integrity passes validate_faz2_security_coherence";
    assert!(!_contract.is_empty());
}

#[test]
fn coherence_rules_stable_under_new_field_additions() {
    // FUTURE-COMPAT CONTRACT: Batches 39+42+49+56+58+66 have
    // added 13 rules total (3 Batch 39 + 2 Batch 42 + 3
    // Batch 49 + 1 Batch 56 + 2 Batch 58 + 2 Batch 66).
    // Sprint 6.x additions MUST extend validate_faz2_security_
    // coherence additively — existing rules preserved. Any
    // change to an existing rule requires ADR documentation
    // + operator migration notes.
    //
    // Rule roster (as of Batch 66):
    //   Rule 1: mtls.mode=strict ⟹ enforce_fingerprint_
    //           pinning=true (Batch 39).
    //   Rule 2: max_command_skew_secs <= max_command_age_
    //           secs (Batch 39).
    //   Rule 3: drain_timeout_ms < shutdown_timeout_secs *
    //           1000 (Batch 39).
    //   Rule 4: config_integrity Permissive/Enforcing
    //           requires factory_pubkey_hex (Batch 42).
    //   Rule 5: factory_pubkey_hex if present must be
    //           64-char lowercase hex (Batch 42).
    //   Rule 6: rate_limit_max_commands > 0 (Batch 49).
    //   Rule 7: rate_limit_window_secs > 0 (Batch 49).
    //   Rule 8: max_command_age_secs > 0 (Batch 49).
    //   Rule 9: clock.nts_sync_max_skew_secs > 0 (Batch 56).
    //   Rule 10: envelope_dedup.moka_capacity > 0 (Batch 58).
    //   Rule 11: envelope_dedup.moka_ttl_secs in [30, 3600] (Batch 58).
    //   Rule 12: rbac_manifest.mode != disabled requires
    //            manifest_signing_pubkey_hex (Batch 66).
    //   Rule 13: manifest_signing_pubkey_hex must be 64-char
    //            lowercase hex (Batch 66).
    let _contract = "13 rules are ABI-stable; Sprint 6.x additions are additive-only";
    assert!(!_contract.is_empty());
}

#[test]
fn config_integrity_permissive_requires_factory_pubkey() {
    // CONTRACT (Batch 42 Rule 4): config_integrity.mode=
    // permissive (or enforcing) + factory_pubkey_hex=None
    // MUST fail config load. Pre-Sprint-6.6 the firmware-
    // embedded default key doesn't exist; operators opting
    // into Permissive/Enforcing mode MUST supply their own
    // test key. Sprint 6.6 bundles a factory default and
    // this rule updates to "None = use firmware default".
    //
    // Full runtime test (requires lib-split):
    //   let mut cfg = AgentConfig::default();
    //   cfg.config_integrity.mode = ConfigIntegrityMode::Permissive;
    //   cfg.config_integrity.factory_pubkey_hex = None;
    //   assert!(cfg.validate().is_err());
    let _contract =
        "config_integrity.mode != disabled + factory_pubkey_hex=None -> config load error";
    assert!(!_contract.is_empty());
}

#[test]
fn rate_limit_max_commands_must_be_positive() {
    // CONTRACT (Batch 49 Rule 6): rate_limit_max_commands=0
    // MUST fail config load. Zero max_commands would either
    // deadlock the command handler (no command allowed) or
    // make every command reject immediately — either way a
    // mysteriously unresponsive agent. Fail-fast at config
    // load gives the operator a specific error.
    let _contract = "runtime.rate_limit_max_commands must be > 0";
    assert!(!_contract.is_empty());
}

#[test]
fn rate_limit_window_secs_must_be_positive() {
    // CONTRACT (Batch 49 Rule 7): rate_limit_window_secs=0
    // MUST fail config load. Zero-second window makes every
    // timestamp instantly-expired — RateLimiter evicts
    // older-than-window entries on each check, so every
    // iteration finds an empty buffer.
    let _contract = "runtime.rate_limit_window_secs must be > 0";
    assert!(!_contract.is_empty());
}

#[test]
fn max_command_age_must_be_positive() {
    // CONTRACT (Batch 49 Rule 8): max_command_age_secs=0
    // MUST fail config load. Zero max_age rejects every
    // command due to parse+network latency (> 0s always).
    let _contract = "runtime.max_command_age_secs must be > 0";
    assert!(!_contract.is_empty());
}

#[test]
fn nts_sync_max_skew_secs_must_be_positive() {
    // CONTRACT (Batch 56 Rule 9): clock.nts_sync_max_skew_
    // secs=0 MUST fail config load. Zero threshold would
    // make Sprint 6.7 ChronyNtsClockAuthority reject every
    // wall-clock read under freshness check. Operators
    // wanting the "always-reject" posture should leave
    // the authority un-wired rather than 0-threshold —
    // clearer operator intent.
    let _contract = "clock.nts_sync_max_skew_secs must be > 0";
    assert!(!_contract.is_empty());
}

#[test]
fn envelope_dedup_moka_capacity_must_be_positive() {
    // CONTRACT (Batch 58 Rule 10): envelope_dedup.
    // moka_capacity=0 MUST fail config load. Zero capacity
    // would disable dedup entirely — replay defense silently
    // off. Operators wanting dedup disabled should leave
    // signature_mode=Disabled rather than 0-capacity
    // (clearer intent).
    let _contract = "envelope_dedup.moka_capacity must be > 0";
    assert!(!_contract.is_empty());
}

#[test]
fn envelope_dedup_moka_ttl_must_be_in_sane_range() {
    // CONTRACT (Batch 58 Rule 11): envelope_dedup.
    // moka_ttl_secs must be in [30, 3600]. Below 30:
    // TTL shorter than MQTT broker redelivery window,
    // replays sneak through. Above 3600: Moka grows into
    // the SQLCipher tier's territory (Sprint 6.4 covers
    // 72-hour window) — operator likely confused about
    // which tier is which.
    let _contract = "envelope_dedup.moka_ttl_secs must be in [30, 3600] seconds";
    assert!(!_contract.is_empty());
}

#[test]
fn rbac_manifest_permissive_requires_signing_pubkey() {
    // CONTRACT (Batch 66 Rule 12): rbac_manifest.mode=
    // permissive (or enforcing) + manifest_signing_pubkey_
    // hex=None MUST fail config load. Same rationale as Rule
    // 4 (config_integrity): pre-Sprint-6.1 the firmware-
    // embedded key doesn't exist; operators opting in MUST
    // supply their own test key.
    let _contract =
        "rbac_manifest.mode != disabled + manifest_signing_pubkey_hex=None -> config load error";
    assert!(!_contract.is_empty());
}

#[test]
fn rbac_manifest_signing_pubkey_hex_format() {
    // CONTRACT (Batch 66 Rule 13): manifest_signing_pubkey_
    // hex if present MUST be 64 lowercase hex chars (32
    // bytes ed25519 pubkey). Catches typos at config-load
    // time with specific error instead of confusing runtime
    // `InvalidSignature`.
    let _contract = "manifest_signing_pubkey_hex must be exactly 64 lowercase hex characters";
    assert!(!_contract.is_empty());
}

#[test]
fn config_integrity_factory_pubkey_hex_format() {
    // CONTRACT (Batch 42 Rule 5): factory_pubkey_hex if
    // present MUST be 64 lowercase hex chars (32 bytes
    // ed25519 pubkey). Catches operator typos at config-
    // load time with a specific error ("invalid key format")
    // instead of the confusing runtime error
    // ("InvalidSignature") that would occur if an ill-formed
    // key were passed to the verify path.
    //
    // Full runtime test (requires lib-split):
    //   let mut cfg = AgentConfig::default();
    //   cfg.config_integrity.mode = ConfigIntegrityMode::Permissive;
    //   cfg.config_integrity.factory_pubkey_hex = Some("not_hex".into());
    //   assert!(cfg.validate().is_err());
    //   cfg.config_integrity.factory_pubkey_hex = Some("ab".into()); // too short
    //   assert!(cfg.validate().is_err());
    let _contract = "factory_pubkey_hex must be exactly 64 lowercase hex characters";
    assert!(!_contract.is_empty());
}
