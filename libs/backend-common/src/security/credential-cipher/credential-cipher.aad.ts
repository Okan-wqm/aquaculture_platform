import { CREDENTIAL_CIPHER_ERROR_CODES, CredentialCipherError } from './credential-cipher.errors';
import type { CredentialCipherAad } from './credential-cipher.types';

const MAX_AAD_STRING_BYTES = 1_024;

function assertAadString(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_AAD_STRING_BYTES
  ) {
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.AAD_INVALID);
  }
}

/**
 * Produce canonical, collision-safe AAD using a fixed-order JSON tuple.
 * Envelope version and key ID are included so header substitution also fails
 * GCM authentication even if two configured IDs ever reference equal bytes.
 */
export function buildCredentialCipherAad(
  value: CredentialCipherAad,
  envelopeVersion: string,
  keyId: string,
): Buffer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.AAD_INVALID);
  }
  assertAadString(value.tenantId);
  assertAadString(value.table);
  assertAadString(value.rowId);
  assertAadString(value.provider);
  assertAadString(value.purpose);
  assertAadString(envelopeVersion);
  assertAadString(keyId);
  if (!Number.isSafeInteger(value.credentialGeneration) || value.credentialGeneration < 1) {
    throw new CredentialCipherError(CREDENTIAL_CIPHER_ERROR_CODES.AAD_INVALID);
  }

  return Buffer.from(
    JSON.stringify([
      'aquaculture.credential-cipher.aad.v1',
      ['envelopeVersion', envelopeVersion],
      ['keyId', keyId],
      ['tenantId', value.tenantId],
      ['table', value.table],
      ['rowId', value.rowId],
      ['provider', value.provider],
      ['purpose', value.purpose],
      ['credentialGeneration', value.credentialGeneration],
    ]),
    'utf8',
  );
}
