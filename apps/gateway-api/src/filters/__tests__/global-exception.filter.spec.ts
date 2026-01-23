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
 * Global Exception Filter Tests
 *
 * Comprehensive test suite for global exception handling
 */

import { HttpException, HttpStatus, ArgumentsHost } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { GraphQLError } from 'graphql';

import { GlobalExceptionFilter } from '../global-exception.filter';

/**
 * Error response body structure
 */
interface ErrorResponseBody {
  statusCode: number;
  message: string;
  error?: string;
  path?: string;
  timestamp?: string;
  correlationId?: string;
  tenantId?: string;
  details?: unknown;
}

/**
 * Mock response with properly typed methods
 */
interface MockResponseObject {
  status: jest.Mock<MockResponseObject, [number]>;
  json: jest.Mock<MockResponseObject, [ErrorResponseBody]>;
}

/**
 * Mock request structure
 */
interface MockRequestObject {
  url: string;
  method: string;
  headers: Record<string, string | undefined>;
  tenantId?: string;
}

/**
 * Mock HTTP host structure
 */
interface MockHttpHost {
  getRequest: () => MockRequestObject;
  getResponse: () => MockResponseObject;
}

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;
  const originalEnv = process.env['NODE_ENV'];

  /**
   * Create mock HTTP arguments host
   */
  const createMockHttpHost = (options: {
    url?: string;
    method?: string;
    correlationId?: string;
    tenantId?: string;
  } = {}): ArgumentsHost => {
    const mockRequest: MockRequestObject = {
      url: options.url ?? '/api/test',
      method: options.method ?? 'GET',
      headers: {
        'x-correlation-id': options.correlationId,
        'x-tenant-id': options.tenantId,
      },
      tenantId: options.tenantId,
    };

    const mockResponse: MockResponseObject = {
      status: jest.fn().mockReturnThis() as jest.Mock<MockResponseObject, [number]>,
      json: jest.fn().mockReturnThis() as jest.Mock<MockResponseObject, [ErrorResponseBody]>,
    };

    const mockHttpHost: MockHttpHost = {
      getRequest: () => mockRequest,
      getResponse: () => mockResponse,
    };

    return {
      switchToHttp: () => mockHttpHost,
      getType: () => 'http',
    } as unknown as ArgumentsHost;
  };

  /**
   * Create mock GraphQL arguments host
   */
  const createMockGraphQLHost = (options: {
    url?: string;
    correlationId?: string;
    tenantId?: string;
  } = {}): ArgumentsHost => {
    const mockRequest: MockRequestObject = {
      url: options.url ?? '/graphql',
      method: 'POST',
      headers: {
        'x-correlation-id': options.correlationId,
        'x-tenant-id': options.tenantId,
      },
      tenantId: options.tenantId,
    };

    return {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
        getResponse: () => ({}),
      }),
      getType: () => 'graphql',
      getArgs: () => [{}, {}, { req: mockRequest }, {}],
    } as unknown as ArgumentsHost;
  };

  /**
   * Helper to get response body from mock
   */
  const getResponseBody = (host: ArgumentsHost): ErrorResponseBody | undefined => {
    const httpHost = host.switchToHttp() as MockHttpHost;
    const response = httpHost.getResponse();
    const calls = response.json.mock.calls;
    if (calls.length > 0) {
      return calls[calls.length - 1][0];
    }
    return undefined;
  };

  /**
   * Helper to get mock response
   */
  const getMockResponse = (host: ArgumentsHost): MockResponseObject => {
    const httpHost = host.switchToHttp() as MockHttpHost;
    return httpHost.getResponse();
  };

  beforeEach(async () => {
    process.env['NODE_ENV'] = 'development';

    const module: TestingModule = await Test.createTestingModule({
      providers: [GlobalExceptionFilter],
    }).compile();

    filter = module.get<GlobalExceptionFilter>(GlobalExceptionFilter);
  });

  afterEach(() => {
    process.env['NODE_ENV'] = originalEnv;
  });

  describe('HTTP Exception Handling', () => {
    it('should handle HttpException and return proper response', () => {
      const host = createMockHttpHost({ url: '/api/users' });
      const exception = new HttpException('Not Found', HttpStatus.NOT_FOUND);

      filter.catch(exception, host);

      const response = getMockResponse(host);
      expect(response.status).toHaveBeenCalledWith(404);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 404,
          message: 'Not Found',
          path: '/api/users',
        }),
      );
    });

    it('should include correlation ID in response', () => {
      const host = createMockHttpHost({ correlationId: 'corr-123' });
      const exception = new HttpException('Error', HttpStatus.BAD_REQUEST);

      filter.catch(exception, host);

      const response = getMockResponse(host);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationId: 'corr-123',
        }),
      );
    });

    it('should include tenant ID in response', () => {
      const host = createMockHttpHost({ tenantId: 'tenant-456' });
      const exception = new HttpException('Error', HttpStatus.BAD_REQUEST);

      filter.catch(exception, host);

      const response = getMockResponse(host);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-456',
        }),
      );
    });

    it('should include timestamp in response', () => {
      const host = createMockHttpHost();
      const exception = new HttpException('Error', HttpStatus.BAD_REQUEST);

      filter.catch(exception, host);

      const responseBody = getResponseBody(host);
      expect(responseBody).toBeDefined();
      expect(responseBody?.timestamp).toBeDefined();
      if (responseBody?.timestamp) {
        expect(new Date(responseBody.timestamp).toISOString()).toBe(responseBody.timestamp);
      }
    });

    it('should handle HttpException with object response', () => {
      const host = createMockHttpHost();
      const exception = new HttpException(
        { message: 'Custom message', error: 'Custom Error', details: { field: 'email' } },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );

      filter.catch(exception, host);

      const response = getMockResponse(host);
      expect(response.status).toHaveBeenCalledWith(422);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Custom message',
          error: 'Custom Error',
        }),
      );
    });

    it('should include details in development mode', () => {
      process.env['NODE_ENV'] = 'development';

      const host = createMockHttpHost();
      const exception = new HttpException(
        { message: 'Error', details: { extra: 'info' } },
        HttpStatus.BAD_REQUEST,
      );

      // Need to create new filter instance to pick up env change
      const devFilter = new GlobalExceptionFilter();
      devFilter.catch(exception, host);

      const response = getMockResponse(host);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          details: { extra: 'info' },
        }),
      );
    });

    it('should hide details in production mode', () => {
      process.env['NODE_ENV'] = 'production';

      const host = createMockHttpHost();
      const exception = new HttpException(
        { message: 'Error', details: { sensitive: 'data' } },
        HttpStatus.BAD_REQUEST,
      );

      const prodFilter = new GlobalExceptionFilter();
      prodFilter.catch(exception, host);

      const responseBody = getResponseBody(host);
      expect(responseBody?.details).toBeUndefined();
    });
  });

  describe('Generic Error Handling', () => {
    it('should handle generic Error', () => {
      const host = createMockHttpHost();
      const exception = new Error('Something went wrong');

      filter.catch(exception, host);

      const response = getMockResponse(host);
      expect(response.status).toHaveBeenCalledWith(500);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 500,
          message: 'Something went wrong',
          error: 'Internal Server Error',
        }),
      );
    });

    it('should include stack trace in development', () => {
      process.env['NODE_ENV'] = 'development';

      const host = createMockHttpHost();
      const exception = new Error('Test error');

      const devFilter = new GlobalExceptionFilter();
      devFilter.catch(exception, host);

      const responseBody = getResponseBody(host);
      expect(responseBody?.details).toContain('Error: Test error');
    });

    it('should hide stack trace in production', () => {
      process.env['NODE_ENV'] = 'production';

      const host = createMockHttpHost();
      const exception = new Error('Test error');

      const prodFilter = new GlobalExceptionFilter();
      prodFilter.catch(exception, host);

      const responseBody = getResponseBody(host);
      expect(responseBody?.details).toBeUndefined();
    });

    it('should handle unknown exception types', () => {
      const host = createMockHttpHost();
      const exception = 'string exception';

      filter.catch(exception, host);

      const response = getMockResponse(host);
      expect(response.status).toHaveBeenCalledWith(500);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'An unexpected error occurred',
        }),
      );
    });
  });

  describe('GraphQL Exception Handling', () => {
    it('should handle GraphQL exception and return GraphQLError', () => {
      const host = createMockGraphQLHost();
      const exception = new HttpException('GraphQL Error', HttpStatus.BAD_REQUEST);

      const result = filter.catch(exception, host);

      expect(result).toBeInstanceOf(GraphQLError);
      expect((result as GraphQLError).message).toBe('GraphQL Error');
    });

    it('should include correct code in GraphQL error extensions', () => {
      const host = createMockGraphQLHost();
      const exception = new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);

      const result = filter.catch(exception, host) as GraphQLError;

      expect(result.extensions?.['code']).toBe('UNAUTHENTICATED');
    });

    it('should map status codes to GraphQL error codes', () => {
      const statusCodeMappings: Array<[number, string]> = [
        [400, 'BAD_REQUEST'],
        [401, 'UNAUTHENTICATED'],
        [403, 'FORBIDDEN'],
        [404, 'NOT_FOUND'],
        [409, 'CONFLICT'],
        [422, 'UNPROCESSABLE_ENTITY'],
        [429, 'TOO_MANY_REQUESTS'],
        [500, 'INTERNAL_SERVER_ERROR'],
      ];

      for (const [status, expectedCode] of statusCodeMappings) {
        const host = createMockGraphQLHost();
        const exception = new HttpException('Test', status);

        const result = filter.catch(exception, host) as GraphQLError;
        expect(result.extensions?.['code']).toBe(expectedCode);
      }
    });

    it('should include correlation ID in GraphQL error', () => {
      const host = createMockGraphQLHost({ correlationId: 'gql-corr-123' });
      const exception = new HttpException('Error', HttpStatus.BAD_REQUEST);

      const result = filter.catch(exception, host) as GraphQLError;

      expect(result.extensions?.['correlationId']).toBe('gql-corr-123');
    });

    it('should handle GraphQLError exception', () => {
      const host = createMockGraphQLHost();
      const exception = new GraphQLError('GraphQL specific error', {
        extensions: { code: 'CUSTOM_CODE', statusCode: 400 },
      });

      const result = filter.catch(exception, host) as GraphQLError;

      expect(result).toBeInstanceOf(GraphQLError);
    });
  });

  describe('Message Sanitization', () => {
    it('should not sanitize messages in development', () => {
      process.env['NODE_ENV'] = 'development';

      const host = createMockHttpHost();
      const exception = new HttpException('Invalid password format', HttpStatus.BAD_REQUEST);

      const devFilter = new GlobalExceptionFilter();
      devFilter.catch(exception, host);

      const response = getMockResponse(host);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Invalid password format',
        }),
      );
    });

    it('should sanitize sensitive messages in production', () => {
      process.env['NODE_ENV'] = 'production';

      const sensitiveMessages = [
        'Invalid password',
        'Secret key expired',
        'Token validation failed',
        'API key invalid',
        'Credential mismatch',
        'SQL syntax error',
        'Query execution failed',
        'Database connection error',
      ];

      for (const msg of sensitiveMessages) {
        const host = createMockHttpHost();
        const exception = new HttpException(msg, HttpStatus.BAD_REQUEST);

        const prodFilter = new GlobalExceptionFilter();
        prodFilter.catch(exception, host);

        const responseBody = getResponseBody(host);
        expect(responseBody?.message).toBe('An error occurred while processing your request');
      }
    });

    it('should not sanitize non-sensitive messages in production', () => {
      process.env['NODE_ENV'] = 'production';

      const host = createMockHttpHost();
      const exception = new HttpException('Resource not found', HttpStatus.NOT_FOUND);

      const prodFilter = new GlobalExceptionFilter();
      prodFilter.catch(exception, host);

      const response = getMockResponse(host);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Resource not found',
        }),
      );
    });
  });

  describe('Status Code Handling', () => {
    it.each([
      [HttpStatus.BAD_REQUEST, 400],
      [HttpStatus.UNAUTHORIZED, 401],
      [HttpStatus.FORBIDDEN, 403],
      [HttpStatus.NOT_FOUND, 404],
      [HttpStatus.CONFLICT, 409],
      [HttpStatus.UNPROCESSABLE_ENTITY, 422],
      [HttpStatus.TOO_MANY_REQUESTS, 429],
      [HttpStatus.INTERNAL_SERVER_ERROR, 500],
      [HttpStatus.BAD_GATEWAY, 502],
      [HttpStatus.SERVICE_UNAVAILABLE, 503],
      [HttpStatus.GATEWAY_TIMEOUT, 504],
    ])('should handle status code %d correctly', (status, expectedStatus) => {
      const host = createMockHttpHost();
      const exception = new HttpException('Test', status);

      filter.catch(exception, host);

      const response = getMockResponse(host);
      expect(response.status).toHaveBeenCalledWith(expectedStatus);
    });
  });

  describe('Error Type Detection', () => {
    it('should detect HTTP exception', () => {
      const host = createMockHttpHost();
      const exception = new HttpException('Test', HttpStatus.BAD_REQUEST);

      filter.catch(exception, host);

      const response = getMockResponse(host);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Bad Request',
        }),
      );
    });

    it('should use error type from exception response', () => {
      const host = createMockHttpHost();
      const exception = new HttpException(
        { message: 'Custom', error: 'Custom Error Type' },
        HttpStatus.BAD_REQUEST,
      );

      filter.catch(exception, host);

      const response = getMockResponse(host);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Custom Error Type',
        }),
      );
    });
  });
});
