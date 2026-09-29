import {
  closeSync,
  constants,
  fstatSync,
  openSync,
} from 'node:fs';
import type { Stats } from 'node:fs';

export interface CheckpointDirectoryAccess {
  readonly descriptor: number;
  readonly descriptor_path: string;
}

export type CheckpointDirectory = string | CheckpointDirectoryAccess;

export interface OpenedCheckpointDirectory {
  readonly descriptor: number;
  readonly path: string;
  readonly close: boolean;
}

export function openCheckpointDirectory(
  directory: CheckpointDirectory,
): OpenedCheckpointDirectory {
  if (typeof directory !== 'string') {
    if (!fstatSync(directory.descriptor).isDirectory()) {
      throw new TypeError('checkpoint IO parent is not a directory');
    }
    return {
      descriptor: directory.descriptor,
      path: directory.descriptor_path,
      close: false,
    };
  }
  const descriptor = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const stat = fstatSync(descriptor);
  if (!stat.isDirectory()) {
    closeSync(descriptor);
    throw new TypeError('checkpoint IO parent is not a directory');
  }
  return {
    descriptor,
    path: `/proc/self/fd/${descriptor.toString()}`,
    close: true,
  };
}

export function isPrivateCheckpointFile(stat: Stats, links: number): boolean {
  const effectiveUid = process.geteuid?.();
  return (
    stat.isFile() &&
    stat.nlink === links &&
    (stat.mode & 0o777) === 0o600 &&
    (effectiveUid === undefined || stat.uid === effectiveUid)
  );
}

export function sameCheckpointFile(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}
