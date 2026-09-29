import type { EvidenceManifest } from '../domain/evidence-contracts';

import {
  isJsonRecord,
  parseCanonicalEvidenceObject,
  requiredSha256,
  verifyDigestObject,
  verifyEvidenceObject,
} from './evidence-object';

interface ClosureState {
  readonly objects: ReadonlyMap<string, Uint8Array>;
  readonly reachable: Set<string>;
  readonly receiptDigests: Set<string>;
}

function markReference(state: ClosureState, value: unknown, label: string): Uint8Array {
  const object = verifyEvidenceObject(value, state.objects, label);
  state.reachable.add(object.uri);
  return object.bytes;
}

function markDigest(state: ClosureState, value: unknown, label: string): void {
  const digest = requiredSha256(value, `${label} digest`);
  verifyDigestObject(digest, state.objects, label);
  state.reachable.add(`aria-evidence://sha256/${digest}`);
}

function markExecution(state: ClosureState, value: unknown, label: string): void {
  if (!isJsonRecord(value)) throw new TypeError(`${label} schema is invalid`);
  const inputDigests = value.input_object_sha256s;
  if (inputDigests !== undefined) {
    if (!Array.isArray(inputDigests)) throw new TypeError(`${label} input roster is invalid`);
    inputDigests.forEach((digest, index) =>
      markDigest(state, digest, `${label} input object ${index}`),
    );
  }
  if (value.execution_receipt !== undefined) {
    const receipt = verifyEvidenceObject(
      value.execution_receipt,
      state.objects,
      `${label} receipt`,
    );
    if (state.receiptDigests.has(receipt.sha256)) {
      throw new TypeError('execution receipt is reused across execution roles');
    }
    state.receiptDigests.add(receipt.sha256);
    state.reachable.add(receipt.uri);
  }
  markDigest(state, value.output_sha256, `${label} output`);
  markDigest(state, value.stdout_sha256, `${label} stdout`);
  markDigest(state, value.stderr_sha256, `${label} stderr`);
  if (value.failure_reason_sha256 !== null) {
    markDigest(state, value.failure_reason_sha256, `${label} failure reason`);
  }
}

function markNegativeControl(
  state: ClosureState,
  value: unknown,
  index: number,
  baselineInputSha256: string,
): void {
  if (!isJsonRecord(value)) throw new TypeError('negative control declaration is invalid');
  const mutant = parseCanonicalEvidenceObject(
    value.mutant,
    state.objects,
    `negative control ${index} mutant`,
  );
  state.reachable.add(mutant.reference.uri);
  const mutatedInput = verifyEvidenceObject(
    mutant.document.mutated_input,
    state.objects,
    `negative control ${index} mutated input`,
  );
  state.reachable.add(mutatedInput.uri);
  const result = parseCanonicalEvidenceObject(
    value.result,
    state.objects,
    `negative control ${index} result`,
  );
  state.reachable.add(result.reference.uri);
  const execution = result.document.execution;
  if (!isJsonRecord(execution)) {
    throw new TypeError('negative-control execution is missing');
  }
  const inputDigests = execution.input_object_sha256s;
  if (
    result.document.mutant_document_sha256 !== mutant.reference.sha256 ||
    result.document.mutated_input_sha256 !== mutatedInput.sha256 ||
    !Array.isArray(inputDigests) ||
    inputDigests.length !== 6 ||
    inputDigests[0] !== baselineInputSha256 ||
    inputDigests[4] !== mutant.reference.sha256 ||
    inputDigests[5] !== mutatedInput.sha256 ||
    execution.input_sha256 !== mutatedInput.sha256
  ) {
    throw new TypeError('negative-control raw mutant digest roles do not match');
  }
  markExecution(state, execution, `negative control ${index} execution`);
}

function markReferences(state: ClosureState, values: unknown, label: string): void {
  if (!Array.isArray(values)) throw new TypeError(`${label} collection is invalid`);
  values.forEach((value: unknown, index) => markReference(state, value, `${label} ${index}`));
}

function markManifest(state: ClosureState, manifest: EvidenceManifest): void {
  markReferences(state, manifest.inputs, 'manifest input');
  markReferences(state, manifest.artifacts, 'manifest artifact');
  markReference(state, manifest.report, 'manifest report');
  markExecution(state, manifest.execution, 'baseline execution');
  markReference(state, manifest.oracle.report, 'oracle report');
  const baselineInputSha256 = manifest.execution.input_object_sha256s[0];
  if (baselineInputSha256 === undefined) {
    throw new TypeError('baseline execution input role is missing');
  }
  manifest.oracle.negative_controls.forEach((control, index) =>
    markNegativeControl(state, control, index, baselineInputSha256),
  );
  markReference(state, manifest.review.conflict_evidence, 'conflict review');
}

export function assertExactEvidenceObjectClosure(
  manifests: readonly EvidenceManifest[],
  objects: ReadonlyMap<string, Uint8Array>,
): void {
  const state: ClosureState = {
    objects,
    reachable: new Set<string>(),
    receiptDigests: new Set<string>(),
  };
  manifests.forEach((manifest) => markManifest(state, manifest));
  for (const uri of objects.keys()) {
    if (!state.reachable.has(uri)) {
      throw new TypeError(`evidence object closure contains unreferenced extra object: ${uri}`);
    }
  }
  if (state.reachable.size !== objects.size) {
    throw new TypeError('evidence object closure is incomplete');
  }
}
