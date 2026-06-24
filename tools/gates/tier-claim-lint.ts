#!/usr/bin/env ts-node
/**
 * tier-claim-lint — enforces tier-claim comment discipline per
 * .claude/shared/tier-claim-syntax.md.
 *
 * Phase 2 deliverable per
 * docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#Phase-2.
 *
 * Validates `// tier-N:` inline comments and `// tier-N-begin:` /
 * `// tier-N-end` block comments against the 4-tier hierarchy and the
 * well-formedness rules in _shared/tier-claim-syntax.md:
 *
 *   R1  Tier number out of range       N must be 1-4
 *   R2  Empty justification            `// tier-N:` with blank body
 *   R3  Unclosed block                 `-begin` without matching `-end`
 *   R4  Orphan end marker              `-end` without preceding `-begin`
 *   R5  Nested block                   second `-begin` before first `-end`
 *   R6  Unapproved tier-4 in domain    `apps/**\/src/**` domain code
 *                                      claiming tier-4 without being in
 *                                      .claude/allowlists/boundary-files.yaml
 *   R7  Missing mechanism reference    justification does not name a
 *                                      concrete mechanism (branded type,
 *                                      ESLint rule, invariant test,
 *                                      migration, CI gate, etc.). Keeps
 *                                      tier-claims from becoming marketing.
 *
 * Scope: regex-based rather than ts-morph AST-based — the rules
 * above are lexical properties of comments, not structural properties
 * of code. Adding ts-morph would double the runtime cost without
 * improving detection. A future semantic validator that cross-checks
 * tier-1 claims against the actual existence of a named branded type
 * is a Phase 4 invariant-suite deliverable, not a gate.
 *
 * Usage:
 *   ts-node tools/gates/tier-claim-lint.ts --mode=staged
 *   ts-node tools/gates/tier-claim-lint.ts --mode=range <base> <head>
 *   ts-node tools/gates/tier-claim-lint.ts --mode=file <path>
 *
 * Exit codes:
 *   0 — clean
 *   1 — tier-claim violation
 *   2 — usage error
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ALLOWLIST_PATH = resolve(
  REPO_ROOT,
  '.claude',
  'allowlists',
  'boundary-files.yaml',
);

/**
 * Well-formed tier-claim patterns. Case-sensitive on the `tier` prefix
 * so we don't false-positive on non-canonical capitalisations elsewhere.
 */
const INLINE_RE = /\/\/\s*tier-([0-9]+)\s*:\s*(.*)$/;
const BEGIN_RE = /\/\/\s*tier-([0-9]+)-begin\s*:\s*(.*)$/;
const END_RE = /\/\/\s*tier-([0-9]+)-end\s*$/;

/**
 * "Mechanism" hints — a non-vague tier claim must mention AT LEAST ONE.
 * Missing all of them means the claim is unverifiable (tier-claim-
 * syntax.md explicitly forbids vague claims). This matches the spirit
 * of the `root-cause-auditor` OVER_CLAIMED detection without requiring
 * that auditor to run.
 */
const MECHANISM_HINTS: readonly RegExp[] = [
  /\bbranded\b/i,
  /\btype\s+system\b/i,
  /\bESLint\b/i,
  /\blint\s+rule\b/i,
  /\bCI\s+(?:invariant|gate|check)\b/i,
  /\binvariant\b/i,
  /\bmigration\b/i,
  /\bDB\s+constraint\b/i,
  /\bschema\s+drift\b/i,
  /\bexhaustive\s+(?:switch|check)\b/i,
  /\b@Column\b/i,
  /\b@Entity\b/i,
  /\bADR-\d+\b/i,
  /\bnever\b/i, // `switch (state: never)`
  /\brepository\s+boundary\b/i,
  /\bRuntime\s+guard\b/i,
  /\bzod\b/i,
  /\bclass-validator\b/i,
  /\bgenerated\b/i,
  /\bcodegen\b/i,
];

type RuleId =
  | 'R1-tier-out-of-range'
  | 'R2-empty-justification'
  | 'R3-unclosed-block'
  | 'R4-orphan-end'
  | 'R5-nested-block'
  | 'R6-unapproved-tier4-in-domain'
  | 'R7-vague-claim';

