import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { initTelemetry, StructuredLoggerService } from '@aquaculture/backend-common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { HTTP_SECURITY } from './constants/auth.constants';

// Initialize OpenTelemetry tracing BEFORE NestFactory.create()
// Only active when ENABLE_TRACING=true environment variable is set.
initTelemetry('auth-service');

async function bootstrap(): Promise<void> {
  const logger = new Logger('AuthService');

  /**
   * ARCH-032: Wrap NestFactory.create() to surface readable errors.
   *
   * NestJS ExceptionHandler serializes Error objects via JSON.stringify, which
   * produces '{}' because Error properties (message, stack) are non-enumerable.
   * By catching here, we log the actual error message BEFORE NestJS can swallow it,
   * ensuring container logs always show what went wrong during module initialization.
   */
  let app: NestExpressApplication;
  try {
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      logger: new StructuredLoggerService('auth-service'),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'fatal',
      service: 'auth-service',
      message: `Module initialization failed: ${message}`,
      ...(stack ? { stack } : {}),
      context: 'Bootstrap',
    }));
    process.exit(1);
  }

  const configService = app.get(ConfigService);

  // Trust proxy configuration for deployments behind reverse proxy (nginx, cloudflare, etc)
  const trustProxy = configService.get<string>('TRUST_PROXY', 'false');
  if (trustProxy === 'true' || trustProxy === '1') {
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
    logger.log('Trust proxy enabled (trusting first proxy)');
  } else if (trustProxy && trustProxy !== 'false' && trustProxy !== '0') {
    app.getHttpAdapter().getInstance().set('trust proxy', trustProxy);
    logger.log(`Trust proxy configured: ${trustProxy}`);
  }

  // SECURITY: cookie-parser required for httpOnly refresh token cookies
  app.use(cookieParser());

  const isProduction = process.env['NODE_ENV'] === 'production';

  // Security middleware with production-appropriate settings
  app.use(
    helmet({
      // CSP is handled by the edge nginx (droplet.conf / nginx.prod.conf).
      // Auth-service sits behind gateway behind nginx — no need for its own CSP.
      contentSecurityPolicy: false,
      strictTransportSecurity: isProduction
        ? { maxAge: HTTP_SECURITY.HSTS_MAX_AGE, includeSubDomains: true, preload: true }
        : false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      noSniff: true,
      frameguard: { action: 'deny' },
      hidePoweredBy: true,
      xssFilter: true,
    }),
  );

  // Global validation pipe with security settings
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
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

  // CORS configuration
  // SECURITY: Wildcard origin with credentials is dangerous
  // In production, CORS_ORIGINS must be set to explicit list of allowed origins
  const corsOrigins = configService.get<string>('CORS_ORIGINS', '*');

  if (isProduction && corsOrigins === '*') {
    throw new Error(
      'SECURITY ERROR: CORS_ORIGINS cannot be set to wildcard ("*") in production. ' +
      'Set CORS_ORIGINS to explicit allowed origins.',
    );
  }

  app.enableCors({
    origin: corsOrigins === '*'
      ? (isProduction ? false : '*')  // Disable CORS wildcard in production
      : corsOrigins.split(',').map(o => o.trim()),
    credentials: corsOrigins !== '*',  // Only allow credentials with explicit origins
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Tenant-Id',
      'X-Correlation-Id',
    ],
  });

  // API prefix - exclude health and metrics endpoints for kubernetes probes and Prometheus
  app.setGlobalPrefix('api/v1', {
    exclude: ['health', 'health/live', 'health/ready', 'metrics'],
  });

  // Enable graceful shutdown hooks
  app.enableShutdownHooks();

  // PORT RESOLUTION: Service-specific var first, then generic PORT, then default 3000.
  // Prevents healthcheck failures from port mismatch when Docker only sets PORT.
  const port = configService.get<number>('AUTH_SERVICE_PORT')
    ?? configService.get<number>('PORT')
    ?? 3000;
  await app.listen(port);

  logger.log(`Auth Service running on http://localhost:${port}`);
  logger.log(`GraphQL Playground: http://localhost:${port}/graphql`);
}

bootstrap().catch((err: unknown) => {
  // ARCH-032: Surface the actual error on bootstrap failure.
  // NestJS ExceptionHandler serializes Error objects as '{}' via JSON.stringify
  // because Error properties (message, stack) are non-enumerable.
  // This catch block ensures the real error is always visible in container logs.
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'fatal',
    service: 'auth-service',
    message: `Bootstrap failed: ${message}`,
    ...(stack ? { stack } : {}),
    context: 'Bootstrap',
  }));
  process.exit(1);
});
