import { isAbsolute, normalize } from 'node:path';

import { assertTrustedGitRepositoryTargetPort } from '../adapters/git/git-repository-target-port';
import { requireIdentifier } from '../kernel/identifiers';
import { requireCanonicalReviewedRef } from '../kernel/reviewed-ref';

import { validateRepositoryExecutionSnapshot } from './repository-execution-snapshot';
import type { RepositoryExecutionSnapshot } from './repository-execution-snapshot';
import type {
  RepositoryExecutionCapability,
  RepositoryExecutionReservation,
  RepositoryTargetPort,
  RepositoryTargetRequest,
  VerifiedRepositoryTarget,
} from './repository-target-contracts';

export type {
  RepositoryExecutionCapability,
  RepositoryExecutionReservation,
  RepositoryTargetPort,
  RepositoryTargetRequest,
  VerifiedRepositoryTarget,
} from './repository-target-contracts';

const sha40 = /^[a-f0-9]{40}$/u;
const sha64 = /^[a-f0-9]{64}$/u;
const verifiedTargets = new WeakSet<object>();
interface TargetCapabilityState {
  readonly port: RepositoryTargetPort;
  readonly snapshot: RepositoryExecutionSnapshot;
  phase: 'ISSUED' | 'RESERVED' | 'CONSUMED';
  reservation?: RepositoryExecutionReservation;
}
const targetCapabilities = new WeakMap<object, TargetCapabilityState>();
const reservationTargets = new WeakMap<object, object>();

export function assertVerifiedRepositoryTarget(
  value: unknown,
): asserts value is VerifiedRepositoryTarget {
  if (value === null || typeof value !== 'object' || !verifiedTargets.has(value)) {
    throw new TypeError('repository target is not verifier-issued');
  }
}

export function assertExecutableRepositoryTarget(target: VerifiedRepositoryTarget): void {
  assertVerifiedRepositoryTarget(target);
  const state = targetCapabilities.get(target);
  if (state === undefined) {
    throw new TypeError('repository target has no immutable execution snapshot');
  }
  assertTrustedGitRepositoryTargetPort(state.port);
}

export function revalidateExecutableRepositoryTarget(target: VerifiedRepositoryTarget): void {
  assertExecutableRepositoryTarget(target);
  const state = targetCapabilities.get(target);
  if (state === undefined) throw new TypeError('repository target capability is absent');
  revalidateTarget(target, state.port);
}

export function snapshotExecutableRepositoryTarget(
  target: VerifiedRepositoryTarget,
): RepositoryExecutionSnapshot {
  assertExecutableRepositoryTarget(target);
  const state = targetCapabilities.get(target);
  if (state === undefined) throw new TypeError('repository target capability is absent');
  return validateRepositoryExecutionSnapshot(state.snapshot, target.head_sha);
}

function validateRequest(request: RepositoryTargetRequest): void {
  requireIdentifier(request.repository_id, 'repository identifier');
  requireIdentifier(request.workspace_id, 'workspace identifier');
  if (
    !isAbsolute(request.repository_root) ||
    normalize(request.repository_root) !== request.repository_root
  ) {
    throw new TypeError('repository root must be an absolute canonical path');
  }
  requireCanonicalReviewedRef(request.reviewed_ref, 'canonical reviewed ref');
  if (!sha40.test(request.base_sha)) throw new TypeError('base SHA is invalid');
  if (!sha40.test(request.head_sha)) throw new TypeError('head SHA is invalid');
  if (request.base_sha === request.head_sha) throw new TypeError('empty target range is forbidden');
}

function revalidateTarget(target: VerifiedRepositoryTarget, port: RepositoryTargetPort): void {
  if (
    port.canonicalRoot(target.repository_root) !== target.repository_root ||
    port.resolveCommit(target.repository_root, target.reviewed_ref) !== target.head_sha ||
    port.objectType(target.repository_root, target.base_sha) !== 'commit' ||
    port.objectType(target.repository_root, target.head_sha) !== 'commit' ||
    !port.isAncestor(target.repository_root, target.base_sha, target.head_sha) ||
    port.mergeBase(target.repository_root, target.base_sha, target.head_sha) !== target.base_sha ||
    port.resolveCommit(target.repository_root, target.reviewed_ref) !== target.head_sha
  ) {
    throw new TypeError('repository target changed after verification');
  }
}

export function reserveRepositoryExecutionCapability(
  target: VerifiedRepositoryTarget,
): RepositoryExecutionReservation {
  assertExecutableRepositoryTarget(target);
  const state = targetCapabilities.get(target);
  if (state === undefined || state.phase !== 'ISSUED') {
    throw new TypeError('repository execution capability is absent, reserved, or consumed');
  }
  const reservation: RepositoryExecutionReservation = Object.freeze({
    contract_id: 'new-aria-repository-execution-reservation-v1',
  });
  state.phase = 'RESERVED';
  state.reservation = reservation;
  reservationTargets.set(reservation, target);
  return reservation;
}

