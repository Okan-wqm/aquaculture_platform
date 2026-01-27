import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import helmet from 'helmet';

async function bootstrap() {
  const logger = new Logger('EventStoreService');
  const app = await NestFactory.create(AppModule);

  // Security middleware
  app.use(
    helmet({
      contentSecurityPolicy: false, // Disable for API service
    }),
  );

  // CORS configuration
  app.enableCors({
    origin: process.env['CORS_ORIGINS']?.split(',') || ['http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Id', 'X-Request-Id'],
    credentials: true,
    maxAge: 3600,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // API prefix
  app.setGlobalPrefix('api/v1');

  // Enable graceful shutdown hooks
  app.enableShutdownHooks();

  const port = process.env['PORT'] || 3010;
  await app.listen(port);

  logger.log(`Event Store Service running on port ${port}`);
  logger.log(`Environment: ${process.env['NODE_ENV'] || 'development'}`);
}

bootstrap();
