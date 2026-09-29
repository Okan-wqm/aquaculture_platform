import { canonicalJsonBytes } from '../src/kernel/canonical-json';

import { negativeControlFixture } from './negative-control-fixture';
import type { OracleBaselineInput } from './negative-control-fixture';
import { rejectionArtifacts } from './negative-control-receipt-fixture';
import {
  configuration,
  executionWitness,
  sha256,
  storeObject,
  verifierArgv,
  verifierCwd,
} from './oracle-execution-fixture';
import type {
  ExecutionAuthenticationMaterial,
  NegativeControlDeclaration,
  ExecutionReceiptFixtureIssuer,
  ObjectReference,
  OracleProofOverrides,
  OracleProofResult,
} from './oracle-proof-contracts';

const oracleId = 'new-aria-s01-admission-oracle';
const oraclePrincipalId = 'oracle-1';
const implementationSha256 = '2'.repeat(64);
export { verifierArgv, verifierCwd };
export type { OracleProofOverrides } from './oracle-proof-contracts';

const defaultAuthentication = (): ExecutionAuthenticationMaterial => ({
  authority_envelope_bytes: canonicalJsonBytes({ fixture: 'operator-authority-envelope' }),
  operator_trust_root_bytes: canonicalJsonBytes({ fixture: 'operator-trust-root' }),
  current_epoch_snapshot_bytes: canonicalJsonBytes({ fixture: 'current-epoch-snapshot' }),
  current_epoch_provider_identity_sha256: '8'.repeat(64),
  current_epoch_revision: 1,
});

export function oracleProof(
  inputs: readonly ObjectReference[],
  output: ObjectReference,
  negativeControlIds: readonly string[],
  baselineInput: OracleBaselineInput,
  observedAt = '2026-09-02T12:00:00.000Z',
  overrides: OracleProofOverrides = {},
  issueReceipt?: ExecutionReceiptFixtureIssuer,
  treeSha = 'c'.repeat(40),
  authentication: ExecutionAuthenticationMaterial = defaultAuthentication(),
): OracleProofResult {
  const objects = new Map<string, Uint8Array>();
  const config = configuration(overrides);
  const inputBundleSha256 = sha256(canonicalJsonBytes(inputs));
  const baselineBytes = canonicalJsonBytes(baselineInput);
  const baselineReference = inputs[0];
  if (baselineReference === undefined) throw new TypeError('baseline input reference is missing');
  const baselineObjects = [
    { bytes: baselineBytes, reference: baselineReference },
    {
      bytes: authentication.authority_envelope_bytes,
      reference: storeObject(objects, authentication.authority_envelope_bytes),
    },
    {
      bytes: authentication.operator_trust_root_bytes,
      reference: storeObject(objects, authentication.operator_trust_root_bytes),
    },
    {
      bytes: authentication.current_epoch_snapshot_bytes,
      reference: storeObject(objects, authentication.current_epoch_snapshot_bytes),
    },
  ];
  const execution = executionWitness(
    objects,
    baselineObjects,
    baselineInput.run_context_sha256,
    output.sha256,
    config,
    {
      tree_sha: treeSha,
      issue_receipt: issueReceipt,
      current_epoch_provider_identity_sha256: authentication.current_epoch_provider_identity_sha256,
      current_epoch_revision: authentication.current_epoch_revision,
    },
  );
  const declarations: NegativeControlDeclaration[] = [];
  const reportControls = [];
  for (const [index, id] of negativeControlIds.entries()) {
    const control = negativeControlFixture(id, index, baselineInput);
    const mutatedInput = storeObject(objects, control.bytes);
    const mutantBytes = canonicalJsonBytes({
      schema_version: '1.0.0',
      contract_id: 'new-aria-negative-control-mutant-v1',
      oracle_id: oracleId,
      control_id: id,
      implementation_sha256: implementationSha256,
      mutation_kind: control.mutationKind,
      run_context_sha256: baselineInput.run_context_sha256,
      baseline_input_sha256: baselineReference.sha256,
      mutated_input: mutatedInput,
    });
    const mutant = storeObject(objects, mutantBytes);
    const artifacts = rejectionArtifacts(objects, {
      oracle_id: oracleId,
      implementation_sha256: implementationSha256,
      control_id: id,
      control,
      baseline_input_sha256: baselineReference.sha256,
      mutant_document_sha256: mutant.sha256,
      mutated_input_sha256: mutatedInput.sha256,
      baseline: baselineInput,
    });
    const stderr =
      overrides.control_stderr_bytes === undefined
        ? artifacts.stderr
        : storeObject(objects, overrides.control_stderr_bytes);
    const resultExecution = executionWitness(
      objects,
      [
        ...baselineObjects,
        { bytes: mutantBytes, reference: mutant },
        { bytes: control.bytes, reference: mutatedInput },
      ],
      baselineInput.run_context_sha256,
      artifacts.output.sha256,
      config,
      {
        ordinal: index + 1,
        control_id: id,
        failure_sha256: artifacts.failure.sha256,
        stdout_sha256: artifacts.stdout.sha256,
        stderr_sha256: stderr.sha256,
        tree_sha: treeSha,
        issue_receipt: issueReceipt,
        current_epoch_provider_identity_sha256:
          authentication.current_epoch_provider_identity_sha256,
        current_epoch_revision: authentication.current_epoch_revision,
      },
    );
    const result = storeObject(
      objects,
      canonicalJsonBytes({
        schema_version: '1.0.0',
        contract_id: 'new-aria-negative-control-result-v1',
        oracle_id: oracleId,
        control_id: id,
        implementation_sha256: implementationSha256,
        mutation_kind: control.mutationKind,
        run_context_sha256: baselineInput.run_context_sha256,
        baseline_input_sha256: baselineReference.sha256,
        mutant_document_sha256: mutant.sha256,
        mutated_input_sha256: mutatedInput.sha256,
        execution: resultExecution,
        verdict: 'REJECTED',
      }),
    );
    declarations.push({
      id,
      mutation_kind: control.mutationKind,
      run_context_sha256: baselineInput.run_context_sha256,
      expected_verdict: 'REJECTED',
      mutant,
      result,
    });
    reportControls.push({
      id,
      mutation_kind: control.mutationKind,
      run_context_sha256: baselineInput.run_context_sha256,
      mutant_sha256: mutant.sha256,
      result_sha256: result.sha256,
      observed_verdict: 'REJECTED',
    });
  }
  const reportDocument = {
    schema_version: '1.0.0',
    contract_id: 'new-aria-evidence-oracle-report-v1',
    oracle_id: oracleId,
    principal_id: oraclePrincipalId,
    implementation_sha256: implementationSha256,
    run_context_sha256: baselineInput.run_context_sha256,
    observed_at: observedAt,
    input_bundle_sha256: inputBundleSha256,
    output_sha256: output.sha256,
    execution,
    negative_controls: reportControls,
    verdict: 'PASSED',
  };
  const report = storeObject(objects, canonicalJsonBytes(reportDocument));
  return {
    execution,
    oracle: {
      principal_id: oraclePrincipalId,
      oracle_id: oracleId,
      implementation_sha256: implementationSha256,
      report,
      negative_controls: declarations,
    },
    objects,
  };
}
