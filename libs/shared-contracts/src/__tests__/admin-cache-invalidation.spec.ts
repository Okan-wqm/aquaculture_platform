import {
  ADMIN_CACHE_INVALIDATION_RECEIPT_SCHEMA_VERSION,
  adminCacheInvalidationReceiptHasValidIdentity,
  adminCacheInvalidationReceiptSha256V1,
  adminCacheKeySetSha256V1,
  type AdminCacheInvalidationEvidenceV1,
} from '../admin-cache-invalidation';

describe('admin cache invalidation evidence', () => {
  const selector = Object.freeze({ kind: 'PATTERN' as const, value: 'report:*' });

  it('normalizes one exact logical key set under a phase- and namespace-bound digest', () => {
    const digest = adminCacheKeySetSha256V1({
      namespace: 'admin:',
      selector,
      phase: 'DISCOVERED',
      keys: ['report:b', 'report:a', 'report:a'],
    });

    expect(digest).toBe(
      adminCacheKeySetSha256V1({
        namespace: 'admin:',
        selector,
        phase: 'DISCOVERED',
        keys: ['report:a', 'report:b'],
      }),
    );
    expect(digest).not.toBe(
      adminCacheKeySetSha256V1({
        namespace: 'other:',
        selector,
        phase: 'DISCOVERED',
        keys: ['report:a', 'report:b'],
      }),
    );
    expect(digest).not.toBe(
      adminCacheKeySetSha256V1({
        namespace: 'admin:',
        selector,
        phase: 'RESIDUAL',
        keys: ['report:a', 'report:b'],
      }),
    );
  });

  it('verifies the domain-separated receipt identity and rejects altered evidence', () => {
    const evidence: AdminCacheInvalidationEvidenceV1 = {
      schemaVersion: ADMIN_CACHE_INVALIDATION_RECEIPT_SCHEMA_VERSION,
      namespace: 'admin:',
      selector,
      discoveredCount: 2,
      discoveredKeysDigest: 'a'.repeat(64),
      deletedCount: 2,
      residualCount: 0,
      residualKeysDigest: 'b'.repeat(64),
      outcome: 'FULLY_INVALIDATED',
    };
    const receipt = {
      ...evidence,
      receiptId: adminCacheInvalidationReceiptSha256V1(evidence),
    };

    expect(adminCacheInvalidationReceiptHasValidIdentity(receipt)).toBe(true);
    expect(
      adminCacheInvalidationReceiptHasValidIdentity({
        ...receipt,
        deletedCount: 1,
      }),
    ).toBe(false);
  });
});
