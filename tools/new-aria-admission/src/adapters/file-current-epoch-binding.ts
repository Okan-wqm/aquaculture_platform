import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { join } from 'node:path';

import {
  loadCurrentEpochStoreIdentity,
  type CurrentEpochStoreIdentity,
} from '../kernel/current-epoch-store-identity';
import { digestBytes } from '../kernel/evidence-object';
import { readCanonicalFile, writeNewCanonicalFile } from '../runtime/canonical-files';
import { boundedDirectoryEntryNames } from './bounded-directory-entries';

export const currentEpochIdentityFileName = '.new-aria-current-epoch-store-identity.json';
export const currentEpochSnapshotFileName = 'current-epochs.json';
const identityByteLimit = 4_096;
const closedBindings = new WeakSet<object>();

export interface BoundCurrentEpochDirectory {
  readonly root: string;
  readonly descriptor: number;
  readonly descriptor_path: string;
  readonly directory_dev: number;
  readonly directory_ino: number;
  readonly identity_descriptor: number;
  readonly identity_dev: number;
  readonly identity_ino: number;
  readonly identity_sha256: string;
  readonly identity: CurrentEpochStoreIdentity;
}

function assertPrivateOwner(stat: Stats, label: string): void {
  const effectiveUid = process.geteuid?.();
  if ((stat.mode & 0o077) !== 0 || (effectiveUid !== undefined && stat.uid !== effectiveUid)) {
    throw new TypeError(`${label} owner or permission mode is not private`);
  }
}

function sameIdentity(stat: Stats, dev: number, ino: number): boolean {
  return stat.dev === dev && stat.ino === ino;
}

function readIdentityDescriptor(descriptor: number): Buffer {
  const stat = fstatSync(descriptor);
  if (!stat.isFile() || stat.size < 1 || stat.size > identityByteLimit) {
    throw new TypeError('current epoch store identity file is invalid');
  }
  const bytes = Buffer.alloc(stat.size);
  if (readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length) {
    throw new TypeError('current epoch store identity read was incomplete');
  }
  return bytes;
}

function provisionIdentity(root: string, bytes: Uint8Array | undefined): void {
  const path = join(root, currentEpochIdentityFileName);
  try {
    lstatSync(path);
    if (
      bytes !== undefined &&
      !readCanonicalFile(path, 'current epoch store identity', identityByteLimit).equals(bytes)
    ) {
      throw new TypeError('current epoch genesis identity does not match existing store');
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (bytes === undefined) {
    throw new TypeError('empty current epoch store requires explicit genesis identity');
  }
  if (boundedDirectoryEntryNames(root, 1, 'current epoch genesis directory').length !== 0) {
    throw new TypeError('current epoch store without identity is not an empty genesis root');
  }
  const identity = loadCurrentEpochStoreIdentity(bytes);
  if (identity.canonical_root !== root) {
    throw new TypeError('current epoch genesis identity root mismatch');
  }
  writeNewCanonicalFile(path, bytes);
  chmodSync(path, 0o400);
}

export function bindCurrentEpochDirectory(
  root: string,
  genesisIdentityBytes?: Uint8Array,
): BoundCurrentEpochDirectory {
  const visible = lstatSync(root);
  if (!visible.isDirectory() || visible.isSymbolicLink() || realpathSync(root) !== root) {
    throw new TypeError('current epoch store directory is not canonical');
  }
  assertPrivateOwner(visible, 'current epoch store directory');
  const descriptor = openSync(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let identityDescriptor: number | undefined;
  try {
    const held = fstatSync(descriptor);
    if (!sameIdentity(held, visible.dev, visible.ino)) {
      throw new TypeError('current epoch store directory changed during binding');
    }
    provisionIdentity(root, genesisIdentityBytes);
    const identityPath = join(root, currentEpochIdentityFileName);
    identityDescriptor = openSync(identityPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const identityStat = fstatSync(identityDescriptor);
    assertPrivateOwner(identityStat, 'current epoch store identity');
    if (!identityStat.isFile() || identityStat.nlink !== 1) {
      throw new TypeError('current epoch identity must be a unique regular file');
    }
    const identityBytes = readIdentityDescriptor(identityDescriptor);
    const identity = loadCurrentEpochStoreIdentity(identityBytes);
    if (identity.canonical_root !== root)
      throw new TypeError('current epoch identity root mismatch');
    return Object.freeze({
      root,
      descriptor,
      descriptor_path: `/proc/self/fd/${descriptor.toString()}`,
      directory_dev: held.dev,
      directory_ino: held.ino,
      identity_descriptor: identityDescriptor,
      identity_dev: identityStat.dev,
      identity_ino: identityStat.ino,
      identity_sha256: digestBytes(identityBytes),
      identity,
    });
  } catch (error) {
    if (identityDescriptor !== undefined) {
      try {
        closeSync(identityDescriptor);
      } catch {
        /* Preserve primary error. */
      }
    }
    try {
      closeSync(descriptor);
    } catch {
      /* Preserve primary error. */
    }
    throw error;
  }
}

export function verifyBoundCurrentEpochDirectory(binding: BoundCurrentEpochDirectory): void {
  if (closedBindings.has(binding)) throw new TypeError('current epoch store binding is closed');
  try {
    const held = fstatSync(binding.descriptor);
    const visible = lstatSync(binding.root);
    const identityHeld = fstatSync(binding.identity_descriptor);
    const identityVisible = lstatSync(join(binding.root, currentEpochIdentityFileName));
    if (
      !sameIdentity(held, binding.directory_dev, binding.directory_ino) ||
      !sameIdentity(visible, binding.directory_dev, binding.directory_ino) ||
      realpathSync(binding.root) !== binding.root ||
      !sameIdentity(identityHeld, binding.identity_dev, binding.identity_ino) ||
      !sameIdentity(identityVisible, binding.identity_dev, binding.identity_ino) ||
      identityHeld.nlink !== 1 ||
      digestBytes(readIdentityDescriptor(binding.identity_descriptor)) !== binding.identity_sha256
    ) {
      throw new TypeError('current epoch store identity changed after construction');
    }
    assertPrivateOwner(held, 'current epoch store directory');
    assertPrivateOwner(identityHeld, 'current epoch store identity');
  } catch {
    throw new TypeError('current epoch store identity changed after construction');
  }
}

export function closeBoundCurrentEpochDirectory(binding: BoundCurrentEpochDirectory): void {
  if (closedBindings.has(binding)) return;
  closedBindings.add(binding);
  closeSync(binding.identity_descriptor);
  closeSync(binding.descriptor);
}
