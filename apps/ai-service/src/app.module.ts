import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
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
} from '@platform/backend-common';
import { EventBusModule } from '@platform/event-bus';
import { TenantSchemaMiddleware } from './middleware/tenant-schema.middleware';
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
            console.warn('WARNING: SSL certificate verification disabled in production!');
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
                  const cacheKey = createHash('sha1')
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
          introspection: !isProduction || configService.get('GRAPHQL_INTROSPECTION', 'false') === 'true',
          context: ({ req }: { req: Request }) => ({ req }),
        };
      },
    }),
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: configService.get('JWT_EXPIRES_IN', '1d') },
      }),
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
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: TenantGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
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
      .exclude('health', 'health/(.*)')
      .forRoutes('*');
  }
}
