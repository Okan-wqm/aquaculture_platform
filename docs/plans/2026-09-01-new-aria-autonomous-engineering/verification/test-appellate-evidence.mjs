#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, sha256 } from './lib/canonical.mjs';
import { createGitSession } from './lib/hermetic-git.mjs';
import { observeGitTool } from './lib/hermetic-git.mjs';
import { verifySignedReviews } from './lib/review-evidence.mjs';
import { digest, withFixture } from './dossier-test-fixture.mjs';
import { signedEnvelope } from './dossier-crypto-test-fixture.mjs';

function appellateEvidence(options, dossier) {
  const index = dossier.reviews.length - 1;
  const reportPath = join(options.artifactRoot, dossier.reviews[index].report_uri);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const evidencePath = join(
    options.artifactRoot,
    report.payload.evidence_artifacts[0].artifact_uri,
  );
  return {
    index,
    report,
    reportPath,
    evidencePath,
    manifest: JSON.parse(readFileSync(evidencePath, 'utf8')),
  };
}

function verifyReviews(fixture) {
  const { authority, dossier, options } = fixture;
  return verifySignedReviews(dossier, authority.bundle, {
    artifactRoot: options.artifactRoot,
    repositoryRoot: options.repositoryRoot,
    reviewedHeadSha: dossier.reviewed_target.head_sha,
    gitSession: createGitSession(observeGitTool()),
    authorityDigest: authority.sha256,
    authorityWindow: {
      observed_at: authority.bundle.observed_at,
      valid_until: authority.bundle.valid_until,
    },
    dossierObservedAt: dossier.freshness.observed_at,
    targetDigest: digest(dossier.reviewed_target),
  });
}

function rewriteAppellate(fixture, mutate) {
  const { options, dossier, context, resign, authority } = fixture;
  const record = appellateEvidence(options, dossier);
  mutate(record.manifest, authority.bundle);
  const evidenceBytes = Buffer.from(`${canonicalJson(record.manifest)}\n`, 'utf8');
  writeFileSync(record.evidencePath, evidenceBytes);
  record.report.payload.evidence_artifacts[0].sha256 = sha256(evidenceBytes);
  const reportBytes = signedEnvelope(
    'new-aria-signed-review-report',
    record.report.payload,
    authority.reviewerSigners[record.index],
  );
  writeFileSync(record.reportPath, reportBytes);
  dossier.reviews[record.index].report_sha256 = sha256(reportBytes);
  context.report_artifacts[record.index].sha256 = sha256(reportBytes);
  context.dossier_sha256 = digest(dossier);
  context.invalidation_facts.dossier = digest(dossier);
  context.invalidation_facts.reports = digest(context.report_artifacts);
  writeFileSync(join(options.artifactRoot, options.dossierPath), `${JSON.stringify(dossier)}\n`);
  resign();
}

withFixture((fixture) => {
  const { options, dossier } = fixture;
  const manifest = appellateEvidence(options, dossier).manifest;
  assert.deepEqual(
    manifest.appellate_review_bundle.map(({ role }) => role),
    dossier.reviews.slice(0, -1).map(({ role }) => role),
    'appellate evidence does not carry the ordered preceding review bundle',
  );
  assert.equal(verifyReviews(fixture).reportPayloads.length, 12);
});

withFixture((fixture) => {
  rewriteAppellate(fixture, (manifest) => manifest.appellate_review_bundle.reverse());
  assert.throws(
    () => verifyReviews(fixture),
    /ordered review bundle/u,
    'a reordered appellate input bundle was accepted',
  );
});

withFixture((fixture) => {
  rewriteAppellate(fixture, (manifest, authority) => {
    const start = Date.parse(authority.observed_at) + 100;
    manifest.started_at = new Date(start).toISOString();
    manifest.negative_controls[0].started_at = new Date(start + 10).toISOString();
    manifest.negative_controls[0].ended_at = new Date(start + 20).toISOString();
    manifest.ended_at = new Date(start + 30).toISOString();
  });
  assert.throws(
    () => verifyReviews(fixture),
    /appellate.*after/u,
    'an appellate review completed before its ordered inputs was accepted',
  );
});

process.stdout.write('PASS appellate-evidence ordered-bundle=bound temporal=causal\n');
