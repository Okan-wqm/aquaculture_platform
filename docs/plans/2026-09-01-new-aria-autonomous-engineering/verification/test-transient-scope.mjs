#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitSignaturePolicy,
  createCommitSigner,
  expectedCommitSignatureFacts,
  writeSignedCommit,
} from './commit-signature-test-fixture.mjs';
import {
  declaredTarget,
  git,
  targetManifest,
  writeAuthority,
  writeManifest,
  writeRuntimeFixture,
} from './target-control-test-fixture.mjs';
import { verifyTarget } from './lib/verify-target.mjs';

const plan = 'docs/plans/2026-09-01-new-aria-autonomous-engineering';

function file(root, path, bytes = `${path}\n`) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), bytes);
}

function initialize(root) {
  mkdirSync(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'D0 Scope Test']);
  git(root, ['config', 'user.email', 'd0-scope@example.invalid']);
  writeRuntimeFixture(root);
  for (const path of [
    `${plan}/baseline.md`,
    'docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md',
    'tools/quality/format-scope.json',
  ]) {
    file(root, path);
  }
}

function result(context) {
  const { baseSha, headSha, manifest, ownerRoot, root, signer } = context;
  git(root, ['update-ref', 'refs/remotes/origin/main', baseSha]);
  git(root, ['update-ref', 'refs/remotes/origin/review', headSha]);
  const facts = expectedCommitSignatureFacts(root, baseSha, headSha);
  const authority = writeAuthority(root, join(ownerRoot, 'operator'), manifest, () => {}, {
    commitSignaturePolicy: commitSignaturePolicy([signer]),
    commitSignaturesSha256: facts.digest,
  });
  return verifyTarget(root, declaredTarget(root, baseSha, headSha), authority);
}

const ownerRoot = mkdtempSync(join(tmpdir(), 'new-aria-transient-scope-'));
try {
  const transientRoot = join(ownerRoot, 'transient');
  initialize(transientRoot);
  const transientSigner = createCommitSigner('transient-key', 'transient-committer');
  const transientBase = writeSignedCommit(
    transientRoot,
    'test: transient scope base',
    transientSigner,
  );
  const transientManifest = targetManifest(transientRoot, transientBase);
  writeManifest(transientRoot, transientManifest);
  file(transientRoot, '.github/workflows/transient.yml', 'name: forbidden\n');
  writeSignedCommit(transientRoot, 'test: transient protected edit', transientSigner);
  rmSync(join(transientRoot, '.github/workflows/transient.yml'));
  const transientHead = writeSignedCommit(
    transientRoot,
    'test: revert protected edit',
    transientSigner,
  );
  const transient = result({
    baseSha: transientBase,
    headSha: transientHead,
    manifest: transientManifest,
    ownerRoot: join(ownerRoot, 'transient-authority'),
    root: transientRoot,
    signer: transientSigner,
  });
  assert.deepEqual(
    [...new Set(transient.errors.map(({ code }) => code))],
    ['PROTECTED_SCOPE'],
    `transient protected edit escaped: ${JSON.stringify(transient.errors)}`,
  );

  const mergeRoot = join(ownerRoot, 'merge-main');
  initialize(mergeRoot);
  const mergeSigner = createCommitSigner('merge-key', 'merge-committer');
  const ancestor = writeSignedCommit(mergeRoot, 'test: shared ancestor', mergeSigner);
  file(mergeRoot, 'apps/main-change.txt', 'new main product bytes\n');
  const mergeBase = writeSignedCommit(mergeRoot, 'test: newer main base', mergeSigner);
  const mergeManifest = targetManifest(mergeRoot, mergeBase);
  git(mergeRoot, ['update-ref', 'HEAD', ancestor]);
  rmSync(join(mergeRoot, 'apps/main-change.txt'));
  file(mergeRoot, `${plan}/candidate.md`, 'D0 candidate\n');
  writeManifest(mergeRoot, mergeManifest);
  const d0Parent = writeSignedCommit(mergeRoot, 'test: D0 parent', mergeSigner);
  git(mergeRoot, ['update-ref', 'HEAD', mergeBase]);
  file(mergeRoot, 'apps/main-change.txt', 'new main product bytes\n');
  file(mergeRoot, `${plan}/candidate.md`, 'D0 candidate\n');
  writeManifest(mergeRoot, mergeManifest);
  const mergeHead = writeSignedCommit(mergeRoot, 'test: merge newer main', mergeSigner, [d0Parent]);
  const merge = result({
    baseSha: mergeBase,
    headSha: mergeHead,
    manifest: mergeManifest,
    ownerRoot: join(ownerRoot, 'merge-authority'),
    root: mergeRoot,
    signer: mergeSigner,
  });
  assert.deepEqual(
    merge.errors,
    [],
    `newer-main merge false positive: ${JSON.stringify(merge.errors)}`,
  );
} finally {
  rmSync(ownerRoot, { recursive: true, force: true });
}

process.stdout.write('PASS transient-scope reverted=denied newer-main-merge=accepted\n');
