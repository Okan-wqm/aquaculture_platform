#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listCommitTree,
  parseBatchOutput,
  readCommitEntries,
  readCommitFile,
} from './lib/git-objects.mjs';
import { createGitSession, observeGitTool, resolveGitTool } from './lib/hermetic-git.mjs';
import { walkRegularFiles } from './lib/secure-tree.mjs';

const ownerRoot = mkdtempSync(join(tmpdir(), 'new-aria-secure-tree-'));
try {
  const root = join(ownerRoot, 'root');
  const outside = join(ownerRoot, 'outside');
  mkdirSync(join(root, 'nested'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, 'nested/ok.txt'), 'ok\n');
  writeFileSync(join(outside, 'secret.txt'), 'secret\n');
  assert.deepEqual(walkRegularFiles(root), [join(root, 'nested/ok.txt')]);

  symlinkSync(join(outside, 'secret.txt'), join(root, 'file-link'));
  assert.throws(() => walkRegularFiles(root), /symbolic link/u);
  rmSync(join(root, 'file-link'));

  symlinkSync(outside, join(root, 'directory-link'));
  assert.throws(() => walkRegularFiles(root), /symbolic link/u);
  rmSync(join(root, 'directory-link'));

  execFileSync('mkfifo', [join(root, 'pipe')]);
  assert.throws(() => walkRegularFiles(root), /regular file or directory/u);

  const repository = join(ownerRoot, 'repository');
  mkdirSync(repository);
  const tool = observeGitTool();
  const git = resolveGitTool(tool).executablePath;
  execFileSync(git, ['init', '-q'], { cwd: repository });
  execFileSync(git, ['config', 'user.name', 'Fixture'], { cwd: repository });
  execFileSync(git, ['config', 'user.email', 'fixture@example.invalid'], { cwd: repository });
  writeFileSync(join(repository, 'outside'), 'secret\n');
  symlinkSync('outside', join(repository, 'evidence'));
  execFileSync(git, ['add', '.'], { cwd: repository });
  execFileSync(git, ['commit', '-q', '-m', 'fixture'], { cwd: repository });
  const head = execFileSync(git, ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  const session = createGitSession(tool);
  const regular = listCommitTree(repository, head, 'outside', session);
  assert.equal(
    readCommitEntries(repository, regular, session).get('outside').bytes.toString(),
    'secret\n',
  );
  const header = Buffer.from(`${regular[0].oid} blob 7\nsecret\n\n`);
  assert.throws(() => parseBatchOutput(header.subarray(0, -1), regular), /truncated/u);
  assert.throws(
    () => parseBatchOutput(Buffer.concat([header, Buffer.from('x')]), regular),
    /trailing/u,
  );
  assert.throws(
    () => parseBatchOutput(Buffer.from(header.toString().replace(' blob ', ' commit ')), regular),
    /identity/u,
  );
  assert.throws(
    () => readCommitFile(repository, head, { path: 'evidence' }, tool),
    /tree mode must be regular non-executable blob/u,
  );
  execFileSync(git, ['update-index', '--chmod=+x', 'outside'], { cwd: repository });
  execFileSync(git, ['update-index', '--add', '--cacheinfo', '160000', head, 'submodule'], {
    cwd: repository,
  });
  execFileSync(git, ['commit', '-q', '-m', 'bad modes'], { cwd: repository });
  const badHead = execFileSync(git, ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  for (const path of ['outside', 'submodule']) {
    assert.throws(
      () => readCommitFile(repository, badHead, { path }, tool),
      /tree mode must be regular non-executable blob/u,
    );
  }
} finally {
  rmSync(ownerRoot, { recursive: true, force: true });
}

process.stdout.write(
  'PASS secure-tree symlink=denied special=denied git-mode=denied batch=framed\n',
);
