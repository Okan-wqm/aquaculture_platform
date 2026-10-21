#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]
//! Golden fixtures of contract v1 (`contracts/suderra-edge/v1/fixtures/
//! index.json`) through the agent's verifier (`src/edge_contract/`, ADR-048
//! DEC-3, DEC-25).
//!
//! * Every statement fixture whose verifier is `agent` must reach exactly its
//!   labelled verdict and reason.
//! * Every acceptance-mode fixture of a statement type the agent verifies
//!   (statements.json `verified_by.agent`) runs through the agent verifier on
//!   the same device context. The agent must reach the labelled verdict, with
//!   one rule taken from statements.json: a rejection whose reason the
//!   agent's `omits` list assigns to root alone is an acceptance for the
//!   agent. The agent's own version gates for the site config and the RBAC
//!   manifest stand at the device context's accepted statements, which is
//!   what they hold on such a device. Not run through the agent: fixtures of
//!   types the agent never verifies (the provisioning manifest, lifecycle
//!   statements), re-verification fixtures (a mode of root's
//!   `edge verify-current`, which compares with root's install receipt), and
//!   contexts with no recorded identity or no device (a factory-fresh device
//!   runs no agent: the unit starts only after an install receipt exists).
//! * The compiled-in contract tables (`registry.rs`) equal statements.json,
//!   boards.json, artifact-naming.json and common.schema.json.
//! * The DSSE PAE vectors match byte for byte and the signature vectors pin
//!   `verify_strict` semantics.
//!
//! `src/edge_contract/` depends on external crates only, so it is compiled
//! into this test crate as it is into the agent.

#[allow(dead_code)]
#[path = "../src/edge_contract/mod.rs"]
mod edge_contract;

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use edge_contract::dsse::{Envelope, pae, verify_strict};
use edge_contract::encoding::{
    decode_base64_array, decode_canonical_base64, hex_lower, parse_version_core,
};
use edge_contract::keys::{KeyEntry, KeyStore, is_admissible_key};
use edge_contract::registry::{
    AgentProfile, Arch, BindingMethod, BoardProfile, CargoFeature, EqualSeq, Purpose, Reason,
    SitePath, StatementType, VERIFICATION_ORDER, naming,
};
use edge_contract::statements::DeviceBinding;
use edge_contract::verify::{
    Accepted, AgentDevice, Identity, OsCompat, Scope, SiteFiles, verify_rbac_with_bundle,
    verify_receipt, verify_release, verify_site_config_with_bundle, verify_trust_anchors,
};
use serde_json::Value;

fn contract() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../contracts/suderra-edge/v1")
}

fn load(rel: &str) -> Value {
    let path = contract().join(rel);
    serde_json::from_slice(
        &std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display())),
    )
    .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn fixture(rel: &str) -> Vec<u8> {
    let path = contract().join("fixtures").join(rel);
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap_or_else(|| panic!("not an array: {v}"))
        .iter()
        .map(|s| s.as_str().unwrap().to_owned())
        .collect()
}

