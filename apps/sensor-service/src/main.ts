import { BadRequestException, Logger, ValidationPipe } from '@nestjs/common';
import { ValidationError } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { initTelemetry, StructuredLoggerService } from '@aquaculture/backend-common';
import helmet from 'helmet';

import { AppModule } from './app.module';

// Initialize OpenTelemetry tracing BEFORE NestFactory.create()
// Only active when ENABLE_TRACING=true environment variable is set.
initTelemetry('sensor-service');

async function bootstrap(): Promise<void> {
  const logger = new Logger('SensorService');

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
      logger: new StructuredLoggerService('sensor-service'),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'fatal',
      service: 'sensor-service',
      message: `Module initialization failed: ${message}`,
      ...(stack ? { stack } : {}),
      context: 'Bootstrap',
    }));
    process.exit(1);
  }

  const configService = app.get(ConfigService);
  const isProduction = configService.get('NODE_ENV') === 'production';

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
  // SECURITY: credentials cannot be true when origin is '*' (wildcard)
  const corsOrigins = configService.get<string>('CORS_ORIGINS') ?? '*';
  const isWildcard = corsOrigins === '*';

  // SECURITY: Throw error in production if wildcard CORS is configured
  if (isWildcard && isProduction) {
    throw new Error('CORS_ORIGINS cannot be "*" in production. Configure an explicit allowlist.');
  }

  const parsedOrigins = isWildcard ? '*' : corsOrigins.split(',').map((o: string) => o.trim()).filter(Boolean);

  app.enableCors({
    origin: parsedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Tenant-Id',
      'X-Correlation-Id',
      'X-Request-Id',
    ],
    // SECURITY: credentials must be false when using wildcard origin
    credentials: !isWildcard,
  });

  // Global validation pipe with security settings
  // Custom exceptionFactory replaces disableErrorMessages so that:
  //   - validation details are always logged server-side (observability)
  //   - client receives sanitized "Bad Request" in production (security)
  const validationLogger = new Logger('ValidationPipe');

  const flattenErrors = (errors: ValidationError[], parent = ''): string[] => {
    const messages: string[] = [];
    for (const err of errors) {
      const prop = parent ? `${parent}.${err.property}` : err.property;
      if (err.constraints) {
        messages.push(...Object.values(err.constraints).map((c) => `${prop}: ${c}`));
      }
      if (err.children?.length) {
        messages.push(...flattenErrors(err.children, prop));
      }
    }
    return messages;
  };

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
      // Custom factory: always log details server-side, hide from client in production
      exceptionFactory: (errors: ValidationError[]) => {
        const details = flattenErrors(errors);
        validationLogger.warn(
          `Validation failed: ${details.join(' | ')}`,
        );
        if (isProduction) {
          return new BadRequestException('Bad Request');
        }
        return new BadRequestException(details);
      },
    }),
  );

  // Graceful shutdown
  app.enableShutdownHooks();

  // PORT RESOLUTION: Service-specific var first, then generic PORT, then default 3000.
  // Prevents healthcheck failures from port mismatch when Docker only sets PORT.
  const port = configService.get<number>('SENSOR_SERVICE_PORT')
    ?? configService.get<number>('PORT')
    ?? 3000;

  await app.listen(port);

  logger.log(`Sensor Service running on port ${port}`);
  logger.log(`GraphQL playground: http://localhost:${port}/graphql`);
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
    service: 'sensor-service',
    message: `Bootstrap failed: ${message}`,
    ...(stack ? { stack } : {}),
    context: 'Bootstrap',
  }));
  process.exit(1);
});
