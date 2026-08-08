import { createHash, type Hash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { computeCanonicalGitWorktreeEvidence, HERMETIC_GIT_RUNTIME } from './hermetic-git-runtime';
import {
  assertStableDirectoryCurrent,
  decodeFatalUtf8,
  observeStableDirectory,
  type StableDirectoryObservationV1,
} from './anchored-filesystem';

const LOCATOR_SCHEMA =
  'https://app.suderra.com/schemas/registered-git-common-dir-locator/v1' as const;
const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const WORKTREE_OWNER_CLASSES = [
  'USER',
  'CLAUDE',
  'ARIA',
  'CODEX',
  'DEPLOY',
  'REPOSITORY_RUNNER',
] as const;
export type WorktreeOwnerClassV1 = (typeof WORKTREE_OWNER_CLASSES)[number];

export interface WorktreeCoordinate {
  readonly path: string;
  readonly headSha: string;
  readonly branchRef: string | null;
  readonly lockReason: string | null;
}

export interface RegisteredWorktreeOwnerBindingV1 {
  readonly worktreePath: string;
  readonly ownerClass: WorktreeOwnerClassV1;
}

export interface RegisteredCommonDirLocatorV1 {
  readonly schema: typeof LOCATOR_SCHEMA;
  readonly locatorId: string;
  readonly repositoryId: string;
  readonly queryWorktreePath: string;
  readonly commonDirPath: string;
  readonly worktrees: readonly RegisteredWorktreeOwnerBindingV1[];
}

export type WorktreeSetDriftCode = 'REGISTERED_WORKTREE_MISSING' | 'UNREGISTERED_LIVE_WORKTREE';

export interface WorktreeSetDrift {
  readonly code: WorktreeSetDriftCode;
  readonly worktreePath: string;
  readonly automaticRetirementAllowed: false;
  readonly requiredDisposition: 'PRESERVE_AND_RECONCILE_REGISTRATION';
}

export interface CommonDirIdentityV1 {
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
  readonly mode: string;
  readonly linkCount: string;
  readonly ownerUid: string;
  readonly ownerGid: string;
  readonly rdev: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly sha256: string;
}

export interface RepositoryIdentityV1 {
  readonly repositoryId: string;
  readonly objectFormat: 'sha1';
  readonly objectDirectoryPath: string;
  readonly objectDirectoryDevice: string;
  readonly objectDirectoryInode: string;
  readonly objectDirectoryIdentitySha256: string;
  /** Stable across independent clones/copies of the same governed logical repository. */
  readonly sha256: string;
  /** Machine-local object/common-dir placement; never used as logical source identity. */
  readonly substrateAttestationSha256: string;
}

export interface RegisteredWorktreeObservationV1 {
  readonly locatorId: string;
  readonly repositoryIdentitySha256: string;
  readonly commonDirIdentitySha256: string;
  readonly worktreePath: string;
  readonly ownerClass: WorktreeOwnerClassV1;
  readonly headSha: string;
  readonly branchRef: string | null;
  readonly lockReason: string | null;
  readonly dirty: boolean;
  readonly statusSha256: string;
  readonly contentSha256: string;
  /** Path-independent source identity used by content-addressed inventory projections. */
  readonly logicalIdentitySha256: string;
  /** Path/inode/generation evidence used only to detect substrate races and replacement. */
  readonly substrateAttestationSha256: string;
  readonly automaticRetirementAllowed: false;
  readonly requiredDisposition: 'PRESERVE';
}

export interface RegisteredCommonDirObservationV1 {
  readonly locatorId: string;
  readonly repository: RepositoryIdentityV1;
  readonly commonDir: CommonDirIdentityV1;
  readonly worktrees: readonly RegisteredWorktreeObservationV1[];
  /** Logical registered source set, independent of paths, devices, inodes, and timestamps. */
  readonly worktreeSetSha256: string;
  /** Exact machine-local topology backing this logical observation. */
  readonly substrateAttestationSha256: string;
}

export interface RegisteredCommonDirDiscoveryObserver {
  afterWorktreeEvidence?: (locatorId: string, worktreePath: string) => Promise<void> | void;
  beforeFinalTopologyVerification?: (locatorId: string) => Promise<void> | void;
}

export class RegisteredWorktreeSetMismatchError extends Error {
  public constructor(public readonly drifts: readonly WorktreeSetDrift[]) {
    super(
      `registered Git worktree set differs from the live common-dir: ${drifts
        .map((drift) => `${drift.code}:${drift.worktreePath}`)
        .join(', ')}`,
    );
    this.name = 'RegisteredWorktreeSetMismatchError';
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireCanonicalAbsolutePath(path: string, label: string): string {
  if (!isAbsolute(path) || path.includes('\0') || resolve(path) !== path) {
    throw new Error(`${label} must be one normalized absolute path: ${JSON.stringify(path)}`);
  }
  return path;
}

function requireIdentifier(value: string, label: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new Error(`${label} is not one stable identifier: ${JSON.stringify(value)}`);
  }
  return value;
}

function requireOwnerClass(value: string, label: string): WorktreeOwnerClassV1 {
  if (!WORKTREE_OWNER_CLASSES.includes(value as WorktreeOwnerClassV1)) {
    throw new Error(
      `${label} must be one closed owner class (${WORKTREE_OWNER_CLASSES.join(', ')}): ${JSON.stringify(value)}`,
    );
  }
  return value as WorktreeOwnerClassV1;
}

function updateFrame(digest: Hash, label: string, payload: string): void {
  const labelBytes = Buffer.from(label, 'utf8');
  const payloadBytes = Buffer.from(payload, 'utf8');
  const lengths = Buffer.alloc(16);
  lengths.writeBigUInt64BE(BigInt(labelBytes.length), 0);
  lengths.writeBigUInt64BE(BigInt(payloadBytes.length), 8);
  digest.update(lengths);
  digest.update(labelBytes);
  digest.update(payloadBytes);
}

function framedSha256(frames: readonly (readonly [string, string])[]): string {
  const digest = createHash('sha256');
  for (const [label, payload] of frames) {
    updateFrame(digest, label, payload);
  }
  return digest.digest('hex');
}

function requireSha1(value: string, label: string): string {
  if (!SHA1_PATTERN.test(value)) {
    throw new Error(`${label} is not one SHA-1 commit object ID`);
  }
  return value;
}

/** Parses the exact `git worktree list --porcelain -z` protocol. */
export function parseWorktreeList(raw: string): WorktreeCoordinate[] {
  const worktrees: WorktreeCoordinate[] = [];
  let path: string | null = null;
  let headSha: string | null = null;
  let branchRef: string | null = null;
  let detached = false;
  let lockReason: string | null = null;
  let lockObserved = false;
  let unsupportedState: string | null = null;

  const flush = (): void => {
    if (path === null) {
      return;
    }
    if (headSha === null) {
      throw new Error(`registered worktree ${path} has no HEAD`);
    }
    if ((branchRef === null) === !detached) {
      throw new Error(`registered worktree ${path} has an ambiguous branch/detached state`);
    }
    if (unsupportedState !== null) {
      throw new Error(`registered worktree ${path} is ${unsupportedState}; evidence is incomplete`);
    }
    worktrees.push(Object.freeze({ path, headSha, branchRef, lockReason }));
    path = null;
    headSha = null;
    branchRef = null;
    detached = false;
    lockReason = null;
    lockObserved = false;
    unsupportedState = null;
  };

  for (const field of raw.split('\0')) {
    if (field.length === 0) {
      continue;
    }
    if (field.startsWith('worktree ')) {
      flush();
      path = requireCanonicalAbsolutePath(
        field.slice('worktree '.length),
        'registered worktree path',
      );
      continue;
    }
    if (path === null) {
      throw new Error(`Git worktree protocol field precedes its worktree: ${field}`);
    }
    if (field.startsWith('HEAD ')) {
      if (headSha !== null) {
        throw new Error(`registered worktree ${path} has duplicate HEAD fields`);
      }
      headSha = requireSha1(field.slice('HEAD '.length), `worktree ${path}.HEAD`);
      continue;
    }
    if (field.startsWith('branch ')) {
      if (branchRef !== null || detached) {
        throw new Error(`registered worktree ${path} has duplicate branch state`);
      }
      const value = field.slice('branch '.length);
      if (!value.startsWith('refs/heads/') || value.length === 'refs/heads/'.length) {
        throw new Error(`registered worktree ${path} has invalid branch ref ${value}`);
      }
      branchRef = value;
      continue;
    }
    if (field === 'detached') {
      if (branchRef !== null || detached) {
        throw new Error(`registered worktree ${path} has duplicate detached state`);
      }
      detached = true;
      continue;
    }
    if (field === 'bare' || field.startsWith('prunable')) {
      unsupportedState = field;
      continue;
    }
    if (field === 'locked' || field.startsWith('locked ')) {
      if (lockObserved) {
        throw new Error(`registered worktree ${path} has duplicate locked state`);
      }
      lockObserved = true;
      lockReason = field === 'locked' ? '' : field.slice('locked '.length);
      continue;
    }
    throw new Error(`registered worktree ${path} has unknown protocol field: ${field}`);
  }
  flush();

  const paths = new Set<string>();
  for (const worktree of worktrees) {
    if (paths.has(worktree.path)) {
      throw new Error(`Git worktree list contains duplicate path ${worktree.path}`);
    }
    paths.add(worktree.path);
  }
  return worktrees.sort((left, right) => compareText(left.path, right.path));
}

export function compareRegisteredWorktreeSet(
  registeredPaths: readonly string[],
  livePaths: readonly string[],
): WorktreeSetDrift[] {
  const registered = new Set(registeredPaths);
  const live = new Set(livePaths);
  if (registered.size !== registeredPaths.length) {
    throw new Error('registered worktree set contains duplicate paths');
  }
  if (live.size !== livePaths.length) {
    throw new Error('live worktree set contains duplicate paths');
  }
  const drifts: WorktreeSetDrift[] = [];
  for (const worktreePath of [...registered].sort(compareText)) {
    if (!live.has(worktreePath)) {
      drifts.push(
        Object.freeze({
          code: 'REGISTERED_WORKTREE_MISSING',
          worktreePath,
          automaticRetirementAllowed: false,
          requiredDisposition: 'PRESERVE_AND_RECONCILE_REGISTRATION',
        }),
      );
    }
  }
  for (const worktreePath of [...live].sort(compareText)) {
    if (!registered.has(worktreePath)) {
      drifts.push(
        Object.freeze({
          code: 'UNREGISTERED_LIVE_WORKTREE',
          worktreePath,
          automaticRetirementAllowed: false,
          requiredDisposition: 'PRESERVE_AND_RECONCILE_REGISTRATION',
        }),
      );
    }
  }
  return drifts;
}

function validateLocator(locator: RegisteredCommonDirLocatorV1): void {
  if (locator.schema !== LOCATOR_SCHEMA) {
    throw new Error(`common-dir locator ${locator.locatorId} has an unsupported schema`);
  }
  requireIdentifier(locator.locatorId, 'common-dir locator ID');
  requireIdentifier(locator.repositoryId, 'repository ID');
  requireCanonicalAbsolutePath(locator.queryWorktreePath, 'query worktree path');
  requireCanonicalAbsolutePath(locator.commonDirPath, 'registered common-dir path');
  if (locator.worktrees.length === 0) {
    throw new Error(`common-dir locator ${locator.locatorId} has no governed worktrees`);
  }
  const paths = new Set<string>();
  for (const [index, binding] of locator.worktrees.entries()) {
    const path = requireCanonicalAbsolutePath(
      binding.worktreePath,
      `${locator.locatorId}.worktrees[${String(index)}].worktreePath`,
    );
    requireOwnerClass(
      binding.ownerClass,
      `${locator.locatorId}.worktrees[${String(index)}].ownerClass`,
    );
    if (paths.has(path)) {
      throw new Error(`${locator.locatorId} registers worktree ${path} more than once`);
    }
    paths.add(path);
  }
  if (!paths.has(locator.queryWorktreePath)) {
    throw new Error(`${locator.locatorId} query worktree is not in its governed worktree set`);
  }
}

function commonDirIdentity(commonDirPath: string): CommonDirIdentityV1 {
  const canonicalPath = realpathSync(commonDirPath);
  if (canonicalPath !== commonDirPath) {
    throw new Error(`registered common-dir is not canonical: ${commonDirPath}`);
  }
  const stat = observeStableDirectory(canonicalPath, 'registered common-dir', false).stat;
  const device = stat.dev.toString();
  const inode = stat.ino.toString();
  const mode = stat.mode.toString();
  const linkCount = stat.nlink.toString();
  const ownerUid = stat.uid.toString();
  const ownerGid = stat.gid.toString();
  const rdev = stat.rdev.toString();
  const size = stat.size.toString();
  const mtimeNs = stat.mtimeNs.toString();
  const ctimeNs = stat.ctimeNs.toString();
  return Object.freeze({
    canonicalPath,
    device,
    inode,
    mode,
    linkCount,
    ownerUid,
    ownerGid,
    rdev,
    size,
    mtimeNs,
    ctimeNs,
    sha256: framedSha256([
      ['FORMAT', 'GIT_COMMON_DIR_IDENTITY_V1'],
      ['PATH', canonicalPath],
      ['DEVICE', device],
      ['INODE', inode],
      ['MODE', mode],
      ['LINK_COUNT', linkCount],
      ['OWNER_UID', ownerUid],
      ['OWNER_GID', ownerGid],
      ['RDEV', rdev],
      ['SIZE', size],
      ['MTIME_NS', mtimeNs],
      ['CTIME_NS', ctimeNs],
    ]),
  });
}

function repositoryIdentity(
  locator: RegisteredCommonDirLocatorV1,
  commonDir: CommonDirIdentityV1,
): RepositoryIdentityV1 {
  const objectFormat = HERMETIC_GIT_RUNTIME.runText(locator.queryWorktreePath, [
    'rev-parse',
    '--show-object-format',
  ]).stdout.trim();
  if (objectFormat !== 'sha1') {
    throw new Error(`${locator.locatorId} repository object format is not governed SHA-1`);
  }
  const objectDirectoryPath = realpathSync(
    HERMETIC_GIT_RUNTIME.runText(locator.queryWorktreePath, [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'objects',
    ]).stdout.trim(),
  );
  const stat = observeStableDirectory(
    objectDirectoryPath,
    `${locator.locatorId} object directory`,
    false,
  ).stat;
  const objectDirectoryDevice = stat.dev.toString();
  const objectDirectoryInode = stat.ino.toString();
  const objectDirectoryIdentitySha256 = framedSha256([
    ['FORMAT', 'GIT_OBJECT_DIRECTORY_IDENTITY_V1'],
    ['PATH', objectDirectoryPath],
    ['DEVICE', objectDirectoryDevice],
    ['INODE', objectDirectoryInode],
    ['MODE', stat.mode.toString()],
    ['LINK_COUNT', stat.nlink.toString()],
    ['OWNER_UID', stat.uid.toString()],
    ['OWNER_GID', stat.gid.toString()],
    ['RDEV', stat.rdev.toString()],
    ['SIZE', stat.size.toString()],
    ['MTIME_NS', stat.mtimeNs.toString()],
    ['CTIME_NS', stat.ctimeNs.toString()],
  ]);
  return Object.freeze({
    repositoryId: locator.repositoryId,
    objectFormat,
    objectDirectoryPath,
    objectDirectoryDevice,
    objectDirectoryInode,
    objectDirectoryIdentitySha256,
    sha256: framedSha256([
      ['FORMAT', 'GIT_REPOSITORY_IDENTITY_V1'],
      ['REPOSITORY_ID', locator.repositoryId],
      ['OBJECT_FORMAT', objectFormat],
    ]),
    substrateAttestationSha256: framedSha256([
      ['FORMAT', 'GIT_REPOSITORY_SUBSTRATE_ATTESTATION_V1'],
      ['REPOSITORY_ID', locator.repositoryId],
      ['COMMON_DIR_SHA256', commonDir.sha256],
      ['OBJECT_FORMAT', objectFormat],
      ['OBJECT_DIRECTORY_PATH', objectDirectoryPath],
      ['OBJECT_DIRECTORY_DEVICE', objectDirectoryDevice],
      ['OBJECT_DIRECTORY_INODE', objectDirectoryInode],
      ['OBJECT_DIRECTORY_IDENTITY_SHA256', objectDirectoryIdentitySha256],
    ]),
  });
}

async function discoverOneCommonDir(
  locator: RegisteredCommonDirLocatorV1,
  observer: RegisteredCommonDirDiscoveryObserver,
): Promise<RegisteredCommonDirObservationV1> {
  validateLocator(locator);
  if (realpathSync(locator.queryWorktreePath) !== locator.queryWorktreePath) {
    throw new Error(`${locator.locatorId} query worktree is not canonical`);
  }
  const resolvedCommonDir = realpathSync(
    HERMETIC_GIT_RUNTIME.runText(locator.queryWorktreePath, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]).stdout.trim(),
  );
  if (resolvedCommonDir !== locator.commonDirPath) {
    throw new Error(
      `${locator.locatorId} resolves common-dir ${resolvedCommonDir}, expected ${locator.commonDirPath}`,
    );
  }
  const commonDir = commonDirIdentity(locator.commonDirPath);
  const repository = repositoryIdentity(locator, commonDir);
  const liveWorktreeBytes = HERMETIC_GIT_RUNTIME.runBuffer(locator.queryWorktreePath, [
    'worktree',
    'list',
    '--porcelain',
    '-z',
  ]).stdout;
  const liveWorktrees = parseWorktreeList(
    decodeFatalUtf8(liveWorktreeBytes, `${locator.locatorId} worktree list`),
  );
  const registeredPaths = locator.worktrees.map((binding) => binding.worktreePath);
  const drifts = compareRegisteredWorktreeSet(
    registeredPaths,
    liveWorktrees.map((worktree) => worktree.path),
  );
  if (drifts.length > 0) {
    throw new RegisteredWorktreeSetMismatchError(Object.freeze(drifts));
  }
  const owners = new Map(
    locator.worktrees.map((binding) => [binding.worktreePath, binding.ownerClass] as const),
  );
  const observations: RegisteredWorktreeObservationV1[] = [];
  const worktreeDirectories = new Map<string, StableDirectoryObservationV1>();
  for (const worktree of liveWorktrees) {
    const worktreeDirectory = observeStableDirectory(
      worktree.path,
      `${locator.locatorId} worktree`,
      false,
    );
    const worktreeCommonDir = realpathSync(
      HERMETIC_GIT_RUNTIME.runText(worktree.path, [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]).stdout.trim(),
    );
    if (worktreeCommonDir !== commonDir.canonicalPath) {
      throw new Error(`${worktree.path} escaped registered common-dir ${commonDir.canonicalPath}`);
    }
    const ownerClass = owners.get(worktree.path);
    if (ownerClass === undefined) {
      throw new Error(`${worktree.path} lost its registered owner class`);
    }
    const evidence = await computeCanonicalGitWorktreeEvidence(worktree.path);
    if (observer.afterWorktreeEvidence) {
      await observer.afterWorktreeEvidence(locator.locatorId, worktree.path);
    }
    assertStableDirectoryCurrent(worktreeDirectory, `${locator.locatorId} worktree`);
    worktreeDirectories.set(worktree.path, worktreeDirectory);
    if (evidence.headSha !== worktree.headSha) {
      throw new Error(`${worktree.path} HEAD moved after common-dir discovery`);
    }
    observations.push(
      Object.freeze({
        locatorId: locator.locatorId,
        repositoryIdentitySha256: repository.sha256,
        commonDirIdentitySha256: commonDir.sha256,
        worktreePath: worktree.path,
        ownerClass,
        headSha: worktree.headSha,
        branchRef: worktree.branchRef,
        lockReason: worktree.lockReason,
        dirty: evidence.dirty,
        statusSha256: evidence.statusSha256,
        contentSha256: evidence.contentSha256,
        logicalIdentitySha256: framedSha256([
          ['FORMAT', 'REGISTERED_WORKTREE_LOGICAL_IDENTITY_V1'],
          ['REPOSITORY_SHA256', repository.sha256],
          ['OWNER_CLASS', ownerClass],
          ['HEAD', worktree.headSha],
          ['BRANCH', worktree.branchRef ?? 'DETACHED'],
          ['DIRTY', String(evidence.dirty)],
          ['STATUS_SHA256', evidence.statusSha256],
          ['CONTENT_SHA256', evidence.contentSha256],
        ]),
        substrateAttestationSha256: framedSha256([
          ['FORMAT', 'REGISTERED_WORKTREE_SUBSTRATE_ATTESTATION_V1'],
          ['LOCATOR_ID', locator.locatorId],
          ['REPOSITORY_SUBSTRATE_SHA256', repository.substrateAttestationSha256],
          ['COMMON_DIR_SHA256', commonDir.sha256],
          ['WORKTREE_PATH', worktree.path],
          ['LOCK_REASON', worktree.lockReason ?? 'UNLOCKED'],
          ['EVIDENCE_SUBSTRATE_SHA256', evidence.substrateAttestationSha256],
        ]),
        automaticRetirementAllowed: false,
        requiredDisposition: 'PRESERVE',
      }),
    );
  }
  if (observer.beforeFinalTopologyVerification) {
    await observer.beforeFinalTopologyVerification(locator.locatorId);
  }
  for (const [worktreePath, worktreeDirectory] of worktreeDirectories) {
    assertStableDirectoryCurrent(
      worktreeDirectory,
      `${locator.locatorId} final worktree ${worktreePath}`,
    );
  }
  const finalResolvedCommonDir = realpathSync(
    HERMETIC_GIT_RUNTIME.runText(locator.queryWorktreePath, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]).stdout.trim(),
  );
  const finalCommonDir = commonDirIdentity(locator.commonDirPath);
  const finalRepository = repositoryIdentity(locator, finalCommonDir);
  const finalLiveWorktreeBytes = HERMETIC_GIT_RUNTIME.runBuffer(locator.queryWorktreePath, [
    'worktree',
    'list',
    '--porcelain',
    '-z',
  ]).stdout;
  if (
    finalResolvedCommonDir !== resolvedCommonDir ||
    finalCommonDir.sha256 !== commonDir.sha256 ||
    finalRepository.sha256 !== repository.sha256 ||
    finalRepository.substrateAttestationSha256 !== repository.substrateAttestationSha256 ||
    !finalLiveWorktreeBytes.equals(liveWorktreeBytes)
  ) {
    throw new Error(
      `${locator.locatorId} common-dir, object-dir, or exact registered worktree protocol changed during discovery`,
    );
  }
  observations.sort((left, right) => compareText(left.worktreePath, right.worktreePath));
  const setFrames: Array<readonly [string, string]> = [
    ['FORMAT', 'REGISTERED_WORKTREE_SET_V1'],
    ['REPOSITORY_SHA256', repository.sha256],
  ];
  for (const observation of [...observations].sort((left, right) =>
    compareText(left.logicalIdentitySha256, right.logicalIdentitySha256),
  )) {
    setFrames.push(['WORKTREE_LOGICAL_IDENTITY_SHA256', observation.logicalIdentitySha256]);
  }
  const substrateFrames: Array<readonly [string, string]> = [
    ['FORMAT', 'REGISTERED_WORKTREE_SET_SUBSTRATE_ATTESTATION_V1'],
    ['LOCATOR_ID', locator.locatorId],
    ['REPOSITORY_SUBSTRATE_SHA256', repository.substrateAttestationSha256],
    ['COMMON_DIR_SHA256', commonDir.sha256],
  ];
  for (const observation of observations) {
    substrateFrames.push(
      ['WORKTREE_PATH', observation.worktreePath],
      ['WORKTREE_SUBSTRATE_SHA256', observation.substrateAttestationSha256],
    );
  }
  return Object.freeze({
    locatorId: locator.locatorId,
    repository,
    commonDir,
    worktrees: Object.freeze(observations),
    worktreeSetSha256: framedSha256(setFrames),
    substrateAttestationSha256: framedSha256(substrateFrames),
  });
}

