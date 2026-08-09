#!/usr/bin/env ts-node
/**
 * finding-registry — CLI for the Phase 6 append-only registry at
 * docs/reviews/_registry/findings.jsonl.
 *
 * Phase 2 deliverable per
 * docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#Phase-2.
 *
 * Subcommands:
 *   verify               — re-compute the hash chain, assert every
 *                           prev_hash + content_hash is intact. Matches
 *                           tests/invariants/finding-registry-integrity
 *                           .spec.ts algorithm exactly — a CI gate and
 *                           a local smoke check in one CLI.
 *   add <domain> <json-path>
 *                         — protected-workflow entry point that allocates a
 *                           domain-wide monotonic id and appends one finding.
 *                           The caller supplies only caller-owned fields; the
 *                           authority fills id / state / timestamps / hashes.
 *   close <id> <sha>     — mutate a finding to state=RESOLVED, set
 *                           closed_at, and APPEND the full protected-main SHA to
 *                           closing_commits[]. The SHA must be
 *                           reachable from origin/main and its commit
 *                           message must carry a matching Closes:
 *                           trailer. Because the registry is
 *                           hash-chained, every entry FROM the mutated
 *                           position onward must have its chain
 *                           re-stitched (prev_hash preserved,
 *                           content_hash recomputed).
 *   export <format>      — dump alternate representations (json-array,
 *                           csv) for dashboards / reporting.
 *
 * Design notes:
 *   * `add`, `close`, and non-dry-run `sweep` fail closed without an
 *     operation-scoped, protected-main GitHub Actions OIDC authority. The CLI
 *     surface is an internal workflow adapter, not an independent local writer.
 *   * Registry mutation preserves append-only SEMANTICS for OPEN/
 *     IN-PROGRESS additions (new entry at tail). `close` is the one
 *     mutation that legitimately modifies a past entry — the state
 *     transition contract in CLAUDE.md "Review Finding Traceability"
 *     REQUIRES closing_commits[] population, which cannot be written
 *     before the fix commit SHA exists. An alternative "close-event"
 *     record (state-machine replay) is Phase 12 territory; the CLI
 *     here matches the jsonl shape the invariant test already expects.
 *   * `close` re-seeds only the closed entry + subsequent entries
 *     (prev_hash pointers from later entries still point to the
 *     closed entry's OLD content_hash; they must be updated to the
 *     NEW content_hash). Validated end-to-end by running `verify`
 *     immediately after a `close`.
 *
 * Exit codes:
 *   0 — OK
 *   1 — integrity failure / missing id / chain break
 *   2 — usage error
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

// The .js extension on the ajv specifier survives both module systems
// (it is a real file in node_modules); ts-jest interop in the Jest
// invariant test omits it.
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { ariaAuthorityFilesAtRevision } from './aria-authority-hash';
// PROC-HIGH-001 structural guard — close ceremony refuses branch-local
// SHAs (see cmdClose). The shared SSOT helper is import-safe for
// node:test specs, which use the same extensionless CJS specifier.
import { findNonCanonicalFindingEvidence } from './finding-evidence-shape';
import {
  atomicWriteFindingReservationFile,
  atomicWriteRegistryFile,
  FINDING_WRITER_REGISTRY_LOCK_POLICY_V1,
  listAtomicWriteStagingFiles,
  nextFindingId,
  orphanMarkdownReservedIdsFromText,
  recoverGovernedFindingStagingFiles,
  RegistryLockError,
  withFindingWriterKernelLockAsync,
  type RegistryLockLease,
} from './finding-registry-store';
import { commitHasFindingCloseTrailer } from './finding-traceability';
import { commitReachableFrom } from './git-reachability';
import {
  acquireRepositoryMutationAuthority,
  type RegistryMutationOperation,
  type RepositoryMutationAuthority,
} from './github-actions-oidc-authority';
import {
  assertStableRegularFileCurrent,
  decodeFatalUtf8,
  observeStablePathKind,
  observeStableRegularFile,
  sameStableParentIdentities,
  type StableRegularFileObservationV1,
} from './lib/anchored-filesystem';
import { FINDING_REGISTRY_RELATIVE_PATH } from './lib/finding-authority-target-catalog';
import {
  deriveRawFindingIdFloors,
  parseFindingRegistrySchemaContract,
} from './lib/finding-registry-schema-contract';
import {
  createFindingWriterRepositorySnapshot,
  FINDING_WRITER_AUTHORITY_PATH,
  FINDING_WRITER_PROTOCOL_ID,
  FINDING_WRITER_RETIRED_MUTATION_SURFACES,
  type FindingWriterRepositorySnapshot,
  verifyFindingWriterProtocolManifest,
} from './lib/finding-registry-writer-authority';
import {
  admitFindingWriterCliInvocation,
  findingWriterCliOperationNames,
  isFindingWriterRegistryMutationOperation,
} from './lib/finding-writer-cli-contract';
import {
  assertFindingWriterFenceAuthority,
  consumeFindingWriterFenceSnapshot,
  createFindingWriterFenceSnapshot,
  defineFindingWriterWorktreeTopologyV1,
  FindingWriterFenceGenerationMismatchError,
  FindingWriterFenceStaleError,
  isAuthenticFindingWriterFenceStaleError,
  prepareFindingWriterFenceSnapshot,
  readFindingWriterAllocationSnapshot,
  redeemRegistryFindingWriterFence,
  releaseFindingWriterFence,
  type FindingWriterAllocationSnapshot,
  type FindingWriterFenceCapability,
  type FindingWriterAllocationFence,
  type FindingWriterFenceSnapshot,
  type FindingWriterMutationProfile,
  type FindingWriterSourceTransitionV1,
  type FindingWriterWorktreeGeneration,
  type FindingWriterWorktreeTopologyV1,
  type RedeemedFindingWriterFenceCapability,
} from './lib/finding-writer-fence';
import {
  HERMETIC_GIT_RUNTIME,
  runWithHermeticGitExecutionDeadline,
} from './lib/hermetic-git-runtime';
import { parseWorktreeList } from './lib/registered-common-dir-discovery';

export type {
  FindingWriterFenceCapability,
  FindingWriterFenceSnapshot,
  FindingWriterMutationProfile,
  RedeemedFindingWriterFenceCapability,
} from './lib/finding-writer-fence';

// __dirname (CommonJS, per tools/gates/tsconfig.json) — this file
// previously derived REPO_ROOT from import.meta.url, which forced the
// whole CLI through ts-node's ESM loader, made relative TS imports
// unresolvable (ERR_MODULE_NOT_FOUND for both extensionless and .js
// specifiers) and tripped TS1343/TS5097 in the changed-files
// type-check. Every other gate in this directory is CJS; the odd one
// out is now aligned (farm-service-enterprise-guardrails.ts precedent).
const REPO_ROOT = resolve(__dirname, '..', '..');
const REGISTRY_RELATIVE_PATH = FINDING_REGISTRY_RELATIVE_PATH;
const SCHEMA_RELATIVE_PATH = join('docs', 'reviews', '_registry', 'findings.jsonl.schema.json');
const ORPHAN_FINDINGS_MD_RELATIVE_PATH = join('docs', 'reviews', 'orphan-findings.md');
const CAPABILITY_MANIFEST_RELATIVE_PATH = join(
  'docs',
  'plans',
  '2026-06-18-enterprise-grade-debt-closure',
  'manifest.json',
);
const ALLOCATOR_RELATIVE_PATH = join('tools', 'gates', 'finding-registry.ts');
const WRITER_PROTOCOL_MANIFEST_RELATIVE_PATH = FINDING_WRITER_AUTHORITY_PATH;
const REGISTRY_PATH = resolve(REPO_ROOT, REGISTRY_RELATIVE_PATH);
const SCHEMA_PATH = resolve(REPO_ROOT, SCHEMA_RELATIVE_PATH);
const ZERO_HASH = '0'.repeat(64);
const REGISTRY_STAGING_STALE_MS = 5 * 60_000;
const GIT_OUTPUT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

function writeStdoutLine(message = ''): void {
  process.stdout.write(`${message}\n`);
}

function writeStderrLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

function formatUnknownCliValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'symbol') return value.description ?? 'Symbol()';
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
  try {
    return canonicalJson(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function assertFindingWriterObservationNotAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Finding writer observation was aborted');
  Object.defineProperty(error, 'cause', {
    configurable: true,
    enumerable: false,
    value: signal.reason,
    writable: true,
  });
  throw error;
}

function formatCsvValue(value: unknown): string {
  return Array.isArray(value)
    ? value.map((item) => formatUnknownCliValue(item)).join('|')
    : formatUnknownCliValue(value);
}

export interface RegistryPaths {
  readonly registryPath: string;
  readonly schemaPath: string;
}

const DEFAULT_REGISTRY_PATHS: RegistryPaths = {
  registryPath: REGISTRY_PATH,
  schemaPath: SCHEMA_PATH,
};

interface FindingIdReservation {
  readonly sequence: number;
  readonly finding_id: string;
  readonly reserved_at: string;
  readonly registry_path: string;
}

interface FindingIdReservationLedger {
  readonly version: 1;
  readonly domains: Record<string, FindingIdReservation>;
}

export interface FindingAllocationAuthority {
  readonly repoRoot: string;
  readonly lockPath: string;
  readonly reservationPath: string;
  readonly assertCompatibleWriters: (signal: AbortSignal) => Promise<FindingWriterFenceSnapshot>;
  readonly consumeCompatibleWriters: (
    snapshot: FindingWriterFenceSnapshot,
    signal: AbortSignal,
  ) => Promise<FindingWriterFenceCapability>;
  readonly redeemCompatibleWriters: (
    capability: FindingWriterFenceCapability,
    lease: RegistryLockLease,
    profile: FindingWriterMutationProfile,
    signal: AbortSignal,
  ) => Promise<RedeemedFindingWriterFenceCapability>;
  readonly releaseCompatibleWriters: (capability: RedeemedFindingWriterFenceCapability) => void;
  readonly activeRegistryPaths: () => readonly string[];
}

export const FINDING_WRITER_FENCE_ADMISSION_POLICY_V1 = Object.freeze({
  schemaVersion: 1 as const,
  admissionDeadlineMs: 120_000,
});

export class FindingWriterFenceAdmissionDeadlineError extends Error {
  public readonly code = 'FINDING_WRITER_FENCE_ADMISSION_DEADLINE' as const;

  public constructor(
    public readonly admissionDeadlineMs: number,
    public readonly cause: FindingWriterFenceStaleError | undefined,
  ) {
    super(`Finding writer fence admission exceeded its ${String(admissionDeadlineMs)}ms deadline`);
    this.name = 'FindingWriterFenceAdmissionDeadlineError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface PreparedFindingWriterFenceAdmissionV1<TAdmission, TResult> {
  readonly resourcePath: string;
  readonly lockPath: string;
  readonly prepareSnapshot: (
    signal: AbortSignal,
  ) => FindingWriterFenceSnapshot | Promise<FindingWriterFenceSnapshot>;
  readonly admit: (
    snapshot: FindingWriterFenceSnapshot,
    lease: RegistryLockLease,
    signal: AbortSignal,
  ) => TAdmission | Promise<TAdmission>;
  readonly run: (admission: TAdmission, lease: RegistryLockLease) => TResult | Promise<TResult>;
}

class RetryPreparedFindingWriterAdmissionError extends Error {
  public constructor(public readonly staleError: FindingWriterFenceStaleError) {
    super(staleError.message);
    this.name = 'RetryPreparedFindingWriterAdmissionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The sole optimistic admission coordinator for finding mutations. Expensive immutable proof is
 * prepared without the kernel lock. The single-use snapshot is consumed under the lock; only a
 * typed pre-side-effect CONSUME/REDEEM CAS miss may release, rebuild, and retry.
 */
