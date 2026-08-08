import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  classifyFindingAuthorityTarget,
  FINDING_AUTHORITY_TRANSACTION_MAX_BYTES,
  findingAuthorityTargetMaxBytes,
  type FindingAuthorityTarget,
} from './lib/finding-authority-target-catalog';
import {
  assertFindingWriterFenceRegistryTransition,
  assertFindingWriterFenceTargetCurrent,
  assertSourceFindingWriterFenceSessionTargetCurrent,
  type RedeemedFindingWriterFenceCapability,
  type SourceFindingWriterFenceSession,
} from './lib/finding-writer-fence';
import {
  assertAnchoredDirectoryChainIdentityCurrent,
  assertStablePathKindCurrent,
  closeAnchoredDirectoryChain,
  decodeFatalUtf8,
  openAnchoredDirectoryChain,
  openHermeticExecutableAuthority,
  observeStablePathKind,
  observeStableRegularFile,
  type AnchoredDirectoryChainV1,
  type HermeticExecutableAuthorityV1,
} from './lib/anchored-filesystem';

import {
  assertRepositoryMutationAuthority,
  type RegistryMutationOperation,
  type RepositoryMutationAuthority,
} from './github-actions-oidc-authority';

export type FindingSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface RegistryLockOptions {
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly lockPath?: string;
}

export interface RegistryLockLease {
  readonly lockPath: string;
  readonly resourcePath: string;
  readonly token: string;
}

const GOVERNED_FINDING_COMPENSATION_BRAND: unique symbol = Symbol(
  'GOVERNED_FINDING_COMPENSATION_V1',
);

export interface GovernedFindingCompensationAuthorization {
  readonly kind: 'GOVERNED_FINDING_COMPENSATION_V1';
  readonly [GOVERNED_FINDING_COMPENSATION_BRAND]: true;
}

interface GovernedFindingCompensationState {
  readonly leaseToken: string;
  readonly lockPath: string;
  readonly beforeImages: ReadonlyMap<
    string,
    { readonly target: FindingAuthorityTarget; readonly content: string | null }
  >;
}

const governedFindingCompensations = new WeakMap<
  GovernedFindingCompensationAuthorization,
  GovernedFindingCompensationState
>();

interface AnchoredFindingMutationTarget {
  readonly parentPath: string;
  readonly parentFd: number;
  readonly parentChain: AnchoredDirectoryChainV1;
  readonly targetPath: string;
}

function openAnchoredFindingMutationTarget(filePath: string): AnchoredFindingMutationTarget {
  const parentPath = dirname(filePath);
  const parentChain = openAnchoredDirectoryChain(parentPath, 'Finding mutation target parent');
  return {
    parentPath,
    parentFd: parentChain.descriptor,
    parentChain,
    targetPath: `/proc/self/fd/${String(parentChain.descriptor)}/${basename(filePath)}`,
  };
}

function closeAnchoredFindingMutationTarget(target: AnchoredFindingMutationTarget): void {
  closeAnchoredDirectoryChain(target.parentChain);
}

function assertAnchoredFindingMutationParentCurrent(target: AnchoredFindingMutationTarget): void {
  assertAnchoredDirectoryChainIdentityCurrent(target.parentChain, 'Finding mutation target parent');
}

function unlinkFindingFileAnchored(filePath: string, beforeCommit: () => void = () => {}): void {
  const anchored = openAnchoredFindingMutationTarget(filePath);
  try {
    assertAnchoredFindingMutationParentCurrent(anchored);
    beforeCommit();
    assertAnchoredFindingMutationParentCurrent(anchored);
    unlinkSync(anchored.targetPath);
    fsyncSync(anchored.parentFd);
    assertAnchoredFindingMutationParentCurrent(anchored);
  } finally {
    closeAnchoredFindingMutationTarget(anchored);
  }
}

function readGovernedFindingBeforeImage(target: FindingAuthorityTarget): string | null {
  const { path } = target;
  const pathKind = observeStablePathKind(path, 'Governed finding before-image path');
  if (pathKind.kind === 'MISSING') {
    assertStablePathKindCurrent(pathKind, 'Governed finding before-image path');
    return null;
  }
  if (pathKind.kind !== 'FILE') {
    throw new Error(`Governed finding compensation target is not a regular file: ${path}`);
  }
  const observed = observeStableRegularFile(
    path,
    findingAuthorityTargetMaxBytes(target),
    'Governed finding compensation target',
  );
  assertStablePathKindCurrent(pathKind, 'Governed finding before-image path');
  return decodeFatalUtf8(observed.content, `Governed finding compensation target ${path}`);
}

function captureGovernedFindingCompensation(
  lease: RegistryLockLease,
  writerFence: RedeemedFindingWriterFenceCapability | SourceFindingWriterFenceSession,
  paths: readonly string[],
): GovernedFindingCompensationAuthorization {
  if (paths.length === 0) {
    throw new Error('Governed finding compensation requires at least one exact target');
  }
  const beforeImages = new Map<
    string,
    { readonly target: FindingAuthorityTarget; readonly content: string | null }
  >();
  let aggregateBytes = 0;
  for (const path of paths) {
    const target = requireFindingAuthorityTarget(path);
    if (beforeImages.has(target.path)) {
      throw new Error(`Governed finding compensation target is duplicated: ${target.path}`);
    }
    assertGovernedFindingWriteAuthorized(writerFence, lease, target, 'WRITE');
    const content = readGovernedFindingBeforeImage(target);
    aggregateBytes += content === null ? 0 : Buffer.byteLength(content, 'utf8');
    if (aggregateBytes > FINDING_AUTHORITY_TRANSACTION_MAX_BYTES) {
      throw new Error('Governed finding compensation exceeds its aggregate byte budget');
    }
    beforeImages.set(target.path, {
      target,
      content,
    });
  }
  if (
    [...beforeImages.values()].filter((entry) => entry.target.kind === 'SOURCE_MANIFEST').length !==
    1
  ) {
    throw new Error('Governed finding compensation requires one exact source manifest');
  }
  const authorization = Object.freeze({
    kind: 'GOVERNED_FINDING_COMPENSATION_V1',
    [GOVERNED_FINDING_COMPENSATION_BRAND]: true as const,
  });
  governedFindingCompensations.set(authorization, {
    leaseToken: lease.token,
    lockPath: lease.lockPath,
    beforeImages,
  });
  return authorization;
}

