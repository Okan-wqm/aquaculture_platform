import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { lstat, open, readlink, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { type Readable } from 'node:stream';
import { TextDecoder } from 'node:util';

import {
  assertStableDirectoryCurrent,
  assertStableRegularFileCurrent,
  assertAnchoredDirectoryChainIdentityCurrent,
  closeAnchoredDirectoryChain,
  decodeFatalUtf8,
  defineHermeticExecutableExecutionPolicyV1,
  openAnchoredDirectoryChain,
  openHermeticExecutableAuthority,
  observeStableDirectory,
  observeStableRegularFile,
  sameBigIntFileObservation,
  type HermeticExecutableAuthorityV1,
  type HermeticExecutableExecutionPolicyV1,
  type AnchoredDirectoryChainV1,
  type StableDirectoryObservationV1,
  type StableRegularFileObservationV1,
} from './anchored-filesystem';
import { errorFromUnknown } from './error-cause';

const GIT_BINARY_PATH = '/usr/bin/git';
const MINIMUM_GIT_VERSION = [2, 35, 0] as const;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_STREAMED_STDERR_BYTES = 64 * 1024;
const MAX_BOUNDED_TEXT_BYTES = 4 * 1024;
const MAX_REPOSITORY_CONFIG_BYTES = 1024 * 1024;
const MAX_GIT_BINARY_BYTES = 128 * 1024 * 1024;
const MAX_GIT_BLOB_BATCH_BYTES = 256 * 1024 * 1024;
const GIT_BLOB_BATCH_SIZE = 256;
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_OBJECT_MODE_REGULAR = '100644';
const GIT_OBJECT_MODE_EXECUTABLE = '100755';
const GIT_OBJECT_MODE_SYMLINK = '120000';

export const REPOSITORY_CHILD_FD_COORDINATES_V1 = Object.freeze([
  Object.freeze({
    role: 'WORKTREE' as const,
    childFd: 3 as const,
    environmentKey: 'GIT_WORK_TREE' as const,
    useAsCwd: true as const,
  }),
  Object.freeze({
    role: 'GIT_DIR' as const,
    childFd: 4 as const,
    environmentKey: 'GIT_DIR' as const,
    useAsCwd: false as const,
  }),
  Object.freeze({
    role: 'COMMON_DIR' as const,
    childFd: 5 as const,
    environmentKey: 'GIT_COMMON_DIR' as const,
    useAsCwd: false as const,
  }),
] as const);
type RepositoryChildFdCoordinateV1 = (typeof REPOSITORY_CHILD_FD_COORDINATES_V1)[number];
type RepositoryDescriptorRoleV1 = RepositoryChildFdCoordinateV1['role'];

function repositoryChildFdPath(childFd: number): string {
  return `/proc/self/fd/${String(childFd)}`;
}

function validateRepositoryChildFdCoordinates(): void {
  const environmentKeys = new Set<string>();
  let cwdCoordinates = 0;
  for (const [index, coordinate] of REPOSITORY_CHILD_FD_COORDINATES_V1.entries()) {
    if (coordinate.childFd !== index + 3) {
      throw new Error('Repository child descriptor coordinates must be contiguous from fd 3');
    }
    if (!environmentKeys.add(coordinate.environmentKey)) {
      throw new Error('Repository child descriptor environment coordinates must be unique');
    }
    if (coordinate.useAsCwd) cwdCoordinates += 1;
  }
  if (cwdCoordinates !== 1) {
    throw new Error('Repository child descriptor coordinates require exactly one cwd authority');
  }
}

validateRepositoryChildFdCoordinates();

function repositoryChildCwdPath(): string {
  const coordinate = REPOSITORY_CHILD_FD_COORDINATES_V1.find((candidate) => candidate.useAsCwd);
  if (coordinate === undefined) {
    throw new Error('Repository child descriptor cwd coordinate is absent');
  }
  return repositoryChildFdPath(coordinate.childFd);
}

export const HERMETIC_GIT_EXECUTION_POLICY_V1 = defineHermeticExecutableExecutionPolicyV1({
  schemaVersion: 1,
  commandDeadlineMs: 60_000,
  timeoutSignal: 'SIGKILL',
});

/**
 * Machine-readable execution-mode authority. Synchronous child execution cannot observe an
 * AbortSignal while JavaScript is blocked in spawnSync, so it is deliberately unavailable inside
 * a contextual execution budget. Both asynchronous facades share the live-interruptible child
 * kernel below and observe every inherited signal.
 */
export const HERMETIC_GIT_EXECUTION_MODES_V1 = Object.freeze({
  schemaVersion: 1 as const,
  synchronousBuffered: Object.freeze({
    APIs: Object.freeze(['read', 'readText'] as const),
    childPrimitive: 'spawnSync' as const,
    contextualBudget: 'FORBIDDEN' as const,
    interruptSemantics: 'CHILD_TIMEOUT_ONLY' as const,
  }),
  asynchronous: Object.freeze({
    APIs: Object.freeze(['readAsync', 'readTextAsync'] as const),
    childPrimitive: 'spawn' as const,
    contextualBudget: 'SUPPORTED' as const,
    interruptSemantics: 'LIVE_ALL_INHERITED_SIGNALS' as const,
  }),
});

interface HermeticGitExecutionBudgetV1 {
  readonly deadlineMs: number;
  readonly deadlineAuthority: symbol | undefined;
  readonly signals: readonly AbortSignal[];
  readonly childDrainAuthorities: readonly HermeticGitChildDrainAuthorityV1[];
}

interface HermeticGitChildDrainAuthorityV1 {
  state: 'OPEN' | 'SEALED';
  failure: Error | undefined;
  readonly childDrains: Set<Promise<void>>;
}

interface HermeticGitChildDrainReservationV1 {
  bind(observation: HermeticGitChildCloseObservation): void;
  release(): void;
}

const hermeticGitExecutionBudget = new AsyncLocalStorage<HermeticGitExecutionBudgetV1>();

interface HermeticGitRepositoryDescriptorAuthorityV1 {
  readonly worktreePath: string;
  readonly topology: RepositoryTopologyObservationV1;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  parentDescriptor(role: RepositoryDescriptorRoleV1): number;
  assertCurrent(): void;
}

const hermeticGitRepositoryDescriptorAuthority =
  new AsyncLocalStorage<HermeticGitRepositoryDescriptorAuthorityV1>();

function runWithHermeticGitExecutionBudgetAuthority<T>(
  durationMs: number,
  signal: AbortSignal,
  deadlineAuthority: symbol | undefined,
  childDrainAuthority: HermeticGitChildDrainAuthorityV1 | undefined,
  action: () => T,
): T {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new TypeError('Hermetic Git execution budget must be one positive safe integer');
  }
  const inherited = hermeticGitExecutionBudget.getStore();
  const requestedDeadlineMs = performance.now() + durationMs;
  const requestedDeadlineIsAuthoritative =
    inherited === undefined || requestedDeadlineMs < inherited.deadlineMs;
  const signals = Object.freeze(
    inherited === undefined
      ? [signal]
      : [...inherited.signals, ...(inherited.signals.includes(signal) ? [] : [signal])],
  );
  const childDrainAuthorities = Object.freeze([
    ...(inherited?.childDrainAuthorities ?? []),
    ...(childDrainAuthority === undefined ? [] : [childDrainAuthority]),
  ]);
  return hermeticGitExecutionBudget.run(
    Object.freeze({
      deadlineMs: requestedDeadlineIsAuthoritative ? requestedDeadlineMs : inherited.deadlineMs,
      deadlineAuthority: requestedDeadlineIsAuthoritative
        ? deadlineAuthority
        : inherited.deadlineAuthority,
      signals,
      childDrainAuthorities,
    }),
    action,
  );
}

export function runWithHermeticGitExecutionBudget<T>(
  durationMs: number,
  signal: AbortSignal,
  action: () => T,
): T {
  return runWithHermeticGitExecutionBudgetAuthority(
    durationMs,
    signal,
    undefined,
    undefined,
    action,
  );
}

function createHermeticGitChildDrainAuthority(): HermeticGitChildDrainAuthorityV1 {
  return {
    state: 'OPEN',
    failure: undefined,
    childDrains: new Set<Promise<void>>(),
  };
}

async function sealAndDrainHermeticGitChildren(
  authority: HermeticGitChildDrainAuthorityV1,
  failure: Error,
): Promise<void> {
  if (authority.state === 'OPEN') {
    authority.state = 'SEALED';
    authority.failure = failure;
  }
  for (;;) {
    const activeChildren = [...authority.childDrains];
    if (activeChildren.length === 0) return;
    await Promise.all(activeChildren);
  }
}

/**
 * Deadline coordinator for abortable async Git phases. On expiry it aborts the shared signal,
 * waits for every child registered by the budget to emit close, and only then rejects. An action
 * that ignores cancellation cannot hold the coordinator open when it owns no running Git child.
 */
export function runWithHermeticGitExecutionDeadline<T>(
  durationMs: number,
  deadlineFailure: Error,
  action: (signal: AbortSignal) => T | Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const deadlineAuthority = Symbol('hermetic-git-execution-deadline-authority');
  const childDrainAuthority = createHermeticGitChildDrainAuthority();
  const settledScopeFailure = new Error('Hermetic Git execution scope is already settled');
  const rawOperation = Promise.resolve().then(() =>
    runWithHermeticGitExecutionBudgetAuthority(
      durationMs,
      controller.signal,
      deadlineAuthority,
      childDrainAuthority,
      () => action(controller.signal),
    ),
  );
  const operation = rawOperation.then(
    async (value) => {
      await sealAndDrainHermeticGitChildren(
        childDrainAuthority,
        controller.signal.aborted ? deadlineFailure : settledScopeFailure,
      );
      if (controller.signal.aborted) throw deadlineFailure;
      return value;
    },
    async (error: unknown) => {
      const ownedContextDeadline =
        error instanceof HermeticGitExecutionTimeoutError &&
        error.isContextDeadlineOwnedBy(deadlineAuthority);
      if (!controller.signal.aborted && !ownedContextDeadline) {
        await sealAndDrainHermeticGitChildren(childDrainAuthority, settledScopeFailure);
        throw error;
      }
      if (!controller.signal.aborted) controller.abort(deadlineFailure);
      await sealAndDrainHermeticGitChildren(childDrainAuthority, deadlineFailure);
      throw deadlineFailure;
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineReleased = Symbol('hermetic-git-deadline-released');
  let resolveDeadline!: (value: typeof deadlineReleased) => void;
  const deadline = new Promise<typeof deadlineReleased>((resolve, reject) => {
    resolveDeadline = resolve;
    timer = setTimeout(() => {
      controller.abort(deadlineFailure);
      void sealAndDrainHermeticGitChildren(childDrainAuthority, deadlineFailure).then(
        () => reject(deadlineFailure),
        () => reject(deadlineFailure),
      );
    }, durationMs);
  });
  return Promise.race([operation, deadline])
    .then((result) => {
      if (result === deadlineReleased) {
        throw new Error('Hermetic Git execution deadline settled without an operation result');
      }
      return result;
    })
    .finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      resolveDeadline(deadlineReleased);
    });
}

const HERMETIC_GIT_ENV = Object.freeze<NodeJS.ProcessEnv>({
  GIT_ASKPASS: '/bin/false',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  LANG: 'C',
  LANGUAGE: 'C',
  LC_ALL: 'C',
  PAGER: 'cat',
  SSH_ASKPASS: '/bin/false',
  TZ: 'UTC',
});

const HERMETIC_GIT_NO_REPOSITORY_ENV = Object.freeze<NodeJS.ProcessEnv>({
  ...HERMETIC_GIT_ENV,
  GIT_DIR: '/dev/null',
  GIT_WORK_TREE: '/dev/null',
});

const HERMETIC_GIT_DISABLED_HOOKS_PATH = '/dev/null';

const GIT_INVOCATION_PREFIX = Object.freeze([
  '--no-optional-locks',
  '--no-replace-objects',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  `core.hooksPath=${HERMETIC_GIT_DISABLED_HOOKS_PATH}`,
  '-c',
  'core.fileMode=true',
  '-c',
  'core.symlinks=true',
  '-c',
  'core.ignoreCase=false',
  '-c',
  'core.ignoreStat=false',
  '-c',
  'core.trustCtime=true',
  '-c',
  'core.checkStat=default',
  '-c',
  'core.sparseCheckout=false',
  '-c',
  'core.sparseCheckoutCone=false',
] as const);

export const CANONICAL_GIT_INDEX_ARGS = Object.freeze([
  'ls-files',
  '--stage',
  '-v',
  '--full-name',
  '-z',
  '--',
] as const);

/**
 * `git ls-files` exposes assume-unchanged with `-v` and fsmonitor-valid with `-f` through
 * the same one-byte tag. Combining the switches makes one bit mask the other, so both exact
 * streams are required to prove that neither hidden index authority is active.
 */
export const CANONICAL_GIT_INDEX_FSMONITOR_ARGS = Object.freeze([
  'ls-files',
  '--stage',
  '-f',
  '--full-name',
  '-z',
  '--',
] as const);

export const CANONICAL_GIT_HEAD_TREE_ARGS = Object.freeze([
  'ls-tree',
  '-r',
  '-z',
  '--full-tree',
  'HEAD',
  '--',
] as const);

/**
 * Deliberately names only repository `.gitignore` files. Mutable global excludes and
 * `<common-dir>/info/exclude` are not inventory authorities.
 */
export const CANONICAL_GIT_UNTRACKED_ARGS = Object.freeze([
  'ls-files',
  '--others',
  '--exclude-per-directory=.gitignore',
  '--full-name',
  '-z',
  '--',
] as const);

/**
 * Untracked `.gitignore` files are themselves inventory authorities. This second,
 * no-excludes stream prevents a self-ignoring file from silently hiding both itself
 * and another untracked path from the canonical evidence.
 */
export const CANONICAL_GIT_UNTRACKED_GITIGNORE_ARGS = Object.freeze([
  'ls-files',
  '--others',
  '--full-name',
  '-z',
  '--',
  ':(top).gitignore',
  ':(glob)**/.gitignore',
] as const);

export interface HermeticGitAttestation {
  readonly binaryPath: string;
  readonly binarySha256: string;
  readonly version: string;
  readonly semanticVersion: readonly [number, number, number];
}

export interface HermeticGitTextResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

export interface HermeticGitBufferResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly status: number;
}

type HermeticGitObjectKindV1 = 'BLOB' | 'COMMIT' | 'TREE';

/**
 * Closed, read-only command algebra for production repository consumers. Callers describe the
 * observation they need; this kernel remains the only authority that selects Git argv, stdin,
 * accepted exit statuses, and output budgets.
 */
export type HermeticGitReadQueryV1 =
  | Readonly<{
      kind: 'RESOLVE_OBJECT';
      revision: string;
      peel: 'COMMIT' | 'TREE' | 'PATH';
      path?: string;
      quiet?: boolean;
    }>
  | Readonly<{
      kind: 'REPOSITORY_COORDINATE';
      coordinate: 'TOP_LEVEL' | 'GIT_DIR' | 'COMMON_DIR' | 'OBJECTS' | 'OBJECT_FORMAT';
    }>
  | Readonly<{ kind: 'CHECK_BRANCH_REF'; shortName: string }>
  | Readonly<{ kind: 'SYMBOLIC_HEAD' }>
  | Readonly<{ kind: 'MERGE_BASE'; left: string; right: string }>
  | Readonly<{ kind: 'IS_ANCESTOR'; ancestor: string; descendant: string }>
  | Readonly<{
      kind: 'LIST_REFS';
      namespace: 'LOCAL_HEADS' | 'ORIGIN_REMOTES' | 'REPLACE';
      projection: 'NAMES' | 'NAMES_AND_OBJECT_IDS';
      contains?: string;
    }>
  | Readonly<{ kind: 'LIST_WORKTREES' }>
  | Readonly<{
      kind: 'LIST_INDEX_PATHS';
      selection: 'TRACKED' | 'UNTRACKED_STANDARD';
      roots: readonly string[];
    }>
  | Readonly<{
      kind: 'LIST_TREE';
      revision: string;
      projection: 'PATHS' | 'ENTRIES';
      recursive: boolean;
      paths: readonly string[];
    }>
  | Readonly<{ kind: 'OBJECT_TYPE'; oid: string }>
  | Readonly<{ kind: 'OBJECT_EXISTS'; oid: string; objectKind: HermeticGitObjectKindV1 }>
  | Readonly<{ kind: 'READ_BLOB'; oid: string }>
  | Readonly<{ kind: 'READ_BLOB_BATCH'; oids: readonly string[] }>
  | Readonly<{ kind: 'READ_COMMIT_BATCH'; oids: readonly string[] }>
  | Readonly<{
      kind: 'DIFF';
      projection: 'QUIET' | 'NAME_ONLY' | 'PATCH_ZERO_CONTEXT';
      base: string;
      head?: string;
      paths: readonly string[];
      noRenames?: boolean;
    }>
  | Readonly<{ kind: 'SHOW_COMMIT_MESSAGE'; oid: string }>
  | Readonly<{ kind: 'SHOW_PATH'; revision: string; path: string }>
  | Readonly<{ kind: 'FIND_AUTOMATION_COMMAND'; commandId: string }>;

export interface HermeticGitRuntimeV1 {
  readonly attestation: HermeticGitAttestation;
  readonly executionPolicy: Readonly<HermeticExecutableExecutionPolicyV1>;
  readonly executionModes: typeof HERMETIC_GIT_EXECUTION_MODES_V1;
  runBuffer(
    worktreePath: string,
    args: readonly string[],
    acceptedStatuses?: readonly number[],
    input?: string | Buffer,
    maxBuffer?: number,
  ): HermeticGitBufferResult;
  runText(
    worktreePath: string,
    args: readonly string[],
    acceptedStatuses?: readonly number[],
    maxBuffer?: number,
  ): HermeticGitTextResult;
  runBufferAsync(
    worktreePath: string,
    args: readonly string[],
    acceptedStatuses?: readonly number[],
    input?: string | Buffer,
    maxBuffer?: number,
  ): Promise<HermeticGitBufferResult>;
  runTextAsync(
    worktreePath: string,
    args: readonly string[],
    acceptedStatuses?: readonly number[],
    maxBuffer?: number,
  ): Promise<HermeticGitTextResult>;
  parseConfig(input: Buffer, maxBuffer?: number): HermeticGitBufferResult;
  parseConfigAsync(input: Buffer, maxBuffer?: number): Promise<HermeticGitBufferResult>;
  consumeStdout(
    worktreePath: string,
    args: readonly string[],
    consumeChunk: (chunk: Buffer) => Promise<void> | void,
    acceptedStatuses?: readonly number[],
  ): Promise<number>;
  close(): void;
}

export interface HermeticGitRepositorySyncSessionV1 {
  read(query: HermeticGitReadQueryV1): HermeticGitBufferResult;
  readText(query: HermeticGitReadQueryV1): HermeticGitTextResult;
}

export interface HermeticGitRepositoryAsyncSessionV1 {
  readAsync(query: HermeticGitReadQueryV1): Promise<HermeticGitBufferResult>;
  readTextAsync(query: HermeticGitReadQueryV1): Promise<HermeticGitTextResult>;
}

type HermeticGitSynchronousResult<T> = T & (T extends PromiseLike<unknown> ? never : unknown);

export interface HermeticGitProductionRuntimeV1 {
  readonly attestation: HermeticGitAttestation;
  readonly executionPolicy: Readonly<HermeticExecutableExecutionPolicyV1>;
  readonly executionModes: typeof HERMETIC_GIT_EXECUTION_MODES_V1;
  withRepository<T>(
    worktreePath: string,
    action: (session: HermeticGitRepositoryAsyncSessionV1) => T | Promise<T>,
  ): Promise<T>;
  withRepositorySync<T>(
    worktreePath: string,
    action: (session: HermeticGitRepositorySyncSessionV1) => HermeticGitSynchronousResult<T>,
  ): T;
}

export interface GitStreamFingerprint {
  readonly byteLength: bigint;
  readonly sha256: string;
}

export interface CanonicalGitWorktreeStatus {
  readonly headSha: string;
  readonly dirty: boolean;
  readonly statusSha256: string;
  readonly repositoryConfiguration: GitStreamFingerprint;
  readonly repositorySubstrate: GitStreamFingerprint;
  readonly headTreeRecords: GitStreamFingerprint;
  readonly indexRecords: GitStreamFingerprint;
  readonly trackedWorktreeRecords: GitStreamFingerprint;
  readonly trackedWorktreeSubstrate: GitStreamFingerprint;
  readonly untrackedPaths: GitStreamFingerprint;
  readonly untrackedGitignoreAuthorities: GitStreamFingerprint;
  readonly substrateAttestationSha256: string;
}

export interface CanonicalGitWorktreeEvidence {
  readonly headSha: string;
  readonly dirty: boolean;
  readonly statusSha256: string;
  readonly contentSha256: string;
  readonly substrateAttestationSha256: string;
}

