#!/usr/bin/env node

import assert from 'node:assert/strict';
import { loadReviewPolicy } from './lib/verify-dossier.mjs';
import { verifyNonAdmissionPackages } from './lib/verify-review-evidence.mjs';
import { mutateJson, repositoryRoot, withPlanCopy } from './test-support.mjs';

function verify(copy) {
  return verifyNonAdmissionPackages(copy, repositoryRoot, loadReviewPolicy(copy));
}

withPlanCopy('new-aria-d0-review-valid-', (copy) => {
  assert.deepEqual(verify(copy), [], 'current non-admission packages rejected');
});

const cases = [
  ['unknown transform field', (value) => (value.review_provenance.view_transform.unknown = 'deny')],
  ['duplicate report role', (value) => (value.reports[1].role = value.reports[0].role)],
  ['duplicate report digest', (value) => (value.reports[1].sha256 = value.reports[0].sha256)],
  [
    'duplicate source digest',
    (value) => (value.reports[1].source_sha256 = value.reports[0].source_sha256),
  ],
  [
    'credential false-admission',
    (value) => (value.review_provenance.principal_credential_claimed = true),
  ],
  ['admission false-positive', (value) => (value.admission.accepted = true)],
  ['unknown manifest field', (value) => (value.unknown = 'deny')],
];

for (const [name, mutate] of cases) {
  withPlanCopy('new-aria-d0-review-mutant-', (copy) => {
    mutateJson(copy, 'progress/evidence/D0-review-c139f40f-changes-required.json', mutate);
    assert(verify(copy).length > 0, `${name}: non-admission mutant accepted`);
  });
}

process.stdout.write(`PASS review-evidence-controls=${cases.length}\n`);
