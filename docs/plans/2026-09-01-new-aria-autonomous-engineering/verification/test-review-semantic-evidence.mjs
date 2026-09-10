#!/usr/bin/env node

import assert from 'node:assert/strict';
import { canonicalJson, sha256 } from './lib/canonical.mjs';
import { validateReviewEvidenceManifest } from './lib/review-evidence-manifest.mjs';
import { REVIEW_ROLE_POLICY } from './lib/review-evidence-policy.mjs';

const targetDigest = 'a'.repeat(64);
const authorityDigest = 'b'.repeat(64);
const expected = {
  role: 'integrity',
  principal_id: 'integrity-principal',
  session_id: 'integrity-session',
  agent_execution_id: 'agent-run-integrity-1',
  reviewed_target_sha256: targetDigest,
  reviewer_authority_bundle_sha256: authorityDigest,
};
const rolePolicy = REVIEW_ROLE_POLICY.integrity;
const negativeArtifactUri = 'evidence-output/target-authority-mutations.log';
assert.equal(rolePolicy.negative_control.artifact_uri, negativeArtifactUri);
const source = {
  path: rolePolicy.source_paths[0],
  blob_oid: 'c'.repeat(40),
  sha256: 'd'.repeat(64),
};
const negativeOutput = Buffer.from(`${rolePolicy.negative_control.output_marker}\n`, 'utf8');
const negativeArtifact = {
  artifact_uri: negativeArtifactUri,
  sha256: sha256(negativeOutput),
};
const baseline = {
  schema_version: '1.0.0',
  contract_id: 'new-aria-review-evidence-v1',
  review_id: 'd0-integrity-review-1',
  ...expected,
  independence_assurance: 'OPERATOR_ATTESTED',
  method: 'ADVERSARIAL_SOURCE_REVIEW',
  scope: [rolePolicy.scope],
  inspected_sources: [source],
  control_results: [
    {
      control_id: rolePolicy.control_id,
      result: 'PASS',
      evidence_refs: [source.path],
    },
  ],
  negative_controls: [
    {
      control_id: rolePolicy.negative_control.control_id,
      argv: rolePolicy.negative_control.argv,
      argv_sha256: sha256(Buffer.from(canonicalJson(rolePolicy.negative_control.argv), 'utf8')),
      exit_code: 0,
      result: 'MUTANTS_REJECTED',
      output_artifact: negativeArtifact,
      started_at: '2026-09-02T12:00:10.000Z',
      ended_at: '2026-09-02T12:00:50.000Z',
    },
  ],
  appellate_review_bundle: null,
  findings: [],
  started_at: '2026-09-02T12:00:00.000Z',
  ended_at: '2026-09-02T12:01:00.000Z',
  verdict: 'ACCEPTED',
  unresolved_load_bearing_findings: [],
};

function bytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
}

const context = {
  verifySource: () => {},
  readArtifact: (uri) => {
    assert.equal(uri, negativeArtifact.artifact_uri);
    return negativeOutput;
  },
  authorityWindow: {
    observed_at: '2026-09-02T11:59:00.000Z',
    valid_until: '2026-09-02T12:02:00.000Z',
  },
  dossierObservedAt: '2026-09-02T12:01:30.000Z',
  appellateReviewBundle: null,
  evidenceArtifactUri: 'evidence/integrity.json',
  reportUri: 'reports/integrity.json',
};

const validate = (value, bindings = expected, controls = context) =>
  validateReviewEvidenceManifest(value, bindings, controls);

assert.deepEqual(validate(bytes(baseline)), baseline);
assert.throws(
  () => validate(bytes(baseline), expected, { ...context, verifySource: undefined }),
  /source verifier/u,
  'evidence was accepted without an exact-head source verifier',
);
assert.throws(
  () =>
    validate(bytes(baseline), expected, {
      ...context,
      verifySource: () => {
        throw new Error('blob OID mismatch');
      },
    }),
  /blob OID/u,
  'fabricated committed source citation was accepted',
);

