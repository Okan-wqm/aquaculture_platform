import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import type { Stats } from 'node:fs';

import { runtimeTemporaryRoot } from './runtime-temporary-root';

export interface PrivateExecutableSnapshot {
  readonly executable_path: string;
  verify(): void;
  dispose(): void;
}

interface SnapshotState {
  readonly rootPath: string;
  readonly executablePath: string;
  readonly rootFd: number;
  readonly executableFd: number;
  readonly rootDevice: number;
  readonly rootInode: number;
  readonly executableDevice: number;
  readonly executableInode: number;
  readonly sha256: string;
  readonly byteLength: number;
  disposed: boolean;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readDescriptor(fd: number, byteLength: number): Buffer {
  const bytes = Buffer.allocUnsafe(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const count = readSync(fd, bytes, offset, byteLength - offset, offset);
    if (count === 0) throw new TypeError('executable changed during immutable read');
    offset += count;
  }
  const probe = Buffer.allocUnsafe(1);
  if (readSync(fd, probe, 0, 1, byteLength) !== 0) {
    throw new TypeError('executable changed during immutable read');
  }
  return bytes;
}

function sameIdentity(
  actual: { readonly dev: number; readonly ino: number },
  device: number,
  inode: number,
): boolean {
  return actual.dev === device && actual.ino === inode;
}

function verifyPathIdentity(state: SnapshotState): void {
  let root: Stats;
  let executable: Stats;
  try {
    root = lstatSync(state.rootPath);
    executable = lstatSync(state.executablePath);
  } catch {
    throw new TypeError('private executable snapshot path identity changed');
  }
  if (
    !root.isDirectory() ||
    !executable.isFile() ||
    !sameIdentity(root, state.rootDevice, state.rootInode) ||
    !sameIdentity(executable, state.executableDevice, state.executableInode)
  ) {
    throw new TypeError('private executable snapshot path identity changed');
  }
}

function verifySnapshot(state: SnapshotState): void {
  if (state.disposed) throw new TypeError('private executable snapshot is disposed');
  const root = fstatSync(state.rootFd);
  const executable = fstatSync(state.executableFd);
  if (
    !root.isDirectory() ||
    !executable.isFile() ||
    !sameIdentity(root, state.rootDevice, state.rootInode) ||
    !sameIdentity(executable, state.executableDevice, state.executableInode) ||
    executable.size !== state.byteLength ||
    (root.mode & 0o777) !== 0o500 ||
    (executable.mode & 0o777) !== 0o500
  ) {
    throw new TypeError('private executable snapshot metadata changed');
  }
  verifyPathIdentity(state);
  if (digest(readDescriptor(state.executableFd, state.byteLength)) !== state.sha256) {
    throw new TypeError('private executable snapshot digest changed');
  }
}

function disposeSnapshot(state: SnapshotState): void {
  if (state.disposed) return;
  state.disposed = true;
  try {
    const root = fstatSync(state.rootFd);
    const executable = fstatSync(state.executableFd);
    verifyPathIdentity(state);
    if (
      !sameIdentity(root, state.rootDevice, state.rootInode) ||
      !sameIdentity(executable, state.executableDevice, state.executableInode)
    ) {
      throw new TypeError('private executable cleanup identity changed');
    }
    unlinkSync(`/proc/self/fd/${state.rootFd}/executable`);
    const currentRoot = lstatSync(state.rootPath);
    if (!sameIdentity(currentRoot, state.rootDevice, state.rootInode)) {
      throw new TypeError('private executable cleanup root changed');
    }
    fchmodSync(state.rootFd, 0o700);
    rmdirSync(state.rootPath);
  } finally {
    closeSync(state.executableFd);
    closeSync(state.rootFd);
  }
}

function createSnapshot(state: SnapshotState): PrivateExecutableSnapshot {
  return Object.freeze({
    executable_path: state.executablePath,
    verify: (): void => verifySnapshot(state),
    dispose: (): void => disposeSnapshot(state),
  });
}

export function materializePrivateExecutable(
  immutableBytes: Uint8Array,
  expectedSha256: string,
): PrivateExecutableSnapshot {
  const bytes = Buffer.from(immutableBytes);
  if (digest(bytes) !== expectedSha256) throw new TypeError('verified executable bytes changed');
  const rootPath = mkdtempSync(join(runtimeTemporaryRoot(), 'new-aria-executable-'));
  const executablePath = join(rootPath, 'executable');
  let rootFd: number | undefined;
  let executableFd: number | undefined;
  try {
    rootFd = openSync(rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    executableFd = openSync(
      executablePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o500,
    );
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += writeSync(executableFd, bytes, offset, bytes.byteLength - offset, offset);
    }
    fsyncSync(executableFd);
    fchmodSync(executableFd, 0o500);
    closeSync(executableFd);
    executableFd = undefined;
    executableFd = openSync(executablePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    fchmodSync(rootFd, 0o500);
    const root = fstatSync(rootFd);
    const executable = fstatSync(executableFd);
    const state: SnapshotState = {
      rootPath,
      executablePath,
      rootFd,
      executableFd,
      rootDevice: root.dev,
      rootInode: root.ino,
      executableDevice: executable.dev,
      executableInode: executable.ino,
      sha256: expectedSha256,
      byteLength: bytes.byteLength,
      disposed: false,
    };
    const snapshot = createSnapshot(state);
    verifySnapshot(state);
    return snapshot;
  } catch (error) {
    if (executableFd !== undefined) closeSync(executableFd);
    if (rootFd !== undefined) closeSync(rootFd);
    try {
      unlinkSync(executablePath);
    } catch {}
    try {
      chmodSync(rootPath, 0o700);
      rmdirSync(rootPath);
    } catch {}
    throw error;
  }
}
