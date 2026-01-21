import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';

import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('AuthService');
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);

  // Security middleware
  app.use(helmet());

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

  // CORS configuration
  // SECURITY: Wildcard origin with credentials is dangerous
  // In production, CORS_ORIGINS must be set to explicit list of allowed origins
  const corsOrigins = configService.get<string>('CORS_ORIGINS', '*');
  const isProduction = process.env['NODE_ENV'] === 'production';

  if (isProduction && corsOrigins === '*') {
    logger.warn(
      'SECURITY WARNING: CORS_ORIGINS is set to wildcard in production. ' +
      'This is insecure. Set CORS_ORIGINS to explicit allowed origins.',
    );
  }

  app.enableCors({
    origin: corsOrigins === '*'
      ? (isProduction ? false : '*')  // Disable CORS wildcard in production
      : corsOrigins.split(',').map(o => o.trim()),
    credentials: corsOrigins !== '*',  // Only allow credentials with explicit origins
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Tenant-Id',
      'X-Correlation-Id',
    ],
  });

  // API prefix - exclude health endpoints for kubernetes probes
  app.setGlobalPrefix('api/v1', {
    exclude: ['health', 'health/live', 'health/ready'],
  });

  const port = configService.get<number>('PORT', 3001);
  await app.listen(port);

  logger.log(`Auth Service running on http://localhost:${port}`);
  logger.log(`GraphQL Playground: http://localhost:${port}/graphql`);
}

void bootstrap();
