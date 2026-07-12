import { TenantExecutionContextModule } from '@aquaculture/backend-common/context';
import {
  RlsModule,
  SchemaDriftModule,
  createSchemaVersionGate,
  createServiceTypeOrmConfig,
} from '@aquaculture/backend-common/database';
import { LoggingModule } from '@aquaculture/backend-common/logging';
import { ServiceMetricsModule } from '@aquaculture/backend-common/metrics';
// DB-INFRA-HIGH-003: event-backbone participation to be a GDPR erasure target.
import { RedisModule, buildRedisOptions } from '@aquaculture/backend-common/redis';
import { TenantErasureTargetModule } from '@aquaculture/backend-common/compliance';
import { EventBusModule, buildEventBusConfig } from '@platform/event-bus';
import { EventStoreOutboxModule } from './outbox/event-store-outbox.module';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EventStoreModule } from './event-store/event-store.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { EventStoreServiceIdentityGuard } from './guards/event-store-service-identity.guard';
import { HealthModule } from './health/health.module';
import { ProjectionsModule } from './projections/projections.module';

// Migration class imports removed — TypeOrmModule now uses the glob
// pattern '/migrations/[0-9]*.{js,ts}' to load every timestamped migration
// on disk while excluding support files from TypeORM's migration loader
// (ORPHAN-HIGH-001 cure). Pre-fix the explicit array missed
// 1781000000000-CreateEventStoreTables and 1800000000000-AddFindingsTable.

const EventStoreSchemaVersionGate = createSchemaVersionGate('event_store');

@Module({
  imports: [
    LoggingModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    // Database connection — event-store-service owns the `event_store`
    // schema. Uses the platform TypeORM factory.
    //
    // INFRA-DB-ENV-001 fix: previously read DB_HOST/DB_PORT/DB_USERNAME/
    // DB_PASSWORD/DB_NAME/DB_SSL — drift from the platform-standard
    // DATABASE_* env-var contract enforced by the factory. event-store is
    // not yet deployed, so no operator config breaks; future deploys must
    // use DATABASE_* (matches every other backend service).
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        createServiceTypeOrmConfig(configService, {
          serviceName: 'event-store',
          schema: 'event_store',
          migrations: [__dirname + '/migrations/[0-9]*.{js,ts}'],
          // Single-writer deploy contract: aqua-db-migrate owns production
          // migrations. Local/E2E can still opt in explicitly.
          migrationsRunFromEnv: (cfg) => cfg.get('DATABASE_MIGRATIONS_RUN', 'false') === 'true',
        }),
    }),
    // Schedule module — single forRoot() for the entire service
    ScheduleModule.forRoot(),

    // DB-INFRA-HIGH-003: event-backbone participation, solely for GDPR erasure.
    // The TenantErasureTargetModule handler subscribes to TenantErasureRequested
    // and deletes the tenant-column projection tables (event_streams, snapshots,
    // projection_*); stored_events is excluded (awaits crypto-shred).
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        buildRedisOptions(configService, 'event-store', 'optional'),
    }),
    EventBusModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: buildEventBusConfig,
    }),
    EventStoreOutboxModule,
    TenantErasureTargetModule.forService('event-store-service'),

    EventStoreModule,
    ProjectionsModule,
    HealthModule,
    // OBS-HIGH-001: Prometheus GET /metrics scrape endpoint + HTTP metrics
    // middleware. /metrics is allowlisted in EventStoreServiceIdentityGuard
    // (exact-match, no prefix) — this service's guard has no @Public() path.
    ServiceMetricsModule,
    /**
     * SECURITY (HIGH-004): Tenant RLS on event-store ledger tables.
     * EventLedgerHardening1800100000000 owns policy installation and FORCE RLS.
     * Runtime boot only wires the pool GUC bridge; readiness asserts the DB state.
     */
    RlsModule.forPoolService({
      serviceName: 'event-store',
      autoApply: false,
    }),
    /**
     * ADR-012: runtime schema-drift validator. Schema owner is `event_store`;
     * serviceName tag matches the service directory (event-store-service)
     * per the adoption-invariant pairing rule.
     */
    SchemaDriftModule.forRoot({ serviceName: 'event-store' }),
    // Tenant execution context interceptor (SSoT registration) — keeps the
    // validated tenant in AsyncLocalStorage across async boundaries so
    // tenant-scoped event-stream reads resolve the correct schema.
    TenantExecutionContextModule,
  ],
  providers: [
    EventStoreSchemaVersionGate,
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    /**
     * Global authentication guard for event-store-service.
     * EventStoreServiceIdentityGuard validates canonical v2 service identity
     * before any tenant-scoped event stream access.
     */
    {
      provide: APP_GUARD,
      useClass: EventStoreServiceIdentityGuard,
    },
  ],
})
export class AppModule {}
