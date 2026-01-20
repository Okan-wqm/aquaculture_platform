import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import helmet from 'helmet';

async function bootstrap() {
  const logger = new Logger('AdminApiService');
  const app = await NestFactory.create(AppModule);

  // Security middleware
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          scriptSrc: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // CORS configuration for admin dashboard
  app.enableCors({
    origin: process.env['ADMIN_CORS_ORIGINS']?.split(',') || [
      'http://localhost:4200',
      'http://localhost:3000',
    ],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Tenant-ID',
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
    }),
  );

  // No global prefix - nginx handles /api routing
  // Health endpoints are at root level for kubernetes probes

  const port = process.env['PORT'] || 3008;
  await app.listen(port);

  logger.log(`Admin API Service running on port ${port}`);
  logger.log(`Environment: ${process.env['NODE_ENV'] || 'development'}`);
  logger.log(`Health check: http://localhost:${port}/api/v1/health`);
}

bootstrap();
