// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import { StructuredLoggerService } from '@aquaculture/backend-common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { InternalApiKeyGuard } from './guards/internal-api-key.guard';

// Default allowed origins for development environments
const DEFAULT_DEV_ORIGINS = 'http://localhost:3000,http://localhost:5173,http://localhost:4000,http://localhost:4001,http://localhost:4002';

async function bootstrap() {
  const logger = new Logger('EventStoreService');

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
      logger: new StructuredLoggerService('event-store-service'),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'fatal',
      service: 'event-store-service',
      message: `Module initialization failed: ${message}`,
      ...(stack ? { stack } : {}),
      context: 'Bootstrap',
    }));
    process.exit(1);
  }

  // Retrieve ConfigService for environment-aware configuration
  const configService = app.get(ConfigService);
  const isProduction = configService.get<string>('NODE_ENV') === 'production';

  // Trust proxy configuration for deployments behind reverse proxy
  // SECURITY: Only enable this when behind a trusted proxy
  const trustProxy = configService.get<string>('TRUST_PROXY', 'false');
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
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", 'data:', 'https:'],
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
      noSniff: true,
      frameguard: { action: 'deny' },
      hidePoweredBy: true,
      xssFilter: true,
    }),
  );

  // CORS configuration
  // SECURITY: Never use wildcard '*' - always use explicit origin allowlist
  const corsOriginsEnv = configService.get<string>('CORS_ORIGINS');

  // Use environment variable if set, otherwise use safe defaults for development
  const corsOrigins = corsOriginsEnv || (isProduction ? '' : DEFAULT_DEV_ORIGINS);

  // SECURITY: Reject wildcard configuration
  if (corsOrigins === '*') {
    throw new Error('CORS_ORIGINS cannot be "*". Configure an explicit allowlist of allowed origins.');
  }

  // SECURITY: Require explicit CORS_ORIGINS in production
  if (isProduction && !corsOriginsEnv) {
    throw new Error('CORS_ORIGINS environment variable must be set in production.');
  }

  // Parse comma-separated origins into an array
  const parsedOrigins: string[] = corsOrigins
    .split(',')
    .map((origin: string) => origin.trim())
    .filter((origin: string) => origin.length > 0);

  if (parsedOrigins.length === 0) {
    throw new Error('CORS_ORIGINS must contain at least one valid origin.');
  }

  const corsOptions: CorsOptions = {
    origin: parsedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Tenant-Id',
      'X-Correlation-Id',
      'X-Request-Id',
      'X-Internal-Api-Key',
    ],
    credentials: true,
    maxAge: 86400, // 24 hours - cache preflight requests
  };

  app.enableCors(corsOptions);

  logger.log(`CORS enabled for origins: ${parsedOrigins.join(', ')}`);

  // Global validation pipe with security settings
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        /** SEC-M12: Disable implicit type conversion to prevent type confusion attacks.
         *  Explicit @Type() decorators must be used on DTOs that need transformation. */
        enableImplicitConversion: false,
      },
      // SECURITY: Hide internal details from validation errors
      validationError: {
        target: false,
        value: false,
      },
      disableErrorMessages: isProduction,
    }),
  );

  // Global internal API key guard for service-to-service authentication
  app.useGlobalGuards(new InternalApiKeyGuard());

  // API prefix for event store endpoints
  app.setGlobalPrefix('api/v1');

  // Enable graceful shutdown hooks
  app.enableShutdownHooks();

  // PORT RESOLUTION: Read service-specific env var first, then generic PORT,
  // then default 3000 to match the Docker healthcheck convention.
  // Uses nullish coalescing (??) to only fall through on null/undefined,
  // not on falsy values like 0.
  const port = configService.get<number>('EVENT_STORE_SERVICE_PORT')
    ?? configService.get<number>('PORT')
    ?? 3000;

  await app.listen(port);

  logger.log(`Event Store Service running on port ${port}`);
  logger.log(`Environment: ${isProduction ? 'production' : 'development'}`);
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
    service: 'event-store-service',
    message: `Bootstrap failed: ${message}`,
    ...(stack ? { stack } : {}),
    context: 'Bootstrap',
  }));
  process.exit(1);
});
