import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloFederationDriver, ApolloFederationDriverConfig } from '@nestjs/apollo';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { join } from 'path';
import { EventEmitterModule } from '@nestjs/event-emitter';
import depthLimit from 'graphql-depth-limit';
import {
  SourceSchemaBootstrapService,
  createTenantConnectionBootstrap,
  TenantSchemaSyncService,
  SourceSchemaWriteGuardService,
  RlsModule,
  getRlsExcludeTablesForService,
  createSchemaVersionGate,
  SchemaDriftModule,
  createServiceTypeOrmConfig,
  isSchemaDdlOwnedByDbMigrate,
} from '@aquaculture/backend-common/database';
import { TenantExecutionContextModule } from '@aquaculture/backend-common/context';
import { TenantGuard, RolesGuard, ServiceIdentityGuard } from '@aquaculture/backend-common/guards';
import { RequestContextMiddleware } from '@aquaculture/backend-common/logging';
import { ServiceMetricsModule } from '@aquaculture/backend-common/metrics';
import {
  TenantContextMiddleware,
  CorrelationIdMiddleware,
  UserContextMiddleware,
  createTenantSchemaMiddleware,
  StripInternalHeadersMiddleware,
  VerifiedUserAssertionMiddleware,
} from '@aquaculture/backend-common/middleware';
import { RedisModule, buildRedisOptions } from '@aquaculture/backend-common/redis';
import {
  AuditLogModule,
  AuditLogInterceptor,
  AuditedOperationModule,
} from '@aquaculture/backend-common/audit';
import { TenantErasureTargetModule } from '@aquaculture/backend-common/compliance';
const TenantSchemaMiddleware = createTenantSchemaMiddleware('alert');
const TenantConnectionBootstrap = createTenantConnectionBootstrap('alert');

/**
 * AlertMigrationRunnerService — runs pending TypeORM migrations in the
 * alert source schema at OnApplicationBootstrap. Wired in P2d of the
 * 2026-04-14 teardown plan to close the RlsSchemaBootstrap docblock gap
 * (lines 14-27: "a replacement migration system has not yet been added").
 *
 * migrations/ starts empty — alert-engine currently relies on
 * SourceSchemaBootstrapService + TenantSchemaSyncService for schema
 * state. Having the runner wired here lets future drift-correcting or
 * RLS-installing migrations land as deterministic commits without
 * reviving the hand-applied-psql anti-pattern.
 */
const AlertMigrationRunnerService = createSchemaVersionGate('alert');

/**
 * PR#363 port — runtime DDL authority gate. In authoritative deployments
 * the per-tenant RLS sweep belongs to aqua-db-migrate's tenant fan-out
 * hardening (SCHEMA_REGISTRY['alert'].postMigrationHardening); local/dev
 * keeps syncTenantSchemas as the historical bootstrap convenience.
 */
const alertSchemaDdlOwnedByDbMigrate = isSchemaDdlOwnedByDbMigrate(process.env);
import { EventBusModule, buildEventBusConfig } from '@platform/event-bus';
import { AlertModule } from './alert/alert.module';
import { AlertOutboxModule } from './outbox/alert-outbox.module';
import { HealthModule } from './health/health.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';

// Nested ObjectTypes for orphanedTypes registration
import { IncidentTimelineEvent } from './database/entities/alert-incident.entity';
import { AlertCondition } from './database/entities/alert-rule.entity';

