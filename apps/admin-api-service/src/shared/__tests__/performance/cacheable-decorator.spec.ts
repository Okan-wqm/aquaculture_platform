import { Cacheable, CacheInvalidate, CacheInvalidatePattern } from '@aquaculture/backend-common/decorators';

// =============================================================================
// Test Service with Cacheable Decorator
// =============================================================================

class MockRedisService {
  private store = new Map<string, string>();

  async getJson<T>(key: string): Promise<T | null> {
    const value = this.store.get(key);
    if (!value) return null;
    return JSON.parse(value) as T;
  }

  async setJson<T>(key: string, value: T, ttl?: number): Promise<void> {
    this.store.set(key, JSON.stringify(value));
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async deletePattern(pattern: string): Promise<number> {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    let count = 0;
    for (const key of this.store.keys()) {
      if (regex.test(key)) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  getStore(): Map<string, string> {
    return this.store;
  }

  clear(): void {
    this.store.clear();
  }
}

class TestService {
  redisService: MockRedisService;
  computeCount = 0;

  constructor(redis: MockRedisService) {
    this.redisService = redis;
  }

  @Cacheable('user:{0}', 3600)
  async getUser(userId: string): Promise<{ id: string; name: string }> {
    this.computeCount++;
    return { id: userId, name: `User ${userId}` };
  }

  @Cacheable('tenant:{0}:stats', 1800, { skipCache: (result: unknown) => !result })
  async getTenantStats(tenantId: string): Promise<{ count: number } | null> {
    this.computeCount++;
    if (tenantId === 'nonexistent') return null;
    return { count: 42 };
  }

  @Cacheable('config:{0.tenantId}:{0.module}', 7200)
  async getConfig(params: { tenantId: string; module: string }): Promise<Record<string, unknown>> {
    this.computeCount++;
    return { setting: 'value', tenantId: params.tenantId };
  }

  @Cacheable('custom-key', 3600, {
    keyGenerator: (...args: unknown[]) => `generated:${(args[0] as string).toUpperCase()}`,
  })
  async getWithCustomKey(key: string): Promise<string> {
    this.computeCount++;
    return `result-${key}`;
  }

  @CacheInvalidate('user:{0}')
  async updateUser(userId: string, data: { name: string }): Promise<{ id: string; name: string }> {
    return { id: userId, name: data.name };
  }

  @CacheInvalidatePattern('tenant:{0}:*')
  async deleteTenant(tenantId: string): Promise<void> {
    // deletion logic
  }
}

class TestServiceNoRedis {
  computeCount = 0;

  @Cacheable('user:{0}', 3600)
  async getUser(userId: string): Promise<{ id: string; name: string }> {
    this.computeCount++;
    return { id: userId, name: `User ${userId}` };
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('Cacheable Decorator', () => {
  let redis: MockRedisService;
  let service: TestService;

  beforeEach(() => {
    redis = new MockRedisService();
    service = new TestService(redis);
  });

  // ---------------------------------------------------------------------------
  // Basic Cache Behavior
  // ---------------------------------------------------------------------------

  describe('basic caching', () => {
    it('should compute on first call (cache miss)', async () => {
      const result = await service.getUser('user-1');

      expect(result).toEqual({ id: 'user-1', name: 'User user-1' });
      expect(service.computeCount).toBe(1);
    });

    it('should return cached result on second call', async () => {
      await service.getUser('user-1');
      expect(service.computeCount).toBe(1);

      const result = await service.getUser('user-1');
      expect(result).toEqual({ id: 'user-1', name: 'User user-1' });
      expect(service.computeCount).toBe(1); // Still 1, not recomputed
    });

    it('should compute separately for different arguments', async () => {
      await service.getUser('user-1');
      await service.getUser('user-2');

      expect(service.computeCount).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Cache Key Interpolation
  // ---------------------------------------------------------------------------

  describe('cache key interpolation', () => {
    it('should interpolate simple argument indices', async () => {
      await service.getUser('abc');
      expect(redis.getStore().has('user:abc')).toBe(true);
    });

    it('should interpolate object property access', async () => {
      await service.getConfig({ tenantId: 't1', module: 'farm' });
      expect(redis.getStore().has('config:t1:farm')).toBe(true);
    });

    it('should use custom key generator when provided', async () => {
      await service.getWithCustomKey('hello');
      expect(redis.getStore().has('generated:HELLO')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Skip Cache Option
  // ---------------------------------------------------------------------------

  describe('skipCache option', () => {
    it('should not cache null results when skipCache is configured', async () => {
      const result = await service.getTenantStats('nonexistent');

      expect(result).toBeNull();
      expect(redis.getStore().size).toBe(0);
    });

    it('should cache non-null results normally', async () => {
      const result = await service.getTenantStats('tenant-1');

      expect(result).toEqual({ count: 42 });
      expect(redis.getStore().has('tenant:tenant-1:stats')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Cache Invalidation
  // ---------------------------------------------------------------------------

  describe('CacheInvalidate', () => {
    it('should remove cached entry after invalidation', async () => {
      // Populate cache
      await service.getUser('user-1');
      expect(redis.getStore().has('user:user-1')).toBe(true);

      // Invalidate
      await service.updateUser('user-1', { name: 'Updated' });
      expect(redis.getStore().has('user:user-1')).toBe(false);
    });

    it('should return the method result after invalidation', async () => {
      await service.getUser('user-1');
      const result = await service.updateUser('user-1', { name: 'Updated' });

      expect(result).toEqual({ id: 'user-1', name: 'Updated' });
    });
  });

  // ---------------------------------------------------------------------------
  // Cache Pattern Invalidation
  // ---------------------------------------------------------------------------

  describe('CacheInvalidatePattern', () => {
    it('should remove all matching cache entries', async () => {
      // Populate multiple cache entries for the same tenant
      await service.getTenantStats('tenant-1');
      await service.getConfig({ tenantId: 'tenant-1', module: 'farm' });

      expect(redis.getStore().has('tenant:tenant-1:stats')).toBe(true);
      // Note: config key is "config:tenant-1:farm" which won't match "tenant:tenant-1:*"

      // Invalidate all tenant-1 entries
      await service.deleteTenant('tenant-1');

      expect(redis.getStore().has('tenant:tenant-1:stats')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Without Redis Service
  // ---------------------------------------------------------------------------

  describe('without Redis service', () => {
    it('should execute the method directly when no RedisService exists', async () => {
      const noRedisService = new TestServiceNoRedis();

      const result = await noRedisService.getUser('user-1');

      expect(result).toEqual({ id: 'user-1', name: 'User user-1' });
      expect(noRedisService.computeCount).toBe(1);
    });

    it('should always compute when no RedisService exists', async () => {
      const noRedisService = new TestServiceNoRedis();

      await noRedisService.getUser('user-1');
      await noRedisService.getUser('user-1');

      expect(noRedisService.computeCount).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Error Resilience
  // ---------------------------------------------------------------------------

  describe('error resilience', () => {
    it('should fall through to computation when cache read throws', async () => {
      const errorRedis = {
        getJson: jest.fn().mockRejectedValue(new Error('Connection refused')),
        setJson: jest.fn().mockResolvedValue(undefined),
      } as any;

      const errorService = new TestService(errorRedis);
      const result = await errorService.getUser('user-1');

      expect(result).toEqual({ id: 'user-1', name: 'User user-1' });
      expect(errorService.computeCount).toBe(1);
    });

    it('should return result even when cache write throws', async () => {
      const errorRedis = {
        getJson: jest.fn().mockResolvedValue(null),
        setJson: jest.fn().mockRejectedValue(new Error('Write failed')),
      } as any;

      const errorService = new TestService(errorRedis);
      const result = await errorService.getUser('user-1');

      expect(result).toEqual({ id: 'user-1', name: 'User user-1' });
    });
  });
});
