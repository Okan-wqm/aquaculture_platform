import { readSync } from 'node:fs';

import { parseStrictJson } from '../kernel/strict-json';
import type { JsonValue } from '../kernel/strict-json';
import {
  EXECUTION_INPUT_ENVELOPE_MAX_BYTES,
  validateExecutionInputEnvelope,
} from '../runtime/execution-input-envelope';

const CHUNK_BYTES = 64 * 1024;

export function readBoundedVerifierInput(): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    const count = readSync(0, chunk, 0, chunk.byteLength, null);
    if (count === 0) return Buffer.concat(chunks, total);
    total += count;
    if (total > EXECUTION_INPUT_ENVELOPE_MAX_BYTES) {
      throw new TypeError('verifier input exceeds its byte limit');
    }
    chunks.push(chunk.subarray(0, count));
  }
}

function objectBase64(value: JsonValue): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('verifier input entry is invalid');
  }
  const encoded = value.object_base64;
  if (typeof encoded !== 'string') throw new TypeError('verifier input object is invalid');
  return encoded;
}

export function decodeVerifierInput(bytes: Uint8Array): readonly Buffer[] {
  validateExecutionInputEnvelope(bytes);
  const value = parseStrictJson(bytes);
  if (!Array.isArray(value)) throw new TypeError('verifier input envelope is invalid');
  return Object.freeze(value.map((entry) => Buffer.from(objectBase64(entry), 'base64')));
}
