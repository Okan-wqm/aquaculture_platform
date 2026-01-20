/**
 * RateLimitGuard Tests
 *
 * Comprehensive test suite for rate limiting guard
 */

import { ExecutionContext, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { RateLimitGuard } from '../rate-limit.guard';

describe('RateLimitGuard', () => {
  let guard: RateLimitGuard;
  let reflector: Reflector;

  const createMockExecutionContext = (
    ip = '192.168.1.1',
    user: Record<string, unknown> | null = null,
    path = '/api/v1/test',
    method = 'GET',
    headers: Record<string, string> = {},
  ): ExecutionContext => {
    const mockResponse = {
      setHeader: jest.fn(),
      getHeader: jest.fn(),
    };

    const mockRequest = {
      ip,
      user,
      path,
      method,
      headers,
      params: {},
      query: {},
    };

    return {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
        getResponse: () => mockResponse,
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
      getType: () => 'http',
    } as unknown as ExecutionContext;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RateLimitGuard,
        {
          provide: Reflector,
          useValue: {
            getAllAndOverride: jest.fn().mockReturnValue(null),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: unknown) => {
              const config: Record<string, unknown> = {
                RATE_LIMIT_ENABLED: true,
                RATE_LIMIT_DEFAULT: 100,
                RATE_LIMIT_WINDOW_MS: 60000,
                RATE_LIMIT_SKIP_IPS: '',
                RATE_LIMIT_BY_IP: true,
                RATE_LIMIT_BY_USER: true,
                RATE_LIMIT_BY_TENANT: true,
              };
              return config[key] ?? defaultValue;
            }),
          },
        },
      ],
    }).compile();

    guard = module.get<RateLimitGuard>(RateLimitGuard);
    reflector = module.get<Reflector>(Reflector);
  });

  afterEach(() => {
    // Clear rate limit storage between tests
    guard['rateLimitStore']?.clear();
  });

  describe('Request Limit Enforcement', () => {
    it('should allow requests under the limit', async () => {
      const context = createMockExecutionContext();
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should return 429 when limit is exceeded', async () => {
      const context = createMockExecutionContext();

      // Make requests up to the limit
      for (let i = 0; i < 100; i++) {
        await guard.canActivate(context);
      }

      // Next request should fail
      try {
        await guard.canActivate(context);
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(429);
      }
    });
  });

  describe('Rate Limit Window', () => {
    it('should reset count after window expires (1 minute)', async () => {
      jest.useFakeTimers();
      const context = createMockExecutionContext();

      // Exhaust limit
      for (let i = 0; i < 100; i++) {
        await guard.canActivate(context);
      }

      // Should fail
      await expect(guard.canActivate(context)).rejects.toThrow();

      // Advance time past window
      jest.advanceTimersByTime(61000);

      // Should work again
      const result = await guard.canActivate(context);
      expect(result).toBe(true);

      jest.useRealTimers();
    });

    it('should track requests within window correctly', async () => {
      const context = createMockExecutionContext();

      // Make 50 requests
      for (let i = 0; i < 50; i++) {
        await guard.canActivate(context);
      }

      // Should still allow 50 more
      for (let i = 0; i < 50; i++) {
        const result = await guard.canActivate(context);
        expect(result).toBe(true);
      }

      // 101st should fail
      await expect(guard.canActivate(context)).rejects.toThrow();
    });
  });

  describe('IP-based Rate Limiting', () => {
    it('should track limits per IP address', async () => {
      const context1 = createMockExecutionContext('192.168.1.1');
      const context2 = createMockExecutionContext('192.168.1.2');

      // Exhaust limit for IP 1
      for (let i = 0; i < 100; i++) {
        await guard.canActivate(context1);
      }

      // IP 2 should still work
      const result = await guard.canActivate(context2);
      expect(result).toBe(true);

      // IP 1 should be blocked
      await expect(guard.canActivate(context1)).rejects.toThrow();
    });
  });

  describe('User-based Rate Limiting', () => {
    it('should track limits per user', async () => {
      const context1 = createMockExecutionContext('192.168.1.1', { sub: 'user-1' });
      const context2 = createMockExecutionContext('192.168.1.1', { sub: 'user-2' });

      // Exhaust limit for user 1
      for (let i = 0; i < 100; i++) {
        await guard.canActivate(context1);
      }

      // User 2 should still work
      const result = await guard.canActivate(context2);
      expect(result).toBe(true);
    });
  });

  describe('API Key Rate Limiting', () => {
    it('should track limits per API key', async () => {
      const context1 = createMockExecutionContext('192.168.1.1', null, '/api', 'GET', {
        'x-api-key': 'key-1',
      });
      const context2 = createMockExecutionContext('192.168.1.1', null, '/api', 'GET', {
        'x-api-key': 'key-2',
      });

      // Exhaust limit for key 1
      for (let i = 0; i < 100; i++) {
        await guard.canActivate(context1);
      }

      // Key 2 should still work
      const result = await guard.canActivate(context2);
      expect(result).toBe(true);
    });
  });

  describe('Tenant-based Rate Limiting', () => {
    it('should track limits per tenant', async () => {
      const context1 = createMockExecutionContext('192.168.1.1', { tenantId: 'tenant-1' });
      const context2 = createMockExecutionContext('192.168.1.1', { tenantId: 'tenant-2' });

      // Exhaust limit for tenant 1
      for (let i = 0; i < 100; i++) {
        await guard.canActivate(context1);
      }

      // Tenant 2 should still work
      const result = await guard.canActivate(context2);
      expect(result).toBe(true);
    });
  });

  describe('Endpoint-based Rate Limits', () => {
    it('should apply different limits per endpoint', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ limit: 10 });

      const context = createMockExecutionContext('192.168.1.1', null, '/api/v1/sensitive');

      // Should only allow 10 requests
      for (let i = 0; i < 10; i++) {
        await guard.canActivate(context);
      }

      await expect(guard.canActivate(context)).rejects.toThrow();
    });
  });

  describe('Burst Allowance (Token Bucket)', () => {
    it('should allow burst requests', async () => {
      const context = createMockExecutionContext();

      // Should allow burst of 10 rapid requests
      const startTime = Date.now();
      for (let i = 0; i < 10; i++) {
        const result = await guard.canActivate(context);
        expect(result).toBe(true);
      }
      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(100); // Should be very fast
    });
  });

  describe('Rate Limit Headers', () => {
    it('should set X-RateLimit-Reset header', async () => {
      const context = createMockExecutionContext();
      const response = context.switchToHttp().getResponse();

      await guard.canActivate(context);

      expect(response.setHeader).toHaveBeenCalledWith(
        'X-RateLimit-Reset',
        expect.any(String),
      );
    });

    it('should set X-RateLimit-Remaining header', async () => {
      const context = createMockExecutionContext();
      const response = context.switchToHttp().getResponse();

      await guard.canActivate(context);

      expect(response.setHeader).toHaveBeenCalledWith(
        'X-RateLimit-Remaining',
        expect.any(String),
      );
    });

    it('should set X-RateLimit-Limit header', async () => {
      const context = createMockExecutionContext();
      const response = context.switchToHttp().getResponse();

      await guard.canActivate(context);

      expect(response.setHeader).toHaveBeenCalledWith(
        'X-RateLimit-Limit',
        expect.any(String),
      );
    });

    it('should set Retry-After header when limit exceeded', async () => {
      const context = createMockExecutionContext();
      const response = context.switchToHttp().getResponse();

      // Exhaust limit
      for (let i = 0; i < 100; i++) {
        await guard.canActivate(context);
      }

      try {
        await guard.canActivate(context);
      } catch {
        // Expected
      }

      expect(response.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
    });
  });

  describe('Rate Limit Bypass Whitelist', () => {
    it('should bypass rate limit for whitelisted IPs', async () => {
      // Mock whitelisted IP
      jest.spyOn(guard as any, 'isWhitelisted').mockReturnValue(true);

      const context = createMockExecutionContext('10.0.0.1');

      // Should allow unlimited requests
      for (let i = 0; i < 200; i++) {
        const result = await guard.canActivate(context);
        expect(result).toBe(true);
      }
    });
  });

  describe('Sliding Window Algorithm', () => {
    it('should use sliding window for accurate rate limiting', async () => {
      jest.useFakeTimers();
      const context = createMockExecutionContext();

      // Make 50 requests at time 0
      for (let i = 0; i < 50; i++) {
        await guard.canActivate(context);
      }

      // Advance 30 seconds (half window)
      jest.advanceTimersByTime(30000);

      // Make 50 more requests
      for (let i = 0; i < 50; i++) {
        await guard.canActivate(context);
      }

      // Should be at limit now
      await expect(guard.canActivate(context)).rejects.toThrow();

      // Advance 31 more seconds (past first batch's window)
      jest.advanceTimersByTime(31000);

      // Should allow some requests now
      const result = await guard.canActivate(context);
      expect(result).toBe(true);

      jest.useRealTimers();
    });
  });

  describe('Fixed Window Algorithm', () => {
    it('should reset count at window boundary', async () => {
      jest.useFakeTimers();

      const context = createMockExecutionContext();

      // Make 100 requests
      for (let i = 0; i < 100; i++) {
        await guard.canActivate(context);
      }

      // Advance to next window
      jest.advanceTimersByTime(60001);

      // Full limit available again
      for (let i = 0; i < 100; i++) {
        const result = await guard.canActivate(context);
        expect(result).toBe(true);
      }

      jest.useRealTimers();
    });
  });

  describe('Rate Limit by HTTP Method', () => {
    it('should apply different limits for GET vs POST', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((_, handlers) => {
        const handler = handlers[0];
        // Return different limits based on method
        return handler?.name === 'POST' ? { limit: 10 } : { limit: 100 };
      });

      const getContext = createMockExecutionContext('192.168.1.1', null, '/api', 'GET');
      const postContext = createMockExecutionContext('192.168.1.1', null, '/api', 'POST');

      // GET should allow many requests
      for (let i = 0; i < 100; i++) {
        await guard.canActivate(getContext);
      }

      // POST should have separate limit
      const result = await guard.canActivate(postContext);
      expect(result).toBe(true);
    });
  });

  describe('Concurrent Request Limit', () => {
    it('should handle concurrent requests correctly', async () => {
      const context = createMockExecutionContext();

      // Make 50 concurrent requests
      const promises = Array.from({ length: 50 }, () => guard.canActivate(context));

      const results = await Promise.all(promises);
      expect(results.every((r) => r === true)).toBe(true);
    });

    it('should correctly count concurrent requests', async () => {
      const context = createMockExecutionContext();

      // Make 100 concurrent requests
      const promises = Array.from({ length: 100 }, () => guard.canActivate(context));

      const results = await Promise.all(promises);
      expect(results.filter((r) => r === true).length).toBe(100);

      // Next request should fail
      await expect(guard.canActivate(context)).rejects.toThrow();
    });
  });

  describe('Error Handling', () => {
    it('should include rate limit info in error response', async () => {
      const context = createMockExecutionContext();

      // Exhaust limit
      for (let i = 0; i < 100; i++) {
        await guard.canActivate(context);
      }

      try {
        await guard.canActivate(context);
        fail('Should have thrown');
      } catch (error) {
        const response = (error as HttpException).getResponse();
        expect(response).toHaveProperty('message');
      }
    });
  });

  describe('Skip Rate Limit Decorator', () => {
    it('should skip rate limiting when decorator is present', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

      const context = createMockExecutionContext();

      // Should allow unlimited requests
      for (let i = 0; i < 200; i++) {
        const result = await guard.canActivate(context);
        expect(result).toBe(true);
      }
    });
  });

  describe('Performance', () => {
    it('should handle high throughput efficiently', async () => {
      const startTime = Date.now();
      const contexts = Array.from({ length: 1000 }, (_, i) =>
        createMockExecutionContext(`192.168.1.${i % 255}`),
      );

      // Process many requests
      await Promise.all(contexts.map((ctx) => guard.canActivate(ctx).catch(() => {})));

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(5000); // Should complete in under 5 seconds
    });
  });
});
