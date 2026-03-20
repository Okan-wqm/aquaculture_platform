import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { initTelemetry, StructuredLoggerService } from '@platform/backend-common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { HTTP_SECURITY } from './constants/auth.constants';

// Initialize OpenTelemetry tracing BEFORE NestFactory.create()
// Only active when ENABLE_TRACING=true environment variable is set.
initTelemetry('auth-service');

async function bootstrap(): Promise<void> {
  const logger = new Logger('AuthService');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new StructuredLoggerService('auth-service'),
  });

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
        enableImplicitConversion: true,
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

  const port = configService.get<number>('AUTH_SERVICE_PORT', 4001);
  await app.listen(port);

  logger.log(`Auth Service running on http://localhost:${port}`);
  logger.log(`GraphQL Playground: http://localhost:${port}/graphql`);
}

void bootstrap();
// force rebuild 1773529705
