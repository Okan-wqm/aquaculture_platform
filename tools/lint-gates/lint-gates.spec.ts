#!/usr/bin/env ts-node
/**
 * lint-gates baseline — the executable definition of the repo's ESLint
 * architectural gates, captured on ESLint 8 + the current `.eslintrc.json`,
 * UNCHANGED. This is the gate-preservation proof for the ESLint 8 -> 9 flat
 * config migration (A2): PR-2 translates `.eslintrc.json` to
 * `eslint.config.mjs` and THESE TESTS MUST STAY GREEN UNCHANGED. Any gate
 * that silently changes severity, scope, or firing semantics in the flat
 * translation fails here.
 *
 * WHY calculateConfigForFile + Linter (not ESLint.lintText against a virtual
 * path): the repo config sets `parserOptions.project` (type-aware linting).
 * `ESLint.lintText` on a virtual file path NOT in any tsconfig makes
 * @typescript-eslint/parser throw before any rule runs (verified: "ESLint
 * was configured to run on <tsconfigRoot>..."), and disabling the project
 * makes the type-aware rules (no-floating-promises etc.) throw instead. The
 * 10 core gates (no-restricted-syntax / no-restricted-imports) are pure
 * AST-selector rules that need NO type information, so we:
 *   1. resolve the REAL per-file config via `eslint.calculateConfigForFile`
 *      (ESLint's own resolver — this is exactly the config a real lint run
 *      uses, including override cascade + test-file overrides), then
 *   2. run ONLY the gate rules from that resolved config through `Linter`
 *      with the default (espree, type-info-free) parser.
 * This proves both the config RESOLUTION (which gates apply to which path)
 * and the firing BEHAVIOUR, without the type-aware-parser obstacle.
 *
 * VERIFIED-FIRSTHAND SEMANTIC (corrects a plan/audit claim): the test-file
 * override (`.eslintrc.json` lines 274-293) redefines `no-restricted-syntax`
 * with only getRepository + JSON.stringify, INTENDING to drop the 4
 * JWT_SECRET selectors in test files. In ESLint 8 eslintrc cascade this
 * redefinition is INEFFECTIVE: `calculateConfigForFile('x.spec.ts')`
 * resolves the FULL 6-selector set, so JWT_SECRET DOES fire in `.spec.ts`
 * today. We pin the ACTUAL behaviour (fires in both), not the intended one.
 * If the flat-config translation makes the test override actually take
 * effect (flat config "last object wins" is stricter than eslintrc cascade),
 * the JWT_SECRET-in-spec assertion below flips red — exactly the silent
 * behaviour change this baseline exists to catch. PR-2 must decide
 * consciously whether to preserve or change it; it cannot drift silently.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

import { ESLint, Linter } from 'eslint';

const REPO_ROOT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
})();

const eslint = new ESLint({ cwd: REPO_ROOT });
const linter = new Linter();

/** Run only the AST-selector gate rules from the file's REAL resolved config. */
async function gateRuleIds(filePath: string, code: string): Promise<readonly string[]> {
  const cfg = await eslint.calculateConfigForFile(filePath);
  const rules: Linter.RulesRecord = {};
  for (const key of ['no-restricted-syntax', 'no-restricted-imports'] as const) {
    const value = cfg.rules?.[key];
    if (value) rules[key] = value as Linter.RuleEntry;
  }
  const messages = linter.verify(code, {
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules,
  });
  return messages.map((m) => m.ruleId).filter((id): id is string => id !== null);
}

interface GateCase {
  readonly label: string;
  readonly filePath: string;
  readonly code: string;
  readonly expect: 'no-restricted-syntax' | 'no-restricted-imports' | 'silent';
}

// Each gate: a firing fixture (at a realistic path so override targeting is
// exercised) and, where relevant, the negative / cross-context fixture.
const CASES: readonly GateCase[] = [
  // ── no-restricted-imports: backend-common root-barrel bans ──
  {
    label: 'gate-1 @aquaculture/backend-common root barrel import fires',
    filePath: 'apps/auth-service/src/x.ts',
    code: "import { x } from '@aquaculture/backend-common';",
    expect: 'no-restricted-imports',
  },
  {
    label: 'gate-1 sub-barrel import is clean',
    filePath: 'apps/auth-service/src/x.ts',
    code: "import { x } from '@aquaculture/backend-common/auth';",
    expect: 'silent',
  },
  {
    label: 'gate-2 @platform/backend-common root barrel import fires',
    filePath: 'apps/auth-service/src/x.ts',
    code: "import { x } from '@platform/backend-common';",
    expect: 'no-restricted-imports',
  },
  // ── no-restricted-syntax (main): getRepository ──
  {
    label: 'gate-3 getRepository() fires in src',
    filePath: 'apps/farm-service/src/x.ts',
    code: 'const r = ds.getRepository(User);',
    expect: 'no-restricted-syntax',
  },
  {
    label: 'gate-3 getScopedRepository() is clean',
    filePath: 'apps/farm-service/src/x.ts',
    code: 'const r = ds.getScopedRepository(User);',
    expect: 'silent',
  },
  // ── no-restricted-syntax (main): JSON.stringify with indent ──
  {
    label: 'gate-4 JSON.stringify(x, y, 2) fires in src',
    filePath: 'apps/farm-service/src/x.ts',
    code: 'const j = JSON.stringify(o, null, 2);',
    expect: 'no-restricted-syntax',
  },
  {
    label: 'gate-4 JSON.stringify(x) (1 arg) is clean',
    filePath: 'apps/farm-service/src/x.ts',
    code: 'const j = JSON.stringify(o);',
    expect: 'silent',
  },
  // ── no-restricted-syntax (main): the 4 JWT_SECRET selectors ──
  {
    label: "gate-5 .get('JWT_SECRET') fires in src",
    filePath: 'apps/auth-service/src/x.ts',
    code: "const s = cfg.get('JWT_SECRET');",
    expect: 'no-restricted-syntax',
  },
  {
    label: "gate-6 .getOrThrow('JWT_SECRET') fires in src",
    filePath: 'apps/auth-service/src/x.ts',
    code: "const s = cfg.getOrThrow('JWT_SECRET');",
    expect: 'no-restricted-syntax',
  },
  {
    label: 'gate-7 process.env.JWT_SECRET fires in src',
    filePath: 'apps/auth-service/src/x.ts',
    code: 'const s = process.env.JWT_SECRET;',
    expect: 'no-restricted-syntax',
  },
  {
    label: "gate-8 process.env['JWT_SECRET'] fires in src",
    filePath: 'apps/auth-service/src/x.ts',
    code: "const s = process.env['JWT_SECRET'];",
    expect: 'no-restricted-syntax',
  },
];

