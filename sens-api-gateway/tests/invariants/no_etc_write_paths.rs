#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]

//! ADR-048 DEC-4.1, DEC-4.2, DEC-4.5, DEC-4.11, DEC-24 — the agent's
//! filesystem contract, checked at build time.
//!
//! * **Suderra OS profile** (`--features suderra-os`): every path constant
//!   of `src/paths.rs` is checked against the cross-repo contract
//!   (`contracts/suderra-edge/v1/mutable-state.json` and
//!   `unit-directives.json`): the directories the agent may write are
//!   exactly the agent `read-write` entries of the mutable-state table and
//!   exactly the unit's `ReadWritePaths=`; the config and RBAC manifest are
//!   files of the read-only site bind (`ReadOnlyPaths=`); and every
//!   artifact path the agent writes resolves strictly inside a writable
//!   directory — nothing under `/etc`, nothing on the read-only root.
//! * **Both profiles**: production source names no `/etc/...` path except
//!   the allowlisted read-side anchors below, and no
//!   `/var/lib/suderra`, `/var/log/suderra` or `/run/suderra` path outside
//!   the path SSoT, so a new store cannot pick its own location (the way
//!   the RBAC manifest, the I/O map and the scripts once picked
//!   `/etc/suderra`, EDGE-HIGH-050) without failing here.
//!
//! `src/paths.rs` (and, in the generic profile, `src/generic_env.rs`) are
//! compiled into this test crate; both depend on `std` alone.

#[path = "source_scan_support/mod.rs"]
mod source_scan_support;

#[cfg(not(feature = "suderra-os"))]
#[allow(dead_code)]
#[path = "../../src/generic_env.rs"]
mod generic_env;

#[allow(dead_code)]
#[path = "../../src/paths.rs"]
mod paths;

#[cfg(feature = "suderra-os")]
use std::collections::BTreeSet;
#[cfg(feature = "suderra-os")]
use std::path::Path;

/// `/etc/...` literals production code may name, each with the reason it
/// is not a write path. Paths are matched as prefixes of the literal.
const ETC_LITERAL_ALLOWLIST: &[(&str, &str, &str)] = &[
    (
        "src/paths.rs",
        "/etc/suderra",
        "generic-profile read-only operator directory (config.yaml, legacy db.key, keystore \
         material, legacy RBAC manifest and scripts); the contract's generic unit mounts it \
         ReadOnlyPaths= and the agent only reads it (DEC-28)",
    ),
    (
        "src/paths.rs",
        "/etc/revpi/config.rsc",
        "generic-profile PiCtory file the KUNBUS piControl driver loaded; the agent only \
         reads it to resolve its signed point list against the driver (DEC-8.8). Under \
         Suderra OS the file is signed site material and no /etc path is named",
    ),
];

/// Files outside the path SSoT that may still name an agent data path,
/// with the reason. Starts empty.
const DATA_LITERAL_ALLOWLIST: &[(&str, &str, &str)] = &[];

/// Prefixes of the agent's data, log and runtime trees.
const DATA_PREFIXES: &[&str] = &["/var/lib/suderra", "/var/log/suderra", "/run/suderra"];

fn allowed(list: &[(&str, &str, &str)], rel: &str, literal: &str) -> bool {
    list.iter()
        .any(|(file, prefix, _)| *file == rel && literal.starts_with(prefix))
}

#[test]
fn production_source_names_no_etc_path_outside_the_allowlist() {
    let mut violations = Vec::new();
    for file in source_scan_support::scan_src() {
        for lit in &file.literals {
            let text = lit.text.as_str();
            if (text == "/etc" || text.starts_with("/etc/"))
                && !allowed(ETC_LITERAL_ALLOWLIST, &file.rel, text)
            {
                violations.push(format!("{}:{}: {:?}", file.rel, lit.line, text));
            }
        }
    }
    assert!(
        violations.is_empty(),
        "production code names /etc paths (ADR-048 DEC-4.1: the agent never writes /etc; \
         route the path through src/paths.rs or allowlist a read-only anchor with a \
         reason):\n{}",
        violations.join("\n")
    );
}

