import { ThrottlerGuard, SlidingWindowStrategy, THROTTLE_KEY, THROTTLE_SKIP_KEY, ThrottleDefaults } from '@aquaculture/backend-common/security';
import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

describe('ThrottlerGuard', () => {
  let guard: ThrottlerGuard;
  let rateLimiter: SlidingWindowStrategy;
  let reflector: Reflector;

  function createMockContext(overrides?: {
    user?: { sub?: string; userId?: string; tenantId?: string };
    ip?: string;
    headers?: Record<string, string>;
    isSkip?: boolean;
    throttleConfig?: Record<string, unknown>;
  }): ExecutionContext {
    const request = {
      user: overrides?.user,
      ip: overrides?.ip || '127.0.0.1',
      headers: overrides?.headers || {},
      connection: { remoteAddress: overrides?.ip || '127.0.0.1' },
      socket: { remoteAddress: overrides?.ip || '127.0.0.1' },
      tenantId: overrides?.user?.tenantId,
    };

    const response = {
      setHeader: jest.fn(),
    };

    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
      if (key === THROTTLE_SKIP_KEY) return overrides?.isSkip || false;
      if (key === THROTTLE_KEY) return overrides?.throttleConfig || undefined;
      return undefined;
    });

    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
      getType: () => 'http',
    } as unknown as ExecutionContext;
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThrottlerGuard,
        SlidingWindowStrategy,
        Reflector,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              if (key === 'THROTTLE_DEFAULT_LIMIT') return 5; // Low for testing
              if (key === 'THROTTLE_DEFAULT_TTL') return 60;
              if (key === 'THROTTLE_ANONYMOUS_LIMIT') return 3;
              if (key === 'THROTTLE_ENABLED') return true;
              if (key === 'RATE_LIMIT_DEFAULT') return 100;
              if (key === 'RATE_LIMIT_WINDOW_MS') return 60000;
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    guard = module.get(ThrottlerGuard);
    rateLimiter = module.get(SlidingWindowStrategy);
    reflector = module.get(Reflector);
  });

  afterEach(async () => {
    // Clean up the sliding window strategy's interval
    rateLimiter.onModuleDestroy();
  });

  // ========================================================================
  // 1. Basic Allow/Block
  // ========================================================================
  describe('Basic rate limiting', () => {
    it('should allow request when under limit', async () => {
      const context = createMockContext({ user: { sub: 'user-1' } });
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should block request when limit exceeded', async () => {
      const context = createMockContext({
        user: { sub: 'user-block-test' },
        throttleConfig: { limit: 2, ttl: 60 },
      });

      // First 2 requests should pass
      await expect(guard.canActivate(context)).resolves.toBe(true);
      await expect(guard.canActivate(context)).resolves.toBe(true);

      // Third should be blocked
      try {
        await guard.canActivate(context);
        fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        expect((e as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      }
    });

    it('should return 429 status with retryAfter in response', async () => {
      const context = createMockContext({
        user: { sub: 'user-429-test' },
        throttleConfig: { limit: 1, ttl: 60 },
      });

      await guard.canActivate(context);

      try {
        await guard.canActivate(context);
        fail('Should have thrown');
      } catch (e) {
        const response = (e as HttpException).getResponse() as Record<string, unknown>;
        expect(response['statusCode']).toBe(429);
        expect(response['retryAfter']).toBeDefined();
        expect(typeof response['retryAfter']).toBe('number');
      }
    });
  });

  // ========================================================================
  // 2. Skip Throttle
  // ========================================================================
  describe('@SkipThrottle() decorator', () => {
    it('should skip throttling when decorator is present', async () => {
      const context = createMockContext({ isSkip: true });

      // Even with a very low limit, skip should work
      for (let i = 0; i < 100; i++) {
        await expect(guard.canActivate(context)).resolves.toBe(true);
      }
    });
  });

  // ========================================================================
  // 3. Disabled Throttling
  // ========================================================================
  describe('Disabled throttling', () => {
    it('should allow all requests when throttling is disabled', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ThrottlerGuard,
          SlidingWindowStrategy,
          Reflector,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: unknown) => {
                if (key === 'THROTTLE_ENABLED') return false;
                if (key === 'RATE_LIMIT_DEFAULT') return 1;
                if (key === 'RATE_LIMIT_WINDOW_MS') return 60000;
                return defaultValue ?? 1;
              }),
            },
          },
        ],
      }).compile();

      const disabledGuard = module.get(ThrottlerGuard);
      const context = createMockContext();

      // Should always pass even with limit=1
      for (let i = 0; i < 10; i++) {
        await expect(disabledGuard.canActivate(context)).resolves.toBe(true);
      }

      module.get(SlidingWindowStrategy).onModuleDestroy();
    });

    it('APA-368: does NOT honour THROTTLE_ENABLED=false in production (the kill switch cannot nullify pre-auth limits)', async () => {
      // Mock the rate limiter (always blocks) so the guard's isEnabled scoping is
      // tested in isolation — the real SlidingWindowStrategy fail-fasts in prod
      // without Redis, which is a separate contract.
      const alwaysBlocks = {
        consumeWithConfig: jest.fn().mockResolvedValue({
          allowed: false,
          remaining: 0,
          resetTime: new Date(Date.now() + 60000),
          retryAfter: 60,
        }),
      };
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ThrottlerGuard,
          { provide: SlidingWindowStrategy, useValue: alwaysBlocks },
          Reflector,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: unknown) => {
                if (key === 'THROTTLE_ENABLED') return false; // operator tries to disable
                if (key === 'NODE_ENV') return 'production';
                return defaultValue;
              }),
            },
          },
        ],
      }).compile();

      const prodGuard = module.get(ThrottlerGuard);
      // Even though THROTTLE_ENABLED=false, production forces enforcement, so the
      // (always-blocking) limiter runs and a 429 is thrown rather than skipped.
      await expect(prodGuard.canActivate(createMockContext())).rejects.toThrow(HttpException);
    });
  });

  // ========================================================================
  // 4. Per-User vs Per-IP Rate Limiting
  // ========================================================================
  describe('Rate limiting key generation', () => {
    it('should use separate limits for different users', async () => {
      const context1 = createMockContext({
        user: { sub: 'user-a' },
        throttleConfig: { limit: 1, ttl: 60 },
      });
      const context2 = createMockContext({
        user: { sub: 'user-b' },
        throttleConfig: { limit: 1, ttl: 60 },
      });

      // Both should succeed (different users)
      await expect(guard.canActivate(context1)).resolves.toBe(true);
      await expect(guard.canActivate(context2)).resolves.toBe(true);
    });

    it('should use IP-based limiting for anonymous requests', async () => {
      const context1 = createMockContext({
        ip: '192.168.1.1',
        throttleConfig: { limit: 1, ttl: 60 },
      });
      const context2 = createMockContext({
        ip: '192.168.1.2',
        throttleConfig: { limit: 1, ttl: 60 },
      });

      // Different IPs should have separate limits
      await expect(guard.canActivate(context1)).resolves.toBe(true);
      await expect(guard.canActivate(context2)).resolves.toBe(true);
    });

    it('should use IP-based limiting when byIp is configured', async () => {
      const context = createMockContext({
        user: { sub: 'user-1' },
        ip: '10.0.0.1',
        throttleConfig: { limit: 1, ttl: 60, byIp: true, keyPrefix: 'test-ip' },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      // Second request from same IP should fail
      await expect(guard.canActivate(context)).rejects.toThrow();
    });
  });

  // ========================================================================
  // 5. Rate Limit Headers
  // ========================================================================
  describe('Rate limit response headers', () => {
    it('should set X-RateLimit headers on response', async () => {
      const context = createMockContext({
        user: { sub: 'header-test-user' },
        throttleConfig: { limit: 10, ttl: 60 },
      });

      await guard.canActivate(context);

      const response = context.switchToHttp().getResponse();
      expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '10');
      expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(String));
      expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(String));
      expect(response.setHeader).toHaveBeenCalledWith('X-RateLimit-Policy', '10;w=60');
    });

    it('should show decreasing remaining count', async () => {
      const context = createMockContext({
        user: { sub: 'decrement-test' },
        throttleConfig: { limit: 3, ttl: 60 },
      });

      await guard.canActivate(context);
      const response = context.switchToHttp().getResponse();
      const remainingCalls = () =>
        (response.setHeader as jest.Mock).mock.calls.filter(
          (c: unknown[]) => c[0] === 'X-RateLimit-Remaining',
        );

      const firstRemaining = parseInt(
        remainingCalls().at(-1)?.[1] || '0',
      );

      await guard.canActivate(context);
      const secondRemaining = parseInt(
        remainingCalls().at(-1)?.[1] || '0',
      );

      expect(secondRemaining).toBeLessThan(firstRemaining);
    });
  });

  // ========================================================================
  // 6. Custom Throttle Configurations
  // ========================================================================
  describe('Custom throttle configurations', () => {
    it('should use ThrottleDefaults.LOGIN config (5 per 15min, IP-based)', () => {
      expect(ThrottleDefaults.LOGIN.limit).toBe(5);
      expect(ThrottleDefaults.LOGIN.ttl).toBe(900);
      expect(ThrottleDefaults.LOGIN.byIp).toBe(true);
    });

    it('should use ThrottleDefaults.PASSWORD_RESET config (3 per hour, IP-based)', () => {
      expect(ThrottleDefaults.PASSWORD_RESET.limit).toBe(3);
      expect(ThrottleDefaults.PASSWORD_RESET.ttl).toBe(3600);
      expect(ThrottleDefaults.PASSWORD_RESET.byIp).toBe(true);
    });

    it('should use ThrottleDefaults.SENSITIVE config (3 per 5min)', () => {
      expect(ThrottleDefaults.SENSITIVE.limit).toBe(3);
      expect(ThrottleDefaults.SENSITIVE.ttl).toBe(300);
    });

    it('should use custom error message from decorator config', async () => {
      const context = createMockContext({
        user: { sub: 'custom-msg-user' },
        throttleConfig: {
          limit: 1,
          ttl: 60,
          errorMessage: 'Custom: Too many login attempts',
        },
      });

      await guard.canActivate(context);

      try {
        await guard.canActivate(context);
        fail('Should have thrown');
      } catch (e) {
        const response = (e as HttpException).getResponse() as Record<string, unknown>;
        expect(response['message']).toBe('Custom: Too many login attempts');
      }
    });
  });

  // ========================================================================
  // 7. IP Extraction
  // ========================================================================
  describe('IP extraction and validation', () => {
    it('should fall back to unknown-ip for invalid IPs', async () => {
      const context = createMockContext({
        ip: 'not-an-ip',
        headers: {},
        throttleConfig: { limit: 1, ttl: 60 },
      });

      // Should still work (using fallback IP)
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('should handle IPv6 addresses', async () => {
      const context = createMockContext({
        ip: '::ffff:192.168.1.1',
        throttleConfig: { limit: 1, ttl: 60 },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });
  });
});
