import { createHash } from 'node:crypto';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { verifyEvidenceChain } from '../src/kernel/evidence-chain';
import { isJsonRecord, JsonRecord } from '../src/kernel/evidence-object';
import { parseStrictJson } from '../src/kernel/strict-json';

import { oracleBaselineInput } from './negative-control-fixture';
import { oracleProof } from './oracle-proof-fixture';
import { evidenceBundle } from './progress-fixture';
import { conflictReviewProof } from './review-proof-fixture';

type Fixture = ReturnType<typeof evidenceBundle>;

interface ObjectReference extends JsonRecord {
  readonly uri: string;
  readonly sha256: string;
}

interface ControlRewrite {
  readonly mutatedInput?: Uint8Array;
  readonly mutationKind?: string;
}

const registeredIds = [
  'NC-S01-EVENT-HASH-TAMPER',
  'NC-S01-EVIDENCE-DIGEST-TAMPER',
  'NC-S01-STALE-EVIDENCE',
  'NC-S01-UNAUTHORIZED-TARGET',
];

function fixture(): Fixture {
  const bundle = evidenceBundle('d'.repeat(64));
  return { manifest: bundle.manifest, objects: new Map(bundle.objects) };
}

function store(objects: Map<string, Uint8Array>, bytes: Uint8Array): ObjectReference {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
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

function arrayRecord(value: JsonRecord, key: string, index: number): JsonRecord {
  const values = value[key];
  if (!Array.isArray(values) || !isJsonRecord(values[index])) {
    throw new Error(`fixture ${key} entry is missing`);
  }
  return values[index];
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

function storeReport(value: Fixture, report: JsonRecord): void {
  value.manifest.oracle.report = store(value.objects, canonicalJsonBytes(report));
  refreshConflict(value);
}

function rewriteControl(value: Fixture, index: number, rewrite: ControlRewrite): void {
  const declaration = value.manifest.oracle.negative_controls[index];
  if (declaration === undefined) throw new Error('fixture control is missing');
  const mutant = record(value.objects, declaration.mutant);
  const result = record(value.objects, declaration.result);
  const report = record(value.objects, value.manifest.oracle.report);
  const reportControl = arrayRecord(report, 'negative_controls', index);
  const currentInput = mutant.mutated_input;
  if (!isJsonRecord(currentInput) || typeof currentInput.sha256 !== 'string') {
    throw new Error('fixture mutant input reference is missing');
  }
  const input =
    rewrite.mutatedInput === undefined ? currentInput : store(value.objects, rewrite.mutatedInput);
  const inputSha256 = input.sha256;
  if (typeof inputSha256 !== 'string') throw new Error('fixture input digest is missing');
  const kind = rewrite.mutationKind ?? declaration.mutation_kind;
  mutant.mutated_input = input;
  mutant.mutation_kind = kind;
  const mutantReference = store(value.objects, canonicalJsonBytes(mutant));
  const resultExecution = result.execution;
  if (!isJsonRecord(resultExecution)) throw new Error('fixture result execution is missing');
  result.mutation_kind = kind;
  result.mutant_document_sha256 = mutantReference.sha256;
  result.mutated_input_sha256 = inputSha256;
  resultExecution.input_sha256 = inputSha256;
  const resultReference = store(value.objects, canonicalJsonBytes(result));
  declaration.mutation_kind = kind;
  declaration.mutant = mutantReference;
  declaration.result = resultReference;
  reportControl.mutation_kind = kind;
  reportControl.mutant_sha256 = mutantReference.sha256;
  reportControl.result_sha256 = resultReference.sha256;
  storeReport(value, report);
}

function replaceOracle(
  value: Fixture,
  ids: readonly string[],
  baseline = oracleBaselineInput(value.manifest),
  inputBytes: Uint8Array = canonicalJsonBytes(baseline),
): void {
  value.manifest.inputs = [store(value.objects, inputBytes)];
  const proof = oracleProof(
    value.manifest.inputs,
    value.manifest.report,
    ids,
    baseline,
    value.manifest.observed_at,
  );
  value.manifest.execution = proof.execution;
  value.manifest.oracle = proof.oracle;
  for (const [uri, bytes] of proof.objects) value.objects.set(uri, bytes);
  refreshConflict(value);
}

function replaceBaselineInput(value: Fixture, bytes: Uint8Array): void {
  replaceOracle(value, registeredIds, oracleBaselineInput(value.manifest), bytes);
}

function reorderFirstTwoControls(value: Fixture): void {
  const first = value.manifest.oracle.negative_controls[0];
  const second = value.manifest.oracle.negative_controls[1];
  if (first === undefined || second === undefined) throw new Error('fixture controls are missing');
  value.manifest.oracle.negative_controls = [
    second,
    first,
    ...value.manifest.oracle.negative_controls.slice(2),
  ];
  const report = record(value.objects, value.manifest.oracle.report);
  const firstReport = arrayRecord(report, 'negative_controls', 0);
  const secondReport = arrayRecord(report, 'negative_controls', 1);
  const controls = report.negative_controls;
  if (!Array.isArray(controls)) throw new Error('fixture report controls are missing');
  controls[0] = secondReport;
  controls[1] = firstReport;
  storeReport(value, report);
}

function verify(value: Fixture): void {
  const bytes = Buffer.from(`${canonicalJsonBytes(value.manifest).toString()}\n`);
  verifyEvidenceChain([bytes], value.objects);
}

describe('semantic negative-control registry', () => {
  it('rejects an open baseline schema even when every digest is rebuilt', () => {
    const value = fixture();
    const baseline = oracleBaselineInput(value.manifest);
    replaceBaselineInput(value, canonicalJsonBytes({ ...baseline, attacker_field: true }));
    expect(() => verify(value)).toThrow(/baseline input/);
  });

  it('rejects a baseline that is not bound to the admitted report', () => {
    const value = fixture();
    const baseline = oracleBaselineInput({ ...value.manifest, authority_sha256: '9'.repeat(64) });
    replaceOracle(value, registeredIds, baseline);
    expect(() => verify(value)).toThrow(/baseline input/);
  });

  it('rejects a random blob re-digested as a registered mutant input', () => {
    const value = fixture();
    rewriteControl(value, 0, { mutatedInput: Buffer.from('attacker-selected bytes\n') });
    expect(() => verify(value)).toThrow(/negative control|mutant/);
  });

  it('rejects a registered control that mutates the wrong baseline field', () => {
    const value = fixture();
    const baseline = oracleBaselineInput(value.manifest);
    rewriteControl(value, 0, {
      mutatedInput: canonicalJsonBytes({
        ...baseline,
        evidence_context_probe_sha256: '9'.repeat(64),
      }),
    });
    expect(() => verify(value)).toThrow(/negative control|mutant/);
  });

  it('rejects a registered control using a non-deterministic value', () => {
    const value = fixture();
    const baseline = oracleBaselineInput(value.manifest);
    rewriteControl(value, 0, {
      mutatedInput: canonicalJsonBytes({ ...baseline, event_context_probe_sha256: '9'.repeat(64) }),
    });
    expect(() => verify(value)).toThrow(/negative control|mutant/);
  });

  it('rejects a registered control with a mislabeled mutation kind', () => {
    const value = fixture();
    rewriteControl(value, 0, { mutationKind: 'OTHER-TAMPER' });
    expect(() => verify(value)).toThrow(/negative control|mutation/);
  });

  it('rejects the exact registry in a different order', () => {
    const value = fixture();
    reorderFirstTwoControls(value);
    expect(() => verify(value)).toThrow(/negative control/);
  });

  it('rejects a sorted control set with an extra unregistered ID', () => {
    const value = fixture();
    replaceOracle(value, ['NC-S01-ADDITIONAL-CONTROL', ...registeredIds]);
    expect(() => verify(value)).toThrow(/negative control/);
  });
});
