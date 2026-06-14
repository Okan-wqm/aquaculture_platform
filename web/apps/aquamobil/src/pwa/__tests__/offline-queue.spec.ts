/**
 * Offline Queue Tests
 *
 * SEC-03: Payload AES-GCM encryption/decryption
 * Queue operations: enqueue, dequeue, cache, sync
 * Retry policy: 3 attempts then permanent fail
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// --------------------------------------------------------------------------
// Mocks — idb-keyval
// --------------------------------------------------------------------------

const idbStore = new Map<string, unknown>();
const cacheIdbStore = new Map<string, unknown>();

vi.mock('idb-keyval', () => {
  return {
    get: vi.fn((key: string, store?: unknown) => {
      const target = store === 'cache-store' ? cacheIdbStore : (store === 'queue-store' ? idbStore : idbStore);
      return Promise.resolve(target.get(key));
    }),
    set: vi.fn((key: string, value: unknown, store?: unknown) => {
      const target = store === 'cache-store' ? cacheIdbStore : (store === 'queue-store' ? idbStore : idbStore);
      target.set(key, value);
      return Promise.resolve();
    }),
    del: vi.fn((key: string, store?: unknown) => {
      const target = store === 'cache-store' ? cacheIdbStore : (store === 'queue-store' ? idbStore : idbStore);
      target.delete(key);
      return Promise.resolve();
    }),
    keys: vi.fn((store?: unknown) => {
      const target = store === 'cache-store' ? cacheIdbStore : (store === 'queue-store' ? idbStore : idbStore);
      return Promise.resolve(Array.from(target.keys()));
    }),
    entries: vi.fn((store?: unknown) => {
      const target = store === 'cache-store' ? cacheIdbStore : (store === 'queue-store' ? idbStore : idbStore);
      return Promise.resolve(Array.from(target.entries()));
    }),
    createStore: vi.fn((dbName: string, _storeName: string) => {
      // Return a sentinel so the mock can distinguish stores
      if (dbName.includes('cache')) return 'cache-store';
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
  getOperation,
  updateOperation,
  clearAllOperations,
  cacheData,
  getCachedData,
  clearCache,
  syncOperation,
  syncAllOperations,
} from '../offline-queue';
import type { OperationPayload } from '@/types';

/** SECURITY (C11): All queue operations are tenant-scoped. Tests use a fixed tenant UUID. */
const TEST_QUEUE_TENANT = 'tenant-queue-001';

/**
 * Build a legacy WQ queue payload (carries the removed `parameters` field) as a
 * structural record, then narrow once to OperationPayload for queueOperation.
 * A single structural `as` keeps the helper free of an `unknown` bridge while
 * still letting the test queue a shape the current type no longer admits.
 */
