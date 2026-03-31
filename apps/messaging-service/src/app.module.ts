/**
 * @module AppModule
 * @description Root module for the messaging-service. Configures TypeORM with
 * tenant schema isolation, GraphQL Federation v2 subgraph, CQRS, NATS microservice
 * transport, JWT auth, rate limiting, and all feature modules.
 * @see ADR-012 section 1 (Architecture Overview)
 */
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import { JwtModule } from '@nestjs/jwt';
import { CqrsModule } from '@nestjs/cqrs';
import { ScheduleModule } from '@nestjs/schedule';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { APP_GUARD } from '@nestjs/core';
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
} from '@nestjs/apollo';
import { GraphQLError } from 'graphql';
import depthLimit from 'graphql-depth-limit';
import {
  fieldExtensionsEstimator,
  getComplexity,
  simpleEstimator,
} from 'graphql-query-complexity';
import {
  TenantContextMiddleware,
  CorrelationIdMiddleware,
  RequestContextMiddleware,
  UserContextMiddleware,
  RolesGuard,
  TenantGuard,
  ThrottlerModule,
  ThrottlerGuard,
  ServiceIdentityGuard,
  SourceSchemaBootstrapService,
  createTenantSchemaMiddleware,
  createTenantConnectionBootstrap,
  TenantSchemaSyncService,
  SourceSchemaWriteGuardService,
} from '@aquaculture/backend-common';

// Tenant infrastructure — 'messaging' source schema for template tables
const TenantSchemaMiddleware = createTenantSchemaMiddleware('messaging');
const TenantConnectionBootstrap = createTenantConnectionBootstrap('messaging');

// Entities
import { Channel } from './channel/entities/channel.entity';
import { ChannelMember } from './channel/entities/channel-member.entity';
import { Message } from './message/entities/message.entity';
import { MessageAttachment } from './message/entities/message-attachment.entity';
import { MessageReceipt } from './message/entities/message-receipt.entity';
import { MessageReaction } from './message/entities/message-reaction.entity';
import { PinnedMessage } from './message/entities/pinned-message.entity';
import { MessagingOutbox } from './outbox/messaging-outbox.entity';
import { RetentionPolicy } from './compliance/entities/retention-policy.entity';
import { LegalHold } from './compliance/entities/legal-hold.entity';
import { ComplianceAuditLog } from './compliance/entities/compliance-audit-log.entity';

// AI entities (ADR-012 section 12)
import { MessageAnalysis } from './ai/entities/message-analysis.entity';
import { MessageEntityReference } from './ai/entities/message-entity-reference.entity';
import { KnowledgeEntry } from './ai/entities/knowledge-entry.entity';
import { EmbeddingsMetadata } from './ai/entities/embeddings-metadata.entity';

// Migrations — imported as class references so webpack bundles them into main.js.
// Glob paths ('dist/migrations/*.js') do NOT work with NX webpack builds because
// all source files are bundled into a single output file.
import { CreateMessagingTables1711800000000 } from './migrations/1711800000000-CreateMessagingTables';
import { CreateAITables1711800000001 } from './migrations/1711800000001-CreateAITables';
import { AddAiPersonaColumns1711800000002 } from './migrations/1711800000002-AddAiPersonaColumns';
import { CreateComplianceTables1711800000003 } from './migrations/1711800000003-CreateComplianceTables';

// Feature modules
import { HealthModule } from './health/health.module';
import { ChannelModule } from './channel/channel.module';
import { MessageModule } from './message/message.module';
import { PresenceModule } from './presence/presence.module';
import { PartitionModule } from './partition/partition.module';
import { OutboxModule } from './outbox/outbox.module';
import { GdprModule } from './gdpr/gdpr.module';
import { ComplianceModule } from './compliance/compliance.module';
import { EventHandlersModule } from './event-handlers/event-handlers.module';
import { AiModule } from './ai/ai.module';
import { MessagingNotificationModule } from './notification/notification.module';
import { MetricsModule } from './metrics/metrics.module';

