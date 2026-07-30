import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, normalize, sep } from 'node:path';

import {
  assertRepositoryMutationAuthority,
  type RegistryMutationOperation,
  type RepositoryMutationAuthority,
} from './github-actions-oidc-authority';

export type FindingSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface RegistryLockOptions {
  readonly timeoutMs: number;
  readonly staleAfterMs: number;
  readonly pollIntervalMs: number;
  readonly lockPath?: string;
}

export interface RegistryLockLease {
  readonly lockPath: string;
  readonly resourcePath: string;
  readonly token: string;
  readonly bootId: string;
  readonly processStartTicks: string;
}

type RegistryLockErrorCode =
  | 'LOCK_TIMEOUT'
  | 'LOCK_MALFORMED'
  | 'LOCK_FOREIGN_HOST'
  | 'LOCK_OWNERSHIP_LOST';

interface LockRecord {
  readonly version: 2;
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly boot_id: string;
  readonly process_start_ticks: string;
  readonly acquired_at: string;
  readonly resource_path: string;
}

interface LockSnapshot {
  readonly record: LockRecord | null;
  readonly ageMs: number;
}

const DEFAULT_LOCK_OPTIONS: RegistryLockOptions = {
  timeoutMs: 5_000,
  staleAfterMs: 30_000,
  pollIntervalMs: 25,
};
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROCESS_START_TICKS_PATTERN = /^[1-9]\d*$/;
const ATOMIC_WRITE_STAGING_PATTERN =
  /^\.(?<basename>.+)\.(?<pid>[1-9]\d*)\.(?<token>[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.new$/;

interface AtomicWriteStagingFile {
  readonly name: string;
  readonly path: string;
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

function parseLockRecord(raw: string): LockRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const record = value as Partial<LockRecord>;
  if (
    record.version !== 2 ||
    typeof record.token !== 'string' ||
    record.token.length === 0 ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid ?? 0) <= 0 ||
    typeof record.hostname !== 'string' ||
    record.hostname.length === 0 ||
    typeof record.boot_id !== 'string' ||
    !BOOT_ID_PATTERN.test(record.boot_id) ||
    typeof record.process_start_ticks !== 'string' ||
    !PROCESS_START_TICKS_PATTERN.test(record.process_start_ticks) ||
    typeof record.acquired_at !== 'string' ||
    !Number.isFinite(Date.parse(record.acquired_at)) ||
    typeof record.resource_path !== 'string' ||
    record.resource_path.length === 0
  ) {
    return null;
  }
  return record as LockRecord;
}

function readLockSnapshot(lockPath: string, nowMs: number): LockSnapshot {
  const stats = statSync(lockPath);
  const raw = readFileSync(lockPath, 'utf8');
  return {
    record: parseLockRecord(raw),
    ageMs: Math.max(0, nowMs - stats.mtimeMs),
  };
}

interface ProcessIdentity {
  readonly bootId: string;
  readonly processStartTicks: string;
}

function readBootId(): string {
  const bootId = readFileSync(BOOT_ID_PATH, 'utf8').trim().toLowerCase();
  if (!BOOT_ID_PATTERN.test(bootId)) {
    throw new Error(`${BOOT_ID_PATH} returned an invalid Linux boot identity`);
  }
  return bootId;
}

function readProcessStartTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd <= 1 || stat[commandEnd + 1] !== ' ') {
      throw new Error(`/proc/${pid}/stat has an invalid process record`);
    }
    const fieldsFromState = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
    const startTicks = fieldsFromState[19];
    if (!startTicks || !PROCESS_START_TICKS_PATTERN.test(startTicks)) {
      throw new Error(`/proc/${pid}/stat has an invalid start-time identity`);
    }
    return startTicks;
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ESRCH')) return null;
    throw error;
  }
}

function currentProcessIdentity(): ProcessIdentity {
  const processStartTicks = readProcessStartTicks(process.pid);
  if (processStartTicks === null) {
    throw new Error(`Current process ${process.pid} disappeared during lock acquisition`);
  }
  return { bootId: readBootId(), processStartTicks };
}

