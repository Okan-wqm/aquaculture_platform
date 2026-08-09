import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';

const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

export interface AnchoredPathGenerationV1 {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly linkCount: bigint;
  readonly ownerUid: bigint;
  readonly ownerGid: bigint;
  readonly rdev: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface AnchoredDirectoryComponentV1 {
  readonly path: string;
  readonly descriptor: number;
  readonly generation: AnchoredPathGenerationV1;
}

export interface AnchoredDirectoryChainV1 {
  readonly path: string;
  readonly descriptor: number;
  readonly components: readonly AnchoredDirectoryComponentV1[];
}

export interface StableRegularFileObservationV1 {
  readonly path: string;
  readonly content: Buffer;
  readonly sha256: string;
  readonly stat: BigIntStats;
  readonly generation: AnchoredPathGenerationV1;
  readonly parentGenerations: readonly {
    readonly path: string;
    readonly generation: AnchoredPathGenerationV1;
  }[];
}

export interface StableDirectoryEntryV1 {
  readonly name: string;
  readonly kind: 'FILE' | 'DIRECTORY';
}

export interface StableDirectoryObservationV1 {
  readonly path: string;
  readonly stat: BigIntStats;
  readonly generation: AnchoredPathGenerationV1;
  readonly parentGenerations: readonly {
    readonly path: string;
    readonly generation: AnchoredPathGenerationV1;
  }[];
  readonly entries: readonly StableDirectoryEntryV1[] | null;
}

export type AnchoredPathKindV1 = 'MISSING' | 'FILE' | 'DIRECTORY';

export interface StablePathKindObservationV1 {
  readonly path: string;
  /** First path component whose presence is sealed by `parent`. */
  readonly anchorPath: string;
  readonly anchorKind: AnchoredPathKindV1;
  readonly kind: AnchoredPathKindV1;
  readonly targetGeneration: AnchoredPathGenerationV1 | null;
  readonly parent: StableDirectoryObservationV1;
}

export interface HermeticExecutableContractV1 {
  readonly path: string;
  readonly label: string;
  readonly versionArgs: readonly string[];
  readonly versionEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly executionPolicy: HermeticExecutableExecutionPolicyV1;
  readonly maximumBytes: number;
  readonly maximumVersionBytes: number;
}

export interface HermeticExecutableExecutionPolicyV1 {
  readonly schemaVersion: 1;
  readonly commandDeadlineMs: number;
  readonly timeoutSignal: 'SIGKILL';
}

export type HermeticExecutableExecutionPhaseV1 = 'VERSION_PROBE' | 'COMMAND';

export interface HermeticExecutableAttestationV1 {
  readonly binaryPath: string;
  readonly binarySha256: string;
  readonly version: string;
  readonly generation: AnchoredPathGenerationV1;
}

export interface HermeticExecutableAuthorityV1 {
  readonly attestation: HermeticExecutableAttestationV1;
  readonly descriptorPath: string;
  readonly argv0: string;
  assertCurrent(): void;
  close(): void;
}

export type AnchoredFilesystemErrorCode =
  | 'SYMLINK_COMPONENT'
  | 'STABLE_REGULAR_FILE_CHANGED'
  | 'STABLE_DIRECTORY_CHANGED'
  | 'STABLE_DIRECTORY_CONTENT_CHANGED'
  | 'STABLE_PATH_KIND_CHANGED';

/**
 * Stable machine-readable failure contract for descriptor-anchored filesystem fences.
 * Callers must branch on `code`; the human-readable message is diagnostic evidence only.
 */
export class AnchoredFilesystemError extends Error {
  public constructor(
    public readonly code: AnchoredFilesystemErrorCode,
    message: string,
    public readonly path: string,
  ) {
    super(message);
    this.name = 'AnchoredFilesystemError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class HermeticExecutableExecutionTimeoutError extends Error {
  public readonly code = 'HERMETIC_EXECUTABLE_EXECUTION_TIMEOUT' as const;

  public constructor(
    public readonly executableLabel: string,
    public readonly phase: HermeticExecutableExecutionPhaseV1,
    public readonly commandDeadlineMs: number,
    public readonly timeoutSignal: 'SIGKILL',
  ) {
    super(
      `${executableLabel} ${phase} exceeded its ${String(commandDeadlineMs)}ms execution deadline`,
    );
    this.name = 'HermeticExecutableExecutionTimeoutError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function assertHermeticExecutableExecutionPolicyV1(
  policy: HermeticExecutableExecutionPolicyV1,
): void {
  if (policy.schemaVersion !== 1) {
    throw new Error('Hermetic executable execution policy must use schemaVersion 1');
  }
  if (!Number.isSafeInteger(policy.commandDeadlineMs) || policy.commandDeadlineMs <= 0) {
    throw new Error('Hermetic executable commandDeadlineMs must be one positive safe integer');
  }
  if (policy.timeoutSignal !== 'SIGKILL') {
    throw new Error('Hermetic executable timeoutSignal must be SIGKILL');
  }
}

export function defineHermeticExecutableExecutionPolicyV1(
  policy: HermeticExecutableExecutionPolicyV1,
): Readonly<HermeticExecutableExecutionPolicyV1> {
  const canonicalPolicy: HermeticExecutableExecutionPolicyV1 = {
    schemaVersion: policy.schemaVersion,
    commandDeadlineMs: policy.commandDeadlineMs,
    timeoutSignal: policy.timeoutSignal,
  };
  assertHermeticExecutableExecutionPolicyV1(canonicalPolicy);
  return Object.freeze(canonicalPolicy);
}

function requireImmutableHermeticExecutableExecutionPolicyV1(
  policy: HermeticExecutableExecutionPolicyV1,
): Readonly<HermeticExecutableExecutionPolicyV1> {
  if (!Object.isFrozen(policy)) {
    throw new Error('Hermetic executable execution policy must be immutable');
  }
  return defineHermeticExecutableExecutionPolicyV1(policy);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function isStableCurrentnessTopologyError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP';
}

function stableCurrentnessError(
  code: Extract<
    AnchoredFilesystemErrorCode,
    | 'STABLE_REGULAR_FILE_CHANGED'
    | 'STABLE_DIRECTORY_CHANGED'
    | 'STABLE_DIRECTORY_CONTENT_CHANGED'
    | 'STABLE_PATH_KIND_CHANGED'
  >,
  path: string,
  label: string,
  cause: unknown,
): AnchoredFilesystemError {
  const failure = new AnchoredFilesystemError(
    code,
    `${label}: expected filesystem topology changed: ${path}`,
    path,
  );
  Object.defineProperty(failure, 'cause', {
    configurable: true,
    enumerable: false,
    value: cause,
    writable: true,
  });
  return failure;
}

function runStableCurrentnessCheck<T>(
  code: Extract<
    AnchoredFilesystemErrorCode,
    | 'STABLE_REGULAR_FILE_CHANGED'
    | 'STABLE_DIRECTORY_CHANGED'
    | 'STABLE_DIRECTORY_CONTENT_CHANGED'
    | 'STABLE_PATH_KIND_CHANGED'
  >,
  path: string,
  label: string,
  action: () => T,
): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof AnchoredFilesystemError) throw error;
    if (isStableCurrentnessTopologyError(error)) {
      throw stableCurrentnessError(code, path, label, error);
    }
    throw error;
  }
}

