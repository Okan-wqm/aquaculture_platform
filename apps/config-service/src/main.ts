import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StructuredLoggerService } from '@platform/backend-common';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('ConfigService');

  const app = await NestFactory.create(AppModule, {
    logger: new StructuredLoggerService('config-service'),
  });

  const configService = app.get(ConfigService);

  // Security middleware
  app.use(
    helmet({
      contentSecurityPolicy:
        configService.get('NODE_ENV') === 'production' ? undefined : false,
    }),
  );

  // CORS configuration
  // SECURITY: credentials cannot be true when origin is '*' (wildcard)
  const corsOrigins = configService.get<string>('CORS_ORIGINS', '*');
  const isWildcard = corsOrigins === '*';

  if (isWildcard && configService.get('NODE_ENV') === 'production') {
    throw new Error('SECURITY: CORS_ORIGINS must not be "*" in production. Set to specific allowed origins.');
  }

  app.enableCors({
    origin: isWildcard ? '*' : corsOrigins.split(',').map((o: string) => o.trim()),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-correlation-id',
      'x-api-key',
    ],
    // SECURITY: credentials must be false when using wildcard origin
    credentials: !isWildcard,
  });

  // Global validation pipe with strict settings
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
      validationError: {
        target: false,
        value: false,
      },
    }),
  );

  // API prefix excluding health endpoints
  app.setGlobalPrefix('api/v1', {
    exclude: ['health', 'health/live', 'health/ready'],
  });

  // Graceful shutdown
  app.enableShutdownHooks();

  const port = configService.get<number>('PORT', 3007);

  await app.listen(port);

  logger.log(`Config Service running on port ${port}`);
  logger.log(`Environment: ${configService.get('NODE_ENV', 'development')}`);
}

const bootstrapLogger = new Logger('ConfigServiceBootstrap');
bootstrap().catch((error) => {
  bootstrapLogger.error('Config Service failed to start:', error);
  process.exit(1);
});
