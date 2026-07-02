//! Rust half of the cloud↔edge contract-parity gate (enterprise plan
//! Faz 4 — counterpart of `libs/sensor-contracts/src/__tests__/
//! contract-fixtures.spec.ts`).
//!
//! The fixtures under `libs/sensor-contracts/fixtures/` are the SHARED
//! source of truth: the TS spec proves each fixture satisfies the
//! canonical AJV schemas the cloud validates at its publish boundary;
//! THIS module proves the same bytes deserialize into the agent's serde
//! structs (`CommandMessage`, `ScadaProcess`, `ProgramDefinition`,
//! `ScadaPackage`) with the semantically-load-bearing fields populated —
//! not silently defaulted. A wire-shape change that breaks either side
//! turns exactly one of the two builds red; drift cannot land silently.
//!
//! Lives inside the crate (`#[cfg(test)]` module, not `tests/`) because
//! the crate is `[[bin]]`-only — external integration tests cannot
//! import internal types (same constraint documented for
//! d1_source_compile_roundtrip in Cargo.toml).
//!
//! The "populated, not defaulted" assertions are the teeth: the
//! historical drift (cloud emitting camelCase `fbType`/`onError`/
//! `intervalSecs`/`ptMs`/`delayMs` at nested scripting types that carry
//! NO serde rename) parsed *successfully* while silently dropping the
//! payload — only `fb_type` (required) failed loudly. Asserting the
//! decoded VALUES pins the whole family.

use std::path::PathBuf;

use crate::commands::ProgramDefinition;
use crate::mqtt::CommandMessage;
use crate::scripting::{ActionType, ExecutionMode, TriggerType};

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../libs/sensor-contracts/fixtures")
        .join(name)
}

fn read_fixture(name: &str) -> serde_json::Value {
    let path = fixture_path(name);
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read fixture {}: {}", path.display(), e));
    serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("fixture {} is not valid JSON: {}", name, e))
}

fn envelope_of(name: &str) -> CommandMessage {
    let value = read_fixture(name);
    serde_json::from_value(value)
        .unwrap_or_else(|e| panic!("fixture {} does not parse as CommandMessage: {}", name, e))
}

#[test]
fn all_fixtures_parse_as_command_envelope() {
    for name in [
        "command-envelope.json",
        "deploy-process.json",
        "deploy-program.json",
        "deploy-scada-package.json",
        "deploy-bundle.json",
    ] {
        let envelope = envelope_of(name);
        assert!(!envelope.command_id.is_empty(), "{}: commandId empty", name);
        assert!(!envelope.command.is_empty(), "{}: command empty", name);
        assert!(!envelope.timestamp.is_empty(), "{}: timestamp empty", name);
        assert!(
            envelope.params.is_object(),
            "{}: params not an object",
            name
        );
    }
}

#[test]
fn deploy_program_fixture_deserializes_with_nested_snake_case_populated() {
    let envelope = envelope_of("deploy-program.json");
    assert_eq!(envelope.command, "deploy_program");

    let program: ProgramDefinition = serde_json::from_value(envelope.params)
        .expect("deploy-program params must parse as ProgramDefinition");

    // Top-level camelCase (ProgramDefinition rename_all).
    assert_eq!(program.version, 2);
    assert_eq!(program.execution_mode, ExecutionMode::ScanCycle);
    assert_eq!(program.scan_cycle_ms, 100);
    assert!(program.replace_existing);

    // FBDefinition is snake_case on the wire — fb_type is REQUIRED, and
    // pt_ms/pv must arrive populated (the drift shape parsed to None).
    assert_eq!(program.function_blocks.len(), 2);
    let ton = &program.function_blocks[0];
    assert_eq!(ton.fb_type, "TON");
    assert_eq!(ton.params.pt_ms, Some(5000));
    assert_eq!(
        ton.inputs.get("IN").map(String::as_str),
        Some("sensor:dissolved_oxygen")
    );
    let ctu = &program.function_blocks[1];
    assert_eq!(ctu.fb_type, "CTU");
    assert_eq!(ctu.params.pv, Some(10));

    // ScriptDefinition nested fields — on_error must be POPULATED
    // (`onError` parsed fine and silently defaulted to []).
    assert_eq!(program.script.on_error.len(), 1);
    assert_eq!(program.script.on_error[0].action_type, ActionType::Alert);

    // Trigger.interval_secs must arrive populated (not None).
    let interval = program
        .script
        .triggers
        .iter()
        .find(|t| t.trigger_type == TriggerType::Interval)
        .expect("fixture carries an interval trigger");
    assert_eq!(interval.interval_secs, Some(60));

    // Action.delay_ms must arrive populated (not None).
    let delay = program
        .script
        .actions
        .iter()
        .find(|a| a.action_type == ActionType::Delay)
        .expect("fixture carries a delay action");
    assert_eq!(delay.delay_ms, Some(1500));
}

