#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './lib/canonical.mjs';
import { writeAuthority } from './target-control-test-fixture.mjs';
import {
  commitSignaturePolicy,
  createCommitSigner,
  expectedCommitSignatureFacts,
  signerFromCommit,
  writeSignedCommit,
} from './commit-signature-test-fixture.mjs';
import {
  copyVerifiedRuntimeDependencies,
  observeRuntimeDependencies,
} from './lib/runtime-dependencies.mjs';
import { canonicalCommand, invokeWithPackageTripwire } from './target-command-test-fixture.mjs';
const sourceRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const planPath = 'docs/plans/2026-09-01-new-aria-autonomous-engineering';
const manifestPath = `${planPath}/verification/target-manifest.json`;
const designPath = 'docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md';
const formatScopePath = 'tools/quality/format-scope.json';
const reviewedRef = 'refs/remotes/origin/docs/new-aria-autonomous-engineering-plan';

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding ?? 'utf8',
    env: options.env,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function requireSuccess(result, label) {
  assert.equal(result.status, 0, `${label}:\n${result.stdout ?? ''}${result.stderr ?? ''}`);
}

function git(root, args, encoding = 'utf8') {
  const result = run('git', args, { cwd: root, encoding });
  requireSuccess(result, `git ${args.join(' ')}`);
  return result.stdout;
}

function copyCandidate(cloneRoot) {
  const destination = join(cloneRoot, planPath);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(join(sourceRoot, planPath), destination, { recursive: true });
  for (const path of [designPath, formatScopePath]) {
    mkdirSync(dirname(join(cloneRoot, path)), { recursive: true });
    cpSync(join(sourceRoot, path), join(cloneRoot, path));
  }
}

function prepareCandidate(cloneRoot, signer) {
  copyCandidate(cloneRoot);
  git(cloneRoot, ['add', planPath, designPath]);
  const commands = [
    [`${planPath}/verification/render-api-contract.mjs`, '--repo-root', '.'],
    [`${planPath}/verification/render-projections.mjs`, '--repo-root', '.'],
  ];
  for (const args of commands) {
    requireSuccess(run(process.execPath, args, { cwd: cloneRoot }), `node ${args[0]}`);
  }
  git(cloneRoot, ['add', planPath]);
  const format = ['tools/quality/quality.mjs', 'format-scope', 'generate'];
  requireSuccess(run(process.execPath, format, { cwd: cloneRoot }), 'format-scope generation');
  git(cloneRoot, ['add', formatScopePath]);
  const provenance = [
    `${planPath}/verification/record-verifier-inputs.mjs`,
    '--repo-root',
    '.',
    '--observed-at',
    '2026-09-02T00:00:00Z',
  ];
  requireSuccess(run(process.execPath, provenance, { cwd: cloneRoot }), 'provenance generation');
  git(cloneRoot, ['add', planPath, designPath, formatScopePath]);
  const headSha = writeSignedCommit(cloneRoot, 'test: materialize exact D0 candidate', signer);
  git(cloneRoot, ['update-ref', reviewedRef, headSha]);
  return headSha;
}

function commitSigners(cloneRoot, baseSha, headSha) {
  const commits = git(cloneRoot, ['rev-list', `${baseSha}..${headSha}`])
    .trim()
    .split('\n')
    .filter(Boolean);
  const signers = new Map();
  for (const commit of commits) {
    const signer = signerFromCommit(cloneRoot, commit, 'pending', 'pending');
    const digest = sha256(signer.publicKeySpki);
    signers.set(digest, {
      ...signer,
      keyId: `commit-${digest}`,
      principalId: `committer-${digest}`,
    });
  }
  return [...signers.values()];
}

function signedTarget(cloneRoot, operatorRoot, headSha) {
  const manifest = JSON.parse(readFileSync(join(cloneRoot, manifestPath), 'utf8'));
  const facts = expectedCommitSignatureFacts(cloneRoot, manifest.base_sha, headSha);
  const authority = writeAuthority(cloneRoot, operatorRoot, manifest, () => {}, {
    commitSignaturePolicy: commitSignaturePolicy(
      commitSigners(cloneRoot, manifest.base_sha, headSha),
    ),
    commitSignaturesSha256: facts.digest,
  });
  return authority.trustRootSha256;
}

