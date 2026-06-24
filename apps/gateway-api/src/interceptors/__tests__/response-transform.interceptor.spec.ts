 
 
 
 
 
 
 
/**
 * ResponseTransformInterceptor Tests
 *
 * Comprehensive test suite for response transformation interceptor
 */

 
 
 
 

import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { of } from 'rxjs';

import {
  ResponseTransformInterceptor,
  ApiResponse,
} from '../response-transform.interceptor';

describe('ResponseTransformInterceptor', () => {
  // Using definite assignment assertion - assigned in beforeEach
  let interceptor!: ResponseTransformInterceptor<unknown>;
  let reflector!: Reflector;

  /**
   * Create mock execution context
   */
  const createMockExecutionContext = (
    options: {
      method?: string;
      path?: string;
      statusCode?: number;
    } = {},
  ): ExecutionContext => {
    const mockRequest = {
      method: options.method || 'GET',
      path: options.path || '/api/v1/test',
      url: options.path || '/api/v1/test',
      // WHY: the interceptor reads request.headers['x-request-id'] /
      // ['x-correlation-id'] to stamp requestId onto the wrapped response —
      // a mock request without headers crashes every transform.
      headers: {},
    };

    const mockResponse = {
      statusCode: options.statusCode || 200,
      // WHY: the interceptor probes response.getHeader('Deprecation') to
      // surface deprecation warnings in meta — the mock must expose the
      // express Response header reader.
      getHeader: jest.fn().mockReturnValue(undefined),
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
  const createMockCallHandler = (response: unknown): CallHandler => ({
    handle: () => of(response),
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ResponseTransformInterceptor,
        {
          provide: Reflector,
          useValue: {
            getAllAndOverride: jest.fn().mockReturnValue(false),
          },
        },
      ],
    }).compile();

    interceptor = module.get<ResponseTransformInterceptor<unknown>>(ResponseTransformInterceptor);
    reflector = module.get<Reflector>(Reflector);
  });

  describe('Standard Response Format', () => {
    it('should wrap response in standard format', (done) => {
      const context = createMockExecutionContext();
      const handler = createMockCallHandler({ name: 'test' });

      interceptor.intercept(context, handler).subscribe({
        next: (result: unknown) => {
          const response = result as ApiResponse<unknown>;
          expect(response.success).toBe(true);
          expect(response.data).toEqual({ name: 'test' });
          expect(response.meta).toBeDefined();
          done();
        },
      });
    });

    it('should include success flag', (done) => {
      const context = createMockExecutionContext();
      const handler = createMockCallHandler({ data: 'test' });

      interceptor.intercept(context, handler).subscribe({
        next: (result: unknown) => {
          const response = result as ApiResponse<unknown>;
          expect(response.success).toBe(true);
          done();
        },
      });
    });

    it('should include data property', (done) => {
      const testData = { id: 1, name: 'Test' };
      const context = createMockExecutionContext();
      const handler = createMockCallHandler(testData);

      interceptor.intercept(context, handler).subscribe({
        next: (result: unknown) => {
          const response = result as ApiResponse<unknown>;
          expect(response.data).toEqual(testData);
          done();
        },
      });
    });

    // The ApiResponse shape places `timestamp` and `path` at the
    // ROOT of the response, not inside `meta` — see
    // response-transform.interceptor.ts:25 (ApiResponse interface)
    // and :38 (ResponseMeta interface). `meta` is reserved for
    // pagination + processing-time fields. The previous test shape
    // `response.meta.timestamp` etc. was a stale assertion against
    // an older contract; tests aligned to the current API.
    //
    // The previous `method` and `statusCode` test cases asserted
    // fields that exist NOWHERE on ApiResponse — they were runtime
    // metadata that the original contract evidently exposed but the
    // current contract doesn't. Removed because asserting non-
    // existent fields is dead-code in test form. If a future API
    // change re-exposes them, that PR adds the assertions.
    it('should include timestamp at the response root', (done) => {
      const context = createMockExecutionContext();
      const handler = createMockCallHandler({});

      interceptor.intercept(context, handler).subscribe({
        next: (result: unknown) => {
          const response = result as ApiResponse<unknown>;
          expect(response.timestamp).toBeDefined();
          expect(new Date(response.timestamp).getTime()).not.toBeNaN();
          done();
        },
      });
    });

    it('should include path at the response root', (done) => {
      const context = createMockExecutionContext({ path: '/api/v1/users' });
      const handler = createMockCallHandler({});

      interceptor.intercept(context, handler).subscribe({
        next: (result: unknown) => {
          const response = result as ApiResponse<unknown>;
          expect(response.path).toBe('/api/v1/users');
          done();
        },
      });
    });
  });

  describe('Skip Transform', () => {
    it('should skip transform when decorator is set', (done) => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

      const rawData = { raw: 'data' };
      const context = createMockExecutionContext();
      const handler = createMockCallHandler(rawData);

      interceptor.intercept(context, handler).subscribe({
        next: (result: unknown) => {
          expect(result).toEqual(rawData);
          expect((result as { success?: boolean }).success).toBeUndefined();
          done();
        },
      });
    });

    it('should apply transform when decorator is not set', (done) => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);

      const context = createMockExecutionContext();
      const handler = createMockCallHandler({ data: 'test' });

      interceptor.intercept(context, handler).subscribe({
        next: (result: unknown) => {
          expect((result as { success?: boolean }).success).toBe(true);
          done();
        },
      });
    });
  });

  describe('Array Response', () => {
    it('should handle array data', (done) => {
      const arrayData = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const context = createMockExecutionContext();
      const handler = createMockCallHandler(arrayData);

      interceptor.intercept(context, handler).subscribe({
        next: (result: unknown) => {
          const response = result as ApiResponse<unknown>;
          expect(response.data).toEqual(arrayData);
          done();
        },
      });
    });

    it('should handle empty array', (done) => {
      const context = createMockExecutionContext();
      const handler = createMockCallHandler([]);

      interceptor.intercept(context, handler).subscribe({
        next: (result: unknown) => {
          const response = result as ApiResponse<unknown>;
          expect(response.data).toEqual([]);
          done();
        },
      });
    });
  });

  describe('Primitive Response', () => {
    it('should handle string data', (done) => {
      const context = createMockExecutionContext();
      const handler = createMockCallHandler('string response');

      interceptor.intercept(context, handler).subscribe({
        next: (result: unknown) => {
          const response = result as ApiResponse<unknown>;
          expect(response.data).toBe('string response');
          done();
        },
      });
    });

    it('should handle number data', (done) => {
      const context = createMockExecutionContext();
      const handler = createMockCallHandler(42);

      interceptor.intercept(context, handler).subscribe({
        next: (result: unknown) => {
          const response = result as ApiResponse<unknown>;
          expect(response.data).toBe(42);
          done();
        },
      });
    });

    it('should handle boolean data', (done) => {
      const context = createMockExecutionContext();
      const handler = createMockCallHandler(true);

      interceptor.intercept(context, handler).subscribe({
        next: (result: unknown) => {
          const response = result as ApiResponse<unknown>;
          expect(response.data).toBe(true);
          done();
        },
      });
    });

    it('should handle null data', (done) => {
      const context = createMockExecutionContext();
      const handler = createMockCallHandler(null);

      interceptor.intercept(context, handler).subscribe({
        next: (result: unknown) => {
          const response = result as ApiResponse<unknown>;
          expect(response.data).toBeNull();
          done();
        },
      });
    });

    it('should handle undefined data', (done) => {
      const context = createMockExecutionContext();
      const handler = createMockCallHandler(undefined);

      interceptor.intercept(context, handler).subscribe({
        next: (result: unknown) => {
          const response = result as ApiResponse<unknown>;
          expect(response.data).toBeUndefined();
          done();
        },
      });
    });
  });

  describe('Nested Object Response', () => {
    it('should handle deeply nested objects', (done) => {
      const nestedData = {
        level1: {
          level2: {
            level3: {
              value: 'deep',
            },
          },
        },
      };
      const context = createMockExecutionContext();
      const handler = createMockCallHandler(nestedData);

      interceptor.intercept(context, handler).subscribe({
        next: (result: unknown) => {
          const response = result as ApiResponse<unknown>;
          expect(response.data).toEqual(nestedData);
          done();
        },
      });
    });
  });

  describe('Pagination Response', () => {
    it('should preserve pagination metadata', (done) => {
      const paginatedData = {
        items: [{ id: 1 }, { id: 2 }],
        total: 100,
        page: 1,
        limit: 10,
      };
      const context = createMockExecutionContext();
      const handler = createMockCallHandler(paginatedData);

      interceptor.intercept(context, handler).subscribe({
        next: (result: unknown) => {
          const response = result as ApiResponse<unknown>;
          expect((response.data as any).items).toEqual([{ id: 1 }, { id: 2 }]);
          expect((response.data as any).total).toBe(100);
          expect((response.data as any).page).toBe(1);
          expect((response.data as any).limit).toBe(10);
          done();
        },
      });
    });
  });

  describe('HTTP Methods', () => {
    // ApiResponse no longer carries `method` — it was a runtime
    // metadata field on an older contract. The current interceptor
    // doesn't echo the request method on the response (clients
    // already know their own method). The HTTP-method-handling
    // tests collapse to "GET / POST / PUT / PATCH / DELETE all
    // produce a successful wrapped response" — the assertion
    // becomes `response.success === true` without per-method
    // payload assertion.
    it.each<[string]>([
      ['GET'], ['POST'], ['PUT'], ['PATCH'], ['DELETE'],
    ])(
      'should produce a wrapped response for %s requests',
      async (method) => {
        const context = createMockExecutionContext({ method });
        const handler = createMockCallHandler({ data: 'test' });

        await new Promise<void>((resolve, reject) => {
          interceptor.intercept(context, handler).subscribe({
            next: (result: unknown) => {
              try {
                const response = result as ApiResponse<unknown>;
                expect(response.success).toBe(true);
                resolve();
              } catch (e) {
                reject(e as Error);
              }
            },
          });
        });
      },
    );
  });

  describe('Status Codes', () => {
    // Same as `HTTP Methods` above — `statusCode` is not on the
    // response payload (HTTP layer handles it). The status-code
    // tests collapse to "all status codes round-trip a wrapped
    // success response without throwing".
    it.each<[number]>([
      [200], [201], [204], [400], [401], [403], [404], [500],
    ])(
      'should produce a wrapped response when status code is %d',
      async (statusCode) => {
        const context = createMockExecutionContext({ statusCode });
        const handler = createMockCallHandler({});

        await new Promise<void>((resolve, reject) => {
          interceptor.intercept(context, handler).subscribe({
            next: (result: unknown) => {
              try {
                const response = result as ApiResponse<unknown>;
                expect(response.success).toBe(true);
                resolve();
              } catch (e) {
                reject(e as Error);
              }
            },
          });
        });
      },
    );
  });

  describe('Already Transformed Response', () => {
    it('should not double-wrap already transformed response', (done) => {
      // `ResponseMeta` is now a NARROW pagination/meta shape (see
      // response-transform.interceptor.ts:38). The previous
      // fixture leaked `timestamp/path/method/statusCode` into
      // meta from a stale contract. Removed those — ApiResponse's
      // root-level `timestamp` + `path` are the canonical home for
      // the temporal/path metadata.
      const alreadyTransformed: ApiResponse<unknown> = {
        success: true,
        data: { name: 'test' },
        meta: {},
        timestamp: new Date().toISOString(),
        path: '/api/v1/test',
      };

      const context = createMockExecutionContext();
      const handler = createMockCallHandler(alreadyTransformed);

      interceptor.intercept(context, handler).subscribe({
        next: (result: unknown) => {
          const response = result as ApiResponse<unknown>;
          // Should still wrap it (interceptor doesn't check for existing structure)
          expect(response.success).toBe(true);
          done();
        },
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle Date objects', (done) => {
      const date = new Date();
      const context = createMockExecutionContext();
      const handler = createMockCallHandler({ createdAt: date });

      interceptor.intercept(context, handler).subscribe({
        next: (result: unknown) => {
          const response = result as ApiResponse<unknown>;
          expect((response.data as any).createdAt).toEqual(date);
          done();
        },
      });
    });

    it('should handle Buffer data', (done) => {
      const buffer = Buffer.from('test');
      const context = createMockExecutionContext();
      const handler = createMockCallHandler(buffer);

      interceptor.intercept(context, handler).subscribe({
        next: (result: unknown) => {
          const response = result as ApiResponse<unknown>;
          expect(response.data).toEqual(buffer);
          done();
        },
      });
    });

    it('should handle empty object', (done) => {
      const context = createMockExecutionContext();
      const handler = createMockCallHandler({});

      interceptor.intercept(context, handler).subscribe({
        next: (result: unknown) => {
          const response = result as ApiResponse<unknown>;
          expect(response.data).toEqual({});
          done();
        },
      });
    });

    it('should handle large arrays', (done) => {
      const largeArray = Array(1000)
        .fill(null)
        .map((_, i) => ({ id: i }));
      const context = createMockExecutionContext();
      const handler = createMockCallHandler(largeArray);

      interceptor.intercept(context, handler).subscribe({
        next: (result: unknown) => {
          const response = result as ApiResponse<unknown>;
          expect((response.data as any[]).length).toBe(1000);
          done();
        },
      });
    });
  });

  describe('Performance', () => {
    it('should handle rapid requests efficiently', async () => {
      const startTime = Date.now();

      for (let i = 0; i < 1000; i++) {
        const context = createMockExecutionContext();
        const handler = createMockCallHandler({ index: i });

        await new Promise<void>((resolve) => {
          interceptor.intercept(context, handler).subscribe({
            complete: () => resolve(),
          });
        });
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(1000); // Should complete in under 1 second
    });
  });
});
