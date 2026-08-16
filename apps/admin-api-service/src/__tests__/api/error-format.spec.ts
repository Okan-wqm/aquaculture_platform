import {
  INestApplication,
  Controller,
  Get,
  Post,
  Body,
  Param,
  HttpStatus,
  HttpException,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  ValidationPipe,
} from '@nestjs/common';
import { StructuredLoggerService } from '@aquaculture/backend-common/logging';
import { APP_FILTER } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Test, TestingModule } from '@nestjs/testing';
import { IsString, IsNotEmpty, IsInt, Min } from 'class-validator';
import { type Observable, throwError } from 'rxjs';
import request from 'supertest';
import { QueryFailedError } from 'typeorm';

import { Public } from '@aquaculture/backend-common/decorators';
import { GlobalExceptionFilter } from '../../filters/global-exception.filter';

class ValidatedDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsInt()
  @Min(1)
  count!: number;
}

/**
 * Controller that throws various error types so we can verify
 * the global exception filter returns a consistent error shape.
 */
@Controller('error-test')
class ErrorTestController {
  @Get('ok')
  @Public()
  ok() {
    return { status: 'ok' };
  }

  @Get('bad-request')
  @Public()
  badRequest() {
    throw new BadRequestException('Invalid input provided');
  }

  @Get('not-found')
  @Public()
  notFound() {
    throw new NotFoundException('Resource not found');
  }

  @Get('forbidden')
  @Public()
  forbidden() {
    throw new ForbiddenException('Access denied');
  }

  @Get('conflict')
  @Public()
  conflict() {
    throw new ConflictException('Duplicate resource');
  }

  @Get('internal')
  @Public()
  internal() {
    throw new InternalServerErrorException('Something went wrong');
  }

  @Get('generic-error')
  @Public()
  genericError() {
    throw new Error('SECRET_GENERIC_FAILURE_SENTINEL');
  }

  @Get('query-error')
  @Public()
  queryError() {
    const driverError = new Error('SECRET_DRIVER_SENTINEL');
    Object.defineProperty(driverError, 'code', { value: '23505' });
    throw new QueryFailedError('INSERT SECRET_SQL_SENTINEL', [], driverError);
  }

  @Get('unknown-error')
  @Public()
  unknownError(): Observable<never> {
    return throwError(() => ({ unexpected: true }));
  }

