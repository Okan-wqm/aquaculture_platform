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
import { ClientsModule, Transport } from '@nestjs/microservices';
import { EventBusModule } from '@platform/event-bus';
import { buildNatsTransportOptions } from '@aquaculture/backend-common/nats';
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
import { PlatformJwtModule } from '@aquaculture/backend-common/auth';
import { SourceSchemaBootstrapService, createTenantConnectionBootstrap, createMigrationRunnerService, TenantSchemaSyncService, SourceSchemaWriteGuardService, RlsModule, SchemaDriftModule, createServiceTypeOrmConfig } from '@aquaculture/backend-common/database';
import { RolesGuard, TenantGuard, ServiceIdentityGuard } from '@aquaculture/backend-common/guards';
import { RequestContextMiddleware } from '@aquaculture/backend-common/logging';
import { TenantContextMiddleware, CorrelationIdMiddleware, UserContextMiddleware, createTenantSchemaMiddleware } from '@aquaculture/backend-common/middleware';
import { ThrottlerModule, ThrottlerGuard, SlidingWindowStrategy } from '@aquaculture/backend-common/security';

// Tenant infrastructure — 'messaging' source schema for template tables
const TenantSchemaMiddleware = createTenantSchemaMiddleware('messaging');
const TenantConnectionBootstrap = createTenantConnectionBootstrap('messaging');

/**
 * MessagingMigrationRunnerService — runs pending TypeORM migrations in the
 * messaging source schema at OnApplicationBootstrap. Replaces TypeORM's
 * built-in `migrationsRun: true` path so we get the platform's
 * search_path invariant between migrations (closes the 2026-04-07
 * farm-service class of bug where one migration's SET search_path
 * leaked into the next migration's session).
 *
 * Wired as part of the 2026-04-14 messaging-isolation plan (ADR-011
 * convergence). TypeORM's `migrationsRun` flag is explicitly disabled in
 * the forRootAsync factory below so there is exactly one source of
 * truth for migration execution.
 */
const MessagingMigrationRunnerService = createMigrationRunnerService('messaging');

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
import { TenantAiSetting } from './ai/entities/tenant-ai-setting.entity';
import { UserAiConsent } from './ai/entities/user-ai-consent.entity';

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
// P3 of 2026-04-14 messaging-isolation plan — tenantId on 7 child tables;
// prerequisite for the P4 RLS install.
import { AddTenantIdToMessageChildren1782300000000 } from './migrations/1782300000000-AddTenantIdToMessageChildren';
// P4 of 2026-04-14 messaging-isolation plan — canonical tenant_isolation_policy
// on messaging source schema. Tenant-schema clones receive the same policy
// via TenantRlsSyncService (wired by RlsModule.forPoolService syncTenantSchemas: true).
import { EnableRowLevelSecurity1782400000000 } from './migrations/1782400000000-EnableRowLevelSecurity';
import { AlignMessagingEntityDrift1782600000000 } from './migrations/1782600000000-AlignMessagingEntityDrift';
import { AddLegalHoldDualApprover1782700000000 } from './migrations/1782700000000-AddLegalHoldDualApprover';
import { AddMessageAttachmentIsDeletedIndex1782800000000 } from './migrations/1782800000000-AddMessageAttachmentIsDeletedIndex';

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

    // Database connection — uses the platform TypeORM factory.
    // INTENTIONAL: no `schema:` — TenantConnectionBootstrap manages
    // search_path per request. Partitioned tables (messages,
    // message_receipts) require migrations — synchronize stays disabled
    // (factory honours DATABASE_SYNC default false).
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
          // INFRA-CRITICAL-020: env-aware migrationsRun timing.
          // Test E2E (DATABASE_MIGRATIONS_RUN=true) → TypeORM applies
          // migrations at DataSource init, BEFORE NestJS lifecycle hooks
          // fire → SourceSchemaBootstrapService finds tables → no false-fail.
          // Production (DATABASE_MIGRATIONS_RUN=false) → unchanged; aqua-db-migrate
          // runs as a separate container BEFORE service containers start.
          migrationsRunFromEnv: (cs) =>
            cs.get<string>('DATABASE_MIGRATIONS_RUN', 'false') === 'true',
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
            TenantAiSetting,
            UserAiConsent,
          ],
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
            AddTenantIdToMessageChildren1782300000000,
            EnableRowLevelSecurity1782400000000,
            AlignMessagingEntityDrift1782600000000,
            AddLegalHoldDualApprover1782700000000,
            AddMessageAttachmentIsDeletedIndex1782800000000,
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
           * 2026-04-30: Keep Apollo CSRF prevention explicit while Apollo Server 5
           * migration is blocked by the Nest/Apollo peer graph.
           * WHY: Apollo Server 4 remains in the dependency graph, so XS-Search
           * class protections must be fail-closed at runtime.
           */
          csrfPrevention: true,
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
          // 2026-04-30: Deprecated GraphQL Playground is not enabled at runtime.
          // WHY: messaging subgraph developer UI must not rely on deprecated Apollo Playground behavior.
          introspection:
            !isProduction ||
            configService.get('GRAPHQL_INTROSPECTION', 'false') === 'true',
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

    // SECURITY (CRITICAL-001): RS256 asymmetric verification via the shared
    // PlatformJwtModule. messaging-service is a token CONSUMER, not an issuer.
    // Replaced the per-service JwtModule.registerAsync block (WS2.B,
    // 2026-04-14) — single source of truth for all consumer services.
    PlatformJwtModule,

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
     * SECURITY (HIGH-004): Tenant Row-Level Security (schema-per-tenant).
     * Messages carry user/tenant PII — defence-in-depth isolation via RLS
     * means an app-layer tenantId bypass cannot read cross-tenant messages.
     *
     * excludeTables MUST stay in lockstep with the migration
     * 1782400000000-EnableRowLevelSecurity so that runtime
     * TenantRlsSyncService (which sweeps tenant_<uuid>.* schemas) uses
     * the same skip list as the migration that installed policies on
     * the source schema. Divergence would mean a table has RLS on
     * source but none on tenant clones (leak), or vice-versa (orphan
     * policy).
     */
    RlsModule.forPoolService({
      serviceName: 'messaging',
      syncTenantSchemas: true,
      // See P4 migration docblock for rationale:
      // - messaging_outbox: cross-tenant worker reads (BypassRls)
      // - embeddings_metadata: platform-wide reference data (no tenantId)
      excludeTables: ['messaging_outbox', 'embeddings_metadata'],
      tenantIdColumns: ['tenantId'],
    }),
    /** P11 of 2026-04-14 teardown — runtime schema-drift validator. */
    SchemaDriftModule.forRoot({ serviceName: 'messaging' }),
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

    // Migration runner — runs pending TypeORM migrations on the messaging
    // source schema at OnApplicationBootstrap with search_path pinning.
    // See docblock on MessagingMigrationRunnerService above.
    MessagingMigrationRunnerService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(
        // SEC-CRITICAL-002 sweep — strip forged internal headers.
        StripInternalHeadersMiddleware,
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
