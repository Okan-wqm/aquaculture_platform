import { ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ErrorResponse } from '@platform/shared';

import {
  createHttpException,
  createValidationException,
  HttpExceptionFilter,
} from '../http-exception.filter';

interface MockResponse {
  status: jest.Mock<MockResponse, [number]>;
  type: jest.Mock<MockResponse, [string]>;
  json: jest.Mock<MockResponse, [ErrorResponse]>;
  setHeader: jest.Mock<MockResponse, [string, string]>;
}

function createHttpHost(
  options: { url?: string; correlationId?: string; requestId?: string } = {},
): { host: ArgumentsHost; response: MockResponse } {
  const response: MockResponse = {
    status: jest.fn().mockReturnThis() as jest.Mock<MockResponse, [number]>,
    type: jest.fn().mockReturnThis() as jest.Mock<MockResponse, [string]>,
    json: jest.fn().mockReturnThis() as jest.Mock<MockResponse, [ErrorResponse]>,
    setHeader: jest.fn().mockReturnThis() as jest.Mock<MockResponse, [string, string]>,
  };
  const request = {
    url: options.url ?? '/api/test',
    originalUrl: options.url ?? '/api/test',
    method: 'GET',
    headers: {
      'x-correlation-id': options.correlationId,
      'x-request-id': options.requestId,
    },
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

describe('HttpExceptionFilter', () => {
  const originalNodeEnv = process.env['NODE_ENV'];

  afterEach(() => {
    process.env['NODE_ENV'] = originalNodeEnv;
    jest.restoreAllMocks();
  });

  it('delegates HTTP mapping to the exact shared JSON envelope', () => {
    process.env['NODE_ENV'] = 'development';
    const filter = new HttpExceptionFilter();
    const { host, response } = createHttpHost({
      url: '/api/farms/farm-1?token=private',
      correlationId: 'corr-http-1',
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
        correlationId: 'corr-http-1',
      },
    });
  });

  it('falls back to a valid request ID and rejects unsafe correlation IDs', () => {
    process.env['NODE_ENV'] = 'development';
    const filter = new HttpExceptionFilter();
    const { host, response } = createHttpHost({
      correlationId: 'alice@example.com',
      requestId: 'request-123',
    });

    filter.catch(new HttpException('Invalid', HttpStatus.BAD_REQUEST), host);

    expect(response.json.mock.calls[0]?.[0].error).not.toHaveProperty('correlationId');
  });

  it('preserves safe transport headers without changing the body contract', () => {
    process.env['NODE_ENV'] = 'development';
    const filter = new HttpExceptionFilter();
    const rateLimited = createHttpHost();
    const unauthorized = createHttpHost();
    const methodNotAllowed = createHttpHost();

    filter.catch(
      new HttpException({ message: 'Slow down', retryAfter: 120 }, HttpStatus.TOO_MANY_REQUESTS),
      rateLimited.host,
    );
    filter.catch(new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED), unauthorized.host);
    filter.catch(
      new HttpException(
        { message: 'Method not allowed', allowedMethods: ['GET', 'POST'] },
        HttpStatus.METHOD_NOT_ALLOWED,
      ),
      methodNotAllowed.host,
    );

    expect(rateLimited.response.setHeader).toHaveBeenCalledWith('Retry-After', '120');
    expect(unauthorized.response.setHeader).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer');
    expect(methodNotAllowed.response.setHeader).toHaveBeenCalledWith('Allow', 'GET, POST');
    expect(methodNotAllowed.response.json.mock.calls[0]?.[0].error.code).toBe(
      'HTTP_METHOD_NOT_ALLOWED',
    );
  });

  it('uses only registered production copy in responses and logs', () => {
    process.env['NODE_ENV'] = 'production';
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const filter = new HttpExceptionFilter();
    const { host, response } = createHttpHost({
      url: '/api/users/alice@example.com?signature=private',
      correlationId: 'alice@example.com',
    });

    filter.catch(
      new HttpException(
        {
          message: 'alice@example.com signed=https://storage/private',
          details: { token: 'private' },
        },
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      ),
      host,
    );

    expect(response.json.mock.calls[0]?.[0].error).toEqual({
      code: 'HTTP_UNSUPPORTED_MEDIA_TYPE',
      message: 'The request media type is not supported',
      timestamp: expect.any(String),
    });
    expect(JSON.stringify(response.json.mock.calls)).not.toMatch(
      /alice@example\.com|signed|storage|private|token/i,
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toMatch(
      /alice@example\.com|signed|storage|private|token/i,
    );
  });

  it('rethrows GraphQL exceptions for Apollo without remapping them', () => {
    const filter = new HttpExceptionFilter();
    const exception = new HttpException('GraphQL rejected', HttpStatus.FORBIDDEN);
    const host = { getType: () => 'graphql' } as ArgumentsHost;

    expect(() => filter.catch(exception, host)).toThrow(exception);
  });

  it('keeps exception helpers typed while their filter output stays canonical', () => {
    const httpException = createHttpException(HttpStatus.CONFLICT, 'Farm exists', {
      field: 'name',
    });
    const validationException = createValidationException([
      { field: 'name', message: 'is required', code: 'VALIDATION_ERROR' },
    ]);

    expect(httpException.getStatus()).toBe(409);
    expect(validationException.getStatus()).toBe(422);
  });
});
