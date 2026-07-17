import {
  AccessLogModule,
  AccessLogEntity,
  AuditedOperationModule,
  AuditLogEntity,
} from '@aquaculture/backend-common/audit';
import { PlatformJwtModule } from '@aquaculture/backend-common/auth';
import { createServiceTypeOrmConfig } from '@aquaculture/backend-common/database';
import { RequestContextMiddleware } from '@aquaculture/backend-common/logging';
import { MetricsMiddleware } from '@aquaculture/backend-common/metrics';
import {
  AccessLogMiddleware,
  CorrelationIdMiddleware,
  RequestLoggingMiddleware,
  StripInternalHeadersMiddleware,
  TenantContextMiddleware,
  UserContextMiddleware,
} from '@aquaculture/backend-common/middleware';
import {
  RATE_LIMIT_EDGE_CONFIG,
  RATE_LIMIT_STORE,
  RateLimitEdgeConfig,
  RateLimitGuard,
  RateLimitModule,
  RateLimitStore,
} from '@aquaculture/backend-common/rate-limit';
import { RedisModule, RedisService, buildRedisOptions } from '@aquaculture/backend-common/redis';
import { ApolloGatewayDriver, ApolloGatewayDriverConfig } from '@nestjs/apollo';
import { Module, MiddlewareConsumer, NestModule, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
// JwtService is injected by AuthGuard / RemoteGraphQLDataSource for token
// verification. JwtService is provided by PlatformJwtModule (which re-exports
// JwtModule), so we still need the named-type import here for DI metadata.
import { JwtService } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule, StorageConfig } from '@platform/storage';
import type { DocumentNode, GraphQLSchema } from 'graphql';
import depthLimit from 'graphql-depth-limit';
import {
  getComplexity,
  simpleEstimator,
  fieldExtensionsEstimator,
} from 'graphql-query-complexity';

import { BackgroundCompositionManager } from './config/background-composition.manager';
import { CompositionStateModule } from './config/composition-state.module';
import { CompositionStateService } from './config/composition-state.service';
import { FEDERATED_SUBGRAPHS } from './config/federated-subgraphs.generated';
import { buildGatewayEdgeConfig } from './config/rate-limit.config';
import { RetryableIntrospectAndCompose } from './config/retryable-introspect';
import { AuthenticatedDataSource } from './federation/authenticated-data-source';
import type { GatewayContext, RequestWithUser } from './federation/authenticated-data-source';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { AuthGuard } from './guards/auth.guard';
import {
  TokenBlacklistStore,
  TOKEN_BLACKLIST_STORE,
  RedisTokenBlacklistStore,
  InMemoryTokenBlacklistStore,
} from './guards/redis-token-blacklist.store';
import { ApiKeyAuthStrategy } from './guards/strategies/api-key-auth.strategy';
import { BasicAuthStrategy } from './guards/strategies/basic-auth.strategy';
import { TenantIsolationGuard } from './guards/tenant-isolation.guard';
import { HealthModule } from './health/health.module';
import { RequestLoggingInterceptor } from './interceptors/request-logging.interceptor';
import { GatewayMetricsModule } from './metrics/metrics.module';
import { CsrfMiddleware } from './middleware/csrf.middleware';
import {
  CaptureRequestedTenantMiddleware,
  EffectiveTenantMiddleware,
} from './middleware/effective-tenant.middleware';
import { JwtMiddleware } from './middleware/jwt.middleware';
import { RequestValidatorMiddleware } from './middleware/request-validator.middleware';
import { SecurityHeadersMiddleware } from './middleware/security-headers.middleware';
import { createAliasLimitPlugin } from './plugins/graphql-alias-limit.plugin';
import { MarineRoutesModule } from './routes/marine.routes';
import { TenantLookupService } from './services/tenant-lookup.service';
import { UploadModule } from './upload/upload.module';
import { WebSocketModule } from './websocket/websocket.module';

// Module-level logger to avoid re-instantiation per GraphQL operation
const queryComplexityLogger = new Logger('QueryComplexity');

interface QueryComplexityOperationContext {
  request: {
    operationName?: string | null;
    variables?: Record<string, unknown> | null;
  };
  document: DocumentNode;
  schema: GraphQLSchema;
}

