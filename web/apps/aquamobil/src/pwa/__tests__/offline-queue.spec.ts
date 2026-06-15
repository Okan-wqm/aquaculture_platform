/**
 * Offline Queue Tests
 *
 * SEC-03: Payload AES-GCM encryption/decryption
 * Queue operations: enqueue, dequeue, cache, sync
 * Retry policy: 3 attempts then permanent fail
 */

import { webcrypto } from 'node:crypto';

import { vi, describe, it, expect, beforeEach } from 'vitest';

// --------------------------------------------------------------------------
// Mocks — idb-keyval
// --------------------------------------------------------------------------

const idbStore = new Map<string, unknown>();
const cacheIdbStore = new Map<string, unknown>();
// Durable KEY store (AES session key + device-id) — a SEPARATE IndexedDB store
// in production ('aquamobil-keys'). Kept distinct here so device-id/key writes
// never pollute the queue store the enqueue tests assert against.
const keyIdbStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => {
  return {
    get: vi.fn((key: string, store?: unknown) => {
      const target = store === 'cache-store' ? cacheIdbStore : (store === 'key-store' ? keyIdbStore : idbStore);
      return Promise.resolve(target.get(key));
    }),
    set: vi.fn((key: string, value: unknown, store?: unknown) => {
      const target = store === 'cache-store' ? cacheIdbStore : (store === 'key-store' ? keyIdbStore : idbStore);
      target.set(key, value);
      return Promise.resolve();
    }),
    del: vi.fn((key: string, store?: unknown) => {
      const target = store === 'cache-store' ? cacheIdbStore : (store === 'key-store' ? keyIdbStore : idbStore);
      target.delete(key);
      return Promise.resolve();
    }),
    keys: vi.fn((store?: unknown) => {
      const target = store === 'cache-store' ? cacheIdbStore : (store === 'key-store' ? keyIdbStore : idbStore);
      return Promise.resolve(Array.from(target.keys()));
    }),
    entries: vi.fn((store?: unknown) => {
      const target = store === 'cache-store' ? cacheIdbStore : (store === 'key-store' ? keyIdbStore : idbStore);
      return Promise.resolve(Array.from(target.entries()));
    }),
    createStore: vi.fn((dbName: string, _storeName: string) => {
      // Return a sentinel so the mock can distinguish stores. The durable KEY
      // store (encryption key + device-id) is a separate store in production
      // ('aquamobil-keys'); the mock must mirror that, else device-id/key writes
      // land in the queue store and break the enqueue assertions.
      if (dbName.includes('cache')) return 'cache-store';
      if (dbName.includes('keys')) return 'key-store';
      return 'queue-store';
    }),
  };
});

// --------------------------------------------------------------------------
// Mocks — crypto.subtle (AES-GCM)
// --------------------------------------------------------------------------

// Simple XOR "encryption" for deterministic testing — not real AES-GCM,
// but exercises the same code paths (generateKey, encrypt, decrypt).
const FAKE_KEY = { type: 'secret', algorithm: 'AES-GCM' };

const mockGenerateKey = vi.fn().mockResolvedValue(FAKE_KEY);
const mockEncrypt = vi.fn().mockImplementation(
  (_algo: unknown, _key: unknown, data: ArrayBuffer) => {
    // Return data as-is (identity transform) — simulates encryption
    return Promise.resolve(new Uint8Array(data).buffer);
  },
);
const mockDecrypt = vi.fn().mockImplementation(
  (_algo: unknown, _key: unknown, data: ArrayBuffer) => {
    // Return data as-is — simulates decryption
    return Promise.resolve(new Uint8Array(data).buffer);
  },
);

