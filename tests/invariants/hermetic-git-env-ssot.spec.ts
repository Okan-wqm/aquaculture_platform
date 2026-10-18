/**
 * Git run against a fixture never inherits the caller's repository
 * (ARIA-MEDIUM-616).
 *
 * # What went wrong
 *
 * On 2026-10-18 a push of the wave-B integration branch, from a linked
 * worktree, ran the pre-push hook, which ran aria-doc-runtime-ssot.spec.ts. In
 * a worktree, git hands that hook an absolute `GIT_DIR`. The spec built its
 * fixture git env as `{ ...process.env, ... }`, so its `git init`, `commit`,
 * `checkout -b pr` and `checkout main` ran against the developer's repository,
 * not against the temp directory. The branch being pushed got a commit whose
 * tree was the fixture's two files, a branch `pr` appeared, and the worktree
 * was left on `main`. Nothing reached the remote only because the next
 * fixture commit failed.
 *
 * Eleven suites already dropped `GIT_*` before running fixture git, each with
 * its own copy of the filter. The twelfth did not.
 *
 * # The two halves of the cure
 *
 * 1. One owner: `tools/gates/hermetic-git.ts` is the only place the filter is
 *    spelled. A new fixture gets it right because the only import available
 *    already is.
 * 2. The hook that leaks the variable drops it first: `.husky/pre-push`
 *    unsets `GIT_DIR` and its siblings before it runs anything, so even a
 *    suite that forgets (1) cannot reach the repository from a push. The
 *    pre-commit hook is left alone on purpose. Its staged-content checks read
 *    `GIT_INDEX_FILE`, so there the module is the guard.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { hermeticGitEnv } from '../../tools/gates/hermetic-git';

const REPO_ROOT = resolve(__dirname, '..', '..');
const OWNER = 'tools/gates/hermetic-git.ts';
/** The filter, in either quote style; assembled so this file does not spell it. */
const GIT_PREFIX_FILTER = new RegExp(`startsWith\\(\\s*['"\`]${'GIT'}_['"\`]\\s*\\)`);

function trackedSources(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--', 'tools', 'tests', 'scripts', 'apps', 'libs', 'platform', 'web'],
    { cwd: REPO_ROOT, encoding: 'utf8', env: hermeticGitEnv(), maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\n')
    .filter((path) => /\.(?:[cm]?[jt]s|tsx)$/u.test(path));
}

describe('INVARIANT: fixture git never inherits the caller repository (ARIA-MEDIUM-616)', () => {
  it('spells the GIT_* filter only in tools/gates/hermetic-git.ts', () => {
    const owners = trackedSources().filter((path) =>
      GIT_PREFIX_FILTER.test(readFileSync(resolve(REPO_ROOT, path), 'utf8')),
    );
    expect(owners).toEqual([OWNER]);
  });

  it('drops every GIT_* variable and keeps what the fixture sets on purpose', () => {
    const env = hermeticGitEnv(
      {
        PATH: '/usr/bin',
        GIT_DIR: '/repo/.git/worktrees/wt',
        GIT_INDEX_FILE: '/repo/.git/index',
        GIT_WORK_TREE: '/repo',
      },
      { GIT_CONFIG_GLOBAL: '/dev/null' },
    );
    expect(env).toEqual({ PATH: '/usr/bin', GIT_CONFIG_GLOBAL: '/dev/null' });
  });

  it('has .husky/pre-push drop GIT_DIR before it runs anything', () => {
    const lines = readFileSync(resolve(REPO_ROOT, '.husky/pre-push'), 'utf8').split('\n');
    const commands = lines
      .map((line, index) => ({ line: line.trim(), index }))
      .filter(({ line }) => line !== '' && !line.startsWith('#') && !line.startsWith('#!'));
    // The husky loader may come first; the unset is the next command.
    const [loader, first] = commands;
    expect(loader?.line).toBe('. "$(dirname "$0")/_/husky.sh"');
    expect(first?.line).toMatch(/^unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\b/);
  });
});
