#!/usr/bin/env ts-node
/**
 * Banned-phrase gate — Phase 2 of /root/.claude/plans/abstract-brewing-mochi.md.
 *
 * Scans staged / changed files + commit messages for phrases forbidden by
 * CLAUDE.md's "Architectural Approach" section. Fails the run when any
 * match is found in a non-exempt path.
 *
 * Banned phrases (canonical in CLAUDE.md and _shared/tier-claim-syntax.md:49-60):
 *   - "for now"
 *   - "interim solution" / "interim"
 *   - "temporary"
 *   - "pragmatic"
 *   - "simpler approach"
 *   - "middle ground"
 *   - "for momentum"
 *   - "just this commit"
 *   - "deferred" (unless paired with owner + deadline + finding ID OR plan phase reference)
 *   - "out of scope" (unless paired with ADR / review / plan reference)
 *   - "good enough"
 *   - "sufficient for now"
 *
 * Exempt paths (from CLAUDE.md + _shared/tier-claim-syntax.md:62):
 *   - docs/adr/**, docs/reviews/**, docs/architecture/**  — may discuss rejected alternatives
 *   - docs/plans/**                                        — plan docs carry tracked-deferral vocabulary
 *                                                            with owner+deadline+finding-ID and quote
 *                                                            the banned-phrase list itself verbatim
 *   - CHANGELOG.md                                         — historical record
 *   - .claude/{agents,agents.legacy,shared,knowledge,skills}/** — agent prompts, knowledge
 *                                                            SSoT, and skills catalog may legitimately
 *                                                            reference banned phrases in rule
 *                                                            definitions and architectural-gate citations
 *   - CLAUDE.md                                            — canonical source of the banned list
 *   - tools/gates/banned-phrase.ts                         — this file itself
 *   - tests/invariants/**                                  — invariant specs may reference banned phrases by name
 *
 * Usage:
 *   ts-node tools/gates/banned-phrase.ts --mode=staged        # pre-commit hook — full staged file
 *   ts-node tools/gates/banned-phrase.ts --mode=range A B     # CI PR check — ADDED LINES only
 *   ts-node tools/gates/banned-phrase.ts --mode=commit        # last commit body only
 *   ts-node tools/gates/banned-phrase.ts --mode=file <path>   # ad-hoc single file — whole file
 *
 * Range mode rationale: on long-lived feature branches pre-existing hits
 * (e.g. SQL enum values like 'deferred' in hr migration 1736000000000)
 * would retrigger on every PR build. The ADDED-LINES-only filter respects
 * the invariant "the gate catches banned phrases this PR introduces" —
 * pre-existing hits are grandfathered. allowIf windowing still reads the
 * full file context around the hit so a plan reference one or two lines
 * away outside the diff still exempts.
 *
 * Exit codes:
 *   0 — clean
 *   1 — banned phrase detected
 *   2 — usage error
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface BannedPhraseRule {
  phrase: RegExp;
  allowIf: RegExp | null;
  label: string;
}

/**
 * Each banned phrase as a case-insensitive word-boundary regex plus an
 * optional exemption matcher. If the exemption pattern matches on the same
 * line, the hit is suppressed (e.g., "deferred" followed by plan-phase
 * reference is a tracked deferral, not a banned hedge).
 */
/**
 * Meta-discussion allowIf — recognises commit bodies / review notes
 * that DESCRIBE a hedge-word being removed, rather than ADVOCATE for
 * hedging. The architectural claim is: the gate's invariant is "no
 * hedge language advocating compromise in code/commits", not "no
 * hedge word appears in any line at all". Describing a fix of
 * `"Temporary ID"` → `"Client-side optimistic ID"` is the inverse
 * of the gate's target class.
 *
 * Match requires BOTH of these to be present on the same line (the
 * allowIf callsite tests one-line windows against the phrase's line):
 *
 *   Precondition A — context marker:
 *     - quoted string `"..."`                    (normal prose quote-back), OR
 *     - git-diff leading `-` or `+`              (rebase-style diff quote), OR
 *     - a `L<number>` file:line reference        (commit body pointing to a fix)
 *
 *   Precondition B — transformation intent:
 *     - a `→` arrow                              (ASCII alternative `->` covered), OR
 *     - a diff-style `-` / `+` line prefix       (already satisfies via A)
 *
 * The old permissive branch `→` alone is REMOVED — a stray arrow on
 * a plain-prose hedge line (e.g. "we'll do temporary fix → Monday")
 * no longer slips through.
 */
