import { canonicalJsonBytes } from '../kernel/canonical-json';
import { verifyCurrentExecutionReceipt } from '../kernel/execution-trust-root';
import { executionRunNonceSha256 } from '../kernel/execution-run-identity';

import { createExecutableRunEvidence } from './executable-run-evidence';
import type { ExecutableRunResult } from './executable-run-result';
import { assertExecutionRunAuthority } from './execution-session-authority';
import { resolveExecutionIdentity, snapshotExecutionArguments } from './execution-identity';
import { validateExecutionInputEnvelope } from './execution-input-envelope';
import type { SignedExecutionReceipt } from './execution-signer';
import type {
  ExecutedSessionRun,
  FinalizedRepositoryExecutionRoster,
  OpenExecutionSessionRequest,
  RepositoryExecutionSession,
  RepositorySessionRunRequest,
} from './repository-execution-contracts';
import { prepareRepositoryExecution } from './repository-execution-preflight';
import {
  cleanupRepositorySessionOrThrow,
  cleanupRepositorySessionResources,
} from './repository-session-cleanup';
import {
  orderedFinalizedSessionRuns,
  snapshotFinalizedSessionRun,
} from './repository-session-finalization';
import type { SessionRunCandidate } from './repository-session-finalization';
import {
  authenticateRepositoryRun,
  verifiedRepositoryRunEpoch,
} from './repository-run-authentication';
import type { RepositoryExecutionState } from './repository-run-authentication';
import {
  publishFinalizedRepositoryExecutionRoster,
  publishRepositoryExecutionSession,
} from './repository-session-publication';
import { executeVerifierProcess } from './verifier-process';
import {
  assertExactVerifierProcessOutcome,
  expectedVerifierProcessOutcome,
} from './verifier-process-outcome';

const sessions = new WeakMap<object, RepositoryExecutionState>();
const finalizedRosters = new WeakMap<object, readonly ExecutableRunResult[]>();
export function openRepositoryExecutionSession(
  input: OpenExecutionSessionRequest,
): RepositoryExecutionSession {
  const prepared = prepareRepositoryExecution(input);
  return publishRepositoryExecutionSession(
    input,
    prepared.trust_root_bytes,
    prepared.repository,
    prepared.revalidate,
    sessions,
  );
}

function activeSession(session: RepositoryExecutionSession): RepositoryExecutionState {
  const state = sessions.get(session);
  if (state === undefined || state.closed) {
    throw new TypeError('repository execution session is absent or closed');
  }
  return state;
}

export function executeRepositorySessionRun(
  request: RepositorySessionRunRequest,
): ExecutedSessionRun {
  const state = activeSession(request.session);
  if (
    state.expectedRuns[state.usedRuns.size] !== request.run_id ||
    state.usedRuns.has(request.run_id) ||
    state.finalizedRuns.size !== state.usedRuns.size
  ) {
    throw new TypeError('execution run ID is unauthorized, out of order, or already used');
  }
  const input = validateExecutionInputEnvelope(request.input_envelope_bytes);
  if (
    (request.run_id === 'BASELINE' && input.object_sha256s.length !== 4) ||
    (request.run_id !== 'BASELINE' && input.object_sha256s.length !== 6)
  ) {
    throw new TypeError('execution run input object roster is invalid');
  }
  const firstObjectSha256 = input.object_sha256s[0];
  if (firstObjectSha256 === undefined) throw new TypeError('execution run input is absent');
  if (request.run_id === 'BASELINE') {
    state.baselineObjectSha256s = Object.freeze(input.object_sha256s.slice(0, 4));
  }
  if (
    request.run_id !== 'BASELINE' &&
    (state.baselineObjectSha256s === undefined ||
      input.object_sha256s
        .slice(0, 4)
        .some((sha256, index) => sha256 !== state.baselineObjectSha256s?.[index]))
  ) {
    throw new TypeError('negative control cannot run without a baseline input');
  }
  const args = snapshotExecutionArguments(request.args);
  assertExecutionRunAuthority(state.authority, state.target, { ...request, args });
  const identity = resolveExecutionIdentity({
    repository_id: state.target.repository_id,
    workspace_id: state.target.workspace_id,
    tool_id: request.tool_id,
    input_reference_bundle_sha256: input.input_reference_bundle_sha256,
    input_envelope_sha256: input.input_envelope_sha256,
    input_object_sha256s: input.object_sha256s,
  });
  const nonce = executionRunNonceSha256({
    execution_session_id: request.session.execution_session_id,
    run_id: request.run_id,
    run_context_sha256: request.run_context_sha256,
    input_envelope_sha256: input.input_envelope_sha256,
    tree_sha: state.target.tree_sha,
  });
  state.repository.verify();
  state.revalidate();
  const epochBefore = verifiedRepositoryRunEpoch(state, input.object_sha256s);
  const authenticated = authenticateRepositoryRun(
    state,
    request.run_id,
    request.run_context_sha256,
    args,
    input.object_bytes,
  );
  if (request.run_id === 'BASELINE') {
    state.baselineRunContextSha256 = authenticated.verification.baseline.run_context_sha256;
  }
  const expectedOutcome = expectedVerifierProcessOutcome(
    request.run_id,
    input.object_bytes,
    authenticated,
  );
  state.usedRuns.add(request.run_id);
  const observation = executeVerifierProcess({
    cwd: state.repository.root,
    tool_path: request.tool_path,
    tool_sha256: request.tool_sha256,
    runtime_sha256: request.runtime_sha256,
    args,
    input: input.bytes,
  });
  state.repository.verify();
  state.revalidate();
  const epochAfter = verifiedRepositoryRunEpoch(state, input.object_sha256s);
  if (epochAfter.sha256 !== epochBefore.sha256 || epochAfter.revision !== epochBefore.revision)
    throw new TypeError('current invalidation epoch changed during verifier execution');
  assertExactVerifierProcessOutcome(observation, expectedOutcome);
  const evidence = createExecutableRunEvidence({
    identity,
    target: state.target,
    execution_session_id: request.session.execution_session_id,
    run_id: request.run_id,
    run_context_sha256: request.run_context_sha256,
    run_nonce_sha256: nonce,
    baseline_input_sha256: state.baselineObjectSha256s?.[0],
    current_epoch_provider_identity_sha256: epochAfter.provider_identity_sha256,
    current_epoch_snapshot_sha256: epochAfter.sha256,
    current_epoch_revision: epochAfter.revision,
    current_epoch_read_at: epochAfter.read_at,
    args,
    ...observation,
  });
  return Object.freeze({
    evidence,
    input_envelope: Buffer.from(input.bytes),
    stdout: Buffer.from(observation.stdout),
    stderr: Buffer.from(observation.stderr),
  });
}

