import { createHash } from 'node:crypto';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { manifestSha256, verifyEvidenceChain } from '../src/kernel/evidence-chain';

import {
  chainBaseline,
  chainClaim,
  chainFreshness,
  chainInputBytes,
  chainInputReference,
  chainObservationTime,
  chainTarget,
} from './evidence-chain-context-fixture';
import { MutableFixture } from './mutable-fixture';
import { oracleProof } from './oracle-proof-fixture';
import type { evidenceBundle } from './progress-fixture';
import { conflictReviewProof } from './review-proof-fixture';

type Manifest = Omit<
  MutableFixture<ReturnType<typeof evidenceBundle>['manifest']>,
  'previous_manifest_sha256'
> & { previous_manifest_sha256: string | null };
type ChainMutation = (values: Manifest[]) => void;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const reference = (bytes: Uint8Array): Manifest['report'] => {
  const digest = sha256(bytes);
  return { uri: `aria-evidence://sha256/${digest}`, sha256: digest };
};
const artifactBytes = Buffer.from('artifact bytes\n');
const reportBytes = Buffer.from('report bytes\n');
const artifactReference = reference(artifactBytes);
const reportReference = reference(reportBytes);

const negativeControlIds = [
  'NC-S01-EVENT-HASH-TAMPER',
  'NC-S01-EVIDENCE-DIGEST-TAMPER',
  'NC-S01-STALE-EVIDENCE',
  'NC-S01-UNAUTHORIZED-TARGET',
];

function manifest(version = 1, previous: string | null = null): Manifest {
  const inputs = [chainInputReference(version, reportReference, artifactReference)];
  const report = reportReference;
  const observedAt = chainObservationTime(version);
  const baseline = chainBaseline(version, reportReference, artifactReference);
  const proof = oracleProof(inputs, report, negativeControlIds, baseline, observedAt);
  const conflict = conflictReviewProof({
    authority_sha256: 'd'.repeat(64),
    target_head_sha: 'b'.repeat(40),
    oracle_report_sha256: proof.oracle.report.sha256,
    negative_controls: proof.oracle.negative_controls,
    reviewed_at: observedAt,
  });
  return {
    schema_version: '1.0.0',
    contract_id: 'aria-evidence-manifest-v1',
    evidence_id: 'S01-code-proof',
    version,
    previous_manifest_sha256: previous,
    observed_at: observedAt,
    observation_id: `observation-${version.toString().padStart(4, '0')}`,
    authority_sha256: 'd'.repeat(64),
    claim: chainClaim(),
    freshness: chainFreshness(version),
    identities: {
      producer_principal_id: 'producer-1',
      reviewer_principal_id: 'reviewer-1',
      oracle_principal_id: 'oracle-1',
      appellate_principal_id: 'appellate-1',
    },
    target: chainTarget(),
    execution: proof.execution,
    inputs,
    artifacts: [artifactReference],
    report,
    oracle: proof.oracle,
    review: {
      conflict_verdict: 'NO_CONFLICT',
      conflict_evidence: conflict.reference,
    },
    admission_reason: 'ALL_REQUIRED_CONTROLS_PASSED',
    verdict: 'ACCEPTED',
    unresolved_findings: [],
  };
}

const bytes = (value: ReturnType<typeof manifest>): Buffer =>
  Buffer.from(`${canonicalJsonBytes(value).toString()}\n`);

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`fixture value ${index.toString()} is missing`);
  return value;
}

const objects = (): Map<string, Uint8Array> => {
  const result = new Map<string, Uint8Array>([
    [artifactReference.uri, artifactBytes],
    [reportReference.uri, reportBytes],
  ]);
  for (const version of [1, 2]) {
    const observedAt = chainObservationTime(version);
    const input = chainInputReference(version, reportReference, artifactReference);
    result.set(input.uri, chainInputBytes(version, reportReference, artifactReference));
    const proof = oracleProof(
      [input],
      reportReference,
      negativeControlIds,
      chainBaseline(version, reportReference, artifactReference),
      observedAt,
    );
    for (const [uri, object] of proof.objects) result.set(uri, object);
    const conflict = conflictReviewProof({
      authority_sha256: 'd'.repeat(64),
      target_head_sha: 'b'.repeat(40),
      oracle_report_sha256: proof.oracle.report.sha256,
      negative_controls: proof.oracle.negative_controls,
      reviewed_at: observedAt,
    });
    result.set(conflict.reference.uri, conflict.bytes);
  }
  return result;
};