const META_DISCUSSION_ALLOW_IF =
  /(^[-+]\s*["'])|("[^"\n]*"\s*(→|->))|(\bL\d+\s*:\s*"[^"\n]*"\s*(→|->)?)|("[^"\n]*"\s*\bL\d+)/;

const BANNED_PHRASES: readonly BannedPhraseRule[] = [
  { phrase: /\bfor now\b/i, allowIf: META_DISCUSSION_ALLOW_IF, label: 'for now' },
  { phrase: /\binterim solution\b/i, allowIf: META_DISCUSSION_ALLOW_IF, label: 'interim solution' },
  { phrase: /\binterim\b/i, allowIf: META_DISCUSSION_ALLOW_IF, label: 'interim' },
  { phrase: /\btemporary\b/i, allowIf: META_DISCUSSION_ALLOW_IF, label: 'temporary' },
  { phrase: /\bpragmatic\b/i, allowIf: META_DISCUSSION_ALLOW_IF, label: 'pragmatic' },
  { phrase: /\bsimpler approach\b/i, allowIf: META_DISCUSSION_ALLOW_IF, label: 'simpler approach' },
  { phrase: /\bmiddle ground\b/i, allowIf: META_DISCUSSION_ALLOW_IF, label: 'middle ground' },
  { phrase: /\bfor momentum\b/i, allowIf: META_DISCUSSION_ALLOW_IF, label: 'for momentum' },
  { phrase: /\bjust this commit\b/i, allowIf: META_DISCUSSION_ALLOW_IF, label: 'just this commit' },
  {
    phrase: /\bdeferred\b/i,
    // Tracked deferral = ANY of:
    //   - Full inline contract: owner:@<user> + deadline:YYYY-MM-DD + #FINDING-ID
    //   - Plan phase reference: "Phase <N>" or "W<N>" linking to plan file
    //   - Explicit plan reference: "abstract-brewing-mochi" | "declarative-riding-shamir"
    //   - Finding ID reference on same line
    allowIf:
      /(owner\s*:\s*@[\w-]+.*deadline\s*:\s*\d{4}-\d{2}-\d{2}.*#[A-Z]+-[A-Z]+-\d+)|(\b[Pp]hase[\s-]\d+(\.\d+)?\b)|(\bW\d+(\.\d+)?\b)|(abstract-brewing-mochi|declarative-riding-shamir)|(#[A-Z][A-Z0-9]+-(CRITICAL|HIGH|MEDIUM|LOW)-\d{3})/i,
    label: 'deferred (without plan phase / W-N / finding ID reference)',
  },
  {
    phrase: /\bout of scope\b/i,
    allowIf: /(ADR-\d+|docs\/reviews\/|docs\/adr\/|\b[Pp]hase[\s-]\d|\bW\d+|abstract-brewing-mochi|declarative-riding-shamir)/i,
    label: 'out of scope (without ADR / review / plan reference)',
  },
  { phrase: /\bgood enough\b/i, allowIf: META_DISCUSSION_ALLOW_IF, label: 'good enough' },
  { phrase: /\bsufficient for now\b/i, allowIf: META_DISCUSSION_ALLOW_IF, label: 'sufficient for now' },
];

const EXEMPT_PATHS: readonly RegExp[] = [
  /^docs\/adr\//,
  /^docs\/reviews\//,
  /^docs\/architecture\//,
  /^docs\/compliance\//,
  /^docs\/plans\//,
  /^CHANGELOG\.md$/,
  /^\.claude\/agents\.legacy\//,
  /^\.claude\/agents\//,
  /^\.claude\/shared\//,
  /^\.claude\/knowledge\//,
  /^\.claude\/skills\//,
  /^CLAUDE\.md$/,
  /^tools\/gates\/banned-phrase\.(ts|mjs)$/,
  /^tools\/gates\/banned-phrase\.test\.(ts|mjs)$/,
  /^tools\/scripts\/seed-finding-registry\.(mjs|ts)$/, // finding seed text references banned phrases by name (meta-text)
  /^tests\/invariants\//,
];

interface Violation {
  source: string;
  line: number;
  column: number;
  phrase: string;
  context: string;
}

interface Commit {
  sha: string;
  subject: string;
  body: string;
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

function stagedFiles(): string[] {
  return run('git diff --cached --name-only --diff-filter=ACM').split('\n').filter(Boolean);
}

function rangeFiles(baseRef: string, headRef: string): string[] {
  return run(`git diff ${baseRef}..${headRef} --name-only --diff-filter=ACM`)
    .split('\n')
    .filter(Boolean);
}

/**
 * Return the set of line indices (1-based, post-image) that were added or
 * modified in `file` between `baseRef` and `headRef`. Parses a `-U0` diff
 * — only the post-image line numbers of lines beginning with `+` (not the
 * `+++` file header). Removals do not advance the post-image counter; a
 * modification shows up as one `-` plus one `+` at the same logical spot.
 *
 * Used by range mode to scan ONLY the lines that this PR introduced. A
 * pre-existing banned phrase that was never touched by the PR is left
 * alone (otherwise long-lived feature branches surface every historical
 * hit as a new violation — mechanically correct, operationally noise).
 */
function addedLinesInRange(
  baseRef: string,
  headRef: string,
  file: string,
): ReadonlySet<number> {
  const diff = run(`git diff --unified=0 ${baseRef}..${headRef} -- "${file}"`);
  if (!diff) return new Set();
  const added = new Set<number>();
  let postLine = 0;
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk && hunk[1]) {
      postLine = parseInt(hunk[1], 10);
      continue;
    }
    if (line.startsWith('+++')) continue; // file header
    if (line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      added.add(postLine);
      postLine++;
    }
    // `-` lines do NOT advance postLine; blank/context lines do (but -U0
    // emits no context, so this branch is unreachable under our invocation).
  }
  return added;
}

function isExempt(relPath: string): boolean {
  return EXEMPT_PATHS.some((re) => re.test(relPath));
}

/**
 * Width of the allowIf context window (in lines around the hit). Commit
 * bodies and file sections often carry the hit word on one line and the
 * plan-phase reference on an adjacent line; a single-line check
 * produces false positives of the form
 *
 *    ... deferred to the      <- hit here
 *    Phase 4 testing sweep    <- reference here
 *
 * A 3-before / 3-after window is wide enough for natural paragraph
 * wrapping without opening the door to unrelated-paragraph coupling.
 */
const ALLOW_IF_WINDOW_FILE = 3;
/**
 * Commit bodies are short, self-contained units; the plan-phase reference
 * often appears in the subject line while the hedge word appears in the
 * body text many lines away. A per-line window would flag legitimate
 * commits whose subject is already scoped (e.g. `fix(agentic,phase-2)`).
 * For commit-body scans, allowIf is evaluated against the ENTIRE content
 * so the subject line counts. `Infinity` flags this to scanContent.
 */
const ALLOW_IF_WINDOW_COMMIT = Infinity;

function scanContent(content: string, sourceLabel: string, allowIfWindow: number): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    for (const rule of BANNED_PHRASES) {
      const match = rule.phrase.exec(line);
      if (!match) continue;
      if (rule.allowIf) {
        let windowText: string;
        if (allowIfWindow === Infinity) {
          windowText = content;
        } else {
          const windowStart = Math.max(0, i - allowIfWindow);
          const windowEnd = Math.min(lines.length, i + allowIfWindow + 1);
          windowText = lines.slice(windowStart, windowEnd).join('\n');
        }
        if (rule.allowIf.test(windowText)) continue;
      }
      violations.push({
        source: sourceLabel,
        line: i + 1,
        column: match.index + 1,
        phrase: rule.label,
        context: line.trim().slice(0, 180),
      });
    }
  });
  return violations;
}