async function runWithPreparedFindingWriterFenceAdmissionDeadline<TAdmission, TResult>(
  request: PreparedFindingWriterFenceAdmissionV1<TAdmission, TResult>,
  admissionDeadlineMs: number,
): Promise<TResult> {
  const deadline = performance.now() + admissionDeadlineMs;
  let lastStaleError: FindingWriterFenceStaleError | undefined;
  const remainingAdmissionMs = (): number => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) {
      throw new FindingWriterFenceAdmissionDeadlineError(admissionDeadlineMs, lastStaleError);
    }
    return remaining;
  };

  const prepareSnapshot = async (): Promise<FindingWriterFenceSnapshot> => {
    const preparationDeadlineMs = remainingAdmissionMs();
    const deadlineFailure = new FindingWriterFenceAdmissionDeadlineError(
      admissionDeadlineMs,
      lastStaleError,
    );
    try {
      const snapshot = await runWithHermeticGitExecutionDeadline(
        preparationDeadlineMs,
        deadlineFailure,
        request.prepareSnapshot,
      );
      remainingAdmissionMs();
      return snapshot;
    } catch (error) {
      if (error === deadlineFailure) throw error;
      remainingAdmissionMs();
      throw error;
    }
  };

  for (;;) {
    remainingAdmissionMs();
    const snapshot = await prepareSnapshot();
    const lockTimeoutMs = Math.min(
      FINDING_WRITER_REGISTRY_LOCK_POLICY_V1.contentionDeadlineMs,
      remainingAdmissionMs(),
    );
    try {
      return await withFindingWriterKernelLockAsync(
        request.resourcePath,
        request.lockPath,
        lockTimeoutMs,
        async (lease) => {
          let admission: TAdmission;
          try {
            const admissionPhaseMs = remainingAdmissionMs();
            const deadlineFailure = new FindingWriterFenceAdmissionDeadlineError(
              admissionDeadlineMs,
              lastStaleError,
            );
            admission = await runWithHermeticGitExecutionDeadline(
              admissionPhaseMs,
              deadlineFailure,
              (signal) => request.admit(snapshot, lease, signal),
            );
            remainingAdmissionMs();
          } catch (error) {
            if (!isAuthenticFindingWriterFenceStaleError(error)) {
              if (error instanceof Error) throw error;
              throw new Error('Finding writer admission threw a non-Error value');
            }
            throw new RetryPreparedFindingWriterAdmissionError(error);
          }
          return request.run(admission, lease);
        },
      );
    } catch (error) {
      if (!(error instanceof RetryPreparedFindingWriterAdmissionError)) throw error;
      lastStaleError = error.staleError;
    }
  }
}

export function runWithPreparedFindingWriterFenceAdmission<TAdmission, TResult>(
  request: PreparedFindingWriterFenceAdmissionV1<TAdmission, TResult>,
): Promise<TResult> {
  return runWithPreparedFindingWriterFenceAdmissionDeadline(
    request,
    FINDING_WRITER_FENCE_ADMISSION_POLICY_V1.admissionDeadlineMs,
  );
}

/** Exact-import test adapter; production callers cannot relax or replace the canonical policy. */
export function testOnlyRunWithPreparedFindingWriterFenceAdmission<TAdmission, TResult>(
  request: PreparedFindingWriterFenceAdmissionV1<TAdmission, TResult>,
  admissionDeadlineMs: number,
): Promise<TResult> {
  if (
    !Number.isSafeInteger(admissionDeadlineMs) ||
    admissionDeadlineMs < 1 ||
    admissionDeadlineMs > FINDING_WRITER_FENCE_ADMISSION_POLICY_V1.admissionDeadlineMs
  ) {
    throw new TypeError(
      `Finding writer test admission deadline must be within 1..${String(FINDING_WRITER_FENCE_ADMISSION_POLICY_V1.admissionDeadlineMs)}ms`,
    );
  }
  return runWithPreparedFindingWriterFenceAdmissionDeadline(request, admissionDeadlineMs);
}

type FindingWriterPinnedAllocationFile = StableRegularFileObservationV1;

const findingWriterAllocationFences = new WeakMap<
  FindingWriterFenceSnapshot,
  FindingWriterAllocationFence
>();

function observeFindingWriterAllocationFile(path: string): FindingWriterPinnedAllocationFile {
  return observeStableRegularFile(
    path,
    GIT_OUTPUT_MAX_BUFFER_BYTES,
    'Finding writer allocation input',
  );
}

function assertFindingWriterAllocationFileCurrent(
  expected: FindingWriterPinnedAllocationFile,
  transitionedSha256?: string,
): void {
  const current = observeFindingWriterAllocationFile(expected.path);
  if (transitionedSha256 !== undefined) {
    if (
      current.sha256 !== transitionedSha256 ||
      !sameStableParentIdentities(expected.parentGenerations, current.parentGenerations)
    ) {
      throw new Error(
        `Finding writer registry transition digest or anchored parent differs: ${expected.path}`,
      );
    }
    return;
  }
  assertStableRegularFileCurrent(
    expected,
    GIT_OUTPUT_MAX_BUFFER_BYTES,
    'Finding writer allocation input',
  );
}

async function assertCommittedRegularFiles(
  worktreePath: string,
  relativePaths: readonly string[],
  headOid: string,
  repositorySnapshot: FindingWriterRepositorySnapshot,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, Buffer>> {
  const normalizedPaths = relativePaths.map((path) => path.replaceAll('\\', '/'));
  if (new Set(normalizedPaths).size !== normalizedPaths.length) {
    throw new Error('Finding writer governed file batch contains duplicate paths');
  }
  let treeOutput: Buffer;
  try {
    treeOutput = (
      await HERMETIC_GIT_RUNTIME.runBufferAsync(
        worktreePath,
        ['ls-tree', '-rz', headOid, '--', ...normalizedPaths],
        [0],
        undefined,
        GIT_OUTPUT_MAX_BUFFER_BYTES,
      )
    ).stdout;
  } catch {
    assertFindingWriterObservationNotAborted(signal);
    throw new Error(`Finding writer governed file batch cannot be read at HEAD: ${worktreePath}`);
  }

  const treeObjects = new Map<string, string>();
  let treeOffset = 0;
  while (treeOffset < treeOutput.length) {
    const terminator = treeOutput.indexOf(0, treeOffset);
    if (terminator === -1) {
      throw new Error('Finding writer HEAD tree batch has a truncated record');
    }
    const record = treeOutput.subarray(treeOffset, terminator);
    const separator = record.indexOf(0x09);
    const metadataBytes = separator === -1 ? Buffer.alloc(0) : record.subarray(0, separator);
    if ([...metadataBytes].some((byte) => byte > 0x7f)) {
      throw new Error('Finding writer HEAD tree batch metadata is not ASCII');
    }
    const metadata = metadataBytes.toString('ascii').split(' ');
    const relativePath =
      separator === -1
        ? ''
        : decodeFatalUtf8(record.subarray(separator + 1), 'Finding writer HEAD tree path');
    const [mode, type, objectId] = metadata;
    if (
      (mode !== '100644' && mode !== '100755') ||
      type !== 'blob' ||
      objectId === undefined ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(objectId) ||
      !normalizedPaths.includes(relativePath) ||
      treeObjects.has(relativePath)
    ) {
      throw new Error(
        `Finding writer HEAD tree batch has an invalid record: ${record.toString('hex')}`,
      );
    }
    treeObjects.set(relativePath, objectId);
    treeOffset = terminator + 1;
  }
  if (treeObjects.size !== normalizedPaths.length) {
    throw new Error(`Finding writer governed file batch is incomplete at HEAD: ${worktreePath}`);
  }

  const objectIds = normalizedPaths.map((path) => {
    const objectId = treeObjects.get(path);
    if (objectId === undefined) {
      throw new Error(`Finding writer governed file is absent from the HEAD tree: ${path}`);
    }
    return objectId;
  });
  let batchOutput: Buffer;
  try {
    batchOutput = (
      await HERMETIC_GIT_RUNTIME.runBufferAsync(
        worktreePath,
        ['cat-file', '--batch'],
        [0],
        `${objectIds.join('\n')}\n`,
        GIT_OUTPUT_MAX_BUFFER_BYTES,
      )
    ).stdout;
  } catch {
    assertFindingWriterObservationNotAborted(signal);
    throw new Error(`Finding writer governed blobs cannot be read at HEAD: ${worktreePath}`);
  }

  const effectiveFiles = new Map<string, Buffer>();
  let batchOffset = 0;
  for (let index = 0; index < normalizedPaths.length; index += 1) {
    const relativePath = normalizedPaths[index];
    const expectedObjectId = objectIds[index];
    if (relativePath === undefined || expectedObjectId === undefined) {
      throw new Error('Finding writer governed blob batch lost its requested order');
    }
    const headerEnd = batchOutput.indexOf(10, batchOffset);
    if (headerEnd === -1) {
      throw new Error('Finding writer governed blob batch has a truncated header');
    }
    const header = batchOutput.subarray(batchOffset, headerEnd).toString('ascii');
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
      throw new Error(`Finding writer governed blob batch has an invalid header: ${header}`);
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= batchOutput.length || batchOutput[contentEnd] !== 10) {
      throw new Error(`Finding writer governed blob batch has truncated content: ${relativePath}`);
    }
    const committed = batchOutput.subarray(contentStart, contentEnd);
    const effective = repositorySnapshot.readFile(relativePath);
    if (!effective.equals(committed)) {
      throw new Error(
        `Finding writer governed file differs from committed HEAD: ${resolve(worktreePath, relativePath)}`,
      );
    }
    effectiveFiles.set(relativePath, effective);
    batchOffset = contentEnd + 1;
  }
  if (batchOffset !== batchOutput.length) {
    throw new Error('Finding writer governed blob batch contains trailing records');
  }
  return effectiveFiles;
}

