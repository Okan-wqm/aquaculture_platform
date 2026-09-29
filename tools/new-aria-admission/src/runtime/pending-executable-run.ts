import type { ExecutableRunEvidence } from './executable-run-result';
import { executeRepositorySessionRun } from './repository-execution-session';
import type {
  RepositoryExecutionSession,
  RepositorySessionRunRequest,
} from './repository-execution-contracts';

export interface VerifierExecutableRequest extends RepositorySessionRunRequest {}

export interface PendingExecutableRun {
  readonly evidence: ExecutableRunEvidence;
  readonly input_envelope: Buffer;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

interface PendingRunState {
  readonly session: RepositoryExecutionSession;
  readonly evidence: ExecutableRunEvidence;
  readonly inputEnvelope: Buffer;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  phase: 'ACTIVE' | 'RESERVED';
  reservation?: PendingExecutableRunReservation;
}

export interface PendingExecutableRunReservation {
  readonly contract_id: 'new-aria-pending-run-reservation-v1';
}

const pendingRuns = new WeakMap<object, PendingRunState>();
const reservedRuns = new WeakMap<object, PendingExecutableRun>();

const copy = (state: PendingRunState): PendingExecutableRun =>
  Object.freeze({
    evidence: state.evidence,
    input_envelope: Buffer.from(state.inputEnvelope),
    stdout: Buffer.from(state.stdout),
    stderr: Buffer.from(state.stderr),
  });

export function runVerifierExecutable(request: VerifierExecutableRequest): PendingExecutableRun {
  const execution = executeRepositorySessionRun(request);
  const state: PendingRunState = {
    session: request.session,
    evidence: execution.evidence,
    inputEnvelope: Buffer.from(execution.input_envelope),
    stdout: Buffer.from(execution.stdout),
    stderr: Buffer.from(execution.stderr),
    phase: 'ACTIVE',
  };
  const pending = copy(state);
  pendingRuns.set(pending, state);
  return pending;
}

export function snapshotPendingExecutableRun(value: unknown): PendingExecutableRun {
  const state = value !== null && typeof value === 'object' ? pendingRuns.get(value) : undefined;
  if (state === undefined) throw new TypeError('pending executable run was not runner-issued');
  return copy(state);
}

export function reservePendingExecutableRun(
  session: RepositoryExecutionSession,
  pending: PendingExecutableRun,
): PendingExecutableRunReservation {
  const state = pendingRuns.get(pending);
  if (state === undefined || state.session !== session || state.phase !== 'ACTIVE') {
    throw new TypeError('pending executable run does not belong to this session');
  }
  const reservation: PendingExecutableRunReservation = Object.freeze({
    contract_id: 'new-aria-pending-run-reservation-v1',
  });
  state.phase = 'RESERVED';
  state.reservation = reservation;
  reservedRuns.set(reservation, pending);
  return reservation;
}

function reservedState(reservation: PendingExecutableRunReservation): {
  readonly pending: PendingExecutableRun;
  readonly state: PendingRunState;
} {
  const pending = reservedRuns.get(reservation);
  const state = pending === undefined ? undefined : pendingRuns.get(pending);
  if (pending === undefined || state === undefined || state.reservation !== reservation) {
    throw new TypeError('pending executable run reservation is absent or inactive');
  }
  return { pending, state };
}

export function commitPendingExecutableRun(
  reservation: PendingExecutableRunReservation,
): PendingExecutableRun {
  const { pending, state } = reservedState(reservation);
  pendingRuns.delete(pending);
  reservedRuns.delete(reservation);
  return copy(state);
}

export function abortPendingExecutableRun(reservation: PendingExecutableRunReservation): void {
  const { state } = reservedState(reservation);
  state.phase = 'ACTIVE';
  delete state.reservation;
  reservedRuns.delete(reservation);
}
