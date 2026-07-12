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
  AuditColumnsModule,
  createSchemaVersionGate,
  createServiceTypeOrmConfig,
  createTenantConnectionBootstrap,
  isSchemaDdlOwnedByDbMigrate,
  RlsModule,
  getRlsExcludeTablesForService,
  SchemaDriftModule,
  SourceSchemaBootstrapService,
  SourceSchemaWriteGuardService,
  TenantSchemaSyncService,
  TenantSchemaCacheModule,
} from '@aquaculture/backend-common/database';
import { TenantExecutionContextModule } from '@aquaculture/backend-common/context';
import { RolesGuard, TenantGuard } from '@aquaculture/backend-common/guards';
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
import { RedisModule } from '@aquaculture/backend-common/redis';
import { CircuitBreakerModule } from '@aquaculture/backend-common/resilience';
import {
  SlidingWindowStrategy,
  ThrottlerGuard,
  ThrottlerModule,
} from '@aquaculture/backend-common/security';
const TenantSchemaMiddleware = createTenantSchemaMiddleware('ai');
const TenantConnectionBootstrap = createTenantConnectionBootstrap('ai');

/**
 * AiMigrationRunnerService — schema-version gate for the ai source schema
 * (Faz 1.5 of the day-one baseline reset).
 *
 * Was `createMigrationRunnerService('ai')`. Now uses
 * `createSchemaVersionGate('ai')`:
 *
 *   • production (`DB_MIGRATE_AUTHORITATIVE=true`) — read-only ledger
 *     probe; refuses boot if aqua-db-migrate has not finalised `ai`.
 *   • development (default)                       — delegates to the
 *     runner verbatim, preserving dev/test ergonomics.
 *
 * migrations/ starts empty — ai-service currently relies on
 * SourceSchemaBootstrapService + TenantSchemaSyncService. The gate is
 * wired so future migrations land deterministically through
 * aqua-db-migrate.
 */
const AiMigrationRunnerService = createSchemaVersionGate('ai');
const aiSchemaDdlOwnedByDbMigrate = isSchemaDdlOwnedByDbMigrate(process.env);
import { EventBusModule, buildEventBusConfig } from '@platform/event-bus';
import { HealthModule } from './health/health.module';
import { ToolRegistryModule } from './tools/tool-registry.module';
import { WaterChemistryToolsModule } from './tools/water-chemistry/water-chemistry-tools.module';
import { SensorConfigToolsModule } from './tools/sensor-config/sensor-config-tools.module';
import { FarmToolsModule } from './tools/farm/farm-tools.module';
import { ConversationModule } from './conversation/conversation.module';
import { AgentConfigModule } from './tenant-config/agent-config.module';
import { AuditModule } from './audit/audit.module';
import { CostModule } from './cost/cost.module';
import { ChatModule } from './chat/chat.module';
import { AiOutboxModule } from './outbox/ai-outbox.module';

