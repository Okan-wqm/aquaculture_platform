import { dirname, resolve } from 'node:path';

import {
  assertRepositoryMutationAuthority,
  type RegistryMutationOperation,
  type RepositoryMutationAuthority,
} from '../github-actions-oidc-authority';
import {
  FINDING_REGISTRY_RELATIVE_PATH,
  SOURCE_FINDING_MANIFEST_BASENAME,
  SOURCE_FINDING_PLAN_RELATIVE_PATH,
  type FindingAuthorityTarget,
} from './finding-authority-target-catalog';
import type { FindingWriterRepositorySnapshot } from './finding-registry-writer-authority';

const FINDING_WRITER_FENCE_SNAPSHOT_BRAND: unique symbol = Symbol(
  'FINDING_WRITER_FENCE_SNAPSHOT_V1',
);
const FINDING_WRITER_FENCE_CAPABILITY_BRAND: unique symbol = Symbol(
  'FINDING_WRITER_FENCE_CAPABILITY_V1',
);
const REDEEMED_FINDING_WRITER_FENCE_CAPABILITY_BRAND: unique symbol = Symbol(
  'REDEEMED_FINDING_WRITER_FENCE_CAPABILITY_V1',
);
const SOURCE_FINDING_WRITER_FENCE_SESSION_BRAND: unique symbol = Symbol(
  'SOURCE_FINDING_WRITER_FENCE_SESSION_V1',
);

export interface FindingWriterWorktreeGeneration {
  readonly worktree_path: string;
  readonly head_oid: string;
  readonly allocator_present: boolean;
}

export interface FindingWriterFenceSnapshot {
  readonly kind: 'FINDING_WRITER_FENCE_SNAPSHOT_V1';
  readonly generation: string;
  readonly worktrees: readonly FindingWriterWorktreeGeneration[];
  readonly [FINDING_WRITER_FENCE_SNAPSHOT_BRAND]: true;
}

export interface FindingWriterFenceCapability {
  readonly kind: 'FINDING_WRITER_FENCE_CAPABILITY_V1';
  readonly generation: string;
  readonly [FINDING_WRITER_FENCE_CAPABILITY_BRAND]: true;
}

export interface RedeemedFindingWriterFenceCapability {
  readonly kind: 'REDEEMED_FINDING_WRITER_FENCE_CAPABILITY_V1';
  readonly generation: string;
  readonly [REDEEMED_FINDING_WRITER_FENCE_CAPABILITY_BRAND]: true;
}

/**
 * Opaque source-publication session. The redeemed mutation capability never crosses this boundary:
 * callers can only ask the fence/store kernels to perform their closed source-profile operations.
 */
export interface SourceFindingWriterFenceSession {
  readonly kind: 'SOURCE_FINDING_WRITER_FENCE_SESSION_V1';
  readonly generation: string;
  readonly [SOURCE_FINDING_WRITER_FENCE_SESSION_BRAND]: true;
}

export interface FindingWriterMutationProfile {
  readonly kind: 'REGISTRY_MUTATION';
  readonly operation: RegistryMutationOperation;
  readonly repositoryAuthority: RepositoryMutationAuthority;
}

export interface FindingWriterFenceLease {
  readonly lockPath: string;
  readonly resourcePath: string;
  readonly token: string;
}

export interface FindingWriterFenceAuthority {
  readonly repoRoot: string;
  readonly lockPath: string;
  readonly reservationPath: string;
}

export interface FindingWriterAllocationSnapshot {
  readonly registryPaths: readonly string[];
  readonly claimedIds: readonly string[];
  readonly orphanReservedIds: readonly string[];
  readonly reservedDomainFloors: Readonly<Record<string, number>>;
}

export interface FindingWriterAllocationFence {
  readonly snapshot: FindingWriterAllocationSnapshot;
  readonly assertCurrent: () => void;
  readonly assertRegistryTransition: (registryPath: string, contentSha256: string) => void;
}

type InternalFindingWriterMutationProfile =
  | FindingWriterMutationProfile
  | { readonly kind: 'SOURCE_INVENTORY' };