export async function assertActiveWorktreeFindingWritersFenced(
  topology: FindingWriterWorktreeTopologyV1,
  authorityWorktreePath: string,
  signal: AbortSignal,
): Promise<FindingWriterFenceSnapshot> {
  assertFindingWriterObservationNotAborted(signal);
  const incompatibleWriters = new Map<string, string>();
  const markIncompatibleWriter = (path: string, reason: unknown): void => {
    if (!incompatibleWriters.has(path)) {
      incompatibleWriters.set(path, formatUnknownCliValue(reason));
    }
  };
  const canonicalTopology = defineFindingWriterWorktreeTopologyV1(topology.worktrees);
  const activeWorktrees = canonicalTopology.worktrees.map((worktree) => worktree.path);
  const headOids = new Map(
    canonicalTopology.worktrees.map((worktree) => [worktree.path, worktree.headOid] as const),
  );
  const worktreeGenerations: FindingWriterWorktreeGeneration[] = [];
  const repositorySnapshots: FindingWriterRepositorySnapshot[] = [];
  const verifiedFilesByWorktree = new Map<string, Readonly<Record<string, string>>>();
  const allocationFiles: FindingWriterPinnedAllocationFile[] = [];
  const registryPaths = new Set<string>();
  const claimedIds = new Set<string>();
  const orphanReservedIds = new Set<string>();
  const allocationIdentities = new Map<
    string,
    { readonly fingerprint: string; readonly registryPath: string }
  >();
  const reservedDomainFloors: Record<string, number> = {};
  for (const worktreePath of activeWorktrees) {
    const allocatorPath = resolve(worktreePath, ALLOCATOR_RELATIVE_PATH);
    try {
      const headOid = headOids.get(worktreePath);
      if (headOid === undefined) {
        throw new Error(`Finding writer topology lost its HEAD coordinate: ${worktreePath}`);
      }
      const repositorySnapshot = createFindingWriterRepositorySnapshot(worktreePath);
      repositorySnapshots.push(repositorySnapshot);
      const generation: FindingWriterWorktreeGeneration = Object.freeze({
        worktree_path: worktreePath,
        head_oid: headOid,
        allocator_present: repositorySnapshot.fileExists(allocatorPath),
      });
      worktreeGenerations.push(generation);
      const registryRelativePath = REGISTRY_RELATIVE_PATH.replaceAll('\\', '/');
      const schemaRelativePath = SCHEMA_RELATIVE_PATH.replaceAll('\\', '/');
      const registryRaw = repositorySnapshot.readText(registryRelativePath);
      const schemaRaw = repositorySnapshot.readText(schemaRelativePath);
      const registryPath = resolve(worktreePath, registryRelativePath);
      const registryEntries = parseRegistryRaw(
        registryRaw,
        registryPath,
        compileFindingValidator(schemaRaw, resolve(worktreePath, schemaRelativePath)),
      );
      const registryVerification = verify(registryEntries);
      if (!registryVerification.ok) {
        throw new Error(
          `Active worktree finding registry is invalid: ${resolve(worktreePath, registryRelativePath)}: ${registryVerification.reason}`,
        );
      }
      for (const entry of registryEntries) {
        const fingerprint = findingAllocationIdentityFingerprint(entry);
        const prior = allocationIdentities.get(entry.id);
        if (prior !== undefined && prior.fingerprint !== fingerprint) {
          throw new Error(
            `Active worktree registries assign ${entry.id} to different immutable finding identities: ${prior.registryPath}, ${registryPath}`,
          );
        }
        allocationIdentities.set(entry.id, { fingerprint, registryPath });
        claimedIds.add(entry.id);
      }
      const registryFile = observeFindingWriterAllocationFile(registryPath);
      if (registryFile.sha256 !== sha256hex(registryRaw)) {
        throw new Error(`Finding writer registry changed while pinning: ${registryPath}`);
      }
      allocationFiles.push(registryFile);
      registryPaths.add(registryPath);

      const orphanRelativePath = ORPHAN_FINDINGS_MD_RELATIVE_PATH.replaceAll('\\', '/');
      const orphanPath = resolve(worktreePath, orphanRelativePath);
      const orphanRaw = repositorySnapshot.readText(orphanRelativePath);
      for (const orphanId of orphanMarkdownReservedIdsFromText(orphanRaw)) {
        orphanReservedIds.add(orphanId);
      }
      const orphanFile = observeFindingWriterAllocationFile(orphanPath);
      if (orphanFile.sha256 !== sha256hex(orphanRaw)) {
        throw new Error(
          `Finding writer orphan allocation input changed while pinning: ${orphanPath}`,
        );
      }
      allocationFiles.push(orphanFile);
      const retiredSurfaces = FINDING_WRITER_RETIRED_MUTATION_SURFACES.filter((path) =>
        repositorySnapshot.fileExists(resolve(worktreePath, path)),
      );
      for (const retiredSurface of retiredSurfaces) {
        markIncompatibleWriter(
          resolve(worktreePath, retiredSurface),
          'retired finding mutation surface is present',
        );
      }
      if (retiredSurfaces.length > 0) continue;
      if (!generation.allocator_present) {
        continue;
      }
      const readSnapshotAuthorityText = (absolutePath: string): string => {
        const relativePath = relative(worktreePath, absolutePath).replaceAll('\\', '/');
        if (
          relativePath.length === 0 ||
          relativePath === '..' ||
          relativePath.startsWith('../') ||
          relativePath.startsWith('/')
        ) {
          throw new Error(
            `Finding writer allocation authority escapes its worktree: ${absolutePath}`,
          );
        }
        return repositorySnapshot.readText(relativePath);
      };
      const sourceManifestPath = resolve(worktreePath, CAPABILITY_MANIFEST_RELATIVE_PATH);
      repositorySnapshot.directoryEntries(dirname(CAPABILITY_MANIFEST_RELATIVE_PATH));
      const floorAuthority = readSourceFindingFloorAuthority(
        sourceManifestPath,
        readSnapshotAuthorityText,
      );
      for (const [namespace, floor] of Object.entries(floorAuthority.floors)) {
        reservedDomainFloors[namespace] = Math.max(reservedDomainFloors[namespace] ?? 0, floor);
      }
      for (const allocationPath of [sourceManifestPath, floorAuthority.artifactPath]) {
        const allocationFile = observeFindingWriterAllocationFile(allocationPath);
        const expectedSha256 =
          allocationPath === sourceManifestPath
            ? floorAuthority.manifestSha256
            : floorAuthority.artifactSha256;
        if (allocationFile.sha256 !== expectedSha256) {
          throw new Error(
            `Finding writer source allocation input changed while pinning: ${allocationPath}`,
          );
        }
        allocationFiles.push(allocationFile);
      }
      const protocolPath = resolve(worktreePath, WRITER_PROTOCOL_MANIFEST_RELATIVE_PATH);
      const protocolRaw = repositorySnapshot.readFile(WRITER_PROTOCOL_MANIFEST_RELATIVE_PATH);
      const ariaAuthorityPaths = await ariaAuthorityFilesAtRevision(
        worktreePath,
        generation.head_oid,
        signal,
      );
      const protocol = verifyFindingWriterProtocolManifest(
        decodeFatalUtf8(protocolRaw, 'Finding writer protocol manifest'),
        protocolPath,
        worktreePath,
        ariaAuthorityPaths,
        repositorySnapshot,
      );
      const effectiveFiles = await assertCommittedRegularFiles(
        worktreePath,
        [WRITER_PROTOCOL_MANIFEST_RELATIVE_PATH, ...Object.keys(protocol.files)],
        generation.head_oid,
        repositorySnapshot,
        signal,
      );
      const committedProtocol = effectiveFiles.get(WRITER_PROTOCOL_MANIFEST_RELATIVE_PATH);
      if (committedProtocol === undefined || !committedProtocol.equals(protocolRaw)) {
        throw new Error(
          `Finding writer protocol changed while loading its snapshot: ${protocolPath}`,
        );
      }
      for (const [relativePath, expectedSha256] of Object.entries(protocol.files)) {
        const content = effectiveFiles.get(relativePath);
        if (content === undefined) {
          throw new Error(
            `Finding writer governed file is absent from its snapshot: ${relativePath}`,
          );
        }
        if (sha256hex(content) !== expectedSha256) {
          throw new Error(
            `Finding writer governed file digest differs from ${protocolPath}: ${resolve(
              worktreePath,
              relativePath,
            )}`,
          );
        }
      }
      verifiedFilesByWorktree.set(worktreePath, protocol.files);
    } catch (error) {
      assertFindingWriterObservationNotAborted(signal);
      markIncompatibleWriter(allocatorPath, error);
    }
  }
  const resolvedAuthorityWorktree = resolve(authorityWorktreePath);
  const authorityFiles = verifiedFilesByWorktree.get(resolvedAuthorityWorktree);
  if (authorityFiles === undefined) {
    markIncompatibleWriter(
      resolve(resolvedAuthorityWorktree, ALLOCATOR_RELATIVE_PATH),
      'authority worktree has no verified writer protocol',
    );
  } else {
    for (const worktreePath of activeWorktrees) {
      const allocatorPath = resolve(worktreePath, ALLOCATOR_RELATIVE_PATH);
      if (incompatibleWriters.has(allocatorPath)) continue;
      const verifiedFiles = verifiedFilesByWorktree.get(worktreePath);
      const allocatorPresent = worktreeGenerations.find(
        (generation) => generation.worktree_path === worktreePath,
      )?.allocator_present;
      if (allocatorPresent === false) continue;
      if (
        verifiedFiles === undefined ||
        JSON.stringify(verifiedFiles) !== JSON.stringify(authorityFiles)
      ) {
        markIncompatibleWriter(
          allocatorPath,
          'writer protocol differs from the authority worktree',
        );
      }
    }
  }
  for (const repositorySnapshot of repositorySnapshots) {
    try {
      repositorySnapshot.assertCurrent();
    } catch (error) {
      assertFindingWriterObservationNotAborted(signal);
      markIncompatibleWriter(resolve(repositorySnapshot.repoRoot, ALLOCATOR_RELATIVE_PATH), error);
    }
  }
  assertFindingWriterObservationNotAborted(signal);
  if (incompatibleWriters.size > 0) {
    throw new Error(
      `Active worktrees expose uncommitted or protocol-incompatible finding writers: ${[
        ...incompatibleWriters.entries(),
      ]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([path, reason]) => `${path}: ${reason}`)
        .join(
          ',',
        )}; preserve them and record an explicit governed disposition or advance them to the committed ${FINDING_WRITER_PROTOCOL_ID} authority before publication or canonical mutation; automatic retirement is forbidden`,
    );
  }
  if (worktreeGenerations.length !== activeWorktrees.length) {
    throw new Error('Finding writer fence did not capture every active worktree generation');
  }
  const frozenWorktrees = Object.freeze([...worktreeGenerations]);
  const frozenAllocationFiles = Object.freeze([...allocationFiles]);
  let currentAllocationFiles = new Map(
    frozenAllocationFiles.map((file) => [file.path, file] as const),
  );
  const authorityRepositorySnapshot = repositorySnapshots.find(
    (snapshot) => snapshot.repoRoot === resolvedAuthorityWorktree,
  );
  if (authorityRepositorySnapshot === undefined) {
    throw new Error('Finding writer source transition lost its authority repository snapshot');
  }
  const allocationSnapshot = Object.freeze({
    registryPaths: Object.freeze([...registryPaths].sort()),
    claimedIds: Object.freeze([...claimedIds].sort()),
    orphanReservedIds: Object.freeze([...orphanReservedIds].sort()),
    reservedDomainFloors: Object.freeze(
      Object.fromEntries(
        Object.entries(reservedDomainFloors).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      ),
    ),
  });
  const allocationFence: FindingWriterAllocationFence = Object.freeze({
    snapshot: allocationSnapshot,
    assertCurrent: () => {
      for (const file of currentAllocationFiles.values()) {
        assertFindingWriterAllocationFileCurrent(file);
      }
    },
    assertRegistryTransition: (registryPath: string, contentSha256: string) => {
      let matched = false;
      for (const file of currentAllocationFiles.values()) {
        if (file.path === registryPath) {
          matched = true;
          assertFindingWriterAllocationFileCurrent(file, contentSha256);
        } else {
          assertFindingWriterAllocationFileCurrent(file);
        }
      }
      if (!matched) {
        throw new Error(
          `Finding writer registry transition target was not snapshotted: ${registryPath}`,
        );
      }
    },
    prepareSourceTransition: (transition: FindingWriterSourceTransitionV1) => {
      const currentTarget = currentAllocationFiles.get(transition.targetPath);
      if (
        (transition.beforeSha256 === null && currentTarget !== undefined) ||
        (transition.beforeSha256 !== null &&
          currentTarget !== undefined &&
          currentTarget.sha256 !== transition.beforeSha256)
      ) {
        throw new Error(
          `Finding writer source transition before-image differs from its allocation fence: ${transition.targetPath}`,
        );
      }
      const repositoryTransition = authorityRepositorySnapshot.prepareSourceMutation(transition);
      let active = true;
      return Object.freeze({
        assertBeforeCurrent: () => {
          if (!active) {
            throw new Error('Finding writer allocation source transition is already consumed');
          }
          authorityRepositorySnapshot.assertSourceMutationBeforeCurrent(repositoryTransition);
          for (const repositorySnapshot of repositorySnapshots) {
            if (repositorySnapshot !== authorityRepositorySnapshot) {
              repositorySnapshot.assertCurrent();
            }
          }
          for (const file of currentAllocationFiles.values()) {
            assertFindingWriterAllocationFileCurrent(file);
          }
        },
        prepareAfterCurrent: () => {
          if (!active) {
            throw new Error('Finding writer allocation source transition is already consumed');
          }
          const preparedRepositoryTransition =
            authorityRepositorySnapshot.prepareSourceMutationCommit(repositoryTransition);
          for (const repositorySnapshot of repositorySnapshots) {
            if (repositorySnapshot !== authorityRepositorySnapshot) {
              repositorySnapshot.assertCurrent();
            }
          }
          for (const [path, file] of currentAllocationFiles) {
            if (path !== transition.targetPath) assertFindingWriterAllocationFileCurrent(file);
          }
          const nextAllocationFiles = new Map(currentAllocationFiles);
          if (transition.afterSha256 === null) {
            const pathKind = observeStablePathKind(
              transition.targetPath,
              'Finding writer transitioned allocation input',
            );
            if (pathKind.kind !== 'MISSING') {
              throw new Error(
                `Finding writer source transition expected a missing allocation input: ${transition.targetPath}`,
              );
            }
            nextAllocationFiles.delete(transition.targetPath);
          } else {
            const nextFile = observeFindingWriterAllocationFile(transition.targetPath);
            if (nextFile.sha256 !== transition.afterSha256) {
              throw new Error(
                `Finding writer source transition after-image differs from its allocation fence: ${transition.targetPath}`,
              );
            }
            nextAllocationFiles.set(transition.targetPath, nextFile);
          }
          let preparedActive = true;
          return Object.freeze({
            commit: () => {
              if (!active || !preparedActive) {
                throw new Error(
                  'Finding writer prepared allocation source transition is stale or consumed',
                );
              }
              preparedActive = false;
              authorityRepositorySnapshot.commitSourceMutation(
                repositoryTransition,
                preparedRepositoryTransition,
              );
              currentAllocationFiles = nextAllocationFiles;
              active = false;
            },
          });
        },
        cancelBeforeCurrent: () => {
          if (!active) {
            throw new Error('Finding writer allocation source transition is already consumed');
          }
          authorityRepositorySnapshot.cancelSourceMutation(repositoryTransition);
          active = false;
        },
      });
    },
  });
  const generation = sha256hex(
    JSON.stringify({
      worktrees: frozenWorktrees.map((worktree) => [
        worktree.worktree_path,
        worktree.head_oid,
        worktree.allocator_present,
      ]),
      allocation_inputs: frozenAllocationFiles.map((file) => [file.path, file.sha256]),
    }),
  );
  const snapshot = createFindingWriterFenceSnapshot(
    generation,
    frozenWorktrees,
    repositorySnapshots,
  );
  findingWriterAllocationFences.set(snapshot, allocationFence);
  assertFindingWriterObservationNotAborted(signal);
  return snapshot;
}

