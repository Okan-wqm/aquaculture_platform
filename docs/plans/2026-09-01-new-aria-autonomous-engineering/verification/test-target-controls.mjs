#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, sha256, sha256File } from './lib/canonical.mjs';
import { verifyTarget } from './lib/verify-target.mjs';

const manifestPath =
  'docs/plans/2026-09-01-new-aria-autonomous-engineering/verification/target-manifest.json';

function git(root, args, binary = false) {
  return execFileSync('git', args, { cwd: root, encoding: binary ? null : 'utf8' });
}

function commit(root, message) {
  git(root, ['add', '.']);
  git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']).trim();
}

function declaredTarget(root, baseSha, headSha, reviewedRef = 'refs/remotes/origin/review') {
  const resolve = (value) => git(root, ['rev-parse', '--verify', value]).trim();
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
    baseTree: resolve(`${baseSha}^{tree}`),
    headTree: resolve(`${headSha}^{tree}`),
    diffSha256: sha256(diff),
    designSha256: sha256File(
      join(root, 'docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md'),
    ),
    formatScopeSha256: sha256File(join(root, 'tools/quality/format-scope.json')),
  };
}

function targetManifest(root, baseSha, reviewedRef = 'refs/remotes/origin/review') {
  return {
    schema_version: '1.0.0',
    kind: 'new-aria-d0-verification-target',
    program_instance: 'new-aria-autonomous-engineering:D0:2026-09-01',
    repository_slug: 'Okan-wqm/aquaculture_platform',
    base_ref: 'refs/remotes/origin/main',
    base_sha: baseSha,
    base_tree: git(root, ['rev-parse', `${baseSha}^{tree}`]).trim(),
    reviewed_ref: reviewedRef,
    head_policy: 'CHECKOUT_EXACT',
    scope_policy: 'D0_PLAN_ONLY',
  };
}

function writeManifest(root, manifest) {
  const path = join(root, manifestPath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

function writeAuthority(root, operatorRoot, manifest, keys = generateKeyPairSync('ed25519')) {
  const publicDer = keys.publicKey.export({ format: 'der', type: 'spki' });
  const trustRoot = {
    schema_version: '1.0.0',
    kind: 'new-aria-external-trust-root',
    algorithm: 'Ed25519',
    key_id: 'operator-test-key',
    principal_id: 'target-operator',
    capabilities: ['d0-target-authority'],
    public_key_spki_base64: publicDer.toString('base64'),
  };
  const declared = declaredTarget(
    root,
    manifest.base_sha,
    git(root, ['rev-parse', 'HEAD']).trim(),
    manifest.reviewed_ref,
  );
  const payload = {
    contract_id: 'new-aria-d0-target-authority-v1',
    manifest_sha256: sha256File(writeManifest(root, manifest)),
    manifest,
    operator_principal_id: trustRoot.principal_id,
    target: {
      base_sha: declared.baseSha,
      base_tree: declared.baseTree,
      head_sha: declared.headSha,
      head_tree: declared.headTree,
      reviewed_ref: declared.reviewedRef,
      committed_diff_sha256: declared.diffSha256,
      design_sha256: declared.designSha256,
      format_scope_sha256: declared.formatScopeSha256,
    },
  };
  const envelope = {
    schema_version: '1.0.0',
    kind: 'new-aria-d0-target-authority',
    algorithm: 'Ed25519',
    key_id: trustRoot.key_id,
    payload,
    signature_base64: sign(null, Buffer.from(canonicalJson(payload)), keys.privateKey).toString(
      'base64',
    ),
  };
  mkdirSync(operatorRoot, { recursive: true });
  const contextPath = join(operatorRoot, 'target-context.json');
  const trustRootPath = join(operatorRoot, 'trust-root.json');
  const trustRootBytes = Buffer.from(`${JSON.stringify(trustRoot, null, 2)}\n`);
  writeFileSync(contextPath, `${JSON.stringify(envelope, null, 2)}\n`);
  writeFileSync(trustRootPath, trustRootBytes);
  return {
    authorityRoot: operatorRoot,
    contextPath,
    trustRootPath,
    trustRootSha256: sha256(trustRootBytes),
  };
}

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
  git(root, ['update-ref', 'refs/remotes/origin/main', baseSha]);
  git(root, ['update-ref', 'refs/remotes/origin/review', headSha]);

  const manifest = targetManifest(root, baseSha);
  const authority = writeAuthority(root, join(ownerRoot, 'operator'), manifest);
  const declared = declaredTarget(root, baseSha, headSha);
  const result = verifyTarget(root, declared, authority);
  expectCode('rename old path', result, 'PROTECTED_SCOPE');
  expectCode('product path', result, 'PRODUCT_SCOPE');

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
