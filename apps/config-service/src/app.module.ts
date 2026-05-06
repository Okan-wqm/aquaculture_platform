import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloFederationDriver, ApolloFederationDriverConfig } from '@nestjs/apollo';
import { join } from 'path';
import { CqrsModule } from '@nestjs/cqrs';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import depthLimit from 'graphql-depth-limit';
import { TenantGuard, RolesGuard, LoggingModule, ServiceIdentityGuard, RlsModule, AuditColumnsModule, createMigrationRunnerService, SchemaDriftModule, PlatformJwtModule } from '@aquaculture/backend-common';
import { AuditLogModule, AuditLogInterceptor } from '@aquaculture/backend-common/audit';
import { createServiceTypeOrmConfig } from '@aquaculture/backend-common/database';

/**
 * ConfigMigrationRunnerService — runs pending TypeORM migrations in the
 * public schema (config-service's current source — will migrate to a
 * dedicated `config` schema in P6-P10 of the 2026-04-14 teardown plan).
 *
 * Added in P2c of the teardown: migrations/ starts empty because
 * config-service currently relies on TypeORM autoLoadEntities + the RLS
 * bootstrap for schema state. The runner is wired now so that future
 * drift-correcting or RLS-installing migrations can land as deterministic
 * commits rather than another round of hand-applied psql statements (see
 * RlsSchemaBootstrap docblock lines 14-27 for the gap this closes).
 */
const ConfigMigrationRunnerService = createMigrationRunnerService('public');
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

    // Database connection — config-service currently lives in the `public`
    // schema (will migrate to dedicated `config` schema in P6-P10 of the
    // 2026-04-14 teardown plan). Uses the platform TypeORM factory.
    // ConfigMigrationRunnerService (provider above) executes migrations
    // at OnApplicationBootstrap; factory's migrationsRun:false default
    // keeps TypeORM out of that codepath.
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        createServiceTypeOrmConfig(configService, {
          serviceName: 'config',
          schema: 'public',
          migrations: [__dirname + '/database/migrations/*.{js,ts}'],
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
      autoSchemaFile: { federation: 2, path: join('/tmp', 'schema.graphql') },
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
    ConfigurationModule,
    HealthModule,
    /** SEC-M22: Audit trail infrastructure for compliance tracking. */
    AuditLogModule.forRoot(),
    /**
     * SEC-DB: Tenant Row-Level Security.
     *
     * config-service stores per-tenant configuration in a single global
     * table — RLS is the only DB-level isolation guard for it.
     *
     * autoApply runs the helper at OnApplicationBootstrap because there
     * is no migration runner wired in for this service.
     */
    RlsModule.forPoolService({
      serviceName: 'config',
      autoApply: true,
    }),
    /**
     * NEW-H1: Convert TIMESTAMP audit columns to TIMESTAMPTZ at cold start.
     *
     * config-service has no TypeORM migration runner — schema state is
     * managed via TypeORM autoLoadEntities + the RLS bootstrap above.
     * The audit-column bootstrap closes NEW-H1 on the same lifecycle
     * hook. Idempotent.
     */
    AuditColumnsModule.forRoot({ serviceName: 'config' }),
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
        new ServiceIdentityGuard(configService),
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
      useFactory: (reflector: Reflector): RolesGuard =>
        new RolesGuard(reflector),
      inject: [Reflector],
    },
    /** SEC-M22: Register global audit logging for compliance — all mutations are tracked. */
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditLogInterceptor,
    },
  ],
})
export class AppModule {}
