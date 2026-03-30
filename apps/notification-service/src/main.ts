import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StructuredLoggerService } from '@aquaculture/backend-common';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('NotificationService');

  const app = await NestFactory.create(AppModule, {
    logger: new StructuredLoggerService('notification-service'),
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
    throw new Error(
      'SECURITY: CORS_ORIGINS must not be "*" in production. Set explicit origins.',
    );
  }

  app.enableCors({
    origin: isWildcard ? '*' : corsOrigins.split(',').map((o: string) => o.trim()),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Tenant-Id',
      'X-Correlation-Id',
    ],
    // SECURITY: credentials must be false when using wildcard origin
    credentials: !isWildcard,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Graceful shutdown
  app.enableShutdownHooks();

  // PORT RESOLUTION: Service-specific var first, then generic PORT, then default 3000.
  // Prevents healthcheck failures from port mismatch when Docker only sets PORT.
  const port = configService.get<number>('NOTIFICATION_SERVICE_PORT')
    ?? configService.get<number>('PORT')
    ?? 3000;

  await app.listen(port);

  logger.log(`Notification Service running on port ${port}`);
}

const bootstrapLogger = new Logger('NotificationServiceBootstrap');
bootstrap().catch((error) => {
  bootstrapLogger.error('Notification Service failed to start:', error);
  process.exit(1);
});
