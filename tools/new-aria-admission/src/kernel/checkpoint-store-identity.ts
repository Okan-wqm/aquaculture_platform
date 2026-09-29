import { isAbsolute, normalize } from 'node:path';

import { canonicalJsonBytes } from './canonical-json';
import { digestBytes, hasExactKeys, isJsonRecord, requiredText } from './evidence-object';
import { requireIdentifier } from './identifiers';
import { parseStrictJson } from './strict-json';

export interface CheckpointStoreIdentity {
  readonly checkpoint_store_id: string;
  readonly canonical_root: string;
  readonly sha256: string;
}

const identityKeys = [
  'schema_version',
  'contract_id',
  'checkpoint_store_id',
  'canonical_root',
] as const;

function canonicalRoot(value: unknown): string {
  const root = requiredText(value, 'checkpoint store canonical root');
  if (!isAbsolute(root) || normalize(root) !== root) {
    throw new TypeError('checkpoint store root must be an absolute canonical path');
  }
  return root;
}

export function checkpointStoreIdentityBytes(checkpointStoreId: string, root: string): Buffer {
  return canonicalJsonBytes({
    schema_version: '1.0.0',
    contract_id: 'new-aria-file-checkpoint-store-identity-v1',
    checkpoint_store_id: requireIdentifier(checkpointStoreId, 'checkpoint store identifier'),
    canonical_root: canonicalRoot(root),
  });
}

export function loadCheckpointStoreIdentity(bytes: Uint8Array): CheckpointStoreIdentity {
  const value = parseStrictJson(bytes);
  if (
    !isJsonRecord(value) ||
    !hasExactKeys(value, identityKeys) ||
    !canonicalJsonBytes(value).equals(Buffer.from(bytes)) ||
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'new-aria-file-checkpoint-store-identity-v1'
  ) {
    throw new TypeError('checkpoint store identity is not a canonical closed document');
  }
  return Object.freeze({
    checkpoint_store_id: requireIdentifier(
      value.checkpoint_store_id,
      'checkpoint store identifier',
    ),
    canonical_root: canonicalRoot(value.canonical_root),
    sha256: digestBytes(bytes),
  });
}
