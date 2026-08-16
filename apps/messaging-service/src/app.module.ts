/**
 * @module AppModule
 * @description Root module for the messaging-service. Configures TypeORM with
 * tenant schema isolation, GraphQL Federation v2 subgraph, CQRS, NATS microservice
 * transport, JWT auth, rate limiting, and all feature modules.
 * @see ADR-012 section 1 (Architecture Overview)
 */
import { createHash } from 'crypto';
import { join } from 'path';
import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import { CqrsModule } from '@nestjs/cqrs';
import { ScheduleModule } from '@nestjs/schedule';
import { ClientsModule } from '@nestjs/microservices';
import { EventBusModule, buildEventBusConfig } from '@platform/event-bus';
import { NatsV3Client } from '@aquaculture/backend-common/nats';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ApolloFederationDriver, ApolloFederationDriverConfig } from '@nestjs/apollo';
import { DocumentNode, GraphQLError, GraphQLSchema } from 'graphql';
import depthLimit from 'graphql-depth-limit';
import { fieldExtensionsEstimator, getComplexity, simpleEstimator } from 'graphql-query-complexity';
import { PlatformJwtModule } from '@aquaculture/backend-common/auth';
import { AuditedOperationModule } from '@aquaculture/backend-common/audit';
import { TenantErasureTargetModule } from '@aquaculture/backend-common/compliance';
import {
  createSchemaVersionGate,
  createServiceTypeOrmConfig,
  createTenantConnectionBootstrap,
  RlsModule,
  getRlsExcludeTablesForService,
  SchemaDriftModule,
  SourceSchemaBootstrapService,
  TenantSchemaSyncService,
  TenantSchemaCacheModule,
} from '@aquaculture/backend-common/database';
import { TenantExecutionContextModule } from '@aquaculture/backend-common/context';
import { RolesGuard, ServiceIdentityGuard, TenantGuard } from '@aquaculture/backend-common/guards';
import { RequestContextMiddleware } from '@aquaculture/backend-common/logging';
import { RedisModule, buildRedisOptions } from '@aquaculture/backend-common/redis';
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

// Tenant infrastructure — 'messaging' source schema for template tables
const TenantSchemaMiddleware = createTenantSchemaMiddleware('messaging');
const TenantConnectionBootstrap = createTenantConnectionBootstrap('messaging');
const runtimeTenantRlsSyncEnabled = process.env['DB_MIGRATE_DDL_AUTHORITY'] === '1';

/**
 * MessagingMigrationRunnerService — runs pending TypeORM migrations in the
 * messaging source schema at OnApplicationBootstrap. Replaces TypeORM's
 * built-in `migrationsRun: true` path so we get the platform's
 * search_path invariant between migrations (closes the 2026-04-07
 * farm-service class of bug where one migration's session search_path
 * leaked into the next migration's session).
 *
 * Wired as part of the 2026-04-14 messaging-isolation plan (ADR-011
 * convergence). TypeORM's `migrationsRun` flag is explicitly disabled in
 * the forRootAsync factory below so there is exactly one source of
 * truth for migration execution.
 */
const MessagingMigrationRunnerService = createSchemaVersionGate('messaging');

// Entities
import { Channel } from './channel/entities/channel.entity';
import { ChannelMember } from './channel/entities/channel-member.entity';
import { Message } from './message/entities/message.entity';
import { MessageAttachment } from './message/entities/message-attachment.entity';
import { MessageSendIdempotency } from './message/entities/message-send-idempotency.entity';
import { MessageReceipt } from './message/entities/message-receipt.entity';
import { MessageReceiptLedger } from './message/entities/message-receipt-ledger.entity';
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
import { UserAiConsent } from './ai/entities/user-ai-consent.entity';

