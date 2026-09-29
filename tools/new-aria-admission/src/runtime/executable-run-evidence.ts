import { createHash } from 'node:crypto';

import { canonicalJsonBytes } from '../kernel/canonical-json';
import { workflowExitCode } from '../kernel/verdict-propagation';

import type { ExecutableRunEvidence } from './executable-run-result';
import type { ExecutionIdentity } from './execution-identity';
import { readVerifierOutputArtifact, readVerifierSemanticVerdict } from './verifier-output';
import type { VerifiedRepositoryTarget } from '../application/repository-target-verifier';

interface ExecutableObservation {
  readonly identity: ExecutionIdentity;
  readonly target: VerifiedRepositoryTarget;
  readonly execution_session_id: string;
  readonly run_id: string;
  readonly run_context_sha256: string;
  readonly run_nonce_sha256: string;
  readonly baseline_input_sha256: string | undefined;
  readonly args: readonly string[];
  readonly materialized_argv: readonly string[];
  readonly runtime_id: string;
  readonly runtime_version: string;
  readonly runtime_sha256: string;
  readonly tool_sha256: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly exit_code: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly current_epoch_provider_identity_sha256: string;
  readonly current_epoch_snapshot_sha256: string;
  readonly current_epoch_revision: number;
  readonly current_epoch_read_at: string;
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function timestamp(value: string, label: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${label} must be canonical UTC`);
  }
  return milliseconds;
}

function artifact(bytes: Uint8Array) {
  return Object.freeze({ byte_length: bytes.byteLength, sha256: digest(bytes) });
}

export function createExecutableRunEvidence(
  observation: ExecutableObservation,
): ExecutableRunEvidence {
  if (
    timestamp(observation.ended_at, 'execution end') <
    timestamp(observation.started_at, 'execution start')
  ) {
    throw new TypeError('execution time moved backwards');
  }
  const verdict = readVerifierSemanticVerdict(observation.stdout, {
    run_id: observation.run_id,
    run_context_sha256: observation.run_context_sha256,
    baseline_input_sha256: observation.baseline_input_sha256,
    input_object_sha256s: observation.identity.input_object_sha256s,
  });
  const output = readVerifierOutputArtifact(observation.stdout, {
    run_id: observation.run_id,
    run_context_sha256: observation.run_context_sha256,
    baseline_input_sha256: observation.baseline_input_sha256,
    input_object_sha256s: observation.identity.input_object_sha256s,
  });
  const workflowSucceeded = observation.exit_code === 0;
  const argv = Object.freeze([
    observation.runtime_id,
    observation.identity.tool_id,
    ...observation.args,
  ]);
  const evidence: ExecutableRunEvidence = {
    schema_version: '1.0.0',
    contract_id: 'new-aria-executable-run-v1',
    repository_id: observation.identity.repository_id,
    workspace_id: observation.identity.workspace_id,
    base_sha: observation.target.base_sha,
    head_sha: observation.target.head_sha,
    tree_sha: observation.target.tree_sha,
    execution_session_id: observation.execution_session_id,
    run_id: observation.run_id,
    run_context_sha256: observation.run_context_sha256,
    run_nonce_sha256: observation.run_nonce_sha256,
    argv,
    argv_sha256: digest(canonicalJsonBytes(argv)),
    materialized_argv: Object.freeze([...observation.materialized_argv]),
    materialized_argv_sha256: digest(canonicalJsonBytes(observation.materialized_argv)),
    cwd: observation.identity.logical_cwd,
    cwd_sha256: observation.identity.logical_cwd_sha256,
    input_reference_bundle_sha256: observation.identity.input_reference_bundle_sha256,
    input_envelope_sha256: observation.identity.input_envelope_sha256,
    input_object_sha256s: Object.freeze([...observation.identity.input_object_sha256s]),
    current_epoch_provider_identity_sha256: observation.current_epoch_provider_identity_sha256,
    current_epoch_snapshot_sha256: observation.current_epoch_snapshot_sha256,
    current_epoch_revision: observation.current_epoch_revision,
    current_epoch_read_at: observation.current_epoch_read_at,
    output_sha256: digest(output),
    runtime: Object.freeze({
      id: observation.runtime_id,
      version: observation.runtime_version,
      executable_sha256: observation.runtime_sha256,
    }),
    tool: Object.freeze({
      id: observation.identity.tool_id,
      sha256: observation.tool_sha256,
    }),
    started_at_utc: observation.started_at,
    ended_at_utc: observation.ended_at,
    process: Object.freeze({
      exit_code: observation.exit_code,
      workflow_succeeded: workflowSucceeded,
    }),
    result: Object.freeze({
      semantic_verdict: verdict,
      final_exit_code: workflowExitCode(verdict, workflowSucceeded),
    }),
    stdout: artifact(observation.stdout),
    stderr: artifact(observation.stderr),
  };
  return Object.freeze(evidence);
}
