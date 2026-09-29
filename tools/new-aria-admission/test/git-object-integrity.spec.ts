import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitRepositoryTargetPort } from '../src/adapters/git/git-repository-target-port';
import { verifyRepositoryTarget } from '../src/application/repository-target-verifier';

import { redirectPackedObject } from './git-pack-index-mutant';
import type { GitTargetFixture } from './git-target-fixture';
import { createGitTargetFixture, gitPath, gitSha256, runGit } from './git-target-fixture';

function verify(
  repository: GitTargetFixture,
  executable = { path: gitPath, sha256: gitSha256 },
): ReturnType<typeof verifyRepositoryTarget> {
  return verifyRepositoryTarget(
    {
      repository_id: 'repo-1',
      workspace_id: 'workspace-1',
      repository_root: repository.root,
      reviewed_ref: repository.reviewed_ref,
      base_sha: repository.base,
      head_sha: repository.head,
    },
    new GitRepositoryTargetPort({
      executable_path: executable.path,
      executable_sha256: executable.sha256,
    }),
  );
}

function treeIdentityWrapper(
  root: string,
  head: string,
  tree: string,
  attackerBlob: string,
): {
  readonly path: string;
  readonly sha256: string;
} {
  const path = join(root, 'fixture-git-wrapper');
  const quotedGit = `'${gitPath.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    path,
    `#!/bin/sh\ncase " $* " in\n*" ${head}^{tree} "*) printf '%s\\n' '${tree}'; exit 0;;\n*" ls-tree "*) printf '100644 blob ${attackerBlob} 14\\treviewed.txt\\000'; exit 0;;\nesac\nexec ${quotedGit} "$@"\n`,
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
  return {
    path,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}

function ancestryWrapper(
  root: string,
  base: string,
  head: string,
): {
  readonly path: string;
  readonly sha256: string;
} {
  const path = join(root, 'fixture-ancestry-wrapper');
  const quotedGit = `'${gitPath.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    path,
    `#!/bin/sh\ncase " $* " in\n*" merge-base --is-ancestor ${base} ${head} "*) exit 0;;\n*" merge-base ${base} ${head} "*) printf '%s\\n' '${base}'; exit 0;;\nesac\nexec ${quotedGit} "$@"\n`,
    { mode: 0o700 },
  );
  chmodSync(path, 0o700);
  return {
    path,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  };
}

describe('Git raw object identity', () => {
  it('rejects a pack index that maps the authorized root tree OID to attacker tree bytes', () => {
    const repository = createGitTargetFixture();
    try {
      const authorizedTree = runGit(repository.root, 'rev-parse', `${repository.head}^{tree}`);
      writeFileSync(join(repository.root, 'reviewed.txt'), 'attacker tree\n');
      runGit(repository.root, 'add', 'reviewed.txt');
      const attackerTree = runGit(repository.root, 'write-tree');
      const attackerBlob = runGit(repository.root, 'rev-parse', `${attackerTree}:reviewed.txt`);
      runGit(repository.root, 'reset', '--hard', '--quiet', repository.head);
      const attackerCommit = runGit(
        repository.root,
        'commit-tree',
        attackerTree,
        '-p',
        repository.base,
        '-m',
        'attacker commit',
      );
      runGit(repository.root, 'update-ref', 'refs/heads/pack-mutant', attackerCommit);
      runGit(repository.root, 'repack', '-a', '-d', '-f', '--window=0', '--depth=0');
      runGit(repository.root, 'update-ref', '-d', 'refs/heads/pack-mutant');
      redirectPackedObject(repository.root, authorizedTree, attackerTree);
      expect(runGit(repository.root, 'show', `${repository.head}:reviewed.txt`)).toBe(
        'attacker tree',
      );
      const wrappedGit = treeIdentityWrapper(
        repository.root,
        repository.head,
        authorizedTree,
        attackerBlob,
      );

      expect(() => verify(repository, wrappedGit)).toThrow(/object identity|raw object|digest/);
    } finally {
      rmSync(repository.root, { force: true, recursive: true });
    }
  });

  it('rejects an ancestry answer that omits the raw parent path to the authorized base', () => {
    const repository = createGitTargetFixture();
    try {
      const tree = runGit(repository.root, 'rev-parse', `${repository.head}^{tree}`);
      const unrelated = runGit(repository.root, 'commit-tree', tree, '-m', 'unrelated root');
      runGit(repository.root, 'update-ref', repository.reviewed_ref, unrelated);
      const wrappedGit = ancestryWrapper(repository.root, repository.base, unrelated);

      expect(() => verify({ ...repository, head: unrelated }, wrappedGit)).toThrow(
        /raw commit|ancestor|closure/,
      );
    } finally {
      rmSync(repository.root, { force: true, recursive: true });
    }
  });

  it('accepts a valid target whose complete object closure is packed', () => {
    const repository = createGitTargetFixture();
    try {
      runGit(repository.root, 'repack', '-a', '-d', '-f');

      expect(verify(repository)).toMatchObject({ verdict: 'ACCEPTED' });
    } finally {
      rmSync(repository.root, { force: true, recursive: true });
    }
  });

  it('accepts a linked worktree only through its canonical common object directory', () => {
    const repository = createGitTargetFixture();
    const linkedRoot = mkdtempSync(join(tmpdir(), 'new-aria-linked-target-'));
    rmSync(linkedRoot, { recursive: true });
    try {
      runGit(
        repository.root,
        'worktree',
        'add',
        '--detach',
        '--quiet',
        linkedRoot,
        repository.head,
      );

      expect(verify({ ...repository, root: linkedRoot })).toMatchObject({ verdict: 'ACCEPTED' });
    } finally {
      rmSync(linkedRoot, { force: true, recursive: true });
      rmSync(repository.root, { force: true, recursive: true });
    }
  });
});
