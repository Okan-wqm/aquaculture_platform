import { PlatformJwtModule } from '@aquaculture/backend-common/auth';
import {
  AdminBypassRlsInterceptor,
  buildDatabaseSslConfig,
  createServiceTypeOrmConfig,
  RlsModule,
  SchemaDriftModule,
} from '@aquaculture/backend-common/database';
import { LoggingModule } from '@aquaculture/backend-common/logging';
import { RedisModule } from '@aquaculture/backend-common/redis';
import { CircuitBreakerModule } from '@aquaculture/backend-common/resilience';
import { ThrottlerModule } from '@aquaculture/backend-common/security';
import { Module, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { CqrsModule } from '@nestjs/cqrs';
// PlatformAdminGuard injects JwtService for verifyAsync() — JwtService is
// provided by PlatformJwtModule (which re-exports JwtModule), so we still
// need the named-type import here for DI metadata.
import { JwtService } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventBusModule } from '@platform/event-bus';

import { ConvertTimestampToTimestamptz1781500000000 } from './migrations/1781500000000-ConvertTimestampToTimestamptz';
import { ConvertAuditColumnsToTimestamptz1781900000000 } from './migrations/1781900000000-ConvertAuditColumnsToTimestamptz';
import { AuditLogImmutability1782000000000 } from './migrations/1782000000000-AuditLogImmutability';
import { AddMfaCompletedToImpersonationSessions1782100000000 } from './migrations/1782100000000-AddMfaCompletedToImpersonationSessions';
import { MoveSharedTablesFromAdminToShared1782200000000 } from './migrations/1782200000000-MoveSharedTablesFromAdminToShared';
import { MoveUserPermissionsToShared1786900000000 } from './migrations/1786900000000-MoveUserPermissionsToShared';
import { GrantSharedSchemaPrivileges1787000000000 } from './migrations/1787000000000-GrantSharedSchemaPrivileges';
import { CreateAdminAuditLogsTable1787100000000 } from './migrations/1787100000000-CreateAdminAuditLogsTable';
import { RealignSharedAuditLogsSchema1787200000000 } from './migrations/1787200000000-RealignSharedAuditLogsSchema';
import { CreateIngestBackendPolicyState1787300000000 } from './migrations/1787300000000-CreateIngestBackendPolicyState';
import { RestoreSharedAuditLogsImmutability1787400000000 } from './migrations/1787400000000-RestoreSharedAuditLogsImmutability';
import { CreateComplianceLegalHolds1787500000000 } from './migrations/1787500000000-CreateComplianceLegalHolds';
import { AddGdprDataRequestsCheckConstraints1787600000000 } from './migrations/1787600000000-AddGdprDataRequestsCheckConstraints';
import { AddUserConsentsNaturalKeyUnique1787700000000 } from './migrations/1787700000000-AddUserConsentsNaturalKeyUnique';
import { AddAdminAuditLogsImmutability1787800000000 } from './migrations/1787800000000-AddAdminAuditLogsImmutability';
import { AddUserPermissionsUserFk1787900000000 } from './migrations/1787900000000-AddUserPermissionsUserFk';
import { ConvertAuditIpColumnsToInet1788000000000 } from './migrations/1788000000000-ConvertAuditIpColumnsToInet';
import { AddAuditLogShapeExtension1788100000000 } from './migrations/1788100000000-AddAuditLogShapeExtension';
import { CreateSharedAccessLogs1788400000000 } from './migrations/1788400000000-CreateSharedAccessLogs';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuditLogModule } from './audit/audit.module';
import { AdminApiRetentionBootstrapModule } from './retention/retention-bootstrap.module';
import { PasswordResetModule } from './auth/password-reset.module';
import { BillingModule } from './billing/billing.module';
import { DatabaseManagementModule } from './database-management/database-management.module';
// SECURITY (NEW-03): DebugToolsModule uses forRoot() pattern — disabled by default in all
// environments. Only enabled when ENABLE_DEBUG_TOOLS=true. See debug-tools.module.ts for details.
import { DebugToolsModule } from './debug-tools/debug-tools.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { HealthModule } from './health/health.module';
import { ImpersonationModule } from './impersonation/impersonation.module';
import { GracefulShutdownService } from './lifecycle/graceful-shutdown.service';
import { ResponseInterceptor } from './shared/response.interceptor';
import { SystemMetricsModule } from './metrics/system-metrics.module';
import { SystemModulesModule } from './modules/modules.module';
import { SecurityModule } from './security/security.module';
import { IngestBackendPolicyModule } from './policy/policy.module';
import { SettingsModule } from './settings/settings.module';
import { SupportModule } from './support/support.module';
import { SystemManagementModule } from './system-management/system-management.module';
import { TenantManagementModule } from './tenant/tenant.module';
import { MessagingAdminModule } from './messaging/messaging-admin.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    // Database connection — admin-api-service owns the 'admin' schema and
    // has read-only access to auth/billing for analytics. Uses the
    // platform TypeORM factory so pool size, SSL, fail-fast, env-var
    // contract, and search_path semantics stay identical across services.
    //
    // INFRA-DB-SSL-001 fix: previously read DB_SSL while compose set
    // DATABASE_SSL — SSL was silently disabled. Factory uses DATABASE_SSL.
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        createServiceTypeOrmConfig(configService, {
          serviceName: 'admin-api',
          schema: 'admin',
          // MEDIUM-007: dashboard fans out 5 parallel metric queries. With a
          // pool of 10, two concurrent dashboard loads drained the pool;
          // operators saw `connection pool exhausted` under normal admin
          // traffic. 40 was validated under concurrent superadmin sessions
          // in 2026-Q1. Operators may further raise via DATABASE_POOL_SIZE.
          defaultPoolSize: 40,
          migrations: [
            ConvertTimestampToTimestamptz1781500000000,
            ConvertAuditColumnsToTimestamptz1781900000000,
            AuditLogImmutability1782000000000,
            AddMfaCompletedToImpersonationSessions1782100000000,
            MoveSharedTablesFromAdminToShared1782200000000,
            MoveUserPermissionsToShared1786900000000,
            GrantSharedSchemaPrivileges1787000000000,
            CreateAdminAuditLogsTable1787100000000,
            RealignSharedAuditLogsSchema1787200000000,
            CreateIngestBackendPolicyState1787300000000,
            RestoreSharedAuditLogsImmutability1787400000000,
            CreateComplianceLegalHolds1787500000000,
            AddGdprDataRequestsCheckConstraints1787600000000,
            AddUserConsentsNaturalKeyUnique1787700000000,
            AddAdminAuditLogsImmutability1787800000000,
            AddUserPermissionsUserFk1787900000000,
            ConvertAuditIpColumnsToInet1788000000000,
            AddAuditLogShapeExtension1788100000000,
            CreateSharedAccessLogs1788400000000,
          ],
          // admin-api opts in to TypeORM's built-in migration runner via the
          // legacy DATABASE_MIGRATIONS_RUN env var (default true). All other
          // services use MigrationRunnerService factory pattern instead.
          migrationsRunFromEnv: (cfg) =>
            cfg.get('DATABASE_MIGRATIONS_RUN', 'true') === 'true',
        }),
    }),
    /**
     * SECURITY (ADMIN-CRITICAL-004): Read-only DataSource for DB Explorer.
     *
     * The DB Explorer panel must NEVER write to the database. This second
     * DataSource uses the same PostgreSQL credentials but forces
     * `default_transaction_read_only=on` at the connection level. Even if
     * application-level query validation is bypassed, PostgreSQL itself
     * will reject any DML/DDL statement.
     *
     * Injected in explorer.controller.ts via @InjectDataSource('explorer-readonly').
     */
    TypeOrmModule.forRootAsync({
      name: 'explorer-readonly',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const dbPassword = configService.get<string>('DATABASE_PASSWORD');
        return {
          type: 'postgres',
          host: configService.get<string>('DATABASE_HOST', 'localhost'),
          port: configService.get<number>('DATABASE_PORT', 5432),
          username: configService.get<string>('DATABASE_READONLY_USER',
            configService.get<string>('DATABASE_USER', 'postgres')),
          password: configService.get<string>('DATABASE_READONLY_PASSWORD',
            dbPassword || 'postgres'),
          database: configService.get<string>('DATABASE_NAME', 'aquaculture'),
          schema: configService.get<string>('DATABASE_SCHEMA', 'admin'),
          // SECURITY: No entities — this DataSource is for raw queries only
          entities: [],
          synchronize: false,
          logging: configService.get<string>('DATABASE_LOGGING', 'false') === 'true',
          // INFRA-DB-SSL-001: previously read DB_SSL while compose set DATABASE_SSL.
          // buildDatabaseSslConfig is the single source of truth for SSL env-var contract.
          ssl: buildDatabaseSslConfig(configService),
          extra: {
            // SECURITY: Force read-only at connection level — defense-in-depth.
            // Independent from the platform factory because Explorer needs
            // `-c default_transaction_read_only=on` instead of a search_path
            // hint and does not participate in the connection-budget rules.
            options: '-c default_transaction_read_only=on',
            max: configService.get<number>('DB_EXPLORER_POOL_SIZE', 5),
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
          },
        };
      },
    }),
    CqrsModule.forRoot(),
    // CIRCUIT-LOW-001 cure foundation: Global circuit breaker for
    // every cross-service fetch in admin-api (system-metrics scraper,
    // performance-monitoring fetch). @Global so feature modules
    // constructor-inject CircuitBreakerService directly.
    CircuitBreakerModule,
    // Schedule module — single forRoot() for the entire service
    ScheduleModule.forRoot(),
    // NATS Event Bus for cross-service event publishing
    EventBusModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        natsUrl: configService.get<string>('NATS_URL', 'nats://localhost:4222'),
        streamName: configService.get<string>('NATS_STREAM_NAME', 'AQUACULTURE_EVENTS'),
      }),
    }),
    LoggingModule,
    ThrottlerModule,
    // Redis for caching and distributed rate limiting
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        host: configService.get('REDIS_HOST', 'localhost'),
        port: parseInt(configService.get('REDIS_PORT', '6379'), 10),
        password: configService.get('REDIS_PASSWORD'),
        db: parseInt(configService.get('REDIS_DB', '0'), 10),
        keyPrefix: 'admin:',
      }),
    }),
    TenantManagementModule,
    AuditLogModule,
    // COMPLIANCE-MEDIUM-001 cure: register retention policies for
    // shared.audit_logs + admin.audit_logs with the canonical
    // RetentionEnforcementService cron (03:00 UTC daily).
    AdminApiRetentionBootstrapModule,
    SystemMetricsModule,
    HealthModule,
    UsersModule,
    SystemModulesModule,
    SettingsModule,
    // ADR-031 ingest-backend policy: admin-api owns the SoT +
    // publishes `policy.ingest_backend.changed` + responds to
    // `policy.ingest_backend.snapshot`.
    IngestBackendPolicyModule,
    BillingModule,
    AnalyticsModule,
    DatabaseManagementModule,
    SupportModule,
    SecurityModule,
    SystemManagementModule,
    ImpersonationModule,
    MessagingAdminModule,
    PasswordResetModule,
    // SECURITY (NEW-03): forRoot() returns empty module when ENABLE_DEBUG_TOOLS != 'true'.
    // No controllers, providers, or entities are registered in the disabled state.
    DebugToolsModule.forRoot(),
    // SECURITY (CRITICAL-001): RS256 asymmetric verification via the shared
    // PlatformJwtModule. admin-api-service is a token CONSUMER, not an issuer.
    // Replaced the per-service JwtModule.registerAsync block (WS2.B,
    // 2026-04-14). PlatformAdminGuard injects JwtService — JwtService comes
    // from PlatformJwtModule (which re-exports JwtModule).
    PlatformJwtModule,
    /**
     * SEC-DB: Tenant Row-Level Security wiring for an admin-only service.
     *
     * autoApply is FALSE because admin-api-service does not own any
     * tenant-scoped tables of its own that need RLS — every query it
     * issues is a cross-tenant analytics read against `auth.*`,
     * `billing.*`, etc. The pool patch (RlsConnectionBootstrap) is still
     * registered so that `app.bypass_rls` propagates to the connection
     * when the AdminBypassRlsInterceptor wraps the request.
     *
     * The interceptor is registered below as APP_INTERCEPTOR so EVERY
     * request automatically runs inside `BypassRlsService.withBypass()`.
     */
    RlsModule.forPoolService({
      serviceName: 'admin-api',
      autoApply: false,
    }),
    /**
     * P11 of 2026-04-14 teardown — runtime schema-drift validator.
     * See ADR-012 + docs/runbooks/schema-drift-response.md.
     */
    SchemaDriftModule.forRoot({ serviceName: 'admin-api' }),
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    // WHY: PlatformAdminGuard registered as named class-token provider via useFactory.
    // @UseGuards(PlatformAdminGuard) on controllers resolves the guard from the DI container
    // using the class token — NOT the APP_GUARD symbol. Without this explicit registration,
    // NestJS falls back to reflect-metadata class resolution which fails in Docker Alpine.
    {
      provide: PlatformAdminGuard,
      useFactory: (reflector: Reflector, configService: ConfigService, jwtService: JwtService): PlatformAdminGuard =>
        new PlatformAdminGuard(reflector, configService, jwtService),
      inject: [Reflector, ConfigService, JwtService],
    },
    {
      provide: APP_GUARD,
      useExisting: PlatformAdminGuard,
    },
    // ThrottlerGuard removed: admin-api is super-admin-only (PlatformAdminGuard).
    // Rate limiting an authenticated admin panel with ~15 concurrent dashboard
    // requests causes 429 floods. Individual sensitive endpoints (login, password
    // reset) still use per-route @Throttle() decorators via backend-common.
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseInterceptor,
    },
    /**
     * SEC-DB: Wrap every admin-api request in BypassRlsService.withBypass()
     * so cross-schema reads against billing/notification/config (which
     * have RLS enforced) succeed. The interceptor logs every grant/release
     * via BypassRlsService — see audit trail discussion in its docblock.
     */
    {
      provide: APP_INTERCEPTOR,
      useClass: AdminBypassRlsInterceptor,
    },
    GracefulShutdownService,
  ],
})
export class AppModule {}