export interface CanonicalGitWorktreeEvidenceObserver {
  beforeSnapshotVerification?: () => Promise<void> | void;
  afterRepositoryTopologyRead?: (worktreePath: string) => Promise<void> | void;
}

export class InventoryInspectionError extends Error {
  public constructor(
    public readonly code:
      | 'CI_EXECUTION_IDENTITY_INVALID'
      | 'CI_EXECUTION_IDENTITY_MISMATCH'
      | 'DIRTY_SNAPSHOT_MOVED'
      | 'INVENTORY_EXECUTION_INTENT_INVALID'
      | 'ORIGIN_MAIN_MOVED'
      | 'WORKTREE_AUTHORITY_MIGRATION_REQUIRED',
    message: string,
  ) {
    super(message);
    this.name = 'InventoryInspectionError';
  }
}

export class HermeticGitExecutionTimeoutError extends Error {
  public readonly code = 'HERMETIC_GIT_EXECUTION_TIMEOUT' as const;

  public constructor(
    public readonly executionMode: 'BUFFERED' | 'STREAMED',
    public readonly worktreePath: string,
    args: readonly string[],
    public readonly commandDeadlineMs: number,
    public readonly timeoutSignal: 'SIGKILL',
    public readonly deadlineSource: 'EXECUTION_POLICY' | 'CONTEXT_BUDGET' = 'EXECUTION_POLICY',
    private readonly contextDeadlineAuthority: symbol | undefined = undefined,
  ) {
    super(
      `Hermetic Git ${executionMode} execution exceeded its ${String(commandDeadlineMs)}ms deadline in ${worktreePath}: git ${args.join(' ')}`,
    );
    this.name = 'HermeticGitExecutionTimeoutError';
    this.args = Object.freeze([...args]);
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public readonly args: readonly string[];

  public isContextDeadlineOwnedBy(deadlineAuthority: symbol): boolean {
    return (
      this.deadlineSource === 'CONTEXT_BUDGET' &&
      this.contextDeadlineAuthority === deadlineAuthority
    );
  }
}

export class HermeticGitExecutionCleanupError extends Error {
  public readonly code = 'HERMETIC_GIT_EXECUTION_CLEANUP_FAILED' as const;

  public constructor(
    public readonly executionMode: 'BUFFERED' | 'STREAMED',
    public readonly worktreePath: string,
    args: readonly string[],
    public readonly cleanupDeadlineMs: number,
    public readonly timeoutSignal: 'SIGKILL',
    public readonly cause: unknown,
  ) {
    super(
      `Hermetic Git ${executionMode} execution did not emit close within its ${String(cleanupDeadlineMs)}ms cleanup deadline in ${worktreePath}: git ${args.join(' ')}`,
    );
    this.name = 'HermeticGitExecutionCleanupError';
    this.args = Object.freeze([...args]);
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public readonly args: readonly string[];
}

export class HermeticGitSynchronousBudgetError extends Error {
  public readonly code = 'HERMETIC_GIT_SYNCHRONOUS_BUDGET_FORBIDDEN' as const;

  public constructor(
    public readonly worktreePath: string,
    args: readonly string[],
  ) {
    super(
      `Hermetic Git synchronous execution is forbidden inside a live execution budget in ${worktreePath}: git ${args.join(' ')}`,
    );
    this.name = 'HermeticGitSynchronousBudgetError';
    this.args = Object.freeze([...args]);
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public readonly args: readonly string[];
}

function parseGitVersion(raw: string): readonly [number, number, number] {
  const match = /^git version (?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:[.-].*)?\n?$/.exec(raw);
  if (!match?.groups) {
    throw new Error(`Hermetic Git returned an invalid version: ${JSON.stringify(raw)}`);
  }
  const version = [
    Number.parseInt(match.groups.major ?? '', 10),
    Number.parseInt(match.groups.minor ?? '', 10),
    Number.parseInt(match.groups.patch ?? '', 10),
  ] as const;
  for (let index = 0; index < MINIMUM_GIT_VERSION.length; index += 1) {
    const actual = version[index] ?? 0;
    const minimum = MINIMUM_GIT_VERSION[index] ?? 0;
    if (actual > minimum) {
      return version;
    }
    if (actual < minimum) {
      throw new Error(
        `Hermetic Git ${version.join('.')} is older than ${MINIMUM_GIT_VERSION.join('.')}`,
      );
    }
  }
  return version;
}

function attestGitBinary(executionPolicy: Readonly<HermeticExecutableExecutionPolicyV1>): {
  readonly executable: HermeticExecutableAuthorityV1;
  readonly attestation: HermeticGitAttestation;
} {
  const executable = openHermeticExecutableAuthority(
    {
      path: GIT_BINARY_PATH,
      label: 'Hermetic Git binary',
      versionArgs: ['--version'],
      versionEnvironment: HERMETIC_GIT_ENV,
      executionPolicy,
      maximumBytes: MAX_GIT_BINARY_BYTES,
      maximumVersionBytes: MAX_BOUNDED_TEXT_BYTES,
    },
    performance.now() + executionPolicy.commandDeadlineMs,
  );
  try {
    const semanticVersion = parseGitVersion(executable.attestation.version);
    return Object.freeze({
      executable,
      attestation: Object.freeze({
        binaryPath: GIT_BINARY_PATH,
        binarySha256: executable.attestation.binarySha256,
        version: executable.attestation.version,
        semanticVersion: Object.freeze(semanticVersion),
      }),
    });
  } catch (error) {
    const parsingFailure =
      error instanceof Error ? error : new Error('Hermetic Git version parsing failed');
    try {
      executable.close();
    } catch (closeError) {
      throw new AggregateError(
        [
          parsingFailure,
          closeError instanceof Error
            ? closeError
            : new Error('Hermetic Git executable cleanup failed'),
        ],
        'Hermetic Git attestation and executable cleanup both failed',
      );
    }
    throw parsingFailure;
  }
}

function requireAbsoluteWorktreePath(worktreePath: string): string {
  if (!isAbsolute(worktreePath) || worktreePath.includes('\0')) {
    throw new Error(`Hermetic Git worktree path must be absolute: ${JSON.stringify(worktreePath)}`);
  }
  return realpathSync(worktreePath);
}

function validateGitArgs(args: readonly string[]): void {
  if (
    args.length === 0 ||
    args.some((argument) => argument.length === 0 || argument.includes('\0'))
  ) {
    throw new Error('Hermetic Git requires non-empty, NUL-free arguments');
  }
}

interface CompiledHermeticGitReadQueryV1 {
  readonly args: readonly string[];
  readonly acceptedStatuses: readonly number[];
  readonly input: Buffer | undefined;
  readonly maximumOutputBytes: number;
}

const FULL_SHA1_PATTERN = /^[0-9a-f]{40}$/;
const REACHABILITY_SHA1_PATTERN = /^[0-9a-f]{7,40}$/;
const CANONICAL_REF_PATTERN = /^refs\/(?:heads|remotes\/origin)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_PUBLIC_GIT_COLLECTION_BYTES = 64 * 1024 * 1024;
const MAX_PUBLIC_GIT_MESSAGE_BYTES = 1024 * 1024;
const MAX_PUBLIC_GIT_QUERY_ITEMS = 4096;
const MAX_PUBLIC_GIT_PATH_BYTES = 4096;
const MAX_PUBLIC_GIT_QUERY_INPUT_BYTES = 512 * 1024;

function requireFullSha1(value: string, field: string): string {
  if (!FULL_SHA1_PATTERN.test(value)) {
    throw new TypeError(`${field} must be one lowercase full SHA-1 object ID`);
  }
  return value;
}

function requireCanonicalRef(value: string, field: string): string {
  if (
    value !== 'HEAD' &&
    (!CANONICAL_REF_PATTERN.test(value) ||
      value.includes('..') ||
      value.includes('//') ||
      value.includes('@{') ||
      value.endsWith('/') ||
      value.endsWith('.') ||
      value.endsWith('.lock'))
  ) {
    throw new TypeError(`${field} must be HEAD or one canonical local/origin ref`);
  }
  return value;
}

function requireObjectRevision(value: string, field: string): string {
  return FULL_SHA1_PATTERN.test(value) ? value : requireCanonicalRef(value, field);
}

function requireReachabilityRevision(value: string, field: string): string {
  return REACHABILITY_SHA1_PATTERN.test(value) ? value : requireCanonicalRef(value, field);
}

function requireRepositoryPath(value: string, field: string): string {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_PUBLIC_GIT_PATH_BYTES ||
    value.startsWith('/') ||
    value.includes('\\') ||
    /[\0\r\n]/.test(value) ||
    value.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new TypeError(`${field} must be one normalized repository-relative path`);
  }
  return value;
}

function requireLiteralTopLevelPathspecs(
  values: readonly string[],
  field: string,
): readonly string[] {
  if (values.length > MAX_PUBLIC_GIT_QUERY_ITEMS) {
    throw new TypeError(
      `${field} exceeds its ${String(MAX_PUBLIC_GIT_QUERY_ITEMS)}-item query limit`,
    );
  }
  const pathspecs = values.map(
    (value, index) => `:(top,literal)${requireRepositoryPath(value, `${field}[${index}]`)}`,
  );
  const encodedBytes = pathspecs.reduce(
    (total, pathspec) => total + Buffer.byteLength(pathspec, 'utf8') + 1,
    0,
  );
  if (encodedBytes > MAX_PUBLIC_GIT_QUERY_INPUT_BYTES) {
    throw new TypeError(
      `${field} exceeds its ${String(MAX_PUBLIC_GIT_QUERY_INPUT_BYTES)}-byte query limit`,
    );
  }
  return Object.freeze(pathspecs);
}

function compileHermeticGitReadQueryV1(
  query: HermeticGitReadQueryV1,
): CompiledHermeticGitReadQueryV1 {
  const compiled = (
    args: readonly string[],
    maximumOutputBytes: number,
    acceptedStatuses: readonly number[] = [0],
    input?: Buffer,
  ): CompiledHermeticGitReadQueryV1 =>
    Object.freeze({
      args: Object.freeze([...args]),
      acceptedStatuses: Object.freeze([...acceptedStatuses]),
      input,
      maximumOutputBytes,
    });

  switch (query.kind) {
    case 'RESOLVE_OBJECT': {
      const revision = requireReachabilityRevision(query.revision, 'RESOLVE_OBJECT.revision');
      if (query.peel === 'PATH') {
        if (query.path === undefined) {
          throw new TypeError('RESOLVE_OBJECT PATH requires a path');
        }
        return compiled(
          [
            'rev-parse',
            '--verify',
            ...(query.quiet === true ? ['--quiet'] : []),
            `${revision}:${requireRepositoryPath(query.path, 'RESOLVE_OBJECT.path')}`,
          ],
          MAX_BOUNDED_TEXT_BYTES,
          query.quiet === true ? [0, 1] : [0],
        );
      }
      if (query.path !== undefined) {
        throw new TypeError('RESOLVE_OBJECT path is valid only for PATH peeling');
      }
      return compiled(
        [
          'rev-parse',
          '--verify',
          ...(query.quiet === true ? ['--quiet'] : []),
          `${revision}^{${query.peel.toLowerCase()}}`,
        ],
        MAX_BOUNDED_TEXT_BYTES,
        query.quiet === true ? [0, 1] : [0],
      );
    }
    case 'REPOSITORY_COORDINATE': {
      const coordinates: Record<typeof query.coordinate, readonly string[]> = {
        TOP_LEVEL: ['rev-parse', '--show-toplevel'],
        GIT_DIR: ['rev-parse', '--path-format=absolute', '--git-dir'],
        COMMON_DIR: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        OBJECTS: ['rev-parse', '--path-format=absolute', '--git-path', 'objects'],
        OBJECT_FORMAT: ['rev-parse', '--show-object-format'],
      };
      return compiled(coordinates[query.coordinate], MAX_BOUNDED_TEXT_BYTES);
    }
    case 'CHECK_BRANCH_REF':
      if (
        query.shortName.length === 0 ||
        query.shortName.length > 1024 ||
        query.shortName.startsWith('refs/') ||
        /[\0\r\n]/.test(query.shortName)
      ) {
        throw new TypeError('CHECK_BRANCH_REF.shortName is outside its bounded short-ref domain');
      }
      return compiled(
        ['check-ref-format', `refs/heads/${query.shortName}`],
        MAX_BOUNDED_TEXT_BYTES,
        [0, 1],
      );
    case 'SYMBOLIC_HEAD':
      return compiled(['symbolic-ref', '-q', 'HEAD'], MAX_BOUNDED_TEXT_BYTES, [0, 1]);
    case 'MERGE_BASE':
      return compiled(
        [
          'merge-base',
          requireFullSha1(query.left, 'MERGE_BASE.left'),
          requireFullSha1(query.right, 'MERGE_BASE.right'),
        ],
        MAX_BOUNDED_TEXT_BYTES,
      );
    case 'IS_ANCESTOR':
      return compiled(
        [
          'merge-base',
          '--is-ancestor',
          requireReachabilityRevision(query.ancestor, 'IS_ANCESTOR.ancestor'),
          requireReachabilityRevision(query.descendant, 'IS_ANCESTOR.descendant'),
        ],
        MAX_BOUNDED_TEXT_BYTES,
        [0, 1],
      );
    case 'LIST_REFS': {
      const namespaces: Record<typeof query.namespace, string> = {
        LOCAL_HEADS: 'refs/heads',
        ORIGIN_REMOTES: 'refs/remotes/origin',
        REPLACE: 'refs/replace',
      };
      const format = query.projection === 'NAMES' ? '%(refname)' : '%(refname)%09%(objectname)';
      return compiled(
        [
          'for-each-ref',
          ...(query.contains === undefined
            ? []
            : [`--contains=${requireFullSha1(query.contains, 'LIST_REFS.contains')}`]),
          `--format=${format}`,
          namespaces[query.namespace],
        ],
        MAX_PUBLIC_GIT_COLLECTION_BYTES,
      );
    }
    case 'LIST_WORKTREES':
      return compiled(['worktree', 'list', '--porcelain', '-z'], MAX_PUBLIC_GIT_COLLECTION_BYTES);
    case 'LIST_INDEX_PATHS': {
      const roots = requireLiteralTopLevelPathspecs(query.roots, 'LIST_INDEX_PATHS.roots');
      return compiled(
        [
          'ls-files',
          ...(query.selection === 'UNTRACKED_STANDARD' ? ['--others', '--exclude-standard'] : []),
          '-z',
          '--',
          ...roots,
        ],
        MAX_PUBLIC_GIT_COLLECTION_BYTES,
      );
    }
    case 'LIST_TREE': {
      const revision = requireFullSha1(query.revision, 'LIST_TREE.revision');
      const paths = requireLiteralTopLevelPathspecs(query.paths, 'LIST_TREE.paths');
      return compiled(
        [
          'ls-tree',
          ...(query.recursive ? ['-r'] : []),
          ...(query.projection === 'PATHS' ? ['--name-only'] : []),
          '-z',
          revision,
          '--',
          ...paths,
        ],
        MAX_PUBLIC_GIT_COLLECTION_BYTES,
      );
    }
    case 'OBJECT_TYPE':
      return compiled(
        ['cat-file', '-t', requireFullSha1(query.oid, 'OBJECT_TYPE.oid')],
        MAX_BOUNDED_TEXT_BYTES,
      );
    case 'OBJECT_EXISTS':
      return compiled(
        [
          'cat-file',
          '-e',
          `${requireFullSha1(query.oid, 'OBJECT_EXISTS.oid')}^{${query.objectKind.toLowerCase()}}`,
        ],
        MAX_BOUNDED_TEXT_BYTES,
        [0, 1, 128],
      );
    case 'READ_BLOB':
      return compiled(
        ['cat-file', 'blob', requireFullSha1(query.oid, 'READ_BLOB.oid')],
        MAX_PUBLIC_GIT_COLLECTION_BYTES,
      );
    case 'READ_BLOB_BATCH': {
      if (query.oids.length === 0 || query.oids.length > MAX_PUBLIC_GIT_QUERY_ITEMS) {
        throw new TypeError(
          `READ_BLOB_BATCH requires 1..${String(MAX_PUBLIC_GIT_QUERY_ITEMS)} object IDs`,
        );
      }
      const oids = query.oids.map((oid, index) =>
        requireFullSha1(oid, `READ_BLOB_BATCH.oids[${index}]`),
      );
      return compiled(
        ['cat-file', '--batch'],
        MAX_GIT_BLOB_BATCH_BYTES,
        [0],
        Buffer.from(`${oids.join('\n')}\n`, 'ascii'),
      );
    }
    case 'READ_COMMIT_BATCH': {
      if (query.oids.length === 0 || query.oids.length > MAX_PUBLIC_GIT_QUERY_ITEMS) {
        throw new TypeError(
          `READ_COMMIT_BATCH requires 1..${String(MAX_PUBLIC_GIT_QUERY_ITEMS)} object IDs`,
        );
      }
      const revisions = query.oids.map(
        (oid, index) =>
          `${requireReachabilityRevision(oid, `READ_COMMIT_BATCH.oids[${index}]`)}^{commit}`,
      );
      const input = Buffer.from(`${revisions.join('\n')}\n`, 'ascii');
      if (input.length > MAX_PUBLIC_GIT_QUERY_INPUT_BYTES) {
        throw new TypeError('READ_COMMIT_BATCH input exceeds its bounded query budget');
      }
      return compiled(['cat-file', '--batch'], MAX_GIT_BLOB_BATCH_BYTES, [0], input);
    }
    case 'DIFF': {
      const base = requireObjectRevision(query.base, 'DIFF.base');
      const head = query.head === undefined ? [] : [requireObjectRevision(query.head, 'DIFF.head')];
      const paths = requireLiteralTopLevelPathspecs(query.paths, 'DIFF.paths');
      const projectionArgs: readonly string[] =
        query.projection === 'QUIET'
          ? ['--quiet']
          : query.projection === 'NAME_ONLY'
            ? ['--name-only', '-z']
            : ['--unified=0', '--no-ext-diff'];
      return compiled(
        [
          'diff',
          ...projectionArgs,
          ...(query.noRenames === true ? ['--no-renames'] : []),
          base,
          ...head,
          '--',
          ...paths,
        ],
        query.projection === 'QUIET' ? MAX_BOUNDED_TEXT_BYTES : MAX_PUBLIC_GIT_COLLECTION_BYTES,
        query.projection === 'QUIET' ? [0, 1] : [0],
      );
    }
    case 'SHOW_COMMIT_MESSAGE':
      return compiled(
        [
          'show',
          '-s',
          '--format=%B',
          requireReachabilityRevision(query.oid, 'SHOW_COMMIT_MESSAGE.oid'),
        ],
        MAX_PUBLIC_GIT_MESSAGE_BYTES,
      );
    case 'SHOW_PATH':
      return compiled(
        [
          'show',
          `${requireObjectRevision(query.revision, 'SHOW_PATH.revision')}:${requireRepositoryPath(query.path, 'SHOW_PATH.path')}`,
        ],
        MAX_PUBLIC_GIT_COLLECTION_BYTES,
      );
    case 'FIND_AUTOMATION_COMMAND':
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(query.commandId)) {
        throw new TypeError('FIND_AUTOMATION_COMMAND.commandId is outside its bounded ID domain');
      }
      return compiled(
        [
          'log',
          'HEAD',
          '--fixed-strings',
          '--grep',
          `Automation-Command-ID: ${query.commandId}`,
          '--format=%H',
        ],
        MAX_PUBLIC_GIT_COLLECTION_BYTES,
      );
    default: {
      const unsupported = query as { readonly kind?: unknown };
      throw new TypeError(
        `Hermetic Git read query kind is not governed: ${JSON.stringify(unsupported.kind)}`,
      );
    }
  }
}

function formatGitFailure(
  args: readonly string[],
  worktreePath: string,
  status: number | null,
  stderr: string,
): string {
  return `git ${args.join(' ')} failed in ${worktreePath} with status ${String(status)}: ${
    stderr.trim() || 'no stderr'
  }`;
}

function bufferFromUnknownChunk(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (typeof chunk === 'string') {
    return Buffer.from(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  throw new Error('Git stream emitted a non-byte chunk');
}

async function collectBoundedStderr(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const bytes = bufferFromUnknownChunk(chunk);
    if (capturedBytes >= MAX_STREAMED_STDERR_BYTES) {
      truncated = true;
      continue;
    }
    const accepted = bytes.subarray(0, MAX_STREAMED_STDERR_BYTES - capturedBytes);
    chunks.push(Buffer.from(accepted));
    capturedBytes += accepted.length;
    truncated ||= accepted.length !== bytes.length;
  }
  const captured = decodeFatalUtf8(Buffer.concat(chunks, capturedBytes), 'Hermetic Git stderr');
  return `${captured.trim()}${truncated ? ' [stderr truncated]' : ''}`;
}

async function collectBoundedBuffer(
  stream: Readable,
  maximumBytes: number,
  label: string,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError(`${label} maximum bytes must be one positive safe integer`);
  }
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of stream) {
    const bytes = bufferFromUnknownChunk(chunk);
    if (byteLength + bytes.length > maximumBytes) {
      throw new Error(`${label} exceeds its ${String(maximumBytes)}-byte limit`);
    }
    chunks.push(Buffer.from(bytes));
    byteLength += bytes.length;
  }
  return Buffer.concat(chunks, byteLength);
}