const cases = [
  ['opaque bytes', Buffer.from('looks convincing\n'), /strict JSON/u],
  ['empty bytes', Buffer.alloc(0), /strict JSON/u],
  ['wrong role binding', bytes({ ...baseline, role: 'identity' }), /semantic binding/u],
  ['missing required role control', bytes({ ...baseline, control_results: [] }), /control/u],
  [
    'wrong role source roster',
    bytes({
      ...baseline,
      inspected_sources: [{ ...source, path: 'D0-candidate.md' }],
      control_results: [{ ...baseline.control_results[0], evidence_refs: ['D0-candidate.md'] }],
    }),
    /role source policy/u,
  ],
  ['source-free review', bytes({ ...baseline, inspected_sources: [] }), /source/u],
  [
    'uncited control',
    bytes({
      ...baseline,
      control_results: [{ ...baseline.control_results[0], evidence_refs: ['missing.md'] }],
    }),
    /evidence reference/u,
  ],
  [
    'fabricated blob digest shape',
    bytes({ ...baseline, inspected_sources: [{ ...source, blob_oid: 'not-a-git-object' }] }),
    /source/u,
  ],
  [
    'unexecuted negative control',
    bytes({ ...baseline, negative_controls: [] }),
    /negative control/u,
  ],
  [
    'wrong negative-control argv',
    bytes({
      ...baseline,
      negative_controls: [
        {
          ...baseline.negative_controls[0],
          argv: ['node', 'untrusted.mjs'],
          argv_sha256: sha256(Buffer.from(canonicalJson(['node', 'untrusted.mjs']), 'utf8')),
        },
      ],
    }),
    /role negative-control policy/u,
  ],
  [
    'negative control outside review interval',
    bytes({
      ...baseline,
      negative_controls: [
        { ...baseline.negative_controls[0], started_at: '2026-09-02T11:59:59.000Z' },
      ],
    }),
    /temporal/u,
  ],
  [
    'review outside reviewer-authority window',
    bytes({ ...baseline, started_at: '2026-09-02T11:58:59.000Z' }),
    /authority window/u,
  ],
  [
    'non-appellate review bundle',
    bytes({ ...baseline, appellate_review_bundle: [] }),
    /appellate.*bundle/u,
  ],
  [
    'accepted unresolved finding',
    bytes({ ...baseline, unresolved_load_bearing_findings: ['D0-P0-999'] }),
    /accepted|unresolved/u,
  ],
  [
    'non-canonical bytes',
    Buffer.from(`${JSON.stringify(baseline, null, 2)}\n`, 'utf8'),
    /canonical/u,
  ],
];

for (const [name, value, pattern] of cases) {
  assert.throws(() => validate(value), pattern, `${name} evidence was accepted`);
}

assert.throws(
  () => validate(bytes(baseline), expected, { ...context, readArtifact: undefined }),
  /artifact reader/u,
  'hash-only negative evidence was accepted without reading its artifact',
);
assert.throws(
  () =>
    validate(bytes(baseline), expected, {
      ...context,
      readArtifact: () => Buffer.from('fabricated output\n', 'utf8'),
    }),
  /artifact digest|output marker/u,
  'negative-control output artifact bytes were not verified',
);
const selfReference = {
  ...baseline,
  negative_controls: [
    {
      ...baseline.negative_controls[0],
      output_artifact: {
        ...negativeArtifact,
        artifact_uri: context.evidenceArtifactUri,
      },
    },
  ],
};
assert.throws(
  () =>
    validate(bytes(selfReference), expected, {
      ...context,
      readArtifact: () => negativeOutput,
    }),
  /artifact self-reference/u,
  'negative-control output reused its enclosing evidence artifact',
);
const wrongArtifact = {
  ...baseline,
  negative_controls: [
    {
      ...baseline.negative_controls[0],
      output_artifact: { ...negativeArtifact, artifact_uri: 'evidence-output/reused.log' },
    },
  ],
};
assert.throws(
  () =>
    validate(bytes(wrongArtifact), expected, {
      ...context,
      readArtifact: () => negativeOutput,
    }),
  /role output artifact/u,
  'a role accepted a non-canonical negative-control artifact location',
);

assert.notEqual(sha256(bytes(baseline)), sha256(bytes({ ...baseline, review_id: 'different' })));
process.stdout.write(`PASS review-semantic-evidence mutants=${cases.length}\n`);
