import { HttpException, HttpStatus } from '@nestjs/common';

import { ApplicationException } from '../application-exception';
import { ERROR_CODES } from '../error-codes';
import {
  buildErrorEnvelope,
  errorCodeForHttpStatus,
  HTTP_STATUS_ERROR_CODES,
  JSON_ERROR_CONTENT_TYPE,
} from '../error-envelope';

const FIXED_TIMESTAMP = '2026-07-20T12:34:56.789Z';

describe('canonical HTTP error envelope', () => {
  it('has one stable registered code for every supported status', () => {
    expect(HTTP_STATUS_ERROR_CODES).toEqual({
      400: 'VALIDATION_FAILED',
      401: 'AUTH_TOKEN_INVALID',
      402: 'HTTP_PAYMENT_REQUIRED',
      403: 'AUTH_FORBIDDEN',
      404: 'RESOURCE_NOT_FOUND',
      405: 'HTTP_METHOD_NOT_ALLOWED',
      406: 'HTTP_NOT_ACCEPTABLE',
      408: 'HTTP_REQUEST_TIMEOUT',
      409: 'RESOURCE_CONFLICT',
      410: 'HTTP_RESOURCE_GONE',
      413: 'HTTP_PAYLOAD_TOO_LARGE',
      415: 'HTTP_UNSUPPORTED_MEDIA_TYPE',
      422: 'HTTP_UNPROCESSABLE_ENTITY',
      429: 'RATE_LIMIT_EXCEEDED',
      500: 'INTERNAL_SERVER_ERROR',
      501: 'HTTP_NOT_IMPLEMENTED',
      502: 'HTTP_BAD_GATEWAY',
      503: 'EXTERNAL_SERVICE_UNAVAILABLE',
      504: 'EXTERNAL_SERVICE_TIMEOUT',
    });
    expect(errorCodeForHttpStatus(418)).toBe('INTERNAL_SERVER_ERROR');
    for (const [status, code] of Object.entries(HTTP_STATUS_ERROR_CODES)) {
      expect(ERROR_CODES[code].status).toBe(Number(status));
    }
  });

  it('builds the exact nested contract and never puts status in the body', () => {
    const result = buildErrorEnvelope(new HttpException('Fish not found', HttpStatus.NOT_FOUND), {
      path: '/api/fish?access_token=must-not-leak',
      correlationId: 'corr-123',
      timestamp: FIXED_TIMESTAMP,
      isProduction: false,
    });

    expect(result).toEqual({
      statusCode: 404,
      body: {
        success: false,
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'Fish not found',
          timestamp: FIXED_TIMESTAMP,
          path: '/api/fish',
          correlationId: 'corr-123',
        },
      },
    });
    expect(result.body).not.toHaveProperty('statusCode');
    expect(result.body).not.toHaveProperty('message');
    expect(JSON_ERROR_CONTENT_TYPE).toBe('application/json');
    expect(JSON_ERROR_CONTENT_TYPE).not.toContain('problem+json');
  });

  it('retains registered ApplicationException codes and development details', () => {
    const result = buildErrorEnvelope(
      new ApplicationException(
        'RESOURCE_CONFLICT',
        { resource: 'farm', field: 'name' },
        'Farm already exists',
      ),
      { timestamp: FIXED_TIMESTAMP, isProduction: false },
    );

    expect(result.statusCode).toBe(409);
    expect(result.body.error).toEqual({
      code: 'RESOURCE_CONFLICT',
      message: 'Farm already exists',
      details: { resource: 'farm', field: 'name' },
      timestamp: FIXED_TIMESTAMP,
    });
  });

  it('normalizes class-validator arrays into field details', () => {
    const result = buildErrorEnvelope(
      new HttpException(
        {
          message: [
            'email must be an email',
            'email should not be empty',
            'name should not be empty',
          ],
        },
        HttpStatus.BAD_REQUEST,
      ),
      { timestamp: FIXED_TIMESTAMP, isProduction: false },
    );

    expect(result.body.error.details).toEqual({
      fields: {
        email: ['email must be an email', 'email should not be empty'],
        name: ['name should not be empty'],
      },
    });
  });

  it('redacts production client errors and omits tenant/secret details', () => {
    const result = buildErrorEnvelope(
      new HttpException(
        {
          message: 'Tenant ID tenant-456 has invalid API key super-secret',
          details: {
            tenantId: 'tenant-456',
            password: 'super-secret',
          },
        },
        HttpStatus.BAD_REQUEST,
      ),
      {
        path: '/api/farms?token=super-secret',
        timestamp: FIXED_TIMESTAMP,
        isProduction: true,
      },
    );

    expect(result.body).toEqual({
      success: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Validation failed',
        timestamp: FIXED_TIMESTAMP,
      },
    });
    expect(JSON.stringify(result.body)).not.toMatch(/tenant-456|super-secret|password|api key/i);
  });

  it.each([
    [HttpStatus.METHOD_NOT_ALLOWED, 'HTTP_METHOD_NOT_ALLOWED'],
    [HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'HTTP_UNSUPPORTED_MEDIA_TYPE'],
  ])('keeps status %d and registered code %s aligned', (status, code) => {
    const result = buildErrorEnvelope(new HttpException('unsafe provider detail', status), {
      timestamp: FIXED_TIMESTAMP,
      isProduction: true,
    });

    expect(result.statusCode).toBe(status);
    expect(result.body.error.code).toBe(code);
    expect(HTTP_STATUS_ERROR_CODES[status]).toBe(code);
  });

  it('normalizes an unregistered HttpException status to the registered 500 pair', () => {
    const result = buildErrorEnvelope(new HttpException('teapot secret', 418), {
      timestamp: FIXED_TIMESTAMP,
      isProduction: true,
    });

    expect(result).toEqual({
      statusCode: 500,
      body: {
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error occurred',
          timestamp: FIXED_TIMESTAMP,
        },
      },
    });
  });

  it('uses registry messages as the production allowlist and rejects unsafe correlation IDs', () => {
    const result = buildErrorEnvelope(
      new HttpException('alice@example.com https://object/signed?sig=secret', HttpStatus.NOT_FOUND),
      {
        path: '/users/alice@example.com?sig=secret',
        correlationId: 'alice@example.com',
        timestamp: FIXED_TIMESTAMP,
        isProduction: true,
      },
    );

    expect(result.body.error).toEqual({
      code: 'RESOURCE_NOT_FOUND',
      message: 'Resource not found',
      timestamp: FIXED_TIMESTAMP,
    });
  });

  it.each([
    [new Error('password=super-secret database=internal'), 500, 'INTERNAL_SERVER_ERROR'],
    [
      new HttpException(
        'upstream=http://private-provider token=super-secret',
        HttpStatus.SERVICE_UNAVAILABLE,
      ),
      503,
      'EXTERNAL_SERVICE_UNAVAILABLE',
    ],
  ])('never reflects production 5xx exception text', (exception, statusCode, code) => {
    const result = buildErrorEnvelope(exception, {
      timestamp: FIXED_TIMESTAMP,
      isProduction: true,
    });

    expect(result.statusCode).toBe(statusCode);
    expect(result.body.error.code).toBe(code);
    expect(result.body.error).not.toHaveProperty('details');
    expect(JSON.stringify(result.body)).not.toMatch(/super-secret|private-provider|database=/i);
  });

  it('keeps useful diagnostics only outside production', () => {
    const result = buildErrorEnvelope(new Error('provider exploded'), {
      timestamp: FIXED_TIMESTAMP,
      isProduction: false,
    });

    expect(result.body.error.message).toBe('provider exploded');
    const stack = result.body.error.details?.['stack'];
    expect(typeof stack).toBe('string');
    expect(stack).toContain('Error: provider exploded');
  });
});
