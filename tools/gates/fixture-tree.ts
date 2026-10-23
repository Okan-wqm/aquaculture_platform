/**
 * Recursive removal of throwaway fixture trees — the ONE place that owns the
 * retry semantics `fs.rm` requires.
 *
 * Why this module exists (2026-09-08, INFRA-HIGH-172): `invariants-fast` went
 * red on `backup-restore-verification-contract.spec.ts` with
 *
 *   ENOTEMPTY: directory not empty, rmdir '/tmp/aqua-runtime-bundle-repo-.../.git'
 *
 * raised from the spec's own `finally { rmSync(root, { recursive: true, force:
 * true }) }`. The assertions had all passed; only the teardown failed, on a diff
 * that touched no part of that spec.
 *
 * Recursive removal is not atomic. Node walks the tree with readdir + unlink and
 * finishes with `rmdir` on each directory, so any entry that appears between the
 * walk and the `rmdir` surfaces as ENOTEMPTY. Two writers produce exactly that
 * window in this repo:
 *
 *   1. Git. `git commit` ends by running `git maintenance run --auto --quiet`
 *      (confirmed under GIT_TRACE=1 on git 2.43 and 2.55), and with the default
 *      `gc.autoDetach=true` the gc task daemonises — it keeps writing under
 *      `.git` after `spawnSync` has already returned to the test. A fixture repo
 *      that is deleted immediately after a commit is racing that child. This is
 *      why the failure landed on `.git` and not on any other directory in the
 *      fixture. The fixtures themselves close this by disabling auto maintenance
 *      (see `runFixtureGit`), so the race has no writer left to lose to.
 *   2. The filesystem. CI runners layer the workspace on overlayfs, where
 *      deleting an entry writes a whiteout rather than removing it, and `rmdir`
 *      can transiently observe a directory as non-empty.
 *
 * `force: true` does NOT cover this: it suppresses ENOENT only. The option that
 * covers it is `maxRetries`, which Node documents as retrying precisely EBUSY,
 * EMFILE, ENFILE, ENOTEMPTY and EPERM with a linear backoff — and which is
 * ignored unless `recursive` is set. Across `tests/invariants/**` and
 * `tools/gates/**` there were 109 recursive removals and not one passed it, so
 * every temp-fixture teardown in the gate suite was one scheduling accident away
 * from reddening an unrelated PR. Leaving `maxRetries` at its default of 0 is
 * the misconfiguration; passing it is using the API as specified.
 *
 * Callers use these helpers instead of `rmSync` directly, enforced by
 * `tests/invariants/fixture-tree-removal-ssot.spec.ts`.
 *
 * The module also owns the creation half for script-style tests
 * (`makeFixtureTree`, ARIA-LOW-595): a file run whole by ts-node builds its
 * workspace at module level, where there is no `afterAll`, and eleven
 * `tools/aria-adapters` tests left their trees in the temp dir on every run.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hermeticGitEnv } from './hermetic-git';

/**
 * Retry budget for a single removal. Worst case is a linear backoff summing to
 * 25 * (12 * 13 / 2) = 1950ms, paid only when a transient actually occurs; the
 * common path retries zero times and costs nothing.
 */
export const FIXTURE_TREE_REMOVAL_MAX_RETRIES = 12;

/** Backoff step in milliseconds. Attempt N waits `N * this` before retrying. */
export const FIXTURE_TREE_REMOVAL_RETRY_DELAY_MS = 25;

/**
 * Remove a fixture tree that may or may not exist — teardown semantics.
 *
 * Use this in `afterEach`/`afterAll`/`finally`, where the tree's absence is a
 * fine outcome and the only thing that matters is that it is gone afterwards.
 */
export function removeFixtureTree(path: string): void {
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: FIXTURE_TREE_REMOVAL_MAX_RETRIES,
    retryDelay: FIXTURE_TREE_REMOVAL_RETRY_DELAY_MS,
  });
}

/**
 * Remove a fixture tree that the test has already asserted exists — setup
 * semantics, e.g. deleting a directory in order to replace it with a symlink.
 *
 * Unlike `removeFixtureTree` this does NOT pass `force`, so a missing path still
 * throws ENOENT and the caller's precondition stays load-bearing. Only the
 * retry behaviour is shared.
 */
export function removeExistingFixtureTree(path: string): void {
  rmSync(path, {
    recursive: true,
    maxRetries: FIXTURE_TREE_REMOVAL_MAX_RETRIES,
    retryDelay: FIXTURE_TREE_REMOVAL_RETRY_DELAY_MS,
  });
}

/** Trees `makeFixtureTree` made in this process, removed when it exits. */
const treesRemovedAtExit = new Set<string>();

function removeTreesAtExit(): void {
  for (const path of treesRemovedAtExit) {
    removeFixtureTree(path);
  }
  treesRemovedAtExit.clear();
}

/**
 * Make a fixture tree under the OS temp dir that is removed when the process
 * exits — normally, through `process.exit`, or on an uncaught failure (Node
 * emits `exit` for each, and removal is synchronous, which is all `exit`
 * allows).
 *
 * For a script-style test, where the process is the test's lifetime. A suite
 * with `afterAll`/`finally` keeps removing its trees there with
 * `removeFixtureTree`, so a long-lived Jest worker does not hold them.
 *
 * One `exit` listener serves every tree, so a test that makes many does not
 * trip Node's listener-leak warning.
 */
export function makeFixtureTree(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  if (treesRemovedAtExit.size === 0) {
    process.once('exit', removeTreesAtExit);
  }
  treesRemovedAtExit.add(path);
  return path;
}

/**
 * Make `root` a git work tree whose index holds every file under it that its
 * own `.gitignore` does not ignore, and return `root`. Call it again after
 * writing more files.
 *
 * The code scans of tools/gates/event-consumer-index.ts read the TRACKED files
 * of a tree (`git ls-files`), never whatever lies on disk, so an ignored or
 * untracked file never becomes a fact (SE-3-R2 corrective R1). A fixture is
 * therefore a tree whose files are in its index. Nothing is committed: the
 * index is the tracked set. Git runs with no inherited `GIT_*` variable and no
 * global or system config, so neither the caller's repository nor a user-wide
 * excludes file decides what the fixture tracks.
 */
export function indexFixtureTree(root: string): string {
  const env = hermeticGitEnv(process.env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  });
  for (const args of [
    ['init', '--quiet'],
    ['add', '--all'],
  ]) {
    execFileSync('git', ['-C', root, ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  }
  return root;
}
