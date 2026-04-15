import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
} from '@nestjs/apollo';
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core';
import { join } from 'path';
import { Request } from 'express';
import depthLimit from 'graphql-depth-limit';
import {
  TenantContextMiddleware,
  CorrelationIdMiddleware,
  RequestContextMiddleware,
  TenantGuard,
  RolesGuard,
  UserContextMiddleware,
  SourceSchemaBootstrapService,
  ServiceIdentityGuard,
  ThrottlerModule,
  PlatformJwtModule,
} from '@aquaculture/backend-common';

/**
 * Extended request interface for GraphQL context
 */
interface GraphQLContextRequest extends Request {
  user?: {
    sub: string;
    roles: string[];
  };
}
import { createTenantSchemaMiddleware, createTenantConnectionBootstrap, TenantSchemaSyncService, SourceSchemaWriteGuardService, RlsModule, SchemaDriftModule, createServiceTypeOrmConfig } from '@aquaculture/backend-common';
const TenantSchemaMiddleware = createTenantSchemaMiddleware('farm');
const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
import { WatchdogCronService } from './infrastructure/watchdog-cron.service';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CqrsModule } from '@platform/cqrs';
import { EventBusModule } from '@platform/event-bus';
import { DatabaseModule } from './database/database.module';
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
import { RegulatoryModule } from './regulatory/regulatory.module';
import { WeatherModule } from './weather/weather.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { EventListenersModule } from './events/event-listeners.module';
import { TaskModule } from './task/task.module';
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

