//! Invariant: every ed25519 signature gate on the program/
//! bytecode/ST/firmware-bundle DEPLOY path uses
//! `VerifyingKey::verify_strict`, never the permissive
//! trait method `Verifier::verify`.
//!
//! WHY (EDGE-MEDIUM-011): `verify` accepts non-canonical `R`
//! encodings and small-order public keys, permitting signature
//! malleability. On a life-safety edge agent these are exactly
//! the paths that flash executable control logic onto
//! controllers, so a malleability-permitting verifier is a
//! system-integrity (IEC 62443 FR3) weakness and an internal
//! inconsistency with the crate-wide `verify_strict` SSoT
//! (envelope_adapter, manifest_runtime, license, config_integrity).
//!
//! WHY grep (Tier-3 detection per CLAUDE.md): running each
//! deploy handler end-to-end needs a full AppState + registry
//! fixture; a source-grep catches the silent-regression class
//! (someone reintroduces `.verify(`) without that cost.
//!
//! The substring `.verify(` does NOT match `.verify_strict(`
//! (the latter is `verify_strict(`, no `verify(` boundary), so
//! this asserts the absence of the permissive call precisely.

const DEPLOY_SIGNATURE_GATES: &[&str] = &[
    "src/commands/deploy_bytecode_program.rs",
    "src/commands/deploy_st_source.rs",
    "src/commands/bundle_deploy.rs",
    "src/commands/system.rs",
];

fn read_source(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "BUG: deploy_verify_strict invariant cannot read {} — \
             this test runs from the sens-api-gateway/ working dir \
             per standard cargo test convention. err={}",
            path, e
        )
    })
}

/// No deploy signature gate may call the permissive
/// `Verifier::verify`. Reintroducing `.verify(` fails here.
#[test]
fn deploy_gates_use_verify_strict_not_verify() {
    for path in DEPLOY_SIGNATURE_GATES {
        let src = read_source(path);
        assert!(
            !src.contains(".verify("),
            "EDGE-MEDIUM-011 regression: {} contains a permissive `.verify(` \
             ed25519 call — deploy/firmware signature gates MUST use \
             `verify_strict` (malleability defense, IEC 62443 FR3).",
            path
        );
    }
}

/// Each deploy gate must actually reference `verify_strict`, so
/// the test above cannot pass vacuously by a gate losing its
/// verifier entirely.
#[test]
fn deploy_gates_reference_verify_strict() {
    for path in DEPLOY_SIGNATURE_GATES {
        let src = read_source(path);
        assert!(
            src.contains("verify_strict"),
            "EDGE-MEDIUM-011: {} no longer references `verify_strict` — \
             the ed25519 deploy signature gate appears to have been \
             removed or weakened.",
            path
        );
    }
}
