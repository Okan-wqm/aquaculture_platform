/**
 * The commit-msg traceability hook must have an install path that survives
 * `--ignore-scripts`.
 *
 * WHY THIS EXISTS: `.husky/commit-msg` enforces CLAUDE.md's Review Finding
 * Traceability rule, and its only binding was `prepare: husky install`. This
 * repository mandates `npm ci --ignore-scripts` for supply-chain hygiene
 * (SEC-CI-007) — nineteen workflows use it, and it is the documented install for
 * contributors. So `prepare` never runs, `core.hooksPath` stays unset, and the
 * hook binds for nobody. The gate existed only as a CI job minutes-to-hours
 * later.
 *
 * That gap is expensive in a specific way: `closes-footer-check` validates the
 * whole PR range, so a missing trailer on a pushed commit cannot be repaired by a
 * follow-up commit. It needs history rewriting, which this repo forbids. The cost
 * of the local hook not running is therefore a branch retrace, not a quick amend
 * — which is exactly what happened, three times in one session, before anyone
 * asked why.
 *
 * TIER CEILING, STATED HONESTLY: a repository cannot force a developer's local
 * git config. This is tier 2 (a one-command installer that does not depend on a
 * lifecycle script) plus tier 3 (this spec, so the hook cannot rot or lose its
 * install path unnoticed). It is not tier 1 and does not pretend to be.
 */

import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const HUSKY_DIR = join(REPO_ROOT, '.husky');

/** Hooks whose absence silently removes a gate rather than breaking something. */
const REQUIRED_HOOKS = ['commit-msg', 'pre-commit', 'pre-push'] as const;

function packageJson(): {
  scripts?: Record<string, string>;
} {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
}

describe('git hook binding', () => {
  it.each(REQUIRED_HOOKS)('ships %s as an executable hook', (hook) => {
    const abs = join(HUSKY_DIR, hook);
    expect(statSync(abs).isFile()).toBe(true);
    // A non-executable hook is skipped by git without any error, which is the
    // worst failure mode: the gate reports nothing at all.
    expect(() => accessSync(abs, constants.X_OK)).not.toThrow();
  });

  it('has an install path that does not depend on a lifecycle script', () => {
    const scripts = packageJson().scripts ?? {};
    const installer = scripts['hooks:install'];
    expect(installer).toBeTruthy();
    // The mechanism matters: `husky install` writes .git/hooks, which is exactly
    // what `--ignore-scripts` prevents from ever happening. Setting
    // core.hooksPath needs no lifecycle hook and no postinstall.
    expect(installer).toContain('core.hooksPath');
    expect(installer).toContain('.husky');
  });

  it('keeps the commit-msg hook bound to the same validator CI runs', () => {
    // If the hook and the workflow drifted onto different validators, a commit
    // could pass locally and fail in CI — which for this particular gate means
    // an unrepairable trailer on a pushed commit.
    const hook = readFileSync(join(HUSKY_DIR, 'commit-msg'), 'utf8');
    expect(hook).toContain('commit-msg-validator');

    const workflow = readFileSync(
      join(REPO_ROOT, '.github', 'workflows', 'closes-footer-check.yml'),
      'utf8',
    );
    expect(workflow).toContain('commit-msg-validator');
  });

  it('does not rely on prepare alone, since --ignore-scripts is mandated', () => {
    const scripts = packageJson().scripts ?? {};
    // `prepare` may stay — it helps anyone installing without the flag — but it
    // must not be the ONLY route, which is what this asserts.
    if (scripts['prepare']?.includes('husky')) {
      expect(scripts['hooks:install']).toBeTruthy();
    }
  });
});
