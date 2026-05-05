#!/usr/bin/env ts-node
/**
 * Commit-msg validator gate — Phase 2 of
 * /root/.claude/plans/abstract-brewing-mochi.md (also tracked as
 * docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#Phase-2).
 *
 * Enforces CLAUDE.md "Review Finding Traceability" rule across three
 * invocation surfaces:
 *
 *   1. Commit-msg hook  — fires on every local `git commit` BEFORE the
 *      commit object is written; gets the prepared message file and
 *      refuses fix/security/refactor(agentic,phase-*) commits that lack a
 *      `Closes: docs/reviews/<agent>/<date>-<topic>.md#<FINDING-ID>`
 *      trailer pointing to an existing review file and a registered
 *      finding ID.
 *   2. Range mode       — CI PR gate: walks every commit between base
 *      and head, enforces the same rule, tolerates commits enumerated
 *      in PRE_PHASE6_SHAS (commits that landed before the registry
 *      existed and cannot be amended under the force-push ban).
 *   3. Last-commit mode — local smoke test / post-commit sanity.
 *
 * Promoted 1:1 from tools/scripts/validate-closes-footer.mjs; the
 * commit-msg mode is new so pre-commit hook coverage becomes symmetric
 * with the banned-phrase gate (they run from the same husky plumbing).
 *
 * Usage:
 *   ts-node tools/gates/commit-msg-validator.ts --mode=msg-file <path>   # husky commit-msg hook
 *   ts-node tools/gates/commit-msg-validator.ts --mode=range <base> <head>  # CI PR range check
 *   ts-node tools/gates/commit-msg-validator.ts --mode=commit             # last commit body (smoke)
 *
 * Exit codes:
 *   0 — clean
 *   1 — violation detected
 *   2 — usage error
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Resolve repo root via `git rev-parse --show-toplevel`
// (Batch #349) — switched away from
// `dirname(fileURLToPath(import.meta.url))` because the
// `import.meta` reference forced Node to load this file
// as ESM at the import time of `commit-msg-validator.spec.ts`,
// which then conflicted with ts-node's CommonJS
// compilation of the spec file ("ReferenceError: exports
// is not defined in ES module scope"). The git-rev-parse
// pattern is CommonJS-clean + already used by
// `tools/gates/clippy-affected.ts` (Batch #343); standardizing
// removes the ESM/CommonJS interop trap from the test
// surface.
const REPO_ROOT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return process.cwd();
  }
})();
const REGISTRY_PATH = resolve(REPO_ROOT, 'docs', 'reviews', '_registry', 'findings.jsonl');

/**
 * Conventional-commit subject prefixes that REQUIRE a Closes: trailer.
 *
 *   fix()                         — closes a bug finding
 *   security()                    — closes a security finding
 *   refactor(agentic,phase-*)     — closes a plan-phase-scoped finding
 *   feat()                        — closes a feature-tracking finding
 *                                   (Batch #285 fix for ORPHAN-MEDIUM-025;
 *                                   pre-Batch-#285 feat commits bypassed
 *                                   the trailer check entirely, so 38
 *                                   feat batches in the 2026-04-25
 *                                   session shipped with dangling
 *                                   `Closes: ULTRA-HIGH-NNN` trailers
 *                                   pointing to unregistered IDs without
 *                                   the gate noticing — see
 *                                   ORPHAN-HIGH-024 + ORPHAN-MEDIUM-025).
 *
 * Architectural reasoning: every architectural change in this codebase
 * (whether bug-fix, security hardening, refactor, or new feature) MUST
 * be traceable to a finding in the registry. The
 * `Review Finding Traceability` discipline (CLAUDE.md) is universal —
 * the regex was historically narrow, this batch widens it to match.
 */
