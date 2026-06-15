import { RedisTokenBlacklistStore, InMemoryTokenBlacklistStore } from '../redis-token-blacklist.store';

/**
 * Tests for RedisTokenBlacklistStore and InMemoryTokenBlacklistStore
 * Verifies security-critical token blacklist behavior including fail-closed semantics
 */
describe('RedisTokenBlacklistStore', () => {
  let store: RedisTokenBlacklistStore;
  let mockRedisService: jest.Mocked<{
    get: jest.Mock;
    set: jest.Mock;
    mget: jest.Mock;
  }>;

  beforeEach(() => {
    mockRedisService = {
      get: jest.fn(),
      set: jest.fn(),
      mget: jest.fn(),
    };
    store = new RedisTokenBlacklistStore(mockRedisService as any);
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
      const actualTtl = mockRedisService.set.mock.calls[0][2];
      expect(actualTtl).toBeGreaterThan(3595);
      expect(actualTtl).toBeLessThanOrEqual(3600);
    });

    it('should set minimum TTL of 1 second for expired tokens', async () => {
      const jti = 'test-jti-expired';
      const exp = Math.floor(Date.now() / 1000) - 100; // Already expired

      mockRedisService.set.mockResolvedValue('OK');

      await store.add(jti, exp);

      const actualTtl = mockRedisService.set.mock.calls[0][2];
      expect(actualTtl).toBe(1);
    });

    it('should SURFACE Redis failures (fail-closed for revocation writes)', async () => {
      // WHY inverted contract: a silently-dropped blacklist write means a
      // revoked token KEEPS WORKING — token revocation must fail loudly so
      // the caller (logout / reuse-detection) can escalate, not pretend.
      const jti = 'test-jti-fail';
      const exp = Math.floor(Date.now() / 1000) + 3600;

      mockRedisService.set.mockRejectedValue(new Error('Redis connection failed'));

      await expect(store.add(jti, exp)).rejects.toThrow('Redis connection failed');
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

  describe('isValidToken (PERF-HIGH-002 — single MGET round-trip)', () => {
    const JTI = 'jti-abc';
    const USER = 'user-1';
    const IAT = 1_000_000;

    it('issues ONE mget in [jti, user] order and accepts a clean token', async () => {
      mockRedisService.mget.mockResolvedValue([null, null]);
      await expect(store.isValidToken(JTI, USER, IAT)).resolves.toBe(true);
      expect(mockRedisService.mget).toHaveBeenCalledTimes(1);
      expect(mockRedisService.mget).toHaveBeenCalledWith(
        `token:blacklist:${JTI}`,
        `user_blacklist:${USER}`,
      );
    });

    it('denies when the jti sentinel (index 0) is present', async () => {
      mockRedisService.mget.mockResolvedValue(['1', null]);
      await expect(store.isValidToken(JTI, USER, IAT)).resolves.toBe(false);
    });

    it('denies when the token was issued BEFORE a user-level invalidation (index 1)', async () => {
      mockRedisService.mget.mockResolvedValue([null, String(IAT + 500)]);
      await expect(store.isValidToken(JTI, USER, IAT)).resolves.toBe(false);
    });

    it('accepts when the token was issued AFTER the user-level invalidation', async () => {
      mockRedisService.mget.mockResolvedValue([null, String(IAT - 500)]);
      await expect(store.isValidToken(JTI, USER, IAT)).resolves.toBe(true);
    });

    it('fails CLOSED (returns false) when the store throws', async () => {
      mockRedisService.mget.mockRejectedValue(new Error('redis down'));
      await expect(store.isValidToken(JTI, USER, IAT)).resolves.toBe(false);
    });

    it('treats a non-numeric user invalidation value as not-invalidated', async () => {
      mockRedisService.mget.mockResolvedValue([null, 'not-a-number']);
      await expect(store.isValidToken(JTI, USER, IAT)).resolves.toBe(true);
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
