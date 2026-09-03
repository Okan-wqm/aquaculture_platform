#!/usr/bin/env ts-node
/**
 * Banned-construct gate — Round-2 cluster-0 train infrastructure
 * (plan: /root/.claude/plans/repoyu-b-r-toparlamak-st-yorum-declarative-russell.md,
 * Phase C step 4; audit finding: mimari denetçi B1).
 *
 * Sibling of banned-phrase.ts: that gate guards PROSE hedges in any file;
 * this gate guards CODE constructs that CLAUDE.md "Code Quality Standards"
 * bans outright. The two stay separate tools because their rule semantics
 * differ — phrases need allowIf context windows (a hedge word can be
 * legitimate meta-discussion); constructs are mechanical (an `as any` in
 * a TS file is a violation regardless of the surrounding sentence).
 *
 * Banned constructs (canonical list: CLAUDE.md "Code Quality Standards"):
 *   - `as any`                      — find the correct type or write a generic
 *   - `as unknown as X`             — casting hack; fix the interface
 *   - `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` — fix the type error
 *   - `it.skip(` / `test.skip(` / `describe.skip(` / `xit(` / `xdescribe(` /
 *     `xtest(`                      — test silencing (Susturma yasak)
 *   - `eslint-disable`              — lint silencing; ESLint config is the
 *                                     SSOT for lint policy
 *   - bare `getRepository(`         — bypasses tenant isolation; use
 *                                     getScopedRepository()
 *
 * WHY a gate when ESLint already errors on some of these: .eslintrc relaxes
 * `no-explicit-any` to OFF for spec/test/e2e files — a banned cast that
 * hides in a spec file sails through lint AND through review fatigue. The
 * gate has no per-file-type relaxation: spec files are scanned exactly like
 * production files (the 2-agent plan audit identified this exact bypass).
 *
 * Scan scope: ADDED LINES ONLY in both staged and range modes. Unlike
 * banned-phrase's staged mode (whole staged file — prose hedges have low
 * legacy density), construct debt is dense in historical spec files; a
 * whole-file staged scan would block every commit that touches a legacy
 * spec for reasons unrelated to the commit. The gate's invariant is "no
 * NEW banned construct enters the repository" — added-lines-only in every
 * diff-based mode enforces exactly that, no more, no less. Pre-existing
 * debt is burned down by the lint/cleanup train, not by ambushing
 * unrelated commits.
 *
 * Manual-review items NOT automated here (AHEAD checklist item 3 keeps
 * them human-judged): optional-chaining (`?.`) growth and JSON-column
 * escapes. Both are legitimate TypeScript in many contexts; a regex gate
 * would drown reviewers in false positives, which erodes trust in the
 * gates that ARE mechanical. They stay in the port-review checklist.
 *
 * Usage:
 *   ts-node tools/gates/banned-construct.ts --mode=staged          # pre-commit — staged ADDED lines
 *   ts-node tools/gates/banned-construct.ts --mode=range A B       # CI PR check — range ADDED lines
 *   ts-node tools/gates/banned-construct.ts --mode=file <path>     # ad-hoc / fixtures — whole file
 *
 * Exit codes:
 *   0 — clean
 *   1 — banned construct detected
 *   2 — usage error
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import {
  type AddedLine,
  collectRangeAddedLines,
  collectStagedAddedLines,
} from './git-diff-ranges';

const REPO_ROOT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return process.cwd();
  }
})();

function writeStdout(message = ''): void {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message = ''): void {
  process.stderr.write(`${message}\n`);
}

interface BannedConstructRule {
  readonly construct: RegExp;
  readonly label: string;
  readonly remedy: string;
  /** Per-rule path exemptions on top of the global EXEMPT_PATHS. */
  readonly exemptPaths?: readonly RegExp[];
}

