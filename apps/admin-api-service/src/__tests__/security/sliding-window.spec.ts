import {
  SlidingWindowStrategy,
  type SlidingWindowRedisPort,
} from '@aquaculture/backend-common/security';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

describe('SlidingWindowStrategy', () => {
  let strategy: SlidingWindowStrategy;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SlidingWindowStrategy,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              if (key === 'RATE_LIMIT_DEFAULT') return 5;
              if (key === 'RATE_LIMIT_WINDOW_MS') return 60000;
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    strategy = module.get(SlidingWindowStrategy);
  });

  afterEach(() => {
    strategy.onModuleDestroy();
  });

  // ========================================================================
  // 1. Basic Consume
  // ========================================================================
  describe('consume()', () => {
    it('should allow requests under the limit', async () => {
      const result = await strategy.consume('test:key');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    });

    it('should track remaining requests', async () => {
      const r1 = await strategy.consume('remaining:key');
      const r2 = await strategy.consume('remaining:key');

      expect(r2.remaining).toBeLessThan(r1.remaining);
    });

    it('should return resetTime as a Date', async () => {
      const result = await strategy.consume('date:key');
      expect(result.resetTime).toBeInstanceOf(Date);
      expect(result.resetTime.getTime()).toBeGreaterThan(Date.now());
    });
  });

  // ========================================================================
  // 2. consumeWithConfig - Custom Limits
  // ========================================================================
  describe('consumeWithConfig()', () => {
    it('should allow requests up to custom limit', async () => {
      const key = 'custom:limit';
      const limit = 3;
      const windowMs = 60000;

      const r1 = await strategy.consumeWithConfig(key, limit, windowMs);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(2);

      const r2 = await strategy.consumeWithConfig(key, limit, windowMs);
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(1);

      const r3 = await strategy.consumeWithConfig(key, limit, windowMs);
      expect(r3.allowed).toBe(true);
      expect(r3.remaining).toBe(0);

      // 4th should be blocked
      const r4 = await strategy.consumeWithConfig(key, limit, windowMs);
      expect(r4.allowed).toBe(false);
      expect(r4.remaining).toBe(0);
      expect(r4.retryAfter).toBeGreaterThan(0);
    });

    it('should return retryAfter in seconds when blocked', async () => {
      const key = 'retry:after';
      const limit = 1;
      const windowMs = 30000;

      await strategy.consumeWithConfig(key, limit, windowMs);
      const result = await strategy.consumeWithConfig(key, limit, windowMs);

      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
      expect(result.retryAfter).toBeLessThanOrEqual(30); // Within window
    });

    it('should use separate tracking for different keys', async () => {
      const r1 = await strategy.consumeWithConfig('key-a', 1, 60000);
      const r2 = await strategy.consumeWithConfig('key-b', 1, 60000);

      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
    });
  });

  // ========================================================================
  // 3. Reset
  // ========================================================================
  describe('reset()', () => {
    it('should clear rate limit for a key', async () => {
      const key = 'reset:key';

      // Exhaust the limit
      await strategy.consumeWithConfig(key, 1, 60000);
      const blocked = await strategy.consumeWithConfig(key, 1, 60000);
      expect(blocked.allowed).toBe(false);

      // Reset
      await strategy.reset(key);

      // Should be allowed again
      const afterReset = await strategy.consumeWithConfig(key, 1, 60000);
      expect(afterReset.allowed).toBe(true);
    });

    it('should not affect other keys when resetting one', async () => {
      await strategy.consumeWithConfig('key-x', 1, 60000);
      await strategy.consumeWithConfig('key-y', 1, 60000);

      await strategy.reset('key-x');

      const resultX = await strategy.consumeWithConfig('key-x', 1, 60000);
      const resultY = await strategy.consumeWithConfig('key-y', 1, 60000);

      expect(resultX.allowed).toBe(true); // Reset
      expect(resultY.allowed).toBe(false); // Still blocked
    });
  });

  // ========================================================================
  // 4. Get Current State
  // ========================================================================
  describe('get()', () => {
    it('should return null for unknown key', async () => {
      const result = await strategy.get('nonexistent:key');
      expect(result).toBeNull();
    });

    it('should return current state without consuming a point', async () => {
      const key = 'get:key';
      await strategy.consumeWithConfig(key, 3, 60000);

      const state = await strategy.get(key);
      expect(state).not.toBeNull();
      expect(state!.remaining).toBe(4); // 1 consumed out of default limit (5)

      // Get again - remaining should be same (not decremented)
      const state2 = await strategy.get(key);
      expect(state2!.remaining).toBe(4);
    });
  });

  // ========================================================================
  // 5. Cleanup
  // ========================================================================
  describe('Module lifecycle', () => {
    it('should clean up interval on destroy', () => {
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
      strategy.onModuleDestroy();
      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });
  });
});

describe('SlidingWindowStrategy distributed authority', () => {
  const productionConfig = (redisEnabled: boolean | undefined = true): ConfigService =>
    new ConfigService({
      NODE_ENV: 'production',
      RATE_LIMIT_USE_REDIS: redisEnabled,
    });

  it('fails production composition without Redis', () => {
    expect(() => new SlidingWindowStrategy(productionConfig())).toThrow(
      'RedisService is required for production throttling',
    );
  });

  it('forbids the per-process fallback in production', () => {
    expect(() => new SlidingWindowStrategy(productionConfig(false))).toThrow(
      'RATE_LIMIT_USE_REDIS=false is forbidden in production',
    );
  });

  it('executes the atomic Lua window against the service-prefixed Redis key', async () => {
    const now = Date.now();
    const evalCommand = jest.fn().mockResolvedValue([1, 2, now]);
    const redis: SlidingWindowRedisPort = {
      getKeyPrefix: jest.fn(() => 'admin:'),
      getClient: jest.fn(() => ({
        eval: evalCommand,
        zremrangebyscore: jest.fn(),
        zcard: jest.fn(),
        zrange: jest.fn(),
      })),
      del: jest.fn().mockResolvedValue(1),
    };
    const strategy = new SlidingWindowStrategy(productionConfig(), redis);

    await expect(strategy.consumeWithConfig('failed-auth:ip', 3, 60_000)).resolves.toMatchObject({
      allowed: true,
      remaining: 2,
    });
    expect(evalCommand).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('ZREMRANGEBYSCORE'"),
      1,
      'admin:rate-limit:failed-auth:ip',
      expect.any(String),
      '60000',
      '3',
      '1',
      expect.stringMatching(/^[0-9a-f]{24}$/),
    );
  });
});
