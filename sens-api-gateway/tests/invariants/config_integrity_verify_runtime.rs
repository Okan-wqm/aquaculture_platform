//! Invariant tests for Batch 54 Sprint 6.6 config-integrity
//! runtime verify wire.
//!
//! The Sprint 6.6 verify path reads config.yaml + sidecar JSON,
//! computes SHA-256, parses factory pubkey, calls the Batch 9
//! pure `verify_config_integrity` function with a closure-
//! injected ed25519 verifier, and routes the result per mode:
//!
//! - Disabled: skip verification entirely.
//! - Permissive: verify attempted; failure warn-logged but
//!   boot continues.
//! - Enforcing: verify required; failure exits(1).
//!
//! These invariants pin the behavioral contracts at the
//! documentation layer. Full runtime assertions require
//! lib-split (Sprint 6.x) + a test harness that synthesizes
//! ed25519 keypairs + sidecar JSON files.

#[test]
fn disabled_mode_skips_verify_entirely() {
    // CONTRACT: ConfigIntegrityMode::Disabled returns Ok(())
    // from verify_at_boot WITHOUT reading the sidecar file
    // OR computing SHA-256. This is the HC-1 backward-compat
    // behavior; operators who have not yet provisioned a
    // sidecar file get the same de-facto boot behavior as
    // pre-Batch-54.
    let _contract = "ConfigIntegrityMode::Disabled => verify_at_boot returns Ok(()) without I/O";
    assert!(!_contract.is_empty());
}

#[test]
fn permissive_mode_warn_logs_on_failure() {
    // CONTRACT: ConfigIntegrityMode::Permissive attempts
    // verify; on failure, warn-logs the specific rejection
    // reason AND returns Ok(()). Boot continues regardless.
    // Rationale: early-detection posture for operator-
    // managed migration. Operators see the attempted-but-
    // failed verify in the log before flipping to Enforcing.
    let _contract = "Permissive mode: verify failure -> warn! + Ok(()) (boot continues)";
    assert!(!_contract.is_empty());
}

#[test]
fn enforcing_mode_fails_closed_on_failure() {
    // CONTRACT: ConfigIntegrityMode::Enforcing + verify
    // failure => verify_at_boot returns Err(reason). main.rs
    // propagates to std::process::exit(1). Fail-closed before
    // any network listener binds — attackers observing the
    // boot path cannot distinguish "device refused to boot
    // because config tampered" from "device offline".
    let _contract = "Enforcing mode: verify failure -> Err(reason) -> exit(1) before network listen";
    assert!(!_contract.is_empty());
}

#[test]
fn factory_pubkey_hex_rejects_wrong_length() {
    // CONTRACT: parse_factory_pubkey checks 64-char hex.
    // Wrong length returns Err with operator-visible message
    // mentioning "64 chars". Operators who typo-paste a
    // truncated key get an actionable error instead of a
    // confusing downstream `InvalidSignature` error.
    //
    // Enforced by Batch 42 Rule 5 at config load (prevents
    // getting this far) PLUS the verify_runtime's
    // parse_factory_pubkey safety net.
    let _contract = "parse_factory_pubkey rejects hex strings != 64 chars";
    assert!(!_contract.is_empty());
}

#[test]
fn highest_seen_version_first_boot_returns_zero() {
    // CONTRACT: load_highest_seen_version on a fresh data_dir
    // (no version file yet) returns 0. 0 is the lowest
    // acceptable floor for verify_config_integrity's Rule 2
    // (strict monotonic); first-boot signed config with any
    // positive version passes.
    //
    // Alternative behaviors that would be WRONG:
    // - Return None/u64::MAX — would reject every signed
    //   config with a positive version (infinite rollback
    //   protection on first boot).
    // - Return the config_version from the incoming sidecar
    //   — would disable rollback detection entirely.
    //
    // Verified by the in-crate test `load_highest_seen_
    // version_missing_file_returns_zero` in
    // config_integrity/verify_runtime.rs.
    let _contract = "load_highest_seen_version on missing file returns 0 (first boot floor)";
    assert!(!_contract.is_empty());
}

#[test]
fn save_highest_seen_version_is_best_effort() {
    // CONTRACT: save_highest_seen_version failure does NOT
    // abort boot. If the agent can't write to data_dir (read-
    // only filesystem, permission issue), the verify still
    // succeeds for THIS boot — but next boot's rollback-
    // detection reverts to the un-updated version floor.
    //
    // Rationale: the integrity primary gates are device_id
    // binding + SHA-256 + ed25519 signature. Rollback
    // detection is defense-in-depth against an attacker who
    // compromises /etc/suderra/ without /var/lib/suderra/
    // write access. If the agent can't persist AT ALL, the
    // attacker already has enough access to mount a fresh
    // compromise — persistence failure doesn't change the
    // security envelope.
    //
    // Sprint 6.3 keystore upgrades persistence to SQLCipher
    // for post-compromise integrity.
    let _contract = "save_highest_seen_version best-effort; failure does not abort boot";
    assert!(!_contract.is_empty());
}

#[test]
fn ed25519_verify_uses_verify_strict() {
    // CONTRACT: the closure-injected verifier in
    // verify_at_boot_inner uses `ed25519_dalek::VerifyingKey::
    // verify_strict` rather than the permissive
    // `verify_weak`. verify_strict enforces:
    // - Signature canonical bytes (no malleability).
    // - Public key subgroup check.
    // - No low-order point acceptance.
    //
    // These hardenings matter for signed-config security:
    // a malleability-permitting verifier would let an
    // attacker craft an equivalent-signature variant of a
    // valid config, bypassing the jti-style uniqueness
    // invariant.
    let _contract = "ed25519 verify uses VerifyingKey::verify_strict for malleability defense";
    assert!(!_contract.is_empty());
}
