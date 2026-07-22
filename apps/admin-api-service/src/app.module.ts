import { PlatformJwtModule } from '@aquaculture/backend-common/auth';
import {
  AdminBypassRlsInterceptor,
  buildDatabaseSslConfig,
  createSchemaVersionGate,
  createServiceTypeOrmConfig,
  RlsModule,
  SchemaDriftModule,
} from '@aquaculture/backend-common/database';
import { LoggingModule } from '@aquaculture/backend-common/logging';
import { ServiceMetricsModule } from '@aquaculture/backend-common/metrics';
import { RedisModule, buildRedisOptions } from '@aquaculture/backend-common/redis';
import { CircuitBreakerModule } from '@aquaculture/backend-common/resilience';
import {
  ThrottlerGuard,
  ThrottlerModule,
  TOKEN_BLACKLIST,
  TokenBlacklistModule,
  USER_TOKEN_REVOCATION,
  UserTokenRevocationModule,
  type ITokenBlacklist,
  type IUserTokenRevocation,
} from '@aquaculture/backend-common/security';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { CqrsModule } from '@nestjs/cqrs';
// PlatformAdminGuard injects JwtService for verifyAsync() — JwtService is
// provided by PlatformJwtModule (which re-exports JwtModule), so we still
// need the named-type import here for DI metadata.
import { JwtService } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventBusModule, buildEventBusConfig } from '@platform/event-bus';
import { StorageModule } from '@platform/storage';

import { AnalyticsModule } from './analytics/analytics.module';
import { AuditLogModule } from './audit/audit.module';
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
import { MessagingAdminModule } from './messaging/messaging-admin.module';
import { SystemMetricsModule } from './metrics/system-metrics.module';
import { SystemModulesModule } from './modules/modules.module';
import { IngestBackendPolicyModule } from './policy/policy.module';
import { AdminApiRetentionBootstrapModule } from './retention/retention-bootstrap.module';
import { SecurityModule } from './security/security.module';
import { SettingsModule } from './settings/settings.module';
import { ResponseInterceptor } from './shared/response.interceptor';
import { SupportModule } from './support/support.module';
import { SystemManagementModule } from './system-management/system-management.module';
import { TenantManagementModule } from './tenant/tenant.module';
import { UsersModule } from './users/users.module';

const AdminSchemaVersionGate = createSchemaVersionGate('admin');

const getRequiredStorageConfig = (
  configService: ConfigService,
  key: string,
): string => {
  const value = configService.get<string>(key);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required object storage configuration: ${key}`);
  }

  return value;
};

const getAdminStorageConfigValue = (
  configService: ConfigService,
  key: string,
  fallback: string,
): string => {
  if (configService.get<string>('NODE_ENV') === 'production') {
    return getRequiredStorageConfig(configService, key);
  }

  return configService.get<string>(key, fallback);
};

const getAdminStoragePort = (configService: ConfigService): number => {
  const rawPort = configService.get<string>('MINIO_PORT', '9000');
  const port = Number.parseInt(rawPort, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid object storage port: ${rawPort}`);
  }

  return port;
};

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
          migrations: [__dirname + '/migrations/[0-9]*{.ts,.js}'],
          // Single-writer deploy contract: aqua-db-migrate owns production
          // migrations. Local/E2E can still opt in explicitly.
          migrationsRunFromEnv: (cfg) =>
            cfg.get('DATABASE_MIGRATIONS_RUN', 'false') === 'true',
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
      useFactory: buildEventBusConfig,
    }),
    LoggingModule,
    ThrottlerModule,
    // APA-367: token-revocation primitives for PlatformAdminGuard. admin-api is a
    // directly-reachable auth boundary (prod nginx routes /api/ straight here,
    // bypassing gateway-api's blacklist-checking guard), so it MUST self-enforce
    // revocation. Both modules are @Global and export their DI tokens; the
    // TokenBlacklistService is cross-instance correct via the RedisModule below.
    //   - TokenBlacklistModule       → per-jti + `token:blacklist:` bulk marker
    //   - UserTokenRevocationModule  → `user_blacklist:{userId}` epoch (force-logout,
    //                                  deletion, RBAC reduction)
    TokenBlacklistModule,
    UserTokenRevocationModule,
    // Redis for caching and distributed rate limiting
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        buildRedisOptions(configService, 'admin', 'optional'),
    }),
    StorageModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        endpoint: getAdminStorageConfigValue(configService, 'MINIO_ENDPOINT', 'localhost'),
        port: getAdminStoragePort(configService),
        useSSL: configService.get<string>('MINIO_USE_SSL', 'false') === 'true',
        accessKey: getAdminStorageConfigValue(configService, 'MINIO_ACCESS_KEY', 'minioadmin'),
        secretKey: getAdminStorageConfigValue(configService, 'MINIO_SECRET_KEY', 'minioadmin'),
        bucket: configService.get<string>('MINIO_BUCKET', 'aquaculture'),
        region: configService.get<string>('MINIO_REGION', 'us-east-1'),
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
    // OBS-HIGH-001: Prometheus GET /metrics scrape endpoint + HTTP metrics
    // middleware. SystemMetricsModule above is the admin ANALYTICS API
    // (/system/metrics, JSON) — it is not a Prometheus scrape surface.
    ServiceMetricsModule,
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
    AdminSchemaVersionGate,
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
      useFactory: (
        reflector: Reflector,
        configService: ConfigService,
        jwtService: JwtService,
        tokenBlacklist: ITokenBlacklist,
        userTokenRevocation: IUserTokenRevocation,
      ): PlatformAdminGuard =>
        new PlatformAdminGuard(
          reflector,
          configService,
          jwtService,
          tokenBlacklist,
          userTokenRevocation,
        ),
      // APA-367: TOKEN_BLACKLIST + USER_TOKEN_REVOCATION are REQUIRED (not
      // optional) — a missing revocation store fails DI at boot instead of
      // silently shipping a guard that never checks revocation.
      inject: [Reflector, ConfigService, JwtService, TOKEN_BLACKLIST, USER_TOKEN_REVOCATION],
    },
    {
      provide: APP_GUARD,
      useExisting: PlatformAdminGuard,
    },
    {
      provide: APP_GUARD,
      useExisting: ThrottlerGuard,
    },
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
export class AppModule {
  readonly moduleName = AppModule.name;
}
