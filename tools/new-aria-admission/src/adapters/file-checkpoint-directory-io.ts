import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { join } from 'node:path';

import {
  isPrivateCheckpointFile,
  openCheckpointDirectory,
  sameCheckpointFile,
} from './file-checkpoint-directory-access';
import { boundedDirectoryEntryNames } from './bounded-directory-entries';
import type {
  CheckpointDirectory,
  CheckpointDirectoryAccess,
  OpenedCheckpointDirectory,
} from './file-checkpoint-directory-access';

export type { CheckpointDirectoryAccess } from './file-checkpoint-directory-access';

function currentFileStat(path: string): Stats {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return fstatSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function readCheckpointFile(
  directory: CheckpointDirectory,
  name: string,
  maximumBytes: number,
  expectedLinkCount = 1,
): Buffer {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError('checkpoint read limit is invalid');
  }
  const parent = openCheckpointDirectory(directory);
  let descriptor: number | undefined;
  try {
    const path = join(parent.path, name);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!isPrivateCheckpointFile(before, expectedLinkCount) || before.size > maximumBytes) {
      throw new TypeError('checkpoint file is invalid or oversized');
    }
    const bytes = Buffer.alloc(before.size);
    const count = readSync(descriptor, bytes, 0, bytes.length, 0);
    const after = fstatSync(descriptor);
    const current = currentFileStat(path);
    if (
      count !== bytes.length ||
      !sameCheckpointFile(before, after) ||
      !sameCheckpointFile(after, current)
    ) {
      throw new TypeError('checkpoint file changed during immutable read');
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (parent.close) closeSync(parent.descriptor);
  }
}

export function writeNewCheckpointFile(
  directory: CheckpointDirectory,
  name: string,
  bytes: Uint8Array,
): void {
  const parent = openCheckpointDirectory(directory);
  const temporaryName = `.${name}.${process.pid}.${randomUUID()}.tmp`;
  const temporaryPath = join(parent.path, temporaryName);
  const outputPath = join(parent.path, name);
  let temporaryExists = false;
  let linkedOutput = false;
  try {
    const descriptor = openSync(temporaryPath, 'wx', 0o600);
    temporaryExists = true;
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    linkSync(temporaryPath, outputPath);
    linkedOutput = true;
    fsyncSync(parent.descriptor);
    unlinkSync(temporaryPath);
    temporaryExists = false;
    fsyncSync(parent.descriptor);
  } finally {
    if (temporaryExists && !linkedOutput) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        /* Preserve primary publication failure. */
      }
    }
    try {
      fsyncSync(parent.descriptor);
    } catch {
      /* Preserve primary publication failure. */
    }
    if (parent.close) closeSync(parent.descriptor);
  }
}

export type CheckpointFilePublicationState = 'NONE' | 'PENDING' | 'LINKED';

interface CheckpointFilePublication {
  readonly state: Exclude<CheckpointFilePublicationState, 'NONE'>;
  readonly temp_name: string;
}

function publicationTempNames(parent: OpenedCheckpointDirectory, name: string): string[] {
  const prefix = `.${name}.`;
  return boundedDirectoryEntryNames(parent.path, 4_096, 'checkpoint directory').filter((entry) => {
    if (!entry.startsWith(prefix) || !entry.endsWith('.tmp')) return false;
    return /^\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      entry.slice(prefix.length, -4),
    );
  });
}

function inspectWithParent(
  parent: OpenedCheckpointDirectory,
  name: string,
  expectedBytes: Uint8Array,
): CheckpointFilePublication | null {
  const matches = publicationTempNames(parent, name);
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new TypeError('checkpoint publication has ambiguous temp files');
  }
  const tempName = matches[0];
  if (tempName === undefined) throw new TypeError('checkpoint publication temp is unavailable');
  const access = { descriptor: parent.descriptor, descriptor_path: parent.path };
  const tempPath = join(parent.path, tempName);
  let finalDescriptor: number | undefined;
  let tempDescriptor: number | undefined;
  try {
    tempDescriptor = openSync(tempPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const tempStat = fstatSync(tempDescriptor);
    try {
      finalDescriptor = openSync(
        join(parent.path, name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (finalDescriptor === undefined) {
      if (
        !isPrivateCheckpointFile(tempStat, 1) ||
        !readCheckpointFile(access, tempName, expectedBytes.byteLength).equals(expectedBytes)
      )
        throw new TypeError('checkpoint pending publication differs from durable bytes');
      return { state: 'PENDING', temp_name: tempName };
    }
    const finalStat = fstatSync(finalDescriptor);
    if (
      !isPrivateCheckpointFile(finalStat, 2) ||
      !isPrivateCheckpointFile(tempStat, 2) ||
      finalStat.dev !== tempStat.dev ||
      finalStat.ino !== tempStat.ino ||
      !readCheckpointFile(access, name, expectedBytes.byteLength, 2).equals(expectedBytes) ||
      !readCheckpointFile(access, tempName, expectedBytes.byteLength, 2).equals(expectedBytes)
    )
      throw new TypeError('checkpoint linked temp differs from claimed durable bytes');
    return { state: 'LINKED', temp_name: tempName };
  } finally {
    if (finalDescriptor !== undefined) closeSync(finalDescriptor);
    if (tempDescriptor !== undefined) closeSync(tempDescriptor);
  }
}

export function inspectCheckpointFilePublication(
  directory: CheckpointDirectory,
  name: string,
  expectedBytes: Uint8Array,
): CheckpointFilePublicationState {
  const parent = openCheckpointDirectory(directory);
  try {
    return inspectWithParent(parent, name, expectedBytes)?.state ?? 'NONE';
  } finally {
    if (parent.close) closeSync(parent.descriptor);
  }
}

export function recoverCheckpointFilePublication(
  directory: CheckpointDirectory,
  name: string,
  expectedBytes: Uint8Array,
  allowPending: boolean,
): CheckpointFilePublicationState {
  const parent = openCheckpointDirectory(directory);
  try {
    const publication = inspectWithParent(parent, name, expectedBytes);
    if (publication === null) return 'NONE';
    if (publication.state === 'PENDING' && !allowPending) return 'PENDING';
    const temporaryPath = join(parent.path, publication.temp_name);
    if (publication.state === 'PENDING') {
      linkSync(temporaryPath, join(parent.path, name));
      fsyncSync(parent.descriptor);
    }
    unlinkSync(temporaryPath);
    fsyncSync(parent.descriptor);
    return publication.state;
  } finally {
    if (parent.close) closeSync(parent.descriptor);
  }
}