function writeHermeticGitInput(
  child: ReturnType<typeof spawn>,
  input: string | Buffer | undefined,
): Promise<void> {
  if (input === undefined) return Promise.resolve();
  if (child.stdin === null) {
    return Promise.reject(new Error('Hermetic Git child did not expose its stdin stream'));
  }
  const stdin = child.stdin;
  return new Promise<void>((resolveInput, rejectInput) => {
    const onError = (error: Error): void => rejectInput(error);
    stdin.once('error', onError);
    stdin.end(input, () => {
      stdin.off('error', onError);
      resolveInput();
    });
  });
}

interface HermeticGitInvocationV1 {
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly inheritedDirectoryDescriptors: readonly number[];
}

function resolveHermeticGitInvocation(
  worktreePath: string,
  args: readonly string[],
  repositoryMode: 'WORKTREE' | 'NO_REPOSITORY' = 'WORKTREE',
): HermeticGitInvocationV1 {
  validateGitArgs(args);
  if (repositoryMode === 'NO_REPOSITORY') {
    return Object.freeze({
      args: Object.freeze([...GIT_INVOCATION_PREFIX, ...args]),
      cwd: '/',
      environment: HERMETIC_GIT_NO_REPOSITORY_ENV,
      inheritedDirectoryDescriptors: Object.freeze([]),
    });
  }
  const absoluteWorktreePath = requireAbsoluteWorktreePath(worktreePath);
  const descriptorAuthority = hermeticGitRepositoryDescriptorAuthority.getStore();
  if (descriptorAuthority !== undefined) {
    if (descriptorAuthority.worktreePath !== absoluteWorktreePath) {
      throw new Error('Hermetic Git repository descriptor authority cannot cross worktrees');
    }
    descriptorAuthority.assertCurrent();
    return Object.freeze({
      args: Object.freeze([...GIT_INVOCATION_PREFIX, '-C', repositoryChildCwdPath(), ...args]),
      cwd: '/',
      environment: descriptorAuthority.environment,
      inheritedDirectoryDescriptors: Object.freeze(
        REPOSITORY_CHILD_FD_COORDINATES_V1.map((coordinate) =>
          descriptorAuthority.parentDescriptor(coordinate.role),
        ),
      ),
    });
  }
  return Object.freeze({
    args: Object.freeze([...GIT_INVOCATION_PREFIX, '-C', absoluteWorktreePath, ...args]),
    cwd: undefined,
    environment: HERMETIC_GIT_ENV,
    inheritedDirectoryDescriptors: Object.freeze([]),
  });
}

function hermeticGitStdio(
  input: string | Buffer | undefined,
  invocation: HermeticGitInvocationV1,
): Array<'ignore' | 'pipe' | number> {
  return [
    input === undefined ? 'ignore' : 'pipe',
    'pipe',
    'pipe',
    ...invocation.inheritedDirectoryDescriptors,
  ];
}

function requireGovernedGitExecutionPolicy(
  policy: HermeticExecutableExecutionPolicyV1,
): Readonly<HermeticExecutableExecutionPolicyV1> {
  if (!Object.isFrozen(policy)) {
    throw new Error('Hermetic Git execution policy must be immutable');
  }
  const validated = defineHermeticExecutableExecutionPolicyV1(policy);
  if (validated.commandDeadlineMs > HERMETIC_GIT_EXECUTION_POLICY_V1.commandDeadlineMs) {
    throw new Error('Hermetic Git runtime policy cannot relax the production command deadline');
  }
  return validated;
}

interface BoundedHermeticGitCommandPolicyV1 extends HermeticExecutableExecutionPolicyV1 {
  readonly deadlineSource: 'EXECUTION_POLICY' | 'CONTEXT_BUDGET';
  readonly contextDeadlineAuthority: symbol | undefined;
}

function boundedHermeticGitCommandPolicy(
  executionPolicy: Readonly<HermeticExecutableExecutionPolicyV1>,
  executionMode: 'BUFFERED' | 'STREAMED',
  worktreePath: string,
  args: readonly string[],
): Readonly<BoundedHermeticGitCommandPolicyV1> {
  const budget = hermeticGitExecutionBudget.getStore();
  if (budget === undefined) {
    return Object.freeze({
      ...executionPolicy,
      deadlineSource: 'EXECUTION_POLICY' as const,
      contextDeadlineAuthority: undefined,
    });
  }
  const abortedSignal = budget.signals.find((signal) => signal.aborted);
  if (abortedSignal !== undefined) {
    if (abortedSignal.reason instanceof Error) throw abortedSignal.reason;
    throw new Error('Hermetic Git execution budget was aborted');
  }
  const sealedChildAuthority = budget.childDrainAuthorities.find(
    (authority) => authority.state === 'SEALED',
  );
  if (sealedChildAuthority !== undefined) {
    throw (
      sealedChildAuthority.failure ??
      new Error('Hermetic Git execution child authority is already sealed')
    );
  }
  const remainingMs = Math.floor(budget.deadlineMs - performance.now());
  if (remainingMs <= 0) {
    throw new HermeticGitExecutionTimeoutError(
      executionMode,
      worktreePath,
      args,
      1,
      executionPolicy.timeoutSignal,
      'CONTEXT_BUDGET',
      budget.deadlineAuthority,
    );
  }
  const contextBudgetIsAuthoritative = remainingMs <= executionPolicy.commandDeadlineMs;
  const boundedPolicy = defineHermeticExecutableExecutionPolicyV1({
    schemaVersion: executionPolicy.schemaVersion,
    commandDeadlineMs: Math.min(executionPolicy.commandDeadlineMs, remainingMs),
    timeoutSignal: executionPolicy.timeoutSignal,
  });
  return Object.freeze({
    ...boundedPolicy,
    deadlineSource: contextBudgetIsAuthoritative
      ? ('CONTEXT_BUDGET' as const)
      : ('EXECUTION_POLICY' as const),
    contextDeadlineAuthority: contextBudgetIsAuthoritative ? budget.deadlineAuthority : undefined,
  });
}

function requireSynchronousHermeticGitExecutionOutsideBudget(
  worktreePath: string,
  args: readonly string[],
): void {
  if (hermeticGitExecutionBudget.getStore() !== undefined) {
    throw new HermeticGitSynchronousBudgetError(worktreePath, args);
  }
}

type HermeticGitAsyncOutcome<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: Error }>;

function observeHermeticGitAsyncOutcome<T>(
  promise: Promise<T>,
): Promise<HermeticGitAsyncOutcome<T>> {
  return promise.then(
    (value) => Object.freeze({ ok: true as const, value }),
    (error: unknown) =>
      Object.freeze({
        ok: false as const,
        error: errorFromUnknown('Hermetic Git asynchronous component failed', error),
      }),
  );
}

interface HermeticGitComponentFailureObservation {
  readonly completion: Promise<void>;
  close(): void;
}

/**
 * One explicitly settleable failure authority for every asynchronous child component. A
 * successful component cannot complete the command before the child closes, while closing the
 * observer releases all Promise.race reactions after the command has settled.
 */
function observeHermeticGitComponentFailures(
  outcomes: readonly Promise<HermeticGitAsyncOutcome<unknown>>[],
): HermeticGitComponentFailureObservation {
  let settled = false;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  for (const outcome of outcomes) {
    void outcome.then((observed) => {
      if (settled || observed.ok) return;
      settled = true;
      rejectCompletion(observed.error);
    });
  }
  return Object.freeze({
    completion,
    close(): void {
      if (settled) return;
      settled = true;
      resolveCompletion();
    },
  });
}

function hermeticGitAbortError(signal: AbortSignal): Error {
  return errorFromUnknown('Hermetic Git execution budget was aborted', signal.reason);
}

function isChildActive(child: ReturnType<typeof spawn>): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function signalHermeticGitProcessGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  const processGroupId = child.pid;
  if (processGroupId === undefined) {
    if (isChildActive(child)) child.kill(signal);
    return;
  }
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if (errorCode(error) === 'ESRCH') {
      if (isChildActive(child)) child.kill(signal);
      return;
    }
    throw error;
  }
}

interface HermeticGitChildCloseResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly lifecycleError: Error | null;
}

interface HermeticGitChildCloseObservation {
  readonly completion: Promise<HermeticGitChildCloseResult>;
  /** Resolves only after `close` and process-group quiescence; a timeout is never reaping evidence. */
  readonly reaped: Promise<void>;
  abandon(error: Error): void;
}

interface HermeticGitChildInterruptionObservation {
  readonly completion: Promise<void>;
  readonly failure: () => Error | null;
  close(): void;
}

function observeHermeticGitChildInterruption(
  child: ReturnType<typeof spawn>,
  worktreePath: string,
  args: readonly string[],
  commandPolicy: Readonly<BoundedHermeticGitCommandPolicyV1>,
  commandCutMs: number,
  executionMode: 'BUFFERED' | 'STREAMED',
): HermeticGitChildInterruptionObservation {
  const budget = hermeticGitExecutionBudget.getStore();
  const signalListeners: Array<readonly [AbortSignal, () => void]> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let forcedFailure: Error | null = null;
  let settled = false;
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const interrupt = (requestedFailure: Error): void => {
    if (settled) return;
    let failure = requestedFailure;
    try {
      signalHermeticGitProcessGroup(child, commandPolicy.timeoutSignal);
    } catch (error) {
      failure = new AggregateError(
        [requestedFailure, errorFromUnknown('Hermetic Git child interrupt failed', error)],
        'Hermetic Git interruption and child termination both failed',
      );
    }
    settled = true;
    forcedFailure = failure;
    rejectCompletion(failure);
  };
  for (const signal of budget?.signals ?? []) {
    const listener = (): void => interrupt(hermeticGitAbortError(signal));
    signalListeners.push([signal, listener]);
    signal.addEventListener('abort', listener, { once: true });
  }
  const alreadyAborted = budget?.signals.find((signal) => signal.aborted);
  if (alreadyAborted !== undefined) {
    interrupt(hermeticGitAbortError(alreadyAborted));
  } else {
    const remainingCommandMs = Math.floor(commandCutMs - performance.now());
    const timeoutError = new HermeticGitExecutionTimeoutError(
      executionMode,
      worktreePath,
      args,
      commandPolicy.commandDeadlineMs,
      commandPolicy.timeoutSignal,
      commandPolicy.deadlineSource,
      commandPolicy.contextDeadlineAuthority,
    );
    if (remainingCommandMs < 1) {
      interrupt(timeoutError);
    } else {
      timer = setTimeout(() => interrupt(timeoutError), remainingCommandMs);
    }
  }
  return Object.freeze({
    completion,
    failure: () => forcedFailure,
    close(): void {
      if (timer !== undefined) clearTimeout(timer);
      for (const [signal, listener] of signalListeners) {
        signal.removeEventListener('abort', listener);
      }
      if (!settled) {
        settled = true;
        resolveCompletion();
      }
    },
  });
}

function observeHermeticGitChildClose(
  child: ReturnType<typeof spawn>,
  processGroupCleanupSignal: NodeJS.Signals,
): HermeticGitChildCloseObservation {
  const processGroupId = child.pid;
  let completionSettled = false;
  let lifecycleError: Error | null = null;
  let resolveCompletion!: (result: HermeticGitChildCloseResult) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<HermeticGitChildCloseResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  let resolveReaped!: () => void;
  const reaped = new Promise<void>((resolve) => {
    resolveReaped = resolve;
  });
  const onError = (error: Error): void => {
    lifecycleError ??= error;
  };
  const waitForProcessGroupQuiescence = async (): Promise<void> => {
    if (processGroupId === undefined) return;
    for (;;) {
      try {
        process.kill(-processGroupId, 0);
      } catch (error) {
        if (errorCode(error) === 'ESRCH') return;
        throw error;
      }
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    }
  };
  const settleAfterProcessGroupQuiescence = (
    status: number | null,
    signal: NodeJS.Signals | null,
    quiescenceError?: unknown,
  ): void => {
    if (quiescenceError !== undefined) {
      lifecycleError ??= errorFromUnknown(
        'Hermetic Git process-group quiescence observation failed',
        quiescenceError,
      );
    }
    resolveReaped();
    if (!completionSettled) {
      completionSettled = true;
      resolveCompletion(Object.freeze({ status, signal, lifecycleError }));
    }
  };
  const onClose = (status: number | null, signal: NodeJS.Signals | null): void => {
    child.off('error', onError);
    try {
      // Git is the process-group leader. A successful leader can still leave a redirected,
      // stdio-detached descendant behind. Signal the whole group, then prove that it no longer
      // exists before publishing either completion or reaping evidence.
      signalHermeticGitProcessGroup(child, processGroupCleanupSignal);
    } catch (error) {
      lifecycleError ??= errorFromUnknown(
        'Hermetic Git process-group cleanup failed after child close',
        error,
      );
    }
    void waitForProcessGroupQuiescence().then(
      () => settleAfterProcessGroupQuiescence(status, signal),
      (error: unknown) => settleAfterProcessGroupQuiescence(status, signal, error),
    );
  };
  child.on('error', onError);
  child.once('close', onClose);
  return Object.freeze({
    completion,
    reaped,
    abandon(error: Error): void {
      if (completionSettled) return;
      completionSettled = true;
      // A process that missed the cleanup deadline is not claimed as reaped. Keep the error
      // sink and late-close listener attached until the kernel eventually reports termination.
      rejectCompletion(error);
    },
  });
}

function reserveHermeticGitChildDrain(): HermeticGitChildDrainReservationV1 {
  const budget = hermeticGitExecutionBudget.getStore();
  const authorities = budget?.childDrainAuthorities ?? [];
  for (const authority of authorities) {
    if (authority.state === 'SEALED') {
      throw (
        authority.failure ?? new Error('Hermetic Git execution child authority is already sealed')
      );
    }
  }
  let resolveDrain!: () => void;
  const drain = new Promise<void>((resolve) => {
    resolveDrain = resolve;
  });
  const enrolledAuthorities: HermeticGitChildDrainAuthorityV1[] = [];
  try {
    for (const authority of authorities) {
      authority.childDrains.add(drain);
      enrolledAuthorities.push(authority);
    }
  } catch (error) {
    for (const authority of enrolledAuthorities) authority.childDrains.delete(drain);
    resolveDrain();
    throw error;
  }
  void drain.then(() => {
    for (const authority of authorities) {
      authority.childDrains.delete(drain);
    }
  });
  let state: 'RESERVED' | 'BOUND' | 'RELEASED' = 'RESERVED';
  return Object.freeze({
    bind(observation: HermeticGitChildCloseObservation): void {
      if (state !== 'RESERVED') {
        throw new Error('Hermetic Git child drain reservation was already consumed');
      }
      state = 'BOUND';
      void observation.reaped.then(resolveDrain);
    },
    release(): void {
      if (state !== 'RESERVED') return;
      state = 'RELEASED';
      resolveDrain();
    },
  });
}

async function requireHermeticGitChildCloseAfterFailure(
  child: ReturnType<typeof spawn>,
  observation: HermeticGitChildCloseObservation,
  executionPolicy: Readonly<HermeticExecutableExecutionPolicyV1>,
  worktreePath: string,
  args: readonly string[],
  cause: unknown,
  executionMode: 'BUFFERED' | 'STREAMED',
): Promise<void> {
  signalHermeticGitProcessGroup(child, executionPolicy.timeoutSignal);
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();

  const cleanupError = new HermeticGitExecutionCleanupError(
    executionMode,
    worktreePath,
    args,
    executionPolicy.commandDeadlineMs,
    executionPolicy.timeoutSignal,
    cause,
  );
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveCleanupDeadline!: () => void;
  const cleanupDeadline = new Promise<void>((resolve, reject) => {
    resolveCleanupDeadline = resolve;
    cleanupTimer = setTimeout(() => reject(cleanupError), executionPolicy.commandDeadlineMs);
  });
  try {
    await Promise.race([observation.completion, cleanupDeadline]);
  } catch (error) {
    if (error === cleanupError) observation.abandon(cleanupError);
    throw error;
  } finally {
    if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    resolveCleanupDeadline();
  }
}

