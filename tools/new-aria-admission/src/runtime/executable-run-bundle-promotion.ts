import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';

import { boundedDirectoryEntryNames } from '../adapters/bounded-directory-entries';
import { assertVerifiedExecutableRunBundle } from './executable-run-bundle-verifier';
import type { VerifiedExecutableRunBundle } from './executable-run-bundle-verifier';
import {
  bindOwnerControlledDirectory,
  verifyOwnerControlledDirectory,
} from './publication-directory-guard';

const descriptorPath = (descriptor: number): string => `/proc/self/fd/${descriptor}`;
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function closeIgnoringFailure(descriptor: number): void {
  if (descriptor < 0) return;
  try {
    closeSync(descriptor);
  } catch {
    // Promotion preserves the originating verification failure.
  }
}

function readCandidate(rootFd: number): Buffer {
  const descriptor = openSync(
    join(descriptorPath(rootFd), 'CANDIDATE.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = fstatSync(descriptor);
    const effectiveUser = process.geteuid?.();
    if (
      effectiveUser === undefined ||
      !before.isFile() ||
      before.uid !== effectiveUser ||
      before.nlink !== 1 ||
      (before.mode & 0o777) !== 0o600 ||
      before.size < 2 ||
      before.size > 256 * 1024
    )
      throw new TypeError('staged run bundle marker metadata is invalid');
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      bytes.byteLength !== after.size
    )
      throw new TypeError('staged run bundle marker changed while it was read');
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export function promoteStagedExecutableRunBundle(
  bundlePath: string,
  verifiedBundle: VerifiedExecutableRunBundle,
): void {
  assertVerifiedExecutableRunBundle(verifiedBundle);
  if (!isAbsolute(bundlePath) || normalize(bundlePath) !== bundlePath) {
    throw new TypeError('staged run bundle path must be absolute and canonical');
  }
  const parentPath = dirname(bundlePath);
  const rootName = basename(bundlePath);
  let parentFd = -1;
  let rootFd = -1;
  try {
    parentFd = openSync(
      parentPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const parentBinding = bindOwnerControlledDirectory(parentPath, parentFd);
    rootFd = openSync(
      join(descriptorPath(parentFd), rootName),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const rootBinding = bindOwnerControlledDirectory(bundlePath, rootFd);
    const entries = [
      ...boundedDirectoryEntryNames(descriptorPath(rootFd), 2, 'run bundle root'),
    ].sort();
    if (
      entries.length !== 2 ||
      entries[0] !== 'CANDIDATE.json' ||
      entries[1] !== 'payload' ||
      digest(readCandidate(rootFd)) !== verifiedBundle.bundle_sha256
    )
      throw new TypeError('staged run bundle does not match verified candidate');
    renameSync(
      join(descriptorPath(rootFd), 'CANDIDATE.json'),
      join(descriptorPath(rootFd), 'COMPLETE.json'),
    );
    fsyncSync(rootFd);
    fsyncSync(parentFd);
    verifyOwnerControlledDirectory(bundlePath, rootFd, rootBinding);
    verifyOwnerControlledDirectory(parentPath, parentFd, parentBinding);
  } finally {
    closeIgnoringFailure(rootFd);
    closeIgnoringFailure(parentFd);
  }
}
