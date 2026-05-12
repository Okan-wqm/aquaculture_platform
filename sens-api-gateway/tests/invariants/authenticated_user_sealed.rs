//! Invariant test for Batch #240 Faz 5 A-2a seal enforcement.
//!
//! Asserts via source-level grep that `AuthenticatedUser` cannot be
//! constructed from a raw `&str` / `String` / arbitrary external
//! input. The Batch #239 newtype carries a `pub(crate) fn anonymous
//! / user_pass / x509` triple + `#[cfg(test)]` `for_test_*` helpers;
//! any `impl From<_> for AuthenticatedUser`, `impl FromStr for
//! AuthenticatedUser`, `impl TryFrom<&str> for AuthenticatedUser`,
//! or `impl<'de> Deserialize<'de> for AuthenticatedUser` would
//! break the Tier-1 seal.
//!
//! Why a source-grep invariant: the compiler cannot catch "a future
//! module implements `From<String> for AuthenticatedUser`" without
//! us being aware — the newtype ships in this crate, anyone in this
//! crate can add such an impl. The invariant test runs as part of
//! the unit suite on every PR + fails the build if the grep pattern
//! matches, converting the seal into a code-review-independent
//! automated gate.
//!
//! Canonical path: `sens-api-gateway/src/` (limited to crate source,
//! skips `target/`, `vendor/`, `fuzz/` corpus files).

use std::fs;
use std::path::{Path, PathBuf};

/// Walk `dir` recursively, collecting every `.rs` file path.
/// Excludes `target`, `vendor`, `fuzz` directories.
fn collect_rs_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if path.is_dir() {
            if matches!(name, "target" | "vendor" | "fuzz" | ".git") {
                continue;
            }
            out.extend(collect_rs_files(&path));
        } else if path.extension().and_then(|s| s.to_str()) == Some("rs") {
            out.push(path);
        }
    }
    out
}

fn src_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// Patterns whose presence in any .rs file under `src/` (except
/// `opc_ua_server_session.rs` itself, where the primitive lives)
/// indicates a seal violation.
///
/// Each pattern is checked case-sensitively against the raw file
/// text; we deliberately don't parse AST because (a) the grep is
/// the load-bearing check, (b) AST parsing requires syntex_syntax
/// or equivalent which is heavy for an invariant suite.
const FORBIDDEN_PATTERNS: &[&str] = &[
    "impl From<String> for AuthenticatedUser",
    "impl From<&str> for AuthenticatedUser",
    "impl FromStr for AuthenticatedUser",
    "impl TryFrom<&str> for AuthenticatedUser",
    "impl TryFrom<String> for AuthenticatedUser",
    "impl Deserialize<'_> for AuthenticatedUser",
    "impl<'de> Deserialize<'de> for AuthenticatedUser",
    // The test-only ctor `for_test_*` MUST NOT appear in production
    // code. `#[cfg(test)]` gate already prevents this compiling in
    // release but a future refactor may mistakenly widen visibility.
    // Grep surfaces the bug at review time.
    "AuthenticatedUser::for_test_anonymous",
    "AuthenticatedUser::for_test_user_pass",
    "AuthenticatedUser::for_test_x509",
];

/// Files exempt from the grep (the primitive's own module + its
/// test block may legitimately reference the test ctors).
fn is_exempt(path: &Path) -> bool {
    path.file_name()
        .and_then(|s| s.to_str())
        .map(|name| name == "opc_ua_server_session.rs")
        .unwrap_or(false)
}

/// Return the line index where `#[cfg(test)]` test-module region
/// starts (inclusive) — any content from this line onward is test-
/// only code and exempt from production-seal grep. Returns
/// `content.lines().count()` (i.e. "no exemption") when the file
/// has no test-gated module.
///
/// Pattern heuristic: find the first `#[cfg(test)]` whose next non-
/// blank line starts with `mod ` or `pub mod ` or `pub(crate) mod `.
/// This catches the idiomatic `#[cfg(test)] mod tests { ... }`
/// shape used throughout the codebase without needing a full Rust
/// parser. A `#[cfg(test)]` ANNOTATION ALONE on a single item (not
/// a module) is treated as exempt only for that single item — but
/// since handler primitives are module-scoped `mod tests` blocks
/// at the end of files, the module-heuristic is sufficient for
/// the current source tree.
fn find_test_region_start(content: &str) -> usize {
    let lines: Vec<&str> = content.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if line.trim() == "#[cfg(test)]" {
            // Look ahead to the next non-blank non-comment line;
            // if it introduces a module, this is the test-region
            // start.
            for peek in lines.iter().skip(i + 1).map(|line| line.trim()) {
                if peek.is_empty() || peek.starts_with("//") {
                    continue;
                }
                if peek.starts_with("mod ")
                    || peek.starts_with("pub mod ")
                    || peek.starts_with("pub(crate) mod ")
                {
                    return i;
                }
                break;
            }
        }
    }
    lines.len()
}

#[test]
fn authenticated_user_seal_forbids_external_constructors() {
    let src = src_dir();
    assert!(src.is_dir(), "src/ not found at {}", src.display());

    let files = collect_rs_files(&src);
    assert!(
        !files.is_empty(),
        "collect_rs_files returned zero files under {}",
        src.display()
    );

    let mut violations: Vec<String> = Vec::new();

    for file in &files {
        if is_exempt(file) {
            continue;
        }
        let content = match fs::read_to_string(file) {
            Ok(c) => c,
            Err(_) => continue,
        };
        // Exempt code that lives inside `#[cfg(test)] mod ...`
        // blocks — test-only call sites of `for_test_*` ctors are
        // legitimate. The walker already excludes `tests/` dir.
        let test_region_start = find_test_region_start(&content);
        for pattern in FORBIDDEN_PATTERNS {
            // Scan the file line by line up to (but excluding)
            // the test-region start. A match inside a `//` comment
            // is still a violation because doc claims of the
            // forbidden impl usually correlate with the impl
            // actually existing.
            for (lineno, line) in content.lines().enumerate() {
                if lineno >= test_region_start {
                    break;
                }
                if line.contains(pattern) {
                    violations.push(format!(
                        "{}:{}: forbidden pattern `{}`",
                        file.strip_prefix(env!("CARGO_MANIFEST_DIR"))
                            .unwrap_or(file)
                            .display(),
                        lineno + 1,
                        pattern
                    ));
                }
            }
        }
    }

    assert!(
        violations.is_empty(),
        "AuthenticatedUser seal violations:\n{}\n\n\
        The Tier-1 seal from Batch #239 requires that\n\
        AuthenticatedUser has no public constructor from\n\
        &str / String / Deserialize. External modules must\n\
        construct it only through the pub(crate) triple\n\
        (anonymous / user_pass / x509) called from the\n\
        future custom NodeManager (Batch A-2b).\n\
        If you need a new ctor path, extend the newtype's\n\
        module with a pub(crate) method — do not add a From\n\
        impl. See docs/reviews/edge-plan/2026-04-19-edge-\n\
        hardening.md#ULTRA-HIGH-003",
        violations.join("\n")
    );
}

#[test]
fn invariant_test_actually_scanned_the_tree() {
    // Meta-check: make sure the walk reached enough files that
    // we're confident it's not silently skipping the src/ tree.
    // Lower bound 40 files — the crate has 60+ src/*.rs files
    // last count, so this threshold is safe across ordinary
    // refactors while catching regressions like "walker
    // aborted after one dir".
    let src = src_dir();
    let files = collect_rs_files(&src);
    assert!(
        files.len() >= 40,
        "walker returned only {} .rs files under src/ — expected ≥40",
        files.len()
    );
}