function positiveIntConfig(
  configService: ConfigService,
  key: string,
  fallback: number,
): number {
  const raw = configService.get<string | number>(key, fallback);
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

    /**
     * ORPHAN-CRITICAL-059 cure: wire a TypeORM root connection so the
     * AuditedOperationInterceptor's `DataSource` constructor dependency
     * resolves at NestJS DI graph build time. Pre-cure, importing
     * `AuditedOperationModule.forRoot()` here registered the interceptor
     * as a global APP_INTERCEPTOR, but no `TypeOrmModule.forRoot(...)`
     * existed in this AppModule's imports[] — so when Nest tried to
     * instantiate `AuditedOperationInterceptor(reflector, dataSource)`
     * at cold boot, it failed with:
     *
     *   "Nest can't resolve dependencies of the AuditedOperationInterceptor
     *    (Reflector, ?). Please make sure that the argument DataSource at
     *    index [1] is available in the AuditedOperationModule module."
     *
     * The crash blocked NestFactory.create() before any HTTP server bound,
     * which then blocked the gateway's /health/live → blocked the droplet
     * compose healthcheck → blocked every login flow proxied through
     * gateway-api. by-okan@live.com could not authenticate against the
     * production droplet for ~2 days. The regression was masked while the
     * older deployed image was still running because that image's
     * AuditedOperationInterceptor signature didn't yet include DataSource.
     * Today's cold-boot exposed it.
     *
     * # Why gateway-api needs a DB connection at all
     *
     * gateway-api owns NO domain schema (no entities, no migrations) but
     * the platform's mandatory audit-trail contract (AUDITTRAIL-CRITICAL-002)
     * registers `AuditedOperationInterceptor` GLOBALLY in every service.
     * The interceptor's job is to write `shared.audit_logs` rows for any
     * handler decorated with `@AuditedOperation()`. gateway-api currently
     * has zero such handlers — it is a pure GraphQL federation proxy — so
     * the interceptor's `intercept()` short-circuits at the metadata-read
     * gate and never actually runs `dataSource.getRepository(...)`. But
     * the constructor itself must still resolve at module-bootstrap time,
     * which requires the DataSource to be in the DI graph.
     *
     * # Why we register AuditLogEntity in entities[]
     *
     * The interceptor's success path is `dataSource.getRepository(AuditLogEntity)
     * .save(...)`. `getRepository(EntityClass)` requires the entity be in
     * the connection's metadata, which means it must appear in the
     * `entities` array of `TypeOrmModule.forRoot()` (or be picked up by
     * `autoLoadEntities` via a `forFeature` registration). gateway-api
     * has no `forFeature` calls, so we list `AuditLogEntity` explicitly.
     * This makes the interceptor's repo lookup correct on the rare day
     * a future contributor adds an `@AuditedOperation()` decorated handler
     * here — instead of failing with "No metadata for 'AuditLogEntity'".
     *
     * # Why no migrations
     *
     * gateway-api owns no schema. The only table the interceptor would
     * ever touch (`shared.audit_logs`) is created by the postgres init
     * scripts (`infrastructure/docker/init-scripts/10-shared-schema.sql`)
     * + maintained by every domain service that owns `AuditLogModule.forRoot()`.
     * `migrations: []` + `migrationsRun: false` makes it structurally
     * impossible for gateway-api to execute migrations against a schema
     * it doesn't own.
     *
     * # Schema choice: 'shared' (not 'gateway')
     *
     * The compose env var `DATABASE_USER=gateway_service` has its own
     * `gateway` schema reserved by 00-init-schemas.sh:332 ("gateway-api
     * is stateless today but reserves a `gateway` schema for"...). But
     * gateway-api has no entities of its own — the only table it ever
     * needs to resolve is `shared.audit_logs`. Using `schema: 'shared'`
     * sets the no-context connection's default `search_path` to
     * `shared,public`, so the interceptor's `getRepository(AuditLogEntity)`
     * resolves to `shared.audit_logs` without needing a TypeORM-level
     * `@Entity({schema:'shared'})` lookup hop. The `gateway_service`
     * Postgres role already holds USAGE+DML on `shared.audit_logs`
     * via the `shared_schema_owner` group membership granted in
     * `10-shared-schema.sql:78`.
     */
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        createServiceTypeOrmConfig(configService, {
          serviceName: 'gateway',
          schema: 'shared',
          // gateway-api owns NO migrations — see docblock above.
          migrations: [],
          migrationsRun: false,
          // Explicit entity list (instead of autoLoadEntities) so the
          // gateway-api connection only ever knows the entities it actually
          // writes. Adding an entity here without a clear ownership story
          // would silently re-introduce the PR #226 surface that motivated
          // removing RlsModule.forRoot() from this AppModule (see large
          // comment block lower down). Both listed entities have that story:
          //   - AuditLogEntity   → shared.audit_logs, written by the global
          //                        AuditedOperationInterceptor.
          //   - AccessLogEntity  → shared.access_logs, written by the
          //                        AccessLogMiddleware mounted in configure()
          //                        (one row per HTTP request at the single
          //                        external ingress; AUDITTRAIL-HIGH-004).
          // Both are cross-tenant `shared` tables the gateway_service role
          // holds DML on (006-shared-schema-tables.sql GRANTs shared DML to
          // PUBLIC), so the repository lookup resolves against the same
          // search_path='shared' connection.
          entities: [AuditLogEntity, AccessLogEntity],
        }),
    }),

    // AUDITTRAIL-CRITICAL-002 sweep — registers AuditedOperationInterceptor.
    AuditedOperationModule.forRoot(),

    // AUDITTRAIL-HIGH-004: low-level HTTP access-log stream. Registers
    // AccessLogService + the AccessLogEntity repository (forFeature) so the
    // AccessLogMiddleware mounted in configure() can persist one row per
    // request to shared.access_logs. The gateway is the single external
    // ingress, so mounting here (not per-subgraph) yields exactly one
    // authoritative access row per external request — including the 401/403/
    // CSRF/throttle rejections that never reach a subgraph. 90-day retention
    // is enforced by the canonical RetentionEnforcementService policy
    // registered in admin-api's AdminApiRetentionBootstrapModule. Enforced
    // mounted by tests/invariants/access-log-middleware-mounted.spec.ts.
    AccessLogModule.forRoot(),

    // ARCH-GW-006: composition readiness state. Imported BEFORE GraphQLModule so
    // the CompositionStateService singleton is resolvable inside the GraphQL
    // factory's inject[] (where it is handed to the BackgroundCompositionManager)
    // and inside HealthService (which reads it for /health/ready).
    CompositionStateModule,

    // Apollo Federation Gateway
    GraphQLModule.forRootAsync<ApolloGatewayDriverConfig>({
      driver: ApolloGatewayDriver,
      imports: [ConfigModule],
      inject: [ConfigService, CompositionStateService],
      useFactory: (
        configService: ConfigService,
        compositionState: CompositionStateService,
      ) => ({
        gateway: {
          /**
           * ARCH-GW-005 / ARCH-GW-006: Federated subgraph registry, composed in
           * the BACKGROUND.
           *
           * CRITICAL INVARIANT: Every service listed here MUST also appear in:
           *   1. docker-compose.droplet.yml gateway depends_on with
           *      condition: service_started (the compose health gate targets
           *      /health/live, which no longer waits on composition)
           *   2. health.service.ts serviceUrls map (for /health/detail + the
           *      /health/ready subgraph fan-out)
           *
           * ARCH-GW-006: RetryableIntrospectAndCompose still owns the real
           * introspect+retry window, but it now runs INSIDE
           * BackgroundCompositionManager, OFF the NestFactory.create() critical
           * path. initialize() returns a tiny composed placeholder supergraph
           * immediately so the HTTP listener binds in <1s and /health/live
           * answers; the real schema is hot-swapped in later via the same
           * options.update() path IntrospectAndCompose polling uses. A subgraph
           * that never becomes reachable no longer blocks the listener — it just
           * keeps /health/ready reporting not_ready until composition lands.
           *
           * Composition is ALL-OR-NOTHING: if any single subgraph fails
           * introspection, the entire supergraph composition fails. There is no
           * partial composition — hence /health/ready short-circuits to
           * not_ready until the all-or-nothing compose succeeds.
           *
           * Current subgraphs (9):
           *   auth, farm, sensor, alert, hr, billing, hydroponics, config,
           *   notification (BUG-4 FIX), messaging (ADR-012)
           */
          supergraphSdl: new BackgroundCompositionManager({
            state: compositionState,
            retryable: new RetryableIntrospectAndCompose({
              subgraphs: FEDERATED_SUBGRAPHS.map((subgraph) => ({
                name: subgraph.name,
                url: configService.get(subgraph.urlEnv, subgraph.localUrl),
              })),
              pollIntervalInMs: 300000, // Poll for schema changes every 5 minutes
              maxRetries: positiveIntConfig(
                configService,
                'GATEWAY_COMPOSITION_MAX_RETRIES',
                24,
              ),
              retryDelayMs: positiveIntConfig(
                configService,
                'GATEWAY_COMPOSITION_RETRY_DELAY_MS',
                3000,
              ),
            }),
          }),
          buildService({ name, url }) {
            return new AuthenticatedDataSource({ url, serviceAudience: name });
          },
        },
        server: {
          // SECURITY: Disable batched HTTP requests to prevent rate-limit bypass
          // A single HTTP request with many batched operations would count as 1 request
          allowBatchedHttpRequests: false,
          /**
           * Keep Apollo CSRF prevention explicit as defense in depth against
           * cross-site search and simple-request execution paths.
           */
          csrfPrevention: true,
          playground: false,
          graphiql: process.env['NODE_ENV'] !== 'production',
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
              requestDidStart: () => Promise.resolve({
                didResolveOperation({
                  request,
                  document,
                  schema,
                }: QueryComplexityOperationContext): Promise<void> {
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
                    const message = error instanceof Error ? error.message : String(error);
                    logger.warn(`Could not calculate query complexity: ${message}`);
                  }
                  return Promise.resolve();
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
      }),
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

    // AI chat is no longer a REST proxy — it rides the AiChatGateway socket.io
    // bridge (WebSocketModule) over NATS request.ai.chat, and AI settings are a
    // federated GraphQL subgraph (ai-service). The hand-rolled proxy is deleted.

    // Backend-owned marine data REST gateway. Browser code talks to this
    // route only; gateway signs the internal farm-service request.
    MarineRoutesModule,

    // Redis for distributed rate limiting (optional, falls back to in-memory if not configured)
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        buildRedisOptions(configService, 'gateway', 'required'),
    }),

    // Platform rate-limit SSoT (D2 / CRITICAL-002). Edge mode: the gateway is a
    // proxy with no decorated routes, so it supplies a config-driven tier policy
    // (built from env vars) instead of @RateLimit decorators. Imported AFTER
    // RedisModule so the lib's atomic-Lua store resolves the gateway RedisService.
    RateLimitModule.forRoot({ keyPrefix: 'ratelimit:', edge: buildGatewayEdgeConfig }),

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
     * (authorization/isolation) -> RateLimitGuard (platform SSoT; the mutation
     * cap is now an additive tier inside this one guard, not a separate guard).
     * This ensures the user is authenticated before tenant isolation is checked.
     */
    // WHY: useFactory bypasses reflect-metadata resolution which fails in Docker Alpine.
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector): TenantIsolationGuard =>
        new TenantIsolationGuard(reflector),
      inject: [Reflector],
    },
    // Platform rate-limit guard (D2 / CRITICAL-002). ONE guard replaces the
    // former local RateLimitGuard + MutationRateLimitGuard + local store: the
    // config-driven edge policy (tiers + additive GraphQL-mutation cap) and the
    // atomic-Lua store both come from RateLimitModule.forRoot above. It occupies
    // the same slot, so the pre-handler rejection order (AuthGuard ->
    // TenantIsolationGuard -> RateLimit) is preserved.
    {
      provide: APP_GUARD,
      useFactory: (
        reflector: Reflector,
        store?: RateLimitStore,
        edge?: RateLimitEdgeConfig,
      ): RateLimitGuard => new RateLimitGuard(reflector, store, edge),
      inject: [
        Reflector,
        { token: RATE_LIMIT_STORE, optional: true },
        { token: RATE_LIMIT_EDGE_CONFIG, optional: true },
      ],
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

    /**
     * AUDITTRAIL-HIGH-004: low-level HTTP access log, one row per request.
     *
     * Mounted at the entry point (right after security headers, before the
     * identity chain) so `start = Date.now()` measures the fullest request
     * duration. The row is emitted from `res.on('finish')` — AFTER the
     * identity chain below has populated req.user / tenantContext /
     * correlationId — so it captures who/which-tenant without depending on
     * middleware order at `use()` time. Fire-and-forget: a persistence blip
     * never surfaces into the response (see AccessLogService docstring).
     * `forRoutes('*')` deliberately includes REST + GraphQL + 404s + guard
     * rejections — the Express layer sees every request the Nest pipeline
     * would miss.
     */
    consumer
      .apply(AccessLogMiddleware)
      .forRoutes('*');

    consumer
      .apply(
        // Order matters:
        // 1. Record request metrics (before everything else for accurate duration)
        // 2. Set correlation id for tracing
        // 3. Capture the requested act-as tenant BEFORE strip deletes the header
        // 4. SECURITY: Strip spoofable internal headers from external requests
        // 5. SECURITY: CSRF double-submit cookie validation
        // 6. Decode JWT and set req.user (needed for willSendRequest to forward headers)
        // 7. Hydrate user from x-user-payload header (for inter-service calls)
        // 8. Resolve + authority-validate the SINGLE effective tenant (SSoT) the
        //    gateway signs — must run after req.user is set, before context capture
        // 9. Set tenant context
        // 10. Log request
        MetricsMiddleware,
        CorrelationIdMiddleware,
        RequestContextMiddleware,
        CaptureRequestedTenantMiddleware,
        StripInternalHeadersMiddleware,
        CsrfMiddleware,
        JwtMiddleware,
        UserContextMiddleware,
        EffectiveTenantMiddleware,
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
