import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

export interface OwnedPublicationFileOptions {
  readonly expected_length?: number;
  readonly expected_link_count?: number;
  readonly maximum_length: number;
  readonly minimum_length?: number;
  readonly label: string;
}

const descriptorPath = (descriptor: number): string => `/proc/self/fd/${descriptor}`;

function readExact(descriptor: number, expectedLength: number, label: string): Buffer {
  const bytes = Buffer.alloc(expectedLength + 1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
    if (count === 0) break;
    offset += count;
  }
  if (offset !== expectedLength) throw new TypeError(`${label} size changed while it was read`);
  return bytes.subarray(0, expectedLength);
}

export function readOwnedPublicationFile(
  directoryFd: number,
  name: string,
  options: OwnedPublicationFileOptions,
): Buffer {
  const descriptor = openSync(
    join(descriptorPath(directoryFd), name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor);
    const effectiveUser = process.geteuid?.();
    const minimum = options.minimum_length ?? 0;
    if (
      effectiveUser === undefined ||
      !before.isFile() ||
      before.uid !== effectiveUser ||
      before.nlink !== (options.expected_link_count ?? 1) ||
      (before.mode & 0o777) !== 0o600 ||
      before.size < minimum ||
      before.size > options.maximum_length ||
      (options.expected_length !== undefined && before.size !== options.expected_length)
    )
      throw new TypeError(`${options.label} metadata is unsafe`);
    const bytes = readExact(descriptor, before.size, options.label);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new TypeError(`${options.label} changed while it was read`);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}