function gitOutput(repoRoot: string, args: readonly string[]): string {
  return HERMETIC_GIT_RUNTIME.runText(
    repoRoot,
    args,
    [0],
    GIT_OUTPUT_MAX_BUFFER_BYTES,
  ).stdout.trim();
}

export function resolveGitFindingAllocationAuthority(
  repoRoot: string,
  registryRelativePath = REGISTRY_RELATIVE_PATH,
): FindingAllocationAuthority {
  const commonDir = gitOutput(repoRoot, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (!commonDir) {
    throw new Error(`Git common-dir resolution returned an empty path for ${repoRoot}`);
  }
  const topologyFromProtocol = (protocolRaw: Buffer): FindingWriterWorktreeTopologyV1 =>
    defineFindingWriterWorktreeTopologyV1(
      parseWorktreeList(decodeFatalUtf8(protocolRaw, 'Finding writer worktree list protocol')).map(
        (worktree) => ({ path: worktree.path, headOid: worktree.headSha }),
      ),
    );
  const activeWorktreeTopology = (): FindingWriterWorktreeTopologyV1 =>
    topologyFromProtocol(
      HERMETIC_GIT_RUNTIME.runBuffer(repoRoot, ['worktree', 'list', '--porcelain', '-z']).stdout,
    );
  const activeWorktreeTopologyAsync = async (
    signal: AbortSignal,
  ): Promise<FindingWriterWorktreeTopologyV1> => {
    if (signal.aborted) {
      if (signal.reason instanceof Error) throw signal.reason;
      throw new Error('Finding writer worktree topology observation was aborted');
    }
    const topology = topologyFromProtocol(
      (
        await HERMETIC_GIT_RUNTIME.runBufferAsync(repoRoot, [
          'worktree',
          'list',
          '--porcelain',
          '-z',
        ])
      ).stdout,
    );
    if (signal.aborted) {
      if (signal.reason instanceof Error) throw signal.reason;
      throw new Error('Finding writer worktree topology observation was aborted');
    }
    return topology;
  };
  const activeRegistryPaths = (): string[] => {
    const worktreePaths = activeWorktreeTopology().worktrees.map((worktree) => worktree.path);
    const registryPaths = worktreePaths.map((worktreePath) =>
      resolve(worktreePath, registryRelativePath),
    );
    const snapshots = worktreePaths.map((worktreePath) =>
      createFindingWriterRepositorySnapshot(worktreePath),
    );
    for (const [index, registryPath] of registryPaths.entries()) {
      const snapshot = snapshots[index];
      if (snapshot === undefined || !snapshot.fileExists(registryPath)) {
        throw new Error(`Active worktree finding registry is missing: ${registryPath}`);
      }
    }
    for (const snapshot of snapshots) snapshot.assertCurrent();
    return registryPaths;
  };

  const authority: FindingAllocationAuthority = {
    repoRoot: resolve(repoRoot),
    lockPath: join(commonDir, 'finding-registry-v1.lock'),
    reservationPath: join(commonDir, 'finding-id-reservations-v1.json'),
    assertCompatibleWriters: async (signal) => {
      const initialTopology = await activeWorktreeTopologyAsync(signal);
      const snapshot = await assertActiveWorktreeFindingWritersFenced(
        initialTopology,
        repoRoot,
        signal,
      );
      const finalTopology = await activeWorktreeTopologyAsync(signal);
      if (JSON.stringify(finalTopology) !== JSON.stringify(initialTopology)) {
        throw new FindingWriterFenceGenerationMismatchError(
          'Finding writer worktree topology changed while preparing its snapshot',
        );
      }
      const allocationFence = findingWriterAllocationFences.get(snapshot);
      if (allocationFence === undefined) {
        throw new Error('Finding writer allocation fence was not bound to its snapshot');
      }
      findingWriterAllocationFences.delete(snapshot);
      prepareFindingWriterFenceSnapshot(
        authority,
        snapshot,
        activeWorktreeTopology,
        activeWorktreeTopologyAsync,
        allocationFence,
      );
      return snapshot;
    },
    consumeCompatibleWriters: (snapshot, signal) =>
      consumeFindingWriterFenceSnapshot(authority, snapshot, signal),
    redeemCompatibleWriters: (capability, lease, profile, signal) => {
      if (profile.kind !== 'REGISTRY_MUTATION') {
        throw new Error('Public finding writer redemption accepts registry mutation profiles only');
      }
      return redeemRegistryFindingWriterFence(authority, capability, lease, profile, signal);
    },
    releaseCompatibleWriters: (capability) => releaseFindingWriterFence(authority, capability),
    activeRegistryPaths,
  };
  return Object.freeze(authority);
}

/**
 * Ajv-compiled validator for the finding schema. Compiled once at
 * first-use; exits 1 if the stub fails validation. This is the
 * add-time half of the Tier-1 defence (companion to the
 * finding-registry-integrity Jest invariant that validates the whole
 * ledger in CI). Before this existed, historical seed scripts wrote
 * entries with free-text evidence and over-long titles that violated
 * the schema; those entries survived until the invariant ran post-hoc.
 * Now every append is schema-checked before the hash chain advances.
 */
const cachedValidators = new Map<string, ValidateFunction>();

function compileFindingValidator(schemaRaw: string, schemaAuthority: string): ValidateFunction {
  const cacheKey = sha256hex(schemaRaw);
  const cached = cachedValidators.get(cacheKey);
  if (cached) return cached;
  let schema: unknown;
  try {
    schema = JSON.parse(schemaRaw) as unknown;
  } catch (error) {
    throw new Error(`Finding registry schema is not JSON: ${schemaAuthority}`, { cause: error });
  }
  if (!isJsonRecord(schema)) {
    throw new Error(`Finding registry schema is not an object: ${schemaAuthority}`);
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validator = ajv.compile(schema);
  cachedValidators.set(cacheKey, validator);
  return validator;
}

function loadStubValidator(schemaPath = SCHEMA_PATH): ValidateFunction {
  return compileFindingValidator(readFileSync(schemaPath, 'utf8'), schemaPath);
}

/**
 * Finding schema mirror — narrow to what the CLI touches. The canonical
 * schema lives in docs/reviews/_registry/findings.jsonl.schema.json; we
 * keep these interfaces structural (no runtime validation here — the
 * integrity invariant test enforces schema conformance separately).
 */
export interface Finding {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  state: 'OPEN' | 'IN-PROGRESS' | 'RESOLVED' | 'STALE' | 'BLOCKED';
  title: string;
  layer?: number;
  evidence?: string[];
  rule_violated?: string;
  owner_agent: string;
  raised_in_cycle: string;
  review_file?: string;
  created_at: string;
  closed_at: string | null;
  closing_commits: string[];
  deadline: string | null;
  owner_user: string | null;
  override_of: string | null;
  notes?: string;
  prev_hash: string;
  content_hash: string;
  [key: string]: unknown;
}

/**
 * Key-sorted JSON without whitespace. Canonical form for hashing;
 * identical to the algorithm in
 * tests/invariants/finding-registry-integrity.spec.ts.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

function findingAllocationIdentityFingerprint(entry: Finding): string {
  const lifecycleAndChainFields = new Set([
    'state',
    'closed_at',
    'closing_commits',
    'prev_hash',
    'content_hash',
  ]);
  return sha256hex(
    canonicalJson(
      Object.fromEntries(
        Object.entries(entry).filter(([field]) => !lifecycleAndChainFields.has(field)),
      ),
    ),
  );
}

function sha256hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

const ADD_STUB_FIELDS = new Set([
  'severity',
  'title',
  'layer',
  'evidence',
  'rule_violated',
  'owner_agent',
  'raised_in_cycle',
  'review_file',
  'deadline',
  'owner_user',
  'override_of',
  'notes',
  'narrative',
]);

function canonicalEffectiveAt(): string {
  const effectiveAt = process.env['FINDING_EFFECTIVE_AT'];
  if (
    !effectiveAt ||
    !Number.isFinite(Date.parse(effectiveAt)) ||
    new Date(Date.parse(effectiveAt)).toISOString() !== effectiveAt
  ) {
    throw new Error('FINDING_EFFECTIVE_AT must be a canonical UTC ISO timestamp');
  }
  return effectiveAt;
}

function normalizedAddStub(stubPath: string): Partial<Finding> {
  const value: unknown = JSON.parse(readFileSync(stubPath, 'utf8'));
  if (!isJsonRecord(value)) {
    throw new Error(`Finding stub must be a JSON object: ${stubPath}`);
  }
  const unsupportedFields = Object.keys(value).filter((field) => !ADD_STUB_FIELDS.has(field));
  if (unsupportedFields.length > 0) {
    throw new Error(
      `Finding stub contains authority-owned or unsupported fields: ${unsupportedFields
        .sort()
        .join(', ')}`,
    );
  }
  return value;
}

function sweepStaleAfterDays(args: readonly string[]): number {
  const staleArg = args.find((argument) => argument.startsWith('--stale-after='));
  if (!staleArg) return 30;
  const raw = staleArg.slice('--stale-after='.length);
  if (!/^\d{1,3}$/.test(raw)) {
    throw new Error(`--stale-after must be an integer between 1 and 365: ${raw}`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed < 1 || parsed > 365) {
    throw new Error(`--stale-after must be between 1 and 365: ${raw}`);
  }
  return parsed;
}

function mutationInputSha256(
  operation: RegistryMutationOperation,
  args: readonly string[],
): string {
  const effectiveAt = canonicalEffectiveAt();
  if (operation === 'add') {
    const domain = args[0];
    const stubPath = args[1];
    if (!domain || !/^[A-Z][A-Z0-9]*$/.test(domain) || !stubPath) {
      throw new Error('add request digest requires an uppercase domain and stub path');
    }
    return sha256hex(
      canonicalJson({
        effective_at: effectiveAt,
        finding: normalizedAddStub(resolve(stubPath)),
        operation,
        domain,
      }),
    );
  }
  if (operation === 'close') {
    const findingId = args[0];
    const closingSha = args[1];
    if (
      !findingId ||
      !/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+-[0-9]{3}$/.test(findingId) ||
      !closingSha ||
      !/^[0-9a-f]{40}$/.test(closingSha)
    ) {
      throw new Error('close request digest requires a canonical finding id and full main SHA');
    }
    return sha256hex(
      canonicalJson({
        closing_sha: closingSha,
        effective_at: effectiveAt,
        finding_id: findingId,
        operation,
      }),
    );
  }
  return sha256hex(
    canonicalJson({
      effective_at: effectiveAt,
      operation,
      stale_after_days: sweepStaleAfterDays(args),
    }),
  );
}

interface CommittedMutationCommand {
  readonly commitSha: string;
  readonly operation: RegistryMutationOperation;
  readonly inputSha256: string;
}

function committedMutationCommand(commandId: string): CommittedMutationCommand | null {
  const matchingCommits = gitOutput(REPO_ROOT, [
    'log',
    'HEAD',
    '--fixed-strings',
    '--grep',
    `Automation-Command-ID: ${commandId}`,
    '--format=%H',
  ])
    .split(/\r?\n/)
    .filter(Boolean);
  if (matchingCommits.length === 0) return null;
  if (matchingCommits.length !== 1) {
    throw new Error(
      `Automation command ${commandId} appears in ${matchingCommits.length} protected-main commits`,
    );
  }
  const commitSha = matchingCommits[0] as string;
  const message = gitOutput(REPO_ROOT, ['show', '-s', '--format=%B', commitSha]);
  const trailerValue = (name: string): string => {
    const matches = message
      .split(/\r?\n/)
      .filter((line) => line.startsWith(`${name}: `))
      .map((line) => line.slice(name.length + 2));
    if (matches.length !== 1 || !matches[0]) {
      throw new Error(`Automation command commit ${commitSha} has an invalid ${name} trailer`);
    }
    return matches[0];
  };
  const operation = trailerValue('Automation-Operation');
  if (operation !== 'add' && operation !== 'close' && operation !== 'sweep') {
    throw new Error(`Automation command commit ${commitSha} has an invalid operation`);
  }
  const inputSha256 = trailerValue('Automation-Input-SHA256');
  if (!/^[0-9a-f]{64}$/.test(inputSha256)) {
    throw new Error(`Automation command commit ${commitSha} has an invalid input digest`);
  }
  return { commitSha, operation, inputSha256 };
}

function parseRegistryRaw(
  rawInput: string,
  registryPath: string,
  validate: ValidateFunction,
): Finding[] {
  if (rawInput.length === 0) return [];
  const lines = rawInput.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const entries: Finding[] = [];
  const ids = new Set<string>();
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (line.length === 0) {
      throw new Error(`Finding registry has an empty JSONL row: ${registryPath}:${lineNumber}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`Finding registry JSON is invalid: ${registryPath}:${lineNumber}`, {
        cause: error,
      });
    }
    if (!validate(value)) {
      const diagnostics = (validate.errors ?? [])
        .map((failure) => `${failure.instancePath || '/'} ${failure.message ?? 'is invalid'}`)
        .join('; ');
      throw new Error(
        `Finding registry row violates its canonical schema: ${registryPath}:${lineNumber}: ${diagnostics}`,
      );
    }
    const entry = value as Finding;
    if (ids.has(entry.id)) {
      throw new Error(`Finding registry repeats id ${entry.id}: ${registryPath}:${lineNumber}`);
    }
    ids.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

function loadRegistry(
  registryPath = REGISTRY_PATH,
  schemaPath = resolve(dirname(registryPath), 'findings.jsonl.schema.json'),
): Finding[] {
  if (!existsSync(registryPath)) return [];
  return parseRegistryRaw(
    readFileSync(registryPath, 'utf8'),
    registryPath,
    loadStubValidator(schemaPath),
  );
}

function loadReservationLedger(reservationPath: string): FindingIdReservationLedger {
  if (!existsSync(reservationPath)) return { version: 1, domains: {} };
  const value = JSON.parse(readFileSync(reservationPath, 'utf8')) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Finding ID reservation ledger is not an object: ${reservationPath}`);
  }
  const candidate = value as Partial<FindingIdReservationLedger>;
  if (
    candidate.version !== 1 ||
    candidate.domains === null ||
    typeof candidate.domains !== 'object' ||
    Array.isArray(candidate.domains)
  ) {
    throw new Error(`Finding ID reservation ledger has an invalid envelope: ${reservationPath}`);
  }

  for (const [domain, reservation] of Object.entries(candidate.domains)) {
    if (
      !/^[A-Z][A-Z0-9]*$/.test(domain) ||
      reservation === null ||
      typeof reservation !== 'object' ||
      !Number.isSafeInteger(reservation.sequence) ||
      reservation.sequence < 1 ||
      reservation.sequence > 999 ||
      typeof reservation.finding_id !== 'string' ||
      !new RegExp(`^${domain}-[A-Z0-9]+-${String(reservation.sequence).padStart(3, '0')}$`).test(
        reservation.finding_id,
      ) ||
      typeof reservation.reserved_at !== 'string' ||
      !Number.isFinite(Date.parse(reservation.reserved_at)) ||
      typeof reservation.registry_path !== 'string' ||
      reservation.registry_path.length === 0
    ) {
      throw new Error(
        `Finding ID reservation ledger has an invalid ${domain} record: ${reservationPath}`,
      );
    }
  }
  return candidate as FindingIdReservationLedger;
}

function registryMutationStagingLocations(
  authority: FindingAllocationAuthority,
  includeReservation = true,
): { parentPath: string; basename: string }[] {
  const registryPaths = authority.activeRegistryPaths();
  for (const registryPath of registryPaths) {
    if (!existsSync(registryPath)) {
      throw new Error(`Active worktree finding registry is missing: ${registryPath}`);
    }
  }
  const legacyLocations = [
    ...registryPaths.map((registryPath) => ({
      parentPath: dirname(registryPath),
      basename: basename(registryPath),
    })),
    ...(includeReservation
      ? [
          {
            parentPath: dirname(authority.reservationPath),
            basename: basename(authority.reservationPath),
          },
        ]
      : []),
  ];
  const stagingParent = dirname(authority.lockPath);
  const stagingBasenames = new Set(registryPaths.map((registryPath) => basename(registryPath)));
  if (includeReservation) stagingBasenames.add(basename(authority.reservationPath));
  const locations = [
    ...[...stagingBasenames].map((targetBasename) => ({
      parentPath: stagingParent,
      basename: targetBasename,
    })),
    ...legacyLocations,
  ];
  return locations.filter(
    (location, index) =>
      locations.findIndex(
        (candidate) =>
          candidate.parentPath === location.parentPath && candidate.basename === location.basename,
      ) === index,
  );
}

export function registryMutationStagingFiles(authority: FindingAllocationAuthority): string[] {
  return registryMutationStagingLocations(authority)
    .flatMap((location) =>
      listAtomicWriteStagingFiles(
        location.parentPath,
        (candidate) => candidate === location.basename,
      ).map((name) => join(location.parentPath, name)),
    )
    .sort();
}

export function recoverRegistryMutationStaging(
  authority: FindingAllocationAuthority,
  lease: RegistryLockLease,
  writerFence: RedeemedFindingWriterFenceCapability,
  repositoryAuthority: RepositoryMutationAuthority,
  operation: RegistryMutationOperation,
): void {
  assertFindingWriterFenceAuthority(writerFence, lease, authority);
  const commonStagingParent = dirname(lease.lockPath);
  const targetByBasename = new Map<string, string>([
    [basename(lease.resourcePath), lease.resourcePath],
    ...(operation === 'add'
      ? ([[basename(authority.reservationPath), authority.reservationPath]] as const)
      : []),
  ]);
  recoverGovernedFindingStagingFiles(
    commonStagingParent,
    (candidate) => targetByBasename.has(candidate),
    lease,
    REGISTRY_STAGING_STALE_MS,
    writerFence,
    repositoryAuthority,
    operation,
    (candidate) => {
      const targetPath = targetByBasename.get(candidate);
      if (targetPath === undefined) {
        throw new Error(`Registry staging recovery lost its target mapping: ${candidate}`);
      }
      return targetPath;
    },
  );
  const locations = [
    ...(operation === 'add'
      ? [
          {
            parentPath: dirname(authority.reservationPath),
            basename: basename(authority.reservationPath),
          },
        ]
      : []),
    { parentPath: dirname(lease.resourcePath), basename: basename(lease.resourcePath) },
  ];
  for (const location of locations) {
    recoverGovernedFindingStagingFiles(
      location.parentPath,
      (candidate) => candidate === location.basename,
      lease,
      REGISTRY_STAGING_STALE_MS,
      writerFence,
      repositoryAuthority,
      operation,
    );
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface SourceFindingFloorAuthority {
  readonly floors: Readonly<Record<string, number>>;
  readonly artifactPath: string;
  readonly manifestSha256: string;
  readonly artifactSha256: string;
}

function readSourceFindingFloorAuthority(
  manifestPath: string,
  readAuthorityText: (absolutePath: string) => string,
): SourceFindingFloorAuthority {
  const manifestRaw = readAuthorityText(manifestPath);
  const manifestValue: unknown = JSON.parse(manifestRaw);
  if (!isJsonRecord(manifestValue)) {
    throw new Error(`Capability manifest is not an object: ${manifestPath}`);
  }
  const reconciliation = manifestValue['capability_reconciliation'];
  if (!isJsonRecord(reconciliation)) {
    throw new Error(`Capability reconciliation is absent or invalid: ${manifestPath}`);
  }
  const allocationPolicy = reconciliation['finding_allocation_policy'];
  if (!isJsonRecord(allocationPolicy)) {
    throw new Error(`Finding allocation policy is absent or invalid: ${manifestPath}`);
  }
  if (allocationPolicy['allocator'] !== 'tools/gates/finding-registry.ts') {
    throw new Error(`Capability manifest names a different finding allocator: ${manifestPath}`);
  }
  const candidateFloors = allocationPolicy['reserved_domain_floors'];
  if (!isJsonRecord(candidateFloors)) {
    throw new Error(`Reserved domain floors are absent or invalid: ${manifestPath}`);
  }
  const findingInventory = reconciliation['finding_inventory'];
  if (!isJsonRecord(findingInventory) || findingInventory['schema_version'] !== 3) {
    throw new Error(`Finding inventory v3 is absent or invalid: ${manifestPath}`);
  }
  const artifactPath = findingInventory['artifact_path'];
  const artifactSha256 = findingInventory['artifact_sha256'];
  const occurrenceCount = findingInventory['occurrence_count'];
  if (typeof artifactPath !== 'string' || typeof artifactSha256 !== 'string') {
    throw new Error(`Finding inventory artifact authority is invalid: ${manifestPath}`);
  }
  const artifactMatch =
    /^docs\/plans\/2026-06-18-enterprise-grade-debt-closure\/source-findings\.(?<sha256>[0-9a-f]{64})\.jsonl$/.exec(
      artifactPath,
    );
  if (
    !artifactMatch?.groups?.sha256 ||
    artifactSha256 !== artifactMatch.groups.sha256 ||
    !Number.isSafeInteger(occurrenceCount) ||
    typeof occurrenceCount !== 'number' ||
    occurrenceCount < 0
  ) {
    throw new Error(`Finding inventory artifact authority is invalid: ${manifestPath}`);
  }
  const planDirectory = dirname(manifestPath);
  const artifactAbsolutePath = resolve(
    planDirectory,
    artifactPath.slice(artifactPath.lastIndexOf('/') + 1),
  );
  const artifactRaw = readAuthorityText(artifactAbsolutePath);
  if (sha256hex(artifactRaw) !== artifactSha256) {
    throw new Error(
      `Finding inventory artifact SHA-256 differs from its authority: ${manifestPath}`,
    );
  }
  const artifactRows = artifactRaw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index): Record<string, unknown> => {
      const value: unknown = JSON.parse(line);
      if (!isJsonRecord(value)) {
        throw new Error(
          `Finding inventory artifact row ${index + 1} is not an object: ${artifactAbsolutePath}`,
        );
      }
      return value;
    });
  if (artifactRows.length !== occurrenceCount) {
    throw new Error(
      `Finding inventory artifact row count differs from its authority: ${manifestPath}`,
    );
  }
  const repoRoot = resolve(planDirectory, '..', '..', '..');
  const schemaPath = resolve(
    repoRoot,
    'docs',
    'reviews',
    '_registry',
    'findings.jsonl.schema.json',
  );
  const schemaContract = parseFindingRegistrySchemaContract(
    JSON.parse(readAuthorityText(schemaPath)) as unknown,
  );
  const artifactRawIds: string[] = [];
  for (const [index, row] of artifactRows.entries()) {
    const rawId = row['raw_id'];
    if (typeof rawId !== 'string') {
      throw new Error(
        `Finding inventory artifact row ${index + 1} has no raw_id: ${artifactAbsolutePath}`,
      );
    }
    artifactRawIds.push(rawId);
  }
  const normalizedDerivedFloors = deriveRawFindingIdFloors(artifactRawIds, schemaContract);
  if (canonicalJson(candidateFloors) !== canonicalJson(normalizedDerivedFloors)) {
    throw new Error(
      `Reserved domain floors differ from the content-addressed finding artifact: ${manifestPath}`,
    );
  }
  for (const [namespace, value] of Object.entries(candidateFloors)) {
    if (
      !/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/.test(namespace) ||
      !Number.isSafeInteger(value) ||
      typeof value !== 'number' ||
      value < 1 ||
      value > 999
    ) {
      throw new Error(
        `Reserved finding namespace floor ${namespace} is invalid in ${manifestPath}`,
      );
    }
  }
  return Object.freeze({
    floors: Object.freeze({ ...normalizedDerivedFloors }),
    artifactPath: artifactAbsolutePath,
    manifestSha256: sha256hex(manifestRaw),
    artifactSha256,
  });
}

export function reservedDomainFloorsFromManifest(
  manifestPath: string,
): Readonly<Record<string, number>> {
  if (!existsSync(manifestPath)) {
    throw new Error(`Active worktree capability manifest is missing: ${manifestPath}`);
  }
  return readSourceFindingFloorAuthority(manifestPath, (absolutePath) => {
    if (!existsSync(absolutePath)) {
      throw new Error(`Finding inventory authority input is missing: ${absolutePath}`);
    }
    return readFileSync(absolutePath, 'utf8');
  }).floors;
}

export function allocationFloorForDomain(
  floors: Readonly<Record<string, number>>,
  domain: string,
): number {
  let floor = 0;
  for (const [namespace, value] of Object.entries(floors)) {
    if (namespace === domain || namespace.startsWith(`${domain}-`)) {
      floor = Math.max(floor, value);
    }
  }
  return floor;
}

function reserveFindingId(
  authority: FindingAllocationAuthority,
  ledger: FindingIdReservationLedger,
  domain: string,
  findingId: string,
  registryPath: string,
  lease: RegistryLockLease,
  reservedAt: string,
  writerFence: RedeemedFindingWriterFenceCapability,
): void {
  const sequence = Number.parseInt(findingId.slice(-3), 10);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 999) {
    throw new RangeError(`Finding reservation sequence is out of range: ${findingId}`);
  }
  const current = ledger.domains[domain];
  if (current && current.sequence >= sequence) return;
  const nextLedger: FindingIdReservationLedger = {
    version: 1,
    domains: {
      ...ledger.domains,
      [domain]: {
        sequence,
        finding_id: findingId,
        reserved_at: reservedAt,
        registry_path: registryPath,
      },
    },
  };
  atomicWriteFindingReservationFile(
    authority.reservationPath,
    `${JSON.stringify(nextLedger)}\n`,
    lease,
    writerFence,
  );
}

function writeRegistry(
  entries: readonly Finding[],
  lease: RegistryLockLease,
  repositoryAuthority: RepositoryMutationAuthority,
  writerFence: RedeemedFindingWriterFenceCapability,
  operation: RegistryMutationOperation,
  registryPath = REGISTRY_PATH,
): void {
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  atomicWriteRegistryFile(
    registryPath,
    content,
    lease,
    repositoryAuthority,
    operation,
    writerFence,
  );
}

/**
 * Recompute prev_hash + content_hash pointers from `startIndex` to the
 * end of `entries`. Mutation in place. Used by `close` after mutating
 * a past entry; every downstream entry carries a stale prev_hash until
 * rechained here.
 */
function rechain(entries: Finding[], startIndex: number): void {
  let prev = startIndex === 0 ? ZERO_HASH : (entries[startIndex - 1]?.content_hash ?? ZERO_HASH);
  for (let i = startIndex; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    entry.prev_hash = prev;
    // content_hash = sha256(canonical JSON of entry minus content_hash)
    const { content_hash: _, ...forHash } = entry;
    const hash = sha256hex(canonicalJson(forHash));
    entry.content_hash = hash;
    prev = hash;
  }
}

interface VerifyResult {
  ok: boolean;
  entries: number;
  firstFailureIndex: number | null;
  reason: string | null;
}

function verify(entries: readonly Finding[]): VerifyResult {
  let prev = ZERO_HASH;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.prev_hash !== prev) {
      return {
        ok: false,
        entries: entries.length,
        firstFailureIndex: i,
        reason: `chain break at entry ${i} (${entry.id}): prev_hash=${entry.prev_hash} expected=${prev}`,
      };
    }
    const { content_hash, ...forHash } = entry;
    const recomp = sha256hex(canonicalJson(forHash));
    if (recomp !== content_hash) {
      return {
        ok: false,
        entries: entries.length,
        firstFailureIndex: i,
        reason: `hash mismatch at entry ${i} (${entry.id}): recomputed=${recomp} stored=${content_hash}`,
      };
    }
    prev = content_hash;
  }
  return { ok: true, entries: entries.length, firstFailureIndex: null, reason: null };
}