function releaseGovernedFindingCompensation(
  authorization: GovernedFindingCompensationAuthorization,
): void {
  if (!governedFindingCompensations.delete(authorization)) {
    throw new Error('Governed finding compensation is foreign or already released.');
  }
}

function restoreGovernedFindingCompensation(
  authorization: GovernedFindingCompensationAuthorization,
  lease: RegistryLockLease,
): void {
  const state = governedFindingCompensations.get(authorization);
  if (
    state === undefined ||
    state.leaseToken !== lease.token ||
    state.lockPath !== lease.lockPath
  ) {
    throw new Error('Governed finding compensation is foreign or bound to another lease');
  }
  assertRegistryLockOwned(lease);
  const restoreBeforeImage = (beforeImage: {
    readonly target: FindingAuthorityTarget;
    readonly content: string | null;
  }): void => {
    const currentTarget = requireFindingAuthorityTarget(beforeImage.target.path);
    if (currentTarget.kind !== beforeImage.target.kind) {
      throw new Error(
        `Governed finding compensation target identity changed: ${currentTarget.path}`,
      );
    }
    if (beforeImage.content === null) {
      if (readGovernedFindingBeforeImage(currentTarget) !== null) {
        unlinkFindingFileAnchored(currentTarget.path);
      }
      return;
    }
    if (readGovernedFindingBeforeImage(currentTarget) !== beforeImage.content) {
      atomicWriteFileWithRegistryLeaseUnchecked(currentTarget.path, beforeImage.content, lease);
    }
  };
  const beforeImages = [...state.beforeImages.values()];
  for (const beforeImage of beforeImages.filter(
    (entry) => entry.target.kind !== 'SOURCE_MANIFEST' && entry.content !== null,
  )) {
    restoreBeforeImage(beforeImage);
  }
  const manifest = beforeImages.find((entry) => entry.target.kind === 'SOURCE_MANIFEST');
  if (manifest === undefined || manifest.content === null) {
    throw new Error('Governed finding compensation lost its prior source manifest');
  }
  // The manifest pointer is the durable commit marker. Restore it only after every old artifact
  // exists again; remove transaction-created artifacts only after the pointer switched back.
  restoreBeforeImage(manifest);
  for (const beforeImage of beforeImages.filter(
    (entry) => entry.target.kind !== 'SOURCE_MANIFEST' && entry.content === null,
  )) {
    restoreBeforeImage(beforeImage);
  }
  const parentDirectories = new Set([...state.beforeImages.keys()].map((path) => dirname(path)));
  for (const parentDirectory of parentDirectories) {
    const parentFd = openSync(parentDirectory, 'r');
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
  }
}

type RegistryLockErrorCode = 'LOCK_TIMEOUT' | 'LOCK_MALFORMED' | 'LOCK_OWNERSHIP_LOST';

