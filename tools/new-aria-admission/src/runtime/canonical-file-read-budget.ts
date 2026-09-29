import { readCanonicalFile } from './canonical-files';

const MAX_AGGREGATE_BYTES = 128 * 1024 * 1024;

function positiveBound(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_AGGREGATE_BYTES) {
    throw new TypeError(`${label} must be a bounded positive safe integer`);
  }
  return value;
}

export class CanonicalFileReadBudget {
  readonly #maximumBytes: number;
  #remainingBytes: number;

  constructor(maximumBytes: number) {
    this.#maximumBytes = positiveBound(maximumBytes, 'aggregate byte limit');
    this.#remainingBytes = this.#maximumBytes;
    Object.freeze(this);
  }

  read(path: string, label: string, itemMaximumBytes: number): Buffer {
    const itemLimit = positiveBound(itemMaximumBytes, 'item byte limit');
    if (this.#remainingBytes < 1) {
      throw new TypeError('canonical file aggregate byte limit exceeded');
    }
    const bytes = readCanonicalFile(path, label, Math.min(itemLimit, this.#remainingBytes));
    if (bytes.byteLength > this.#remainingBytes) {
      throw new TypeError('canonical file aggregate byte limit exceeded');
    }
    this.#remainingBytes -= bytes.byteLength;
    return bytes;
  }
}

Object.freeze(CanonicalFileReadBudget.prototype);
Object.freeze(CanonicalFileReadBudget);
