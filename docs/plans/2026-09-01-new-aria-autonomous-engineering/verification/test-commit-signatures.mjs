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
const signatureExpression =
  /gpgsig -----BEGIN SSH SIGNATURE-----\n((?: [A-Za-z0-9+/=]+\n)+) -----END SSH SIGNATURE-----/u;

function signatureBlock(blob) {
  const encoded = blob.toString('base64').match(/.{1,70}/gu) ?? [];
  return `gpgsig -----BEGIN SSH SIGNATURE-----\n ${encoded.join(
    '\n ',
  )}\n -----END SSH SIGNATURE-----`;
}

function rewriteSignature(root, commit, mutate) {
  const raw = git(root, ['cat-file', 'commit', commit], true);
  const text = raw.toString('utf8');
  const match = signatureExpression.exec(text);
  assert(match, 'signed test commit has no SSH signature block');
  const blob = Buffer.from(match[1].replaceAll(' ', '').replaceAll('\n', ''), 'base64');
  const rewritten = Buffer.from(text.replace(signatureExpression, signatureBlock(mutate(blob))));
  const changed = git(root, ['hash-object', '-t', 'commit', '-w', '--stdin'], false, {
    input: rewritten,
  }).trim();
  git(root, ['update-ref', 'HEAD', changed, commit]);
  return changed;
}

function rewriteNoncanonicalArmor(root, commit) {
  const raw = git(root, ['cat-file', 'commit', commit], true);
  const text = raw.toString('utf8');
  const malformed = text.replace(/ ([A-Za-z0-9+/=]{69})([A-Za-z0-9+/=])\n/u, ' $1\n $2\n');
  assert.notEqual(malformed, text, 'test signature had no full armor line');
  const changed = git(root, ['hash-object', '-t', 'commit', '-w', '--stdin'], false, {
    input: Buffer.from(malformed),
  }).trim();
  git(root, ['update-ref', 'HEAD', changed, commit]);
  return changed;
}

function rewriteAsPgpArmor(root, commit) {
  const raw = git(root, ['cat-file', 'commit', commit], true).toString('utf8');
  const pgp = 'gpgsig -----BEGIN PGP SIGNATURE-----\n AAECAwQ=\n -----END PGP SIGNATURE-----';
  const rewritten = raw.replace(signatureExpression, pgp);
  assert.notEqual(rewritten, raw, 'test signature was not replaced');
  return git(root, ['hash-object', '-t', 'commit', '-w', '--stdin'], false, {
    input: Buffer.from(rewritten),
  }).trim();
}

function authorityResult(context, name, head, policy, signatureDigest) {
  git(context.root, ['update-ref', 'HEAD', head]);
  git(context.root, ['update-ref', 'refs/remotes/origin/review', head]);
  const authority = writeAuthority(
    context.root,
    join(context.ownerRoot, `operator-${name}`),
    context.manifest,
    () => {},
    { commitSignaturePolicy: policy, commitSignaturesSha256: signatureDigest },
  );
  return verifyTarget(context.root, declaredTarget(context.root, context.baseSha, head), authority);
}

function expectOnlySignatureError(name, result) {
  assert.deepEqual(
    [...new Set(result.errors.map(({ code }) => code))],
    ['COMMIT_SIGNATURE'],
    `${name}: ${JSON.stringify(result.errors)}`,
  );
}

