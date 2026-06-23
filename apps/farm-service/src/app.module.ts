import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloFederationDriver, ApolloFederationDriverConfig } from '@nestjs/apollo';
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core';
import { join } from 'path';
import { Request } from 'express';
import { DocumentNode, GraphQLError, GraphQLSchema } from 'graphql';
import depthLimit from 'graphql-depth-limit';
import { fieldExtensionsEstimator, getComplexity, simpleEstimator } from 'graphql-query-complexity';
import { PlatformJwtModule } from '@aquaculture/backend-common/auth';
import { LegalHoldModule } from '@aquaculture/backend-common/compliance';
import { SourceSchemaBootstrapService } from '@aquaculture/backend-common/database';
import { RolesGuard, ServiceIdentityGuard, TenantGuard } from '@aquaculture/backend-common/guards';
import { RequestContextMiddleware } from '@aquaculture/backend-common/logging';
import {
  CorrelationIdMiddleware,
  StripInternalHeadersMiddleware,
  TenantContextMiddleware,
  UserContextMiddleware,
  VerifiedUserAssertionMiddleware,
} from '@aquaculture/backend-common/middleware';
import { RedisModule, buildRedisOptions } from '@aquaculture/backend-common/redis';
import { ThrottlerModule } from '@aquaculture/backend-common/security';

/**
 * Extended request interface for GraphQL context
 */
interface GraphQLContextRequest extends Request {
  user?: {
    sub: string;
    tenantId?: string;
    roles: string[];
  };
  tenantId?: string;
}

type QueryComplexityOperationContext = {
  request: {
    operationName?: string;
    variables?: Record<string, unknown>;
  };
  document: DocumentNode;
  schema: GraphQLSchema;
};
import {
  createTenantConnectionBootstrap,
  TenantSchemaSyncService,
  SourceSchemaWriteGuardService,
  RlsModule,
  SchemaDriftModule,
  createServiceTypeOrmConfig,
  isSchemaDdlOwnedByDbMigrate,
} from '@aquaculture/backend-common/database';
import { createTenantSchemaMiddleware } from '@aquaculture/backend-common/middleware';
const TenantSchemaMiddleware = createTenantSchemaMiddleware('farm');
const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
/**
 * PR#363 port — runtime DDL authority gate. In authoritative deployments
 * the per-tenant RLS sweep belongs to aqua-db-migrate's tenant fan-out
 * hardening (SCHEMA_REGISTRY['farm'].postMigrationHardening); local/dev
 * keeps syncTenantSchemas as the historical bootstrap convenience.
 */
const farmSchemaDdlOwnedByDbMigrate = isSchemaDdlOwnedByDbMigrate(process.env);
import { WatchdogCronService } from './infrastructure/watchdog-cron.service';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CqrsModule } from '@platform/cqrs';
import { EventBusModule } from '@platform/event-bus';
import { DatabaseModule } from './database/database.module';
import { FarmMetricsModule } from './common/metrics/farm-metrics.module';
import { FarmAppErrorFilter } from './common/errors/farm-app-error.filter';
import { CacheableModule } from './common/cache/cacheable.module';
import { JsonbPatchModule } from './common/jsonb/jsonb-patch.module';
import { ComplianceModule } from './compliance/compliance.module';
import { StorageModule } from '@platform/storage';
import type { StorageConfig } from '@platform/storage';
import { PermissionMatrixGuard } from './common/authz/permission-matrix.guard';
import { FarmOutboxModule } from './outbox/farm-outbox.module';
import { FarmModule } from './farm/farm.module';
import { HealthModule } from './health/health.module';
import { SpeciesModule } from './species/species.module';
import { TankModule } from './tank/tank.module';
import { BatchModule } from './batch/batch.module';
import { FeedingModule } from './feeding/feeding.module';
import { GrowthModule } from './growth/growth.module';
import { WaterQualityModule } from './water-quality/water-quality.module';
import { FishHealthModule } from './fish-health/fish-health.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { HarvestModule } from './harvest/harvest.module';
import { SiteModule } from './site/site.module';
import { DepartmentModule } from './department/department.module';
import { EquipmentModule } from './equipment/equipment.module';
import { SupplierModule } from './supplier/supplier.module';
import { ChemicalModule } from './chemical/chemical.module';
import { ConsumableModule } from './consumable/consumable.module';
import { FeedModule } from './feed/feed.module';
import { InventoryModule } from './storage/storage.module';
import { WorkerModule } from './worker/worker.module';
import { SystemModule } from './system/system.module';
import { SentinelHubModule } from './sentinel-hub/sentinel-hub.module';
import { MarineDataModule } from './marine-data/marine-data.module';
import { RegulatoryModule } from './regulatory/regulatory.module';
import { WeatherModule } from './weather/weather.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { EventListenersModule } from './events/event-listeners.module';
import { TaskModule } from './task/task.module';
import { FarmStockModule } from './farm-stock/farm-stock.module';
import { MobileDashboardModule } from './mobile-dashboard/mobile-dashboard.module';
import { FarmDocumentModule } from './document/document.module';
/**
 * WHY: AiInsightsModule integrates the MCP Farm Intelligence server with the
 * farm service, providing AI-powered risk assessment, anomaly detection, growth
 * prediction, and feeding advice via GraphQL queries.
 */
