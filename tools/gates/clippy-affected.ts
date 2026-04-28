#!/usr/bin/env ts-node
/**
 * `cargo clippy` per-diff gate — Batch #343 (closes
 * ORPHAN-MEDIUM-029).
 *
 * ## Why this gate exists
 *
 * The `sens-api-gateway` Rust crate declares a clippy
 * deny-list at the rustc invocation level
 * (`--deny=clippy::unwrap_used`,
 * `--deny=clippy::expect_used`,
 * `--deny=clippy::indexing_slicing`, etc.). These flags
 * are no-ops under `cargo check` (regular rustc does
 * not register clippy lints) but fire under
 * `cargo clippy`. The full crate has dozens of legacy
 * violations across many files — running `cargo clippy
 * --deny warnings` workspace-wide would block every
 * commit indefinitely.
 *
 * The auditor (edge-industrial-auditor LOW-001 / closed
 * via this gate) flagged the gap: the deny-list is an
 * architectural CONTRACT but is not gate-enforced. New
 * code conforming to the contract sits next to legacy
 * code violating it with no operator-visible signal of
 * which side is "current standard".
 *
 * Architectural fix per CLAUDE.md hierarchy: TIER-2
 * MAKE-IT-AUTOMATIC. Run clippy on every build, but only
 * SURFACE the diagnostics that affect files in the
 * current diff. New code can't introduce new
 * violations; legacy debt doesn't block.
 *
 * ## How it works
 *
 * 1. Compute the affected Rust file set:
 *    `git diff --name-only <base>...<head>`. Filter to
 *    `*.rs` paths under `sens-api-gateway/`.
 * 2. Run `cargo clippy --bin suderra-agent
 *    --message-format=json` once. Cargo emits one JSON
 *    object per diagnostic.
 * 3. Parse the JSON stream. Filter to diagnostics whose
 *    primary span's file_name is in the affected set.
 * 4. Filter to error-level diagnostics (warning-level
 *    pass cleanly so legacy `dead_code` warnings don't
 *    block).
 * 5. Print the affected diagnostics + exit non-zero if
 *    any remain.
 *
 * ## Why JSON message format (not human format)
 *
 * `cargo clippy` human format emits messages with file
 * paths AND surrounding context lines. Filtering by
 * substring would either miss diagnostics that mention
 * an affected file in their note: line OR over-include
 * diagnostics whose context happens to mention an
 * affected path. JSON gives us the canonical
 * `spans[*].file_name` field — unambiguous.
 *
 * ## Why warning-level passes cleanly
 *
 * The crate has many pre-existing clippy warnings
 * (dead_code, never_constructed, etc.) that are not in
 * the architectural deny-list. The deny-list is the
 * architectural contract; warnings are advisory.
 * Filtering to error-level keeps the gate focused on
 * the contract violations the user-facing crate-wide
 * `--deny=clippy::*` flags would otherwise enforce.
 *
 * ## Usage
 *
 *   ts-node tools/gates/clippy-affected.ts --mode=range <base> <head>
 *   ts-node tools/gates/clippy-affected.ts --mode=staged   # pre-commit
 *
 * ## Exit codes
 *
 *   0 — no error-level diagnostics in affected files
 *   1 — error-level diagnostic found in an affected file
 *   2 — usage error / cargo invocation failed
 *
 * ## Why TypeScript (not bash)
 *
 * Per memory `feedback_tooling_language.md` — new CI/
 * deploy scripts prefer TypeScript with Node 22
 * type-stripping; bash JSON parsing requires `jq` and
 * is brittle on shell-quote edge cases. The TS surface
 * sits next to the other tools/gates/* and reuses
 * their conventions.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return process.cwd();
  }
})();

const RUST_CRATE_DIR = resolve(REPO_ROOT, 'sens-api-gateway');
const RUST_CRATE_PREFIX = 'sens-api-gateway/';

interface ClippyDiagnostic {
  /** Rendered human-readable message (multi-line). */
  readonly rendered: string;
  /** Severity: "error" | "warning" | "note" | "help". */
  readonly level: string;
  /** Primary file the diagnostic applies to. */
  readonly primaryFile: string;
}

interface CargoMessage {
  readonly reason?: string;
  readonly message?: {
    readonly rendered?: string;
    readonly level?: string;
    readonly spans?: ReadonlyArray<{
      readonly file_name?: string;
      readonly is_primary?: boolean;
    }>;
  };
}

/**
 * Compute the affected file set for the given mode.
 *
 * - `range`: `git diff --name-only <base>...<head>`
 * - `staged`: `git diff --name-only --cached`
 */