function lockOwnerStillExists(record: LockRecord, localBootId: string): boolean {
  if (record.boot_id !== localBootId) return false;
  const observedStartTicks = readProcessStartTicks(record.pid);
  return observedStartTicks === record.process_start_ticks;
}

function writeLockRecord(lockPath: string, record: LockRecord): void {
  const fd = openSync(lockPath, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
    fsyncSync(fd);
  } catch (error) {
    // This process created the O_EXCL pathname and has not returned a
    // lease, so no peer can legitimately own it yet.
    unlinkSync(lockPath);
    throw error;
  } finally {
    closeSync(fd);
  }
}

function quarantineDeadLock(lockPath: string, expected: LockRecord): boolean {
  const quarantinePath = `${lockPath}.${randomUUID()}.stale`;
  try {
    renameSync(lockPath, quarantinePath);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }

  const moved = parseLockRecord(readFileSync(quarantinePath, 'utf8'));
  if (moved?.token !== expected.token) {
    // The pathname changed between observation and rename. Restore the
    // record only when no successor owns the canonical lock pathname.
    if (!existsSync(lockPath)) renameSync(quarantinePath, lockPath);
    throw new RegistryLockError(
      'LOCK_OWNERSHIP_LOST',
      `Registry lock changed during stale-lock takeover: ${lockPath}`,
    );
  }
  unlinkSync(quarantinePath);
  return true;
}

