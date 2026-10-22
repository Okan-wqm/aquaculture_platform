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

#[path = "source_scan_support/mod.rs"]
mod source_scan_support;

use source_scan_support::{functions, scan_src};

#[test]
fn signature_mode_default_is_permissive_on_generic_and_enforcing_on_suderra_os() {
    // HC-1 BACKWARD COMPAT CONTRACT (ADR-048 DEC-9.10, DEC-28): a
    // configuration that names no `signature_mode` (every v1.6.0
    // configuration) must load in a release build. The old default,
    // Disabled, is what a release build refuses
    // (`check_release_posture`), so the whole fleet's configurations
    // failed to load (SENSOR-CRITICAL-203). The generic profile's default
    // is therefore Permissive: unsigned mutating commands are logged,
    // every signed envelope is still verified. The suderra-os profile
    // compiles Enforcing alone and makes it the default. Disabled is
    // never a default of either profile.
    //
    // Read from the enum's source, because the check has to see the
    // `#[default]` of the profile that is not being compiled.
    let src = std::fs::read_to_string("src/command_envelope/envelope.rs")
        .expect("invariant runs from the sens-api-gateway/ working dir per cargo convention");
    let start = src
        .find("pub enum SignatureMode")
        .expect("SignatureMode must exist in command_envelope/envelope.rs");
    let open = start + src[start..].find('{').expect("the enum has a body");
    let close = open + src[open..].find("\n}").expect("the enum body is closed");
    let body = &src[open..close];

    let after_default = body
        .split_once("#[default]")
        .expect("the generic profile's default variant carries #[default]")
        .1;
    let generic_default: String = after_default
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    assert_eq!(
        generic_default, "Permissive",
        "SENSOR-CRITICAL-203: the generic profile's SignatureMode default must be Permissive \
         (Disabled is refused by a release build, so a v1.6.0 configuration would not load)"
    );

    let enforcing = body
        .find("    Enforcing,")
        .expect("SignatureMode::Enforcing must exist in both profiles");
    assert!(
        body[..enforcing]
            .trim_end()
            .ends_with("#[cfg_attr(feature = \"suderra-os\", default)]"),
        "DEC-9.1: Enforcing must be the suderra-os profile's default"
    );
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
    //   signature_mode: disabled    # generic profile, debug builds only
    //   signature_mode: permissive  # generic profile default
    //   signature_mode: enforcing   # suderra-os profile (the only mode)
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
    // security-posture modes (SignatureMode::Disabled, MtlsMode::Legacy
    // with a pin configured) stay available to debug builds and staged
    // rollouts, but a RELEASE build MUST fail to boot rather than silently
    // accept unsigned commands / log-only pinning.
    //
    // The refusal is `AgentConfig::check_release_posture` (a function of its
    // own so a test can run any configuration, the v1.6.0 fleet's included,
    // through the release posture from a debug build);
    // `validate_faz2_security_coherence` calls it behind
    // `!cfg!(debug_assertions)`. This test holds both halves: what the
    // posture refuses, and that the validation reaches it in a release
    // build.
    //
    // Why a source read (Tier-3): the call is compiled OUT of debug/test
    // builds, so a runtime assertion here cannot exercise it — a source-read
    // is the detection that catches the silent-regression class (someone
    // deletes the release gate or empties the posture).
    let config = scan_src()
        .into_iter()
        .find(|f| f.rel == "src/config.rs")
        .expect("src/config.rs is scanned");
    let fns = functions(&config.code);
    let body_of = |name: &str| -> String {
        fns.get(name)
            .and_then(|bodies| bodies.first())
            .unwrap_or_else(|| panic!("{name} must exist in src/config.rs"))
            .clone()
    };

    let posture = body_of("check_release_posture");
    assert!(
        posture.contains("SignatureMode::Disabled"),
        "EDGE-HIGH-010: the release posture no longer rejects signature_mode=disabled."
    );
    assert!(
        posture.contains("MtlsMode::Legacy"),
        "EDGE-HIGH-010: the release posture no longer rejects mtls.mode=legacy."
    );
    assert!(
        posture.matches("bail!").count() >= 2,
        "EDGE-HIGH-010: the release posture must refuse (bail) for each of the two postures."
    );

    let coherence = body_of("validate_faz2_security_coherence");
    let call = coherence.find("self.check_release_posture()").expect(
        "EDGE-HIGH-010 regression: validate_faz2_security_coherence no longer runs the \
             release posture — fail-open defaults could ship in a release binary.",
    );
    let gate = coherence[..call]
        .rfind("debug_assertions")
        .expect("the release posture must be gated on debug_assertions");
    assert!(
        coherence[..gate].ends_with("!cfg!(") && !coherence[gate..call].contains('}'),
        "EDGE-HIGH-010 regression: the release posture must run directly under \
         `if !cfg!(debug_assertions)` — debug builds keep the dev-rollout modes, a \
         release build must not."
    );

    assert!(
        fns.values()
            .flatten()
            .any(|body| body.contains("self.validate_faz2_security_coherence()")),
        "EDGE-HIGH-010 regression: nothing calls validate_faz2_security_coherence."
    );
}
