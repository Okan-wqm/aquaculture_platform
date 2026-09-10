#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, policy, withFixture } from './dossier-test-fixture.mjs';
import { signedEnvelope } from './dossier-crypto-test-fixture.mjs';
import { admitReviewDossier } from './lib/dossier-admission.mjs';
import { sha256 } from './lib/canonical.mjs';
import { loadReviewerAuthority } from './lib/review-authority.mjs';

function writeDossier(options, dossier, context, resign) {
  context.dossier_sha256 = digest(dossier);
  context.invalidation_facts.dossier = digest(dossier);
  writeFileSync(join(options.artifactRoot, options.dossierPath), `${JSON.stringify(dossier)}\n`);
  resign();
}

function authorityExpectation(dossier) {
  return {
    roles: policy.roles,
    reviewedTarget: dossier.reviewed_target,
    producer: {
      principal_id: dossier.producer.principal_id,
      session_id: dossier.producer.session_id,
    },
    admissionPrincipal: dossier.admission.operator_principal_id,
    maxFreshnessSeconds: policy.admission_context.max_freshness_seconds,
  };
}

withFixture(({ options, dossier }) => {
  const bundle = JSON.parse(readFileSync(options.reviewerAuthorityBundlePath, 'utf8'));
  bundle.valid_until = 'not-a-time';
  writeFileSync(options.reviewerAuthorityBundlePath, `${JSON.stringify(bundle)}\n`);
  options.reviewerAuthorityBundleSha256 = sha256(readFileSync(options.reviewerAuthorityBundlePath));
  assert.throws(
    () => loadReviewerAuthority(options, authorityExpectation(dossier)),
    /clock|stale/u,
    'non-finite reviewer authority expiry accepted',
  );
});

withFixture(({ options, dossier }) => {
  assert.throws(
    () =>
      loadReviewerAuthority(options, {
        ...authorityExpectation(dossier),
        maxFreshnessSeconds: Number.NaN,
      }),
    /clock|freshness/u,
    'non-finite reviewer authority freshness policy accepted',
  );
});

withFixture(({ options }) => {
  delete options.reviewerAuthorityBundleSha256;
  assert.throws(
    () => admitReviewDossier(options),
    /out-of-band|pin/u,
    'unpinned reviewer authority bundle accepted',
  );
});

for (const [name, mutate, pattern] of [
  [
    'reviewer/conflict principal alias',
    (bundle) => (bundle.conflict.principal_id = bundle.reviewers[0].principal_id),
    /alias/u,
  ],
  [
    'reviewer capability escalation',
    (bundle) => (bundle.reviewers[0].capabilities = ['appellate']),
    /capability/u,
  ],
  [
    'reviewer agent execution alias',
    (bundle) => (bundle.reviewers[1].agent_execution_id = bundle.reviewers[0].agent_execution_id),
    /agent execution|alias/u,
  ],
  [
    'cryptographic independence overclaim',
    (bundle) => (bundle.independence_assurance = 'CRYPTOGRAPHICALLY_PROVEN'),
    /identity|assurance/u,
  ],
]) {
  withFixture(({ options }) => {
    const bundle = JSON.parse(readFileSync(options.reviewerAuthorityBundlePath, 'utf8'));
    mutate(bundle);
    writeFileSync(options.reviewerAuthorityBundlePath, `${JSON.stringify(bundle)}\n`);
    options.reviewerAuthorityBundleSha256 = sha256(
      readFileSync(options.reviewerAuthorityBundlePath),
    );
    assert.throws(() => admitReviewDossier(options), pattern, `${name} accepted`);
  });
}

withFixture(({ options, dossier, context, resign }) => {
  const review = dossier.reviews[0];
  const path = join(options.artifactRoot, review.report_uri);
  const envelope = JSON.parse(readFileSync(path, 'utf8'));
  envelope.payload.verdict = 'REJECTED';
  const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8');
  writeFileSync(path, bytes);
  review.report_sha256 = sha256(bytes);
  context.report_artifacts[0].sha256 = review.report_sha256;
  context.invalidation_facts.reports = digest(context.report_artifacts);
  writeDossier(options, dossier, context, resign);
  assert.throws(
    () => admitReviewDossier(options),
    /signature/u,
    'tampered reviewer payload with coordinated admission rewrite accepted',
  );
});

withFixture(({ options, dossier, context, resign, authority }) => {
  const path = join(options.artifactRoot, dossier.oracle.envelope_uri);
  const envelope = JSON.parse(readFileSync(path, 'utf8'));
  envelope.payload.input_digest = '0'.repeat(64);
  const bytes = signedEnvelope(
    'new-aria-signed-review-oracle',
    envelope.payload,
    authority.oracleSigner,
  );
  writeFileSync(path, bytes);
  dossier.oracle.input_digest = envelope.payload.input_digest;
  dossier.oracle.envelope_sha256 = sha256(bytes);
  context.oracle_artifact.sha256 = dossier.oracle.envelope_sha256;
  context.invalidation_facts.oracle = digest(dossier.oracle);
  writeDossier(options, dossier, context, resign);
  assert.throws(
    () => admitReviewDossier(options),
    /deterministic oracle/u,
    'valid oracle signer bypassed deterministic input recomputation',
  );
});

withFixture(({ options, dossier }) => {
  const route = join(options.repositoryRoot, 'reviewer-authority-link');
  symlinkSync(options.reviewerAuthorityRoot, route, 'dir');
  assert.throws(
    () =>
      loadReviewerAuthority(
        {
          ...options,
          reviewerAuthorityRoot: route,
          reviewerAuthorityBundlePath: join(route, 'review-authority.json'),
        },
        authorityExpectation(dossier),
      ),
    /external authority|repository/u,
    'repository-internal reviewer authority symlink route accepted',
  );
});

process.stdout.write('PASS review-authority-controls=10\n');