function scanFile(relPath: string): Violation[] {
  if (isExempt(relPath)) return [];
  const abs = resolve(REPO_ROOT, relPath);
  if (!existsSync(abs)) return [];
  const content = readFileSync(abs, 'utf8');
  return scanContent(content, relPath, ALLOW_IF_WINDOW_FILE);
}

/**
 * Like scanFile but only reports hits whose (1-based) line number is in
 * `onlyLines`. Used by range mode to restrict the gate to lines the PR
 * actually touched. allowIf windowing still sees the full file context
 * so that a reference line one or two lines away (outside the hit set)
 * still exempts the hit.
 */
function scanFileAddedLinesOnly(relPath: string, onlyLines: ReadonlySet<number>): Violation[] {
  if (isExempt(relPath)) return [];
  if (onlyLines.size === 0) return [];
  const abs = resolve(REPO_ROOT, relPath);
  if (!existsSync(abs)) return [];
  const content = readFileSync(abs, 'utf8');
  return scanContent(content, relPath, ALLOW_IF_WINDOW_FILE).filter((v) => onlyLines.has(v.line));
}

function scanCommitBody(): Violation[] {
  const body = run('git log -1 --pretty=%B');
  return scanContent(body, '<last commit message>', ALLOW_IF_WINDOW_COMMIT);
}