function affectedFiles(
  mode: 'range' | 'staged',
  base: string | undefined,
  head: string | undefined,
): Set<string> {
  let raw: string;
  if (mode === 'range') {
    if (!base || !head) {
      console.error(
        'range mode requires two refs: --mode=range <base> <head>',
      );
      process.exit(2);
    }
    raw = execFileSync(
      'git',
      ['diff', '--name-only', `${base}...${head}`],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
  } else {
    raw = execFileSync('git', ['diff', '--name-only', '--cached'], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
  }
  const files = new Set<string>();
  for (const line of raw.split('\n')) {
    const path = line.trim();
    if (!path) continue;
    if (!path.startsWith(RUST_CRATE_PREFIX)) continue;
    if (!path.endsWith('.rs')) continue;
    files.add(path);
  }
  return files;
}

/**
 * Run `cargo clippy --bin suderra-agent
 * --message-format=json` once and return the parsed
 * diagnostics. cargo writes one JSON object per line on
 * stdout.
 */
function runClippy(): ClippyDiagnostic[] {
  // We run from the crate directory so the `[[bin]]`
  // target resolves correctly. `--no-deps` skips
  // dependency clippy runs (much faster + dependencies'
  // diagnostics are not under our control anyway).
  const result = spawnSync(
    'cargo',
    [
      'clippy',
      '--bin',
      'suderra-agent',
      '--no-deps',
      '--message-format=json',
    ],
    {
      cwd: RUST_CRATE_DIR,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) {
    console.error(`cargo clippy invocation failed: ${result.error.message}`);
    process.exit(2);
  }
  const diagnostics: ClippyDiagnostic[] = [];
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: CargoMessage;
    try {
      parsed = JSON.parse(trimmed) as CargoMessage;
    } catch {
      // Cargo also emits non-JSON build progress lines
      // when invoked via TTY. We tolerate them.
      continue;
    }
    if (parsed.reason !== 'compiler-message') continue;
    const msg = parsed.message;
    if (!msg) continue;
    const level = msg.level ?? '';
    const rendered = msg.rendered ?? '';
    if (!rendered) continue;
    // Find the PRIMARY span — clippy diagnostics carry
    // multiple spans; the primary is the one the
    // diagnostic actually applies to.
    const primary = (msg.spans ?? []).find((s) => s.is_primary === true);
    const primaryFile = primary?.file_name ?? '';
    if (!primaryFile) continue;
    diagnostics.push({ rendered, level, primaryFile });
  }
  return diagnostics;
}

/**
 * Resolve a clippy span path relative to the crate root
 * back to a repo-root-relative path so the affected-set
 * comparison is apples-to-apples.
 *
 * cargo clippy emits `file_name` as crate-relative
 * (e.g., `src/db_migration/manifest.rs`). The git diff
 * is repo-relative (e.g.,
 * `sens-api-gateway/src/db_migration/manifest.rs`).
 * We prefix the crate path.
 */
function repoRelativeFromClippyPath(clippyPath: string): string {
  if (clippyPath.startsWith(RUST_CRATE_PREFIX)) return clippyPath;
  return RUST_CRATE_PREFIX + clippyPath;
}

interface RunOptions {
  readonly mode: 'range' | 'staged';
  readonly base?: string;
  readonly head?: string;
}

function parseArgs(argv: readonly string[]): RunOptions {
  const args = [...argv];
  const modeFlag = args.shift() ?? '';
  if (!modeFlag.startsWith('--mode=')) {
    console.error('Usage: clippy-affected --mode=<range|staged> [base head]');
    process.exit(2);
  }
  const mode = modeFlag.replace(/^--mode=/, '');
  if (mode === 'range') {
    const [base, head] = args;
    return { mode: 'range', base, head };
  }
  if (mode === 'staged') {
    return { mode: 'staged' };
  }
  console.error(`Unknown mode: ${mode}`);
  process.exit(2);
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const affected = affectedFiles(opts.mode, opts.base, opts.head);
  if (affected.size === 0) {
    console.log('clippy-affected: no Rust files in the diff; gate skipped.');
    return;
  }
  console.log(
    `clippy-affected: scanning ${affected.size} affected file(s) under ${RUST_CRATE_PREFIX}…`,
  );

  if (!existsSync(resolve(RUST_CRATE_DIR, 'Cargo.toml'))) {
    console.error(
      `clippy-affected: no Cargo.toml at ${RUST_CRATE_DIR}; gate cannot run.`,
    );
    process.exit(2);
  }

  const all = runClippy();
  const errorsInAffectedFiles = all.filter((d) => {
    if (d.level !== 'error') return false;
    const repoRelative = repoRelativeFromClippyPath(d.primaryFile);
    return affected.has(repoRelative);
  });

  if (errorsInAffectedFiles.length === 0) {
    console.log(
      'clippy-affected: no error-level diagnostics in affected files. Gate passed.',
    );
    return;
  }

  console.error(
    `clippy-affected: FAILED — ${errorsInAffectedFiles.length} error-level diagnostic(s) in affected files:`,
  );
  console.error('');
  for (const diag of errorsInAffectedFiles) {
    console.error(diag.rendered.trimEnd());
    console.error('');
  }
  console.error(
    'New code in this diff must satisfy the crate-level clippy deny-list (',
  );
  console.error(
    '  clippy::unwrap_used / clippy::expect_used / clippy::indexing_slicing /',
  );
  console.error(
    '  clippy::print_stdout / clippy::print_stderr / clippy::dbg_macro /',
  );
  console.error(
    '  clippy::large_stack_arrays / clippy::unimplemented / clippy::todo',
  );
  console.error(
    ').',
  );
  console.error(
    'Legacy violations in untouched files are not blocked — only new code is gated.',
  );
  console.error(
    'See ORPHAN-MEDIUM-029 + Batch #343 commit for the architectural rationale.',
  );
  process.exit(1);
}

main();

// Exported for testing.
export {
  affectedFiles,
  parseArgs,
  repoRelativeFromClippyPath,
  type ClippyDiagnostic,
  type RunOptions,
};
