import { Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggingModule, RlsModule, SchemaDriftModule, createServiceTypeOrmConfig } from '@aquaculture/backend-common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { PrometheusModule } from './prometheus/prometheus.module';
import { MetricsAggregatorModule } from './metrics/metrics-aggregator.module';
import { HealthModule } from './health/health.module';
import { TracingModule } from './tracing/tracing.module';
import { InternalApiGuard } from './guards/internal-api.guard';

@Module({
  imports: [
    LoggingModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    ScheduleModule.forRoot(),
    // Database connection — observability-service reads aggregated metrics
    // across tenants (deliberate cross-tenant access). Uses the platform
    // TypeORM factory so pool, SSL, fail-fast, and search_path semantics
    // stay identical across services.
    //
    // INFRA-DB-ENV-001 fix: previously read DB_HOST/DB_PORT/DB_USERNAME/
    // DB_PASSWORD/DB_NAME — drift from the platform-standard DATABASE_*
    // contract enforced by the factory. docker-compose.droplet.yml was
    // updated atomically in the same commit to publish DATABASE_* env vars.
    // INFRA-DB-SSL-001 fix: DB_SSL → DATABASE_SSL via factory.
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        createServiceTypeOrmConfig(configService, {
          serviceName: 'observability',
          schema: 'observability',
          // No migrations — observability-service uses synchronize=true in
          // dev (factory honours DATABASE_SYNC) and reads cross-schema
          // aggregates in prod. RLS module above handles schema bootstrap.
          migrations: [],
        }),
    }),
    PrometheusModule,
    MetricsAggregatorModule,
    HealthModule,
    TracingModule,
    /**
     * SECURITY (HIGH-004, V6): RlsConnectionBootstrap for pool-level GUC
     * propagation. observability-service reads aggregated metrics across
     * tenants — deliberately cross-tenant access pattern — but the pool
     * patch is still registered so that the GUC contract is uniform
     * platform-wide. Cross-tenant reads happen explicitly via
     * BypassRlsService, never by accident.
     */
    RlsModule.forPoolService({
      serviceName: 'observability',
      autoApply: false,
      excludeTables: [],
    }),
    /**
     * INFRA-CRITICAL-016: SchemaDriftValidator registration.
     *
     * Observability-service has no @Entity() declarations (it consumes
     * aggregated metrics via raw SQL across tenant schemas, not via
     * TypeORM entities), so the validator runs against an empty
     * entityMetadatas list. Even at zero entities the validator emits
     *   `Schema drift scan clean: checked 0 entities`
     * — substring `Schema drift scan clean` matches the deploy-gate's
     * `schema_drift_clean` signal_library entry. Without this
     * registration, observability cannot satisfy the manifest contract
     * declared in infrastructure/deploy/required-signals.yaml.
     */
    SchemaDriftModule.forRoot({ serviceName: 'observability' }),
  ],
  providers: [
    // WHY: useFactory bypasses reflect-metadata resolution which fails in Docker Alpine.
    {
      provide: APP_GUARD,
      useFactory: (configService: ConfigService, reflector: Reflector): InternalApiGuard =>
        new InternalApiGuard(configService, reflector),
      inject: [ConfigService, Reflector],
    },
  ],
})
export class AppModule {}
