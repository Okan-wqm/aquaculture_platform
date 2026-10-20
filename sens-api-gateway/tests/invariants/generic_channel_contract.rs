#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]
//! ADR-048 DEC-28 — the generic-Linux channel's release contract is frozen.
//!
//! The v1.6.0 fleet runs on generic Linux, installed and updated by the
//! cloud's `curl | bash` installer from GitHub release assets. The contract
//! (`contracts/suderra-edge/v1/artifact-naming.json` `generic_channel`)
//! fixes those names: `suderra-agent-{version}-{slug}.tar.gz` for the slugs
//! x86_64-linux, aarch64-linux and armv7-linux, with the binary `edge-agent`
//! inside. Three producers and consumers must agree with it:
//!
//! * the release workflow (`.github/workflows/edge-agent-release.yml`)
//!   builds exactly those targets and packs exactly that name;
//! * the cloud's generic installer and update scripts
//!   (`apps/sensor-service/src/edge-device/installer-script.service.ts`)
//!   map `uname -m` onto exactly those slugs and fetch exactly that name;
//! * the agent consumes none of them: its legacy tarball OTA, which asked
//!   for `suderra-agent-<arch>-unknown-linux-gnu.tar.gz` and so could never
//!   find a release, is removed (SENSOR-MEDIUM-223), and nothing in it
//!   downloads a GitHub release.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;

#[path = "source_scan_support/mod.rs"]
mod source_scan_support;

fn repo() -> PathBuf {
    source_scan_support::crate_root().join("..")
}

fn read(rel: &str) -> String {
    std::fs::read_to_string(repo().join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

fn generic_channel() -> Value {
    let naming: Value =
        serde_json::from_str(&read("contracts/suderra-edge/v1/artifact-naming.json")).unwrap();
    naming["generic_channel"].clone()
}

/// slug → Rust target of the contract.
fn contract_slugs() -> BTreeMap<String, String> {
    generic_channel()["slugs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["slug"].as_str().unwrap().to_owned(),
                s["rust_target"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn artifact_template() -> String {
    generic_channel()["artifact"].as_str().unwrap().to_owned()
}

const WORKFLOW: &str = ".github/workflows/edge-agent-release.yml";
const INSTALLER: &str = "apps/sensor-service/src/edge-device/installer-script.service.ts";

#[test]
fn the_release_workflow_builds_and_names_exactly_the_contract_artifacts() {
    let text = read(WORKFLOW);
    let workflow: serde_yaml::Value = serde_yaml::from_str(&text).unwrap();

    // The build matrix: target_slug → target.
    let mut built = BTreeMap::new();
    for (_, job) in workflow["jobs"].as_mapping().unwrap() {
        let Some(include) = job["strategy"]["matrix"]["include"].as_sequence() else {
            continue;
        };
        for row in include {
            if let (Some(slug), Some(target)) =
                (row["target_slug"].as_str(), row["target"].as_str())
            {
                built.insert(slug.to_owned(), target.to_owned());
            }
        }
    }
    assert_eq!(built, contract_slugs(), "{WORKFLOW} build matrix");

    // The packed binary and the archive name.
    let env = &workflow["env"];
    assert_eq!(
        env["ARCHIVE_BINARY_NAME"].as_str(),
        generic_channel()["binary_name"].as_str(),
        "the binary inside the archive"
    );
    let binary_name = env["BINARY_NAME"].as_str().unwrap();
    let base = text
        .lines()
        .map(str::trim)
        .find_map(|l| l.strip_prefix("ARCHIVE_BASE="))
        .expect("ARCHIVE_BASE assignment")
        .trim_matches('"');
    let archive = format!("{base}.tar.gz")
        .replace("${BINARY_NAME}", binary_name)
        .replace("${RELEASE_VERSION}", "{version}")
        .replace("${TARGET_SLUG}", "{slug}");
    assert_eq!(archive, artifact_template());
    assert!(
        text.contains(
            r#"tar -czf "${ARCHIVE_BASE}.tar.gz" -C "${STAGING_DIR}" "${ARCHIVE_BINARY_NAME}""#
        ),
        "the archive holds the binary under ARCHIVE_BINARY_NAME"
    );
}

#[test]
fn the_cloud_generic_installer_fetches_exactly_the_contract_artifacts() {
    let text = read(INSTALLER);

    // Every tarball the scripts fetch is the contract name.
    let tarballs: Vec<String> = text
        .lines()
        .map(str::trim)
        .filter_map(|l| l.strip_prefix("TARBALL="))
        .map(|v| {
            v.trim_matches('"')
                .replace("\\$", "$")
                .replace("${RELEASE_VERSION}", "{version}")
                .replace("${TARGET_SLUG}", "{slug}")
        })
        .collect();
    assert!(
        tarballs.len() >= 2,
        "install and update scripts: {tarballs:?}"
    );
    for t in &tarballs {
        assert_eq!(t, &artifact_template());
    }

    // Every `uname -m` → slug table maps onto exactly the contract slugs.
    let slugs: Vec<String> = contract_slugs().into_keys().collect();
    let mut tables = Vec::new();
    let mut current: Vec<String> = Vec::new();
    for line in text.lines().map(str::trim) {
        let slug = line
            .split_once(')')
            .and_then(|(_, rest)| rest.trim().strip_prefix("TARGET_SLUG=\""))
            .and_then(|r| r.split_once('"'))
            .map(|(s, _)| s.to_owned());
        match slug {
            Some(slug) => current.push(slug),
            None if line == "esac" && !current.is_empty() => {
                current.sort();
                tables.push(std::mem::take(&mut current));
            }
            None => {}
        }
    }
    assert!(tables.len() >= 2, "install and update scripts: {tables:?}");
    for table in &tables {
        assert_eq!(table, &slugs);
    }

    // The binary the scripts take out of the archive.
    let binary = generic_channel()["binary_name"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(text.contains(&format!("\"$WORK_DIR/{binary}\"")));
    assert!(text.contains(&format!("\"$INSTALL_DIR/{binary}\"")));
}

#[test]
fn the_agent_consumes_no_generic_channel_artifact() {
    let slugs: Vec<String> = contract_slugs().into_keys().collect();
    let mut stray = Vec::new();
    for file in source_scan_support::scan_src() {
        for lit in &file.literals {
            let t = &lit.text;
            let generic_name = t.contains("unknown-linux-gnu.tar.gz")
                || slugs.iter().any(|s| t.contains(&format!("{s}.tar.gz")));
            let release_download = t.contains("releases/download") || t.contains("api.github.com");
            if generic_name || release_download {
                stray.push(format!("{}:{}: {t:?}", file.rel, lit.line));
            }
        }
    }
    assert!(
        stray.is_empty(),
        "the agent must not fetch generic-channel releases (DEC-2, DEC-28):\n{}",
        stray.join("\n")
    );
}