interface PendingFindingWriterFenceState {
  readonly authority: FindingWriterFenceAuthority;
  readonly activeWorktreePaths: readonly string[];
  readonly worktrees: readonly FindingWriterWorktreeGeneration[];
  readonly repositorySnapshots: readonly FindingWriterRepositorySnapshot[];
  readonly allocationFence: FindingWriterAllocationFence;
  readonly readActiveWorktreePaths: () => readonly string[];
  readonly assertWorktreeGeneration: (generation: FindingWriterWorktreeGeneration) => void;
}

interface ConsumedFindingWriterFenceState extends PendingFindingWriterFenceState {
  readonly generation: string;
}

interface RedeemedFindingWriterFenceState extends ConsumedFindingWriterFenceState {
  readonly leaseToken: string;
  readonly lockPath: string;
  readonly profile: InternalFindingWriterMutationProfile;
}

const pendingFindingWriterFences = new WeakMap<
  FindingWriterFenceSnapshot,
  PendingFindingWriterFenceState
>();
const consumedFindingWriterFences = new WeakMap<
  FindingWriterFenceCapability,
  ConsumedFindingWriterFenceState
>();
const redeemedFindingWriterFences = new WeakMap<
  RedeemedFindingWriterFenceCapability,
  RedeemedFindingWriterFenceState
>();
const sourceFindingWriterFenceSessions = new WeakMap<
  SourceFindingWriterFenceSession,
  RedeemedFindingWriterFenceCapability
>();
const findingWriterFenceRepositorySnapshots = new WeakMap<
  FindingWriterFenceSnapshot,
  readonly FindingWriterRepositorySnapshot[]
>();

function canonicalFindingWriterMutationProfile(
  profile: InternalFindingWriterMutationProfile,
  authority: FindingWriterFenceAuthority,
  lease: FindingWriterFenceLease,
): InternalFindingWriterMutationProfile {
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
    throw new Error('Finding writer mutation profile must be one closed object');
  }
  if (profile.kind === 'SOURCE_INVENTORY') {
    if (Object.keys(profile).length !== 1) {
      throw new Error('Finding writer source profile contains unknown authority fields');
    }
    const expectedResource = resolve(
      authority.repoRoot,
      SOURCE_FINDING_PLAN_RELATIVE_PATH,
      SOURCE_FINDING_MANIFEST_BASENAME,
    );
    if (lease.resourcePath !== expectedResource) {
      throw new Error(`Finding writer source profile is bound to ${expectedResource}`);
    }
    return Object.freeze({ kind: 'SOURCE_INVENTORY' });
  }
  if (
    profile.kind !== 'REGISTRY_MUTATION' ||
    Object.keys(profile).sort().join('\0') !==
      ['kind', 'operation', 'repositoryAuthority'].sort().join('\0')
  ) {
    throw new Error('Finding writer registry profile is malformed');
  }
  assertRepositoryMutationAuthority(profile.repositoryAuthority, profile.operation);
  const expectedResource = resolve(authority.repoRoot, FINDING_REGISTRY_RELATIVE_PATH);
  if (lease.resourcePath !== expectedResource) {
    throw new Error(`Finding writer registry profile is bound to ${expectedResource}`);
  }
  return Object.freeze({
    kind: 'REGISTRY_MUTATION',
    operation: profile.operation,
    repositoryAuthority: profile.repositoryAuthority,
  });
}

function assertFindingWriterFenceStateCurrent(state: ConsumedFindingWriterFenceState): void {
  assertFindingWriterFenceTopologyCurrent(state);
  state.allocationFence.assertCurrent();
  for (const repositorySnapshot of state.repositorySnapshots) repositorySnapshot.assertCurrent();
}

function assertFindingWriterFenceTopologyCurrent(state: ConsumedFindingWriterFenceState): void {
  const currentActivePaths = [...state.readActiveWorktreePaths()];
  if (JSON.stringify(currentActivePaths) !== JSON.stringify(state.activeWorktreePaths)) {
    throw new Error(
      `Finding writer active worktree set changed: expected=${state.activeWorktreePaths.join(',')} current=${currentActivePaths.join(',')}`,
    );
  }
  for (const generation of state.worktrees) state.assertWorktreeGeneration(generation);
}