function createHermeticGitRuntime(
  policy: HermeticExecutableExecutionPolicyV1,
): HermeticGitRuntimeV1 {
  const executionPolicy = requireGovernedGitExecutionPolicy(policy);
  let binaryAuthority: ReturnType<typeof attestGitBinary> | undefined;
  let closed = false;
  const resolveBinaryAuthority = (
    attestationPolicy: Readonly<HermeticExecutableExecutionPolicyV1> = executionPolicy,
  ): ReturnType<typeof attestGitBinary> => {
    if (closed) throw new Error('Hermetic Git runtime is closed');
    binaryAuthority ??= attestGitBinary(attestationPolicy);
    return binaryAuthority;
  };
  const assertBinaryCurrent = (
    attestationPolicy: Readonly<HermeticExecutableExecutionPolicyV1> = executionPolicy,
  ): void => {
    resolveBinaryAuthority(attestationPolicy).executable.assertCurrent();
  };

  const executeAsync = async <TStderr>(
    executionMode: 'BUFFERED' | 'STREAMED',
    worktreePath: string,
    args: readonly string[],
    acceptedStatuses: readonly number[],
    input: string | Buffer | undefined,
    consumeChunk: (chunk: Buffer) => Promise<void> | void,
    readStderr: (stream: Readable) => Promise<TStderr>,
    formatStderr: (stderr: TStderr) => string,
    repositoryMode: 'WORKTREE' | 'NO_REPOSITORY' = 'WORKTREE',
  ): Promise<Readonly<{ status: number; stderr: TStderr }>> => {
    let commandPolicy = boundedHermeticGitCommandPolicy(
      executionPolicy,
      executionMode,
      worktreePath,
      args,
    );
    assertBinaryCurrent(commandPolicy);
    const executable = resolveBinaryAuthority(commandPolicy).executable;
    const childDrainReservation = reserveHermeticGitChildDrain();
    let child: ReturnType<typeof spawn>;
    let commandCutMs: number;
    try {
      // Reservation is the pre-spawn CAS. Re-read every inherited signal/deadline after the
      // reservation so a sealed scope can release without ever creating a child.
      commandPolicy = boundedHermeticGitCommandPolicy(
        executionPolicy,
        executionMode,
        worktreePath,
        args,
      );
      assertBinaryCurrent(commandPolicy);
      const invocation = resolveHermeticGitInvocation(worktreePath, args, repositoryMode);
      commandCutMs = performance.now() + commandPolicy.commandDeadlineMs;
      child = spawn(executable.descriptorPath, invocation.args, {
        argv0: executable.argv0,
        cwd: invocation.cwd,
        detached: true,
        env: invocation.environment,
        stdio: hermeticGitStdio(input, invocation),
      });
    } catch (error) {
      childDrainReservation.release();
      throw error;
    }
    const closeObservation = observeHermeticGitChildClose(child, commandPolicy.timeoutSignal);
    let interruption: HermeticGitChildInterruptionObservation;
    try {
      childDrainReservation.bind(closeObservation);
      interruption = observeHermeticGitChildInterruption(
        child,
        worktreePath,
        args,
        commandPolicy,
        commandCutMs,
        executionMode,
      );
    } catch (error) {
      childDrainReservation.release();
      await requireHermeticGitChildCloseAfterFailure(
        child,
        closeObservation,
        commandPolicy,
        worktreePath,
        args,
        error,
        executionMode,
      );
      throw errorFromUnknown('Hermetic Git child initialization failed', error);
    }
    const componentFailures: {
      stdout: Error | null;
      stderr: Error | null;
      input: Error | null;
    } = { stdout: null, stderr: null, input: null };
    let stderrOutcome: Promise<HermeticGitAsyncOutcome<TStderr>> | undefined;
    let inputOutcome: Promise<HermeticGitAsyncOutcome<void>> | undefined;
    let componentFailure: HermeticGitComponentFailureObservation | undefined;
    try {
      if (child.stderr === null || child.stdout === null) {
        throw new Error('Hermetic Git child did not expose its stdout/stderr streams');
      }
      const stdout = child.stdout;
      const stdoutOutcome = observeHermeticGitAsyncOutcome(
        (async (): Promise<void> => {
          for await (const chunk of stdout) {
            await consumeChunk(bufferFromUnknownChunk(chunk));
          }
        })(),
      );
      stderrOutcome = observeHermeticGitAsyncOutcome(readStderr(child.stderr));
      inputOutcome = observeHermeticGitAsyncOutcome(writeHermeticGitInput(child, input));
      void stdoutOutcome.then((outcome) => {
        if (!outcome.ok) componentFailures.stdout = outcome.error;
      });
      void stderrOutcome.then((outcome) => {
        if (!outcome.ok) componentFailures.stderr = outcome.error;
      });
      void inputOutcome.then((outcome) => {
        if (!outcome.ok) componentFailures.input = outcome.error;
      });
      const operation = (async (): Promise<Readonly<{ status: number; stderr: TStderr }>> => {
        const [stdoutResult, stderrResult, inputResult, result] = await Promise.all([
          stdoutOutcome,
          stderrOutcome,
          inputOutcome,
          closeObservation.completion,
        ]);
        if (!stdoutResult.ok) throw stdoutResult.error;
        if (!stderrResult.ok) throw stderrResult.error;
        if (!inputResult.ok) throw inputResult.error;
        const stderr = stderrResult.value;
        if (result.lifecycleError !== null) throw result.lifecycleError;
        assertBinaryCurrent(commandPolicy);
        boundedHermeticGitCommandPolicy(executionPolicy, executionMode, worktreePath, args);
        if (result.status === null || !acceptedStatuses.includes(result.status)) {
          throw new Error(
            `${formatGitFailure(args, worktreePath, result.status, formatStderr(stderr))}${
              result.signal ? ` (${result.signal})` : ''
            }`,
          );
        }
        return Object.freeze({ status: result.status, stderr });
      })();
      componentFailure = observeHermeticGitComponentFailures([
        stdoutOutcome,
        stderrOutcome,
        inputOutcome,
      ]);
      return await Promise.race([
        operation,
        componentFailure.completion,
        interruption.completion,
      ]).then((result) => {
        if (result === undefined) {
          throw new Error('Hermetic Git execution observer settled without a command result');
        }
        return result;
      });
    } catch (error) {
      const interruptionFailure = interruption.failure();
      const primaryFailure =
        interruptionFailure ??
        errorFromUnknown('Hermetic Git asynchronous execution failed', error);
      const concurrentFailures = [
        componentFailures.stdout,
        componentFailures.stderr,
        componentFailures.input,
      ].filter((failure): failure is Error => failure !== null && failure !== primaryFailure);
      await requireHermeticGitChildCloseAfterFailure(
        child,
        closeObservation,
        executionPolicy,
        worktreePath,
        args,
        primaryFailure,
        executionMode,
      );
      if (interruptionFailure !== null) throw interruptionFailure;
      await Promise.all([stderrOutcome, inputOutcome].filter((outcome) => outcome !== undefined));
      const failures = [primaryFailure, ...concurrentFailures];
      if (failures.length > 1) {
        throw new AggregateError(failures, 'Hermetic Git asynchronous components failed');
      }
      throw primaryFailure;
    } finally {
      componentFailure?.close();
      interruption.close();
    }
  };

  const executeBufferSync = (
    worktreePath: string,
    args: readonly string[],
    acceptedStatuses: readonly number[],
    input: string | Buffer | undefined,
    maxBuffer: number,
    repositoryMode: 'WORKTREE' | 'NO_REPOSITORY' = 'WORKTREE',
  ): HermeticGitBufferResult => {
    requireSynchronousHermeticGitExecutionOutsideBudget(worktreePath, args);
    let commandPolicy = boundedHermeticGitCommandPolicy(
      executionPolicy,
      'BUFFERED',
      worktreePath,
      args,
    );
    assertBinaryCurrent(commandPolicy);
    const executable = resolveBinaryAuthority(commandPolicy).executable;
    commandPolicy = boundedHermeticGitCommandPolicy(
      executionPolicy,
      'BUFFERED',
      worktreePath,
      args,
    );
    assertBinaryCurrent(commandPolicy);
    const invocation = resolveHermeticGitInvocation(worktreePath, args, repositoryMode);
    const result = spawnSync(executable.descriptorPath, invocation.args, {
      argv0: executable.argv0,
      cwd: invocation.cwd,
      env: invocation.environment,
      input,
      maxBuffer,
      timeout: commandPolicy.commandDeadlineMs,
      killSignal: commandPolicy.timeoutSignal,
      stdio: hermeticGitStdio(input, invocation),
    });
    assertBinaryCurrent(commandPolicy);
    if (errorCode(result.error) === 'ETIMEDOUT') {
      throw new HermeticGitExecutionTimeoutError(
        'BUFFERED',
        worktreePath,
        args,
        commandPolicy.commandDeadlineMs,
        commandPolicy.timeoutSignal,
        commandPolicy.deadlineSource,
        commandPolicy.contextDeadlineAuthority,
      );
    }
    if (result.error) throw result.error;
    if (result.status === null || !acceptedStatuses.includes(result.status)) {
      throw new Error(
        formatGitFailure(
          args,
          worktreePath,
          result.status,
          decodeFatalUtf8(result.stderr, 'Hermetic Git stderr'),
        ),
      );
    }
    boundedHermeticGitCommandPolicy(executionPolicy, 'BUFFERED', worktreePath, args);
    return Object.freeze({
      stdout: Buffer.from(result.stdout),
      stderr: Buffer.from(result.stderr),
      status: result.status,
    });
  };

  const runtime: HermeticGitRuntimeV1 = {
    get attestation(): HermeticGitAttestation {
      return resolveBinaryAuthority().attestation;
    },

    executionPolicy,
    executionModes: HERMETIC_GIT_EXECUTION_MODES_V1,

    runBuffer(
      worktreePath: string,
      args: readonly string[],
      acceptedStatuses: readonly number[] = [0],
      input?: string | Buffer,
      maxBuffer = DEFAULT_MAX_OUTPUT_BYTES,
    ): HermeticGitBufferResult {
      return executeBufferSync(worktreePath, args, acceptedStatuses, input, maxBuffer);
    },

    runText(
      worktreePath: string,
      args: readonly string[],
      acceptedStatuses: readonly number[] = [0],
      maxBuffer = DEFAULT_MAX_OUTPUT_BYTES,
    ): HermeticGitTextResult {
      const result = runtime.runBuffer(worktreePath, args, acceptedStatuses, undefined, maxBuffer);
      return Object.freeze({
        stdout: decodeFatalUtf8(result.stdout, 'Hermetic Git stdout'),
        stderr: decodeFatalUtf8(result.stderr, 'Hermetic Git stderr'),
        status: result.status,
      });
    },

    async runBufferAsync(
      worktreePath: string,
      args: readonly string[],
      acceptedStatuses: readonly number[] = [0],
      input?: string | Buffer,
      maxBuffer = DEFAULT_MAX_OUTPUT_BYTES,
    ): Promise<HermeticGitBufferResult> {
      if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1) {
        throw new TypeError('Hermetic Git buffered output limit must be one positive safe integer');
      }
      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      const result = await executeAsync(
        'BUFFERED',
        worktreePath,
        args,
        acceptedStatuses,
        input,
        (chunk) => {
          if (stdoutBytes + chunk.length > maxBuffer) {
            throw new Error(`Hermetic Git stdout exceeds its ${String(maxBuffer)}-byte limit`);
          }
          stdoutChunks.push(Buffer.from(chunk));
          stdoutBytes += chunk.length;
        },
        (stream) => collectBoundedBuffer(stream, maxBuffer, 'Hermetic Git stderr'),
        (stderr) => decodeFatalUtf8(stderr, 'Hermetic Git stderr'),
      );
      return Object.freeze({
        stdout: Buffer.concat(stdoutChunks, stdoutBytes),
        stderr: Buffer.from(result.stderr),
        status: result.status,
      });
    },

    async runTextAsync(
      worktreePath: string,
      args: readonly string[],
      acceptedStatuses: readonly number[] = [0],
      maxBuffer = DEFAULT_MAX_OUTPUT_BYTES,
    ): Promise<HermeticGitTextResult> {
      const result = await runtime.runBufferAsync(
        worktreePath,
        args,
        acceptedStatuses,
        undefined,
        maxBuffer,
      );
      return Object.freeze({
        stdout: decodeFatalUtf8(result.stdout, 'Hermetic Git stdout'),
        stderr: decodeFatalUtf8(result.stderr, 'Hermetic Git stderr'),
        status: result.status,
      });
    },

    parseConfig(input: Buffer, maxBuffer = MAX_REPOSITORY_CONFIG_BYTES): HermeticGitBufferResult {
      if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1) {
        throw new TypeError('Hermetic Git config output limit must be one positive safe integer');
      }
      return executeBufferSync(
        '/',
        ['config', '--file', '-', '--no-includes', '--null', '--list'],
        [0],
        input,
        maxBuffer,
        'NO_REPOSITORY',
      );
    },

    async parseConfigAsync(
      input: Buffer,
      maxBuffer = MAX_REPOSITORY_CONFIG_BYTES,
    ): Promise<HermeticGitBufferResult> {
      if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1) {
        throw new TypeError('Hermetic Git config output limit must be one positive safe integer');
      }
      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      const args = ['config', '--file', '-', '--no-includes', '--null', '--list'] as const;
      const result = await executeAsync(
        'BUFFERED',
        '/',
        args,
        [0],
        input,
        (chunk) => {
          if (stdoutBytes + chunk.length > maxBuffer) {
            throw new Error(
              `Hermetic Git config output exceeds its ${String(maxBuffer)}-byte limit`,
            );
          }
          stdoutChunks.push(Buffer.from(chunk));
          stdoutBytes += chunk.length;
        },
        (stream) => collectBoundedBuffer(stream, maxBuffer, 'Hermetic Git config stderr'),
        (stderr) => decodeFatalUtf8(stderr, 'Hermetic Git config stderr'),
        'NO_REPOSITORY',
      );
      return Object.freeze({
        stdout: Buffer.concat(stdoutChunks, stdoutBytes),
        stderr: Buffer.from(result.stderr),
        status: result.status,
      });
    },

    async consumeStdout(
      worktreePath: string,
      args: readonly string[],
      consumeChunk: (chunk: Buffer) => Promise<void> | void,
      acceptedStatuses: readonly number[] = [0],
    ): Promise<number> {
      const result = await executeAsync(
        'STREAMED',
        worktreePath,
        args,
        acceptedStatuses,
        undefined,
        consumeChunk,
        collectBoundedStderr,
        (stderr) => stderr,
      );
      return result.status;
    },

    close(): void {
      if (closed) throw new Error('Hermetic Git runtime is already closed');
      closed = true;
      binaryAuthority?.executable.close();
      binaryAuthority = undefined;
    },
  };
  return Object.freeze(runtime);
}

/** Exact-import adapter for execution-kernel contract tests; production callers use sessions. */
export function testOnlyCreateHermeticGitRuntime(
  policy: HermeticExecutableExecutionPolicyV1,
): HermeticGitRuntimeV1 {
  return createHermeticGitRuntime(policy);
}

const productionGitRuntime = createHermeticGitRuntime(HERMETIC_GIT_EXECUTION_POLICY_V1);
const hermeticGitProductionRuntime: HermeticGitProductionRuntimeV1 = {
  get attestation(): HermeticGitAttestation {
    return productionGitRuntime.attestation;
  },
  executionPolicy: productionGitRuntime.executionPolicy,
  executionModes: productionGitRuntime.executionModes,
  withRepository<T>(
    worktreePath: string,
    action: (session: HermeticGitRepositoryAsyncSessionV1) => T | Promise<T>,
  ): Promise<T> {
    return withValidatedHermeticGitRepository(worktreePath, action);
  },
  withRepositorySync<T>(
    worktreePath: string,
    action: (session: HermeticGitRepositorySyncSessionV1) => HermeticGitSynchronousResult<T>,
  ): T {
    return withValidatedHermeticGitRepositorySync(worktreePath, action);
  },
};
export const HERMETIC_GIT_RUNTIME: HermeticGitProductionRuntimeV1 = Object.freeze(
  hermeticGitProductionRuntime,
);

function updateDigestFrame(digest: Hash, label: string, payload: Buffer): void {
  const labelBytes = Buffer.from(label, 'utf8');
  const lengths = Buffer.alloc(16);
  lengths.writeBigUInt64BE(BigInt(labelBytes.length), 0);
  lengths.writeBigUInt64BE(BigInt(payload.length), 8);
  digest.update(lengths);
  digest.update(labelBytes);
  digest.update(payload);
}

function updateDigestFingerprintFrame(
  digest: Hash,
  label: string,
  fingerprint: GitStreamFingerprint,
): void {
  if (fingerprint.byteLength > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`${label} exceeds the canonical 64-bit length frame`);
  }
  if (!SHA256_PATTERN.test(fingerprint.sha256)) {
    throw new Error(`${label}.sha256 is not one SHA-256 digest`);
  }
  const payload = Buffer.alloc(40);
  payload.writeBigUInt64BE(fingerprint.byteLength, 0);
  Buffer.from(fingerprint.sha256, 'hex').copy(payload, 8);
  updateDigestFrame(digest, label, payload);
}

async function fingerprintGitStdout(
  args: readonly string[],
  worktreePath: string,
): Promise<GitStreamFingerprint> {
  const digest = createHash('sha256');
  let byteLength = 0n;
  await productionGitRuntime.consumeStdout(worktreePath, args, (chunk) => {
    byteLength += BigInt(chunk.length);
    digest.update(chunk);
  });
  return Object.freeze({ byteLength, sha256: digest.digest('hex') });
}

async function readBoundedGitText(args: readonly string[], worktreePath: string): Promise<string> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  await productionGitRuntime.consumeStdout(worktreePath, args, (chunk) => {
    byteLength += chunk.length;
    if (byteLength > MAX_BOUNDED_TEXT_BYTES) {
      throw new Error(`git ${args.join(' ')} exceeded the bounded text contract`);
    }
    chunks.push(Buffer.from(chunk));
  });
  return decodeFatalUtf8(Buffer.concat(chunks, byteLength), `git ${args.join(' ')} stdout`);
}

async function consumeGitNulRecords(
  args: readonly string[],
  worktreePath: string,
  label: string,
  consumeRecord: (record: Buffer) => Promise<void>,
): Promise<void> {
  let remainder = Buffer.alloc(0);
  await productionGitRuntime.consumeStdout(worktreePath, args, async (chunk) => {
    const bytes =
      remainder.length === 0
        ? chunk
        : Buffer.concat([remainder, chunk], remainder.length + chunk.length);
    let offset = 0;
    for (;;) {
      const terminator = bytes.indexOf(0, offset);
      if (terminator === -1) {
        break;
      }
      if (terminator === offset) {
        throw new Error(`${label} contains an empty record`);
      }
      await consumeRecord(Buffer.from(bytes.subarray(offset, terminator)));
      offset = terminator + 1;
    }
    remainder = Buffer.from(bytes.subarray(offset));
  });
  if (remainder.length !== 0) {
    throw new Error(`${label} is not NUL terminated`);
  }
}

function sameFingerprint(left: GitStreamFingerprint, right: GitStreamFingerprint): boolean {
  return left.byteLength === right.byteLength && left.sha256 === right.sha256;
}

type GitObjectFormat = 'sha1';

interface RepositoryConfigurationEvidence {
  readonly contentFingerprint: GitStreamFingerprint;
  readonly substrateFingerprint: GitStreamFingerprint;
  readonly objectFormat: GitObjectFormat;
}

interface TrackedEntry {
  readonly path: Buffer;
  readonly mode: '100644' | '100755' | '120000';
  readonly objectId: string;
}

interface GitBlobProof extends GitStreamFingerprint {
  readonly objectId: string;
}

interface RawContentFingerprint extends GitStreamFingerprint {
  readonly objectId: string;
}

