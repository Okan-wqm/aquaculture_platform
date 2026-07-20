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
  method: string;
  headers: Record<string, string | undefined>;
}

function createHttpHost(
  options: {
    url?: string;
    correlationId?: string;
    tenantId?: string;
  } = {},
): { host: ArgumentsHost; response: MockResponse } {
  const request: MockRequest = {
    url: options.url ?? '/api/farms',
    method: 'GET',
    headers: {
      'x-correlation-id': options.correlationId,
      'x-tenant-id': options.tenantId,
    },
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

function createGraphqlHost(): ArgumentsHost {
  const request: MockRequest = {
    url: '/graphql',
    method: 'POST',
    headers: { 'x-correlation-id': 'gql-corr-1' },
  };

  return {
    getType: () => 'graphql',
    getArgs: () => [{}, {}, { req: request }, {}],
  } as ArgumentsHost;
}

describe('Farm GlobalExceptionFilter HTTP conformance', () => {
  const originalNodeEnv = process.env['NODE_ENV'];

  afterEach(() => {
    process.env['NODE_ENV'] = originalNodeEnv;
  });

  it('emits the canonical JSON envelope without top-level Nest fields', () => {
    process.env['NODE_ENV'] = 'development';
    const filter = new GlobalExceptionFilter();
    const { host, response } = createHttpHost({
      url: '/api/farms/farm-1',
      correlationId: 'corr-farm-1',
      tenantId: 'tenant-private',
    });

    filter.catch(new HttpException('Farm not found', HttpStatus.NOT_FOUND), host);

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.type).toHaveBeenCalledWith('application/json');
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'RESOURCE_NOT_FOUND',
        message: 'Farm not found',
        timestamp: expect.any(String),
        path: '/api/farms/farm-1',
        correlationId: 'corr-farm-1',
      },
    });

    const body = response.json.mock.calls[0]?.[0];
    expect(body).not.toHaveProperty('statusCode');
    expect(body).not.toHaveProperty('message');
    expect(body).not.toHaveProperty('tenantId');
    expect(body?.error).not.toHaveProperty('tenantId');
  });

  it('does not expose production details, secrets, tenant headers, or query tokens', () => {
    process.env['NODE_ENV'] = 'production';
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const filter = new GlobalExceptionFilter();
    const { host, response } = createHttpHost({
      url: '/api/farms?token=query-secret',
      tenantId: 'tenant-private',
    });

    filter.catch(
      new HttpException(
        {
          message: 'Tenant ID tenant-private used secret key farm-secret',
          details: { password: 'farm-secret' },
        },
        HttpStatus.BAD_REQUEST,
      ),
      host,
    );

    const body = response.json.mock.calls[0]?.[0];
    expect(body).toEqual({
      success: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Validation failed',
        timestamp: expect.any(String),
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/tenant-private|farm-secret|query-secret|password/i);
    expect(response.type).not.toHaveBeenCalledWith(expect.stringContaining('problem+json'));
    expect(JSON.stringify(warnSpy.mock.calls)).not.toMatch(
      /tenant-private|farm-secret|query-secret|password/i,
    );
    warnSpy.mockRestore();
  });

  it.each([
    [HttpStatus.METHOD_NOT_ALLOWED, 'HTTP_METHOD_NOT_ALLOWED'],
    [HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'HTTP_UNSUPPORTED_MEDIA_TYPE'],
  ])('keeps HTTP status %d aligned with canonical code %s', (status, code) => {
    process.env['NODE_ENV'] = 'development';
    const filter = new GlobalExceptionFilter();
    const { host, response } = createHttpHost();

    filter.catch(new HttpException('Rejected request', status), host);

    expect(response.status).toHaveBeenCalledWith(status);
    expect(response.json.mock.calls[0]?.[0].error.code).toBe(code);
  });

  it('preserves the existing GraphQL error contract', () => {
    process.env['NODE_ENV'] = 'development';
    const filter = new GlobalExceptionFilter();

    const result = filter.catch(
      new HttpException({ message: ['name should not be empty'] }, HttpStatus.BAD_REQUEST),
      createGraphqlHost(),
    ) as GraphQLError;

    expect(result).toBeInstanceOf(GraphQLError);
    expect(result.message).toBe('name should not be empty');
    expect(result.extensions).toEqual({
      code: 'BAD_REQUEST',
      statusCode: 400,
      validationErrors: ['name should not be empty'],
    });
  });
});