@Module({
  imports: [
    // Global configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
      cache: true,
    }),

    // Database connection — uses the platform TypeORM factory.
    // INTENTIONAL: no `schema:` — TenantConnectionBootstrap manages
    // search_path per request. AlertMigrationRunnerService (provider above)
    // executes migrations at OnApplicationBootstrap; factory's
    // migrationsRun:false default keeps TypeORM out of that codepath.
    // Pre-factory, this service had NO explicit pool max — pg driver
    // default 10 was used. The factory's default 10 preserves that.
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        createServiceTypeOrmConfig(configService, {
          serviceName: 'alert',
          schema: 'alert',
          migrations: [__dirname + '/database/migrations/[0-9]*.{js,ts}'],
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
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        autoSchemaFile: {
          federation: 2,
          path: join(process.cwd(), 'dist/graphql/subgraphs/alert.graphql'),
        },
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
        /**
         * SECURITY (H-05): depthLimit(10) prevents deeply nested query DoS attacks.
         * Without depth limiting, an attacker can craft a deeply nested GraphQL query
         * that causes exponential resource consumption on the server.
         */
        validationRules: [depthLimit(10)],
        buildSchemaOptions: {
          orphanedTypes: [IncidentTimelineEvent, AlertCondition],
        },
        /**
         * 2026-04-30: Deprecated GraphQL Playground is not enabled at runtime.
         * WHY: subgraphs must not depend on deprecated Apollo developer UI behavior.
         */
        // SECURITY: Disable introspection in production
        introspection: configService.get('NODE_ENV') !== 'production',
        context: ({ req }: { req: unknown }) => ({ req }),
      }),
    }),

    // Event Bus Module
    EventBusModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: buildEventBusConfig,
    }),
    AlertOutboxModule,
    TenantErasureTargetModule.forService('alert-engine'),

    // Redis for distributed state management
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        buildRedisOptions(configService, 'alert', 'required'),
    }),

    // In-process event emitter (used by EscalationManagerService, etc.)
    EventEmitterModule.forRoot(),

    // Feature modules
    AlertModule,
    HealthModule,
    // OBS-HIGH-001: Prometheus GET /metrics scrape endpoint + HTTP metrics
    // middleware (self-contained platform module — controller is @Public()).
    ServiceMetricsModule,
    /** SEC-M22: Audit trail infrastructure for compliance tracking. */
    AuditLogModule.forRoot(),
    // AUDITTRAIL-CRITICAL-002 sweep — registers AuditedOperationInterceptor.
    AuditedOperationModule.forRoot(),
    /** SECURITY (HIGH-004): Tenant RLS (schema-per-tenant alert). */
    RlsModule.forPoolService({
      serviceName: 'alert',
      // PR#363 port: runtime per-tenant RLS sweep only when db-migrate is
      // NOT authoritative — production tenants get the same policies from
      // the db-migrate tenant fan-out hardening.
      syncTenantSchemas: !alertSchemaDdlOwnedByDbMigrate,
      excludeTables: getRlsExcludeTablesForService('alert'),
    }),
    /** P11 of 2026-04-14 teardown — runtime schema-drift validator. */
    // Tenant execution context interceptor (SSoT registration) — keeps the
    // validated tenant schema in AsyncLocalStorage across Apollo/CQRS async
    // boundaries so per-tenant search_path routing holds at pg checkout.
    TenantExecutionContextModule,
    SchemaDriftModule.forRoot({
      serviceName: 'alert-engine',
      schemaName: 'alert',
    }),
  ],
  providers: [
    // Migration runner — see const declaration near top of file.
    AlertMigrationRunnerService,
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
        new ServiceIdentityGuard(configService, undefined, 'alert-engine'),
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
    /** SEC-M22: Register global audit logging for compliance — all mutations are tracked. */
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditLogInterceptor,
    },
    // Bootstrap source schema tables on startup (creates template tables if missing)
    SourceSchemaBootstrapService,
    // Tenant connection pool patching for schema-level isolation
    TenantConnectionBootstrap,
    // Auto-sync tenant schemas with source schema (creates missing tables/columns)
    TenantSchemaSyncService,
    // DB-level write guards on source schema (defense-in-depth)
    SourceSchemaWriteGuardService,
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
        RequestContextMiddleware, // Populate AsyncLocalStorage for structured logging
        UserContextMiddleware,
        TenantContextMiddleware,
        TenantSchemaMiddleware, // Schema-level tenant isolation via search_path
      )
      .forRoutes('*');
  }
}