function asQueuePayload(record: Record<string, unknown>): OperationPayload {
  return record as OperationPayload;
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('Offline Queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idbStore.clear();
    cacheIdbStore.clear();
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
      const id = await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload);

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
      const id = await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload);

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
        _resourceId: '',
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
      const id = await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload);

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
      const id = await queueOperation('tenant-A', 'recordMortality', payload);

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
      const id = await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload);
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
      const id = await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload);

      const mockExecutor = vi.fn().mockRejectedValue(new Error('Fail'));
      const op = await getOperation(TEST_QUEUE_TENANT, id);

      await syncOperation(op!, mockExecutor);

      const updated = await getOperation(TEST_QUEUE_TENANT, id);
      expect(updated!.retryCount).toBe(1);
      expect(updated!.status).toBe('failed');
    });

    it('should skip operations with retryCount >= MAX_RETRY_COUNT (permanent fail)', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const id = await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload);

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
      const id = await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload);

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
      const id = await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload);

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
      const id = await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload);

      const longError = 'A'.repeat(500);
      const mockExecutor = vi.fn().mockRejectedValue(new Error(longError));

      const op = await getOperation(TEST_QUEUE_TENANT, id);
      await syncOperation(op!, mockExecutor);

      const updated = await getOperation(TEST_QUEUE_TENANT, id);
      expect(updated!.lastError!.length).toBeLessThanOrEqual(200);
    });

    it('should remove operation on successful sync', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const id = await queueOperation(TEST_QUEUE_TENANT, 'recordMortality', payload);

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

  // ========================================================================
  // SINGLE-INGRESS (Tier-1): forward-compat WQ payload upgrade on replay.
  //
  // A legacy CreateWaterQualityInput queued BEFORE the `parameters` field was
  // removed must be upgraded to {dynamicParameters, equipmentId} when it is
  // read back for replay, otherwise the production ValidationPipe
  // ({ whitelist, forbidNonWhitelisted }) rejects it and the field worker's
  // offline measurement is silently lost. The transform runs at the single
  // read ingress (decryptOperation), so both getPendingOperations and
  // getOperation surface the upgraded shape.
  // ========================================================================
  describe('water-quality forward-compat migration', () => {
    const WQ_TENANT = 'tenant-wq-001';

    it('folds a legacy `parameters` payload into dynamicParameters and drops `parameters`', async () => {
      // Simulate a payload queued by the OLD app: empty dynamicParameters but a
      // populated legacy `parameters` object.
      const legacy = asQueuePayload({
        equipmentId: 'eq-1',
        measuredAt: '2026-06-14T08:00:00.000Z',
        source: 'MANUAL',
        idempotencyKey: 'idem-1',
        parameters: { temperature: 14, ph: 7.2 },
      });
      await queueOperation(WQ_TENANT, 'createWaterQuality', legacy);

      const [op] = await getPendingOperations(WQ_TENANT);
      const payload = op!.payload as Record<string, unknown>;

      expect(payload).not.toHaveProperty('parameters');
      expect(payload.dynamicParameters).toEqual({ temperature: 14, ph: 7.2 });
      expect(payload.equipmentId).toBe('eq-1');
    });

    it('keeps existing dynamicParameters keys over folded legacy values', async () => {
      const mixed = asQueuePayload({
        equipmentId: 'eq-2',
        measuredAt: '2026-06-14T08:00:00.000Z',
        source: 'MANUAL',
        parameters: { temperature: 99 },
        dynamicParameters: { temperature: 14 },
      });
      await queueOperation(WQ_TENANT, 'createWaterQuality', mixed);

      const [op] = await getPendingOperations(WQ_TENANT);
      const payload = op!.payload as Record<string, unknown>;

      // The newer (validated) dynamicParameters channel wins.
      expect(payload.dynamicParameters).toEqual({ temperature: 14 });
      expect(payload).not.toHaveProperty('parameters');
    });

    it('backfills equipmentId from legacy tankId when equipmentId is absent', async () => {
      const legacyTankOnly = asQueuePayload({
        tankId: 'tank-9',
        measuredAt: '2026-06-14T08:00:00.000Z',
        source: 'MANUAL',
        parameters: { temperature: 12 },
      });
      await queueOperation(WQ_TENANT, 'createWaterQuality', legacyTankOnly);

      const [op] = await getPendingOperations(WQ_TENANT);
      const payload = op!.payload as Record<string, unknown>;

      expect(payload.equipmentId).toBe('tank-9');
      expect(payload.dynamicParameters).toEqual({ temperature: 12 });
    });

    it('leaves an already-migrated payload untouched (idempotent transform)', async () => {
      const modern = asQueuePayload({
        equipmentId: 'eq-3',
        measuredAt: '2026-06-14T08:00:00.000Z',
        source: 'MANUAL',
        dynamicParameters: { temperature: 15, oxygen: 8 },
      });
      await queueOperation(WQ_TENANT, 'createWaterQuality', modern);

      const [op] = await getPendingOperations(WQ_TENANT);
      const payload = op!.payload as Record<string, unknown>;

      expect(payload).not.toHaveProperty('parameters');
      expect(payload.dynamicParameters).toEqual({ temperature: 15, oxygen: 8 });
      expect(payload.equipmentId).toBe('eq-3');
    });

    it('does NOT transform non-WQ operations', async () => {
      const mortality = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      await queueOperation(WQ_TENANT, 'recordMortality', mortality);

      const [op] = await getPendingOperations(WQ_TENANT);
      const payload = op!.payload as Record<string, unknown>;

      // recordMortality legitimately carries tankId; no WQ migration applied.
      expect(payload.tankId).toBe('t1');
      expect(payload).not.toHaveProperty('dynamicParameters');
    });
  });
});
