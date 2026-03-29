/**
 * @module main
 * @description Entry point for the messaging-service microservice.
 * Bootstraps NestJS application with NATS transport, JWT auth,
 * security middleware (helmet, CORS), and GraphQL federation subgraph.
 * @see ADR-012 section 2 (Service Bootstrap)
 */
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { StructuredLoggerService } from '@aquaculture/backend-common';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('MessagingService');

  const app = await NestFactory.create(AppModule, {
    logger: new StructuredLoggerService('messaging-service'),
  });

  const configService = app.get(ConfigService);
  const isProduction = configService.get('NODE_ENV') === 'production';

  // NATS microservice transport for event-driven communication
  const natsUrl = configService.get<string>('NATS_URL', 'nats://localhost:4222');
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.NATS,
    options: {
      servers: [natsUrl],
      queue: 'messaging-service',
    },
  });

  // Trust proxy configuration for deployments behind nginx
  const trustProxy = configService.get<string>('TRUST_PROXY', 'false');
  if (trustProxy === 'true' || trustProxy === '1') {
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
    logger.log('Trust proxy enabled (trusting first proxy)');
  } else if (trustProxy && trustProxy !== 'false' && trustProxy !== '0') {
    app.getHttpAdapter().getInstance().set('trust proxy', trustProxy);
    logger.log(`Trust proxy configured: ${trustProxy}`);
  }

  // Security middleware
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
  const corsOrigins = configService.get<string>('CORS_ORIGINS', '*');
  const isWildcard = corsOrigins === '*';

  if (isWildcard && isProduction) {
    throw new Error('CORS_ORIGINS cannot be "*" in production. Configure an explicit allowlist.');
  }

  const parsedOrigins = isWildcard
    ? '*'
    : corsOrigins.split(',').map((o: string) => o.trim()).filter(Boolean);

  app.enableCors({
    origin: parsedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Tenant-Id',
      'X-Correlation-Id',
      'X-Request-Id',
      'X-User-Payload',
    ],
    credentials: !isWildcard,
  });

  // Global validation pipe — whitelist strips unknown properties, transform enables
  // implicit type conversion, and forbidNonWhitelisted rejects unknown fields.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      validationError: { target: false, value: false },
      disableErrorMessages: isProduction,
    }),
  );

  // Graceful shutdown hooks for SIGTERM/SIGINT
  app.enableShutdownHooks();

  // Start all microservices (NATS) then HTTP
  await app.startAllMicroservices();

  const port = configService.get<number>('PORT', 3000);
  await app.listen(port);

  logger.log(`Messaging Service running on port ${port}`);
  if (!isProduction) {
    const host = configService.get<string>('HOST', 'localhost');
    logger.log(`GraphQL playground: http://${host}:${port}/graphql`);
  }
}

const bootstrapLogger = new Logger('MessagingServiceBootstrap');
bootstrap().catch((error) => {
  bootstrapLogger.error('Messaging Service failed to start:', error);
  process.exit(1);
});
