import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloFederationDriver, ApolloFederationDriverConfig } from '@nestjs/apollo';
import { join } from 'path';
import { CqrsModule } from '@nestjs/cqrs';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import depthLimit from 'graphql-depth-limit';
import { PlatformJwtModule } from '@aquaculture/backend-common/auth';
import { AuditLogModule, AuditLogInterceptor } from '@aquaculture/backend-common/audit';
import {
  AuditColumnsModule,
  createSchemaVersionGate,
  createServiceTypeOrmConfig,
  isSchemaDdlOwnedByDbMigrate,
  RlsModule,
  SchemaDriftModule,
} from '@aquaculture/backend-common/database';
import { RolesGuard, ServiceIdentityGuard, TenantGuard } from '@aquaculture/backend-common/guards';
import { LoggingModule } from '@aquaculture/backend-common/logging';
import { ServiceMetricsModule } from '@aquaculture/backend-common/metrics';
// DB-INFRA-HIGH-003: config-service onboarded to the event backbone to be a GDPR
// tenant-erasure target (EventBus + Redis + outbox + the erasure target handler).
import { RedisModule, buildRedisOptions } from '@aquaculture/backend-common/redis';
import { EventBusModule, buildEventBusConfig } from '@platform/event-bus';
import { TenantErasureTargetModule } from '@aquaculture/backend-common/compliance';
import { ConfigOutboxModule } from './outbox/config-outbox.module';
import {
  StripInternalHeadersMiddleware,
  VerifiedUserAssertionMiddleware,
} from '@aquaculture/backend-common/middleware';

/**
 * ConfigMigrationRunnerService — runs pending TypeORM migrations against
 * the `config` schema at OnApplicationBootstrap.
 *
 * # Why schema: 'config' (not 'public')
 *
 * Every config-service entity declares
 * `@Entity('<table>', { schema: 'config' })` (see
 * `configuration.entity.ts`) and every migration body issues
 * `CREATE TABLE config.<table>` / `pinSearchPath(qr, 'config')`. Passing
 * `'public'` to the runner factory tells the runner to advisory-lock and
 * pin `search_path` against `public` while the DDL targets `config` — an
 * incoherent state where the runner attempts to maintain the migration
 * ledger in `public`, requiring CREATE privilege
 * on `public` that the per-service DB role does not have. Production
 * cold-boot crashed with:
 *
 *   Migration "AlignConfigEntitySurface1789000000000" failed on "public":
 *   permission denied for database aquaculture
 *
 * Aligning the runner with the schema the entities + migrations target
 * is the canonical platform shape (billing-service:
 * `createSchemaVersionGate('billing')`, hr-service: `('hr')`,
 * ai-service: `('ai')`). The aqua-db-migrate orchestrator container
 * already applies config migrations against `config`; this restores the
 * per-service runner to the same target so the orchestrator and
 * per-service runner stay aligned (idempotent — the runner skips
 * already-applied migrations via the per-schema `migrations` ledger via
 * `MigrationExecutor.getPendingMigrations()`).
 *
 * Closes: docs/reviews/orphan-findings.md#ORPHAN-CRITICAL-069
 */
const ConfigMigrationRunnerService = createSchemaVersionGate('config');
const configSchemaDdlOwnedByDbMigrate = isSchemaDdlOwnedByDbMigrate(process.env);
import { ConfigurationModule } from './configuration/configuration.module';
import { HealthModule } from './health/health.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';

