#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, withFixture } from './dossier-test-fixture.mjs';
import { admitReviewDossier } from './lib/dossier-admission.mjs';
import { sha256 } from './lib/canonical.mjs';

function replaceSigner(options, context, resign, principalId) {
  const trustRoot = JSON.parse(readFileSync(options.trustRootPath, 'utf8'));
  trustRoot.principal_id = principalId;
  context.operator_principal_id = principalId;
  writeFileSync(options.trustRootPath, `${JSON.stringify(trustRoot)}\n`);
  options.trustRootSha256 = sha256(readFileSync(options.trustRootPath));
  resign();
}

for (const [label, selectPrincipal] of [
  ['producer', (dossier) => dossier.producer.principal_id],
  ['reviewer', (dossier) => dossier.reviews[0].principal_id],
]) {
  withFixture(({ options, dossier, context, resign }) => {
    replaceSigner(options, context, resign, selectPrincipal(dossier));
    assert.throws(
      () => admitReviewDossier(options),
      /independent|principal/u,
      `${label} principal was accepted as the dossier signer`,
    );
  });
}

for (const [label, selectArtifact, mutate] of [
  ['missing producer', (context) => context.producer_artifact, unlinkSync],
  [
    'tampered producer',
    (context) => context.producer_artifact,
    (path) => writeFileSync(path, 'tampered\n'),
  ],
  ['missing authority', (context) => context.authority_artifact, unlinkSync],
  [
    'tampered authority',
    (context) => context.authority_artifact,
    (path) => writeFileSync(path, 'tampered\n'),
  ],
]) {
  withFixture(({ options, context }) => {
    const artifact = selectArtifact(context);
    mutate(join(options.artifactRoot, artifact.artifact_uri));
    assert.throws(
      () => admitReviewDossier(options),
      /artifact|digest|ENOENT/u,
      `${label} artifact was accepted`,
    );
  });
}

withFixture(({ options, dossier, context, resign }) => {
  const nonexistentHead = 'f'.repeat(40);
  dossier.reviewed_target.head_sha = nonexistentHead;
  dossier.reviews.forEach((review) => (review.reviewed_head_sha = nonexistentHead));
  context.resolved_head_sha = nonexistentHead;
  context.invalidation_facts.head = nonexistentHead;
  context.dossier_sha256 = digest(dossier);
  context.invalidation_facts.dossier = digest(dossier);
  writeFileSync(join(options.artifactRoot, options.dossierPath), `${JSON.stringify(dossier)}\n`);
  resign();
  assert.throws(
    () => admitReviewDossier(options),
    /target|commit|HEAD|Git|repository/u,
    'nonexistent reviewed commit was accepted',
  );
});

withFixture(({ options }) => {
  writeFileSync(join(options.repositoryRoot, 'moved.txt'), 'new head\n');
  execFileSync('git', ['-C', options.repositoryRoot, 'add', 'moved.txt']);
  execFileSync('git', [
    '-C',
    options.repositoryRoot,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-q',
    '-m',
    'move head',
  ]);
  assert.throws(
    () => admitReviewDossier(options),
    /commit|HEAD|ref/u,
    'moved repository HEAD remained admitted',
  );
});

withFixture(({ options, context, resign }) => {
  context.reviewed_target.reviewed_ref = 'refs/heads/main';
  resign();
  assert.throws(
    () => admitReviewDossier(options),
    /target|ref|fact/u,
    'non-canonical reviewed ref was accepted',
  );
});

process.stdout.write('PASS dossier-resolution=9\n');
