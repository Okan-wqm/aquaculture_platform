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
 * ## How it works (per-LINE semantic, Batch #346 — closes
 * ORPHAN-MEDIUM-034)
 *
 * 1. Compute the affected Rust file set:
 *    `git diff --name-only <base>...<head>`. Filter to
 *    `*.rs` paths under `sens-api-gateway/`.
 * 2. Compute the affected LINE set per file:
 *    `git diff --unified=0 <base>...<head> -- <file>`.
 *    Parse hunk headers (`@@ -<old> +<new_start>,<new_count>
 *    @@`) to extract added/modified line numbers on the
 *    NEW (post-diff) side. Result is
 *    `Map<file, Set<line>>`.
 * 3. Run `cargo clippy --bin suderra-agent
 *    --message-format=json` once. Cargo emits one JSON
 *    object per diagnostic with `spans[].line_start` /
 *    `line_end`.
 * 4. Parse the JSON stream. Filter to diagnostics whose
 *    primary span's file_name is in the affected file
 *    set AND whose primary span's line range
 *    `[line_start..=line_end]` overlaps the affected
 *    line set for that file.
 * 5. Filter to error-level diagnostics (warning-level
 *    pass cleanly so legacy `dead_code` warnings don't
 *    block).
 * 6. Print the affected diagnostics + exit non-zero if
 *    any remain.
 *
 * **Why per-LINE (not per-FILE):** the auditor's
 * MEDIUM-029 recommendation framed Tier-2 as preventing
 * NEW debt without forcing fleet-wide cleanup.
 * Pre-Batch-#346 the gate was per-FILE — touching a file
 * even minimally (single import, doc-comment edit)
 * surfaced ALL pre-existing legacy violations in that
 * file. On the PR-194 branch this caught 700 violations
 * across 212 affected files (live-fire test in Batch
 * #345). The per-LINE refinement narrows the gate to
 * only catch violations on lines this diff actually
 * touched — the auditor's Tier-2 intent.
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
 *
 * Note (Batch #346): per-LINE filtering requires
 * `--mode=range` with explicit base+head refs. Staged
 * mode (`--mode=staged`) is not yet implemented for
 * per-line filtering — the file-set computation
 * supports it but the line-range hunk extraction needs
 * a `--cached` variant. Future batch.
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

/**
 * CLI output channels. Gate scripts are standalone CLIs (no Nest
 * runtime, so no StructuredLoggerService) — they write line-oriented
 * operator output directly to the process streams, matching the
 * scripts/ci/* convention. console.* is ESLint-banned repo-wide.
 */
function emitLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

function emitErrorLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

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
  /** Primary span's line_start (1-indexed). */
  readonly primaryLineStart: number;
  /** Primary span's line_end (1-indexed, inclusive). */
  readonly primaryLineEnd: number;
}

interface CargoMessage {
  readonly reason?: string;
  readonly message?: {
    readonly rendered?: string;
    readonly level?: string;
    readonly spans?: ReadonlyArray<{
      readonly file_name?: string;
      readonly is_primary?: boolean;
      readonly line_start?: number;
      readonly line_end?: number;
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
      emitErrorLine(
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
    emitErrorLine(`cargo clippy invocation failed: ${result.error.message}`);
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
    const primaryLineStart = primary?.line_start ?? 0;
    const primaryLineEnd = primary?.line_end ?? primaryLineStart;
    if (primaryLineStart === 0) continue;
    diagnostics.push({
      rendered,
      level,
      primaryFile,
      primaryLineStart,
      primaryLineEnd,
    });
  }
  return diagnostics;
}

/**
 * Per-LINE affected-line-set computation (Batch #346 —
 * closes ORPHAN-MEDIUM-034). For each Rust file in the
 * affected-FILE set, run `git diff --unified=0
 * <base>...<head> -- <file>` to extract hunk headers,
 * parse them into added/modified line numbers on the
 * NEW (post-diff) side, return a
 * `Map<repo-relative-path, Set<line>>`.
 *
 * **Hunk header shape:** `@@ -<old_start>,<old_count>
 * +<new_start>,<new_count> @@` (counts default to 1 if
 * omitted). For hunks with `<new_count> = 0` (pure
 * deletion), no lines are added on the new side; we
 * skip. For `<new_count> >= 1` we add the range
 * `[new_start, new_start + new_count)` to the set.
 *
 * **Why per-line (not per-file):** the auditor's
 * MEDIUM-029 recommendation framed Tier-2 as preventing
 * NEW debt without forcing fleet-wide cleanup. Per-FILE
 * filtering caught 700 pre-existing legacy violations
 * on the PR-194 branch (live-fire test in Batch #345).
 * Per-LINE filtering catches only the violations on
 * lines this diff actually touched — the auditor's
 * Tier-2 intent.
 *
 * **Why --unified=0:** `git diff --unified=N` includes
 * N lines of CONTEXT around each change. `=0` strips
 * context, so hunk headers describe only the changed
 * lines — no false positives from context-line
 * inclusion.
 */
function affectedLineRanges(
  base: string,
  head: string,
  files: Iterable<string>,
): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const file of files) {
    const raw = execFileSync(
      'git',
      [
        'diff',
        '--unified=0',
        '--no-color',
        `${base}...${head}`,
        '--',
        file,
      ],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    const lines = parseDiffHunkLines(raw);
    if (lines.size > 0) result.set(file, lines);
  }
  return result;
}

/**
 * Pure-function hunk-header parser (Batch #350 —
 * extracted from `affectedLineRanges` so the line-set
 * computation can be unit-tested independently of git
 * invocation).
 *
 * Input: raw output of `git diff --unified=0 ...` for a
 * single file (or empty string).
 *
 * Output: Set of NEW-side (post-diff) line numbers
 * that were added or modified.
 *
 * **Hunk header shape:** `@@ -<old_start>,<old_count>
 * +<new_start>,<new_count> @@` — counts default to 1
 * when omitted. `<new_count> = 0` is a pure deletion
 * (no NEW-side lines added); skipped.
 *
 * **Why extracted (not inlined in `affectedLineRanges`):**
 * the parser is the algorithmic core of the line-set
 * computation; the git invocation is the IO. Splitting
 * them keeps the algorithm directly testable via
 * canned input strings — Batch #348's spec file pattern
 * extends to this helper without needing a temp git
 * repo.
 */
function parseDiffHunkLines(rawDiffOutput: string): Set<number> {
  const lines = new Set<number>();
  // Hunk header: `@@ -<old> +<new_start>,<new_count> @@`.
  // The `,<count>` is optional (defaults to 1 when
  // omitted). Anchor at line start so `@@` mentions
  // inside diff context don't false-positive — but
  // since we run `git diff --unified=0` the hunk
  // headers are the only `@@`-bearing lines anyway.
  const hunkRegex = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
  for (const line of rawDiffOutput.split('\n')) {
    const m = hunkRegex.exec(line);
    if (!m || !m[1]) continue;
    const newStart = Number.parseInt(m[1], 10);
    const newCount = m[2] === undefined ? 1 : Number.parseInt(m[2], 10);
    if (newCount === 0) continue; // pure deletion hunk
    for (let ln = newStart; ln < newStart + newCount; ln += 1) {
      lines.add(ln);
    }
  }
  return lines;
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
  readonly mode: 'range' | 'staged' | 'prepush';
  readonly base?: string;
  readonly head?: string;
}

function parseArgs(argv: readonly string[]): RunOptions {
  const args = [...argv];
  const modeFlag = args.shift() ?? '';
  if (!modeFlag.startsWith('--mode=')) {
    emitErrorLine('Usage: clippy-affected --mode=<range|staged|prepush> [base head]');
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
  if (mode === 'prepush') {
    return { mode: 'prepush' };
  }
  emitErrorLine(`Unknown mode: ${mode}`);
  process.exit(2);
}

/**
 * Pre-push stdin parser (Batch #347 — closes
 * ORPHAN-LOW-035).
 *
 * git invokes pre-push hooks with one line per ref on
 * stdin:
 *
 *     <local_ref> <local_sha> <remote_ref> <remote_sha>
 *
 * The hook is expected to inspect each ref + decide
 * whether to allow the push. For our gate the relevant
 * range is `<remote_sha>...<local_sha>` — exactly the
 * commits being introduced by THIS push, not
 * `origin/main...HEAD` (the full branch delta).
 *
 * **Edge cases handled:**
 *
 * - Branch deletion (`local_sha = 0000…`): nothing to
 *   gate; skip.
 * - New branch creation (`remote_sha = 0000…`): fall
 *   back to `origin/main` as the base if it exists,
 *   else skip with a warning. The fallback covers the
 *   "first push of a feature branch" case where there's
 *   no remote-side ancestor to compare against.
 * - Multiple refs in one push: process each
 *   independently; the gate fires if ANY ref's range
 *   has clippy errors. The combined error list groups
 *   per-ref output for operator legibility.
 *
 * **Why stdin parsing (not just `origin/main...HEAD`):**
 * see ORPHAN-LOW-035 closure rationale. A long-lived
 * feature branch with N batches' worth of clippy debt
 * would fail every push under the
 * `origin/main...HEAD` semantic — even pushes that
 * only contain new clippy-clean commits. The pre-push
 * stdin range scopes the gate to exactly the new
 * commits this push is publishing.
 */
interface PrePushRef {
  readonly localRef: string;
  readonly localSha: string;
  readonly remoteRef: string;
  readonly remoteSha: string;
}

const ZERO_SHA_REGEX = /^0+$/;

function parsePrePushStdin(raw: string): PrePushRef[] {
  const refs: PrePushRef[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 4) continue;
    const [localRef, localSha, remoteRef, remoteSha] = parts;
    if (!localRef || !localSha || !remoteRef || !remoteSha) continue;
    refs.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return refs;
}

/**
 * Resolve the diff range for a pre-push ref. Returns
 * `null` if the ref should be skipped (deletion + no
 * fallback for new-branch case).
 */
function rangeForPrePushRef(
  ref: PrePushRef,
): { base: string; head: string } | null {
  // Branch deletion — nothing to clippy.
  if (ZERO_SHA_REGEX.test(ref.localSha)) return null;

  // New branch (no remote ancestor) — fall back to a
  // sensible base.
  //
  // **Stacked-PR support (Batch #2 of PR-195):** if the
  // operator sets `SUDERRA_PREPUSH_BASE_REF` to a
  // specific ref (e.g., `origin/pr194-faz2-d-closure`
  // when stacking PR-195 on PR-194), use that ref as
  // the base. This avoids surfacing 100% of the
  // accumulated debt across the parent PR's commits as
  // "new on this branch". Without the override the
  // fallback is `origin/main`, which is conservative
  // for green-field branches but over-aggressive for
  // stacked PRs.
  if (ZERO_SHA_REGEX.test(ref.remoteSha)) {
    const overrideBase = process.env.SUDERRA_PREPUSH_BASE_REF;
    if (overrideBase) {
      const hasOverride = (() => {
        try {
          execFileSync('git', ['rev-parse', '--verify', '--quiet', overrideBase], {
            cwd: REPO_ROOT,
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          return true;
        } catch {
          return false;
        }
      })();
      if (hasOverride) {
        return { base: overrideBase, head: ref.localSha };
      }
      // Override set but ref not resolvable — log + fall
      // through to origin/main; the operator sees the
      // exact ref name in the gate output to fix.
      emitErrorLine(
        `clippy-affected: SUDERRA_PREPUSH_BASE_REF=${overrideBase} not resolvable; falling back to origin/main.`,
      );
    }
    const hasOriginMain = (() => {
      try {
        execFileSync('git', ['rev-parse', '--verify', '--quiet', 'origin/main'], {
          cwd: REPO_ROOT,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return true;
      } catch {
        return false;
      }
    })();
    if (!hasOriginMain) return null;
    return { base: 'origin/main', head: ref.localSha };
  }

  // Updating an existing branch — exact range is the
  // commits being added.
  return { base: ref.remoteSha, head: ref.localSha };
}

/**
 * Intersect two per-file affected-line maps: a line survives only when BOTH
 * ranges mark it as new. Files whose intersection is empty are dropped, so the
 * result is usable as the gate's affected set directly.
 */
function intersectAffectedLines(
  left: Map<string, Set<number>>,
  right: Map<string, Set<number>>,
): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const [file, lines] of left) {
    const other = right.get(file);
    if (!other) continue;
    const shared = new Set<number>();
    for (const line of lines) {
      if (other.has(line)) shared.add(line);
    }
    if (shared.size > 0) result.set(file, shared);
  }
  return result;
}

/** `git rev-parse --verify` for a ref name; null when it does not resolve. */
function resolveRef(ref: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The integration base whose lines a push must NOT be gated for
 * (PROC-MEDIUM-027).
 *
 * `<remote_sha>...<local_sha>` names every line that is new on the BRANCH
 * since its last push — which, when the push carries a merge from
 * `origin/main`, includes every Rust line main itself added in the meantime.
 * Those lines are main's, they passed main's own gates, and this branch did
 * not write them; re-gating them refused a merge commit on 2026-09-05 for two
 * clippy findings in code the branch never touched, with no honest way
 * through short of a hook bypass.
 *
 * So `gateRange` intersects the branch-side range with
 * `<integration base>...<head>`: a line is gated only when it is new relative
 * to the remote tip AND new relative to the integration base. The three-dot
 * form measures from the merge-base, so this holds whether the branch merged
 * main's tip or an older main.
 *
 * The integration base is `origin/main` unless `SUDERRA_PREPUSH_BASE_REF`
 * names a stacked parent (the same override `rangeForPrePushRef` honours for
 * a first push). Returns null when no candidate resolves, or when the
 * candidate IS the range base already (the intersection would be the
 * identity).
 */
function integrationBaseFor(base: string): string | null {
  const candidates = [process.env.SUDERRA_PREPUSH_BASE_REF, 'origin/main'].filter(
    (ref): ref is string => typeof ref === 'string' && ref.length > 0,
  );
  const baseSha = resolveRef(base);
  for (const ref of candidates) {
    const sha = resolveRef(ref);
    if (!sha) continue;
    return baseSha !== null && sha === baseSha ? null : ref;
  }
  return null;
}

/**
 * Run the per-LINE clippy gate over a single
 * `<base>...<head>` range. Returns the count of
 * error-level diagnostics found on affected lines (0 =
 * gate passed). Errors are written to stderr in the
 * caller's expected canonical format.
 *
 * Extracted from `main()` in Batch #347 so the prepush
 * mode can call it once per ref + aggregate results.
 */
function gateRange(base: string, head: string, label: string): number {
  // Batch #352 — closes the file-set-computation
  // duplication introduced in Batch #347. Pre-#352 this
  // function inlined a `git diff --name-only` IIFE that
  // duplicated the logic in `affectedFiles('range',
  // base, head)`. Calling the existing helper instead
  // keeps the file-set algorithm SSoT-located + makes
  // future changes to the file filter (e.g., a `.rs`
  // extension swap or a path-prefix change) ripple
  // through one place.
  const affected = affectedFiles('range', base, head);

  if (affected.size === 0) {
    emitLine(
      `clippy-affected[${label}]: no Rust files in ${base}...${head}; gate skipped.`,
    );
    return 0;
  }

  let lineRanges = affectedLineRanges(base, head, affected);
  const integrationBase = integrationBaseFor(base);
  if (integrationBase !== null) {
    const branchOnly = intersectAffectedLines(
      lineRanges,
      affectedLineRanges(integrationBase, head, affected),
    );
    const countLines = (ranges: Map<string, Set<number>>): number =>
      Array.from(ranges.values()).reduce((sum, set) => sum + set.size, 0);
    const excluded = countLines(lineRanges) - countLines(branchOnly);
    if (excluded > 0) {
      emitLine(
        `clippy-affected[${label}]: ${excluded} line(s) in ${base}...${head} are already on ${integrationBase} (merged in, not written here); gating only lines new to both.`,
      );
    }
    lineRanges = branchOnly;
    for (const file of Array.from(affected)) {
      if (!lineRanges.has(file)) affected.delete(file);
    }
    if (affected.size === 0) {
      emitLine(
        `clippy-affected[${label}]: every Rust line in ${base}...${head} is already on ${integrationBase}; gate skipped.`,
      );
      return 0;
    }
  }
  const totalAffectedLines = Array.from(lineRanges.values()).reduce(
    (sum, set) => sum + set.size,
    0,
  );
  emitLine(
    `clippy-affected[${label}]: scanning ${affected.size} file(s) / ${totalAffectedLines} line(s) in ${base}...${head}…`,
  );

  if (!existsSync(resolve(RUST_CRATE_DIR, 'Cargo.toml'))) {
    emitErrorLine(
      `clippy-affected: no Cargo.toml at ${RUST_CRATE_DIR}; gate cannot run.`,
    );
    process.exit(2);
  }

  const all = runClippy();
  const errorsInAffectedLines = all.filter((d) => {
    if (d.level !== 'error') return false;
    const repoRelative = repoRelativeFromClippyPath(d.primaryFile);
    if (!affected.has(repoRelative)) return false;
    const fileLines = lineRanges.get(repoRelative);
    if (!fileLines) return false;
    for (let ln = d.primaryLineStart; ln <= d.primaryLineEnd; ln += 1) {
      if (fileLines.has(ln)) return true;
    }
    return false;
  });

  if (errorsInAffectedLines.length === 0) {
    emitLine(
      `clippy-affected[${label}]: 0 errors on affected lines.`,
    );
    return 0;
  }

  emitErrorLine(
    `clippy-affected[${label}]: FAILED — ${errorsInAffectedLines.length} error(s) on affected lines:`,
  );
  emitErrorLine('');
  for (const diag of errorsInAffectedLines) {
    emitErrorLine(diag.rendered.trimEnd());
    emitErrorLine('');
  }
  return errorsInAffectedLines.length;
}

function printDenyListReminder(): void {
  emitErrorLine(
    'New code on affected lines must satisfy the crate-level clippy deny-list (',
  );
  emitErrorLine(
    '  clippy::unwrap_used / clippy::expect_used / clippy::indexing_slicing /',
  );
  emitErrorLine(
    '  clippy::print_stdout / clippy::print_stderr / clippy::dbg_macro /',
  );
  emitErrorLine(
    '  clippy::large_stack_arrays / clippy::unimplemented / clippy::todo',
  );
  emitErrorLine(
    ').',
  );
  emitErrorLine(
    'Legacy violations on untouched lines are not blocked — only new code is gated.',
  );
  emitErrorLine(
    'See ORPHAN-MEDIUM-029 + Batch #343/#346/#347 commits for architectural rationale.',
  );
}

/**
 * Preservation-namespace predicate (2026-06-10 repo consolidation).
 *
 * WHY: `refs/heads/rescue/**` is the quarantine namespace for
 * state-capture snapshots (parked worktree WIP, stash exports,
 * pre-rewrite lineage tips). These refs preserve OTHER sessions'
 * historical working-tree states verbatim; their content is, by
 * definition, not integration-bound — anything landing on main is
 * regenerated on a fresh branch and passes the full gate suite there.
 * Gating a rescue push on clippy would force mutating someone else's
 * parked snapshot to satisfy a lint the snapshot never claimed to
 * pass, which destroys the evidentiary value of the capture.
 *
 * WHAT: prepush mode skips (with an explicit notice) any ref whose
 * REMOTE destination is under refs/heads/rescue/. The remote ref is
 * the gated coordinate — pushing INTO rescue/ is preservation;
 * pushing FROM a rescue checkout to a normal branch is still gated.
 */
function isPreservationRef(remoteRef: string): boolean {
  return remoteRef.startsWith('refs/heads/rescue/');
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.mode === 'prepush') {
    // Read git's pre-push stdin protocol.
    const stdin = readFileSync(0, 'utf8');
    const refs = parsePrePushStdin(stdin);
    if (refs.length === 0) {
      emitLine('clippy-affected[prepush]: no refs on stdin; gate skipped.');
      return;
    }
    let totalErrors = 0;
    for (const ref of refs) {
      if (isPreservationRef(ref.remoteRef)) {
        emitLine(
          `clippy-affected[prepush]: ref ${ref.localRef} → ${ref.remoteRef} skipped (rescue/ preservation namespace — snapshot pushes are not integration-bound; see gate header).`,
        );
        continue;
      }
      const range = rangeForPrePushRef(ref);
      if (!range) {
        emitLine(
          `clippy-affected[prepush]: ref ${ref.localRef} → ${ref.remoteRef} skipped (deletion or new-branch with no origin/main fallback).`,
        );
        continue;
      }
      const label = `${ref.localRef}→${ref.remoteRef}`;
      totalErrors += gateRange(range.base, range.head, label);
    }
    if (totalErrors > 0) {
      printDenyListReminder();
      process.exit(1);
    }
    return;
  }

  if (opts.mode !== 'range' || !opts.base || !opts.head) {
    emitErrorLine(
      'clippy-affected: per-LINE filtering requires --mode=range with explicit base + head refs (or --mode=prepush via git pre-push stdin).',
    );
    emitErrorLine(
      '  Staged-mode per-line tracked at ORPHAN-LOW-035 (filed Batch #346).',
    );
    process.exit(2);
  }

  const errors = gateRange(opts.base, opts.head, 'range');
  if (errors > 0) {
    printDenyListReminder();
    process.exit(1);
  }
}

// Guard main() invocation behind the require.main check
// so this module can be imported by tests without
// triggering the CLI's argv parsing + execution.
// `require.main === module` is true only when this file
// is the entry point (invoked via `ts-node` or `node`).
// When imported as a library (e.g., from
// `clippy-affected.spec.ts`), main() is skipped.
if (require.main === module) {
  main();
}

// Exported for testing.
export {
  affectedFiles,
  affectedLineRanges,
  intersectAffectedLines,
  isPreservationRef,
  parseDiffHunkLines,
  parsePrePushStdin,
  rangeForPrePushRef,
  parseArgs,
  repoRelativeFromClippyPath,
  type ClippyDiagnostic,
  type PrePushRef,
  type RunOptions,
};