interface TrackedWorktreeScan {
  readonly fingerprint: GitStreamFingerprint;
  readonly substrateFingerprint: GitStreamFingerprint;
  readonly dirty: boolean;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

type StableRegularFileObservation = StableRegularFileObservationV1;

function readStableRegularFileObservation(
  path: string,
  maximumBytes: number,
  label: string,
): StableRegularFileObservation {
  return observeStableRegularFile(path, maximumBytes, label);
}

function assertStableRegularFileObservationCurrent(
  observation: StableRegularFileObservation,
  maximumBytes: number,
  label: string,
): void {
  try {
    assertStableRegularFileCurrent(observation, maximumBytes, label);
  } catch (error) {
    throw new InventoryInspectionError(
      'DIRTY_SNAPSHOT_MOVED',
      `${label} changed across its repository-topology observation: ${observation.path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function requireBooleanConfigValue(key: string, value: string): void {
  if (!['true', 'false', 'yes', 'no', 'on', 'off', '1', '0'].includes(value.toLowerCase())) {
    throw new Error(`Hermetic Git config ${key} is not one boolean value`);
  }
}

function isPermittedInertConfigKey(key: string): boolean {
  return (
    key === 'core.hookspath' ||
    /^remote\..+\.(?:url|pushurl|fetch|tagopt|mirror|prune)$/.test(key) ||
    /^branch\..+\.(?:remote|merge|rebase|description)$/.test(key) ||
    /^user\.(?:name|email|signingkey|useconfigonly)$/.test(key) ||
    /^gpg\.(?:format|program|mintrustlevel)$/.test(key) ||
    /^gpg\.ssh\.(?:allowedsignersfile|revocationfile|defaultkeycommand)$/.test(key) ||
    /^commit\.(?:gpgsign|template|cleanup|verbose)$/.test(key) ||
    /^tag\.gpgsign$/.test(key) ||
    /^pull\.(?:rebase|ff)$/.test(key) ||
    /^push\.(?:default|autosetupremote|followtags)$/.test(key) ||
    /^fetch\.(?:prune|prunetags|writecommitgraph)$/.test(key) ||
    /^init\.defaultbranch$/.test(key) ||
    /^advice\.[a-z0-9.-]+$/.test(key) ||
    /^rerere\.(?:enabled|autoupdate)$/.test(key) ||
    /^maintenance\.[a-z0-9.-]+$/.test(key) ||
    /^gc\.[a-z0-9.-]+$/.test(key)
  );
}

function decodeRepositoryConfigKey(rawKey: Buffer): string {
  const decoded = decodeFatalUtf8(rawKey, 'Hermetic Git repository config key');
  const firstSeparator = decoded.indexOf('.');
  const lastSeparator = decoded.lastIndexOf('.');
  const section = firstSeparator === -1 ? '' : decoded.slice(0, firstSeparator);
  const variable = lastSeparator === -1 ? '' : decoded.slice(lastSeparator + 1);

  // Git's flattened config representation is `section[.subsection].variable`.
  // Section and variable names have a narrow grammar, while a quoted subsection may
  // legitimately contain ref-name characters such as `/` (for example a branch name).
  // Validate those structural authorities independently instead of treating the whole
  // flattened key as one variable name.
  if (
    firstSeparator <= 0 ||
    lastSeparator === decoded.length - 1 ||
    /[\u0000-\u001f\u007f]/u.test(decoded) ||
    !/^[a-z][a-z0-9-]*$/iu.test(section) ||
    !/^[a-z][a-z0-9-]*$/iu.test(variable)
  ) {
    throw new Error(`Hermetic Git repository config key is invalid: ${JSON.stringify(decoded)}`);
  }

  return decoded.toLowerCase();
}

function assertHermeticRepositoryConfig(rawConfigList: Buffer): void {
  const records = splitNulRecords(rawConfigList, 'repository config');
  for (const record of records) {
    const separator = record.indexOf(0x0a);
    if (separator <= 0) {
      throw new Error('Hermetic Git repository config contains a malformed entry');
    }
    const key = decodeRepositoryConfigKey(record.subarray(0, separator));
    const value = decodeFatalUtf8(
      record.subarray(separator + 1),
      `Hermetic Git repository config ${key}`,
    );
    if (key === 'core.repositoryformatversion') {
      if (value !== '0') {
        throw new Error(`Hermetic Git requires repository format 0, received ${value}`);
      }
      continue;
    }
    if (key === 'core.bare') {
      requireBooleanConfigValue(key, value);
      if (!['false', 'no', 'off', '0'].includes(value.toLowerCase())) {
        throw new Error('Hermetic Git refuses a bare repository');
      }
      continue;
    }
    if (key === 'core.filemode' || key === 'core.logallrefupdates') {
      requireBooleanConfigValue(key, value);
      continue;
    }
    if (
      key === 'extensions.partialclone' ||
      /^remote\..+\.(?:promisor|partialclonefilter)$/.test(key)
    ) {
      throw new Error(
        `Hermetic Git refuses partial/promisor object authority ${key}; every governed blob must be locally complete`,
      );
    }
    if (isPermittedInertConfigKey(key)) {
      continue;
    }
    throw new Error(
      `Hermetic Git refuses ungoverned local config ${key}; includes, filters, diff drivers, sparse/worktree redirects, and behavior-changing core keys are not evidence authorities`,
    );
  }
}

function updateConfigurationDigestFile(
  digest: Hash,
  label: string,
  content: Buffer | null,
): bigint {
  const payload = content ?? Buffer.from('ABSENT', 'ascii');
  updateDigestFrame(digest, label, payload);
  return BigInt(payload.length);
}

interface StableDirectoryObservation extends StableDirectoryObservationV1 {
  readonly identity: Buffer;
}

function observeDirectory(
  path: string,
  label: string,
  exactEntries = false,
): StableDirectoryObservation {
  const observed = observeStableDirectory(path, label, exactEntries);
  const { stat } = observed;
  const identity = Buffer.from(
    [
      path,
      stat.dev,
      stat.ino,
      stat.mode,
      stat.nlink,
      stat.uid,
      stat.gid,
      stat.rdev,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
    ]
      .map((value) => value.toString())
      .join('\0'),
    'utf8',
  );
  return Object.freeze({ ...observed, identity });
}

function assertDirectoryObservationCurrent(
  observation: StableDirectoryObservation,
  label: string,
): void {
  try {
    assertStableDirectoryCurrent(observation, label);
  } catch (error) {
    throw new InventoryInspectionError(
      'DIRTY_SNAPSHOT_MOVED',
      `${label} changed across its repository-topology observation: ${observation.path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function regularFileIdentity(observation: StableRegularFileObservation): Buffer {
  const { path, content, stat } = observation;
  return Buffer.from(
    [
      path,
      stat.dev,
      stat.ino,
      stat.mode,
      stat.nlink,
      stat.uid,
      stat.gid,
      stat.rdev,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
      createHash('sha256').update(content).digest('hex'),
    ]
      .map((value) => value.toString())
      .join('\0'),
    'utf8',
  );
}

function directoryAnchorIdentity(observation: StableDirectoryObservation): Buffer {
  const { path, stat } = observation;
  return Buffer.from(
    [path, stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.rdev]
      .map((value) => value.toString())
      .join('\0'),
    'utf8',
  );
}

function decodeGitMetadataPath(content: Buffer, label: string): string {
  const raw = decodeUtf8(content, label);
  const match = /^(?<path>[^\0\r\n]+)\n$/.exec(raw);
  if (match?.groups?.path === undefined) {
    throw new Error(`${label} must contain exactly one LF-terminated path`);
  }
  return match.groups.path;
}

function decodeUtf8(content: Buffer, label: string): string {
  return decodeFatalUtf8(content, label);
}

interface OptionalTopologyFileObservation {
  readonly path: string;
  readonly label: string;
  readonly parent: StableDirectoryObservation;
  readonly file: StableRegularFileObservation | null;
}

interface OptionalTopologyDirectoryObservation {
  readonly path: string;
  readonly label: string;
  readonly parent: StableDirectoryObservation;
  readonly directory: StableDirectoryObservation | null;
}

function observeOptionalTopologyFile(path: string, label: string): OptionalTopologyFileObservation {
  const parent = observeDirectory(dirname(path), `${label} parent`, true);
  const entry = parent.entries?.find(
    (candidate) => candidate.name === path.slice(dirname(path).length + 1),
  );
  if (entry !== undefined && entry.kind !== 'FILE') {
    throw new Error(`${label} is not one regular file: ${path}`);
  }
  const file =
    entry === undefined
      ? null
      : readStableRegularFileObservation(path, MAX_REPOSITORY_CONFIG_BYTES, label);
  assertDirectoryObservationCurrent(parent, `${label} parent`);
  return Object.freeze({ path, label, parent, file });
}

function assertOptionalTopologyFileCurrent(observation: OptionalTopologyFileObservation): void {
  assertDirectoryObservationCurrent(observation.parent, `${observation.label} parent`);
  if (observation.file !== null) {
    assertStableRegularFileObservationCurrent(
      observation.file,
      MAX_REPOSITORY_CONFIG_BYTES,
      observation.label,
    );
  }
}

function observeOptionalTopologyDirectory(
  path: string,
  label: string,
): OptionalTopologyDirectoryObservation {
  const parent = observeDirectory(dirname(path), `${label} parent`, true);
  const entry = parent.entries?.find(
    (candidate) => candidate.name === path.slice(dirname(path).length + 1),
  );
  if (entry !== undefined && entry.kind !== 'DIRECTORY') {
    throw new Error(`${label} is not one directory: ${path}`);
  }
  const directory = entry === undefined ? null : observeDirectory(path, label, true);
  assertDirectoryObservationCurrent(parent, `${label} parent`);
  return Object.freeze({ path, label, parent, directory });
}

function assertOptionalTopologyDirectoryCurrent(
  observation: OptionalTopologyDirectoryObservation,
): void {
  assertDirectoryObservationCurrent(observation.parent, `${observation.label} parent`);
  if (observation.directory !== null) {
    assertDirectoryObservationCurrent(observation.directory, observation.label);
  }
}

function optionalTopologyContent(observation: OptionalTopologyFileObservation): Buffer | null {
  return observation.file?.content ?? null;
}

function optionalTopologySubstrateIdentity(observation: OptionalTopologyFileObservation): Buffer {
  return observation.file === null
    ? Buffer.concat([Buffer.from('ABSENT\0', 'ascii'), observation.parent.identity])
    : regularFileIdentity(observation.file);
}

function optionalTopologyDirectorySubstrateIdentity(
  observation: OptionalTopologyDirectoryObservation,
): Buffer {
  if (observation.directory === null) {
    return Buffer.concat([Buffer.from('ABSENT\0', 'ascii'), observation.parent.identity]);
  }
  const entries = Buffer.from(
    (observation.directory.entries ?? []).map((entry) => `${entry.kind}\0${entry.name}\0`).join(''),
    'utf8',
  );
  return Buffer.concat([
    Buffer.from('PRESENT\0', 'ascii'),
    observation.directory.identity,
    Buffer.from('\0ENTRIES\0', 'ascii'),
    entries,
  ]);
}

type DotGitEntryObservation =
  | Readonly<{
      kind: 'REDIRECT';
      path: string;
      redirectPath: string;
      file: StableRegularFileObservation;
    }>
  | Readonly<{
      kind: 'DIRECTORY';
      path: string;
      directory: StableDirectoryObservation;
    }>;

function observeDotGitEntry(worktreePath: string): DotGitEntryObservation {
  const path = join(worktreePath, '.git');
  const stat = lstatSync(path, { bigint: true });
  if (stat.isFile() && !stat.isSymbolicLink()) {
    const file = readStableRegularFileObservation(
      path,
      MAX_REPOSITORY_CONFIG_BYTES,
      '.git redirect',
    );
    const redirectMatch = /^gitdir: (?<path>[^\0\r\n]+)\n$/.exec(
      decodeUtf8(file.content, '.git redirect'),
    );
    const redirectPath = redirectMatch?.groups?.path;
    if (redirectPath === undefined) {
      throw new Error('.git redirect must contain exactly one LF-terminated gitdir path');
    }
    return Object.freeze({ kind: 'REDIRECT', path, redirectPath, file });
  }
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    return Object.freeze({
      kind: 'DIRECTORY',
      path,
      directory: observeDirectory(path, '.git directory'),
    });
  }
  throw new Error(`Hermetic Git refuses an unsupported .git redirect: ${path}`);
}

interface RepositoryTopologyObservationV1 {
  readonly worktreePath: string;
  readonly worktree: StableDirectoryObservation;
  readonly dotGitEntry: DotGitEntryObservation;
  readonly dotGitIdentity: Buffer;
  readonly gitDirPath: string;
  readonly commonDirPath: string;
  readonly gitDir: StableDirectoryObservation;
  readonly commonDir: StableDirectoryObservation;
  readonly commonDirRedirect: OptionalTopologyFileObservation;
  readonly gitDirBacklink: OptionalTopologyFileObservation;
  readonly config: StableRegularFileObservation;
  readonly replaceRefs: OptionalTopologyDirectoryObservation;
  readonly alternates: OptionalTopologyFileObservation;
  readonly shallow: OptionalTopologyFileObservation;
  readonly grafts: OptionalTopologyFileObservation;
  readonly worktreeConfig: OptionalTopologyFileObservation;
}

function assertRepositoryTopologyCurrent(topology: RepositoryTopologyObservationV1): void {
  assertDirectoryObservationCurrent(topology.worktree, 'Git worktree');
  assertDirectoryObservationCurrent(topology.gitDir, 'Git directory');
  assertDirectoryObservationCurrent(topology.commonDir, 'Git common-dir');
  if (topology.dotGitEntry.kind === 'REDIRECT') {
    assertStableRegularFileObservationCurrent(
      topology.dotGitEntry.file,
      MAX_REPOSITORY_CONFIG_BYTES,
      '.git redirect',
    );
  } else {
    assertDirectoryObservationCurrent(topology.dotGitEntry.directory, '.git directory');
  }
  assertOptionalTopologyFileCurrent(topology.commonDirRedirect);
  assertOptionalTopologyFileCurrent(topology.gitDirBacklink);
  assertStableRegularFileObservationCurrent(
    topology.config,
    MAX_REPOSITORY_CONFIG_BYTES,
    'repository config',
  );
  assertOptionalTopologyDirectoryCurrent(topology.replaceRefs);
  assertOptionalTopologyFileCurrent(topology.alternates);
  assertOptionalTopologyFileCurrent(topology.shallow);
  assertOptionalTopologyFileCurrent(topology.grafts);
  assertOptionalTopologyFileCurrent(topology.worktreeConfig);
}

function observeRepositoryTopology(worktreePath: string): RepositoryTopologyObservationV1 {
  const worktree = observeDirectory(worktreePath, 'Git worktree');
  const dotGitEntry = observeDotGitEntry(worktreePath);
  const dotGitPath = dotGitEntry.path;
  let dotGitIdentity: Buffer;
  let gitDirPath: string;
  let commonDirPath: string;
  let gitDir: StableDirectoryObservation;
  let commonDir: StableDirectoryObservation;
  let commonDirRedirect: OptionalTopologyFileObservation;
  let gitDirBacklink: OptionalTopologyFileObservation;

  if (dotGitEntry.kind === 'REDIRECT') {
    gitDirPath = resolve(worktreePath, dotGitEntry.redirectPath);
    gitDir = observeDirectory(gitDirPath, 'Git directory');
    if (realpathSync(gitDirPath) !== gitDirPath) {
      throw new Error('linked Git directory path is not canonical after anchored observation');
    }
    commonDirRedirect = observeOptionalTopologyFile(
      join(gitDirPath, 'commondir'),
      'linked-worktree commondir redirect',
    );
    if (commonDirRedirect.file === null) {
      throw new Error('linked-worktree commondir redirect is absent');
    }
    commonDirPath = resolve(
      gitDirPath,
      decodeGitMetadataPath(commonDirRedirect.file.content, 'linked-worktree commondir redirect'),
    );
    if (gitDirPath === commonDirPath || dirname(gitDirPath) !== join(commonDirPath, 'worktrees')) {
      throw new Error('linked .git redirect is outside the attested common-dir worktrees registry');
    }
    commonDir = observeDirectory(commonDirPath, 'Git common-dir');
    if (realpathSync(commonDirPath) !== commonDirPath) {
      throw new Error('Git common-dir path is not canonical after anchored observation');
    }
    gitDirBacklink = observeOptionalTopologyFile(
      join(gitDirPath, 'gitdir'),
      'linked-worktree gitdir backlink',
    );
    if (gitDirBacklink.file === null) {
      throw new Error('linked-worktree gitdir backlink is absent');
    }
    const backlinkTarget = resolve(
      gitDirPath,
      decodeGitMetadataPath(gitDirBacklink.file.content, 'linked-worktree gitdir backlink'),
    );
    if (backlinkTarget !== dotGitPath) {
      throw new Error(`linked-worktree gitdir backlink does not name ${dotGitPath}`);
    }
    if (
      !sameBigIntFileObservation(dotGitEntry.file.stat, lstatSync(backlinkTarget, { bigint: true }))
    ) {
      throw new Error('linked-worktree gitdir backlink reached another .git redirect generation');
    }
    dotGitIdentity = regularFileIdentity(dotGitEntry.file);
  } else {
    gitDirPath = dotGitPath;
    commonDirPath = gitDirPath;
    gitDir = dotGitEntry.directory;
    commonDir = dotGitEntry.directory;
    dotGitIdentity = dotGitEntry.directory.identity;
    commonDirRedirect = observeOptionalTopologyFile(
      join(gitDirPath, 'commondir'),
      'primary-worktree commondir redirect',
    );
    gitDirBacklink = observeOptionalTopologyFile(
      join(gitDirPath, 'gitdir'),
      'primary-worktree gitdir backlink',
    );
    if (commonDirRedirect.file !== null || gitDirBacklink.file !== null) {
      throw new Error('primary worktree cannot carry linked-worktree redirect authorities');
    }
  }

  const config = readStableRegularFileObservation(
    join(commonDirPath, 'config'),
    MAX_REPOSITORY_CONFIG_BYTES,
    'repository config',
  );
  const replaceRefs = observeOptionalTopologyDirectory(
    join(commonDirPath, 'refs', 'replace'),
    'Git replace refs',
  );
  const alternates = observeOptionalTopologyFile(
    join(commonDirPath, 'objects', 'info', 'alternates'),
    'Git object alternates',
  );
  const alternatesContent = optionalTopologyContent(alternates);
  if (
    alternatesContent !== null &&
    decodeUtf8(alternatesContent, 'Git object alternates').trim().length > 0
  ) {
    throw new Error('Hermetic Git refuses common-dir object alternates');
  }
  const shallow = observeOptionalTopologyFile(
    join(commonDirPath, 'shallow'),
    'Git shallow boundary',
  );
  const shallowContent = optionalTopologyContent(shallow);
  if (
    shallowContent !== null &&
    decodeUtf8(shallowContent, 'Git shallow boundary').trim().length > 0
  ) {
    throw new Error('Hermetic Git refuses a shallow repository boundary');
  }
  const grafts = observeOptionalTopologyFile(
    join(commonDirPath, 'info', 'grafts'),
    'Git graft authority',
  );
  const graftsContent = optionalTopologyContent(grafts);
  if (
    graftsContent !== null &&
    decodeUtf8(graftsContent, 'Git graft authority').trim().length > 0
  ) {
    throw new Error('Hermetic Git refuses common-dir grafts');
  }
  const worktreeConfig = observeOptionalTopologyFile(
    join(gitDirPath, 'config.worktree'),
    'Git worktree config',
  );
  const topology = Object.freeze({
    worktreePath,
    worktree,
    dotGitEntry,
    dotGitIdentity,
    gitDirPath,
    commonDirPath,
    gitDir,
    commonDir,
    commonDirRedirect,
    gitDirBacklink,
    config,
    replaceRefs,
    alternates,
    shallow,
    grafts,
    worktreeConfig,
  });
  assertRepositoryTopologyCurrent(topology);
  return topology;
}

interface RepositoryDescriptorChainV1 {
  readonly label: string;
  readonly chain: AnchoredDirectoryChainV1;
  readonly expected: StableDirectoryObservation;
}

function closeRepositoryDescriptorChains(chains: readonly RepositoryDescriptorChainV1[]): void {
  const failures: Error[] = [];
  for (const { label, chain } of [...chains].reverse()) {
    try {
      closeAnchoredDirectoryChain(chain);
    } catch (error) {
      failures.push(errorFromUnknown(`${label} descriptor cleanup failed`, error));
    }
  }
  const failure = failures[0];
  if (failures.length === 1 && failure !== undefined) throw failure;
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Repository descriptor authority cleanup failed');
  }
}

function openRepositoryDescriptorAuthority(topology: RepositoryTopologyObservationV1): Readonly<{
  authority: HermeticGitRepositoryDescriptorAuthorityV1;
  chains: readonly RepositoryDescriptorChainV1[];
}> {
  const chains: RepositoryDescriptorChainV1[] = [];
  try {
    const chainsByPath = new Map<string, RepositoryDescriptorChainV1>();
    const openCoordinate = (
      label: string,
      expected: StableDirectoryObservation,
    ): RepositoryDescriptorChainV1 => {
      const existing = chainsByPath.get(expected.path);
      if (existing !== undefined) {
        if (!sameBigIntFileObservation(existing.expected.stat, expected.stat)) {
          throw new InventoryInspectionError(
            'DIRTY_SNAPSHOT_MOVED',
            `${label} aliases another role with a different directory generation`,
          );
        }
        return existing;
      }
      const chain = openAnchoredDirectoryChain(expected.path, `${label} descriptor authority`);
      const descriptorStat = fstatSync(chain.descriptor, { bigint: true });
      if (
        !descriptorStat.isDirectory() ||
        !sameBigIntFileObservation(expected.stat, descriptorStat)
      ) {
        closeAnchoredDirectoryChain(chain);
        throw new InventoryInspectionError(
          'DIRTY_SNAPSHOT_MOVED',
          `${label} changed before its retained descriptor authority opened: ${expected.path}`,
        );
      }
      const coordinate = Object.freeze({ label, chain, expected });
      chains.push(coordinate);
      chainsByPath.set(expected.path, coordinate);
      return coordinate;
    };
    const chainsByRole = new Map<RepositoryDescriptorRoleV1, RepositoryDescriptorChainV1>([
      ['WORKTREE', openCoordinate('Git worktree', topology.worktree)],
      ['GIT_DIR', openCoordinate('Git directory', topology.gitDir)],
      ['COMMON_DIR', openCoordinate('Git common-dir', topology.commonDir)],
    ]);
    assertRepositoryTopologyCurrent(topology);
    const parentDescriptor = (role: RepositoryDescriptorRoleV1): number => {
      const coordinate = chainsByRole.get(role);
      if (coordinate === undefined) {
        throw new Error(`Repository descriptor authority role is absent: ${role}`);
      }
      return coordinate.chain.descriptor;
    };
    const environment: NodeJS.ProcessEnv = { ...HERMETIC_GIT_ENV };
    for (const coordinate of REPOSITORY_CHILD_FD_COORDINATES_V1) {
      environment[coordinate.environmentKey] = repositoryChildFdPath(coordinate.childFd);
    }
    const authority: HermeticGitRepositoryDescriptorAuthorityV1 = Object.freeze({
      worktreePath: topology.worktreePath,
      topology,
      environment: Object.freeze(environment),
      parentDescriptor,
      assertCurrent(): void {
        for (const coordinate of chains) {
          assertAnchoredDirectoryChainIdentityCurrent(
            coordinate.chain,
            `${coordinate.label} retained descriptor authority`,
          );
          const current = fstatSync(coordinate.chain.descriptor, { bigint: true });
          if (
            !current.isDirectory() ||
            !sameBigIntFileObservation(coordinate.expected.stat, current)
          ) {
            throw new InventoryInspectionError(
              'DIRTY_SNAPSHOT_MOVED',
              `${coordinate.label} retained descriptor changed during Git execution`,
            );
          }
        }
        assertRepositoryTopologyCurrent(topology);
      },
    });
    return Object.freeze({ authority, chains: Object.freeze(chains) });
  } catch (error) {
    try {
      closeRepositoryDescriptorChains(chains);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Repository descriptor authority open and cleanup both failed',
      );
    }
    throw error;
  }
}

async function withRepositoryDescriptorAuthority<T>(
  worktreePath: string,
  action: (topology: RepositoryTopologyObservationV1) => Promise<T>,
): Promise<T> {
  const existing = hermeticGitRepositoryDescriptorAuthority.getStore();
  if (existing !== undefined) {
    if (existing.worktreePath !== worktreePath) {
      throw new Error('Nested repository descriptor authority cannot cross worktrees');
    }
    existing.assertCurrent();
    return action(existing.topology);
  }
  const topology = observeRepositoryTopology(worktreePath);
  const opened = openRepositoryDescriptorAuthority(topology);
  return runWithHermeticGitCleanupAsync(
    `Repository descriptor authority ${worktreePath}`,
    () => hermeticGitRepositoryDescriptorAuthority.run(opened.authority, () => action(topology)),
    () =>
      runWithHermeticGitCleanup(
        `Repository descriptor authority ${worktreePath} final topology`,
        () => opened.authority.assertCurrent(),
        () => closeRepositoryDescriptorChains(opened.chains),
      ),
  );
}

function withRepositoryDescriptorAuthoritySync<T>(
  worktreePath: string,
  action: (topology: RepositoryTopologyObservationV1) => T,
): T {
  const existing = hermeticGitRepositoryDescriptorAuthority.getStore();
  if (existing !== undefined) {
    if (existing.worktreePath !== worktreePath) {
      throw new Error('Nested repository descriptor authority cannot cross worktrees');
    }
    existing.assertCurrent();
    return action(existing.topology);
  }
  const topology = observeRepositoryTopology(worktreePath);
  const opened = openRepositoryDescriptorAuthority(topology);
  return runWithHermeticGitCleanup(
    `Repository descriptor authority ${worktreePath}`,
    () => hermeticGitRepositoryDescriptorAuthority.run(opened.authority, () => action(topology)),
    () =>
      runWithHermeticGitCleanup(
        `Repository descriptor authority ${worktreePath} final topology`,
        () => opened.authority.assertCurrent(),
        () => closeRepositoryDescriptorChains(opened.chains),
      ),
  );
}

function requireRepositorySessionAuthority(worktreePath: string): void {
  const authority = hermeticGitRepositoryDescriptorAuthority.getStore();
  if (authority === undefined || authority.worktreePath !== worktreePath) {
    throw new Error('Hermetic Git repository session escaped its descriptor authority');
  }
  authority.assertCurrent();
}

function runWithRepositorySessionAuthority<T>(worktreePath: string, action: () => T): T {
  requireRepositorySessionAuthority(worktreePath);
  return runWithHermeticGitCleanup(
    `Hermetic Git repository session command ${worktreePath}`,
    action,
    () => requireRepositorySessionAuthority(worktreePath),
  );
}

function runWithRepositorySessionAuthorityAsync<T>(
  worktreePath: string,
  action: () => Promise<T>,
): Promise<T> {
  requireRepositorySessionAuthority(worktreePath);
  return runWithHermeticGitCleanupAsync(
    `Hermetic Git repository session command ${worktreePath}`,
    action,
    () => requireRepositorySessionAuthority(worktreePath),
  );
}

function createHermeticGitRepositorySyncSession(
  worktreePath: string,
): HermeticGitRepositorySyncSessionV1 {
  const session: HermeticGitRepositorySyncSessionV1 = {
    read: (query) => {
      const command = compileHermeticGitReadQueryV1(query);
      return runWithRepositorySessionAuthority(worktreePath, () =>
        productionGitRuntime.runBuffer(
          worktreePath,
          command.args,
          command.acceptedStatuses,
          command.input,
          command.maximumOutputBytes,
        ),
      );
    },
    readText: (query) => {
      const command = compileHermeticGitReadQueryV1(query);
      if (command.input !== undefined) {
        throw new TypeError(`${query.kind} is a byte-protocol query and cannot be decoded as text`);
      }
      return runWithRepositorySessionAuthority(worktreePath, () =>
        productionGitRuntime.runText(
          worktreePath,
          command.args,
          command.acceptedStatuses,
          command.maximumOutputBytes,
        ),
      );
    },
  };
  return Object.freeze(session);
}

interface HermeticGitRepositoryAsyncSessionScopeV1 {
  state: 'OPEN' | 'SEALED';
  failure: Error | undefined;
  readonly drains: Set<Promise<void>>;
  readonly operationFailures: Error[];
}

function createHermeticGitRepositoryAsyncSessionScope(): HermeticGitRepositoryAsyncSessionScopeV1 {
  return { state: 'OPEN', failure: undefined, drains: new Set(), operationFailures: [] };
}

function trackHermeticGitRepositoryAsyncOperation<T>(
  scope: HermeticGitRepositoryAsyncSessionScopeV1,
  action: () => Promise<T>,
): Promise<T> {
  if (scope.state === 'SEALED') {
    return Promise.reject(
      scope.failure ?? new Error('Hermetic Git asynchronous repository session is already sealed'),
    );
  }
  let operation: Promise<T>;
  try {
    operation = action();
  } catch (error) {
    operation = Promise.reject(
      errorFromUnknown('Hermetic Git asynchronous repository operation failed', error),
    );
  }
  const observed = operation.catch((error: unknown) => {
    const failure = errorFromUnknown(
      'Hermetic Git asynchronous repository operation failed',
      error,
    );
    scope.operationFailures.push(failure);
    throw failure;
  });
  const drain = observed.then(
    () => undefined,
    () => undefined,
  );
  scope.drains.add(drain);
  void drain.then(() => scope.drains.delete(drain));
  return observed;
}

async function sealAndDrainHermeticGitRepositoryAsyncSession(
  scope: HermeticGitRepositoryAsyncSessionScopeV1,
  failure: Error,
): Promise<void> {
  if (scope.state === 'OPEN') {
    scope.state = 'SEALED';
    scope.failure = failure;
  }
  for (;;) {
    const drains = [...scope.drains];
    if (drains.length === 0) return;
    await Promise.all(drains);
  }
}

function createHermeticGitRepositoryAsyncSession(
  worktreePath: string,
  scope: HermeticGitRepositoryAsyncSessionScopeV1,
): HermeticGitRepositoryAsyncSessionV1 {
  const session: HermeticGitRepositoryAsyncSessionV1 = {
    readAsync: (query) =>
      trackHermeticGitRepositoryAsyncOperation(scope, () => {
        const command = compileHermeticGitReadQueryV1(query);
        return runWithRepositorySessionAuthorityAsync(worktreePath, () =>
          productionGitRuntime.runBufferAsync(
            worktreePath,
            command.args,
            command.acceptedStatuses,
            command.input,
            command.maximumOutputBytes,
          ),
        );
      }),
    readTextAsync: (query) =>
      trackHermeticGitRepositoryAsyncOperation(scope, () => {
        const command = compileHermeticGitReadQueryV1(query);
        if (command.input !== undefined) {
          return Promise.reject(
            new TypeError(`${query.kind} is a byte-protocol query and cannot be decoded as text`),
          );
        }
        return runWithRepositorySessionAuthorityAsync(worktreePath, () =>
          productionGitRuntime.runTextAsync(
            worktreePath,
            command.args,
            command.acceptedStatuses,
            command.maximumOutputBytes,
          ),
        );
      }),
  };
  return Object.freeze(session);
}

async function attestRepositoryConfiguration(
  topology: RepositoryTopologyObservationV1,
  observer: CanonicalGitWorktreeEvidenceObserver = {},
): Promise<RepositoryConfigurationEvidence> {
  const { worktreePath, gitDirPath, commonDirPath } = topology;
  const parsedConfig = (
    await productionGitRuntime.parseConfigAsync(
      topology.config.content,
      MAX_REPOSITORY_CONFIG_BYTES,
    )
  ).stdout;
  assertHermeticRepositoryConfig(parsedConfig);
  assertRepositoryTopologyCurrent(topology);

  const reportedCommonDirPath = realpathSync(
    (
      await readBoundedGitText(
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        worktreePath,
      )
    ).trim(),
  );
  const reportedGitDirPath = realpathSync(
    (
      await readBoundedGitText(['rev-parse', '--path-format=absolute', '--git-dir'], worktreePath)
    ).trim(),
  );
  const objectFormatRaw = (
    await readBoundedGitText(['rev-parse', '--show-object-format'], worktreePath)
  ).trim();
  if (reportedCommonDirPath !== commonDirPath || reportedGitDirPath !== gitDirPath) {
    throw new Error('Git repository locator differs from its descriptor-anchored topology');
  }
  if (objectFormatRaw !== 'sha1') {
    throw new Error(
      `Hermetic Git currently governs only repository-format-0 SHA-1 object stores; received ${objectFormatRaw}`,
    );
  }
  const objectFormat: GitObjectFormat = 'sha1';
  const replaceRefs = (
    await productionGitRuntime.runTextAsync(worktreePath, [
      'for-each-ref',
      '--format=%(refname)',
      'refs/replace',
    ])
  ).stdout.trim();
  if (replaceRefs.length > 0) {
    throw new Error('Hermetic Git refuses replace refs');
  }

  if (observer.afterRepositoryTopologyRead) {
    await observer.afterRepositoryTopologyRead(worktreePath);
  }
  assertRepositoryTopologyCurrent(topology);
  const finalCommonDirPath = realpathSync(
    (
      await readBoundedGitText(
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        worktreePath,
      )
    ).trim(),
  );
  const finalGitDirPath = realpathSync(
    (
      await readBoundedGitText(['rev-parse', '--path-format=absolute', '--git-dir'], worktreePath)
    ).trim(),
  );
  const finalObjectFormat = (
    await readBoundedGitText(['rev-parse', '--show-object-format'], worktreePath)
  ).trim();
  if (
    finalCommonDirPath !== commonDirPath ||
    finalGitDirPath !== gitDirPath ||
    finalObjectFormat !== objectFormat
  ) {
    throw new InventoryInspectionError(
      'DIRTY_SNAPSHOT_MOVED',
      `${worktreePath} repository topology changed during its descriptor-anchored observation`,
    );
  }

  const substrateDigest = createHash('sha256');
  let substrateByteLength = 0n;
  for (const [label, payload] of [
    ['WORKTREE_IDENTITY', directoryAnchorIdentity(topology.worktree)],
    ['DOT_GIT_IDENTITY', topology.dotGitIdentity],
    ['GIT_DIR_IDENTITY', topology.gitDir.identity],
    ['COMMON_DIR_IDENTITY', topology.commonDir.identity],
    ['COMMON_DIR_REDIRECT_IDENTITY', optionalTopologySubstrateIdentity(topology.commonDirRedirect)],
    ['GIT_DIR_BACKLINK_IDENTITY', optionalTopologySubstrateIdentity(topology.gitDirBacklink)],
    ['CONFIG_IDENTITY', regularFileIdentity(topology.config)],
    ['REPLACE_REFS_IDENTITY', optionalTopologyDirectorySubstrateIdentity(topology.replaceRefs)],
    ['ALTERNATES_IDENTITY', optionalTopologySubstrateIdentity(topology.alternates)],
    ['SHALLOW_IDENTITY', optionalTopologySubstrateIdentity(topology.shallow)],
    ['GRAFTS_IDENTITY', optionalTopologySubstrateIdentity(topology.grafts)],
    ['WORKTREE_CONFIG_IDENTITY', optionalTopologySubstrateIdentity(topology.worktreeConfig)],
  ] as const) {
    updateDigestFrame(substrateDigest, label, payload);
    substrateByteLength += BigInt(payload.length);
  }
  const contentDigest = createHash('sha256');
  updateDigestFrame(
    contentDigest,
    'FORMAT',
    Buffer.from('HERMETIC_GIT_REPOSITORY_CONFIGURATION_CONTENT_V2', 'ascii'),
  );
  let contentByteLength = 0n;
  // Raw repository config is a substrate/race authority, not logical source content. Every
  // accepted key is either fixed above (format/bare) or inert for the descriptor-bound evidence
  // commands. Behavior-changing includes, filters, alternates, sparse checkout, activated
  // worktree config, and partial-clone authorities are rejected before this projection is built.
  // An inactive config.worktree file is retained as content and substrate evidence because the
  // common config is the only activation authority for extensions.worktreeConfig.
  for (const [label, payload] of [['OBJECT_FORMAT', Buffer.from(objectFormat, 'ascii')]] as const) {
    updateDigestFrame(contentDigest, label, payload);
    contentByteLength += BigInt(payload.length);
  }
  contentByteLength += updateConfigurationDigestFile(
    contentDigest,
    'ALTERNATES',
    optionalTopologyContent(topology.alternates),
  );
  contentByteLength += updateConfigurationDigestFile(
    contentDigest,
    'SHALLOW',
    optionalTopologyContent(topology.shallow),
  );
  contentByteLength += updateConfigurationDigestFile(
    contentDigest,
    'GRAFTS',
    optionalTopologyContent(topology.grafts),
  );
  contentByteLength += updateConfigurationDigestFile(
    contentDigest,
    'WORKTREE_CONFIG',
    optionalTopologyContent(topology.worktreeConfig),
  );
  return Object.freeze({
    contentFingerprint: Object.freeze({
      byteLength: contentByteLength,
      sha256: contentDigest.digest('hex'),
    }),
    substrateFingerprint: Object.freeze({
      byteLength: substrateByteLength,
      sha256: substrateDigest.digest('hex'),
    }),
    objectFormat,
  });
}

function attestRepositoryConfigurationSync(topology: RepositoryTopologyObservationV1): void {
  const { worktreePath, gitDirPath, commonDirPath } = topology;
  assertHermeticRepositoryConfig(
    productionGitRuntime.parseConfig(topology.config.content, MAX_REPOSITORY_CONFIG_BYTES).stdout,
  );
  assertRepositoryTopologyCurrent(topology);
  const session = createHermeticGitRepositorySyncSession(worktreePath);
  const readCoordinate = (
    coordinate: Extract<
      HermeticGitReadQueryV1,
      { readonly kind: 'REPOSITORY_COORDINATE' }
    >['coordinate'],
  ): string => session.readText({ kind: 'REPOSITORY_COORDINATE', coordinate }).stdout.trim();
  const reportedCommonDirPath = realpathSync(readCoordinate('COMMON_DIR'));
  const reportedGitDirPath = realpathSync(readCoordinate('GIT_DIR'));
  const objectFormat = readCoordinate('OBJECT_FORMAT');
  if (
    reportedCommonDirPath !== commonDirPath ||
    reportedGitDirPath !== gitDirPath ||
    objectFormat !== 'sha1'
  ) {
    throw new Error('Git repository locator differs from its descriptor-anchored topology');
  }
  const replaceRefs = session
    .readText({ kind: 'LIST_REFS', namespace: 'REPLACE', projection: 'NAMES' })
    .stdout.trim();
  if (replaceRefs.length > 0) throw new Error('Hermetic Git refuses replace refs');
  assertRepositoryTopologyCurrent(topology);
  const finalCommonDirPath = realpathSync(readCoordinate('COMMON_DIR'));
  const finalGitDirPath = realpathSync(readCoordinate('GIT_DIR'));
  if (
    finalCommonDirPath !== commonDirPath ||
    finalGitDirPath !== gitDirPath ||
    readCoordinate('OBJECT_FORMAT') !== objectFormat
  ) {
    throw new InventoryInspectionError(
      'DIRTY_SNAPSHOT_MOVED',
      `${worktreePath} repository topology changed during its synchronous observation`,
    );
  }
}

async function withValidatedHermeticGitRepository<T>(
  worktreePath: string,
  action: (session: HermeticGitRepositoryAsyncSessionV1) => T | Promise<T>,
): Promise<T> {
  const absoluteWorktreePath = requireAbsoluteWorktreePath(worktreePath);
  return withRepositoryDescriptorAuthority(absoluteWorktreePath, async (topology) => {
    await attestRepositoryConfiguration(topology);
    const scope = createHermeticGitRepositoryAsyncSessionScope();
    const session = createHermeticGitRepositoryAsyncSession(absoluteWorktreePath, scope);
    let outcome: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: Error }>;
    try {
      outcome = Object.freeze({ ok: true, value: await action(session) });
    } catch (error) {
      outcome = Object.freeze({
        ok: false,
        error: errorFromUnknown('Hermetic Git repository action failed', error),
      });
    }
    const settledFailure = outcome.ok
      ? new Error('Hermetic Git asynchronous repository session is already settled')
      : outcome.error;
    await sealAndDrainHermeticGitRepositoryAsyncSession(scope, settledFailure);
    const failures = [
      ...(outcome.ok ? [] : [outcome.error]),
      ...scope.operationFailures.filter((failure) => outcome.ok || failure !== outcome.error),
    ];
    const onlyFailure = failures.length === 1 ? failures[0] : undefined;
    if (onlyFailure !== undefined) throw onlyFailure;
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Hermetic Git repository action and operations failed');
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  });
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false;
  return typeof Reflect.get(value, 'then') === 'function';
}

function withValidatedHermeticGitRepositorySync<T>(
  worktreePath: string,
  action: (session: HermeticGitRepositorySyncSessionV1) => HermeticGitSynchronousResult<T>,
): T {
  const absoluteWorktreePath = requireAbsoluteWorktreePath(worktreePath);
  return withRepositoryDescriptorAuthoritySync(absoluteWorktreePath, (topology) => {
    attestRepositoryConfigurationSync(topology);
    const result = action(createHermeticGitRepositorySyncSession(absoluteWorktreePath));
    if (isPromiseLike(result)) {
      throw new TypeError('Hermetic Git synchronous repository action returned a Promise/thenable');
    }
    return result;
  });
}

function splitNulRecords(raw: Buffer, label: string): Buffer[] {
  if (raw.length === 0) {
    return [];
  }
  if (raw[raw.length - 1] !== 0) {
    throw new Error(`${label} is not NUL terminated`);
  }
  const records: Buffer[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const terminator = raw.indexOf(0, offset);
    if (terminator === -1 || terminator === offset) {
      throw new Error(`${label} contains a malformed record`);
    }
    records.push(Buffer.from(raw.subarray(offset, terminator)));
    offset = terminator + 1;
  }
  return records;
}

function decodeGitPath(path: Buffer, label: string): string {
  validateRelativeGitPath(path);
  try {
    return utf8Decoder.decode(path);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function assertPathOrderAndCaseUniqueness(entries: readonly TrackedEntry[], label: string): void {
  const caseFolded = new Map<string, string>();
  let previous: Buffer | null = null;
  for (const entry of entries) {
    if (previous !== null && Buffer.compare(previous, entry.path) >= 0) {
      throw new Error(`${label} paths are not strictly byte ordered`);
    }
    previous = entry.path;
    const decodedPath = decodeGitPath(entry.path, `${label} path`);
    const folded = decodedPath.normalize('NFC').toLowerCase();
    const collision = caseFolded.get(folded);
    if (collision !== undefined) {
      throw new Error(
        `${label} contains a case/normalization collision: ${collision}, ${decodedPath}`,
      );
    }
    caseFolded.set(folded, decodedPath);
  }
}

function requireTrackedMode(mode: string, label: string): TrackedEntry['mode'] {
  if (mode === '160000') {
    throw new Error(`${label} is a gitlink; submodule content is not recursively governed`);
  }
  if (mode !== '100644' && mode !== '100755' && mode !== '120000') {
    throw new Error(`${label} has unsupported Git mode ${mode}`);
  }
  return mode;
}

function requireObjectId(objectId: string, objectFormat: GitObjectFormat, label: string): string {
  const expectedLength = 40;
  if (
    objectId.length !== expectedLength ||
    !/^[0-9a-f]+$/.test(objectId) ||
    /^0+$/.test(objectId)
  ) {
    throw new Error(`${label} is not one ${objectFormat} object ID`);
  }
  return objectId;
}

function parseIndexEntries(raw: Buffer, objectFormat: GitObjectFormat): TrackedEntry[] {
  const entries = splitNulRecords(raw, 'Git index record stream').map((record, index) => {
    if (record.length < 3 || record[1] !== 0x20) {
      throw new Error(`Git index record ${String(index + 1)} has no flag tag`);
    }
    const tag = String.fromCharCode(record[0] ?? 0);
    if (tag !== 'H') {
      throw new Error(
        `Git index record ${String(index + 1)} carries ${JSON.stringify(tag)}; assume-unchanged, skip-worktree, fsmonitor-valid, sparse, unmerged, and removed flags are forbidden`,
      );
    }
    const separator = record.indexOf(0x09, 2);
    if (separator === -1) {
      throw new Error(`Git index record ${String(index + 1)} is malformed`);
    }
    const metadata = record.subarray(2, separator).toString('ascii').split(' ');
    if (metadata.length !== 3) {
      throw new Error(`Git index record ${String(index + 1)} metadata is malformed`);
    }
    const [rawMode, rawObjectId, stage] = metadata;
    if (rawMode === undefined || rawObjectId === undefined || stage !== '0') {
      throw new Error(`Git index record ${String(index + 1)} is not one stage-zero entry`);
    }
    return Object.freeze({
      path: Buffer.from(record.subarray(separator + 1)),
      mode: requireTrackedMode(rawMode, `Git index record ${String(index + 1)}`),
      objectId: requireObjectId(
        rawObjectId,
        objectFormat,
        `Git index record ${String(index + 1)} object ID`,
      ),
    });
  });
  assertPathOrderAndCaseUniqueness(entries, 'Git index');
  return entries;
}

function parseHeadTreeEntries(raw: Buffer, objectFormat: GitObjectFormat): TrackedEntry[] {
  const entries = splitNulRecords(raw, 'HEAD tree record stream').map((record, index) => {
    const separator = record.indexOf(0x09);
    if (separator === -1) {
      throw new Error(`HEAD tree record ${String(index + 1)} is malformed`);
    }
    const metadata = record.subarray(0, separator).toString('ascii').split(' ');
    if (metadata.length !== 3) {
      throw new Error(`HEAD tree record ${String(index + 1)} metadata is malformed`);
    }
    const [rawMode, type, rawObjectId] = metadata;
    if (rawMode === undefined || rawObjectId === undefined || type !== 'blob') {
      if (rawMode === '160000' || type === 'commit') {
        throw new Error(
          `HEAD tree record ${String(index + 1)} is a gitlink; submodule content is not recursively governed`,
        );
      }
      throw new Error(`HEAD tree record ${String(index + 1)} is not one blob`);
    }
    return Object.freeze({
      path: Buffer.from(record.subarray(separator + 1)),
      mode: requireTrackedMode(rawMode, `HEAD tree record ${String(index + 1)}`),
      objectId: requireObjectId(
        rawObjectId,
        objectFormat,
        `HEAD tree record ${String(index + 1)} object ID`,
      ),
    });
  });
  assertPathOrderAndCaseUniqueness(entries, 'HEAD tree');
  return entries;
}

function sameTrackedEntries(
  left: readonly TrackedEntry[],
  right: readonly TrackedEntry[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => {
    const peer = right[index];
    return (
      peer !== undefined &&
      entry.mode === peer.mode &&
      entry.objectId === peer.objectId &&
      entry.path.equals(peer.path)
    );
  });
}

function gitObjectId(
  objectFormat: GitObjectFormat,
  content: Buffer,
  declaredSize = content.length,
): string {
  return createHash(objectFormat)
    .update(`blob ${String(declaredSize)}\0`, 'ascii')
    .update(content)
    .digest('hex');
}

async function loadGitBlobProofBatch(
  worktreePath: string,
  objectFormat: GitObjectFormat,
  proofs: Map<string, GitBlobProof>,
  objectIds: readonly string[],
): Promise<void> {
  if (objectIds.length === 0) {
    return;
  }
  const output = (
    await productionGitRuntime.runBufferAsync(
      worktreePath,
      ['cat-file', '--batch'],
      [0],
      `${objectIds.join('\n')}\n`,
      MAX_GIT_BLOB_BATCH_BYTES,
    )
  ).stdout;
  let offset = 0;
  for (const expectedObjectId of objectIds) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd === -1) {
      throw new Error('Git blob proof batch has a truncated header');
    }
    const header = output.subarray(offset, headerEnd).toString('ascii');
    const [objectId, type, rawSize, ...unexpected] = header.split(' ');
    const size = Number.parseInt(rawSize ?? '', 10);
    if (
      objectId !== expectedObjectId ||
      type !== 'blob' ||
      unexpected.length > 0 ||
      !/^(?:0|[1-9]\d*)$/.test(rawSize ?? '') ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      throw new Error(`Git blob proof batch has an invalid header: ${header}`);
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= output.length || output[contentEnd] !== 0x0a) {
      throw new Error(`Git blob proof batch has truncated content for ${expectedObjectId}`);
    }
    const content = output.subarray(contentStart, contentEnd);
    if (gitObjectId(objectFormat, content, size) !== expectedObjectId) {
      throw new Error(`Git blob ${expectedObjectId} does not hash to its object ID`);
    }
    proofs.set(
      expectedObjectId,
      Object.freeze({
        objectId: expectedObjectId,
        byteLength: BigInt(size),
        sha256: createHash('sha256').update(content).digest('hex'),
      }),
    );
    offset = contentEnd + 1;
  }
  if (offset !== output.length) {
    throw new Error('Git blob proof batch contains trailing bytes');
  }
}

async function loadGitBlobProofs(
  worktreePath: string,
  configuration: RepositoryConfigurationEvidence,
  entries: readonly TrackedEntry[],
): Promise<ReadonlyMap<string, GitBlobProof>> {
  const objectIds = [...new Set(entries.map((entry) => entry.objectId))];
  const proofs = new Map<string, GitBlobProof>();
  for (let offset = 0; offset < objectIds.length; offset += GIT_BLOB_BATCH_SIZE) {
    await loadGitBlobProofBatch(
      worktreePath,
      configuration.objectFormat,
      proofs,
      objectIds.slice(offset, offset + GIT_BLOB_BATCH_SIZE),
    );
  }
  for (const objectId of objectIds) {
    if (!proofs.has(objectId)) {
      throw new Error(`Git blob proof batch lost ${objectId}`);
    }
  }
  return proofs;
}

function updateCountedFrame(
  digest: Hash,
  byteLength: bigint,
  label: string,
  payload: Buffer,
): bigint {
  updateDigestFrame(digest, label, payload);
  return byteLength + BigInt(16 + Buffer.byteLength(label) + payload.length);
}

function encodeBigIntStatGeneration(stat: BigIntStats): Buffer {
  const values = [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.uid,
    stat.gid,
    stat.rdev,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ];
  const encoded = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => {
    if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
      throw new Error(`filesystem generation field ${String(index)} exceeds unsigned 64-bit`);
    }
    encoded.writeBigUInt64BE(value, index * 8);
  });
  return encoded;
}

