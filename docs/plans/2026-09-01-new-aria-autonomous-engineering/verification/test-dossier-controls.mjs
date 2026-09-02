#!/usr/bin/env node

import assert from 'node:assert/strict';
import { sha256 } from './lib/canonical.mjs';
import { loadReviewPolicy, validateAdmissionDossier } from './lib/verify-dossier.mjs';
import { planRoot } from './test-support.mjs';

const policy = loadReviewPolicy(planRoot);
const headSha = 'a'.repeat(40);
const authorityDigest = 'b'.repeat(64);

function report(role, index) {
  return {
    role,
    principal_id: `principal-${index}`,
    session_id: `session-${index}`,
    report_uri: `reviews/admission/${index}-${role}.json`,
    report_sha256: sha256(Buffer.from(`report-${index}`, 'utf8')),
    capabilities: [role],
    reviewed_head_sha: headSha,
    authority_bundle_sha256: authorityDigest,
  };
}

function validDossier() {
  const reviews = policy.roles.map(report);
  const appellate = reviews.at(-1);
  return {
    schema_version: '1.0.0',
    contract_id: policy.contract_id,
    reviewed_target: { head_sha: headSha, authority_bundle_sha256: authorityDigest },
    producer: {
      principal_id: 'producer-principal',
      session_id: 'producer-session',
      artifact_uri: 'artifacts/program-bundle.json',
    },
    reviews,
    conflict_graph: { result: 'NO_CONFLICTS', evaluated_pairs: 78 },
    oracle: { id: 'd0-admission-oracle-v1', result: 'PASS', input_digest: 'c'.repeat(64) },
    dissent: { disposition: 'RESOLVED', unresolved: 0 },
    appellate: {
      role: 'appellate',
      principal_id: appellate.principal_id,
      report_uri: appellate.report_uri,
      verdict: 'ACCEPTED',
    },
    unresolved_load_bearing_findings: [],
    freshness: {
      current: true,
      observed_at: '2026-09-01T22:00:00Z',
      valid_until: '2026-09-01T22:05:00Z',
      invalidation_keys: ['head', 'authority', 'review-policy'],
    },
    admission: { accepted: true, reason: 'Exact independent dossier accepted.' },
  };
}

assert.deepEqual(validateAdmissionDossier(validDossier(), policy), [], 'valid dossier rejected');

const cases = [
  ['duplicate role', (value) => (value.reviews[1].role = value.reviews[0].role)],
  [
    'duplicate principal',
    (value) => (value.reviews[1].principal_id = value.reviews[0].principal_id),
  ],
  ['duplicate session', (value) => (value.reviews[1].session_id = value.reviews[0].session_id)],
  ['duplicate report', (value) => (value.reviews[1].report_uri = value.reviews[0].report_uri)],
  [
    'duplicate report digest',
    (value) => (value.reviews[1].report_sha256 = value.reviews[0].report_sha256),
  ],
  ['stale target', (value) => (value.reviews[0].reviewed_head_sha = 'd'.repeat(40))],
  ['wrong authority', (value) => (value.reviews[0].authority_bundle_sha256 = 'd'.repeat(64))],
  ['missing reviewed target', (value) => delete value.reviewed_target],
  ['missing conflict graph', (value) => delete value.conflict_graph],
  ['wrong conflict graph count', (value) => (value.conflict_graph.evaluated_pairs = 77)],
  ['missing oracle', (value) => delete value.oracle],
  ['missing dissent', (value) => delete value.dissent],
  ['missing appellate', (value) => delete value.appellate],
  ['appellate report mismatch', (value) => (value.appellate.report_uri = 'reviews/wrong.json')],
  ['unresolved finding', (value) => value.unresolved_load_bearing_findings.push('D-P1-999')],
  [
    'producer as reviewer',
    (value) => (value.reviews[0].principal_id = value.producer.principal_id),
  ],
  [
    'producer session as reviewer',
    (value) => (value.reviews[0].session_id = value.producer.session_id),
  ],
  ['capability mismatch', (value) => (value.reviews[0].capabilities = ['appellate'])],
  ['stale freshness', (value) => (value.freshness.current = false)],
  ['expired freshness interval', (value) => (value.freshness.valid_until = '2026-09-01T21:00:00Z')],
  ['missing freshness invalidator', (value) => (value.freshness.invalidation_keys = [])],
  ['non-accepted admission', (value) => (value.admission.accepted = false)],
  ['unknown dossier field', (value) => (value.unknown = 'deny')],
  ['unknown review field', (value) => (value.reviews[0].unknown = 'deny')],
  ['unknown nested field', (value) => (value.oracle.unknown = 'deny')],
];

for (const [name, mutate] of cases) {
  const dossier = validDossier();
  mutate(dossier);
  const errors = validateAdmissionDossier(dossier, policy);
  assert(errors.length > 0, `${name}: admission dossier mutant accepted`);
}

process.stdout.write(`PASS dossier-controls=${cases.length}\n`);
