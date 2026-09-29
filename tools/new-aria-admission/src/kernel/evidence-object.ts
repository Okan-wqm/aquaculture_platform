import { createHash } from 'node:crypto';

import { canonicalJsonBytes } from './canonical-json';
import { JsonValue, parseStrictJson } from './strict-json';

export type JsonRecord = { [key: string]: JsonValue };

export interface VerifiedEvidenceObject {
  readonly uri: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

const referenceKeys = ['uri', 'sha256'];
const sha64 = /^[a-f0-9]{64}$/u;

export const digestBytes = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

export const isJsonRecord = (value: unknown): value is JsonRecord =>
  value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);

export const hasExactKeys = (value: JsonRecord, expected: readonly string[]): boolean =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());

export function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is invalid`);
  return value;
}

export function requiredSha256(value: unknown, label: string): string {
  const digest = requiredText(value, label);
  if (!sha64.test(digest)) throw new TypeError(`${label} is invalid`);
  return digest;
}

export function verifyEvidenceObject(
  value: unknown,
  objects: ReadonlyMap<string, Uint8Array>,
  label: string,
): VerifiedEvidenceObject {
  if (!isJsonRecord(value) || !hasExactKeys(value, referenceKeys)) {
    throw new TypeError(`${label} reference schema is invalid`);
  }
  const sha256 = requiredSha256(value.sha256, `${label} digest`);
  const uri = requiredText(value.uri, `${label} URI`);
  if (uri !== `aria-evidence://sha256/${sha256}`) {
    throw new TypeError(`${label} reference is not content-addressed`);
  }
  const bytes = objects.get(uri);
  if (bytes === undefined || digestBytes(bytes) !== sha256) {
    throw new TypeError(`${label} object is unavailable or changed`);
  }
  return { uri, sha256, bytes };
}

export function parseCanonicalEvidenceObject(
  value: unknown,
  objects: ReadonlyMap<string, Uint8Array>,
  label: string,
): { readonly reference: VerifiedEvidenceObject; readonly document: JsonRecord } {
  const reference = verifyEvidenceObject(value, objects, label);
  const parsed = parseStrictJson(reference.bytes);
  if (!isJsonRecord(parsed) || !canonicalJsonBytes(parsed).equals(Buffer.from(reference.bytes))) {
    throw new TypeError(`${label} object must be a canonical JSON record`);
  }
  return { reference, document: parsed };
}

export function verifyDigestObject(
  digest: string,
  objects: ReadonlyMap<string, Uint8Array>,
  label: string,
  requireContent = false,
): Uint8Array {
  const bytes = objects.get(`aria-evidence://sha256/${digest}`);
  if (
    bytes === undefined ||
    digestBytes(bytes) !== digest ||
    (requireContent && bytes.length === 0)
  ) {
    throw new TypeError(`${label} object is unavailable or changed`);
  }
  return bytes;
}