  @Get('custom-http')
  @Public()
  customHttp() {
    throw new HttpException(
      { message: 'SECRET_HTTP_SENTINEL', details: { field: 'SECRET_DETAIL_SENTINEL' } },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  @Get('unsupported-status')
  @Public()
  unsupportedStatus() {
    throw new HttpException('SECRET_TEAPOT_SENTINEL', HttpStatus.I_AM_A_TEAPOT);
  }

  @Post('validate')
  @Public()
  validate(@Body() dto: ValidatedDto) {
    return dto;
  }
}

/**
 * Validates that the GlobalExceptionFilter produces a consistent
 * error response shape for all HTTP status codes.
 */
describe('Error Response Format Consistency', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [ErrorTestController],
      providers: [
        {
          provide: APP_FILTER,
          useClass: GlobalExceptionFilter,
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
        stopAtFirstError: false,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Helper: asserts that every error response contains the expected
   * standard fields: statusCode, message, error, timestamp, path.
   */
  function expectStandardErrorShape(body: Record<string, unknown>, expectedStatus: number) {
    expect(body).toEqual({
      contractVersion: 'admin-http-error.v1',
      success: false,
      error: expect.any(Object),
    });
    const error = body['error'] as Record<string, unknown>;
    expect(error).toHaveProperty('status', expectedStatus);
    expect(typeof error['message']).toBe('string');
    expect(typeof error['code']).toBe('string');
    expect(typeof error['timestamp']).toBe('string');
    // Timestamp should be ISO 8601
    expect(new Date(error['timestamp'] as string).toISOString()).toBe(error['timestamp']);
    expect(typeof error['path']).toBe('string');
    expect(error['path']).not.toContain('?');
    expect(typeof error['requestId']).toBe('string');
  }

  describe('Standard HTTP exception responses', () => {
    it('should return standard shape for 400 Bad Request', async () => {
      const response = await request(app.getHttpServer()).get(
        '/error-test/bad-request?token=must-not-echo',
      );

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expectStandardErrorShape(response.body, 400);
      expect(response.body.error.code).toBe('BAD_REQUEST');
      expect(JSON.stringify(response.body)).not.toContain('must-not-echo');
    });

    it('should return standard shape for 404 Not Found', async () => {
      const response = await request(app.getHttpServer()).get('/error-test/not-found');

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
      expectStandardErrorShape(response.body, 404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    it('should return standard shape for 403 Forbidden', async () => {
      const response = await request(app.getHttpServer()).get('/error-test/forbidden');

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
      expectStandardErrorShape(response.body, 403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    });

    it('should return standard shape for 409 Conflict', async () => {
      const response = await request(app.getHttpServer()).get('/error-test/conflict');

      expect(response.status).toBe(HttpStatus.CONFLICT);
      expectStandardErrorShape(response.body, 409);
      expect(response.body.error.code).toBe('CONFLICT');
    });

    it('should return standard shape for 500 Internal Server Error', async () => {
      const response = await request(app.getHttpServer()).get('/error-test/internal');

      expect(response.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expectStandardErrorShape(response.body, 500);
      expect(response.body.error.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('Non-HTTP exceptions (generic Error)', () => {
    it('should return 500 with standard shape for unhandled Error', async () => {
      const logger = jest.spyOn(StructuredLoggerService.prototype, 'error').mockImplementation();
      const response = await request(app.getHttpServer()).get('/error-test/generic-error');

      expect(response.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expectStandardErrorShape(response.body, 500);
      expect(response.body.error.code).toBe('INTERNAL_ERROR');
      expect(response.body.error.message).toBe('An unexpected error occurred');
      expect(JSON.stringify(response.body)).not.toContain('SECRET_GENERIC_FAILURE_SENTINEL');
      expect(JSON.stringify(logger.mock.calls)).not.toContain('SECRET_GENERIC_FAILURE_SENTINEL');
      logger.mockRestore();
    });

    it('maps QueryFailedError without exposing driver detail', async () => {
      const logger = jest.spyOn(StructuredLoggerService.prototype, 'warn').mockImplementation();
      const response = await request(app.getHttpServer()).get('/error-test/query-error');
      expect(response.status).toBe(HttpStatus.CONFLICT);
      expectStandardErrorShape(response.body, 409);
      expect(response.body.error).toMatchObject({
        code: 'DATABASE_CONFLICT',
        message: 'Resource already exists',
      });
      expect(JSON.stringify(response.body)).not.toContain('SECRET_DRIVER_SENTINEL');
      expect(JSON.stringify(response.body)).not.toContain('SECRET_SQL_SENTINEL');
      expect(JSON.stringify(logger.mock.calls)).not.toContain('SECRET_DRIVER_SENTINEL');
      expect(JSON.stringify(logger.mock.calls)).not.toContain('SECRET_SQL_SENTINEL');
      logger.mockRestore();
    });

    it('normalizes a non-Error throw into the versioned envelope', async () => {
      const response = await request(app.getHttpServer()).get('/error-test/unknown-error');
      expect(response.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expectStandardErrorShape(response.body, 500);
      expect(response.body.error.code).toBe('INTERNAL_ERROR');
    });
  });

  describe('Closed HTTP exception projection', () => {
    it('drops arbitrary details and messages that have no code-owned decoder', async () => {
      const logger = jest.spyOn(StructuredLoggerService.prototype, 'warn').mockImplementation();
      const response = await request(app.getHttpServer()).get('/error-test/custom-http');

      expect(response.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expectStandardErrorShape(response.body, 422);
      expect(response.body.error).not.toHaveProperty('details');
      expect(JSON.stringify(response.body)).not.toContain('SECRET_HTTP_SENTINEL');
      expect(JSON.stringify(response.body)).not.toContain('SECRET_DETAIL_SENTINEL');
      expect(JSON.stringify(logger.mock.calls)).not.toContain('SECRET_HTTP_SENTINEL');
      logger.mockRestore();
    });

    it('normalizes an unsupported status into a coherent internal error', async () => {
      const response = await request(app.getHttpServer()).get('/error-test/unsupported-status');

      expect(response.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expectStandardErrorShape(response.body, 500);
      expect(response.body.error).toMatchObject({
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      });
      expect(JSON.stringify(response.body)).not.toContain('SECRET_TEAPOT_SENTINEL');
    });
  });

  describe('Request ID forwarding', () => {
    it('should include requestId when x-request-id header is sent', async () => {
      const requestId = 'test-req-id-12345';
      const response = await request(app.getHttpServer())
        .get('/error-test/bad-request')
        .set('x-request-id', requestId);

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body.error.requestId).toBe(requestId);
    });

    it('should generate requestId when no x-request-id header exists', async () => {
      const response = await request(app.getHttpServer()).get('/error-test/bad-request');

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.headers['x-request-id']).toBe(response.body.error.requestId);
    });
  });

  describe('404 for non-existent routes', () => {
    it('should return 404 for a completely unknown path', async () => {
      const response = await request(app.getHttpServer()).get('/this-route-does-not-exist');

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('Validation pipe error format', () => {
    it('should return 400 for invalid body with standard error shape', async () => {
      const response = await request(app.getHttpServer())
        .post('/error-test/validate')
        .send({ name: '', count: -1 });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      // The ValidationPipe throws HttpException which our filter catches
      expectStandardErrorShape(response.body, 400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(response.body.error.details.validationMessages).toHaveLength(2);
    });

    it('should return 400 when required fields are missing', async () => {
      const response = await request(app.getHttpServer()).post('/error-test/validate').send({});

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body.error.status).toBe(400);
    });

    it('should return 400 for non-whitelisted properties', async () => {
      const response = await request(app.getHttpServer())
        .post('/error-test/validate')
        .send({ name: 'valid', count: 5, extraField: 'not allowed' });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });
  });

  describe('Error name mapping', () => {
    const errorNameCases: [number, string][] = [
      [400, 'BAD_REQUEST'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
      [409, 'CONFLICT'],
      [422, 'UNPROCESSABLE_ENTITY'],
      [500, 'INTERNAL_ERROR'],
    ];

    it.each(errorNameCases)(
      'status %i should map to error name "%s"',
      async (expectedStatus, expectedName) => {
        // We already tested each individually; this ensures the mapping table is consistent
        const routeMap: Record<number, string> = {
          400: '/error-test/bad-request',
          403: '/error-test/forbidden',
          404: '/error-test/not-found',
          409: '/error-test/conflict',
          422: '/error-test/custom-http',
          500: '/error-test/internal',
        };

        const route = routeMap[expectedStatus]!;
        const response = await request(app.getHttpServer()).get(route);

        expect(response.status).toBe(expectedStatus);
        expect(response.body.error.code).toBe(expectedName);
      },
    );
  });
});

describe('GlobalExceptionFilter transport boundary', () => {
  it('rethrows the identical failure without entering HTTP context for RPC hosts', () => {
    const host = new ExecutionContextHost([]);
    host.setType('rpc');
    const switchToHttp = jest.spyOn(host, 'switchToHttp');
    const failure = new Error('rpc failure');

    let observed: unknown;
    try {
      new GlobalExceptionFilter().catch(failure, host);
    } catch (error) {
      observed = error;
    }

    expect(observed).toBe(failure);
    expect(switchToHttp).not.toHaveBeenCalled();
  });
});