export function acceptRepositorySessionReceipt(
  session: RepositoryExecutionSession,
  candidate: SessionRunCandidate,
  receipt: SignedExecutionReceipt,
): void {
  const state = activeSession(session);
  const evidence = candidate.evidence;
  const verified = verifyCurrentExecutionReceipt({
    receipt_bytes: receipt.bytes,
    trust_root_bytes: state.trustRootBytes,
    authority: state.authority,
    expected_run_id: evidence.run_id,
    expected_run_context_sha256: evidence.run_context_sha256,
  });
  if (
    verified.sha256 !== receipt.sha256 ||
    !canonicalJsonBytes(verified.document.execution).equals(canonicalJsonBytes(evidence)) ||
    state.finalizedRuns.has(evidence.run_id)
  ) {
    throw new TypeError('execution receipt does not finalize this exact session run');
  }
  state.finalizedRuns.set(evidence.run_id, snapshotFinalizedSessionRun(candidate, receipt));
}

export function closeRepositoryExecutionSession(
  session: RepositoryExecutionSession,
): FinalizedRepositoryExecutionRoster {
  const state = activeSession(session);
  state.closed = true;
  let completed: readonly ExecutableRunResult[] | undefined;
  const cleanupFailures: unknown[] = [];
  try {
    state.repository.verify();
    state.revalidate();
    completed = orderedFinalizedSessionRuns(state.expectedRuns, state.finalizedRuns);
  } finally {
    cleanupFailures.push(
      ...cleanupRepositorySessionResources(
        state.repository,
        state.signingCapability,
        state.currentEpochProvider,
      ),
    );
  }
  if (cleanupFailures.length > 0 || completed === undefined) {
    throw new AggregateError(cleanupFailures, 'repository execution session cleanup failed');
  }
  return publishFinalizedRepositoryExecutionRoster(session, completed, finalizedRosters);
}

export function abortRepositoryExecutionSession(session: RepositoryExecutionSession): void {
  const state = activeSession(session);
  state.closed = true;
  cleanupRepositorySessionOrThrow(
    state.repository,
    state.signingCapability,
    state.currentEpochProvider,
  );
}

export function consumeFinalizedRepositoryExecutionRoster(
  value: unknown,
): readonly ExecutableRunResult[] {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('finalized session roster capability was not issued');
  }
  const runs = finalizedRosters.get(value);
  if (runs === undefined) {
    throw new TypeError('finalized session roster capability was not issued');
  }
  finalizedRosters.delete(value);
  return runs;
}