function reservedTarget(reservation: RepositoryExecutionReservation): {
  readonly target: VerifiedRepositoryTarget;
  readonly state: TargetCapabilityState;
} {
  const target = reservationTargets.get(reservation);
  const state = target === undefined ? undefined : targetCapabilities.get(target);
  if (
    target === undefined ||
    state === undefined ||
    state.phase !== 'RESERVED' ||
    state.reservation !== reservation
  ) {
    throw new TypeError('repository execution reservation is absent or inactive');
  }
  assertVerifiedRepositoryTarget(target);
  return { target, state };
}

export function snapshotRepositoryExecutionReservation(
  reservation: RepositoryExecutionReservation,
): RepositoryExecutionCapability {
  const { target, state } = reservedTarget(reservation);
  return Object.freeze({
    snapshot: state.snapshot,
    revalidate: () => revalidateTarget(target, state.port),
  });
}

export function commitRepositoryExecutionReservation(
  reservation: RepositoryExecutionReservation,
): void {
  const { state } = reservedTarget(reservation);
  state.phase = 'CONSUMED';
  delete state.reservation;
  reservationTargets.delete(reservation);
}

export function abortRepositoryExecutionReservation(
  reservation: RepositoryExecutionReservation,
): void {
  const { state } = reservedTarget(reservation);
  state.phase = 'ISSUED';
  delete state.reservation;
  reservationTargets.delete(reservation);
}

function verifyTarget(
  request: RepositoryTargetRequest,
  port: RepositoryTargetPort,
  requireCurrentRef: boolean,
): VerifiedRepositoryTarget {
  validateRequest(request);
  const gitToolId = requireIdentifier(port.git_tool_id, 'Git verifier identifier');
  if (!sha64.test(port.git_sha256)) throw new TypeError('Git verifier digest is invalid');
  const repositoryRoot = port.canonicalRoot(request.repository_root);
  if (repositoryRoot !== request.repository_root) {
    throw new TypeError('repository canonical root mismatch');
  }
  const reviewedRefSha = requireCurrentRef
    ? port.resolveCommit(repositoryRoot, request.reviewed_ref)
    : request.head_sha;
  if (requireCurrentRef && reviewedRefSha !== request.head_sha) {
    throw new TypeError('reviewed ref does not resolve to the authorized head');
  }
  if (port.objectType(repositoryRoot, request.base_sha) !== 'commit') {
    throw new TypeError('base object is missing or is not a commit');
  }
  if (port.objectType(repositoryRoot, request.head_sha) !== 'commit') {
    throw new TypeError('head object is missing or is not a commit');
  }
  if (!port.isAncestor(repositoryRoot, request.base_sha, request.head_sha)) {
    throw new TypeError('authorized base is not an ancestor of head');
  }
  const mergeBaseSha = port.mergeBase(repositoryRoot, request.base_sha, request.head_sha);
  if (mergeBaseSha !== request.base_sha) {
    throw new TypeError('authorized base does not equal the merge base');
  }
  const snapshot = validateRepositoryExecutionSnapshot(
    port.captureExecutionSnapshot(repositoryRoot, request.head_sha),
    request.head_sha,
  );
  if (
    requireCurrentRef &&
    port.resolveCommit(repositoryRoot, request.reviewed_ref) !== reviewedRefSha
  ) {
    throw new TypeError('reviewed ref changed during target verification');
  }
  const result: VerifiedRepositoryTarget = Object.freeze({
    schema_version: '1.0.0',
    contract_id: 'new-aria-repository-target-v1',
    repository_id: request.repository_id,
    workspace_id: request.workspace_id,
    git_tool_id: gitToolId,
    git_tool_sha256: port.git_sha256,
    tree_sha: snapshot.tree_sha,
    repository_root: repositoryRoot,
    reviewed_ref: request.reviewed_ref,
    reviewed_ref_sha: reviewedRefSha,
    base_sha: request.base_sha,
    head_sha: request.head_sha,
    merge_base_sha: mergeBaseSha,
    ancestry: 'BASE_IS_ANCESTOR',
    verdict: 'ACCEPTED',
  });
  verifiedTargets.add(result);
  targetCapabilities.set(result, { port, snapshot, phase: 'ISSUED' });
  return result;
}

export function verifyRepositoryTarget(
  request: RepositoryTargetRequest,
  port: RepositoryTargetPort,
): VerifiedRepositoryTarget {
  return verifyTarget(request, port, true);
}

export function verifyHistoricalRepositoryTarget(
  request: RepositoryTargetRequest,
  port: RepositoryTargetPort,
): VerifiedRepositoryTarget {
  return verifyTarget(request, port, false);
}
