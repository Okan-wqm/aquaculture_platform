//! E-4 AuditActorLabel invariant seal — Tier-3 grep
//! gate banning the legacy `"opc-ua-anonymous"` literal
//! (Batch #354 — closes ULTRA-MEDIUM-001 / Plan §5
//! Faz 5 Core Gap E-4).
//!
//! ## Why this file
//!
//! Batches #241-#243 (A-2a/A-2b/A-2c) made the literal
//! `"opc-ua-anonymous"` runtime-unreachable in the
//! resolver path — every audit actor label now flows
//! through `ActorIdentity::audit_label()` which
//! exhaustively pattern-matches `Operator(_)` →
//! `"op:<operator>"` and `MachineIssuer { subject_cn }`
//! → `"svc:<cn>"`. No third arm exists.
//!
//! The runtime event class is closed. But the LITERAL
//! string `"opc-ua-anonymous"` may still exist in
//! source — dead code, doc comments, cfg-gated test
//! shims — and a future refactor could re-introduce it
//! via a copy-paste, a `From<&str>` impl, or a
//! deserialization path. The "we happened to remove it"
//! property does not survive operator turnover.
//!
//! Plan §5 Batch #246 specifies the architectural fix:
//! convert "we happened to remove" → "cannot reappear"
//! via a Tier-3 source-grep gate. This file is that
//! gate.
//!
//! ## What this file pins
//!
//! For every `*.rs` file under `sens-api-gateway/src/`,
//! the literal byte sequence `"opc-ua-anonymous"` MUST
//! NOT appear. If it does, the test fails with the
//! file path + line number so the operator immediately
//! sees what to fix.
//!
//! ## Allowlist policy
//!
//! Pre-Batch-#354 the literal appeared in 7 doc-comment
//! references documenting the architectural elimination
//! itself (e.g., "the legacy `opc-ua-anonymous` actor
//! that we no longer use…"). Those comments were
//! reworded to describe the legacy wire-string without
//! naming it directly — the historical context survives
//! in `git blame` + Batch #354's commit body.
//!
//! Going forward the allowlist is EMPTY. Doc comments
//! that need to reference the historical elimination
//! should use phrases like "the legacy anonymous-actor
//! wire-string banned by the Batch #354
//! audit_actor_label_no_legacy invariant" — clear about
//! what was eliminated without re-introducing the
//! literal.
//!
//! ## What this file does NOT pin
//!
//! - Runtime behavior — covered by the existing
//!   `ActorIdentity::audit_label()` exhaustive match +
//!   the in-tree behavioural unit tests on `audit_label`.
//! - The newtype seal of `AuditActor` — that's a
//!   companion architectural property tracked separately
//!   if/when audit-log wire format graduates to the
//!   plan's documented `"operator:<hex32>"` /
//!   `"machine_issuer:<cn>"` long-form (which would
//!   break audit log compatibility on the deployed
//!   fleet without an explicit migration plan + ADR).

use std::fs;
use std::path::{Path, PathBuf};

const BANNED_LITERAL: &str = "opc-ua-anonymous";
const SRC_ROOT: &str = "src";

/// Empty allowlist (Batch #354 convention). Future
/// entries — if architecturally justified — go here
/// with explicit rationale.
const ALLOWLIST: &[&str] = &[];

/// **E-4 invariant 1:** the literal `"opc-ua-anonymous"`
/// MUST NOT appear in any `*.rs` source file under
/// `sens-api-gateway/src/`.
///
/// This is the Tier-3 architectural seal that prevents
/// reintroduction of the legacy anonymous-actor wire-
/// string. The runtime event class was closed by
/// Batches #241-#243 (A-2a/A-2b/A-2c); this gate makes
/// "cannot reappear" structural.
#[test]
fn e4_no_legacy_anonymous_actor_literal_in_src_tree() {
    let mut violations: Vec<(PathBuf, usize, String)> = Vec::new();
    walk_rs_files(Path::new(SRC_ROOT), &mut violations);

    if !violations.is_empty() {
        eprintln!(
            "E-4 INVARIANT VIOLATED: {count} occurrence(s) of \
             banned literal `\"{lit}\"` in src/ tree:",
            count = violations.len(),
            lit = BANNED_LITERAL,
        );
        for (path, line_num, line) in &violations {
            eprintln!("  {}:{} — {}", path.display(), line_num, line.trim());
        }
        eprintln!();
        eprintln!(
            "The `\"{}\"` literal is the legacy anonymous-actor wire-string \
             that Batches #241-#243 made runtime-unreachable. Plan §5 Faz 5 \
             Core Gap E-4 (Batch #246) seals it from reappearing in source.",
            BANNED_LITERAL,
        );
        eprintln!();
        eprintln!(
            "If you are documenting the architectural elimination itself, use \
             a description like \"the legacy anonymous-actor wire-string \
             banned by the Batch #354 audit_actor_label_no_legacy \
             invariant\" — clear about what was eliminated without \
             re-introducing the literal.",
        );
        eprintln!();
        eprintln!(
            "If you genuinely need an exception, add the file path to the \
             ALLOWLIST in tests/invariants/audit_actor_label_no_legacy.rs \
             with explicit ADR + finding-ID rationale.",
        );
        panic!(
            "{} occurrence(s) of banned literal `\"{}\"` in src/ tree",
            violations.len(),
            BANNED_LITERAL,
        );
    }
}

/// Walk every `.rs` file under `dir` recursively + scan
/// each line for the banned literal.
fn walk_rs_files(dir: &Path, out: &mut Vec<(PathBuf, usize, String)>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => panic!(
            "BUG: audit_actor_label_no_legacy invariant cannot read {}: {} \
             (this test runs from sens-api-gateway/ working dir per cargo \
             test convention)",
            dir.display(),
            e,
        ),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_rs_files(&path, out);
        } else if path.extension().map(|s| s == "rs").unwrap_or(false) {
            scan_file(&path, out);
        }
    }
}

fn scan_file(path: &Path, out: &mut Vec<(PathBuf, usize, String)>) {
    // Skip allowlisted paths.
    let path_str = path.to_string_lossy();
    for allowed in ALLOWLIST {
        if path_str.ends_with(allowed) {
            return;
        }
    }
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return, // unreadable; skip silently (binary/etc.)
    };
    for (idx, line) in content.lines().enumerate() {
        if line.contains(BANNED_LITERAL) {
            out.push((path.to_path_buf(), idx + 1, line.to_string()));
        }
    }
}
