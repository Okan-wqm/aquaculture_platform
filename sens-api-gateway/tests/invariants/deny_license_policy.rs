//! Supply-chain license gate invariants for `deny.toml`.
//!
//! ## Why this file exists
//!
//! `cargo deny check licenses` (run by rust-ci and by the edge release
//! workflow before any binary is built) only protects the shipped agent if
//! the license it evaluates is the crate's real license. A
//! `[[licenses.clarify]]` entry replaces the detected license with an
//! asserted SPDX expression, so a clarify on a third-party crate can make a
//! dependency under a non-commercial license pass the permissive `allow`
//! list. Clarify is therefore reserved for first-party crates; third-party
//! crates must pass detection on their own published license text.
//!
//! Crates under non-commercial / non-production licenses are additionally
//! listed in `[bans] deny`, and must be absent from both lockfiles.
//!
//! Tier-3 MAKE-IT-DETECTABLE, same source-scan convention as
//! `tests/invariants/cipher_allowlist_fleet_compat.rs`.

/// Crates published by this repository. Only these may carry a
/// `[[licenses.clarify]]` entry.
const FIRST_PARTY_CRATES: &[&str] = &["suderra-agent"];

/// Crates whose license forbids commercial or production use.
const NON_COMMERCIAL_CRATES: &[&str] = &["rodbus", "dnp3"];

fn read_source(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| {
        panic!(
            "BUG: deny_license_policy invariant cannot read {path} — this test \
             runs from sens-api-gateway/ working dir per cargo test convention. err={e}"
        )
    })
}

/// Value of `key = "value"` on a TOML line, if the line is that key.
fn string_value<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let rest = line.trim().strip_prefix(key)?.trim_start();
    let rest = rest.strip_prefix('=')?.trim();
    rest.strip_prefix('"')?.split('"').next()
}

/// `[table]` / `[[array.of.tables]]` header line.
fn is_table_header(line: &str) -> bool {
    line.starts_with('[') && line.ends_with(']') && !line.contains('=') && !line.contains('"')
}

/// Crate names of every `[[licenses.clarify]]` table in deny.toml.
fn clarified_crates(deny: &str) -> Vec<String> {
    let mut crates = Vec::new();
    let mut in_clarify = false;
    for line in deny.lines() {
        let trimmed = line.trim();
        if is_table_header(trimmed) {
            in_clarify = trimmed == "[[licenses.clarify]]";
            continue;
        }
        if !in_clarify {
            continue;
        }
        if let Some(name) = string_value(trimmed, "crate") {
            crates.push(name.to_string());
        }
    }
    crates
}

/// Crate names in the `[bans]` table's `deny = [ { name = "..." }, ... ]` list.
fn banned_crates(deny: &str) -> Vec<String> {
    let mut banned = Vec::new();
    let mut in_bans = false;
    let mut in_deny_list = false;
    for line in deny.lines() {
        let trimmed = line.trim();
        if is_table_header(trimmed) {
            in_bans = trimmed == "[bans]";
            in_deny_list = false;
            continue;
        }
        if in_bans && trimmed.starts_with("deny") && trimmed.ends_with('[') {
            in_deny_list = true;
            continue;
        }
        if !in_deny_list {
            continue;
        }
        if trimmed.starts_with(']') {
            in_deny_list = false;
            continue;
        }
        if let Some(name) = trimmed
            .strip_prefix('{')
            .and_then(|entry| string_value(entry, "name"))
        {
            banned.push(name.to_string());
        }
    }
    banned
}

#[test]
fn license_clarify_entries_are_first_party_only() {
    let deny = read_source("deny.toml");
    let clarified = clarified_crates(&deny);
    assert!(
        clarified.iter().any(|c| c == "suderra-agent"),
        "deny_license_policy parser found no clarify entry for suderra-agent — \
         the parser no longer matches deny.toml's shape; fix the parser, not the policy"
    );
    for crate_name in &clarified {
        assert!(
            FIRST_PARTY_CRATES.contains(&crate_name.as_str()),
            "deny.toml clarifies the license of third-party crate `{crate_name}`. \
             A clarify entry overrides cargo-deny's license detection; third-party \
             crates must pass detection on their own published license text."
        );
    }
}

#[test]
fn non_commercial_crates_are_banned() {
    let deny = read_source("deny.toml");
    let banned = banned_crates(&deny);
    assert!(
        banned.iter().any(|c| c == "openssl"),
        "deny_license_policy parser found no `openssl` ban — the parser no longer \
         matches deny.toml's [bans] shape; fix the parser, not the policy"
    );
    for crate_name in NON_COMMERCIAL_CRATES {
        assert!(
            banned.iter().any(|c| c == crate_name),
            "deny.toml [bans] deny must list `{crate_name}` (non-commercial license)"
        );
    }
}

#[test]
fn non_commercial_crates_absent_from_lockfiles() {
    for lockfile in ["Cargo.lock", "fuzz/Cargo.lock"] {
        let lock = read_source(lockfile);
        for crate_name in NON_COMMERCIAL_CRATES {
            let entry = format!("name = \"{crate_name}\"");
            assert!(
                !lock.lines().any(|line| line.trim() == entry),
                "{lockfile} resolves `{crate_name}`, which is under a non-commercial license"
            );
        }
    }
}
