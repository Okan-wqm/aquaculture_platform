//! Invariant: the production file-backed keystore boot path verifies
//! the acceptance-ceremony ed25519 signature — it MUST NOT ship the
//! `|_, _| true` stub.
//!
//! WHY (EDGE-HIGH-011): `build_production_keystore_from_config` is the
//! normal-boot construction path for the file-backed master-key tier.
//! The acceptance ceremony (ADR-018 §5) is the governance gate that
//! keeps that weaker tier unavailable unless a central authority
//! signed off; with the signature verify stubbed to `|_, _| true`,
//! anyone able to drop a JSON file with any 64 signature bytes gained
//! a valid acceptance. The fix parses a configured ceremony pubkey
//! (`keystore.acceptance_pubkey_hex`), runs `verify_strict`, and fails
//! closed when the key is absent.
//!
//! WHY grep (Tier-3): exercising the real boot path needs on-disk
//! passphrase/salt/acceptance fixtures; the ed25519 round-trip through
//! the same closure shape is unit-tested in
//! src/keystore/acceptance.rs. This guards the wiring against the stub
//! silently returning.

const BOOTSTRAP_PATH: &str = "src/keystore/bootstrap.rs";

fn read_bootstrap() -> String {
    std::fs::read_to_string(BOOTSTRAP_PATH).unwrap_or_else(|e| {
        panic!(
            "BUG: keystore-acceptance invariant cannot read {} — runs from the \
             sens-api-gateway/ working dir per cargo convention. err={}",
            BOOTSTRAP_PATH, e
        )
    })
}

/// The `|_, _| true` acceptance-verify stub must never reappear.
#[test]
fn acceptance_verify_is_not_stubbed_open() {
    let src = read_bootstrap();
    assert!(
        !src.contains("|_, _| true"),
        "EDGE-HIGH-011 regression: {} contains the `|_, _| true` acceptance-verify \
         stub — the file-backed keystore acceptance signature gate is decorative.",
        BOOTSTRAP_PATH
    );
}

/// The boot path must parse the ceremony pubkey and verify_strict.
#[test]
fn acceptance_verify_uses_ceremony_pubkey_and_verify_strict() {
    let src = read_bootstrap();
    assert!(
        src.contains("acceptance_pubkey_hex"),
        "EDGE-HIGH-011: {} no longer reads keystore.acceptance_pubkey_hex — the \
         acceptance ceremony trust anchor was removed.",
        BOOTSTRAP_PATH
    );
    assert!(
        src.contains("verify_strict"),
        "EDGE-HIGH-011: {} no longer calls verify_strict on the acceptance signature.",
        BOOTSTRAP_PATH
    );
}
