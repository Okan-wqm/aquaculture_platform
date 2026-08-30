import { dirname, resolve } from 'node:path';

import {
  assertRepositoryMutationAuthority,
  type RegistryMutationOperation,
  type RepositoryMutationAuthority,
} from '../github-actions-oidc-authority';

import { AnchoredFilesystemError } from './anchored-filesystem';
import { errorFromUnknown, errorWithCause } from './error-cause';
import {
  classifyFindingAuthorityTarget,
  FINDING_REGISTRY_RELATIVE_PATH,
  SOURCE_FINDING_MANIFEST_BASENAME,
  SOURCE_FINDING_PLAN_RELATIVE_PATH,
  type FindingAuthorityTarget,
} from './finding-authority-target-catalog';
import {
  FindingWriterRepositorySnapshotMismatchError,
  type FindingWriterRepositorySnapshot,
} from './finding-registry-writer-authority';

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
const SOURCE_FINDING_WRITER_FENCE_TRANSITION_BRAND: unique symbol = Symbol(
  'SOURCE_FINDING_WRITER_FENCE_TRANSITION_V1',
);

export interface FindingWriterWorktreeGeneration {
  readonly worktree_path: string;
  readonly head_oid: string;
  readonly allocator_present: boolean;
}

export interface FindingWriterWorktreeTopologyEntryV1 {
  readonly path: string;
  readonly headOid: string;
}

export interface FindingWriterWorktreeTopologyV1 {
  readonly schemaVersion: 1;
  readonly worktrees: readonly FindingWriterWorktreeTopologyEntryV1[];
}

