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
 *   - CHANGELOG.md                                         — historical record
 *   - .claude/{agents.legacy,agents-enterprise-v2,knowledge}/** — agent prompts may reference banned phrases in rule definitions
 *   - CLAUDE.md                                            — canonical source of the banned list
 *   - tools/gates/banned-phrase.ts                         — this file itself
 *   - tests/invariants/**                                  — invariant specs may reference banned phrases by name
 *
 * Usage:
 *   ts-node tools/gates/banned-phrase.ts --mode=staged        # pre-commit hook
 *   ts-node tools/gates/banned-phrase.ts --mode=range A B     # CI PR check
 *   ts-node tools/gates/banned-phrase.ts --mode=commit        # last commit body only
 *   ts-node tools/gates/banned-phrase.ts --mode=file <path>   # ad-hoc single file
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
const BANNED_PHRASES: readonly BannedPhraseRule[] = [
  { phrase: /\bfor now\b/i, allowIf: null, label: 'for now' },
  { phrase: /\binterim solution\b/i, allowIf: null, label: 'interim solution' },
  { phrase: /\binterim\b/i, allowIf: null, label: 'interim' },
  { phrase: /\btemporary\b/i, allowIf: null, label: 'temporary' },
  { phrase: /\bpragmatic\b/i, allowIf: null, label: 'pragmatic' },
  { phrase: /\bsimpler approach\b/i, allowIf: null, label: 'simpler approach' },
  { phrase: /\bmiddle ground\b/i, allowIf: null, label: 'middle ground' },
  { phrase: /\bfor momentum\b/i, allowIf: null, label: 'for momentum' },
  { phrase: /\bjust this commit\b/i, allowIf: null, label: 'just this commit' },
  {
    phrase: /\bdeferred\b/i,
    // Tracked deferral = ANY of:
    //   - Full inline contract: owner:@<user> + deadline:YYYY-MM-DD + #FINDING-ID
    //   - Plan phase reference: "Phase <N>" or "W<N>" linking to plan file
    //   - Explicit plan reference: "abstract-brewing-mochi" | "declarative-riding-shamir"
    //   - Finding ID reference on same line
    allowIf:
      /(owner\s*:\s*@[\w-]+.*deadline\s*:\s*\d{4}-\d{2}-\d{2}.*#[A-Z]+-[A-Z]+-\d+)|(\bPhase\s+\d(\.\d)?\b)|(\bW\d+(\.\d+)?\b)|(abstract-brewing-mochi|declarative-riding-shamir)|(#[A-Z][A-Z0-9]+-(CRITICAL|HIGH|MEDIUM|LOW)-\d{3})/i,
    label: 'deferred (without plan phase / W-N / finding ID reference)',
  },
  {
    phrase: /\bout of scope\b/i,
    allowIf: /(ADR-\d+|docs\/reviews\/|docs\/adr\/|\bPhase\s+\d|\bW\d+)/i,
    label: 'out of scope (without ADR / review / plan reference)',
  },
  { phrase: /\bgood enough\b/i, allowIf: null, label: 'good enough' },
  { phrase: /\bsufficient for now\b/i, allowIf: null, label: 'sufficient for now' },
];

const EXEMPT_PATHS: readonly RegExp[] = [
  /^docs\/adr\//,
  /^docs\/reviews\//,
  /^docs\/architecture\//,
  /^docs\/compliance\//,
  /^CHANGELOG\.md$/,
  /^\.claude\/agents\.legacy\//,
  /^\.claude\/agents-enterprise-v2\//,
  /^\.claude\/knowledge\//,
  /^\.claude\/test-agents\//,
  /^CLAUDE\.md$/,
  /^tools\/gates\/banned-phrase\.(ts|mjs)$/,
  /^tools\/gates\/banned-phrase\.test\.(ts|mjs)$/,
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

function isExempt(relPath: string): boolean {
  return EXEMPT_PATHS.some((re) => re.test(relPath));
}

function scanContent(content: string, sourceLabel: string): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    for (const rule of BANNED_PHRASES) {
      const match = rule.phrase.exec(line);
      if (!match) continue;
      if (rule.allowIf && rule.allowIf.test(line)) continue;
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
  return scanContent(content, relPath);
}

function scanCommitBody(): Violation[] {
  const body = run('git log -1 --pretty=%B');
  return scanContent(body, '<last commit message>');
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
    violations.push(...scanContent(body, `<commit ${shortSha} message>`));
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
      violations.push(...scanFile(f));
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
