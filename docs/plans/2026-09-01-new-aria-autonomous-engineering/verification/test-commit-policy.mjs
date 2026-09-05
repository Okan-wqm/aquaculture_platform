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

function resultFor(context, name, policy) {
  const authority = writeAuthority(
    context.root,
    join(context.ownerRoot, `operator-${name}`),
    context.manifest,
    () => {},
    { commitSignaturePolicy: policy, commitSignaturesSha256: context.facts.digest },
  );
  return verifyTarget(
    context.root,
    declaredTarget(context.root, context.baseSha, context.headSha),
    authority,
  );
}

function expectOnly(context, name, code, mutate) {
  const policy = structuredClone(context.policy);
  mutate(policy);
  const errors = resultFor(context, name, policy).errors;
  assert.deepEqual(
    [...new Set(errors.map((error) => error.code))],
    [code],
    `${name}: ${JSON.stringify(errors)}`,
  );
}

const ownerRoot = mkdtempSync(join(tmpdir(), 'new-aria-commit-policy-'));
const root = join(ownerRoot, 'repository');
try {
  mkdirSync(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'D0 Commit Policy Test']);
  git(root, ['config', 'user.email', 'd0-policy@example.invalid']);
  writeRuntimeFixture(root);
  for (const path of [
    `${plan}/baseline.md`,
    'docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md',
    'tools/quality/format-scope.json',
  ]) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), `${path}\n`);
  }
  const signer = createCommitSigner('policy-signer', 'policy-committer');
  const baseSha = writeSignedCommit(root, 'test: policy base', signer);
  const manifest = targetManifest(root, baseSha);
  writeManifest(root, manifest);
  const headSha = writeSignedCommit(root, 'test: policy head', signer);
  git(root, ['update-ref', 'refs/remotes/origin/main', baseSha]);
  git(root, ['update-ref', 'refs/remotes/origin/review', headSha]);
  const context = {
    baseSha,
    facts: expectedCommitSignatureFacts(root, baseSha, headSha),
    headSha,
    manifest,
    ownerRoot,
    policy: commitSignaturePolicy([signer]),
    root,
  };
  assert.deepEqual(resultFor(context, 'valid', context.policy).errors, []);
  expectOnly(context, 'same-principal', 'TARGET_MANIFEST', (policy) => {
    policy.commit_signers[0].principal_id = 'target-operator';
  });
  expectOnly(context, 'wrong-repository', 'TARGET_MANIFEST', (policy) => {
    policy.commit_signers[0].repository_slug = 'attacker/repository';
  });
  expectOnly(context, 'wrong-program', 'TARGET_MANIFEST', (policy) => {
    policy.commit_signers[0].program_instance = 'attacker:workspace';
  });
  expectOnly(context, 'expired', 'TARGET_MANIFEST', (policy) => {
    policy.commit_signers[0].valid_until = '2020-01-02T00:00:00Z';
  });
  expectOnly(context, 'revoked', 'TARGET_MANIFEST', (policy) => {
    policy.commit_signers[0].status = 'REVOKED';
  });
  expectOnly(context, 'stale-epoch', 'TARGET_MANIFEST', (policy) => {
    policy.commit_signers[0].revocation_epoch = 0;
  });
  expectOnly(context, 'commit-before-window', 'COMMIT_SIGNATURE', (policy) => {
    const future = Math.floor(Date.now() / 1_000) - 1_800;
    policy.commit_signers[0].valid_from = new Date(future * 1_000)
      .toISOString()
      .replace('.000Z', 'Z');
  });
  expectOnly(context, 'future-observation', 'TARGET_MANIFEST', (policy) => {
    policy.operator_observed_at = '2035-01-01T00:00:00Z';
  });
} finally {
  rmSync(ownerRoot, { recursive: true, force: true });
}

process.stdout.write('PASS commit-policy identity=bound validity=bound revocation=bound\n');
