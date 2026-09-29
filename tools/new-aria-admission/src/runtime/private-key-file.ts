import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, normalize } from 'node:path';

import type { Stats } from 'node:fs';

const MAX_PRIVATE_KEY_BYTES = 4_096;

type FileIdentity = Stats;

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
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

function sameDirectory(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function effectiveUserId(): number {
  const id = process.geteuid?.();
  if (id === undefined) throw new TypeError('private key ownership inspection is unavailable');
  return id;
}

function readExact(descriptor: number, byteLength: number): Buffer {
  const bytes = Buffer.allocUnsafe(byteLength);
  try {
    let offset = 0;
    while (offset < byteLength) {
      const count = readSync(descriptor, bytes, offset, byteLength - offset, offset);
      if (count === 0) throw new TypeError('private key changed during immutable read');
      offset += count;
    }
    const probe = Buffer.allocUnsafe(1);
    try {
      if (readSync(descriptor, probe, 0, 1, byteLength) !== 0) {
        throw new TypeError('private key changed during immutable read');
      }
    } finally {
      probe.fill(0);
    }
    return bytes;
  } catch (error) {
    bytes.fill(0);
    throw error;
  }
}

function assertSafeParent(parent: FileIdentity, owner: number): void {
  if (!parent.isDirectory() || parent.uid !== owner || (parent.mode & 0o022) !== 0) {
    throw new TypeError('private key parent directory is not owner-controlled');
  }
}

function assertSafeKey(file: FileIdentity, owner: number): void {
  if (!file.isFile() || file.uid !== owner) {
    throw new TypeError('private key file ownership is invalid');
  }
  if ((file.mode & 0o777) !== 0o600) throw new TypeError('private key file mode must be 0600');
  if (file.nlink !== 1) throw new TypeError('private key file must have exactly one link');
  if (file.size < 1 || file.size > MAX_PRIVATE_KEY_BYTES) {
    throw new TypeError('private key file size is invalid');
  }
}

export function readPrivateKeyFile(path: string): Buffer {
  if (!isAbsolute(path) || normalize(path) !== path) {
    throw new TypeError('private key path must be absolute and canonical');
  }
  const parentPath = dirname(path);
  if (realpathSync(parentPath) !== parentPath || realpathSync(path) !== path) {
    throw new TypeError('private key path must be canonical and non-symbolic');
  }
  const owner = effectiveUserId();
  const parentFd = openSync(
    parentPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const parentBefore = fstatSync(parentFd);
    assertSafeParent(parentBefore, owner);
    const fileFd = openSync(
      `/proc/self/fd/${parentFd.toString()}/${basename(path)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = fstatSync(fileFd);
      assertSafeKey(before, owner);
      const bytes = readExact(fileFd, before.size);
      const after = fstatSync(fileFd);
      const current = lstatSync(path);
      const parentAfter = statSync(parentPath);
      if (
        !sameFile(before, after) ||
        !sameFile(after, current) ||
        !sameDirectory(parentBefore, parentAfter) ||
        realpathSync(parentPath) !== parentPath ||
        realpathSync(path) !== path
      ) {
        bytes.fill(0);
        throw new TypeError('private key changed during immutable read');
      }
      return bytes;
    } finally {
      closeSync(fileFd);
    }
  } finally {
    closeSync(parentFd);
  }
}