// Per-process complexity cache keyed by document hash
const complexityCache = new Map<string, number>();

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),

    // Database connection — NO explicit schema!
    // Schema isolation handled by TenantSchemaMiddleware via PostgreSQL search_path
    // search_path set to: "tenant_xxx", messaging, public
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
          entities: [
            Channel,
            ChannelMember,
            Message,
            MessageAttachment,
            MessageReceipt,
            MessageReaction,
            PinnedMessage,
            MessagingOutbox,
            RetentionPolicy,
            LegalHold,
            ComplianceAuditLog,
            MessageAnalysis,
            MessageEntityReference,
            KnowledgeEntry,
            EmbeddingsMetadata,
          ],
          // ALWAYS false — partitioned tables (messages, message_receipts)
          // require migrations. TypeORM synchronize cannot handle PARTITION BY RANGE.
          synchronize: false,
          // When sync is off (production), run migrations for structural changes.
          migrationsRun:
            configService.get('DATABASE_MIGRATIONS_RUN', 'true') === 'true',
          // Class references (NOT glob paths) — webpack bundles all into main.js,
          // so 'dist/migrations/*.js' would match zero files at runtime.
          migrations: [
            CreateMessagingTables1711800000000,
            CreateAITables1711800000001,
            AddAiPersonaColumns1711800000002,
            CreateComplianceTables1711800000003,
          ],
          logging: configService.get('NODE_ENV') === 'development',
          ssl: (() => {
            const sslEnabled = configService.get('DB_SSL') === 'true';
            if (!sslEnabled) return false;

            const isProduction = configService.get('NODE_ENV') === 'production';
            const caPath = configService.get<string>('DATABASE_SSL_CA');
            const rejectUnauthorized =
              configService.get('DATABASE_SSL_REJECT_UNAUTHORIZED', 'true') !== 'false';

            if (isProduction && !rejectUnauthorized && !caPath) {
              console.warn(
                'WARNING: SSL certificate verification disabled in production!',
              );
            }

            return {
              rejectUnauthorized,
              ...(caPath ? { ca: readFileSync(caPath) } : {}),
            };
          })(),
          extra: {
            max: configService.get<number>('DB_POOL_SIZE', 20),
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
            options: '-c search_path=messaging,public',
          },
        };
      },
    }),

    // GraphQL Federation subgraph
    GraphQLModule.forRootAsync<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const isProduction = configService.get('NODE_ENV') === 'production';
        return {
          /** SEC-M21: Disable GraphQL query batching to prevent batch-based brute-force attacks.
           *  The gateway already blocks batching, but subgraphs must also enforce this as
           *  defense-in-depth in case a subgraph becomes directly accessible. */
          allowBatchedHttpRequests: false,
          autoSchemaFile: {
            federation: 2,
            path: join('/tmp', 'messaging-schema.graphql'),
          },
          validationRules: [depthLimit(10)],
          plugins: [
            {
              requestDidStart: async () => ({
                async didResolveOperation({ request, document, schema }) {
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
          playground:
            !isProduction &&
            configService.get('GRAPHQL_PLAYGROUND', 'true') === 'true',
          introspection:
            !isProduction ||
            configService.get('GRAPHQL_INTROSPECTION', 'false') === 'true',
          context: ({ req }: { req: Request }) => ({ req }),
        };
      },
    }),

    // CQRS for command/query separation
    CqrsModule.forRoot(),

    // Scheduled tasks (partition manager, outbox cleanup)
    ScheduleModule.forRoot(),

    // NATS client for publishing events
    ClientsModule.register([
      {
        name: 'NATS_SERVICE',
        transport: Transport.NATS,
        options: {
          servers: [process.env['NATS_URL'] || 'nats://localhost:4222'],
        },
      },
    ]),

    // JWT for authentication
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: configService.get('JWT_EXPIRES_IN', '1d'),
        },
      }),
    }),

    // Rate limiting
    ThrottlerModule,

    // Feature modules
    HealthModule,
    ChannelModule,
    MessageModule,
    PresenceModule,
    PartitionModule,
    OutboxModule,
    GdprModule,
    ComplianceModule,
    EventHandlersModule,
    AiModule,
    MessagingNotificationModule,
    MetricsModule,
  ],
  providers: [
    // SECURITY: Service identity guard — validates HMAC-signed service identity headers
    { provide: APP_GUARD, useClass: ServiceIdentityGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },

    // Tenant infrastructure providers (all 5 required — see ADR-012 section 6.1)
    SourceSchemaBootstrapService,
    TenantConnectionBootstrap,
    TenantSchemaSyncService,
    SourceSchemaWriteGuardService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(
        CorrelationIdMiddleware,
        RequestContextMiddleware,
        UserContextMiddleware,
        TenantContextMiddleware,
        TenantSchemaMiddleware,
      )
      // Express v5 path-to-regexp v8: named wildcard required instead of regex capture group
      .exclude('health', 'health/{*path}')
      .forRoutes('*');
  }
}
