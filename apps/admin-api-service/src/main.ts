import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import helmet from 'helmet';

async function bootstrap() {
  const logger = new Logger('AdminApiService');
  const app = await NestFactory.create(AppModule);

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

  // No global prefix - nginx handles /api routing
  // Health endpoints are at root level for kubernetes probes

  // Enable graceful shutdown hooks
  app.enableShutdownHooks();

  const port = process.env['PORT'] || 3008;
  await app.listen(port);

  logger.log(`Admin API Service running on port ${port}`);
  logger.log(`Environment: ${process.env['NODE_ENV'] || 'development'}`);
  logger.log(`Health check: http://localhost:${port}/api/v1/health`);
}

const bootstrapLogger = new Logger('AdminApiServiceBootstrap');
bootstrap().catch((error) => {
  bootstrapLogger.error('Admin API Service failed to start:', error);
  process.exit(1);
});