#[cfg(feature = "scada-display")]
#[test]
fn deploy_process_fixture_deserializes_as_scada_process() {
    let envelope = envelope_of("deploy-process.json");
    assert_eq!(envelope.command, "deploy_process");

    let process: crate::scada_server::ScadaProcess = serde_json::from_value(envelope.params)
        .expect("deploy-process params must parse as ScadaProcess");

    assert_eq!(process.name, "Fish Tank Cooling Loop");
    assert_eq!(process.version, 3);
    assert_eq!(process.nodes.len(), 1);
    assert_eq!(process.edges.len(), 1);
    assert_eq!(process.tag_mappings.len(), 1);
    let mapping = &process.tag_mappings[0];
    assert_eq!(mapping.tag_name, "water_temp");
    assert_eq!(mapping.equipment_id, "pump-01");
}

#[cfg(feature = "scada-display")]
#[test]
fn deploy_scada_package_fixture_deserializes_as_scada_package() {
    let envelope = envelope_of("deploy-scada-package.json");
    assert_eq!(envelope.command, "deploy_scada_package");

    let package: crate::scada_types::ScadaPackage = serde_json::from_value(envelope.params)
        .expect("deploy-scada-package params must parse as ScadaPackage");

    assert_eq!(package.meta.version, 3);
    assert_eq!(package.meta.package_version, "3.0.0");
    assert_eq!(
        package.meta.edge_device_id.as_deref(),
        Some("9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d")
    );
    assert_eq!(package.screens.len(), 1);
    assert_eq!(package.screens[0].widgets.len(), 2);
    assert_eq!(package.alarm_rules.len(), 1);
    assert_eq!(
        package.control_permissions.security_levels.confirm,
        vec!["widget-2".to_string()]
    );
    assert_eq!(package.trend_config.retention_days, Some(7));
}

/// Faz 5: the deploy-bundle fixture must clear the FULL edge
/// verification pipeline — manifest hash, ed25519 signature (seed
/// 0x01×32, tenant "tenant-42", domain tag bundle-v1), per-artifact
/// checksums, and typed parsing of every member artifact. This is the
/// strongest cross-language pin in the suite: the fixture was signed
/// by the cloud signer implementation, verified here by the edge.
#[cfg(feature = "scada-display")]
#[test]
fn deploy_bundle_fixture_clears_full_edge_verification() {
    use ed25519_dalek::{SigningKey, Verifier};

    let envelope = envelope_of("deploy-bundle.json");
    assert_eq!(envelope.command, "deploy_bundle");

    let params: crate::commands::bundle_deploy::DeployBundleParams =
        serde_json::from_value(envelope.params)
            .expect("deploy-bundle params must parse as DeployBundleParams");

    let verifying_key = SigningKey::from_bytes(&[1u8; 32]).verifying_key();
    let verified = crate::commands::bundle_deploy::verify_bundle(
        &params,
        Some("tenant-42".to_string()),
        |msg, sig| {
            verifying_key
                .verify(msg, &ed25519_dalek::Signature::from_bytes(sig))
                .is_ok()
        },
    )
    .expect("fixture bundle must verify end-to-end");

    assert_eq!(verified.staged.len(), 2);
    assert!(verified.staged.iter().any(|a| matches!(
        a,
        crate::commands::bundle_deploy::StagedArtifact::Program { .. }
    )));
    assert!(verified.staged.iter().any(|a| matches!(
        a,
        crate::commands::bundle_deploy::StagedArtifact::ScadaPackage { .. }
    )));

    // Version truth flows from the SIGNED manifest into the staged
    // package meta (the content-addressed body is version-free).
    for artifact in &verified.staged {
        if let crate::commands::bundle_deploy::StagedArtifact::ScadaPackage { package } = artifact {
            assert_eq!(package.meta.version, 3);
        }
    }

    // A signature minted for another tenant must NOT verify.
    let err = crate::commands::bundle_deploy::verify_bundle(
        &params,
        Some("tenant-99".to_string()),
        |msg, sig| {
            verifying_key
                .verify(msg, &ed25519_dalek::Signature::from_bytes(sig))
                .is_ok()
        },
    )
    .expect_err("wrong tenant must fail");
    assert!(err.contains("signature verification failed"));
}

/// The signature material rides in the SAME positions the Faz 4 edge
/// gate reads (`meta.signature`/`meta.artifactSha256` for packages,
/// top-level for processes) and stays well-formed hex of the pinned
/// lengths — the gate rejects malformed material instead of skipping.
#[test]
fn signature_material_positions_match_the_deploy_gate() {
    use crate::scripting::deploy_sig::parse_signature_hex;

    let package = read_fixture("deploy-scada-package.json");
    let meta = &package["params"]["meta"];
    let sig = meta["signature"].as_str().expect("package meta.signature");
    assert!(
        parse_signature_hex(sig).is_some(),
        "package signature must be 128-char hex"
    );
    assert_eq!(meta["artifactSha256"].as_str().map(str::len), Some(64));

    let process = read_fixture("deploy-process.json");
    let sig = process["params"]["signature"]
        .as_str()
        .expect("process params.signature");
    assert!(
        parse_signature_hex(sig).is_some(),
        "process signature must be 128-char hex"
    );
    assert_eq!(
        process["params"]["artifactSha256"].as_str().map(str::len),
        Some(64)
    );
}
