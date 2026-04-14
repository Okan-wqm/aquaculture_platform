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
import { Module, NestModule, MiddlewareConsumer, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import { JwtModule } from '@nestjs/jwt';
import { CqrsModule } from '@nestjs/cqrs';
import { ScheduleModule } from '@nestjs/schedule';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { EventBusModule } from '@platform/event-bus';
import { buildNatsTransportOptions } from '@aquaculture/backend-common';
import { APP_GUARD, Reflector } from '@nestjs/core';
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
  SlidingWindowStrategy,
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
import { ConvertMessagingOutboxToIdentity1781200000000 } from './migrations/1781200000000-ConvertMessagingOutboxToIdentity';
import { AddCompositeFkIndexesOnMessageChildren1781600000000 } from './migrations/1781600000000-AddCompositeFkIndexesOnMessageChildren';
// NEW-H1: convert audit columns from TIMESTAMP to TIMESTAMPTZ across the
// messaging schema. Excludes messaging_outbox to stay in lockstep with the
// outbox migration's invariants (cross-tenant table read by background
// workers). Runs after the outbox IDENTITY conversion is complete; the
// helper is idempotent at the discovery layer so retries are free.
import { ConvertAuditColumnsToTimestamptz1781900000000 } from './migrations/1781900000000-ConvertAuditColumnsToTimestamptz';
// Package 21-26: Tenant isolation, message idempotency, outbox dedup, audit immutability
import { AddTenantIsolationAndAuditImmutability1782000000000 } from './migrations/1782000000000-AddTenantIsolationAndAuditImmutability';
import { AddMessagingOutboxNotifyTrigger1782100000000 } from './migrations/1782100000000-AddMessagingOutboxNotifyTrigger';
import { AddMissingOutboxColumns1782200000000 } from './migrations/1782200000000-AddMissingOutboxColumns';

// Feature modules
import { HealthModule } from './health/health.module';
import { ChannelModule } from './channel/channel.module';
import { MessageModule } from './message/message.module';
import { PresenceModule } from './presence/presence.module';
import { PartitionModule } from './partition/partition.module';
import { MessagingOutboxModule } from './outbox/messaging-outbox.module';
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
            ConvertMessagingOutboxToIdentity1781200000000,
            AddCompositeFkIndexesOnMessageChildren1781600000000,
            ConvertAuditColumnsToTimestamptz1781900000000,
            AddTenantIsolationAndAuditImmutability1782000000000,
            AddMessagingOutboxNotifyTrigger1782100000000,
            AddMissingOutboxColumns1782200000000,
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
              new Logger('TypeORM').warn('SECURITY: SSL certificate verification disabled in production. Set DATABASE_SSL_CA for MITM protection.');
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

    // NATS JetStream Event Bus — required by @platform/outbox OutboxWorkerService.
    // The worker publishes via IEventBus.publish() using subject pattern
    // events.{tenantId}.{eventType}, aligned with platform event-contracts.
    EventBusModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        natsUrl: configService.get('NATS_URL', 'nats://localhost:4222'),
        streamName: configService.get('NATS_STREAM_NAME', 'AQUACULTURE_EVENTS'),
      }),
    }),

    /** SEC-H01: NATS client with shared auth factory — used by NestJS microservice
     * transport (@MessagePattern handlers). Kept separate from EventBusModule
     * because ClientProxy uses core NATS request-reply, not JetStream. */
    ClientsModule.register([
      {
        name: 'NATS_SERVICE',
        transport: Transport.NATS,
        options: buildNatsTransportOptions('messaging-service'),
      },
    ]),

    // SECURITY (CRITICAL-001): RS256 asymmetric verification — public key only.
    // messaging-service is a token CONSUMER, not an issuer. It verifies tokens
    // using the RSA public key from auth-service. JWT_SECRET is no longer accepted.
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

    // Rate limiting
    ThrottlerModule,

    // Feature modules
    HealthModule,
    ChannelModule,
    MessageModule,
    PresenceModule,
    PartitionModule,
    MessagingOutboxModule,
    GdprModule,
    ComplianceModule,
    EventHandlersModule,
    AiModule,
    MessagingNotificationModule,
    MetricsModule,

    /**
     * SECURITY (HIGH-004): RlsModule deferred for messaging-service.
     * messaging-service has a pre-existing e2e failure in the source-schema
     * write guard that predates this plan. Adding RlsModule here risks
     * conflating RLS test-setup work with the existing SourceSchemaWriteGuard
     * issue. Re-enable once the e2e gate turns green — the other 12 services
     * already cover the broader HIGH-004 remediation.
     *
     * RlsModule.forRoot({
     *   serviceName: 'messaging',
     *   syncTenantSchemas: true,
     *   excludeTables: ['messaging_outbox', 'outbox'],
     * }),
     */
  ],
  providers: [
    // WHY: useFactory bypasses reflect-metadata resolution which fails in Docker Alpine.
    { provide: APP_GUARD, useFactory: (c: ConfigService): ServiceIdentityGuard => new ServiceIdentityGuard(c), inject: [ConfigService] },
    { provide: APP_GUARD, useFactory: (r: Reflector, c: ConfigService): TenantGuard => new TenantGuard(r, undefined, c), inject: [Reflector, ConfigService] },
    { provide: APP_GUARD, useFactory: (r: Reflector): RolesGuard => new RolesGuard(r), inject: [Reflector] },
    { provide: APP_GUARD, useFactory: (r: Reflector, c: ConfigService, s: SlidingWindowStrategy): ThrottlerGuard => new ThrottlerGuard(r, c, s), inject: [Reflector, ConfigService, SlidingWindowStrategy] },

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
