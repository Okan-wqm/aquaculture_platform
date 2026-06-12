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
 * VERIFIED-FIRSTHAND SEMANTIC (corrects an EARLIER claim in this very file):
 * an earlier revision said JWT_SECRET fires in an app spec file because the
 * root test override's `no-restricted-syntax` redefinition is "ineffective
 * via a basename-glob quirk". That explanation was WRONG. The real cause,
 * confirmed against the ESLint 8 resolved config: every app has a `root: true`
 * `.eslintrc.cjs`, so the ROOT test override never reaches its files at all.
 * The app's OWN cjs carries the 6-selector no-restricted-syntax (via its
 * `typedRules`) and its cjs test sub-override does NOT touch that rule — so
 * `.spec.ts` keeps all 6 selectors and JWT_SECRET fires. The OBSERVED value
 * (6) was always correct; only the mechanism was mis-stated. The PR-2 flat
 * config reproduces this per-project policy exactly (proven to zero drift by
 * eslintrc-flat-parity); these assertions stay green across the cutover.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';

import { ESLint, Linter } from 'eslint';

const require_ = createRequire(import.meta.url);

const REPO_ROOT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
})();

/**
 * Config-format-agnostic ESLint instance. This baseline is read by BOTH
 * eslintrc (PR-1) and flat config (PR-2), under both ESLint 8 (where `new
 * ESLint` is eslintrc-only and flat needs the use-at-your-own-risk
 * `FlatESLint`) and ESLint 9 (where `new ESLint` IS flat). It picks the
 * right reader from what's on disk + the installed major — the ASSERTIONS
 * below are unchanged across both configs; only the config-reader adapts.
 */
function makeESLint(): ESLint {
  const major = parseInt(require_('eslint/package.json').version, 10);
  const hasFlat =
    existsSync(join(REPO_ROOT, 'eslint.config.mjs')) ||
    existsSync(join(REPO_ROOT, 'eslint.config.js')) ||
    existsSync(join(REPO_ROOT, 'eslint.config.cjs'));
  if (major < 9 && hasFlat) {
    const { FlatESLint } = require_('eslint/use-at-your-own-risk');
    return new FlatESLint({ cwd: REPO_ROOT }) as ESLint;
  }
  return new ESLint({ cwd: REPO_ROOT });
}

const eslint = makeESLint();
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

// ── Semantic pin: JWT_SECRET fires in .spec.ts. The mechanism (verified
//    firsthand against the ESLint 8 resolved config, then reproduced by the
//    flat config) is the root:true `apps/auth-service/.eslintrc.cjs`: its
//    `typedRules` carry the 6-selector no-restricted-syntax and its test
//    sub-override does NOT touch that rule, so .spec.ts keeps all 6 selectors.
//    (An earlier note mis-attributed this to a "basename-glob quirk" — the
//    real cause is the per-project root:true config. The OBSERVED value, 6,
//    was always correct.) The flat config's per-project auth block reproduces
//    it exactly; this pin trips if a future change drops the gate in tests. ──
test('SEMANTIC PIN: JWT_SECRET fires in .spec.ts (per-project config keeps all 6 selectors)', async () => {
  const ids = await gateRuleIds('apps/auth-service/src/x.spec.ts', "const s = cfg.get('JWT_SECRET');");
  assert.ok(
    ids.includes('no-restricted-syntax'),
    'The JWT_SECRET ban must hold in apps/*/src/**/*.spec.ts. ' +
      'If this flips, a config change dropped the security gate in test files — resolve consciously.',
  );
});

// ── Config-resolution snapshot: the no-restricted-syntax selector COUNT per
//    path-kind. These are FIRSTHAND-MEASURED ESLint 8 resolved values that the
//    ESLint 9 flat config reproduces EXACTLY (zero drift — proven rule-for-rule
//    by tools/lint-gates/eslintrc-flat-parity across 72 probes). The counts are
//    deliberately NOT uniform: they encode the real, faithfully-preserved
//    policy, including two quirks fixed separately (see ORPHAN-MEDIUM-092), so
//    that any cutover that "tidied" them into consistency would trip here.
//   path kind                | selectors | why
//   apps src `.ts`           |    6      | auth root:true cjs typedRules (full gate)
//   apps `.entity.ts`        |    6      | same
//   libs/backend-common `.ts`|    6      | non-project zone → root main override (full gate)
//   apps `.spec.ts`          |    6      | auth cjs test sub-override doesn't touch the rule
//   `e2e/**` `.ts`           |    2      | non-project test → root test override (2-selector subset)
//   web/shell `.tsx`         |    0      | web/shell root:true cjs sets no-restricted-syntax:off
const SNAPSHOT_PATHS: ReadonlyArray<{ path: string; selectorCount: number }> = [
  { path: 'apps/auth-service/src/x.ts', selectorCount: 6 },
  { path: 'apps/auth-service/src/x.entity.ts', selectorCount: 6 },
  { path: 'libs/backend-common/src/x.ts', selectorCount: 6 },
  { path: 'apps/auth-service/src/x.spec.ts', selectorCount: 6 },
  { path: 'e2e/tests/x.ts', selectorCount: 2 },
  { path: 'web/shell/src/x.tsx', selectorCount: 0 },
];

for (const { path, selectorCount } of SNAPSHOT_PATHS) {
  test(`config snapshot: ${path} resolves ${selectorCount} no-restricted-syntax selectors`, async () => {
    const cfg = await eslint.calculateConfigForFile(path);
    const nrs = cfg.rules?.['no-restricted-syntax'];
    const count = Array.isArray(nrs) ? nrs.length - 1 : 0; // minus the severity element
    assert.equal(count, selectorCount, `${path}: expected ${selectorCount} selectors, got ${count}`);
  });
}