import { AiInsightsModule } from './ai-insights/ai-insights.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { GraphQLContextFactory } from './common/graphql-context.factory';
import { GraphQLContextModule } from './common/graphql-context.module';
import { getTenantSchemaName } from './common/utils/schema-sanitizer';

// Migrations — FARM_MIGRATIONS is the canonical runtime class list. Keep this
// import path stable; invariants compare it with the on-disk migrations
// directory and the production db-migrate numeric glob. The numeric glob
// intentionally excludes manifest.js so TypeORM does not load the same classes
// twice via the manifest import graph.
import { FARM_MIGRATIONS } from './database/migrations/manifest';

@Module({
  imports: [
    // Global configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
      cache: true,
    }),

    // Rate limiting (custom sliding-window implementation from backend-common)
    ThrottlerModule,

    // Database connection — uses the platform TypeORM factory so pool size,
    // SSL, fail-fast, env-var contract, and search_path semantics are
    // identical across every backend service. INTENTIONAL: no `schema:` —
    // TenantConnectionBootstrap manages search_path per request (see the
    // factory's docblock §"Why schema is NOT applied").
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        createServiceTypeOrmConfig(configService, {
          serviceName: 'farm',
          schema: 'farm',
          // migrationsRun: false (default) — db-migrate / MigrationRunnerService
          // own migration application. SourceSchemaBootstrapService only
          // verifies the post-migration source schema at OnApplicationBootstrap
          // and refuses any runtime synchronize() fallback.
          migrations: [...FARM_MIGRATIONS],
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

    // GraphQL Federation
    GraphQLModule.forRootAsync<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      imports: [ConfigModule, GraphQLContextModule],
      inject: [ConfigService, GraphQLContextFactory],
      useFactory: (configService: ConfigService, contextFactory: GraphQLContextFactory) => ({
        autoSchemaFile: {
          federation: 2,
          path: join(process.cwd(), 'dist/graphql/subgraphs/farm.graphql'),
        },
        /** SEC-CSRF: Apollo CSRF prevention. Rejects simple-CORS GraphQL
         *  requests that cannot carry a custom header — defense against
         *  cross-site GraphQL execution from a victim's browser. The
         *  gateway already enforces this; subgraphs do too as
         *  defense-in-depth in case a subgraph becomes directly
         *  accessible. Validated by scripts/ci/check-apollo-csrf-prevention.mjs. */
        csrfPrevention: true,
        /** SEC-M21: Disable GraphQL query batching to prevent batch-based brute-force attacks.
         *  The gateway already blocks batching, but subgraphs must also enforce this as
         *  defense-in-depth in case a subgraph becomes directly accessible. */
        allowBatchedHttpRequests: false,
        /**
         * SECURITY (H-05): depthLimit(10) prevents deeply nested query DoS attacks.
         * Without depth limiting, an attacker can craft a deeply nested GraphQL query
         * that causes exponential resource consumption on the server.
         */
        validationRules: [depthLimit(10)],
        /**
         * Phase 5.4 of the "Farm modülü kalan kör noktalar" plan.
         * depthLimit rejects queries that NEST too deeply but does
         * nothing against wide queries: a single-level selection with
         * 200 fields or a paginated list with `first: 10000` slips
         * through depth 1 and still exhausts the server.
         *
         * graphql-query-complexity adds a per-field cost model and
         * rejects queries whose total cost exceeds the threshold.
         *   - `simpleEstimator` assigns every field a cost of 1.
         *   - `fieldExtensionsEstimator` lets individual resolvers
         *     override their cost via `@ComplexityField({ value: N })`
         *     or similar — paginated list resolvers should multiply
         *     by the caller's `first` argument so a 1000-item page
         *     costs roughly 1000 even when the row shape is flat.
         *
         * Threshold is env-configurable via
         * `FARM_GRAPHQL_MAX_COMPLEXITY` (default 1000 — matches the
         * pattern used in hr-service / messaging-service / sensor-
         * service / hydroponics-service / ai-service). A rejected
         * query returns a `QUERY_TOO_COMPLEX` error with the
         * computed cost surfaced in `extensions.cost` so operators
         * can tune their queries rather than guess.
         */
        plugins: [
          {
            requestDidStart: async () => ({
              async didResolveOperation({
                request,
                document,
                schema,
              }: QueryComplexityOperationContext) {
                const rawLimit = configService.get<number | string>(
                  'FARM_GRAPHQL_MAX_COMPLEXITY',
                  1000,
                );
                const parsed = typeof rawLimit === 'string' ? Number(rawLimit) : rawLimit;
                const maxComplexity =
                  typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0
                    ? parsed
                    : 1000;
                const complexity = getComplexity({
                  schema,
                  operationName: request.operationName,
                  query: document,
                  variables: request.variables,
                  estimators: [
                    fieldExtensionsEstimator(),
                    simpleEstimator({ defaultComplexity: 1 }),
                  ],
                });
                if (complexity > maxComplexity) {
                  throw new GraphQLError(
                    `Query too complex: ${complexity}. Maximum allowed: ${maxComplexity}`,
                    {
                      extensions: {
                        code: 'QUERY_TOO_COMPLEX',
                        cost: complexity,
                        maxCost: maxComplexity,
                      },
                    },
                  );
                }
              },
            }),
          },
        ],
        playground: configService.get('NODE_ENV') !== 'production',
        // SECURITY: Disable introspection in production
        introspection: configService.get('NODE_ENV') !== 'production',
        context: ({ req }: { req: GraphQLContextRequest }) => {
          // User and tenant context are populated by VerifiedUserAssertionMiddleware.
          const tenantId = req.user?.tenantId ?? req.tenantId;
          let loaders;
          if (tenantId) {
            const schema = getTenantSchemaName(tenantId);
            loaders = contextFactory.createLoaders(tenantId, schema);
          }

          return { req, loaders };
        },
        buildSchemaOptions: {
          orphanedTypes: [],
        },
      }),
    }),

    // SECURITY (CRITICAL-001): RS256 asymmetric verification via the shared
    // PlatformJwtModule. farm-service is a token CONSUMER, not an issuer.
    // Replaced the per-service JwtModule.registerAsync block (WS2.B,
    // 2026-04-14) so future RS256/HS256 wiring changes touch ONE file
    // instead of ten. The shared module enforces algorithms ['RS256']
    // unconditionally; HS256 reintroduction is additionally banned by the
    // ESLint no-restricted-syntax rule on JWT_SECRET reads (WS2.C).
    PlatformJwtModule,

    // Schedule module — single forRoot() for the entire service
    ScheduleModule.forRoot(),

    /**
     * Global EventEmitter2 registration — single forRoot() for the entire service.
     * Feature modules (e.g. EventListenersModule) must NOT call forRoot() again.
     * In NestJS v11, duplicate forRoot() calls create separate EventEmitter2
     * instances, causing events emitted in one context to be invisible to
     * listeners registered in the other.
     */
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      ignoreErrors: false,
      maxListeners: 20,
    }),

    // CQRS Module
    CqrsModule.forRoot(),

    // Event Bus Module
    EventBusModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        natsUrl: configService.get('NATS_URL', 'nats://localhost:4222'),
        streamName: configService.get('NATS_STREAM_NAME', 'AQUACULTURE_EVENTS'),
      }),
    }),

    // Database module (audit, code generation, migration runner)
    DatabaseModule,

    // Domain Prometheus metrics — phase 5.3. Registers
    // FarmDomainMetricsService (counters + histograms) and the
    // APP_INTERCEPTOR that auto-records every GraphQL resolver call.
    FarmMetricsModule,

    // Systematic @Cacheable interceptor — phase 7.3. Read-through
    // Redis caching for any resolver/service method decorated with
    // @Cacheable. Tenant-scoped keys by default; operators tune
    // TTL per call site.
    CacheableModule,
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        buildRedisOptions(configService, 'farm', 'optional'),
    }),

    // Targeted jsonb_set UPDATE helper — phase 5.7. Lets
    // concurrent handlers patch DIFFERENT keys of the same JSONB
    // column without tripping each other's @VersionColumn.
    JsonbPatchModule,

    // Canonical legal-hold registry. Tenant erasure and every destructive
    // compliance path fail closed if this provider cannot answer.
    LegalHoldModule.forRoot(),

    // GDPR primitives — phase 6.3. Tenant export (right-of-access)
    // and two-step erasure (right-to-erasure) with audit-row
    // anonymisation. Platform-wide fan-out + event emission live
    // in admin-api + libs/event-contracts (phase 6.3.1).
    ComplianceModule,

    // @platform/storage — MinIO/S3 client + file upload security
    // + orphan cleanup service. Farm-service owns the domain
    // references (BatchDocument.storagePath, Chemical.documents[].url)
    // so the nightly cleanup cron lives here too. Fail-fast on
    // missing credentials in production; dev defaults in non-prod.
    StorageModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): StorageConfig => {
        const nodeEnv = configService.get<string>('NODE_ENV', 'development');
        const isProduction = nodeEnv === 'production';
        const accessKey = configService.get<string>('MINIO_ACCESS_KEY', '');
        const secretKey = configService.get<string>('MINIO_SECRET_KEY', '');
        if (isProduction && (!accessKey || !secretKey)) {
          throw new Error(
            'CRITICAL: MINIO_ACCESS_KEY and MINIO_SECRET_KEY must be ' +
              'explicitly configured in production. Farm-service startup ' +
              'aborted to prevent use of default credentials.',
          );
        }
        const rawPort = configService.get<string | number>('MINIO_PORT');
        const port =
          typeof rawPort === 'string' && rawPort.length > 0
            ? Number(rawPort)
            : typeof rawPort === 'number'
              ? rawPort
              : undefined;
        return {
          endpoint: configService.get<string>('MINIO_ENDPOINT', 'localhost'),
          port,
          useSSL: configService.get<string>('MINIO_USE_SSL', 'false') === 'true',
          accessKey: accessKey || 'minioadmin',
          secretKey: secretKey || 'minioadmin',
          bucket: configService.get<string>('MINIO_BUCKET', 'farm-uploads'),
          region: configService.get<string>('MINIO_REGION', 'us-east-1'),
        };
      },
    }),

    // Transactional outbox for reliable event publishing
    // (handlers enqueue → OutboxWorkerService polls → NATS publish)
    FarmOutboxModule,

    // Feature modules
    FarmDocumentModule,
    FarmModule,
    HealthModule,
    SpeciesModule,
    TankModule,
    BatchModule,
    FeedingModule,
    GrowthModule,
    WaterQualityModule,
    FishHealthModule,
    MaintenanceModule,
    HarvestModule,
    SiteModule,
    DepartmentModule,
    EquipmentModule,
    SupplierModule,
    ChemicalModule,
    ConsumableModule,
    FeedModule,
    InventoryModule,
    WorkerModule,
    SystemModule,
    SentinelHubModule,
    MarineDataModule,
    RegulatoryModule,
    WeatherModule,
    SchedulerModule,
    EventListenersModule,
    TaskModule,
    FarmStockModule,
    MobileDashboardModule,
    // WHY: AI insights module — MCP Farm Intelligence integration
    AiInsightsModule,
    /**
     * SEC-DB NEW-C1: Tenant Row-Level Security for the schema-per-tenant
     * deployment. Three things this wires up:
     *
     * 1. RlsConnectionBootstrap (always) — patches the pg pool so every
     *    checkout sets `app.current_tenant` and `app.bypass_rls` from
     *    AsyncLocalStorage. Without this, the policies installed below
     *    would deny every query because the GUC is unset.
     *
     * 2. autoApply: false — the existing TypeORM migration runner already
     *    applies `applyTenantRlsToSchema` to the source `farm` schema via
     *    RefreshTenantRlsPredicate1781000000000. We do NOT want
     *    RlsSchemaBootstrap to also touch the source schema; that would
     *    duplicate work.
     *
     * 3. syncTenantSchemas: true — registers TenantRlsSyncService which
     *    iterates every `tenant_<uuid>` schema at OnApplicationBootstrap
     *    and installs policies on each. This is the actual production
     *    enforcement layer; CREATE TABLE LIKE INCLUDING ALL does NOT
     *    propagate RLS policies, so per-tenant tables need them
     *    installed explicitly.
     */
    RlsModule.forPoolService({
      serviceName: 'farm',
      autoApply: false,
      // PR#363 port: runtime per-tenant RLS sweep only when db-migrate is
      // NOT authoritative — production tenants get the same policies from
      // the db-migrate tenant fan-out hardening.
      syncTenantSchemas: !farmSchemaDdlOwnedByDbMigrate,
      excludeTables: [
        'farm_outbox',
        'outbox_events',
        'inbox_messages',
        'event_dlq',
        'audit_logs',
        'audit_log',
      ],
    }),
    /** P11 of 2026-04-14 teardown — runtime schema-drift validator. */
    SchemaDriftModule.forRoot({ serviceName: 'farm' }),
  ],
  providers: [
    // Phase 6.4 — domain error filter runs BEFORE the generic
    // GlobalExceptionFilter. NestJS invokes filters in reverse
    // registration order so the FarmAppErrorFilter needs to come
    // AFTER GlobalExceptionFilter in the array to be picked first
    // for FarmAppError subclasses. Non-FarmAppError exceptions
    // fall through untouched to the generic filter.
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    {
      provide: APP_FILTER,
      useClass: FarmAppErrorFilter,
    },
    // SECURITY: Service identity guard - validates HMAC-signed service identity headers
    // Must be FIRST guard (before tenant/roles) to verify request origin
    // WHY: useFactory bypasses reflect-metadata resolution which fails in Docker Alpine.
    {
      provide: APP_GUARD,
      useFactory: (configService: ConfigService): ServiceIdentityGuard =>
        new ServiceIdentityGuard(configService, undefined, 'farm-service'),
      inject: [ConfigService],
    },
    // Tenant guard
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector, configService: ConfigService): TenantGuard =>
        new TenantGuard(reflector, undefined, configService),
      inject: [Reflector, ConfigService],
    },
    // SECURITY: Roles guard - enforces @Roles() decorator authorization
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector): RolesGuard => new RolesGuard(reflector),
      inject: [Reflector],
    },
    // Phase 6.1.2 — fail-closed permission-matrix guard. Rejects
    // any GraphQL @Mutation / @Query whose operation name is not
    // present in permission-matrix.ts. Grandfathered operations
    // (UNGATED_OPERATIONS) pass; unknown ones return 403. This is
    // the runtime counterpart to the build-time invariant test —
    // together they make "new mutation without matrix entry" a
    // zero-time-to-detect regression.
    {
      provide: APP_GUARD,
      useClass: PermissionMatrixGuard,
    },
    // Bootstrap source schema tables on startup (creates template tables if missing)
    SourceSchemaBootstrapService,
    // Pool-level tenant schema routing (patches pg Pool.connect for search_path injection)
    TenantConnectionBootstrap,
    // Auto-sync tenant schemas with source schema (creates missing tables/columns)
    TenantSchemaSyncService,
    // DB-level write guards on source schema (defense-in-depth)
    SourceSchemaWriteGuardService,
    WatchdogCronService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Middleware execution order:
    // 1. StripInternalHeadersMiddleware - remove spoofable gateway headers unless service-signed
    // 2. CorrelationIdMiddleware - Add correlation ID for request tracing
    // 3. UserContextMiddleware - Parse x-user-payload header from gateway (sets req.user)
    // 4. TenantContextMiddleware - Extract tenant from JWT/headers (uses req.user.tenantId)
    // 5. TenantSchemaMiddleware - Set PostgreSQL search_path to tenant schema
    consumer
      .apply(
        StripInternalHeadersMiddleware,
        VerifiedUserAssertionMiddleware,
        CorrelationIdMiddleware,
        RequestContextMiddleware, // Populate AsyncLocalStorage for structured logging
        UserContextMiddleware,
        TenantContextMiddleware,
        TenantSchemaMiddleware,
      )
      .forRoutes('*');
  }
}