function assertCurrentLexicalKind(
  path: string,
  expectedKind: 'FILE' | 'DIRECTORY',
  code:
    | 'STABLE_REGULAR_FILE_CHANGED'
    | 'STABLE_DIRECTORY_CHANGED'
    | 'STABLE_DIRECTORY_CONTENT_CHANGED',
  label: string,
): void {
  const lexical = lstatSync(path, { bigint: true });
  const kindMatches = expectedKind === 'FILE' ? lexical.isFile() : lexical.isDirectory();
  if (lexical.isSymbolicLink() || !kindMatches) {
    throw stableCurrentnessError(code, path, label, new Error(`expected ${expectedKind}`));
  }
}

function cleanupFailure(message: string, error: unknown): Error {
  if (error instanceof Error) return error;
  const wrapped = new Error(message);
  Object.defineProperty(wrapped, 'cause', {
    configurable: true,
    enumerable: false,
    value: error,
    writable: true,
  });
  return wrapped;
}

function runWithAnchoredCleanup<T>(label: string, action: () => T, cleanup: () => void): T {
  let outcome:
    | { readonly status: 'SUCCESS'; readonly value: T }
    | { readonly status: 'FAILURE'; readonly error: unknown };
  try {
    outcome = { status: 'SUCCESS', value: action() };
  } catch (error) {
    outcome = { status: 'FAILURE', error };
  }
  let cleanupError: unknown;
  try {
    cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (outcome.status === 'FAILURE' && cleanupError !== undefined) {
    throw new AggregateError(
      [
        cleanupFailure(`${label} action failed`, outcome.error),
        cleanupFailure(`${label} cleanup failed`, cleanupError),
      ],
      `${label} action and cleanup both failed`,
    );
  }
  if (outcome.status === 'FAILURE') {
    throw cleanupFailure(`${label} action failed`, outcome.error);
  }
  if (cleanupError !== undefined) {
    throw cleanupFailure(`${label} cleanup failed`, cleanupError);
  }
  return outcome.value;
}

function closeAnchoredDirectoryComponents(
  components: readonly AnchoredDirectoryComponentV1[],
): void {
  const failures: Error[] = [];
  for (const component of [...components].reverse()) {
    try {
      closeSync(component.descriptor);
    } catch (error) {
      failures.push(
        cleanupFailure(`Failed to close directory descriptor ${component.path}`, error),
      );
    }
  }
  const [onlyFailure] = failures;
  if (failures.length === 1 && onlyFailure !== undefined) throw onlyFailure;
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      `Failed to close ${String(failures.length)} directory descriptors`,
    );
  }
}

