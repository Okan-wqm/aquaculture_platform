import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('FarmService');

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
  });

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
  const corsOrigins = configService.get<string>('CORS_ORIGINS', '*');
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
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
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

  // Graceful shutdown
  app.enableShutdownHooks();

  const port = configService.get<number>('PORT', 3002);

  await app.listen(port);

  logger.log(`Farm Service running on port ${port}`);
  logger.log(
    `GraphQL playground: http://localhost:${port}/graphql`,
  );
}

const bootstrapLogger = new Logger('FarmServiceBootstrap');
bootstrap().catch((error) => {
  bootstrapLogger.error('Farm Service failed to start:', error);
  process.exit(1);
});
