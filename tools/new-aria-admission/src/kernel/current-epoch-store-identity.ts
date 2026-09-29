import { isAbsolute, normalize } from 'node:path';

import { canonicalJsonBytes } from './canonical-json';
import {
  digestBytes,
  hasExactKeys,
  isJsonRecord,
  requiredSha256,
  requiredText,
} from './evidence-object';
import { requireIdentifier } from './identifiers';
import { parseStrictJson } from './strict-json';

export interface CurrentEpochStoreIdentity {
  readonly provider_id: string;
  readonly canonical_root: string;
  readonly operator_trust_root_sha256: string;
  readonly signer_principal_id: string;
  readonly signer_key_sha256: string;
  readonly sha256: string;
}

const identityKeys = [
  'schema_version',
  'contract_id',
  'provider_id',
  'canonical_root',
  'operator_trust_root_sha256',
  'signer_principal_id',
  'signer_key_sha256',
];

function canonicalRoot(value: unknown): string {
  const root = requiredText(value, 'current epoch store canonical root');
  if (!isAbsolute(root) || normalize(root) !== root) {
    throw new TypeError('current epoch store root must be an absolute canonical path');
  }
  return root;
}

export function currentEpochStoreIdentityBytes(
  identity: Omit<CurrentEpochStoreIdentity, 'sha256'>,
): Buffer {
  return canonicalJsonBytes({
    schema_version: '1.0.0',
    contract_id: 'new-aria-current-epoch-store-identity-v1',
    provider_id: requireIdentifier(identity.provider_id, 'current epoch provider identifier'),
    canonical_root: canonicalRoot(identity.canonical_root),
    operator_trust_root_sha256: requiredSha256(
      identity.operator_trust_root_sha256,
      'current epoch operator trust root',
    ),
    signer_principal_id: requireIdentifier(
      identity.signer_principal_id,
      'current epoch signer principal',
    ),
    signer_key_sha256: requiredSha256(identity.signer_key_sha256, 'current epoch signer key'),
  });
}

export function loadCurrentEpochStoreIdentity(bytes: Uint8Array): CurrentEpochStoreIdentity {
  const value = parseStrictJson(bytes);
  if (
    !isJsonRecord(value) ||
    !hasExactKeys(value, identityKeys) ||
    !canonicalJsonBytes(value).equals(Buffer.from(bytes)) ||
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'new-aria-current-epoch-store-identity-v1'
  ) {
    throw new TypeError('current epoch store identity is not a canonical closed document');
  }
  return Object.freeze({
    provider_id: requireIdentifier(value.provider_id, 'current epoch provider identifier'),
    canonical_root: canonicalRoot(value.canonical_root),
    operator_trust_root_sha256: requiredSha256(
      value.operator_trust_root_sha256,
      'current epoch operator trust root',
    ),
    signer_principal_id: requireIdentifier(
      value.signer_principal_id,
      'current epoch signer principal',
    ),
    signer_key_sha256: requiredSha256(value.signer_key_sha256, 'current epoch signer key'),
    sha256: digestBytes(bytes),
  });
}
