import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { GitRepositoryTargetPort } from '../src/adapters/git/git-repository-target-port';
import {
  revalidateExecutableRepositoryTarget,
  verifyRepositoryTarget,
} from '../src/application/repository-target-verifier';

const gitPath = realpathSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim());
const gitSha256 = createHash('sha256').update(readFileSync(gitPath)).digest('hex');
const temporaryRoots: string[] = [];

function git(repository: string, ...args: string[]): string {
  return execFileSync(gitPath, ['-C', repository, ...args], {
    encoding: 'utf8',
    env: { PATH: dirname(gitPath), LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

function createRepository(): { root: string; base: string; head: string; reviewed_ref: string } {
  const root = mkdtempSync(join(tmpdir(), 'new-aria-target-'));
  temporaryRoots.push(root);
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.name', 'ARIA test');
  git(root, 'config', 'user.email', 'aria-test@example.invalid');
  writeFileSync(join(root, 'proof.txt'), 'base\n');
  git(root, 'add', 'proof.txt');
  git(root, 'commit', '--quiet', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'proof.txt'), 'head\n');
  git(root, 'commit', '--quiet', '-am', 'head');
  const head = git(root, 'rev-parse', 'HEAD');
  const reviewed_ref = 'refs/remotes/upstream/reviewed-change';
  git(root, 'update-ref', reviewed_ref, head);
  return { root, base, head, reviewed_ref };
}

const port = (): GitRepositoryTargetPort =>
  new GitRepositoryTargetPort({ executable_path: gitPath, executable_sha256: gitSha256 });

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('Git repository target adapter', () => {
  it('proves ref reachability, commit existence, and exact merge-base ancestry', () => {
    const repository = createRepository();

    const result = verifyRepositoryTarget(
      {
        repository_id: 'repo-1',
        workspace_id: 'workspace-1',
        repository_root: repository.root,
        reviewed_ref: repository.reviewed_ref,
        base_sha: repository.base,
        head_sha: repository.head,
      },
      port(),
    );

    expect(result.reviewed_ref_sha).toBe(repository.head);
    expect(result.merge_base_sha).toBe(repository.base);
    expect(result.ancestry).toBe('BASE_IS_ANCESTOR');
  });

  it('rejects a reviewed ref that moved to a different commit', () => {
    const repository = createRepository();
    git(repository.root, 'update-ref', repository.reviewed_ref, repository.base);

    expect(() =>
      verifyRepositoryTarget(
        {
          repository_id: 'repo-1',
          workspace_id: 'workspace-1',
          repository_root: repository.root,
          reviewed_ref: repository.reviewed_ref,
          base_sha: repository.base,
          head_sha: repository.head,
        },
        port(),
      ),
    ).toThrow(/reviewed ref/);
  });

  it('rejects a reviewed ref moved after a target capability was issued', () => {
    const repository = createRepository();
    const target = verifyRepositoryTarget(
      {
        repository_id: 'repo-1',
        workspace_id: 'workspace-1',
        repository_root: repository.root,
        reviewed_ref: repository.reviewed_ref,
        base_sha: repository.base,
        head_sha: repository.head,
      },
      port(),
    );
    git(repository.root, 'update-ref', repository.reviewed_ref, repository.base);

    expect(() => revalidateExecutableRepositoryTarget(target)).toThrow(/changed after/);
  });

  it('rejects a missing authorized commit object', () => {
    const repository = createRepository();
    const missing = 'f'.repeat(40);
    git(repository.root, 'update-ref', repository.reviewed_ref, repository.head);

    expect(() =>
      verifyRepositoryTarget(
        {
          repository_id: 'repo-1',
          workspace_id: 'workspace-1',
          repository_root: repository.root,
          reviewed_ref: repository.reviewed_ref,
          base_sha: missing,
          head_sha: repository.head,
        },
        port(),
      ),
    ).toThrow(/base object/);
  });

  it('rejects an existing non-commit head object', () => {
    const repository = createRepository();
    const blob = git(repository.root, 'hash-object', '-w', 'proof.txt');
    git(repository.root, 'update-ref', repository.reviewed_ref, blob);

    expect(() =>
      verifyRepositoryTarget(
        {
          repository_id: 'repo-1',
          workspace_id: 'workspace-1',
          repository_root: repository.root,
          reviewed_ref: repository.reviewed_ref,
          base_sha: repository.base,
          head_sha: blob,
        },
        port(),
      ),
    ).toThrow(/head object/);
  });

  it('rejects unrelated commit histories', () => {
    const repository = createRepository();
    const tree = git(repository.root, 'rev-parse', `${repository.head}^{tree}`);
    const unrelated = git(repository.root, 'commit-tree', tree, '-m', 'unrelated root');
    git(repository.root, 'update-ref', repository.reviewed_ref, unrelated);

    expect(() =>
      verifyRepositoryTarget(
        {
          repository_id: 'repo-1',
          workspace_id: 'workspace-1',
          repository_root: repository.root,
          reviewed_ref: repository.reviewed_ref,
          base_sha: repository.base,
          head_sha: unrelated,
        },
        port(),
      ),
    ).toThrow(/not an ancestor/);
  });

  it('rejects a symlink alias instead of changing the evidenced root', () => {
    const repository = createRepository();
    const alias = `${repository.root}-alias`;
    temporaryRoots.push(alias);
    symlinkSync(repository.root, alias);

    expect(() => port().canonicalRoot(alias)).toThrow(/canonical repository root/);
  });

  it('rejects an unpinned Git executable', () => {
    expect(
      () =>
        new GitRepositoryTargetPort({
          executable_path: gitPath,
          executable_sha256: '0'.repeat(64),
        }),
    ).toThrow(/Git executable digest/);
  });

  it('executes a verified private Git snapshot after the source path changes', () => {
    const repository = createRepository();
    const executableRoot = mkdtempSync(join(tmpdir(), 'new-aria-git-source-'));
    temporaryRoots.push(executableRoot);
    const mutableGitPath = join(executableRoot, 'git');
    copyFileSync(gitPath, mutableGitPath);
    chmodSync(mutableGitPath, 0o700);
    const mutableDigest = createHash('sha256').update(readFileSync(mutableGitPath)).digest('hex');
    const adapter = new GitRepositoryTargetPort({
      executable_path: mutableGitPath,
      executable_sha256: mutableDigest,
    });
    writeFileSync(mutableGitPath, '#!/bin/sh\nexit 97\n');
    chmodSync(mutableGitPath, 0o700);

    expect(
      verifyRepositoryTarget(
        {
          repository_id: 'repo-1',
          workspace_id: 'workspace-1',
          repository_root: repository.root,
          reviewed_ref: repository.reviewed_ref,
          base_sha: repository.base,
          head_sha: repository.head,
        },
        adapter,
      ),
    ).toMatchObject({ verdict: 'ACCEPTED' });
  });
});
