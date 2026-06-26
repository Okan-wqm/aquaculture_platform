import { createHash } from 'crypto';
import { join } from 'path';
import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { ApolloFederationDriver, ApolloFederationDriverConfig } from '@nestjs/apollo';
import { DocumentNode, GraphQLError, GraphQLSchema } from 'graphql';
import depthLimit from 'graphql-depth-limit';
import { fieldExtensionsEstimator, getComplexity, simpleEstimator } from 'graphql-query-complexity';
import { PlatformJwtModule } from '@aquaculture/backend-common/auth';
import {
  AuditLogModule,
  AuditLogInterceptor,
  AuditedOperationModule,
} from '@aquaculture/backend-common/audit';
import { TenantErasureTargetModule } from '@aquaculture/backend-common/compliance';
import {
  createServiceTypeOrmConfig,
  createTenantConnectionBootstrap,
  isSchemaDdlOwnedByDbMigrate,
  RlsModule,
  SchemaDriftModule,
  SourceSchemaBootstrapService,
  SourceSchemaWriteGuardService,
  TenantSchemaSyncService,
} from '@aquaculture/backend-common/database';
import { RolesGuard, ServiceIdentityGuard, TenantGuard } from '@aquaculture/backend-common/guards';
import { RequestContextMiddleware } from '@aquaculture/backend-common/logging';
import { ServiceMetricsModule } from '@aquaculture/backend-common/metrics';
import {
  CorrelationIdMiddleware,
  createTenantSchemaMiddleware,
  StripInternalHeadersMiddleware,
  VerifiedUserAssertionMiddleware,
  TenantContextMiddleware,
  UserContextMiddleware,
} from '@aquaculture/backend-common/middleware';
import {
  SlidingWindowStrategy,
  ThrottlerGuard,
  ThrottlerModule,
} from '@aquaculture/backend-common/security';
import { EventBusModule, buildEventBusConfig } from '@platform/event-bus';
const TenantSchemaMiddleware = createTenantSchemaMiddleware('hydroponics');
const TenantConnectionBootstrap = createTenantConnectionBootstrap('hydroponics');
/**
 * PR#363 port — runtime DDL authority gate. In authoritative deployments
 * the per-tenant RLS sweep belongs to aqua-db-migrate's tenant fan-out
 * hardening (SCHEMA_REGISTRY['hydroponics'].postMigrationHardening);
 * local/dev keeps syncTenantSchemas as the historical bootstrap convenience.
 */
const hydroponicsSchemaDdlOwnedByDbMigrate = isSchemaDdlOwnedByDbMigrate(process.env);
import { HydroponicsSetupModule } from './setup/setup.module';
import { HealthModule } from './health/health.module';
import { HydroponicsOutboxModule } from './outbox/hydroponics-outbox.module';
import { HydroponicsOutbox } from './outbox/hydroponics-outbox.entity';

// Entities
import { HydroponicsConfig } from './setup/entities/hydroponics-config.entity';

// Per-process cache for GraphQL complexity results keyed by document hash.
// This avoids recomputing complexity for identical operations on every request.
const complexityCache = new Map<string, number>();