const DEFAULT_LOCK_OPTIONS: RegistryLockOptions = {
  timeoutMs: 5_000,
  pollIntervalMs: 25,
};
const FINDING_WRITER_FLOCK_PATH = '/usr/bin/flock';
const FINDING_WRITER_FLOCK_VERSION_PATTERN = /^flock from util-linux (\d+)\.(\d+)(?:\.(\d+))?$/;
const MIN_FINDING_WRITER_FLOCK_VERSION = Object.freeze([2, 37] as const);
const FINDING_WRITER_FLOCK_CONFLICT_EXIT_CODE = 73;
const FINDING_WRITER_FLOCK_ENV = Object.freeze({ LC_ALL: 'C', LANG: 'C' });
const FINDING_WRITER_FLOCK_MAX_BYTES = 16 * 1024 * 1024;
const FINDING_WRITER_FLOCK_MAX_VERSION_BYTES = 4 * 1024;
const ATOMIC_WRITE_STAGING_PATTERN =
  /^\.(?<basename>.+)\.(?<pid>[1-9]\d*)\.(?<token>[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.new$/;

interface AtomicWriteStagingFile {
  readonly name: string;
  readonly path: string;
  readonly targetBasename: string;
  readonly pid: number;
  readonly token: string;
}

export class RegistryLockError extends Error {
  public constructor(
    public readonly code: RegistryLockErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RegistryLockError';
  }
}

function sleepSync(milliseconds: number): void {
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function errorWithCause(message: string, cause: unknown): Error & { cause: unknown } {
  const error = new Error(message) as Error & { cause: unknown };
  Object.defineProperty(error, 'cause', {
    configurable: true,
    enumerable: false,
    value: cause,
    writable: true,
  });
  return error;
}

interface RegistryKernelLockState {
  readonly fd: number;
  readonly device: number;
  readonly inode: number;
  readonly uid: number;
  readonly lockAnchor: AnchoredFindingMutationTarget;
  readonly flockRuntime: HermeticExecutableAuthorityV1;
}

const registryKernelLockStates = new WeakMap<RegistryLockLease, RegistryKernelLockState>();

function attestFlockRuntime(): HermeticExecutableAuthorityV1 {
  let executable: HermeticExecutableAuthorityV1;
  try {
    executable = openHermeticExecutableAuthority({
      path: FINDING_WRITER_FLOCK_PATH,
      label: 'Finding writer flock runtime',
      versionArgs: ['--version'],
      versionEnvironment: FINDING_WRITER_FLOCK_ENV,
      maximumBytes: FINDING_WRITER_FLOCK_MAX_BYTES,
      maximumVersionBytes: FINDING_WRITER_FLOCK_MAX_VERSION_BYTES,
    });
  } catch (error) {
    throw new RegistryLockError(
      'LOCK_MALFORMED',
      `Finding writer flock runtime attestation failed closed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const versionRaw = executable.attestation.version;
  const version = versionRaw.match(FINDING_WRITER_FLOCK_VERSION_PATTERN);
  if (version === null) {
    executable.close();
    throw new RegistryLockError(
      'LOCK_MALFORMED',
      `Finding writer flock runtime/version probe failed closed: ${versionRaw}`,
    );
  }
  const major = Number(version[1]);
  const minor = Number(version[2]);
  const [minimumMajor, minimumMinor] = MIN_FINDING_WRITER_FLOCK_VERSION;
  if (major < minimumMajor || (major === minimumMajor && minor < minimumMinor)) {
    executable.close();
    throw new RegistryLockError(
      'LOCK_MALFORMED',
      `Finding writer flock runtime is too old: ${versionRaw}`,
    );
  }
  return executable;
}

function assertPersistentLockIdentity(lockPath: string, state: RegistryKernelLockState): void {
  let descriptor;
  let pathname;
  try {
    descriptor = fstatSync(state.fd);
    assertAnchoredFindingMutationParentCurrent(state.lockAnchor);
    pathname = lstatSync(state.lockAnchor.targetPath);
  } catch (error) {
    throw new RegistryLockError(
      'LOCK_OWNERSHIP_LOST',
      `Registry kernel lock pathname or descriptor disappeared: ${lockPath}: ${String(error)}`,
    );
  }
  const currentUid = process.getuid?.();
  if (
    !descriptor.isFile() ||
    !pathname.isFile() ||
    descriptor.isSymbolicLink() ||
    pathname.isSymbolicLink() ||
    descriptor.dev !== state.device ||
    descriptor.ino !== state.inode ||
    pathname.dev !== state.device ||
    pathname.ino !== state.inode ||
    descriptor.nlink !== 1 ||
    pathname.nlink !== 1 ||
    (descriptor.mode & 0o777) !== 0o600 ||
    descriptor.uid !== state.uid ||
    (currentUid !== undefined && descriptor.uid !== currentUid) ||
    descriptor.size !== 0 ||
    pathname.size !== 0
  ) {
    throw new RegistryLockError(
      'LOCK_OWNERSHIP_LOST',
      `Registry kernel lock inode, ownership, mode, or empty-record invariant changed: ${lockPath}`,
    );
  }
  state.flockRuntime.assertCurrent();
}

function openPersistentRegistryLock(
  lockPath: string,
  flockRuntime: HermeticExecutableAuthorityV1,
): RegistryKernelLockState {
  const creationAnchor = openAnchoredFindingMutationTarget(lockPath);
  let fd: number;
  try {
    fd = openSync(
      creationAnchor.targetPath,
      fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      0o600,
    );
    fsyncSync(creationAnchor.parentFd);
  } finally {
    closeAnchoredFindingMutationTarget(creationAnchor);
  }
  const lockAnchor = openAnchoredFindingMutationTarget(lockPath);
  try {
    const descriptor = fstatSync(fd);
    const state = {
      fd,
      device: descriptor.dev,
      inode: descriptor.ino,
      uid: descriptor.uid,
      lockAnchor,
      flockRuntime,
    };
    assertPersistentLockIdentity(lockPath, state);
    return state;
  } catch (error) {
    closeSync(fd);
    closeAnchoredFindingMutationTarget(lockAnchor);
    throw error;
  }
}

function tryAcquireKernelFlock(state: RegistryKernelLockState): boolean {
  state.flockRuntime.assertCurrent();
  const result = spawnSync(
    state.flockRuntime.descriptorPath,
    ['--nonblock', '--conflict-exit-code', String(FINDING_WRITER_FLOCK_CONFLICT_EXIT_CODE), '3'],
    {
      argv0: state.flockRuntime.argv0,
      encoding: 'utf8',
      env: FINDING_WRITER_FLOCK_ENV,
      stdio: ['ignore', 'pipe', 'pipe', state.fd],
      timeout: 5_000,
    },
  );
  state.flockRuntime.assertCurrent();
  if (result.error !== undefined || result.signal !== null) {
    throw new RegistryLockError(
      'LOCK_MALFORMED',
      `Finding writer kernel flock execution failed: ${String(result.error ?? result.signal)}`,
    );
  }
  if (result.status === 0) return true;
  if (result.status === FINDING_WRITER_FLOCK_CONFLICT_EXIT_CODE) return false;
  throw new RegistryLockError(
    'LOCK_MALFORMED',
    `Finding writer kernel flock acquisition failed: status=${String(result.status)} signal=${String(result.signal)} stderr=${result.stderr.trim()}`,
  );
}

function assertKernelFlockHeld(lockPath: string, state: RegistryKernelLockState): void {
  let probeFd: number;
  try {
    assertAnchoredFindingMutationParentCurrent(state.lockAnchor);
    probeFd = openSync(state.lockAnchor.targetPath, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
  } catch (error) {
    throw new RegistryLockError(
      'LOCK_OWNERSHIP_LOST',
      `Registry kernel lock cannot open an independent ownership probe: ${lockPath}: ${String(error)}`,
    );
  }
  try {
    const probe = fstatSync(probeFd);
    if (
      !probe.isFile() ||
      probe.isSymbolicLink() ||
      probe.dev !== state.device ||
      probe.ino !== state.inode
    ) {
      throw new RegistryLockError(
        'LOCK_OWNERSHIP_LOST',
        `Registry kernel lock independent probe reached another inode: ${lockPath}`,
      );
    }
    if (tryAcquireKernelFlock({ ...state, fd: probeFd })) {
      throw new RegistryLockError(
        'LOCK_OWNERSHIP_LOST',
        `Registry kernel lock descriptor no longer owns the advisory lock: ${lockPath}`,
      );
    }
  } finally {
    closeSync(probeFd);
  }
}

function acquireRegistryLock(
  resourcePath: string,
  lockPath: string,
  options: RegistryLockOptions,
): RegistryLockLease {
  const deadlineMs = Date.now() + options.timeoutMs;
  const flockRuntime = attestFlockRuntime();
  let state: RegistryKernelLockState;
  try {
    state = openPersistentRegistryLock(lockPath, flockRuntime);
  } catch (error) {
    flockRuntime.close();
    throw error;
  }

  try {
    for (;;) {
      assertPersistentLockIdentity(lockPath, state);
      if (tryAcquireKernelFlock(state)) {
        assertPersistentLockIdentity(lockPath, state);
        const lease = Object.freeze({
          lockPath,
          resourcePath,
          token: randomUUID(),
        });
        registryKernelLockStates.set(lease, state);
        assertRegistryLockOwned(lease);
        return lease;
      }

      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        throw new RegistryLockError(
          'LOCK_TIMEOUT',
          `Timed out after ${options.timeoutMs}ms waiting for registry lock: ${lockPath}`,
        );
      }
      sleepSync(Math.min(options.pollIntervalMs, remainingMs));
    }
  } catch (error) {
    closeSync(state.fd);
    closeAnchoredFindingMutationTarget(state.lockAnchor);
    state.flockRuntime.close();
    throw error;
  }
}

export function assertRegistryLockOwned(lease: RegistryLockLease): void {
  const state = registryKernelLockStates.get(lease);
  if (state === undefined) {
    throw new RegistryLockError(
      'LOCK_OWNERSHIP_LOST',
      `Registry lock ownership was lost before mutation: ${lease.lockPath}`,
    );
  }
  assertPersistentLockIdentity(lease.lockPath, state);
  assertKernelFlockHeld(lease.lockPath, state);
}

function releaseRegistryLock(lease: RegistryLockLease): void {
  const state = registryKernelLockStates.get(lease);
  if (state === undefined) {
    throw new RegistryLockError(
      'LOCK_OWNERSHIP_LOST',
      `Registry lock lease is foreign, fabricated, or already released: ${lease.lockPath}`,
    );
  }
  try {
    assertRegistryLockOwned(lease);
  } finally {
    registryKernelLockStates.delete(lease);
    closeSync(state.fd);
    closeAnchoredFindingMutationTarget(state.lockAnchor);
    state.flockRuntime.close();
  }
}

export function withRegistryFileLock<T>(
  resourcePath: string,
  action: (lease: RegistryLockLease) => T,
  overrides: Partial<RegistryLockOptions> = {},
): T {
  const lease = acquireConfiguredRegistryLock(resourcePath, overrides);
  let outcome: RegistryActionOutcome<T>;
  try {
    outcome = { status: 'SUCCESS', value: action(lease) };
  } catch (error) {
    outcome = { status: 'FAILURE', error };
  }
  return finalizeRegistryAction(lease, outcome);
}

type RegistryActionOutcome<T> =
  | { readonly status: 'SUCCESS'; readonly value: T }
  | { readonly status: 'FAILURE'; readonly error: unknown };

function acquireConfiguredRegistryLock(
  resourcePath: string,
  overrides: Partial<RegistryLockOptions>,
): RegistryLockLease {
  const options: RegistryLockOptions = { ...DEFAULT_LOCK_OPTIONS, ...overrides };
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    !Number.isSafeInteger(options.pollIntervalMs) ||
    options.pollIntervalMs <= 0
  ) {
    throw new TypeError('Registry lock durations must be positive safe integers.');
  }

  const lockPath = options.lockPath ?? `${resourcePath}.lock`;
  return acquireRegistryLock(resourcePath, lockPath, options);
}

function observedFailure(message: string, error: unknown): Error {
  return error instanceof Error ? error : errorWithCause(message, error);
}

function finalizeRegistryAction<T>(lease: RegistryLockLease, outcome: RegistryActionOutcome<T>): T {
  let releaseOutcome: RegistryActionOutcome<undefined>;
  try {
    releaseRegistryLock(lease);
    releaseOutcome = { status: 'SUCCESS', value: undefined };
  } catch (error) {
    releaseOutcome = { status: 'FAILURE', error };
  }

  if (outcome.status === 'FAILURE' && releaseOutcome.status === 'FAILURE') {
    throw new AggregateError(
      [
        observedFailure('Registry action threw a non-Error value.', outcome.error),
        observedFailure('Registry lock release threw a non-Error value.', releaseOutcome.error),
      ],
      'Registry action and lock release both failed.',
    );
  }
  if (outcome.status === 'FAILURE') {
    throw observedFailure('Registry action threw a non-Error value.', outcome.error);
  }
  if (releaseOutcome.status === 'FAILURE') {
    throw observedFailure('Registry lock release threw a non-Error value.', releaseOutcome.error);
  }
  return outcome.value;
}

export async function withRegistryFileLockAsync<T>(
  resourcePath: string,
  action: (lease: RegistryLockLease) => Promise<T>,
  overrides: Partial<RegistryLockOptions> = {},
): Promise<T> {
  const lease = acquireConfiguredRegistryLock(resourcePath, overrides);
  let outcome: RegistryActionOutcome<T>;
  try {
    outcome = { status: 'SUCCESS', value: await action(lease) };
  } catch (error) {
    outcome = { status: 'FAILURE', error };
  }
  return finalizeRegistryAction(lease, outcome);
}

function requireFindingAuthorityTarget(filePath: string): FindingAuthorityTarget {
  const target = classifyFindingAuthorityTarget(filePath);
  if (target === null) {
    throw new Error(`Governed finding writer refuses a non-authority target: ${filePath}`);
  }
  return target;
}

function assertGovernedFindingWriteAuthorized(
  writerFence: RedeemedFindingWriterFenceCapability | SourceFindingWriterFenceSession,
  lease: RegistryLockLease,
  target: FindingAuthorityTarget,
  action: 'WRITE' | 'UNLINK' | 'RECOVER',
  repositoryAuthority?: RepositoryMutationAuthority,
  operation?: RegistryMutationOperation,
): void {
  if (writerFence.kind === 'SOURCE_FINDING_WRITER_FENCE_SESSION_V1') {
    if (repositoryAuthority !== undefined || operation !== undefined) {
      throw new Error('Finding writer source session cannot carry a registry mutation profile');
    }
    assertSourceFindingWriterFenceSessionTargetCurrent(writerFence, lease, target, action);
  } else {
    assertFindingWriterFenceTargetCurrent(
      writerFence,
      lease,
      target,
      action,
      repositoryAuthority,
      operation,
    );
  }
  assertRegistryLockOwned(lease);
}

function atomicWriteFileWithRegistryLeaseUnchecked(
  filePath: string,
  content: string,
  lease: RegistryLockLease,
  beforeCommit: () => void = () => {},
  commitMode: 'REPLACE' | 'CREATE_OR_VERIFY_IDENTICAL' = 'REPLACE',
): void {
  assertRegistryLockOwned(lease);

  const anchored = openAnchoredFindingMutationTarget(filePath);
  const stagingBasename = `.${basename(filePath)}.${process.pid}.${lease.token}.new`;
  let stagingAnchor: AnchoredFindingMutationTarget | null = null;
  let stagingPath: string | null = null;
  let stagingExists = false;
  try {
    stagingAnchor = openAnchoredFindingMutationTarget(
      join(dirname(lease.lockPath), stagingBasename),
    );
    stagingPath = stagingAnchor.targetPath;
    if (fstatSync(anchored.parentFd).dev !== fstatSync(stagingAnchor.parentFd).dev) {
      throw new Error('Finding mutation staging and target directories are on different devices');
    }
    const fd = openSync(stagingPath, 'wx', 0o644);
    stagingExists = true;
    try {
      writeFileSync(fd, content, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    // A stale owner that resumes after a takeover cannot cross this fence.
    assertRegistryLockOwned(lease);
    assertAnchoredFindingMutationParentCurrent(anchored);
    beforeCommit();
    assertRegistryLockOwned(lease);
    assertAnchoredFindingMutationParentCurrent(anchored);
    if (commitMode === 'CREATE_OR_VERIFY_IDENTICAL') {
      try {
        linkSync(stagingPath, anchored.targetPath);
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error;
        const target = requireFindingAuthorityTarget(filePath);
        if (readGovernedFindingBeforeImage(target) !== content) {
          throw new Error(`Source-finding immutable artifact collision: ${target.path}`);
        }
      }
      unlinkSync(stagingPath);
    } else {
      renameSync(stagingPath, anchored.targetPath);
    }
    stagingExists = false;

    fsyncSync(anchored.parentFd);
    fsyncSync(stagingAnchor.parentFd);
    assertAnchoredFindingMutationParentCurrent(anchored);
    assertAnchoredFindingMutationParentCurrent(stagingAnchor);
  } finally {
    if (stagingExists && stagingPath !== null) {
      try {
        unlinkSync(stagingPath);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
      }
    }
    if (stagingAnchor !== null) closeAnchoredFindingMutationTarget(stagingAnchor);
    closeAnchoredFindingMutationTarget(anchored);
  }
}

/** Test dependency injection for exercising the lock kernel without a governed authority target. */
export function testOnlyAtomicWriteFileWithRegistryLease(
  filePath: string,
  content: string,
  lease: RegistryLockLease,
): void {
  if (classifyFindingAuthorityTarget(filePath) !== null) {
    throw new Error('Test lock adapter refuses governed finding authority targets.');
  }
  atomicWriteFileWithRegistryLeaseUnchecked(filePath, content, lease);
}

function atomicWriteGovernedFindingFile(
  filePath: string,
  content: string,
  lease: RegistryLockLease,
  writerFence: RedeemedFindingWriterFenceCapability | SourceFindingWriterFenceSession,
): void {
  const target = requireFindingAuthorityTarget(filePath);
  assertGovernedFindingWriteAuthorized(writerFence, lease, target, 'WRITE');
  if (target.kind === 'SOURCE_ARTIFACT') {
    const contentId = createHash('sha256').update(content, 'utf8').digest('hex');
    if (contentId !== target.contentId) {
      throw new Error(
        `Source-finding artifact content id mismatch: expected ${target.contentId}, got ${contentId}`,
      );
    }
    const currentContent = readGovernedFindingBeforeImage(target);
    if (currentContent !== null) {
      if (currentContent !== content) {
        throw new Error(`Source-finding immutable artifact collision: ${target.path}`);
      }
      return;
    }
  }
  atomicWriteFileWithRegistryLeaseUnchecked(
    target.path,
    content,
    lease,
    () => assertGovernedFindingWriteAuthorized(writerFence, lease, target, 'WRITE'),
    target.kind === 'SOURCE_ARTIFACT' ? 'CREATE_OR_VERIFY_IDENTICAL' : 'REPLACE',
  );
}

function unlinkGovernedFindingFile(
  filePath: string,
  lease: RegistryLockLease,
  writerFence: RedeemedFindingWriterFenceCapability | SourceFindingWriterFenceSession,
): void {
  const target = requireFindingAuthorityTarget(filePath);
  assertGovernedFindingWriteAuthorized(writerFence, lease, target, 'UNLINK');
  unlinkFindingFileAnchored(target.path, () =>
    assertGovernedFindingWriteAuthorized(writerFence, lease, target, 'UNLINK'),
  );
}

export interface SourceFindingPublicationStore {
  captureCompensation(paths: readonly string[]): GovernedFindingCompensationAuthorization;
  publishImmutableArtifact(filePath: string, content: string): void;
  commitManifest(filePath: string, content: string): void;
  removeArtifact(filePath: string): void;
  restoreCompensation(authorization: GovernedFindingCompensationAuthorization): void;
  releaseCompensation(authorization: GovernedFindingCompensationAuthorization): void;
}

/**
 * Bind source mutation primitives to one live source-profile capability. No raw write/unlink API is
 * exported: callers can only publish an immutable artifact, advance the manifest marker, or remove
 * a superseded artifact in that profile's exact repository.
 */
export function bindSourceFindingPublicationStore(
  lease: RegistryLockLease,
  writerFence: SourceFindingWriterFenceSession,
): SourceFindingPublicationStore {
  return Object.freeze({
    captureCompensation: (paths: readonly string[]) =>
      captureGovernedFindingCompensation(lease, writerFence, paths),
    publishImmutableArtifact: (filePath: string, content: string) => {
      const target = requireFindingAuthorityTarget(filePath);
      if (target.kind !== 'SOURCE_ARTIFACT') {
        throw new Error(
          `Source publication artifact operation refuses ${target.kind.toLowerCase()}`,
        );
      }
      atomicWriteGovernedFindingFile(filePath, content, lease, writerFence);
    },
    commitManifest: (filePath: string, content: string) => {
      const target = requireFindingAuthorityTarget(filePath);
      if (target.kind !== 'SOURCE_MANIFEST') {
        throw new Error(`Source publication commit operation refuses ${target.kind.toLowerCase()}`);
      }
      atomicWriteGovernedFindingFile(filePath, content, lease, writerFence);
    },
    removeArtifact: (filePath: string) => {
      const target = requireFindingAuthorityTarget(filePath);
      if (target.kind !== 'SOURCE_ARTIFACT' && target.kind !== 'SOURCE_LEGACY_ARTIFACT') {
        throw new Error(
          `Source publication cleanup operation refuses ${target.kind.toLowerCase()}`,
        );
      }
      unlinkGovernedFindingFile(filePath, lease, writerFence);
    },
    restoreCompensation: (authorization: GovernedFindingCompensationAuthorization) =>
      restoreGovernedFindingCompensation(authorization, lease),
    releaseCompensation: (authorization: GovernedFindingCompensationAuthorization) =>
      releaseGovernedFindingCompensation(authorization),
  });
}

export function atomicWriteFindingReservationFile(
  filePath: string,
  content: string,
  lease: RegistryLockLease,
  writerFence: RedeemedFindingWriterFenceCapability,
): void {
  const target = requireFindingAuthorityTarget(filePath);
  if (target.kind !== 'RESERVATION') {
    throw new Error(`Finding reservation writer refuses ${target.kind.toLowerCase()}`);
  }
  atomicWriteGovernedFindingFile(filePath, content, lease, writerFence);
}

function governedAtomicWriteStagingFiles(
  parentPath: string,
  isGovernedBasename: (basename: string) => boolean,
): AtomicWriteStagingFile[] {
  const stagingFiles: AtomicWriteStagingFile[] = [];
  for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
    const match = ATOMIC_WRITE_STAGING_PATTERN.exec(entry.name);
    const governedBasename = match?.groups?.basename;
    if (!governedBasename || !isGovernedBasename(governedBasename)) continue;
    const stagingPath = join(parentPath, entry.name);
    if (!entry.isFile() || lstatSync(stagingPath).isSymbolicLink()) {
      throw new Error(`Atomic staging inspection found a non-regular entry: ${entry.name}`);
    }
    const pid = Number.parseInt(match.groups?.pid ?? '', 10);
    const token = match.groups?.token;
    if (!Number.isSafeInteger(pid) || pid <= 0 || !token) {
      throw new Error(`Atomic staging inspection found an invalid owner: ${entry.name}`);
    }
    stagingFiles.push({
      name: entry.name,
      path: stagingPath,
      targetBasename: governedBasename,
      pid,
      token,
    });
  }
  return stagingFiles.sort((left, right) => left.name.localeCompare(right.name));
}

export function listAtomicWriteStagingFiles(
  parentPath: string,
  isGovernedBasename: (basename: string) => boolean,
): string[] {
  return governedAtomicWriteStagingFiles(parentPath, isGovernedBasename).map(
    (stagingFile) => stagingFile.name,
  );
}

function recoverAtomicWriteStagingFilesWithAuthorization(
  parentPath: string,
  isGovernedBasename: (basename: string) => boolean,
  lease: RegistryLockLease,
  minimumAgeMs: number,
  writerFence: RedeemedFindingWriterFenceCapability | SourceFindingWriterFenceSession | null,
  repositoryAuthority?: RepositoryMutationAuthority,
  operation?: RegistryMutationOperation,
  governedTargetPath?: (targetBasename: string) => string,
): string[] {
  if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs <= 0) {
    throw new TypeError('Atomic staging recovery age must be a positive safe integer.');
  }
  assertRegistryLockOwned(lease);
  const recovered: string[] = [];
  for (const stagingFile of governedAtomicWriteStagingFiles(parentPath, isGovernedBasename)) {
    const targetPath =
      governedTargetPath?.(stagingFile.targetBasename) ??
      join(parentPath, stagingFile.targetBasename);
    const governedTarget = classifyFindingAuthorityTarget(targetPath);
    if (governedTarget !== null && writerFence === null) {
      throw new Error(
        `Governed finding staging recovery requires a redeemed worktree-fence authorization: ${targetPath}`,
      );
    }
    if (governedTarget === null && writerFence !== null) {
      throw new Error(
        `Governed finding staging recovery refuses a non-authority target: ${targetPath}`,
      );
    }
    if (governedTarget !== null && writerFence !== null) {
      assertGovernedFindingWriteAuthorized(
        writerFence,
        lease,
        governedTarget,
        'RECOVER',
        repositoryAuthority,
        operation,
      );
    }
    if (stagingFile.token === lease.token) {
      throw new Error(`Atomic staging recovery found its own active owner: ${stagingFile.name}`);
    }
    const ageMs = Math.max(0, Date.now() - statSync(stagingFile.path).mtimeMs);
    if (ageMs < minimumAgeMs) {
      throw new Error(
        `Atomic staging file is younger than the recovery threshold (pid=${stagingFile.pid}, age_ms=${Math.floor(
          ageMs,
        )}): ${stagingFile.name}`,
      );
    }
    unlinkFindingFileAnchored(stagingFile.path, () => {
      assertRegistryLockOwned(lease);
      if (governedTarget !== null && writerFence !== null) {
        assertGovernedFindingWriteAuthorized(
          writerFence,
          lease,
          governedTarget,
          'RECOVER',
          repositoryAuthority,
          operation,
        );
      }
    });
    recovered.push(stagingFile.name);
  }
  if (recovered.length > 0) {
    const parentFd = openSync(parentPath, 'r');
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
  }
  return recovered.sort();
}

export function recoverAtomicWriteStagingFiles(
  parentPath: string,
  isGovernedBasename: (basename: string) => boolean,
  lease: RegistryLockLease,
  minimumAgeMs: number,
): string[] {
  return recoverAtomicWriteStagingFilesWithAuthorization(
    parentPath,
    isGovernedBasename,
    lease,
    minimumAgeMs,
    null,
    undefined,
    undefined,
    undefined,
  );
}

export function recoverGovernedFindingStagingFiles(
  parentPath: string,
  isGovernedBasename: (basename: string) => boolean,
  lease: RegistryLockLease,
  minimumAgeMs: number,
  writerFence: RedeemedFindingWriterFenceCapability | SourceFindingWriterFenceSession,
  repositoryAuthority?: RepositoryMutationAuthority,
  operation?: RegistryMutationOperation,
  governedTargetPath?: (targetBasename: string) => string,
): string[] {
  return recoverAtomicWriteStagingFilesWithAuthorization(
    parentPath,
    isGovernedBasename,
    lease,
    minimumAgeMs,
    writerFence,
    repositoryAuthority,
    operation,
    governedTargetPath,
  );
}

export function atomicWriteRegistryFile(
  resourcePath: string,
  content: string,
  lease: RegistryLockLease,
  repositoryAuthority: RepositoryMutationAuthority,
  operation: RegistryMutationOperation,
  writerFence: RedeemedFindingWriterFenceCapability,
): void {
  assertRepositoryMutationAuthority(repositoryAuthority, operation);
  if (lease.resourcePath !== resourcePath) {
    throw new RegistryLockError(
      'LOCK_OWNERSHIP_LOST',
      `Registry lease does not fence the requested resource: ${resourcePath}`,
    );
  }
  const target = requireFindingAuthorityTarget(resourcePath);
  if (target.kind !== 'REGISTRY') {
    throw new Error(`Registry writer refuses a non-registry target: ${resourcePath}`);
  }
  assertGovernedFindingWriteAuthorized(
    writerFence,
    lease,
    target,
    'WRITE',
    repositoryAuthority,
    operation,
  );
  const beforeImage = readGovernedFindingBeforeImage(target);
  if (beforeImage === null) {
    throw new Error(`Registry transition requires one existing before-image: ${target.path}`);
  }
  try {
    atomicWriteFileWithRegistryLeaseUnchecked(target.path, content, lease, () =>
      assertGovernedFindingWriteAuthorized(
        writerFence,
        lease,
        target,
        'WRITE',
        repositoryAuthority,
        operation,
      ),
    );
    assertFindingWriterFenceRegistryTransition(
      writerFence,
      lease,
      target.path,
      createHash('sha256').update(content, 'utf8').digest('hex'),
    );
  } catch (error) {
    try {
      assertRegistryLockOwned(lease);
      if (readGovernedFindingBeforeImage(target) !== beforeImage) {
        atomicWriteFileWithRegistryLeaseUnchecked(target.path, beforeImage, lease, () =>
          assertRegistryLockOwned(lease),
        );
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [
          observedFailure('Registry transition failed.', error),
          observedFailure('Registry transition rollback failed.', rollbackError),
        ],
        'Registry transition and rollback both failed.',
      );
    }
    throw error;
  }
}

/** H2 heading pattern for the markdown orphan-findings store.
 *
 * `docs/reviews/orphan-findings.md` is a finding store in its own right
 * and it allocates from the SAME ORPHAN sequence space as the
 * hash-chained registry. Both the commit-msg resolver and the ID
 * allocator have to read it, so the pattern and its reader live here:
 * two private copies drift, and a sequence one copy cannot see is a
 * sequence the allocator hands out a second time.
 *
 * Deliberately broader than the registry's own severity-qualified ID
 * form, because the file really contains `## ORPHAN-001` (pre-severity
 * era), `## ORPHAN-INFO-363` (a severity the registry does not use) and
 * `## ORPHAN-LOW-337b` (a suffixed re-open). The narrower
 * `ORPHAN-(CRITICAL|HIGH|MEDIUM|LOW)-\d{3}` form skipped 16 real
 * headings — every one of them a sequence the allocator believed free.
 */
export const ORPHAN_MD_HEADING_REGEX = /^##\s+(ORPHAN-(?:[A-Z]+-)?(\d{3})[a-z]?)\b/;

export interface OrphanMarkdownStore {
  /** Full IDs exactly as written in the headings. */
  readonly ids: ReadonlySet<string>;
  /** Numeric sequences, severity and suffix discarded. */
  readonly sequences: ReadonlySet<number>;
}

/** Parse the orphan heading authority from already-pinned bytes. */
function parseOrphanMarkdownStore(raw: string): OrphanMarkdownStore {
  const ids = new Set<string>();
  const sequences = new Set<number>();
  for (const line of raw.split('\n')) {
    const match = ORPHAN_MD_HEADING_REGEX.exec(line);
    if (!match?.[1] || !match[2]) continue;
    ids.add(match[1]);
    sequences.add(Number.parseInt(match[2], 10));
  }
  return Object.freeze({ ids, sequences });
}

/** Reads the markdown orphan store. Missing file is empty, not an error. */
export function readOrphanMarkdownStore(path: string): OrphanMarkdownStore {
  return parseOrphanMarkdownStore(existsSync(path) ? readFileSync(path, 'utf8') : '');
}

/** Markdown-held sequences, rendered in a form `nextFindingId` can see.
 *
 * `nextFindingId` extracts a sequence with `^<DOMAIN>-[A-Z0-9]+-(\d{3})$`,
 * so a bare `ORPHAN-001` or a suffixed `ORPHAN-LOW-337b` is invisible to
 * it even when handed over. Re-using the `-RESERVED-` synthetic form that
 * the reservation ledger already feeds it keeps one convention rather
 * than teaching the allocator a second ID grammar.
 */
export function orphanMarkdownReservedIds(path: string): string[] {
  return orphanMarkdownReservedIdsFromText(existsSync(path) ? readFileSync(path, 'utf8') : '');
}

/** Render allocation-visible IDs from bytes captured by the worktree fence. */
export function orphanMarkdownReservedIdsFromText(raw: string): string[] {
  return [...parseOrphanMarkdownStore(raw).sequences].map(
    (sequence) => `ORPHAN-RESERVED-${String(sequence).padStart(3, '0')}`,
  );
}

/**
 * The sequence numbers already claimed in `domain`.
 *
 * ORPHAN-HIGH-457 — the SEQUENCE is the identity, not the full string. The
 * classifier segment varies with severity (`ORPHAN-MEDIUM-416` and
 * `ORPHAN-HIGH-416` are the same slot) and `orphanMarkdownReservedIds`
 * deliberately normalizes the markdown store to `ORPHAN-RESERVED-NNN`,
 * because a markdown heading records no severity.
 *
 * That is why an exact-string collision check is wrong and silently so: it
 * compares `ORPHAN-MEDIUM-416` against `ORPHAN-RESERVED-416`, finds no match,
 * and admits an id that already names a live finding. Exported so the
 * allocator and the explicit-append collision check extract sequences the
 * same way rather than each writing their own comparison.
 */
export function claimedSequences(domain: string, existingIds: readonly string[]): Set<number> {
  if (!/^[A-Z][A-Z0-9]*$/.test(domain)) {
    throw new TypeError(`Finding domain must be uppercase alphanumeric: ${domain}`);
  }
  const domainPattern = new RegExp(`^${domain}-[A-Z0-9]+-([0-9]{3})$`);
  const sequences = new Set<number>();
  for (const id of existingIds) {
    const match = domainPattern.exec(id);
    if (!match?.[1]) continue;
    sequences.add(Number.parseInt(match[1], 10));
  }
  return sequences;
}

export function nextFindingId(
  domain: string,
  severity: FindingSeverity,
  existingIds: readonly string[],
): string {
  if (!['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(severity)) {
    throw new TypeError(`Unsupported finding severity: ${severity}`);
  }

  const sequences = claimedSequences(domain, existingIds);
  const maximum = sequences.size > 0 ? Math.max(...sequences) : 0;

  const next = maximum + 1;
  if (next > 999) {
    throw new RangeError(`Finding ID space exhausted for domain ${domain} (maximum 999).`);
  }
  return `${domain}-${severity}-${String(next).padStart(3, '0')}`;
}

export function findingIdHighWater(domain: string, existingIds: readonly string[]): number {
  const sequences = claimedSequences(domain, existingIds);
  return sequences.size > 0 ? Math.max(...sequences) : 0;
}
