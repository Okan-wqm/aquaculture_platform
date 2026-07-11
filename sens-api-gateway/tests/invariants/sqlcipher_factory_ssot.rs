//! EDGE-HIGH-026 — Tier-3 invariant: the SQLCipher `PRAGMA key` ceremony
//! has exactly one steady-state owner (`db::sqlcipher_factory`).
//!
//! Before EDGE-HIGH-026 the raw-key `PRAGMA key = "x'…'"` application was
//! hand-rolled across ~19 store openers with three divergent pragma
//! profiles — the structural enabler of the EDGE-CRITICAL-002
//! key-derivation defect class. This test is the make-it-detectable guard:
//! it FAILS the build if any source file outside the sanctioned set emits
//! an executable `PRAGMA key` / `PRAGMA rekey` / `pragma_update(_, "key")`.
//!
//! Sanctioned emitters:
//!   * `src/db/sqlcipher_factory.rs` — the steady-state open ceremony SSoT.
//!   * `src/db_migration/{rekey,rekey_swap,cli,cli_runtime,cli_executor,
//!     v1_legacy_key,v2_keystore_key}.rs` — the v1→v2 migration ceremonies
//!     + key-format kernels (they open a DB solely to run/derive the rekey).
//!   * `src/scada_db.rs` — the SCADA store opener that ALSO performs an
//!     in-place legacy→hardened rekey of an existing database
//!     (EDGE-CRITICAL-002); a migration-performing opener, same class as the
//!     db_migration internals.
//!   * any line carrying `// INVARIANT-ALLOW: sqlcipher-test-seed` (or the
//!     line immediately above it) — `#[cfg(test)]` fixtures that seed an
//!     encrypted DB directly, never a production opener.
//!
//! Runs from the `sens-api-gateway/` working dir per cargo test convention.

use std::path::{Path, PathBuf};

/// Executable raw-key forms. The escaped `\"` distinguishes real code
/// (`format!("PRAGMA key = \"x'…")`) from doc-comment prose
/// (`/// PRAGMA key = "x'…"`), which carries no backslash and is ignored.
const NEEDLES: &[&str] = &[
    "PRAGMA key = \\\"x'",
    "PRAGMA rekey = \\\"x'",
    "pragma_update(None, \"key\"",
];

const ALLOWLISTED_FILES: &[&str] = &[
    "src/db/sqlcipher_factory.rs",
    "src/db_migration/rekey.rs",
    "src/db_migration/rekey_swap.rs",
    "src/db_migration/cli.rs",
    "src/db_migration/cli_runtime.rs",
    "src/db_migration/cli_executor.rs",
    "src/db_migration/v1_legacy_key.rs",
    "src/db_migration/v2_keystore_key.rs",
    "src/scada_db.rs",
];

const TEST_SEED_MARKER: &str = "INVARIANT-ALLOW: sqlcipher-test-seed";

fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => panic!("BUG: sqlcipher_factory_ssot cannot read dir {dir:?}: {e}"),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rs_files(&path, out);
        } else if path.extension().and_then(|s| s.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

fn normalize(path: &Path) -> String {
    // Normalize to a forward-slash, `src/`-relative path for allowlist match.
    path.to_string_lossy().replace('\\', "/")
}

#[test]
fn only_the_factory_and_migration_internals_emit_pragma_key() {
    let mut files = Vec::new();
    collect_rs_files(Path::new("src"), &mut files);
    assert!(
        !files.is_empty(),
        "BUG: no src/**/*.rs files found — is the cwd sens-api-gateway/?"
    );

    let mut offenders: Vec<String> = Vec::new();

    for file in &files {
        let rel = normalize(file);
        if ALLOWLISTED_FILES.iter().any(|a| rel.ends_with(a)) {
            continue;
        }
        let src =
            std::fs::read_to_string(file).unwrap_or_else(|e| panic!("BUG: cannot read {rel}: {e}"));
        let lines: Vec<&str> = src.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            if !NEEDLES.iter().any(|n| line.contains(n)) {
                continue;
            }
            // Exempt a marked test-seed: the marker may be on this line or
            // the line immediately above it.
            let marked_here = line.contains(TEST_SEED_MARKER);
            let marked_above = i > 0 && lines[i - 1].contains(TEST_SEED_MARKER);
            if marked_here || marked_above {
                continue;
            }
            offenders.push(format!("{rel}:{}: {}", i + 1, line.trim()));
        }
    }

    assert!(
        offenders.is_empty(),
        "EDGE-HIGH-026 SSoT VIOLATED: a `PRAGMA key`/`rekey` was emitted \
         outside db::sqlcipher_factory (and the sanctioned migration \
         internals). Route the open through \
         crate::db::sqlcipher_factory::{{open_device_secret,open_resolved}}, \
         or mark a genuine test-seed with `// {TEST_SEED_MARKER}`.\n  offenders:\n  {}",
        offenders.join("\n  ")
    );
}

#[test]
fn factory_owns_the_canonical_sequence() {
    // Positive pin: the factory MUST contain the raw-key literal AND every
    // step of the canonical durability sequence, so the ceremony cannot
    // silently lose a step or move out of the SSoT.
    let src =
        std::fs::read_to_string("src/db/sqlcipher_factory.rs").expect("factory source must exist");
    for token in [
        "PRAGMA key = \\\"x'",
        "journal_mode=WAL",
        "synchronous=NORMAL",
        "busy_timeout=5000",
        "auto_vacuum=INCREMENTAL",
    ] {
        assert!(
            src.contains(token),
            "EDGE-HIGH-026: db/sqlcipher_factory.rs is missing canonical \
             token `{token}` — the open ceremony lost a step."
        );
    }
}