function encodeDirectoryStableIdentity(stat: BigIntStats): Buffer {
  const values = [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.rdev];
  const encoded = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => encoded.writeBigUInt64BE(value, index * 8));
  return encoded;
}

function updatePinnedDirectorySubstrate(
  digest: Hash,
  byteLength: bigint,
  pinnedPath: PinnedWorktreePath,
): bigint {
  let current = byteLength;
  for (const descriptor of pinnedPath.directoryDescriptors) {
    current = updateCountedFrame(
      digest,
      current,
      'PARENT_DIRECTORY_IDENTITY',
      encodeDirectoryStableIdentity(fstatSync(descriptor, { bigint: true })),
    );
  }
  return current;
}

function updateDirectoryAbsenceSubstrate(
  digest: Hash,
  byteLength: bigint,
  observation: StableDirectoryObservationV1,
): bigint {
  if (observation.entries === null) {
    throw new Error(`missing-path parent has no exact entry observation: ${observation.path}`);
  }
  let current = updateCountedFrame(
    digest,
    byteLength,
    'MISSING_PARENT_PATH',
    Buffer.from(observation.path, 'utf8'),
  );
  current = updateCountedFrame(
    digest,
    current,
    'MISSING_PARENT_GENERATION',
    encodeBigIntStatGeneration(observation.stat),
  );
  for (const entry of observation.entries) {
    current = updateCountedFrame(
      digest,
      current,
      'MISSING_PARENT_ENTRY',
      Buffer.from(`${entry.kind}\0${entry.name}`, 'utf8'),
    );
  }
  return current;
}