function redeemedFindingWriterFenceState(
  capability: RedeemedFindingWriterFenceCapability,
  lease: FindingWriterFenceLease,
): RedeemedFindingWriterFenceState {
  const state = redeemedFindingWriterFences.get(capability);
  if (
    state === undefined ||
    state.leaseToken !== lease.token ||
    state.lockPath !== lease.lockPath
  ) {
    throw new Error(
      'Finding writer side effect requires a live redeemed capability for the held lease',
    );
  }
  return state;
}

export function createFindingWriterFenceSnapshot(
  generation: string,
  worktrees: readonly FindingWriterWorktreeGeneration[],
  repositorySnapshots: readonly FindingWriterRepositorySnapshot[],
): FindingWriterFenceSnapshot {
  const frozenWorktrees = Object.freeze(
    worktrees.map((worktree) =>
      Object.freeze({
        worktree_path: worktree.worktree_path,
        head_oid: worktree.head_oid,
        allocator_present: worktree.allocator_present,
      }),
    ),
  );
  const snapshot = Object.freeze({
    kind: 'FINDING_WRITER_FENCE_SNAPSHOT_V1' as const,
    generation,
    worktrees: frozenWorktrees,
    [FINDING_WRITER_FENCE_SNAPSHOT_BRAND]: true as const,
  });
  findingWriterFenceRepositorySnapshots.set(snapshot, Object.freeze([...repositorySnapshots]));
  return snapshot;
}

export function prepareFindingWriterFenceSnapshot(
  authority: FindingWriterFenceAuthority,
  snapshot: FindingWriterFenceSnapshot,
  activeWorktreePaths: readonly string[],
  readActiveWorktreePaths: () => readonly string[],
  assertWorktreeGeneration: (generation: FindingWriterWorktreeGeneration) => void,
  allocationFence: FindingWriterAllocationFence,
): void {
  const repositorySnapshots = findingWriterFenceRepositorySnapshots.get(snapshot);
  if (repositorySnapshots === undefined) {
    throw new Error('Finding writer fence lost its repository snapshots');
  }
  pendingFindingWriterFences.set(snapshot, {
    authority,
    activeWorktreePaths: Object.freeze([...activeWorktreePaths]),
    worktrees: snapshot.worktrees,
    repositorySnapshots,
    allocationFence: Object.freeze({
      snapshot: Object.freeze({
        registryPaths: Object.freeze([...allocationFence.snapshot.registryPaths]),
        claimedIds: Object.freeze([...allocationFence.snapshot.claimedIds]),
        orphanReservedIds: Object.freeze([...allocationFence.snapshot.orphanReservedIds]),
        reservedDomainFloors: Object.freeze({
          ...allocationFence.snapshot.reservedDomainFloors,
        }),
      }),
      assertCurrent: allocationFence.assertCurrent,
      assertRegistryTransition: allocationFence.assertRegistryTransition,
    }),
    readActiveWorktreePaths,
    assertWorktreeGeneration,
  });
}

export function consumeFindingWriterFenceSnapshot(
  authority: FindingWriterFenceAuthority,
  snapshot: FindingWriterFenceSnapshot,
): FindingWriterFenceCapability {
  const state = pendingFindingWriterFences.get(snapshot);
  pendingFindingWriterFences.delete(snapshot);
  if (state === undefined || state.authority !== authority) {
    throw new Error('Finding writer fence snapshot is foreign, fabricated, or already consumed');
  }
  const consumed = { ...state, generation: snapshot.generation };
  assertFindingWriterFenceStateCurrent(consumed);
  const capability = Object.freeze({
    kind: 'FINDING_WRITER_FENCE_CAPABILITY_V1' as const,
    generation: snapshot.generation,
    [FINDING_WRITER_FENCE_CAPABILITY_BRAND]: true as const,
  });
  consumedFindingWriterFences.set(capability, consumed);
  return capability;
}

