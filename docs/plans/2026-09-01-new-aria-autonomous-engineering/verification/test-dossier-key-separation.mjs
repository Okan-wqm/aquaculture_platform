#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { signedEnvelope } from './dossier-crypto-test-fixture.mjs';
import { withFixture } from './dossier-test-fixture.mjs';
import { admitReviewDossier } from './lib/dossier-admission.mjs';
import { sha256 } from './lib/canonical.mjs';

const exactDigest = /^[a-f0-9]{64}$/u;

withFixture(({ options }) => {
  const result = admitReviewDossier(options);
  assert.deepEqual(Object.keys(result).sort(), [
    'accepted',
    'admission_principal_id',
    'admission_public_key_sha256',
    'dossier_sha256',
    'producer_principal_id',
    'review_admission_sha256',
    'review_count',
    'reviewed_base_sha',
    'reviewed_head_sha',
    'reviewer_authority_bundle_sha256',
    'reviewer_principal_ids',
    'reviewer_public_key_sha256s',
    'target_operator_principal_id',
    'target_operator_public_key_sha256',
  ]);
  assert.equal(result.accepted, true);
  assert.match(result.admission_public_key_sha256, exactDigest);
  assert.match(result.target_operator_public_key_sha256, exactDigest);
  assert.equal(result.reviewer_public_key_sha256s.length, 14);
  assert.equal(
    result.reviewer_public_key_sha256s.every((value) => exactDigest.test(value)),
    true,
  );
  const verifiedKeys = [
    result.admission_public_key_sha256,
    result.target_operator_public_key_sha256,
    ...result.reviewer_public_key_sha256s,
  ];
  assert.equal(new Set(verifiedKeys).size, 16, 'verified dossier key roster contains an alias');
});

withFixture(({ options, context, authority }) => {
  const reviewer = authority.reviewerSigners[0];
  const keyId = 'aliased-admission-key';
  const envelopeSigner = { privateKey: reviewer.privateKey, credential: { key_id: keyId } };
  const trustRoot = JSON.parse(readFileSync(options.trustRootPath, 'utf8'));
  trustRoot.key_id = keyId;
  trustRoot.public_key_spki_base64 = reviewer.credential.public_key_spki_base64;
  writeFileSync(
    options.contextEnvelopePath,
    signedEnvelope('new-aria-review-dossier-context', context, envelopeSigner),
  );
  writeFileSync(options.trustRootPath, `${JSON.stringify(trustRoot)}\n`);
  assert.throws(
    () =>
      admitReviewDossier({
        ...options,
        trustRootSha256: sha256(readFileSync(options.trustRootPath)),
      }),
    /public key alias/u,
    'one Ed25519 key was accepted for admission and reviewer roles',
  );
});

process.stdout.write('PASS dossier-key-separation fingerprints=16 alias-mutants=1\n');
