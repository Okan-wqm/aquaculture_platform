import type { EvidenceExecution } from '../domain/evidence-contracts';

import { isJsonRecord, verifyEvidenceObject } from './evidence-object';
import type { VerifiedExecutionReceipt } from './execution-trust-root';
import type { JsonValue } from './strict-json';

export interface ExecutionReceiptTarget {
  readonly repository_id: string;
  readonly workspace_id: string;
  readonly base_sha: string;
  readonly head_sha: string;
  readonly tree_sha: string;
}

export interface ExecutionReceiptBindingScope {
  readonly objects: ReadonlyMap<string, Uint8Array>;
  readonly target: ExecutionReceiptTarget;
  readonly current_epoch: {
    readonly provider_identity_sha256: string;
    readonly sha256: string;
    readonly revision: number;
  };
}

function sameStrings(left: readonly string[], right: JsonValue | undefined): boolean {
  return (
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function assertMappedExecutionReceipt(
  witness: EvidenceExecution,
  receipt: VerifiedExecutionReceipt,
  input: ExecutionReceiptBindingScope,
): void {
  const receiptObject = verifyEvidenceObject(witness.execution_receipt, input.objects, 'receipt');
  const raw = receipt.document.execution;
  const runtime = raw.runtime;
  const tool = raw.tool;
  const process = raw.process;
  const result = raw.result;
  const stdout = raw.stdout;
  const stderr = raw.stderr;
  const target = input.target;
  if (
    receipt.sha256 !== receiptObject.sha256 ||
    !isJsonRecord(runtime) ||
    !isJsonRecord(tool) ||
    !isJsonRecord(process) ||
    !isJsonRecord(result) ||
    !isJsonRecord(stdout) ||
    !isJsonRecord(stderr) ||
    receipt.document.repository_id !== target.repository_id ||
    receipt.document.workspace_id !== target.workspace_id ||
    receipt.document.base_sha !== target.base_sha ||
    receipt.document.head_sha !== target.head_sha ||
    receipt.document.tree_sha !== target.tree_sha ||
    raw.repository_id !== target.repository_id ||
    raw.workspace_id !== target.workspace_id ||
    raw.base_sha !== target.base_sha ||
    raw.head_sha !== target.head_sha ||
    raw.tree_sha !== target.tree_sha ||
    raw.execution_session_id !== witness.execution_session_id ||
    raw.run_id !== witness.run_id ||
    raw.run_context_sha256 !== witness.run_context_sha256 ||
    raw.run_nonce_sha256 !== witness.run_nonce_sha256 ||
    !sameStrings(witness.argv, raw.argv) ||
    raw.argv_sha256 !== witness.argv_sha256 ||
    !sameStrings(witness.materialized_argv, raw.materialized_argv) ||
    raw.materialized_argv_sha256 !== witness.materialized_argv_sha256 ||
    tool.id !== witness.tool_id ||
    tool.sha256 !== witness.tool_sha256 ||
    runtime.id !== witness.runtime_id ||
    runtime.executable_sha256 !== witness.runtime_sha256 ||
    raw.cwd !== witness.cwd ||
    raw.cwd_sha256 !== witness.cwd_sha256 ||
    raw.input_reference_bundle_sha256 !== witness.input_reference_bundle_sha256 ||
    raw.input_envelope_sha256 !== witness.input_envelope_sha256 ||
    !sameStrings(witness.input_object_sha256s, raw.input_object_sha256s) ||
    raw.current_epoch_provider_identity_sha256 !== witness.current_epoch_provider_identity_sha256 ||
    raw.current_epoch_snapshot_sha256 !== witness.current_epoch_snapshot_sha256 ||
    raw.current_epoch_revision !== witness.current_epoch_revision ||
    raw.current_epoch_read_at !== witness.current_epoch_read_at ||
    raw.current_epoch_provider_identity_sha256 !== input.current_epoch.provider_identity_sha256 ||
    raw.current_epoch_snapshot_sha256 !== input.current_epoch.sha256 ||
    raw.current_epoch_revision !== input.current_epoch.revision ||
    raw.output_sha256 !== witness.output_sha256 ||
    raw.started_at_utc !== witness.started_at ||
    raw.ended_at_utc !== witness.finished_at ||
    process.exit_code !== witness.exit_code ||
    stdout.sha256 !== witness.stdout_sha256 ||
    stderr.sha256 !== witness.stderr_sha256 ||
    stderr.byte_length !== witness.stderr_byte_length ||
    (witness.semantic_verdict === 'PASSED') !== (result.semantic_verdict === 'PASSED')
  ) {
    throw new TypeError('execution receipt evidence does not match mapped execution and target');
  }
}