function requireCanonicalAbsolutePath(path: string, label: string): string {
  if (!isAbsolute(path) || path.includes('\0') || resolve(path) !== path) {
    throw new Error(`${label} must be one normalized absolute path: ${JSON.stringify(path)}`);
  }
  return path;
}

export function anchoredPathGeneration(stat: BigIntStats): AnchoredPathGenerationV1 {
  return Object.freeze({
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    linkCount: stat.nlink,
    ownerUid: stat.uid,
    ownerGid: stat.gid,
    rdev: stat.rdev,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  });
}

export function sameAnchoredPathGeneration(
  left: AnchoredPathGenerationV1,
  right: AnchoredPathGenerationV1,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.linkCount === right.linkCount &&
    left.ownerUid === right.ownerUid &&
    left.ownerGid === right.ownerGid &&
    left.rdev === right.rdev &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/**
 * Directory contents legitimately change size and timestamps when an unrelated
 * child is created or removed.  The descriptor chain therefore pins only the
 * directory object's security identity; callers that need an exact child set
 * must additionally retain and compare a directory-entry observation. A
 * directory's link count is content-derived on POSIX (it changes with child
 * directories), so symlink rejection is explicit and `linkCount` is not an
 * identity field here.
 */
export function sameAnchoredDirectoryIdentity(
  left: AnchoredPathGenerationV1,
  right: AnchoredPathGenerationV1,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.ownerUid === right.ownerUid &&
    left.ownerGid === right.ownerGid &&
    left.rdev === right.rdev
  );
}

export function sameBigIntFileObservation(left: BigIntStats, right: BigIntStats): boolean {
  return sameAnchoredPathGeneration(anchoredPathGeneration(left), anchoredPathGeneration(right));
}

function assertDescriptorMatchesLexicalPath(
  path: string,
  descriptorStat: BigIntStats,
  expectedKind: 'FILE' | 'DIRECTORY',
  label: string,
): void {
  let lexical: BigIntStats;
  try {
    lexical = lstatSync(path, { bigint: true });
  } catch (error) {
    if (isStableCurrentnessTopologyError(error)) {
      throw stableCurrentnessError('STABLE_PATH_KIND_CHANGED', path, label, error);
    }
    throw error;
  }
  const kindMatches =
    expectedKind === 'FILE' ? descriptorStat.isFile() : descriptorStat.isDirectory();
  const lexicalKindMatches = expectedKind === 'FILE' ? lexical.isFile() : lexical.isDirectory();
  const descriptorGeneration = anchoredPathGeneration(descriptorStat);
  const lexicalGeneration = anchoredPathGeneration(lexical);
  const sameIdentity =
    expectedKind === 'DIRECTORY'
      ? sameAnchoredDirectoryIdentity(descriptorGeneration, lexicalGeneration)
      : sameAnchoredPathGeneration(descriptorGeneration, lexicalGeneration);
  if (
    descriptorStat.isSymbolicLink() ||
    lexical.isSymbolicLink() ||
    !kindMatches ||
    !lexicalKindMatches ||
    !sameIdentity
  ) {
    throw stableCurrentnessError(
      'STABLE_PATH_KIND_CHANGED',
      path,
      label,
      new Error('descriptor and lexical path identities differ'),
    );
  }
}

