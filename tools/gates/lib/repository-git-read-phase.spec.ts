import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { withPinnedRepositoryGitReadPhase } from './repository-git-read-phase';

const roots: string[] = [];

function repositoryFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'aqua-repository-git-phase-'));
  roots.push(root);
  execFileSync('git', ['init', '--quiet', root]);
  writeFileSync(join(root, 'authority.txt'), 'stable\n', 'utf8');
  execFileSync('git', ['-C', root, 'add', 'authority.txt']);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Repository Phase Fixture',
    '-c',
    'user.email=repository-phase@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'test: seed repository phase',
  ]);
  return root;
}

void afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

void describe('pinned repository Git read phase', () => {
  void it('keeps sequential semantic reads in one stable global coordinate generation', () => {
    const root = repositoryFixture();
    const head = withPinnedRepositoryGitReadPhase(root, 'fixture', (readGit) => {
      const first = readGit({
        kind: 'RESOLVE_OBJECT',
        revision: 'HEAD',
        peel: 'COMMIT',
      }).stdout;
      const second = readGit({
        kind: 'RESOLVE_OBJECT',
        revision: 'HEAD',
        peel: 'COMMIT',
      }).stdout;
      assert.equal(first, second);
      return first.trim();
    });
    assert.match(head, /^[0-9a-f]{40}$/);
  });

  void it('fails the whole operation when topology mutates between sequential queries', () => {
    const root = repositoryFixture();
    assert.throws(
      () =>
        withPinnedRepositoryGitReadPhase(root, 'mutation fixture', (readGit) => {
          readGit({ kind: 'RESOLVE_OBJECT', revision: 'HEAD', peel: 'COMMIT' });
          execFileSync('git', ['-C', root, 'branch', 'topology-mutation']);
          readGit({ kind: 'RESOLVE_OBJECT', revision: 'HEAD', peel: 'COMMIT' });
        }),
      /(?:repository .* coordinate changed|descriptor authority)/,
    );
  });
});
