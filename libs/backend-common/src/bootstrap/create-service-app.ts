/**
 * Shared NestJS application bootstrap factory.
 *
 * Provides enterprise-standard configuration for all backend services:
 * - Express trust proxy behind nginx reverse proxy
 * - Helmet security headers with production CSP
 * - CORS with production wildcard guard (throws in production)
 * - Class-validator validation pipe (whitelist + forbidNonWhitelisted)
 * - Global API prefix with health/metrics endpoint exclusion
 * - Graceful shutdown hooks (SIGTERM/SIGINT)
 * - Port resolution: SERVICE_PORT ?? PORT ?? 3000
 * - Structured JSON logging via StructuredLoggerService
 * - Optional OpenTelemetry tracing initialization
 *
 * Usage in service main.ts:
 * ```ts
 * import { createServiceApp } from '@aquaculture/backend-common';
 * import { AppModule } from './app.module';
 *
 * createServiceApp(AppModule, {
 *   serviceName: 'farm-service',
 *   portEnvVar: 'FARM_SERVICE_PORT',
 * });
 * ```
 *
 * Services that need custom middleware or configuration can use `onBeforeListen`:
 * ```ts
 * createServiceApp(AppModule, {
 *   serviceName: 'gateway-api',
 *   portEnvVar: 'GATEWAY_PORT',
 *   onBeforeListen: async (app) => {
 *     app.use(cookieParser());
 *     app.use(json({ limit: '1mb' }));
 *   },
 * });
 * ```
 */
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { INestApplication, Type } from '@nestjs/common';
import type { NestApplicationOptions } from '@nestjs/common/interfaces/nest-application-options.interface';
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import { StructuredLoggerService } from '../logging';
import helmet from 'helmet';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Configuration options for the shared bootstrap factory.
 *
 * Every option has a sensible default so that a minimal call requires only
 * `serviceName` and `portEnvVar`.
 */
export interface ServiceBootstrapOptions {
  /** Service name for logging and health endpoint identification. */
  serviceName: string;

  /**
   * Environment variable name for the service-specific port
   * (e.g., 'FARM_SERVICE_PORT'). Resolved as: portEnvVar ?? PORT ?? 3000.
   */
  portEnvVar: string;

  /** Global API prefix applied to all routes (default: 'api/v1'). */
  globalPrefix?: string;

  /**
   * Routes to exclude from the global prefix.
   * Default: ['health', 'health/(.*)', 'metrics'].
   * Set to `false` to disable global prefix entirely.
   */
  prefixExclusions?: string[] | false;

  /**
   * Additional CORS allowed headers merged with the default set.
   * Default headers: Content-Type, Authorization, X-Tenant-Id,
   * X-Correlation-Id, X-Request-Id.
   */
  additionalCorsHeaders?: string[];

  /**
   * Custom helmet options deep-merged with the enterprise defaults.
   * Pass `{ contentSecurityPolicy: false }` to disable CSP (e.g. when
   * CSP is handled by the edge nginx proxy).
   */
  helmetOptions?: Record<string, unknown>;

  /** Whether this service exposes a GraphQL endpoint (affects prefix exclusions). */
  hasGraphQL?: boolean;

  /**
   * Whether to initialize OpenTelemetry tracing before NestFactory.create().
   * Only active when ENABLE_TRACING=true is set in the environment.
   * Default: false.
   */
  enableTelemetry?: boolean;

  /**
   * Additional NestFactory.create() options merged with the defaults.
   * Use this for rawBody, bodyParser overrides, etc.
   */
  nestFactoryOptions?: Partial<NestApplicationOptions>;

  /**
   * Callback invoked after the app is created and all default middleware is
   * applied, but before `app.listen()`. Use this for service-specific
   * middleware, guards, interceptors, microservice transports, Swagger, etc.
   */
  onBeforeListen?: (app: INestApplication) => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Default CORS headers shared across all services
// ---------------------------------------------------------------------------

/** Standard CORS allowed headers for the aquaculture platform. */
const DEFAULT_CORS_HEADERS: string[] = [
  'Content-Type',
  'Authorization',
  'X-Tenant-Id',
  'X-Correlation-Id',
  'X-Request-Id',
];

/** Standard CORS allowed methods for the aquaculture platform. */
const DEFAULT_CORS_METHODS: string[] = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'OPTIONS',
];

