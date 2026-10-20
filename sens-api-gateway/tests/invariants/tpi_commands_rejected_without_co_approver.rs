#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]
//! ADR-048 DEC-9.4 — two-person-integrity (TPI) commands are refused
//! fail-closed until operator keys and co-signing arrive (P2).
//!
//! In contract 1.x the only command key on a device is the single platform
//! actor's (`platform-authenticated`), so a co-approver signature could only
//! come from the same platform: it cannot mean a second person. The class
//! is `Permission::requires_two_person_integrity` — firmware update,
//! program deploy, ForceValue, SafeStateTrigger, reboot, OPC UA write and
//! S7 write — and three independent gates keep it closed:
//!
//! 1. No contract 1.x RBAC manifest can grant a TPI permission: the
//!    contract schema has no such permission, the agent's contract verifier
//!    refuses one as `schema-invalid`, and the agent's conversion into its
//!    engine's manifest refuses one again (DEC-9.4: the manifest producer
//!    cannot give the class to `platform-authenticated`).
//! 2. The Suderra OS profile refuses every TPI permission in
//!    `authorize_adapted` before the policy engine runs, with or without a
//!    co-approver (`Permission::refused_until_operator_co_signing`).
//! 3. Without that gate the engine still refuses a TPI permission that has
//!    no co-approver (`TwoPersonIntegrityMissing`), which is what the
//!    generic profile relies on until DEC-28's P2 work.
//!
//! The behavioural check of gate 2 against the whole command catalog is the
//! in-crate test `envelope_adapter::tests::
//! two_person_commands_are_refused_even_with_a_co_approver` (the crate is
//! binary-only); this file pins the vocabulary and the wiring.

#[allow(dead_code)]
#[path = "../../src/authz/permission.rs"]
mod permission;

#[allow(dead_code)]
#[path = "../../src/edge_contract/mod.rs"]
mod edge_contract;

#[path = "source_scan_support/mod.rs"]
mod source_scan_support;

use edge_contract::statements::{PARAMETERISED_PERMISSIONS, PLAIN_PERMISSIONS, permission_ok};
use permission::{Permission, TagId};
use serde_json::{Value, json};

/// The DEC-9.4 class, one value per variant.
fn tpi_class() -> Vec<Permission> {
    vec![
        Permission::UpdateFirmware,
        Permission::DeployProgram,
        Permission::ForceValue,
        Permission::SafeStateTrigger,
        Permission::Reboot,
        Permission::OpcUaWrite {
            tag_id: TagId::from("pond1.do".to_string()),
        },
        Permission::S7Write {
            address: TagId::from("DB1.DBW0".to_string()),
        },
    ]
}

fn contract_dir() -> std::path::PathBuf {
    source_scan_support::crate_root().join("../contracts/suderra-edge/v1")
}

