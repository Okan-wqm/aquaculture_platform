#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, withFixture } from './dossier-test-fixture.mjs';
import { admitReviewDossier } from './lib/dossier-admission.mjs';
import { sha256 } from './lib/canonical.mjs';
import { loadVerifiedPayload } from './lib/verify-signature.mjs';

withFixture(({ options }) => {
  const cli = spawnSync(
    process.execPath,
    [
      new URL('./admit-dossier.mjs', import.meta.url).pathname,
      '--repository-root',
      options.repositoryRoot,
      '--artifact-root',
      options.artifactRoot,
      '--dossier',
      options.dossierPath,
      '--context-envelope',
      options.contextEnvelopePath,
      '--trust-root',
      options.trustRootPath,
      '--authority-root',
      options.authorityRoot,
      '--trust-root-sha256',
      options.trustRootSha256,
      '--reviewer-authority-root',
      options.reviewerAuthorityRoot,
      '--reviewer-authority-bundle',
      options.reviewerAuthorityBundlePath,
      '--reviewer-authority-bundle-sha256',
      options.reviewerAuthorityBundleSha256,
      '--target-authority-root',
      options.targetAuthorityRoot,
      '--target-context-envelope',
      options.targetContextEnvelopePath,
      '--target-trust-root',
      options.targetTrustRootPath,
      '--target-trust-root-sha256',
      options.targetTrustRootSha256,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(cli.status, 0, cli.stderr);
  const result = JSON.parse(cli.stdout);
  assert.equal(result.accepted, true);
  assert.equal(result.review_count, 12);
  assert.match(result.reviewed_base_sha, /^[a-f0-9]{40}$/u);
  assert.equal(result.reviewer_principal_ids.length, 14);
  assert.equal(new Set(result.reviewer_principal_ids).size, 14);
});
withFixture(({ options }) => {
  assert.throws(
    () =>
      loadVerifiedPayload({
        repositoryRoot: join(options.repositoryRoot, 'docs'),
        authorityRoot: options.authorityRoot,
        envelopePath: options.contextEnvelopePath,
        trustRootPath: options.trustRootPath,
        trustRootSha256: options.trustRootSha256,
        expectedKind: 'new-aria-review-dossier-context',
        expectedCapability: 'review-dossier-admission',
      }),
    /top-level|repository root/u,
    'nested repository root weakened the external-authority boundary',
  );
});
withFixture(({ options, context, resign }) => {
  context.operator_principal_id = 'unbound-operator';
  resign();
  assert.throws(
    () => admitReviewDossier(options),
    /principal|signer/u,
    'context operator was not bound to the signing principal',
  );
});

for (const [name, capabilities] of [
  ['missing capability', []],
  ['duplicate capability', ['review-dossier-admission', 'review-dossier-admission']],
  ['structured capability', [{ name: 'review-dossier-admission' }]],
]) {
  withFixture(({ options }) => {
    const trustRoot = JSON.parse(readFileSync(options.trustRootPath, 'utf8'));
    trustRoot.capabilities = capabilities;
    writeFileSync(options.trustRootPath, `${JSON.stringify(trustRoot)}\n`);
    assert.throws(
      () =>
        admitReviewDossier({
          ...options,
          trustRootSha256: sha256(readFileSync(options.trustRootPath)),
        }),
      /capability|schema/u,
      `${name} accepted`,
    );
  });
}

withFixture(({ options, dossier, context }) => {
  dossier.oracle.input_digest = 'd'.repeat(64);
  writeFileSync(join(options.artifactRoot, options.dossierPath), `${JSON.stringify(dossier)}\n`);
  context.dossier_sha256 = digest(dossier);
  context.invalidation_facts.dossier = digest(dossier);
  context.invalidation_facts.oracle = digest(dossier.oracle);
  const envelope = JSON.parse(readFileSync(options.contextEnvelopePath, 'utf8'));
  envelope.payload = context;
  writeFileSync(options.contextEnvelopePath, `${JSON.stringify(envelope)}\n`);
  assert.throws(() => admitReviewDossier(options), /signature/u, 'coordinated forgery accepted');
});

withFixture(({ options, dossier, context, resign }) => {
  dossier.reviews[0].report_uri = '../outside.md';
  context.report_artifacts[0].report_uri = '../outside.md';
  context.dossier_sha256 = digest(dossier);
  context.invalidation_facts.dossier = digest(dossier);
  context.invalidation_facts.reports = digest(context.report_artifacts);
  writeFileSync(join(options.artifactRoot, options.dossierPath), `${JSON.stringify(dossier)}\n`);
  resign();
  assert.throws(() => admitReviewDossier(options), /artifact/u, 'report traversal accepted');
});

withFixture(({ options, dossier }) => {
  writeFileSync(join(options.artifactRoot, dossier.reviews[0].report_uri), 'tampered report\n');
  assert.throws(() => admitReviewDossier(options), /digest/u, 'changed report bytes accepted');
});

withFixture(({ options }) => {
  const envelope = JSON.parse(readFileSync(options.contextEnvelopePath, 'utf8'));
  delete envelope.signature_base64;
  writeFileSync(options.contextEnvelopePath, `${JSON.stringify(envelope)}\n`);
  assert.throws(
    () => admitReviewDossier(options),
    /signature|schema/u,
    'missing signature accepted',
  );
});

withFixture(({ options, dossier, context, resign }) => {
  dossier.freshness.observed_at = new Date(Date.now() - 120_000).toISOString();
  dossier.freshness.valid_until = new Date(Date.now() - 60_000).toISOString();
  context.observed_at = dossier.freshness.observed_at;
  context.valid_until = dossier.freshness.valid_until;
  context.dossier_sha256 = digest(dossier);
  context.invalidation_facts.dossier = digest(dossier);
  writeFileSync(join(options.artifactRoot, options.dossierPath), `${JSON.stringify(dossier)}\n`);
  resign();
  assert.throws(() => admitReviewDossier(options), /clock/u, 'expired signed context accepted');
});

withFixture(({ options }) => {
  const unpinned = { ...options };
  delete unpinned.trustRootSha256;
  assert.throws(() => admitReviewDossier(unpinned), /SHA-256|pin/u, 'unpinned trust root accepted');
});

withFixture(({ options }) => {
  assert.throws(
    () => admitReviewDossier({ ...options, trustRootSha256: '0'.repeat(64) }),
    /SHA-256|pin/u,
    'wrong trust-root pin accepted',
  );
});

withFixture(({ options }) => {
  const lexicalRoute = join(options.repositoryRoot, 'operator-authority');
  symlinkSync(options.authorityRoot, lexicalRoute, 'dir');
  assert.throws(
    () =>
      loadVerifiedPayload({
        repositoryRoot: options.repositoryRoot,
        authorityRoot: lexicalRoute,
        envelopePath: join(lexicalRoute, 'context.json'),
        trustRootPath: join(lexicalRoute, 'trust-root.json'),
        trustRootSha256: options.trustRootSha256,
        expectedKind: 'new-aria-review-dossier-context',
        expectedCapability: 'review-dossier-admission',
      }),
    /authority|repository|path/u,
    'repository-internal lexical symlink route accepted',
  );
});

withFixture(({ options }) => {
  const trustRoot = JSON.parse(readFileSync(options.trustRootPath, 'utf8'));
  trustRoot.principal_id = null;
  writeFileSync(options.trustRootPath, `${JSON.stringify(trustRoot)}\n`);
  assert.throws(
    () =>
      admitReviewDossier({
        ...options,
        trustRootSha256: sha256(readFileSync(options.trustRootPath)),
      }),
    /principal|identity|schema/u,
    'null signer principal accepted',
  );
});

withFixture(({ options }) => {
  const envelope = JSON.parse(readFileSync(options.contextEnvelopePath, 'utf8'));
  const trustRoot = JSON.parse(readFileSync(options.trustRootPath, 'utf8'));
  envelope.key_id = null;
  trustRoot.key_id = null;
  writeFileSync(options.contextEnvelopePath, `${JSON.stringify(envelope)}\n`);
  writeFileSync(options.trustRootPath, `${JSON.stringify(trustRoot)}\n`);
  assert.throws(
    () =>
      admitReviewDossier({
        ...options,
        trustRootSha256: sha256(readFileSync(options.trustRootPath)),
      }),
    /key|identity|schema/u,
    'null key ID accepted',
  );
});

withFixture(({ options, dossier, context, resign }) => {
  dossier.reviews.forEach((review, index) => {
    const bytes = Buffer.from(`not an independent review ${index}\n`, 'utf8');
    writeFileSync(join(options.artifactRoot, review.report_uri), bytes);
    review.report_sha256 = sha256(bytes);
    context.report_artifacts[index].sha256 = review.report_sha256;
  });
  dossier.oracle.input_digest = '0'.repeat(64);
  context.dossier_sha256 = digest(dossier);
  context.invalidation_facts.dossier = digest(dossier);
  context.invalidation_facts.reports = digest(context.report_artifacts);
  context.invalidation_facts.oracle = digest(dossier.oracle);
  writeFileSync(join(options.artifactRoot, options.dossierPath), `${JSON.stringify(dossier)}\n`);
  resign();
  assert.throws(
    () => admitReviewDossier(options),
    /reviewer|signature|oracle|authority/u,
    'single admission signer fabricated all reviewer reports and the deterministic oracle',
  );
});
process.stdout.write('PASS dossier-admission=17\n');
