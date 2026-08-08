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
import { lstat, open, readlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { type Readable } from 'node:stream';
import { TextDecoder } from 'node:util';

import {
  assertStableDirectoryCurrent,
  assertStableRegularFileCurrent,
  decodeFatalUtf8,
  openHermeticExecutableAuthority,
  observeStableDirectory,
  observeStableRegularFile,
  sameBigIntFileObservation,
  type HermeticExecutableAuthorityV1,
  type StableDirectoryObservationV1,
  type StableRegularFileObservationV1,
} from './anchored-filesystem';

export { sameBigIntFileObservation } from './anchored-filesystem';

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
      | 'INVENTORY_RUNNER_PROFILE_INVALID'
      | 'ORIGIN_MAIN_MOVED'
      | 'WORKTREE_AUTHORITY_MIGRATION_REQUIRED',
    message: string,
  ) {
    super(message);
    this.name = 'InventoryInspectionError';
  }
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

function attestGitBinary(): {
  readonly executable: HermeticExecutableAuthorityV1;
  readonly attestation: HermeticGitAttestation;
} {
  const executable = openHermeticExecutableAuthority({
    path: GIT_BINARY_PATH,
    label: 'Hermetic Git binary',
    versionArgs: ['--version'],
    versionEnvironment: HERMETIC_GIT_ENV,
    maximumBytes: MAX_GIT_BINARY_BYTES,
    maximumVersionBytes: MAX_BOUNDED_TEXT_BYTES,
  });
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

let gitBinaryAuthority: ReturnType<typeof attestGitBinary> | undefined;

function resolveGitBinaryAuthority(): ReturnType<typeof attestGitBinary> {
  gitBinaryAuthority ??= attestGitBinary();
  return gitBinaryAuthority;
}

function assertGitBinaryCurrent(): void {
  const authority = resolveGitBinaryAuthority();
  authority.executable.assertCurrent();
}

function invocationArgs(worktreePath: string, args: readonly string[]): string[] {
  validateGitArgs(args);
  return [...GIT_INVOCATION_PREFIX, '-C', requireAbsoluteWorktreePath(worktreePath), ...args];
}

export const HERMETIC_GIT_RUNTIME = Object.freeze({
  get attestation(): HermeticGitAttestation {
    return resolveGitBinaryAuthority().attestation;
  },

  runBuffer(
    worktreePath: string,
    args: readonly string[],
    acceptedStatuses: readonly number[] = [0],
    input?: string | Buffer,
    maxBuffer = DEFAULT_MAX_OUTPUT_BYTES,
  ): HermeticGitBufferResult {
    assertGitBinaryCurrent();
    const executable = resolveGitBinaryAuthority().executable;
    const result = spawnSync(executable.descriptorPath, invocationArgs(worktreePath, args), {
      argv0: executable.argv0,
      env: HERMETIC_GIT_ENV,
      input,
      maxBuffer,
    });
    assertGitBinaryCurrent();
    if (result.error) {
      throw result.error;
    }
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
    return Object.freeze({
      stdout: Buffer.from(result.stdout),
      stderr: Buffer.from(result.stderr),
      status: result.status,
    });
  },

  runText(
    worktreePath: string,
    args: readonly string[],
    acceptedStatuses: readonly number[] = [0],
    maxBuffer = DEFAULT_MAX_OUTPUT_BYTES,
  ): HermeticGitTextResult {
    const result = this.runBuffer(worktreePath, args, acceptedStatuses, undefined, maxBuffer);
    return Object.freeze({
      stdout: decodeFatalUtf8(result.stdout, 'Hermetic Git stdout'),
      stderr: decodeFatalUtf8(result.stderr, 'Hermetic Git stderr'),
      status: result.status,
    });
  },

  async consumeStdout(
    worktreePath: string,
    args: readonly string[],
    consumeChunk: (chunk: Buffer) => Promise<void> | void,
    acceptedStatuses: readonly number[] = [0],
  ): Promise<number> {
    assertGitBinaryCurrent();
    const executable = resolveGitBinaryAuthority().executable;
    const child = spawn(executable.descriptorPath, invocationArgs(worktreePath, args), {
      argv0: executable.argv0,
      env: HERMETIC_GIT_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const completion = new Promise<{
      readonly status: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => resolve({ status, signal }));
    });
    if (child.stderr === null || child.stdout === null) {
      child.kill('SIGTERM');
      throw new Error('Hermetic Git child did not expose its stdout/stderr streams');
    }
    const stderrPromise = collectBoundedStderr(child.stderr).then(
      (value) => Object.freeze({ ok: true as const, value }),
      (error: unknown) => Object.freeze({ ok: false as const, error }),
    );
    try {
      for await (const chunk of child.stdout) {
        await consumeChunk(bufferFromUnknownChunk(chunk));
      }
      const [result, stderrResult] = await Promise.all([completion, stderrPromise]);
      if (!stderrResult.ok) throw stderrResult.error;
      const stderr = stderrResult.value;
      assertGitBinaryCurrent();
      if (result.status === null || !acceptedStatuses.includes(result.status)) {
        throw new Error(
          `${formatGitFailure(args, worktreePath, result.status, stderr)}${
            result.signal ? ` (${result.signal})` : ''
          }`,
        );
      }
      return result.status;
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
      await Promise.allSettled([completion, stderrPromise]);
      throw error;
    }
  },
});

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
  await HERMETIC_GIT_RUNTIME.consumeStdout(worktreePath, args, (chunk) => {
    byteLength += BigInt(chunk.length);
    digest.update(chunk);
  });
  return Object.freeze({ byteLength, sha256: digest.digest('hex') });
}

