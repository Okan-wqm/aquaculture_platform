import { createHash } from 'node:crypto';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';

import { NegativeControlFixture, OracleBaselineInput } from './negative-control-fixture';

interface ObjectReference {
  readonly uri: string;
  readonly sha256: string;
}

export interface RejectionFixtureExpectation {
  readonly oracle_id: string;
  readonly implementation_sha256: string;
  readonly control_id: string;
  readonly control: NegativeControlFixture;
  readonly baseline_input_sha256: string;
  readonly mutant_document_sha256: string;
  readonly mutated_input_sha256: string;
  readonly baseline: OracleBaselineInput;
}

interface RejectionArtifacts {
  readonly output: ObjectReference;
  readonly stdout: ObjectReference;
  readonly failure: ObjectReference;
  readonly stderr: ObjectReference;
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function store(objects: Map<string, Uint8Array>, bytes: Uint8Array): ObjectReference {
  const sha256 = digest(bytes);
  const reference = { uri: `aria-evidence://sha256/${sha256}`, sha256 };
  objects.set(reference.uri, Buffer.from(bytes));
  return reference;
}

function scope(baseline: OracleBaselineInput): object {
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

export function rejectionArtifacts(
  objects: Map<string, Uint8Array>,
  expectation: RejectionFixtureExpectation,
): RejectionArtifacts {
  const receiptBytes = canonicalJsonBytes({
    schema_version: '1.0.0',
    contract_id: 'new-aria-negative-control-rejection-receipt-v1',
    oracle_id: expectation.oracle_id,
    implementation_sha256: expectation.implementation_sha256,
    control_id: expectation.control_id,
    mutation_kind: expectation.control.mutationKind,
    reason_code: expectation.control.reasonCode,
    run_context_sha256: expectation.baseline.run_context_sha256,
    baseline_input_sha256: expectation.baseline_input_sha256,
    mutant_document_sha256: expectation.mutant_document_sha256,
    mutated_input_sha256: expectation.mutated_input_sha256,
    scope: scope(expectation.baseline),
    verdict: 'REJECTED',
  });
  const failureBytes = canonicalJsonBytes({
    schema_version: '1.0.0',
    contract_id: 'new-aria-negative-control-failure-reason-v1',
    control_id: expectation.control_id,
    reason_code: expectation.control.reasonCode,
    run_context_sha256: expectation.baseline.run_context_sha256,
    verdict: 'REJECTED',
  });
  const failure = store(objects, failureBytes);
  return {
    output: store(objects, receiptBytes),
    stdout: store(objects, Buffer.concat([receiptBytes, Buffer.from('\n')])),
    failure,
    stderr: store(objects, Buffer.concat([failureBytes, Buffer.from('\n')])),
  };
}