Object.defineProperty(globalThis, 'crypto', {
  value: {
    subtle: {
      generateKey: mockGenerateKey,
      encrypt: mockEncrypt,
      decrypt: mockDecrypt,
      // Real SHA-256 via Node's WebCrypto. sha256Hex/attachCommandEnvelope's
      // payloadHash must be a TRUE, collision-free digest because the idempotency
      // (clientCommandId+payloadHash) and offline dedup paths key off it — a fake
      // digest would silently mask hash-collision regressions in those tests.
      digest: (algorithm: AlgorithmIdentifier, data: BufferSource) =>
        webcrypto.subtle.digest(algorithm, data),
    },
    randomUUID: () => `uuid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    getRandomValues: (arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
      return arr;
    },
  },
  configurable: true,
});

// Mock navigator.serviceWorker for background sync registration
Object.defineProperty(globalThis, 'navigator', {
  value: {
    ...globalThis.navigator,
    serviceWorker: {
      ready: Promise.resolve({
        sync: { register: vi.fn() },
      }),
    },
  },
  configurable: true,
  writable: true,
});

// --------------------------------------------------------------------------
// Import after mocks
// --------------------------------------------------------------------------

import {
  queueOperation,
  getPendingOperations,
  getPendingCount,
  getQueueVersion,
  getOperation,
  updateOperation,
  clearAllOperations,
  cacheData,
  getCachedData,
  cacheUserData,
  getCachedUserData,
  clearCache,
  syncOperation,
  syncAllOperations,
} from '../offline-queue';
import { userScopedCacheKey } from '../../utils/user-scoped-cache-key';

/** SECURITY (C11): All queue operations are tenant-scoped. Tests use a fixed tenant UUID. */
const TEST_QUEUE_TENANT = 'tenant-queue-001';

/**
 * FE-HIGH-050: queueOperation now returns a discriminated AddToQueueResult.
 * Most legacy assertions only need the freshly-written op id, so this helper
 * unwraps it and fails loudly if a write was unexpectedly deduped.
 */
async function enqueueId(
  tenantId: string,
  type: Parameters<typeof queueOperation>[1],
  payload: Parameters<typeof queueOperation>[2],
): Promise<string> {
  const result = await queueOperation(tenantId, type, payload);
  if (result.status !== 'queued') {
    throw new Error(`expected a fresh queued op, got status=${result.status}`);
  }
  return result.id;
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('Offline Queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idbStore.clear();
    cacheIdbStore.clear();
    // FE-HIGH-051: the monotonic queue-version token lives in the durable KEY
    // store. Clear it so per-test version assertions start from a clean slate.
    // The session key is module-cached (_sessionKey), so wiping the persisted
    // copy here does not break decryption in the rest of the suite.
    keyIdbStore.clear();
  });

  // NOTE: vi.restoreAllMocks() was removed because it resets factory mock
  // implementations created by vi.mock(), causing idb-keyval mocks (get, set,
  // entries, etc.) to become no-op vi.fn() after the first test cycle. This
  // broke every test that reads data back through the module (getPendingOperations,
  // getOperation, syncAllOperations, etc.). vi.clearAllMocks() in beforeEach
  // already resets call history, which is sufficient.

  // ========================================================================
  // enqueueOperation: Payload AES-GCM encryption
  // ========================================================================

  describe('queueOperation (enqueue)', () => {
    it('should enqueue an operation and return an ID', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const id = await enqueueId(TEST_QUEUE_TENANT, 'recordMortality', payload);

      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });

    it('should encrypt payload before storing (SEC-03)', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload);

      expect(mockEncrypt).toHaveBeenCalled();
      // Verify stored value has _enc envelope, not plaintext payload
      const storedEntries = Array.from(idbStore.values());
      expect(storedEntries.length).toBe(1);
      const stored = storedEntries[0] as Record<string, unknown>;
      expect(stored).toHaveProperty('_enc');
      expect(stored).not.toHaveProperty('payload');
    });

    it('should set status to pending', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload);

      const storedEntries = Array.from(idbStore.values());
      const stored = storedEntries[0] as Record<string, unknown>;
      expect(stored.status).toBe('pending');
      expect(stored.retryCount).toBe(0);
    });

    it('should include tenantId in stored operation (C11)', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload);

      const storedEntries = Array.from(idbStore.values());
      const stored = storedEntries[0] as Record<string, unknown>;
      expect(stored.tenantId).toBe(TEST_QUEUE_TENANT);
    });

    it('should use tenant-scoped key format (C11)', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const id = await enqueueId(TEST_QUEUE_TENANT, 'recordMortality', payload);

      const storedKeys = Array.from(idbStore.keys());
      expect(storedKeys[0]).toBe(`pending_${TEST_QUEUE_TENANT}_${id}`);
    });

    it('should reject when tenantId is empty (C11)', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      await expect(queueOperation('', 'recordMortality', payload)).rejects.toThrow(
        'tenantId is required',
      );
    });

    it('should set createdAt timestamp', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload);

      const storedEntries = Array.from(idbStore.values());
      const stored = storedEntries[0] as Record<string, unknown>;
      expect(stored.createdAt).toBeTruthy();
    });

    // NOTE: The "should call generateKey on first operation" test was removed.
    // The module-level _sessionKey is cached across tests, so generateKey is
    // only called once per module lifecycle (not per test). Encryption is already
    // verified by the "should encrypt payload" test above.

    it('should store operation type', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload);

      const storedEntries = Array.from(idbStore.values());
      const stored = storedEntries[0] as Record<string, unknown>;
      expect(stored.type).toBe('recordMortality');
    });
  });

  // ========================================================================
  // FE-HIGH-050 / FE-MEDIUM-050: payloadHash dedup + discriminated result
  // ========================================================================

  describe('queueOperation dedup (FE-HIGH-050 payloadHash)', () => {
    it('returns { status: "queued" } for a fresh op and writes exactly one entry', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const result = await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload);

      expect(result.status).toBe('queued');
      expect(result.id).toBeTruthy();
      expect(await getPendingCount(TEST_QUEUE_TENANT)).toBe(1);
    });

    it('collapses a byte-identical re-submit onto the existing op (status duplicate, same id)', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const first = await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload);
      const second = await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload);

      expect(first.status).toBe('queued');
      expect(second.status).toBe('duplicate');
      // FE-HIGH-050: the duplicate result points at the EXISTING op, not a new one.
      expect(second.id).toBe(first.id);
      // And no second row was written.
      expect(await getPendingCount(TEST_QUEUE_TENANT)).toBe(1);
    });

    it('does NOT dedup when a single payload field differs', async () => {
      const a = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const b = { batchId: 'b1', tankId: 't1', quantity: 6, reason: 'DISEASE' as const };
      const r1 = await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', a);
      const r2 = await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', b);

      expect(r1.status).toBe('queued');
      expect(r2.status).toBe('queued');
      expect(await getPendingCount(TEST_QUEUE_TENANT)).toBe(2);
    });

    it('FE-MEDIUM-050: dedups identical recordStockMovement (previously un-deduped)', async () => {
      // The old extractResourceId heuristic had no branch for stock movements,
      // so two identical taps both queued. payloadHash dedup now collapses them.
      const input = {
        movementType: 'OUT' as const,
        itemType: 'FEED' as const,
        itemId: 'item-1',
        quantity: 10,
        fromLocationId: 'loc-1',
        idempotencyKey: 'fixed-key-for-dedup',
      };
      const r1 = await queueOperation(TEST_QUEUE_TENANT, 'recordStockMovement', input);
      const r2 = await queueOperation(TEST_QUEUE_TENANT, 'recordStockMovement', input);

      expect(r1.status).toBe('queued');
      expect(r2.status).toBe('duplicate');
      expect(r2.id).toBe(r1.id);
      expect(await getPendingCount(TEST_QUEUE_TENANT)).toBe(1);
    });

    it('FE-MEDIUM-050: dedups identical transferStock (previously un-deduped)', async () => {
      const input = {
        itemType: 'CHEMICAL' as const,
        itemId: 'item-9',
        fromLocationId: 'loc-1',
        toLocationId: 'loc-2',
        quantity: 3,
        idempotencyKey: 'fixed-transfer-key',
      };
      const r1 = await queueOperation(TEST_QUEUE_TENANT, 'transferStock', input);
      const r2 = await queueOperation(TEST_QUEUE_TENANT, 'transferStock', input);

      expect(r1.status).toBe('queued');
      expect(r2.status).toBe('duplicate');
      expect(r2.id).toBe(r1.id);
    });

    it('dedups within tenant only — an identical payload under another tenant still queues', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const r1 = await queueOperation('tenant-A', 'recordMortality', payload);
      const r2 = await queueOperation('tenant-B', 'recordMortality', payload);

      expect(r1.status).toBe('queued');
      expect(r2.status).toBe('queued');
      expect(r2.id).not.toBe(r1.id);
    });
  });

  // ========================================================================
  // FE-HIGH-051: monotonic per-tenant queue version (auto-sync re-arm token)
  // ========================================================================

  describe('queue version (FE-HIGH-051 re-arm token)', () => {
    it('starts at 0 before any enqueue', async () => {
      expect(await getQueueVersion(TEST_QUEUE_TENANT)).toBe(0);
    });

    it('increments on every fresh enqueue', async () => {
      await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', {
        batchId: 'b1', tankId: 't1', quantity: 1, reason: 'DISEASE' as const,
      });
      expect(await getQueueVersion(TEST_QUEUE_TENANT)).toBe(1);

      await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', {
        batchId: 'b2', tankId: 't2', quantity: 2, reason: 'STRESS' as const,
      });
      expect(await getQueueVersion(TEST_QUEUE_TENANT)).toBe(2);
    });

    it('does NOT increment when a submit is deduped (no new content)', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 1, reason: 'DISEASE' as const };
      await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload);
      const afterFirst = await getQueueVersion(TEST_QUEUE_TENANT);

      const dup = await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload);
      expect(dup.status).toBe('duplicate');
      expect(await getQueueVersion(TEST_QUEUE_TENANT)).toBe(afterFirst);
    });

    it('bumps version on a drain-then-enqueue even when the count returns to the same value', async () => {
      // FE-HIGH-051 core case: the OLD count-delta guard could not see this —
      // count goes 1 -> 0 -> 1, an unchanged observation, yet a genuinely new op
      // must sync. The version strictly increases, giving the re-arm signal.
      const first = await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', {
        batchId: 'b1', tankId: 't1', quantity: 1, reason: 'DISEASE' as const,
      });
      const v1 = await getQueueVersion(TEST_QUEUE_TENANT);
      expect(await getPendingCount(TEST_QUEUE_TENANT)).toBe(1);

      // Drain the only op (simulating a completed sync).
      const mockExecutor = vi.fn().mockResolvedValue({ ok: true });
      const firstOp = await getOperation(TEST_QUEUE_TENANT, first.id);
      expect(firstOp).toBeDefined();
      if (!firstOp) throw new Error('expected the queued op to be readable');
      await syncOperation(firstOp, mockExecutor);
      expect(await getPendingCount(TEST_QUEUE_TENANT)).toBe(0);

      // Enqueue a different op — count is back to 1 (same as before), but version moved.
      await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', {
        batchId: 'b9', tankId: 't9', quantity: 9, reason: 'OXYGEN' as const,
      });
      const v2 = await getQueueVersion(TEST_QUEUE_TENANT);
      expect(await getPendingCount(TEST_QUEUE_TENANT)).toBe(1);
      expect(v2).toBeGreaterThan(v1);
    });

    it('resets the version token to 0 on a tenant-scoped clear', async () => {
      await queueOperation('tenant-A', 'recordMortality', {
        batchId: 'b1', tankId: 't1', quantity: 1, reason: 'DISEASE' as const,
      });
      await queueOperation('tenant-B', 'recordMortality', {
        batchId: 'b2', tankId: 't2', quantity: 2, reason: 'STRESS' as const,
      });
      expect(await getQueueVersion('tenant-A')).toBe(1);
      expect(await getQueueVersion('tenant-B')).toBe(1);

      await clearAllOperations('tenant-A');

      // tenant-A's token is wiped; tenant-B's survives.
      expect(await getQueueVersion('tenant-A')).toBe(0);
      expect(await getQueueVersion('tenant-B')).toBe(1);
    });

    it('wipes all version tokens on a full (logout) clear', async () => {
      await queueOperation('tenant-A', 'recordMortality', {
        batchId: 'b1', tankId: 't1', quantity: 1, reason: 'DISEASE' as const,
      });
      await queueOperation('tenant-B', 'recordMortality', {
        batchId: 'b2', tankId: 't2', quantity: 2, reason: 'STRESS' as const,
      });

      await clearAllOperations();

      expect(await getQueueVersion('tenant-A')).toBe(0);
      expect(await getQueueVersion('tenant-B')).toBe(0);
    });
  });

  // ========================================================================
  // dequeueOperation: Decryption + parse
  // ========================================================================

  describe('getPendingOperations (dequeue)', () => {
    it('should decrypt and return queued operations', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload);

      const pending = await getPendingOperations(TEST_QUEUE_TENANT);

      expect(pending).toHaveLength(1);
      expect(mockDecrypt).toHaveBeenCalled();
    });

    it('should return operations sorted by createdAt', async () => {
      const payload1 = { batchId: 'b1', tankId: 't1', quantity: 1, reason: 'DISEASE' as const };
      const payload2 = { batchId: 'b2', tankId: 't2', quantity: 2, reason: 'STRESS' as const };

      await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload1);
      await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload2);

      const pending = await getPendingOperations(TEST_QUEUE_TENANT);

      expect(pending).toHaveLength(2);
      const time1 = new Date(pending[0].createdAt).getTime();
      const time2 = new Date(pending[1].createdAt).getTime();
      expect(time1).toBeLessThanOrEqual(time2);
    });

    it('should return empty array when no operations', async () => {
      const pending = await getPendingOperations(TEST_QUEUE_TENANT);
      expect(pending).toEqual([]);
    });

    it('should only return operations for the requested tenant (C11)', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      await queueOperation('tenant-A', 'recordMortality', payload);
      await queueOperation('tenant-B', 'recordMortality', payload);

      const tenantAOps = await getPendingOperations('tenant-A');
      const tenantBOps = await getPendingOperations('tenant-B');

      expect(tenantAOps).toHaveLength(1);
      expect(tenantAOps[0].tenantId).toBe('tenant-A');
      expect(tenantBOps).toHaveLength(1);
      expect(tenantBOps[0].tenantId).toBe('tenant-B');
    });

    it('should skip operations that fail decryption', async () => {
      // Manually insert a corrupted entry with tenant-scoped key
      idbStore.set(`pending_${TEST_QUEUE_TENANT}_bad`, {
        id: 'bad',
        tenantId: TEST_QUEUE_TENANT,
        type: 'recordMortality',
        _enc: { iv: 'invalid', ciphertext: 'corrupted' },
        _payloadHash: '',
        createdAt: new Date().toISOString(),
        retryCount: 0,
        status: 'pending',
      });

      // Make decrypt fail for this entry
      mockDecrypt.mockRejectedValueOnce(new Error('Decryption failed'));

      const pending = await getPendingOperations(TEST_QUEUE_TENANT);
      // The corrupted entry should be skipped
      expect(pending).toHaveLength(0);
    });
  });

  describe('getOperation (single)', () => {
    it('should store operation with correct tenant-scoped key', async () => {
      const payload = { batchId: 'getop-b1', tankId: 'getop-t1', quantity: 5, reason: 'DISEASE' as const };
      const id = await enqueueId(TEST_QUEUE_TENANT, 'recordMortality', payload);

      // Verify via direct idbStore access (bypasses mock get/entries)
      const expectedKey = `pending_${TEST_QUEUE_TENANT}_${id}`;
      const stored = idbStore.get(expectedKey) as Record<string, unknown>;
      expect(stored).toBeTruthy();
      expect(stored.id).toBe(id);
      expect(stored.tenantId).toBe(TEST_QUEUE_TENANT);
      expect(stored.type).toBe('recordMortality');
    });

    it('should return undefined for non-existent ID', async () => {
      const op = await getOperation(TEST_QUEUE_TENANT, 'non-existent-id');
      expect(op).toBeUndefined();
    });

    it('should return undefined when querying wrong tenant (C11)', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const id = await enqueueId('tenant-A', 'recordMortality', payload);

      const op = await getOperation('tenant-B', id);
      expect(op).toBeUndefined();
    });
  });

  describe('getPendingCount', () => {
    it('should return correct count', async () => {
      // Use unique resourceIds to avoid dedup within the 5s window
      const payload1 = { batchId: 'b1', tankId: 't1', quantity: 1, reason: 'DISEASE' as const };
      const payload2 = { batchId: 'b2', tankId: 't2', quantity: 1, reason: 'STRESS' as const };
      await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload1);
      await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload2);

      const count = await getPendingCount(TEST_QUEUE_TENANT);
      expect(count).toBe(2);
    });

    it('should only count operations for the requested tenant (C11)', async () => {
      const payloadA = { batchId: 'b1', tankId: 't1', quantity: 1, reason: 'DISEASE' as const };
      const payloadB1 = { batchId: 'b2', tankId: 't2', quantity: 1, reason: 'STRESS' as const };
      const payloadB2 = { batchId: 'b3', tankId: 't3', quantity: 1, reason: 'OXYGEN' as const };
      await queueOperation('tenant-A', 'recordMortality', payloadA);
      await queueOperation('tenant-B', 'recordMortality', payloadB1);
      await queueOperation('tenant-B', 'recordMortality', payloadB2);

      expect(await getPendingCount('tenant-A')).toBe(1);
      expect(await getPendingCount('tenant-B')).toBe(2);
    });
  });

  // ========================================================================
  // cacheData: Cache encryption (Wave 4)
  // ========================================================================

  describe('cacheData', () => {
    const TEST_TENANT = 'tenant-test-001';

    it('should encrypt data before caching (SEC-03-A)', async () => {
      await cacheData(TEST_TENANT, 'tanks', [{ id: 't1', name: 'Tank A' }]);

      expect(mockEncrypt).toHaveBeenCalled();
    });

    it('should store with TTL metadata in plaintext', async () => {
      await cacheData(TEST_TENANT, 'tanks', [{ id: 't1' }], 60000);

      // The cache store should have an entry
      const entries = Array.from(cacheIdbStore.values());
      expect(entries.length).toBe(1);
      const entry = entries[0] as Record<string, unknown>;
      expect(entry).toHaveProperty('cachedAt');
      expect(entry).toHaveProperty('expiresAt');
      expect(entry).toHaveProperty('_enc');
    });
  });

  // ========================================================================
  // getCachedData: Decryption + backwards compatibility
  // ========================================================================

  describe('getCachedData', () => {
    const TEST_TENANT = 'tenant-test-001';

    it('should store encrypted data and verify via direct Map access', async () => {
      const data = [{ id: 't1', name: 'Tank A' }];
      await cacheData(TEST_TENANT, 'tanks', data, 3600000);

      // Verify data is in cacheIdbStore directly
      const key = `cache_${TEST_TENANT}:tanks`;
      const stored = cacheIdbStore.get(key) as Record<string, unknown>;
      expect(stored).toBeTruthy();
      expect(stored._enc).toBeTruthy();
      expect(stored.cachedAt).toBeTruthy();
      expect(stored.expiresAt).toBeTruthy();
    });

    it('should return null for expired cache entries', async () => {
      // Insert entry with expired TTL — key format is cache_${tenantId}:${key}
      cacheIdbStore.set(`cache_${TEST_TENANT}:expired`, {
        _enc: { iv: 'abc', ciphertext: 'def' },
        cachedAt: new Date(Date.now() - 7200000).toISOString(),
        expiresAt: new Date(Date.now() - 3600000).toISOString(), // expired 1 hour ago
      });

      const cached = await getCachedData(TEST_TENANT, 'expired');
      expect(cached).toBeNull();
    });

    it('should purge legacy unencrypted entries (backwards compat)', async () => {
      // Legacy entry without _enc — should be purged
      cacheIdbStore.set(`cache_${TEST_TENANT}:legacy`, {
        data: [{ id: 't1' }],
        cachedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });

      const cached = await getCachedData(TEST_TENANT, 'legacy');
      expect(cached).toBeNull();
      // Entry should have been deleted
      expect(cacheIdbStore.has(`cache_${TEST_TENANT}:legacy`)).toBe(false);
    });

    it('should return null for non-existent cache key', async () => {
      const cached = await getCachedData(TEST_TENANT, 'nonexistent');
      expect(cached).toBeNull();
    });
  });

  // ========================================================================
  // MT-CRITICAL-051: per-user cache isolation on a SHARED device.
  // The user-scoped cache key embeds user.id, so two users of the SAME tenant
  // never share a `my*` cache namespace. These tests prove a write by user A is
  // NOT readable by user B (same tenant, same device) and IS readable by user A.
  // ========================================================================

  describe('cacheUserData / getCachedUserData (MT-CRITICAL-051)', () => {
    const TENANT = 'tenant-shared-001';
    const USER_A = 'user-aaaa';
    const USER_B = 'user-bbbb';

    // Re-assert the identity decrypt impl. A sibling test
    // ('should skip operations that fail decryption') queues a
    // mockRejectedValueOnce that, under full-suite run order, can leak forward
    // and reject the FIRST decrypt in this block. mockReset() drains any pending
    // once-implementation; we then restore the base identity impl so these
    // isolation tests are deterministic without touching production code.
    beforeEach(() => {
      mockDecrypt.mockReset();
      mockDecrypt.mockImplementation(
        (_algo: unknown, _key: unknown, data: ArrayBuffer) =>
          Promise.resolve(new Uint8Array(data).buffer),
      );
    });

    it('serves user A their own cached schedule', async () => {
      const keyA = userScopedCacheKey(USER_A, 'schedule', '2026-06-15');
      await cacheUserData(TENANT, keyA, { plannedWorkDays: 5 }, 60_000);

      const read = await getCachedUserData<{ plannedWorkDays: number }>(TENANT, keyA);
      expect(read).toEqual({ plannedWorkDays: 5 });
    });

    it('does NOT serve user A\'s schedule to user B on the same tenant/device', async () => {
      const keyA = userScopedCacheKey(USER_A, 'schedule', '2026-06-15');
      const keyB = userScopedCacheKey(USER_B, 'schedule', '2026-06-15');
      await cacheUserData(TENANT, keyA, { plannedWorkDays: 5 }, 60_000);

      // User B reads with THEIR key for the same tenant/week — must get nothing,
      // because the namespace embeds the user id (the MT-CRITICAL-051 leak fix).
      const readAsB = await getCachedUserData<{ plannedWorkDays: number }>(TENANT, keyB);
      expect(readAsB).toBeNull();
    });

    it('partitions the same domain key by user inside the IndexedDB store', async () => {
      const keyA = userScopedCacheKey(USER_A, 'myTasks');
      const keyB = userScopedCacheKey(USER_B, 'myTasks');
      await cacheUserData(TENANT, keyA, [{ id: 'task-a' }], 60_000);
      await cacheUserData(TENANT, keyB, [{ id: 'task-b' }], 60_000);

      // Two distinct physical IndexedDB keys — no collision, no overwrite.
      expect(cacheIdbStore.has(`cache_${TENANT}:u:${USER_A}:myTasks`)).toBe(true);
      expect(cacheIdbStore.has(`cache_${TENANT}:u:${USER_B}:myTasks`)).toBe(true);

      const readA = await getCachedUserData<Array<{ id: string }>>(TENANT, keyA);
      const readB = await getCachedUserData<Array<{ id: string }>>(TENANT, keyB);
      expect(readA).toEqual([{ id: 'task-a' }]);
      expect(readB).toEqual([{ id: 'task-b' }]);
    });

    it('the logout full clearCache() wipes user-scoped entries too', async () => {
      const keyA = userScopedCacheKey(USER_A, 'leaveBalances', 2026);
      await cacheUserData(TENANT, keyA, [{ remaining: 10 }], 60_000);
      expect(cacheIdbStore.size).toBe(1);

      // No-tenant clearCache() is the logout wipe path (useAuth.clearAllUserData).
      await clearCache();
      expect(cacheIdbStore.size).toBe(0);
      expect(await getCachedUserData(TENANT, keyA)).toBeNull();
    });

    it('userScopedCacheKey rejects an empty userId (no namespace collapse)', () => {
      expect(() => userScopedCacheKey('', 'schedule')).toThrow(/userId is required/);
    });
  });

  // ========================================================================
  // syncPendingOperations: Network online -> flush
  // ========================================================================

  describe('syncAllOperations', () => {
    it('should sync all pending operations for the given tenant', async () => {
      // Use unique resourceIds to avoid dedup within the 5s window
      const payload1 = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const payload2 = { batchId: 'b2', tankId: 't2', quantity: 3, reason: 'STRESS' as const };
      await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload1);
      await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload2);

      const mockExecutor = vi.fn().mockResolvedValue({ success: true });

      const result = await syncAllOperations(TEST_QUEUE_TENANT, mockExecutor);

      expect(result.success).toBe(2);
      expect(result.failed).toBe(0);
      expect(mockExecutor).toHaveBeenCalledTimes(2);
    });

    it('should NOT sync operations from a different tenant (C11)', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      await queueOperation('tenant-A', 'recordMortality', payload);
      await queueOperation('tenant-B', 'recordMortality', payload);

      const mockExecutor = vi.fn().mockResolvedValue({ success: true });

      const result = await syncAllOperations('tenant-A', mockExecutor);

      // Only tenant-A's operation should be synced
      expect(result.success).toBe(1);
      expect(result.failed).toBe(0);
      expect(mockExecutor).toHaveBeenCalledTimes(1);

      // tenant-B's operation should still be in the queue
      const remaining = await getPendingOperations('tenant-B');
      expect(remaining).toHaveLength(1);
    });

    it('should count failed operations', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload);

      const mockExecutor = vi.fn().mockRejectedValue(new Error('Server error'));

      const result = await syncAllOperations(TEST_QUEUE_TENANT, mockExecutor);

      expect(result.success).toBe(0);
      expect(result.failed).toBe(1);
    });

    it('should reset stale syncing entries before processing (BUG-02)', async () => {
      // Manually insert a stale 'syncing' entry
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const id = await enqueueId(TEST_QUEUE_TENANT, 'recordMortality', payload);
      await updateOperation(TEST_QUEUE_TENANT, id, { status: 'syncing' });

      const mockExecutor = vi.fn().mockResolvedValue({ success: true });

      const result = await syncAllOperations(TEST_QUEUE_TENANT, mockExecutor);

      // Stale syncing should be reset to pending and then processed
      expect(result.success).toBe(1);
    });
  });

  // ========================================================================
  // Retry policy: MAX_RETRY_COUNT attempts then permanent fail
  // ========================================================================

  describe('Retry Policy', () => {
    it('should increment retryCount on failure', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const id = await enqueueId(TEST_QUEUE_TENANT, 'recordMortality', payload);

      const mockExecutor = vi.fn().mockRejectedValue(new Error('Fail'));
      const op = await getOperation(TEST_QUEUE_TENANT, id);

      await syncOperation(op!, mockExecutor);

      const updated = await getOperation(TEST_QUEUE_TENANT, id);
      expect(updated!.retryCount).toBe(1);
      expect(updated!.status).toBe('failed');
    });

    it('should skip operations with retryCount >= MAX_RETRY_COUNT (permanent fail)', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const id = await enqueueId(TEST_QUEUE_TENANT, 'recordMortality', payload);

      // Manually set retryCount to MAX_RETRY_COUNT
      await updateOperation(TEST_QUEUE_TENANT, id, { retryCount: 5, status: 'failed' });

      const mockExecutor = vi.fn().mockResolvedValue({ success: true });

      const result = await syncAllOperations(TEST_QUEUE_TENANT, mockExecutor);

      // Should be counted as failed, not retried
      expect(result.failed).toBe(1);
      expect(result.success).toBe(0);
      expect(mockExecutor).not.toHaveBeenCalled();
    });

    it('should promote retryable failed operations back to pending (BUG-17)', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const id = await enqueueId(TEST_QUEUE_TENANT, 'recordMortality', payload);

      // Simulate a failed operation with retryCount < MAX_RETRY_COUNT
      await updateOperation(TEST_QUEUE_TENANT, id, { retryCount: 2, status: 'failed', lastError: 'Network timeout' });

      const mockExecutor = vi.fn().mockResolvedValue({ success: true });

      const result = await syncAllOperations(TEST_QUEUE_TENANT, mockExecutor);

      // Should have been promoted to pending and retried successfully
      expect(result.success).toBe(1);
      expect(result.failed).toBe(0);
      expect(mockExecutor).toHaveBeenCalledTimes(1);
    });

    it('should NOT retry operations with permanent error messages', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const id = await enqueueId(TEST_QUEUE_TENANT, 'recordMortality', payload);

      // Simulate a permanent failure (validation error)
      await updateOperation(TEST_QUEUE_TENANT, id, { retryCount: 1, status: 'failed', lastError: 'Validation failed: quantity must be positive' });

      const mockExecutor = vi.fn().mockResolvedValue({ success: true });

      const result = await syncAllOperations(TEST_QUEUE_TENANT, mockExecutor);

      // Permanent errors should NOT be promoted to pending
      expect(result.failed).toBe(1);
      expect(result.success).toBe(0);
      expect(mockExecutor).not.toHaveBeenCalled();
    });

    it('should truncate error messages to 200 chars (SEC-07)', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const id = await enqueueId(TEST_QUEUE_TENANT, 'recordMortality', payload);

      const longError = 'A'.repeat(500);
      const mockExecutor = vi.fn().mockRejectedValue(new Error(longError));

      const op = await getOperation(TEST_QUEUE_TENANT, id);
      await syncOperation(op!, mockExecutor);

      const updated = await getOperation(TEST_QUEUE_TENANT, id);
      expect(updated!.lastError!.length).toBeLessThanOrEqual(200);
    });

    it('should remove operation on successful sync', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const id = await enqueueId(TEST_QUEUE_TENANT, 'recordMortality', payload);

      const mockExecutor = vi.fn().mockResolvedValue({ success: true });
      const op = await getOperation(TEST_QUEUE_TENANT, id);
      const success = await syncOperation(op!, mockExecutor);

      expect(success).toBe(true);
      const removed = await getOperation(TEST_QUEUE_TENANT, id);
      expect(removed).toBeUndefined();
    });
  });

  // ========================================================================
  // Clear operations
  // ========================================================================

  describe('clearAllOperations', () => {
    it('should remove all queued operations when no tenantId given', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      await queueOperation('tenant-A', 'recordMortality', payload);
      await queueOperation('tenant-B', 'recordMortality', payload);

      await clearAllOperations();

      expect(await getPendingCount()).toBe(0);
    });

    it('should only remove the specified tenant operations (C11)', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      await queueOperation('tenant-A', 'recordMortality', payload);
      await queueOperation('tenant-B', 'recordMortality', payload);

      await clearAllOperations('tenant-A');

      expect(await getPendingCount('tenant-A')).toBe(0);
      expect(await getPendingCount('tenant-B')).toBe(1);
    });
  });

  describe('clearCache', () => {
    const TEST_TENANT = 'tenant-test-001';

    it('should remove all cache entries', async () => {
      await cacheData(TEST_TENANT, 'tanks', [{ id: 't1' }]);
      await cacheData(TEST_TENANT, 'batches', [{ id: 'b1' }]);

      await clearCache();

      expect(await getCachedData(TEST_TENANT, 'tanks')).toBeNull();
      expect(await getCachedData(TEST_TENANT, 'batches')).toBeNull();
    });
  });
});
