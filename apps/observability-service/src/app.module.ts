import { Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  RlsModule,
  SchemaDriftModule,
  createSchemaVersionGate,
  createServiceTypeOrmConfig,
} from '@aquaculture/backend-common/database';
import { LoggingModule } from '@aquaculture/backend-common/logging';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { PrometheusModule } from './prometheus/prometheus.module';
import { MetricsAggregatorModule } from './metrics/metrics-aggregator.module';
import { HealthModule } from './health/health.module';
import { TracingModule } from './tracing/tracing.module';
import { MigrationAuditModule } from './migration-audit/migration-audit.module';
import { GdprModule } from './gdpr/gdpr.module';
import { RetentionBootstrapModule } from './retention/retention-bootstrap.module';
import { InternalApiGuard } from './guards/internal-api.guard';

/**
 * PR#363 port — observability joins the fleet-wide schema authority
 * contract. In authoritative mode (production/staging) this is a
 * READ-ONLY ledger gate: boot is refused until aqua-db-migrate has
 * finalised the `observability` schema head. In dev it delegates to the
 * standard MigrationRunnerService. `tenantAware: false` because
 * observability deliberately has no tenant_<uuid> clones — it reads
 * aggregated metrics cross-tenant via BypassRlsService.
 */
const ObservabilitySchemaVersionGate = createSchemaVersionGate('observability', {
  tenantAware: false,
});

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
          // ORPHAN-HIGH-001 cure (observability-service leg): switched
          // from empty array to glob pattern. Pre-fix the array was [],
          // which masked 5 on-disk migrations (cost rollup, migration
          // events, schema-object history, emergency overrides, migration
          // backfill progress) — none of them ran on a fresh deploy.
          migrations: [__dirname + '/database/migrations/[0-9]*.{js,ts}'],
          // PR#363 port (INFRA-CRITICAL-020 contract): observability owns a
          // real migration glob now, so it uses the same env-aware timing
          // switch as the rest of the fleet — E2E harnesses set
          // DATABASE_MIGRATIONS_RUN=true to apply migrations at DataSource
          // init; production stays 'false' (db-migrate owns the ledger).
          migrationsRunFromEnv: (cfg) => cfg.get('DATABASE_MIGRATIONS_RUN', 'false') === 'true',
        }),
    }),
    PrometheusModule,
    MetricsAggregatorModule,
    HealthModule,
    TracingModule,
    // Plan v3 Phase 0 — durable audit trail for db-migrate lifecycle
    // events + drift validator emissions. Exposes RecordMigrationEventCommand
    // via the CQRS bus; the orchestrator (Phase 6) dispatches against it.
    MigrationAuditModule,
    // DSAR Art 15/20 export for observability audit rows. Tenant erasure is
    // deliberately not wired here; the canonical erasure target roster lives
    // in @platform/event-contracts and excludes observability.
    GdprModule,
    // Plan v3 R17 — single-enforcer-many-policies retention. Registers
    // migration_events (13mo) + schema_object_history (7y) +
    // emergency_overrides (7y, with legal-hold predicate) at module-init.
    // Replaces the retired per-table MigrationEventsRetentionService.
    RetentionBootstrapModule,
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
     * entityMetadatas list. Even at zero entities the validator emits the
     * structured `schema_drift_clean` boot signal. Without this registration,
     * observability cannot satisfy the manifest contract declared in
     * infrastructure/deploy/required-signals.yaml.
     */
    SchemaDriftModule.forRoot({ serviceName: 'observability' }),
  ],
  providers: [
    // Schema authority gate — see const declaration near top of file.
    ObservabilitySchemaVersionGate,
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
