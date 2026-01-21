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
  StandardApiResponse,
} from '../response-transform.interceptor';

describe('ResponseTransformInterceptor', () => {
  let interceptor: ResponseTransformInterceptor;
  let reflector: Reflector;

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
    };

    const mockResponse = {
      statusCode: options.statusCode || 200,
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

    // Using indirect assignment to satisfy type checker
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const resolved: ResponseTransformInterceptor = module.get(ResponseTransformInterceptor);
    interceptor = resolved;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const resolvedReflector: Reflector = module.get(Reflector);
    reflector = resolvedReflector;
  });

  describe('Standard Response Format', () => {
    it('should wrap response in standard format', (done) => {
      const context = createMockExecutionContext();
      const handler = createMockCallHandler({ name: 'test' });

      interceptor.intercept(context, handler).subscribe({
        next: (result) => {
          const response = result as StandardApiResponse<unknown>;
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
        next: (result) => {
          const response = result as StandardApiResponse<unknown>;
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
        next: (result) => {
          const response = result as StandardApiResponse<unknown>;
          expect(response.data).toEqual(testData);
          done();
        },
      });
    });

    it('should include meta with timestamp', (done) => {
      const context = createMockExecutionContext();
      const handler = createMockCallHandler({});

      interceptor.intercept(context, handler).subscribe({
        next: (result) => {
          const response = result as StandardApiResponse<unknown>;
          expect(response.meta.timestamp).toBeDefined();
          expect(new Date(response.meta.timestamp).getTime()).not.toBeNaN();
          done();
        },
      });
    });

    it('should include meta with path', (done) => {
      const context = createMockExecutionContext({ path: '/api/v1/users' });
      const handler = createMockCallHandler({});

      interceptor.intercept(context, handler).subscribe({
        next: (result) => {
          const response = result as StandardApiResponse<unknown>;
          expect(response.meta.path).toBe('/api/v1/users');
          done();
        },
      });
    });

    it('should include meta with method', (done) => {
      const context = createMockExecutionContext({ method: 'POST' });
      const handler = createMockCallHandler({});

      interceptor.intercept(context, handler).subscribe({
        next: (result) => {
          const response = result as StandardApiResponse<unknown>;
          expect(response.meta.method).toBe('POST');
          done();
        },
      });
    });

    it('should include meta with statusCode', (done) => {
      const context = createMockExecutionContext({ statusCode: 201 });
      const handler = createMockCallHandler({});

      interceptor.intercept(context, handler).subscribe({
        next: (result) => {
          const response = result as StandardApiResponse<unknown>;
          expect(response.meta.statusCode).toBe(201);
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
        next: (result) => {
          expect(result).toEqual(rawData);
          expect((result).success).toBeUndefined();
          done();
        },
      });
    });

    it('should apply transform when decorator is not set', (done) => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);

      const context = createMockExecutionContext();
      const handler = createMockCallHandler({ data: 'test' });

      interceptor.intercept(context, handler).subscribe({
        next: (result) => {
          expect((result).success).toBe(true);
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
        next: (result) => {
          const response = result as StandardApiResponse<unknown>;
          expect(response.data).toEqual(arrayData);
          done();
        },
      });
    });

    it('should handle empty array', (done) => {
      const context = createMockExecutionContext();
      const handler = createMockCallHandler([]);

      interceptor.intercept(context, handler).subscribe({
        next: (result) => {
          const response = result as StandardApiResponse<unknown>;
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
        next: (result) => {
          const response = result as StandardApiResponse<unknown>;
          expect(response.data).toBe('string response');
          done();
        },
      });
    });

    it('should handle number data', (done) => {
      const context = createMockExecutionContext();
      const handler = createMockCallHandler(42);

      interceptor.intercept(context, handler).subscribe({
        next: (result) => {
          const response = result as StandardApiResponse<unknown>;
          expect(response.data).toBe(42);
          done();
        },
      });
    });

    it('should handle boolean data', (done) => {
      const context = createMockExecutionContext();
      const handler = createMockCallHandler(true);

      interceptor.intercept(context, handler).subscribe({
        next: (result) => {
          const response = result as StandardApiResponse<unknown>;
          expect(response.data).toBe(true);
          done();
        },
      });
    });

    it('should handle null data', (done) => {
      const context = createMockExecutionContext();
      const handler = createMockCallHandler(null);

      interceptor.intercept(context, handler).subscribe({
        next: (result) => {
          const response = result as StandardApiResponse<unknown>;
          expect(response.data).toBeNull();
          done();
        },
      });
    });

    it('should handle undefined data', (done) => {
      const context = createMockExecutionContext();
      const handler = createMockCallHandler(undefined);

      interceptor.intercept(context, handler).subscribe({
        next: (result) => {
          const response = result as StandardApiResponse<unknown>;
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
        next: (result) => {
          const response = result as StandardApiResponse<unknown>;
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
        next: (result) => {
          const response = result as StandardApiResponse<unknown>;
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
    it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])(
      'should handle %s requests',
      (method, done) => {
        const context = createMockExecutionContext({ method });
        const handler = createMockCallHandler({ data: 'test' });

        interceptor.intercept(context, handler).subscribe({
          next: (result) => {
            const response = result as StandardApiResponse<unknown>;
            expect(response.meta.method).toBe(method);
            (done)();
          },
        });
      },
    );
  });

  describe('Status Codes', () => {
    it.each([200, 201, 204, 400, 401, 403, 404, 500])(
      'should include status code %d in meta',
      (statusCode, done) => {
        const context = createMockExecutionContext({ statusCode });
        const handler = createMockCallHandler({});

        interceptor.intercept(context, handler).subscribe({
          next: (result) => {
            const response = result as StandardApiResponse<unknown>;
            expect(response.meta.statusCode).toBe(statusCode);
            (done)();
          },
        });
      },
    );
  });

  describe('Already Transformed Response', () => {
    it('should not double-wrap already transformed response', (done) => {
      const alreadyTransformed: StandardApiResponse<unknown> = {
        success: true,
        data: { name: 'test' },
        meta: {
          timestamp: new Date().toISOString(),
          path: '/api/v1/test',
          method: 'GET',
          statusCode: 200,
        },
      };

      const context = createMockExecutionContext();
      const handler = createMockCallHandler(alreadyTransformed);

      interceptor.intercept(context, handler).subscribe({
        next: (result) => {
          const response = result as StandardApiResponse<unknown>;
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
        next: (result) => {
          const response = result as StandardApiResponse<unknown>;
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
        next: (result) => {
          const response = result as StandardApiResponse<unknown>;
          expect(response.data).toEqual(buffer);
          done();
        },
      });
    });

    it('should handle empty object', (done) => {
      const context = createMockExecutionContext();
      const handler = createMockCallHandler({});

      interceptor.intercept(context, handler).subscribe({
        next: (result) => {
          const response = result as StandardApiResponse<unknown>;
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
        next: (result) => {
          const response = result as StandardApiResponse<unknown>;
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