/** Routes excluded from global prefix by default (health probes + metrics). */
const DEFAULT_PREFIX_EXCLUSIONS: string[] = [
  'health',
  'health/(.*)',
  'metrics',
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Configures Express trust proxy based on the TRUST_PROXY environment variable.
 *
 * Supports the following values:
 * - 'true' or '1': trusts the first hop (integer 1)
 * - 'false' or '0': no trust proxy (default)
 * - numeric string: trusts N hops
 * - CIDR/IP string: passed verbatim to Express
 */
function configureTrustProxy(
  app: INestApplication,
  configService: ConfigService,
  logger: Logger,
): void {
  const trustProxy = configService.get<string>('TRUST_PROXY', 'false');

  if (trustProxy === 'true' || trustProxy === '1') {
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
    logger.log('Trust proxy enabled (trusting first proxy)');
  } else if (trustProxy && trustProxy !== 'false' && trustProxy !== '0') {
    app.getHttpAdapter().getInstance().set('trust proxy', trustProxy);
    logger.log(`Trust proxy configured: ${trustProxy}`);
  }
}

/**
 * Builds the production-grade Helmet configuration.
 *
 * In production, enables a strict CSP, HSTS with preload, and all defensive
 * headers. In development, CSP and HSTS are disabled to avoid dev-server
 * issues while keeping the remaining headers active.
 *
 * Services behind nginx that have CSP handled at the edge should pass
 * `helmetOverrides.contentSecurityPolicy = false`.
 */
function buildHelmetOptions(
  isProduction: boolean,
  helmetOverrides?: Record<string, unknown>,
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {
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
  };

  if (!helmetOverrides) {
    return defaults;
  }

  // Shallow merge: overrides win. This allows services to set e.g.
  // contentSecurityPolicy: false without affecting other defaults.
  return { ...defaults, ...helmetOverrides };
}

/**
 * Configures CORS with production wildcard guard.
 *
 * In production, wildcard ('*') origin is rejected with a hard error. In
 * development, wildcard is permitted but credentials are disabled to comply
 * with the CORS spec (credentials + wildcard is invalid).
 *
 * @returns The parsed CORS options applied to the application.
 */
function configureCors(
  app: INestApplication,
  configService: ConfigService,
  isProduction: boolean,
  additionalHeaders: string[],
  logger: Logger,
): void {
  const corsOriginsEnv = configService.get<string>('CORS_ORIGINS', '*');
  const isWildcard = corsOriginsEnv === '*';

  // SECURITY: Hard-fail in production if wildcard CORS is configured
  if (isWildcard && isProduction) {
    throw new Error(
      'CORS_ORIGINS cannot be "*" in production. ' +
        'Configure an explicit allowlist of allowed origins.',
    );
  }

  // SECURITY: Require explicit CORS_ORIGINS in production
  if (isProduction && !configService.get<string>('CORS_ORIGINS')) {
    throw new Error(
      'CORS_ORIGINS environment variable must be set in production.',
    );
  }

  const parsedOrigins: string | string[] = isWildcard
    ? '*'
    : corsOriginsEnv
        .split(',')
        .map((o: string) => o.trim())
        .filter(Boolean);

  const allowedHeaders = [
    ...DEFAULT_CORS_HEADERS,
    ...additionalHeaders,
  ];

  const corsOptions: CorsOptions = {
    origin: parsedOrigins,
    methods: DEFAULT_CORS_METHODS,
    allowedHeaders,
    // SECURITY: credentials must be false when using wildcard origin
    credentials: !isWildcard,
    maxAge: 86400, // 24 hours - cache preflight requests
  };

  app.enableCors(corsOptions);

  if (Array.isArray(parsedOrigins)) {
    logger.log(`CORS enabled for origins: ${parsedOrigins.join(', ')}`);
  } else {
    logger.log('CORS enabled with wildcard origin (development only)');
  }
}

/**
 * Configures the global ValidationPipe with enterprise security defaults.
 *
 * - whitelist: strips properties not in the DTO
 * - forbidNonWhitelisted: rejects requests with unknown properties
 * - transform: enables class-transformer for auto-conversion
 * - validationError.target/value: hidden to avoid leaking internals
 * - disableErrorMessages: suppressed in production
 */
function configureValidationPipe(
  app: INestApplication,
  isProduction: boolean,
): void {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
      // SECURITY: Hide internal details from validation errors
      validationError: {
        target: false,
        value: false,
      },
      disableErrorMessages: isProduction,
    }),
  );
}

/**
 * Resolves the listen port using the standard cascade:
 * SERVICE_PORT env var -> PORT env var -> 3000.
 */
function resolvePort(
  configService: ConfigService,
  portEnvVar: string,
): number {
  return (
    configService.get<number>(portEnvVar) ??
    configService.get<number>('PORT') ??
    3000
  );
}

// ---------------------------------------------------------------------------
// Public factory function
// ---------------------------------------------------------------------------

/**
 * Creates and starts a NestJS application with enterprise-standard configuration.
 *
 * This factory consolidates the bootstrap boilerplate that was previously
 * duplicated across all backend services. It provides a single, tested,
 * consistent configuration surface while remaining flexible enough to
 * handle service-specific needs via `onBeforeListen`.
 *
 * @param appModule - The root NestJS module class (e.g., AppModule)
 * @param options   - Service-specific bootstrap options
 * @returns The running INestApplication instance (for testing or programmatic use)
 *
 * @example
 * // Minimal usage
 * import { createServiceApp } from '@aquaculture/backend-common';
 * import { AppModule } from './app.module';
 * createServiceApp(AppModule, { serviceName: 'farm-service', portEnvVar: 'FARM_SERVICE_PORT' });
 *
 * @example
 * // With OpenTelemetry, GraphQL, and custom middleware
 * createServiceApp(AppModule, {
 *   serviceName: 'gateway-api',
 *   portEnvVar: 'GATEWAY_PORT',
 *   enableTelemetry: true,
 *   hasGraphQL: true,
 *   helmetOptions: { contentSecurityPolicy: false },
 *   additionalCorsHeaders: ['X-CSRF-Token', 'X-Requested-With'],
 *   onBeforeListen: async (app) => {
 *     app.use(cookieParser());
 *   },
 * });
 */