export function openAnchoredDirectoryChain(
  directoryPath: string,
  label: string,
  afterComponentDescriptorOpen: (componentPath: string) => void = () => undefined,
): AnchoredDirectoryChainV1 {
  const canonicalPath = requireCanonicalAbsolutePath(directoryPath, label);
  const root = parse(canonicalPath).root;
  const segments = canonicalPath.slice(root.length).split(sep).filter(Boolean);
  const components: AnchoredDirectoryComponentV1[] = [];
  try {
    let componentPath = root;
    const rootDescriptor = openSync(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    let descriptor = rootDescriptor;
    let rootRetained = false;
    runWithAnchoredCleanup(
      `${label} root descriptor construction`,
      () => {
        const descriptorStat = fstatSync(rootDescriptor, { bigint: true });
        afterComponentDescriptorOpen(componentPath);
        assertDescriptorMatchesLexicalPath(
          componentPath,
          descriptorStat,
          'DIRECTORY',
          `${label} root`,
        );
        components.push(
          Object.freeze({
            path: componentPath,
            descriptor: rootDescriptor,
            generation: anchoredPathGeneration(descriptorStat),
          }),
        );
        rootRetained = true;
      },
      () => {
        if (!rootRetained) closeSync(rootDescriptor);
      },
    );
    for (const segment of segments) {
      componentPath = join(componentPath, segment);
      try {
        descriptor = openSync(
          `/proc/self/fd/${String(descriptor)}/${segment}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (errorCode(error) === 'ELOOP') {
          throw new AnchoredFilesystemError(
            'SYMLINK_COMPONENT',
            `${label} descriptor chain encountered a symlink or non-directory: ${componentPath}`,
            componentPath,
          );
        }
        if (errorCode(error) === 'ENOTDIR') {
          try {
            if (lstatSync(componentPath, { bigint: true }).isSymbolicLink()) {
              throw new AnchoredFilesystemError(
                'SYMLINK_COMPONENT',
                `${label} descriptor chain encountered a symlink: ${componentPath}`,
                componentPath,
              );
            }
          } catch (lexicalError) {
            if (errorCode(lexicalError) !== 'ENOENT' && errorCode(lexicalError) !== 'ENOTDIR') {
              throw lexicalError;
            }
          }
        }
        throw error;
      }
      let retained = false;
      runWithAnchoredCleanup(
        `${label} component descriptor construction`,
        () => {
          const descriptorStat = fstatSync(descriptor, { bigint: true });
          afterComponentDescriptorOpen(componentPath);
          assertDescriptorMatchesLexicalPath(componentPath, descriptorStat, 'DIRECTORY', label);
          components.push(
            Object.freeze({
              path: componentPath,
              descriptor,
              generation: anchoredPathGeneration(descriptorStat),
            }),
          );
          retained = true;
        },
        () => {
          if (!retained) closeSync(descriptor);
        },
      );
    }
    const final = components.at(-1);
    if (final === undefined) {
      throw new Error(`${label} lost its directory descriptor`);
    }
    return Object.freeze({
      path: canonicalPath,
      descriptor: final.descriptor,
      components: Object.freeze(components),
    });
  } catch (error) {
    try {
      closeAnchoredDirectoryComponents(components);
    } catch (closeError) {
      throw new AggregateError(
        [
          cleanupFailure(`${label} descriptor-chain construction failed`, error),
          cleanupFailure(`${label} descriptor-chain cleanup failed`, closeError),
        ],
        `${label} descriptor-chain construction and cleanup both failed`,
      );
    }
    throw error;
  }
}

export function assertAnchoredDirectoryChainCurrent(
  chain: AnchoredDirectoryChainV1,
  label: string,
): void {
  assertAnchoredDirectoryChainIdentityCurrent(chain, label);
}

export function assertAnchoredDirectoryChainIdentityCurrent(
  chain: AnchoredDirectoryChainV1,
  label: string,
): void {
  for (const component of chain.components) {
    const descriptorStat = fstatSync(component.descriptor, { bigint: true });
    let lexical: BigIntStats;
    try {
      lexical = lstatSync(component.path, { bigint: true });
    } catch (error) {
      if (isStableCurrentnessTopologyError(error)) {
        throw stableCurrentnessError('STABLE_DIRECTORY_CHANGED', component.path, label, error);
      }
      throw error;
    }
    const descriptorGeneration = anchoredPathGeneration(descriptorStat);
    const lexicalGeneration = anchoredPathGeneration(lexical);
    if (
      !descriptorStat.isDirectory() ||
      descriptorStat.isSymbolicLink() ||
      !lexical.isDirectory() ||
      lexical.isSymbolicLink() ||
      !sameAnchoredDirectoryIdentity(component.generation, descriptorGeneration) ||
      !sameAnchoredDirectoryIdentity(component.generation, lexicalGeneration)
    ) {
      throw stableCurrentnessError(
        'STABLE_DIRECTORY_CHANGED',
        component.path,
        label,
        new Error('descriptor-chain identity differs'),
      );
    }
  }
}

export function closeAnchoredDirectoryChain(chain: AnchoredDirectoryChainV1): void {
  closeAnchoredDirectoryComponents(chain.components);
}

function readDescriptorBytes(
  descriptor: number,
  size: bigint,
  maximumBytes: number,
  label: string,
): Buffer {
  if (size > BigInt(maximumBytes) || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds its ${String(maximumBytes)}-byte contract`);
  }
  const content = Buffer.alloc(Number(size));
  let offset = 0;
  while (offset < content.length) {
    const bytesRead = readSync(descriptor, content, offset, content.length - offset, offset);
    if (bytesRead === 0) throw new Error(`${label} ended before its observed size`);
    offset += bytesRead;
  }
  return content;
}

function frozenParentGenerations(
  chain: AnchoredDirectoryChainV1,
): StableRegularFileObservationV1['parentGenerations'] {
  return Object.freeze(
    chain.components.map((component) =>
      Object.freeze({ path: component.path, generation: component.generation }),
    ),
  );
}

export function observeStableRegularFile(
  filePath: string,
  maximumBytes: number,
  label: string,
  afterDescriptorOpen: () => void = () => undefined,
): StableRegularFileObservationV1 {
  const canonicalPath = requireCanonicalAbsolutePath(filePath, label);
  const parent = openAnchoredDirectoryChain(dirname(canonicalPath), `${label} parent`);
  return runWithAnchoredCleanup(
    `${label} regular-file observation`,
    () => {
      const descriptorPath = `/proc/self/fd/${String(parent.descriptor)}/${basename(canonicalPath)}`;
      const descriptor = openSync(descriptorPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      return runWithAnchoredCleanup(
        `${label} regular-file descriptor`,
        () => {
          afterDescriptorOpen();
          const before = fstatSync(descriptor, { bigint: true });
          assertDescriptorMatchesLexicalPath(canonicalPath, before, 'FILE', label);
          const content = readDescriptorBytes(descriptor, before.size, maximumBytes, label);
          const after = fstatSync(descriptor, { bigint: true });
          const lexicalAfter = lstatSync(canonicalPath, { bigint: true });
          assertAnchoredDirectoryChainIdentityCurrent(parent, `${label} parent`);
          if (
            !sameBigIntFileObservation(before, after) ||
            !sameBigIntFileObservation(before, lexicalAfter)
          ) {
            throw new Error(
              `${label} changed during its descriptor-anchored read: ${canonicalPath}`,
            );
          }
          return Object.freeze({
            path: canonicalPath,
            content,
            sha256: createHash('sha256').update(content).digest('hex'),
            stat: after,
            generation: anchoredPathGeneration(after),
            parentGenerations: frozenParentGenerations(parent),
          });
        },
        () => closeSync(descriptor),
      );
    },
    () => closeAnchoredDirectoryChain(parent),
  );
}

export function sameStableParentIdentities(
  left: StableRegularFileObservationV1['parentGenerations'],
  right: StableRegularFileObservationV1['parentGenerations'],
): boolean {
  return (
    left.length === right.length &&
    left.every((component, index) => {
      const peer = right[index];
      return (
        peer !== undefined &&
        component.path === peer.path &&
        sameAnchoredDirectoryIdentity(component.generation, peer.generation)
      );
    })
  );
}

export function assertStableRegularFileCurrent(
  expected: StableRegularFileObservationV1,
  maximumBytes: number,
  label: string,
): void {
  runStableCurrentnessCheck('STABLE_REGULAR_FILE_CHANGED', expected.path, label, () => {
    assertCurrentLexicalKind(expected.path, 'FILE', 'STABLE_REGULAR_FILE_CHANGED', label);
    const current = observeStableRegularFile(expected.path, maximumBytes, label);
    if (
      !sameAnchoredPathGeneration(expected.generation, current.generation) ||
      !sameStableParentIdentities(expected.parentGenerations, current.parentGenerations) ||
      expected.sha256 !== current.sha256 ||
      !expected.content.equals(current.content)
    ) {
      throw new AnchoredFilesystemError(
        'STABLE_REGULAR_FILE_CHANGED',
        `${label} generation or bytes changed: ${expected.path}`,
        expected.path,
      );
    }
  });
}

function decodeDirectoryEntryName(name: Buffer, label: string): string {
  try {
    return fatalUtf8Decoder.decode(name);
  } catch {
    throw new Error(`${label} contains a non-UTF-8 entry name`);
  }
}

function stableDirectoryEntryKind(entry: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): StableDirectoryEntryV1['kind'] {
  if (entry.isFile() && !entry.isSymbolicLink()) return 'FILE';
  if (entry.isDirectory() && !entry.isSymbolicLink()) return 'DIRECTORY';
  throw new Error('stable directory contains a symlink or unsupported filesystem object');
}

export function observeStableDirectory(
  directoryPath: string,
  label: string,
  includeEntries: boolean,
): StableDirectoryObservationV1 {
  const chain = openAnchoredDirectoryChain(directoryPath, label);
  return runWithAnchoredCleanup(
    `${label} directory observation`,
    () => {
      const before = fstatSync(chain.descriptor, { bigint: true });
      const entries = includeEntries
        ? readdirSync(`/proc/self/fd/${String(chain.descriptor)}`, {
            encoding: 'buffer',
            withFileTypes: true,
          })
            .map((entry) =>
              Object.freeze({
                name: decodeDirectoryEntryName(entry.name, label),
                kind: stableDirectoryEntryKind(entry),
              }),
            )
            .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
        : null;
      const after = fstatSync(chain.descriptor, { bigint: true });
      assertAnchoredDirectoryChainIdentityCurrent(chain, label);
      const sameDirectory = includeEntries
        ? sameBigIntFileObservation(before, after)
        : sameAnchoredDirectoryIdentity(
            anchoredPathGeneration(before),
            anchoredPathGeneration(after),
          );
      if (!sameDirectory) {
        throw new Error(`${label} changed while its directory entries were observed`);
      }
      return Object.freeze({
        path: chain.path,
        stat: after,
        generation: anchoredPathGeneration(after),
        parentGenerations: frozenParentGenerations(chain),
        entries: entries === null ? null : Object.freeze(entries),
      });
    },
    () => closeAnchoredDirectoryChain(chain),
  );
}

export function assertStableDirectoryCurrent(
  expected: StableDirectoryObservationV1,
  label: string,
): void {
  runStableCurrentnessCheck('STABLE_DIRECTORY_CHANGED', expected.path, label, () => {
    assertCurrentLexicalKind(expected.path, 'DIRECTORY', 'STABLE_DIRECTORY_CHANGED', label);
    const current = observeStableDirectory(expected.path, label, expected.entries !== null);
    const sameDirectory =
      expected.entries === null
        ? sameAnchoredDirectoryIdentity(expected.generation, current.generation)
        : sameAnchoredPathGeneration(expected.generation, current.generation);
    if (
      !sameDirectory ||
      !sameStableParentIdentities(expected.parentGenerations, current.parentGenerations) ||
      JSON.stringify(expected.entries) !== JSON.stringify(current.entries)
    ) {
      throw new AnchoredFilesystemError(
        'STABLE_DIRECTORY_CHANGED',
        `${label}: directory generation changed or entry set changed: ${expected.path}`,
        expected.path,
      );
    }
  });
}

/**
 * Seals directory content generation without enumerating every child. This is
 * suitable for coalescing many negative child lookups under one parent; unlike
 * descriptor-chain identity, a child create/remove must invalidate it.
 */
export function assertStableDirectoryContentGenerationCurrent(
  expected: StableDirectoryObservationV1,
  label: string,
): void {
  runStableCurrentnessCheck('STABLE_DIRECTORY_CONTENT_CHANGED', expected.path, label, () => {
    assertCurrentLexicalKind(expected.path, 'DIRECTORY', 'STABLE_DIRECTORY_CONTENT_CHANGED', label);
    const current = observeStableDirectory(expected.path, label, false);
    if (
      !sameAnchoredPathGeneration(expected.generation, current.generation) ||
      !sameStableParentIdentities(expected.parentGenerations, current.parentGenerations)
    ) {
      throw new AnchoredFilesystemError(
        'STABLE_DIRECTORY_CONTENT_CHANGED',
        `${label}: directory content generation changed: ${expected.path}`,
        expected.path,
      );
    }
  });
}

export function observeAnchoredPathKind(path: string, label: string): AnchoredPathKindV1 {
  const canonicalPath = requireCanonicalAbsolutePath(path, label);
  let parent: AnchoredDirectoryChainV1;
  try {
    parent = openAnchoredDirectoryChain(dirname(canonicalPath), `${label} parent`);
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return 'MISSING';
    throw error;
  }
  return runWithAnchoredCleanup(
    `${label} path-kind observation`,
    () => {
      const descriptorPath = `/proc/self/fd/${String(parent.descriptor)}/${basename(canonicalPath)}`;
      let descriptorStat: BigIntStats;
      let lexicalStat: BigIntStats;
      try {
        descriptorStat = lstatSync(descriptorPath, { bigint: true });
        lexicalStat = lstatSync(canonicalPath, { bigint: true });
      } catch (error) {
        if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') {
          assertAnchoredDirectoryChainIdentityCurrent(parent, `${label} parent`);
          return 'MISSING';
        }
        throw error;
      }
      assertAnchoredDirectoryChainIdentityCurrent(parent, `${label} parent`);
      if (!sameBigIntFileObservation(descriptorStat, lexicalStat)) {
        throw new Error(
          `${label} path generation differs from its parent anchor: ${canonicalPath}`,
        );
      }
      if (descriptorStat.isSymbolicLink()) {
        throw stableCurrentnessError(
          'STABLE_PATH_KIND_CHANGED',
          canonicalPath,
          label,
          new Error('path is symlinked'),
        );
      }
      if (descriptorStat.isFile()) return 'FILE';
      if (descriptorStat.isDirectory()) return 'DIRECTORY';
      throw new Error(`${label} is an unsupported filesystem object: ${canonicalPath}`);
    },
    () => closeAnchoredDirectoryChain(parent),
  );
}

export function observeStablePathKind(path: string, label: string): StablePathKindObservationV1 {
  const canonicalPath = requireCanonicalAbsolutePath(path, label);
  let anchorPath = canonicalPath;
  let parentPath = dirname(anchorPath);
  let parent: StableDirectoryObservationV1;
  for (;;) {
    try {
      parent = observeStableDirectory(parentPath, `${label} parent`, false);
      break;
    } catch (error) {
      if (
        (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'ENOTDIR') ||
        parentPath === parse(parentPath).root
      ) {
        throw error;
      }
      anchorPath = parentPath;
      parentPath = dirname(parentPath);
    }
  }
  const kind = observeAnchoredPathKind(canonicalPath, label);
  const targetGeneration =
    kind === 'MISSING' ? null : anchoredPathGeneration(lstatSync(canonicalPath, { bigint: true }));
  const anchorKind =
    anchorPath === canonicalPath ? kind : observeAnchoredPathKind(anchorPath, `${label} anchor`);
  assertStableDirectoryCurrent(parent, `${label} parent`);
  if (anchorPath === canonicalPath && anchorKind !== kind) {
    throw new Error(`${label} presence changed during its parent entry observation: ${path}`);
  }
  return Object.freeze({
    path: canonicalPath,
    anchorPath,
    anchorKind,
    kind,
    targetGeneration,
    parent,
  });
}

export function assertStablePathKindCurrent(
  expected: StablePathKindObservationV1,
  label: string,
): void {
  assertStableDirectoryCurrent(expected.parent, `${label} parent`);
  const current = observeStablePathKind(expected.path, label);
  if (
    current.anchorPath !== expected.anchorPath ||
    current.anchorKind !== expected.anchorKind ||
    current.kind !== expected.kind ||
    (expected.targetGeneration === null) !== (current.targetGeneration === null) ||
    (expected.targetGeneration !== null &&
      current.targetGeneration !== null &&
      !sameAnchoredPathGeneration(expected.targetGeneration, current.targetGeneration))
  ) {
    throw new AnchoredFilesystemError(
      'STABLE_PATH_KIND_CHANGED',
      `${label} topology changed: generation or presence changed: ${expected.path}`,
      expected.path,
    );
  }
}

export function decodeFatalUtf8(content: Buffer, label: string): string {
  try {
    return fatalUtf8Decoder.decode(content);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function assertTrustedExecutableGeneration(
  generation: AnchoredPathGenerationV1,
  label: string,
): void {
  if (
    generation.ownerUid !== 0n ||
    (generation.mode & 0o022n) !== 0n ||
    generation.linkCount !== 1n ||
    (generation.mode & 0o111n) === 0n
  ) {
    throw new Error(
      `${label} must be root-owned, singly linked, executable, and group/world non-writable`,
    );
  }
}

function assertTrustedExecutableParents(
  parents: StableRegularFileObservationV1['parentGenerations'],
  label: string,
): void {
  for (const parent of parents) {
    if (parent.generation.ownerUid !== 0n || (parent.generation.mode & 0o022n) !== 0n) {
      throw new Error(
        `${label} parent is not root-owned and group/world non-writable: ${parent.path}`,
      );
    }
  }
}

export function openHermeticExecutableAuthority(
  contract: HermeticExecutableContractV1,
  operationDeadlineMs?: number,
): HermeticExecutableAuthorityV1 {
  const canonicalPath = requireCanonicalAbsolutePath(contract.path, `${contract.label} path`);
  const executionPolicy = requireImmutableHermeticExecutableExecutionPolicyV1(
    contract.executionPolicy,
  );
  if (operationDeadlineMs !== undefined && !Number.isFinite(operationDeadlineMs)) {
    throw new TypeError('Hermetic executable operation deadline must be one finite timestamp');
  }
  if (realpathSync(canonicalPath) !== canonicalPath) {
    throw new Error(`${contract.label} path is not canonical: ${canonicalPath}`);
  }
  const parent = openAnchoredDirectoryChain(dirname(canonicalPath), `${contract.label} parent`);
  let descriptor: number | null = null;
  try {
    const descriptorPath = `/proc/self/fd/${String(parent.descriptor)}/${basename(canonicalPath)}`;
    descriptor = openSync(descriptorPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor, { bigint: true });
    assertDescriptorMatchesLexicalPath(canonicalPath, before, 'FILE', contract.label);
    const generation = anchoredPathGeneration(before);
    assertTrustedExecutableGeneration(generation, contract.label);
    const parentGenerations = frozenParentGenerations(parent);
    assertTrustedExecutableParents(parentGenerations, contract.label);
    const content = readDescriptorBytes(
      descriptor,
      before.size,
      contract.maximumBytes,
      contract.label,
    );
    const afterRead = fstatSync(descriptor, { bigint: true });
    if (!sameBigIntFileObservation(before, afterRead)) {
      throw new Error(`${contract.label} changed while its bytes were hashed`);
    }
    const executableDescriptorPath = `/proc/self/fd/${String(descriptor)}`;
    const argv0 = basename(canonicalPath);
    const versionCommandDeadlineMs =
      operationDeadlineMs === undefined
        ? executionPolicy.commandDeadlineMs
        : Math.min(
            executionPolicy.commandDeadlineMs,
            Math.floor(operationDeadlineMs - performance.now()),
          );
    if (versionCommandDeadlineMs < 1) {
      throw new HermeticExecutableExecutionTimeoutError(
        contract.label,
        'VERSION_PROBE',
        1,
        executionPolicy.timeoutSignal,
      );
    }
    const versionResult = spawnSync(executableDescriptorPath, [...contract.versionArgs], {
      argv0,
      encoding: 'utf8',
      env: contract.versionEnvironment,
      maxBuffer: contract.maximumVersionBytes,
      timeout: versionCommandDeadlineMs,
      killSignal: executionPolicy.timeoutSignal,
    });
    if (errorCode(versionResult.error) === 'ETIMEDOUT') {
      throw new HermeticExecutableExecutionTimeoutError(
        contract.label,
        'VERSION_PROBE',
        versionCommandDeadlineMs,
        executionPolicy.timeoutSignal,
      );
    }
    if (
      operationDeadlineMs !== undefined &&
      Math.floor(operationDeadlineMs - performance.now()) < 1
    ) {
      throw new HermeticExecutableExecutionTimeoutError(
        contract.label,
        'VERSION_PROBE',
        versionCommandDeadlineMs,
        executionPolicy.timeoutSignal,
      );
    }
    if (
      versionResult.error !== undefined ||
      versionResult.signal !== null ||
      versionResult.status !== 0
    ) {
      throw new Error(
        `${contract.label} version probe failed: ${versionResult.stderr.trim() || String(versionResult.error ?? versionResult.signal)}`,
      );
    }
    if (Buffer.byteLength(versionResult.stdout, 'utf8') > contract.maximumVersionBytes) {
      throw new Error(`${contract.label} version output exceeded its bounded contract`);
    }
    const attestation = Object.freeze({
      binaryPath: canonicalPath,
      binarySha256: createHash('sha256').update(content).digest('hex'),
      version: versionResult.stdout.trim(),
      generation,
    });
    const retainedDescriptor = descriptor;
    let closed = false;
    const assertCurrent = (): void => {
      if (closed) throw new Error(`${contract.label} authority is closed`);
      assertAnchoredDirectoryChainIdentityCurrent(parent, `${contract.label} parent`);
      const currentDescriptor = fstatSync(retainedDescriptor, { bigint: true });
      const lexical = lstatSync(canonicalPath, { bigint: true });
      if (
        !currentDescriptor.isFile() ||
        currentDescriptor.isSymbolicLink() ||
        !lexical.isFile() ||
        lexical.isSymbolicLink() ||
        !sameAnchoredPathGeneration(generation, anchoredPathGeneration(currentDescriptor)) ||
        !sameAnchoredPathGeneration(generation, anchoredPathGeneration(lexical))
      ) {
        throw new Error(`${contract.label} differs from its descriptor-bound attestation`);
      }
    };
    const authority = Object.freeze({
      attestation,
      descriptorPath: `/proc/self/fd/${String(retainedDescriptor)}`,
      argv0,
      assertCurrent,
      close: (): void => {
        if (closed) throw new Error(`${contract.label} authority is already closed`);
        closed = true;
        const failures: Error[] = [];
        try {
          closeSync(retainedDescriptor);
        } catch (error) {
          failures.push(cleanupFailure(`${contract.label} descriptor close failed`, error));
        }
        try {
          closeAnchoredDirectoryChain(parent);
        } catch (error) {
          failures.push(cleanupFailure(`${contract.label} parent close failed`, error));
        }
        const [onlyFailure] = failures;
        if (failures.length === 1 && onlyFailure !== undefined) throw onlyFailure;
        if (failures.length > 1) {
          throw new AggregateError(failures, `${contract.label} authority cleanup failed`);
        }
      },
    });
    assertCurrent();
    descriptor = null;
    return authority;
  } catch (error) {
    const cleanupFailures: Error[] = [];
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch (closeError) {
        cleanupFailures.push(
          cleanupFailure(`${contract.label} descriptor cleanup failed`, closeError),
        );
      }
    }
    try {
      closeAnchoredDirectoryChain(parent);
    } catch (closeError) {
      cleanupFailures.push(cleanupFailure(`${contract.label} parent cleanup failed`, closeError));
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [
          cleanupFailure(`${contract.label} authority construction failed`, error),
          ...cleanupFailures,
        ],
        `${contract.label} authority construction and cleanup both failed`,
      );
    }
    throw error;
  }
}
