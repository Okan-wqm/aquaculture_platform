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
 * import { createServiceApp } from '@aquaculture/backend-common/create-service-app.ts';
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
import { BadRequestException, Logger, ValidationPipe } from '@nestjs/common';
import type {
  CanActivate,
  INestApplication,
  Type,
  ValidationError,
  ValidationPipeOptions,
  VersioningOptions,
} from '@nestjs/common';
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import type { NestApplicationOptions } from '@nestjs/common/interfaces/nest-application-options.interface';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { MicroserviceOptions } from '@nestjs/microservices';
import type { RequestHandler } from 'express';
import helmet from 'helmet';
import type { HelmetOptions } from 'helmet';

import { bootstrapSecrets } from '../config/secrets.provider';
import { StructuredLoggerService } from '../logging';
import { NatsV3Server } from '../nats/nats-v3-server.strategy';

import { mountEdgeHardening, resolveTrustProxy, type ServiceVisibility } from './edge-hardening';
import { logBootstrapError } from './safe-error-logger';

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
  helmetOptions?: Partial<HelmetOptions>;

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
   * Override or extend the default ValidationPipe configuration.
   * These options are shallow-merged with the factory defaults, so services
   * can opt in to specific behaviors (e.g. enableImplicitConversion) without
   * replacing the entire pipe.
   */
  validationPipeOverrides?: Partial<ValidationPipeOptions>;

  /**
   * Replace the default ValidationPipe entirely (factory skips its own pipe).
   * Use this when the service needs a fundamentally different validation
   * strategy that cannot be expressed through `validationPipeOverrides`.
   */
  customValidationPipe?: ValidationPipe;

  /**
   * Callback invoked after the app is created and default middleware/config is
   * applied, but before app.init() runs boot hooks and before app.listen().
   * Use this for service-specific adapters or final route/middleware tweaks.
   */
  onBeforeListen?: (app: INestApplication) => Promise<void> | void;

  /**
   * Pre-NestFactory environment checks (e.g., service identity keyring guard).
   * Each function is called before NestFactory.create() — throw to abort startup.
   */
  environmentGuards?: Array<() => void>;

  /**
   * Middleware applied before helmet/CORS (e.g., cookieParser, body limits).
   * Functions are applied in order via `app.use(middleware)`.
   */
  earlyMiddleware?: RequestHandler[];

  /**
   * NATS microservice transport config. When set, connectMicroservice()
   * is called after NestFactory.create() and startAllMicroservices()
   * is called before app.listen().
   */
  natsTransport?: { queue?: string };

  /**
   * Swagger config. Auto-disabled in production (SEC-L14).
   * When set, Swagger UI is exposed at `path` (default: 'docs').
   */
  swagger?: {
    title: string;
    description: string;
    version: string;
    path?: string;
  };

  /**
   * API versioning config. When set, app.enableVersioning() is called.
   */
  versioning?: VersioningOptions;

  /**
   * Global guards applied via app.useGlobalGuards().
   * Applied after validation pipe and versioning.
   */
  globalGuards?: CanActivate[];

  /**
   * Service reachability — REQUIRED (ADR-0006). The compiler refuses a boot
   * site that does not state it, and
   * `tests/invariants/public-service-edge-hardening.spec.ts` refuses a
   * declaration that disagrees with `infrastructure/nginx/droplet.conf`.
   *
   * - `'public'`: nginx proxies internet traffic to this service. The factory
   *   applies the edge-hardening bundle (`./edge-hardening.ts`): `TRUST_PROXY`
   *   is mandatory in production and `AccessLogMiddleware` is mounted ahead of
   *   every Nest middleware (the AppModule must import
   *   `AccessLogModule.forRoot()`). `configureCors()` runs and `CORS_ORIGINS`
   *   is REQUIRED in production.
   *
   * - `'internal'`: only the Docker network reaches the service (gateway
   *   federation, NATS RPC, Prometheus scraping). No browser ever sends a
   *   preflight to it, so `configureCors()` is SKIPPED, and no edge bundle is
   *   mounted — the edge already logged the request.
   */
  serviceVisibility: ServiceVisibility;

  /**
   * Additional env var names to resolve via file-mounted secrets before
   * NestFactory.create. The default `PLATFORM_SECRET_ENV_VARS` list in this
   * file is intentionally limited to platform-wide dependencies. Services
   * must opt in to their own private secrets at the boot site so ownership is
   * explicit (for example, auth-service owns JWT_PRIVATE_KEY,
   * PASSWORD_PEPPER, MFA_ENCRYPTION_KEY, and SUPER_ADMIN_PASSWORD).
   *
   * Each entry `X` is resolved as follows: if `X_FILE` is set and readable,
   * the file's contents are injected into `process.env.X`. Otherwise the
   * existing `process.env.X` value is kept.
   *
   * SECURITY (MEDIUM-001): closes the gap where Docker Secrets /
   * Kubernetes file-mount secrets could be delivered but were never
   * picked up by the application.
   */
  secrets?: readonly string[];
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
  // ADR-0007: SUPER_ADMIN act-as intent + justification, validated by the
  // kernel EffectiveTenantMiddleware on every browser-authenticating ingress.
  'X-Act-As-Tenant',
  'X-Act-As-Reason',
  'X-Act-As-Ticket',
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