#[test]
fn the_two_person_class_is_exactly_the_dec_9_4_set() {
    for p in tpi_class() {
        assert!(p.requires_two_person_integrity(), "{p:?}");
        assert_eq!(
            p.refused_until_operator_co_signing(),
            cfg!(feature = "suderra-os"),
            "{p:?}: refused outright exactly in the suderra-os profile"
        );
    }
    // Everything the contract can grant is outside the class.
    for name in PLAIN_PERMISSIONS {
        let p: Permission =
            serde_json::from_value(json!(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(!p.requires_two_person_integrity(), "{name}");
        assert!(!p.refused_until_operator_co_signing(), "{name}");
    }
}

#[test]
fn no_contract_manifest_can_grant_a_two_person_permission() {
    for p in tpi_class() {
        let wire = serde_json::to_value(&p).expect("serialize");
        assert!(
            !permission_ok(&wire),
            "the contract permission schema admits {wire}"
        );
    }
    let schema: Value = serde_json::from_slice(
        &std::fs::read(contract_dir().join("schemas/rbac-manifest.schema.json")).unwrap(),
    )
    .unwrap();
    let text = schema["$defs"]["permission"].to_string();
    for p in tpi_class() {
        let wire = serde_json::to_value(&p).unwrap();
        let name = match &wire {
            Value::String(s) => s.clone(),
            Value::Object(m) => m.keys().next().unwrap().clone(),
            other => panic!("{other}"),
        };
        assert!(
            !text.contains(&format!("\"{name}\"")),
            "{name} in the schema"
        );
        assert!(!PLAIN_PERMISSIONS.contains(&name.as_str()));
        assert!(!PARAMETERISED_PERMISSIONS.contains(&name.as_str()));
    }
    // The golden fixture that tries anyway is labelled schema-invalid.
    let index: Value =
        serde_json::from_slice(&std::fs::read(contract_dir().join("fixtures/index.json")).unwrap())
            .unwrap();
    let entry = index["statements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["path"] == "rbac-manifest/invalid/tpi-permission.dsse.json")
        .expect("tpi-permission fixture");
    assert_eq!(entry["expect"], "reject");
    assert_eq!(entry["reason"], "schema-invalid");
}

#[test]
fn every_contract_permission_form_is_the_agents_own_serde_form() {
    // A parameterised permission the contract admits must deserialize into
    // the agent's vocabulary, or the conversion would refuse a valid
    // manifest.
    for wire in [
        json!({"WriteTag": {"tag_id": "pond.1:do"}}),
        json!({"ModbusWrite": {"device_id": 3, "register_range": {"start": 10, "end": 12}}}),
        json!({"GpioWrite": {"pin": 17}}),
        json!({"PwmWrite": {"channel": 1}}),
        json!({"SpiWrite": {"device_id": 0}}),
        json!({"AffectActuator": {"class": {"Aeration": "LifeSupport"}}}),
        json!({"EmergencyActuator": {"class": "Feeding"}}),
    ] {
        assert!(permission_ok(&wire), "{wire}");
        let p: Permission =
            serde_json::from_value(wire.clone()).unwrap_or_else(|e| panic!("{wire}: {e}"));
        assert!(!p.requires_two_person_integrity(), "{wire}");
    }
}

#[test]
fn authorization_refuses_the_class_before_the_engine_and_the_conversion_refuses_it_too() {
    let adapter = source_scan_support::scan(
        "src/commands/envelope_adapter.rs",
        &std::fs::read_to_string(
            source_scan_support::crate_root().join("src/commands/envelope_adapter.rs"),
        )
        .unwrap(),
    );
    let gate = adapter.code_lines_with("refused_until_operator_co_signing()");
    let engine = adapter.code_lines_with("engine.authorize(");
    assert_eq!(
        gate.len(),
        1,
        "one TPI refusal in authorize_adapted: {gate:?}"
    );
    assert_eq!(engine.len(), 1, "{engine:?}");
    assert!(gate[0] < engine[0], "the refusal must precede the engine");

    let runtime = source_scan_support::scan(
        "src/authz/manifest_runtime.rs",
        &std::fs::read_to_string(
            source_scan_support::crate_root().join("src/authz/manifest_runtime.rs"),
        )
        .unwrap(),
    );
    assert!(
        !runtime
            .code_lines_with("permission.requires_two_person_integrity()")
            .is_empty(),
        "the contract manifest conversion must refuse a TPI permission"
    );

    let engine_src = source_scan_support::scan(
        "src/authz/in_memory_engine.rs",
        &std::fs::read_to_string(
            source_scan_support::crate_root().join("src/authz/in_memory_engine.rs"),
        )
        .unwrap(),
    );
    assert!(
        !engine_src
            .code_lines_with("AuthorizationDenyReason::TwoPersonIntegrityMissing")
            .is_empty(),
        "the engine's co-approver requirement must stay"
    );
}

#[cfg(feature = "suderra-os")]
#[test]
fn the_suderra_os_profile_compiles_enforcing_alone() {
    // DEC-9.1: SignatureMode::{Disabled, Permissive} and the unsigned legacy
    // command path are compiled out; each sits behind the generic-profile
    // cfg in the source the suderra-os build compiles.
    let envelope = std::fs::read_to_string(
        source_scan_support::crate_root().join("src/command_envelope/envelope.rs"),
    )
    .unwrap();
    let start = envelope.find("pub enum SignatureMode {").expect("enum");
    let body = &envelope[start..start + envelope[start..].find("\n}").unwrap()];
    for variant in ["Disabled,", "Permissive,"] {
        let at = body.find(variant).unwrap_or_else(|| panic!("{variant}"));
        let before = &body[..at];
        let attr = before.rfind("#[cfg(not(feature = \"suderra-os\"))]");
        let last_variant_end = before.rfind(',');
        assert!(
            attr.is_some() && attr > last_variant_end,
            "{variant} must be compiled out of the suderra-os profile"
        );
    }
    let dispatch =
        std::fs::read_to_string(source_scan_support::crate_root().join("src/commands/catalog.rs"))
            .unwrap();
    let legacy = dispatch
        .find("pub(crate) fn legacy_command_permitted(")
        .expect("legacy gate");
    assert!(
        dispatch[..legacy]
            .trim_end()
            .ends_with("#[cfg(not(feature = \"suderra-os\"))]"),
        "the unsigned legacy command gate exists only in the generic profile"
    );
}