const REQUIRE_CLOSES_TYPES = /^(fix|security|refactor\(agentic,phase-|feat)/;

/** Hard format for the trailer; stricter than a free-text "closes" mention. */
const CLOSES_TRAILER_REGEX =
  /^Closes:\s+(\S+?)#([A-Z][A-Z0-9]+-(?:CRITICAL|HIGH|MEDIUM|LOW)-\d{3})\s*$/;

/**
 * Commits landed BEFORE the registry + this gate existed. Amending is
 * forbidden under the force-push ban, so these short SHAs are allow-
 * listed. Going forward, the set does not grow.
 *
 * Governed by P0-HIGH-005 (phantom infrastructure) retroactive amnesty —
 * captured in docs/reviews/_registry/findings.jsonl.
 */
const PRE_PHASE6_SHAS: ReadonlySet<string> = new Set([
  // Commits that landed BEFORE the registry was seeded OR used the old
  // short-form finding-ID format (e.g. `#P0-1` instead of the current
  // `#P0-CRITICAL-001`). Amending is forbidden under the force-push ban,
  // so these specific SHAs are allowlisted. The set is frozen — every new
  // commit is expected to carry a long-form `#PREFIX-SEVERITY-NNN`
  // trailer referencing a live registry entry.
  '32839e24', // Phase 0 audit close — pre-registry
  'f931f935', // Phase 0.1 agents-legacy archive — pre-registry
  '2dd09f99', // Phase 4 invariants — pre-registry
  'b907c235', // Phase 5 root-cause-auditor — pre-registry
  '71474fbf', // W2-E INFRA-1 backup SHA guard — pre-Phase-6 landing
  'fc00fc19', // W3-C follow-up eslint-plugin rename — pre-Phase-6 landing
  'c0e7d492', // W3-D backup-manifest-invariant CI gate — pre-Phase-6 landing
  '955c8caa', // Phase 8.4 queryKey ESLint rule — old `#P0-1` short-form trailer
  '973394b3', // Phase 11 platform-services split — old `#P0-5` short-form trailer
]);

interface Commit {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly body: string;
}

interface Trailer {
  readonly path: string;
  readonly findingId: string;
}

interface Violation {
  readonly sha: string;
  readonly subject: string;
  readonly reason: string;
}

function run(cmd: string): string {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function loadRegistryIds(): Set<string> {
  if (!existsSync(REGISTRY_PATH)) return new Set();
  const content = readFileSync(REGISTRY_PATH, 'utf8').trim();
  if (!content) return new Set();
  const ids = new Set<string>();
  for (const line of content.split('\n')) {
    try {
      const entry = JSON.parse(line) as { id?: unknown };
      if (typeof entry.id === 'string') ids.add(entry.id);
    } catch {
      // Malformed lines are tolerated here — the hash-chain integrity
      // invariant in finding-registry-integrity.spec.ts is responsible
      // for flagging them; we just want best-effort ID coverage.
    }
  }
  return ids;
}

/**
 * Load the set of `ORPHAN-{SEV}-NNN` IDs from
 * `docs/reviews/orphan-findings.md` (Batch #342 — closes
 * ORPHAN-MEDIUM-032).
 *
 * **Why orphan IDs need their own loader:** orphan
 * findings live in markdown (not the hash-chained
 * registry) by architectural design — they record
 * plan-independent observations that are not gated by
 * the registry's append-only crash-safety contract. But
 * fix commits can legitimately reference orphan IDs in
 * `Closes:` trailers (e.g., a hygiene batch that closes
 * an ORPHAN-LOW finding). Pre-#342 the validator rejected
 * any non-registry ID, blocking multi-Closes commits
 * that referenced both UH-NNN (registry) AND ORPHAN-NNN
 * (markdown) targets — even when the registry side was
 * legitimately valid. The architectural fix is per-prefix
 * routing: ORPHAN-* trailers validate against this loader;
 * non-ORPHAN trailers continue to validate against the
 * registry as before.
 *
 * **Parser shape:** scans for `^## (ORPHAN-{SEV}-NNN)`
 * headings. The orphan-findings.md format is documented
 * at the file's top + has been stable since the doc was
 * established. A future restructure that breaks the
 * heading convention also fails the orphan-findings
 * structural tests (out-of-band).
 */
const ORPHAN_FINDINGS_PATH = resolve(
  REPO_ROOT,
  'docs/reviews/orphan-findings.md',
);

const ORPHAN_HEADING_REGEX =
  /^##\s+(ORPHAN-(?:CRITICAL|HIGH|MEDIUM|LOW)-\d{3})\b/;

function loadOrphanIds(): Set<string> {
  if (!existsSync(ORPHAN_FINDINGS_PATH)) return new Set();
  const ids = new Set<string>();
  const content = readFileSync(ORPHAN_FINDINGS_PATH, 'utf8');
  for (const line of content.split('\n')) {
    const m = ORPHAN_HEADING_REGEX.exec(line);
    if (m && m[1]) ids.add(m[1]);
  }
  return ids;
}

function extractTrailers(body: string): Trailer[] {
  const out: Trailer[] = [];
  for (const line of body.split('\n')) {
    const m = CLOSES_TRAILER_REGEX.exec(line);
    if (m && m[1] && m[2]) {
      out.push({ path: m[1], findingId: m[2] });
    }
  }
  return out;
}

function commitsInRange(baseRef: string, headRef: string): Commit[] {
  const raw = run(`git log ${baseRef}..${headRef} --format=%H%x09%s%x09%b%x1f`);
  if (!raw) return [];
  return raw
    .split('\u001f')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((chunk): Commit => {
      const [sha = '', subject = '', ...rest] = chunk.split('\t');
      return {
        sha,
        shortSha: sha.slice(0, 8),
        subject,
        body: rest.join('\t'),
      };
    });
}

function lastCommit(): Commit | null {
  const raw = run('git log -1 --format=%H%x09%s%x09%b');
  if (!raw) return null;
  const [sha = '', subject = '', ...rest] = raw.split('\t');
  return {
    sha,
    shortSha: sha.slice(0, 8),
    subject,
    body: rest.join('\t'),
  };
}

/** Build a synthetic Commit from a commit-msg file (no SHA yet). */
function commitFromMsgFile(path: string): Commit {
  const raw = readFileSync(path, 'utf8');
  // Strip comment lines that git injects into COMMIT_EDITMSG.
  const cleaned = raw
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .trim();
  const [subject = '', ...bodyLines] = cleaned.split('\n');
  // Drop the conventional empty line between subject and body if present.
  while (bodyLines.length > 0 && bodyLines[0] === '') bodyLines.shift();
  return {
    sha: '<pending>',
    shortSha: '<pending>',
    subject,
    body: bodyLines.join('\n'),
  };
}

function validateCommit(
  commit: Commit,
  registryIds: ReadonlySet<string>,
  orphanIds: ReadonlySet<string>,
  isPreGate: (commit: Commit) => boolean,
): Violation[] {
  const needsCloses = REQUIRE_CLOSES_TYPES.test(commit.subject);
  if (!needsCloses) return [];
  if (isPreGate(commit)) return [];

  const trailers = extractTrailers(commit.body);
  if (trailers.length === 0) {
    return [
      {
        sha: commit.shortSha,
        subject: commit.subject,
        reason:
          'missing Closes: trailer (fix/security/refactor(agentic,phase-*) commits must close a finding)',
      },
    ];
  }

  const out: Violation[] = [];
  for (const { path, findingId } of trailers) {
    const reviewFile = resolve(REPO_ROOT, path);
    if (!existsSync(reviewFile)) {
      out.push({
        sha: commit.shortSha,
        subject: commit.subject,
        reason: `Closes: trailer references missing review file: ${path}`,
      });
    }
    // Per-prefix routing (Batch #342 — closes
    // ORPHAN-MEDIUM-032): ORPHAN-{SEV}-NNN IDs are
    // validated against the orphan-findings.md heading
    // index; all other prefixes (ULTRA-HIGH-*,
    // AUDIT-*, DEPLOY-CRITICAL-*, etc.) continue to
    // validate against the hash-chained registry. This
    // unblocks commits that legitimately close BOTH a
    // registry-tracked finding AND a referenced orphan
    // finding in the same batch.
    if (findingId.startsWith('ORPHAN-')) {
      if (!orphanIds.has(findingId)) {
        out.push({
          sha: commit.shortSha,
          subject: commit.subject,
          reason: `Closes: trailer references unknown ORPHAN finding ID: ${findingId} (no matching "## ${findingId}" heading in docs/reviews/orphan-findings.md)`,
        });
      }
    } else if (!registryIds.has(findingId)) {
      out.push({
        sha: commit.shortSha,
        subject: commit.subject,
        reason: `Closes: trailer references unknown finding ID: ${findingId} (not in docs/reviews/_registry/findings.jsonl)`,
      });
    }
  }
  return out;
}

function report(violations: Violation[]): void {
  console.error('Closes: trailer validation FAILED:');
  for (const v of violations) {
    console.error(`  ${v.sha}  ${v.subject}`);
    console.error(`    -> ${v.reason}`);
  }
  console.error('');
  console.error('Every fix/security/refactor(agentic,phase-*) commit must carry:');
  console.error('  Closes: docs/reviews/<agent>/<date>-<topic>.md#<FINDING-ID>');
  console.error('');
  console.error('Finding IDs live in: docs/reviews/_registry/findings.jsonl');
  console.error('Finding-ID regex:    {PREFIX}-(CRITICAL|HIGH|MEDIUM|LOW)-NNN');
  console.error('Phase 6 reference:   docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#Phase-6');
}

function main(): void {
  const [, , modeFlag, ...args] = process.argv;
  if (!modeFlag) {
    console.error(
      'Usage: ts-node tools/gates/commit-msg-validator.ts --mode=<msg-file|range|commit> [args]',
    );
    process.exit(2);
  }

  const mode = modeFlag.replace(/^--mode=/, '');
  const registryIds = loadRegistryIds();
  const orphanIds = loadOrphanIds();
  const violations: Violation[] = [];

  if (mode === 'msg-file') {
    const [msgPath] = args;
    if (!msgPath) {
      console.error('msg-file mode requires the commit-msg path: --mode=msg-file <path>');
      process.exit(2);
    }
    const abs = resolve(REPO_ROOT, msgPath);
    if (!existsSync(abs)) {
      console.error(`msg-file not found: ${msgPath}`);
      process.exit(2);
    }
    // No PRE_PHASE6_SHAS applies — the commit has no SHA yet.
    violations.push(
      ...validateCommit(
        commitFromMsgFile(abs),
        registryIds,
        orphanIds,
        () => false,
      ),
    );
  } else if (mode === 'range') {
    const [baseRef, headRef] = args;
    if (!baseRef || !headRef) {
      console.error('range mode requires two refs: --mode=range <base> <head>');
      process.exit(2);
    }
    const commits = commitsInRange(baseRef, headRef);
    if (commits.length === 0) {
      console.log('No commits in range; nothing to validate.');
      return;
    }
    for (const c of commits) {
      violations.push(
        ...validateCommit(
          c,
          registryIds,
          orphanIds,
          (cm) => PRE_PHASE6_SHAS.has(cm.shortSha),
        ),
      );
    }
  } else if (mode === 'commit') {
    const c = lastCommit();
    if (!c) {
      console.log('No HEAD commit; nothing to validate.');
      return;
    }
    violations.push(
      ...validateCommit(
        c,
        registryIds,
        orphanIds,
        (cm) => PRE_PHASE6_SHAS.has(cm.shortSha),
      ),
    );
  } else {
    console.error(`Unknown mode: ${mode}`);
    process.exit(2);
  }

  if (violations.length === 0) {
    console.log('Closes: trailer validation passed.');
    return;
  }

  report(violations);
  process.exit(1);
}

// Guard main() invocation so this module can be imported
// by tests without triggering the CLI's argv parsing +
// execution. See clippy-affected.ts module doc for the
// architectural rationale (Batch #348 established this
// pattern as the SSoT for CLI-script-with-exported-
// helpers in `tools/gates/`).
if (require.main === module) {
  main();
}

// Exported for testing (Batch #349 — closes the test-
// coverage gap from Batch #342 where the orphan-routing
// extensions to `validateCommit` + the new `loadOrphanIds`
// helper shipped without unit tests).
export {
  CLOSES_TRAILER_REGEX,
  ORPHAN_HEADING_REGEX,
  REQUIRE_CLOSES_TYPES,
  commitFromMsgFile,
  extractTrailers,
  loadOrphanIds,
  loadRegistryIds,
  validateCommit,
  type Commit,
  type Trailer,
  type Violation,
};
