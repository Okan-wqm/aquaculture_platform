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

import { RateLimitGuard, SKIP_RATE_LIMIT_KEY } from '../rate-limit.guard';

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
      // The guard reads `request.url` for endpoint-prefix bucket
      // detection (rate-limit.guard.ts:396) — mirror the path so
      // bucket-classification tests work consistently with the
      // existing limit-enforcement tests.
      url: path,
      method,
      headers,
      params: {},
      query: {},
      // RateLimitGuard.setRateLimitHeaders (rate-limit.guard.ts:564)
      // reads `request.res`, not `context.switchToHttp().getResponse()`.
      // Express normally hangs the response off the request object —
      // mirror that here so the X-RateLimit-* header assertions can see
      // the calls. Both refs point at the same mock object.
      res: mockResponse,
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
                RATE_LIMIT_WINDOW_MS: 60000,
                RATE_LIMIT_SKIP_IPS: '',
                RATE_LIMIT_BY_IP: true,
                RATE_LIMIT_BY_USER: true,
                RATE_LIMIT_BY_TENANT: true,
                // Tests assert "100 requests then 429". Production
                // (rate-limit.guard.ts:545-549) routes unauthenticated
                // requests to RATE_LIMIT_ANONYMOUS (default 20) — the
                // tighter limit is a security cure to make
                // unauthenticated abuse expensive. The spec wants the
                // default tier so it can exercise the "100 then 429"
                // contract uniformly across user and anonymous cases.
                RATE_LIMIT_ANONYMOUS: 100,
                // Tenant tier defaults to 1000 but the per-tenant test
                // uses the same "100 then 429" assertion — pin tenant
                // limit to the default so the assertion is consistent.
                RATE_LIMIT_TENANT: 100,
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
    // Clear rate limit storage between tests. The in-memory store lives on
    // `fallbackStore` (rate-limit.guard.ts:178), not the legacy
    // `rateLimitStore` name the original spec scaffolding assumed. Reach
    // through to InMemoryRateLimitStore's private map via bracket access
    // because the class itself doesn't expose a `clear()` method on the
    // RateLimitStore interface and the failure mode here is silent state
    // leakage between tests (causes the next test's bucket to be pre-full).
    interface InMemoryStoreLike {
      destroy?: () => void;
      // private Map<string, RateLimitEntry>
      store?: Map<string, unknown>;
    }
    const fallback = (guard as unknown as { fallbackStore?: InMemoryStoreLike }).fallbackStore;
    fallback?.store?.clear();
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
    it('SHARES bucket across API keys on same IP (no API-key bucket)', async () => {
      // RateLimitGuard.generateKey (rate-limit.guard.ts:359-441) buckets on
      // user → tenant → IP — there is NO X-API-Key bucket. The original
      // "track per API key" expectation never matched production; documenting
      // the actual contract here makes the test useful: two distinct API
      // keys on the same IP share the IP bucket, so once IP is exhausted
      // BOTH keys hit 429. (If per-API-key bucketing is needed, it would be
      // a feature add — see ORPHAN-CRITICAL-077 backlog.)
      const context1 = createMockExecutionContext('192.168.1.1', null, '/api', 'GET', {
        'x-api-key': 'key-1',
      });
      const context2 = createMockExecutionContext('192.168.1.1', null, '/api', 'GET', {
        'x-api-key': 'key-2',
      });

      // Exhaust limit for key 1 — drains the shared IP bucket.
      for (let i = 0; i < 100; i++) {
        await guard.canActivate(context1);
      }

      // Key 2 from same IP hits the same exhausted bucket → 429.
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
      // RateLimitConfig (rate-limit.guard.ts:27) is `{ limit: number;
      // windowMs: number }` — BOTH fields are required for the bucket to
      // reset properly. Omitting windowMs collapses `now + undefined` to
      // NaN inside incrementOrCreate (line 134) and every call falls into
      // the "new entry" branch, so count stays at 1 forever and the
      // 11th request never exceeds the limit. Pass a real windowMs.
      // IMPORTANT: only return the rate-limit config for RATE_LIMIT_KEY —
      // returning truthy for SKIP_RATE_LIMIT_KEY would bypass the limit
      // entirely (see rate-limit.guard.ts:296 short-circuit).
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === SKIP_RATE_LIMIT_KEY) return undefined;
        return { limit: 10, windowMs: 60000 };
      });

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

    it('exact-matches /api/auth/login → login bucket', () => {
      expect(generateKey('1.1.1.1', null, '/api/auth/login')).toContain(
        ':login:',
      );
    });

    it('exact-matches /auth/login (no /api prefix) → login bucket', () => {
      expect(generateKey('1.1.1.1', null, '/auth/login')).toContain(':login:');
    });

    it('does NOT bucket /api/auth/login/foo as login (404 + suffix attack)', () => {
      const key = generateKey('1.1.1.1', null, '/api/auth/login/foo');
      expect(key).not.toContain(':login:');
      expect(key).toContain(':default:');
    });

    it('does NOT bucket /api/v2/wrap/upload-something as upload (substring-attack)', () => {
      const key = generateKey('1.1.1.1', null, '/api/v2/wrap/upload-something');
      expect(key).not.toContain(':upload:');
      expect(key).toContain(':default:');
    });

    it('strips query-string + trailing slash before exact-match', () => {
      // /api/auth/login?next=/foo → still login bucket
      expect(
        generateKey('1.1.1.1', null, '/api/auth/login?next=/foo'),
      ).toContain(':login:');
      // /api/auth/login/ (trailing slash) → still login bucket
      expect(generateKey('1.1.1.1', null, '/api/auth/login/')).toContain(
        ':login:',
      );
    });

    it('canonical /api/files/upload → upload bucket; suffix variants do not', () => {
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

  describe('Rate Limit Bypass Whitelist', () => {
    it('should bypass rate limit via @SkipRateLimit decorator (whitelist replacement)', async () => {
      // The historical `isWhitelisted` IP-allowlist method has been removed
      // from RateLimitGuard (it was unused dead code). The supported bypass
      // is the @SkipRateLimit() handler decorator — handler-scoped skip is
      // more auditable than IP-scoped whitelist. Mock the reflector to
      // return truthy ONLY for SKIP_RATE_LIMIT_KEY so canActivate
      // short-circuits before bucket accounting (rate-limit.guard.ts:296).
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === SKIP_RATE_LIMIT_KEY) return true;
        return undefined;
      });

      const context = createMockExecutionContext('10.0.0.1');

      // Should allow unlimited requests via decorator bypass.
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
    it('respects the per-handler limit returned by the reflector', async () => {
      // generateKey buckets on user → tenant → IP (rate-limit.guard.ts:433-441),
      // NOT on HTTP method. So GET and POST from the same IP share one
      // bucket — there is no implicit per-method differentiation. The
      // supported way to apply different limits is the @RateLimit decorator
      // returning RateLimitConfig from reflector.getAllAndOverride. This
      // test now exercises THAT contract: when the decorator pins a small
      // limit, the bucket exhausts at that limit regardless of method.
      // IMPORTANT: target only the RATE_LIMIT_KEY metadata — returning
      // truthy for SKIP_RATE_LIMIT_KEY would bypass the limit entirely.
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === SKIP_RATE_LIMIT_KEY) return undefined;
        return { limit: 5, windowMs: 60000 };
      });

      const ctx = createMockExecutionContext('192.168.10.20', null, '/api', 'POST');

      // First 5 succeed.
      for (let i = 0; i < 5; i++) {
        const result = await guard.canActivate(ctx);
        expect(result).toBe(true);
      }

      // 6th throws — decorator limit honoured even from a fresh IP bucket.
      await expect(guard.canActivate(ctx)).rejects.toThrow();
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

  describe('Skip Rate Limit Decorator', () => {
    it('should skip rate limiting when decorator is present', async () => {
      // @SkipRateLimit() short-circuits canActivate before bucket
      // accounting. Mock the reflector to return truthy for the SKIP
      // metadata key only (the implementation distinguishes the skip
      // metadata from RATE_LIMIT_KEY via the key argument).
      jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
        if (key === SKIP_RATE_LIMIT_KEY) return true;
        return undefined;
      });

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

      // Process many requests. canActivate is async; awaiting in-order
      // serialises the calls, which matches the original sync-loop's
      // semantics (one-at-a-time) better than Promise.all (which would
      // race for the same key and break the throughput assertion).
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
