#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, policy, withFixture } from './dossier-test-fixture.mjs';
import { admitReviewDossier } from './lib/dossier-admission.mjs';
import { loadReviewerAuthority } from './lib/review-authority.mjs';
import { loadVerifiedPayload } from './lib/verify-signature.mjs';
import { parseStrictJsonBytes } from './lib/canonical.mjs';
import { parseReviewPolicy } from './lib/verify-dossier.mjs';

function rawSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

for (const invalid of [
  Buffer.from([0x80]),
  Buffer.from([0xc0, 0xaf]),
  Buffer.from([0xe2, 0x82]),
  Buffer.from([0xed, 0xa0, 0x80]),
  Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
  Buffer.from('\u00a0{}', 'utf8'),
]) {
  assert.throws(
    () => parseStrictJsonBytes(invalid, 'strict JSON vector'),
    /UTF-8|JSON|token/u,
    'non-canonical UTF-8 or whitespace vector was accepted',
  );
}

assert.throws(
  () => parseReviewPolicy(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0x80, 0x22, 0x7d])),
  /UTF-8/u,
  'malformed UTF-8 review-policy bytes were replacement-decoded',
);

withFixture(({ options }) => {
  const expectedEnvelope = readFileSync(options.contextEnvelopePath);
  const expectedTrustRoot = readFileSync(options.trustRootPath);
  const verified = loadVerifiedPayload({
    repositoryRoot: options.repositoryRoot,
    authorityRoot: options.authorityRoot,
    envelopePath: options.contextEnvelopePath,
    trustRootPath: options.trustRootPath,
    trustRootSha256: options.trustRootSha256,
    expectedKind: 'new-aria-review-dossier-context',
    expectedCapability: 'review-dossier-admission',
  });
  assert.ok(Buffer.isBuffer(verified.envelopeBytes), 'verified envelope bytes were not returned');
  assert.ok(
    Buffer.isBuffer(verified.trustRootBytes),
    'verified trust-root bytes were not returned',
  );
  assert.equal(verified.envelopeSha256, rawSha256(expectedEnvelope));
  assert.equal(verified.trustRootSha256, rawSha256(expectedTrustRoot));
  assert.deepEqual(verified.envelopeBytes, expectedEnvelope);
  assert.deepEqual(verified.trustRootBytes, expectedTrustRoot);
});

withFixture(({ options, dossier, context, resign }) => {
  dossier.admission.reason = '\uFFFD';
  context.dossier_sha256 = digest(dossier);
  context.invalidation_facts.dossier = digest(dossier);
  resign();
  const encoded = Buffer.from(`${JSON.stringify(dossier)}\n`, 'utf8');
  const replacement = Buffer.from('\uFFFD', 'utf8');
  const replacementIndex = encoded.indexOf(replacement);
  assert.notEqual(replacementIndex, -1, 'malformed UTF-8 fixture marker is missing');
  const malformed = Buffer.concat([
    encoded.subarray(0, replacementIndex),
    Buffer.from([0x80]),
    encoded.subarray(replacementIndex + replacement.length),
  ]);
  writeFileSync(join(options.artifactRoot, options.dossierPath), malformed);
  assert.throws(
    () => admitReviewDossier(options),
    /UTF-8/u,
    'malformed UTF-8 dossier bytes were admitted through replacement decoding',
  );
});

withFixture(({ ownerRoot, options, dossier, context }) => {
  const shimRoot = join(ownerRoot, 'path-shim');
  const sentinel = join(ownerRoot, 'ambient-git-ran');
  mkdirSync(shimRoot);
  writeFileSync(
    join(shimRoot, 'git'),
    `#!/bin/sh\n: > '${sentinel}'\nprintf '%s\\n' '${options.repositoryRoot}'\n`,
  );
  chmodSync(join(shimRoot, 'git'), 0o700);
  const originalPath = process.env.PATH;
  process.env.PATH = `${shimRoot}:${originalPath}`;
  try {
    loadVerifiedPayload({
      repositoryRoot: options.repositoryRoot,
      authorityRoot: options.authorityRoot,
      envelopePath: options.contextEnvelopePath,
      trustRootPath: options.trustRootPath,
      trustRootSha256: options.trustRootSha256,
      expectedKind: 'new-aria-review-dossier-context',
      expectedCapability: 'review-dossier-admission',
    });
    assert.equal(existsSync(sentinel), false, 'signature bootstrap executed ambient Git');
    loadReviewerAuthority(options, {
      roles: policy.roles,
      reviewedTarget: dossier.reviewed_target,
      producer: {
        principal_id: dossier.producer.principal_id,
        session_id: dossier.producer.session_id,
      },
      admissionPrincipal: context.operator_principal_id,
      maxFreshnessSeconds: policy.admission_context.max_freshness_seconds,
    });
    assert.equal(existsSync(sentinel), false, 'review bootstrap executed ambient Git');
  } finally {
    process.env.PATH = originalPath;
    if (existsSync(sentinel)) unlinkSync(sentinel);
  }
});

process.stdout.write('PASS external-json fatal-utf8=required snapshot=exact\n');