interface PinnedWorktreePath {
  readonly kind: 'TARGET';
  readonly descriptorPath: Buffer;
  readonly directoryDescriptors: readonly number[];
  readonly targetParentPath: string;
  readonly targetParentGeneration: BigIntStats;
}

interface PinnedWorktreeAbsence {
  readonly kind: 'MISSING';
  readonly parentObservation: StableDirectoryObservationV1;
}

function throwHermeticGitActionAndCleanupFailures(
  label: string,
  actionFailure: Error | null,
  cleanupFailure: Error | null,
): void {
  if (actionFailure !== null && cleanupFailure !== null) {
    throw new AggregateError(
      [actionFailure, cleanupFailure],
      `${label} action failed (${actionFailure.message}); cleanup failed (${cleanupFailure.message})`,
    );
  }
  if (actionFailure !== null) throw actionFailure;
  if (cleanupFailure !== null) throw cleanupFailure;
}

function runWithHermeticGitCleanup<T>(label: string, action: () => T, cleanup: () => void): T {
  let result!: T;
  let actionFailure: Error | null = null;
  try {
    result = action();
  } catch (error) {
    actionFailure = errorFromUnknown(`${label} action failed`, error);
  }
  let cleanupFailure: Error | null = null;
  try {
    cleanup();
  } catch (error) {
    cleanupFailure = errorFromUnknown(`${label} cleanup failed`, error);
  }
  throwHermeticGitActionAndCleanupFailures(label, actionFailure, cleanupFailure);
  return result;
}

async function runWithHermeticGitCleanupAsync<T>(
  label: string,
  action: () => Promise<T>,
  cleanup: () => Promise<void> | void,
): Promise<T> {
  let result!: T;
  let actionFailure: Error | null = null;
  try {
    result = await action();
  } catch (error) {
    actionFailure = errorFromUnknown(`${label} action failed`, error);
  }
  let cleanupFailure: Error | null = null;
  try {
    await cleanup();
  } catch (error) {
    cleanupFailure = errorFromUnknown(`${label} cleanup failed`, error);
  }
  throwHermeticGitActionAndCleanupFailures(label, actionFailure, cleanupFailure);
  return result;
}

function closeHermeticGitDescriptors(descriptors: readonly number[], label: string): void {
  const failures: Error[] = [];
  for (const descriptor of [...descriptors].reverse()) {
    try {
      closeSync(descriptor);
    } catch (error) {
      failures.push(
        errorFromUnknown(`${label} descriptor ${String(descriptor)} close failed`, error),
      );
    }
  }
  const singleFailure = failures[0];
  if (failures.length === 1 && singleFailure !== undefined) throw singleFailure;
  if (failures.length > 1) {
    throw new AggregateError(failures, `${label} descriptor cleanup failed`);
  }
}

/** Exact-import test adapter for the production all-descriptor cleanup kernel. */
export function testOnlyCloseHermeticGitDescriptors(descriptors: readonly number[]): void {
  closeHermeticGitDescriptors(descriptors, 'Hermetic Git test descriptor set');
}

function closePinnedWorktreePath(path: PinnedWorktreePath): void {
  closeHermeticGitDescriptors(path.directoryDescriptors, 'Pinned Git worktree path');
}

