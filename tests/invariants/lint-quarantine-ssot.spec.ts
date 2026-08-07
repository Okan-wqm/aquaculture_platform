/**
 * One lint-quarantine list, read by both lanes.
 *
 * # Why this exists
 *
 * The repository ran two lint lanes that disagreed about which projects carry
 * pre-existing debt:
 *
 *   - `ci-affected` consulted `scripts/ci/affected-target-policy.json` and
 *     skipped the projects under `targets.lint.knownUnstableProjects`, each
 *     with a written reason.
 *   - `ci-full` ran `nx run-many --target=lint --all`, which knew nothing about
 *     that file and linted them anyway.
 *
 * A project could therefore be quarantined and still block every pull request,
 * because `build-status` — a REQUIRED context — depends on the full lane. The
 * two lanes were not two policies. They were one policy and one accident, and
 * the accident won whenever it mattered.
 *
 * Found the hard way: four libraries were quarantined for 941 pre-existing
 * eslint errors, CI went green on the affected lane, and the full lane failed
 * the merge anyway.
 *
 * # What this asserts
 *
 * `lint:all` goes through the script that reads the policy, and the policy
 * still declares a reason for every quarantined project. A quarantine without
 * a reason is just a project nobody lints.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const EXCLUSIONS = join(REPO_ROOT, 'scripts/ci/lint-all-exclusions.json');
const RUNNER = join(REPO_ROOT, 'scripts/ci/lint-all.mjs');

interface Exclusions {
  exclusions?: Record<string, string>;
}

/** Ceiling on the full lane's exclusion list. A list that can grow without
 *  bound turns "lint everything" into "lint whatever is left". */
const MAX_EXCLUSIONS = 6;

function exclusions(): Record<string, string> {
  return (JSON.parse(readFileSync(EXCLUSIONS, 'utf8')) as Exclusions).exclusions ?? {};
}

describe('lint quarantine has one source', () => {
  it('routes lint:all through the script that reads the policy', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    // `nx run-many --all` here would silently re-lint every quarantined
    // project and block merges the affected lane deliberately let through.
    expect(pkg.scripts['lint:all']).toContain('scripts/ci/lint-all.mjs');
  });

  it('makes that script read the policy rather than a copy of it', () => {
    const runner = readFileSync(RUNNER, 'utf8');

    expect(runner).toContain('lint-all-exclusions.json');
    // The exclusion has to be derived, not typed out a second time.
    expect(runner).toContain('--exclude=');
  });

  it('gives every lint-quarantined project a stated reason', () => {
    const entries = Object.entries(exclusions());

    expect(entries.length).toBeGreaterThan(0);
    // The ceiling is the point: without it, "exclude the failing project" is
    // always the cheapest way to make a red lane green.
    expect(entries.length).toBeLessThanOrEqual(MAX_EXCLUSIONS);
    const unexplained = entries
      .filter(([, reason]) => typeof reason !== 'string' || reason.trim().length < 30)
      .map(([project]) => project);

    // An entry with no reason is indistinguishable from a project someone
    // quietly stopped linting.
    expect(unexplained).toEqual([]);
  });

  it('keeps the quarantine pointed at projects that exist', () => {
    // A stale entry silently widens nothing, but it does make the list look
    // larger than the debt actually is — and the list is what gets paid down.
    const declared = Object.keys(exclusions());
    const nxProjects = new Set(
      (
        JSON.parse(
          require('node:child_process').execFileSync('npx', ['nx', 'show', 'projects', '--json'], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            env: { ...process.env, NX_DAEMON: 'false' },
          }),
        ) as string[]
      ).map((name) => name),
    );

    const vanished = declared.filter((project) => !nxProjects.has(project));

    expect(vanished).toEqual([]);
  });
});