const ownerRoot = mkdtempSync(join(tmpdir(), 'new-aria-d0-command-'));
const cloneRoot = join(ownerRoot, 'repository');
try {
  requireSuccess(
    run('git', ['clone', '--no-local', sourceRoot, cloneRoot], { cwd: ownerRoot }),
    'fresh git clone',
  );
  copyVerifiedRuntimeDependencies(sourceRoot, cloneRoot, observeRuntimeDependencies(sourceRoot));
  assert.equal(
    lstatSync(join(cloneRoot, 'node_modules')).isSymbolicLink(),
    false,
    'fresh clone runtime dependencies must be a private copy',
  );
  git(cloneRoot, ['config', 'user.name', 'D0 Command Test']);
  git(cloneRoot, ['config', 'user.email', 'd0-command@example.invalid']);
  git(cloneRoot, ['config', 'commit.gpgsign', 'false']);
  const baseSha = JSON.parse(readFileSync(join(sourceRoot, manifestPath), 'utf8')).base_sha;
  git(cloneRoot, ['update-ref', 'refs/remotes/origin/main', baseSha]);
  const headSha = prepareCandidate(cloneRoot, createCommitSigner('candidate-key', 'candidate'));
  const trustRootSha256 = signedTarget(cloneRoot, join(ownerRoot, 'operator-input'), headSha);
  const argv = canonicalCommand(cloneRoot);
  const authorityEnv = { ...process.env, ARIA_D0_TRUST_ROOT_SHA256: trustRootSha256 };
  const accepted = run(argv[0], argv.slice(1), { cwd: cloneRoot, env: authorityEnv });
  requireSuccess(accepted, 'documented canonical command');
  assert.match(accepted.stdout, /PASS D0 verifier/u);
  const negativeArgv = canonicalCommand(cloneRoot, 'test-negative-controls.mjs');
  const negative = run(negativeArgv[0], negativeArgv.slice(1), {
    cwd: cloneRoot,
    env: authorityEnv,
  });
  requireSuccess(negative, 'documented negative-control command');
  assert.match(negative.stdout, /PASS negative-controls=/u);
  assert.match(
    negative.stdout,
    /PASS D0 suite roster=/u,
    'canonical negative-control command did not invoke the closed D0 suite runner',
  );

  const cleanEnv = { ...process.env };
  delete cleanEnv.ARIA_D0_TARGET_CONTEXT;
  delete cleanEnv.ARIA_D0_TRUST_ROOT;
  delete cleanEnv.ARIA_D0_AUTHORITY_ROOT;
  delete cleanEnv.ARIA_D0_TRUST_ROOT_SHA256;
  const nodeIndex = argv.indexOf('node');
  assert(nodeIndex > 0, 'canonical command must invoke node after explicit environment settings');
  const withoutEnv = argv.slice(nodeIndex);
  const missingAuthority = invokeWithPackageTripwire(
    cloneRoot,
    join(ownerRoot, 'third-party-executed'),
    () => run(withoutEnv[0], withoutEnv.slice(1), { cwd: cloneRoot, env: cleanEnv }),
  );
  assert.notEqual(missingAuthority.status, 0, 'missing authority environment was accepted');
  assert.match(missingAuthority.stderr, /TARGET_MANIFEST.*authority root/u);

  const refreshedTrustRootSha256 = signedTarget(
    cloneRoot,
    join(ownerRoot, 'operator-input'),
    headSha,
  );
  const refreshedEnv = {
    ...process.env,
    ARIA_D0_TRUST_ROOT_SHA256: refreshedTrustRootSha256,
  };
  const refreshedArgv = canonicalCommand(cloneRoot);
  git(cloneRoot, ['commit', '--allow-empty', '-m', 'test: advance candidate after signature']);
  git(cloneRoot, ['update-ref', reviewedRef, git(cloneRoot, ['rev-parse', 'HEAD']).trim()]);
  const staleSignature = run(refreshedArgv[0], refreshedArgv.slice(1), {
    cwd: cloneRoot,
    env: refreshedEnv,
  });
  assert.notEqual(staleSignature.status, 0, 'old signature accepted a different exact head commit');
  assert.match(staleSignature.stderr, /TARGET_HEAD|TARGET_REF/u);
} finally {
  rmSync(ownerRoot, { recursive: true, force: true });
}

process.stdout.write('PASS target-command fresh-clone=exit0 exact-head=signature-bound\n');
