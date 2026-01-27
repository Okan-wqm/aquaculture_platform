import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';

import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('AuthService');
  const app = await NestFactory.create(AppModule);

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

  const isProduction = process.env['NODE_ENV'] === 'production';

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
  const isProduction = process.env['NODE_ENV'] === 'production';

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

  // API prefix - exclude health endpoints for kubernetes probes
  app.setGlobalPrefix('api/v1', {
    exclude: ['health', 'health/live', 'health/ready'],
  });

  // Enable graceful shutdown hooks
  app.enableShutdownHooks();

  const port = configService.get<number>('PORT', 3001);
  await app.listen(port);

  logger.log(`Auth Service running on http://localhost:${port}`);
  logger.log(`GraphQL Playground: http://localhost:${port}/graphql`);
}

void bootstrap();