/**
 * Read-only discovery over explicitly registered common-dir locators. The API has no
 * mutation or retirement surface; live/registered set inequality always preserves and fails.
 */
export async function discoverRegisteredCommonDirs(
  locators: readonly RegisteredCommonDirLocatorV1[],
  observer: RegisteredCommonDirDiscoveryObserver = {},
): Promise<readonly RegisteredCommonDirObservationV1[]> {
  if (locators.length === 0) {
    throw new Error('registered common-dir discovery requires at least one explicit locator');
  }
  const locatorIds = new Set<string>();
  const repositoryIds = new Set<string>();
  const commonDirs = new Set<string>();
  for (const locator of locators) {
    validateLocator(locator);
    if (locatorIds.has(locator.locatorId)) {
      throw new Error(`duplicate common-dir locator ID ${locator.locatorId}`);
    }
    if (repositoryIds.has(locator.repositoryId)) {
      throw new Error(`duplicate repository identity authority ${locator.repositoryId}`);
    }
    if (commonDirs.has(locator.commonDirPath)) {
      throw new Error(`duplicate common-dir discovery authority ${locator.commonDirPath}`);
    }
    locatorIds.add(locator.locatorId);
    repositoryIds.add(locator.repositoryId);
    commonDirs.add(locator.commonDirPath);
  }
  const observations: RegisteredCommonDirObservationV1[] = [];
  for (const locator of [...locators].sort((left, right) =>
    compareText(left.locatorId, right.locatorId),
  )) {
    observations.push(await discoverOneCommonDir(locator, observer));
  }
  return Object.freeze(observations);
}

export const REGISTERED_COMMON_DIR_LOCATOR_SCHEMA = LOCATOR_SCHEMA;
