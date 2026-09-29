import { createHash } from 'node:crypto';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { manifestSha256, verifyEvidenceChain } from '../src/kernel/evidence-chain';
import { isJsonRecord, JsonRecord } from '../src/kernel/evidence-object';
import * as registryApi from '../src/kernel/negative-control-registry';
import { parseStrictJson } from '../src/kernel/strict-json';

import {
  negativeControlFixture,
  OracleBaselineInput,
  oracleBaselineInput,
} from './negative-control-fixture';
import { oracleProof } from './oracle-proof-fixture';
import { evidenceBundle } from './progress-fixture';
import { conflictReviewProof } from './review-proof-fixture';

type Fixture = ReturnType<typeof evidenceBundle>;

interface ObjectReference extends JsonRecord {
  readonly uri: string;
  readonly sha256: string;
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function store(objects: Map<string, Uint8Array>, bytes: Uint8Array): ObjectReference {
  const sha256 = digest(bytes);
  const reference = { uri: `aria-evidence://sha256/${sha256}`, sha256 };
  objects.set(reference.uri, Buffer.from(bytes));
  return reference;
}

function record(objects: ReadonlyMap<string, Uint8Array>, reference: ObjectReference): JsonRecord {
  const bytes = objects.get(reference.uri);
  if (bytes === undefined) throw new Error('fixture object is missing');
  const value = parseStrictJson(bytes);
  if (!isJsonRecord(value)) throw new Error('fixture object is not a record');
  return value;
}

function manifestBytes(value: Fixture['manifest']): Buffer {
  return Buffer.concat([canonicalJsonBytes(value), Buffer.from('\n')]);
}

function refreshConflict(value: Fixture): void {
  const proof = conflictReviewProof({
    authority_sha256: value.manifest.authority_sha256,
    target_head_sha: value.manifest.target.head_sha,
    oracle_report_sha256: value.manifest.oracle.report.sha256,
    negative_controls: value.manifest.oracle.negative_controls,
    reviewed_at: value.manifest.observed_at,
  });
  value.manifest.review.conflict_evidence = proof.reference;
  value.objects.set(proof.reference.uri, proof.bytes);
}

function replaceOracle(value: Fixture, baseline: OracleBaselineInput, observedAt: string): void {
  value.manifest.inputs = [store(value.objects, canonicalJsonBytes(baseline))];
  const proof = oracleProof(
    value.manifest.inputs,
    value.manifest.report,
    value.manifest.oracle.negative_controls.map(({ id }) => id),
    baseline,
    observedAt,
  );
  value.manifest.execution = proof.execution;
  value.manifest.oracle = proof.oracle;
  for (const [uri, bytes] of proof.objects) value.objects.set(uri, bytes);
  refreshConflict(value);
}

function rewriteControlExecution(
  value: Fixture,
  index: number,
  mutate: (execution: JsonRecord) => void,
): void {
  const declaration = value.manifest.oracle.negative_controls[index];
  if (declaration === undefined) throw new Error('fixture control is missing');
  const result = record(value.objects, declaration.result);
  if (!isJsonRecord(result.execution)) throw new Error('fixture execution is missing');
  mutate(result.execution);
  const resultReference = store(value.objects, canonicalJsonBytes(result));
  declaration.result = resultReference;
  const report = record(value.objects, value.manifest.oracle.report);
  const controls = report.negative_controls;
  if (!Array.isArray(controls) || !isJsonRecord(controls[index])) {
    throw new Error('fixture report control is missing');
  }
  controls[index].result_sha256 = resultReference.sha256;
  value.manifest.oracle.report = store(value.objects, canonicalJsonBytes(report));
  refreshConflict(value);
}

function replaceControlResultArtifacts(value: Fixture, index: number): void {
  rewriteControlExecution(value, index, (execution) => {
    execution.output_sha256 = store(value.objects, Buffer.from('attacker output')).sha256;
    execution.stdout_sha256 = store(value.objects, Buffer.from('attacker stdout')).sha256;
    execution.failure_reason_sha256 = store(value.objects, Buffer.from('attacker failure')).sha256;
  });
}

function advanceObservationWithReplayedControls(value: Fixture, firstBytes: Uint8Array): void {
  value.manifest.version = 2;
  value.manifest.previous_manifest_sha256 = manifestSha256(firstBytes);
  value.manifest.observation_id = 'observation-0002';
  value.manifest.observed_at = '2026-09-02T12:06:00.000Z';
  value.manifest.freshness = {
    ...value.manifest.freshness,
    observed_at: '2026-09-02T12:06:00.000Z',
    valid_until: '2026-09-02T13:06:00.000Z',
  };
  const baseline = oracleBaselineInput(value.manifest);
  replaceOracle(value, baseline, value.manifest.observed_at);
}

function replayControls(target: Fixture, source: Fixture): void {
  target.manifest.oracle.negative_controls = [...source.manifest.oracle.negative_controls];
  const sourceReport = record(source.objects, source.manifest.oracle.report);
  const targetReport = record(target.objects, target.manifest.oracle.report);
  const controls = sourceReport.negative_controls;
  if (!Array.isArray(controls)) throw new Error('source report controls are missing');
  targetReport.negative_controls = controls;
  target.manifest.oracle.report = store(target.objects, canonicalJsonBytes(targetReport));
  refreshConflict(target);
}

function verify(value: Fixture): void {
  verifyEvidenceChain([manifestBytes(value.manifest)], value.objects);
}

describe('oracle negative-control adversarial boundaries', () => {
  it('rejects a caller-authored nonzero result backed only by arbitrary blobs', () => {
    const value = evidenceBundle('d'.repeat(64));
    replaceControlResultArtifacts(value, 0);
    expect(() => verify(value)).toThrow(/rejection receipt|negative control/);
  });

  it('rejects a baseline execution context that diverges from its canonical input', () => {
    const value = evidenceBundle('d'.repeat(64));
    const attackerContext = '9'.repeat(64);
    value.manifest.execution.run_context_sha256 = attackerContext;
    const report = record(value.objects, value.manifest.oracle.report);
    if (!isJsonRecord(report.execution)) throw new Error('fixture baseline execution is missing');
    report.execution.run_context_sha256 = attackerContext;
    value.manifest.oracle.report = store(value.objects, canonicalJsonBytes(report));
    refreshConflict(value);

    expect(() => verify(value)).toThrow(/run context.*baseline/i);
  });

  it('rejects a generic nonzero process exit even with an otherwise valid receipt', () => {
    const value = evidenceBundle('d'.repeat(64));
    rewriteControlExecution(value, 0, (execution) => {
      execution.exit_code = 2;
    });
    expect(() => verify(value)).toThrow(/semantic rejection exit code/);
  });

  it('rejects a baseline whose event and freshness facts are unrelated to the manifest', () => {
    const value = evidenceBundle('d'.repeat(64));
    const baseline = oracleBaselineInput({
      ...value.manifest,
      observed_at: '2030-01-01T00:00:00.000Z',
      freshness: {
        ...value.manifest.freshness,
        observed_at: '2030-01-01T00:00:00.000Z',
        valid_until: '2030-01-02T00:00:00.000Z',
      },
    });
    replaceOracle(value, baseline, value.manifest.observed_at);
    expect(() => verify(value)).toThrow(/baseline.*manifest|run context/);
  });

  it('rejects negative-control material replayed into a later evidence observation', () => {
    const first = evidenceBundle('d'.repeat(64));
    const firstBytes = manifestBytes(first.manifest);
    const second = evidenceBundle('d'.repeat(64));
    advanceObservationWithReplayedControls(second, firstBytes);
    replayControls(second, first);
    for (const [uri, bytes] of second.objects) first.objects.set(uri, bytes);
    expect(() =>
      verifyEvidenceChain([firstBytes, manifestBytes(second.manifest)], first.objects),
    ).toThrow(/replay|run context|baseline/);
  });

  it.each([
    ['authority', (value: Fixture) => (value.manifest.authority_sha256 = '9'.repeat(64))],
    ['repository', (value: Fixture) => (value.manifest.target.repository_id = 'repo-2')],
    ['workspace', (value: Fixture) => (value.manifest.target.workspace_id = 'workspace-2')],
    ['base', (value: Fixture) => (value.manifest.target.base_sha = '9'.repeat(40))],
    ['head', (value: Fixture) => (value.manifest.target.head_sha = '9'.repeat(40))],
    ['evidence ID', (value: Fixture) => (value.manifest.evidence_id = 'other-evidence')],
    ['version', (value: Fixture) => (value.manifest.version = 2)],
    ['observation ID', (value: Fixture) => (value.manifest.observation_id = 'observation-0002')],
    [
      'times',
      (value: Fixture) => {
        value.manifest.observed_at = '2026-09-02T12:01:00.000Z';
        value.manifest.freshness.observed_at = '2026-09-02T12:01:00.000Z';
      },
    ],
  ])('rejects a baseline replay after %s context changes', (_name, mutate) => {
    const value = evidenceBundle('d'.repeat(64));
    mutate(value);
    expect(() => verify(value)).toThrow(/baseline input/);
  });

  it('does not expose a mutable negative-control registry entry', () => {
    expect(Object.prototype.hasOwnProperty.call(registryApi, 'registeredNegativeControl')).toBe(
      false,
    );
    const baseline = oracleBaselineInput(evidenceBundle('d'.repeat(64)).manifest);
    const controlId = 'NC-S01-EVENT-HASH-TAMPER';
    const mutationKind = 'EVENT-CONTEXT-PROBE-TAMPER';
    registryApi
      .canonicalRegisteredNegativeControl(0, controlId, mutationKind, baseline)
      .bytes.fill(0);
    const second = registryApi.canonicalRegisteredNegativeControl(
      0,
      controlId,
      mutationKind,
      baseline,
    ).bytes;
    expect(Buffer.from(second)).toEqual(
      Buffer.from(negativeControlFixture(controlId, 0, baseline).bytes),
    );
  });
});
