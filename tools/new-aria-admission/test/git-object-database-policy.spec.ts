import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  assertTrustedGitRepositoryTargetPort,
  GitRepositoryTargetPort,
} from '../src/adapters/git/git-repository-target-port';

const gitPath = realpathSync(execFileSync('which', ['git'], { encoding: 'utf8' }).trim());
const gitSha256 = createHash('sha256').update(readFileSync(gitPath)).digest('hex');
const temporaryRoots: string[] = [];

function git(repository: string, ...args: string[]): string {
  return execFileSync(gitPath, ['-C', repository, ...args], {
    encoding: 'utf8',
    env: { PATH: dirname(gitPath), LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'new-aria-git-policy-'));
  temporaryRoots.push(root);
  git(root, 'init', '--quiet');
  return root;
}

const port = (): GitRepositoryTargetPort =>
  new GitRepositoryTargetPort({ executable_path: gitPath, executable_sha256: gitSha256 });

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('Git object database trust policy', () => {
  it('rejects a subclass that overrides a trusted Git adapter method', () => {
    class ForgedGitRepositoryTargetPort extends GitRepositoryTargetPort {
      override resolveCommit(): string {
        return 'f'.repeat(40);
      }
    }

    const forged = new ForgedGitRepositoryTargetPort({
      executable_path: gitPath,
      executable_sha256: gitSha256,
    });

    expect(() => assertTrustedGitRepositoryTargetPort(forged)).toThrow(/not trusted Git/);
  });

  it.each(['objects/info/http-alternates', 'objects/pack/pack-deadbeef.promisor'])(
    'rejects forbidden object database metadata at %s',
    (relative) => {
      const root = createRepository();
      const metadataPath = join(root, '.git', relative);
      mkdirSync(dirname(metadataPath), { recursive: true });
      writeFileSync(metadataPath, 'forbidden\n');

      expect(() => port().canonicalRoot(root)).toThrow(/object database metadata/);
    },
  );

  it('rejects lowercase partial-clone configuration', () => {
    const root = createRepository();
    git(root, 'config', 'extensions.partialclone', 'origin');

    expect(() => port().canonicalRoot(root)).toThrow(/partial-clone or promisor/);
  });

  it('rejects a dangling graft metadata link before it can become active', () => {
    const root = createRepository();
    const graftTarget = join(root, 'delayed-grafts');
    mkdirSync(join(root, '.git/info'), { recursive: true });
    symlinkSync(graftTarget, join(root, '.git/info/grafts'));

    expect(() => port().canonicalRoot(root)).toThrow(/grafts|symbolic|metadata/);
  });

  it('rejects an object database redirected outside the canonical Git directory', () => {
    const root = createRepository();
    const external = mkdtempSync(join(tmpdir(), 'new-aria-external-objects-'));
    temporaryRoots.push(external);
    rmSync(external, { recursive: true });
    renameSync(join(root, '.git/objects'), external);
    symlinkSync(external, join(root, '.git/objects'), 'dir');

    expect(() => port().canonicalRoot(root)).toThrow(/object database|canonical|symbolic/);
  });

  it('rejects a non-worktree gitfile that redirects the complete Git directory', () => {
    const source = createRepository();
    const root = mkdtempSync(join(tmpdir(), 'new-aria-external-gitdir-'));
    temporaryRoots.push(root);
    writeFileSync(join(root, '.git'), `gitdir: ${join(source, '.git')}\n`);

    expect(() => port().canonicalRoot(root)).toThrow(/Git directory binding|linked worktree/);
  });

  it('rejects an externally redirected loose-object fanout directory', () => {
    const root = createRepository();
    writeFileSync(join(root, 'loose-source'), 'loose object\n');
    const oid = git(root, 'hash-object', '-w', 'loose-source');
    const fanout = join(root, '.git/objects', oid.slice(0, 2));
    const external = mkdtempSync(join(tmpdir(), 'new-aria-loose-fanout-'));
    temporaryRoots.push(external);
    rmSync(external, { recursive: true });
    renameSync(fanout, external);
    symlinkSync(external, fanout, 'dir');

    expect(() => port().canonicalRoot(root)).toThrow(/object database|loose|symbolic/);
  });

  it('rejects a symbolic pack-directory entry even when it is not a promisor marker', () => {
    const root = createRepository();
    const external = join(root, 'outside-index');
    writeFileSync(external, 'not an index\n');
    symlinkSync(external, join(root, '.git/objects/pack', `pack-${'a'.repeat(40)}.idx`));

    expect(() => port().canonicalRoot(root)).toThrow(/pack|object database|symbolic/);
  });

  it('bounds pack-directory enumeration before accepting repository metadata', () => {
    const root = createRepository();
    const packDirectory = join(root, '.git/objects/pack');
    for (let index = 0; index < 4_097; index += 1) {
      writeFileSync(join(packDirectory, `bounded-${index.toString().padStart(4, '0')}`), '');
    }

    expect(() => port().canonicalRoot(root)).toThrow(/pack directory exceeds its entry bound/);
  });

  it('shares one bounded enumeration budget across all object info subdirectories', () => {
    const root = createRepository();
    const info = join(root, '.git/objects/info');
    mkdirSync(info, { recursive: true });
    for (const directoryName of ['first', 'second']) {
      const directory = join(info, directoryName);
      mkdirSync(directory);
      for (let index = 0; index < 2_048; index += 1) {
        writeFileSync(join(directory, `entry-${index.toString().padStart(4, '0')}`), '');
      }
    }

    expect(() => port().canonicalRoot(root)).toThrow(/info.*entry bound/i);
  });

  it('rejects promisor configuration scoped to a linked worktree', () => {
    const root = createRepository();
    git(root, 'config', 'user.name', 'ARIA test');
    git(root, 'config', 'user.email', 'aria-test@example.invalid');
    writeFileSync(join(root, 'tracked'), 'tracked\n');
    git(root, 'add', 'tracked');
    git(root, 'commit', '--quiet', '-m', 'tracked');
    git(root, 'config', 'extensions.worktreeConfig', 'true');
    const linked = mkdtempSync(join(tmpdir(), 'new-aria-policy-worktree-'));
    temporaryRoots.push(linked);
    rmSync(linked, { recursive: true });
    git(root, 'worktree', 'add', '--detach', '--quiet', linked);
    git(linked, 'config', '--worktree', 'remote.evil.promisor', 'true');

    expect(() => port().canonicalRoot(linked)).toThrow(/partial-clone or promisor/);
  });

  it('rejects a repository whose object format is not the pinned SHA-1 format', () => {
    const root = mkdtempSync(join(tmpdir(), 'new-aria-sha256-repository-'));
    temporaryRoots.push(root);
    git(root, 'init', '--quiet', '--object-format=sha256');

    expect(() => port().canonicalRoot(root)).toThrow(/object format|SHA-1/);
  });
});
