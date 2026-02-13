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
import { APP_FILTER } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { IsString, IsNotEmpty, IsInt, Min } from 'class-validator';
import request from 'supertest';

import { Public } from '../../decorators/public.decorator';
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
    throw new Error('Unexpected failure');
  }

  @Get('custom-http')
  @Public()
  customHttp() {
    throw new HttpException(
      { message: 'Custom error', details: { field: 'value' } },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
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
  function expectStandardErrorShape(
    body: Record<string, unknown>,
    expectedStatus: number,
  ) {
    expect(body).toHaveProperty('statusCode', expectedStatus);
    expect(body).toHaveProperty('message');
    expect(typeof body.message).toBe('string');
    expect(body).toHaveProperty('error');
    expect(typeof body.error).toBe('string');
    expect(body).toHaveProperty('timestamp');
    expect(typeof body.timestamp).toBe('string');
    // Timestamp should be ISO 8601
    expect(new Date(body.timestamp as string).toISOString()).toBe(body.timestamp);
    expect(body).toHaveProperty('path');
    expect(typeof body.path).toBe('string');
  }

  describe('Standard HTTP exception responses', () => {
    it('should return standard shape for 400 Bad Request', async () => {
      const response = await request(app.getHttpServer())
        .get('/error-test/bad-request');

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expectStandardErrorShape(response.body, 400);
      expect(response.body.error).toBe('Bad Request');
    });

    it('should return standard shape for 404 Not Found', async () => {
      const response = await request(app.getHttpServer())
        .get('/error-test/not-found');

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
      expectStandardErrorShape(response.body, 404);
      expect(response.body.error).toBe('Not Found');
    });

    it('should return standard shape for 403 Forbidden', async () => {
      const response = await request(app.getHttpServer())
        .get('/error-test/forbidden');

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
      expectStandardErrorShape(response.body, 403);
      expect(response.body.error).toBe('Forbidden');
    });

    it('should return standard shape for 409 Conflict', async () => {
      const response = await request(app.getHttpServer())
        .get('/error-test/conflict');

      expect(response.status).toBe(HttpStatus.CONFLICT);
      expectStandardErrorShape(response.body, 409);
      expect(response.body.error).toBe('Conflict');
    });

    it('should return standard shape for 500 Internal Server Error', async () => {
      const response = await request(app.getHttpServer())
        .get('/error-test/internal');

      expect(response.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expectStandardErrorShape(response.body, 500);
      expect(response.body.error).toBe('Internal Server Error');
    });
  });

  describe('Non-HTTP exceptions (generic Error)', () => {
    it('should return 500 with standard shape for unhandled Error', async () => {
      const response = await request(app.getHttpServer())
        .get('/error-test/generic-error');

      expect(response.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expectStandardErrorShape(response.body, 500);
      expect(response.body.error).toBe('Internal Server Error');
    });
  });

  describe('Custom HTTP exception with details', () => {
    it('should include details field when provided', async () => {
      const response = await request(app.getHttpServer())
        .get('/error-test/custom-http');

      expect(response.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expectStandardErrorShape(response.body, 422);
      expect(response.body.details).toEqual({ field: 'value' });
    });
  });

  describe('Request ID forwarding', () => {
    it('should include requestId when x-request-id header is sent', async () => {
      const requestId = 'test-req-id-12345';
      const response = await request(app.getHttpServer())
        .get('/error-test/bad-request')
        .set('x-request-id', requestId);

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body.requestId).toBe(requestId);
    });

    it('should omit requestId when no x-request-id header', async () => {
      const response = await request(app.getHttpServer())
        .get('/error-test/bad-request');

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      // requestId should be undefined (not present) or explicitly undefined
      expect(response.body.requestId).toBeUndefined();
    });
  });

  describe('404 for non-existent routes', () => {
    it('should return 404 for a completely unknown path', async () => {
      const response = await request(app.getHttpServer())
        .get('/this-route-does-not-exist');

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
      expect(response.body).toHaveProperty('statusCode', 400);
      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('path');
    });

    it('should return 400 when required fields are missing', async () => {
      const response = await request(app.getHttpServer())
        .post('/error-test/validate')
        .send({});

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body.statusCode).toBe(400);
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
      [400, 'Bad Request'],
      [403, 'Forbidden'],
      [404, 'Not Found'],
      [409, 'Conflict'],
      [422, 'Unprocessable Entity'],
      [500, 'Internal Server Error'],
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
        const response = await request(app.getHttpServer())
          .get(route);

        expect(response.status).toBe(expectedStatus);
        expect(response.body.error).toBe(expectedName);
      },
    );
  });
});
