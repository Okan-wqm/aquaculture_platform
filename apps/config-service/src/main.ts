import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('ConfigService');

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
  app.enableCors({
    origin: configService.get('CORS_ORIGINS', '*').split(','),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-tenant-id',
      'x-correlation-id',
      'x-api-key',
    ],
    credentials: true,
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

  // API prefix
  app.setGlobalPrefix('api/v1');

  // Graceful shutdown
  app.enableShutdownHooks();

  const port = configService.get<number>('PORT', 3007);

  await app.listen(port);

  logger.log(`Config Service running on port ${port}`);
  logger.log(`Environment: ${configService.get('NODE_ENV', 'development')}`);
}

bootstrap().catch((error) => {
  console.error('Config Service failed to start:', error);
  process.exit(1);
});
