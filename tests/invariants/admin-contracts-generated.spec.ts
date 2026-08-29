/**
 * The admin panel's backend contracts are DERIVED, not declared.
 *
 * # What this replaces
 *
 * The panel is a federated remote and cannot import a backend library — its
 * tsconfig resolves only `@/*` and `@aquaculture/shared-ui`. The consequence
 * was that every response shape was re-declared by hand: 113 of its 177
 * exported types shared a name with an admin-api export, plus 12 more under a
 * `Backend*` prefix.
 *
 * The established cure was declare-and-pin — write the type twice, then add a
 * spec asserting the two copies match field for field. That detects drift, but
 * it is still duplication, and it made the contract exist THREE times: backend,
 * frontend, and the spec holding them together. It also only ever covers what
 * someone remembered to pin: the analytics parity spec compared
 * `services/types/analytics.ts` against the backend and passed, while
 * `AnalyticsDashboardPage` kept its own `TimeSeriesPoint` shadow declaring
 * `value: number` against a backend `number | null` — so unmeasured buckets
 * were drawn on the trend chart as zeroes.
 *
 * `tools/codegen/admin-contracts` removes the second copy. The backend type is
 * read through the TypeScript compiler and emitted into the panel's own tree in
 * WIRE form (`Date` → `string`, optionals absent rather than `undefined`, enums
 * as unions of their values), and `services/types/*.ts` re-exports it. Drift
 * stops being something to detect and becomes something that cannot be written
 * down: the generated file changes with the backend, and this gate fails the
 * build if it was not regenerated.
 *
 * # Why a gate at all, if the type is derived
 *
 * Because generation is a build step, not a compiler feature. Someone can edit
 * a backend contract and not run codegen. `--check` regenerates in memory and
 * diffs, so a stale file is a red build rather than a silent lie.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const GENERATED = 'web/modules/admin-panel/src/services/types/generated/admin-contracts.ts';
const TYPES_DIR = join(REPO_ROOT, 'web/modules/admin-panel/src/services/types');

describe('admin panel contracts are generated from the backend', () => {
  it('regenerates to exactly what is committed', () => {
    // The whole guarantee. If a backend contract moved and nobody ran codegen,
    // the panel is back to carrying a stale second copy — which is the state
    // this tool exists to make impossible.
    const result = execFileSync(
      'npx',
      [
        'ts-node',
        '--project',
        'tools/gates/tsconfig.json',
        'tools/codegen/admin-contracts/generate.ts',
        '--check',
      ],
      { cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );

    expect(result).toContain('up to date');
  }, 240_000);

  it('marks the generated file as generated', () => {
    const source = readFileSync(join(REPO_ROOT, GENERATED), 'utf-8');

    expect(source).toContain('GENERATED — DO NOT EDIT');
    expect(source).toContain('npm run codegen:admin-contracts');
  });

  it('emits wire form, not in-memory form', () => {
    // `Date` is the drift that hand-written types got wrong most often: the
    // backend declares 78 Date fields and the panel had 35 of them as string,
    // leaving the rest to guesswork. Nothing typed as Date may survive here.
    const source = readFileSync(join(REPO_ROOT, GENERATED), 'utf-8');
    const dateFields = source.split('\n').filter((line) => /^\s+\w+\??:\s*Date\b/.test(line));

    expect(dateFields).toEqual([]);
  });

  it('re-exports the generated contracts instead of re-declaring them', () => {
    // A module that both imports from `generated/` and declares its own copy of
    // a generated name has reintroduced the second copy.
    const generated = readFileSync(join(REPO_ROOT, GENERATED), 'utf-8');
    const generatedNames = new Set(
      [...generated.matchAll(/^export (?:interface|type) (\w+)/gm)].map((match) => match[1]),
    );
    expect(generatedNames.size).toBeGreaterThan(10);

    const offending: string[] = [];
    for (const file of readdirSync(TYPES_DIR)) {
      if (!file.endsWith('.ts')) continue;
      const source = readFileSync(join(TYPES_DIR, file), 'utf-8');
      for (const match of source.matchAll(/^export (?:interface|type) (\w+)[\s<]/gm)) {
        const name = match[1];
        // An alias re-export (`ComplianceCheckResult as BackendComplianceCheckResult`)
        // is the sanctioned way to rename at the boundary and is not a copy.
        if (name && generatedNames.has(name)) {
          offending.push(`${file}: ${name}`);
        }
      }
    }

    expect(offending).toEqual([]);
  });
});