#[test]
fn agent_data_paths_are_named_only_by_the_path_ssot() {
    let mut violations = Vec::new();
    for file in source_scan_support::scan_src() {
        if file.rel == "src/paths.rs" {
            continue;
        }
        for lit in &file.literals {
            let text = lit.text.as_str();
            if DATA_PREFIXES.iter().any(|p| text.starts_with(p))
                && !allowed(DATA_LITERAL_ALLOWLIST, &file.rel, text)
            {
                violations.push(format!("{}:{}: {:?}", file.rel, lit.line, text));
            }
        }
    }
    assert!(
        violations.is_empty(),
        "agent data paths hardcoded outside src/paths.rs (ADR-048 DEC-4.5: one \
         resolver):\n{}",
        violations.join("\n")
    );
}

#[test]
fn allowlist_entries_are_still_needed() {
    let files = source_scan_support::scan_src();
    for (list, name) in [
        (ETC_LITERAL_ALLOWLIST, "ETC_LITERAL_ALLOWLIST"),
        (DATA_LITERAL_ALLOWLIST, "DATA_LITERAL_ALLOWLIST"),
    ] {
        for (file, prefix, _) in list {
            let used = files
                .iter()
                .any(|f| f.rel == *file && f.literals.iter().any(|l| l.text.starts_with(prefix)));
            assert!(
                used,
                "{name} entry ({file}, {prefix}) matches nothing; remove it"
            );
        }
    }
}

/// Agent-written paths that still resolve under `/etc`, each tied to its
/// tracked finding and to the production code that performs the write:
/// (path, source file, code evidence, finding). An entry whose evidence is
/// gone fails the test, so the exception cannot outlive its finding.
#[cfg(not(feature = "suderra-os"))]
const KNOWN_ETC_WRITES: &[(&str, &str, &str, &str)] = &[(
    "/etc/suderra/config.yaml",
    "src/config.rs",
    "pub fn save(",
    "EDGE-HIGH-055: AgentConfig::save (the HC-1 config topic and the Modbus provision / \
     decommission commands) rewrites the operator's config.yaml in place; under the generic \
     reference unit (ReadOnlyPaths=/etc/suderra) those commands fail",
)];
/// The Suderra OS profile has no exception.
#[cfg(feature = "suderra-os")]
const KNOWN_ETC_WRITES: &[(&str, &str, &str, &str)] = &[];

/// Nothing the agent writes resolves under `/etc`, in either profile, except
/// the tracked [`KNOWN_ETC_WRITES`] — and each of those is still real.
#[test]
fn nothing_the_agent_writes_resolves_under_etc() {
    let files = source_scan_support::scan_src();
    for (path, file, evidence, finding) in KNOWN_ETC_WRITES {
        assert!(
            files
                .iter()
                .any(|f| f.rel == *file && f.code.contains(evidence)),
            "{path}: `{evidence}` is gone from {file} — {finding} is fixed; remove the exception"
        );
    }
    for path in written_paths(&profile_paths()) {
        if KNOWN_ETC_WRITES
            .iter()
            .any(|(known, ..)| path == std::path::Path::new(known))
        {
            continue;
        }
        assert!(
            !path.starts_with("/etc"),
            "{} is agent-written and must not live under /etc (DEC-4.1)",
            path.display()
        );
    }
}

#[cfg(feature = "suderra-os")]
fn profile_paths() -> paths::AgentPaths {
    paths::AgentPaths::suderra_os()
}

#[cfg(not(feature = "suderra-os"))]
fn profile_paths() -> paths::AgentPaths {
    paths::AgentPaths::generic(paths::GenericOverrides::default())
}

/// Every artifact the agent writes; directories through a child, because
/// the writable roots themselves belong to the OS (DEC-4.3).
fn written_paths(p: &paths::AgentPaths) -> Vec<std::path::PathBuf> {
    #[allow(unused_mut)]
    let mut out = vec![
        p.activation_state_file(),
        p.db_key_file(),
        p.offline_queue_db(),
        p.scripts_dir().join("script.json"),
        p.retain_db(),
        p.program_state_file(),
        p.license_cache_db(),
        p.jti_dedup_db(),
        p.rbac_version_db(),
        p.user_token_version_db(),
        p.keystore_rotation_marker("keystore_rotation_marker.json"),
        p.backup_dir().join("backup.tar"),
        p.scada_dir().join("process.json"),
        p.scada_db(),
        p.lora_sessions_db(),
        p.opcua_own_pki_dir().join("cert.der"),
        p.opcua_trusted_certs_dir().join("client.der"),
        p.audit_log_file(),
    ];
    // ADR-048 DEC-2: the agent's A/B state exists only where the agent
    // updates itself.
    #[cfg(not(feature = "os-managed-updates"))]
    out.push(p.partition_store_file());
    #[cfg(not(feature = "suderra-os"))]
    {
        out.push(p.rbac_manifest_persist_file());
        out.push(p.io_config_file());
        out.push(p.config_integrity_floor_dir().join("floor.json"));
        // EDGE-HIGH-055 (KNOWN_ETC_WRITES): AgentConfig::save.
        out.push(p.config_file().to_path_buf());
    }
    #[cfg(feature = "suderra-os")]
    {
        out.push(p.activation_receipt_file());
        out.push(p.lifecycle_request_file());
        out.push(p.rbac_gate_file());
        out.push(p.site_config_gate_file());
        out.push(p.update_requests_dir().join("request.dsse"));
    }
    out
}

