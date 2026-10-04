/**
 * The generated `postCondition()` probe in the tenant-aware Baselines.
 *
 * WHY. `scripts/migration/dequalify-tenant-baselines.mjs` emits a
 * `postCondition()` into each tenant-aware Baseline (DATA-CRITICAL-010). It
 * emitted `const rows: Array<{ missing: string }> = await queryRunner.query(...)`
 * — TypeORM types `QueryRunner.query()` as `Promise<any>`, so that line is an
 * unchecked `any` → `T` assignment. ai-service's lint policy (the strictest of
 * the seven) rejects it with `@typescript-eslint/no-unsafe-assignment`
 * (apps/ai-service/src/database/migrations/1800000000000-Baseline.ts:43), and
 * because the affected lane quarantines ai-service lint (INFRA-MEDIUM-154) the
 * only lane that lints it, CI - Full, has been red on it every week since the
 * probe landed (runs 34018063733 … 37188374410).
 *
 * The probe now binds the result to `unknown` and narrows it with
 * `Array.isArray`, which is honest about what the driver returns and fails
 * closed on an unexpected shape. These tests pin the generator's contract and
 * that the committed Baselines are exactly what it emits — a hand edit of a
 * generated block, or a generator change nobody re-applied, both fail here
 * instead of in a weekly lane.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const GENERATOR = 'scripts/migration/dequalify-tenant-baselines.mjs';
const PROBE_BEGIN = '// ── GENERATED postCondition (DATA-CRITICAL-010) — do not hand-edit ──';
const PROBE_END = '// ── END GENERATED postCondition ──';

/** The Baselines the generator owns, read from the generator itself. */
function generatedBaselines(): string[] {
  const source = readFileSync(join(REPO_ROOT, GENERATOR), 'utf8');
  const paths = [...source.matchAll(/path: '(apps\/[^']+\/1800000000000-Baseline\.ts)'/g)].map(
    (match) => match[1],
  );
  if (paths.length === 0) throw new Error(`${GENERATOR} lists no Baselines`);
  return paths;
}

function probeBlock(path: string): string {
  const source = readFileSync(join(REPO_ROOT, path), 'utf8');
  const begin = source.indexOf(PROBE_BEGIN);
  const end = source.indexOf(PROBE_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`${path} carries no generated postCondition block`);
  }
  return source.slice(begin, end);
}

describe('tenant-aware Baseline postCondition probe', () => {
  it('names all seven tenant-aware Baselines', () => {
    expect(generatedBaselines()).toHaveLength(7);
  });

  it.each(generatedBaselines())(
    '%s binds the untyped query result to unknown and narrows it',
    (path) => {
      const block = probeBlock(path);
      expect(block).toContain('const rows: unknown = await queryRunner.query(`');
      expect(block).toContain('return Array.isArray(rows) && rows.length === 0;');
      expect(block).not.toMatch(/const \w+: (?!unknown\b)[^=]+= await queryRunner\.query\(/);
    },
  );

  it('the committed Baselines are exactly what the generator emits', () => {
    const output = execFileSync('node', [GENERATOR], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const verdicts = output
      .split('\n')
      .filter((line) => /^\[(noop|would|ok)/.test(line))
      .map((line) => line.slice(0, line.indexOf(']') + 1));
    expect(verdicts).toHaveLength(generatedBaselines().length);
    expect(new Set(verdicts)).toEqual(new Set(['[noop]']));
  }, 120_000);
});
