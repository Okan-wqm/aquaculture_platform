import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('GatewayAPI');
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);

  // Trust proxy configuration for deployments behind reverse proxy (nginx, cloudflare, etc)
  // This ensures req.ip contains the real client IP from X-Forwarded-For header
  // SECURITY: Only enable this when behind a trusted proxy
  const trustProxy = configService.get<string>('TRUST_PROXY', 'false');
  if (trustProxy === 'true' || trustProxy === '1') {
    // Trust first proxy
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
    logger.log('Trust proxy enabled (trusting first proxy)');
  } else if (trustProxy && trustProxy !== 'false' && trustProxy !== '0') {
    // Trust specific proxy count or CIDR
    app.getHttpAdapter().getInstance().set('trust proxy', trustProxy);
    logger.log(`Trust proxy configured: ${trustProxy}`);
  }

  // Security middleware with explicit production settings
  const isProduction = process.env.NODE_ENV === 'production';
  app.use(
    helmet({
      // Content Security Policy - strict in production
      contentSecurityPolicy: isProduction
        ? {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"], // Allow inline styles for GraphQL Playground
              imgSrc: ["'self'", 'data:', 'https:'],
              fontSrc: ["'self'"],
              connectSrc: ["'self'"],
              objectSrc: ["'none'"],
              frameSrc: ["'none'"],
              baseUri: ["'self'"],
              formAction: ["'self'"],
              upgradeInsecureRequests: [],
            },
          }
        : false, // Disable in development for GraphQL Playground

      // HSTS - Strict Transport Security (production only)
      strictTransportSecurity: isProduction
        ? {
            maxAge: 31536000, // 1 year
            includeSubDomains: true,
            preload: true,
          }
        : false,

      // Referrer Policy - don't leak referrer information
      referrerPolicy: {
        policy: 'strict-origin-when-cross-origin',
      },

      // Cross-Origin Embedder Policy
      crossOriginEmbedderPolicy: isProduction ? { policy: 'require-corp' } : false,

      // Cross-Origin Opener Policy
      crossOriginOpenerPolicy: { policy: 'same-origin' },

      // Cross-Origin Resource Policy
      crossOriginResourcePolicy: { policy: 'same-origin' },

      // X-Content-Type-Options
      noSniff: true,

      // X-Frame-Options (prevent clickjacking)
      frameguard: { action: 'deny' },

      // Hide X-Powered-By header
      hidePoweredBy: true,

      // X-XSS-Protection (legacy but still useful)
      xssFilter: true,

      // DNS Prefetch Control
      dnsPrefetchControl: { allow: false },

      // IE No Open (prevents IE from executing downloads)
      ieNoOpen: true,
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
        target: false, // Don't expose target object in errors
        value: false,  // Don't expose submitted value in errors
      },
      // SECURITY: Disable detailed error messages in production
      disableErrorMessages: process.env.NODE_ENV === 'production',
    }),
  );

  // CORS configuration
  // SECURITY: credentials cannot be true when origin is '*' (wildcard)
  // When CORS_ORIGINS is '*', we disable credentials for security
  // For specific origins, credentials are enabled for authenticated requests
  const corsOrigins = configService.get<string>('CORS_ORIGINS', '*');
  const isWildcard = corsOrigins === '*';

  if (isWildcard && process.env.NODE_ENV === 'production') {
    throw new Error('CORS_ORIGINS cannot be "*" in production. Configure an explicit allowlist.');
  }

  const parsedOrigins = isWildcard ? '*' : corsOrigins.split(',').map(o => o.trim()).filter(Boolean);

  app.enableCors({
    origin: parsedOrigins,
    // SECURITY: credentials must be false when using wildcard origin
    credentials: !isWildcard,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Tenant-Id',
      'X-Correlation-Id',
      'X-Request-Id',
    ],
  });

  // Enable graceful shutdown hooks
  app.enableShutdownHooks();

  const port = configService.get<number>('PORT', 3000);
  await app.listen(port);

  logger.log(`Gateway API running on http://localhost:${port}`);
  logger.log(`GraphQL Playground: http://localhost:${port}/graphql`);
}

void bootstrap();