function cmdVerify(): number {
  try {
    const stagingFiles = registryMutationStagingFiles(
      resolveGitFindingAllocationAuthority(REPO_ROOT),
    );
    if (stagingFiles.length > 0) {
      process.stderr.write(
        `FAIL: unpublished finding-registry atomic staging files exist: ${stagingFiles.join(
          ',',
        )}\n`,
      );
      return 1;
    }
  } catch (error) {
    process.stderr.write(
      `FAIL: finding-registry staging inspection failed closed: ${formatUnknownCliValue(error)}\n`,
    );
    return 1;
  }
  const entries = loadRegistry();
  const result = verify(entries);
  if (!result.ok) {
    process.stderr.write(`FAIL: ${result.reason}\n`);
    return 1;
  }
  process.stdout.write(`OK: registry chain valid (${result.entries} entries).\n`);
  const tip = entries.length === 0 ? ZERO_HASH : (entries[entries.length - 1]?.content_hash ?? '');
  if (tip) process.stdout.write(`Chain tip: ${tip}\n`);
  return 0;
}

async function cmdWriterPreflight(): Promise<number> {
  try {
    const authority = resolveGitFindingAllocationAuthority(REPO_ROOT);
    const deadlineFailure = new FindingWriterFenceAdmissionDeadlineError(
      FINDING_WRITER_FENCE_ADMISSION_POLICY_V1.admissionDeadlineMs,
      undefined,
    );
    const snapshot = await runWithHermeticGitExecutionDeadline(
      FINDING_WRITER_FENCE_ADMISSION_POLICY_V1.admissionDeadlineMs,
      deadlineFailure,
      (signal) => authority.assertCompatibleWriters(signal),
    );
    await runWithHermeticGitExecutionDeadline(
      FINDING_WRITER_FENCE_ADMISSION_POLICY_V1.admissionDeadlineMs,
      deadlineFailure,
      (signal) => authority.consumeCompatibleWriters(snapshot, signal),
    );
    const registryCount = snapshot.worktrees.length;
    const stagingFiles = registryMutationStagingFiles(authority);
    if (stagingFiles.length > 0) {
      throw new Error(`unpublished atomic staging files exist: ${stagingFiles.join(',')}`);
    }
    process.stdout.write(
      `OK: finding writer preflight passed (${registryCount} active registry snapshots).\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `FAIL: finding writer preflight failed closed: ${formatUnknownCliValue(error)}\n`,
    );
    return 1;
  }
}

function readFindingStub(stubPath: string): Partial<Finding> | null {
  if (!existsSync(stubPath)) {
    process.stderr.write(`Stub file not found: ${stubPath}\n`);
    return null;
  }
  return normalizedAddStub(stubPath);
}

function buildFinding(stub: Partial<Finding>, id: string, effectiveAt: string): Finding | null {
  const required: (keyof Finding)[] = ['severity', 'title', 'owner_agent', 'raised_in_cycle'];
  for (const field of required) {
    if (stub[field] === undefined || stub[field] === null) {
      process.stderr.write(`Stub missing required field: ${field}\n`);
      return null;
    }
  }

  return {
    id,
    severity: stub.severity as Finding['severity'],
    state: 'OPEN',
    title: stub.title as string,
    ...(stub.layer === undefined || stub.layer === null ? {} : { layer: stub.layer }),
    evidence: stub.evidence ?? [],
    rule_violated: stub.rule_violated ?? '',
    owner_agent: stub.owner_agent as string,
    raised_in_cycle: stub.raised_in_cycle as string,
    review_file: stub.review_file ?? '',
    created_at: effectiveAt,
    closed_at: null,
    closing_commits: [],
    deadline: stub.deadline ?? null,
    owner_user: stub.owner_user ?? null,
    override_of: stub.override_of ?? null,
    notes: stub.notes ?? '',
    ...(stub.narrative ? { narrative: stub.narrative } : {}),
    prev_hash: ZERO_HASH, // fixed by rechain
    content_hash: ZERO_HASH, // fixed by rechain
  };
}

function validateAndAppendFinding(
  newEntry: Finding,
  entries: Finding[],
  lease: RegistryLockLease,
  repositoryAuthority: RepositoryMutationAuthority,
  writerFence: RedeemedFindingWriterFenceCapability,
  paths: RegistryPaths,
  beforeRegistryWrite?: () => void,
): number {
  if (entries.some((entry) => entry.id === newEntry.id)) {
    process.stderr.write(`Duplicate id: ${newEntry.id} already exists in registry.\n`);
    return 1;
  }

  // Schema validation BEFORE rechain: reject malformed stubs at the
  // earliest point. The prev_hash/content_hash placeholders match the
  // schema's pattern rule (64-hex OR 64-zero), so validation can run
  // pre-rechain. This guarantees no schema-violating entry ever hits
  // the JSONL — the invariant test becomes a belt-and-suspenders
  // check rather than the primary defence.
  const validate = loadStubValidator(paths.schemaPath);
  if (!validate(newEntry)) {
    process.stderr.write('Stub failed schema validation:\n');
    for (const err of validate.errors ?? []) {
      process.stderr.write(`  ${err.instancePath || '<root>'}: ${err.message} (${err.keyword})\n`);
    }
    return 1;
  }

  const invalidEvidence = findNonCanonicalFindingEvidence(newEntry.evidence);
  if (invalidEvidence.length > 0) {
    process.stderr.write(
      'Stub evidence must use canonical file/path citation shapes; move diagnostic prose to narrative:\n',
    );
    for (const violation of invalidEvidence) {
      process.stderr.write(
        `  evidence[${violation.index}]: ${JSON.stringify(violation.evidence)}\n`,
      );
    }
    return 1;
  }

  entries.push(newEntry);
  rechain(entries, entries.length - 1);

  const post = verify(entries);
  if (!post.ok) {
    process.stderr.write(`Post-add integrity check FAILED: ${post.reason}\n`);
    return 1;
  }

  beforeRegistryWrite?.();
  writeRegistry(entries, lease, repositoryAuthority, writerFence, 'add', paths.registryPath);
  process.stdout.write(`Added: ${newEntry.id} at position ${entries.length - 1}\n`);
  process.stdout.write(`Chain tip: ${newEntry.content_hash}\n`);
  return 0;
}

/**
 * Every id already claimed in `domain`, across EVERY store that claims ids.
 *
 * ORPHAN-HIGH-457 — the single allocation reader used by the only append
 * path. Explicit caller-owned identifiers were retired; repository authority
 * always allocates through this union of every live sequence store.
 *
 * The stores, and why each counts:
 *   * the JSONL registry — the obvious one;
 *   * sibling active worktree registries via `authority`, so two concurrent
 *     branches cannot mint the same id;
 *   * `docs/reviews/orphan-findings.md`, which allocates from the SAME ORPHAN
 *     sequence space. At the time this was found the registry's ORPHAN
 *     maximum was 332 while the markdown store was already at 416, so the
 *     next nineteen ids handed out (333-351) all named findings that already
 *     existed. Eight collided exactly, and their commit trailers resolved —
 *     to the wrong finding.
 */
export function claimedIdsForDomain(
  domain: string,
  allocationSnapshot: FindingWriterAllocationSnapshot,
): string[] {
  const claimed = [...allocationSnapshot.claimedIds];
  const sourceInventoryFloor = allocationFloorForDomain(
    allocationSnapshot.reservedDomainFloors,
    domain,
  );
  if (sourceInventoryFloor > 0) {
    claimed.push(`${domain}-SOURCEINVENTORY-${String(sourceInventoryFloor).padStart(3, '0')}`);
  }
  if (domain === 'ORPHAN') {
    claimed.push(...allocationSnapshot.orphanReservedIds);
  }
  return claimed;
}

export function appendAllocatedFinding(
  domain: string,
  stubPath: string,
  lease: RegistryLockLease,
  repositoryAuthority: RepositoryMutationAuthority,
  writerFence: RedeemedFindingWriterFenceCapability,
  authority: FindingAllocationAuthority,
  paths: RegistryPaths = DEFAULT_REGISTRY_PATHS,
): number {
  assertFindingWriterFenceAuthority(writerFence, lease, authority);
  if (lease.resourcePath !== paths.registryPath || lease.lockPath !== authority.lockPath) {
    throw new RegistryLockError(
      'LOCK_OWNERSHIP_LOST',
      'Allocated append requires a lease for both the target registry and its allocation authority.',
    );
  }
  const stub = readFindingStub(stubPath);
  if (!stub) return 2;
  if (stub.id !== undefined) {
    process.stderr.write('Allocated add refuses a caller-supplied id; remove id from the stub.\n');
    return 2;
  }
  if (stub.severity === undefined) {
    process.stderr.write('Stub missing required field: severity\n');
    return 2;
  }

  const allocationSnapshot = readFindingWriterAllocationSnapshot(writerFence, lease);
  const entries = loadRegistry(paths.registryPath, paths.schemaPath);
  const reservationLedger = loadReservationLedger(authority.reservationPath);
  const existingIds = claimedIdsForDomain(domain, allocationSnapshot);
  const reserved = reservationLedger.domains[domain];
  if (reserved) {
    existingIds.push(`${domain}-RESERVED-${String(reserved.sequence).padStart(3, '0')}`);
  }
  let id: string;
  try {
    id = nextFindingId(domain, stub.severity, existingIds);
  } catch (error) {
    writeStderrLine(formatUnknownCliValue(error));
    return 2;
  }
  const newEntry = buildFinding(stub, id, repositoryAuthority.effectiveAt);
  if (!newEntry) return 2;
  return validateAndAppendFinding(
    newEntry,
    entries,
    lease,
    repositoryAuthority,
    writerFence,
    paths,
    () => {
      reserveFindingId(
        authority,
        reservationLedger,
        domain,
        id,
        paths.registryPath,
        lease,
        repositoryAuthority.effectiveAt,
        writerFence,
      );
    },
  );
}

function cmdClose(
  id: string,
  shortSha: string,
  lease: RegistryLockLease,
  repositoryAuthority: RepositoryMutationAuthority,
  writerFence: RedeemedFindingWriterFenceCapability,
): number {
  if (!/^[a-f0-9]{40}$/.test(shortSha)) {
    writeStderrLine(`Invalid SHA: ${shortSha} (expected a full lowercase main SHA).`);
    return 2;
  }

  // PROC-HIGH-001 structural guard (Round-2 cluster-0): the three-store
  // invariant requires every closing_commits SHA to exist in fetchable
  // history. A feature-branch SHA is GUARANTEED to be invalidated by
  // branch cleanup after merge (2026-06-10: 7 rows orphaned by #378,
  // repaired in #384; SEC-CRITICAL-002 / AUDIT-CRITICAL-006 recurrences
  // repaired in #380 / cluster-0). The ceremony therefore runs ONLY
  // post-merge, with a main-reachable commit whose own message carries
  // the matching Closes: trailer. Fail-closed — an unresolvable
  // origin/main (stale fetch, shallow clone) refuses with instructions
  // rather than certifying blind.
  // tier-1: runtime guard commitReachableFrom (git-reachability.ts) refuses branch-local closing SHAs at the only write path; CI invariant finding-registry-integrity.spec.ts enforces the stored chain
  const reachability = commitReachableFrom(REPO_ROOT, shortSha, 'origin/main');
  if (!reachability.ok) {
    // Preserve the CLI's error channel while refusing non-main evidence.
    process.stderr.write(`close refused: ${reachability.reason}\n`);
    return 1;
  }

  const entries = loadRegistry();
  const index = entries.findIndex((e) => e.id === id);
  if (index === -1) {
    writeStderrLine(`Finding not found: ${id}`);
    return 1;
  }

  const entry = entries[index];
  if (!entry) {
    writeStderrLine(`Finding at index ${index} is undefined — registry corruption?`);
    return 1;
  }

  const traceability = commitHasFindingCloseTrailer(REPO_ROOT, shortSha, id);
  if (!traceability.ok) {
    process.stderr.write(`close refused: ${traceability.reason}\n`);
    return 1;
  }

  if (entry.state === 'RESOLVED' && entry.closing_commits.includes(shortSha)) {
    writeStdoutLine(`No-op: ${id} is already RESOLVED with closing commit ${shortSha}.`);
    return 0;
  }

  entry.state = 'RESOLVED';
  entry.closed_at = entry.closed_at ?? repositoryAuthority.effectiveAt;
  if (!entry.closing_commits.includes(shortSha)) {
    entry.closing_commits = [...entry.closing_commits, shortSha];
  }

  // Rechain from mutated entry to tail; earlier entries unchanged.
  rechain(entries, index);

  const post = verify(entries);
  if (!post.ok) {
    writeStderrLine(`Post-close integrity check FAILED: ${post.reason}`);
    return 1;
  }

  writeRegistry(entries, lease, repositoryAuthority, writerFence, 'close');
  writeStdoutLine(`Closed: ${id} at position ${index} → state=RESOLVED, +commit ${shortSha}`);
  const tip = entries.length === 0 ? ZERO_HASH : (entries[entries.length - 1]?.content_hash ?? '');
  writeStdoutLine(`Chain tip: ${tip}`);
  return 0;
}

interface SweepConfig {
  readonly staleAfterDays: number;
  readonly dryRun: boolean;
  readonly now: Date;
}

interface SweepAction {
  readonly id: string;
  readonly fromState: Finding['state'];
  readonly toState: Finding['state'];
  readonly reason: string;
}

/**
 * Phase 6 state-sweep automation — runs daily in CI, transitions state
 * based on declarative rules:
 *
 *   * OPEN / IN-PROGRESS finding older than `staleAfterDays`
 *     (default 30) → STALE.
 *   * Any non-RESOLVED finding with `deadline` in the past → BLOCKED.
 *
 * Deterministic ordering: deadline check before staleness check so a
 * past-deadline STALE-candidate lands in BLOCKED (the stronger signal).
 *
 * --dry-run prints the proposed transitions WITHOUT mutating the
 * registry. The daily workflow opens a PR with the mutations so a
 * human reviews before merge — direct auto-commit would open a
 * tampering surface (bot push to main).
 */
function planSweep(entries: readonly Finding[], config: SweepConfig): SweepAction[] {
  const actions: SweepAction[] = [];
  const staleThresholdMs = config.staleAfterDays * 24 * 60 * 60 * 1000;

  for (const entry of entries) {
    if (entry.state === 'RESOLVED') continue;

    // Deadline check (stronger signal) runs first.
    if (entry.deadline) {
      const deadlineDate = new Date(entry.deadline);
      if (!Number.isNaN(deadlineDate.getTime()) && deadlineDate < config.now) {
        if (entry.state !== 'BLOCKED') {
          actions.push({
            id: entry.id,
            fromState: entry.state,
            toState: 'BLOCKED',
            reason: `past deadline ${entry.deadline}`,
          });
        }
        continue;
      }
    }

    // Staleness check (OPEN + IN-PROGRESS only, not BLOCKED/STALE).
    if (entry.state === 'OPEN' || entry.state === 'IN-PROGRESS') {
      const created = new Date(entry.created_at);
      if (Number.isNaN(created.getTime())) continue;
      const ageMs = config.now.getTime() - created.getTime();
      if (ageMs >= staleThresholdMs) {
        actions.push({
          id: entry.id,
          fromState: entry.state,
          toState: 'STALE',
          reason: `${Math.floor(ageMs / 86400000)} days old (threshold ${config.staleAfterDays})`,
        });
      }
    }
  }
  return actions;
}

function cmdSweep(
  args: string[],
  lease?: RegistryLockLease,
  repositoryAuthority?: RepositoryMutationAuthority,
  writerFence?: RedeemedFindingWriterFenceCapability,
): number {
  const dryRun = args.includes('--dry-run');
  const staleAfterDays = sweepStaleAfterDays(args);
  const effectiveAt =
    repositoryAuthority?.effectiveAt ??
    (process.env['FINDING_EFFECTIVE_AT'] ? canonicalEffectiveAt() : new Date().toISOString());

  const entries = loadRegistry();
  const actions = planSweep(entries, {
    staleAfterDays,
    dryRun,
    now: new Date(effectiveAt),
  });

  if (actions.length === 0) {
    writeStdoutLine(`Sweep clean: 0 transitions needed (${entries.length} entries scanned).`);
    return 0;
  }

  writeStdoutLine(`Sweep plan (${actions.length} transitions):`);
  for (const a of actions) {
    writeStdoutLine(`  ${a.id}: ${a.fromState} → ${a.toState}  (${a.reason})`);
  }

  if (dryRun) {
    writeStdoutLine();
    writeStdoutLine('--dry-run: no mutations written.');
    return 0;
  }
  if (!lease || !repositoryAuthority || !writerFence) {
    throw new Error(
      'Sweep mutation requires repository-global authority and a redeemed writer fence',
    );
  }

  // Apply transitions; earliest mutated entry anchors rechain scope.
  let minIndex = entries.length;
  for (const a of actions) {
    const i = entries.findIndex((e) => e.id === a.id);
    if (i === -1) continue;
    const entry = entries[i];
    if (!entry) continue;
    entry.state = a.toState;
    if (i < minIndex) minIndex = i;
  }
  rechain(entries, minIndex);

  const post = verify(entries);
  if (!post.ok) {
    writeStderrLine(`Post-sweep integrity check FAILED: ${post.reason}`);
    return 1;
  }

  writeRegistry(entries, lease, repositoryAuthority, writerFence, 'sweep');
  const tip = entries.length === 0 ? ZERO_HASH : (entries[entries.length - 1]?.content_hash ?? '');
  writeStdoutLine();
  writeStdoutLine(`Applied ${actions.length} transitions. Chain tip: ${tip}`);
  return 0;
}

function cmdExport(format: string): number {
  const entries = loadRegistry();
  if (format === 'json-array') {
    writeStdoutLine(canonicalJson(entries));
    return 0;
  }
  if (format === 'csv') {
    const cols = [
      'id',
      'severity',
      'state',
      'title',
      'owner_agent',
      'created_at',
      'closed_at',
      'closing_commits',
    ];
    writeStdoutLine(cols.join(','));
    for (const e of entries) {
      const row = cols.map((c) => {
        const v = (e as Record<string, unknown>)[c];
        const s = formatCsvValue(v);
        // CSV-escape: wrap in quotes if contains comma/quote/newline
        if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
      });
      writeStdoutLine(row.join(','));
    }
    return 0;
  }
  writeStderrLine(`Unknown export format: ${format} (supported: json-array, csv).`);
  return 2;
}

/**
 * `list` — tabular registry view filtered by state / severity / owner.
 *
 * Added in Phase 14 (docs/plans/2026-04-17-agentic-post-audit-consolidation-plan.md#14.1)
 * as the read-only dev-loop equivalent of `findings:list` / `findings:list:all`
 * npm scripts. Purely a query — does NOT mutate the registry or recompute
 * hashes. When no flags are passed, prints every entry.
 *
 * Flags:
 *   --state <CSV>    OPEN,IN-PROGRESS,RESOLVED,STALE,BLOCKED
 *   --severity <CSV> CRITICAL,HIGH,MEDIUM,LOW
 *   --owner <name>   owner_agent substring match
 *   --format <fmt>   table (default) | id-only | json
 *
 * Exit 0 always unless the registry itself is missing/malformed; absence
 * of matches is NOT an error (an empty OPEN list is a good result).
 */
function cmdList(args: readonly string[]): number {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    }
  }
  const entries = loadRegistry();
  const stateFilter =
    flags['state']
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? null;
  const sevFilter =
    flags['severity']
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? null;
  const ownerFilter = flags['owner'] ?? null;

  const matched = entries.filter((e) => {
    if (stateFilter && !stateFilter.includes(e.state)) return false;
    if (sevFilter && !sevFilter.includes(e.severity)) return false;
    if (ownerFilter && !e.owner_agent.includes(ownerFilter)) return false;
    return true;
  });

  const format = flags['format'] ?? 'table';
  if (format === 'id-only') {
    for (const e of matched) writeStdoutLine(e.id);
    return 0;
  }
  if (format === 'json') {
    writeStdoutLine(canonicalJson(matched));
    return 0;
  }
  // table (default)
  if (matched.length === 0) {
    const criteria =
      [
        stateFilter ? `state=${stateFilter.join(',')}` : null,
        sevFilter ? `severity=${sevFilter.join(',')}` : null,
        ownerFilter ? `owner=${ownerFilter}` : null,
      ]
        .filter(Boolean)
        .join(' ') || 'all';
    writeStdoutLine(`(no findings matched: ${criteria})`);
    return 0;
  }
  const header = ['ID', 'SEV', 'STATE', 'OWNER', 'TITLE'];
  const rows = matched.map((e) => [
    e.id,
    e.severity,
    e.state,
    e.owner_agent,
    e.title.length > 60 ? e.title.slice(0, 57) + '...' : e.title,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmtRow = (r: readonly string[]): string =>
    r.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  writeStdoutLine(fmtRow(header));
  writeStdoutLine(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) writeStdoutLine(fmtRow(r));
  writeStdoutLine(`\n${matched.length} / ${entries.length} entries matched.`);
  return 0;
}

async function main(): Promise<void> {
  const commandArguments = process.argv.slice(2);
  const requestedOperation = commandArguments[0];
  const args = commandArguments.slice(1);
  if (!requestedOperation) {
    const operations = findingWriterCliOperationNames('tools/gates/finding-registry.ts');
    writeStderrLine(`Usage: finding-registry <${operations.join('|')}> [args]`);
    writeStderrLine('  verify');
    writeStderrLine('  writer-preflight');
    writeStderrLine('  request-digest <add|close|sweep> [operation args]');
    writeStderrLine('  add <domain> <stub.json>  — atomically allocate id + append');
    writeStderrLine('  close <finding-id> <full-main-sha>');
    writeStderrLine('  sweep [--dry-run] [--stale-after=<days>]');
    writeStderrLine('  export <json-array|csv>');
    writeStderrLine(
      '  list [--state <CSV>] [--severity <CSV>] [--owner <name>] [--format table|id-only|json]',
    );
    process.exit(2);
  }
  const sub = admitFindingWriterCliInvocation(
    'tools/gates/finding-registry.ts',
    commandArguments,
  ).operation;

  let exitCode = 0;
  if (sub === 'verify') {
    exitCode = cmdVerify();
  } else if (sub === 'writer-preflight') {
    exitCode = await cmdWriterPreflight();
  } else if (sub === 'request-digest') {
    const operation = args[0];
    if (!isFindingWriterRegistryMutationOperation(operation)) {
      writeStderrLine('request-digest requires one of: add, close, sweep');
      process.exit(2);
    }
    process.stdout.write(`${mutationInputSha256(operation, args.slice(1))}\n`);
    exitCode = 0;
  } else if (sub === 'add') {
    const domain = args[0];
    const stubPath = args[1];
    if (!domain || !stubPath) {
      writeStderrLine('add requires domain and stub: finding-registry add <DOMAIN> <stub.json>');
      process.exit(2);
    }
    const inputSha256 = mutationInputSha256('add', [domain, stubPath]);
    exitCode = await runRegistryMutation(
      'add',
      inputSha256,
      (lease, authority, repositoryAuthority, writerFence) =>
        appendAllocatedFinding(
          domain,
          resolve(stubPath),
          lease,
          repositoryAuthority,
          writerFence,
          authority,
          DEFAULT_REGISTRY_PATHS,
        ),
    );
  } else if (sub === 'close') {
    const id = args[0];
    const sha = args[1];
    if (!id || !sha) {
      writeStderrLine('close requires id and sha: finding-registry close <id> <sha>');
      process.exit(2);
    }
    const inputSha256 = mutationInputSha256('close', [id, sha]);
    exitCode = await runRegistryMutation(
      'close',
      inputSha256,
      (lease, _authority, repositoryAuthority, writerFence) =>
        cmdClose(id, sha, lease, repositoryAuthority, writerFence),
    );
  } else if (sub === 'export') {
    const format = args[0];
    if (!format) {
      writeStderrLine('export requires a format: finding-registry export <json-array|csv>');
      process.exit(2);
    }
    exitCode = cmdExport(format);
  } else if (sub === 'sweep') {
    exitCode = args.includes('--dry-run')
      ? cmdSweep(args)
      : await runRegistryMutation(
          'sweep',
          mutationInputSha256('sweep', args),
          (lease, _authority, repositoryAuthority, writerFence) =>
            cmdSweep(args, lease, repositoryAuthority, writerFence),
        );
  } else if (sub === 'list') {
    exitCode = cmdList(args);
  } else {
    writeStderrLine(`Unknown subcommand: ${sub}`);
    process.exit(2);
  }

  process.exit(exitCode);
}

async function runRegistryMutation(
  operation: RegistryMutationOperation,
  inputSha256: string,
  action: (
    lease: RegistryLockLease,
    authority: FindingAllocationAuthority,
    repositoryAuthority: RepositoryMutationAuthority,
    writerFence: RedeemedFindingWriterFenceCapability,
  ) => number,
): Promise<number> {
  try {
    const repositoryAuthority = await acquireRepositoryMutationAuthority(operation);
    if (repositoryAuthority.inputSha256 !== inputSha256) {
      throw new Error(
        `Trusted workflow input digest ${repositoryAuthority.inputSha256} differs from CLI digest ${inputSha256}`,
      );
    }
    const priorCommand = committedMutationCommand(repositoryAuthority.commandId);
    if (priorCommand) {
      if (priorCommand.operation !== operation || priorCommand.inputSha256 !== inputSha256) {
        throw new Error(
          `Automation command ${repositoryAuthority.commandId} was already committed with different semantics at ${priorCommand.commitSha}`,
        );
      }
      process.stdout.write(
        `No-op: automation command ${repositoryAuthority.commandId} already committed at ${priorCommand.commitSha}.\n`,
      );
      return 0;
    }
    process.stdout.write(
      `Repository mutation authority: ${repositoryAuthority.workflowRef} run ${repositoryAuthority.runId}/${repositoryAuthority.runAttempt} at ${repositoryAuthority.workflowSha}\n`,
    );
    const authority = resolveGitFindingAllocationAuthority(REPO_ROOT);
    return runWithPreparedFindingWriterFenceAdmission({
      resourcePath: REGISTRY_PATH,
      lockPath: authority.lockPath,
      prepareSnapshot: (signal) => authority.assertCompatibleWriters(signal),
      admit: async (snapshot, lease, signal) => {
        const capability = await authority.consumeCompatibleWriters(snapshot, signal);
        return authority.redeemCompatibleWriters(
          capability,
          lease,
          {
            kind: 'REGISTRY_MUTATION',
            operation,
            repositoryAuthority,
          },
          signal,
        );
      },
      run: (writerFence, lease) => {
        try {
          recoverRegistryMutationStaging(
            authority,
            lease,
            writerFence,
            repositoryAuthority,
            operation,
          );
          return action(lease, authority, repositoryAuthority, writerFence);
        } finally {
          authority.releaseCompatibleWriters(writerFence);
        }
      },
    });
  } catch (error) {
    if (error instanceof RegistryLockError) {
      process.stderr.write(`Registry mutation refused [${error.code}]: ${error.message}\n`);
      return 1;
    }
    process.stderr.write(
      `Registry mutation authority failed closed: ${formatUnknownCliValue(error)}\n`,
    );
    return 1;
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`Registry command failed closed: ${formatUnknownCliValue(error)}\n`);
    process.exitCode = 1;
  });
}
