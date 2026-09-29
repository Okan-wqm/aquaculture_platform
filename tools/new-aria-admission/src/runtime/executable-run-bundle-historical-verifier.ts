import { createHash } from 'node:crypto';

import {
  assertExecutableRepositoryTarget,
  snapshotExecutableRepositoryTarget,
} from '../application/repository-target-verifier';
import type { VerifiedRepositoryTarget } from '../application/repository-target-verifier';
import { canonicalJsonBytes } from '../kernel/canonical-json';
import { loadOracleBaselineDocument } from '../kernel/oracle-baseline';
import { assertHistoricallyVerifiedS01ProgressAuthority } from '../kernel/operator-progress-authority';
import type { HistoricallyVerifiedS01ProgressAuthority } from '../kernel/operator-progress-authority';
import { verifyHistoricalExecutionReceipt } from '../kernel/execution-trust-root';
import { authenticateHistoricalVerifierSnapshotInput } from '../verifier/historical-authenticated-input';

import {
  assertExecutionAuthority,
  assertHistoricalEpoch,
  assertInput,
  assertOutput,
  assertTargetAuthority,
  bytesFor,
  stringField,
  stringsField,
} from './executable-run-bundle-binding';
import { readExecutionSessionBundle } from './executable-run-bundle-reader';
import { validateExecutionInputEnvelope } from './execution-input-envelope';
import { expectedVerifierProcessOutcome } from './verifier-process-outcome';

export interface HistoricalExecutableRunBundleVerificationInput {
  readonly bundle_path: string;
  readonly authority: HistoricallyVerifiedS01ProgressAuthority;
  readonly target: VerifiedRepositoryTarget;
  readonly execution_trust_root_bytes: Uint8Array;
}

export interface HistoricallyVerifiedExecutableRunBundle {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-historical-execution-session-bundle-v1';
  readonly historical_verdict: 'HISTORICALLY_VALID';
  readonly current: false;
  readonly bundle_sha256: string;
  readonly execution_session_id: string;
  readonly run_ids: readonly string[];
  readonly tree_sha: string;
}

const verifiedHistoricalBundles = new WeakSet<object>();
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const jsonLine = (value: unknown): Buffer =>
  Buffer.concat([canonicalJsonBytes(value), Buffer.from('\n')]);

export function verifyHistoricalExecutableRunBundle(
  input: HistoricalExecutableRunBundleVerificationInput,
): HistoricallyVerifiedExecutableRunBundle {
  assertHistoricallyVerifiedS01ProgressAuthority(input.authority);
  assertExecutableRepositoryTarget(input.target);
  assertTargetAuthority(input.authority, input.target);
  const runIds = ['BASELINE', ...input.authority.authority.document.required_negative_control_ids];
  const loaded = readExecutionSessionBundle(input.bundle_path, runIds);
  const baselineRun = loaded.marker.runs[0];
  if (baselineRun === undefined) throw new TypeError('historical run bundle baseline is absent');
  const baselineInput = validateExecutionInputEnvelope(bytesFor(loaded.artifacts, baselineRun, 1));
  const baselineDocument = loadOracleBaselineDocument(
    baselineInput.object_bytes[0] ?? Buffer.alloc(0),
  );
  const baselineReceipt = verifyHistoricalExecutionReceipt({
    receipt_bytes: bytesFor(loaded.artifacts, baselineRun, 4),
    trust_root_bytes: input.execution_trust_root_bytes,
    authority: input.authority,
    expected_run_id: 'BASELINE',
    expected_run_context_sha256: baselineDocument.run_context_sha256,
  });
  const baselineExecution = baselineReceipt.document.execution;
  const baselineArgv = stringsField(baselineExecution, 'argv');
  const authenticated = authenticateHistoricalVerifierSnapshotInput(
    baselineInput.object_bytes,
    input.authority,
    snapshotExecutableRepositoryTarget(input.target),
    baselineArgv.slice(2),
    stringField(baselineExecution, 'current_epoch_read_at'),
  );
  for (const run of loaded.marker.runs) {
    const inputEnvelope = validateExecutionInputEnvelope(bytesFor(loaded.artifacts, run, 1));
    const receipt =
      run.run_id === 'BASELINE'
        ? baselineReceipt
        : verifyHistoricalExecutionReceipt({
            receipt_bytes: bytesFor(loaded.artifacts, run, 4),
            trust_root_bytes: input.execution_trust_root_bytes,
            authority: input.authority,
            expected_run_id: run.run_id,
            expected_run_context_sha256: baselineDocument.run_context_sha256,
          });
    const execution = receipt.document.execution;
    const stdout = bytesFor(loaded.artifacts, run, 2);
    const stderr = bytesFor(loaded.artifacts, run, 3);
    if (
      !jsonLine(execution).equals(bytesFor(loaded.artifacts, run, 0)) ||
      receipt.document.tree_sha !== input.target.tree_sha
    )
      throw new TypeError('historical bundle evidence differs from receipt or target');
    assertExecutionAuthority(execution, run, input.authority, input.target, baselineArgv);
    assertHistoricalEpoch(execution, input.authority, authenticated.current_epoch_snapshot);
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
  const result: HistoricallyVerifiedExecutableRunBundle = Object.freeze({
    schema_version: '1.0.0',
    contract_id: 'new-aria-historical-execution-session-bundle-v1',
    historical_verdict: 'HISTORICALLY_VALID',
    current: false,
    bundle_sha256: digest(loaded.marker_bytes),
    execution_session_id: input.authority.authority.document.execution_session_id,
    run_ids: Object.freeze([...runIds]),
    tree_sha: input.target.tree_sha,
  });
  verifiedHistoricalBundles.add(result);
  return result;
}

export function assertHistoricallyVerifiedExecutableRunBundle(
  value: unknown,
): asserts value is HistoricallyVerifiedExecutableRunBundle {
  if (value === null || typeof value !== 'object' || !verifiedHistoricalBundles.has(value)) {
    throw new TypeError('historical execution bundle was not issued by the cryptographic verifier');
  }
}
