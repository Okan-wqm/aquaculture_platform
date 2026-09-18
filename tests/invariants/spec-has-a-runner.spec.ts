/**
 * Every spec file must be reachable by something that runs it.
 *
 * # Why this exists
 *
 * An audit of one day's merges found three test files that nobody executes:
 * `libs/backend-common/src/metrics/__tests__/cron-heartbeat.service.spec.ts`,
 * `platform/libs/outbox/src/__tests__/outbox-relay-liveness.spec.ts`, and
 * `tools/supervisor/runtime-supervisor.spec.ts`. Each was written, reviewed
 * and merged green — and its greenness carried no information, because no
 * command in the repository could reach it.
 *
 * The mechanism was always the same: a directory ships a working
 * `jest.config` but no `project.json`, so Nx does not see a project, so
 * `affected` and `run-many` both skip it. `libs/backend-common` had been in
 * that state long enough to accumulate **1,359 tests that had never run in
 * CI** — in the library every service depends on.
 *
 * Worse than invisible: those directories sit inside `nx.json`'s
 * `sharedGlobals`, so touching them marks all 42 test projects affected. CI
 * did maximum work and still ran none of their specs.
 *
 * # What this asserts
 *
 * For every `*.spec.*` file outside the runners' own trees, SOME declared
 * runner claims it: an Nx project with a `test` target whose root contains
 * it, or one of the explicitly-declared non-Nx runner globs below.
 *
 * A new spec in a new directory therefore fails here at authoring time
 * rather than passing silently forever.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  KNOWN_UNRUNNABLE_SPECS,
  isKnownUnrunnable,
  runnersOf,
  walkSpecs,
} from './helpers/spec-runners';

const repoRoot = resolve(__dirname, '../..');

describe('every spec has a runner', () => {
  it('leaves no spec file unreachable by any declared runner', () => {
    const specs = walkSpecs(repoRoot);
    expect(specs.length).toBeGreaterThan(100);

    const orphans = specs.filter(
      (spec) => !isKnownUnrunnable(spec) && runnersOf(spec).length === 0,
    );

    expect(orphans).toEqual([]);
  });

  it('keeps the unrunnable list honest — every entry still contains a spec', () => {
    // A ratchet that can be satisfied by stale entries is not a ratchet. If a
    // directory has been fixed or deleted, its exemption must go with it.
    const specs = walkSpecs(repoRoot);
    const stale = [...KNOWN_UNRUNNABLE_SPECS].filter(
      (prefix) => !specs.some((spec) => spec.startsWith(`${prefix}/`)),
    );

    expect(stale).toEqual([]);
  });

  it('keeps the non-Nx runner scripts real', () => {
    // A declared runner that does not exist is the same lie one level up.
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts['tools:test']).toBeDefined();
    expect(existsSync(join(repoRoot, '.github/workflows/quality-gates.yml'))).toBe(true);
    expect(readFileSync(join(repoRoot, '.github/workflows/quality-gates.yml'), 'utf8')).toContain(
      'npm run tools:test',
    );

    // `gates:test` globs tools/gates, which is what lets the runner entry
    // above claim the whole directory. Naming specs one at a time is how
    // eight of the ten came to have no CI invocation at all.
    expect(pkg.scripts['gates:test']).toContain('tools/gates/run-all.mjs');
    // The runner must GLOB the directory — naming specs one at a time is how
    // eight of the ten came to have no CI invocation at all.
    expect(readFileSync(join(repoRoot, 'tools/gates/run-all.mjs'), 'utf8')).toContain(
      "endsWith('.spec.ts')",
    );
    expect(
      readFileSync(join(repoRoot, '.github/workflows/closes-footer-check.yml'), 'utf8'),
    ).toContain('npm run gates:test');
  });
});