function acquireRegistryLock(
  resourcePath: string,
  lockPath: string,
  options: RegistryLockOptions,
): RegistryLockLease {
  const deadlineMs = Date.now() + options.timeoutMs;
  const localHostname = hostname();
  const processIdentity = currentProcessIdentity();

  for (;;) {
    const token = randomUUID();
    const record: LockRecord = {
      version: 2,
      token,
      pid: process.pid,
      hostname: localHostname,
      boot_id: processIdentity.bootId,
      process_start_ticks: processIdentity.processStartTicks,
      acquired_at: new Date().toISOString(),
      resource_path: resourcePath,
    };

    try {
      writeLockRecord(lockPath, record);
      return {
        lockPath,
        resourcePath,
        token,
        bootId: processIdentity.bootId,
        processStartTicks: processIdentity.processStartTicks,
      };
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;
    }

    const nowMs = Date.now();
    let snapshot: LockSnapshot;
    try {
      snapshot = readLockSnapshot(lockPath, nowMs);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue;
      throw error;
    }

    if (snapshot.ageMs >= options.staleAfterMs) {
      const owner = snapshot.record;
      if (!owner) {
        throw new RegistryLockError(
          'LOCK_MALFORMED',
          `Stale registry lock is malformed and cannot be taken over safely: ${lockPath}`,
        );
      }
      if (owner.hostname !== localHostname) {
        throw new RegistryLockError(
          'LOCK_FOREIGN_HOST',
          `Stale registry lock belongs to host ${owner.hostname}; refusing cross-host takeover: ${lockPath}`,
        );
      }
      if (
        !lockOwnerStillExists(owner, processIdentity.bootId) &&
        quarantineDeadLock(lockPath, owner)
      ) {
        continue;
      }
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
}

export function assertRegistryLockOwned(lease: RegistryLockLease): void {
  let record: LockRecord | null = null;
  try {
    record = parseLockRecord(readFileSync(lease.lockPath, 'utf8'));
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  if (
    record?.token !== lease.token ||
    record.resource_path !== lease.resourcePath ||
    record.pid !== process.pid ||
    record.hostname !== hostname() ||
    record.boot_id !== lease.bootId ||
    record.process_start_ticks !== lease.processStartTicks
  ) {
    throw new RegistryLockError(
      'LOCK_OWNERSHIP_LOST',
      `Registry lock ownership was lost before mutation: ${lease.lockPath}`,
    );
  }
}

function releaseRegistryLock(lease: RegistryLockLease): void {
  assertRegistryLockOwned(lease);
  const releasePath = `${lease.lockPath}.${randomUUID()}.release`;
  renameSync(lease.lockPath, releasePath);

  const moved = parseLockRecord(readFileSync(releasePath, 'utf8'));
  if (
    moved?.token !== lease.token ||
    moved.resource_path !== lease.resourcePath ||
    moved.pid !== process.pid ||
    moved.hostname !== hostname() ||
    moved.boot_id !== lease.bootId ||
    moved.process_start_ticks !== lease.processStartTicks
  ) {
    if (!existsSync(lease.lockPath)) renameSync(releasePath, lease.lockPath);
    throw new RegistryLockError(
      'LOCK_OWNERSHIP_LOST',
      `Registry lock changed during release: ${lease.lockPath}`,
    );
  }
  unlinkSync(releasePath);
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
    !Number.isSafeInteger(options.staleAfterMs) ||
    options.staleAfterMs <= 0 ||
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

const FINDING_REGISTRY_PATH_SUFFIX = ['docs', 'reviews', '_registry', 'findings.jsonl'].join(sep);

function isCanonicalFindingRegistryPath(filePath: string): boolean {
  const normalizedPath = normalize(filePath);
  return (
    normalizedPath === FINDING_REGISTRY_PATH_SUFFIX ||
    normalizedPath.endsWith(`${sep}${FINDING_REGISTRY_PATH_SUFFIX}`)
  );
}

function atomicWriteFileWithRegistryLeaseUnchecked(
  filePath: string,
  content: string,
  lease: RegistryLockLease,
): void {
  assertRegistryLockOwned(lease);

  const parentPath = dirname(filePath);
  const stagingPath = join(parentPath, `.${basename(filePath)}.${process.pid}.${lease.token}.new`);
  let stagingExists = false;
  try {
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
    renameSync(stagingPath, filePath);
    stagingExists = false;

    const parentFd = openSync(parentPath, 'r');
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
  } finally {
    if (stagingExists && existsSync(stagingPath)) unlinkSync(stagingPath);
  }
}

export function atomicWriteFileWithRegistryLease(
  filePath: string,
  content: string,
  lease: RegistryLockLease,
): void {
  if (isCanonicalFindingRegistryPath(filePath)) {
    throw new Error('Canonical finding registry writes require repository-global OIDC authority.');
  }
  atomicWriteFileWithRegistryLeaseUnchecked(filePath, content, lease);
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
    stagingFiles.push({ name: entry.name, path: stagingPath, pid, token });
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

export function recoverAtomicWriteStagingFiles(
  parentPath: string,
  isGovernedBasename: (basename: string) => boolean,
  lease: RegistryLockLease,
  minimumAgeMs: number,
): string[] {
  if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs <= 0) {
    throw new TypeError('Atomic staging recovery age must be a positive safe integer.');
  }
  assertRegistryLockOwned(lease);
  const recovered: string[] = [];
  for (const stagingFile of governedAtomicWriteStagingFiles(parentPath, isGovernedBasename)) {
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
    assertRegistryLockOwned(lease);
    unlinkSync(stagingFile.path);
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

export function atomicWriteRegistryFile(
  resourcePath: string,
  content: string,
  lease: RegistryLockLease,
  repositoryAuthority: RepositoryMutationAuthority,
  operation: RegistryMutationOperation,
): void {
  assertRepositoryMutationAuthority(repositoryAuthority, operation);
  if (lease.resourcePath !== resourcePath) {
    throw new RegistryLockError(
      'LOCK_OWNERSHIP_LOST',
      `Registry lease does not fence the requested resource: ${resourcePath}`,
    );
  }
  atomicWriteFileWithRegistryLeaseUnchecked(resourcePath, content, lease);
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

/** Reads the markdown orphan store. Missing file is empty, not an error. */
export function readOrphanMarkdownStore(path: string): OrphanMarkdownStore {
  const ids = new Set<string>();
  const sequences = new Set<number>();
  if (!existsSync(path)) return { ids, sequences };
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = ORPHAN_MD_HEADING_REGEX.exec(line);
    if (!match?.[1] || !match[2]) continue;
    ids.add(match[1]);
    sequences.add(Number.parseInt(match[2], 10));
  }
  return { ids, sequences };
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
  return [...readOrphanMarkdownStore(path).sequences].map(
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
