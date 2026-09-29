import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';

import {
  canonicalOutputPendingName,
  recoverOrVerifyCanonicalOutput,
} from './canonical-output-recovery';

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;

function canonicalPath(path: string, label: string): void {
  if (!isAbsolute(path) || normalize(path) !== path) {
    throw new TypeError(`${label} must be an absolute canonical path`);
  }
}

function byteLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('canonical file byte limit must be a positive safe integer');
  }
  return value;
}

function sameFile(
  left: ReturnType<typeof fstatSync>,
  right: ReturnType<typeof fstatSync>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function effectiveUserId(): number {
  const value = process.geteuid?.();
  if (value === undefined) throw new TypeError('output parent ownership inspection is unavailable');
  return value;
}

function verifyDirectoryIdentity(path: string, descriptor: number, owner: number): void {
  const held = fstatSync(descriptor);
  const visible = lstatSync(path);
  if (
    !held.isDirectory() ||
    !visible.isDirectory() ||
    visible.isSymbolicLink() ||
    held.uid !== owner ||
    visible.uid !== owner ||
    (held.mode & 0o022) !== 0 ||
    (visible.mode & 0o022) !== 0 ||
    held.mode !== visible.mode ||
    held.nlink < 1 ||
    held.dev !== visible.dev ||
    held.ino !== visible.ino ||
    realpathSync(path) !== path
  ) {
    throw new TypeError('output parent is not owner-controlled or changed identity');
  }
}

function readBounded(descriptor: number, maximumBytes: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const remaining = maximumBytes + 1 - total;
    if (remaining <= 0) throw new TypeError('canonical file exceeds byte limit');
    const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, remaining));
    const count = readSync(descriptor, chunk, 0, chunk.length, null);
    if (count === 0) return Buffer.concat(chunks, total);
    chunks.push(chunk.subarray(0, count));
    total += count;
    if (total > maximumBytes) throw new TypeError('canonical file exceeds byte limit');
  }
}

export function readCanonicalFile(
  path: string,
  label: string,
  maximumBytes = DEFAULT_MAX_BYTES,
): Buffer {
  canonicalPath(path, label);
  const limit = byteLimit(maximumBytes);
  if (realpathSync(path) !== path || lstatSync(path).isSymbolicLink()) {
    throw new TypeError(`${label} must identify a canonical regular file`);
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new TypeError(`${label} must identify a canonical regular file`);
    if (before.size > limit) throw new TypeError(`${label} exceeds byte limit`);
    const bytes = readBounded(descriptor, limit);
    const after = fstatSync(descriptor);
    const current = statSync(path);
    if (
      !sameFile(before, after) ||
      !sameFile(after, current) ||
      bytes.byteLength !== after.size ||
      realpathSync(path) !== path
    ) {
      throw new TypeError(`${label} changed during its immutable read`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export function writeNewCanonicalFile(path: string, bytes: Uint8Array): void {
  canonicalPath(path, 'output path');
  const parent = dirname(path);
  if (realpathSync(parent) !== parent || !statSync(parent).isDirectory()) {
    throw new TypeError('output parent must be a canonical directory');
  }
  const outputName = basename(path);
  if (outputName.length === 0) throw new TypeError('output file name is invalid');
  const parentFd = openSync(
    parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const parentDescriptor = `/proc/self/fd/${parentFd.toString()}`;
  const owner = effectiveUserId();
  const temporaryName = canonicalOutputPendingName(outputName, bytes);
  const temporaryPath = join(parentDescriptor, temporaryName);
  const outputPath = join(parentDescriptor, outputName);
  let temporaryExists = false;
  let outputExists = false;
  try {
    verifyDirectoryIdentity(parent, parentFd, owner);
    const descriptor = openSync(temporaryPath, 'wx', 0o600);
    temporaryExists = true;
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    verifyDirectoryIdentity(parent, parentFd, owner);
    linkSync(temporaryPath, outputPath);
    outputExists = true;
    fsyncSync(parentFd);
    verifyDirectoryIdentity(parent, parentFd, owner);
    unlinkSync(temporaryPath);
    temporaryExists = false;
    fsyncSync(parentFd);
    verifyDirectoryIdentity(parent, parentFd, owner);
    outputExists = false;
  } finally {
    if (outputExists) {
      try {
        unlinkSync(outputPath);
      } catch {
        // Preserve the publication failure while attempting bounded cleanup.
      }
    }
    if (temporaryExists) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Preserve the publication failure while attempting bounded cleanup.
      }
    }
    try {
      fsyncSync(parentFd);
    } catch {
      // The primary publication error remains authoritative.
    }
    closeSync(parentFd);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST';
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

export function assertCanonicalOutputAvailable(path: string, expectedBytes: Uint8Array): void {
  canonicalPath(path, 'output path');
  const expected = Buffer.from(expectedBytes);
  if (expected.byteLength < 1) throw new TypeError('canonical output cannot be empty');
  const parent = dirname(path);
  const parentFd = openSync(
    parent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    verifyDirectoryIdentity(parent, parentFd, effectiveUserId());
    try {
      lstatSync(join(`/proc/self/fd/${parentFd.toString()}`, basename(path)));
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  } finally {
    closeSync(parentFd);
  }
  if (recoverOrVerifyCanonicalOutput(path, expected) !== 'VERIFIED') {
    throw new TypeError('existing canonical output differs from expected bytes');
  }
}

export function writeNewOrVerifyCanonicalFile(path: string, bytes: Uint8Array): void {
  const expected = Buffer.from(bytes);
  if (expected.byteLength < 1) throw new TypeError('canonical output cannot be empty');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeNewCanonicalFile(path, expected);
      return;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (recoverOrVerifyCanonicalOutput(path, expected) === 'VERIFIED') return;
    }
  }
  throw new TypeError('canonical output recovery could not publish exact bytes');
}
