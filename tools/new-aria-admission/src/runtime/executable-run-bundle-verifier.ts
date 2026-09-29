import { createHash } from 'node:crypto';

import {
  assertExecutableRepositoryTarget,
  revalidateExecutableRepositoryTarget,
  snapshotExecutableRepositoryTarget,
} from '../application/repository-target-verifier';
import type { VerifiedRepositoryTarget } from '../application/repository-target-verifier';
import { readCurrentEpochSnapshot } from '../adapters/file-current-epoch-provider';
import type { FileCurrentEpochProvider } from '../adapters/file-current-epoch-provider';
import { canonicalJsonBytes } from '../kernel/canonical-json';
import { loadOracleBaselineDocument } from '../kernel/oracle-baseline';
import { assertAuthorizedS01ProgressAuthority } from '../kernel/operator-progress-authority';
import type { AuthorizedS01ProgressAuthority } from '../kernel/operator-progress-authority';
import { verifyCurrentExecutionReceipt } from '../kernel/execution-trust-root';
import { authenticateVerifierSnapshotInput } from '../verifier/authenticated-input';

import {
  assertEpoch,
  assertExecutionAuthority,
  assertInput,
  assertOutput,
  assertTargetAuthority,
  bytesFor,
  stringsField,
} from './executable-run-bundle-binding';
import { readExecutionSessionBundle } from './executable-run-bundle-reader';
import { validateExecutionInputEnvelope } from './execution-input-envelope';
import { expectedVerifierProcessOutcome } from './verifier-process-outcome';

export interface ExecutableRunBundleVerificationInput {
  readonly bundle_path: string;
  readonly authority: AuthorizedS01ProgressAuthority;
  readonly target: VerifiedRepositoryTarget;
  readonly execution_trust_root_bytes: Uint8Array;
  readonly current_epoch_provider: FileCurrentEpochProvider;
}

export interface VerifiedExecutableRunBundle {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-verified-execution-session-bundle-v1';
  readonly bundle_sha256: string;
  readonly execution_session_id: string;
  readonly run_ids: readonly string[];
  readonly tree_sha: string;
}

const verifiedBundles = new WeakSet<object>();
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const jsonLine = (value: unknown): Buffer =>
  Buffer.concat([canonicalJsonBytes(value), Buffer.from('\n')]);

function verifyBundle(
  input: ExecutableRunBundleVerificationInput,
  markerName: 'CANDIDATE.json' | 'COMPLETE.json',
): VerifiedExecutableRunBundle {
  assertAuthorizedS01ProgressAuthority(input.authority);
  assertExecutableRepositoryTarget(input.target);
  assertTargetAuthority(input.authority, input.target);
  revalidateExecutableRepositoryTarget(input.target);
  const epochBefore = readCurrentEpochSnapshot(input.current_epoch_provider, input.authority);
  const runIds = ['BASELINE', ...input.authority.authority.document.required_negative_control_ids];
  const loaded = readExecutionSessionBundle(input.bundle_path, runIds, markerName);
  const baselineRun = loaded.marker.runs[0];
  if (baselineRun === undefined) throw new TypeError('run bundle baseline is absent');
  const baselineInput = validateExecutionInputEnvelope(bytesFor(loaded.artifacts, baselineRun, 1));
  const baselineDocument = loadOracleBaselineDocument(
    baselineInput.object_bytes[0] ?? Buffer.alloc(0),
  );
  const baselineReceipt = verifyCurrentExecutionReceipt({
    receipt_bytes: bytesFor(loaded.artifacts, baselineRun, 4),
    trust_root_bytes: input.execution_trust_root_bytes,
    authority: input.authority,
    expected_run_id: 'BASELINE',
    expected_run_context_sha256: baselineDocument.run_context_sha256,
  });
  const baselineArgv = stringsField(baselineReceipt.document.execution, 'argv');
  const authenticated = authenticateVerifierSnapshotInput(
    baselineInput.object_bytes,
    input.authority.trust_root_sha256,
    snapshotExecutableRepositoryTarget(input.target),
    baselineArgv.slice(2),
  );
  if (
    authenticated.authority.authority.sha256 !== input.authority.authority.sha256 ||
    authenticated.authority.envelope_sha256 !== input.authority.envelope_sha256
  )
    throw new TypeError('run bundle authentication objects differ from external authority');
  for (const run of loaded.marker.runs) {
    const inputEnvelope = validateExecutionInputEnvelope(bytesFor(loaded.artifacts, run, 1));
    const receipt =
      run.run_id === 'BASELINE'
        ? baselineReceipt
        : verifyCurrentExecutionReceipt({
            receipt_bytes: bytesFor(loaded.artifacts, run, 4),
            trust_root_bytes: input.execution_trust_root_bytes,
            authority: input.authority,
            expected_run_id: run.run_id,
            expected_run_context_sha256: baselineDocument.run_context_sha256,
          });
    const execution = receipt.document.execution;
    const evidence = bytesFor(loaded.artifacts, run, 0);
    const stdout = bytesFor(loaded.artifacts, run, 2);
    const stderr = bytesFor(loaded.artifacts, run, 3);
    if (
      !jsonLine(execution).equals(evidence) ||
      receipt.document.tree_sha !== input.target.tree_sha
    )
      throw new TypeError('run bundle evidence differs from signed receipt or target');
    assertExecutionAuthority(execution, run, input.authority, input.target, baselineArgv);
    assertEpoch(execution, epochBefore);
    assertInput(execution, inputEnvelope, baselineInput);
    assertOutput(
      execution,
      run,
      inputEnvelope,
      stdout,
      stderr,
      expectedVerifierProcessOutcome(run.run_id, inputEnvelope.object_bytes, authenticated),
    );
  }
  const epochAfter = readCurrentEpochSnapshot(input.current_epoch_provider, input.authority);
  revalidateExecutableRepositoryTarget(input.target);
  if (
    epochAfter.provider_identity_sha256 !== epochBefore.provider_identity_sha256 ||
    epochAfter.sha256 !== epochBefore.sha256 ||
    epochAfter.revision !== epochBefore.revision
  )
    throw new TypeError('current epoch changed while the run bundle was verified');
  const result: VerifiedExecutableRunBundle = Object.freeze({
    schema_version: '1.0.0',
    contract_id: 'new-aria-verified-execution-session-bundle-v1',
    bundle_sha256: digest(loaded.marker_bytes),
    execution_session_id: input.authority.authority.document.execution_session_id,
    run_ids: Object.freeze([...runIds]),
    tree_sha: input.target.tree_sha,
  });
  verifiedBundles.add(result);
  return result;
}

export function verifyExecutableRunBundle(
  input: ExecutableRunBundleVerificationInput,
): VerifiedExecutableRunBundle {
  return verifyBundle(input, 'COMPLETE.json');
}

export function verifyStagedExecutableRunBundle(
  input: ExecutableRunBundleVerificationInput,
): VerifiedExecutableRunBundle {
  return verifyBundle(input, 'CANDIDATE.json');
}

export function assertVerifiedExecutableRunBundle(
  value: unknown,
): asserts value is VerifiedExecutableRunBundle {
  if (value === null || typeof value !== 'object' || !verifiedBundles.has(value)) {
    throw new TypeError('execution session bundle was not issued by the trusted verifier');
  }
}
