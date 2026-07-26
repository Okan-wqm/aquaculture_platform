import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';

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
}

type RegistryLockErrorCode =
  | 'LOCK_TIMEOUT'
  | 'LOCK_MALFORMED'
  | 'LOCK_FOREIGN_HOST'
  | 'LOCK_OWNERSHIP_LOST';

interface LockRecord {
  readonly version: 1;
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
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
    record.version !== 1 ||
    typeof record.token !== 'string' ||
    record.token.length === 0 ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid ?? 0) <= 0 ||
    typeof record.hostname !== 'string' ||
    record.hostname.length === 0 ||
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return false;
    // EPERM means the process exists but this user cannot signal it.
    return true;
  }
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

  for (;;) {
    const token = randomUUID();
    const record: LockRecord = {
      version: 1,
      token,
      pid: process.pid,
      hostname: localHostname,
      acquired_at: new Date().toISOString(),
      resource_path: resourcePath,
    };

    try {
      writeLockRecord(lockPath, record);
      return { lockPath, resourcePath, token };
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
      if (!processIsAlive(owner.pid) && quarantineDeadLock(lockPath, owner)) {
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
    record.hostname !== hostname()
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
    moved.hostname !== hostname()
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
  const lease = acquireRegistryLock(resourcePath, lockPath, options);
  let result: T | undefined;
  let actionFailed = false;
  let actionError: unknown;
  try {
    result = action(lease);
  } catch (error) {
    actionFailed = true;
    actionError = error;
  }

  let releaseFailed = false;
  let releaseError: unknown;
  try {
    releaseRegistryLock(lease);
  } catch (error) {
    releaseFailed = true;
    releaseError = error;
  }

  if (actionFailed) {
    if (actionError instanceof Error) throw actionError;
    throw errorWithCause('Registry action threw a non-Error value.', actionError);
  }
  if (releaseFailed) {
    if (releaseError instanceof Error) throw releaseError;
    throw errorWithCause('Registry lock release threw a non-Error value.', releaseError);
  }
  return result as T;
}

export function atomicWriteFileWithRegistryLease(
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

export function atomicWriteRegistryFile(
  resourcePath: string,
  content: string,
  lease: RegistryLockLease,
): void {
  if (lease.resourcePath !== resourcePath) {
    throw new RegistryLockError(
      'LOCK_OWNERSHIP_LOST',
      `Registry lease does not fence the requested resource: ${resourcePath}`,
    );
  }
  atomicWriteFileWithRegistryLease(resourcePath, content, lease);
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

export function nextFindingId(
  domain: string,
  severity: FindingSeverity,
  existingIds: readonly string[],
): string {
  if (!/^[A-Z][A-Z0-9]*$/.test(domain)) {
    throw new TypeError(`Finding domain must be uppercase alphanumeric: ${domain}`);
  }
  if (!['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(severity)) {
    throw new TypeError(`Unsupported finding severity: ${severity}`);
  }

  const domainPattern = new RegExp(`^${domain}-[A-Z0-9]+-([0-9]{3})$`);
  let maximum = 0;
  for (const id of existingIds) {
    const match = domainPattern.exec(id);
    if (!match?.[1]) continue;
    maximum = Math.max(maximum, Number.parseInt(match[1], 10));
  }

  const next = maximum + 1;
  if (next > 999) {
    throw new RangeError(`Finding ID space exhausted for domain ${domain} (maximum 999).`);
  }
  return `${domain}-${severity}-${String(next).padStart(3, '0')}`;
}
