import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('GatewayAPI');
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);

  // Security middleware
  app.use(
    helmet({
      contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false,
    }),
  );

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
  const corsOrigins = configService.get<string>('CORS_ORIGINS', '*');
  app.enableCors({
    origin: corsOrigins === '*' ? '*' : corsOrigins.split(','),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Tenant-Id',
      'X-Correlation-Id',
      'X-Request-Id',
    ],
  });

  const port = configService.get<number>('PORT', 3000);
  await app.listen(port);

  logger.log(`Gateway API running on http://localhost:${port}`);
  logger.log(`GraphQL Playground: http://localhost:${port}/graphql`);
}

bootstrap();
