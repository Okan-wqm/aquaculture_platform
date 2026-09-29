import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';

import type { PrivateExecutableSnapshot } from './private-executable-snapshot';
import { materializePrivateExecutable } from './private-executable-snapshot';

export type { PrivateExecutableSnapshot } from './private-executable-snapshot';

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_EXECUTABLE_BYTES = 128 * 1024 * 1024;
const sourceToken = Symbol('verified executable source');

interface SourceState {
  readonly sha256: string;
  readonly bytes: Buffer;
}

const sourceStates = new WeakMap<VerifiedExecutableSource, SourceState>();

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
  expected: { readonly dev: number; readonly ino: number },
): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

export class VerifiedExecutableSource {
  private constructor(token: symbol, state: SourceState) {
    if (token !== sourceToken)
      throw new TypeError('verified executable source construction denied');
    sourceStates.set(this, state);
    Object.freeze(this);
  }

  static load(sourcePath: string, expectedSha256: string, label: string): VerifiedExecutableSource {
    if (!SHA256.test(expectedSha256)) throw new TypeError(`${label} digest is invalid`);
    if (!isAbsolute(sourcePath) || normalize(sourcePath) !== sourcePath) {
      throw new TypeError(`${label} path is not canonical`);
    }
    const canonical = realpathSync(sourcePath);
    if (canonical !== sourcePath) throw new TypeError(`${label} path is not canonical`);
    const fd = openSync(
      sourcePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.size < 1 || before.size > MAX_EXECUTABLE_BYTES) {
        throw new TypeError(`${label} is not a bounded regular file`);
      }
      const bytes = readDescriptor(fd, before.size);
      const after = fstatSync(fd);
      if (!sameIdentity(after, before) || after.size !== before.size) {
        throw new TypeError(`${label} changed during immutable read`);
      }
      if (digest(bytes) !== expectedSha256) throw new TypeError(`${label} digest mismatch`);
      return new VerifiedExecutableSource(sourceToken, {
        sha256: expectedSha256,
        bytes: Buffer.from(bytes),
      });
    } finally {
      closeSync(fd);
    }
  }

  get sha256(): string {
    return this.state().sha256;
  }

  materialize(): PrivateExecutableSnapshot {
    const state = this.state();
    return materializePrivateExecutable(state.bytes, state.sha256);
  }

  private state(): SourceState {
    const state = sourceStates.get(this);
    if (state === undefined) throw new TypeError('verified executable source is not authentic');
    return state;
  }
}

export function assertVerifiedExecutableSource(
  value: unknown,
): asserts value is VerifiedExecutableSource {
  if (!(value instanceof VerifiedExecutableSource) || !sourceStates.has(value)) {
    throw new TypeError('verified executable source is not authentic');
  }
}

Object.freeze(VerifiedExecutableSource.prototype);
Object.freeze(VerifiedExecutableSource);
