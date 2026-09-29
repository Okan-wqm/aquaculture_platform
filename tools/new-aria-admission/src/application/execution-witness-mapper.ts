import { createHash } from 'node:crypto';

import type { EvidenceExecution, EvidenceReference } from '../domain/evidence-contracts';
import { canonicalJsonBytes } from '../kernel/canonical-json';
import { assertAuthorizedS01ProgressAuthority } from '../kernel/operator-progress-authority';
import type { AuthorizedS01ProgressAuthority } from '../kernel/operator-progress-authority';
import type { ExecutableRunResult } from '../runtime/executable-run-result';
import { snapshotExecutableRunResult } from '../runtime/executable-runner';
import { validateExecutionInputEnvelope } from '../runtime/execution-input-envelope';
import {
  readVerifierFailureArtifact,
  readVerifierOutputArtifact,
} from '../runtime/verifier-output';

import { assertVerifiedRepositoryTarget } from './repository-target-verifier';
import type { VerifiedRepositoryTarget } from './repository-target-verifier';

const referenceKeys = ['sha256', 'uri'] as const;

export interface ExecutionWitnessMappingRequest {
  readonly run: ExecutableRunResult;
  readonly authority: AuthorizedS01ProgressAuthority;
  readonly target: VerifiedRepositoryTarget;
  readonly input_envelope_bytes: Uint8Array;
  readonly output_reference: EvidenceReference;
  readonly output_bytes: Uint8Array;
}

export type MappedEvidenceExecution = EvidenceExecution;

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function verifyOutput(
  reference: EvidenceReference,
  output: Uint8Array,
  run: ReturnType<typeof snapshotExecutableRunResult>,
): string {
  if (!(output instanceof Uint8Array)) {
    throw new TypeError('execution output must be immutable copied bytes');
  }
  if (typeof SharedArrayBuffer !== 'undefined' && output.buffer instanceof SharedArrayBuffer) {
    throw new TypeError('execution output cannot use shared mutable memory');
  }
  const ownedOutput = Buffer.from(output);
  if (
    Object.keys(reference).length !== referenceKeys.length ||
    referenceKeys.some((key) => !Object.prototype.hasOwnProperty.call(reference, key)) ||
    !/^[a-f0-9]{64}$/u.test(reference.sha256) ||
    reference.uri !== `aria-evidence://sha256/${reference.sha256}`
  ) {
    throw new TypeError('execution output reference is not content-addressed');
  }
  const outputSha256 = digest(ownedOutput);
  const artifact = readVerifierOutputArtifact(run.stdout, {
    run_id: run.evidence.run_id,
    run_context_sha256: run.evidence.run_context_sha256,
    baseline_input_sha256: run.evidence.input_object_sha256s[0],
    input_object_sha256s: run.evidence.input_object_sha256s,
  });
  if (outputSha256 !== reference.sha256 || !ownedOutput.equals(artifact)) {
    throw new TypeError('execution output is not the validated process result artifact');
  }
  return outputSha256;
}

function verifyAuthorityBinding(request: ExecutionWitnessMappingRequest): void {
  assertAuthorizedS01ProgressAuthority(request.authority);
  assertVerifiedRepositoryTarget(request.target);
  const document = request.authority.authority.document;
  const evidence = snapshotExecutableRunResult(request.run).evidence;
  if (
    request.target.repository_id !== document.repository_id ||
    request.target.workspace_id !== document.workspace_id ||
    request.target.base_sha !== document.base_sha ||
    request.target.head_sha !== document.head_sha ||
    request.target.git_tool_id !== document.git_tool_id ||
    request.target.git_tool_sha256 !== document.git_tool_sha256 ||
    evidence.repository_id !== request.target.repository_id ||
    evidence.workspace_id !== request.target.workspace_id ||
    evidence.base_sha !== request.target.base_sha ||
    evidence.head_sha !== request.target.head_sha ||
    evidence.tree_sha !== request.target.tree_sha ||
    evidence.execution_session_id !== document.execution_session_id ||
    evidence.tool.id !== document.verifier_tool_id ||
    evidence.tool.sha256 !== document.verifier_sha256 ||
    evidence.runtime.id !== document.runtime_id ||
    evidence.runtime.executable_sha256 !== document.toolchain_sha256 ||
    evidence.argv_sha256 !== document.verifier_argv_sha256 ||
    evidence.cwd_sha256 !== document.execution_cwd_sha256 ||
    Date.parse(evidence.started_at_utc) < Date.parse(request.authority.observed_at) ||
    Date.parse(evidence.ended_at_utc) > Date.parse(request.authority.valid_until)
  ) {
    throw new TypeError('executable run does not match signed progress authority and target');
  }
}