fn set<T: AsRef<str>>(items: impl IntoIterator<Item = T>) -> BTreeSet<String> {
    items.into_iter().map(|s| s.as_ref().to_owned()).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    assert!(text.len() % 2 == 0, "odd hex length");
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

/// OS image pins of the fixtures' simulated device (keyring fixture_anchor).
fn os_pins() -> KeyStore {
    let ring = load("test-keys/keyring.json");
    KeyStore::from_entries(
        ring["keys"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|k| k["fixture_anchor"] == "os-image")
            .map(|k| KeyEntry {
                purpose: Purpose::parse(k["purpose"].as_str().unwrap()).unwrap(),
                epoch: u16::try_from(k["epoch"].as_u64().unwrap()).unwrap(),
                raw: decode_base64_array::<32>(k["public_key"].as_str().unwrap()).unwrap(),
            }),
    )
    .unwrap()
}

/// The agent's view of a fixture device context: `None` when the context
/// has no device or no recorded identity (no agent runs there).
struct AgentContext {
    device: AgentDevice,
    gates: BTreeMap<StatementType, Accepted>,
    os: OsCompat,
}

fn agent_context(index: &Value, name: &str) -> Option<AgentContext> {
    let ctx = &index["device_contexts"][name];
    assert!(ctx.is_object(), "unknown device context {name}");
    let identity = match (ctx["tenant_id"].as_str(), ctx["device_id"].as_str()) {
        (Some(t), Some(d)) => Identity {
            tenant_id: t.to_owned(),
            device_id: d.to_owned(),
        },
        (None, None) => return None,
        other => panic!("{name}: half an identity {other:?}"),
    };
    let gates = ctx["accepted"]
        .as_object()
        .unwrap()
        .iter()
        .filter_map(|(t, a)| {
            let t = StatementType::parse(t).unwrap();
            // The agent keeps its own gate for these two types only
            // (statements.json verifiers.agent).
            matches!(t, StatementType::SiteConfig | StatementType::RbacManifest).then(|| {
                (
                    t,
                    Accepted {
                        seq: a["seq"].as_u64().unwrap(),
                        statement_digest: a["statement_digest"]["sha256"]
                            .as_str()
                            .unwrap()
                            .to_owned(),
                    },
                )
            })
        })
        .collect();
    let os = &ctx["os_release"];
    let version = parse_version_core(os["VERSION_ID"].as_str().unwrap()).unwrap();
    let (min, max) = os["SUDERRA_AGENT_ABI"]
        .as_str()
        .unwrap()
        .split_once('-')
        .unwrap();
    let kernel_config = ctx["kernel_config"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l.as_str().unwrap().split('=').next().unwrap().to_owned())
        .collect();
    Some(AgentContext {
        device: AgentDevice {
            board: BoardProfile::parse(ctx["board_profile"].as_str().unwrap()).unwrap(),
            arch: Arch::parse(ctx["arch"].as_str().unwrap()).unwrap(),
            binding: serde_json::from_value::<DeviceBinding>(ctx["device_binding"].clone())
                .unwrap(),
            identity,
        },
        gates,
        os: OsCompat {
            version,
            abi: (min.parse().unwrap(), max.parse().unwrap()),
            kernel_config,
        },
    })
}

/// The site bundle input (update channel): it stands in for the RBAC manifest
/// and the site files the site config names.
fn site_bundle(inputs: &Value) -> Option<Value> {
    inputs["site_bundle"]
        .as_str()
        .map(|rel| serde_json::from_slice(&fixture(rel)).unwrap())
}

fn envelope(inputs: &Value, name: &str) -> Envelope {
    if let (Some(bundle), "rbac_manifest") = (site_bundle(inputs), name) {
        return Envelope::parse(bundle["rbac_manifest"].to_string().as_bytes())
            .unwrap_or_else(|r| panic!("site bundle rbac_manifest: {r}"));
    }
    let rel = inputs[name]
        .as_str()
        .unwrap_or_else(|| panic!("fixture needs input {name}"));
    Envelope::parse(&fixture(rel)).unwrap_or_else(|r| panic!("input {rel}: {r}"))
}

fn site_files(inputs: &Value) -> SiteFiles {
    if let Some(bundle) = site_bundle(inputs) {
        return bundle["site_files"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(path, bytes)| {
                (
                    SitePath::parse(path).unwrap(),
                    decode_canonical_base64(bytes.as_str().unwrap()).unwrap(),
                )
            })
            .collect();
    }
    inputs["site_files"]
        .as_object()
        .map(|files| {
            files
                .iter()
                .map(|(path, rel)| {
                    (
                        SitePath::parse(path).unwrap(),
                        fixture(rel.as_str().unwrap()),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Reasons the agent verifier reports for one statement fixture.
fn run_agent(
    index: &Value,
    keys: &KeyStore,
    ctx: &AgentContext,
    entry: &Value,
) -> BTreeSet<Reason> {
    let scope = Scope {
        os_keys: keys,
        device: &ctx.device,
        gates: &ctx.gates,
        now: index["evaluation_time"].as_str().unwrap(),
    };
    let env = match Envelope::parse(&fixture(entry["path"].as_str().unwrap())) {
        Ok(env) => env,
        Err(reason) => return BTreeSet::from([reason]),
    };
    let inputs = &entry["inputs"];
    match StatementType::parse(entry["statement_type"].as_str().unwrap()).unwrap() {
        StatementType::EdgeRelease => verify_release(&env, &scope, &ctx.os).reasons,
        StatementType::TrustAnchors => verify_trust_anchors(&env, &scope).reasons,
        StatementType::RbacManifest => {
            verify_rbac_with_bundle(&env, &envelope(inputs, "trust_anchors"), &scope).reasons
        }
        StatementType::SiteConfig => {
            verify_site_config_with_bundle(
                &env,
                &envelope(inputs, "trust_anchors"),
                &scope,
                &envelope(inputs, "rbac_manifest"),
                &site_files(inputs),
            )
            .reasons
        }
        StatementType::EdgeActivationReceipt => verify_receipt(&env, &scope).reasons,
        other => panic!("the agent does not verify {other}"),
    }
}

/// The reasons a fixture is labelled with: its one `reason` and the `also`
/// reasons that follow from the one defect (fixture-index.schema.json). A
/// verifier stops at a failed verification_order step (schema-invalid) and
/// reports that reason alone.
fn labelled(entry: &Value) -> BTreeSet<Reason> {
    let parse = |text: &str| {
        Reason::parse(text).unwrap_or_else(|| panic!("unknown reason {text} in {entry}"))
    };
    match entry["expect"].as_str().unwrap() {
        "accept" => BTreeSet::new(),
        "reject" => {
            let reason = parse(entry["reason"].as_str().unwrap());
            let mut reasons = BTreeSet::from([reason]);
            if !VERIFICATION_ORDER.contains(&reason) {
                for also in entry["also"].as_array().into_iter().flatten() {
                    reasons.insert(parse(also.as_str().unwrap()));
                }
            }
            reasons
        }
        other => panic!("expect {other}"),
    }
}

fn describe(entry: &Value) -> String {
    format!(
        "{} [{} {} {} ctx={}]",
        entry["path"],
        entry["statement_type"],
        entry["verifier"],
        entry["mode"],
        entry["device_context"]
    )
}

#[test]
fn every_agent_statement_fixture_reaches_its_labelled_verdict() {
    let index = load("fixtures/index.json");
    let keys = os_pins();
    let mut failures = Vec::new();
    let mut ran = 0;
    for entry in index["statements"].as_array().unwrap() {
        if entry["verifier"] != "agent" {
            continue;
        }
        assert_eq!(entry["mode"], "accept", "{}", describe(entry));
        let ctx = agent_context(&index, entry["device_context"].as_str().unwrap())
            .unwrap_or_else(|| panic!("agent fixture without identity: {}", describe(entry)));
        ran += 1;
        let got = run_agent(&index, &keys, &ctx, entry);
        let want = labelled(entry);
        if got != want {
            failures.push(format!("{}: want {want:?}, got {got:?}", describe(entry)));
        }
    }
    assert!(ran >= 4, "only {ran} agent fixtures found");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn agent_verified_types_reach_the_contract_verdict_with_root_only_checks_omitted() {
    let index = load("fixtures/index.json");
    let keys = os_pins();
    let mut failures = Vec::new();
    let mut ran: BTreeMap<StatementType, usize> = BTreeMap::new();
    let mut omitted_rejections = 0;
    for entry in index["statements"].as_array().unwrap() {
        let t = StatementType::parse(entry["statement_type"].as_str().unwrap()).unwrap();
        let Some(omits) = t.spec().agent_omits else {
            continue;
        };
        if entry["verifier"] != "os-root" || entry["mode"] != "accept" {
            continue;
        }
        let Some(ctx) = entry["device_context"]
            .as_str()
            .and_then(|name| agent_context(&index, name))
        else {
            continue;
        };
        let mut want = labelled(entry);
        if want.iter().any(|r| omits.contains(r)) {
            want.clear();
            omitted_rejections += 1;
        }
        *ran.entry(t).or_default() += 1;
        let got = run_agent(&index, &keys, &ctx, entry);
        if got != want {
            failures.push(format!("{}: want {want:?}, got {got:?}", describe(entry)));
        }
    }
    for t in [
        StatementType::EdgeRelease,
        StatementType::TrustAnchors,
        StatementType::RbacManifest,
        StatementType::SiteConfig,
        StatementType::EdgeActivationReceipt,
    ] {
        assert!(
            ran.get(&t).copied().unwrap_or(0) >= 5,
            "too few {t} fixtures ran through the agent: {ran:?}"
        );
    }
    assert!(
        omitted_rejections >= 4,
        "only {omitted_rejections} root-only rejections seen"
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn a_trust_anchors_bundle_signed_by_the_provisioning_key_is_refused() {
    // P0 exit criterion (ADR-048 Implementation): the online provisioning
    // key is never the root of agent trust (DEC-3.7).
    let index = load("fixtures/index.json");
    let ctx = agent_context(&index, "revpi-active").unwrap();
    let scope = Scope {
        os_keys: &os_pins(),
        device: &ctx.device,
        gates: &ctx.gates,
        now: index["evaluation_time"].as_str().unwrap(),
    };
    let env = Envelope::parse(&fixture(
        "trust-anchors/invalid/wrong-purpose-key.dsse.json",
    ))
    .unwrap();
    let signer = os_pins().get(&env.keyid).cloned().expect("pinned signer");
    assert_eq!(signer.purpose, Purpose::EdgeProvisioning);
    assert_eq!(
        verify_trust_anchors(&env, &scope).reasons,
        BTreeSet::from([Reason::KeyPurposeMismatch])
    );
}

#[test]
fn an_identical_rbac_manifest_is_reaccepted_after_its_window_and_a_changed_one_is_not() {
    // EDGE-HIGH-059 / DEC-9.9: the gate accepts the manifest it already
    // accepted on every boot, even after the window that bounded its first
    // acceptance has closed, and refuses another manifest at that version.
    let index = load("fixtures/index.json");
    let ctx = agent_context(&index, "revpi-active").unwrap();
    let keys = os_pins();
    let ta = Envelope::parse(&fixture("trust-anchors/valid/bundle-seq-1.dsse.json")).unwrap();
    let policy_1 = Envelope::parse(&fixture(
        "rbac-manifest/valid/platform-actor-policy-1.dsse.json",
    ))
    .unwrap();
    let after_window = "2099-01-01T00:00:00Z";
    let scope = |now| Scope {
        os_keys: &keys,
        device: &ctx.device,
        gates: &ctx.gates,
        now,
    };
    let verdict = verify_rbac_with_bundle(&policy_1, &ta, &scope(after_window));
    let accepted = verdict.accepted().expect("identical manifest re-accepted");
    assert!(accepted.reverified);
    let changed = Envelope::parse(&fixture(
        "rbac-manifest/invalid/same-policy-version-changed.dsse.json",
    ))
    .unwrap();
    assert_eq!(
        verify_rbac_with_bundle(
            &changed,
            &ta,
            &scope(index["evaluation_time"].as_str().unwrap())
        )
        .reasons,
        BTreeSet::from([Reason::SequenceReplay])
    );
    // Without a gate record the same manifest is a first acceptance, whose
    // window does apply.
    let empty = BTreeMap::new();
    let fresh = Scope {
        os_keys: &keys,
        device: &ctx.device,
        gates: &empty,
        now: after_window,
    };
    assert_eq!(
        verify_rbac_with_bundle(&policy_1, &ta, &fresh).reasons,
        BTreeSet::from([Reason::Expired])
    );
}

// --------------------------------------------------------------- DSSE vectors

#[test]
fn pae_vectors_match_byte_for_byte() {
    let v = load("fixtures/dsse/pae-vectors.json");
    let vectors = v["vectors"].as_array().unwrap();
    assert!(!vectors.is_empty());
    for vector in vectors {
        let payload = decode_canonical_base64(vector["payload"].as_str().unwrap()).unwrap();
        assert_eq!(
            hex_lower(&pae(vector["payload_type"].as_str().unwrap(), &payload)),
            vector["pae_hex"].as_str().unwrap()
        );
    }
}

#[test]
fn signature_vectors_pin_verify_strict() {
    let v = load("fixtures/dsse/signature-vectors.json");
    let mut ids = BTreeSet::new();
    for vector in v["vectors"].as_array().unwrap() {
        let key: [u8; 32] = unhex(vector["public_key_hex"].as_str().unwrap())
            .try_into()
            .unwrap();
        let sig: [u8; 64] = unhex(vector["signature_hex"].as_str().unwrap())
            .try_into()
            .unwrap();
        let message = unhex(vector["message_hex"].as_str().unwrap());
        let id = vector["id"].as_str().unwrap();
        assert_eq!(
            verify_strict(&key, &message, &sig),
            vector["verify_strict"].as_bool().unwrap(),
            "{id}"
        );
        ids.insert(id.to_owned());
    }
    for required in [
        "non-canonical-s",
        "small-order-r",
        "non-canonical-a",
        "non-canonical-r",
    ] {
        assert!(ids.contains(required), "vector {required} missing");
    }
}

#[test]
fn a_key_store_admits_exactly_the_canonical_points_that_are_not_small_order() {
    // fixtures/dsse/point-vectors.json: no signature exists under a non-canonical
    // encoding of a full-order point, so the rule cannot be tested by verifying
    // anything; it is the admission of a key, which fails here when either term
    // of the rule is dropped. trust-anchors/invalid/anchor-non-canonical-key and
    // anchor-small-order-key pin it through the bundle verifier.
    let v = load("fixtures/dsse/point-vectors.json");
    let mut refused_for_form = 0;
    let mut refused_for_order = 0;
    let mut admitted = 0;
    for vector in v["vectors"].as_array().unwrap() {
        let id = vector["id"].as_str().unwrap();
        let point: [u8; 32] = unhex(vector["encoding_hex"].as_str().unwrap())
            .try_into()
            .unwrap();
        let canonical = vector["canonical"].as_bool().unwrap();
        let small_order = vector["small_order"].as_bool().unwrap();
        assert_eq!(is_admissible_key(&point), canonical && !small_order, "{id}");
        match (canonical, small_order) {
            (false, _) => refused_for_form += 1,
            (true, true) => refused_for_order += 1,
            (true, false) => admitted += 1,
        }
    }
    assert!(
        refused_for_form >= 10 && refused_for_order >= 3 && admitted >= 10,
        "vectors cover {refused_for_form} non-canonical, {refused_for_order} small-order and {admitted} admissible encodings"
    );
    // The rule must not refuse a key the fixtures sign with.
    for key in load("test-keys/keyring.json")["keys"].as_array().unwrap() {
        let raw = decode_base64_array::<32>(key["public_key"].as_str().unwrap()).unwrap();
        assert!(
            is_admissible_key(&raw),
            "test key {} is not admissible",
            key["keyid"]
        );
    }
}

// -------------------------------------------------------------- drift gates

#[test]
fn reasons_and_verification_order_match_the_contract() {
    let st = load("statements.json");
    let rejections = set(st["rejection_reasons"].as_object().unwrap().keys());
    assert_eq!(set(Reason::ALL.iter().map(|r| r.as_str())), rejections);
    assert_eq!(
        strings(&st["verification_order"]),
        VERIFICATION_ORDER.map(|r| r.as_str().to_owned()).to_vec()
    );
}

#[test]
fn statement_rows_match_the_contract() {
    let st = load("statements.json");
    let rows = st["statements"].as_object().unwrap();
    assert_eq!(
        set(rows.keys()),
        set(StatementType::ALL.iter().map(|t| t.as_str()))
    );
    for t in StatementType::ALL {
        let row = &rows[t.as_str()];
        let spec = t.spec();
        assert_eq!(row["payload_type"], t.payload_type(), "{t}");
        assert_eq!(row["signing_purpose"], spec.signing_purpose.as_str(), "{t}");
        assert_eq!(row["device_bound"], spec.device_bound, "{t}");
        assert_eq!(row["tenant_bound"], spec.tenant_bound, "{t}");
        assert_eq!(
            strings(&row["checks"]),
            spec.checks
                .iter()
                .map(|r| r.as_str().to_owned())
                .collect::<Vec<_>>(),
            "{t}"
        );
        assert_eq!(
            strings(&row["nested"]),
            spec.nested
                .iter()
                .map(|n| n.as_str().to_owned())
                .collect::<Vec<_>>(),
            "{t}"
        );
        match (&row["sequence"], spec.sequence) {
            (Value::Null, None) => {}
            (seq, Some(rule)) => {
                assert_eq!(seq["field"], rule.field, "{t}");
                let equal = match rule.equal {
                    EqualSeq::Reject => "reject",
                    EqualSeq::IdenticalOnly => "identical-only",
                };
                assert_eq!(seq["equal_seq"], equal, "{t}");
            }
            (other, rule) => panic!("{t}: sequence {other} vs {rule:?}"),
        }
        match (row["verified_by"].get("agent"), spec.agent_omits) {
            (None, None) => {}
            (Some(agent), Some(omits)) => {
                assert_eq!(
                    set(strings(&agent["omits"])),
                    set(omits.iter().map(|r| r.as_str())),
                    "{t}"
                );
                // The agent verifier takes no ratchet input at all; that is
                // conforming only while every agent-verified type omits it.
                assert!(omits.contains(&Reason::KeyEpochBelowRatchet), "{t}");
            }
            (agent, omits) => panic!("{t}: verified_by.agent {agent:?} vs {omits:?}"),
        }
        let schema = load(row["schema"].as_str().unwrap());
        assert_eq!(schema["properties"]["_type"]["const"], t.as_str(), "{t}");
    }
}

#[test]
fn purposes_match_the_contract() {
    let st = load("statements.json");
    let purposes = st["purposes"].as_object().unwrap();
    assert_eq!(
        set(purposes.keys()),
        set(Purpose::ALL.iter().map(|p| p.as_str()))
    );
    for p in Purpose::ALL {
        let row = &purposes[p.as_str()];
        let anchored = set(strings(&row["anchored_in"]));
        assert_eq!(
            anchored.contains("os-image"),
            p.anchored_in_os_image(),
            "{p}"
        );
        assert_eq!(
            anchored.contains("trust-anchors-bundle"),
            p.anchored_in_bundle(),
            "{p}"
        );
        assert_eq!(row["algorithm"], p.algorithm(), "{p}");
    }
}

#[test]
fn boards_vocabularies_and_naming_match_the_contract() {
    let boards = load("boards.json");
    let rows = boards["boards"].as_array().unwrap();
    assert_eq!(
        set(rows.iter().map(|r| r["board_profile"].as_str().unwrap())),
        set(BoardProfile::ALL.iter().map(|b| b.as_str()))
    );
    for row in rows {
        let board = BoardProfile::parse(row["board_profile"].as_str().unwrap()).unwrap();
        let spec = board.spec();
        assert_eq!(row["arch"], spec.arch.as_str(), "{board}");
        assert_eq!(row["agent_profile"], spec.agent_profile.as_str(), "{board}");
        assert_eq!(
            set(strings(&row["cargo_features"])),
            set(spec.cargo_features.iter().map(|f| f.as_str())),
            "{board}"
        );
        assert_eq!(
            row["device_binding_method"],
            spec.device_binding_method.as_str(),
            "{board}"
        );
    }
    let common = load("schemas/common.schema.json");
    let defs = &common["$defs"];
    let enum_set = |name: &str| set(strings(&defs[name]["enum"]));
    assert_eq!(
        enum_set("board_profile"),
        set(BoardProfile::ALL.iter().map(|b| b.as_str()))
    );
    assert_eq!(enum_set("arch"), set(Arch::ALL.iter().map(|b| b.as_str())));
    assert_eq!(
        enum_set("agent_profile"),
        set(AgentProfile::ALL.iter().map(|b| b.as_str()))
    );
    assert_eq!(
        enum_set("cargo_feature"),
        set(CargoFeature::ALL.iter().map(|b| b.as_str()))
    );
    assert_eq!(
        enum_set("site_path"),
        set(SitePath::ALL.iter().map(|b| b.as_str()))
    );
    assert_eq!(
        set(strings(
            &defs["device_binding"]["properties"]["method"]["enum"]
        )),
        set(BindingMethod::ALL.iter().map(|b| b.as_str()))
    );

    let naming_file = load("artifact-naming.json");
    let os = &naming_file["suderra_os_channel"];
    assert_eq!(os["artifact"], naming::ARTIFACT_TEMPLATE);
    assert_eq!(os["statement"], naming::STATEMENT_TEMPLATE);
    assert_eq!(os["format"], naming::FORMAT);
    assert_eq!(os["binary_name"], naming::BINARY_NAME);
    assert_eq!(
        strings(&os["archive_members"]),
        naming::ARCHIVE_MEMBERS.to_vec()
    );
}

#[test]
fn rbac_permission_vocabulary_matches_the_schema() {
    use edge_contract::statements::{PARAMETERISED_PERMISSIONS, PLAIN_PERMISSIONS};
    let schema = load("schemas/rbac-manifest.schema.json");
    let permission = &schema["$defs"]["permission"];
    let text = permission.to_string();
    for name in PLAIN_PERMISSIONS
        .iter()
        .chain(PARAMETERISED_PERMISSIONS.iter())
    {
        assert!(
            text.contains(&format!("\"{name}\"")),
            "{name} not in $defs/permission"
        );
    }
    // The two-person-integrity class can never appear in a 1.x manifest
    // (DEC-9.4); tests/invariants/tpi_commands_rejected_without_co_approver.rs
    // ties this list to the agent's Permission enum.
    for tpi in [
        "UpdateFirmware",
        "DeployProgram",
        "ForceValue",
        "SafeStateTrigger",
        "Reboot",
        "OpcUaWrite",
        "S7Write",
    ] {
        assert!(
            !text.contains(&format!("\"{tpi}\"")),
            "{tpi} grantable by the schema"
        );
        assert!(!PLAIN_PERMISSIONS.contains(&tpi) && !PARAMETERISED_PERMISSIONS.contains(&tpi));
    }
}
