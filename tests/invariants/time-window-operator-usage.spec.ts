/**
 * APA-319 — no inline time-window `FindOperator` predicates in `apps/**`.
 *
 * A recency window ("rows WITHIN the last N ms") and a retention/staleness
 * window ("rows OLDER than N ms ago") are mirror opposites built from nearly
 * identical inline code — `MoreThanOrEqual(new Date(Date.now() - ms))` vs
 * `LessThan(new Date(Date.now() - ms))` — with the intended DIRECTION encoded
 * only in a `// Last hour`-style comment the type system cannot check. That
 * comment-as-contract drift shipped an inverted predicate on a SUPER_ADMIN
 * database-health widget (the "Slow Queries / last hour" check counted rows
 * OLDER than an hour).
 *
 * The architectural cure is the intent-named helpers `withinLast(ms)` /
 * `olderThan(ms)` in `@aquaculture/backend-common/database`, whose NAME carries
 * the direction. This gate freezes the class out: any inline
 * `<Op>(new Date(Date.now() …))` FindOperator in `apps/**` source fails the
 * build, forcing the helper. The helper module itself lives in `libs/**` and is
 * the single sanctioned home for the raw operators, so it is outside this scope.
 *
 * Tier-3 make-detectable. Runs on every PR via the `invariants:fast` shard.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Scan scope: application source only. `libs/**` is deliberately excluded —
 * `libs/backend-common/src/database/time-window.operators.ts` is the ONE place
 * the raw operators are allowed (it defines the helpers).
 */
const TRACKED_GLOBS = ['apps'] as const;

const EXEMPT_PATH_PATTERNS = [
  /__tests__\//,
  /__mocks__\//,
  /\.spec\.ts$/,
  /\.test\.ts$/,
  /\.e2e\.ts$/,
  /\.e2e-spec\.ts$/,
  /\.d\.ts$/,
] as const;

/**
 * Inline time-window FindOperator form:
 * `<Op>(new Date(Date.now() …))` for any of the four ordering operators.
 * Whitespace-tolerant so `LessThan( new Date( Date.now() ...` is still caught.
 */
const INLINE_TIME_WINDOW_RE =
  /\b(LessThanOrEqual|LessThan|MoreThanOrEqual|MoreThan)\(\s*new Date\(\s*Date\.now\(\)/;

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
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
 * Strip block and line comments while preserving line count, so a doc comment
 * that mentions the banned form is not mistaken for a real call and reported
 * line numbers stay accurate.
 */
function stripCommentsPreservingLines(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

function scanFile(file: string): readonly Hit[] {
  const raw = readFileSync(resolve(REPO_ROOT, file), 'utf-8');
  const codeLines = stripCommentsPreservingLines(raw).split(/\r?\n/);
  const rawLines = raw.split(/\r?\n/);
  const hits: Hit[] = [];
  for (let i = 0; i < codeLines.length; i++) {
    if (INLINE_TIME_WINDOW_RE.test(codeLines[i] ?? '')) {
      hits.push({ file, line: i + 1, text: (rawLines[i] ?? '').trim() });
    }
  }
  return hits;
}

describe('INVARIANT: no inline time-window FindOperator predicates in apps (APA-319)', () => {
  const files = listTrackedFiles();
  const allHits: Hit[] = files.flatMap((f) => [...scanFile(f)]);

  it('every recency/retention window uses withinLast()/olderThan()', () => {
    if (allHits.length > 0) {
      const lines = allHits
        .map((h) => `  ${h.file}:${h.line}: ${h.text.slice(0, 110)}`)
        .join('\n');
      throw new Error(
        `${allHits.length} inline time-window FindOperator predicate(s) found in ` +
          `apps/** source:\n${lines}\n\n` +
          `Inline \`<Op>(new Date(Date.now() - ms))\` encodes the predicate ` +
          `direction only in a comment, which drifts (APA-319 shipped an ` +
          `inverted "last hour" check). Replace with the intent-named helpers ` +
          `from \`@aquaculture/backend-common/database\`:\n` +
          `  • recency ("within the last N ms")  -> withinLast(ms)  ` +
          `(MoreThanOrEqual)\n` +
          `  • retention ("older than N ms ago")  -> olderThan(ms)  (LessThan)`,
      );
    }
    expect(allHits).toEqual([]);
  });
});
