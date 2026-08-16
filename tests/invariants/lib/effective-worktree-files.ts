/**
 * Effective-worktree source inventory for repository invariants.
 *
 * `git ls-files` alone is an index view: it retains paths deleted by the
 * change under test and omits new files until they are staged. Invariants run
 * before publication, so their authority must instead be the files that
 * actually exist in the candidate worktree. This helper is the single place
 * that composes tracked and untracked, non-ignored paths and removes cached
 * deletions.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function listEffectiveWorktreeFiles(
  repoRoot: string,
  pathspecs: readonly string[],
): readonly string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspecs],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
    },
  );

  return [...new Set(output.split('\0').filter(Boolean))]
    .filter((file) => existsSync(resolve(repoRoot, file)))
    .sort();
}
