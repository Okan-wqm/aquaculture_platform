// WHY: MUST be first import. tslib.__metadata() silently no-ops if Reflect.metadata
// is not yet a function. In Docker production (Alpine, --omit=dev), the leaner module
// graph can cause @nestjs/common to be mid-evaluation when decorated classes load,
// meaning reflect-metadata hasn't executed yet. This guarantees it loads first.
import 'reflect-metadata';
import { ValidationPipe, Logger, VersioningType, VERSION_NEUTRAL } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { StructuredLoggerService } from '@aquaculture/backend-common';
import helmet from 'helmet';

import { AppModule } from './app.module';

async function bootstrap() {
  const structuredLogger = new StructuredLoggerService('admin-api-service');
  const logger = new Logger('AdminApiService');

  /**
   * ARCH-032: Wrap NestFactory.create() to surface readable errors.
   *
   * NestJS ExceptionHandler serializes Error objects via JSON.stringify, which
   * produces '{}' because Error properties (message, stack) are non-enumerable.
   * By catching here, we log the actual error message BEFORE NestJS can swallow it,
   * ensuring container logs always show what went wrong during module initialization.
   */
  let app;
  try {
    app = await NestFactory.create(AppModule, {
      logger: structuredLogger,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'fatal',
      service: 'admin-api-service',
      message: `Module initialization failed: ${message}`,
      ...(stack ? { stack } : {}),
      context: 'Bootstrap',
    }));
    process.exit(1);
  }

  const configService = app.get(ConfigService);
  const isProduction = process.env['NODE_ENV'] === 'production';

  // Trust proxy configuration for deployments behind reverse proxy
  // SECURITY: Only enable this when behind a trusted proxy
  const trustProxy = process.env['TRUST_PROXY'] || 'false';
  if (trustProxy === 'true' || trustProxy === '1') {
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
    logger.log('Trust proxy enabled (trusting first proxy)');
  } else if (trustProxy && trustProxy !== 'false' && trustProxy !== '0') {
    app.getHttpAdapter().getInstance().set('trust proxy', trustProxy);
    logger.log(`Trust proxy configured: ${trustProxy}`);
  }

  // Security middleware with production-appropriate settings
  app.use(
    helmet({
      contentSecurityPolicy: isProduction
        ? {
            directives: {
              defaultSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:', 'https:'],
              scriptSrc: ["'self'"],
              fontSrc: ["'self'"],
              connectSrc: ["'self'"],
              objectSrc: ["'none'"],
              frameSrc: ["'none'"],
            },
          }
        : false,
      strictTransportSecurity: isProduction
        ? { maxAge: 31536000, includeSubDomains: true, preload: true }
        : false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      crossOriginEmbedderPolicy: false,
      noSniff: true,
      frameguard: { action: 'deny' },
      hidePoweredBy: true,
      xssFilter: true,
    }),
  );

  // CORS configuration for admin dashboard
  // SECURITY: In production, ADMIN_CORS_ORIGINS must be explicitly set
  const corsOriginsEnv = process.env['ADMIN_CORS_ORIGINS'];
  const defaultDevOrigins = ['http://localhost:4200', 'http://localhost:3000'];

  if (!corsOriginsEnv && isProduction) {
    throw new Error('ADMIN_CORS_ORIGINS must be set in production. Configure an explicit allowlist.');
  }

  const corsOrigins = corsOriginsEnv
    ? corsOriginsEnv.split(',').map(o => o.trim()).filter(Boolean)
    : defaultDevOrigins;

  app.enableCors({
    origin: corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Tenant-ID',
      'X-Correlation-Id',
      'X-Request-ID',
      'X-Impersonate-User',
    ],
    credentials: true,
    maxAge: 3600,
  });

  // Global validation pipe with strict settings
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: false,
      },
      validationError: {
        target: false,
        value: false,
      },
      stopAtFirstError: false,
      // SECURITY: Disable detailed error messages in production
      disableErrorMessages: isProduction,
    }),
  );

  // API Versioning — URI-based (e.g., /v1/tenants)
  // defaultVersion includes VERSION_NEUTRAL so existing unversioned routes
  // continue to work at their current paths (backwards-compatible).
  // New or updated endpoints can use @Version('2') for future breaking changes.
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: ['1', VERSION_NEUTRAL],
  });

  // Enable graceful shutdown hooks
  app.enableShutdownHooks();

  const port = process.env['PORT'] || 3000;

  /**
   * SEC-L14: Swagger UI is strictly disabled in production.
   *
   * API documentation exposure in production reveals endpoint structure, request/response
   * schemas, and authentication requirements — valuable reconnaissance for attackers.
   * The previous ENABLE_SWAGGER env var override is removed; only NODE_ENV controls this.
   */
  if (!isProduction) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Aquaculture Admin API')
      .setDescription('Platform administration API for the Aquaculture SaaS platform')
      .setVersion('1.0.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        'JWT',
      )
      .addServer('/', 'Direct (dev)')
      .addServer('/api', 'Via nginx gateway')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
        tagsSorter: 'alpha',
        operationsSorter: 'alpha',
      },
    });
    logger.log(`Swagger docs available at http://localhost:${port}/docs`);
  }

  await app.listen(port);

  logger.log(`Admin API Service running on port ${port}`);
  logger.log(`Environment: ${process.env['NODE_ENV'] || 'development'}`);
  logger.log(`Health check: http://localhost:${port}/v1/health`);
  logger.log(`Health check (unversioned): http://localhost:${port}/health`);
}

/**
 * ARCH-032: Surface the actual error on bootstrap failure.
 * NestJS Logger serializes Error objects as '{}' via JSON.stringify because
 * Error properties (message, stack) are non-enumerable. Structured JSON
 * ensures the real error is always visible in container logs.
 */
bootstrap().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'fatal',
    service: 'admin-api-service',
    message: `Bootstrap failed: ${message}`,
    ...(stack ? { stack } : {}),
    context: 'Bootstrap',
  }));
  process.exit(1);
});
