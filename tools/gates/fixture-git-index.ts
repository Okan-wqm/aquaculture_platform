/**
 * Index a fixture tree with git: the half of fixture handling that needs a
 * sibling module (`hermetic-git.ts`).
 *
 * It was part of `fixture-tree.ts` until RW-2. That module is also loaded under
 * Node's own type stripping (`npm run tools:test`), where the extensionless
 * sibling import this function needs does not resolve, so the git half lives
 * here and `fixture-tree.ts` imports only `node:` built-ins.
 */
import { execFileSync } from 'node:child_process';

import { hermeticGitEnv } from './hermetic-git';

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