interface Violation {
  file: string;
  line: number;
  ruleId: RuleId;
  snippet: string;
  message: string;
}

interface BlockTracker {
  tier: number;
  openLine: number;
}

/**
 * Load the boundary-files allowlist. Parse just enough YAML to extract
 * the `path:` values — avoids adding js-yaml as a dependency for a
 * one-field read.
 */
function loadAllowlistPaths(): readonly string[] {
  if (!existsSync(ALLOWLIST_PATH)) return [];
  const raw = readFileSync(ALLOWLIST_PATH, 'utf8');
  const paths: string[] = [];
  for (const line of raw.split('\n')) {
    const m = /^\s*-\s*path\s*:\s*["']?([^"'\n]+?)["']?\s*$/.exec(line);
    if (m && m[1]) paths.push(m[1].trim());
  }
  return paths;
}

function matchesAllowlist(relPath: string, globs: readonly string[]): boolean {
  const normal = relPath.replace(/\\/g, '/');
  for (const glob of globs) {
    // Support only the specific glob forms used in boundary-files.yaml:
    //   exact path, `**` globstar, `*` single-segment, prefix matches.
    const re = new RegExp(
      '^' +
        glob
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '::GS::')
          .replace(/\*/g, '[^/]*')
          .replace(/::GS::/g, '.*') +
        '$',
    );
    if (re.test(normal)) return true;
  }
  return false;
}

const DOMAIN_CODE_RE = /^apps\/[^/]+\/src\//;

function scanContent(relPath: string, content: string, allowlist: readonly string[]): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split('\n');
  const blockStack: BlockTracker[] = [];

  const inDomain = DOMAIN_CODE_RE.test(relPath);
  const isAllowlisted = matchesAllowlist(relPath, allowlist);

  function push(line: number, ruleId: RuleId, snippet: string, message: string): void {
    violations.push({ file: relPath, line, ruleId, snippet, message });
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;

    const endMatch = END_RE.exec(line);
    if (endMatch) {
      const tier = parseInt(endMatch[1] ?? '0', 10);
      const top = blockStack[blockStack.length - 1];
      if (!top) {
        push(
          lineNo,
          'R4-orphan-end',
          line.trim(),
          `orphan "tier-${tier}-end" with no matching "tier-N-begin" above.`,
        );
      } else if (top.tier !== tier) {
        push(
          lineNo,
          'R4-orphan-end',
          line.trim(),
          `tier-${tier}-end does not match the open tier-${top.tier}-begin at line ${top.openLine}.`,
        );
      } else {
        blockStack.pop();
      }
      continue;
    }

    const beginMatch = BEGIN_RE.exec(line);
    if (beginMatch) {
      const tier = parseInt(beginMatch[1] ?? '0', 10);
      const justification = (beginMatch[2] ?? '').trim();
      if (tier < 1 || tier > 4) {
        push(
          lineNo,
          'R1-tier-out-of-range',
          line.trim(),
          `tier-${tier} is out of range (valid: 1-4).`,
        );
      }
      if (justification.length === 0) {
        push(
          lineNo,
          'R2-empty-justification',
          line.trim(),
          'tier-N-begin with empty justification.',
        );
      } else if (!MECHANISM_HINTS.some((re) => re.test(justification))) {
        push(
          lineNo,
          'R7-vague-claim',
          line.trim(),
          'tier-N justification does not name a concrete mechanism (branded type / ESLint rule / invariant / migration / ADR / @Column / etc.).',
        );
      }
      if (blockStack.length > 0) {
        push(
          lineNo,
          'R5-nested-block',
          line.trim(),
          `nested tier-${tier}-begin while tier-${blockStack[blockStack.length - 1]?.tier ?? '?'}-begin is still open.`,
        );
      }
      if (tier === 4 && inDomain && !isAllowlisted) {
        push(
          lineNo,
          'R6-unapproved-tier4-in-domain',
          line.trim(),
          'tier-4 claim in apps/**/src/** requires an entry in .claude/allowlists/boundary-files.yaml.',
        );
      }
      blockStack.push({ tier, openLine: lineNo });
      continue;
    }

    const inlineMatch = INLINE_RE.exec(line);
    if (inlineMatch) {
      const tier = parseInt(inlineMatch[1] ?? '0', 10);
      const justification = (inlineMatch[2] ?? '').trim();
      if (tier < 1 || tier > 4) {
        push(
          lineNo,
          'R1-tier-out-of-range',
          line.trim(),
          `tier-${tier} is out of range (valid: 1-4).`,
        );
        continue;
      }
      if (justification.length === 0) {
        push(lineNo, 'R2-empty-justification', line.trim(), 'tier-N with empty justification.');
        continue;
      }
      if (!MECHANISM_HINTS.some((re) => re.test(justification))) {
        push(
          lineNo,
          'R7-vague-claim',
          line.trim(),
          'tier-N justification does not name a concrete mechanism (branded type / ESLint rule / invariant / migration / ADR / @Column / etc.).',
        );
      }
      if (tier === 4 && inDomain && !isAllowlisted) {
        push(
          lineNo,
          'R6-unapproved-tier4-in-domain',
          line.trim(),
          'tier-4 claim in apps/**/src/** requires an entry in .claude/allowlists/boundary-files.yaml.',
        );
      }
    }
  }

  // Any unclosed block tiers remaining at EOF.
  for (const open of blockStack) {
    push(
      open.openLine,
      'R3-unclosed-block',
      `// tier-${open.tier}-begin:`,
      `tier-${open.tier}-begin at line ${open.openLine} has no matching tier-${open.tier}-end before end-of-file.`,
    );
  }

  return violations;
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
  return run('git diff --cached --name-only --diff-filter=ACM')
    .split('\n')
    .filter((f) => f.length > 0 && /\.(ts|tsx)$/.test(f));
}

