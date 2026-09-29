import { digestBytes, hasExactKeys, isJsonRecord, requiredSha256 } from '../kernel/evidence-object';
import type { JsonValue } from '../kernel/strict-json';

const encodedKeys = ['bytes_base64', 'sha256'] as const;
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAX_EMBEDDED_BYTES = 8 * 1024 * 1024;
const MAX_BASE64_BYTES = Math.ceil(MAX_EMBEDDED_BYTES / 3) * 4;

export interface DecodedDossierBytes {
  readonly bytes: Buffer;
  readonly sha256: string;
}

export function decodeDossierBytes(
  value: JsonValue | undefined,
  label: string,
): DecodedDossierBytes {
  if (!isJsonRecord(value) || !hasExactKeys(value, encodedKeys)) {
    throw new TypeError(`${label} byte reference is invalid`);
  }
  const encoded = value.bytes_base64;
  if (
    typeof encoded !== 'string' ||
    encoded.length === 0 ||
    encoded.length > MAX_BASE64_BYTES ||
    !base64.test(encoded)
  ) {
    throw new TypeError(`${label} base64 is invalid or oversized`);
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.byteLength > MAX_EMBEDDED_BYTES ||
    bytes.toString('base64') !== encoded ||
    digestBytes(bytes) !== requiredSha256(value.sha256, `${label} digest`)
  ) {
    throw new TypeError(`${label} bytes do not match their digest`);
  }
  return Object.freeze({ bytes, sha256: requiredSha256(value.sha256, `${label} digest`) });
}
