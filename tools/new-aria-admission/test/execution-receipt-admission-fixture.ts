import { sign } from 'node:crypto';

import type { EvidenceExecution } from '../src/domain/evidence-contracts';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import type { ExecutionReceiptRosterInput } from '../src/kernel/execution-receipt-admission';
import { executionRunNonceSha256 } from '../src/kernel/execution-run-identity';

import {
  authorizedExecutionAuthority,
  executionTrustRootBytes,
  trustedExecutionSigner,
} from './execution-receipt-fixture';
import { digest } from './operator-authority-fixture';
import { evidenceBundle, evidenceManifestContract } from './progress-fixture';

function referenced(bytes: Uint8Array): {
  readonly bytes: Buffer;
  readonly reference: { readonly uri: string; readonly sha256: string };
} {
  const copy = Buffer.from(bytes);
  const sha256 = digest(copy);
  return { bytes: copy, reference: { uri: `aria-evidence://sha256/${sha256}`, sha256 } };
}

export function receiptAdmissionScenario(stdoutSha256 = '4'.repeat(64)): {
  readonly input: ExecutionReceiptRosterInput;
  readonly witness: EvidenceExecution;
} {
  const authority = authorizedExecutionAuthority();
  const inputs = [
    referenced(canonicalJsonBytes({ input: 'baseline' })),
    referenced(canonicalJsonBytes({ input: 'authority-envelope' })),
    referenced(canonicalJsonBytes({ input: 'operator-root' })),
    referenced(canonicalJsonBytes({ input: 'current-epoch-snapshot' })),
  ];
  const references = inputs.map(({ reference }) => reference);
  const envelope = inputs.map(({ bytes, reference }) => ({
    object_base64: bytes.toString('base64'),
    reference,
  }));
  const referenceListSha256 = digest(canonicalJsonBytes(references));
  const envelopeSha256 = digest(canonicalJsonBytes(envelope));
  const runContextSha256 = '7'.repeat(64);
  const treeSha = 'c'.repeat(40);
  const nonce = executionRunNonceSha256({
    execution_session_id: 'execution-session-s01-0001',
    run_id: 'BASELINE',
    run_context_sha256: runContextSha256,
    input_envelope_sha256: envelopeSha256,
    tree_sha: treeSha,
  });
  const argv = ['nodejs-20.11.1-linux-x64', 'new-aria-admission-verifier'];
  const materializedArgv = ['/verified/runtime', '/verified/tool'];
  const cwd = 'workspace://repo-1/workspace-1';
  const rawExecution = {
    schema_version: '1.0.0',
    contract_id: 'new-aria-executable-run-v1',
    repository_id: 'repo-1',
    workspace_id: 'workspace-1',
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
    tree_sha: treeSha,
    execution_session_id: 'execution-session-s01-0001',
    run_id: 'BASELINE',
    run_context_sha256: runContextSha256,
    run_nonce_sha256: nonce,
    argv,
    argv_sha256: digest(canonicalJsonBytes(argv)),
    materialized_argv: materializedArgv,
    materialized_argv_sha256: digest(canonicalJsonBytes(materializedArgv)),
    cwd,
    cwd_sha256: digest(Buffer.from(cwd)),
    input_reference_bundle_sha256: referenceListSha256,
    input_envelope_sha256: envelopeSha256,
    input_object_sha256s: references.map(({ sha256 }) => sha256),
    current_epoch_provider_identity_sha256: '8'.repeat(64),
    current_epoch_snapshot_sha256: references[3]?.sha256,
    current_epoch_revision: 1,
    current_epoch_read_at: '2026-09-02T12:12:00.000Z',
    output_sha256: '4'.repeat(64),
    runtime: {
      id: 'nodejs-20.11.1-linux-x64',
      version: '20.11.1',
      executable_sha256: 'f'.repeat(64),
    },
    tool: { id: 'new-aria-admission-verifier', sha256: '1'.repeat(64) },
    started_at_utc: '2026-09-02T12:10:00.000Z',
    ended_at_utc: '2026-09-02T12:11:00.000Z',
    process: { exit_code: 0, workflow_succeeded: true },
    result: { semantic_verdict: 'PASSED', final_exit_code: 0 },
    stdout: { byte_length: 1, sha256: stdoutSha256 },
    stderr: { byte_length: 0, sha256: digest(Buffer.alloc(0)) },
  };
  const payload = {
    schema_version: '1.0.0',
    contract_id: 'new-aria-execution-receipt-payload-v1',
    capability: 'ATTEST_EXECUTION',
    authority_sha256: authority.authority.sha256,
    authority_envelope_sha256: authority.envelope_sha256,
    execution_trust_root_sha256: authority.authority.document.execution_trust_root_sha256,
    execution_session_id: 'execution-session-s01-0001',
    signer_principal_id: trustedExecutionSigner.principalId,
    signer_key_sha256: digest(
      trustedExecutionSigner.publicKey.export({ format: 'der', type: 'spki' }),
    ),
    signer_key_epoch: 1,
    repository_id: 'repo-1',
    workspace_id: 'workspace-1',
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
    tree_sha: treeSha,
    run_id: 'BASELINE',
    run_context_sha256: runContextSha256,
    run_nonce_sha256: nonce,
    reference_list_sha256: referenceListSha256,
    object_envelope_sha256: envelopeSha256,
    execution: rawExecution,
    issued_at: '2026-09-02T12:20:00.000Z',
    valid_until: '2026-09-02T14:00:00.000Z',
  };
  const receiptBytes = canonicalJsonBytes({
    schema_version: '1.0.0',
    contract_id: 'new-aria-execution-receipt-envelope-v1',
    payload,
    signature: {
      principal_id: trustedExecutionSigner.principalId,
      capability: 'ATTEST_EXECUTION',
      signature_base64: sign(
        null,
        canonicalJsonBytes(payload),
        trustedExecutionSigner.privateKey,
      ).toString('base64'),
    },
  });
  const receipt = referenced(receiptBytes).reference;
  const baselineSha256 = references[0]?.sha256;
  const epochSha256 = references[3]?.sha256;
  if (baselineSha256 === undefined || epochSha256 === undefined) {
    throw new TypeError('receipt input fixture is incomplete');
  }
  const witness: EvidenceExecution = {
    execution_session_id: rawExecution.execution_session_id,
    run_id: rawExecution.run_id,
    run_context_sha256: runContextSha256,
    run_nonce_sha256: nonce,
    argv,
    argv_sha256: rawExecution.argv_sha256,
    materialized_argv: rawExecution.materialized_argv,
    materialized_argv_sha256: rawExecution.materialized_argv_sha256,
    tool_id: rawExecution.tool.id,
    tool_sha256: rawExecution.tool.sha256,
    runtime_id: rawExecution.runtime.id,
    runtime_sha256: rawExecution.runtime.executable_sha256,
    cwd,
    cwd_sha256: rawExecution.cwd_sha256,
    input_sha256: baselineSha256,
    input_reference_bundle_sha256: referenceListSha256,
    input_envelope_sha256: envelopeSha256,
    input_object_sha256s: rawExecution.input_object_sha256s,
    current_epoch_provider_identity_sha256: rawExecution.current_epoch_provider_identity_sha256,
    current_epoch_snapshot_sha256: epochSha256,
    current_epoch_revision: rawExecution.current_epoch_revision,
    current_epoch_read_at: rawExecution.current_epoch_read_at,
    execution_receipt: receipt,
    output_sha256: rawExecution.output_sha256,
    started_at: rawExecution.started_at_utc,
    finished_at: rawExecution.ended_at_utc,
    exit_code: 0,
    stdout_sha256: stdoutSha256,
    stderr_sha256: rawExecution.stderr.sha256,
    stderr_byte_length: rawExecution.stderr.byte_length,
    failure_reason_sha256: null,
    semantic_verdict: 'PASSED',
  };
  return {
    witness,
    input: {
      manifest: evidenceManifestContract(evidenceBundle(authority.authority.sha256).manifest),
      objects: new Map([[receipt.uri, receiptBytes]]),
      authority,
      trust_root_bytes: executionTrustRootBytes(),
      target: {
        repository_id: 'repo-1',
        workspace_id: 'workspace-1',
        base_sha: 'a'.repeat(40),
        head_sha: 'b'.repeat(40),
        tree_sha: treeSha,
      },
      current_epoch: {
        provider_identity_sha256: rawExecution.current_epoch_provider_identity_sha256,
        sha256: epochSha256,
        revision: rawExecution.current_epoch_revision,
      },
    },
  };
}
