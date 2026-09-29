import { createHash, createPublicKey, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { workflowExitCode } from '../src/kernel/verdict-propagation';

import type {
  ExecutionReceiptFixtureIssuer,
  ObjectReference,
  ReceiptlessExecutionWitness,
} from './oracle-proof-contracts';

export interface SyntheticExecutionReceiptScope {
  readonly authority_sha256: string;
  readonly authority_envelope_sha256: string;
  readonly execution_trust_root_sha256: string;
  readonly execution_session_id: string;
  readonly signer_principal_id: string;
  readonly signer_private_key: KeyObject;
  readonly repository_id: string;
  readonly workspace_id: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly tree_sha: string;
  readonly issued_at: string;
  readonly valid_until: string;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function referenceFor(bytes: Uint8Array): ObjectReference {
  const digest = sha256(bytes);
  return { uri: `aria-evidence://sha256/${digest}`, sha256: digest };
}

function artifact(
  objects: ReadonlyMap<string, Uint8Array>,
  digest: string,
): { readonly byte_length: number; readonly sha256: string } {
  const bytes = objects.get(`aria-evidence://sha256/${digest}`);
  if (bytes === undefined) throw new TypeError('synthetic execution artifact is missing');
  return { byte_length: bytes.byteLength, sha256: digest };
}

function rawExecution(
  objects: ReadonlyMap<string, Uint8Array>,
  witness: ReceiptlessExecutionWitness,
  scope: SyntheticExecutionReceiptScope,
): object {
  const semanticVerdict = witness.semantic_verdict === 'PASSED' ? 'PASSED' : 'FAILED';
  const workflowSucceeded = witness.exit_code === 0;
  return {
    schema_version: '1.0.0',
    contract_id: 'new-aria-executable-run-v1',
    repository_id: scope.repository_id,
    workspace_id: scope.workspace_id,
    base_sha: scope.base_sha,
    head_sha: scope.head_sha,
    tree_sha: scope.tree_sha,
    execution_session_id: witness.execution_session_id,
    run_id: witness.run_id,
    run_context_sha256: witness.run_context_sha256,
    run_nonce_sha256: witness.run_nonce_sha256,
    argv: witness.argv,
    argv_sha256: witness.argv_sha256,
    materialized_argv: witness.materialized_argv,
    materialized_argv_sha256: witness.materialized_argv_sha256,
    cwd: witness.cwd,
    cwd_sha256: witness.cwd_sha256,
    input_reference_bundle_sha256: witness.input_reference_bundle_sha256,
    input_envelope_sha256: witness.input_envelope_sha256,
    input_object_sha256s: witness.input_object_sha256s,
    current_epoch_provider_identity_sha256: witness.current_epoch_provider_identity_sha256,
    current_epoch_snapshot_sha256: witness.current_epoch_snapshot_sha256,
    current_epoch_revision: witness.current_epoch_revision,
    current_epoch_read_at: witness.current_epoch_read_at,
    output_sha256: witness.output_sha256,
    runtime: {
      id: witness.runtime_id,
      version: '20.11.1',
      executable_sha256: witness.runtime_sha256,
    },
    tool: { id: witness.tool_id, sha256: witness.tool_sha256 },
    started_at_utc: witness.started_at,
    ended_at_utc: witness.finished_at,
    process: { exit_code: witness.exit_code, workflow_succeeded: workflowSucceeded },
    result: {
      semantic_verdict: semanticVerdict,
      final_exit_code: workflowExitCode(semanticVerdict, workflowSucceeded),
    },
    stdout: artifact(objects, witness.stdout_sha256),
    stderr: artifact(objects, witness.stderr_sha256),
  };
}

export function syntheticExecutionReceiptIssuer(
  scope: SyntheticExecutionReceiptScope,
): ExecutionReceiptFixtureIssuer {
  const publicKey = createPublicKey(scope.signer_private_key).export({
    format: 'der',
    type: 'spki',
  });
  const signerKeySha256 = sha256(publicKey);
  return (objects, witness) => {
    const execution = rawExecution(objects, witness, scope);
    const payload = {
      schema_version: '1.0.0',
      contract_id: 'new-aria-execution-receipt-payload-v1',
      capability: 'ATTEST_EXECUTION',
      authority_sha256: scope.authority_sha256,
      authority_envelope_sha256: scope.authority_envelope_sha256,
      execution_trust_root_sha256: scope.execution_trust_root_sha256,
      execution_session_id: scope.execution_session_id,
      signer_principal_id: scope.signer_principal_id,
      signer_key_sha256: signerKeySha256,
      signer_key_epoch: 1,
      repository_id: scope.repository_id,
      workspace_id: scope.workspace_id,
      base_sha: scope.base_sha,
      head_sha: scope.head_sha,
      tree_sha: scope.tree_sha,
      run_id: witness.run_id,
      run_context_sha256: witness.run_context_sha256,
      run_nonce_sha256: witness.run_nonce_sha256,
      reference_list_sha256: witness.input_reference_bundle_sha256,
      object_envelope_sha256: witness.input_envelope_sha256,
      execution,
      issued_at: scope.issued_at,
      valid_until: scope.valid_until,
    };
    const receiptBytes = canonicalJsonBytes({
      schema_version: '1.0.0',
      contract_id: 'new-aria-execution-receipt-envelope-v1',
      payload,
      signature: {
        principal_id: scope.signer_principal_id,
        capability: 'ATTEST_EXECUTION',
        signature_base64: sign(
          null,
          canonicalJsonBytes(payload),
          scope.signer_private_key,
        ).toString('base64'),
      },
    });
    const reference = referenceFor(receiptBytes);
    objects.set(reference.uri, receiptBytes);
    return reference;
  };
}
