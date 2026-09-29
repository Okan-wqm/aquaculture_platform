import { createHash } from 'node:crypto';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { verifyEvidenceChain } from '../src/kernel/evidence-chain';
import { isJsonRecord, JsonRecord } from '../src/kernel/evidence-object';
import { parseStrictJson } from '../src/kernel/strict-json';

import { evidenceBundle } from './progress-fixture';
import { conflictReviewProof } from './review-proof-fixture';

type OracleManifest = ReturnType<typeof evidenceBundle>['manifest'];

function objectReference(
  objects: Map<string, Uint8Array>,
  bytes: Uint8Array,
): OracleManifest['report'] {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const reference = { uri: `aria-evidence://sha256/${sha256}`, sha256 };
  objects.set(reference.uri, Buffer.from(bytes));
  return reference;
}

function parseRecord(bytes: Uint8Array | undefined): JsonRecord {
  if (bytes === undefined) throw new Error('fixture object is missing');
  const value = parseStrictJson(bytes);
  if (!isJsonRecord(value)) throw new Error('fixture object is not a record');
  return value;
}

function fixture(): { manifest: OracleManifest; objects: Map<string, Uint8Array> } {
  const bundle = evidenceBundle('d'.repeat(64));
  return { manifest: bundle.manifest, objects: new Map(bundle.objects) };
}

function rewriteControlResult(
  value: ReturnType<typeof fixture>,
  index: number,
  mutate: (result: JsonRecord) => void,
): void {
  const declaration = value.manifest.oracle.negative_controls[index];
  if (declaration === undefined) throw new Error('fixture control is missing');
  const result = parseRecord(value.objects.get(declaration.result.uri));
  mutate(result);
  const resultReference = objectReference(value.objects, canonicalJsonBytes(result));
  declaration.result = resultReference;

  const report = parseRecord(value.objects.get(value.manifest.oracle.report.uri));
  if (!Array.isArray(report.negative_controls))
    throw new Error('fixture report controls are missing');
  const reportControl = report.negative_controls[index];
  if (!isJsonRecord(reportControl)) throw new Error('fixture report control is missing');
  reportControl.result_sha256 = resultReference.sha256;
  value.manifest.oracle.report = objectReference(value.objects, canonicalJsonBytes(report));
  const conflict = conflictReviewProof({
    authority_sha256: value.manifest.authority_sha256,
    target_head_sha: value.manifest.target.head_sha,
    oracle_report_sha256: value.manifest.oracle.report.sha256,
    negative_controls: value.manifest.oracle.negative_controls,
    reviewed_at: value.manifest.observed_at,
  });
  value.manifest.review.conflict_evidence = conflict.reference;
  value.objects.set(conflict.reference.uri, conflict.bytes);
}

function verify(value: ReturnType<typeof fixture>): void {
  const bytes = Buffer.from(`${canonicalJsonBytes(value.manifest).toString()}\n`);
  verifyEvidenceChain([bytes], value.objects);
}

function execution(result: JsonRecord): JsonRecord {
  if (!isJsonRecord(result.execution)) throw new Error('fixture execution is missing');
  return result.execution;
}

function rewriteConflictReview(
  value: ReturnType<typeof fixture>,
  mutate: (review: JsonRecord) => void,
): void {
  const current = value.manifest.review.conflict_evidence;
  const review = parseRecord(value.objects.get(current.uri));
  mutate(review);
  value.manifest.review.conflict_evidence = objectReference(
    value.objects,
    canonicalJsonBytes(review),
  );
}

