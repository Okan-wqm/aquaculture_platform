import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import {
  LoggingModule,
  RlsModule,
  SchemaDriftModule,
  createServiceTypeOrmConfig,
} from '@aquaculture/backend-common';
import { InternalApiKeyGuard } from './guards/internal-api-key.guard';
import { EventStoreModule } from './event-store/event-store.module';
import { ProjectionsModule } from './projections/projections.module';
import { HealthModule } from './health/health.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { AddStoredEventsImmutabilityTriggers1782000000000 } from './migrations/1782000000000-AddStoredEventsImmutabilityTriggers';

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
          migrations: [AddStoredEventsImmutabilityTriggers1782000000000],
          // event-store opts in to TypeORM's built-in migration runner via
          // DATABASE_MIGRATIONS_RUN (default true). No MigrationRunnerService
          // for this service yet.
          migrationsRunFromEnv: (cfg) =>
            cfg.get('DATABASE_MIGRATIONS_RUN', 'true') === 'true',
        }),
    }),
    CqrsModule.forRoot(),
    // Schedule module — single forRoot() for the entire service
    ScheduleModule.forRoot(),
    EventStoreModule,
    ProjectionsModule,
    HealthModule,
    /**
     * SECURITY (HIGH-004): Tenant RLS on event-store projections.
     * stored_events and projection tables carry tenant_id; autoApply runs
     * the helper at OnApplicationBootstrap so policies are idempotently
     * installed on every cold start.
     */
    RlsModule.forPoolService({
      serviceName: 'event-store',
      autoApply: true,
      excludeTables: ['stored_events', 'projection_checkpoint'],
    }),
    /**
     * ADR-012: runtime schema-drift validator. Schema owner is `event_store`;
     * serviceName tag matches the service directory (event-store-service)
     * per the adoption-invariant pairing rule.
     */
    SchemaDriftModule.forRoot({ serviceName: 'event-store' }),
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    /**
     * Global authentication guard for event-store-service.
     * InternalApiKeyGuard ensures only authenticated internal services
     * can access event streams. This prevents unauthorized containers
     * from reading or writing tenant event data.
     */
    {
      provide: APP_GUARD,
      useClass: InternalApiKeyGuard,
    },
  ],
})
export class AppModule {}
