#!/usr/bin/env node

import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyTarget } from './lib/verify-target.mjs';
import {
  commit,
  declaredTarget,
  git,
  targetManifest,
  writeAuthority,
  writeManifest,
  writeRuntimeFixture,
} from './target-control-test-fixture.mjs';

function expectCode(name, result, code) {
  assert(
    result.errors.some((error) => error.code === code),
    `${name}: expected ${code}, received ${JSON.stringify(result.errors)}`,
  );
}

const ownerRoot = mkdtempSync(join(tmpdir(), 'new-aria-d0-target-owner-'));
const root = join(ownerRoot, 'repository');
try {
  mkdirSync(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'D0 Target Test']);
  git(root, ['config', 'user.email', 'd0-target@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  writeRuntimeFixture(root);
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
  const manifest = targetManifest(root, baseSha);
  writeManifest(root, manifest);
  renameSync(
    join(root, 'aria-kernel/frozen.txt'),
    join(root, 'docs/plans/2026-09-01-new-aria-autonomous-engineering/renamed.txt'),
  );
  mkdirSync(join(root, 'apps/example'), { recursive: true });
  writeFileSync(join(root, 'apps/example/product.txt'), 'product\n');
  const headSha = commit(root, 'test: commit forbidden scope');
  git(root, ['update-ref', 'refs/remotes/origin/main', baseSha]);
  git(root, ['update-ref', 'refs/remotes/origin/review', headSha]);

  const authority = writeAuthority(root, join(ownerRoot, 'operator'), manifest);
  const declared = declaredTarget(root, baseSha, headSha);
  const result = verifyTarget(root, declared, authority);
  assert.equal(
    result.errors.some((error) => error.code === 'TARGET_MANIFEST'),
    false,
    `signed manifest with a pinned Git tool was rejected: ${JSON.stringify(result.errors)}`,
  );
  expectCode('rename old path', result, 'PROTECTED_SCOPE');
  expectCode('product path', result, 'PRODUCT_SCOPE');

  const committedManifestPath = join(
    root,
    'docs/plans/2026-09-01-new-aria-autonomous-engineering/verification/target-manifest.json',
  );
  writeFileSync(committedManifestPath, Buffer.from([0x7b, 0x80, 0x7d]));
  const dirtyManifest = verifyTarget(root, declared, authority);
  assert.equal(
    dirtyManifest.errors.some((error) => error.code === 'TARGET_MANIFEST'),
    false,
    'mutable worktree manifest replaced the signed HEAD manifest snapshot',
  );
  expectCode('dirty worktree manifest', dirtyManifest, 'WORKTREE_DIRTY');
  writeManifest(root, manifest);

  const emptyRange = declaredTarget(root, headSha, headSha);
  expectCode(
    'caller-selected empty range',
    verifyTarget(root, emptyRange, authority),
    'TARGET_RANGE',
  );
  expectCode(
    'caller-selected base contradicts authority',
    verifyTarget(root, emptyRange, authority),
    'TARGET_MANIFEST',
  );

  const rewritten = targetManifest(root, headSha);
  writeManifest(root, rewritten);
  expectCode(
    'coordinated manifest and empty-range rewrite',
    verifyTarget(root, emptyRange, authority),
    'TARGET_MANIFEST',
  );

  const missingGitAuthority = writeAuthority(
    root,
    join(ownerRoot, 'operator-missing-git'),
    manifest,
    (target) => delete target.git_tool,
  );
  expectCode(
    'signed target without a Git tool',
    verifyTarget(root, declared, missingGitAuthority),
    'TARGET_MANIFEST',
  );

  const wrongNodeAuthority = writeAuthority(
    root,
    join(ownerRoot, 'operator-wrong-node'),
    manifest,
    (target) => (target.node_tool.executable_sha256 = '0'.repeat(64)),
  );
  expectCode(
    'signed target with wrong Node executable digest',
    verifyTarget(root, declared, wrongNodeAuthority),
    'TARGET_RESOLUTION',
  );

  const missingDependencyAuthority = writeAuthority(
    root,
    join(ownerRoot, 'operator-missing-runtime-dependency'),
    manifest,
    (target) => target.runtime_dependencies.pop(),
  );
  expectCode(
    'signed target with an open runtime dependency roster',
    verifyTarget(root, declared, missingDependencyAuthority),
    'TARGET_MANIFEST',
  );

  const tamperedDependencyAuthority = writeAuthority(
    root,
    join(ownerRoot, 'operator-tampered-runtime-dependency'),
    manifest,
    (target) => (target.runtime_dependencies[0].package_tree_sha256 = '0'.repeat(64)),
  );
  expectCode(
    'installed runtime bytes disagree with signed dependency facts',
    verifyTarget(root, declared, tamperedDependencyAuthority),
    'TARGET_RESOLUTION',
  );

  const hostBoundManifest = { ...manifest, git_tool: {} };
  const hostBoundAuthority = writeAuthority(
    root,
    join(ownerRoot, 'operator-host-bound-manifest'),
    hostBoundManifest,
  );
  expectCode(
    'committed manifest with host-specific tool facts',
    verifyTarget(root, declared, hostBoundAuthority),
    'TARGET_MANIFEST',
  );

  git(root, ['update-ref', 'refs/remotes/origin/main', headSha]);
  const authorizedEmpty = writeAuthority(root, join(ownerRoot, 'operator-empty'), rewritten);
  expectCode(
    'signed empty range remains forbidden',
    verifyTarget(root, emptyRange, authorizedEmpty),
    'TARGET_RANGE',
  );

  git(root, ['update-ref', 'refs/remotes/origin/main', baseSha]);
  const localRef = targetManifest(root, baseSha, 'refs/heads/main');
  const localAuthority = writeAuthority(root, join(ownerRoot, 'operator-local'), localRef);
  expectCode(
    'local reviewed ref is not clone-reproducible',
    verifyTarget(root, { ...declared, reviewedRef: 'refs/heads/main' }, localAuthority),
    'TARGET_MANIFEST',
  );

  writeManifest(root, manifest);
  expectCode(
    'authority root that contains the repository',
    verifyTarget(root, declared, { ...authority, authorityRoot: ownerRoot }),
    'TARGET_MANIFEST',
  );
  expectCode(
    'wrong out-of-band trust-root digest',
    verifyTarget(root, declared, { ...authority, trustRootSha256: '0'.repeat(64) }),
    'TARGET_MANIFEST',
  );
  const insideTrustRoot = join(root, 'inside-trust.json');
  copyFileSync(authority.trustRootPath, insideTrustRoot);
  expectCode(
    'trust root inside reviewed repository',
    verifyTarget(root, declared, { ...authority, trustRootPath: insideTrustRoot }),
    'TARGET_MANIFEST',
  );

  for (const [name, field, code] of [
    ['base tree', 'baseTree', 'TARGET_BASE_TREE'],
    ['head tree', 'headTree', 'TARGET_HEAD_TREE'],
    ['diff digest', 'diffSha256', 'TARGET_DIFF'],
    ['design digest', 'designSha256', 'TARGET_DESIGN'],
    ['format digest', 'formatScopeSha256', 'TARGET_FORMAT_SCOPE'],
  ]) {
    const width = field.endsWith('Tree') ? 40 : 64;
    expectCode(
      name,
      verifyTarget(root, { ...declared, [field]: '0'.repeat(width) }, authority),
      code,
    );
  }
} finally {
  rmSync(ownerRoot, { recursive: true, force: true });
}

process.stdout.write('PASS target-controls external-signature=required empty-range=denied\n');