function redeemFindingWriterFenceCapability(
  authority: FindingWriterFenceAuthority,
  capability: FindingWriterFenceCapability,
  lease: FindingWriterFenceLease,
  profile: InternalFindingWriterMutationProfile,
): RedeemedFindingWriterFenceCapability {
  const state = consumedFindingWriterFences.get(capability);
  consumedFindingWriterFences.delete(capability);
  if (
    state === undefined ||
    state.authority !== authority ||
    lease.lockPath !== authority.lockPath
  ) {
    throw new Error(
      'Finding writer fence capability is foreign, fabricated, already redeemed, or bound to another lease',
    );
  }
  assertFindingWriterFenceStateCurrent(state);
  const canonicalProfile = canonicalFindingWriterMutationProfile(profile, authority, lease);
  const redeemed = Object.freeze({
    kind: 'REDEEMED_FINDING_WRITER_FENCE_CAPABILITY_V1' as const,
    generation: state.generation,
    [REDEEMED_FINDING_WRITER_FENCE_CAPABILITY_BRAND]: true as const,
  });
  redeemedFindingWriterFences.set(redeemed, {
    ...state,
    leaseToken: lease.token,
    lockPath: lease.lockPath,
    profile: canonicalProfile,
  });
  return redeemed;
}

export function redeemRegistryFindingWriterFence(
  authority: FindingWriterFenceAuthority,
  capability: FindingWriterFenceCapability,
  lease: FindingWriterFenceLease,
  profile: FindingWriterMutationProfile,
): RedeemedFindingWriterFenceCapability {
  return redeemFindingWriterFenceCapability(authority, capability, lease, profile);
}

/**
 * Open the opaque session consumed by the closed source-inventory facade. No callback or redeemed
 * capability is returned, so a caller cannot become a generic mutation issuer.
 */
export function openSourceFindingWriterFenceSession(
  authority: FindingWriterFenceAuthority,
  capability: FindingWriterFenceCapability,
  lease: FindingWriterFenceLease,
): SourceFindingWriterFenceSession {
  const writerFence = redeemFindingWriterFenceCapability(authority, capability, lease, {
    kind: 'SOURCE_INVENTORY',
  });
  const session = Object.freeze({
    kind: 'SOURCE_FINDING_WRITER_FENCE_SESSION_V1' as const,
    generation: writerFence.generation,
    [SOURCE_FINDING_WRITER_FENCE_SESSION_BRAND]: true as const,
  });
  sourceFindingWriterFenceSessions.set(session, writerFence);
  return session;
}

function sourceFindingWriterFenceCapability(
  session: SourceFindingWriterFenceSession,
): RedeemedFindingWriterFenceCapability {
  const capability = sourceFindingWriterFenceSessions.get(session);
  if (capability === undefined) {
    throw new Error('Finding writer source session is foreign, fabricated, or already closed');
  }
  return capability;
}

export function closeSourceFindingWriterFenceSession(
  authority: FindingWriterFenceAuthority,
  session: SourceFindingWriterFenceSession,
): void {
  const capability = sourceFindingWriterFenceCapability(session);
  releaseFindingWriterFence(authority, capability);
  sourceFindingWriterFenceSessions.delete(session);
}

export function releaseFindingWriterFence(
  authority: FindingWriterFenceAuthority,
  capability: RedeemedFindingWriterFenceCapability,
): void {
  const state = redeemedFindingWriterFences.get(capability);
  if (state === undefined || state.authority !== authority) {
    throw new Error('Finding writer fence capability is foreign, fabricated, or already released');
  }
  redeemedFindingWriterFences.delete(capability);
}

export function assertFindingWriterFenceAuthority(
  capability: RedeemedFindingWriterFenceCapability,
  lease: FindingWriterFenceLease,
  authority: FindingWriterFenceAuthority,
): void {
  const state = redeemedFindingWriterFenceState(capability, lease);
  if (state.authority !== authority) {
    throw new Error('Finding writer operation received a foreign finding writer fence');
  }
  assertFindingWriterFenceStateCurrent(state);
}

export function assertFindingWriterFenceCurrent(
  capability: RedeemedFindingWriterFenceCapability,
  lease: FindingWriterFenceLease,
): void {
  assertFindingWriterFenceStateCurrent(redeemedFindingWriterFenceState(capability, lease));
}