describe('structured oracle evidence', () => {
  it('accepts a canonical report with distinct control mutants and results', () => {
    expect(() => verify(fixture())).not.toThrow();
  });

  it('rejects an arbitrary blob presented as a no-conflict review', () => {
    const value = fixture();
    value.manifest.review.conflict_evidence = objectReference(
      value.objects,
      canonicalJsonBytes({ verdict: 'NO_CONFLICT' }),
    );
    expect(() => verify(value)).toThrow(/conflict review/);
  });

  it.each([
    ['reviewer', (review: JsonRecord) => (review.reviewer_principal_id = 'producer-1')],
    ['target', (review: JsonRecord) => (review.target_head_sha = '9'.repeat(40))],
    ['oracle report', (review: JsonRecord) => (review.oracle_report_sha256 = '9'.repeat(64))],
    ['control set', (review: JsonRecord) => (review.negative_controls_sha256 = '9'.repeat(64))],
    ['timestamp', (review: JsonRecord) => (review.reviewed_at = '2026-09-02T11:59:00.000Z')],
    ['conflicts', (review: JsonRecord) => (review.conflicts = ['conflict-1'])],
  ])('rejects a re-digested no-conflict review with false %s binding', (_name, mutate) => {
    const value = fixture();
    rewriteConflictReview(value, mutate);
    expect(() => verify(value)).toThrow(/conflict review/);
  });

  it('rejects arbitrary JSON presented as an oracle report', () => {
    const value = fixture();
    value.manifest.oracle.report = objectReference(
      value.objects,
      canonicalJsonBytes({ verdict: 'PASSED' }),
    );
    expect(() => verify(value)).toThrow(/oracle report/);
  });

  it('rejects arbitrary JSON presented as a negative-control result', () => {
    const value = fixture();
    rewriteControlResult(value, 0, (result) => {
      for (const key of Object.keys(result)) Reflect.deleteProperty(result, key);
      result.verdict = 'REJECTED';
    });
    expect(() => verify(value)).toThrow(/control result/);
  });

  it('rejects one mutant and result reused for another control', () => {
    const value = fixture();
    const first = value.manifest.oracle.negative_controls[0];
    const second = value.manifest.oracle.negative_controls[1];
    if (first === undefined || second === undefined)
      throw new Error('fixture controls are missing');
    second.mutant = first.mutant;
    second.result = first.result;
    expect(() => verify(value)).toThrow(/control|mutant|reused/);
  });

  it('rejects a re-digested control result that ran unrelated argv', () => {
    const value = fixture();
    rewriteControlResult(value, 0, (result) => {
      if (!isJsonRecord(result.execution)) throw new Error('fixture execution is missing');
      result.execution.argv = ['node', 'unrelated.mjs'];
      result.execution.argv_sha256 = createHash('sha256')
        .update(canonicalJsonBytes(result.execution.argv))
        .digest('hex');
    });
    expect(() => verify(value)).toThrow(/argv/);
  });

  it('rejects a top-level artifact reused as negative-control stdout', () => {
    const value = fixture();
    const artifact = value.manifest.artifacts[0];
    if (artifact === undefined) throw new Error('fixture artifact is missing');
    rewriteControlResult(value, 0, (result) => {
      execution(result).stdout_sha256 = artifact.sha256;
    });
    expect(() => verify(value)).toThrow(/reused|typed rejection receipt/);
  });

  it.each([
    ['argv digest', (result: JsonRecord) => (execution(result).argv_sha256 = '9'.repeat(64))],
    ['input digest', (result: JsonRecord) => (execution(result).input_sha256 = '9'.repeat(64))],
    [
      'output digest',
      (result: JsonRecord) => {
        execution(result).output_sha256 = execution(result).stdout_sha256 ?? null;
      },
    ],
    ['tool digest', (result: JsonRecord) => (execution(result).tool_sha256 = '9'.repeat(64))],
    ['runtime digest', (result: JsonRecord) => (execution(result).runtime_sha256 = '9'.repeat(64))],
    [
      'working directory',
      (result: JsonRecord) => {
        execution(result).cwd = 'workspace://attacker/checkout';
        execution(result).cwd_sha256 = createHash('sha256')
          .update(Buffer.from('workspace://attacker/checkout'))
          .digest('hex');
      },
    ],
    [
      'timestamps',
      (result: JsonRecord) => {
        execution(result).finished_at = '2026-09-02T13:00:00.000Z';
      },
    ],
    ['stdout digest', (result: JsonRecord) => (execution(result).stdout_sha256 = '9'.repeat(64))],
    ['failure reason', (result: JsonRecord) => (execution(result).failure_reason_sha256 = null)],
  ])('rejects a re-digested result with a false %s binding', (_name, mutate) => {
    const value = fixture();
    rewriteControlResult(value, 0, mutate);
    expect(() => verify(value)).toThrow();
  });
});
