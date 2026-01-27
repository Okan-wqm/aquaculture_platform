import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('NotificationService');

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
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
    logger.warn('SECURITY WARNING: CORS_ORIGINS is set to "*" in production');
  }

  app.enableCors({
    origin: isWildcard ? '*' : corsOrigins.split(',').map((o: string) => o.trim()),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-tenant-id',
      'x-correlation-id',
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

  const port = configService.get<number>('PORT', 3006);

  await app.listen(port);

  logger.log(`Notification Service running on port ${port}`);
}

const bootstrapLogger = new Logger('NotificationServiceBootstrap');
bootstrap().catch((error) => {
  bootstrapLogger.error('Notification Service failed to start:', error);
  process.exit(1);
});