function verifyIssuedRun(request: ExecutionWitnessMappingRequest): {
  readonly run: ReturnType<typeof snapshotExecutableRunResult>;
  readonly failureReasonSha256: string | null;
} {
  const run = snapshotExecutableRunResult(request.run);
  const evidence = run.evidence;
  const input = validateExecutionInputEnvelope(request.input_envelope_bytes);
  const outputSha256 = verifyOutput(request.output_reference, request.output_bytes, run);
  const baseline = evidence.run_id === 'BASELINE';
  const failureArtifact = baseline
    ? undefined
    : readVerifierFailureArtifact(run.stderr, {
        run_id: evidence.run_id,
        run_context_sha256: evidence.run_context_sha256,
        baseline_input_sha256: evidence.input_object_sha256s[0],
        input_object_sha256s: evidence.input_object_sha256s,
      });
  if (
    evidence.schema_version !== '1.0.0' ||
    evidence.contract_id !== 'new-aria-executable-run-v1' ||
    evidence.input_reference_bundle_sha256 !== input.input_reference_bundle_sha256 ||
    evidence.input_envelope_sha256 !== input.input_envelope_sha256 ||
    evidence.input_object_sha256s.length !== input.object_sha256s.length ||
    evidence.input_object_sha256s.some((sha256, index) => sha256 !== input.object_sha256s[index]) ||
    evidence.output_sha256 !== outputSha256 ||
    evidence.stdout.sha256 !== digest(run.stdout) ||
    evidence.stdout.byte_length !== run.stdout.byteLength ||
    evidence.stderr.sha256 !== digest(run.stderr) ||
    evidence.stderr.byte_length !== run.stderr.byteLength ||
    run.execution_receipt.sha256 !== digest(run.execution_receipt.bytes) ||
    input.object_sha256s.length !== (baseline ? 4 : 6) ||
    evidence.argv_sha256 !== digest(canonicalJsonBytes(evidence.argv)) ||
    evidence.materialized_argv.length !== evidence.argv.length ||
    evidence.materialized_argv
      .slice(2)
      .some((argument, index) => argument !== evidence.argv[index + 2]) ||
    evidence.materialized_argv_sha256 !== digest(canonicalJsonBytes(evidence.materialized_argv)) ||
    evidence.cwd_sha256 !== digest(Buffer.from(evidence.cwd)) ||
    (baseline
      ? evidence.process.exit_code !== 0 ||
        !evidence.process.workflow_succeeded ||
        evidence.result.semantic_verdict !== 'PASSED' ||
        evidence.result.final_exit_code !== 0
      : evidence.process.exit_code !== 1 ||
        evidence.process.workflow_succeeded ||
        evidence.result.semantic_verdict !== 'FAILED' ||
        evidence.result.final_exit_code !== 1) ||
    Date.parse(evidence.started_at_utc) > Date.parse(evidence.ended_at_utc)
  ) {
    throw new TypeError('issued executable run is not an admissible passed execution');
  }
  return {
    run,
    failureReasonSha256: failureArtifact === undefined ? null : digest(failureArtifact),
  };
}

export function mapExecutableRunToEvidenceExecution(
  request: ExecutionWitnessMappingRequest,
): MappedEvidenceExecution {
  verifyAuthorityBinding(request);
  const { run, failureReasonSha256 } = verifyIssuedRun(request);
  const evidence = run.evidence;
  const inputSha256 = evidence.input_object_sha256s[evidence.run_id === 'BASELINE' ? 0 : 5];
  if (inputSha256 === undefined) throw new TypeError('baseline execution input object is absent');
  return Object.freeze({
    argv: Object.freeze([...evidence.argv]),
    argv_sha256: evidence.argv_sha256,
    materialized_argv: Object.freeze([...evidence.materialized_argv]),
    materialized_argv_sha256: evidence.materialized_argv_sha256,
    tool_id: evidence.tool.id,
    tool_sha256: evidence.tool.sha256,
    runtime_id: evidence.runtime.id,
    runtime_sha256: evidence.runtime.executable_sha256,
    cwd: evidence.cwd,
    cwd_sha256: evidence.cwd_sha256,
    execution_session_id: evidence.execution_session_id,
    run_id: evidence.run_id,
    run_context_sha256: evidence.run_context_sha256,
    run_nonce_sha256: evidence.run_nonce_sha256,
    input_sha256: inputSha256,
    input_reference_bundle_sha256: evidence.input_reference_bundle_sha256,
    input_envelope_sha256: evidence.input_envelope_sha256,
    input_object_sha256s: Object.freeze([...evidence.input_object_sha256s]),
    current_epoch_provider_identity_sha256: evidence.current_epoch_provider_identity_sha256,
    current_epoch_snapshot_sha256: evidence.current_epoch_snapshot_sha256,
    current_epoch_revision: evidence.current_epoch_revision,
    current_epoch_read_at: evidence.current_epoch_read_at,
    execution_receipt: Object.freeze({
      uri: `aria-evidence://sha256/${run.execution_receipt.sha256}`,
      sha256: run.execution_receipt.sha256,
    }),
    output_sha256: evidence.output_sha256,
    started_at: evidence.started_at_utc,
    finished_at: evidence.ended_at_utc,
    exit_code: evidence.process.exit_code,
    stdout_sha256: evidence.stdout.sha256,
    stderr_sha256: evidence.stderr.sha256,
    stderr_byte_length: evidence.stderr.byte_length,
    failure_reason_sha256: failureReasonSha256,
    semantic_verdict: evidence.run_id === 'BASELINE' ? 'PASSED' : 'REJECTED',
  });
}