const ownerRoot = mkdtempSync(join(tmpdir(), 'new-aria-commit-signatures-'));
const root = join(ownerRoot, 'repository');
try {
  mkdirSync(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'D0 Signature Test']);
  git(root, ['config', 'user.email', 'd0-signature@example.invalid']);
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
  const signer = createCommitSigner('signer-a', 'committer-a');
  const unused = createCommitSigner('signer-b', 'committer-b');
  const baseSha = writeSignedCommit(root, 'test: establish signature baseline', signer);
  const manifest = targetManifest(root, baseSha);
  writeManifest(root, manifest);
  const validHead = writeSignedCommit(root, 'test: signed target head', signer);
  git(root, ['update-ref', 'refs/remotes/origin/main', baseSha]);
  const context = { baseSha, manifest, ownerRoot, root };
  const validFacts = expectedCommitSignatureFacts(root, baseSha, validHead);
  const valid = authorityResult(
    context,
    'valid',
    validHead,
    commitSignaturePolicy([signer]),
    validFacts.digest,
  );
  assert.deepEqual(
    valid.errors,
    [],
    `valid signed commit rejected: ${JSON.stringify(valid.errors)}`,
  );

  const reusedAuthority = writeAuthority(
    root,
    join(ownerRoot, 'operator-reused-key'),
    manifest,
    () => {},
    {
      commitSignaturePolicy: commitSignaturePolicy([signer]),
      commitSignaturesSha256: validFacts.digest,
      operatorKeys: { privateKey: signer.privateKey, publicKey: signer.publicKey },
    },
  );
  const reused = verifyTarget(root, declaredTarget(root, baseSha, validHead), reusedAuthority);
  assert.deepEqual(
    reused.errors.map(({ code }) => code),
    ['TARGET_MANIFEST'],
    `operator/committer key reuse was accepted: ${JSON.stringify(reused.errors)}`,
  );
  assert.match(reused.errors[0].message, /operator key cannot authorize repository commits/u);

  const pgpArmored = rewriteAsPgpArmor(root, validHead);
  assert.throws(
    () => expectedCommitSignatureFacts(root, baseSha, pgpArmored),
    /commit SSH signature armor is invalid/u,
  );

  git(root, ['update-ref', 'HEAD', validHead]);
  git(root, ['commit', '--allow-empty', '-m', 'test: unsigned target head']);
  const unsigned = git(root, ['rev-parse', 'HEAD']).trim();
  expectOnlySignatureError(
    'unsigned',
    authorityResult(context, 'unsigned', unsigned, commitSignaturePolicy([signer]), '0'.repeat(64)),
  );

  git(root, ['update-ref', 'HEAD', validHead]);
  const signedForged = writeSignedCommit(root, 'test: forged signature', signer);
  const forged = rewriteSignature(root, signedForged, (blob) => {
    const changed = Buffer.from(blob);
    changed[changed.length - 1] ^= 1;
    return changed;
  });
  const forgedFacts = expectedCommitSignatureFacts(root, baseSha, forged);
  expectOnlySignatureError(
    'forged',
    authorityResult(context, 'forged', forged, commitSignaturePolicy([signer]), forgedFacts.digest),
  );

  expectOnlySignatureError(
    'wrong key',
    authorityResult(
      context,
      'wrong-key',
      validHead,
      commitSignaturePolicy([unused]),
      validFacts.digest,
    ),
  );

  git(root, ['update-ref', 'HEAD', validHead]);
  const signedTrailing = writeSignedCommit(root, 'test: trailing SSHSIG bytes', signer);
  const trailing = rewriteSignature(root, signedTrailing, (blob) =>
    Buffer.concat([blob, Buffer.from([0])]),
  );
  const trailingFacts = expectedCommitSignatureFacts(root, baseSha, trailing);
  expectOnlySignatureError(
    'trailing bytes',
    authorityResult(
      context,
      'trailing',
      trailing,
      commitSignaturePolicy([signer]),
      trailingFacts.digest,
    ),
  );

  git(root, ['update-ref', 'HEAD', validHead]);
  const signedMalformed = writeSignedCommit(root, 'test: malformed SSHSIG armor', signer);
  const malformed = rewriteNoncanonicalArmor(root, signedMalformed);
  const malformedFacts = expectedCommitSignatureFacts(root, baseSha, malformed);
  expectOnlySignatureError(
    'malformed armor',
    authorityResult(
      context,
      'malformed',
      malformed,
      commitSignaturePolicy([signer]),
      malformedFacts.digest,
    ),
  );

  expectOnlySignatureError(
    'declared but unused signer',
    authorityResult(
      context,
      'unused',
      validHead,
      commitSignaturePolicy([signer, unused]),
      validFacts.digest,
    ),
  );
} finally {
  rmSync(ownerRoot, { recursive: true, force: true });
}

process.stdout.write('PASS commit-signatures unsigned=denied forged=denied signer-set=exact\n');