export function defineFindingWriterWorktreeTopologyV1(
  worktrees: readonly FindingWriterWorktreeTopologyEntryV1[],
): FindingWriterWorktreeTopologyV1 {
  const canonical = [...worktrees]
    .map((worktree) => {
      const path = resolve(worktree.path);
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(worktree.headOid)) {
        throw new Error(`Finding writer worktree HEAD is not one exact object ID: ${path}`);
      }
      return Object.freeze({ path, headOid: worktree.headOid });
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (new Set(canonical.map((worktree) => worktree.path)).size !== canonical.length) {
    throw new Error('Finding writer worktree topology contains duplicate paths');
  }
  return Object.freeze({ schemaVersion: 1, worktrees: Object.freeze(canonical) });
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

export interface SourceFindingWriterFenceTransition {
  readonly kind: 'SOURCE_FINDING_WRITER_FENCE_TRANSITION_V1';
  readonly [SOURCE_FINDING_WRITER_FENCE_TRANSITION_BRAND]: true;
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
  readonly prepareSourceTransition: (
    transition: FindingWriterSourceTransitionV1,
  ) => FindingWriterAllocationSourceTransition;
}

export interface FindingWriterPreparedAllocationSourceTransition {
  readonly commit: () => void;
}

export interface FindingWriterAllocationSourceTransition {
  readonly assertBeforeCurrent: () => void;
  readonly prepareAfterCurrent: () => FindingWriterPreparedAllocationSourceTransition;
  readonly cancelBeforeCurrent: () => void;
}

export interface FindingWriterSourceTransitionV1 {
  readonly planDirectoryPath: string;
  readonly targetPath: string;
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
}

export class FindingWriterFenceGenerationMismatchError extends Error {
  public readonly code = 'FINDING_WRITER_FENCE_GENERATION_MISMATCH' as const;

  public constructor(message: string) {
    super(message);
    this.name = 'FindingWriterFenceGenerationMismatchError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const FINDING_WRITER_FENCE_STALE_ERROR_TOKEN: unique symbol = Symbol(
  'FINDING_WRITER_FENCE_STALE_ERROR_TOKEN',
);
const authenticFindingWriterFenceStaleErrors = new WeakSet<FindingWriterFenceStaleError>();

export class FindingWriterFenceStaleError extends Error {
  public readonly code = 'FINDING_WRITER_FENCE_STALE' as const;

  public constructor(
    public readonly admissionPhase: 'CONSUME' | 'REDEEM',
    public readonly cause: unknown,
    token: typeof FINDING_WRITER_FENCE_STALE_ERROR_TOKEN,
  ) {
    if (token !== FINDING_WRITER_FENCE_STALE_ERROR_TOKEN) {
      throw new Error('Finding writer stale errors can only be minted by the fence kernel');
    }
    super(
      `Finding writer prepared snapshot became stale during ${admissionPhase.toLowerCase()}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = 'FindingWriterFenceStaleError';
    Object.setPrototypeOf(this, new.target.prototype);
    authenticFindingWriterFenceStaleErrors.add(this);
  }
}

export function isAuthenticFindingWriterFenceStaleError(
  error: unknown,
): error is FindingWriterFenceStaleError {
  return (
    error instanceof FindingWriterFenceStaleError &&
    authenticFindingWriterFenceStaleErrors.has(error)
  );
}

function isFindingWriterFenceGenerationMismatch(error: unknown): boolean {
  return (
    error instanceof FindingWriterFenceGenerationMismatchError ||
    error instanceof FindingWriterRepositorySnapshotMismatchError ||
    error instanceof AnchoredFilesystemError
  );
}

function findingWriterFenceStaleError(
  admissionPhase: 'CONSUME' | 'REDEEM',
  cause: unknown,
): FindingWriterFenceStaleError {
  if (!isFindingWriterFenceGenerationMismatch(cause)) {
    if (cause instanceof Error) throw cause;
    throw errorWithCause('Finding writer currentness check threw a non-Error value', cause);
  }
  return new FindingWriterFenceStaleError(
    admissionPhase,
    cause,
    FINDING_WRITER_FENCE_STALE_ERROR_TOKEN,
  );
}

type InternalFindingWriterMutationProfile =
  | FindingWriterMutationProfile
  | { readonly kind: 'SOURCE_INVENTORY' };

interface PendingFindingWriterFenceState {
  readonly authority: FindingWriterFenceAuthority;
  readonly worktrees: readonly FindingWriterWorktreeGeneration[];
  readonly repositorySnapshots: readonly FindingWriterRepositorySnapshot[];
  readonly allocationFence: FindingWriterAllocationFence;
  readonly readWorktreeTopology: () => FindingWriterWorktreeTopologyV1;
  readonly readWorktreeTopologyAsync: (
    signal: AbortSignal,
  ) => Promise<FindingWriterWorktreeTopologyV1>;
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
interface PendingSourceFindingWriterFenceTransitionStateV1 {
  readonly session: SourceFindingWriterFenceSession;
  readonly capability: RedeemedFindingWriterFenceCapability;
  readonly leaseToken: string;
  readonly lockPath: string;
  readonly allocationTransition: FindingWriterAllocationSourceTransition;
}

const pendingSourceFindingWriterFenceTransitions = new WeakMap<
  SourceFindingWriterFenceTransition,
  PendingSourceFindingWriterFenceTransitionStateV1
>();
const activeSourceFindingWriterFenceTransitions = new WeakMap<
  SourceFindingWriterFenceSession,
  SourceFindingWriterFenceTransition
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
  assertFindingWriterFenceTopologyCurrent(state, state.readWorktreeTopology());
  state.allocationFence.assertCurrent();
  for (const repositorySnapshot of state.repositorySnapshots) repositorySnapshot.assertCurrent();
}

function expectedFindingWriterWorktreeTopology(
  state: ConsumedFindingWriterFenceState,
): FindingWriterWorktreeTopologyV1 {
  return defineFindingWriterWorktreeTopologyV1(
    state.worktrees.map((worktree) => ({
      path: worktree.worktree_path,
      headOid: worktree.head_oid,
    })),
  );
}

function topologyDescription(topology: FindingWriterWorktreeTopologyV1): string {
  return topology.worktrees.map((worktree) => `${worktree.path}@${worktree.headOid}`).join(',');
}

function assertFindingWriterFenceTopologyCurrent(
  state: ConsumedFindingWriterFenceState,
  current: FindingWriterWorktreeTopologyV1,
): void {
  const expected = expectedFindingWriterWorktreeTopology(state);
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new FindingWriterFenceGenerationMismatchError(
      `Finding writer worktree topology changed: expected=${topologyDescription(expected)} current=${topologyDescription(current)}`,
    );
  }
}

async function assertFindingWriterFenceTopologyCurrentAsync(
  state: ConsumedFindingWriterFenceState,
  signal: AbortSignal,
): Promise<void> {
  assertFindingWriterFenceTopologyCurrent(state, await state.readWorktreeTopologyAsync(signal));
}

async function assertFindingWriterFenceStateCurrentAsync(
  state: ConsumedFindingWriterFenceState,
  signal: AbortSignal,
): Promise<void> {
  await assertFindingWriterFenceTopologyCurrentAsync(state, signal);
  state.allocationFence.assertCurrent();
  for (const repositorySnapshot of state.repositorySnapshots) repositorySnapshot.assertCurrent();
  await assertFindingWriterFenceTopologyCurrentAsync(state, signal);
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
  readWorktreeTopology: () => FindingWriterWorktreeTopologyV1,
  readWorktreeTopologyAsync: (signal: AbortSignal) => Promise<FindingWriterWorktreeTopologyV1>,
  allocationFence: FindingWriterAllocationFence,
): void {
  const repositorySnapshots = findingWriterFenceRepositorySnapshots.get(snapshot);
  if (repositorySnapshots === undefined) {
    throw new Error('Finding writer fence lost its repository snapshots');
  }
  pendingFindingWriterFences.set(snapshot, {
    authority,
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
      prepareSourceTransition: allocationFence.prepareSourceTransition,
    }),
    readWorktreeTopology,
    readWorktreeTopologyAsync,
  });
}

export async function consumeFindingWriterFenceSnapshot(
  authority: FindingWriterFenceAuthority,
  snapshot: FindingWriterFenceSnapshot,
  signal: AbortSignal,
): Promise<FindingWriterFenceCapability> {
  const state = pendingFindingWriterFences.get(snapshot);
  pendingFindingWriterFences.delete(snapshot);
  if (state === undefined || state.authority !== authority) {
    throw new Error('Finding writer fence snapshot is foreign, fabricated, or already consumed');
  }
  const consumed = { ...state, generation: snapshot.generation };
  try {
    await assertFindingWriterFenceStateCurrentAsync(consumed, signal);
  } catch (error) {
    throw findingWriterFenceStaleError('CONSUME', error);
  }
  const capability = Object.freeze({
    kind: 'FINDING_WRITER_FENCE_CAPABILITY_V1' as const,
    generation: snapshot.generation,
    [FINDING_WRITER_FENCE_CAPABILITY_BRAND]: true as const,
  });
  consumedFindingWriterFences.set(capability, consumed);
  return capability;
}

async function redeemFindingWriterFenceCapability(
  authority: FindingWriterFenceAuthority,
  capability: FindingWriterFenceCapability,
  lease: FindingWriterFenceLease,
  profile: InternalFindingWriterMutationProfile,
  signal: AbortSignal,
): Promise<RedeemedFindingWriterFenceCapability> {
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
  try {
    // Consume owns the full admission proof. Redemption only closes the synchronous gap by
    // rechecking the exact active-worktree/HEAD topology before a mutation profile is attached.
    await assertFindingWriterFenceTopologyCurrentAsync(state, signal);
  } catch (error) {
    throw findingWriterFenceStaleError('REDEEM', error);
  }
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
  signal: AbortSignal,
): Promise<RedeemedFindingWriterFenceCapability> {
  return redeemFindingWriterFenceCapability(authority, capability, lease, profile, signal);
}

/**
 * Open the opaque session consumed by the closed source-inventory facade. No callback or redeemed
 * capability is returned, so a caller cannot become a generic mutation issuer.
 */
export async function openSourceFindingWriterFenceSession(
  authority: FindingWriterFenceAuthority,
  capability: FindingWriterFenceCapability,
  lease: FindingWriterFenceLease,
  signal: AbortSignal,
): Promise<SourceFindingWriterFenceSession> {
  const writerFence = await redeemFindingWriterFenceCapability(
    authority,
    capability,
    lease,
    {
      kind: 'SOURCE_INVENTORY',
    },
    signal,
  );
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
  const state = redeemedFindingWriterFences.get(capability);
  if (state === undefined || state.authority !== authority) {
    throw new Error('Finding writer fence capability is foreign, fabricated, or already released');
  }
  const pendingTransition = activeSourceFindingWriterFenceTransitions.get(session);
  if (pendingTransition !== undefined) {
    pendingSourceFindingWriterFenceTransitions.delete(pendingTransition);
    activeSourceFindingWriterFenceTransitions.delete(session);
  }
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
  assertFindingWriterFenceTopologyCurrent(state, state.readWorktreeTopology());
  state.allocationFence.assertRegistryTransition(registryPath, contentSha256);
}

export function assertSourceFindingWriterFenceSessionCurrent(
  session: SourceFindingWriterFenceSession,
  lease: FindingWriterFenceLease,
): void {
  assertFindingWriterFenceCurrent(sourceFindingWriterFenceCapability(session), lease);
}

function pendingSourceFindingWriterFenceTransitionState(
  transition: SourceFindingWriterFenceTransition,
  session: SourceFindingWriterFenceSession,
  lease: FindingWriterFenceLease,
): PendingSourceFindingWriterFenceTransitionStateV1 {
  const pending = pendingSourceFindingWriterFenceTransitions.get(transition);
  const capability = sourceFindingWriterFenceCapability(session);
  if (
    pending === undefined ||
    pending.session !== session ||
    pending.capability !== capability ||
    pending.leaseToken !== lease.token ||
    pending.lockPath !== lease.lockPath ||
    activeSourceFindingWriterFenceTransitions.get(session) !== transition
  ) {
    throw new Error('Finding writer source transition is foreign, stale, or already consumed');
  }
  return pending;
}

function consumeSourceFindingWriterFenceTransition(
  transition: SourceFindingWriterFenceTransition,
  pending: PendingSourceFindingWriterFenceTransitionStateV1,
): void {
  pendingSourceFindingWriterFenceTransitions.delete(transition);
  activeSourceFindingWriterFenceTransitions.delete(pending.session);
}

export function prepareSourceFindingWriterFenceSessionTransition(
  session: SourceFindingWriterFenceSession,
  lease: FindingWriterFenceLease,
  transition: FindingWriterSourceTransitionV1,
): SourceFindingWriterFenceTransition {
  if (activeSourceFindingWriterFenceTransitions.has(session)) {
    throw new Error('Finding writer source session already has one pending transition');
  }
  const capability = sourceFindingWriterFenceCapability(session);
  const state = redeemedFindingWriterFenceState(capability, lease);
  if (state.profile.kind !== 'SOURCE_INVENTORY') {
    throw new Error('Finding writer source transition requires the source-inventory profile');
  }
  const target = classifyFindingAuthorityTarget(transition.targetPath);
  if (
    target === null ||
    (target.kind !== 'SOURCE_MANIFEST' &&
      target.kind !== 'SOURCE_ARTIFACT' &&
      target.kind !== 'SOURCE_LEGACY_ARTIFACT')
  ) {
    throw new Error(
      `Finding writer source transition target is not governed: ${transition.targetPath}`,
    );
  }
  assertFindingWriterFenceTargetProfileAuthorized(
    state,
    lease,
    target,
    transition.afterSha256 === null ? 'UNLINK' : 'WRITE',
  );
  assertFindingWriterFenceStateCurrent(state);
  const allocationTransition = state.allocationFence.prepareSourceTransition(transition);
  const pending = Object.freeze({
    kind: 'SOURCE_FINDING_WRITER_FENCE_TRANSITION_V1' as const,
    [SOURCE_FINDING_WRITER_FENCE_TRANSITION_BRAND]: true as const,
  });
  pendingSourceFindingWriterFenceTransitions.set(pending, {
    session,
    capability,
    leaseToken: lease.token,
    lockPath: lease.lockPath,
    allocationTransition,
  });
  activeSourceFindingWriterFenceTransitions.set(session, pending);
  return pending;
}

function prepareSourceFindingWriterFenceTransitionAfterCurrent(
  pending: PendingSourceFindingWriterFenceTransitionStateV1,
  lease: FindingWriterFenceLease,
): FindingWriterPreparedAllocationSourceTransition {
  const state = redeemedFindingWriterFenceState(pending.capability, lease);
  assertFindingWriterFenceTopologyCurrent(state, state.readWorktreeTopology());
  const prepared = pending.allocationTransition.prepareAfterCurrent();
  assertFindingWriterFenceTopologyCurrent(state, state.readWorktreeTopology());
  return prepared;
}

export function assertPendingSourceFindingWriterFenceSessionTransitionBeforeCurrent(
  transition: SourceFindingWriterFenceTransition,
  session: SourceFindingWriterFenceSession,
  lease: FindingWriterFenceLease,
): void {
  const pending = pendingSourceFindingWriterFenceTransitionState(transition, session, lease);
  const state = redeemedFindingWriterFenceState(pending.capability, lease);
  assertFindingWriterFenceTopologyCurrent(state, state.readWorktreeTopology());
  pending.allocationTransition.assertBeforeCurrent();
  assertFindingWriterFenceTopologyCurrent(state, state.readWorktreeTopology());
}

export function commitSourceFindingWriterFenceSessionTransition(
  transition: SourceFindingWriterFenceTransition,
  session: SourceFindingWriterFenceSession,
  lease: FindingWriterFenceLease,
): void {
  const pending = pendingSourceFindingWriterFenceTransitionState(transition, session, lease);
  const prepared = prepareSourceFindingWriterFenceTransitionAfterCurrent(pending, lease);
  prepared.commit();
  consumeSourceFindingWriterFenceTransition(transition, pending);
}

export function rollbackPendingSourceFindingWriterFenceSessionTransition(
  transition: SourceFindingWriterFenceTransition,
  session: SourceFindingWriterFenceSession,
  lease: FindingWriterFenceLease,
  restoreRawBeforeImage: (assertAfterCurrent: () => void) => void,
): void {
  const pending = pendingSourceFindingWriterFenceTransitionState(transition, session, lease);
  const state = redeemedFindingWriterFenceState(pending.capability, lease);
  let beforeFailure: unknown;
  try {
    assertFindingWriterFenceStateCurrent(state);
    pending.allocationTransition.cancelBeforeCurrent();
    consumeSourceFindingWriterFenceTransition(transition, pending);
    return;
  } catch (error) {
    beforeFailure = error;
  }

  const assertAfterCurrent = (): void => {
    prepareSourceFindingWriterFenceTransitionAfterCurrent(pending, lease);
  };
  try {
    assertAfterCurrent();
  } catch (afterError) {
    throw new AggregateError(
      [
        errorFromUnknown('Source transition before-image check failed.', beforeFailure),
        errorFromUnknown('Source transition after-image check failed.', afterError),
      ],
      'Pending source transition is neither its exact before-image nor its exact after-image',
    );
  }

  try {
    restoreRawBeforeImage(assertAfterCurrent);
  } catch (restoreError) {
    try {
      assertFindingWriterFenceStateCurrent(state);
      pending.allocationTransition.cancelBeforeCurrent();
      consumeSourceFindingWriterFenceTransition(transition, pending);
    } catch (currentnessError) {
      throw new AggregateError(
        [
          errorFromUnknown('Source transition raw rollback failed.', restoreError),
          errorFromUnknown('Source transition rollback currentness failed.', currentnessError),
        ],
        'Source transition rollback failed and did not recover its exact before-image',
      );
    }
    throw restoreError;
  }

  assertFindingWriterFenceStateCurrent(state);
  pending.allocationTransition.cancelBeforeCurrent();
  consumeSourceFindingWriterFenceTransition(transition, pending);
}

function assertFindingWriterFenceTargetProfileAuthorized(
  state: RedeemedFindingWriterFenceState,
  lease: FindingWriterFenceLease,
  target: FindingAuthorityTarget,
  action: 'WRITE' | 'UNLINK' | 'RECOVER',
  repositoryAuthority?: RepositoryMutationAuthority,
  operation?: RegistryMutationOperation,
): void {
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

export function assertFindingWriterFenceTargetAuthorized(
  capability: RedeemedFindingWriterFenceCapability,
  lease: FindingWriterFenceLease,
  target: FindingAuthorityTarget,
  action: 'WRITE' | 'UNLINK' | 'RECOVER',
  repositoryAuthority?: RepositoryMutationAuthority,
  operation?: RegistryMutationOperation,
): void {
  assertFindingWriterFenceTargetProfileAuthorized(
    redeemedFindingWriterFenceState(capability, lease),
    lease,
    target,
    action,
    repositoryAuthority,
    operation,
  );
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
  assertFindingWriterFenceTargetProfileAuthorized(
    state,
    lease,
    target,
    action,
    repositoryAuthority,
    operation,
  );
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
