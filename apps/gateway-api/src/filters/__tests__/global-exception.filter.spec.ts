import { ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ErrorResponse } from '@platform/shared';
import { GraphQLError } from 'graphql';

import { GlobalExceptionFilter } from '../global-exception.filter';

interface MockResponse {
  status: jest.Mock<MockResponse, [number]>;
  type: jest.Mock<MockResponse, [string]>;
  json: jest.Mock<MockResponse, [ErrorResponse]>;
}

interface MockRequest {
  url: string;
  originalUrl?: string;
  method: string;
  headers: Record<string, string | undefined>;
  tenantId?: string;
}

function createHttpHost(
  options: {
    url?: string;
    correlationId?: string;
    tenantId?: string;
  } = {},
): { host: ArgumentsHost; response: MockResponse } {
  const request: MockRequest = {
    url: options.url ?? '/api/test',
    originalUrl: options.url ?? '/api/test',
    method: 'GET',
    headers: {
      'x-correlation-id': options.correlationId,
      'x-tenant-id': options.tenantId,
    },
    tenantId: options.tenantId,
  };
  const response: MockResponse = {
    status: jest.fn().mockReturnThis() as jest.Mock<MockResponse, [number]>,
    type: jest.fn().mockReturnThis() as jest.Mock<MockResponse, [string]>,
    json: jest.fn().mockReturnThis() as jest.Mock<MockResponse, [ErrorResponse]>,
  };

  return {
    response,
    host: {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as ArgumentsHost,
  };
}

function createGraphqlHost(
  options: { correlationId?: string; tenantId?: string } = {},
): ArgumentsHost {
  const request: MockRequest = {
    url: '/graphql?token=private',
    method: 'POST',
    headers: {
      'x-correlation-id': options.correlationId,
      'x-tenant-id': options.tenantId,
    },
    tenantId: options.tenantId,
  };

  return {
    getType: () => 'graphql',
    getArgs: () => [{}, {}, { req: request }, {}],
  } as ArgumentsHost;
}

describe('Gateway GlobalExceptionFilter', () => {
  const originalNodeEnv = process.env['NODE_ENV'];

  afterEach(() => {
    process.env['NODE_ENV'] = originalNodeEnv;
    jest.restoreAllMocks();
  });

  it('emits the exact canonical JSON envelope for HTTP', () => {
    process.env['NODE_ENV'] = 'development';
    const filter = new GlobalExceptionFilter();
    const { host, response } = createHttpHost({
      url: '/api/users/user-1?access_token=private',
      correlationId: 'corr-123',
      tenantId: 'tenant-private',
    });

    filter.catch(new HttpException('User not found', HttpStatus.NOT_FOUND), host);

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.type).toHaveBeenCalledWith('application/json');
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'RESOURCE_NOT_FOUND',
        message: 'User not found',
        timestamp: expect.any(String),
        path: '/api/users/user-1',
        correlationId: 'corr-123',
      },
    });
    expect(JSON.stringify(response.json.mock.calls[0]?.[0])).not.toContain('tenant-private');
  });

  it('uses a production allowlist and never logs or reflects PII, signed URLs, or details', () => {
    process.env['NODE_ENV'] = 'production';
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const filter = new GlobalExceptionFilter();
    const { host, response } = createHttpHost({
      url: '/api/users/alice@example.com?X-Amz-Signature=private',
      correlationId: 'alice@example.com',
      tenantId: 'tenant-private',
    });

    filter.catch(
      new HttpException(
        {
          message: 'alice@example.com https://storage/object?signature=private',
          details: { password: 'private' },
        },
        HttpStatus.BAD_REQUEST,
      ),
      host,
    );

    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Validation failed',
        timestamp: expect.any(String),
      },
    });
    expect(JSON.stringify(response.json.mock.calls)).not.toMatch(
      /alice@example\.com|signature|private|password|tenant-private/i,
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toMatch(
      /alice@example\.com|signature|private|password|tenant-private/i,
    );
  });

  it.each([
    [HttpStatus.METHOD_NOT_ALLOWED, 'HTTP_METHOD_NOT_ALLOWED'],
    [HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'HTTP_UNSUPPORTED_MEDIA_TYPE'],
  ])('keeps status %d aligned with code %s', (status, code) => {
    process.env['NODE_ENV'] = 'development';
    const filter = new GlobalExceptionFilter();
    const { host, response } = createHttpHost();

    filter.catch(new HttpException('Rejected', status), host);

    expect(response.status).toHaveBeenCalledWith(status);
    expect(response.json.mock.calls[0]?.[0].error.code).toBe(code);
  });

  it('normalizes an unregistered HTTP status to the consistent 500 pair', () => {
    process.env['NODE_ENV'] = 'production';
    const filter = new GlobalExceptionFilter();
    const { host, response } = createHttpHost();

    filter.catch(new HttpException('teapot detail', 418), host);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json.mock.calls[0]?.[0].error).toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
      timestamp: expect.any(String),
    });
  });

  it('preserves the existing GraphQL mapping and development validation details', () => {
    process.env['NODE_ENV'] = 'development';
    const filter = new GlobalExceptionFilter();

    const result = filter.catch(
      new HttpException(
        { message: 'Invalid input', details: { field: 'email' } },
        HttpStatus.UNPROCESSABLE_ENTITY,
      ),
      createGraphqlHost({ correlationId: 'gql-corr-1' }),
    ) as GraphQLError;

    expect(result.message).toBe('Invalid input');
    expect(result.extensions).toEqual({
      code: 'UNPROCESSABLE_ENTITY',
      statusCode: 422,
      timestamp: expect.any(String),
      correlationId: 'gql-corr-1',
      path: '/graphql?token=private',
      details: { field: 'email' },
    });
  });

  it('redacts production GraphQL messages, details, paths, and unsafe correlation IDs', () => {
    process.env['NODE_ENV'] = 'production';
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const filter = new GlobalExceptionFilter();

    const result = filter.catch(
      new HttpException(
        { message: 'alice@example.com token=private', details: { password: 'private' } },
        HttpStatus.FORBIDDEN,
      ),
      createGraphqlHost({
        correlationId: 'alice@example.com',
        tenantId: 'tenant-private',
      }),
    ) as GraphQLError;

    expect(result.message).toBe('You do not have permission to perform this action');
    expect(result.extensions).toEqual({
      code: 'FORBIDDEN',
      statusCode: 403,
      timestamp: expect.any(String),
      correlationId: undefined,
    });
    expect(JSON.stringify(warnSpy.mock.calls)).not.toMatch(
      /alice@example\.com|token|private|password|tenant-private/i,
    );
  });
});