function rangeFiles(baseRef: string, headRef: string): string[] {
  return run(`git diff ${baseRef}..${headRef} --name-only --diff-filter=ACM`)
    .split('\n')
    .filter((f) => f.length > 0 && /\.(ts|tsx)$/.test(f));
}

function scanFile(relPath: string, allowlist: readonly string[]): Violation[] {
  const abs = resolve(REPO_ROOT, relPath);
  if (!existsSync(abs)) return [];
  const content = readFileSync(abs, 'utf8');
  return scanContent(relPath, content, allowlist);
}

function report(violations: readonly Violation[]): void {
  console.error('Tier-claim lint FAILED:');
  for (const v of violations) {
    console.error(`  [${v.ruleId}]  ${v.file}:${v.line}`);
    console.error(`    ${v.message}`);
    console.error(`    > ${v.snippet}`);
  }
  console.error('');
  console.error('Tier-claim syntax reference:');
  console.error(
    '  .claude/shared/tier-claim-syntax.md',
  );
  console.error(
    'Allowlist (boundary files exempt from R6 tier-4-in-domain rule):',
  );
  console.error('  .claude/allowlists/boundary-files.yaml');
}

function main(): void {
  const [, , rawModeFlag, ...args] = process.argv;
  // Default mode for `npm run gates:all` / bare-shell invocations.
  // CI always supplies --mode=range explicitly.
  const modeFlag = rawModeFlag ?? '--mode=staged';
  if (!rawModeFlag) {
    console.error('[tier-claim-lint] no --mode supplied; defaulting to --mode=staged.');
  }

  const allowlist = loadAllowlistPaths();
  const mode = modeFlag.replace(/^--mode=/, '');
  let files: string[] = [];

  if (mode === 'staged') {
    files = stagedFiles();
  } else if (mode === 'range') {
    const [baseRef, headRef] = args;
    if (!baseRef || !headRef) {
      console.error('range mode requires two refs: --mode=range <base> <head>');
      process.exit(2);
    }
    files = rangeFiles(baseRef, headRef);
  } else if (mode === 'file') {
    const [filePath] = args;
    if (!filePath) {
      console.error('file mode requires a path: --mode=file <path>');
      process.exit(2);
    }
    files = [relative(REPO_ROOT, resolve(filePath))];
  } else {
    console.error(`Unknown mode: ${mode}`);
    process.exit(2);
  }

  const violations: Violation[] = [];
  for (const f of files) {
    violations.push(...scanFile(f, allowlist));
  }

  if (violations.length === 0) {
    console.log(`Tier-claim lint passed (${files.length} file(s) scanned).`);
    return;
  }

  report(violations);
  process.exit(1);
}

main();
