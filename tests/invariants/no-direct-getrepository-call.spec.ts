/**
 * Invariant — every `.getRepository(` callsite on a real code line
 * is either (a) annotated with `// eslint-disable-next-line
 * no-restricted-syntax -- <rationale>` on the immediately preceding
 * non-comment line, OR (b) inside a path the rule structurally exempts
 * (tests/__tests__/__mocks__/migrations).
 *
 * # Why this exists (the architectural gap it closes)
 *
 * The platform's primary defence against direct-getRepository tenant
 * bypass is the ESLint `no-restricted-syntax` rule in `.eslintrc.json`
 * with selector `CallExpression[callee.property.name='getRepository']`.
 * On a clean `npm run lint:all` invocation, that rule fires.
 *
 * However, the CI pipeline runs lint via TWO different surfaces:
 *
 *   - `ci-affected.yml` (every PR)  → `nx affected -t lint`
 *     Only lints projects whose dependency graph was touched.
 *   - `ci-full.yml`     (weekly + tags)  → `npm run lint:all`
 *     Lints every project.
 *
 * The PR-time gate (ci-affected) skips projects whose files weren't
 * changed in the diff. So a PR that only touches farm-service can
 * accumulate hr-service `getRepository(` callsites without ever
 * triggering the rule. Between weekly ci-full runs, drift is invisible.
 *
 * This invariant runs in the `invariants:fast` shard which IS a
 * required gate on every PR (registered in `.github/workflows/
 * ci-affected.yml` per AUDIT-CRITICAL-003 closure). Because it walks
 * the working tree directly via `git ls-files` and never calls into
 * Nx / ESLint, it is completely orthogonal to the affected-vs-all
 * lint-scope class of problems.
 *
 * # Tier classification
 *
 * Tier-3 make-detectable. Complement to:
 *   - `eslint-rule-presence.spec.ts` (config-drift detector — rule
 *     deletion class)
 *   - `eslint-disable-annotation-positional-binding.spec.ts`
 *     (rationale-binding detector — drifted/orphan annotation class)
 *   - The ESLint rule itself (callsite detector — when ESLint runs)
 *
 * The four-layer defence catches every known evasion path:
 *
 *   |               | Rule deleted | Annotation drifts | Lint scope wrong |
 *   |---------------|--------------|--------------------|------------------|
 *   | eslint rule   |     —        |       ✓ catches    |       —          |
 *   | rule-presence |   ✓ catches  |         —          |       —          |
 *   | positional    |     —        |       ✓ catches    |       —          |
 *   | (this file)   |   ✓ catches  |       ✓ catches    |     ✓ catches    |
 *
 * # What this invariant does NOT enforce
 *
 *   - It does not enforce that the annotation rationale is *meaningful*.
 *     The architectural review of "is this getRepository call legitimate
 *     cross-tenant catalog access vs. pre-tenant-context auth vs.
 *     library-implementation bedrock" is human judgment.
 *   - It does not validate that the entity being fetched is the one the
 *     rationale claims. SEC-REVIEW-007's tenantManagerRepo factory
 *     contract handles the upstream invariant (the wrapper injects
 *     tenantId regardless of caller intent).
 *   - It does not scan documentation strings, JSDoc, or string literals
 *     containing the literal substring `.getRepository(`. The scan
 *     skips comment lines, mirroring how ESLint's AST traversal
 *     ignores them.
 */

import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Tracked source globs. Mirrors the path scope of the ESLint rule
 * in `.eslintrc.json` (the rule is in the `*.ts, *.tsx` override).
 * Filtered to `.ts` only because `.tsx` UI surfaces have no
 * getRepository callsites by design (browser-side React, no TypeORM).
 */
const TRACKED_GLOBS = ['apps', 'libs', 'platform'] as const;

