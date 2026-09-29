import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { GitRepositoryTargetPort } from '../src/adapters/git/git-repository-target-port';
import { verifyRepositoryTarget } from '../src/application/repository-target-verifier';

export const gitPath = realpathSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim());
export const gitSha256 = createHash('sha256').update(readFileSync(gitPath)).digest('hex');

export interface GitTargetFixture {
  readonly root: string;
  readonly base: string;
  readonly head: string;
  readonly reviewed_ref: string;
}

export function runGit(repository: string, ...args: string[]): string {
  return execFileSync(gitPath, ['-C', repository, ...args], {
    encoding: 'utf8',
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      LC_ALL: 'C',
      PATH: dirname(gitPath),
    },
  }).trim();
}

export function createGitTargetFixture(): GitTargetFixture {
  const root = mkdtempSync(join(tmpdir(), 'new-aria-reviewed-target-'));
  runGit(root, 'init', '--quiet');
  runGit(root, 'config', 'user.name', 'ARIA test');
  runGit(root, 'config', 'user.email', 'aria-test@example.invalid');
  writeFileSync(join(root, 'reviewed.txt'), 'base\n');
  runGit(root, 'add', 'reviewed.txt');
  runGit(root, 'commit', '--quiet', '-m', 'base');
  const base = runGit(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'reviewed.txt'), 'head\n');
  runGit(root, 'commit', '--quiet', '-am', 'head');
  const head = runGit(root, 'rev-parse', 'HEAD');
  const reviewed_ref = 'refs/remotes/origin/reviewed';
  runGit(root, 'update-ref', reviewed_ref, head);
  return { root, base, head, reviewed_ref };
}

export function cloneGitTargetFixture(source: GitTargetFixture): GitTargetFixture {
  const root = mkdtempSync(join(tmpdir(), 'new-aria-reviewed-clone-'));
  rmSync(root, { recursive: true });
  execFileSync(gitPath, ['clone', '--quiet', '--no-local', source.root, root], {
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      LC_ALL: 'C',
      PATH: dirname(gitPath),
    },
  });
  const base = runGit(root, 'rev-parse', 'HEAD^');
  const head = runGit(root, 'rev-parse', 'HEAD');
  const reviewed_ref = source.reviewed_ref;
  runGit(root, 'update-ref', reviewed_ref, head);
  return { root, base, head, reviewed_ref };
}

export function verifiedGitTarget(repository: GitTargetFixture) {
  return verifyRepositoryTarget(
    {
      repository_id: 'repo-1',
      workspace_id: 'workspace-1',
      repository_root: repository.root,
      reviewed_ref: repository.reviewed_ref,
      base_sha: repository.base,
      head_sha: repository.head,
    },
    new GitRepositoryTargetPort({ executable_path: gitPath, executable_sha256: gitSha256 }),
  );
}