function openPinnedWorktreePath(
  worktreePath: string,
  relativePath: Buffer,
): PinnedWorktreePath | PinnedWorktreeAbsence {
  validateRelativeGitPath(relativePath);
  const decodedPath = decodeGitPath(relativePath, 'pinned Git worktree path');
  const components = relativePath
    .toString('binary')
    .split('/')
    .map((component) => Buffer.from(component, 'binary'));
  const finalComponent = components.at(-1);
  if (finalComponent === undefined) {
    throw new Error('Git path has no final component');
  }
  const descriptors: number[] = [];
  let currentLexicalPath = worktreePath;
  const rootBefore = lstatSync(worktreePath, { bigint: true });
  const rootDescriptor = openSync(
    worktreePath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  descriptors.push(rootDescriptor);
  let retainDescriptors = false;
  return runWithHermeticGitCleanup(
    `Pinned Git worktree path ${worktreePath}/${decodedPath}`,
    () => {
      let currentDescriptor = rootDescriptor;
      const openedRoot = fstatSync(currentDescriptor, { bigint: true });
      if (!openedRoot.isDirectory() || !sameBigIntFileObservation(rootBefore, openedRoot)) {
        throw new InventoryInspectionError(
          'DIRTY_SNAPSHOT_MOVED',
          `${worktreePath} changed before its root directory descriptor opened`,
        );
      }
      for (const [index, component] of components.slice(0, -1).entries()) {
        const parentBefore = fstatSync(currentDescriptor, { bigint: true });
        const candidate = Buffer.concat([
          Buffer.from(`/proc/self/fd/${String(currentDescriptor)}/`, 'ascii'),
          component,
        ]);
        let nextDescriptor: number;
        try {
          nextDescriptor = openSync(
            candidate,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
        } catch (error) {
          if (errorCode(error) === 'ENOENT') {
            const parentObservation = observeStableDirectory(
              currentLexicalPath,
              `${worktreePath}/${decodedPath} missing parent`,
              true,
            );
            if (!sameBigIntFileObservation(parentBefore, parentObservation.stat)) {
              throw new InventoryInspectionError(
                'DIRTY_SNAPSHOT_MOVED',
                `${worktreePath}/${decodedPath} parent changed while absence was observed`,
              );
            }
            return Object.freeze({ kind: 'MISSING' as const, parentObservation });
          }
          if (errorCode(error) === 'ELOOP' || errorCode(error) === 'ENOTDIR') {
            throw new InventoryInspectionError(
              'DIRTY_SNAPSHOT_MOVED',
              `${worktreePath}/${relativePath.toString('utf8')} parent changed into a symlink or non-directory`,
            );
          }
          throw error;
        }
        descriptors.push(nextDescriptor);
        const parentStat = fstatSync(nextDescriptor, { bigint: true });
        if (!parentStat.isDirectory()) {
          throw new Error(
            `${worktreePath}/${relativePath.toString('utf8')} traverses a non-directory parent`,
          );
        }
        currentDescriptor = nextDescriptor;
        currentLexicalPath = join(currentLexicalPath, decodedPath.split('/')[index] ?? '');
      }
      const target = Object.freeze({
        kind: 'TARGET' as const,
        descriptorPath: Buffer.concat([
          Buffer.from(`/proc/self/fd/${String(currentDescriptor)}/`, 'ascii'),
          finalComponent,
        ]),
        directoryDescriptors: Object.freeze(descriptors),
        targetParentPath: currentLexicalPath,
        targetParentGeneration: fstatSync(currentDescriptor, { bigint: true }),
      });
      retainDescriptors = true;
      return target;
    },
    () => {
      if (!retainDescriptors) {
        closeHermeticGitDescriptors(
          descriptors,
          `Pinned Git worktree path ${worktreePath}/${decodedPath}`,
        );
      }
    },
  );
}

function observePinnedTargetAbsence(
  worktreePath: string,
  relativePath: Buffer,
  pinnedPath: PinnedWorktreePath,
): StableDirectoryObservationV1 {
  const observation = observeStableDirectory(
    pinnedPath.targetParentPath,
    `${worktreePath}/${decodeGitPath(relativePath, 'missing Git worktree path')} missing target parent`,
    true,
  );
  if (!sameBigIntFileObservation(pinnedPath.targetParentGeneration, observation.stat)) {
    throw new InventoryInspectionError(
      'DIRTY_SNAPSHOT_MOVED',
      `${worktreePath}/${relativePath.toString('hex')} parent changed while target absence was observed`,
    );
  }
  const finalName = decodeGitPath(relativePath, 'missing Git worktree path').split('/').at(-1);
  if (finalName === undefined || observation.entries?.some((entry) => entry.name === finalName)) {
    throw new InventoryInspectionError(
      'DIRTY_SNAPSHOT_MOVED',
      `${worktreePath}/${relativePath.toString('hex')} appeared while target absence was observed`,
    );
  }
  return observation;
}

function fingerprintSymlinkContent(
  content: Buffer,
  objectFormat: GitObjectFormat,
): RawContentFingerprint {
  return Object.freeze({
    objectId: gitObjectId(objectFormat, content),
    byteLength: BigInt(content.length),
    sha256: createHash('sha256').update(content).digest('hex'),
  });
}

async function scanTrackedWorktree(
  worktreePath: string,
  objectFormat: GitObjectFormat,
  entries: readonly TrackedEntry[],
  blobProofs: ReadonlyMap<string, GitBlobProof>,
): Promise<TrackedWorktreeScan> {
  const digest = createHash('sha256');
  const substrateDigest = createHash('sha256');
  let canonicalByteLength = 0n;
  let substrateByteLength = updateCountedFrame(
    substrateDigest,
    0n,
    'WORKTREE_PATH',
    Buffer.from(worktreePath, 'utf8'),
  );
  let dirty = false;
  for (const entry of entries) {
    substrateByteLength = updateCountedFrame(
      substrateDigest,
      substrateByteLength,
      'TRACKED_PATH',
      entry.path,
    );
    canonicalByteLength = updateCountedFrame(
      digest,
      canonicalByteLength,
      'TRACKED_PATH',
      entry.path,
    );
    canonicalByteLength = updateCountedFrame(
      digest,
      canonicalByteLength,
      'INDEX_MODE',
      Buffer.from(entry.mode, 'ascii'),
    );
    canonicalByteLength = updateCountedFrame(
      digest,
      canonicalByteLength,
      'INDEX_OBJECT_ID',
      Buffer.from(entry.objectId, 'ascii'),
    );
    const expectedBlob = blobProofs.get(entry.objectId);
    if (expectedBlob === undefined) {
      throw new Error(`Git blob proof is missing for ${entry.objectId}`);
    }
    canonicalByteLength = updateCountedFrame(
      digest,
      canonicalByteLength,
      'INDEX_BLOB_SHA256',
      Buffer.from(expectedBlob.sha256, 'ascii'),
    );

    const pinnedPath = openPinnedWorktreePath(worktreePath, entry.path);
    if (pinnedPath.kind === 'MISSING') {
      dirty = true;
      substrateByteLength = updateCountedFrame(
        substrateDigest,
        substrateByteLength,
        'WORKTREE_STATE',
        Buffer.from('MISSING', 'ascii'),
      );
      substrateByteLength = updateDirectoryAbsenceSubstrate(
        substrateDigest,
        substrateByteLength,
        pinnedPath.parentObservation,
      );
      canonicalByteLength = updateCountedFrame(
        digest,
        canonicalByteLength,
        'WORKTREE_STATE',
        Buffer.from('MISSING', 'ascii'),
      );
      continue;
    }
    await runWithHermeticGitCleanupAsync(
      `Tracked Git worktree path ${worktreePath}/${entry.path.toString('hex')}`,
      async () => {
        const descriptorPath = pinnedPath.descriptorPath;
        let before: BigIntStats;
        try {
          before = await lstat(descriptorPath, { bigint: true });
        } catch (error) {
          if (errorCode(error) === 'ENOENT') {
            dirty = true;
            substrateByteLength = updateCountedFrame(
              substrateDigest,
              substrateByteLength,
              'WORKTREE_STATE',
              Buffer.from('MISSING', 'ascii'),
            );
            canonicalByteLength = updateCountedFrame(
              digest,
              canonicalByteLength,
              'WORKTREE_STATE',
              Buffer.from('MISSING', 'ascii'),
            );
            substrateByteLength = updateDirectoryAbsenceSubstrate(
              substrateDigest,
              substrateByteLength,
              observePinnedTargetAbsence(worktreePath, entry.path, pinnedPath),
            );
            return;
          }
          throw error;
        }
        const actualMode = resolveGitObjectMode(before);
        const rawContent =
          actualMode === GIT_OBJECT_MODE_SYMLINK
            ? fingerprintSymlinkContent(
                await readlink(descriptorPath, { encoding: 'buffer' }),
                objectFormat,
              )
            : await fingerprintRegularFile(
                descriptorPath,
                before,
                worktreePath,
                entry.path,
                objectFormat,
              );
        const after = await lstat(descriptorPath, { bigint: true });
        if (!sameBigIntFileObservation(before, after) || rawContent.byteLength !== before.size) {
          throw new InventoryInspectionError(
            'DIRTY_SNAPSHOT_MOVED',
            `${worktreePath}/${entry.path.toString('utf8')} changed during tracked-byte hashing`,
          );
        }
        substrateByteLength = updatePinnedDirectorySubstrate(
          substrateDigest,
          substrateByteLength,
          pinnedPath,
        );
        substrateByteLength = updateCountedFrame(
          substrateDigest,
          substrateByteLength,
          'WORKTREE_GENERATION',
          encodeBigIntStatGeneration(after),
        );
        canonicalByteLength = updateCountedFrame(
          digest,
          canonicalByteLength,
          'WORKTREE_MODE',
          Buffer.from(actualMode, 'ascii'),
        );
        canonicalByteLength = updateCountedFrame(
          digest,
          canonicalByteLength,
          'WORKTREE_OBJECT_ID',
          Buffer.from(rawContent.objectId, 'ascii'),
        );
        canonicalByteLength = updateCountedFrame(
          digest,
          canonicalByteLength,
          'WORKTREE_SHA256',
          Buffer.from(rawContent.sha256, 'ascii'),
        );
        const rawLength = Buffer.alloc(8);
        rawLength.writeBigUInt64BE(rawContent.byteLength);
        canonicalByteLength = updateCountedFrame(
          digest,
          canonicalByteLength,
          'WORKTREE_BYTE_LENGTH',
          rawLength,
        );
        dirty ||=
          actualMode !== entry.mode ||
          rawContent.objectId !== entry.objectId ||
          rawContent.sha256 !== expectedBlob.sha256 ||
          rawContent.byteLength !== expectedBlob.byteLength;
      },
      () => closePinnedWorktreePath(pinnedPath),
    );
  }
  return Object.freeze({
    dirty,
    fingerprint: Object.freeze({
      byteLength: canonicalByteLength,
      sha256: digest.digest('hex'),
    }),
    substrateFingerprint: Object.freeze({
      byteLength: substrateByteLength,
      sha256: substrateDigest.digest('hex'),
    }),
  });
}

function canonicalStatusSha256(
  headSha: string,
  repositoryConfiguration: GitStreamFingerprint,
  headTreeRecords: GitStreamFingerprint,
  indexRecords: GitStreamFingerprint,
  trackedWorktreeRecords: GitStreamFingerprint,
  untrackedPaths: GitStreamFingerprint,
  untrackedGitignoreAuthorities: GitStreamFingerprint,
): string {
  const digest = createHash('sha256');
  updateDigestFrame(digest, 'FORMAT', Buffer.from('HERMETIC_GIT_STATUS_V2', 'ascii'));
  updateDigestFrame(digest, 'HEAD', Buffer.from(headSha, 'ascii'));
  updateDigestFingerprintFrame(digest, 'REPOSITORY_CONFIGURATION', repositoryConfiguration);
  updateDigestFingerprintFrame(digest, 'HEAD_TREE_RECORDS', headTreeRecords);
  updateDigestFingerprintFrame(digest, 'INDEX_RECORDS', indexRecords);
  updateDigestFingerprintFrame(digest, 'TRACKED_WORKTREE_RECORDS', trackedWorktreeRecords);
  updateDigestFingerprintFrame(digest, 'UNTRACKED_PATHS', untrackedPaths);
  updateDigestFingerprintFrame(
    digest,
    'UNTRACKED_GITIGNORE_AUTHORITIES',
    untrackedGitignoreAuthorities,
  );
  return digest.digest('hex');
}

function canonicalSubstrateAttestationSha256(
  headSha: string,
  statusSha256: string,
  repositorySubstrate: GitStreamFingerprint,
  trackedWorktreeSubstrate: GitStreamFingerprint,
): string {
  const digest = createHash('sha256');
  updateDigestFrame(
    digest,
    'FORMAT',
    Buffer.from('HERMETIC_GIT_SUBSTRATE_ATTESTATION_V1', 'ascii'),
  );
  updateDigestFrame(digest, 'HEAD', Buffer.from(headSha, 'ascii'));
  updateDigestFrame(digest, 'CONTENT_STATUS_SHA256', Buffer.from(statusSha256, 'ascii'));
  updateDigestFingerprintFrame(digest, 'REPOSITORY_SUBSTRATE', repositorySubstrate);
  updateDigestFingerprintFrame(digest, 'TRACKED_WORKTREE_SUBSTRATE', trackedWorktreeSubstrate);
  return digest.digest('hex');
}

async function captureCanonicalGitWorktreeStatusWithAuthority(
  absoluteWorktreePath: string,
  observer: CanonicalGitWorktreeEvidenceObserver,
  startTopology: RepositoryTopologyObservationV1,
): Promise<CanonicalGitWorktreeStatus> {
  // Parse pinned config bytes without a repository, then run every repository-aware Git process
  // through the retained worktree/git-dir/common-dir descriptor authority.
  const configurationStart = await attestRepositoryConfiguration(startTopology, observer);
  const startHead = (
    await readBoundedGitText(['rev-parse', '--verify', 'HEAD^{commit}'], absoluteWorktreePath)
  ).trim();
  if (!SHA_PATTERN.test(startHead)) {
    throw new Error(`${absoluteWorktreePath}.HEAD is not one commit object ID`);
  }
  const headTreeRaw = (
    await productionGitRuntime.runBufferAsync(absoluteWorktreePath, CANONICAL_GIT_HEAD_TREE_ARGS)
  ).stdout;
  const indexRaw = (
    await productionGitRuntime.runBufferAsync(absoluteWorktreePath, CANONICAL_GIT_INDEX_ARGS)
  ).stdout;
  const fsmonitorIndexRaw = (
    await productionGitRuntime.runBufferAsync(
      absoluteWorktreePath,
      CANONICAL_GIT_INDEX_FSMONITOR_ARGS,
    )
  ).stdout;
  const headEntries = parseHeadTreeEntries(headTreeRaw, configurationStart.objectFormat);
  const indexEntries = parseIndexEntries(indexRaw, configurationStart.objectFormat);
  const fsmonitorIndexEntries = parseIndexEntries(
    fsmonitorIndexRaw,
    configurationStart.objectFormat,
  );
  if (!sameTrackedEntries(indexEntries, fsmonitorIndexEntries)) {
    throw new Error('Git index flag observations disagree on stage-zero entry authority');
  }
  const blobProofs = await loadGitBlobProofs(absoluteWorktreePath, configurationStart, [
    ...headEntries,
    ...indexEntries,
  ]);
  const trackedWorktree = await scanTrackedWorktree(
    absoluteWorktreePath,
    configurationStart.objectFormat,
    indexEntries,
    blobProofs,
  );
  const untrackedPaths = await fingerprintGitStdout(
    CANONICAL_GIT_UNTRACKED_ARGS,
    absoluteWorktreePath,
  );
  const untrackedGitignoreAuthorities = await fingerprintGitStdout(
    CANONICAL_GIT_UNTRACKED_GITIGNORE_ARGS,
    absoluteWorktreePath,
  );
  const endTopology = observeRepositoryTopology(absoluteWorktreePath);
  const configurationEnd = await attestRepositoryConfiguration(endTopology, observer);
  const endHead = (
    await readBoundedGitText(['rev-parse', '--verify', 'HEAD^{commit}'], absoluteWorktreePath)
  ).trim();
  if (
    startHead !== endHead ||
    !sameFingerprint(configurationStart.contentFingerprint, configurationEnd.contentFingerprint) ||
    !sameFingerprint(configurationStart.substrateFingerprint, configurationEnd.substrateFingerprint)
  ) {
    throw new InventoryInspectionError(
      'DIRTY_SNAPSHOT_MOVED',
      `${absoluteWorktreePath} HEAD or repository/common-dir identity changed while pinning status`,
    );
  }
  const headTreeRecords = fingerprintBuffer(headTreeRaw);
  const indexRecords = fingerprintIndexRecordStreams(indexRaw, fsmonitorIndexRaw);
  const dirty =
    !sameTrackedEntries(headEntries, indexEntries) ||
    trackedWorktree.dirty ||
    untrackedPaths.byteLength !== 0n ||
    untrackedGitignoreAuthorities.byteLength !== 0n;
  const statusSha256 = canonicalStatusSha256(
    startHead,
    configurationStart.contentFingerprint,
    headTreeRecords,
    indexRecords,
    trackedWorktree.fingerprint,
    untrackedPaths,
    untrackedGitignoreAuthorities,
  );
  return Object.freeze({
    headSha: startHead,
    dirty,
    statusSha256,
    repositoryConfiguration: configurationStart.contentFingerprint,
    repositorySubstrate: configurationStart.substrateFingerprint,
    headTreeRecords,
    indexRecords,
    trackedWorktreeRecords: trackedWorktree.fingerprint,
    trackedWorktreeSubstrate: trackedWorktree.substrateFingerprint,
    untrackedPaths,
    untrackedGitignoreAuthorities,
    substrateAttestationSha256: canonicalSubstrateAttestationSha256(
      startHead,
      statusSha256,
      configurationStart.substrateFingerprint,
      trackedWorktree.substrateFingerprint,
    ),
  });
}

export async function captureCanonicalGitWorktreeStatus(
  worktreePath: string,
  observer: CanonicalGitWorktreeEvidenceObserver = {},
): Promise<CanonicalGitWorktreeStatus> {
  const absoluteWorktreePath = requireAbsoluteWorktreePath(worktreePath);
  return withRepositoryDescriptorAuthority(absoluteWorktreePath, (topology) =>
    captureCanonicalGitWorktreeStatusWithAuthority(absoluteWorktreePath, observer, topology),
  );
}

function sameCanonicalStatus(
  left: CanonicalGitWorktreeStatus,
  right: CanonicalGitWorktreeStatus,
): boolean {
  return (
    left.headSha === right.headSha &&
    left.dirty === right.dirty &&
    left.statusSha256 === right.statusSha256 &&
    sameFingerprint(left.repositoryConfiguration, right.repositoryConfiguration) &&
    sameFingerprint(left.repositorySubstrate, right.repositorySubstrate) &&
    sameFingerprint(left.headTreeRecords, right.headTreeRecords) &&
    sameFingerprint(left.indexRecords, right.indexRecords) &&
    sameFingerprint(left.trackedWorktreeRecords, right.trackedWorktreeRecords) &&
    sameFingerprint(left.trackedWorktreeSubstrate, right.trackedWorktreeSubstrate) &&
    sameFingerprint(left.untrackedPaths, right.untrackedPaths) &&
    sameFingerprint(left.untrackedGitignoreAuthorities, right.untrackedGitignoreAuthorities) &&
    left.substrateAttestationSha256 === right.substrateAttestationSha256
  );
}

function assertSameCanonicalStatus(
  worktreePath: string,
  expected: CanonicalGitWorktreeStatus,
  actual: CanonicalGitWorktreeStatus,
): void {
  if (!sameCanonicalStatus(expected, actual)) {
    throw new InventoryInspectionError(
      'DIRTY_SNAPSHOT_MOVED',
      `${worktreePath} HEAD, config/common-dir, index, raw tracked bytes, or untracked inventory changed during hashing`,
    );
  }
}

function fingerprintBuffer(payload: Buffer): GitStreamFingerprint {
  return Object.freeze({
    byteLength: BigInt(payload.length),
    sha256: createHash('sha256').update(payload).digest('hex'),
  });
}

function fingerprintIndexRecordStreams(
  assumeUnchangedAndSkipWorktree: Buffer,
  fsmonitorAndSkipWorktree: Buffer,
): GitStreamFingerprint {
  const digest = createHash('sha256');
  updateDigestFrame(digest, 'INDEX_V_FLAGS', assumeUnchangedAndSkipWorktree);
  updateDigestFrame(digest, 'INDEX_F_FLAGS', fsmonitorAndSkipWorktree);
  return Object.freeze({
    byteLength:
      BigInt(assumeUnchangedAndSkipWorktree.length) + BigInt(fsmonitorAndSkipWorktree.length),
    sha256: digest.digest('hex'),
  });
}

async function fingerprintRegularFile(
  path: Buffer,
  pathObservation: BigIntStats,
  worktreePath: string,
  relativePath: Buffer,
  objectFormat: GitObjectFormat = 'sha1',
  closeHandle: (handle: FileHandle) => Promise<void> = (handle) => handle.close(),
): Promise<RawContentFingerprint> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  return runWithHermeticGitCleanupAsync(
    `Hermetic Git regular-file fingerprint ${worktreePath}/${relativePath.toString('hex')}`,
    async () => {
      const descriptorBefore = await handle.stat({ bigint: true });
      if (
        !descriptorBefore.isFile() ||
        !sameBigIntFileObservation(pathObservation, descriptorBefore)
      ) {
        throw new InventoryInspectionError(
          'DIRTY_SNAPSHOT_MOVED',
          `${worktreePath}/${relativePath.toString('utf8')} changed before hashing`,
        );
      }
      const sha256Digest = createHash('sha256');
      const objectDigest = createHash(objectFormat).update(
        `blob ${descriptorBefore.size.toString()}\0`,
        'ascii',
      );
      let byteLength = 0n;
      for await (const chunk of handle.createReadStream({
        autoClose: false,
        highWaterMark: 64 * 1024,
      })) {
        const bytes = bufferFromUnknownChunk(chunk);
        byteLength += BigInt(bytes.length);
        sha256Digest.update(bytes);
        objectDigest.update(bytes);
      }
      const descriptorAfter = await handle.stat({ bigint: true });
      if (
        !sameBigIntFileObservation(descriptorBefore, descriptorAfter) ||
        byteLength !== descriptorBefore.size
      ) {
        throw new InventoryInspectionError(
          'DIRTY_SNAPSHOT_MOVED',
          `${worktreePath}/${relativePath.toString('utf8')} changed during hashing`,
        );
      }
      return Object.freeze({
        objectId: objectDigest.digest('hex'),
        byteLength,
        sha256: sha256Digest.digest('hex'),
      });
    },
    () => closeHandle(handle),
  );
}

/** Exact-import adapter for deterministic action-plus-close fault tests. */
export function testOnlyFingerprintHermeticGitRegularFile(
  path: string,
  pathObservation: BigIntStats,
  closeHandle: (handle: FileHandle) => Promise<void>,
): Promise<void> {
  return fingerprintRegularFile(
    Buffer.from(path),
    pathObservation,
    dirname(path),
    Buffer.from(path),
    'sha1',
    closeHandle,
  ).then(() => undefined);
}

function validateRelativeGitPath(pathBytes: Buffer): void {
  if (pathBytes.length === 0 || pathBytes[0] === 0x2f) {
    throw new Error('Git returned an empty or absolute untracked path');
  }
  for (const component of pathBytes.toString('binary').split('/')) {
    if (component.length === 0 || component === '.' || component === '..') {
      throw new Error('Git returned an unsafe untracked path');
    }
  }
}

function resolveGitObjectMode(stat: BigIntStats): string {
  if (stat.isSymbolicLink()) {
    return GIT_OBJECT_MODE_SYMLINK;
  }
  if (!stat.isFile()) {
    throw new Error('unsupported untracked filesystem object');
  }
  return (stat.mode & 0o111n) === 0n ? GIT_OBJECT_MODE_REGULAR : GIT_OBJECT_MODE_EXECUTABLE;
}

interface CanonicalWorktreeHashEvidence {
  readonly contentSha256: string;
  readonly untrackedSubstrate: GitStreamFingerprint;
}

async function hashCanonicalWorktreeEvidence(
  worktreePath: string,
  status: CanonicalGitWorktreeStatus,
): Promise<CanonicalWorktreeHashEvidence> {
  const digest = createHash('sha256');
  const substrateDigest = createHash('sha256');
  let substrateByteLength = updateCountedFrame(
    substrateDigest,
    0n,
    'WORKTREE_PATH',
    Buffer.from(worktreePath, 'utf8'),
  );
  updateDigestFrame(digest, 'FORMAT', Buffer.from('HERMETIC_GIT_WORKTREE_CONTENT_V2', 'ascii'));
  updateDigestFrame(digest, 'HEAD', Buffer.from(status.headSha, 'ascii'));
  updateDigestFrame(digest, 'STATUS_SHA256', Buffer.from(status.statusSha256, 'ascii'));
  updateDigestFingerprintFrame(digest, 'REPOSITORY_CONFIGURATION', status.repositoryConfiguration);
  updateDigestFingerprintFrame(digest, 'HEAD_TREE_RECORDS', status.headTreeRecords);
  updateDigestFingerprintFrame(digest, 'INDEX_RECORDS', status.indexRecords);
  updateDigestFingerprintFrame(digest, 'TRACKED_WORKTREE_RECORDS', status.trackedWorktreeRecords);
  updateDigestFingerprintFrame(digest, 'UNTRACKED_PATHS', status.untrackedPaths);
  updateDigestFingerprintFrame(
    digest,
    'UNTRACKED_GITIGNORE_AUTHORITIES',
    status.untrackedGitignoreAuthorities,
  );

  let previousPath: Buffer | null = null;
  let untrackedCount = 0n;
  const authorityRaw = (
    await productionGitRuntime.runBufferAsync(worktreePath, CANONICAL_GIT_UNTRACKED_GITIGNORE_ARGS)
  ).stdout;
  if (!sameFingerprint(fingerprintBuffer(authorityRaw), status.untrackedGitignoreAuthorities)) {
    throw new InventoryInspectionError(
      'DIRTY_SNAPSHOT_MOVED',
      `${worktreePath} untracked .gitignore authority changed before content hashing`,
    );
  }
  const remainingGitignoreAuthorities = new Map<string, Buffer>();
  let previousAuthority: Buffer | null = null;
  for (const authorityPath of splitNulRecords(
    authorityRaw,
    `${worktreePath} untracked .gitignore authority stream`,
  )) {
    validateRelativeGitPath(authorityPath);
    if (previousAuthority !== null && Buffer.compare(previousAuthority, authorityPath) >= 0) {
      throw new Error(`${worktreePath} untracked .gitignore authorities are not ordered`);
    }
    previousAuthority = authorityPath;
    const decoded = decodeGitPath(authorityPath, 'untracked .gitignore authority');
    if (decoded !== '.gitignore' && !decoded.endsWith('/.gitignore')) {
      throw new Error(`Git returned a non-.gitignore authority path: ${decoded}`);
    }
    remainingGitignoreAuthorities.set(authorityPath.toString('hex'), authorityPath);
  }
  const hashUntrackedPath = async (untrackedPath: Buffer): Promise<void> => {
    substrateByteLength = updateCountedFrame(
      substrateDigest,
      substrateByteLength,
      'UNTRACKED_PATH',
      untrackedPath,
    );
    const pinnedPath = openPinnedWorktreePath(worktreePath, untrackedPath);
    if (pinnedPath.kind === 'MISSING') {
      throw new InventoryInspectionError(
        'DIRTY_SNAPSHOT_MOVED',
        `${worktreePath}/${decodeGitPath(untrackedPath, 'untracked worktree path')} disappeared before hashing`,
      );
    }
    await runWithHermeticGitCleanupAsync(
      `Untracked Git worktree path ${worktreePath}/${untrackedPath.toString('hex')}`,
      async () => {
        const descriptorPath = pinnedPath.descriptorPath;
        const before = await lstat(descriptorPath, { bigint: true });
        let mode: string;
        try {
          mode = resolveGitObjectMode(before);
        } catch (error) {
          throw new Error(
            `unsupported untracked filesystem object ${untrackedPath.toString('utf8')}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        const content =
          mode === GIT_OBJECT_MODE_SYMLINK
            ? fingerprintSymlinkContent(
                await readlink(descriptorPath, { encoding: 'buffer' }),
                'sha1',
              )
            : await fingerprintRegularFile(descriptorPath, before, worktreePath, untrackedPath);
        const after = await lstat(descriptorPath, { bigint: true });
        if (!sameBigIntFileObservation(before, after) || content.byteLength !== before.size) {
          throw new InventoryInspectionError(
            'DIRTY_SNAPSHOT_MOVED',
            `${worktreePath}/${untrackedPath.toString('utf8')} changed during hashing`,
          );
        }
        substrateByteLength = updatePinnedDirectorySubstrate(
          substrateDigest,
          substrateByteLength,
          pinnedPath,
        );
        substrateByteLength = updateCountedFrame(
          substrateDigest,
          substrateByteLength,
          'UNTRACKED_GENERATION',
          encodeBigIntStatGeneration(after),
        );
        updateDigestFrame(digest, 'UNTRACKED_PATH', untrackedPath);
        updateDigestFrame(digest, 'UNTRACKED_GIT_MODE', Buffer.from(mode, 'ascii'));
        updateDigestFingerprintFrame(digest, 'UNTRACKED_CONTENT', content);
        untrackedCount += 1n;
      },
      () => closePinnedWorktreePath(pinnedPath),
    );
  };
  await consumeGitNulRecords(
    CANONICAL_GIT_UNTRACKED_ARGS,
    worktreePath,
    `${worktreePath} untracked path list`,
    async (untrackedPath) => {
      validateRelativeGitPath(untrackedPath);
      if (previousPath !== null && Buffer.compare(previousPath, untrackedPath) >= 0) {
        throw new Error(`${worktreePath} untracked path list is not strictly ordered`);
      }
      previousPath = Buffer.from(untrackedPath);
      remainingGitignoreAuthorities.delete(untrackedPath.toString('hex'));
      await hashUntrackedPath(untrackedPath);
    },
  );
  for (const authorityPath of [...remainingGitignoreAuthorities.values()].sort((left, right) =>
    Buffer.compare(left, right),
  )) {
    await hashUntrackedPath(authorityPath);
  }
  const countFrame = Buffer.alloc(8);
  countFrame.writeBigUInt64BE(untrackedCount);
  updateDigestFrame(digest, 'UNTRACKED_COUNT', countFrame);
  substrateByteLength = updateCountedFrame(
    substrateDigest,
    substrateByteLength,
    'UNTRACKED_COUNT',
    countFrame,
  );
  return Object.freeze({
    contentSha256: digest.digest('hex'),
    untrackedSubstrate: Object.freeze({
      byteLength: substrateByteLength,
      sha256: substrateDigest.digest('hex'),
    }),
  });
}

function finalSubstrateAttestationSha256(
  status: CanonicalGitWorktreeStatus,
  untrackedSubstrate: GitStreamFingerprint,
): string {
  const digest = createHash('sha256');
  updateDigestFrame(
    digest,
    'FORMAT',
    Buffer.from('HERMETIC_GIT_COMPLETE_SUBSTRATE_ATTESTATION_V1', 'ascii'),
  );
  updateDigestFrame(
    digest,
    'STATUS_SUBSTRATE_SHA256',
    Buffer.from(status.substrateAttestationSha256, 'ascii'),
  );
  updateDigestFingerprintFrame(digest, 'UNTRACKED_SUBSTRATE', untrackedSubstrate);
  return digest.digest('hex');
}

/**
 * Produces the same canonical evidence for clean and dirty worktrees. Two complete
 * observations reject torn HEAD/index/worktree snapshots.
 */
export async function computeCanonicalGitWorktreeEvidence(
  worktreePath: string,
  observer: CanonicalGitWorktreeEvidenceObserver = {},
): Promise<CanonicalGitWorktreeEvidence> {
  const absoluteWorktreePath = requireAbsoluteWorktreePath(worktreePath);
  return withRepositoryDescriptorAuthority(absoluteWorktreePath, async (startTopology) => {
    const start = await captureCanonicalGitWorktreeStatusWithAuthority(
      absoluteWorktreePath,
      observer,
      startTopology,
    );
    const primaryHash = await hashCanonicalWorktreeEvidence(absoluteWorktreePath, start);
    const contentSha256 = primaryHash.contentSha256;
    const substrateAttestationSha256 = finalSubstrateAttestationSha256(
      start,
      primaryHash.untrackedSubstrate,
    );
    if (observer.beforeSnapshotVerification) {
      await observer.beforeSnapshotVerification();
    }
    const verificationStart = await captureCanonicalGitWorktreeStatusWithAuthority(
      absoluteWorktreePath,
      observer,
      observeRepositoryTopology(absoluteWorktreePath),
    );
    assertSameCanonicalStatus(absoluteWorktreePath, start, verificationStart);
    const verificationHash = await hashCanonicalWorktreeEvidence(
      absoluteWorktreePath,
      verificationStart,
    );
    const verificationContentSha256 = verificationHash.contentSha256;
    const verificationSubstrateAttestationSha256 = finalSubstrateAttestationSha256(
      verificationStart,
      verificationHash.untrackedSubstrate,
    );
    const verificationEnd = await captureCanonicalGitWorktreeStatusWithAuthority(
      absoluteWorktreePath,
      observer,
      observeRepositoryTopology(absoluteWorktreePath),
    );
    assertSameCanonicalStatus(absoluteWorktreePath, start, verificationEnd);
    if (
      verificationContentSha256 !== contentSha256 ||
      verificationSubstrateAttestationSha256 !== substrateAttestationSha256
    ) {
      throw new InventoryInspectionError(
        'DIRTY_SNAPSHOT_MOVED',
        `${absoluteWorktreePath} evidence changed between primary and verification scans`,
      );
    }
    return Object.freeze({
      headSha: start.headSha,
      dirty: start.dirty,
      statusSha256: start.statusSha256,
      contentSha256,
      substrateAttestationSha256,
    });
  });
}