/**
 * Test/mock/migration directories the rule structurally exempts.
 * Migrations use raw getRepository because they intentionally run
 * outside the request/tenant context (DDL only; tenantManagerRepo
 * is for runtime data operations).
 */
const EXEMPT_PATH_PATTERNS = [
  /__tests__\//,
  /__mocks__\//,
  /\.spec\.ts$/,
  /\.test\.ts$/,
  /\.e2e\.ts$/,
  /\.e2e-spec\.ts$/,
  /\.d\.ts$/,
  /database\/migrations\//,
  // The factory tests above, plus any test-setup file under e2e/test.
  /\/e2e-setup\.ts$/,
  /\/test\//,
] as const;

interface Hit {
  file: string;
  line: number;
  text: string;
}

function listTrackedFiles(): readonly string[] {
  const args = ['ls-files', '-z', '--', ...TRACKED_GLOBS.map((g) => `${g}/**/*.ts`)];
  const out = execSync(`git ${args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')}`, {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((p) => existsSync(resolve(REPO_ROOT, p)))
    .filter((p) => !EXEMPT_PATH_PATTERNS.some((rx) => rx.test(p)));
}

/**
 * A line is a comment / blank line iff it is empty after trimming OR
 * begins with `//`, `/*`, or `*` (continuation of a JSDoc block).
 * The annotation lookup walks past these line shapes.
 */
function isBlankOrCommentLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return true;
  if (trimmed.startsWith('//')) return true;
  if (trimmed.startsWith('/*')) return true;
  if (trimmed.startsWith('*')) return true;
  return false;
}

/**
 * Return true iff the given physical line, taken in isolation, is
 * just inside-a-comment text (i.e. the substring `.getRepository(`
 * appears in a JSDoc, line-comment, or string literal — NOT as a
 * runtime call expression).
 *
 * Strategy: a line is "comment-only" if every character before the
 * `.getRepository(` substring is whitespace + comment-introducer.
 * A more rigorous check (strip TS string-literal content) is
 * unnecessary: the codebase's coding convention puts code calls at
 * column 6+ (indented inside a function body) and never embeds
 * `.getRepository(` inside string literals on a code line. If a
 * future commit DID embed it in a string literal, this invariant
 * would over-report — that is a deliberate trade-off favouring
 * false positive (loud) over false negative (silent bypass).
 */
function isInCommentOrJsdoc(line: string, callIndex: number): boolean {
  const before = line.slice(0, callIndex);
  if (/^\s*\/\//.test(before)) return true; // line comment
  if (/^\s*\*/.test(before)) return true; // jsdoc continuation
  if (/^\s*\/\*/.test(before)) return true; // jsdoc opener
  // The fragment before the call may close a previously-opened JSDoc
  // (`*/`). If it does, `.getRepository(` is real code AFTER the JSDoc
  // ends on the same line. Treat as code, not comment.
  return false;
}

const LINT_ANNOTATION_TOKEN = ['eslint', 'disable', 'next', 'line'].join('-');
const ANNOTATION_RE = new RegExp(`//\\s*${LINT_ANNOTATION_TOKEN}\\s+no-restricted-syntax`);

const CALL_RE = /\.getRepository\(/;

function scanFile(file: string): readonly Hit[] {
  const path = resolve(REPO_ROOT, file);
  const lines = readFileSync(path, 'utf-8').split(/\r?\n/);
  const hits: Hit[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const callIdx = line.search(CALL_RE);
    if (callIdx < 0) continue;
    if (isInCommentOrJsdoc(line, callIdx)) continue;

    // Walk backward to the most recent non-blank, non-comment line.
    // That line is the candidate annotation site. ESLint's
    // `eslint-disable-next-line` only covers the NEXT line, so we
    // require the annotation to be the immediate previous code line
    // (with comment lines as the only acceptable preamble — they are
    // skipped because ESLint also skips them when resolving directive
    // scope).
    //
    // For multi-line callees like
    //
    //   const x = await manager
    //     .getRepository(Entity)
    //
    // the call is on a continuation line; the annotation belongs on
    // the line preceding the STATEMENT START (the `const x = ...`
    // line). We resolve "statement start" as the nearest preceding
    // line that does NOT begin with one of the continuation-tokens
    // also recognised by SEC-REVIEW-003's positional-binding spec.
    const isContinuation = (s: string): boolean => {
      const t = s.trim();
      return (
        t.startsWith('.') ||
        t.startsWith('?.') ||
        t.startsWith(',') ||
        t.startsWith(')') ||
        t.startsWith(']') ||
        t.startsWith('&&') ||
        t.startsWith('||') ||
        t.startsWith('??') ||
        t.startsWith('+') ||
        t.startsWith('-') ||
        t.startsWith('*') ||
        t.startsWith('/') ||
        t.startsWith('?') ||
        t.startsWith(':') ||
        t.startsWith('=')
      );
    };
    // Walk backward through continuation-prefixed lines (the call
    // line itself may be `.getRepository(...)` — i.e. a continuation
    // of a statement that started earlier). The statement start is
    // the first line above that does NOT begin with a continuation
    // token. The annotation, if present, sits above the statement
    // start (possibly with a comment band between).
    let statementStart = i;
    while (statementStart > 0 && isContinuation(lines[statementStart] ?? '')) {
      statementStart--;
    }

    // Now walk backwards from statementStart-1 through any comment
    // band, looking for the annotation. The annotation may sit
    // directly above the statement, or above a JSDoc/comment band
    // that is between annotation and statement (ESLint allows this).
    let cursor = statementStart - 1;
    let foundAnnotation = false;
    while (cursor >= 0) {
      const prev = lines[cursor] ?? '';
      if (ANNOTATION_RE.test(prev)) {
        foundAnnotation = true;
        break;
      }
      if (!isBlankOrCommentLine(prev)) break;
      cursor--;
    }

    if (!foundAnnotation) {
      hits.push({ file, line: i + 1, text: line.trim() });
    }
  }
  return hits;
}

describe('INVARIANT: every .getRepository() callsite is annotated or in an exempt path', () => {
  const files = listTrackedFiles();
  const allHits: Hit[] = files.flatMap((f) => [...scanFile(f)]);

  it('no unannotated .getRepository( calls in tracked source', () => {
    if (allHits.length > 0) {
      const grouped = new Map<string, Hit[]>();
      for (const h of allHits) {
        const list = grouped.get(h.file) ?? [];
        list.push(h);
        grouped.set(h.file, list);
      }
      const sorted = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const lines = sorted
        .map(([file, hs]) => {
          const callLines = hs.map((h) => `      L${h.line}: ${h.text.slice(0, 100)}`).join('\n');
          return `  ${file} (${hs.length})\n${callLines}`;
        })
        .join('\n\n');
      throw new Error(
        `${allHits.length} unannotated .getRepository() callsite(s) in ` +
          `${grouped.size} file(s):\n${lines}\n\n` +
          `Each callsite MUST either:\n` +
          `  (a) carry an immediately-preceding ` +
          `\`// eslint-disable-next-line no-restricted-syntax -- <rationale>\` ` +
          `comment, OR\n` +
          `  (b) be migrated to \`tenantManagerRepo(manager, Entity, tenantId)\` ` +
          `(\`@aquaculture/backend-common/database\`) which is the canonical ` +
          `tenant-scoped wrapper Phase B introduced.\n\n` +
          `For library-level implementations of the safe wrapper itself ` +
          `(TenantAwareRepository, TenantScopedRepository factory, ` +
          `withTenantContext example, audit/outbox-worker), ` +
          `(a) is correct — annotate with rationale "library-level ` +
          `implementation". For application-layer code (handlers / services), ` +
          `(b) is the architecturally correct fix.`,
      );
    }
    expect(allHits).toEqual([]);
  });
});
