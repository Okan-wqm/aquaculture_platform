#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createFixture } from './dossier-test-fixture.mjs';
import { loadReviewPolicy, validateDossierStructure } from './lib/verify-dossier.mjs';
import { planRoot } from './test-support.mjs';

const policy = loadReviewPolicy(planRoot);
const fixture = createFixture();
const baseline = structuredClone(fixture.dossier);
fixture.cleanup();

function validDossier() {
  return structuredClone(baseline);
}

const acceptedDossier = validDossier();
assert.deepEqual(
  validateDossierStructure(acceptedDossier, policy),
  [],
  'valid dossier structure rejected',
);

const cases = [
  ['duplicate role', (value) => (value.reviews[1].role = value.reviews[0].role)],
  [
    'duplicate principal',
    (value) => (value.reviews[1].principal_id = value.reviews[0].principal_id),
  ],
  ['duplicate session', (value) => (value.reviews[1].session_id = value.reviews[0].session_id)],
  [
    'duplicate agent execution',
    (value) => (value.reviews[1].agent_execution_id = value.reviews[0].agent_execution_id),
  ],
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
  ['object review principal', (value) => (value.reviews[0].principal_id = { id: 'principal-0' })],
  ['empty review principal', (value) => (value.reviews[0].principal_id = '')],
  ['object review session', (value) => (value.reviews[0].session_id = { id: 'session-0' })],
  ['empty review session', (value) => (value.reviews[0].session_id = '')],
  ['object review report URI', (value) => (value.reviews[0].report_uri = { path: 'report' })],
  ['empty review report URI', (value) => (value.reviews[0].report_uri = '')],
  ['object producer principal', (value) => (value.producer.principal_id = { id: 'producer' })],
  ['empty producer principal', (value) => (value.producer.principal_id = '')],
  ['object producer session', (value) => (value.producer.session_id = { id: 'producer' })],
  ['empty producer session', (value) => (value.producer.session_id = '')],
  ['object producer artifact URI', (value) => (value.producer.artifact_uri = { path: 'bundle' })],
  ['empty producer artifact URI', (value) => (value.producer.artifact_uri = '')],
  [
    'shared object appellate principal',
    (value) => {
      const identity = { id: 'appellate' };
      value.reviews.at(-1).principal_id = identity;
      value.appellate.principal_id = identity;
    },
  ],
  [
    'shared object appellate report URI',
    (value) => {
      const uri = { path: 'appellate-report' };
      value.reviews.at(-1).report_uri = uri;
      value.appellate.report_uri = uri;
    },
  ],
];

for (const [name, mutate] of cases) {
  const dossier = validDossier();
  mutate(dossier);
  const errors = validateDossierStructure(dossier, policy);
  assert(errors.length > 0, `${name}: malformed dossier structure accepted`);
}

process.stdout.write(`PASS dossier-controls=${cases.length}\n`);