// ---------------------------------------------------------------------------
// Suderra OS profile: the constants are the contract
// ---------------------------------------------------------------------------

#[cfg(feature = "suderra-os")]
fn contract(name: &str) -> serde_json::Value {
    let path = source_scan_support::crate_root()
        .join("../contracts/suderra-edge/v1")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read contract {}: {e}", path.display()));
    serde_json::from_str(&text).expect("contract JSON")
}

#[cfg(feature = "suderra-os")]
fn mutable_state_entries() -> Vec<serde_json::Value> {
    contract("mutable-state.json")["entries"]
        .as_array()
        .expect("entries")
        .clone()
}

#[cfg(feature = "suderra-os")]
fn entry(path: &str) -> serde_json::Value {
    mutable_state_entries()
        .into_iter()
        .find(|e| e["path"] == path)
        .unwrap_or_else(|| panic!("mutable-state.json has no entry for {path}"))
}

#[cfg(feature = "suderra-os")]
fn unit_profile_service() -> serde_json::Value {
    contract("unit-directives.json")["profiles"]["suderra-os"]["exact"]["Service"].clone()
}

#[cfg(feature = "suderra-os")]
fn strings(v: &serde_json::Value) -> BTreeSet<String> {
    v.as_array()
        .expect("array")
        .iter()
        .map(|s| s.as_str().expect("string").to_string())
        .collect()
}

#[cfg(feature = "suderra-os")]
#[test]
fn writable_dirs_are_exactly_the_contract_read_write_entries() {
    let ours: BTreeSet<String> = paths::suderra_os::WRITABLE_DIRS
        .iter()
        .map(|s| s.to_string())
        .collect();
    let table: BTreeSet<String> = mutable_state_entries()
        .iter()
        .filter(|e| e["writer"] == "agent" && e["agent_access"] == "read-write")
        .map(|e| e["path"].as_str().expect("path").to_string())
        .collect();
    assert_eq!(
        ours, table,
        "WRITABLE_DIRS vs mutable-state.json agent read-write entries"
    );
    let unit = strings(&unit_profile_service()["ReadWritePaths"]);
    assert_eq!(
        ours, unit,
        "WRITABLE_DIRS vs unit-directives.json ReadWritePaths="
    );
    for dir in &ours {
        assert!(!dir.starts_with("/etc"), "{dir} is under /etc");
    }
}

#[cfg(feature = "suderra-os")]
#[test]
fn site_files_are_read_only_site_material_of_the_contract() {
    let site = entry("/var/lib/suderra-site");
    assert_eq!(site["agent_access"], "read-only-bind");
    let contents = strings(&site["contents"]);
    for file in [
        paths::suderra_os::CONFIG_FILE,
        paths::suderra_os::RBAC_MANIFEST_FILE,
        paths::suderra_os::TRUST_ANCHORS_FILE,
    ] {
        let path = Path::new(file);
        assert_eq!(
            path.parent(),
            Some(Path::new("/var/lib/suderra-site")),
            "{file} must be in the site bind"
        );
        let name = path.file_name().expect("file name").to_string_lossy();
        assert!(
            contents.contains(name.as_ref()),
            "{name} is not site material"
        );
    }
    let read_only = strings(&unit_profile_service()["ReadOnlyPaths"]);
    assert_eq!(
        read_only,
        BTreeSet::from(["/var/lib/suderra-site".to_string()]),
        "unit ReadOnlyPaths="
    );
    let p = paths::AgentPaths::suderra_os();
    assert!(p.check_agent_writable(p.config_file()).is_err());
    assert!(p.check_agent_writable(&p.rbac_manifest_file()).is_err());
    assert!(p.check_agent_writable(&p.trust_anchors_file()).is_err());
}

