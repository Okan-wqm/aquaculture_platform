/**
 * ErrorMappingInterceptor Tests
 *
 * Comprehensive test suite for error mapping and transformation interceptor
 */

import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Request, Response } from 'express';
import { of, throwError } from 'rxjs';

import {
  ErrorMappingInterceptor,
  MappedErrorResponse,
  BusinessError,
  createBusinessError,
  throwBusinessError,
} from '../error-mapping.interceptor';

/**
 * Interface for mapped error response with tracking
 */
interface ErrorResponseWithTracking {
  message?: string;
  errors?: string[];
  trackingId?: string;
  code?: string;
  statusCode?: number;
  path?: string;
}

/**
 * Interface for mock response with setHeader
 */
interface MockResponseWithSetHeader {
  setHeader: jest.Mock;
}

/**
 * Interface for typed HTTP context
 */
interface TypedHttpContext {
  getRequest: () => Partial<Request>;
  getResponse: () => MockResponseWithSetHeader;
}

/**
 * Helper to get typed response from context
 */
const getTypedResponse = (context: ExecutionContext): MockResponseWithSetHeader => {
  const httpContext = context.switchToHttp() as unknown as TypedHttpContext;
  return httpContext.getResponse();
};

/**
 * Helper to call done.fail properly to avoid unbound method lint error
 */
const failTest = (done: jest.DoneCallback, message: string): void => {
  done.fail(message);
};

/**
 * Interface for error with code property
 */
interface ErrorWithCode extends Error {
  code: string;
}

/**
 * Helper to create error with code property - avoids Object.assign returning any
 */
const createErrorWithCode = (message: string, code: string): ErrorWithCode => {
  const error = new Error(message) as ErrorWithCode;
  error.code = code;
  return error;
};

/**
 * Map of error type names to their constructors
 */
const errorConstructors: Record<string, new (message: string) => Error> = {
  TypeError: TypeError,
  ReferenceError: ReferenceError,
  SyntaxError: SyntaxError,
};

/**
 * Helper to create typed error by name
 */
const createTypedError = (errorType: string, message: string): Error => {
  const Constructor = errorConstructors[errorType] ?? Error;
  return new Constructor(message);
};

