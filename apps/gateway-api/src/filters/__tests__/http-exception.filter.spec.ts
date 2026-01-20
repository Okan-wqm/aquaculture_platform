/**
 * HTTP Exception Filter Tests
 *
 * Comprehensive test suite for HTTP exception handling
 */

import {
  HttpException,
  HttpStatus,
  ArgumentsHost,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Request, Response } from 'express';

import {
  HttpExceptionFilter,
  HttpErrorResponse,
  createHttpException,
  createValidationException,
} from '../http-exception.filter';


describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;
  const originalEnv = process.env['NODE_ENV'];

  /**
   * Create mock HTTP arguments host
   */
  const createMockHttpHost = (options: {
    url?: string;
    originalUrl?: string;
    method?: string;
    correlationId?: string;
    requestId?: string;
    ip?: string;
    userAgent?: string;
  } = {}): ArgumentsHost => {
    const mockRequest: Partial<Request> = {
      url: options.url || '/api/test',
      originalUrl: options.originalUrl || options.url || '/api/test',
      method: options.method || 'GET',
      headers: {
        'x-correlation-id': options.correlationId,
        'x-request-id': options.requestId,
        'user-agent': options.userAgent || 'test-agent',
      },
      ip: options.ip || '127.0.0.1',
    };

    const mockResponse: Partial<Response> = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockReturnThis(),
    };

    return {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
        getResponse: () => mockResponse,
      }),
      getType: () => 'http',
    } as unknown as ArgumentsHost;
  };

  beforeEach(async () => {
    process.env['NODE_ENV'] = 'development';

    const module: TestingModule = await Test.createTestingModule({
      providers: [HttpExceptionFilter],
    }).compile();

    filter = module.get<HttpExceptionFilter>(HttpExceptionFilter);
  });

  afterEach(() => {
    process.env['NODE_ENV'] = originalEnv;
  });

  describe('Standard Error Response Format', () => {
    it('should return success: false', () => {
      const host = createMockHttpHost();
      const exception = new HttpException('Test', HttpStatus.BAD_REQUEST);

      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
        }),
      );
    });

    it('should include error code based on status', () => {
      const host = createMockHttpHost();
      const exception = new HttpException('Test', HttpStatus.NOT_FOUND);

      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'NOT_FOUND',
          }),
        }),
      );
    });

    it('should include meta information', () => {
      const host = createMockHttpHost({
        url: '/api/users',
        method: 'POST',
        correlationId: 'corr-123',
      });
      const exception = new HttpException('Test', HttpStatus.BAD_REQUEST);

      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          meta: expect.objectContaining({
            path: '/api/users',
            method: 'POST',
            statusCode: 400,
            correlationId: 'corr-123',
          }),
        }),
      );
    });

    it('should include timestamp in ISO format', () => {
      const host = createMockHttpHost();
      const exception = new HttpException('Test', HttpStatus.BAD_REQUEST);

      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      const call = response.json.mock.calls[0][0] as HttpErrorResponse;
      expect(new Date(call.meta.timestamp).toISOString()).toBe(call.meta.timestamp);
    });
  });

  describe('Status Code Mapping', () => {
    it.each([
      [HttpStatus.BAD_REQUEST, 'BAD_REQUEST'],
      [HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED'],
      [HttpStatus.FORBIDDEN, 'FORBIDDEN'],
      [HttpStatus.NOT_FOUND, 'NOT_FOUND'],
      [HttpStatus.METHOD_NOT_ALLOWED, 'METHOD_NOT_ALLOWED'],
      [HttpStatus.NOT_ACCEPTABLE, 'NOT_ACCEPTABLE'],
      [HttpStatus.REQUEST_TIMEOUT, 'REQUEST_TIMEOUT'],
      [HttpStatus.CONFLICT, 'CONFLICT'],
      [HttpStatus.GONE, 'GONE'],
      [HttpStatus.PAYLOAD_TOO_LARGE, 'PAYLOAD_TOO_LARGE'],
      [HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'UNSUPPORTED_MEDIA_TYPE'],
      [HttpStatus.UNPROCESSABLE_ENTITY, 'UNPROCESSABLE_ENTITY'],
      [HttpStatus.TOO_MANY_REQUESTS, 'TOO_MANY_REQUESTS'],
      [HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_SERVER_ERROR'],
      [HttpStatus.NOT_IMPLEMENTED, 'NOT_IMPLEMENTED'],
      [HttpStatus.BAD_GATEWAY, 'BAD_GATEWAY'],
      [HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE'],
      [HttpStatus.GATEWAY_TIMEOUT, 'GATEWAY_TIMEOUT'],
    ])('should map status %d to code %s', (status, expectedCode) => {
      const host = createMockHttpHost();
      const exception = new HttpException('Test', status);

      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: expectedCode,
          }),
        }),
      );
    });
  });

  describe('User-Friendly Messages', () => {
    it('should use user-friendly message when string response', () => {
      const host = createMockHttpHost();
      const exception = new HttpException('Custom message', HttpStatus.BAD_REQUEST);

      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: 'Custom message',
          }),
        }),
      );
    });

    it('should use default message when no message provided', () => {
      const host = createMockHttpHost();
      const exception = new HttpException({}, HttpStatus.NOT_FOUND);

      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: 'The requested resource was not found.',
          }),
        }),
      );
    });
  });

  describe('Validation Error Handling', () => {
    it('should parse validation errors from array', () => {
      const host = createMockHttpHost();
      const exception = new HttpException(
        { message: ['email must be valid', 'name is required'] },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );

      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      const call = response.json.mock.calls[0][0] as HttpErrorResponse;

      expect(call.error.validationErrors).toBeDefined();
      expect(call.error.validationErrors).toHaveLength(2);
      expect(call.error.message).toBe('Validation failed');
    });

    it('should extract field name from validation message', () => {
      const host = createMockHttpHost();
      const exception = new HttpException(
        { message: ['email must be valid format'] },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );

      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      const call = response.json.mock.calls[0][0] as HttpErrorResponse;

      expect(call.error.validationErrors?.[0]).toEqual({
        field: 'email',
        message: 'must be valid format',
        code: 'VALIDATION_ERROR',
      });
    });

    it('should use unknown field when cannot extract', () => {
      const host = createMockHttpHost();
      const exception = new HttpException(
        { message: ['invalid input'] },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );

      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      const call = response.json.mock.calls[0][0] as HttpErrorResponse;

      expect(call.error.validationErrors?.[0]?.field).toBe('unknown');
    });
  });

  describe('Special Headers', () => {
    it('should set Retry-After header for 429', () => {
      const host = createMockHttpHost();
      const exception = new HttpException(
        { message: 'Rate limited', retryAfter: 120 },
        HttpStatus.TOO_MANY_REQUESTS,
      );

      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '120');
    });

    it('should use default Retry-After of 60 when not provided', () => {
      const host = createMockHttpHost();
      const exception = new HttpException('Rate limited', HttpStatus.TOO_MANY_REQUESTS);

      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '60');
    });

    it('should set WWW-Authenticate header for 401', () => {
      const host = createMockHttpHost();
      const exception = new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);

      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      expect(response.setHeader).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer');
    });

    it('should set Allow header for 405', () => {
      const host = createMockHttpHost();
      const exception = new HttpException(
        { message: 'Method not allowed', allowedMethods: ['GET', 'POST'] },
        HttpStatus.METHOD_NOT_ALLOWED,
      );

      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      expect(response.setHeader).toHaveBeenCalledWith('Allow', 'GET, POST');
    });
  });

  describe('Production Mode', () => {
    it('should use generic message for 5xx errors in production', () => {
      process.env['NODE_ENV'] = 'production';

      const host = createMockHttpHost();
      const exception = new HttpException('Database query failed', HttpStatus.INTERNAL_SERVER_ERROR);

      const prodFilter = new HttpExceptionFilter();
      prodFilter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: 'An unexpected error occurred. Please try again later.',
          }),
        }),
      );
    });

    it('should hide details in production', () => {
      process.env['NODE_ENV'] = 'production';

      const host = createMockHttpHost();
      const exception = new HttpException(
        { message: 'Error', details: { sensitive: 'data' } },
        HttpStatus.BAD_REQUEST,
      );

      const prodFilter = new HttpExceptionFilter();
      prodFilter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      const call = response.json.mock.calls[0][0] as HttpErrorResponse;
      expect(call.error.details).toBeUndefined();
    });

    it('should preserve client error messages in production', () => {
      process.env['NODE_ENV'] = 'production';

      const host = createMockHttpHost();
      const exception = new HttpException('Resource not found', HttpStatus.NOT_FOUND);

      const prodFilter = new HttpExceptionFilter();
      prodFilter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: 'Resource not found',
          }),
        }),
      );
    });
  });

  describe('NestJS Exception Classes', () => {
    it('should handle BadRequestException', () => {
      const host = createMockHttpHost();
      const exception = new BadRequestException('Invalid input');

      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      expect(response.status).toHaveBeenCalledWith(400);
    });

    it('should handle UnauthorizedException', () => {
      const host = createMockHttpHost();
      const exception = new UnauthorizedException('Not authenticated');

      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      expect(response.status).toHaveBeenCalledWith(401);
    });

    it('should handle ForbiddenException', () => {
      const host = createMockHttpHost();
      const exception = new ForbiddenException('Access denied');

      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      expect(response.status).toHaveBeenCalledWith(403);
    });

    it('should handle NotFoundException', () => {
      const host = createMockHttpHost();
      const exception = new NotFoundException('User not found');

      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      expect(response.status).toHaveBeenCalledWith(404);
    });
  });

  describe('Correlation ID', () => {
    it('should use x-correlation-id header', () => {
      const host = createMockHttpHost({ correlationId: 'corr-123' });
      const exception = new HttpException('Test', HttpStatus.BAD_REQUEST);

      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      const call = response.json.mock.calls[0][0] as HttpErrorResponse;
      expect(call.meta.correlationId).toBe('corr-123');
    });

    it('should fallback to x-request-id header', () => {
      const host = createMockHttpHost({ requestId: 'req-456' });
      const exception = new HttpException('Test', HttpStatus.BAD_REQUEST);

      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      const call = response.json.mock.calls[0][0] as HttpErrorResponse;
      expect(call.meta.correlationId).toBe('req-456');
    });
  });

  describe('Helper Functions', () => {
    describe('createHttpException', () => {
      it('should create HttpException with message', () => {
        const exception = createHttpException(HttpStatus.BAD_REQUEST, 'Invalid data');

        expect(exception).toBeInstanceOf(HttpException);
        expect(exception.getStatus()).toBe(400);
      });

      it('should include details in exception', () => {
        const exception = createHttpException(HttpStatus.BAD_REQUEST, 'Invalid data', {
          field: 'email',
        });

        const response = exception.getResponse() as Record<string, unknown>;
        expect(response.details).toEqual({ field: 'email' });
      });
    });

    describe('createValidationException', () => {
      it('should create 422 exception with validation errors', () => {
        const errors = [
          { field: 'email', message: 'must be valid', code: 'INVALID_EMAIL' },
          { field: 'name', message: 'is required', code: 'REQUIRED' },
        ];

        const exception = createValidationException(errors);

        expect(exception.getStatus()).toBe(422);
        const response = exception.getResponse() as Record<string, unknown>;
        expect(response.validationErrors).toEqual(errors);
      });
    });
  });

  describe('URL Path Handling', () => {
    it('should use originalUrl when available', () => {
      const host = createMockHttpHost({
        url: '/rewritten',
        originalUrl: '/api/v1/original',
      });
      const exception = new HttpException('Test', HttpStatus.BAD_REQUEST);

      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      const call = response.json.mock.calls[0][0] as HttpErrorResponse;
      expect(call.meta.path).toBe('/api/v1/original');
    });

    it('should fallback to url when originalUrl not available', () => {
      const host = createMockHttpHost({ url: '/api/test' });
      (host.switchToHttp().getRequest()).originalUrl = undefined;

      const exception = new HttpException('Test', HttpStatus.BAD_REQUEST);

      filter.catch(exception, host);

      const response = host.switchToHttp().getResponse();
      const call = response.json.mock.calls[0][0] as HttpErrorResponse;
      expect(call.meta.path).toBe('/api/test');
    });
  });
});