// Migrations — imported as class references so webpack bundles them into main.js.
// Glob paths ('dist/migrations/*.js') do NOT work with NX webpack builds because
// all source files are bundled into a single output file.
// Baseline1800000000000 plus forward repair migrations after day-one reset (ADR-030).
import { Baseline1800000000000 } from './migrations/1800000000000-Baseline';
import { CreateMessagingOutboxTable1800200000000 } from './migrations/1800200000000-CreateMessagingOutboxTable';
import { AddUserAiConsentTenantUserUnique1800300000000 } from './migrations/1800300000000-AddUserAiConsentTenantUserUnique';
import { EnforceSourceOnlyMessagingOutboxContract1800400000000 } from './migrations/1800400000000-EnforceSourceOnlyMessagingOutboxContract';
import { EnsureMessagingPartitionContract1800500000000 } from './migrations/1800500000000-EnsureMessagingPartitionContract';
import { CreateMessageSendIdempotencyLedger1800600000000 } from './migrations/1800600000000-CreateMessageSendIdempotencyLedger';
import { AddMessagesEmbeddingColumn1800700000000 } from './migrations/1800700000000-AddMessagesEmbeddingColumn';
import { CreateMessageReceiptLedger1800800000000 } from './migrations/1800800000000-CreateMessageReceiptLedger';
import { EnsureMessagingTenantErasureProofLedger1801000000000 } from './migrations/1801000000000-EnsureMessagingTenantErasureProofLedger';
import { DropChannelAiServiceUrl1802000000000 } from './migrations/1802000000000-DropChannelAiServiceUrl';
import { DropTenantAiSettings1802100000000 } from './migrations/1802100000000-DropTenantAiSettings';
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
    // search_path per request. Partitioned tables (messages,
    // message_receipts) require migrations — synchronize is structurally
    // disabled by the shared TypeORM factory.
    // MessagingMigrationRunnerService (provider above) executes migrations
    // at OnApplicationBootstrap; factory's migrationsRun:false default
    // keeps TypeORM out of that codepath.
    // INFRA-DB-SSL-001 fix: DB_SSL → DATABASE_SSL via factory.
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        createServiceTypeOrmConfig(configService, {
          serviceName: 'messaging',
          schema: 'messaging',
          // INFRA-CRITICAL-020: keep TypeORM's built-in runner behind an
          // explicit env switch. Messaging E2E leaves this false and enables
          // the platform migration runner via MIGRATION_RUNNER_ENABLED=true
          // so transaction='none' migrations keep their custom-runner
          // semantics.
          migrationsRunFromEnv: (cs) =>
            cs.get<string>('DATABASE_MIGRATIONS_RUN', 'false') === 'true',
          entities: [
            Channel,
            ChannelMember,
            Message,
            MessageAttachment,
            MessageSendIdempotency,
            MessageReceipt,
            MessageReceiptLedger,
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
            UserAiConsent,
          ],
          // Class references (NOT glob paths) — webpack bundles all into main.js,
          // so 'dist/migrations/*.js' would match zero files at runtime.
          migrations: [
            Baseline1800000000000,
            CreateMessagingOutboxTable1800200000000,
            AddUserAiConsentTenantUserUnique1800300000000,
            EnforceSourceOnlyMessagingOutboxContract1800400000000,
            EnsureMessagingPartitionContract1800500000000,
            CreateMessageSendIdempotencyLedger1800600000000,
            AddMessagesEmbeddingColumn1800700000000,
            CreateMessageReceiptLedger1800800000000,
            EnsureMessagingTenantErasureProofLedger1801000000000,
            DropChannelAiServiceUrl1802000000000,
            DropTenantAiSettings1802100000000,
          ],
        }),
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
          /**
           * Keep Apollo CSRF prevention explicit as defense in depth against
           * cross-site search and simple-request execution paths.
           */
          csrfPrevention: true,
          playground: false,
          graphiql: process.env['NODE_ENV'] !== 'production',
          autoSchemaFile: {
            federation: 2,
            path: join(process.cwd(), 'dist/graphql/subgraphs/messaging.graphql'),
          },
          validationRules: [depthLimit(10)],
          plugins: [
            {
              requestDidStart: async () => ({
                async didResolveOperation({
                  request,
                  document,
                  schema,
                }: QueryComplexityOperationContext) {
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
          // WHY: messaging subgraph developer UI must not rely on deprecated Apollo Playground behavior.
          introspection:
            !isProduction || configService.get('GRAPHQL_INTROSPECTION', 'false') === 'true',
          context: ({ req }: { req: Request }) => ({ req }),
        };
      },
    }),

    // CQRS for command/query separation
    CqrsModule.forRoot(),
    // AUDITTRAIL-CRITICAL-002 sweep — registers AuditedOperationInterceptor.
    AuditedOperationModule.forRoot(),

    // Scheduled tasks (partition manager, outbox cleanup)
    ScheduleModule.forRoot(),

    // NATS JetStream Event Bus — required by @platform/outbox OutboxWorkerService.
    // The worker publishes via IEventBus.publish() using subject pattern
    // events.{tenantId}.{eventType}, aligned with platform event-contracts.
    EventBusModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: buildEventBusConfig,
    }),

    /** SEC-H01: NATS client with shared auth factory — used by NestJS microservice
     * transport (@MessagePattern handlers). Kept separate from EventBusModule
     * because ClientProxy uses core NATS request-reply, not JetStream. */
    ClientsModule.register([
      {
        name: 'NATS_SERVICE',
        customClass: NatsV3Client,
        options: { serviceName: 'messaging-service' },
      },
    ]),

    // SECURITY (CRITICAL-001): RS256 asymmetric verification via the shared
    // PlatformJwtModule. messaging-service is a token CONSUMER, not an issuer.
    // Replaced the per-service JwtModule.registerAsync block (WS2.B,
    // 2026-04-14) — single source of truth for all consumer services.
    PlatformJwtModule,

    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        buildRedisOptions(configService, 'messaging', 'required'),
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
    TenantErasureTargetModule.forService('messaging-service'),
    GdprModule,
    ComplianceModule,
    EventHandlersModule,
    AiModule,
    MessagingNotificationModule,
    MetricsModule,

    /**
     * SECURITY (HIGH-004): Tenant Row-Level Security (schema-per-tenant).
     * Messages carry user/tenant PII — defence-in-depth isolation via RLS
     * means an app-layer tenantId bypass cannot read cross-tenant messages.
     *
     * Tenant schema RLS DDL is owned by db-migrate/provisioner. Runtime
     * services do not hold DB_MIGRATE_DDL_AUTHORITY, so registering
     * TenantRlsSyncService in app boot would fail closed by design.
     */
    RlsModule.forPoolService({
      serviceName: 'messaging',
      syncTenantSchemas: runtimeTenantRlsSyncEnabled,
      // See P4 migration docblock for rationale:
      // - messaging_outbox: cross-tenant worker reads (BypassRls)
      // - embeddings_metadata: platform-wide reference data (no tenantId)
      // - message_send_idempotency: source-schema idempotency ledger
      excludeTables: getRlsExcludeTablesForService('messaging'),
      tenantIdColumns: ['tenantId'],
    }),
    /** P11 of 2026-04-14 teardown — runtime schema-drift validator. */
    // Tenant execution context interceptor (SSoT registration) — keeps the
    // validated tenant schema in AsyncLocalStorage across Apollo/CQRS async
    // boundaries so per-tenant search_path routing holds at pg checkout.
    TenantExecutionContextModule,
    // Shared tenant schema-existence cache + TenantProvisioned invalidation
    // (no stale-negative-cache block for freshly provisioned tenants).
    TenantSchemaCacheModule,
    SchemaDriftModule.forRoot({ serviceName: 'messaging' }),
  ],
  providers: [
    // WHY: useFactory bypasses reflect-metadata resolution which fails in Docker Alpine.
    {
      provide: APP_GUARD,
      useFactory: (c: ConfigService): ServiceIdentityGuard =>
        new ServiceIdentityGuard(c, undefined, 'messaging-service'),
      inject: [ConfigService],
    },
    {
      provide: APP_GUARD,
      useFactory: (r: Reflector, c: ConfigService): TenantGuard => new TenantGuard(r, undefined, c),
      inject: [Reflector, ConfigService],
    },
    {
      provide: APP_GUARD,
      useFactory: (r: Reflector): RolesGuard => new RolesGuard(r),
      inject: [Reflector],
    },
    {
      provide: APP_GUARD,
      useFactory: (r: Reflector, c: ConfigService, s: SlidingWindowStrategy): ThrottlerGuard =>
        new ThrottlerGuard(r, c, s),
      inject: [Reflector, ConfigService, SlidingWindowStrategy],
    },

    // Migration runner — runs pending TypeORM migrations on the messaging
    // source schema at OnApplicationBootstrap with search_path pinning.
    // See docblock on MessagingMigrationRunnerService above.
    //
    // SourceSchemaBootstrapService waits on the migration runner's in-process
    // completion promise before checking the source schema. Production still
    // relies on aqua-db-migrate before service containers start; in E2E the
    // runner is the SSoT for migration execution.
    MessagingMigrationRunnerService,

    // Tenant infrastructure providers (all 4 required — see ADR-012 section 6.1)
    SourceSchemaBootstrapService,
    TenantConnectionBootstrap,
    TenantSchemaSyncService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(
        // SEC-CRITICAL-002 sweep — strip forged internal headers.
        StripInternalHeadersMiddleware,
        // SEC-HIGH-156: resolve req.user/req.tenantId from the gateway-signed
        // verified-user assertion (runs after Strip sets req.verifiedIdentity,
        // before UserContext/TenantContext).
        VerifiedUserAssertionMiddleware,
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