// Migrations — imported as class references so webpack/tsc bundles them.
// Glob paths ('dist/migrations/*.js') do NOT work with NX builds because
// all source files are bundled into a single output, leaving zero file matches.
// MigrationRunnerService (database.module) executes these on OnApplicationBootstrap
// AFTER SourceSchemaBootstrapService.synchronize() has run, ensuring tables exist
// before the migrations attempt to ALTER them.
import { AddSystemHierarchy1734336000000 } from './database/migrations/1734336000000-AddSystemHierarchy';
import { AddBatchDocuments1734500000000 } from './database/migrations/1734500000000-AddBatchDocuments';
// `MakeDepartmentSiteIdNullable1765012800000` was deleted: its intent
// (siteId nullable, FK ON DELETE SET NULL, unique index on (tenantId, code))
// is fully expressed by the current Department entity decorators. Every
// environment that bootstraps via SourceSchemaBootstrapService.synchronize()
// already has the post-refactor camelCase schema, so the migration could
// never run successfully — the snake_case `site_id` column it targets does
// not exist anywhere. Removing the dead migration is the architectural fix;
// the git history preserves the audit trail. Adding an idempotency guard
// would only mask a no-op behind ceremonial code, not solve the structural
// issue of a migration whose desired state is now provided by another mechanism.
//
// `AddCleanerFishSupport1768500000000` was deleted for the SAME class of
// reason: its ALTER TABLE column adds are now expressed by the @Column
// decorators on Species/Batch/TankBatch/TankOperation entities, its enum
// extension targeted `operation_type_enum` but TypeORM synchronize creates
// the enum as `tank_operations_operationtype_enum` (default
// {table}_{column_lowercase}_enum convention) so ALTER TYPE on the legacy
// name fails on every fresh environment, and every idempotency branch in
// the migration logged "column already exists, skipping" in production —
// proof the schema was already provisioned by synchronize before the
// migration ever ran. The only non-redundant part — the global cleaner
// fish species seed — has been moved to
// FarmSeedService.seedGlobalCleanerFishSpecies() so it ships on every
// cold start in every environment, idempotently. Git history preserves
// the full original migration for audit purposes.
import { AddRegulatorySettings1769000000000 } from './database/migrations/1769000000000-AddRegulatorySettings';
import { AddSpeciesTags1769100000000 } from './database/migrations/1769100000000-AddSpeciesTags';
import { AddFeedMinFishWeight1770000000000 } from './database/migrations/1770000000000-AddFeedMinFishWeight';
import { AddStorageManagement1771000000000 } from './database/migrations/1771000000000-AddStorageManagement';
import { AddPurchaseOrders1772000000000 } from './database/migrations/1772000000000-AddPurchaseOrders';
import { AddWeatherTables1773000000000 } from './database/migrations/1773000000000-AddWeatherTables';
import { AddFeederCalibrations1774000000000 } from './database/migrations/1774000000000-AddFeederCalibrations';
import { AddFeederFieldsToExecution1775000000000 } from './database/migrations/1775000000000-AddFeederFieldsToExecution';
// NEW-S1: Schema convergence — drop dead PondBatch `batches` table and
// converge `farms`/`ponds`/`workers`.`tenantId` from the legacy varchar
// type to uuid, matching the corrected entity decorators. Runs IMMEDIATELY
// BEFORE EnableRowLevelSecurity so the RLS policy install no longer fails
// with `operator does not exist: text = uuid` on legacy columns.
import { ConvergeTenantIdTypesAndDropPondBatch1775900000000 } from './database/migrations/1775900000000-ConvergeTenantIdTypesAndDropPondBatch';
import { EnableRowLevelSecurity1776000000000 } from './database/migrations/1776000000000-EnableRowLevelSecurity';
import { CreateFarmOutboxTable1780300000000 } from './database/migrations/1780300000000-CreateFarmOutboxTable';
import { RefreshTenantRlsPredicate1781000000000 } from './database/migrations/1781000000000-RefreshTenantRlsPredicate';
import { ConvertFarmOutboxToIdentity1781200000000 } from './database/migrations/1781200000000-ConvertFarmOutboxToIdentity';
import { AddTenantActivePartialIndexes1781800000000 } from './database/migrations/1781800000000-AddTenantActivePartialIndexes';
// NEW-H1: convert audit columns from TIMESTAMP to TIMESTAMPTZ across the
// farm schema. Excludes farm_outbox/audit_logs/audit_log to stay in lockstep
// with the RLS migration's exclusion list. Helper uses dynamic discovery,
// so any new entity that uses the bare @CreateDateColumn() decorator is
// picked up automatically without amending this list.
import { ConvertAuditColumnsToTimestamptz1781900000000 } from './database/migrations/1781900000000-ConvertAuditColumnsToTimestamptz';
// C2/P-H1 fix: add leasedAt/leasedBy columns to farm_outbox so the
// OutboxWorkerService can claim rows atomically across replicas via
// SELECT ... FOR UPDATE SKIP LOCKED. Unblocks horizontal scaling of
// farm-service — before this migration, multi-replica deploys caused
// every replica to publish every event, relying on NATS dedup to
// absorb the duplicates.
import { AddFarmOutboxLeaseColumns1782000000000 } from './database/migrations/1782000000000-AddFarmOutboxLeaseColumns';
// P-C1 fix: AFTER INSERT trigger on farm_outbox that fires
// pg_notify('farm_outbox_notify', ''), paired with the shared
// OutboxNotifyListener to wake the worker immediately on every new
// row. Drops median enqueue-to-publish latency from ~500ms (cron
// cadence) to ~5ms.
import { AddFarmOutboxNotifyTrigger1782100000000 } from './database/migrations/1782100000000-AddFarmOutboxNotifyTrigger';

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
          // migrationsRun: false (default) — MigrationRunnerService in
          // database.module executes migrations at OnApplicationBootstrap
          // so SourceSchemaBootstrapService.synchronize() (OnModuleInit)
          // creates base tables BEFORE any ALTER statement runs.
          migrations: [
            AddSystemHierarchy1734336000000,
            AddBatchDocuments1734500000000,
            AddRegulatorySettings1769000000000,
            AddSpeciesTags1769100000000,
            AddFeedMinFishWeight1770000000000,
            AddStorageManagement1771000000000,
            AddPurchaseOrders1772000000000,
            AddWeatherTables1773000000000,
            AddFeederCalibrations1774000000000,
            AddFeederFieldsToExecution1775000000000,
            ConvergeTenantIdTypesAndDropPondBatch1775900000000,
            EnableRowLevelSecurity1776000000000,
            CreateFarmOutboxTable1780300000000,
            RefreshTenantRlsPredicate1781000000000,
            ConvertFarmOutboxToIdentity1781200000000,
            AddTenantActivePartialIndexes1781800000000,
            ConvertAuditColumnsToTimestamptz1781900000000,
            AddFarmOutboxLeaseColumns1782000000000,
            AddFarmOutboxNotifyTrigger1782100000000,
          ],
        }),
    }),

    // GraphQL Federation
    GraphQLModule.forRootAsync<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      imports: [ConfigModule, GraphQLContextModule],
      inject: [ConfigService, GraphQLContextFactory],
      useFactory: (configService: ConfigService, contextFactory: GraphQLContextFactory) => ({
        autoSchemaFile: { federation: 2, path: join('/tmp', 'schema.graphql') },
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
        playground: configService.get('NODE_ENV') !== 'production',
        // SECURITY: Disable introspection in production
        introspection: configService.get('NODE_ENV') !== 'production',
        context: ({ req }: { req: GraphQLContextRequest }) => {
          // Reconstruct user from gateway headers for @CurrentUser() decorator
          const userPayloadHeader = req.headers['x-user-payload'];
          const userIdHeader = req.headers['x-user-id'];
          const userRolesHeader = req.headers['x-user-roles'];

          if (typeof userPayloadHeader === 'string') {
            try {
              req.user = JSON.parse(userPayloadHeader);
            } catch {
              // Fallback: create minimal user from individual headers
              if (typeof userIdHeader === 'string') {
                req.user = {
                  sub: userIdHeader,
                  roles: typeof userRolesHeader === 'string'
                    ? JSON.parse(userRolesHeader)
                    : [],
                };
              }
            }
          } else if (typeof userIdHeader === 'string') {
            // Fallback if x-user-payload not present
            req.user = {
              sub: userIdHeader,
              roles: typeof userRolesHeader === 'string'
                ? JSON.parse(userRolesHeader)
                : [],
            };
          }

          // Create per-request DataLoaders for equipment batch metrics (N+1 → bulk)
          const tenantHeader = req.headers['x-tenant-id'];
          const tenantId = typeof tenantHeader === 'string' ? tenantHeader : undefined;
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

    // Transactional outbox for reliable event publishing
    // (handlers enqueue → OutboxWorkerService polls → NATS publish)
    FarmOutboxModule,

    // Feature modules
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
    RegulatoryModule,
    WeatherModule,
    SchedulerModule,
    EventListenersModule,
    TaskModule,
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
      syncTenantSchemas: true,
      excludeTables: ['farm_outbox', 'audit_logs', 'audit_log'],
    }),
    /** P11 of 2026-04-14 teardown — runtime schema-drift validator. */
    SchemaDriftModule.forRoot({ serviceName: 'farm' }),
  ],
  providers: [
    // Global exception filter
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    // SECURITY: Service identity guard - validates HMAC-signed service identity headers
    // Must be FIRST guard (before tenant/roles) to verify request origin
    // WHY: useFactory bypasses reflect-metadata resolution which fails in Docker Alpine.
    {
      provide: APP_GUARD,
      useFactory: (configService: ConfigService): ServiceIdentityGuard =>
        new ServiceIdentityGuard(configService),
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
      useFactory: (reflector: Reflector): RolesGuard =>
        new RolesGuard(reflector),
      inject: [Reflector],
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
    // 1. CorrelationIdMiddleware - Add correlation ID for request tracing
    // 2. UserContextMiddleware - Parse x-user-payload header from gateway (sets req.user)
    // 3. TenantContextMiddleware - Extract tenant from JWT/headers (uses req.user.tenantId)
    // 4. TenantSchemaMiddleware - Set PostgreSQL search_path to tenant schema
    consumer
      .apply(
        CorrelationIdMiddleware,
        RequestContextMiddleware, // Populate AsyncLocalStorage for structured logging
        UserContextMiddleware,
        TenantContextMiddleware,
        TenantSchemaMiddleware,
      )
      .forRoutes('*');
  }
}