/**
 * Commits landed BEFORE this gate existed cannot be expected to comply with
 * its retroactive rules. Amending is forbidden (force-push ban) so these
 * specific SHAs are allowlisted. Going forward the gate runs on every PR.
 *
 * Governed by P0-HIGH-005 (phantom infrastructure) retroactive amnesty —
 * captured in docs/reviews/_registry/findings.jsonl.
 */
const PRE_GATE_SHAS = new Set<string>([
  '32839e24', // Phase 0 — landed before Phase 2 gate infrastructure
  'f931f935', // Phase 0.1
  '2dd09f99', // Phase 4 invariants
  'b907c235', // Phase 5 root-cause-auditor
  '7090c950', // Phase 6 finding registry
  '4eb35921', // Phase 7 CODEOWNERS
  '47bea207', // Phase 2 banned-phrase gate landing itself (META — names the banned words)
  '0af5c197', // W1.5 ADR fix — pre-gate docs commit
  '5703de4e', // W1 Part A unified synthesis — pre-gate docs commit
  '9f977259', // W0 ripple-tracer DRAFT spec — pre-gate docs commit
]);

function scanRangeCommitBodies(baseRef: string, headRef: string): Violation[] {
  const bodies = run(`git log ${baseRef}..${headRef} --pretty=%H%x09%B%x1f`);
  if (!bodies) return [];
  const chunks = bodies
    .split('\u001f')
    .map((c) => c.trim())
    .filter(Boolean);
  const violations: Violation[] = [];
  for (const chunk of chunks) {
    const [sha, ...rest] = chunk.split('\t');
    const body = rest.join('\t');
    const shortSha = sha?.slice(0, 8) ?? '<unknown>';
    if (PRE_GATE_SHAS.has(shortSha)) continue;
    violations.push(...scanContent(body, `<commit ${shortSha} message>`, ALLOW_IF_WINDOW_COMMIT));
  }
  return violations;
}

function main(): void {
  const [, , modeFlag, ...args] = process.argv;
  if (!modeFlag) {
    console.error(
      'Usage: ts-node tools/gates/banned-phrase.ts --mode=<staged|range|commit|file> [args]',
    );
    process.exit(2);
  }

  const mode = modeFlag.replace(/^--mode=/, '');
  const violations: Violation[] = [];

  if (mode === 'staged') {
    for (const f of stagedFiles()) {
      violations.push(...scanFile(f));
    }
  } else if (mode === 'range') {
    const [baseRef, headRef] = args;
    if (!baseRef || !headRef) {
      console.error('range mode requires two refs: --mode=range <base> <head>');
      process.exit(2);
    }
    for (const f of rangeFiles(baseRef, headRef)) {
      const added = addedLinesInRange(baseRef, headRef, f);
      violations.push(...scanFileAddedLinesOnly(f, added));
    }
    violations.push(...scanRangeCommitBodies(baseRef, headRef));
  } else if (mode === 'commit') {
    violations.push(...scanCommitBody());
  } else if (mode === 'file') {
    const [fp] = args;
    if (!fp) {
      console.error('file mode requires a path: --mode=file <path>');
      process.exit(2);
    }
    violations.push(...scanFile(relative(REPO_ROOT, resolve(fp))));
  } else {
    console.error(`Unknown mode: ${mode}`);
    process.exit(2);
  }

  if (violations.length === 0) {
    console.log('No banned phrases detected.');
    return;
  }

  console.error('Banned-phrase violations detected:');
  for (const v of violations) {
    console.error(`  ${v.source}:${v.line}:${v.column}  "${v.phrase}"`);
    console.error(`    > ${v.context}`);
  }
  console.error('');
  console.error('Phrases banned by CLAUDE.md — "Architectural Approach" section:');
  console.error('  for now, interim, temporary, pragmatic, simpler approach, middle ground,');
  console.error(
    '  for momentum, just this commit, deferred*, out of scope*, good enough, sufficient for now',
  );
  console.error(
    '  (* = allowed only with plan phase reference OR owner+deadline+finding-ID for "deferred",',
  );
  console.error('     ADR/review/plan reference for "out of scope")');
  console.error('');
  console.error(
    'If the match is on a legitimate discussion (e.g., ADR documenting rejected alternative),',
  );
  console.error('add the path to EXEMPT_PATHS in tools/gates/banned-phrase.ts AND document why.');
  process.exit(1);
}

main();
