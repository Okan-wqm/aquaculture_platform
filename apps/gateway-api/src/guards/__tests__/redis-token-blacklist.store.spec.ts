import { RedisService } from '@aquaculture/backend-common/redis';

import { RedisTokenBlacklistStore, InMemoryTokenBlacklistStore } from '../redis-token-blacklist.store';

/**
 * Tests for RedisTokenBlacklistStore and InMemoryTokenBlacklistStore.
 * Verifies security-critical token blacklist behavior including fail-closed semantics.
 *
 * RedisService's constructor needs a connection-config object; we instantiate it via
 * Object.create(RedisService.prototype) so the prototype chain (and therefore
 * `instanceof RedisService` checks) is satisfied without firing the real Redis
 * connection. We then attach get/set jest mocks directly on the bare instance.
 */
interface RedisGetSetMock {
  get: jest.Mock<Promise<string | null>, [key: string]>;
  set: jest.Mock<Promise<string | null>, [key: string, value: string, ttl?: number]>;
}

function createRedisServiceMock(): RedisService & RedisGetSetMock {
  // Build a bare RedisService instance whose prototype is the real class so
  // `instanceof RedisService` succeeds, but no real connection is opened.
  const stub = Object.create(RedisService.prototype) as RedisService & RedisGetSetMock;
  stub.get = jest.fn();
  stub.set = jest.fn();
  return stub;
}

describe('RedisTokenBlacklistStore', () => {
  let store: RedisTokenBlacklistStore;
  let mockRedisService: RedisService & RedisGetSetMock;

  beforeEach(() => {
    mockRedisService = createRedisServiceMock();
    store = new RedisTokenBlacklistStore(mockRedisService);
  });

  describe('add', () => {
    it('should add token to blacklist with correct TTL', async () => {
      const jti = 'test-jti-123';
      const exp = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

      mockRedisService.set.mockResolvedValue('OK');

      await store.add(jti, exp);

      expect(mockRedisService.set).toHaveBeenCalledWith(
        `token:blacklist:${jti}`,
        '1',
        expect.any(Number),
      );

      // TTL should be approximately 3600 seconds (within a few seconds margin)
      const actualTtl = mockRedisService.set.mock.calls[0]?.[2];
      expect(actualTtl).toBeGreaterThan(3595);
      expect(actualTtl).toBeLessThanOrEqual(3600);
    });

    it('should set minimum TTL of 1 second for expired tokens', async () => {
      const jti = 'test-jti-expired';
      const exp = Math.floor(Date.now() / 1000) - 100; // Already expired

      mockRedisService.set.mockResolvedValue('OK');

      await store.add(jti, exp);

      const actualTtl = mockRedisService.set.mock.calls[0]?.[2];
      expect(actualTtl).toBe(1);
    });

    it('should not throw when Redis fails (fail-open for add operation)', async () => {
      const jti = 'test-jti-fail';
      const exp = Math.floor(Date.now() / 1000) + 3600;

      mockRedisService.set.mockRejectedValue(new Error('Redis connection failed'));

      // Should not throw
      await expect(store.add(jti, exp)).resolves.not.toThrow();
    });
  });

  describe('isBlacklisted', () => {
    it('should return true when token is blacklisted', async () => {
      const jti = 'blacklisted-token';
      mockRedisService.get.mockResolvedValue('1');

      const result = await store.isBlacklisted(jti);

      expect(result).toBe(true);
      expect(mockRedisService.get).toHaveBeenCalledWith(`token:blacklist:${jti}`);
    });

    it('should return false when token is not blacklisted', async () => {
      const jti = 'valid-token';
      mockRedisService.get.mockResolvedValue(null);

      const result = await store.isBlacklisted(jti);

      expect(result).toBe(false);
    });

    it('SECURITY: should return true (fail-closed) when Redis fails', async () => {
      const jti = 'unknown-token';
      mockRedisService.get.mockRejectedValue(new Error('Redis connection failed'));

      const result = await store.isBlacklisted(jti);

      // SECURITY CRITICAL: When we can't verify, assume token is blacklisted
      // This prevents revoked tokens from being used during Redis outages
      expect(result).toBe(true);
    });

    it('SECURITY: should return true (fail-closed) on Redis timeout', async () => {
      const jti = 'timeout-token';
      mockRedisService.get.mockRejectedValue(new Error('Redis ETIMEDOUT'));

      const result = await store.isBlacklisted(jti);

      expect(result).toBe(true);
    });
  });
});

describe('InMemoryTokenBlacklistStore', () => {
  let store: InMemoryTokenBlacklistStore;

  beforeEach(() => {
    jest.useFakeTimers();
    store = new InMemoryTokenBlacklistStore();
  });

  afterEach(() => {
    store.onModuleDestroy();
    jest.useRealTimers();
  });

  describe('add', () => {
    it('should add token to in-memory blacklist', async () => {
      const jti = 'mem-token-123';
      const exp = Math.floor(Date.now() / 1000) + 3600;

      await store.add(jti, exp);

      expect(await store.isBlacklisted(jti)).toBe(true);
    });
  });

  describe('isBlacklisted', () => {
    it('should return false for non-blacklisted token', async () => {
      const result = await store.isBlacklisted('non-existent-token');
      expect(result).toBe(false);
    });

    it('should return true for blacklisted token', async () => {
      const jti = 'blacklisted-mem-token';
      await store.add(jti, Math.floor(Date.now() / 1000) + 3600);

      const result = await store.isBlacklisted(jti);
      expect(result).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('should remove expired tokens during cleanup', async () => {
      const expiredJti = 'expired-token';
      const validJti = 'valid-token';

      const now = Math.floor(Date.now() / 1000);
      await store.add(expiredJti, now - 100); // Already expired
      await store.add(validJti, now + 3600); // Still valid

      store.cleanup();

      expect(await store.isBlacklisted(expiredJti)).toBe(false);
      expect(await store.isBlacklisted(validJti)).toBe(true);
    });

    it('should automatically cleanup on interval', async () => {
      const expiredJti = 'auto-cleanup-token';
      await store.add(expiredJti, Math.floor(Date.now() / 1000) - 100);

      // Fast-forward by 60 seconds to trigger cleanup
      jest.advanceTimersByTime(60000);

      expect(await store.isBlacklisted(expiredJti)).toBe(false);
    });
  });
});