type QueryComplexityOperationContext = {
  request: {
    query?: string;
    operationName?: string;
    variables?: Record<string, unknown>;
  };
  document: DocumentNode;
  schema: GraphQLSchema;
};

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    // Database connection — uses the platform TypeORM factory.
    // INTENTIONAL: no `schema:` — TenantConnectionBootstrap manages
    // search_path per request. INFRA-DB-SSL-001 fix: DB_SSL → DATABASE_SSL.
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        createServiceTypeOrmConfig(configService, {
          serviceName: 'hydroponics',
          schema: 'hydroponics',
          // HydroponicsOutbox must be in TypeORM metadata: explicit entities
          // list disables autoLoadEntities, so OutboxNotifyListener.onModuleInit
          // getMetadata(HydroponicsOutbox) would throw and crash-loop boot.
          entities: [HydroponicsConfig, HydroponicsOutbox],
          migrations: [__dirname + '/database/migrations/[0-9]*.{js,ts}'],
          // INFRA-CRITICAL-020 contract: env-aware migration timing.
          // - Production: DATABASE_MIGRATIONS_RUN=false (default). The
          //   aqua-db-migrate container runs migrations BEFORE service
          //   containers start, so this service's TypeORM does NOT touch
          //   the migration table at boot — MigrationRunnerService below
          //   verifies the schema is healthy and proceeds.
          // - E2E tests: harness sets DATABASE_MIGRATIONS_RUN=true so
          //   TypeORM runs migrations at DataSource init — BEFORE the
          //   SourceSchemaBootstrapService onApplicationBootstrap hook
          //   fires, which would otherwise hard-fail on an empty source
          //   schema (INFRA-CRITICAL-009, INFRA-CRITICAL-020).
          migrationsRunFromEnv: (cs) =>
            cs.get<string>('DATABASE_MIGRATIONS_RUN', 'false') === 'true',
        }),
    }),
    GraphQLModule.forRootAsync<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const isProduction = configService.get('NODE_ENV') === 'production';
        return {
          autoSchemaFile: {
            federation: 2,
            path: join(process.cwd(), 'dist/graphql/subgraphs/hydroponics.graphql'),
          },
          /** SEC-M21: Disable GraphQL query batching to prevent batch-based brute-force attacks.
           *  The gateway already blocks batching, but subgraphs must also enforce this as
           *  defense-in-depth in case a subgraph becomes directly accessible. */
          allowBatchedHttpRequests: false,
          /**
           * 2026-04-30: Keep Apollo CSRF prevention explicit while Apollo Server 5
           * migration is blocked by the Nest/Apollo peer graph.
           * WHY: Apollo Server 4 remains in the dependency graph, so XS-Search
           * class protections must be fail-closed at runtime.
           */
          csrfPrevention: true,
          validationRules: [depthLimit(10)],
          plugins: [
            {
              requestDidStart: async () => ({
                async didResolveOperation({
                  request,
                  document,
                  schema,
                }: QueryComplexityOperationContext) {
                  // Cache complexity by document hash to avoid re-computation for
                  // identical operations. The hash key incorporates the operation name
                  // so distinct named operations in the same document are treated separately.
                  const docSource = request.query ?? '';
                  const opName = request.operationName ?? '';
                  /** SEC-L01: Use SHA-256 instead of deprecated SHA-1 for cache key generation.
                   *  SHA-1 has known collision vulnerabilities (SHAttered attack, 2017). */
                  const cacheKey = createHash('sha256')
                    .update(docSource)
                    .update('\x00')
                    .update(opName)
                    .digest('hex');

                  let complexity = complexityCache.get(cacheKey);
                  if (complexity === undefined) {
                    complexity = getComplexity({
                      schema,
                      operationName: request.operationName,
                      query: document,
                      variables: request.variables,
                      estimators: [
                        fieldExtensionsEstimator(),
                        simpleEstimator({ defaultComplexity: 1 }),
                      ],
                    });
                    complexityCache.set(cacheKey, complexity);
                  }

                  const maxComplexity = 1000;
                  if (complexity > maxComplexity) {
                    throw new GraphQLError(
                      `Query too complex: ${complexity}. Maximum allowed: ${maxComplexity}`,
                    );
                  }
                },
              }),
            },
          ],
          /**
           * 2026-04-30: Deprecated GraphQL Playground is not enabled at runtime.
           * WHY: subgraphs must not depend on deprecated Apollo developer UI behavior.
           */
          /** SEC-NEW06: Disable introspection override — gateway handles introspection centrally.
           *  Subgraph introspection in production exposes internal schema details. */
          introspection: !isProduction,
          context: ({ req }: { req: Request }) => ({ req }),
        };
      },
    }),
    // NOTE: CqrsModule intentionally omitted — no CQRS handlers are wired in this service yet.
    // Re-add CqrsModule.forRoot() once actual command/query handlers are implemented.
    //
    // SECURITY (CRITICAL-001): RS256 asymmetric verification via the shared
    // PlatformJwtModule. hydroponics-service is a token CONSUMER, not an issuer.
    //
    // History: this service was missed in the HS256 -> RS256 migration
    // (commit 7c076361). It stayed on the legacy
    // configService.getOrThrow('JWT_SECRET') path and crashed at boot on
    // 2026-04-14 when JWT_SECRET stopped being provisioned. The mirror-fix
    // commit (607f9d9d) copied the canonical block from farm-service —
    // which left ten copies of the same wiring in the tree, exactly the
    // drift surface this WS exists to eliminate. PlatformJwtModule (WS2.B)
    // is the structural answer: one source of truth, no per-service block
    // to forget.
    PlatformJwtModule,
    EventBusModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: buildEventBusConfig,
    }),
    HydroponicsOutboxModule,
    TenantErasureTargetModule.forService('hydroponics-service'),
    // Rate limiting: applies sliding-window throttling to all GraphQL and REST endpoints.
    // Limits are configurable via THROTTLE_DEFAULT_LIMIT, THROTTLE_DEFAULT_TTL,
    // THROTTLE_ANONYMOUS_LIMIT, and THROTTLE_ENABLED environment variables.
    ThrottlerModule,
    HydroponicsSetupModule,
    HealthModule,
    // OBS-HIGH-001: Prometheus GET /metrics scrape endpoint + HTTP metrics
    // middleware (self-contained platform module — controller is @Public()).
    ServiceMetricsModule,
    /** SEC-M22: Audit trail infrastructure for compliance tracking. */
    AuditLogModule.forRoot(),
    // AUDITTRAIL-CRITICAL-002 sweep — registers AuditedOperationInterceptor.
    AuditedOperationModule.forRoot(),
    /** SECURITY (HIGH-004): Tenant RLS (schema-per-tenant hydroponics). */
    RlsModule.forPoolService({
      serviceName: 'hydroponics',
      // PR#363 port: runtime per-tenant RLS sweep only when db-migrate is
      // NOT authoritative — production tenants get the same policies from
      // the db-migrate tenant fan-out hardening.
      syncTenantSchemas: !hydroponicsSchemaDdlOwnedByDbMigrate,
      excludeTables: ['hydroponics_outbox'],
    }),
    /** P11 of 2026-04-14 teardown — runtime schema-drift validator. */
    SchemaDriftModule.forRoot({ serviceName: 'hydroponics' }),
  ],
  providers: [
    // SECURITY: Service identity guard - validates HMAC-signed service identity headers
    // Must be FIRST guard (before tenant/roles/throttler) to verify request origin
    // WHY: useFactory bypasses reflect-metadata resolution which fails in Docker Alpine.
    {
      provide: APP_GUARD,
      useFactory: (configService: ConfigService): ServiceIdentityGuard =>
        new ServiceIdentityGuard(configService, undefined, 'hydroponics-service'),
      inject: [ConfigService],
    },
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector, configService: ConfigService): TenantGuard =>
        new TenantGuard(reflector, undefined, configService),
      inject: [Reflector, ConfigService],
    },
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector): RolesGuard => new RolesGuard(reflector),
      inject: [Reflector],
    },
    {
      provide: APP_GUARD,
      useFactory: (
        reflector: Reflector,
        configService: ConfigService,
        rateLimiter: SlidingWindowStrategy,
      ): ThrottlerGuard => new ThrottlerGuard(reflector, configService, rateLimiter),
      inject: [Reflector, ConfigService, SlidingWindowStrategy],
    },
    /** SEC-M22: Register global audit logging for compliance — all mutations are tracked. */
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditLogInterceptor,
    },
    // Bootstrap source schema tables on startup (creates template tables if missing)
    SourceSchemaBootstrapService,
    // Pool-level tenant schema routing (patches pg Pool.connect for search_path injection)
    TenantConnectionBootstrap,
    // Auto-sync tenant schemas with source schema (creates missing tables/columns)
    TenantSchemaSyncService,
    // DB-level write guards on source schema (defense-in-depth)
    SourceSchemaWriteGuardService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Middleware execution order:
    // 1. CorrelationIdMiddleware - Add correlation ID for request tracing
    // 2. UserContextMiddleware - Parse x-user-payload header from gateway
    // 3. TenantContextMiddleware - Extract tenant from JWT/headers
    // 4. TenantSchemaMiddleware - Set PostgreSQL search_path to tenant schema
    consumer
      .apply(
        // SEC-CRITICAL-002 sweep — strip forged internal headers.
        StripInternalHeadersMiddleware,
        // SEC-HIGH-156: resolve req.user/req.tenantId from the gateway-signed
        // verified-user assertion (runs after Strip sets req.verifiedIdentity,
        // before UserContext/TenantContext).
        VerifiedUserAssertionMiddleware,
        CorrelationIdMiddleware,
        RequestContextMiddleware, // Populate AsyncLocalStorage for structured logging
        UserContextMiddleware,
        TenantContextMiddleware,
        TenantSchemaMiddleware,
      )
      // Express v5 path-to-regexp v8: named wildcard required instead of regex capture group
      .exclude('health', 'health/{*path}')
      .forRoutes('*');
  }
}