async function readBoundedGitText(args: readonly string[], worktreePath: string): Promise<string> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  await HERMETIC_GIT_RUNTIME.consumeStdout(worktreePath, args, (chunk) => {
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
  await HERMETIC_GIT_RUNTIME.consumeStdout(worktreePath, args, async (chunk) => {
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

function readStableRegularFile(path: string, maximumBytes: number, label: string): Buffer {
  return readStableRegularFileObservation(path, maximumBytes, label).content;
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

function assertHermeticRepositoryConfig(rawConfigList: Buffer): void {
  const records = splitNulRecords(rawConfigList, 'repository config');
  for (const record of records) {
    const separator = record.indexOf(0x0a);
    if (separator <= 0) {
      throw new Error('Hermetic Git repository config contains a malformed entry');
    }
    const key = record.subarray(0, separator).toString('ascii').toLowerCase();
    const value = decodeFatalUtf8(
      record.subarray(separator + 1),
      `Hermetic Git repository config ${key}`,
    );
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(key)) {
      throw new Error(`Hermetic Git repository config key is invalid: ${JSON.stringify(key)}`);
    }
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

function observeOptionalTopologyFile(path: string, label: string): OptionalTopologyFileObservation {
  const parent = observeDirectory(dirname(path), `${label} parent`, true);
  let file: StableRegularFileObservation | null;
  try {
    file = readStableRegularFileObservation(path, MAX_REPOSITORY_CONFIG_BYTES, label);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    file = null;
  }
  assertDirectoryObservationCurrent(parent, `${label} parent`);
  const entry = parent.entries?.find(
    (candidate) => candidate.name === path.slice(dirname(path).length + 1),
  );
  if ((file === null) !== (entry === undefined)) {
    throw new InventoryInspectionError(
      'DIRTY_SNAPSHOT_MOVED',
      `${label} presence changed during its parent entry-generation observation: ${path}`,
    );
  }
  if (entry !== undefined && entry.kind !== 'FILE') {
    throw new Error(`${label} is not one regular file: ${path}`);
  }
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

function optionalTopologyContent(observation: OptionalTopologyFileObservation): Buffer | null {
  return observation.file?.content ?? null;
}

function optionalTopologySubstrateIdentity(observation: OptionalTopologyFileObservation): Buffer {
  return observation.file === null
    ? Buffer.concat([Buffer.from('ABSENT\0', 'ascii'), observation.parent.identity])
    : regularFileIdentity(observation.file);
}

async function attestRepositoryConfiguration(
  worktreePath: string,
  observer: CanonicalGitWorktreeEvidenceObserver = {},
): Promise<RepositoryConfigurationEvidence> {
  const commonDirPath = realpathSync(
    (
      await readBoundedGitText(
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        worktreePath,
      )
    ).trim(),
  );
  const gitDirPath = realpathSync(
    (
      await readBoundedGitText(['rev-parse', '--path-format=absolute', '--git-dir'], worktreePath)
    ).trim(),
  );
  const objectFormatRaw = (
    await readBoundedGitText(['rev-parse', '--show-object-format'], worktreePath)
  ).trim();
  if (objectFormatRaw !== 'sha1') {
    throw new Error(
      `Hermetic Git currently governs only repository-format-0 SHA-1 object stores; received ${objectFormatRaw}`,
    );
  }
  const objectFormat: GitObjectFormat = 'sha1';
  const commonDir = observeDirectory(commonDirPath, 'Git common-dir');
  const gitDir = observeDirectory(gitDirPath, 'Git directory');
  const worktree = observeDirectory(worktreePath, 'Git worktree');
  const dotGitPath = join(worktreePath, '.git');
  const dotGitStat = lstatSync(dotGitPath, { bigint: true });
  let dotGitIdentity: Buffer;
  let dotGitRedirect: StableRegularFileObservation | null = null;
  let dotGitDirectory: StableDirectoryObservation | null = null;
  let commonDirRedirect: OptionalTopologyFileObservation;
  let gitDirBacklink: OptionalTopologyFileObservation;
  if (dotGitStat.isFile() && !dotGitStat.isSymbolicLink()) {
    dotGitRedirect = readStableRegularFileObservation(
      dotGitPath,
      MAX_REPOSITORY_CONFIG_BYTES,
      '.git redirect',
    );
    const redirectMatch = /^gitdir: (?<path>[^\0\r\n]+)\n$/.exec(
      decodeUtf8(dotGitRedirect.content, '.git redirect'),
    );
    const redirectPath = redirectMatch?.groups?.path;
    if (
      redirectPath === undefined ||
      realpathSync(resolve(worktreePath, redirectPath)) !== gitDirPath
    ) {
      throw new Error(
        `.git redirect does not resolve to the attested Git directory: ${dotGitPath}`,
      );
    }
    if (gitDirPath === commonDirPath || dirname(gitDirPath) !== join(commonDirPath, 'worktrees')) {
      throw new Error(`linked .git redirect is outside the attested common-dir worktrees registry`);
    }
    const commonDirRedirectPath = join(gitDirPath, 'commondir');
    commonDirRedirect = observeOptionalTopologyFile(
      commonDirRedirectPath,
      'linked-worktree commondir redirect',
    );
    if (commonDirRedirect.file === null) {
      throw new Error('linked-worktree commondir redirect is absent');
    }
    if (
      realpathSync(
        resolve(
          gitDirPath,
          decodeGitMetadataPath(
            commonDirRedirect.file.content,
            'linked-worktree commondir redirect',
          ),
        ),
      ) !== commonDirPath
    ) {
      throw new Error(`linked-worktree commondir redirect does not resolve to ${commonDirPath}`);
    }
    const gitDirBacklinkPath = join(gitDirPath, 'gitdir');
    gitDirBacklink = observeOptionalTopologyFile(
      gitDirBacklinkPath,
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
    const backlinkStat = lstatSync(backlinkTarget, { bigint: true });
    if (!sameBigIntFileObservation(dotGitRedirect.stat, backlinkStat)) {
      throw new Error('linked-worktree gitdir backlink reached another .git redirect generation');
    }
    dotGitIdentity = regularFileIdentity(dotGitRedirect);
  } else if (dotGitStat.isDirectory() && !dotGitStat.isSymbolicLink()) {
    if (realpathSync(dotGitPath) !== gitDirPath) {
      throw new Error(`.git directory differs from the attested Git directory: ${dotGitPath}`);
    }
    if (gitDirPath !== commonDirPath) {
      throw new Error('directory-form .git must be the repository common-dir');
    }
    dotGitDirectory = observeDirectory(dotGitPath, '.git directory');
    dotGitIdentity = dotGitDirectory.identity;
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
  } else {
    throw new Error(`Hermetic Git refuses an unsupported .git redirect: ${dotGitPath}`);
  }

  const configPath = join(commonDirPath, 'config');
  const configObservation = readStableRegularFileObservation(
    configPath,
    MAX_REPOSITORY_CONFIG_BYTES,
    'repository config',
  );
  const parsedConfig = HERMETIC_GIT_RUNTIME.runBuffer(
    worktreePath,
    ['config', '--file', configPath, '--no-includes', '--null', '--list'],
    [0],
    undefined,
    MAX_REPOSITORY_CONFIG_BYTES,
  ).stdout;
  assertHermeticRepositoryConfig(parsedConfig);
  assertStableRegularFileObservationCurrent(
    configObservation,
    MAX_REPOSITORY_CONFIG_BYTES,
    'repository config',
  );

  const alternatesObservation = observeOptionalTopologyFile(
    join(commonDirPath, 'objects', 'info', 'alternates'),
    'Git object alternates',
  );
  const alternates = optionalTopologyContent(alternatesObservation);
  if (alternates !== null && decodeUtf8(alternates, 'Git object alternates').trim().length > 0) {
    throw new Error('Hermetic Git refuses common-dir object alternates');
  }
  const shallowObservation = observeOptionalTopologyFile(
    join(commonDirPath, 'shallow'),
    'Git shallow boundary',
  );
  const shallow = optionalTopologyContent(shallowObservation);
  if (shallow !== null && decodeUtf8(shallow, 'Git shallow boundary').trim().length > 0) {
    throw new Error('Hermetic Git refuses a shallow repository boundary');
  }
  const graftsObservation = observeOptionalTopologyFile(
    join(commonDirPath, 'info', 'grafts'),
    'Git graft authority',
  );
  const grafts = optionalTopologyContent(graftsObservation);
  if (grafts !== null && decodeUtf8(grafts, 'Git graft authority').trim().length > 0) {
    throw new Error('Hermetic Git refuses common-dir grafts');
  }
  const worktreeConfigObservation = observeOptionalTopologyFile(
    join(gitDirPath, 'config.worktree'),
    'Git worktree config',
  );
  const worktreeConfig = optionalTopologyContent(worktreeConfigObservation);
  if (worktreeConfig !== null && worktreeConfig.length > 0) {
    throw new Error('Hermetic Git refuses per-worktree config authority');
  }
  const replaceRefs = HERMETIC_GIT_RUNTIME.runText(worktreePath, [
    'for-each-ref',
    '--format=%(refname)',
    'refs/replace',
  ]).stdout.trim();
  if (replaceRefs.length > 0) {
    throw new Error('Hermetic Git refuses replace refs');
  }

  if (observer.afterRepositoryTopologyRead) {
    await observer.afterRepositoryTopologyRead(worktreePath);
  }
  assertDirectoryObservationCurrent(worktree, 'Git worktree');
  assertDirectoryObservationCurrent(gitDir, 'Git directory');
  assertDirectoryObservationCurrent(commonDir, 'Git common-dir');
  if (dotGitRedirect !== null) {
    assertStableRegularFileObservationCurrent(
      dotGitRedirect,
      MAX_REPOSITORY_CONFIG_BYTES,
      '.git redirect',
    );
  } else if (dotGitDirectory !== null) {
    assertDirectoryObservationCurrent(dotGitDirectory, '.git directory');
  } else {
    throw new Error('repository topology lost its .git authority observation');
  }
  assertOptionalTopologyFileCurrent(commonDirRedirect);
  assertOptionalTopologyFileCurrent(gitDirBacklink);
  assertStableRegularFileObservationCurrent(
    configObservation,
    MAX_REPOSITORY_CONFIG_BYTES,
    'repository config',
  );
  assertOptionalTopologyFileCurrent(alternatesObservation);
  assertOptionalTopologyFileCurrent(shallowObservation);
  assertOptionalTopologyFileCurrent(graftsObservation);
  assertOptionalTopologyFileCurrent(worktreeConfigObservation);
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
      `${worktreePath} repository topology changed during its atomic observation`,
    );
  }

  const substrateDigest = createHash('sha256');
  let substrateByteLength = 0n;
  for (const [label, payload] of [
    ['WORKTREE_IDENTITY', directoryAnchorIdentity(worktree)],
    ['DOT_GIT_IDENTITY', dotGitIdentity],
    ['GIT_DIR_IDENTITY', gitDir.identity],
    ['COMMON_DIR_IDENTITY', commonDir.identity],
    ['COMMON_DIR_REDIRECT_IDENTITY', optionalTopologySubstrateIdentity(commonDirRedirect)],
    ['GIT_DIR_BACKLINK_IDENTITY', optionalTopologySubstrateIdentity(gitDirBacklink)],
    ['CONFIG_IDENTITY', regularFileIdentity(configObservation)],
    ['ALTERNATES_IDENTITY', optionalTopologySubstrateIdentity(alternatesObservation)],
    ['SHALLOW_IDENTITY', optionalTopologySubstrateIdentity(shallowObservation)],
    ['GRAFTS_IDENTITY', optionalTopologySubstrateIdentity(graftsObservation)],
    ['WORKTREE_CONFIG_IDENTITY', optionalTopologySubstrateIdentity(worktreeConfigObservation)],
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
  // commands; behavior-changing includes, filters, alternates, sparse/worktree config, and
  // partial-clone authorities are rejected before this projection is built.
  for (const [label, payload] of [['OBJECT_FORMAT', Buffer.from(objectFormat, 'ascii')]] as const) {
    updateDigestFrame(contentDigest, label, payload);
    contentByteLength += BigInt(payload.length);
  }
  contentByteLength += updateConfigurationDigestFile(contentDigest, 'ALTERNATES', alternates);
  contentByteLength += updateConfigurationDigestFile(contentDigest, 'SHALLOW', shallow);
  contentByteLength += updateConfigurationDigestFile(contentDigest, 'GRAFTS', grafts);
  contentByteLength += updateConfigurationDigestFile(
    contentDigest,
    'WORKTREE_CONFIG',
    worktreeConfig,
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

function loadGitBlobProofBatch(
  worktreePath: string,
  objectFormat: GitObjectFormat,
  proofs: Map<string, GitBlobProof>,
  objectIds: readonly string[],
): void {
  if (objectIds.length === 0) {
    return;
  }
  const output = HERMETIC_GIT_RUNTIME.runBuffer(
    worktreePath,
    ['cat-file', '--batch'],
    [0],
    `${objectIds.join('\n')}\n`,
    MAX_GIT_BLOB_BATCH_BYTES,
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

function loadGitBlobProofs(
  worktreePath: string,
  configuration: RepositoryConfigurationEvidence,
  entries: readonly TrackedEntry[],
): ReadonlyMap<string, GitBlobProof> {
  const objectIds = [...new Set(entries.map((entry) => entry.objectId))];
  const proofs = new Map<string, GitBlobProof>();
  for (let offset = 0; offset < objectIds.length; offset += GIT_BLOB_BATCH_SIZE) {
    loadGitBlobProofBatch(
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

function closePinnedWorktreePath(path: PinnedWorktreePath): void {
  for (const descriptor of [...path.directoryDescriptors].reverse()) {
    closeSync(descriptor);
  }
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
  let currentDescriptor = openSync(
    worktreePath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  descriptors.push(currentDescriptor);
  try {
    const rootDescriptor = fstatSync(currentDescriptor, { bigint: true });
    if (!rootDescriptor.isDirectory() || !sameBigIntFileObservation(rootBefore, rootDescriptor)) {
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
          for (const descriptor of [...descriptors].reverse()) {
            closeSync(descriptor);
          }
          return Object.freeze({ kind: 'MISSING', parentObservation });
        }
        if (errorCode(error) === 'ELOOP' || errorCode(error) === 'ENOTDIR') {
          throw new InventoryInspectionError(
            'DIRTY_SNAPSHOT_MOVED',
            `${worktreePath}/${relativePath.toString('utf8')} parent changed into a symlink or non-directory`,
          );
        }
        throw error;
      }
      const parentStat = fstatSync(nextDescriptor, { bigint: true });
      if (!parentStat.isDirectory()) {
        closeSync(nextDescriptor);
        throw new Error(
          `${worktreePath}/${relativePath.toString('utf8')} traverses a non-directory parent`,
        );
      }
      descriptors.push(nextDescriptor);
      currentDescriptor = nextDescriptor;
      currentLexicalPath = join(currentLexicalPath, decodedPath.split('/')[index] ?? '');
    }
    return Object.freeze({
      kind: 'TARGET',
      descriptorPath: Buffer.concat([
        Buffer.from(`/proc/self/fd/${String(currentDescriptor)}/`, 'ascii'),
        finalComponent,
      ]),
      directoryDescriptors: Object.freeze(descriptors),
      targetParentPath: currentLexicalPath,
      targetParentGeneration: fstatSync(currentDescriptor, { bigint: true }),
    });
  } catch (error) {
    for (const descriptor of [...descriptors].reverse()) {
      closeSync(descriptor);
    }
    throw error;
  }
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
    try {
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
          continue;
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
    } finally {
      closePinnedWorktreePath(pinnedPath);
    }
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

export async function captureCanonicalGitWorktreeStatus(
  worktreePath: string,
  observer: CanonicalGitWorktreeEvidenceObserver = {},
): Promise<CanonicalGitWorktreeStatus> {
  const absoluteWorktreePath = requireAbsoluteWorktreePath(worktreePath);
  const startHead = (
    await readBoundedGitText(['rev-parse', '--verify', 'HEAD^{commit}'], absoluteWorktreePath)
  ).trim();
  if (!SHA_PATTERN.test(startHead)) {
    throw new Error(`${absoluteWorktreePath}.HEAD is not one commit object ID`);
  }
  const configurationStart = await attestRepositoryConfiguration(absoluteWorktreePath, observer);
  const headTreeRaw = HERMETIC_GIT_RUNTIME.runBuffer(
    absoluteWorktreePath,
    CANONICAL_GIT_HEAD_TREE_ARGS,
  ).stdout;
  const indexRaw = HERMETIC_GIT_RUNTIME.runBuffer(
    absoluteWorktreePath,
    CANONICAL_GIT_INDEX_ARGS,
  ).stdout;
  const fsmonitorIndexRaw = HERMETIC_GIT_RUNTIME.runBuffer(
    absoluteWorktreePath,
    CANONICAL_GIT_INDEX_FSMONITOR_ARGS,
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
  const blobProofs = loadGitBlobProofs(absoluteWorktreePath, configurationStart, [
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
  const configurationEnd = await attestRepositoryConfiguration(absoluteWorktreePath, observer);
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
): Promise<RawContentFingerprint> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
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
  } finally {
    await handle.close();
  }
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
  const authorityRaw = HERMETIC_GIT_RUNTIME.runBuffer(
    worktreePath,
    CANONICAL_GIT_UNTRACKED_GITIGNORE_ARGS,
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
    try {
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
    } finally {
      closePinnedWorktreePath(pinnedPath);
    }
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
  for (const authorityPath of [...remainingGitignoreAuthorities.values()].sort(Buffer.compare)) {
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
  const start = await captureCanonicalGitWorktreeStatus(absoluteWorktreePath, observer);
  const primaryHash = await hashCanonicalWorktreeEvidence(absoluteWorktreePath, start);
  const contentSha256 = primaryHash.contentSha256;
  const substrateAttestationSha256 = finalSubstrateAttestationSha256(
    start,
    primaryHash.untrackedSubstrate,
  );
  if (observer.beforeSnapshotVerification) {
    await observer.beforeSnapshotVerification();
  }
  const verificationStart = await captureCanonicalGitWorktreeStatus(absoluteWorktreePath, observer);
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
  const verificationEnd = await captureCanonicalGitWorktreeStatus(absoluteWorktreePath, observer);
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
}
