/**
 * Offline Queue Tests
 *
 * SEC-03: Payload AES-GCM encryption/decryption
 * Queue operations: enqueue, dequeue, cache, sync
 * Retry policy: 3 attempts then permanent fail
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// --------------------------------------------------------------------------
// Mocks — idb-keyval
// --------------------------------------------------------------------------

const idbStore = new Map<string, unknown>();
const cacheIdbStore = new Map<string, unknown>();

// Track which store is being used
let activeStore: Map<string, unknown> = idbStore;

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
    createStore: vi.fn((dbName: string, storeName: string) => {
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
  removeOperation,
  clearAllOperations,
  cacheData,
  getCachedData,
  clearCache,
  syncOperation,
  syncAllOperations,
} from '../offline-queue';

import type { QueuedOperation, OperationPayload } from '@/types';

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('Offline Queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    idbStore.clear();
    cacheIdbStore.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ========================================================================
  // enqueueOperation: Payload AES-GCM encryption
  // ========================================================================

  describe('queueOperation (enqueue)', () => {
    it('should enqueue an operation and return an ID', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const id = await queueOperation('recordMortality', payload);

      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });

    it('should encrypt payload before storing (SEC-03)', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      await queueOperation('recordMortality', payload);

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
      await queueOperation('recordMortality', payload);

      const storedEntries = Array.from(idbStore.values());
      const stored = storedEntries[0] as Record<string, unknown>;
      expect(stored.status).toBe('pending');
      expect(stored.retryCount).toBe(0);
    });

    it('should set createdAt timestamp', async () => {
      const before = new Date().toISOString();
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      await queueOperation('recordMortality', payload);

      const storedEntries = Array.from(idbStore.values());
      const stored = storedEntries[0] as Record<string, unknown>;
      expect(stored.createdAt).toBeTruthy();
    });

    it('should call generateKey on first operation', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      await queueOperation('recordMortality', payload);

      expect(mockGenerateKey).toHaveBeenCalled();
    });

    it('should store operation type', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      await queueOperation('recordMortality', payload);

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
      await queueOperation('recordMortality', payload);

      const pending = await getPendingOperations();

      expect(pending).toHaveLength(1);
      expect(mockDecrypt).toHaveBeenCalled();
    });

    it('should return operations sorted by createdAt', async () => {
      const payload1 = { batchId: 'b1', tankId: 't1', quantity: 1, reason: 'DISEASE' as const };
      const payload2 = { batchId: 'b2', tankId: 't2', quantity: 2, reason: 'STRESS' as const };

      await queueOperation('recordMortality', payload1);
      await queueOperation('recordMortality', payload2);

      const pending = await getPendingOperations();

      expect(pending).toHaveLength(2);
      const time1 = new Date(pending[0].createdAt).getTime();
      const time2 = new Date(pending[1].createdAt).getTime();
      expect(time1).toBeLessThanOrEqual(time2);
    });

    it('should return empty array when no operations', async () => {
      const pending = await getPendingOperations();
      expect(pending).toEqual([]);
    });

    it('should skip operations that fail decryption', async () => {
      // Manually insert a corrupted entry
      idbStore.set('pending_bad', {
        id: 'bad',
        type: 'recordMortality',
        _enc: { iv: 'invalid', ciphertext: 'corrupted' },
        createdAt: new Date().toISOString(),
        retryCount: 0,
        status: 'pending',
      });

      // Make decrypt fail for this entry
      mockDecrypt.mockRejectedValueOnce(new Error('Decryption failed'));

      const pending = await getPendingOperations();
      // The corrupted entry should be skipped
      expect(pending).toHaveLength(0);
    });
  });

  describe('getOperation (single)', () => {
    it('should return single operation by ID', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const id = await queueOperation('recordMortality', payload);

      const op = await getOperation(id);
      expect(op).toBeTruthy();
      expect(op!.id).toBe(id);
    });

    it('should return undefined for non-existent ID', async () => {
      const op = await getOperation('non-existent-id');
      expect(op).toBeUndefined();
    });
  });

  describe('getPendingCount', () => {
    it('should return correct count', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 1, reason: 'DISEASE' as const };
      await queueOperation('recordMortality', payload);
      await queueOperation('recordMortality', payload);

      const count = await getPendingCount();
      expect(count).toBe(2);
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

    it('should decrypt and return cached data', async () => {
      const data = [{ id: 't1', name: 'Tank A' }];
      await cacheData(TEST_TENANT, 'tanks', data, 3600000);

      const cached = await getCachedData<typeof data>(TEST_TENANT, 'tanks');
      expect(cached).toBeTruthy();
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
    it('should sync all pending operations when online', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      await queueOperation('recordMortality', payload);
      await queueOperation('recordMortality', payload);

      const mockExecutor = vi.fn().mockResolvedValue({ success: true });

      const result = await syncAllOperations(mockExecutor);

      expect(result.success).toBe(2);
      expect(result.failed).toBe(0);
      expect(mockExecutor).toHaveBeenCalledTimes(2);
    });

    it('should count failed operations', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      await queueOperation('recordMortality', payload);

      const mockExecutor = vi.fn().mockRejectedValue(new Error('Server error'));

      const result = await syncAllOperations(mockExecutor);

      expect(result.success).toBe(0);
      expect(result.failed).toBe(1);
    });

    it('should reset stale syncing entries before processing (BUG-02)', async () => {
      // Manually insert a stale 'syncing' entry
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const id = await queueOperation('recordMortality', payload);
      await updateOperation(id, { status: 'syncing' });

      const mockExecutor = vi.fn().mockResolvedValue({ success: true });

      const result = await syncAllOperations(mockExecutor);

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
      const id = await queueOperation('recordMortality', payload);

      const mockExecutor = vi.fn().mockRejectedValue(new Error('Fail'));
      const op = await getOperation(id);

      await syncOperation(op!, mockExecutor);

      const updated = await getOperation(id);
      expect(updated!.retryCount).toBe(1);
      expect(updated!.status).toBe('failed');
    });

    it('should skip operations with retryCount >= MAX_RETRY_COUNT (permanent fail)', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const id = await queueOperation('recordMortality', payload);

      // Manually set retryCount to MAX_RETRY_COUNT
      await updateOperation(id, { retryCount: 5, status: 'failed' });

      const mockExecutor = vi.fn().mockResolvedValue({ success: true });

      const result = await syncAllOperations(mockExecutor);

      // Should be counted as failed, not retried
      expect(result.failed).toBe(1);
      expect(result.success).toBe(0);
      expect(mockExecutor).not.toHaveBeenCalled();
    });

    it('should promote retryable failed operations back to pending (BUG-17)', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const id = await queueOperation('recordMortality', payload);

      // Simulate a failed operation with retryCount < MAX_RETRY_COUNT
      await updateOperation(id, { retryCount: 2, status: 'failed', lastError: 'Network timeout' });

      const mockExecutor = vi.fn().mockResolvedValue({ success: true });

      const result = await syncAllOperations(mockExecutor);

      // Should have been promoted to pending and retried successfully
      expect(result.success).toBe(1);
      expect(result.failed).toBe(0);
      expect(mockExecutor).toHaveBeenCalledTimes(1);
    });

    it('should NOT retry operations with permanent error messages', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const id = await queueOperation('recordMortality', payload);

      // Simulate a permanent failure (validation error)
      await updateOperation(id, { retryCount: 1, status: 'failed', lastError: 'Validation failed: quantity must be positive' });

      const mockExecutor = vi.fn().mockResolvedValue({ success: true });

      const result = await syncAllOperations(mockExecutor);

      // Permanent errors should NOT be promoted to pending
      expect(result.failed).toBe(1);
      expect(result.success).toBe(0);
      expect(mockExecutor).not.toHaveBeenCalled();
    });

    it('should truncate error messages to 200 chars (SEC-07)', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const id = await queueOperation('recordMortality', payload);

      const longError = 'A'.repeat(500);
      const mockExecutor = vi.fn().mockRejectedValue(new Error(longError));

      const op = await getOperation(id);
      await syncOperation(op!, mockExecutor);

      const updated = await getOperation(id);
      expect(updated!.lastError!.length).toBeLessThanOrEqual(200);
    });

    it('should remove operation on successful sync', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      const id = await queueOperation('recordMortality', payload);

      const mockExecutor = vi.fn().mockResolvedValue({ success: true });
      const op = await getOperation(id);
      const success = await syncOperation(op!, mockExecutor);

      expect(success).toBe(true);
      const removed = await getOperation(id);
      expect(removed).toBeUndefined();
    });
  });

  // ========================================================================
  // Clear operations
  // ========================================================================

  describe('clearAllOperations', () => {
    it('should remove all queued operations', async () => {
      const payload = { batchId: 'b1', tankId: 't1', quantity: 5, reason: 'DISEASE' as const };
      await queueOperation('recordMortality', payload);
      await queueOperation('recordMortality', payload);

      await clearAllOperations();

      const count = await getPendingCount();
      expect(count).toBe(0);
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