export function readFindingWriterAllocationSnapshot(
  capability: RedeemedFindingWriterFenceCapability,
  lease: FindingWriterFenceLease,
): FindingWriterAllocationSnapshot {
  const state = redeemedFindingWriterFenceState(capability, lease);
  assertFindingWriterFenceStateCurrent(state);
  return state.allocationFence.snapshot;
}

export function assertFindingWriterFenceRegistryTransition(
  capability: RedeemedFindingWriterFenceCapability,
  lease: FindingWriterFenceLease,
  registryPath: string,
  contentSha256: string,
): void {
  const state = redeemedFindingWriterFenceState(capability, lease);
  if (state.profile.kind !== 'REGISTRY_MUTATION' || registryPath !== lease.resourcePath) {
    throw new Error('Finding writer registry transition is outside its redeemed profile');
  }
  assertFindingWriterFenceTopologyCurrent(state);
  state.allocationFence.assertRegistryTransition(registryPath, contentSha256);
}

export function assertSourceFindingWriterFenceSessionCurrent(
  session: SourceFindingWriterFenceSession,
  lease: FindingWriterFenceLease,
): void {
  assertFindingWriterFenceCurrent(sourceFindingWriterFenceCapability(session), lease);
}

export function assertFindingWriterFenceTargetCurrent(
  capability: RedeemedFindingWriterFenceCapability,
  lease: FindingWriterFenceLease,
  target: FindingAuthorityTarget,
  action: 'WRITE' | 'UNLINK' | 'RECOVER',
  repositoryAuthority?: RepositoryMutationAuthority,
  operation?: RegistryMutationOperation,
): void {
  const state = redeemedFindingWriterFenceState(capability, lease);
  assertFindingWriterFenceStateCurrent(state);
  if (target.kind === 'REGISTRY' || target.kind === 'RESERVATION') {
    if (state.profile.kind !== 'REGISTRY_MUTATION') {
      throw new Error(`Finding writer source profile cannot mutate ${target.kind.toLowerCase()}`);
    }
    const expectedPath =
      target.kind === 'REGISTRY'
        ? target.path === lease.resourcePath
        : target.path === state.authority.reservationPath;
    if (!expectedPath) {
      throw new Error(`Finding writer target is outside its repository authority: ${target.path}`);
    }
    if (
      target.kind === 'REGISTRY' &&
      (repositoryAuthority === undefined ||
        operation === undefined ||
        state.profile.repositoryAuthority !== repositoryAuthority ||
        state.profile.operation !== operation)
    ) {
      throw new Error(
        'Finding writer registry profile does not match the OIDC operation authority',
      );
    }
    if (
      target.kind === 'RESERVATION' &&
      (state.profile.operation !== 'add' || action === 'UNLINK')
    ) {
      throw new Error(
        `Finding writer ${state.profile.operation} profile cannot ${action.toLowerCase()} reservation`,
      );
    }
    return;
  }
  if (state.profile.kind !== 'SOURCE_INVENTORY') {
    throw new Error(`Finding writer registry profile cannot mutate ${target.kind.toLowerCase()}`);
  }
  const sourceRoot = resolve(state.authority.repoRoot, SOURCE_FINDING_PLAN_RELATIVE_PATH);
  if (dirname(target.path) !== sourceRoot) {
    throw new Error(
      `Finding writer source target is outside its repository authority: ${target.path}`,
    );
  }
  if (target.kind === 'SOURCE_MANIFEST' && action === 'UNLINK') {
    throw new Error('Finding writer source manifest is a non-deletable commit marker');
  }
}

export function assertSourceFindingWriterFenceSessionTargetCurrent(
  session: SourceFindingWriterFenceSession,
  lease: FindingWriterFenceLease,
  target: FindingAuthorityTarget,
  action: 'WRITE' | 'UNLINK' | 'RECOVER',
): void {
  assertFindingWriterFenceTargetCurrent(
    sourceFindingWriterFenceCapability(session),
    lease,
    target,
    action,
  );
}
