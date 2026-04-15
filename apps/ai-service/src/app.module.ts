import { createHash } from 'crypto';
import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
} from '@nestjs/apollo';
import { GraphQLError } from 'graphql';
import depthLimit from 'graphql-depth-limit';
import { fieldExtensionsEstimator, getComplexity, simpleEstimator } from 'graphql-query-complexity';
import {
  TenantContextMiddleware,
  CorrelationIdMiddleware,
  RequestContextMiddleware,
  UserContextMiddleware,
  RolesGuard,
  TenantGuard,
  ThrottlerModule,
  ThrottlerGuard,
  SlidingWindowStrategy,
  RedisModule,
  SourceSchemaBootstrapService,
  createTenantSchemaMiddleware,
  createTenantConnectionBootstrap,
  TenantSchemaSyncService,
  SourceSchemaWriteGuardService,
  AuditLogModule,
  AuditLogInterceptor,
  AuditColumnsModule,
  RlsModule,
  createMigrationRunnerService,
  SchemaDriftModule,
  PlatformJwtModule,
  createServiceTypeOrmConfig,
} from '@aquaculture/backend-common';
const TenantSchemaMiddleware = createTenantSchemaMiddleware('ai');
const TenantConnectionBootstrap = createTenantConnectionBootstrap('ai');

/**
 * AiMigrationRunnerService — runs pending TypeORM migrations in the ai
 * source schema at OnApplicationBootstrap. Wired in P2d of the 2026-04-14
 * teardown plan to close the RlsSchemaBootstrap docblock gap (lines
 * 14-27).
 *
 * migrations/ starts empty — ai-service currently relies on
 * SourceSchemaBootstrapService + TenantSchemaSyncService. Runner is wired
 * so future migrations can land deterministically.
 */
const AiMigrationRunnerService = createMigrationRunnerService('ai');
import { EventBusModule } from '@platform/event-bus';
import { HealthModule } from './health/health.module';
import { ToolRegistryModule } from './tools/tool-registry.module';
import { WaterChemistryToolsModule } from './tools/water-chemistry/water-chemistry-tools.module';
import { SensorConfigToolsModule } from './tools/sensor-config/sensor-config-tools.module';
import { ConversationModule } from './conversation/conversation.module';
import { AgentConfigModule } from './tenant-config/agent-config.module';
import { AuditModule } from './audit/audit.module';
import { CostModule } from './cost/cost.module';
import { ChatModule } from './chat/chat.module';

// Entities
import { AgentConversation } from './conversation/conversation.entity';
import { TenantAgentConfig } from './tenant-config/agent-config.entity';
import { ToolExecutionAudit } from './audit/tool-execution-audit.entity';

// Per-process cache for GraphQL complexity results keyed by document hash.
// This avoids recomputing complexity for identical operations on every request.
const complexityCache = new Map<string, number>();

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
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
          entities: [AgentConversation, TenantAgentConfig, ToolExecutionAudit],
          migrations: [__dirname + '/database/migrations/*.{js,ts}'],
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
          },
          /** SEC-M21: Disable GraphQL query batching to prevent batch-based brute-force attacks.
           *  The gateway already blocks batching, but subgraphs must also enforce this as
           *  defense-in-depth in case a subgraph becomes directly accessible. */
          allowBatchedHttpRequests: false,
          validationRules: [depthLimit(10)],
          plugins: [
            {
              requestDidStart: async () => ({
                async didResolveOperation({ request, document, schema }) {
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
                      estimators: [fieldExtensionsEstimator(), simpleEstimator({ defaultComplexity: 1 })],
                    });
                    complexityCache.set(cacheKey, complexity);
                  }

                  const maxComplexity = 1000;
                  if (complexity > maxComplexity) {
                    throw new GraphQLError(`Query too complex: ${complexity}. Maximum allowed: ${maxComplexity}`);
                  }
                },
              }),
            },
          ],
          playground: !isProduction && configService.get('GRAPHQL_PLAYGROUND', 'true') === 'true',
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
      useFactory: (configService: ConfigService) => ({
        natsUrl: configService.get<string>('NATS_URL', 'nats://localhost:4222'),
        streamName: configService.get<string>('NATS_STREAM_NAME', 'AQUACULTURE_EVENTS'),
      }),
    }),
    // Redis: Distributed state for rate limiting and token budget counters.
    // WHY: Without Redis, each ai-service instance maintains its own in-memory
    // counters, effectively multiplying rate limits by the instance count.
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        url: configService.get<string>('REDIS_URL', 'redis://localhost:6379'),
      }),
    }),
    // Rate limiting: applies sliding-window throttling to all GraphQL and REST endpoints.
    ThrottlerModule,
    // Tool system
    ToolRegistryModule,
    WaterChemistryToolsModule,
    SensorConfigToolsModule,
    // Feature modules
    HealthModule,
    ConversationModule,
    AgentConfigModule,
    AuditModule,
    CostModule,
    ChatModule,
    /** SEC-M22: Audit trail infrastructure for compliance tracking. */
    AuditLogModule.forRoot(),
    /**
     * SECURITY (HIGH-004): Tenant RLS (schema-per-tenant ai).
     * Conversations and tool executions carry user context — RLS prevents
     * cross-tenant reads if an app-layer check is bypassed.
     */
    RlsModule.forPoolService({
      serviceName: 'ai',
      syncTenantSchemas: true,
      excludeTables: ['ai_outbox'],
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
    AuditColumnsModule.forRoot({ serviceName: 'ai' }),
    /** P11 of 2026-04-14 teardown — runtime schema-drift validator. */
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
      useFactory: (reflector: Reflector): RolesGuard =>
        new RolesGuard(reflector),
      inject: [Reflector],
    },
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector, configService: ConfigService, rateLimiter: SlidingWindowStrategy): ThrottlerGuard =>
        new ThrottlerGuard(reflector, configService, rateLimiter),
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
