import { createPublicKey, KeyObject } from 'node:crypto';

import { canonicalJsonBytes, compareCodePoints } from './canonical-json';
import {
  digestBytes,
  hasExactKeys,
  isJsonRecord,
  JsonRecord,
  requiredSha256,
  requiredText,
} from './evidence-object';
import { decodeCanonicalBase64 } from './evidence-trust-root';
import { requireIdentifier } from './identifiers';
import { JsonValue, parseStrictJson } from './strict-json';

export interface OperatorProgressTrustKey {
  readonly principalId: string;
  readonly publicKey: KeyObject;
  readonly encodedKey: string;
  readonly keySha256: string;
}

const rootKeys = ['schema_version', 'contract_id', 'keys'];
const trustKeyKeys = ['principal_id', 'capability', 'public_key_spki_der_base64'];

export function parseCanonicalOperatorRecord(bytes: Uint8Array, label: string): JsonRecord {
  const value = parseStrictJson(bytes);
  if (!isJsonRecord(value)) throw new TypeError(`${label} schema is invalid`);
  if (!canonicalJsonBytes(value).equals(Buffer.from(bytes))) {
    throw new TypeError(`${label} must use canonical JSON`);
  }
  return value;
}

function parseTrustKey(value: JsonValue): OperatorProgressTrustKey {
  if (!isJsonRecord(value) || !hasExactKeys(value, trustKeyKeys)) {
    throw new TypeError('operator trust key schema is invalid');
  }
  if (value.capability !== 'AUTHORIZE_PROGRESS') {
    throw new TypeError('operator trust key capability is invalid');
  }
  const principalId = requireIdentifier(value.principal_id, 'operator trust key principal');
  const encodedKey = requiredText(value.public_key_spki_der_base64, 'operator public key');
  const keyBytes = decodeCanonicalBase64(encodedKey, 'operator public key');
  const publicKey = createPublicKey({ key: keyBytes, format: 'der', type: 'spki' });
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('operator public key is not Ed25519');
  }
  const canonicalKey = publicKey.export({ format: 'der', type: 'spki' });
  if (!canonicalKey.equals(keyBytes)) {
    throw new TypeError('operator public key is not canonical Ed25519 SPKI DER');
  }
  return {
    principalId,
    publicKey,
    encodedKey: canonicalKey.toString('base64'),
    keySha256: digestBytes(canonicalKey),
  };
}

export function loadOperatorProgressTrustKeys(
  trustRootBytes: Uint8Array,
  expectedTrustRootSha256: string,
): readonly OperatorProgressTrustKey[] {
  const expectedDigest = requiredSha256(
    expectedTrustRootSha256,
    'external operator trust root digest',
  );
  if (digestBytes(trustRootBytes) !== expectedDigest) {
    throw new TypeError('operator trust root digest mismatch');
  }
  const root = parseCanonicalOperatorRecord(trustRootBytes, 'operator trust root');
  if (
    !hasExactKeys(root, rootKeys) ||
    root.schema_version !== '1.0.0' ||
    root.contract_id !== 'new-aria-operator-progress-trust-root-v1' ||
    !Array.isArray(root.keys) ||
    root.keys.length === 0
  ) {
    throw new TypeError('operator trust root schema or identity is invalid');
  }
  const keys = root.keys.map(parseTrustKey);
  const principals = keys.map(({ principalId }) => principalId);
  const encodedKeys = keys.map(({ encodedKey }) => encodedKey);
  const unsorted = principals.some(
    (principal, index) =>
      index > 0 && compareCodePoints(principal, principals[index - 1] ?? principal) <= 0,
  );
  if (
    new Set(principals).size !== principals.length ||
    new Set(encodedKeys).size !== encodedKeys.length ||
    unsorted
  ) {
    throw new TypeError('operator trust keys require unique keys and sorted unique principals');
  }
  return keys;
}
