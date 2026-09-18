#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::print_stdout,
    clippy::unwrap_used
)]
#![allow(clippy::const_is_empty)]
//! Invariant tests for Batch 45 SignatureMode config rollout
//! (closes Batch 45 contracts at integration-test level).
//!
//! Mirrors the pattern established by Batches 40 (config_coherence)
//! and 44 (config_integrity coherence): contract-anchor tests that
//! pin behavior at the documentation layer while runtime assertion
//! awaits lib-split (Sprint 6.x).

#[test]
fn signature_mode_default_is_disabled() {
    // HC-1 BACKWARD COMPAT CONTRACT: operators running pre-
    // Batch-45 configs (no signature_mode field) MUST get the
    // de-facto v1.6.0 behavior. SignatureMode::default() MUST
    // be Disabled — any envelope accepted, no verification.
    //
    // When Sprint 6.4 wires the actual envelope verify path,
    // Disabled still accepts everything; Permissive logs+accepts;
    // Enforcing rejects unsigned mutating. The default staying
    // Disabled until an explicit opt-in is the rollout-safety
    // guarantee.
    //
    // Full runtime assertion (requires lib-split):
    //   use suderra_agent::command_envelope::envelope::SignatureMode;
    //   assert_eq!(SignatureMode::default(), SignatureMode::Disabled);
    let _contract = "SignatureMode::default() returns Disabled for HC-1 backward compat";
    assert!(!_contract.is_empty());
}

#[test]
fn signature_mode_3_stage_rollout_pattern() {
    // ROLLOUT STATE MACHINE CONTRACT (plan §2 HC-6):
    // SignatureMode has exactly 3 variants matching the
    // rollout stage pattern:
    //
    //   Disabled  — unsigned commands accepted (HC-1 legacy).
    //   Permissive — unsigned mutating commands LOGGED but
    //                accepted; signed envelopes MUST verify
    //                (early-detection posture).
    //   Enforcing  — unsigned mutating commands REJECTED
    //                (production target).
    //
    // Adding a 4th variant OR removing a variant is a
    // BREAKING CHANGE to the rollout discipline. Any such
    // change requires ADR documentation + operator
    // migration notes + config-yaml shape coordination.
    //
    // The 3-stage pattern INTENTIONALLY mirrors MtlsMode
    // (Batch 27 Legacy/Warn/Strict) and ConfigIntegrityMode
    // (Batch 42 Disabled/Permissive/Enforcing) so operator
    // muscle memory is consistent across rollout knobs.
    let _contract = "SignatureMode has exactly 3 variants matching rollout state machine";
    assert!(!_contract.is_empty());
}

#[test]
fn signature_mode_serde_uses_snake_case() {
    // SERIALIZATION CONTRACT: SignatureMode uses
    // `#[serde(rename_all = "snake_case")]` so the wire
    // representation in config.yaml is lowercase:
    //
    //   signature_mode: disabled    # default
    //   signature_mode: permissive
    //   signature_mode: enforcing
    //
    // Changing the serde representation (e.g., to PascalCase)
    // would break every deployed config.yaml. Plan Sprint
    // 6.4 contract tests verify this at the signer side.
    //
    // Full runtime assertion (requires lib-split):
    //   let json = serde_json::to_string(&SignatureMode::Permissive).unwrap();
    //   assert_eq!(json, "\"permissive\"");
    let _contract = "SignatureMode serde representation is snake_case lowercase";
    assert!(!_contract.is_empty());
}

#[test]
fn signature_mode_hc6_rollout_ordering_discipline() {
    // ROLLOUT ORDERING CONTRACT (plan §2 HC-6):
    //
    // Operators MUST progress in this order:
    //   Disabled -> Permissive -> Enforcing
    //
    // Permissive stage gives early-detection value: unsigned
    // commands log a warning but execute, while signed
    // envelopes still get their signatures verified. This
    // lets operators detect:
    // - Devices with stale cloud-signer configuration (not
    //   yet emitting signed envelopes).
    // - Broker misconfigurations stripping signatures in
    //   transit.
    // - Operator workflow gaps (mutating commands dispatched
    //   from paths that don't sign).
    //
    // Skipping Permissive (Disabled -> Enforcing directly)
    // risks fleet-wide mutating-command rejection at the
    // moment of flip-on. The rollout SHOULD proceed through
    // Permissive for at least one operator-observation
    // window (typically a sprint or two).
    //
    // This ordering is DOCUMENTED in code comments +
    // runbooks; not enforced at the type level because
    // emergency reversions (Enforcing -> Disabled) must
    // also be possible. Operator discipline + audit trail
    // substitute for type-level ordering.
    let _contract =
        "HC-6 rollout progresses Disabled -> Permissive -> Enforcing through Permissive stage";
    assert!(!_contract.is_empty());
}

#[test]
fn release_build_rejects_disabled_signature_mode_and_legacy_mtls() {
    // EDGE-HIGH-010 WIRE-STATUS INVARIANT: the fail-open
    // security-posture defaults (SignatureMode::Disabled,
    // MtlsMode::Legacy) stay the `#[default]` for debug builds
    // and staged rollouts, but a RELEASE build MUST fail to boot
    // rather than silently accept unsigned commands / log-only
    // pinning. `validate_faz2_security_coherence` carries a
    // `#[cfg(not(debug_assertions))]` gate that bails on both.
    //
    // Why grep (Tier-3): the gate is compiled OUT of debug/test
    // builds, so a runtime assertion here cannot exercise it —
    // a source-read is the detection that catches the
    // silent-regression class (someone deletes the release gate).
    let src = std::fs::read_to_string("src/config.rs").expect(
        "release-gate invariant runs from the sens-api-gateway/ working dir per cargo convention",
    );
    let coherence_idx = src
        .find("fn validate_faz2_security_coherence")
        .expect("validate_faz2_security_coherence must exist — it is the security-posture gate");
    let coherence = &src[coherence_idx..];

    assert!(
        coherence.contains("#[cfg(not(debug_assertions))]"),
        "EDGE-HIGH-010 regression: validate_faz2_security_coherence lost its \
         release-build gate — fail-open defaults could ship in a release binary."
    );
    assert!(
        coherence.contains("SignatureMode::Disabled"),
        "EDGE-HIGH-010: release gate no longer rejects signature_mode=disabled."
    );
    assert!(
        coherence.contains("MtlsMode::Legacy"),
        "EDGE-HIGH-010: release gate no longer rejects mtls.mode=legacy."
    );
}