@Module({
  imports: [
    LoggingModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
      cache: true,
    }),

    // Database connection — config-service owns the `config` schema
    // (per ADR-011 schema-per-service). Every entity in
    // `configuration/entities/*.entity.ts` declares
    // `@Entity('<table>', { schema: 'config' })` and every migration body
    // is schema-qualified to `config.<table>`. The TypeORM factory pins
    // `search_path` to `config,public` so unqualified reads land in the
    // owned schema and the runner ledger lives in `config.migrations`,
    // where the role has CREATE.
    // ConfigMigrationRunnerService (provider above) executes migrations
    // at OnApplicationBootstrap against the same `config` schema;
    // factory's migrationsRun:false default keeps TypeORM out of that
    // codepath.
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        createServiceTypeOrmConfig(configService, {
          serviceName: 'config',
          schema: 'config',
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

    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      autoSchemaFile: {
        federation: 2,
        path: join(process.cwd(), 'dist/graphql/subgraphs/config.graphql'),
      },
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
      /**
       * 2026-04-30: Deprecated GraphQL Playground is not enabled at runtime.
       * WHY: subgraphs must not depend on deprecated Apollo developer UI behavior.
       */
      introspection: process.env['NODE_ENV'] !== 'production',
      // installSubscriptionHandlers removed in @nestjs/graphql v13 — use graphql-ws for subscriptions instead
      validationRules: [depthLimit(10)],
      context: ({ req }: { req: Request }) => ({ req }),
    }),

    // SECURITY (CRITICAL-001): RS256 asymmetric verification via the shared
    // PlatformJwtModule. config-service is a token CONSUMER, not an issuer.
    //
    // History: this service was on the legacy HS256 / JWT_SECRET shared-secret
    // path identical to the one that crashed hydroponics-service at boot on
    // 2026-04-14. Migrated to PlatformJwtModule in the WS2.B sweep so the
    // entire platform is RS256-only.
    PlatformJwtModule,

    CqrsModule.forRoot(),

    // DB-INFRA-HIGH-003: event-backbone participation, solely for GDPR erasure.
    // RedisModule (outbox worker leasing) + EventBusModule (NATS) + the
    // config_outbox module feed the TenantErasureTargetModule handler, which
    // subscribes to TenantErasureRequested and deletes per-tenant config rows.
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        // Marine credential disclosure/mutation uses Redis SET-NX as its
        // cross-replica replay ledger. Production must fail at boot when the
        // shared store is not configured; a pod-local fallback is unsafe.
        buildRedisOptions(configService, 'config', 'required'),
    }),
    EventBusModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: buildEventBusConfig,
    }),
    ConfigOutboxModule,
    TenantErasureTargetModule.forService('config-service'),

    ConfigurationModule,
    HealthModule,
    // OBS-HIGH-001: Prometheus GET /metrics scrape endpoint + HTTP metrics
    // middleware (self-contained platform module — controller is @Public()).
    ServiceMetricsModule,
    /** SEC-M22: Audit trail infrastructure for compliance tracking. */
    AuditLogModule.forRoot(),
    /**
     * SEC-DB: Tenant Row-Level Security.
     *
     * config-service stores per-tenant configuration in a single global
     * table — RLS is the only DB-level isolation guard for it.
     *
     * autoApply runs the helper at OnApplicationBootstrap to install /
     * verify the RLS policy alongside the schema migrations applied by
     * ConfigMigrationRunnerService (declared at the top of this file).
     * The two lifecycle hooks are independent: the migration runner
     * shapes the table surface, the RLS bootstrap pins the policy on
     * top of it. Idempotent in both directions.
     */
    RlsModule.forPoolService({
      serviceName: 'config',
      autoApply: !configSchemaDdlOwnedByDbMigrate,
    }),
    /**
     * NEW-H1: Convert TIMESTAMP audit columns to TIMESTAMPTZ at cold start.
     *
     * Works alongside ConfigMigrationRunnerService (above) — the runner
     * applies any pending DDL via the migration ledger; this bootstrap
     * normalises the audit column type independently of migration order
     * (idempotent ALTER TYPE that is a no-op once the columns are
     * TIMESTAMPTZ). Closes NEW-H1 on the same OnApplicationBootstrap
     * hook.
     */
    ...(configSchemaDdlOwnedByDbMigrate
      ? []
      : [AuditColumnsModule.forRoot({ serviceName: 'config' })]),
    /** P11 of 2026-04-14 teardown — runtime schema-drift validator. */
    SchemaDriftModule.forRoot({ serviceName: 'config' }),
  ],
  providers: [
    // Migration runner — runs pending TypeORM migrations at
    // OnApplicationBootstrap. See const declaration near top of file for
    // architectural rationale.
    ConfigMigrationRunnerService,
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
        new ServiceIdentityGuard(configService, undefined, 'config-service'),
      inject: [ConfigService],
    },
    // SECURITY: Tenant guard - ensures tenant isolation (defense-in-depth)
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
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(StripInternalHeadersMiddleware, VerifiedUserAssertionMiddleware).forRoutes('*');
  }
}