// Entities
import { AgentConversation } from './conversation/conversation.entity';
import { ActionsModule } from './actions/actions.module';
import { ProposedAction } from './actions/proposed-action.entity';
import { TenantAgentConfig } from './tenant-config/agent-config.entity';
import { ToolExecutionAudit } from './audit/tool-execution-audit.entity';
import { AiOutbox } from './outbox/ai-outbox.entity';

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
    // CIRCUIT-CRITICAL-001 cure: register the @Global canonical
    // CircuitBreakerService so feature modules (AgentRunnerService at
    // ai-service/src/agent/...) can constructor-inject it without
    // per-module re-import. Wraps the Anthropic API call (and any
    // future external IO) in a sliding-window breaker with fail-CLOSED
    // semantics and per-tenant keying.
    CircuitBreakerModule,
    // Database connection — uses the platform TypeORM factory.
    // INTENTIONAL: no `schema:` — TenantConnectionBootstrap manages
    // search_path per request. AiMigrationRunnerService (provider above)
    // executes migrations at OnApplicationBootstrap; factory's
    // migrationsRun:false default keeps TypeORM out of that codepath.
    // INFRA-DB-SSL-001 fix: DB_SSL → DATABASE_SSL via factory.
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        createServiceTypeOrmConfig(configService, {
          serviceName: 'ai',
          schema: 'ai',
          // FAZ0-BOOT-02: AiOutbox MUST be in this list — OutboxModule.forFeature
          // only wires repositories/publishers; the DataSource learns entity
          // metadata solely from here. Omitting it broke outbox repository DI
          // and left the outbox table out of SourceSchemaBootstrap/TenantSchemaSync
          // (messaging-service registers MessagingOutbox the same way).
          entities: [AgentConversation, TenantAgentConfig, ToolExecutionAudit, AiOutbox, ProposedAction],
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
            // Emit the federated SDL to the registry-canonical artifact path so
            // the supergraph build + validate-registry pick up the ai subgraph
            // (must match gatewaySubgraph('ai').schemaArtifactPath in the catalog).
            path: join(process.cwd(), 'dist/graphql/subgraphs/ai.graphql'),
            federation: 2,
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
          // 2026-04-30: Deprecated GraphQL Playground is not enabled at runtime.
          // WHY: subgraphs must not depend on deprecated Apollo developer UI behavior.
          /** SEC-NEW06: Disable introspection override — gateway handles introspection centrally.
           *  Subgraph introspection in production exposes internal schema details. */
          introspection: !isProduction,
          context: ({ req }: { req: Request }) => ({ req }),
        };
      },
    }),
    // SECURITY (CRITICAL-001): RS256 asymmetric verification via the shared
    // PlatformJwtModule. ai-service is a token CONSUMER, not an issuer.
    // Replaced the per-service JwtModule.registerAsync block (WS2.B,
    // 2026-04-14) — single source of truth for all consumer services.
    PlatformJwtModule,
    // Event bus for NATS pub/sub
    EventBusModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: buildEventBusConfig,
    }),
    AiOutboxModule,
    TenantErasureTargetModule.forService('ai-service'),
    // Redis: Distributed state for rate limiting and token budget counters.
    // WHY: Without Redis, each ai-service instance maintains its own in-memory
    // counters, effectively multiplying rate limits by the instance count.
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      // Build the connection from the platform-standard discrete vars
      // (REDIS_HOST/PORT/PASSWORD/DB) that compose provides and the cost
      // services already read — NOT a REDIS_URL that nothing sets, which
      // silently fell back to redis://localhost:6379 and ECONNREFUSED'd in
      // every container (the redis service is reachable as host `redis`).
      useFactory: (configService: ConfigService) => {
        const host = configService.get<string>('REDIS_HOST', 'localhost');
        const port = configService.get<number>('REDIS_PORT', 6379);
        const password = configService.get<string>('REDIS_PASSWORD');
        const db = configService.get<number>('REDIS_DB', 0);
        const auth = password ? `:${encodeURIComponent(password)}@` : '';
        return { url: `redis://${auth}${host}:${port}/${db}` };
      },
    }),
    // Rate limiting: applies sliding-window throttling to all GraphQL and REST endpoints.
    ThrottlerModule,
    // Tool system
    ToolRegistryModule,
    WaterChemistryToolsModule,
    SensorConfigToolsModule,
    FarmToolsModule,
    // Feature modules
    HealthModule,
    // OBS-HIGH-001: Prometheus GET /metrics scrape endpoint + HTTP metrics
    // middleware (self-contained platform module — controller is @Public()).
    ServiceMetricsModule,
    ConversationModule,
    AgentConfigModule,
    AuditModule,
    CostModule,
    ChatModule,
    // MOB-HIGH-001: human-in-the-loop actuation — proposal persistence +
    // the request.ai.executeAction responder.
    ActionsModule,
    /** SEC-M22: Audit trail infrastructure for compliance tracking. */
    AuditLogModule.forRoot(),
    // AUDITTRAIL-CRITICAL-002 sweep — registers AuditedOperationInterceptor.
    AuditedOperationModule.forRoot(),
    /**
     * SECURITY (HIGH-004): Tenant RLS (schema-per-tenant ai).
     * Conversations and tool executions carry user context — RLS prevents
     * cross-tenant reads if an app-layer check is bypassed.
     */
    RlsModule.forPoolService({
      serviceName: 'ai',
      syncTenantSchemas: !aiSchemaDdlOwnedByDbMigrate,
      excludeTables: getRlsExcludeTablesForService('ai'),
    }),
    /**
     * NEW-H1: Convert TIMESTAMP audit columns to TIMESTAMPTZ at cold start.
     *
     * ai-service is schema-per-tenant (mirrors farm/sensor/hr/messaging)
     * but currently has no TypeORM migration runner — schema concerns
     * are delivered through SourceSchemaBootstrapService and the related
     * tenant-sync services. The audit-column bootstrap follows the same
     * lifecycle and is idempotent.
     */
    ...(aiSchemaDdlOwnedByDbMigrate ? [] : [AuditColumnsModule.forRoot({ serviceName: 'ai' })]),
    /** P11 of 2026-04-14 teardown — runtime schema-drift validator. */
    // Tenant execution context interceptor (SSoT registration) — keeps the
    // validated tenant schema in AsyncLocalStorage across Apollo/CQRS async
    // boundaries so per-tenant search_path routing holds at pg checkout.
    TenantExecutionContextModule,
    // Shared tenant schema-existence cache + TenantProvisioned invalidation
    // (no stale-negative-cache block for freshly provisioned tenants).
    TenantSchemaCacheModule,
    SchemaDriftModule.forRoot({ serviceName: 'ai' }),
  ],
  providers: [
    // Migration runner — see const declaration near top of file.
    AiMigrationRunnerService,
    // WHY: useFactory bypasses reflect-metadata resolution which fails in Docker Alpine.
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
    // SEC-CRITICAL-002 sweep — strip forged internal headers (safe on all routes
    // except the health probe).
    consumer
      .apply(StripInternalHeadersMiddleware)
      .exclude('health', 'health/{*path}')
      .forRoutes('*');

    // SEC-HIGH-156: resolve req.user/req.tenantId from the gateway-signed
    // verified-user assertion (after Strip sets req.verifiedIdentity, before
    // UserContext). EXCLUDED from /api/v2/ai/*: the AI chat REST surface arrives
    // via the gateway's REST proxy (routes/v2/ai.routes.ts), which forwards only
    // an allowlist of headers and does NOT sign a gateway service identity, so
    // requiring the assertion there would 400 in production — that path still
    // authenticates via the JWT guard + x-tenant-id. Both prefix forms excluded
    // to fail safe.
    consumer
      .apply(VerifiedUserAssertionMiddleware)
      .exclude(
        'health',
        'health/{*path}',
        'api/v2/ai',
        'api/v2/ai/{*path}',
        'api/v1/api/v2/ai',
        'api/v1/api/v2/ai/{*path}',
      )
      .forRoutes('*');

    consumer
      .apply(
        CorrelationIdMiddleware,
        RequestContextMiddleware, // Populate AsyncLocalStorage for structured logging
        UserContextMiddleware,
        TenantContextMiddleware,
        TenantSchemaMiddleware,
      )
      .exclude('health', 'health/{*path}')
      .forRoutes('*');
  }
}
