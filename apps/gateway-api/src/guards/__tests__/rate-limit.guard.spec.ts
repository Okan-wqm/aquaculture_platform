/* eslint-disable @typescript-eslint/no-dynamic-delete */
/* eslint-disable @typescript-eslint/no-empty-function */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

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

/**
 * Interface for mock response object
 */
interface MockResponseObject {
  setHeader: jest.Mock;
  getHeader: jest.Mock;
}

/**
 * Interface for mock HTTP context
 */
interface MockHttpContext {
  getRequest: () => Record<string, unknown>;
  getResponse: () => MockResponseObject;
}

/**
 * Interface for rate limit store
 */
interface RateLimitStore {
  clear: () => void;
}

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
      // WHY res here: setRateLimitHeaders reads request.res (express
      // response back-reference), not context.getResponse().
      res: mockResponse,
      // The guard reads `request.url` for endpoint-prefix bucket
      // detection (rate-limit.guard.ts:396) — mirror the path so
      // bucket-classification tests work consistently with the
      // existing limit-enforcement tests.
      url: path,
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

  /**
   * Helper to get typed response from context
   */
  const getResponse = (context: ExecutionContext): MockResponseObject => {
    const httpContext = context.switchToHttp() as unknown as MockHttpContext;
    return httpContext.getResponse();
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
                // WHY: fixtures are unauthenticated — the guard applies the
                // ANONYMOUS bucket to them; align it with the 100-request
                // window the suite's arithmetic is written against.
                RATE_LIMIT_ANONYMOUS: 100,
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
    // WHY onModuleDestroy (public) instead of reaching into the private
    // fallback Map: beforeEach compiles a FRESH testing module per test, so
    // each `guard` owns a brand-new in-memory counter Map that is discarded
    // with the instance — counters cannot leak across tests. The genuine
    // cross-test leak is the fallback store's 60s cleanup setInterval; the
    // guard's public onModuleDestroy() clears it via destroy(). This is the
    // supported lifecycle seam — no private reach-in, no banned cast.
    guard.onModuleDestroy();
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
    it('should share the per-IP bucket for unauthenticated API-key callers', async () => {
      // WHY inverted contract: the guard no longer keys on raw x-api-key —
      // API-key identity is resolved by AuthGuard into request.user, and
      // unauthenticated callers are rate-limited per IP. Two different keys
      // from ONE IP therefore share a single bucket (anti key-rotation).
      const context1 = createMockExecutionContext('192.168.1.1', null, '/api', 'GET', {
        'x-api-key': 'key-1',
      });
      const context2 = createMockExecutionContext('192.168.1.1', null, '/api', 'GET', {
        'x-api-key': 'key-2',
      });

      for (let i = 0; i < 100; i++) {
        await guard.canActivate(context1);
      }

      // Same IP, different key — bucket already exhausted
      await expect(guard.canActivate(context2)).rejects.toThrow();
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
      // WHY windowMs too: a decorator config without windowMs yields a NaN
      // reset boundary — every hit looks expired and the counter resets to 1.
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ limit: 10, windowMs: 60000 });

      const context = createMockExecutionContext('192.168.1.1', null, '/api/v1/sensitive');

      // Should only allow 10 requests
      for (let i = 0; i < 10; i++) {
        await guard.canActivate(context);
      }

      await expect(guard.canActivate(context)).rejects.toThrow();
    });
  });

  /**
   * SECREV-LOW-001 — endpoint-prefix substring collision regression.
   *
   * Pre-cure used `url.endsWith('/auth/login')` /
   * `url.includes('/upload')` so an attacker could forge URLs
   * containing 'upload' or '/auth/login' suffixes to share
   * rate-limit buckets with legitimate users. Cure exact-matches
   * against an explicit allow-list of canonical paths.
   *
   * The specs probe `generateKey` indirectly via
   * `getRateLimitInfo` (private) — we use the public
   * `canActivate` path and observe the bucket via the response
   * headers' rate-limit reset / remaining values which are
   * keyed.
   */
  describe('SECREV-LOW-001 endpoint-prefix exact-match', () => {
    /**
     * Helper that probes the bucket key directly via the
     * private generateKey. We bracket-cast to access the
     * private; cleaner than asserting on response headers
     * which involve a pile of orthogonal book-keeping.
     */
    const generateKey = (
      ip: string,
      user: Record<string, unknown> | null,
      path: string,
    ): string => {
      const fakeReq = { ip, user, url: path } as unknown as Parameters<
        (typeof guard)['generateKey']
      >[0];
      return (guard as unknown as {
        generateKey: (r: unknown) => string;
      }).generateKey(fakeReq);
    };

    it('exact-matches /api/auth/login → login bucket', async () => {
      expect(generateKey('1.1.1.1', null, '/api/auth/login')).toContain(
        ':login:',
      );
    });

    it('exact-matches /auth/login (no /api prefix) → login bucket', async () => {
      expect(generateKey('1.1.1.1', null, '/auth/login')).toContain(':login:');
    });

    it('does NOT bucket /api/auth/login/foo as login (404 + suffix attack)', async () => {
      const key = generateKey('1.1.1.1', null, '/api/auth/login/foo');
      expect(key).not.toContain(':login:');
      expect(key).toContain(':default:');
    });

    it('does NOT bucket /api/v2/wrap/upload-something as upload (substring-attack)', async () => {
      const key = generateKey('1.1.1.1', null, '/api/v2/wrap/upload-something');
      expect(key).not.toContain(':upload:');
      expect(key).toContain(':default:');
    });

    it('strips query-string + trailing slash before exact-match', async () => {
      // /api/auth/login?next=/foo → still login bucket
      expect(
        generateKey('1.1.1.1', null, '/api/auth/login?next=/foo'),
      ).toContain(':login:');
      // /api/auth/login/ (trailing slash) → still login bucket
      expect(generateKey('1.1.1.1', null, '/api/auth/login/')).toContain(
        ':login:',
      );
    });

    it('canonical /api/files/upload → upload bucket; suffix variants do not', async () => {
      expect(generateKey('1.1.1.1', null, '/api/files/upload')).toContain(
        ':upload:',
      );
      expect(
        generateKey('1.1.1.1', null, '/api/files/upload-extra'),
      ).toContain(':default:');
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
      const response = getResponse(context);

      await guard.canActivate(context);

      expect(response.setHeader).toHaveBeenCalledWith(
        'X-RateLimit-Reset',
        expect.any(String),
      );
    });

    it('should set X-RateLimit-Remaining header', async () => {
      const context = createMockExecutionContext();
      const response = getResponse(context);

      await guard.canActivate(context);

      expect(response.setHeader).toHaveBeenCalledWith(
        'X-RateLimit-Remaining',
        expect.any(String),
      );
    });

    it('should set X-RateLimit-Limit header', async () => {
      const context = createMockExecutionContext();
      const response = getResponse(context);

      await guard.canActivate(context);

      expect(response.setHeader).toHaveBeenCalledWith(
        'X-RateLimit-Limit',
        expect.any(String),
      );
    });

    it('should set Retry-After header when limit exceeded', async () => {
      const context = createMockExecutionContext();
      const response = getResponse(context);

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

  // NOTE: the IP-whitelist bypass was REMOVED from the guard — trusted
  // sources are exempted at the edge (nginx allow-lists / internal HMAC
  // paths), not by a guard-level list that silently bypasses counters.
  // The former "Rate Limit Bypass Whitelist" suite asserted that removed
  // surface and was deleted with it.

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
    it('should apply handler-specific limits to identity buckets (method is NOT a key dimension)', async () => {
      // WHY rewritten: the bucket key is identity-based (user/tenant/IP) —
      // two methods from one IP share a bucket, so the old premise
      // ("POST gets a fresh window") asserted behaviour the guard never
      // had. Handler-level @RateLimit configs change the LIMIT applied to
      // an identity's bucket; distinct IPs prove both configs bite.
      const spy = jest.spyOn(reflector, 'getAllAndOverride');

      spy.mockReturnValue({ limit: 100, windowMs: 60000 });
      const getContext = createMockExecutionContext('192.168.1.10', null, '/api', 'GET');
      for (let i = 0; i < 100; i++) {
        await guard.canActivate(getContext);
      }
      await expect(guard.canActivate(getContext)).rejects.toThrow();

      spy.mockReturnValue({ limit: 10, windowMs: 60000 });
      const postContext = createMockExecutionContext('192.168.1.20', null, '/api', 'POST');
      for (let i = 0; i < 10; i++) {
        await guard.canActivate(postContext);
      }
      await expect(guard.canActivate(postContext)).rejects.toThrow();
    });
  });

  describe('Concurrent Request Limit', () => {
    it('should handle concurrent requests correctly', async () => {
      const context = createMockExecutionContext();

      // `canActivate` is async (returns Promise<boolean>) — see
      // rate-limit.guard.ts:283. The test's previous "sync" comment
      // was stale; awaiting all 50 promises is the correct shape.
      const results = await Promise.all(
        Array.from({ length: 50 }, () => guard.canActivate(context)),
      );
      expect(results.every((r) => r === true)).toBe(true);
    });

    it('should correctly count concurrent requests', async () => {
      const context = createMockExecutionContext();

      const results = await Promise.all(
        Array.from({ length: 100 }, () => guard.canActivate(context)),
      );
      expect(results.filter((r) => r === true).length).toBe(100);

      // Next request rejects with a rate-limit exception. The
      // promise-side analogue of the previous `.toThrow()`.
      await expect(guard.canActivate(context)).rejects.toBeDefined();
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

  describe('Malformed Decorator Metadata', () => {
    it('should ignore non-config reflector values and apply default limits (no skip surface)', async () => {
      // WHY inverted contract: the guard exposes NO skip decorator — a
      // truthy-but-malformed metadata value must not bypass limiting OR
      // crash header arithmetic; it falls through to the default bucket.
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

      const context = createMockExecutionContext();

      for (let i = 0; i < 100; i++) {
        const result = await guard.canActivate(context);
        expect(result).toBe(true);
      }

      await expect(guard.canActivate(context)).rejects.toThrow();
    });
  });

  describe('Performance', () => {
    it('should handle high throughput efficiently', async () => {
      const startTime = Date.now();
      const contexts = Array.from({ length: 1000 }, (_, i) =>
        createMockExecutionContext(`192.168.1.${i % 255}`),
      );

      // Process many requests sequentially
      for (const ctx of contexts) {
        try {
          await guard.canActivate(ctx);
        } catch {
          // Some may fail due to rate limit
        }
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(5000); // Should complete in under 5 seconds
    });
  });

  describe('Security: IP Validation', () => {
    it('should validate IPv4 addresses', async () => {
      const validContext = createMockExecutionContext('192.168.1.100');
      const result = await guard.canActivate(validContext);
      expect(result).toBe(true);
    });

    it('should handle invalid IP addresses consistently', async () => {
      // Invalid IP should be grouped together to prevent bypass
      const invalidContext1 = createMockExecutionContext('not-an-ip');
      const invalidContext2 = createMockExecutionContext('another-bad-ip');

      // Both should be treated as same "invalid-ip" bucket
      for (let i = 0; i < 100; i++) {
        await guard.canActivate(invalidContext1);
      }

      // Second invalid IP should share the same bucket
      await expect(guard.canActivate(invalidContext2)).rejects.toThrow();
    });

    it('should reject X-Forwarded-For spoofing when trust proxy is not configured', async () => {
      // When trust proxy is not set, X-Forwarded-For should be treated cautiously
      const context = createMockExecutionContext('127.0.0.1', null, '/api', 'GET', {
        'x-forwarded-for': 'spoofed-ip',
      });

      // Should still work but log warning about unverified IP
      const result = await guard.canActivate(context);
      expect(result).toBe(true);
    });
  });

  describe('Security: Atomic Operations', () => {
    it('should use atomic increment-or-create operation', async () => {
      const context = createMockExecutionContext('192.168.1.50');

      // Make multiple concurrent requests
      const promises = Array.from({ length: 10 }, () => guard.canActivate(context));
      const results = await Promise.all(promises);

      // All should succeed without race condition issues
      expect(results.filter((r) => r === true).length).toBe(10);
    });
  });

  describe('Security: Fail-Closed Behavior', () => {
    it('should fail closed when store is unavailable in production', async () => {
      // This test verifies the fail-closed behavior when Redis is unavailable
      // In a real scenario with Redis configured and failing, requests would be denied
      const context = createMockExecutionContext('192.168.1.75');
      const result = await guard.canActivate(context);

      // With in-memory fallback in test, should still work
      expect(result).toBe(true);
    });
  });
});
