#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitSignaturePolicy,
  createCommitSigner,
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
import { createGitSession, observeGitTool } from './lib/hermetic-git.mjs';
import { repositoryMetadataViolation } from './lib/repository-integrity.mjs';

const plan = 'docs/plans/2026-09-01-new-aria-autonomous-engineering';

function expectOnly(name, result, code) {
  assert.deepEqual(
    [...new Set(result.errors.map((error) => error.code))],
    [code],
    `${name}: ${JSON.stringify(result.errors)}`,
  );
}

function verifyAttack(context, name, head, signer, code) {
  const authority = writeAuthority(
    context.root,
    join(context.ownerRoot, `operator-${name}`),
    context.manifest,
    () => {},
    {
      commitSignaturePolicy: commitSignaturePolicy([signer]),
      commitSignaturesSha256: '0'.repeat(64),
    },
  );
  expectOnly(
    name,
    verifyTarget(context.root, declaredTarget(context.root, context.baseSha, head), authority),
    code,
  );
}

function tamperCommitGraph(root, commit, replacementParent) {
  git(root, ['commit-graph', 'write', '--reachable']);
  const path = join(root, '.git/objects/info/commit-graph');
  const bytes = readFileSync(path);
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'CGPH');
  assert.equal(bytes[4], 1);
  assert.equal(bytes[5], 1);
  const chunks = new Map();
  for (let index = 0; index <= bytes[6]; index += 1) {
    const offset = 8 + index * 12;
    chunks.set(
      bytes.subarray(offset, offset + 4).toString('ascii'),
      Number(bytes.readBigUInt64BE(offset + 4)),
    );
  }
  const oidRoot = chunks.get('OIDL');
  const commitRoot = chunks.get('CDAT');
  const count = (commitRoot - oidRoot) / 20;
  const position = (sha) => {
    const expected = Buffer.from(sha, 'hex');
    for (let index = 0; index < count; index += 1) {
      if (bytes.subarray(oidRoot + index * 20, oidRoot + (index + 1) * 20).equals(expected)) {
        return index;
      }
    }
    throw new Error(`${sha}: commit-graph OID missing`);
  };
  bytes.writeUInt32BE(position(replacementParent), commitRoot + position(commit) * 36 + 20);
  createHash('sha1')
    .update(bytes.subarray(0, -20))
    .digest()
    .copy(bytes, bytes.length - 20);
  writeFileSync(path, bytes);
}

const ownerRoot = mkdtempSync(join(tmpdir(), 'new-aria-repository-integrity-'));
const root = join(ownerRoot, 'repository');
try {
  mkdirSync(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'D0 Repository Test']);
  git(root, ['config', 'user.email', 'd0-repository@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  writeRuntimeFixture(root);
  for (const path of [
    `${plan}/baseline.md`,
    'docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md',
    'tools/quality/format-scope.json',
  ]) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), `${path}\n`);
  }
  const signer = createCommitSigner('repository-signer', 'repository-committer');
  const baseSha = writeSignedCommit(root, 'test: repository integrity base', signer);
  const manifest = targetManifest(root, baseSha);
  writeManifest(root, manifest);
  const signedMain = writeSignedCommit(root, 'test: signed main parent', signer);
  git(root, ['update-ref', 'refs/remotes/origin/main', baseSha]);
  git(root, ['update-ref', 'HEAD', baseSha]);
  git(root, ['commit', '--allow-empty', '-m', 'test: hidden unsigned commit']);
  const unsigned = git(root, ['rev-parse', 'HEAD']).trim();
  const signedSide = writeSignedCommit(root, 'test: signed child of hidden commit', signer);
  git(root, ['update-ref', 'HEAD', signedMain]);
  const merge = writeSignedCommit(root, 'test: signed merge target', signer, [signedSide]);
  git(root, ['update-ref', 'refs/remotes/origin/review', merge]);
  const context = { baseSha, manifest, ownerRoot, root };

  writeFileSync(join(root, '.git/shallow'), `${signedSide}\n`);
  verifyAttack(context, 'shallow', merge, signer, 'TARGET_SHALLOW');
  rmSync(join(root, '.git/shallow'));

  mkdirSync(join(root, '.git/info'), { recursive: true });
  writeFileSync(join(root, '.git/info/grafts'), `${signedSide} ${baseSha}\n`);
  verifyAttack(context, 'grafts', merge, signer, 'TARGET_GRAFTS');
  rmSync(join(root, '.git/info/grafts'));

  const linked = join(ownerRoot, 'linked');
  git(root, ['worktree', 'add', '--detach', linked, merge]);
  writeFileSync(join(root, '.git/info/grafts'), `${signedSide} ${baseSha}\n`);
  assert.equal(
    repositoryMetadataViolation(linked, createGitSession(observeGitTool())).code,
    'TARGET_GRAFTS',
    'linked worktree escaped common-directory metadata inspection',
  );
  rmSync(join(root, '.git/info/grafts'));

  git(root, ['config', 'extensions.partialClone', 'origin']);
  git(root, ['config', 'remote.origin.promisor', 'true']);
  verifyAttack(context, 'partial-clone', merge, signer, 'TARGET_OBJECT_STORE');
  git(root, ['config', '--unset', 'extensions.partialClone']);
  git(root, ['config', '--unset', 'remote.origin.promisor']);

  tamperCommitGraph(root, signedSide, baseSha);
  assert.equal(
    git(root, ['rev-list', `${baseSha}..${merge}`]).includes(unsigned),
    false,
    'tampered commit graph did not hide the unsigned commit',
  );
  verifyAttack(context, 'commit-graph', merge, signer, 'COMMIT_SIGNATURE');

  assert.match(unsigned, /^[a-f0-9]{40}$/u);
} finally {
  rmSync(ownerRoot, { recursive: true, force: true });
}

process.stdout.write(
  'PASS repository-integrity shallow=grafts=promisor=denied raw-commit-graph=verified\n',
);
