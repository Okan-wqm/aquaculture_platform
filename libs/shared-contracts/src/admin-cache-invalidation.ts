import {
  canonicalWireJsonSha256V1,
  compareUtf16CodeUnits,
  type CanonicalHashAuthorityV1,
} from './canonical-json';

export const ADMIN_CACHE_INVALIDATION_RECEIPT_SCHEMA_VERSION =
  'admin-cache-invalidation-receipt.v1' as const;

export const ADMIN_CACHE_INVALIDATION_RECEIPT_HASH_AUTHORITY_V1: CanonicalHashAuthorityV1 =
  Object.freeze({
    domain: 'aquaculture.admin-cache-invalidation-receipt',
    schemaVersion: 'admin-cache-invalidation-receipt/v1',
  });

export const ADMIN_CACHE_KEY_SET_HASH_AUTHORITY_V1: CanonicalHashAuthorityV1 = Object.freeze({
  domain: 'aquaculture.admin-cache-key-set',
  schemaVersion: 'admin-cache-key-set/v1',
});

export interface AdminCacheInvalidationSelectorV1 {
  readonly kind: 'KEY' | 'PATTERN';
  readonly value: string;
}

export interface AdminCacheInvalidationEvidenceV1 {
  readonly schemaVersion: typeof ADMIN_CACHE_INVALIDATION_RECEIPT_SCHEMA_VERSION;
  readonly namespace: string;
  readonly selector: AdminCacheInvalidationSelectorV1;
  readonly discoveredCount: number;
  readonly discoveredKeysDigest: string;
  readonly deletedCount: number;
  readonly residualCount: number;
  readonly residualKeysDigest: string;
  readonly outcome: 'FULLY_INVALIDATED' | 'RESIDUAL_KEYS_PRESENT';
}

export interface AdminCacheInvalidationReceiptV1 extends AdminCacheInvalidationEvidenceV1 {
  readonly receiptId: string;
}

export function adminCacheKeySetSha256V1(input: {
  readonly namespace: string;
  readonly selector: AdminCacheInvalidationSelectorV1;
  readonly phase: 'DISCOVERED' | 'RESIDUAL';
  readonly keys: readonly string[];
}): string {
  const keys = [...new Set(input.keys)].sort(compareUtf16CodeUnits);
  return canonicalWireJsonSha256V1(ADMIN_CACHE_KEY_SET_HASH_AUTHORITY_V1, {
    namespace: input.namespace,
    selector: input.selector,
    phase: input.phase,
    keys,
  });
}

export function adminCacheInvalidationReceiptSha256V1(
  evidence: AdminCacheInvalidationEvidenceV1,
): string {
  return canonicalWireJsonSha256V1(ADMIN_CACHE_INVALIDATION_RECEIPT_HASH_AUTHORITY_V1, evidence);
}

export function adminCacheInvalidationReceiptHasValidIdentity(
  receipt: AdminCacheInvalidationReceiptV1,
): boolean {
  const { receiptId, ...evidence } = receipt;
  return (
    /^[a-f0-9]{64}$/.test(receiptId) &&
    receiptId === adminCacheInvalidationReceiptSha256V1(evidence)
  );
}