#[cfg(feature = "suderra-os")]
#[test]
fn trust_inputs_are_root_owned_read_only_contract_locations() {
    // DEC-3.4 / DEC-3.6: the key pins live on the verity rootfs and the
    // identity on root's tmpfs; the agent reads both and writes neither.
    let p = paths::AgentPaths::suderra_os();
    assert!(p.key_pins_dir().starts_with("/etc/suderra"));
    assert!(
        p.check_agent_writable(&p.key_pins_dir().join("fleet-root/1.pub"))
            .is_err()
    );
    let identity = p.identity_file();
    assert!(p.check_agent_writable(&identity).is_err());
    let run = entry("/run/suderra");
    assert_eq!(run["writer"], "os-root");
    assert_eq!(run["agent_access"], "read");
    let name = identity.file_name().expect("file name").to_string_lossy();
    assert!(strings(&run["contents"]).contains(name.as_ref()));
    // DEC-7.3: root's clock state is the agent's only clock authority, a
    // read-only file of the same tmpfs.
    let time_state = p.time_state_file();
    assert!(p.check_agent_writable(&time_state).is_err());
    assert_eq!(time_state.parent(), identity.parent());
    let name = time_state.file_name().expect("file name").to_string_lossy();
    assert!(strings(&run["contents"]).contains(name.as_ref()));
    // The receipt and the lifecycle request are named state contents.
    let state = strings(&entry(paths::suderra_os::STATE_DIR)["contents"]);
    for file in [p.activation_receipt_file(), p.lifecycle_request_file()] {
        let name = file.file_name().expect("file name").to_string_lossy();
        assert!(state.contains(name.as_ref()), "{name} is not a state file");
    }
}

/// DEC-4.10: the site config and every statement the agent verifies with
/// it are files of the read-only site bind the contract names; the agent's
/// site-config gate is policy-cache content.
#[cfg(feature = "suderra-os")]
#[test]
fn the_site_config_is_read_only_site_material_and_its_gate_is_in_the_policy_cache() {
    let p = paths::AgentPaths::suderra_os();
    assert_eq!(p.site_dir(), Path::new(paths::suderra_os::SITE_DIR));
    let site = strings(&entry(paths::suderra_os::SITE_DIR)["contents"]);
    for file in [
        p.site_config_file(),
        p.rbac_manifest_file(),
        p.trust_anchors_file(),
        p.config_file().to_path_buf(),
    ] {
        let name = file
            .strip_prefix(paths::suderra_os::SITE_DIR)
            .expect("in the site directory")
            .to_string_lossy()
            .into_owned();
        assert!(site.contains(&name), "{name} is not named site material");
        assert!(p.check_agent_writable(&file).is_err(), "{name} is writable");
    }
    let cache = strings(&entry(paths::suderra_os::POLICY_CACHE_DIR)["contents"]);
    assert!(
        cache
            .iter()
            .any(|c| c.starts_with("site-config version gate")),
        "{cache:?}"
    );
    assert!(
        p.site_config_gate_file()
            .starts_with(paths::suderra_os::POLICY_CACHE_DIR)
    );
}

#[cfg(feature = "suderra-os")]
#[test]
fn data_and_log_roots_are_the_contract_entries() {
    let data = entry(paths::suderra_os::DATA_ROOT);
    assert_eq!(data["writer"], "agent");
    assert_eq!(
        data["agent_access"], "read",
        "the agent writes only its subdirectories"
    );
    let log = entry(paths::suderra_os::LOG_DIR);
    assert_eq!(log["agent_access"], "read-write");
    assert!(strings(&log["contents"]).contains("audit.log"));
    let state = entry(paths::suderra_os::STATE_DIR);
    assert!(strings(&state["contents"]).contains("activation.json"));
    let secrets = entry(paths::suderra_os::SECRETS_DIR);
    assert!(strings(&secrets["contents"]).contains("db.key"));
    assert_eq!(secrets["mode"], "0700");
    assert_eq!(secrets["file_mode"], "0400");
}

#[cfg(feature = "suderra-os")]
#[test]
fn every_agent_written_path_is_strictly_inside_a_writable_dir() {
    let p = paths::AgentPaths::suderra_os();
    for path in written_paths(&p) {
        assert!(
            p.check_agent_writable(&path).is_ok(),
            "{} is outside the contract's agent-writable directories",
            path.display()
        );
    }
}
