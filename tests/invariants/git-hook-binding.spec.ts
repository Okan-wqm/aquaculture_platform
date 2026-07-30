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

import { accessSync, constants, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const HUSKY_DIR = join(REPO_ROOT, '.husky');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

/** Hooks whose absence silently removes a gate rather than breaking something. */
const REQUIRED_HOOKS = ['commit-msg', 'pre-commit', 'pre-push'] as const;

/** `quality.mjs <domain> <action>` — the gate's identity, ignoring flags. */
const QUALITY_GATE = /quality\.mjs\s+([a-z][a-z-]*\s+[a-z][a-z-]*)/g;

/** `npm run quality:<name>` — the same gate reached through package.json. */
const QUALITY_SCRIPT = /npm\s+run\s+(quality:[A-Za-z0-9:_.-]+)/g;

/**
 * Where a local gate is deliberately a different mode of the same rule.
 *
 * `check-changed` compares the worktree against the PR base — the right question
 * in CI. `check-staged` compares the index against HEAD — the right question at
 * commit time, when the content under test is not committed yet. Same rule, same
 * implementation, different comparison point, so it counts as the mirror.
 */
const LOCAL_COUNTERPARTS: Record<string, readonly string[]> = {
  'format check-changed': ['format check-staged', 'format check-changed'],
};

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

  it('mirrors every quality.mjs gate CI runs into a local hook', () => {
    // WHY: `.husky/pre-commit` ran `format-scope check` — manifest freshness —
    // and its own comment claimed the intent was to catch CI redness at commit
    // time. But CI runs TWO format gates, and the one that catches actual
    // Prettier drift (`format check-changed`) had no local counterpart at all.
    // Eight commits shipped drift with a green hook every time before CI
    // objected (ORPHAN-HIGH-500). Mirroring one gate of a pair is worse than
    // mirroring neither, because the developer stops looking.
    //
    // Discovered rather than listed: a hardcoded expectation would pass while a
    // NEWLY added CI gate went unmirrored, which is the defect itself.
    const collectGates = (text: string, into: Set<string>): void => {
      for (const match of text.matchAll(QUALITY_GATE)) {
        const gate = match[1];
        if (gate) into.add(gate);
      }
    };

    const gates = new Set<string>();
    for (const file of readdirSync(WORKFLOW_DIR).filter((n) => /\.ya?ml$/.test(n))) {
      const body = readFileSync(join(WORKFLOW_DIR, file), 'utf8');
      collectGates(body, gates);
      // Gates reached through an npm script indirection count the same.
      for (const match of body.matchAll(QUALITY_SCRIPT)) {
        const script = match[1];
        if (!script) continue;
        collectGates((packageJson().scripts ?? {})[script] ?? '', gates);
      }
    }

    // Only assertions are mirrored. `generate` rewrites a manifest; running it
    // from a hook would silently mutate the developer's tree, not gate it.
    const assertions = [...gates].filter((gate) => /\b(check|check-[a-z]+)$/.test(gate));
    expect(assertions.length).toBeGreaterThan(0);

    // Gates the hooks actually INVOKE, parsed structurally. A substring search
    // over raw hook text passes on a mention inside a comment — this test was
    // written that way first and stayed green when the real invocation was
    // deleted, which is the same substring-instead-of-structure defect the
    // branch is closing. Comment lines are stripped before matching.
    const invoked = new Set<string>();
    for (const name of readdirSync(HUSKY_DIR).filter((n) => !n.startsWith('_'))) {
      const path = join(HUSKY_DIR, name);
      if (!statSync(path).isFile()) continue;
      const code = readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n');
      collectGates(code, invoked);
    }

    const unmirrored = assertions.filter(
      (gate) => !(LOCAL_COUNTERPARTS[gate] ?? [gate]).some((local) => invoked.has(local)),
    );

    expect(unmirrored).toEqual([]);
  });
});