const BANNED_CONSTRUCTS: readonly BannedConstructRule[] = [
  {
    construct: /\bas\s+any\b/,
    label: 'as any',
    remedy: 'find the correct type or write a generic (CLAUDE.md Code Quality Standards)',
  },
  {
    construct: /\bas\s+unknown\s+as\b/,
    label: 'as unknown as',
    remedy: 'fix the interface or the implementation, not the cast',
  },
  {
    construct: /@ts-ignore\b/,
    label: '@ts-ignore',
    remedy: 'fix the type error',
  },
  {
    construct: /@ts-expect-error\b/,
    label: '@ts-expect-error',
    remedy: 'fix the type error',
  },
  {
    construct: /@ts-nocheck\b/,
    label: '@ts-nocheck',
    remedy: 'fix the file, never opt it out of the compiler',
  },
  {
    construct: /\b(?:it|test|describe)\.skip\s*\(/,
    label: 'test .skip(',
    remedy: 'fix the test or delete it with a tracked finding — silencing is banned',
  },
  {
    construct: /\bx(?:it|describe|test)\s*\(/,
    label: 'xit( / xdescribe( / xtest(',
    remedy: 'fix the test or delete it with a tracked finding — silencing is banned',
  },
  {
    construct: /eslint-disable/,
    label: 'eslint-disable',
    remedy:
      'fix the violation; if the rule itself is wrong, change .eslintrc (the lint-policy SSOT) with a documented WHY',
  },
  {
    construct: /\bgetRepository\s*\(/,
    label: 'bare getRepository(',
    remedy: 'use getScopedRepository() — raw repository access bypasses tenant isolation',
    exemptPaths: [
      // The scoping SSOT itself wraps the raw TypeORM API — that is the
      // one place the bare call legitimately lives.
      /^libs\/backend-common\//,
      // Mock factories construct repository doubles around the raw shape.
      /^platform\/libs\/testing\//,
    ],
  },
];

/**
 * Global exemptions — files whose PURPOSE is to name the banned
 * constructs (this gate, its spec, verification fixtures). Mirrors the
 * self-exemption precedent in banned-phrase.ts. Markdown and other
 * non-code files are excluded by CODE_FILE instead of by path.
 */
const EXEMPT_PATHS: readonly RegExp[] = [
  /^tools\/gates\/banned-construct\.ts$/,
  /^tools\/gates\/banned-construct\.spec\.ts$/,
  /^tests\/invariants\/fixtures\//,
  // new-aria/ is a verbatim transport copy of the ARIA surface destined for its
  // own repository; every construct in it exists at a canonical path that is
  // range-grandfathered here. The copy is not authored code.
  /^new-aria\//,
  // The ESLint gate-preservation baseline (A2) embeds the very constructs
  // it tests as fixture STRINGS — getRepository(), JSON.stringify(x,y,2),
  // JWT_SECRET reads — to prove the no-restricted-* gates fire on them.
  // Same self-exemption rationale as banned-construct.spec.ts above.
  /^tools\/lint-gates\//,
  // The flat ESLint config + its per-project policy data DEFINE the
  // no-restricted-syntax gates; their human-readable messages necessarily
  // quote the banned constructs (e.g. "Direct getRepository() bypasses…").
  // These files are the gate SSOT — exempting them is the same precedent as
  // .eslintrc.json was implicitly exempt (the gate cannot ban its own text).
  /^eslint\.config\.mjs$/,
  /^eslint\.project-overrides\.mjs$/,
  // Codegen output (graphql-codegen typed-document-node / client-preset) emits the
  // standard `... as unknown as DocumentNode<...>` TypedDocumentNode wrapper.
  // Generated files are never hand-edited, so the hand-written-code cast ban does
  // not apply to them (they regenerate from the schema; the codegen-up-to-date gate
  // owns their correctness).
  /\/generated\//,
];

/** Constructs are TypeScript/JavaScript concepts; other files are out of the gate's domain (prose discussion lives in docs and is banned-phrase territory). */
const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export interface Violation {
  readonly path: string;
  readonly line: number;
  readonly label: string;
  readonly remedy: string;
  readonly context: string;
}

function isExempt(relPath: string, rule: BannedConstructRule): boolean {
  if (EXEMPT_PATHS.some((re) => re.test(relPath))) return true;
  if (rule.exemptPaths?.some((re) => re.test(relPath))) return true;
  return false;
}

export function scanAddedLines(lines: readonly AddedLine[]): Violation[] {
  const violations: Violation[] = [];
  for (const line of lines) {
    if (!CODE_FILE.test(line.path)) continue;
    for (const rule of BANNED_CONSTRUCTS) {
      if (isExempt(line.path, rule)) continue;
      if (!rule.construct.test(line.text)) continue;
      violations.push({
        path: line.path,
        line: line.lineNumber,
        label: rule.label,
        remedy: rule.remedy,
        context: line.text.trim().slice(0, 180),
      });
    }
  }
  return violations;
}

function fileAsAddedLines(relPath: string): readonly AddedLine[] {
  const abs = resolve(REPO_ROOT, relPath);
  if (!existsSync(abs)) return [];
  return readFileSync(abs, 'utf8')
    .split('\n')
    .map((text, index) => ({ path: relPath, lineNumber: index + 1, text }));
}

function parseArgv(rawArgv: string[]): {
  mode: string;
  flags: Set<string>;
  positional: string[];
} {
  const flags = new Set<string>();
  const positional: string[] = [];
  let modeArg: string | null = null;
  for (const tok of rawArgv) {
    if (tok.startsWith('--mode=')) {
      modeArg = tok.replace(/^--mode=/, '');
      continue;
    }
    if (tok.startsWith('--')) {
      flags.add(tok.replace(/^--/, ''));
      continue;
    }
    positional.push(tok);
  }
  return { mode: modeArg ?? 'staged', flags, positional };
}

function main(): void {
  const { mode, flags, positional } = parseArgv(process.argv.slice(2));
  const ignoreExemptions = flags.has('ignore-exemptions');

  let lines: readonly AddedLine[];
  if (mode === 'staged') {
    lines = collectStagedAddedLines(REPO_ROOT);
  } else if (mode === 'range') {
    const [baseRef, headRef] = positional;
    if (!baseRef || !headRef) {
      writeStderr('range mode requires two refs: --mode=range <base> <head>');
      process.exit(2);
    }
    lines = collectRangeAddedLines(REPO_ROOT, baseRef, headRef);
  } else if (mode === 'file') {
    const [fp] = positional;
    if (!fp) {
      writeStderr('file mode requires a path: --mode=file <path>');
      process.exit(2);
    }
    lines = fileAsAddedLines(relative(REPO_ROOT, resolve(fp)));
  } else {
    writeStderr(`Unknown mode: ${mode}`);
    process.exit(2);
  }

  const violations = ignoreExemptions
    ? scanAllIgnoringExemptions(lines)
    : scanAddedLines(lines);

  if (violations.length === 0) {
    writeStdout('No banned constructs detected.');
    return;
  }

  writeStderr('Banned-construct violations detected:');
  for (const v of violations) {
    writeStderr(`  ${v.path}:${v.line}  "${v.label}"`);
    writeStderr(`    > ${v.context}`);
    writeStderr(`    fix: ${v.remedy}`);
  }
  writeStderr('');
  writeStderr('Constructs banned by CLAUDE.md — "Code Quality Standards" section.');
  writeStderr('Spec/test files are NOT exempt: the gate exists precisely because');
  writeStderr('.eslintrc relaxes no-explicit-any for them.');
  process.exit(1);
}

function scanAllIgnoringExemptions(lines: readonly AddedLine[]): Violation[] {
  const violations: Violation[] = [];
  for (const line of lines) {
    if (!CODE_FILE.test(line.path)) continue;
    for (const rule of BANNED_CONSTRUCTS) {
      if (!rule.construct.test(line.text)) continue;
      violations.push({
        path: line.path,
        line: line.lineNumber,
        label: rule.label,
        remedy: rule.remedy,
        context: line.text.trim().slice(0, 180),
      });
    }
  }
  return violations;
}

// require.main guard (clippy-affected.ts precedent): the spec imports
// scanAddedLines directly; without the guard, the import would execute
// the CLI and exit the test runner.
if (require.main === module) {
  main();
}