const chainMutations: readonly [name: string, mutate: ChainMutation][] = [
  ['non-null genesis', (values) => (at(values, 0).previous_manifest_sha256 = 'd'.repeat(64))],
  ['version gap', (values) => (at(values, 1).version = 3)],
  ['wrong predecessor', (values) => (at(values, 1).previous_manifest_sha256 = 'd'.repeat(64))],
  ['evidence ID fork', (values) => (at(values, 1).evidence_id = 'other')],
  [
    'identity alias',
    (values) => {
      const first = at(values, 0);
      first.identities.reviewer_principal_id = first.identities.producer_principal_id;
    },
  ],
  ['target drift', (values) => (at(values, 1).target.head_sha = 'd'.repeat(40))],
  [
    'claim drift',
    (values) => {
      const claim = at(values, 1).claim;
      claim.finding_ids = [...claim.finding_ids, 'ARIA-AUDIT-067'];
    },
  ],
  [
    'observation ID reuse',
    (values) => {
      at(values, 1).observation_id = at(values, 0).observation_id;
    },
  ],
  [
    'observation time reversal',
    (values) => {
      const second = at(values, 1);
      second.observed_at = '2026-09-02T11:00:00.000Z';
      second.freshness.observed_at = '2026-09-02T11:00:00.000Z';
    },
  ],
  [
    'freshness unknown field',
    (values) => Object.assign(at(values, 0).freshness, { current: true }),
  ],
  [
    'argv digest drift',
    (values) => {
      const execution = at(values, 0).execution;
      execution.argv = [...execution.argv, '--unsafe'];
    },
  ],
  ['transport-only success', (values) => (at(values, 0).execution.semantic_verdict = 'FAILED')],
  [
    'oracle self-alias',
    (values) => {
      const first = at(values, 0);
      first.identities.oracle_principal_id = first.identities.producer_principal_id;
    },
  ],
  ['missing negative control', (values) => (at(values, 0).oracle.negative_controls = [])],
  [
    'false negative-control verdict',
    (values) => {
      const controls = at(values, 0).oracle.negative_controls;
      at(controls, 0).expected_verdict = 'PASSED';
    },
  ],
  [
    'oracle implementation drift',
    (values) => (at(values, 0).oracle.implementation_sha256 = 'f'.repeat(64)),
  ],
  ['unresolved conflict', (values) => (at(values, 0).review.conflict_verdict = 'CONFLICT')],
  ['unresolved accepted finding', (values) => (at(values, 0).unresolved_findings = ['P0-1'])],
  ['unknown field', (values) => Object.assign(at(values, 0), { unknown: true })],
  [
    'Bidi principal ID',
    (values) => (at(values, 0).identities.producer_principal_id = 'producer-\u202e1'),
  ],
  ['control observation ID', (values) => (at(values, 0).observation_id = 'observation-\u00001')],
];

describe('evidence manifest chain', () => {
  it('accepts immutable, versioned, content-addressed evidence', () => {
    const first = bytes(manifest());
    const second = bytes(manifest(2, manifestSha256(first)));
    const verified = verifyEvidenceChain([first, second], objects());
    expect(verified).toHaveLength(2);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(at(verified, 0))).toBe(true);
    expect(Object.isFrozen(at(verified, 0).claim.finding_ids)).toBe(true);
    expect(Reflect.set(at(verified, 0).claim, 'state', 'READY')).toBe(false);
  });

  it('rejects one object reused as input, artifact, report, and review proof', () => {
    const value = manifest();
    const input = chainInputReference(1, reportReference, artifactReference);
    value.artifacts = [input];
    value.report = input;
    expect(() => verifyEvidenceChain([bytes(value)], objects())).toThrow(/reused/);
  });

  it.each(chainMutations)('rejects %s', (_name, mutate) => {
    const values = [manifest(), manifest(2)];
    at(values, 1).previous_manifest_sha256 = manifestSha256(bytes(at(values, 0)));
    mutate(values);
    expect(() => verifyEvidenceChain(values.map(bytes), objects())).toThrow();
  });

  it('rejects unavailable or changed content-addressed bytes', () => {
    expect(() => verifyEvidenceChain([bytes(manifest())], new Map())).toThrow(/unavailable/);
    const input = chainInputReference(1, reportReference, artifactReference);
    const changed = objects();
    changed.set(input.uri, Buffer.from('changed'));
    expect(() => verifyEvidenceChain([bytes(manifest())], changed)).toThrow(/digest/);
  });

  it('rejects duplicate version content and non-canonical manifest bytes', () => {
    const first = bytes(manifest());
    const nonCanonical = Buffer.concat([Buffer.from(' '), bytes(manifest())]);
    expect(() => verifyEvidenceChain([first, first], objects())).toThrow(/version|predecessor/);
    expect(() => verifyEvidenceChain([nonCanonical], objects())).toThrow(/canonical/);
  });
});
