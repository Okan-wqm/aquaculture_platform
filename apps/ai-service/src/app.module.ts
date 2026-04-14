import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { Module, NestModule, MiddlewareConsumer, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import { JwtModule } from '@nestjs/jwt';
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
} from '@aquaculture/backend-common';
const TenantSchemaMiddleware = createTenantSchemaMiddleware('ai');
const TenantConnectionBootstrap = createTenantConnectionBootstrap('ai');
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
    // Database connection - NO explicit schema!
    // Schema isolation is handled by TenantSchemaMiddleware via PostgreSQL search_path
    // search_path is set to: "tenant_xxx", ai, public
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const dbPassword = configService.get<string>('DATABASE_PASSWORD');
        if (!dbPassword && process.env['NODE_ENV'] === 'production') {
          throw new Error('SECURITY: DATABASE_PASSWORD must be set in production');
        }
        return {
        type: 'postgres',
        host: configService.get('DATABASE_HOST', 'localhost'),
        port: configService.get<number>('DATABASE_PORT', 5432),
        username: configService.get('DATABASE_USER', 'postgres'),
        password: dbPassword || 'postgres',
        database: configService.get('DATABASE_NAME', 'aquaculture'),
        // NOTE: Do NOT set 'schema' here! Schema is managed dynamically by TenantSchemaMiddleware
        entities: [
          AgentConversation,
          TenantAgentConfig,
          ToolExecutionAudit,
        ],
        synchronize: configService.get('DATABASE_SYNC') === 'true' && configService.get('NODE_ENV') !== 'production',
        logging: configService.get('NODE_ENV') === 'development',
        ssl: (() => {
          const sslEnabled = configService.get('DB_SSL') === 'true';
          if (!sslEnabled) return false;

          const isProduction = configService.get('NODE_ENV') === 'production';
          const caPath = configService.get<string>('DATABASE_SSL_CA');
          const rejectUnauthorized = configService.get('DATABASE_SSL_REJECT_UNAUTHORIZED', 'true') !== 'false';

          if (isProduction && !rejectUnauthorized && !caPath) {
            new Logger('TypeORM').warn('SECURITY: SSL certificate verification disabled in production. Set DATABASE_SSL_CA for MITM protection.');
          }

          return {
            rejectUnauthorized,
            ...(caPath ? { ca: readFileSync(caPath) } : {}),
          };
        })(),
        extra: {
          max: configService.get<number>('DB_POOL_SIZE', 5),
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000,
          // Default search_path targets the source schema so TypeORM sync/migrations
          // create tables there. TenantConnectionBootstrap overrides per-request.
          options: '-c search_path=ai,public',
        },
      };
      },
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
    // SECURITY (CRITICAL-001): RS256 asymmetric verification — public key only.
    // ai-service is a token CONSUMER, not an issuer. It verifies tokens using
    // the RSA public key from auth-service. JWT_SECRET is no longer accepted.
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const { getJwtVerifyOptions } = require('@aquaculture/backend-common');
        const verifyOpts = getJwtVerifyOptions(configService);
        return {
          publicKey: verifyOpts.publicKey,
          verifyOptions: {
            algorithms: ['RS256'],
            issuer: verifyOpts.issuer,
            audience: verifyOpts.audience,
          },
        };
      },
    }),
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
    RlsModule.forRoot({
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
  ],
  providers: [
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
