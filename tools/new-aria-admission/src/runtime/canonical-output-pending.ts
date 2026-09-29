import { closeSync, constants, fstatSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';

function isAlreadyExists(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'EEXIST';
}

function exactPrefix(descriptor: number, length: number): Buffer {
  const bytes = Buffer.alloc(length + 1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  if (offset !== length) throw new TypeError('canonical output pending file changed while read');
  return bytes.subarray(0, length);
}

export function openOrResumeCanonicalOutputPending(path: string, expected: Buffer): number {
  try {
    return openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor);
    const effectiveUser = process.geteuid?.();
    if (
      effectiveUser === undefined ||
      !before.isFile() ||
      before.uid !== effectiveUser ||
      before.nlink !== 1 ||
      (before.mode & 0o777) !== 0o600 ||
      before.size > expected.byteLength ||
      !expected.subarray(0, before.size).equals(exactPrefix(descriptor, before.size))
    )
      throw new TypeError('canonical output pending file differs from admitted bytes');
    let offset = before.size;
    while (offset < expected.byteLength) {
      const count = writeSync(descriptor, expected, offset, expected.byteLength - offset, offset);
      if (count === 0) throw new TypeError('canonical output pending write made no progress');
      offset += count;
    }
    fsyncSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      after.size !== expected.byteLength ||
      after.nlink !== 1 ||
      !exactPrefix(descriptor, expected.byteLength).equals(expected)
    )
      throw new TypeError('canonical output pending file changed during recovery');
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}
