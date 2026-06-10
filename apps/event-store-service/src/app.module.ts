import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import {
  RlsModule,
  SchemaDriftModule,
  createSchemaVersionGate,
  createServiceTypeOrmConfig,
} from '@aquaculture/backend-common/database';
import { LoggingModule, RequestContextMiddleware } from '@aquaculture/backend-common/logging';
import { InternalApiKeyGuard } from './guards/internal-api-key.guard';
import { EventStoreModule } from './event-store/event-store.module';
import { ProjectionsModule } from './projections/projections.module';
import { HealthModule } from './health/health.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
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
    CqrsModule.forRoot(),
    // Schedule module — single forRoot() for the entire service
    ScheduleModule.forRoot(),
    EventStoreModule,
    ProjectionsModule,
    HealthModule,
    /**
     * SECURITY (HIGH-004): Tenant RLS on event-store projections.
     * Policy DDL is migration-owned and applied by aqua-db-migrate. Runtime
     * wiring here only syncs AsyncLocalStorage tenant context into the
     * PostgreSQL session.
     */
    RlsModule.forPoolService({
      serviceName: 'event-store',
    }),
    /**
     * ADR-012: runtime schema-drift validator. Schema owner is `event_store`;
     * serviceName tag matches the service directory (event-store-service)
     * per the adoption-invariant pairing rule.
     */
    SchemaDriftModule.forRoot({ serviceName: 'event-store' }),
  ],
  providers: [
    EventStoreSchemaVersionGate,
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
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
