/**
 * Spec module-mode invariant (PROC-MEDIUM-010 — closed by PR-37)
 * ============================================================================
 *
 * # The invariant
 *
 * Every TypeScript spec file under `**\/__tests__/**\/*.spec.ts` MUST be a
 * MODULE (carry at least one `import` or `export` statement at top level).
 *
 * # Why it exists (the footgun this gate prevents)
 *
 * TypeScript treats a `.ts` file with **no** `import` / `export` statement
 * as a **SCRIPT**, not a module. All top-level declarations in a script
 * file go into the GLOBAL scope. If two spec files in the same project
 * both run in script mode and both declare a `const runCheck` at the top
 * level, they collide:
 *
 *   - strict-tsc rejects with "Cannot redeclare block-scoped variable
 *     'runCheck'" — surface symptom, easy to spot.
 *   - WORSE: cross-file type-checking merges the declarations. A test in
 *     spec A that calls `runCheck(report, args)` (2 args) gets type-
 *     checked against spec B's `runCheck(): Array<…>` no-arg signature,
 *     producing cascading "Expected 0 arguments, got 2" / "Property
 *     'exitCode' does not exist on Array" errors that LOOK unrelated.
 *
 * This was caught in PR #180 (libs/backend-common, PROC-MEDIUM-007 ratchet
 * §31). Two gate specs (`gha-sha-pin-gate.spec.ts`,
 * `npm-audit-gate.spec.ts`) used only `require(...)` at the top — no
 * import/export. The collision produced 5 cascading errors that
 * collapsed to 0 from one fix: adding `export {};` to each.
 *
 * The fix is one line per file, but the BUG is invisible to eslint and
 * the test runner — only strict-tsc surfaces it. This invariant
 * prevents recurrence by checking the property at PR time.
 *
 * # Detection algorithm
 *
 * Lexical scan, not AST: walk the file and find any line that starts
 * with `import ` (with space, distinguishing from `important` etc.) or
 * `export ` / `export{` / `export*`. The TypeScript spec rules are:
 *
 *   "A module is a source file containing at least one top-level
 *    import or export statement."
 *
 * Comments are matched too because the test runner doesn't strip them
 * before module-vs-script classification — but a comment containing
 * "import " will never accidentally satisfy the test because comments
 * never start with `import` at column 0 unless authored that way; the
 * scan checks for a leading non-comment-character match.
 *
 * # Exempt patterns
 *
 *   - `**\/jest.config.*` — jest config files, not test specs
 *   - test fixtures and snapshots — not in the spec scope anyway
 *
 * # When this spec fails
 *
 *   Add `export {};` at the top of the offending spec file. That's
 *   ALL it takes. The test runner is unaffected, the file's runtime
 *   behaviour is identical, and the strict-tsc collision is closed
 *   forever.
 *
 * # References
 *
 *   - docs/reviews/2026-04-25-implementation-notes/observations.md §31
 *     (PR-29 root cause + monorepo-wide rationale)
 *   - docs/reviews/_registry/findings.jsonl (PROC-MEDIUM-010, OPEN
 *     until this PR closes it)
 *   - TypeScript Handbook § "Modules" (script-vs-module distinction)
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Spec roots that this invariant scans. Each is walked recursively for
 * `*.spec.ts` files. The set is intentionally explicit — adding a new
 * spec root requires a deliberate edit so script-mode loopholes can't
 * sneak in via an unscanned path.
 */
const SPEC_ROOTS: readonly string[] = [
  'apps',
  'libs',
  'platform',
  'tests',
  'web',
];

/**
 * Files that are allowed to be script-mode. Empty on purpose — every
 * known case in the monorepo has been migrated. If a future case
 * surfaces that legitimately cannot carry an import/export (vanishingly
 * rare), add the relative path here with a justification comment.
 */
const EXEMPT_RELATIVE_PATHS: readonly string[] = [];

/**
 * Walks `dir` recursively, returning every `.spec.ts` path (absolute).
 * Excludes `node_modules`, `dist`, and `coverage` to keep walk time
 * bounded.
 */
function walkSpecs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.spec.ts')) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Returns true iff `source` is module-mode per the TypeScript spec —
 * carries at least one top-level `import` or `export` statement.
 *
 * Detection is line-oriented: a line starting with `import ` (followed
 * by whitespace) or `export` (followed by space, `{`, `*`, or `=`)
 * counts. Leading whitespace is allowed (block-scoped exports etc. are
 * NOT permitted at top level in TS, but lex tolerance keeps the rule
 * simple). Comments and string contents are skipped via a "first non-
 * comment character" check — a `//` line never qualifies, neither does
 * a `/* ... import ... *\/` block-comment line.
 */
function isModule(source: string): boolean {
  const lines = source.split('\n');
  let inBlockComment = false;
  for (const raw of lines) {
    const line = raw.trimStart();
    if (line.length === 0) continue;
    // Line/block comment skip. Block-comment continuation is detected
    // by the simple presence of `*/` later on the same line; nested
    // comments aren't a TS thing.
    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.startsWith('//')) continue;
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    // Module-mode triggers. Match `import ` (with whitespace) and
    // export with the legal continuations: `export {`, `export *`,
    // `export =`, `export default`, `export type`, `export const`,
    // `export function`, `export class`, `export interface`,
    // `export enum`, `export namespace`, `export async`.
    if (/^import\s/.test(line) || /^import\(/.test(line)) return true;
    if (/^export(\s|\{|\*|=)/.test(line)) return true;
  }
  return false;
}

describe('Spec module-mode invariant (PROC-MEDIUM-010)', () => {
  const allSpecs: string[] = [];
  for (const root of SPEC_ROOTS) {
    allSpecs.push(...walkSpecs(path.join(REPO_ROOT, root)));
  }
  const exemptAbsolute = new Set(
    EXEMPT_RELATIVE_PATHS.map((rel) => path.join(REPO_ROOT, rel)),
  );

  it('scope is non-empty (otherwise this invariant is a no-op regression)', () => {
    expect(allSpecs.length).toBeGreaterThan(0);
  });

  it('every *.spec.ts under apps/, libs/, platform/, tests/, web/ is module-mode', () => {
    const violations: string[] = [];
    for (const absPath of allSpecs) {
      if (exemptAbsolute.has(absPath)) continue;
      const source = fs.readFileSync(absPath, 'utf8');
      if (!isModule(source)) {
        violations.push(path.relative(REPO_ROOT, absPath));
      }
    }
    if (violations.length > 0) {
      const message = [
        `${violations.length} spec file(s) are SCRIPT-mode (no top-level import/export):`,
        ...violations.map((v) => `  - ${v}`),
        '',
        'Fix: add `export {};` at the top of each file.',
        'Why: script-mode files leak top-level declarations into the global',
        'scope. Two specs declaring the same name (e.g. `runCheck`) collide,',
        'and cross-file type-checking merges their signatures, producing',
        'cascading strict-tsc errors that look unrelated. Surfaced by PR #180',
        '(libs/backend-common, observations §31). Closes PROC-MEDIUM-010.',
      ].join('\n');
      throw new Error(message);
    }
  });
});
