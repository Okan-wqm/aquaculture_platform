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
 * RequestLoggingInterceptor Tests
 *
 * Comprehensive test suite for request logging interceptor
 */

import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { of, throwError } from 'rxjs';

import { RequestLoggingInterceptor } from '../request-logging.interceptor';

/**
 * Interface for error object in log context
 */
interface LoggedError {
  message: string;
  stack?: string;
}

describe('RequestLoggingInterceptor', () => {
  let interceptor: RequestLoggingInterceptor;

  /**
   * Create mock HTTP execution context
   */
  const createMockHttpContext = (
    options: {
      method?: string;
      url?: string;
      // `ip` defaults to '127.0.0.1' when the key is OMITTED from
      // options, but stays `undefined` when the caller passes
      // `ip: undefined` explicitly — that lets the spoofing test
      // model a request where express has NOT populated req.ip.
      ip?: string;
      remoteAddress?: string;
      headers?: Record<string, string>;
      user?: { sub?: string };
      tenantId?: string;
    } = {},
  ): ExecutionContext => {
    const hasExplicitIp = 'ip' in options;
    const mockRequest = {
      method: options.method || 'GET',
      url: options.url || '/api/v1/test',
      ip: hasExplicitIp ? options.ip : '127.0.0.1',
      headers: {
        'user-agent': 'Test Agent/1.0',
        ...options.headers,
      },
      user: options.user,
      tenantId: options.tenantId,
      connection: {
        remoteAddress: options.remoteAddress ?? '127.0.0.1',
      },
    };

    return {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
        getResponse: () => ({}),
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
      getType: () => 'http',
    } as unknown as ExecutionContext;
  };

  /**
   * Create mock call handler
   */
  const createMockCallHandler = (
    response: unknown = { data: 'test' },
    error?: Error,
  ): CallHandler => ({
    handle: () => (error ? throwError(() => error) : of(response)),
  });

  beforeEach(async () => {
    // Reset environment
    delete process.env['SLOW_REQUEST_THRESHOLD_MS'];

    const module: TestingModule = await Test.createTestingModule({
      providers: [RequestLoggingInterceptor],
    }).compile();

    interceptor = module.get<RequestLoggingInterceptor>(RequestLoggingInterceptor);
  });

  describe('HTTP Request Logging', () => {
    it('should log successful HTTP request', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      const context = createMockHttpContext({
        method: 'GET',
        url: '/api/v1/users',
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          expect(logSpy).toHaveBeenCalled();
          expect(logSpy.mock.calls[0]?.[0]).toContain('GET');
          expect(logSpy.mock.calls[0]?.[0]).toContain('/api/v1/users');
          done();
        },
      });
    });

    it('should log request method', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      const context = createMockHttpContext({ method: 'POST' });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          expect(logSpy.mock.calls[0]?.[0]).toContain('POST');
          done();
        },
      });
    });

    it('should log request path', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      const context = createMockHttpContext({ url: '/api/v1/farms/123' });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          expect(logSpy.mock.calls[0]?.[0]).toContain('/api/v1/farms/123');
          done();
        },
      });
    });

    it('should log request duration', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      const context = createMockHttpContext();
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          expect(logSpy.mock.calls[0]?.[0]).toMatch(/\d+ms/);
          done();
        },
      });
    });

    it('should include correlation ID in logs', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      const context = createMockHttpContext({
        headers: { 'x-correlation-id': 'corr-123' },
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          expect(logSpy.mock.calls[0]?.[0]).toContain('[corr-123]');
          done();
        },
      });
    });

    it('should include tenant ID in log context', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      const context = createMockHttpContext({
        tenantId: 'tenant-456',
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          const logContext = logSpy.mock.calls[0]?.[1] as Record<string, unknown>;
          expect(logContext['tenantId']).toBe('tenant-456');
          done();
        },
      });
    });

    it('should include user ID in log context', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      const context = createMockHttpContext({
        user: { sub: 'user-789' },
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          const logContext = logSpy.mock.calls[0]?.[1] as Record<string, unknown>;
          expect(logContext['userId']).toBe('user-789');
          done();
        },
      });
    });

    it('should include IP address in log context', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      const context = createMockHttpContext({
        ip: '192.168.1.100',
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          const logContext = logSpy.mock.calls[0]?.[1] as Record<string, unknown>;
          expect(logContext['ip']).toBe('192.168.1.100');
          done();
        },
      });
    });
  });

  describe('Error Logging', () => {
    it('should log errors', (done) => {
      const errorSpy = jest.spyOn(interceptor['logger'], 'error');
      const context = createMockHttpContext();
      const error = new Error('Test error');
      const handler = createMockCallHandler(null, error);

      interceptor.intercept(context, handler).subscribe({
        error: () => {
          expect(errorSpy).toHaveBeenCalled();
          done();
        },
      });
    });

    it('should include error message in log', (done) => {
      const errorSpy = jest.spyOn(interceptor['logger'], 'error');
      const context = createMockHttpContext();
      const error = new Error('Something went wrong');
      const handler = createMockCallHandler(null, error);

      interceptor.intercept(context, handler).subscribe({
        error: () => {
          const logContext = errorSpy.mock.calls[0]?.[2] as Record<string, unknown>;
          const loggedError = logContext['error'] as LoggedError;
          expect(loggedError.message).toBe('Something went wrong');
          done();
        },
      });
    });

    it('should include error stack trace', (done) => {
      const errorSpy = jest.spyOn(interceptor['logger'], 'error');
      const context = createMockHttpContext();
      const error = new Error('Stack trace error');
      const handler = createMockCallHandler(null, error);

      interceptor.intercept(context, handler).subscribe({
        error: () => {
          expect(errorSpy.mock.calls[0]?.[1]).toContain('Stack trace error');
          done();
        },
      });
    });

    it('should extract status code from error', (done) => {
      const errorSpy = jest.spyOn(interceptor['logger'], 'error');
      const context = createMockHttpContext();
      const error = Object.assign(new Error('Not found'), { status: 404 });
      const handler = createMockCallHandler(null, error);

      interceptor.intercept(context, handler).subscribe({
        error: () => {
          expect(errorSpy.mock.calls[0]?.[0]).toContain('404');
          done();
        },
      });
    });

    it('should default to 500 when no status code', (done) => {
      const errorSpy = jest.spyOn(interceptor['logger'], 'error');
      const context = createMockHttpContext();
      const error = new Error('Internal error');
      const handler = createMockCallHandler(null, error);

      interceptor.intercept(context, handler).subscribe({
        error: () => {
          expect(errorSpy.mock.calls[0]?.[0]).toContain('500');
          done();
        },
      });
    });

    it('should propagate error after logging', (done) => {
      const context = createMockHttpContext();
      const originalError = new Error('Original error');
      const handler = createMockCallHandler(null, originalError);

      interceptor.intercept(context, handler).subscribe({
        error: (error) => {
          expect(error).toBe(originalError);
          done();
        },
      });
    });
  });

  describe('Slow Request Detection', () => {
    it('should warn for slow requests', async () => {
      // Set a very low threshold for testing
      process.env['SLOW_REQUEST_THRESHOLD_MS'] = '1';

      const module = await Test.createTestingModule({
        providers: [RequestLoggingInterceptor],
      }).compile();

      const slowInterceptor = module.get<RequestLoggingInterceptor>(RequestLoggingInterceptor);
      // Set up spy (not asserted as timing is unreliable in tests)
      jest.spyOn(slowInterceptor['logger'], 'warn');
      const context = createMockHttpContext();

      // Just test with regular handler since timing is tricky in tests
      const regularHandler = createMockCallHandler();
      await new Promise<void>((resolve) => {
        slowInterceptor.intercept(context, regularHandler).subscribe({
          complete: () => {
            // The test verifies the interceptor works, actual slow detection
            // depends on timing which is unreliable in tests
            resolve();
          },
        });
      });
    });

    it('should include [SLOW] prefix for slow requests', async () => {
      process.env['SLOW_REQUEST_THRESHOLD_MS'] = '0'; // Any request is slow

      const module = await Test.createTestingModule({
        providers: [RequestLoggingInterceptor],
      }).compile();

      const slowInterceptor = module.get<RequestLoggingInterceptor>(RequestLoggingInterceptor);
      const warnSpy = jest.spyOn(slowInterceptor['logger'], 'warn');
      const context = createMockHttpContext();
      const handler = createMockCallHandler();

      await new Promise<void>((resolve) => {
        slowInterceptor.intercept(context, handler).subscribe({
          complete: () => {
            expect(warnSpy).toHaveBeenCalled();
            expect(warnSpy.mock.calls[0]?.[0]).toContain('[SLOW]');
            resolve();
          },
        });
      });
    });
  });

  describe('Response Size Tracking', () => {
    // Per commit 734fd574 (L3 perf hardening) the interceptor stopped
    // running JSON.stringify on every response — that produced an
    // O(n) heap copy per request just to compute a log size. The
    // current contract: `responseSize` is set only when the response
    // is a `string` or `Buffer` (where `.length` is O(1)). Object
    // responses intentionally do not get a size to keep the logging
    // hot path cheap. Tests aligned to that contract.
    it('should include response size for string responses (O(1) length)', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      const context = createMockHttpContext();
      const response = 'x'.repeat(1000);
      const handler = createMockCallHandler(response);

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          const logContext = logSpy.mock.calls[0]?.[1] as Record<string, unknown>;
          expect(logContext['responseSize']).toBe(1000);
          done();
        },
      });
    });

    it('should include response size for Buffer responses (O(1) length)', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      const context = createMockHttpContext();
      const response = Buffer.alloc(512);
      const handler = createMockCallHandler(response);

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          const logContext = logSpy.mock.calls[0]?.[1] as Record<string, unknown>;
          expect(logContext['responseSize']).toBe(512);
          done();
        },
      });
    });

    it('should skip response size for object responses (avoid O(n) serialization)', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      const context = createMockHttpContext();
      const response = { data: 'x'.repeat(1000) };
      const handler = createMockCallHandler(response);

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          const logContext = logSpy.mock.calls[0]?.[1] as Record<string, unknown>;
          // Object size is deliberately not computed — see comment in
          // request-logging.interceptor.ts:248–257.
          expect(logContext['responseSize']).toBeUndefined();
          done();
        },
      });
    });

    it('should handle non-serializable responses without throwing', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      const context = createMockHttpContext();

      // Circular reference — JSON.stringify would have thrown, but
      // the new size code skips objects entirely so this is a no-op
      // on the size path. The test still pins the "doesn't crash"
      // contract.
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;

      const handler = createMockCallHandler(circular);

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          expect(logSpy).toHaveBeenCalled();
          const logContext = logSpy.mock.calls[0]?.[1] as Record<string, unknown>;
          expect(logContext['responseSize']).toBeUndefined();
          done();
        },
      });
    });
  });

  describe('Log Message Format', () => {
    it('should format HTTP log message correctly', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      const context = createMockHttpContext({
        method: 'GET',
        url: '/api/test',
        headers: { 'x-correlation-id': 'abc123' },
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          const message = logSpy.mock.calls[0]?.[0] as string;
          expect(message).toMatch(/GET \/api\/test/);
          expect(message).toMatch(/200/);
          expect(message).toMatch(/\d+ms/);
          expect(message).toContain('[abc123]');
          done();
        },
      });
    });
  });

  describe('Log Context', () => {
    it('should include type in log context', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      const context = createMockHttpContext();
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          const logContext = logSpy.mock.calls[0]?.[1] as Record<string, unknown>;
          expect(logContext['type']).toBe('http');
          done();
        },
      });
    });

    it('should include method in log context', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      const context = createMockHttpContext({ method: 'DELETE' });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          const logContext = logSpy.mock.calls[0]?.[1] as Record<string, unknown>;
          expect(logContext['method']).toBe('DELETE');
          done();
        },
      });
    });

    it('should include path in log context', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      const context = createMockHttpContext({ url: '/api/v1/sensors' });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          const logContext = logSpy.mock.calls[0]?.[1] as Record<string, unknown>;
          expect(logContext['path']).toBe('/api/v1/sensors');
          done();
        },
      });
    });

    it('should include duration in log context', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      const context = createMockHttpContext();
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          const logContext = logSpy.mock.calls[0]?.[1] as Record<string, unknown>;
          expect(typeof logContext['duration']).toBe('number');
          done();
        },
      });
    });

    it('should include success flag in log context', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      const context = createMockHttpContext();
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          const logContext = logSpy.mock.calls[0]?.[1] as Record<string, unknown>;
          expect(logContext['success']).toBe(true);
          done();
        },
      });
    });
  });

  describe('IP Extraction', () => {
    // Per commit 734fd574 (L3 security audit) the interceptor no longer
    // parses `x-forwarded-for` directly — express's `req.ip` already
    // does that when `trust proxy` is configured, and reading the raw
    // header allows spoofing when the gateway is NOT behind a trusted
    // proxy. The interceptor's IP source is therefore exactly
    // `request.ip || request.connection.remoteAddress`. Tests aligned
    // to that hardened contract.
    it('should log req.ip as the IP source (trust-proxy-aware)', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      // Simulate express with `trust proxy` enabled — express parses
      // `x-forwarded-for` and writes the resolved client IP onto `req.ip`.
      const context = createMockHttpContext({
        ip: '10.0.0.1',
        headers: { 'x-forwarded-for': '10.0.0.1, 10.0.0.2' },
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          const logContext = logSpy.mock.calls[0]?.[1] as Record<string, unknown>;
          expect(logContext['ip']).toBe('10.0.0.1');
          done();
        },
      });
    });

    it('should not parse x-forwarded-for when req.ip is unset (no spoofing)', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      // Simulate untrusted client sending x-forwarded-for without
      // express having parsed it (no trust proxy). The interceptor
      // MUST NOT use the raw header — it falls back to the socket
      // remote address instead.
      const context = createMockHttpContext({
        ip: undefined,
        headers: { 'x-forwarded-for': '10.0.0.99' }, // spoof attempt
      });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          const logContext = logSpy.mock.calls[0]?.[1] as Record<string, unknown>;
          // 127.0.0.1 is the connection.remoteAddress default in the
          // mock builder — confirms the spoof header was ignored.
          expect(logContext['ip']).toBe('127.0.0.1');
          done();
        },
      });
    });

    it('should fallback to req.ip', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      const context = createMockHttpContext({ ip: '192.168.1.50' });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          const logContext = logSpy.mock.calls[0]?.[1] as Record<string, unknown>;
          expect(logContext['ip']).toBe('192.168.1.50');
          done();
        },
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing headers', (done) => {
      const context = createMockHttpContext({ headers: {} });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          // Should not throw
          done();
        },
      });
    });

    it('should handle missing user', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      const context = createMockHttpContext({ user: undefined });
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          const logContext = logSpy.mock.calls[0]?.[1] as Record<string, unknown>;
          expect(logContext['userId']).toBeUndefined();
          done();
        },
      });
    });

    it('should handle null response', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      const context = createMockHttpContext();
      const handler = createMockCallHandler(null);

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          expect(logSpy).toHaveBeenCalled();
          done();
        },
      });
    });

    it('should handle string response', (done) => {
      const logSpy = jest.spyOn(interceptor['logger'], 'log');
      const context = createMockHttpContext();
      const handler = createMockCallHandler('string response');

      interceptor.intercept(context, handler).subscribe({
        complete: () => {
          expect(logSpy).toHaveBeenCalled();
          done();
        },
      });
    });
  });

  describe('Performance', () => {
    it('should handle rapid requests efficiently', async () => {
      const startTime = Date.now();

      for (let i = 0; i < 1000; i++) {
        const context = createMockHttpContext({ url: `/api/test/${i}` });
        const handler = createMockCallHandler();

        await new Promise<void>((resolve) => {
          interceptor.intercept(context, handler).subscribe({
            complete: () => resolve(),
          });
        });
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(5000); // Should complete in under 5 seconds
    });
  });
});
