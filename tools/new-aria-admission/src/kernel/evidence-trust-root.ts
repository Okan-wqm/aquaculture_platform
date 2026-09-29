import { createPublicKey, KeyObject } from 'node:crypto';

import { canonicalJsonBytes } from './canonical-json';
import { digestBytes, hasExactKeys, isJsonRecord, requiredText } from './evidence-object';
import { JsonValue, parseStrictJson } from './strict-json';

export type EvidenceCapability = 'APPELLATE' | 'ORACLE' | 'PRODUCE' | 'REVIEW';

export interface EvidenceTrustKey {
  readonly principalId: string;
  readonly capability: EvidenceCapability;
  readonly publicKey: KeyObject;
  readonly encodedKey: string;
}

const rootKeys = ['schema_version', 'contract_id', 'keys'];
const trustKeyKeys = ['principal_id', 'capability', 'public_key_spki_der_base64'];
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export function decodeCanonicalBase64(value: JsonValue | undefined, label: string): Buffer {
  const encoded = requiredText(value, label);
  if (!base64.test(encoded)) throw new TypeError(`${label} is not canonical base64`);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== encoded) {
    throw new TypeError(`${label} is not canonical base64`);
  }
  return bytes;
}

export function evidenceCapability(value: JsonValue | undefined): EvidenceCapability {
  if (value !== 'APPELLATE' && value !== 'ORACLE' && value !== 'PRODUCE' && value !== 'REVIEW') {
    throw new TypeError('evidence signer capability is invalid');
  }
  return value;
}

function parseTrustKey(value: JsonValue): EvidenceTrustKey {
  if (!isJsonRecord(value) || !hasExactKeys(value, trustKeyKeys)) {
    throw new TypeError('evidence trust key schema is invalid');
  }
  const encodedKey = requiredText(value.public_key_spki_der_base64, 'evidence public key');
  const keyBytes = decodeCanonicalBase64(encodedKey, 'evidence public key');
  const publicKey = createPublicKey({ key: keyBytes, format: 'der', type: 'spki' });
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('evidence public key is not Ed25519');
  }
  const canonicalKey = publicKey.export({ format: 'der', type: 'spki' });
  if (!canonicalKey.equals(keyBytes)) {
    throw new TypeError('evidence public key is not canonical Ed25519 SPKI DER');
  }
  return {
    principalId: requiredText(value.principal_id, 'evidence principal ID'),
    capability: evidenceCapability(value.capability),
    publicKey,
    encodedKey: canonicalKey.toString('base64'),
  };
}

export function loadEvidenceTrustKeys(
  bytes: Uint8Array,
  expectedDigest: string,
): readonly EvidenceTrustKey[] {
  const value = parseStrictJson(bytes);
  if (!isJsonRecord(value) || !hasExactKeys(value, rootKeys)) {
    throw new TypeError('evidence trust root schema is invalid');
  }
  if (
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'new-aria-evidence-trust-root-v1' ||
    !Array.isArray(value.keys) ||
    value.keys.length !== 4
  ) {
    throw new TypeError('evidence trust root identity or key set is invalid');
  }
  if (!canonicalJsonBytes(value).equals(Buffer.from(bytes))) {
    throw new TypeError('evidence trust root must use canonical JSON');
  }
  if (digestBytes(bytes) !== expectedDigest) {
    throw new TypeError('evidence trust root digest mismatch');
  }
  const keys = value.keys.map(parseTrustKey);
  const principals = keys.map(({ principalId }) => principalId);
  const encodedKeys = keys.map(({ encodedKey }) => encodedKey);
  const capabilities = keys.map(({ capability }) => capability);
  if (
    new Set(principals).size !== principals.length ||
    new Set(encodedKeys).size !== encodedKeys.length ||
    new Set(capabilities).size !== capabilities.length ||
    principals.some(
      (principal, index) => index > 0 && principal <= (principals[index - 1] ?? principal),
    )
  ) {
    throw new TypeError('evidence trust keys must have unique keys and sorted principals');
  }
  return keys;
}
