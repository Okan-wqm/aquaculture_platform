#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]
//! ADR-048 DEC-2 — when the OS manages updates the agent has no updater.
//!
//! RAUC/suderra-ota updates the OS image and the root installer updates the
//! agent binary (DEC-2.1, DEC-2.2). The agent writes no binary, boot
//! configuration or bootloader flag and manages no service, so the feature
//! `os-managed-updates` (implied by `suderra-os`) compiles out:
//!
//! * `src/updater/` — the A/B partition store, the tryboot writer of
//!   `/boot/firmware/autoboot.txt` and the cold-boot watchdog;
//! * the `apply_signed_manifest`, `confirm_slot` and
//!   `verify_signed_manifest` commands, the `--confirm-active` CLI and the
//!   `/lifecycle/confirm-active` endpoint;
//! * the `reboot` and `restart_agent` commands (DEC-2.1).
//!
//! The legacy tarball OTA (`/opt/suderra/edge-agent`) is gone from every
//! profile (DEC-28). The checks run on the agent binary this test run built
//! — its strings and symbol names — as well as on the source, so a path that
//! slips back in through another module is caught where it matters.

#[path = "source_scan_support/mod.rs"]
mod source_scan_support;

use source_scan_support::{crate_root, scan_src};

const OMU: &str = "#[cfg(not(feature = \"os-managed-updates\"))]";

/// Strings only the agent's own updater, slot confirmation and service
/// control put into the binary.
fn updater_strings() -> Vec<&'static str> {
    let mut s = vec!["/boot/firmware/autoboot.txt", "--confirm-active"];
    if cfg!(feature = "health") {
        s.push("/lifecycle/confirm-active");
    }
    s
}

/// Symbol path segments (`<len><ident>`, the form both Rust mangling
/// schemes use) of the agent's updater module and of the handlers that are
/// not compiled when the OS manages updates.
fn updater_symbols() -> Vec<String> {
    let seg = |s: &str| format!("{}{}", s.len(), s);
    let mut v = vec![format!("{}{}", seg("suderra_agent"), seg("updater"))];
    for handler in [
        "cmd_reboot",
        "cmd_restart_agent",
        "cmd_confirm_slot",
        "cmd_verify_signed_manifest",
        "cmd_apply_signed_manifest",
        "run_confirm_active",
    ] {
        v.push(seg(handler));
    }
    v
}

fn agent_binary() -> Vec<u8> {
    std::fs::read(env!("CARGO_BIN_EXE_suderra-agent")).expect("read the agent binary")
}

fn present(bin: &[u8], needles: &[String]) -> Vec<String> {
    let set = regex::bytes::RegexSet::new(needles.iter().map(|n| regex::escape(n)))
        .expect("literal patterns");
    set.matches(bin)
        .into_iter()
        .map(|i| needles[i].clone())
        .collect()
}

#[test]
fn the_agent_binary_has_an_updater_exactly_where_it_updates_itself() {
    let bin = agent_binary();
    // The symbol checks need the symbol table of the test profile's build.
    let crate_segment = format!("{}suderra_agent", "suderra_agent".len());
    assert!(
        !present(&bin, &[crate_segment]).is_empty(),
        "the agent binary carries no symbols; run this test in the dev/test profile"
    );
    let mut needles: Vec<String> = updater_strings().into_iter().map(String::from).collect();
    needles.extend(updater_symbols());
    let found = present(&bin, &needles);
    if cfg!(feature = "os-managed-updates") {
        assert!(
            found.is_empty(),
            "the os-managed-updates build still contains {found:?}"
        );
    } else {
        // The check has teeth: the generic profile keeps its updater
        // until DEC-28's P2 work.
        let mut missing = needles.clone();
        missing.retain(|n| !found.contains(n));
        assert!(missing.is_empty(), "the generic build lacks {missing:?}");
    }
    // DEC-28: no profile carries the legacy tarball OTA.
    let legacy = [
        "/opt/suderra/edge-agent".to_owned(),
        "unknown-linux-gnu.tar.gz".to_owned(),
    ];
    assert!(present(&bin, &legacy).is_empty());
}

#[test]
fn suderra_os_implies_os_managed_updates() {
    let manifest = std::fs::read_to_string(crate_root().join("Cargo.toml")).unwrap();
    let feature = |name: &str| {
        let prefix = format!("{name} = [");
        manifest
            .lines()
            .find(|l| l.starts_with(&prefix))
            .unwrap_or_else(|| panic!("feature {name} not declared"))
            .to_owned()
    };
    assert!(
        feature("suderra-os").contains("\"os-managed-updates\""),
        "the suderra-os profile must imply os-managed-updates"
    );
    assert_eq!(feature("os-managed-updates"), "os-managed-updates = []");
}

/// Whether `attr` is one of the attributes directly above `item` (the first
/// exact match in `rel`).
fn gated(rel: &str, item: &str, attr: &str) -> bool {
    let text = std::fs::read_to_string(crate_root().join(rel)).unwrap();
    let at = text
        .find(item)
        .unwrap_or_else(|| panic!("{item:?} not found in {rel}"));
    text[..at]
        .trim_end_matches([' ', '\t', '\n'])
        .lines()
        .rev()
        .map(str::trim)
        .take_while(|l| l.starts_with("#["))
        .any(|l| l == attr)
}

#[test]
fn the_updater_modules_and_handlers_are_gated() {
    assert!(gated("src/main.rs", "\nmod updater;", OMU));
    assert!(gated(
        "src/main.rs",
        "\nmod lifecycle;",
        "#[cfg(all(feature = \"health\", not(feature = \"os-managed-updates\")))]"
    ));
    for module in [
        "apply_signed_manifest",
        "confirm_slot",
        "verify_signed_manifest",
    ] {
        assert!(
            gated("src/commands/mod.rs", &format!("\nmod {module};"), OMU),
            "commands::{module}"
        );
    }
    for arm in [
        "\"reboot\" =>",
        "\"restart_agent\" =>",
        "\"confirm_slot\" =>",
        "\"verify_signed_manifest\" =>",
        "\"apply_signed_manifest\" =>",
    ] {
        assert!(
            gated("src/commands/dispatch_lifecycle.rs", arm, OMU),
            "dispatch arm {arm}"
        );
    }
    assert!(gated("src/main.rs", "\"--confirm-active\" =>", OMU));
}

#[test]
fn boot_and_opt_paths_live_only_in_the_gated_updater() {
    // Files compiled only where the agent updates itself.
    let gated_files = |rel: &str| {
        rel.starts_with("src/updater/")
            || [
                "src/commands/apply_signed_manifest.rs",
                "src/commands/confirm_slot.rs",
                "src/commands/verify_signed_manifest.rs",
                "src/lifecycle.rs",
            ]
            .contains(&rel)
    };
    let mut stray = Vec::new();
    for file in scan_src() {
        for lit in &file.literals {
            let path_like = lit.text.contains("/boot/") || lit.text.contains("/opt/");
            if path_like && !gated_files(&file.rel) {
                stray.push(format!("{}:{}: {:?}", file.rel, lit.line, lit.text));
            }
        }
    }
    assert!(
        stray.is_empty(),
        "/boot or /opt paths outside the gated updater:\n{}",
        stray.join("\n")
    );
}
