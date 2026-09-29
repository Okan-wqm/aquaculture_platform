import { fstatSync, lstatSync, realpathSync } from 'node:fs';

export interface BoundPublicationDirectory {
  readonly device: number;
  readonly inode: number;
  readonly owner: number;
}

function effectiveUserId(): number {
  const value = process.geteuid?.();
  if (value === undefined) {
    throw new TypeError('publication directory ownership inspection is unavailable');
  }
  return value;
}

export function verifyOwnerControlledDirectory(
  path: string,
  descriptor: number,
  binding: BoundPublicationDirectory,
): void {
  const held = fstatSync(descriptor);
  const visible = lstatSync(path);
  if (
    !held.isDirectory() ||
    !visible.isDirectory() ||
    visible.isSymbolicLink() ||
    held.uid !== binding.owner ||
    visible.uid !== binding.owner ||
    (held.mode & 0o022) !== 0 ||
    (visible.mode & 0o022) !== 0 ||
    held.dev !== binding.device ||
    visible.dev !== binding.device ||
    held.ino !== binding.inode ||
    visible.ino !== binding.inode ||
    realpathSync(path) !== path
  ) {
    throw new TypeError('publication directory is not owner-controlled or changed identity');
  }
}

export function bindOwnerControlledDirectory(
  path: string,
  descriptor: number,
): BoundPublicationDirectory {
  const held = fstatSync(descriptor);
  const binding = Object.freeze({
    device: held.dev,
    inode: held.ino,
    owner: effectiveUserId(),
  });
  verifyOwnerControlledDirectory(path, descriptor, binding);
  return binding;
}