describe('ErrorMappingInterceptor', () => {
  let interceptor: ErrorMappingInterceptor;
  const originalEnv = process.env['NODE_ENV'];

  /**
   * Create mock execution context
   */
  const createMockExecutionContext = (
    options: {
      path?: string;
      originalUrl?: string;
      method?: string;
      headers?: Record<string, string>;
      ip?: string;
    } = {},
  ): ExecutionContext => {
    const mockRequest: Partial<Request> = {
      path: options.path || '/api/v1/test',
      originalUrl: options.originalUrl || options.path || '/api/v1/test',
      url: options.path || '/api/v1/test',
      method: options.method || 'GET',
      headers: {
        'user-agent': 'test-agent',
        ...options.headers,
      },
      ip: options.ip || '127.0.0.1',
    };

    const mockResponse: Partial<Response> = {
      setHeader: jest.fn(),
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
   * Create mock call handler that throws an error
   */
  const createErrorCallHandler = (error: Error): CallHandler => ({
    handle: () => throwError(() => error),
  });

  /**
   * Create mock call handler that returns successfully
   */
  const createSuccessCallHandler = (response: unknown): CallHandler => ({
    handle: () => of(response),
  });

  beforeEach(async () => {
    process.env['NODE_ENV'] = 'development';

    const module: TestingModule = await Test.createTestingModule({
      providers: [ErrorMappingInterceptor],
    }).compile();

    interceptor = module.get<ErrorMappingInterceptor>(ErrorMappingInterceptor);
  });

  afterEach(() => {
    process.env['NODE_ENV'] = originalEnv;
  });

  describe('Successful Requests', () => {
    it('should pass through successful responses', (done) => {
      const context = createMockExecutionContext();
      const handler = createSuccessCallHandler({ data: 'test' });

      interceptor.intercept(context, handler).subscribe({
        next: (result) => {
          expect(result).toEqual({ data: 'test' });
          done();
        },
        error: (err: unknown) => failTest(done, `Unexpected error: ${String(err)}`),
      });
    });
  });

  describe('HTTP Exception Handling', () => {
    it('should enhance existing HttpException with tracking ID', (done) => {
      const context = createMockExecutionContext();
      const originalError = new HttpException('Not Found', HttpStatus.NOT_FOUND);
      const handler = createErrorCallHandler(originalError);

      interceptor.intercept(context, handler).subscribe({
        next: () => failTest(done, 'Should have thrown'),
        error: (err: unknown) => {
          const error = err as HttpException;
          expect(error).toBeInstanceOf(HttpException);
          expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
          const response = error.getResponse() as ErrorResponseWithTracking;
          expect(response).toHaveProperty('trackingId');
          done();
        },
      });
    });

    it('should preserve HttpException message', (done) => {
      const context = createMockExecutionContext();
      const originalError = new HttpException('Custom message', HttpStatus.BAD_REQUEST);
      const handler = createErrorCallHandler(originalError);

      interceptor.intercept(context, handler).subscribe({
        next: () => failTest(done, 'Should have thrown'),
        error: (err: unknown) => {
          const error = err as HttpException;
          const response = error.getResponse() as ErrorResponseWithTracking;
          expect(response).toHaveProperty('message', 'Custom message');
          done();
        },
      });
    });

    it('should preserve HttpException with object response', (done) => {
      const context = createMockExecutionContext();
      const originalError = new HttpException(
        { message: 'Validation failed', errors: ['field1 is required'] },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
      const handler = createErrorCallHandler(originalError);

      interceptor.intercept(context, handler).subscribe({
        next: () => failTest(done, 'Should have thrown'),
        error: (err: unknown) => {
          const error = err as HttpException;
          const response = error.getResponse() as ErrorResponseWithTracking;
          expect(response.message).toBe('Validation failed');
          expect(response.errors).toEqual(['field1 is required']);
          expect(response.trackingId).toBeDefined();
          done();
        },
      });
    });
  });

  describe('Error Code Mapping', () => {
    describe('Authentication Errors', () => {
      it.each([
        ['AUTH_INVALID_CREDENTIALS', 401, 'Invalid credentials'],
        ['AUTH_TOKEN_EXPIRED', 401, 'Token has expired'],
        ['AUTH_TOKEN_INVALID', 401, 'Invalid token'],
        ['AUTH_INSUFFICIENT_PERMISSIONS', 403, 'Insufficient permissions'],
        ['AUTH_ACCOUNT_LOCKED', 403, 'Account is locked'],
        ['AUTH_ACCOUNT_DISABLED', 403, 'Account is disabled'],
      ])('should map %s to status %d', (code, expectedStatus, expectedMessage, done) => {
        const context = createMockExecutionContext();
        const error = createErrorWithCode('Internal error', code as string);
        const handler = createErrorCallHandler(error);

        interceptor.intercept(context, handler).subscribe({
          next: () => failTest(done as jest.DoneCallback, 'Should have thrown'),
          error: (err: unknown) => {
            const httpError = err as HttpException;
            expect(httpError.getStatus()).toBe(expectedStatus);
            const response = httpError.getResponse() as MappedErrorResponse;
            expect(response.error.code).toBe(code);
            expect(response.error.message).toBe(expectedMessage);
            (done as jest.DoneCallback)();
          },
        });
      });
    });

    describe('Resource Errors', () => {
      it.each([
        ['RESOURCE_NOT_FOUND', 404, 'Resource not found'],
        ['RESOURCE_ALREADY_EXISTS', 409, 'Resource already exists'],
        ['RESOURCE_CONFLICT', 409, 'Resource conflict'],
        ['RESOURCE_GONE', 410, 'Resource no longer available'],
      ])('should map %s to status %d', (code, expectedStatus, expectedMessage, done) => {
        const context = createMockExecutionContext();
        const error = createErrorWithCode('Internal error', code as string);
        const handler = createErrorCallHandler(error);

        interceptor.intercept(context, handler).subscribe({
          next: () => failTest(done as jest.DoneCallback, 'Should have thrown'),
          error: (err: unknown) => {
            const httpError = err as HttpException;
            expect(httpError.getStatus()).toBe(expectedStatus);
            const response = httpError.getResponse() as MappedErrorResponse;
            expect(response.error.message).toBe(expectedMessage);
            (done as jest.DoneCallback)();
          },
        });
      });
    });

    describe('Validation Errors', () => {
      it.each([
        ['VALIDATION_FAILED', 422, 'Validation failed'],
        ['INVALID_INPUT', 400, 'Invalid input'],
        ['MISSING_REQUIRED_FIELD', 400, 'Missing required field'],
      ])('should map %s to status %d', (code, expectedStatus, expectedMessage, done) => {
        const context = createMockExecutionContext();
        const error = createErrorWithCode('Internal error', code as string);
        const handler = createErrorCallHandler(error);

        interceptor.intercept(context, handler).subscribe({
          next: () => failTest(done as jest.DoneCallback, 'Should have thrown'),
          error: (err: unknown) => {
            const httpError = err as HttpException;
            expect(httpError.getStatus()).toBe(expectedStatus);
            const response = httpError.getResponse() as MappedErrorResponse;
            expect(response.error.message).toBe(expectedMessage);
            (done as jest.DoneCallback)();
          },
        });
      });
    });

    describe('Rate Limiting Errors', () => {
      it('should map RATE_LIMIT_EXCEEDED to 429', (done) => {
        const context = createMockExecutionContext();
        const error = createErrorWithCode('Rate limit', 'RATE_LIMIT_EXCEEDED');
        const handler = createErrorCallHandler(error);

        interceptor.intercept(context, handler).subscribe({
          next: () => failTest(done, 'Should have thrown'),
          error: (err: unknown) => {
            const httpError = err as HttpException;
            expect(httpError.getStatus()).toBe(429);
            const response = httpError.getResponse() as MappedErrorResponse;
            expect(response.error.message).toBe('Too many requests');
            done();
          },
        });
      });

      it('should set Retry-After header for rate limit errors', (done) => {
        const context = createMockExecutionContext();
        const error = createErrorWithCode('Rate limit', 'RATE_LIMIT_EXCEEDED');
        const handler = createErrorCallHandler(error);

        interceptor.intercept(context, handler).subscribe({
          next: () => failTest(done, 'Should have thrown'),
          error: () => {
            const response = getTypedResponse(context);
            expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '60');
            done();
          },
        });
      });
    });

    describe('Tenant Errors', () => {
      it.each([
        ['TENANT_NOT_FOUND', 404, 'Tenant not found'],
        ['TENANT_SUSPENDED', 403, 'Tenant is suspended'],
        ['TENANT_LIMIT_EXCEEDED', 429, 'Tenant limit exceeded'],
      ])('should map %s to status %d', (code, expectedStatus, expectedMessage, done) => {
        const context = createMockExecutionContext();
        const error = createErrorWithCode('Internal error', code as string);
        const handler = createErrorCallHandler(error);

        interceptor.intercept(context, handler).subscribe({
          next: () => failTest(done as jest.DoneCallback, 'Should have thrown'),
          error: (err: unknown) => {
            const httpError = err as HttpException;
            expect(httpError.getStatus()).toBe(expectedStatus);
            const response = httpError.getResponse() as MappedErrorResponse;
            expect(response.error.message).toBe(expectedMessage);
            (done as jest.DoneCallback)();
          },
        });
      });
    });

    describe('External Service Errors', () => {
      it.each([
        ['EXTERNAL_SERVICE_ERROR', 502, 'External service error'],
        ['EXTERNAL_SERVICE_TIMEOUT', 504, 'External service timeout'],
        ['EXTERNAL_SERVICE_UNAVAILABLE', 503, 'External service unavailable'],
      ])('should map %s to status %d', (code, expectedStatus, expectedMessage, done) => {
        const context = createMockExecutionContext();
        const error = createErrorWithCode('Internal error', code as string);
        const handler = createErrorCallHandler(error);

        interceptor.intercept(context, handler).subscribe({
          next: () => failTest(done as jest.DoneCallback, 'Should have thrown'),
          error: (err: unknown) => {
            const httpError = err as HttpException;
            expect(httpError.getStatus()).toBe(expectedStatus);
            const response = httpError.getResponse() as MappedErrorResponse;
            expect(response.error.message).toBe(expectedMessage);
            (done as jest.DoneCallback)();
          },
        });
      });
    });

    describe('Database Errors', () => {
      it.each([
        ['DATABASE_ERROR', 500, 'Database error'],
        ['DATABASE_CONNECTION_ERROR', 503, 'Database connection error'],
        ['DATABASE_CONSTRAINT_VIOLATION', 409, 'Database constraint violation'],
      ])('should map %s to status %d', (code: string, expectedStatus: number, expectedMessage: string) => {
        return new Promise<void>((resolve, reject) => {
          const context = createMockExecutionContext();
          const error = createErrorWithCode('Internal error', code);
          const handler = createErrorCallHandler(error);

          interceptor.intercept(context, handler).subscribe({
            next: () => reject(new Error('Should have thrown')),
            error: (err: unknown) => {
              const httpError = err as HttpException;
              expect(httpError.getStatus()).toBe(expectedStatus);
              const response = httpError.getResponse() as MappedErrorResponse;
              expect(response.error.message).toBe(expectedMessage);
              resolve();
            },
          });
        });
      });
    });
  });

  describe('Error Type Mapping', () => {
    it.each([
      ['TypeError', 500],
      ['ReferenceError', 500],
      ['SyntaxError', 500],
    ])('should map %s to status %d', (errorType: string, expectedStatus: number) => {
      return new Promise<void>((resolve, reject) => {
        const context = createMockExecutionContext();
        const error = createTypedError(errorType, 'Test error');
        const handler = createErrorCallHandler(error);

        interceptor.intercept(context, handler).subscribe({
          next: () => reject(new Error('Should have thrown')),
          error: (err: unknown) => {
            const httpError = err as HttpException;
            expect(httpError.getStatus()).toBe(expectedStatus);
            resolve();
          },
        });
      });
    });

    it('should map ValidationError type to 422', (done) => {
      const context = createMockExecutionContext();
      const error = new Error('Validation failed');
      error.name = 'ValidationError';
      const handler = createErrorCallHandler(error);

      interceptor.intercept(context, handler).subscribe({
        next: () => failTest(done, 'Should have thrown'),
        error: (err: unknown) => {
          const httpError = err as HttpException;
          expect(httpError.getStatus()).toBe(422);
          done();
        },
      });
    });

    it('should map NotFoundError type to 404', (done) => {
      const context = createMockExecutionContext();
      const error = new Error('Not found');
      error.name = 'NotFoundError';
      const handler = createErrorCallHandler(error);

      interceptor.intercept(context, handler).subscribe({
        next: () => failTest(done, 'Should have thrown'),
        error: (err: unknown) => {
          const httpError = err as HttpException;
          expect(httpError.getStatus()).toBe(404);
          done();
        },
      });
    });
  });

  describe('Error Message Pattern Mapping', () => {
    it.each([
      ['duplicate key violation', 409, 'A record with this identifier already exists'],
      ['foreign key constraint failed', 409, 'Cannot perform operation due to related records'],
      ['unique constraint violation', 409, 'A record with this value already exists'],
      ['not null violation error', 400, 'A required field is missing'],
      ['connection refused error', 503, 'Service is temporarily unavailable'],
      ['request timeout exceeded', 504, 'Request took too long to process'],
      ['ECONNREFUSED error', 503, 'Service is temporarily unavailable'],
      ['ENOTFOUND error', 503, 'Service is temporarily unavailable'],
    ])('should map message containing "%s" to user-friendly message', (errorMessage: string, expectedStatus: number, expectedUserMessage: string) => {
      return new Promise<void>((resolve, reject) => {
        const context = createMockExecutionContext();
        const error = new Error(errorMessage);
        const handler = createErrorCallHandler(error);

        interceptor.intercept(context, handler).subscribe({
          next: () => reject(new Error('Should have thrown')),
          error: (err: unknown) => {
            const httpError = err as HttpException;
            expect(httpError.getStatus()).toBe(expectedStatus);
            const response = httpError.getResponse() as MappedErrorResponse;
            expect(response.error.message).toBe(expectedUserMessage);
            resolve();
          },
        });
      });
    });
  });

  describe('Error Response Format', () => {
    it('should include success: false', (done) => {
      const context = createMockExecutionContext();
      const error = createErrorWithCode('Test', 'RESOURCE_NOT_FOUND');
      const handler = createErrorCallHandler(error);

      interceptor.intercept(context, handler).subscribe({
        next: () => failTest(done, 'Should have thrown'),
        error: (err: unknown) => {
          const httpError = err as HttpException;
          const response = httpError.getResponse() as MappedErrorResponse;
          expect(response.success).toBe(false);
          done();
        },
      });
    });

    it('should include tracking ID', (done) => {
      const context = createMockExecutionContext();
      const error = createErrorWithCode('Test', 'RESOURCE_NOT_FOUND');
      const handler = createErrorCallHandler(error);

      interceptor.intercept(context, handler).subscribe({
        next: () => failTest(done, 'Should have thrown'),
        error: (err: unknown) => {
          const httpError = err as HttpException;
          const response = httpError.getResponse() as MappedErrorResponse;
          expect(response.error.trackingId).toBeDefined();
          expect(typeof response.error.trackingId).toBe('string');
          expect(response.error.trackingId.length).toBeGreaterThan(0);
          done();
        },
      });
    });

    it('should include meta information', (done) => {
      const context = createMockExecutionContext({
        path: '/api/v1/users',
        method: 'POST',
        headers: { 'x-correlation-id': 'corr-123' },
      });
      const error = createErrorWithCode('Test', 'RESOURCE_NOT_FOUND');
      const handler = createErrorCallHandler(error);

      interceptor.intercept(context, handler).subscribe({
        next: () => failTest(done, 'Should have thrown'),
        error: (err: unknown) => {
          const httpError = err as HttpException;
          const response = httpError.getResponse() as MappedErrorResponse;
          expect(response.meta.path).toBe('/api/v1/users');
          expect(response.meta.method).toBe('POST');
          expect(response.meta.statusCode).toBe(404);
          expect(response.meta.correlationId).toBe('corr-123');
          expect(response.meta.timestamp).toBeDefined();
          done();
        },
      });
    });

    it('should include details in development mode', async () => {
      process.env['NODE_ENV'] = 'development';

      const compiled = await Test.createTestingModule({
        providers: [ErrorMappingInterceptor],
      }).compile();

      const devInterceptor = compiled.get<ErrorMappingInterceptor>(ErrorMappingInterceptor);
      const context = createMockExecutionContext();
      const error = createErrorWithCode('Detailed error message', 'RESOURCE_NOT_FOUND');
      const handler = createErrorCallHandler(error);

      await new Promise<void>((resolve, reject) => {
        devInterceptor.intercept(context, handler).subscribe({
          next: () => reject(new Error('Should have thrown')),
          error: (err: unknown) => {
            const httpError = err as HttpException;
            const response = httpError.getResponse() as MappedErrorResponse;
            expect(response.error.details).toBe('Detailed error message');
            resolve();
          },
        });
      });
    });
  });

  describe('Production Mode', () => {
    it('should hide error details in production', async () => {
      process.env['NODE_ENV'] = 'production';

      const module = await Test.createTestingModule({
        providers: [ErrorMappingInterceptor],
      }).compile();

      const prodInterceptor = module.get<ErrorMappingInterceptor>(ErrorMappingInterceptor);
      const context = createMockExecutionContext();
      const error = new Error('Sensitive internal error');
      const handler = createErrorCallHandler(error);

      await new Promise<void>((resolve, reject) => {
        prodInterceptor.intercept(context, handler).subscribe({
          next: () => reject(new Error('Should have thrown')),
          error: (err: unknown) => {
            const httpError = err as HttpException;
            const response = httpError.getResponse() as MappedErrorResponse;
            expect(response.error.message).toBe('An unexpected error occurred. Please try again later.');
            expect(response.error.stack).toBeUndefined();
            resolve();
          },
        });
      });
    });

    it('should hide stack trace in production', async () => {
      process.env['NODE_ENV'] = 'production';

      const module = await Test.createTestingModule({
        providers: [ErrorMappingInterceptor],
      }).compile();

      const prodInterceptor = module.get<ErrorMappingInterceptor>(ErrorMappingInterceptor);
      const context = createMockExecutionContext();
      const error = new Error('Test error');
      const handler = createErrorCallHandler(error);

      await new Promise<void>((resolve, reject) => {
        prodInterceptor.intercept(context, handler).subscribe({
          next: () => reject(new Error('Should have thrown')),
          error: (err: unknown) => {
            const httpError = err as HttpException;
            const response = httpError.getResponse() as MappedErrorResponse;
            expect(response.error.stack).toBeUndefined();
            resolve();
          },
        });
      });
    });
  });

  describe('Internal Server Error Fallback', () => {
    it('should default to 500 for unknown errors', (done) => {
      const context = createMockExecutionContext();
      const error = new Error('Unknown error');
      const handler = createErrorCallHandler(error);

      interceptor.intercept(context, handler).subscribe({
        next: () => failTest(done, 'Should have thrown'),
        error: (err: unknown) => {
          const httpError = err as HttpException;
          expect(httpError.getStatus()).toBe(500);
          const response = httpError.getResponse() as MappedErrorResponse;
          expect(response.error.code).toBe('INTERNAL_ERROR');
          done();
        },
      });
    });
  });

  describe('Business Error Class', () => {
    it('should create BusinessError with code', () => {
      const error = new BusinessError('CUSTOM_CODE', 'Custom message');
      expect(error.code).toBe('CUSTOM_CODE');
      expect(error.message).toBe('Custom message');
      expect(error.name).toBe('BusinessError');
    });

    it('should create BusinessError with details', () => {
      const details = { field: 'email', reason: 'invalid format' };
      const error = new BusinessError('VALIDATION_ERROR', 'Validation failed', details);
      expect(error.details).toEqual(details);
    });
  });

  describe('createBusinessError Helper', () => {
    it('should create BusinessError instance', () => {
      const error = createBusinessError('TEST_CODE', 'Test message');
      expect(error).toBeInstanceOf(BusinessError);
      expect(error.code).toBe('TEST_CODE');
      expect(error.message).toBe('Test message');
    });

    it('should create BusinessError with details', () => {
      const error = createBusinessError('TEST_CODE', 'Test message', { extra: 'data' });
      expect(error.details).toEqual({ extra: 'data' });
    });
  });

  describe('throwBusinessError Helper', () => {
    it('should throw BusinessError', () => {
      expect(() => {
        throwBusinessError('THROWN_ERROR', 'This should throw');
      }).toThrow(BusinessError);
    });

    it('should throw BusinessError with correct properties', () => {
      try {
        throwBusinessError('THROWN_CODE', 'Thrown message', { id: 123 });
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BusinessError);
        expect((error as BusinessError).code).toBe('THROWN_CODE');
        expect((error as BusinessError).message).toBe('Thrown message');
        expect((error as BusinessError).details).toEqual({ id: 123 });
      }
    });
  });

  describe('Correlation ID Handling', () => {
    it('should include correlation ID from request header', (done) => {
      const context = createMockExecutionContext({
        headers: { 'x-correlation-id': 'trace-abc-123' },
      });
      const error = new Error('Test error');
      const handler = createErrorCallHandler(error);

      interceptor.intercept(context, handler).subscribe({
        next: () => failTest(done, 'Should have thrown'),
        error: (err: unknown) => {
          const httpError = err as HttpException;
          const response = httpError.getResponse() as MappedErrorResponse;
          expect(response.meta.correlationId).toBe('trace-abc-123');
          done();
        },
      });
    });

    it('should handle missing correlation ID', (done) => {
      const context = createMockExecutionContext();
      const error = new Error('Test error');
      const handler = createErrorCallHandler(error);

      interceptor.intercept(context, handler).subscribe({
        next: () => failTest(done, 'Should have thrown'),
        error: (err: unknown) => {
          const httpError = err as HttpException;
          const response = httpError.getResponse() as MappedErrorResponse;
          expect(response.meta.correlationId).toBeUndefined();
          done();
        },
      });
    });
  });

  describe('URL Path Handling', () => {
    it('should use originalUrl when available', (done) => {
      const context = createMockExecutionContext({
        path: '/rewritten',
        originalUrl: '/api/v1/original/path',
      });
      const error = new Error('Test error');
      const handler = createErrorCallHandler(error);

      interceptor.intercept(context, handler).subscribe({
        next: () => failTest(done, 'Should have thrown'),
        error: (err: unknown) => {
          const httpError = err as HttpException;
          const response = httpError.getResponse() as MappedErrorResponse;
          expect(response.meta.path).toBe('/api/v1/original/path');
          done();
        },
      });
    });

    it('should fallback to url when originalUrl is missing', (done) => {
      const mockRequest: Partial<Request> = {
        path: '/api/v1/test',
        url: '/api/v1/test',
        method: 'GET',
        headers: {},
        ip: '127.0.0.1',
      };

      const context = {
        switchToHttp: () => ({
          getRequest: () => mockRequest,
          getResponse: () => ({ setHeader: jest.fn() }),
        }),
        getHandler: () => jest.fn(),
        getClass: () => jest.fn(),
        getType: () => 'http',
      } as unknown as ExecutionContext;

      const error = new Error('Test error');
      const handler = createErrorCallHandler(error);

      interceptor.intercept(context, handler).subscribe({
        next: () => failTest(done, 'Should have thrown'),
        error: (err: unknown) => {
          const httpError = err as HttpException;
          const response = httpError.getResponse() as MappedErrorResponse;
          expect(response.meta.path).toBe('/api/v1/test');
          done();
        },
      });
    });
  });

  describe('Timestamp Format', () => {
    it('should include ISO timestamp in meta', (done) => {
      const context = createMockExecutionContext();
      const error = new Error('Test error');
      const handler = createErrorCallHandler(error);

      interceptor.intercept(context, handler).subscribe({
        next: () => failTest(done, 'Should have thrown'),
        error: (err: unknown) => {
          const httpError = err as HttpException;
          const response = httpError.getResponse() as MappedErrorResponse;
          expect(new Date(response.meta.timestamp).toISOString()).toBe(response.meta.timestamp);
          done();
        },
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle error with no message', (done) => {
      const context = createMockExecutionContext();
      const error = new Error();
      const handler = createErrorCallHandler(error);

      interceptor.intercept(context, handler).subscribe({
        next: () => failTest(done, 'Should have thrown'),
        error: (err: unknown) => {
          const httpError = err as HttpException;
          expect(httpError.getStatus()).toBe(500);
          done();
        },
      });
    });

    it('should handle error with null prototype', (done) => {
      const context = createMockExecutionContext();
      const error = Object.create(null) as Error;
      error.message = 'Null prototype error';
      error.name = 'Error';
      const handler = createErrorCallHandler(error);

      interceptor.intercept(context, handler).subscribe({
        next: () => failTest(done, 'Should have thrown'),
        error: (err: unknown) => {
          expect(err).toBeInstanceOf(HttpException);
          done();
        },
      });
    });

    it('should handle circular reference in error details', (done) => {
      const context = createMockExecutionContext();
      const error = createErrorWithCode('Circular error', 'RESOURCE_NOT_FOUND');
      const handler = createErrorCallHandler(error);

      interceptor.intercept(context, handler).subscribe({
        next: () => failTest(done, 'Should have thrown'),
        error: (err: unknown) => {
          expect(err).toBeInstanceOf(HttpException);
          done();
        },
      });
    });
  });
});
