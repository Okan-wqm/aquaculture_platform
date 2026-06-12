#!/usr/bin/env ts-node
/**
 * eslintrc → flat-config PARITY guard (A2 PR-2).
 *
 * The ESLint 8 -> 9 migration promises ZERO behavioural drift: the flat
 * `eslint.config.mjs` must resolve, for every file, the SAME effective lint
 * policy that the deleted `.eslintrc.json` + 30 `.eslintrc.cjs` resolved.
 *
 * During the migration that equivalence was proven EXHAUSTIVELY: the ESLint 8
 * resolved rule map (all 492 rules) was captured for 74 representative files
 * across every zone, and the ESLint 9 flat resolved map was diffed against it
 * rule-for-rule → 0 mismatches (off≡undefined normalised). That full golden is
 * regenerable only from the pre-deletion eslintrc tree, so it is NOT committed.
 *
 * THIS committed guard is the durable subset: a curated fixture pinning the
 * security gates + the headline relaxations + the custom-rule asymmetry + both
 * reconciliation directions, for one probe per zone. It re-resolves each probe
 * under whatever config is on disk and asserts the curated severities still
 * match. It trips if a future edit to eslint.config.mjs (or eslint.project-
 * overrides.mjs) drifts any of these load-bearing values.
 *
 * The fixture values are FIRSTHAND-MEASURED ESLint 8 truth (see
 * fixtures/eslintrc-flat-parity.fixture.json), deliberately NON-uniform — they
 * encode the real, faithfully-preserved policy (e.g. web/shell disables
 * no-restricted-syntax; e2e carries only the 2-selector subset; the 6 custom
 * `aquaculture/*` rules are live in non-project lib zones but inert in
 * projects; libs/migration-harness gets the gates but not the lib-scoped custom
 * rules). A cutover that "tidied" any of these into consistency trips here.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';

import { ESLint } from 'eslint';

const require_ = createRequire(__filename);

const REPO_ROOT = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
})();

/** Config-format-agnostic ESLint instance (see lint-gates.spec.ts makeESLint). */
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

interface ParityProbe {
  readonly zone: string;
  readonly path: string;
  readonly nrs_selectors: number;
  readonly expected: Readonly<Record<string, number>>;
}

const FIXTURE: readonly ParityProbe[] = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'eslintrc-flat-parity.fixture.json'), 'utf8'),
) as ParityProbe[];

/** Normalise a rule entry to {0:off/undefined, 1:warn, 2:error}; -1 = unknown. */
function severity(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const head = Array.isArray(value) ? value[0] : value;
  if (head === 0 || head === 'off') return 0;
  if (head === 1 || head === 'warn') return 1;
  if (head === 2 || head === 'error') return 2;
  return -1;
}

/** no-restricted-syntax selector count = entries after the severity head. */
function selectorCount(value: unknown): number {
  return Array.isArray(value) ? value.length - 1 : 0;
}

const eslint = makeESLint();

for (const probe of FIXTURE) {
  test(`parity: ${probe.zone} — ${probe.path}`, async () => {
    const cfg = await eslint.calculateConfigForFile(join(REPO_ROOT, probe.path));
    const rules = (cfg.rules ?? {}) as Record<string, unknown>;

    assert.equal(
      selectorCount(rules['no-restricted-syntax']),
      probe.nrs_selectors,
      `${probe.zone}: no-restricted-syntax must resolve ${probe.nrs_selectors} selectors (ESLint 8 truth)`,
    );

    for (const [rule, expected] of Object.entries(probe.expected)) {
      assert.equal(
        severity(rules[rule]),
        expected,
        `${probe.zone}: ${rule} must resolve severity ${expected} (ESLint 8 truth), got ${severity(rules[rule])}`,
      );
    }
  });
}
