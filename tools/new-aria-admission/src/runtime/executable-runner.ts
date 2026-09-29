import type { ExecutableRunEvidence, ExecutableRunResult } from './executable-run-result';
import {
  abortPendingExecutableRun,
  commitPendingExecutableRun,
  reservePendingExecutableRun,
  snapshotPendingExecutableRun,
} from './pending-executable-run';
import type { PendingExecutableRun, VerifierExecutableRequest } from './pending-executable-run';
import {
  abortRepositoryExecutionSession,
  acceptRepositorySessionReceipt,
  closeRepositoryExecutionSession,
  openRepositoryExecutionSession,
} from './repository-execution-session';
import type {
  OpenExecutionSessionRequest,
  RepositoryExecutionSession,
} from './repository-execution-contracts';
import type { SignedExecutionReceipt } from './execution-signer';

export type { ExecutableRunEvidence, ExecutableRunResult } from './executable-run-result';
export { runVerifierExecutable, snapshotPendingExecutableRun } from './pending-executable-run';
export type { PendingExecutableRun, VerifierExecutableRequest } from './pending-executable-run';
export {
  abortRepositoryExecutionSession,
  closeRepositoryExecutionSession,
  openRepositoryExecutionSession,
} from './repository-execution-session';
export type {
  FinalizedRepositoryExecutionRoster,
  OpenExecutionSessionRequest,
  RepositoryExecutionSession,
} from './repository-execution-contracts';

interface RunState {
  readonly session: RepositoryExecutionSession;
  readonly evidence: ExecutableRunEvidence;
  readonly input_envelope: Buffer;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

interface FinalRunState extends RunState {
  readonly receipt: SignedExecutionReceipt;
}

const issuedRuns = new WeakMap<object, FinalRunState>();

export function finalizeExecutableRun(
  session: RepositoryExecutionSession,
  pending: PendingExecutableRun,
  receipt: SignedExecutionReceipt,
): ExecutableRunResult {
  const reservation = reservePendingExecutableRun(session, pending);
  const candidate = snapshotPendingExecutableRun(pending);
  try {
    acceptRepositorySessionReceipt(session, candidate, receipt);
  } catch (error) {
    abortPendingExecutableRun(reservation);
    throw error;
  }
  const consumed = commitPendingExecutableRun(reservation);
  const state: RunState = { session, ...consumed };
  const finalState: FinalRunState = {
    ...state,
    receipt: Object.freeze({ bytes: Buffer.from(receipt.bytes), sha256: receipt.sha256 }),
  };
  const result: ExecutableRunResult = Object.freeze({
    evidence: state.evidence,
    input_envelope: Buffer.from(state.input_envelope),
    stdout: Buffer.from(state.stdout),
    stderr: Buffer.from(state.stderr),
    execution_receipt: finalState.receipt,
  });
  issuedRuns.set(result, finalState);
  return result;
}

export function snapshotExecutableRunResult(value: unknown): ExecutableRunResult {
  const state = value !== null && typeof value === 'object' ? issuedRuns.get(value) : undefined;
  if (state === undefined) {
    throw new TypeError('executable run result was not issued by the verified runner');
  }
  return Object.freeze({
    evidence: state.evidence,
    input_envelope: Buffer.from(state.input_envelope),
    stdout: Buffer.from(state.stdout),
    stderr: Buffer.from(state.stderr),
    execution_receipt: Object.freeze({
      bytes: Buffer.from(state.receipt.bytes),
      sha256: state.receipt.sha256,
    }),
  });
}
