/**
 * CacheControlInterceptor Tests
 *
 * Comprehensive test suite for HTTP caching interceptor
 */

import { Test, TestingModule } from '@nestjs/testing';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import {
  CacheControlInterceptor,
  CachePolicy,
  CACHE_POLICY_KEY,
  buildCacheControlHeader,
} from '../cache-control.interceptor';

describe('CacheControlInterceptor', () => {
  let interceptor: CacheControlInterceptor;
  let reflector: Reflector;

  /**
   * Create mock execution context
   */
  const createMockExecutionContext = (
    options: {
      method?: string;
      path?: string;
      headers?: Record<string, string>;
    } = {},
  ): ExecutionContext => {
    const mockRequest = {
      method: options.method || 'GET',
      path: options.path || '/api/v1/test',
      headers: options.headers || {},
    };

    const headers: Record<string, string | string[]> = {};
    const mockResponse = {
      setHeader: jest.fn((name: string, value: string | string[]) => {
        headers[name] = value;
      }),
      getHeader: jest.fn((name: string) => headers[name]),
      _headers: headers,
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
   * Create mock call handler
   */
  const createMockCallHandler = (responseData: unknown = { data: 'test' }): CallHandler => ({
    handle: () => of(responseData),
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CacheControlInterceptor,
        {
          provide: Reflector,
          useValue: {
            getAllAndOverride: jest.fn().mockReturnValue(undefined),
          },
        },
      ],
    }).compile();

    interceptor = module.get<CacheControlInterceptor>(CacheControlInterceptor);
    reflector = module.get<Reflector>(Reflector);
  });

  describe('ETag Generation', () => {
    it('should generate ETag header', (done) => {
      const context = createMockExecutionContext();
      const response = context.switchToHttp().getResponse() as any;
      const handler = createMockCallHandler({ data: 'test content' });

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          expect(response.setHeader).toHaveBeenCalledWith('ETag', expect.stringMatching(/^"[a-f0-9]{32}"$/));
          done();
        },
      });
    });

    it('should generate consistent ETag for same content', (done) => {
      const content = { data: 'consistent content' };
      const context1 = createMockExecutionContext();
      const context2 = createMockExecutionContext();
      const response1 = context1.switchToHttp().getResponse() as any;
      const response2 = context2.switchToHttp().getResponse() as any;

      interceptor.intercept(context1, createMockCallHandler(content)).subscribe({
        next: () => {
          const etag1 = response1.setHeader.mock.calls.find((c: string[]) => c[0] === 'ETag')?.[1];

          interceptor.intercept(context2, createMockCallHandler(content)).subscribe({
            next: () => {
              const etag2 = response2.setHeader.mock.calls.find((c: string[]) => c[0] === 'ETag')?.[1];
              expect(etag1).toBe(etag2);
              done();
            },
          });
        },
      });
    });

    it('should generate different ETags for different content', (done) => {
      const context1 = createMockExecutionContext();
      const context2 = createMockExecutionContext();
      const response1 = context1.switchToHttp().getResponse() as any;
      const response2 = context2.switchToHttp().getResponse() as any;

      interceptor.intercept(context1, createMockCallHandler({ data: 'content1' })).subscribe({
        next: () => {
          const etag1 = response1.setHeader.mock.calls.find((c: string[]) => c[0] === 'ETag')?.[1];

          interceptor.intercept(context2, createMockCallHandler({ data: 'content2' })).subscribe({
            next: () => {
              const etag2 = response2.setHeader.mock.calls.find((c: string[]) => c[0] === 'ETag')?.[1];
              expect(etag1).not.toBe(etag2);
              done();
            },
          });
        },
      });
    });

    it('should not generate ETag when noStore is true', (done) => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ noStore: true });

      const context = createMockExecutionContext();
      const response = context.switchToHttp().getResponse() as any;
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          expect(response.setHeader).not.toHaveBeenCalledWith('ETag', expect.anything());
          done();
        },
      });
    });
  });

  describe('Last-Modified Header', () => {
    it('should set Last-Modified when response has updatedAt', (done) => {
      const updatedAt = new Date('2024-01-01T12:00:00Z');
      const context = createMockExecutionContext();
      const response = context.switchToHttp().getResponse() as any;
      const handler = createMockCallHandler({ data: 'test', updatedAt });

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          expect(response.setHeader).toHaveBeenCalledWith(
            'Last-Modified',
            updatedAt.toUTCString(),
          );
          done();
        },
      });
    });

    it('should not set Last-Modified when response lacks updatedAt', (done) => {
      const context = createMockExecutionContext();
      const response = context.switchToHttp().getResponse() as any;
      const handler = createMockCallHandler({ data: 'test' });

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          expect(response.setHeader).not.toHaveBeenCalledWith(
            'Last-Modified',
            expect.anything(),
          );
          done();
        },
      });
    });
  });

  describe('Cache-Control Header', () => {
    describe('Public Cache', () => {
      it('should set public directive', (done) => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ public: true, maxAge: 3600 });

        const context = createMockExecutionContext();
        const response = context.switchToHttp().getResponse() as any;
        const handler = createMockCallHandler();

        interceptor.intercept(context, handler).subscribe({
          next: () => {
            expect(response.setHeader).toHaveBeenCalledWith(
              'Cache-Control',
              expect.stringContaining('public'),
            );
            done();
          },
        });
      });
    });

    describe('Private Cache', () => {
      it('should set private directive', (done) => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ private: true, maxAge: 300 });

        const context = createMockExecutionContext();
        const response = context.switchToHttp().getResponse() as any;
        const handler = createMockCallHandler();

        interceptor.intercept(context, handler).subscribe({
          next: () => {
            expect(response.setHeader).toHaveBeenCalledWith(
              'Cache-Control',
              expect.stringContaining('private'),
            );
            done();
          },
        });
      });
    });

    describe('No-Cache', () => {
      it('should set no-cache directive', (done) => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ noCache: true });

        const context = createMockExecutionContext();
        const response = context.switchToHttp().getResponse() as any;
        const handler = createMockCallHandler();

        interceptor.intercept(context, handler).subscribe({
          next: () => {
            expect(response.setHeader).toHaveBeenCalledWith(
              'Cache-Control',
              expect.stringContaining('no-cache'),
            );
            done();
          },
        });
      });

      it('should set Pragma header for HTTP/1.0 compatibility', (done) => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ noCache: true });

        const context = createMockExecutionContext();
        const response = context.switchToHttp().getResponse() as any;
        const handler = createMockCallHandler();

        interceptor.intercept(context, handler).subscribe({
          next: () => {
            expect(response.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache');
            done();
          },
        });
      });
    });

    describe('No-Store', () => {
      it('should set no-store directive', (done) => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ noStore: true });

        const context = createMockExecutionContext();
        const response = context.switchToHttp().getResponse() as any;
        const handler = createMockCallHandler();

        interceptor.intercept(context, handler).subscribe({
          next: () => {
            expect(response.setHeader).toHaveBeenCalledWith(
              'Cache-Control',
              expect.stringContaining('no-store'),
            );
            done();
          },
        });
      });
    });

    describe('Max-Age', () => {
      it('should set max-age directive', (done) => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ maxAge: 3600 });

        const context = createMockExecutionContext();
        const response = context.switchToHttp().getResponse() as any;
        const handler = createMockCallHandler();

        interceptor.intercept(context, handler).subscribe({
          next: () => {
            expect(response.setHeader).toHaveBeenCalledWith(
              'Cache-Control',
              expect.stringContaining('max-age=3600'),
            );
            done();
          },
        });
      });

      it('should set Expires header when max-age > 0', (done) => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ maxAge: 3600 });

        const context = createMockExecutionContext();
        const response = context.switchToHttp().getResponse() as any;
        const handler = createMockCallHandler();

        interceptor.intercept(context, handler).subscribe({
          next: () => {
            expect(response.setHeader).toHaveBeenCalledWith(
              'Expires',
              expect.any(String),
            );
            done();
          },
        });
      });
    });

    describe('s-maxage', () => {
      it('should set s-maxage directive for shared caches', (done) => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ sMaxAge: 7200 });

        const context = createMockExecutionContext();
        const response = context.switchToHttp().getResponse() as any;
        const handler = createMockCallHandler();

        interceptor.intercept(context, handler).subscribe({
          next: () => {
            expect(response.setHeader).toHaveBeenCalledWith(
              'Cache-Control',
              expect.stringContaining('s-maxage=7200'),
            );
            done();
          },
        });
      });
    });

    describe('Must-Revalidate', () => {
      it('should set must-revalidate directive', (done) => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ mustRevalidate: true });

        const context = createMockExecutionContext();
        const response = context.switchToHttp().getResponse() as any;
        const handler = createMockCallHandler();

        interceptor.intercept(context, handler).subscribe({
          next: () => {
            expect(response.setHeader).toHaveBeenCalledWith(
              'Cache-Control',
              expect.stringContaining('must-revalidate'),
            );
            done();
          },
        });
      });
    });

    describe('Immutable', () => {
      it('should set immutable directive', (done) => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ immutable: true, maxAge: 86400 });

        const context = createMockExecutionContext();
        const response = context.switchToHttp().getResponse() as any;
        const handler = createMockCallHandler();

        interceptor.intercept(context, handler).subscribe({
          next: () => {
            expect(response.setHeader).toHaveBeenCalledWith(
              'Cache-Control',
              expect.stringContaining('immutable'),
            );
            done();
          },
        });
      });
    });

    describe('Stale-While-Revalidate', () => {
      it('should set stale-while-revalidate directive', (done) => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ staleWhileRevalidate: 60 });

        const context = createMockExecutionContext();
        const response = context.switchToHttp().getResponse() as any;
        const handler = createMockCallHandler();

        interceptor.intercept(context, handler).subscribe({
          next: () => {
            expect(response.setHeader).toHaveBeenCalledWith(
              'Cache-Control',
              expect.stringContaining('stale-while-revalidate=60'),
            );
            done();
          },
        });
      });
    });

    describe('Stale-If-Error', () => {
      it('should set stale-if-error directive', (done) => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue({ staleIfError: 300 });

        const context = createMockExecutionContext();
        const response = context.switchToHttp().getResponse() as any;
        const handler = createMockCallHandler();

        interceptor.intercept(context, handler).subscribe({
          next: () => {
            expect(response.setHeader).toHaveBeenCalledWith(
              'Cache-Control',
              expect.stringContaining('stale-if-error=300'),
            );
            done();
          },
        });
      });
    });
  });

  describe('Vary Header', () => {
    it('should set default Vary headers', (done) => {
      const context = createMockExecutionContext();
      const response = context.switchToHttp().getResponse() as any;
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          expect(response.setHeader).toHaveBeenCalledWith(
            'Vary',
            expect.stringContaining('Accept'),
          );
          done();
        },
      });
    });

    it('should set custom Vary headers from policy', (done) => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue({
        varyHeaders: ['Authorization', 'X-Custom-Header'],
      });

      const context = createMockExecutionContext();
      const response = context.switchToHttp().getResponse() as any;
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          expect(response.setHeader).toHaveBeenCalledWith(
            'Vary',
            expect.stringContaining('Authorization'),
          );
          done();
        },
      });
    });
  });

  describe('Default Policies', () => {
    it('should apply health endpoint policy', (done) => {
      const context = createMockExecutionContext({ path: '/health' });
      const response = context.switchToHttp().getResponse() as any;
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          expect(response.setHeader).toHaveBeenCalledWith(
            'Cache-Control',
            expect.stringContaining('public'),
          );
          done();
        },
      });
    });

    it('should apply static assets policy', (done) => {
      const context = createMockExecutionContext({ path: '/api/v1/static/logo.png' });
      const response = context.switchToHttp().getResponse() as any;
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          expect(response.setHeader).toHaveBeenCalledWith(
            'Cache-Control',
            expect.stringContaining('immutable'),
          );
          done();
        },
      });
    });

    it('should apply no-store for GraphQL path', (done) => {
      const context = createMockExecutionContext({ path: '/graphql' });
      const response = context.switchToHttp().getResponse() as any;
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          expect(response.setHeader).toHaveBeenCalledWith(
            'Cache-Control',
            expect.stringContaining('no-store'),
          );
          done();
        },
      });
    });

    it('should apply no-store for non-GET requests', (done) => {
      const context = createMockExecutionContext({ method: 'POST' });
      const response = context.switchToHttp().getResponse() as any;
      const handler = createMockCallHandler();

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          expect(response.setHeader).toHaveBeenCalledWith(
            'Cache-Control',
            expect.stringContaining('no-store'),
          );
          done();
        },
      });
    });
  });

  describe('Static Methods', () => {
    describe('compareETags', () => {
      it('should return true for matching ETags', () => {
        expect(CacheControlInterceptor.compareETags('"abc123"', '"abc123"')).toBe(true);
      });

      it('should return false for non-matching ETags', () => {
        expect(CacheControlInterceptor.compareETags('"abc123"', '"xyz789"')).toBe(false);
      });

      it('should handle weak ETags', () => {
        expect(CacheControlInterceptor.compareETags('W/"abc123"', '"abc123"')).toBe(true);
      });
    });

    describe('shouldCache', () => {
      it('should return true for GET 200', () => {
        expect(CacheControlInterceptor.shouldCache(200, 'GET')).toBe(true);
      });

      it('should return true for GET 304', () => {
        expect(CacheControlInterceptor.shouldCache(304, 'GET')).toBe(false);
      });

      it('should return true for HEAD 200', () => {
        expect(CacheControlInterceptor.shouldCache(200, 'HEAD')).toBe(true);
      });

      it('should return false for POST', () => {
        expect(CacheControlInterceptor.shouldCache(200, 'POST')).toBe(false);
      });

      it('should return false for PUT', () => {
        expect(CacheControlInterceptor.shouldCache(200, 'PUT')).toBe(false);
      });

      it('should return false for DELETE', () => {
        expect(CacheControlInterceptor.shouldCache(200, 'DELETE')).toBe(false);
      });

      it('should return true for cacheable error status', () => {
        expect(CacheControlInterceptor.shouldCache(404, 'GET')).toBe(true);
      });
    });
  });

  describe('Helper Functions', () => {
    describe('buildCacheControlHeader', () => {
      it('should build public cache header', () => {
        const header = buildCacheControlHeader({ public: true, maxAge: 3600 });
        expect(header).toContain('public');
        expect(header).toContain('max-age=3600');
      });

      it('should build private cache header', () => {
        const header = buildCacheControlHeader({ private: true, maxAge: 300 });
        expect(header).toContain('private');
        expect(header).toContain('max-age=300');
      });

      it('should build no-cache header', () => {
        const header = buildCacheControlHeader({ noCache: true, noStore: true });
        expect(header).toContain('no-cache');
        expect(header).toContain('no-store');
      });

      it('should build immutable header', () => {
        const header = buildCacheControlHeader({ public: true, maxAge: 86400, immutable: true });
        expect(header).toContain('immutable');
      });

      it('should build header with s-maxage', () => {
        const header = buildCacheControlHeader({ sMaxAge: 7200 });
        expect(header).toContain('s-maxage=7200');
      });

      it('should build header with must-revalidate', () => {
        const header = buildCacheControlHeader({ mustRevalidate: true });
        expect(header).toContain('must-revalidate');
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle null response data', (done) => {
      const context = createMockExecutionContext();
      const handler = createMockCallHandler(null);

      interceptor.intercept(context, handler).subscribe({
        next: (result) => {
          expect(result).toBeNull();
          done();
        },
      });
    });

    it('should handle string response data', (done) => {
      const context = createMockExecutionContext();
      const response = context.switchToHttp().getResponse() as any;
      const handler = createMockCallHandler('string response');

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          expect(response.setHeader).toHaveBeenCalledWith('ETag', expect.any(String));
          done();
        },
      });
    });

    it('should handle array response data', (done) => {
      const context = createMockExecutionContext();
      const response = context.switchToHttp().getResponse() as any;
      const handler = createMockCallHandler([1, 2, 3]);

      interceptor.intercept(context, handler).subscribe({
        next: () => {
          expect(response.setHeader).toHaveBeenCalledWith('ETag', expect.any(String));
          done();
        },
      });
    });
  });
});
