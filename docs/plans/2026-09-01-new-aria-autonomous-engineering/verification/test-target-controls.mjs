#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256, sha256File } from './lib/canonical.mjs';
import { verifyTarget } from './lib/verify-target.mjs';

function git(root, args, binary = false) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: binary ? null : 'utf8',
  });
}

function commit(root, message) {
  git(root, ['add', '.']);
  git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']).trim();
}

function target(root, baseSha, headSha, reviewedRef = 'refs/heads/main') {
  const commitValue = (value) => git(root, ['rev-parse', '--verify', value]).trim();
  const diff = git(
    root,
    [
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      '--find-copies',
      `${baseSha}..${headSha}`,
      '--',
    ],
    true,
  );
  return {
    baseSha,
    headSha,
    reviewedRef,
    baseTree: commitValue(`${baseSha}^{tree}`),
    headTree: commitValue(`${headSha}^{tree}`),
    diffSha256: sha256(diff),
    designSha256: sha256File(
      join(root, 'docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md'),
    ),
    formatScopeSha256: sha256File(join(root, 'tools/quality/format-scope.json')),
  };
}

function expectCode(name, result, code) {
  assert(
    result.errors.some((error) => error.code === code),
    `${name}: expected ${code}, received ${JSON.stringify(result.errors)}`,
  );
}

const root = mkdtempSync(join(tmpdir(), 'new-aria-d0-target-'));
try {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'D0 Target Test']);
  git(root, ['config', 'user.email', 'd0-target@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  for (const path of [
    'aria-kernel/frozen.txt',
    'docs/plans/2026-09-01-new-aria-autonomous-engineering/allowed.txt',
    'docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md',
    'tools/quality/format-scope.json',
  ]) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), `${path}\n`);
  }
  const baseSha = commit(root, 'test: establish target baseline');
  renameSync(
    join(root, 'aria-kernel/frozen.txt'),
    join(root, 'docs/plans/2026-09-01-new-aria-autonomous-engineering/renamed.txt'),
  );
  mkdirSync(join(root, 'apps/example'), { recursive: true });
  writeFileSync(join(root, 'apps/example/product.txt'), 'product\n');
  const headSha = commit(root, 'test: commit forbidden scope');
  const declared = target(root, baseSha, headSha);
  const result = verifyTarget(root, declared);
  expectCode('rename old path', result, 'PROTECTED_SCOPE');
  expectCode('product path', result, 'PRODUCT_SCOPE');
  assert(
    result.facts.committed_entries.some(
      (entry) =>
        entry.oldPath === 'aria-kernel/frozen.txt' &&
        entry.newPath !== null &&
        entry.newPath.endsWith('/renamed.txt'),
    ),
    'rename old/new paths were not retained',
  );

  for (const [name, field, code] of [
    ['base tree', 'baseTree', 'TARGET_BASE_TREE'],
    ['head tree', 'headTree', 'TARGET_HEAD_TREE'],
    ['diff digest', 'diffSha256', 'TARGET_DIFF'],
    ['design digest', 'designSha256', 'TARGET_DESIGN'],
    ['format digest', 'formatScopeSha256', 'TARGET_FORMAT_SCOPE'],
  ]) {
    expectCode(
      name,
      verifyTarget(root, { ...declared, [field]: '0'.repeat(field.endsWith('Tree') ? 40 : 64) }),
      code,
    );
  }

  git(root, ['branch', 'stale-review', baseSha]);
  expectCode(
    'reviewed ref',
    verifyTarget(root, { ...declared, reviewedRef: 'refs/heads/stale-review' }),
    'TARGET_REF',
  );
  git(root, ['checkout', '--detach', baseSha]);
  expectCode('checkout head', verifyTarget(root, declared), 'TARGET_HEAD');
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write('PASS target-controls\n');