for (const c of CASES) {
  test(c.label, async () => {
    const ids = await gateRuleIds(c.filePath, c.code);
    if (c.expect === 'silent') {
      assert.deepEqual(ids, [], `expected no gate to fire, got: ${ids.join(',')}`);
    } else {
      assert.ok(ids.includes(c.expect), `expected ${c.expect} to fire, got: ${ids.join(',') || '(none)'}`);
    }
  });
}

// ── Cross-context: getRepository + JSON.stringify fire in BOTH src and test ──
test('gate-3/4 getRepository + JSON.stringify fire in .spec.ts too (test override keeps them)', async () => {
  const getRepo = await gateRuleIds('apps/farm-service/src/x.spec.ts', 'const r = ds.getRepository(User);');
  const jsonStr = await gateRuleIds('apps/farm-service/src/x.spec.ts', 'const j = JSON.stringify(o, null, 2);');
  assert.ok(getRepo.includes('no-restricted-syntax'), 'getRepository must fire in test files');
  assert.ok(jsonStr.includes('no-restricted-syntax'), 'JSON.stringify(>2) must fire in test files');
});

// ── The load-bearing semantic pin (see file header): JWT_SECRET fires in
//    .spec.ts under the ESLint 8 eslintrc cascade because the test override's
//    no-restricted-syntax redefinition is INEFFECTIVE. If a flat-config
//    translation changes this, this test goes red and PR-2 must address it
//    consciously. ──
test('SEMANTIC PIN: JWT_SECRET fires in .spec.ts under eslintrc cascade (override redefinition ineffective)', async () => {
  const ids = await gateRuleIds('apps/auth-service/src/x.spec.ts', "const s = cfg.get('JWT_SECRET');");
  assert.ok(
    ids.includes('no-restricted-syntax'),
    'BASELINE: under ESLint 8 eslintrc, JWT_SECRET fires in .spec.ts (the test override does not drop it). ' +
      'If this flipped, the flat-config translation changed override-cascade semantics — resolve consciously.',
  );
});

// ── Config-resolution snapshot: which gates resolve for representative paths.
//    Pins the no-restricted-syntax selector COUNT per path-kind so a flat
//    translation that adds/drops selectors anywhere is caught. ──
// These counts are FIRSTHAND-MEASURED, not assumed — the eslintrc override
// cascade resolves them inconsistently, and that inconsistency is precisely
// what a flat-config translation can silently change:
//   - backend src `.ts`        → 6 (main TS override)
//   - `.spec.ts`               → 6 (test override's redefinition is INEFFECTIVE
//                                   via basename `*.spec.ts` glob — see SEMANTIC PIN)
//   - `e2e/**/*.ts`            → 2 (test override IS effective via path glob —
//                                   the OPPOSITE resolution of `.spec.ts`!)
//   - web `.tsx`              → 0 (no main no-restricted-syntax applies to web)
const SNAPSHOT_PATHS: ReadonlyArray<{ path: string; selectorCount: number }> = [
  { path: 'apps/auth-service/src/x.ts', selectorCount: 6 },
  { path: 'apps/auth-service/src/x.entity.ts', selectorCount: 6 },
  { path: 'libs/backend-common/src/x.ts', selectorCount: 6 },
  { path: 'apps/auth-service/src/x.spec.ts', selectorCount: 6 }, // basename-glob: redefinition ineffective
  { path: 'e2e/tests/x.ts', selectorCount: 2 }, // path-glob: redefinition effective — opposite of .spec.ts
  { path: 'web/shell/src/x.tsx', selectorCount: 0 }, // no no-restricted-syntax on web
];

for (const { path, selectorCount } of SNAPSHOT_PATHS) {
  test(`config snapshot: ${path} resolves ${selectorCount} no-restricted-syntax selectors`, async () => {
    const cfg = await eslint.calculateConfigForFile(path);
    const nrs = cfg.rules?.['no-restricted-syntax'];
    const count = Array.isArray(nrs) ? nrs.length - 1 : 0; // minus the severity element
    assert.equal(count, selectorCount, `${path}: expected ${selectorCount} selectors, got ${count}`);
  });
}
