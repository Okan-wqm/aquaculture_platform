#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]

//! ADR-048 DEC-19 — the production mode and every security-relevant
//! setting come from verity-protected data or a compile-time feature, never
//! from the environment, in the Suderra OS profile.
//!
//! Tier 1 does the work: `src/generic_env.rs` is the only module that reads
//! a runtime environment variable (path overrides, SCADA listener and
//! token, backup secret, systemd credentials directory), and `main.rs`
//! declares it under `#[cfg(not(feature = "suderra-os"))]`, so in that
//! profile any code that tries to consult one does not compile. This test
//! keeps the tier-1 structure from eroding:
//!
//! * no runtime environment read appears anywhere else in production
//!   source, except the reasoned allowlist below (DEC-19: the allowlist
//!   starts empty and every entry needs a reason);
//! * `generic_env` and `machine_id` (DEC-4.9: no machine-id reader in the
//!   Suderra OS profile) stay generic-only;
//! * in the suderra-os build itself, the module really is absent
//!   (`generic_env_is_not_compiled_in_suderra_os`).

#[path = "source_scan_support/mod.rs"]
mod source_scan_support;

/// Runtime environment reads allowed outside `src/generic_env.rs`:
/// (file, variable, reason).
const ENV_READ_ALLOWLIST: &[(&str, &str, &str)] = &[(
    "src/main.rs",
    "SUDERRA_AUDIT_KEY_HEX",
    "input of the offline `--audit-verify <log>` CLI, which an auditor runs on a copy of \
     the log; it selects no path, listener, credential or mode of the running agent, and \
     an argv key would leak through /proc/<pid>/cmdline",
)];

/// Code shapes that read the process environment at run time.
const ENV_READ_PATTERNS: &[&str] = &[
    "env::var(",
    "env::var_os(",
    "env::vars(",
    "env::vars_os(",
    "getenv(",
];

#[test]
fn runtime_environment_reads_live_only_in_generic_env() {
    let mut violations = Vec::new();
    for file in source_scan_support::scan_src() {
        if file.rel == "src/generic_env.rs" {
            continue;
        }
        for pattern in ENV_READ_PATTERNS {
            for line in file.code_lines_with(pattern) {
                let allowed = ENV_READ_ALLOWLIST.iter().any(|(f, var, _)| {
                    *f == file.rel
                        && file
                            .literals
                            .iter()
                            .any(|l| l.line == line && l.text == *var)
                });
                if !allowed {
                    violations.push(format!("{}:{line}: {pattern}", file.rel));
                }
            }
        }
    }
    assert!(
        violations.is_empty(),
        "runtime environment reads outside src/generic_env.rs (ADR-048 DEC-19; move the \
         read into generic_env, or allowlist it with a reason):\n{}",
        violations.join("\n")
    );
}

#[test]
fn allowlist_entries_are_still_needed() {
    let files = source_scan_support::scan_src();
    for (file, var, _) in ENV_READ_ALLOWLIST {
        let used = files.iter().any(|f| {
            f.rel == *file
                && f.literals.iter().any(|l| {
                    l.text == *var
                        && ENV_READ_PATTERNS
                            .iter()
                            .any(|p| f.code_lines_with(p).contains(&l.line))
                })
        });
        assert!(
            used,
            "ENV_READ_ALLOWLIST entry ({file}, {var}) matches nothing; remove it"
        );
    }
}

/// `true` when the production declaration `mod <name>;` in `main.rs` is
/// gated by `#[cfg(not(feature = "suderra-os"))]`.
fn declared_generic_only(name: &str) -> bool {
    let main = source_scan_support::scan_src()
        .into_iter()
        .find(|f| f.rel == "src/main.rs")
        .expect("src/main.rs");
    let raw = std::fs::read_to_string(source_scan_support::crate_root().join("src/main.rs"))
        .expect("read main.rs");
    let decl = format!("mod {name};");
    let lines: Vec<&str> = raw.lines().collect();
    let code_lines: Vec<&str> = main.code.lines().collect();
    let at = code_lines
        .iter()
        .position(|l| l.trim() == decl)
        .unwrap_or_else(|| panic!("main.rs declares no `{decl}`"));
    // The attribute is the nearest non-comment line above the declaration.
    lines[..at]
        .iter()
        .rev()
        .map(|l| l.trim())
        .find(|l| !l.is_empty() && !l.starts_with("//"))
        .is_some_and(|l| l == "#[cfg(not(feature = \"suderra-os\"))]")
}

#[test]
fn generic_env_is_declared_generic_only() {
    assert!(
        declared_generic_only("generic_env"),
        "src/generic_env.rs must be declared under #[cfg(not(feature = \"suderra-os\"))] \
         (ADR-048 DEC-19)"
    );
}

#[test]
fn machine_id_reader_is_declared_generic_only() {
    assert!(
        declared_generic_only("machine_id"),
        "src/machine_id.rs must be declared under #[cfg(not(feature = \"suderra-os\"))] \
         (ADR-048 DEC-4.9: nothing in the Suderra OS profile reads a machine-id)"
    );
}

/// The machine-id crate is reached only through `src/machine_id.rs`.
#[test]
fn machine_uid_is_read_only_by_the_generic_reader() {
    let mut violations = Vec::new();
    for file in source_scan_support::scan_src() {
        if file.rel == "src/machine_id.rs" {
            continue;
        }
        for line in file.code_lines_with("machine_uid::") {
            // The SCADA store's pre-EDGE-CRITICAL-002 migration passphrase is
            // generic-only (its function is gated) and is the one other
            // reader; any further one is a violation.
            if file.rel == "src/scada_db.rs" && scada_legacy_reader_is_gated() {
                continue;
            }
            violations.push(format!("{}:{line}", file.rel));
        }
    }
    assert!(
        violations.is_empty(),
        "machine_uid read outside src/machine_id.rs:\n{}",
        violations.join("\n")
    );
}

fn scada_legacy_reader_is_gated() -> bool {
    let raw = std::fs::read_to_string(source_scan_support::crate_root().join("src/scada_db.rs"))
        .expect("read scada_db.rs");
    let lines: Vec<&str> = raw.lines().collect();
    let at = lines
        .iter()
        .position(|l| {
            l.trim_start()
                .starts_with("fn legacy_machine_id_passphrase(")
        })
        .expect("legacy_machine_id_passphrase");
    lines[..at]
        .iter()
        .rev()
        .map(|l| l.trim())
        .find(|l| !l.starts_with("//"))
        .is_some_and(|l| l == "#[cfg(not(feature = \"suderra-os\"))]")
}

/// In the suderra-os build the generic module must not exist: this file
/// would not compile if `paths.rs` (compiled here with no `generic_env`
/// module) referred to it outside a generic-only item.
#[cfg(feature = "suderra-os")]
#[allow(dead_code)]
#[path = "../../src/paths.rs"]
mod paths;

#[cfg(feature = "suderra-os")]
#[test]
fn generic_env_is_not_compiled_in_suderra_os() {
    // Compiling `paths` above without a `generic_env` module is the proof;
    // the profile's paths are the compile-time constants.
    let p = paths::AgentPaths::suderra_os();
    assert_eq!(
        p.config_file(),
        std::path::Path::new(paths::suderra_os::CONFIG_FILE)
    );
}
