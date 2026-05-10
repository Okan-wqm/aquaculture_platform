import { RemoteGraphQLDataSource } from '@apollo/gateway';
import { GatewayGraphQLRequestContext, GatewayGraphQLResponse } from '@apollo/server-gateway-interface';
import type { ResponsePath } from '@apollo/query-planner';
import { RetryableIntrospectAndCompose } from './config/retryable-introspect';
import { ApolloGatewayDriver, ApolloGatewayDriverConfig } from '@nestjs/apollo';
import { Module, MiddlewareConsumer, NestModule, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
// JwtService is injected by AuthGuard / RemoteGraphQLDataSource for token
// verification. JwtService is provided by PlatformJwtModule (which re-exports
// JwtModule), so we still need the named-type import here for DI metadata.
import { JwtService } from '@nestjs/jwt';
import depthLimit from 'graphql-depth-limit';
import {
  getComplexity,
  simpleEstimator,
  fieldExtensionsEstimator,
} from 'graphql-query-complexity';
import { PlatformJwtModule } from '@aquaculture/backend-common/auth';
import { RequestContextMiddleware } from '@aquaculture/backend-common/logging';
import { MetricsMiddleware } from '@aquaculture/backend-common/metrics';
import {
  CorrelationIdMiddleware,
  RequestLoggingMiddleware,
  TenantContextMiddleware,
  UserContextMiddleware,
} from '@aquaculture/backend-common/middleware';
import { RedisModule, RedisService } from '@aquaculture/backend-common/redis';
import { generateServiceIdentityHeaders } from '@aquaculture/backend-common/utils';
import { AuditedOperationModule } from '@aquaculture/backend-common/audit';
import { buildSignedInternalHeaders } from '@aquaculture/backend-common/http';
import { StorageModule, StorageConfig } from '@platform/storage';

import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { AuthGuard, JwtPayload } from './guards/auth.guard';
import { ApiKeyAuthStrategy } from './guards/strategies/api-key-auth.strategy';
import { BasicAuthStrategy } from './guards/strategies/basic-auth.strategy';
import { TenantIsolationGuard } from './guards/tenant-isolation.guard';
import { JwtMiddleware } from './middleware/jwt.middleware';
import { SecurityHeadersMiddleware } from './middleware/security-headers.middleware';
import { StripInternalHeadersMiddleware } from '@aquaculture/backend-common/middleware';
import { CsrfMiddleware } from './middleware/csrf.middleware';
import { RequestValidatorMiddleware } from './middleware/request-validator.middleware';
import { RateLimitGuard, RATE_LIMIT_STORE } from './guards/rate-limit.guard';
import { MutationRateLimitGuard } from './guards/mutation-rate-limit.guard';
import { RedisRateLimitStore } from './guards/redis-rate-limit.store';
import {
  TokenBlacklistStore,
  TOKEN_BLACKLIST_STORE,
  RedisTokenBlacklistStore,
  InMemoryTokenBlacklistStore,
} from './guards/redis-token-blacklist.store';
import { HealthModule } from './health/health.module';
import { RequestLoggingInterceptor } from './interceptors/request-logging.interceptor';
import { GatewayMetricsModule } from './metrics/metrics.module';
import { UploadModule } from './upload/upload.module';
import { WebSocketModule } from './websocket/websocket.module';
import { createAliasLimitPlugin } from './plugins/graphql-alias-limit.plugin';
import { AiRoutesModule } from './routes/v2/ai.routes';
import { TenantLookupService } from './services/tenant-lookup.service';

// JwtPayload is imported from auth.guard.ts for consistency

// Module-level logger to avoid re-instantiation per GraphQL operation
const queryComplexityLogger = new Logger('QueryComplexity');

/**
 * Request headers structure
 */
interface RequestHeaders {
  authorization?: string;
  cookie?: string;
  'x-tenant-id'?: string;
  'x-correlation-id'?: string;
  [key: string]: string | undefined;
}

/**
 * Request with user information attached
 */
interface RequestWithUser {
  headers: RequestHeaders;
  user?: JwtPayload;
  cookies?: Record<string, string>;
}

/**
 * Extended context type for Apollo Gateway
 */
interface GatewayContext {
  req: RequestWithUser;
  res: import('express').Response;
}

/**
 * SECURITY NOTE: JWT decoding moved to guard for proper verification.
 * Context only passes through the original request reference.
 * The guard will verify the JWT and set req.user with validated payload.
 * willSendRequest then forwards the verified user data to subgraphs.
 *
 * DO NOT decode JWT without verification - it creates security risks:
 * 1. Unverified claims could be forwarded to subgraphs
 * 2. Attackers could craft malicious payloads that bypass validation
 */

/**
 * Custom data source that forwards headers to subgraphs
 * Includes error logging for transient failures
 */
class AuthenticatedDataSource extends RemoteGraphQLDataSource<GatewayContext> {
  private readonly logger = new Logger('AuthenticatedDataSource');
  private readonly secret?: string;

  constructor(config: { url?: string; secret?: string }) {
    super({ url: config.url });
    this.secret = config.secret;
  }

  override willSendRequest(params: {
    request: { http?: { headers: { set: (key: string, value: string) => void } } };
    context?: GatewayContext | Record<string, unknown>;
  }): void {
    const { request, context } = params;

    // Handle health checks and schema loading which don't have our GatewayContext
    if (!context || !('req' in context)) {
      return;
    }

    const req = (context as GatewayContext).req;
    const httpRequest = request.http;

    if (!httpRequest) {
      return;
    }

    // Forward authentication header to subgraphs
    const authorization = req.headers.authorization;
    if (authorization) {
      httpRequest.headers.set('authorization', authorization);
    }

    // SECURITY: Forward cookies to subgraphs (needed for httpOnly refresh token)
    const cookie = req.headers.cookie;
    if (cookie) {
      httpRequest.headers.set('cookie', cookie);
    }

    // Forward tenant ID - prefer JWT tenantId (trusted), fallback to header
    // SECURITY: Only forward valid, non-empty UUIDs to prevent subgraphs from
    // receiving "null", "undefined", empty strings, or array values as tenant ID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let resolvedTenantId = req.user?.tenantId;
    if (!resolvedTenantId) {
      // Fallback: header (may be string[] if sent multiple times — use first element)
      const headerVal = req.headers['x-tenant-id'];
      const candidate = Array.isArray(headerVal) ? headerVal[0] : headerVal;
      if (typeof candidate === 'string') {
        resolvedTenantId = candidate.trim();
      }
    }
    if (
      resolvedTenantId &&
      typeof resolvedTenantId === 'string' &&
      resolvedTenantId.length > 0 &&
      uuidRegex.test(resolvedTenantId)
    ) {
      httpRequest.headers.set('x-tenant-id', resolvedTenantId);
    }

    // Forward correlation ID and trace context for distributed tracing
    const correlationId = req.headers['x-correlation-id'];
    if (correlationId) {
      httpRequest.headers.set('x-correlation-id', correlationId);
    }

    // Forward W3C Trace Context (traceparent)
    const traceparent = req.headers['traceparent'];
    if (traceparent) {
      httpRequest.headers.set('traceparent', traceparent);
    }

    // Forward trace/span IDs
    const traceId = req.headers['x-trace-id'];
    if (traceId) {
      httpRequest.headers.set('x-trace-id', traceId);
    }

    const spanId = req.headers['x-span-id'];
    if (spanId) {
      httpRequest.headers.set('x-span-id', spanId);
    }

    const parentSpanId = req.headers['x-parent-span-id'];
    if (parentSpanId) {
      httpRequest.headers.set('x-parent-span-id', parentSpanId);
    }

    // Forward user info if decoded
    const user = req.user;
    if (user) {
      httpRequest.headers.set('x-user-id', user.sub);
      httpRequest.headers.set('x-user-roles', JSON.stringify(user.roles ?? []));
      // Forward full user payload for @CurrentUser() decorator in subgraphs
      httpRequest.headers.set('x-user-payload', JSON.stringify(user));
    }

    // SECURITY: sign request for subgraph identity verification AND bind
    // the resolved tenant + method + path + body into the HMAC. v2 canonical
    // input prevents cross-endpoint replay (a captured signature for one
    // subgraph operation cannot be forwarded to another) AND body-tampering
    // (the receiver re-derives sha256(body) and rejects on mismatch). If
    // no tenant applies (public / pre-auth paths), tenantId is empty string.
    //
    // Closes: SEC-CRITICAL-001 — sender side; subgraph guards already accept v2
    // via verifyServiceIdentityRequest in libs/backend-common/src/guards.
    if (this.secret) {
      const signedTenantId = uuidRegex.test(resolvedTenantId ?? '')
        ? (resolvedTenantId as string)
        : '';
      // Apollo's runtime httpRequest exposes the to-be-sent verb, URL, and
      // body, but its public type only guarantees the header mutator.
      // Path is extracted without the query string per v2 contract.
      const outgoingRequest = httpRequest as typeof httpRequest & {
        url?: string;
        method?: string;
        body?: unknown;
      };
      const subgraphUrl = new URL(outgoingRequest.url ?? '/graphql', 'http://subgraph.local');
      const subgraphPath = subgraphUrl.pathname;
      const subgraphMethod = outgoingRequest.method ?? 'POST';
      const subgraphBody =
        typeof outgoingRequest.body === 'string'
          ? outgoingRequest.body
          : JSON.stringify(outgoingRequest.body ?? '');
      const identityHeaders = buildSignedInternalHeaders({
        serviceName: 'gateway-api',
        tenantId: signedTenantId,
        method: subgraphMethod,
        path: subgraphPath,
        body: subgraphBody,
        secret: this.secret,
      });
      for (const [key, value] of Object.entries(identityHeaders)) {
        httpRequest.headers.set(key, value);
      }
    }
  }

  override didReceiveResponse(
    requestContext: Required<Pick<GatewayGraphQLRequestContext<GatewayContext>, 'request' | 'response' | 'context'>> & {
      pathInIncomingRequest?: ResponsePath;
    },
  ): GatewayGraphQLResponse {
    const { response, context } = requestContext;
    // Forward set-cookie headers from subgraph → browser
    // Critical for httpOnly refresh token cookie from auth-service
    if (context && 'res' in context) {
      const res = (context as GatewayContext).res;
      const setCookieHeader = response.http?.headers?.get('set-cookie');
      if (setCookieHeader) {
        // Append (don't overwrite) — multiple subgraphs may set cookies
        res.append('set-cookie', setCookieHeader);
      }
    }
    return response;
  }
}

@Module({
  imports: [
    // Global configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
      cache: true,
    }),

    // SECURITY (CRITICAL-001): RS256 asymmetric verification via the shared
    // PlatformJwtModule. gateway-api is a token CONSUMER, not an issuer.
    //
    // Replaced the ~80-line bespoke block (WS2.B, 2026-04-14) — single
    // source of truth for all consumer services. The previous block carried
    // a non-production HS256 dev fallback (ALLOW_DEV_JWT_SECRET +
    // DEV_JWT_SECRET) which was the exact RS256/HS256-confusion surface
    // PlatformJwtModule exists to remove. Dev environments now require
    // JWT_PUBLIC_KEY (or JWT_PUBLIC_KEY_PATH) just like prod — generate a
    // keypair via scripts/generate-jwt-keys.sh and source the public key.
    //
    // FOLLOW-UP (HIGH-001): docker-compose.dev.yml + docker-compose.yml +
    // apps/gateway-api/test/header-propagation.e2e-spec.ts still reference
    // ALLOW_DEV_JWT_SECRET / DEV_JWT_SECRET. They are now dead env vars
    // for gateway-api but still consumed by auth-service's own dev
    // fallback. Tracked separately because removing the dev path requires
    // updating dev-onboarding scripts.
    PlatformJwtModule,

    // AUDITTRAIL-CRITICAL-002 sweep — registers AuditedOperationInterceptor.
    AuditedOperationModule.forRoot(),

    // Apollo Federation Gateway
    GraphQLModule.forRootAsync<ApolloGatewayDriverConfig>({
      driver: ApolloGatewayDriver,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        // Capture INTERNAL_SERVICE_SECRET for HMAC signing in buildService closure
        const internalServiceSecret = configService.get<string>('INTERNAL_SERVICE_SECRET');

        return {
        gateway: {
          /**
           * ARCH-GW-005: Federated subgraph registry.
           *
           * CRITICAL INVARIANT: Every service listed here MUST also appear in:
           *   1. docker-compose.droplet.yml gateway depends_on with condition: service_healthy
           *   2. health.service.ts serviceUrls map (for /health/detail monitoring)
           *
           * If a subgraph is added here but not in depends_on, the gateway container
           * starts before that subgraph is ready, causing composition failure that
           * blocks NestFactory.create() and prevents /health/live from responding.
           *
           * Composition is ALL-OR-NOTHING: if any single subgraph fails introspection,
           * the entire supergraph composition fails. There is no partial composition.
           *
           * Current subgraphs (11):
           *   auth, farm, sensor, alert, hr, billing, hydroponics, config,
           *   notification (BUG-4 FIX), messaging (ADR-012)
           */
          supergraphSdl: new RetryableIntrospectAndCompose({
            subgraphs: [
              {
                name: 'auth',
                url: configService.get('AUTH_SERVICE_URL', 'http://localhost:3001/graphql'),
              },
              {
                name: 'farm',
                url: configService.get('FARM_SERVICE_URL', 'http://localhost:3002/graphql'),
              },
              {
                name: 'sensor',
                url: configService.get('SENSOR_SERVICE_URL', 'http://localhost:3003/graphql'),
              },
              {
                name: 'alert',
                url: configService.get('ALERT_SERVICE_URL', 'http://localhost:3004/graphql'),
              },
              {
                name: 'hr',
                url: configService.get('HR_SERVICE_URL', 'http://localhost:3005/graphql'),
              },
              {
                name: 'billing',
                url: configService.get('BILLING_SERVICE_URL', 'http://localhost:3006/graphql'),
              },
              {
                name: 'hydroponics',
                url: configService.get('HYDROPONICS_SERVICE_URL', 'http://localhost:4007/graphql'),
              },
              {
                name: 'config',
                url: configService.get('CONFIG_SERVICE_URL', 'http://localhost:3007/graphql'),
              },
              // BUG-4 FIX: notification-service exposes a federation-compatible GraphQL
              // endpoint (myNotifications, unreadNotificationCount, markNotificationAsRead,
              // markAllNotificationsAsRead, registerDeviceToken).  It was previously
              // excluded with an incorrect comment.  The service uses ApolloFederationDriver
              // and must be included for mobile notification queries to resolve.
              {
                name: 'notification',
                url: configService.get('NOTIFICATION_SERVICE_URL', 'http://localhost:4008/graphql'),
              },
              // ADR-012: messaging-service is a federated subgraph for tenant-internal
              // WhatsApp-like messaging. Added to docker-compose depends_on and
              // health.service.ts serviceUrls map as part of ARCH-GW-001.
              {
                name: 'messaging',
                url: configService.get('MESSAGING_SERVICE_URL', 'http://messaging-service:3000/graphql'),
              },
            ],
            pollIntervalInMs: 300000, // Poll for schema changes every 5 minutes
          }),
          buildService({ url }) {
            return new AuthenticatedDataSource({ url, secret: internalServiceSecret });
          },
        },
        server: {
          // SECURITY: Disable batched HTTP requests to prevent rate-limit bypass
          // A single HTTP request with many batched operations would count as 1 request
          allowBatchedHttpRequests: false,
          /**
           * 2026-04-30: Keep Apollo CSRF prevention explicit while Apollo Server 5
           * migration is blocked by the Nest/Apollo peer graph.
           * WHY: Apollo Server 4 remains in the dependency graph, so XS-Search
           * class protections must be fail-closed at runtime.
           */
          csrfPrevention: true,
          // 2026-04-30: Deprecated GraphQL Playground is not enabled at runtime.
          // WHY: gateway UI exposure must not rely on deprecated Apollo Playground behavior.
          // SECURITY: Disable introspection in production to prevent schema discovery attacks
          // Explicit env var allows overriding independently of NODE_ENV
          introspection: configService.get('GRAPHQL_INTROSPECTION', 'false') === 'true' ||
            configService.get('NODE_ENV') !== 'production',
          // SECURITY: Hide stack traces in production error responses (C-4)
          includeStacktraceInErrorResponses: configService.get('NODE_ENV') !== 'production',
          // SECURITY: Strip internal details from error responses in production
          formatError: configService.get('NODE_ENV') === 'production'
            ? (formattedError: { message: string; extensions?: Record<string, unknown> }) => ({
                message: formattedError.message,
                extensions: {
                  code: formattedError.extensions?.code ?? 'INTERNAL_SERVER_ERROR',
                },
              })
            : undefined,
          // SECURITY: Depth limiting to prevent deeply nested query DoS attacks
          // Maximum query depth of 10 prevents excessive resource consumption
          validationRules: [depthLimit(10)],
          // SECURITY: Query complexity limiting to prevent expensive query DoS attacks
          plugins: [
            // SECURITY: Alias brute-force protection (H-2)
            createAliasLimitPlugin(),
            {
              // Hoist Logger out of per-request closure to avoid re-instantiation per operation
              requestDidStart: async () => ({
                async didResolveOperation({ request, document, schema }) {
                  const logger = queryComplexityLogger;
                  const maxComplexity = configService.get<number>('GRAPHQL_MAX_COMPLEXITY', 1000);

                  try {
                    const complexity = getComplexity({
                      schema,
                      operationName: request.operationName ?? undefined,
                      query: document,
                      variables: request.variables ?? {},
                      estimators: [
                        fieldExtensionsEstimator(),
                        simpleEstimator({ defaultComplexity: 1 }),
                      ],
                    });

                    if (complexity > maxComplexity) {
                      logger.warn(
                        `Query complexity ${complexity} exceeds maximum allowed ${maxComplexity}`,
                      );
                      throw new Error(
                        `Query is too complex: ${complexity}. Maximum allowed complexity: ${maxComplexity}`,
                      );
                    }

                    if (configService.get('NODE_ENV') !== 'production') {
                      logger.debug(`Query complexity: ${complexity}/${maxComplexity}`);
                    }
                  } catch (error) {
                    if (error instanceof Error && error.message.includes('Query is too complex')) {
                      throw error;
                    }
                    // Log but don't fail on complexity calculation errors
                    // (e.g., schema not available during startup)
                    logger.warn(`Could not calculate query complexity: ${error}`);
                  }
                },
              }),
            },
          ],
          context: ({ req, res }: { req: RequestWithUser; res: import('express').Response }): GatewayContext => {
            // SECURITY: req.user is set by JwtMiddleware which runs before context creation.
            // JwtMiddleware verifies the JWT signature and decodes the payload.
            // This ensures req.user is available when willSendRequest forwards headers.
            //
            // AuthGuard still runs as an additional validation layer and handles
            // token blacklist checks, but JwtMiddleware ensures headers are forwarded.
            //
            // res is passed through so auth-service can set httpOnly cookies via the gateway.

            return { req, res };
          },
        },
      };
      },
    }),

    // MinIO Storage Module for file uploads
    // SECURITY: No default credentials - must be explicitly configured
    StorageModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): StorageConfig => {
        const nodeEnv = configService.get<string>('NODE_ENV', 'development');
        const isProduction = nodeEnv === 'production';
        const accessKey = configService.get<string>('MINIO_ACCESS_KEY', '');
        const secretKey = configService.get<string>('MINIO_SECRET_KEY', '');

        // SECURITY: Fail fast in production if MinIO credentials are not configured
        // Prevents silent fallback to well-known default credentials
        if (isProduction && (!accessKey || !secretKey)) {
          throw new Error(
            'CRITICAL: MINIO_ACCESS_KEY and MINIO_SECRET_KEY must be explicitly configured in production. ' +
            'Application startup aborted to prevent use of default credentials.',
          );
        }

        // In development, use defaults only if not explicitly set
        const resolvedAccessKey = accessKey || 'minioadmin';
        const resolvedSecretKey = secretKey || 'minioadmin';

        if (!accessKey || !secretKey) {
          const minioLogger = new Logger('StorageModule');
          minioLogger.warn(
            'Using default MinIO credentials for development. ' +
            'Set MINIO_ACCESS_KEY and MINIO_SECRET_KEY for production.',
          );
        }

        return {
          endpoint: configService.get('MINIO_ENDPOINT', 'localhost'),
          port: parseInt(configService.get('MINIO_PORT', '9000'), 10),
          useSSL: configService.get('MINIO_USE_SSL', 'false') === 'true',
          accessKey: resolvedAccessKey,
          secretKey: resolvedSecretKey,
          bucket: configService.get('MINIO_BUCKET', 'aquaculture'),
          region: configService.get('MINIO_REGION', 'us-east-1'),
        };
      },
    }),

    // Health check module
    HealthModule,

    // Prometheus metrics (per-service /metrics endpoint)
    GatewayMetricsModule,

    // File upload module
    UploadModule,

    // WebSocket module for real-time sensor data
    WebSocketModule,

    // AI service proxy routes (chat, conversations)
    AiRoutesModule,

    // Redis for distributed rate limiting (optional, falls back to in-memory if not configured)
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        host: configService.get('REDIS_HOST', 'localhost'),
        port: parseInt(configService.get('REDIS_PORT', '6379'), 10),
        password: configService.get('REDIS_PASSWORD'),
        db: parseInt(configService.get('REDIS_DB', '0'), 10),
        keyPrefix: 'gateway:',
      }),
    }),

    /**
     * REMOVED 2026-04-14 (architectural correction):
     *
     * RlsModule.forRoot was added in commit c48e2edb (V6) under the
     * stated rationale "gateway-api ... holds tenant-lookup / session /
     * audit reads". That rationale is FALSE — gateway-api has zero
     * TypeORM/DataSource code (confirmed by grep). Apollo's
     * RemoteGraphQLDataSource is a GraphQL data source abstraction,
     * NOT a SQL connection pool.
     *
     * RlsConnectionBootstrap requires a TypeORM DataSource at index [0]
     * to patch its checkout hook for GUC injection. Without a pool,
     * NestJS DI fails at startup:
     *
     *   "Nest can't resolve dependencies of the
     *    RlsConnectionBootstrapImpl (?). DataSource at index [0]..."
     *
     * The "uniform GUC contract" intent is achieved by every
     * pool-owning service registering RlsModule (auth, farm, sensor,
     * hr, billing, alert, hydroponics, messaging, notification, config,
     * admin-api, ai). Pool-LESS services like gateway-api don't need
     * GUC because they have no rows to filter.
     */
  ],
  providers: [
    // SECURITY: TenantLookupService is required for production tenant resolution.
    // TenantContextMiddleware uses @Optional() @Inject(TenantLookupService), so
    // registration here makes it available in production where it queries auth-service.
    TenantLookupService,
    // Authentication strategy services (injected into AuthGuard)
    ApiKeyAuthStrategy,
    BasicAuthStrategy,
    // Global exception filter
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    /**
     * Global auth guard — supports JWT, API Key, and Basic Auth.
     *
     * useFactory with explicit inject array bypasses webpack's stripping of
     * TypeScript emitDecoratorMetadata. This is the NestJS-recommended pattern
     * for webpack-bundled production builds where design:paramtypes metadata
     * is unavailable at runtime.
     */
    {
      provide: APP_GUARD,
      useFactory: (
        reflector: Reflector,
        configService: ConfigService,
        jwtService: JwtService,
        apiKeyStrategy: ApiKeyAuthStrategy,
        basicStrategy: BasicAuthStrategy,
        tokenBlacklist?: TokenBlacklistStore,
      ) => new AuthGuard(reflector, configService, jwtService, apiKeyStrategy, basicStrategy, tokenBlacklist),
      inject: [
        Reflector,
        ConfigService,
        JwtService,
        ApiKeyAuthStrategy,
        BasicAuthStrategy,
        { token: TOKEN_BLACKLIST_STORE, optional: true },
      ],
    },
    /**
     * SECURITY (M-11): TenantIsolationGuard registered as a global guard.
     *
     * This guard enforces strict tenant data isolation across ALL gateway
     * requests. It validates that the authenticated user's tenant matches
     * the requested tenant, prevents unauthorized cross-tenant access, and
     * supports admin/platform_admin overrides with proper audit logging.
     *
     * Execution order: AuthGuard (authentication) -> TenantIsolationGuard
     * (authorization/isolation) -> RateLimitGuard -> MutationRateLimitGuard.
     * This ensures the user is authenticated before tenant isolation is checked.
     */
    // WHY: useFactory bypasses reflect-metadata resolution which fails in Docker Alpine.
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector): TenantIsolationGuard =>
        new TenantIsolationGuard(reflector),
      inject: [Reflector],
    },
    // Rate limiting guard
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector, configService: ConfigService, redisStore?: unknown): RateLimitGuard =>
        new RateLimitGuard(reflector, configService, redisStore as never),
      inject: [Reflector, ConfigService, { token: RATE_LIMIT_STORE, optional: true }],
    },
    // GraphQL mutation rate limiting guard (no deps)
    {
      provide: APP_GUARD,
      useClass: MutationRateLimitGuard,
    },
    // Redis-based rate limit store for distributed deployments
    // Enabled via RATE_LIMIT_USE_REDIS=true environment variable
    {
      provide: RATE_LIMIT_STORE,
      useFactory: (redisService: RedisService) => new RedisRateLimitStore(redisService),
      inject: [RedisService],
    },
    // Redis-based token blacklist store for distributed token revocation
    // Falls back to in-memory if Redis is unavailable
    // SECURITY: Required for proper logout and token revocation across instances
    {
      provide: TOKEN_BLACKLIST_STORE,
      useFactory: (redisService: RedisService, configService: ConfigService) => {
        const useRedis = configService.get<string>('TOKEN_BLACKLIST_USE_REDIS', 'true') === 'true';
        if (useRedis && redisService) {
          return new RedisTokenBlacklistStore(redisService);
        }
        return new InMemoryTokenBlacklistStore();
      },
      inject: [RedisService, ConfigService],
    },
    // Request logging interceptor
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestLoggingInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    /**
     * SEC-L08: Register SecurityHeadersMiddleware for all routes.
     *
     * This middleware sets defense-in-depth security headers (X-Content-Type-Options,
     * X-Frame-Options, Strict-Transport-Security, CSP, Permissions-Policy, etc.)
     * as a fallback when NGINX headers are not applied (e.g., direct API access,
     * development environments, or NGINX misconfiguration).
     */
    consumer
      .apply(SecurityHeadersMiddleware)
      .forRoutes('*');

    consumer
      .apply(
        // Order matters:
        // 1. Record request metrics (before everything else for accurate duration)
        // 2. Set correlation id for tracing
        // 3. SECURITY: Strip spoofable internal headers from external requests
        // 4. SECURITY: CSRF double-submit cookie validation
        // 5. Decode JWT and set req.user (needed for willSendRequest to forward headers)
        // 6. Hydrate user from x-user-payload header (for inter-service calls)
        // 7. Set tenant context
        // 8. Log request
        MetricsMiddleware,
        CorrelationIdMiddleware,
        RequestContextMiddleware,
        StripInternalHeadersMiddleware,
        CsrfMiddleware,
        JwtMiddleware,
        UserContextMiddleware,
        TenantContextMiddleware,
        RequestLoggingMiddleware,
      )
      .forRoutes('*');

    /**
     * SECURITY (H-11): Register RequestValidatorMiddleware for REST routes.
     *
     * This middleware was previously defined but never registered (dead code).
     * It provides defense-in-depth against injection attacks (SQL injection, XSS,
     * path traversal, command injection) by validating and sanitizing request
     * bodies, query parameters, headers, and URL paths.
     *
     * Applied only to REST routes (upload endpoints, v2 API proxy routes) because
     * GraphQL requests are already validated by Apollo Server's query parser, and
     * applying request-body sanitization to GraphQL would corrupt query strings.
     */
    consumer
      .apply(RequestValidatorMiddleware)
      .forRoutes('upload', 'upload/{*path}', 'api/v2/{*path}');
  }
}
