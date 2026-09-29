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
  loadCheckpointStoreIdentity,
  type CheckpointStoreIdentity,
} from '../kernel/checkpoint-store-identity';
import { digestBytes } from '../kernel/evidence-object';
import { readCanonicalFile, writeNewCanonicalFile } from '../runtime/canonical-files';
import { boundedDirectoryEntryNames } from './bounded-directory-entries';

export const checkpointIdentityFileName = '.new-aria-checkpoint-store-identity.json';
const identityByteLimit = 4096;
const closedBindings = new WeakSet<object>();

export interface BoundCheckpointDirectory {
  readonly root: string;
  readonly descriptor: number;
  readonly descriptor_path: string;
  readonly directory_dev: number;
  readonly directory_ino: number;
  readonly identity_descriptor: number;
  readonly identity_dev: number;
  readonly identity_ino: number;
  readonly identity_sha256: string;
  readonly identity: CheckpointStoreIdentity;
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
    throw new TypeError('checkpoint store identity file is invalid');
  }
  const bytes = Buffer.alloc(stat.size);
  const count = readSync(descriptor, bytes, 0, bytes.length, 0);
  if (count !== bytes.length) throw new TypeError('checkpoint store identity read was incomplete');
  return bytes;
}

function provisionIdentity(root: string, bytes: Uint8Array | undefined): void {
  const identityPath = join(root, checkpointIdentityFileName);
  try {
    lstatSync(identityPath);
    if (
      bytes !== undefined &&
      !readCanonicalFile(identityPath, 'checkpoint identity', identityByteLimit).equals(bytes)
    ) {
      throw new TypeError('checkpoint genesis identity does not match the existing store');
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (bytes === undefined)
    throw new TypeError('empty checkpoint store requires explicit genesis identity');
  if (boundedDirectoryEntryNames(root, 1, 'checkpoint genesis directory').length !== 0) {
    throw new TypeError('checkpoint store without identity is not an empty genesis root');
  }
  const identity = loadCheckpointStoreIdentity(bytes);
  if (identity.canonical_root !== root)
    throw new TypeError('checkpoint genesis identity root mismatch');
  writeNewCanonicalFile(identityPath, bytes);
  chmodSync(identityPath, 0o400);
}

export function bindCheckpointDirectory(
  root: string,
  genesisIdentityBytes?: Uint8Array,
): BoundCheckpointDirectory {
  const visible = lstatSync(root);
  if (!visible.isDirectory() || visible.isSymbolicLink() || realpathSync(root) !== root) {
    throw new TypeError('checkpoint directory is not canonical');
  }
  assertPrivateOwner(visible, 'checkpoint directory');
  const descriptor = openSync(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let identityDescriptor: number | undefined;
  try {
    const held = fstatSync(descriptor);
    if (!sameIdentity(held, visible.dev, visible.ino)) {
      throw new TypeError('checkpoint directory identity changed during binding');
    }
    provisionIdentity(root, genesisIdentityBytes);
    const identityPath = join(root, checkpointIdentityFileName);
    identityDescriptor = openSync(identityPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const identityStat = fstatSync(identityDescriptor);
    assertPrivateOwner(identityStat, 'checkpoint identity');
    if (!identityStat.isFile() || identityStat.nlink !== 1) {
      throw new TypeError('checkpoint identity must be a unique regular file, not a hard link');
    }
    const identityBytes = readIdentityDescriptor(identityDescriptor);
    const identity = loadCheckpointStoreIdentity(identityBytes);
    if (identity.canonical_root !== root) throw new TypeError('checkpoint identity root mismatch');
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
        /* Preserve the binding failure. */
      }
    }
    try {
      closeSync(descriptor);
    } catch {
      /* Preserve the binding failure. */
    }
    throw error;
  }
}

export function verifyBoundCheckpointDirectory(binding: BoundCheckpointDirectory): void {
  if (closedBindings.has(binding)) throw new TypeError('checkpoint store binding is closed');
  try {
    const held = fstatSync(binding.descriptor);
    const visible = lstatSync(binding.root);
    const identityHeld = fstatSync(binding.identity_descriptor);
    const identityVisible = lstatSync(join(binding.root, checkpointIdentityFileName));
    if (
      !sameIdentity(held, binding.directory_dev, binding.directory_ino) ||
      !sameIdentity(visible, binding.directory_dev, binding.directory_ino) ||
      realpathSync(binding.root) !== binding.root ||
      !sameIdentity(identityHeld, binding.identity_dev, binding.identity_ino) ||
      !sameIdentity(identityVisible, binding.identity_dev, binding.identity_ino) ||
      identityHeld.nlink !== 1 ||
      digestBytes(readIdentityDescriptor(binding.identity_descriptor)) !== binding.identity_sha256
    ) {
      throw new TypeError('checkpoint store identity changed after construction');
    }
    assertPrivateOwner(held, 'checkpoint directory');
    assertPrivateOwner(identityHeld, 'checkpoint identity');
  } catch {
    throw new TypeError('checkpoint store identity changed after construction');
  }
}

export function closeBoundCheckpointDirectory(binding: BoundCheckpointDirectory): void {
  if (closedBindings.has(binding)) return;
  closedBindings.add(binding);
  let failure: unknown;
  try {
    closeSync(binding.identity_descriptor);
  } catch (error) {
    failure = error;
  }
  try {
    closeSync(binding.descriptor);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw new TypeError('checkpoint store binding close failed');
}