export async function createServiceApp(
  appModule: Type<unknown>,
  options: ServiceBootstrapOptions,
): Promise<INestApplication> {
  const {
    serviceName,
    portEnvVar,
    globalPrefix = 'api/v1',
    prefixExclusions = DEFAULT_PREFIX_EXCLUSIONS,
    additionalCorsHeaders = [],
    helmetOptions: helmetOverrides,
    hasGraphQL = false,
    enableTelemetry = false,
    nestFactoryOptions = {},
    onBeforeListen,
  } = options;

  const logger = new Logger(serviceName);

  // -----------------------------------------------------------------------
  // 1. Optional OpenTelemetry initialization (must happen before NestFactory.create)
  // -----------------------------------------------------------------------
  if (enableTelemetry) {
    try {
      const { initTelemetry } = await import('../telemetry');
      initTelemetry(serviceName);
    } catch (err) {
      logger.warn(
        `Failed to initialize telemetry for ${serviceName}: ${String(err)}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // 2. Create the NestJS application
  // -----------------------------------------------------------------------
  const app = await NestFactory.create(appModule, {
    logger: new StructuredLoggerService(serviceName),
    ...nestFactoryOptions,
  });

  const configService = app.get(ConfigService);
  const isProduction = configService.get('NODE_ENV') === 'production';

  // -----------------------------------------------------------------------
  // 3. Trust proxy (for req.ip behind nginx/cloudflare)
  // -----------------------------------------------------------------------
  configureTrustProxy(app, configService, logger);

  // -----------------------------------------------------------------------
  // 4. Helmet security headers
  // -----------------------------------------------------------------------
  const mergedHelmet = buildHelmetOptions(isProduction, helmetOverrides);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use(helmet(mergedHelmet as any));

  // -----------------------------------------------------------------------
  // 5. CORS with production wildcard guard
  // -----------------------------------------------------------------------
  configureCors(app, configService, isProduction, additionalCorsHeaders, logger);

  // -----------------------------------------------------------------------
  // 6. Global validation pipe
  // -----------------------------------------------------------------------
  configureValidationPipe(app, isProduction);

  // -----------------------------------------------------------------------
  // 7. Global prefix with health/metrics exclusions
  // -----------------------------------------------------------------------
  if (prefixExclusions !== false) {
    const exclusions = [...prefixExclusions];

    // Add graphql to exclusions if the service uses GraphQL
    if (hasGraphQL && !exclusions.includes('graphql')) {
      exclusions.push('graphql');
    }

    app.setGlobalPrefix(globalPrefix, {
      exclude: exclusions,
    });
  }

  // -----------------------------------------------------------------------
  // 8. Graceful shutdown hooks (SIGTERM + SIGINT)
  // -----------------------------------------------------------------------
  app.enableShutdownHooks();

  // -----------------------------------------------------------------------
  // 9. Service-specific customization hook
  // -----------------------------------------------------------------------
  if (onBeforeListen) {
    await onBeforeListen(app);
  }

  // -----------------------------------------------------------------------
  // 10. Resolve port and start listening
  // -----------------------------------------------------------------------
  const port = resolvePort(configService, portEnvVar);
  await app.listen(port);

  logger.log(`${serviceName} running on port ${port}`);

  if (hasGraphQL && !isProduction) {
    logger.log(`GraphQL playground: http://localhost:${port}/graphql`);
  }

  logger.log(`Health check: http://localhost:${port}/health`);

  return app;
}

// ---------------------------------------------------------------------------
// Standalone runner (wraps createServiceApp with error handling + process.exit)
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper that calls `createServiceApp` and handles fatal errors
 * with a log + process.exit(1). This is the recommended entry point for
 * service main.ts files.
 *
 * @example
 * import { bootstrapService } from '@aquaculture/backend-common';
 * import { AppModule } from './app.module';
 * bootstrapService(AppModule, { serviceName: 'farm-service', portEnvVar: 'FARM_SERVICE_PORT' });
 */
export function bootstrapService(
  appModule: Type<unknown>,
  options: ServiceBootstrapOptions,
): void {
  const bootstrapLogger = new Logger(`${options.serviceName}:bootstrap`);

  createServiceApp(appModule, options).catch((error: unknown) => {
    bootstrapLogger.error(`${options.serviceName} failed to start:`, error);
    process.exit(1);
  });
}
