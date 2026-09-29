import { createHash, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  bindOwnerControlledDirectory,
  verifyOwnerControlledDirectory,
} from './publication-directory-guard';

const descriptorPath = (descriptor: number): string => `/proc/self/fd/${descriptor}`;

export function canonicalOutputPendingName(outputName: string, bytes: Uint8Array): string {
  const digest = createHash('sha256')
    .update(Buffer.from(outputName))
    .update(Buffer.from([0]))
    .update(bytes)
    .digest('hex');
  return `.new-aria-output-${digest}.pending`;
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function openOptional(path: string): number | undefined {
  try {
    return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function readExact(descriptor: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(descriptor, bytes, offset, length - offset, offset);
    if (count === 0) throw new TypeError('canonical output ended before its declared size');
    offset += count;
  }
  return bytes;
}

function assertOwnedFile(
  metadata: Stats,
  owner: number,
  allowedLinks: 1 | 2,
): void {
  if (
    !metadata.isFile() ||
    metadata.uid !== owner ||
    (metadata.mode & 0o777) !== 0o600 ||
    metadata.nlink !== allowedLinks
  )
    throw new TypeError('existing canonical output ownership or mode is invalid');
}

function sameStableFile(
  before: Stats,
  after: Stats,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mode === after.mode &&
    before.uid === after.uid &&
    before.nlink === after.nlink &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function assertExactBytes(descriptor: number, expected: Buffer): Stats {
  const before = fstatSync(descriptor);
  if (before.size !== expected.byteLength) {
    throw new TypeError('existing canonical output differs from admitted bytes');
  }
  const bytes = readExact(descriptor, expected.byteLength);
  const after = fstatSync(descriptor);
  if (!sameStableFile(before, after) || !timingSafeEqual(bytes, expected)) {
    throw new TypeError('existing canonical output differs from admitted bytes');
  }
  return after;
}

export type CanonicalOutputRecovery = 'RETRY' | 'VERIFIED';

export function recoverOrVerifyCanonicalOutput(
  path: string,
  expected: Buffer,
): CanonicalOutputRecovery {
  const parentPath = dirname(path);
  const outputName = basename(path);
  const parentFd = openSync(
    parentPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const binding = bindOwnerControlledDirectory(parentPath, parentFd);
  const owner = binding.owner;
  const root = descriptorPath(parentFd);
  let outputFd: number | undefined;
  let pendingFd: number | undefined;
  try {
    outputFd = openOptional(join(root, outputName));
    pendingFd = openOptional(join(root, canonicalOutputPendingName(outputName, expected)));
    if (outputFd === undefined) {
      if (pendingFd === undefined) throw new TypeError('canonical output recovery state is absent');
      assertOwnedFile(fstatSync(pendingFd), owner, 1);
      assertExactBytes(pendingFd, expected);
      closeSync(pendingFd);
      pendingFd = undefined;
      unlinkSync(join(root, canonicalOutputPendingName(outputName, expected)));
      fsyncSync(parentFd);
      verifyOwnerControlledDirectory(parentPath, parentFd, binding);
      return 'RETRY';
    }
    const output = fstatSync(outputFd);
    assertOwnedFile(output, owner, output.nlink === 2 ? 2 : 1);
    const stableOutput = assertExactBytes(outputFd, expected);
    if (stableOutput.nlink === 2) {
      if (pendingFd === undefined) {
        throw new TypeError('existing canonical output ownership has an external hard-link alias');
      }
      const pending = fstatSync(pendingFd);
      assertOwnedFile(pending, owner, 2);
      if (pending.dev !== stableOutput.dev || pending.ino !== stableOutput.ino) {
        throw new TypeError('canonical output pending link has a different identity');
      }
      closeSync(pendingFd);
      pendingFd = undefined;
      unlinkSync(join(root, canonicalOutputPendingName(outputName, expected)));
      fsyncSync(parentFd);
      assertOwnedFile(fstatSync(outputFd), owner, 1);
    } else if (pendingFd !== undefined) {
      assertOwnedFile(fstatSync(pendingFd), owner, 1);
      assertExactBytes(pendingFd, expected);
      closeSync(pendingFd);
      pendingFd = undefined;
      unlinkSync(join(root, canonicalOutputPendingName(outputName, expected)));
      fsyncSync(parentFd);
    }
    const visible = lstatSync(join(root, outputName));
    const finalOutput = fstatSync(outputFd);
    assertExactBytes(outputFd, expected);
    verifyOwnerControlledDirectory(parentPath, parentFd, binding);
    if (visible.isSymbolicLink() || !sameStableFile(finalOutput, visible)) {
      throw new TypeError('existing canonical output changed during immutable read');
    }
    return 'VERIFIED';
  } finally {
    if (pendingFd !== undefined) closeSync(pendingFd);
    if (outputFd !== undefined) closeSync(outputFd);
    closeSync(parentFd);
  }
}
