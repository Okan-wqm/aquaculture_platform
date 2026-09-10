#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitSignaturePolicy,
  createCommitSigner,
  expectedCommitSignatureFacts,
  writeSignedCommit,
} from './commit-signature-test-fixture.mjs';
import { classifyPlanArtifact, planPrefix } from './lib/artifact-policy.mjs';
import {
  declaredTarget,
  git,
  targetManifest,
  writeAuthority,
  writeManifest,
  writeRuntimeFixture,
} from './target-control-test-fixture.mjs';
import { verifyTarget } from './lib/verify-target.mjs';

for (const path of [`${planPrefix}bad\nname.md`, `${planPrefix}bad\u007fname.md`]) {
  assert.equal(classifyPlanArtifact(path), null, `control-character path accepted: ${path}`);
}
assert.equal(
  classifyPlanArtifact(`${planPrefix}safe\u202eevil.md`),
  null,
  'bidirectional-control path accepted',
);

const ownerRoot = mkdtempSync(join(tmpdir(), 'new-aria-d0-artifacts-'));
const root = join(ownerRoot, 'repository');
try {
  mkdirSync(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'D0 Artifact Test']);
  git(root, ['config', 'user.email', 'd0-artifact@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  const signer = createCommitSigner();
  writeRuntimeFixture(root);
  for (const path of [
    `${planPrefix}baseline.md`,
    'docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md',
    'tools/quality/format-scope.json',
  ]) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), `${path}\n`);
  }
  const unchanged = `${planPrefix}unchanged-symlink.md`;
  const changed = `${planPrefix}changed-from-symlink.md`;
  symlinkSync('baseline.md', join(root, unchanged));
  symlinkSync('baseline.md', join(root, changed));
  const baseSha = writeSignedCommit(root, 'test: establish malformed plan tree', signer);
  const manifest = targetManifest(root, baseSha);
  unlinkSync(join(root, changed));
  writeFileSync(join(root, changed), 'now regular\n');
  writeManifest(root, manifest);
  const headSha = writeSignedCommit(root, 'test: change another plan artifact', signer);
  git(root, ['update-ref', 'refs/remotes/origin/main', baseSha]);
  git(root, ['update-ref', 'refs/remotes/origin/review', headSha]);
  const signatures = expectedCommitSignatureFacts(root, baseSha, headSha);
  const authority = writeAuthority(root, join(ownerRoot, 'operator'), manifest, () => {}, {
    commitSignaturePolicy: commitSignaturePolicy([signer]),
    commitSignaturesSha256: signatures.digest,
  });
  const result = verifyTarget(root, declaredTarget(root, baseSha, headSha), authority);
  assert.deepEqual(
    result.errors
      .map(({ code, message }) => ({ code, path: message.split(':')[0] }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    ['changed-from-symlink.md', 'unchanged-symlink.md'].map((path) => ({
      code: 'D0_ARTIFACT_POLICY',
      path: `${planPrefix}${path}`,
    })),
  );
} finally {
  rmSync(ownerRoot, { recursive: true, force: true });
}

process.stdout.write('PASS target-artifacts paths=closed plan-tree=enumerated\n');
