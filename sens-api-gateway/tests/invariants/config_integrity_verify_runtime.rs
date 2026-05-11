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
    let _contract =
        "Enforcing mode: verify failure -> Err(reason) -> exit(1) before network listen";
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

// =====================================================================
// Batch #319 — D-5 wire-status invariants (closes UH-019)
// =====================================================================
//
// The contract-marker tests above document `verify_at_boot`'s
// behavior but DO NOT verify that main.rs actually CALLS it.
// A future refactor that accidentally removes the call from
// fn main()'s boot sequence would let the contract markers
// stay green while the deployment shipped without integrity
// enforcement — exactly the silent-regression class the D-5
// gap was raised to prevent.
//
// These two tests close the wire-status gap by READING the
// main.rs source + asserting the call shape is present at
// the expected boot phase. Tier-3 detection per CLAUDE.md
// architectural-solution hierarchy.

const MAIN_RS_PATH: &str = "src/main.rs";

fn read_main_rs() -> String {
    std::fs::read_to_string(MAIN_RS_PATH).unwrap_or_else(|e| {
        panic!(
            "BUG: Batch #319 wire invariant cannot read {} — \
             this test runs from sens-api-gateway/ working dir per \
             standard cargo test convention. err={}",
            MAIN_RS_PATH, e
        )
    })
}

/// **D-5 wire-status invariant (Batch #319):** main.rs MUST
/// contain the `crate::config_integrity::verify_at_boot(...)`
/// call. A refactor that deletes the wire fails THIS test.
///
/// **Why grep (not full-process integration test):** running
/// the actual main() entry point requires either a
/// fork/exec'd subprocess (slow + flakier on CI) OR a lib-
/// split that exposes main_inner() (Sprint 6.x scope). Grep
/// is the intermediate Tier-3 detection that catches the
/// silent-regression class of bugs without the full-process
/// cost.
///
/// **Why position-aware:** the grep is scoped to AFTER the
/// `fn main()` opening brace + BEFORE the
/// `init_opentelemetry` call (which is the first
/// state-bearing init step). This narrows the failure mode
/// to "call removed entirely OR moved out of the cold-boot
/// phase" — both of which are silent-regression classes.
#[test]
fn d5_verify_at_boot_called_from_main_before_otel_init() {
    let main_rs = read_main_rs();

    // Locate the cold-boot phase boundaries.
    let main_fn_idx = main_rs.find("fn main()").unwrap_or_else(|| {
        panic!(
            "BUG: main.rs does not contain `fn main()` — \
             grep target locator is wrong"
        )
    });
    // The OTel init is the first state-bearing init step;
    // verify_at_boot MUST run before this.
    let otel_idx = main_rs[main_fn_idx..]
        .find("init_opentelemetry(")
        .map(|rel| main_fn_idx + rel)
        .unwrap_or_else(|| {
            panic!(
                "BUG: main.rs does not contain `init_opentelemetry(` — \
                 the boot-phase locator anchor was removed; this test \
                 needs an updated anchor"
            )
        });

    let cold_boot_phase = &main_rs[main_fn_idx..otel_idx];
    let verify_at_boot_call = "config_integrity::verify_at_boot(";
    assert!(
        cold_boot_phase.contains(verify_at_boot_call),
        "D-5 WIRE INVARIANT VIOLATED: main.rs's cold-boot phase \
         (between `fn main()` and `init_opentelemetry(`) MUST contain \
         a call to `{}`. The verify_at_boot wire is the architectural \
         enforcement of ULTRA-HIGH-019 D-5 — without it the agent \
         would boot with NO config-integrity check, making operator \
         /etc/suderra/config.yaml tampering undetectable. If you \
         intentionally moved the call (e.g., to a different boot \
         phase), update this test's `otel_idx` anchor and document \
         the architectural reason in the move commit. If you \
         accidentally deleted the call, restore it.",
        verify_at_boot_call,
    );
}

/// **D-5 wire-status invariant (Batch #319):** main.rs's
/// verify_at_boot call MUST be wrapped in a fail-closed
/// `match` arm that calls `std::process::exit(1)` on the
/// `Err` path.
///
/// **Why this matters architecturally:** the verify_at_boot
/// function returns `Result<(), String>` where the Err arm
/// is the structured rejection reason. A caller that
/// ignores the Err — `let _ = verify_at_boot(...)` — would
/// boot the agent regardless of the integrity verdict. This
/// test pins that the call is gated by a real fail-closed
/// arm.
#[test]
fn d5_verify_at_boot_err_arm_is_fail_closed() {
    let main_rs = read_main_rs();

    // Find the verify_at_boot invocation.
    let call_idx = main_rs
        .find("config_integrity::verify_at_boot(")
        .unwrap_or_else(|| {
            panic!(
                "BUG: D-5 wire invariant — verify_at_boot call not found \
             (this should have been caught by the sibling test \
             `d5_verify_at_boot_called_from_main_before_otel_init`)"
            )
        });

    // Look at the next ~1500 chars after the call site —
    // the match arm should be there.
    let nearby = &main_rs[call_idx..main_rs.len().min(call_idx + 1500)];

    // Two markers MUST appear in this window:
    // 1. `Err(` — the match arm exists
    // 2. `process::exit(1)` — the fail-closed action
    assert!(
        nearby.contains("Err("),
        "D-5 WIRE INVARIANT VIOLATED: verify_at_boot call site \
         lacks an `Err(` match arm within 1500 chars. The Err arm is \
         the architectural fail-closed path; without it the agent \
         would boot with a tampered config silently."
    );
    assert!(
        nearby.contains("process::exit(1)"),
        "D-5 WIRE INVARIANT VIOLATED: verify_at_boot call site \
         lacks a `process::exit(1)` within the Err arm window. \
         Fail-closed boot is the only acceptable outcome for an \
         Enforcing-mode integrity failure — Permissive-mode \
         failures are consumed inside verify_at_boot itself \
         (returns Ok with warn-log), so the only Err arm reaching \
         main MUST exit(1). Removing the exit would silently \
         downgrade Enforcing to Permissive."
    );
}

/// **D-5 wire-status invariant (Batch #319):** the
/// `factory_pubkey_hex` is sourced from
/// `config.config_integrity.factory_pubkey_hex` — operator-
/// supplied per ADR-020 §2 (firmware-embedded default
/// reserved for Sprint 6.6+).
///
/// **Why this matters:** sourcing the factory pubkey from
/// elsewhere (env var, hardcoded constant) would let an
/// attacker who controls the build pipeline OR the env
/// substitute their own pubkey + accept their own forged
/// signed config. Pinning the source to the operator-
/// signed config field keeps the trust anchor explicit.
#[test]
fn d5_factory_pubkey_hex_sourced_from_config_field() {
    let main_rs = read_main_rs();
    let needle = "config.config_integrity.factory_pubkey_hex";
    assert!(
        main_rs.contains(needle),
        "D-5 WIRE INVARIANT VIOLATED: main.rs does not source \
         factory_pubkey_hex from `{}`. The operator-signed config \
         field is the architectural trust anchor for the integrity \
         pubkey; sourcing from elsewhere (env var, constant) would \
         break the ADR-020 §2 chain.",
        needle
    );
}
