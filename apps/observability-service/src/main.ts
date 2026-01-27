import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import helmet from 'helmet';

async function bootstrap() {
  const logger = new Logger('ObservabilityService');
  const app = await NestFactory.create(AppModule);

  // Security middleware
  app.use(
    helmet({
      contentSecurityPolicy: false,
    }),
  );

  // CORS configuration for metrics scrapers and dashboards
  app.enableCors({
    origin: process.env['CORS_ORIGINS']?.split(',') || [
      'http://localhost:3000',
      'http://localhost:9090', // Prometheus
      'http://localhost:3001', // Grafana
    ],
    methods: ['GET', 'POST'],
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // API prefix
  app.setGlobalPrefix('api/v1');

  // Enable graceful shutdown hooks
  app.enableShutdownHooks();

  const port = process.env['PORT'] || 3009;
  await app.listen(port);

  logger.log(`Observability Service running on port ${port}`);
  logger.log(`Environment: ${process.env['NODE_ENV'] || 'development'}`);
  logger.log(`Prometheus metrics: http://localhost:${port}/metrics`);
  logger.log(`Health check: http://localhost:${port}/api/v1/health`);
}

bootstrap();
