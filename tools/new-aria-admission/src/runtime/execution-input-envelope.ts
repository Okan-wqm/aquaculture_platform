import { createHash } from 'node:crypto';

import { canonicalJsonBytes } from '../kernel/canonical-json';
import { JsonValue, parseStrictJson } from '../kernel/strict-json';

const sha64 = /^[a-f0-9]{64}$/u;
const entryKeys = ['object_base64', 'reference'] as const;
const referenceKeys = ['sha256', 'uri'] as const;
const MAX_OBJECTS = 64;
const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
export const EXECUTION_INPUT_ENVELOPE_MAX_BYTES = 24 * 1024 * 1024;
const MAX_OBJECT_BASE64_BYTES = Math.ceil(MAX_OBJECT_BYTES / 3) * 4;
type JsonRecord = { [key: string]: JsonValue };

export interface ValidatedExecutionInputEnvelope {
  readonly bytes: Buffer;
  readonly input_reference_bundle_sha256: string;
  readonly input_envelope_sha256: string;
  readonly object_sha256s: readonly string[];
  readonly object_bytes: readonly Buffer[];
  readonly object_count: number;
  readonly total_object_bytes: number;
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function record(value: JsonValue | undefined, keys: readonly string[], label: string): JsonRecord {
  if (
    value === undefined ||
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new TypeError(`${label} schema is invalid`);
  }
  return value;
}

function validateEntry(value: JsonValue): { reference: JsonRecord; objectBase64: string } {
  const entry = record(value, entryKeys, 'execution input envelope entry');
  const reference = record(entry.reference, referenceKeys, 'execution input reference');
  if (
    typeof reference.sha256 !== 'string' ||
    !sha64.test(reference.sha256) ||
    reference.uri !== `aria-evidence://sha256/${reference.sha256}` ||
    typeof entry.object_base64 !== 'string'
  ) {
    throw new TypeError('execution input envelope reference or object encoding is invalid');
  }
  if (entry.object_base64.length > MAX_OBJECT_BASE64_BYTES) {
    throw new TypeError('execution input envelope object exceeds its allocation limit');
  }
  return { reference, objectBase64: entry.object_base64 };
}

export function validateExecutionInputEnvelope(bytes: Uint8Array): ValidatedExecutionInputEnvelope {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('execution input envelope must be bytes');
  if (bytes.byteLength > EXECUTION_INPUT_ENVELOPE_MAX_BYTES) {
    throw new TypeError('execution input envelope exceeds its byte limit');
  }
  if (typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer) {
    throw new TypeError('execution input envelope cannot use shared mutable memory');
  }
  const owned = Buffer.from(bytes);
  const value = parseStrictJson(owned);
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_OBJECTS ||
    !canonicalJsonBytes(value).equals(owned)
  ) {
    throw new TypeError('execution input envelope is not bounded canonical JSON');
  }
  const encodedEntries = value.map(validateEntry);
  const totalEncodedBytes = encodedEntries.reduce(
    (total, entry) => total + entry.objectBase64.length,
    0,
  );
  if (totalEncodedBytes > MAX_OBJECT_BASE64_BYTES) {
    throw new TypeError('execution input envelope exceeds its allocation limit');
  }
  const entries = encodedEntries.map(({ reference, objectBase64 }) => {
    const objectBytes = Buffer.from(objectBase64, 'base64');
    if (
      objectBytes.toString('base64') !== objectBase64 ||
      digest(objectBytes) !== reference.sha256
    ) {
      throw new TypeError('execution input envelope object digest mismatch');
    }
    return { reference, objectBytes };
  });
  const totalBytes = entries.reduce((total, entry) => total + entry.objectBytes.byteLength, 0);
  const references = entries.map(({ reference }) => reference);
  const referenceDigests = references.map(({ sha256 }) => String(sha256));
  if (totalBytes > MAX_OBJECT_BYTES || new Set(referenceDigests).size !== references.length) {
    throw new TypeError('execution input envelope exceeds limits or reuses an object');
  }
  return Object.freeze({
    bytes: owned,
    input_reference_bundle_sha256: digest(canonicalJsonBytes(references)),
    input_envelope_sha256: digest(owned),
    object_sha256s: Object.freeze([...referenceDigests]),
    object_bytes: Object.freeze(entries.map(({ objectBytes }) => Buffer.from(objectBytes))),
    object_count: entries.length,
    total_object_bytes: totalBytes,
  });
}
