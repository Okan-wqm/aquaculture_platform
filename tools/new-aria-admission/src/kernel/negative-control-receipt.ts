import { canonicalJsonBytes } from './canonical-json';
import { digestBytes, JsonRecord, requiredSha256, verifyDigestObject } from './evidence-object';
import { NegativeControlReasonCode, OracleBaselineInput } from './negative-control-registry';

export interface RejectionReceiptExpectation {
  readonly oracle_id: string;
  readonly implementation_sha256: string;
  readonly control_id: string;
  readonly mutation_kind: string;
  readonly reason_code: NegativeControlReasonCode;
  readonly baseline_input_sha256: string;
  readonly mutant_document_sha256: string;
  readonly mutated_input_sha256: string;
  readonly baseline: OracleBaselineInput;
}

function receiptScope(baseline: OracleBaselineInput): object {
  return {
    authority_sha256: baseline.authority_sha256,
    repository_id: baseline.repository_id,
    workspace_id: baseline.workspace_id,
    base_sha: baseline.base_sha,
    head_sha: baseline.head_sha,
    evidence_id: baseline.evidence_id,
    program_id: baseline.program_id,
    sprint_id: baseline.sprint_id,
    event_policy_sha256: baseline.event_policy_sha256,
    freshness_policy_sha256: baseline.freshness_policy_sha256,
    epoch_provider_id: baseline.epoch_provider_id,
    epoch_provider_identity_sha256: baseline.epoch_provider_identity_sha256,
    verification_plan_sha256: baseline.verification_plan_sha256,
  };
}

export function canonicalRejectionReceipt(expectation: RejectionReceiptExpectation): Uint8Array {
  return canonicalJsonBytes({
    schema_version: '1.0.0',
    contract_id: 'new-aria-negative-control-rejection-receipt-v1',
    oracle_id: expectation.oracle_id,
    implementation_sha256: expectation.implementation_sha256,
    control_id: expectation.control_id,
    mutation_kind: expectation.mutation_kind,
    reason_code: expectation.reason_code,
    run_context_sha256: expectation.baseline.run_context_sha256,
    baseline_input_sha256: expectation.baseline_input_sha256,
    mutant_document_sha256: expectation.mutant_document_sha256,
    mutated_input_sha256: expectation.mutated_input_sha256,
    scope: receiptScope(expectation.baseline),
    verdict: 'REJECTED',
  });
}

export function canonicalNegativeControlFailureReason(
  expectation: RejectionReceiptExpectation,
): Uint8Array {
  return canonicalJsonBytes({
    schema_version: '1.0.0',
    contract_id: 'new-aria-negative-control-failure-reason-v1',
    control_id: expectation.control_id,
    reason_code: expectation.reason_code,
    run_context_sha256: expectation.baseline.run_context_sha256,
    verdict: 'REJECTED',
  });
}

function exactObject(
  digest: string,
  expected: Uint8Array,
  objects: ReadonlyMap<string, Uint8Array>,
  label: string,
): Uint8Array {
  const bytes = verifyDigestObject(digest, objects, label, true);
  if (digestBytes(expected) !== digest || !Buffer.from(bytes).equals(Buffer.from(expected))) {
    throw new TypeError(`${label} is not the canonical typed rejection receipt`);
  }
  return bytes;
}

export function validateRejectionReceipt(
  execution: JsonRecord,
  objects: ReadonlyMap<string, Uint8Array>,
  expectation: RejectionReceiptExpectation,
): void {
  if (execution.exit_code !== 1) {
    throw new TypeError('oracle negative control must use the semantic rejection exit code');
  }
  const outputDigest = requiredSha256(
    execution.output_sha256,
    'oracle negative control rejection receipt digest',
  );
  const receipt = exactObject(
    outputDigest,
    canonicalRejectionReceipt(expectation),
    objects,
    'oracle negative control rejection receipt',
  );
  const stdoutDigest = requiredSha256(
    execution.stdout_sha256,
    'oracle negative control stdout digest',
  );
  const stdout = verifyDigestObject(stdoutDigest, objects, 'oracle negative control stdout', true);
  const expectedStdout = Buffer.concat([Buffer.from(receipt), Buffer.from('\n')]);
  if (digestBytes(expectedStdout) !== stdoutDigest || !Buffer.from(stdout).equals(expectedStdout)) {
    throw new TypeError('oracle negative control stdout is not the typed rejection receipt');
  }
  const failureDigest = requiredSha256(
    execution.failure_reason_sha256,
    'oracle negative control failure reason digest',
  );
  const failure = exactObject(
    failureDigest,
    canonicalNegativeControlFailureReason(expectation),
    objects,
    'oracle negative control failure reason',
  );
  const stderrDigest = requiredSha256(
    execution.stderr_sha256,
    'oracle negative control stderr digest',
  );
  const stderr = verifyDigestObject(stderrDigest, objects, 'oracle negative control stderr', true);
  const expectedStderr = Buffer.concat([Buffer.from(failure), Buffer.from('\n')]);
  if (
    execution.stderr_byte_length !== expectedStderr.byteLength ||
    digestBytes(expectedStderr) !== stderrDigest ||
    !Buffer.from(stderr).equals(expectedStderr)
  ) {
    throw new TypeError('oracle negative control stderr is not the typed failure reason');
  }
}