interface ExpressTrustProxyApp {
  set(setting: 'trust proxy', value: boolean | number | string): void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Applies the Express `trust proxy` setting resolved by `resolveTrustProxy`
 * (`./edge-hardening.ts`): a public service in production refuses to boot
 * without a trusted hop, because behind nginx an untrusted proxy makes
 * `req.ip` the proxy address and collapses every per-IP rate-limit bucket
 * into one (AUTH-010).
 */
function configureTrustProxy(
  app: INestApplication,
  configService: ConfigService,
  logger: Logger,
  serviceName: string,
  serviceVisibility: ServiceVisibility,
  isProduction: boolean,
): void {
  const setting = resolveTrustProxy({
    serviceName,
    visibility: serviceVisibility,
    isProduction,
    rawValue: configService.get<string>('TRUST_PROXY'),
  });
  if (setting === false) {
    logger.log('Trust proxy disabled (no reverse proxy trusted)');
    return;
  }
  const expressApp = app.getHttpAdapter().getInstance() as ExpressTrustProxyApp;
  expressApp.set('trust proxy', setting);
  logger.log(`Trust proxy configured: ${String(setting)}`);
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
  helmetOverrides?: Partial<HelmetOptions>,
): HelmetOptions {
  // Helmet options typed via the helmet package's own HelmetOptions interface
  const defaults: HelmetOptions = {
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
  return { ...defaults, ...helmetOverrides } as HelmetOptions;
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
  // Read the raw value without a default so we can detect "not set" vs "set to *"
  const rawCorsOrigins = configService.get<string>('CORS_ORIGINS');

  // SECURITY: Require explicit CORS_ORIGINS in production (checked first to
  // avoid the dead-code scenario where a default '*' masks a missing value)
  if (isProduction && !rawCorsOrigins) {
    throw new Error(
      'CORS_ORIGINS must be set in production.',
    );
  }

  // Fall back to wildcard only in non-production environments
  const corsOriginsEnv = rawCorsOrigins ?? '*';
  const isWildcard = corsOriginsEnv === '*';

  // SECURITY: Hard-fail in production if wildcard CORS is configured
  if (isWildcard && isProduction) {
    throw new Error(
      'CORS_ORIGINS cannot be "*" in production. ' +
        'Configure an explicit allowlist of allowed origins.',
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
 * Flattens nested class-validator errors to a compact list for structured
 * server-side logging. PII-safe: includes property paths + constraint messages
 * only, never the rejected field values.
 */
function flattenValidationErrors(
  errors: ValidationError[],
  parentPath = '',
): Array<{ field: string; constraints: string[] }> {
  const flattened: Array<{ field: string; constraints: string[] }> = [];
  for (const error of errors) {
    const field = parentPath ? `${parentPath}.${error.property}` : error.property;
    if (error.constraints) {
      flattened.push({ field, constraints: Object.values(error.constraints) });
    }
    if (error.children && error.children.length > 0) {
      flattened.push(...flattenValidationErrors(error.children, field));
    }
  }
  return flattened;
}

const validationLogger = new Logger('RequestValidation');

/**
 * Configures the global ValidationPipe with enterprise security defaults.
 *
 * - whitelist: strips properties not in the DTO
 * - forbidNonWhitelisted: rejects requests with unknown properties
 * - transform: enables class-transformer for auto-conversion
 * - enableImplicitConversion: OFF by default for security (opt-in via overrides)
 * - validationError.target/value: hidden to avoid leaking internals
 * - disableErrorMessages: suppressed in production
 *
 * Services can extend defaults via `validationPipeOverrides`, or replace
 * the entire pipe via `customValidationPipe`.
 */
function configureValidationPipe(
  app: INestApplication,
  isProduction: boolean,
  validationPipeOverrides?: Partial<ValidationPipeOptions>,
  customValidationPipe?: ValidationPipe,
): void {
  // If the caller provided a fully custom pipe, use it as-is and skip defaults
  if (customValidationPipe) {
    app.useGlobalPipes(customValidationPipe);
    return;
  }

  const defaults: ValidationPipeOptions = {
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: {
      // SECURITY: Disabled by default. Implicit conversion of "true"/"1"
      // to boolean can bypass authorization checks. Services that need it
      // must opt in via validationPipeOverrides.
      enableImplicitConversion: false,
    },
    // SECURITY: Hide internal details from validation errors
    validationError: {
      target: false,
      value: false,
    },
    disableErrorMessages: isProduction,
    // WHY: production sets disableErrorMessages, which masks the RESPONSE to a
    // bare "Bad Request" — historically undiagnosable from logs (masked 400s
    // cost real debugging time). WHAT: always emit the failing field paths +
    // constraint messages to the service log (structured, PII-safe — never the
    // rejected field values), while the client response stays masked in
    // production. Makes masked validation failures detectable (Tier-3).
    exceptionFactory: (errors: ValidationError[]): BadRequestException => {
      const fields = flattenValidationErrors(errors);
      validationLogger.warn(
        `Request validation failed: ${JSON.stringify({ fields })}`,
      );
      return isProduction
        ? new BadRequestException()
        : new BadRequestException(fields);
    },
  };

  // Shallow-merge caller overrides so services can opt in to specific
  // behaviors without replacing the entire configuration
  const merged: ValidationPipeOptions = validationPipeOverrides
    ? { ...defaults, ...validationPipeOverrides }
    : defaults;

  app.useGlobalPipes(new ValidationPipe(merged));
}

/**
 * Resolves the listen port using the standard cascade:
 * SERVICE_PORT env var -> PORT env var -> 3000.
 *
 * ConfigService.get<number>() does NOT parse strings to numbers; env vars are
 * always strings. We explicitly parseInt and validate the range to prevent
 * silent NaN or out-of-range ports.
 */
function resolvePort(
  configService: ConfigService,
  portEnvVar: string,
): number {
  const raw =
    configService.get<string>(portEnvVar) ??
    configService.get<string>('PORT') ??
    '3000';
  const port = parseInt(raw, 10);

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid port: "${raw}" from ${portEnvVar}/PORT. ` +
        'Must be an integer between 1 and 65535.',
    );
  }

  return port;
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
 * import { createServiceApp } from '@aquaculture/backend-common/create-service-app.ts';
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
 *   additionalCorsHeaders: ['X-Requested-With'],
 *   onBeforeListen: async (app) => {
 *     app.use(cookieParser());
 *   },
 * });
 */
/**
 * Platform-wide secret env vars auto-resolved via `bootstrapSecrets()` at the
 * top of every service's boot. Each entry may be provided either directly
 * (`VAR=value`) or via a file mount (`VAR_FILE=/run/secrets/var`). Docker
 * Secrets and Kubernetes secret projection both use the file-mount pattern.
 *
 * SECURITY (MEDIUM-001): The helper existed in libs/backend-common but was
 * never invoked by any service's main.ts. That left the file-mounted secret
 * supply chain disconnected — even though the infra (Helm ExternalSecrets,
 * Terraform Secrets Manager, Docker secrets) could deliver secrets via
 * files, services only read from env vars. Wiring the helper into the
 * shared bootstrap makes the file-path reachable for every service at once
 * without edits to 15 main.ts files.
 */
const PLATFORM_SECRET_ENV_VARS: readonly string[] = [
  'JWT_PUBLIC_KEY',
  'JWT_SECRET',
  'SERVICE_IDENTITY_KEYRING',
  'POSTGRES_PASSWORD',
  'REDIS_PASSWORD',
  // NATS per-service passwords REMOVED (ADR-015).
  // Production NATS auth is mTLS cert-only (verify_and_map on the server
  // maps cert CN → user identity; CONNECT-frame user/pass fields are
  // IGNORED by the server). Passwords in env vars would be legitimate
  // secrets only if user/pass auth were load-bearing — which it no
  // longer is. Keeping them in this list would keep the file-mounted
  // secret-delivery pipeline wired for values that no service consumes,
  // which is the anti-pattern ADR-014 + ADR-015 exist to eliminate.
  //
  // Dev environments that still use user/pass auth (TLS disabled) get
  // credentials from the container's env directly — they don't need the
  // secrets-provider file-mount path.
  'ENCRYPTION_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'SMTP_PASSWORD',
  'OBSERVABILITY_INTERNAL_API_KEY',
];

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
    validationPipeOverrides,
    customValidationPipe,
    onBeforeListen,
    environmentGuards = [],
    earlyMiddleware = [],
    natsTransport,
    swagger,
    versioning,
    globalGuards = [],
    serviceVisibility,
    secrets: secretsOverride,
  } = options;

  const logger = new Logger(serviceName);

  // -----------------------------------------------------------------------
  // SECURITY (MEDIUM-001): Resolve file-mounted secrets into process.env
  // BEFORE any Nest module or ConfigService is constructed. This makes the
  // Docker Secrets / Kubernetes file-mount path usable via every existing
  // `configService.get('SECRET_NAME')` call site without further changes.
  //
  // Merge strategy:
  //   - Default list covers the full platform-wide secret surface.
  //   - Each service MAY pass an additional `secrets: [...]` array to
  //     resolve service-specific secret files (e.g. STRIPE_SIGNING_SECRET).
  // -----------------------------------------------------------------------
  const secretVars = new Set<string>(PLATFORM_SECRET_ENV_VARS);
  for (const extra of secretsOverride ?? []) secretVars.add(extra);
  bootstrapSecrets([...secretVars]);

  // -----------------------------------------------------------------------
  // SEC-H15 / INFRA-CRITICAL-009: retired DATABASE_SYNC guard
  //
  // TypeORM synchronize mode (DATABASE_SYNC=true) auto-alters tables by
  // diffing entities against the live schema. Runtime services no longer
  // support it in any environment because it creates a second DDL authority
  // beside db-migrate / reviewed migrations.
  //
  // This guard runs before any NestJS module is loaded — before TypeORM's
  // DataSource.initialize() can execute the destructive synchronize. All
  // 15+ services inherit this check via the shared bootstrap factory.
  //
  // Deployments and local stacks MUST use migrations/db-migrate.
  // -----------------------------------------------------------------------
  const databaseSync = process.env['DATABASE_SYNC'];
  if (databaseSync === 'true') {
    throw new Error(
      'FATAL: DATABASE_SYNC=true is retired. Runtime services must never run TypeORM synchronize. ' +
        'Use db-migrate or a reviewed TypeORM migration instead.',
    );
  }

  // -----------------------------------------------------------------------
  // 1a. Environment guards (run before NestFactory — throw to abort startup)
  // -----------------------------------------------------------------------
  for (const guard of environmentGuards) {
    guard();
  }

  // -----------------------------------------------------------------------
  // 1b. Optional OpenTelemetry initialization (must happen before NestFactory.create)
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
  //
  // ARCH-032: Wrap NestFactory.create() to surface readable errors.
  // NestJS ExceptionHandler serializes Error objects via JSON.stringify,
  // which produces '{}' because Error properties (message, stack) are
  // non-enumerable. By catching here, we log the actual error message
  // BEFORE NestJS can swallow it, ensuring container logs always show
  // what went wrong during module initialization.
  // -----------------------------------------------------------------------
  // SECURITY (R1 Path-alpha): GraphQL subgraph services re-verify a service-identity
  // HMAC-v2 on every inbound request, binding sha256(body). The receiver must hash the
  // RAW wire bytes — not a re-`JSON.stringify` of the parsed body — so its hash matches
  // the sender's (gateway / Rust router coprocessor) byte-for-byte regardless of
  // JS-vs-serde serialization differences. Enabling `rawBody` makes Nest's body parser
  // capture `req.rawBody` (the pre-parse Buffer), which ServiceIdentityGuard prefers.
  //
  // Default ON for `hasGraphQL` (the subgraph-verifier surface); a service may still
  // override via an explicit `nestFactoryOptions.rawBody` (e.g. gateway-api is the
  // SENDER, not a verifier, and sets `rawBody: false`). The explicit value always wins
  // because the spread below comes after this default.
  const rawBodyDefault = hasGraphQL ? { rawBody: true } : {};
  let app: INestApplication;
  try {
    app = await NestFactory.create(appModule, {
      logger: new StructuredLoggerService(serviceName),
      ...rawBodyDefault,
      ...nestFactoryOptions,
    });
  } catch (err: unknown) {
    logBootstrapError(serviceName, err, 'Module initialization');
    process.exit(1);
  }

  const configService = app.get(ConfigService);
  const isProduction = configService.get('NODE_ENV') === 'production';

  // -----------------------------------------------------------------------
  // 2a. NATS microservice transport (connectMicroservice early, startAll later)
  // -----------------------------------------------------------------------
  if (natsTransport) {
    // PR-B (PLAT-HIGH-003): platform-owned v3 strategy replaces Nest's Transport.NATS
    // (which binds the removed nats v2 JSONCodec). Wire-compatible — see nats-v3-codec.
    app.connectMicroservice<MicroserviceOptions>({
      strategy: new NatsV3Server({
        serviceName,
        ...(natsTransport.queue ? { queue: natsTransport.queue } : {}),
      }),
    });
    logger.log(`NATS microservice transport connected (queue: ${natsTransport.queue ?? 'default'})`);
  }

  // -----------------------------------------------------------------------
  // 2b. Early middleware (before helmet/CORS — e.g., cookieParser, body limits)
  // -----------------------------------------------------------------------
  for (const middleware of earlyMiddleware) {
    app.use(middleware);
  }

  // -----------------------------------------------------------------------
  // 3. Trust proxy (for req.ip behind nginx) + edge-hardening bundle
  //
  // ADR-0006: a service that declares itself internet-reachable gets the
  // kernel's edge controls here, ahead of helmet/CORS and of every Nest
  // middleware, so no service can be an edge without them.
  // -----------------------------------------------------------------------
  configureTrustProxy(app, configService, logger, serviceName, serviceVisibility, isProduction);
  if (serviceVisibility === 'public') {
    mountEdgeHardening(app, serviceName, logger);
  }

  // -----------------------------------------------------------------------
  // 4. Helmet security headers — properly typed via HelmetOptions, no cast needed
  // -----------------------------------------------------------------------
  const mergedHelmet = buildHelmetOptions(isProduction, helmetOverrides);
  app.use(helmet(mergedHelmet));

  // -----------------------------------------------------------------------
  // 5. CORS with production wildcard guard
  //
  // Internal services (Prometheus aggregators, internal admin tools, RPC-only
  // services) have no browser exposure — they cannot receive a CORS preflight,
  // so configuring CORS would be configuring a no-op. We skip configureCors()
  // entirely instead of setting a synthetic `CORS_ORIGINS` env var to satisfy
  // the production hard-fail. The hard-fail correctly catches missing CORS for
  // public-facing services; for internal services it would be a false positive.
  // -----------------------------------------------------------------------
  if (serviceVisibility === 'internal') {
    logger.log(
      `Service visibility 'internal' — CORS not configured (no browser exposure)`,
    );
  } else {
    configureCors(
      app,
      configService,
      isProduction,
      additionalCorsHeaders,
      logger,
    );
  }

  // -----------------------------------------------------------------------
  // 6. Global validation pipe
  // -----------------------------------------------------------------------
  configureValidationPipe(app, isProduction, validationPipeOverrides, customValidationPipe);

  // -----------------------------------------------------------------------
  // 6a. API versioning (when configured)
  // -----------------------------------------------------------------------
  if (versioning) {
    app.enableVersioning(versioning);
  }

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
  // 7a. Global guards (applied after validation pipe and prefix)
  // -----------------------------------------------------------------------
  if (globalGuards.length > 0) {
    app.useGlobalGuards(...globalGuards);
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
  // 10a. Finish Nest application bootstrap before transports/listeners start.
  //
  // app.init() runs OnModuleInit / OnApplicationBootstrap hooks, including
  // SchemaDriftValidator. Only after those invariants pass do we start NATS
  // message consumers or bind the HTTP listener.
  // -----------------------------------------------------------------------
  await app.init();
  logger.log('Nest application bootstrap hooks completed');

  // -----------------------------------------------------------------------
  // 10b. Start NATS microservices (if connected)
  // -----------------------------------------------------------------------
  if (natsTransport) {
    await app.startAllMicroservices();
    logger.log('NATS microservices started');
  }

  // -----------------------------------------------------------------------
  // 10c. Swagger (auto-disabled in production — SEC-L14)
  // -----------------------------------------------------------------------
  if (swagger && !isProduction) {
    try {
      const { SwaggerModule } = await import('@nestjs/swagger');
      // CONTRACT-CRITICAL-003: the served document and the committed
      // openapi.json artifact are built by the same function.
      const { buildOpenApiConfig } = await import('./openapi-config');

      const document = SwaggerModule.createDocument(app, buildOpenApiConfig(swagger));
      const swaggerPath = swagger.path ?? 'docs';
      SwaggerModule.setup(swaggerPath, app, document, {
        swaggerOptions: {
          persistAuthorization: true,
          tagsSorter: 'alpha',
          operationsSorter: 'alpha',
        },
      });
      logger.log(`Swagger docs available at /${swaggerPath}`);
    } catch {
      logger.warn('Swagger module not available — skipping API docs setup');
    }
  }

  // -----------------------------------------------------------------------
  // 10d. Resolve port and start listening
  // -----------------------------------------------------------------------
  const port = resolvePort(configService, portEnvVar);
  await app.listen(port);

  logger.log(`${serviceName} running on port ${port}`);

  if (hasGraphQL && !isProduction) {
    // 2026-04-30: Do not advertise deprecated GraphQL Playground.
    // WHY: local logs must reflect the supported GraphQL endpoint, not a disabled UI.
    logger.log(`GraphQL endpoint: http://localhost:${port}/graphql`);
  }

  logger.log(`Health check: http://localhost:${port}/health`);

  return app;
}

// ---------------------------------------------------------------------------
// Standalone runner (wraps createServiceApp with error handling + process.exit)
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper that calls `createServiceApp` and handles fatal errors
 * with structured JSON logging + process.exit(1). This is the recommended
 * entry point for service main.ts files.
 *
 * ARCH-032: Uses console.error with JSON.stringify instead of Logger.error()
 * because NestJS Logger serializes Error objects as '{}' via JSON.stringify
 * (Error properties are non-enumerable). Structured JSON ensures the actual
 * error message and stack trace are always visible in container logs.
 *
 * @example
 * import { bootstrapService } from '@aquaculture/backend-common/create-service-app.ts';
 * import { AppModule } from './app.module';
 * bootstrapService(AppModule, { serviceName: 'farm-service', portEnvVar: 'FARM_SERVICE_PORT' });
 */
export function bootstrapService(
  appModule: Type<unknown>,
  options: ServiceBootstrapOptions,
): void {
  createServiceApp(appModule, options).catch((err: unknown) => {
    logBootstrapError(options.serviceName, err, 'Bootstrap');
    process.exit(1);
  });
}
