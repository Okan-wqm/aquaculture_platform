import { ThrottlerModule, RedisModule, LoggingModule, RlsModule, AdminBypassRlsInterceptor, SchemaDriftModule } from '@aquaculture/backend-common';
import { Module, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { CqrsModule } from '@nestjs/cqrs';
// JwtModule added: PlatformAdminGuard now uses JwtService.verifyAsync() with
// centralised getJwtVerifyOptions() instead of raw jwt.verify() (sync, no algorithm restriction).
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventBusModule } from '@platform/event-bus';

import { ConvertTimestampToTimestamptz1781500000000 } from './migrations/1781500000000-ConvertTimestampToTimestamptz';
import { AddMfaCompletedToImpersonationSessions1782100000000 } from './migrations/1782100000000-AddMfaCompletedToImpersonationSessions';
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
import { ResponseInterceptor } from './shared/response.interceptor';
import { SystemMetricsModule } from './metrics/system-metrics.module';
import { SystemModulesModule } from './modules/modules.module';
import { SecurityModule } from './security/security.module';
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
    // Database connection with schema separation
    // admin-api-service owns the 'admin' schema
    // Note: Also has read-only access to auth/billing schemas for analytics
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        // SECURITY: Fail fast in production if database password is not configured
        const dbPassword = configService.get<string>('DATABASE_PASSWORD');
        if (!dbPassword && process.env['NODE_ENV'] === 'production') {
          throw new Error('SECURITY: DATABASE_PASSWORD must be set in production');
        }
        return {
        type: 'postgres',
        host: configService.get<string>('DATABASE_HOST', 'localhost'),
        port: configService.get<number>('DATABASE_PORT', 5432),
        username: configService.get<string>('DATABASE_USER', 'postgres'),
        password: dbPassword || 'postgres',
        database: configService.get<string>('DATABASE_NAME', 'aquaculture'),
        schema: configService.get<string>('DATABASE_SCHEMA', 'admin'),
        autoLoadEntities: true,
        // SECURITY: Default to false — explicit DATABASE_SYNC=true required.
        // Shared bootstrap guards against DATABASE_SYNC=true in production.
        synchronize: configService.get('DATABASE_SYNC', 'false') === 'true',
        // Enterprise: Run pending migrations on startup (idempotent,
        // safe for multi-replica because TypeORM tracks applied
        // migrations in the `migrations` table with advisory-lock
        // based single-runner semantics).
        migrationsRun:
          configService.get('DATABASE_MIGRATIONS_RUN', 'true') === 'true',
        // Class references (not glob paths) — webpack bundles all files
        // into main.js and glob patterns match zero files at runtime.
        // Matches the pattern used by farm-service and messaging-service.
        migrations: [
          ConvertTimestampToTimestamptz1781500000000,
          AddMfaCompletedToImpersonationSessions1782100000000,
        ],
        logging: configService.get<string>('NODE_ENV') === 'development',
        // SECURITY: SSL configuration with proper certificate validation
        ssl: (() => {
          const sslEnabled = configService.get<string>('DB_SSL') === 'true';
          if (!sslEnabled) return false;

          const isProduction = configService.get('NODE_ENV') === 'production';
          const caPath = configService.get<string>('DATABASE_SSL_CA');
          const rejectUnauthorized = configService.get('DATABASE_SSL_REJECT_UNAUTHORIZED', 'true') !== 'false';

          if (isProduction && !rejectUnauthorized && !caPath) {
            new Logger('TypeORM').warn('SECURITY: SSL certificate verification disabled in production. Set DATABASE_SSL_CA for MITM protection.');
          }

          return {
            rejectUnauthorized,
            ...(caPath ? { ca: require('fs').readFileSync(caPath) } : {}),
          };
        })(),
        extra: {
          // MEDIUM-007 fix: raised default pool size from 20 → 40.
          // The admin-api-service fans out to 5 parallel metric queries on every
          // dashboard call; 20 connections exhausted under concurrent usage.
          max: configService.get<number>('DB_POOL_SIZE', 40),
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000,
        },
      };
      },
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
          logging: configService.get<string>('NODE_ENV') === 'development',
          ssl: (() => {
            const sslEnabled = configService.get<string>('DB_SSL') === 'true';
            if (!sslEnabled) return false;
            const caPath = configService.get<string>('DATABASE_SSL_CA');
            const rejectUnauthorized = configService.get('DATABASE_SSL_REJECT_UNAUTHORIZED', 'true') !== 'false';
            return {
              rejectUnauthorized,
              ...(caPath ? { ca: require('fs').readFileSync(caPath) } : {}),
            };
          })(),
          extra: {
            // SECURITY: Force read-only at connection level — defense-in-depth
            options: '-c default_transaction_read_only=on',
            max: configService.get<number>('DB_EXPLORER_POOL_SIZE', 5),
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
          },
        };
      },
    }),
    CqrsModule.forRoot(),
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
    SystemMetricsModule,
    HealthModule,
    UsersModule,
    SystemModulesModule,
    SettingsModule,
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
    // SECURITY (CRITICAL-001): RS256 asymmetric verification — public key only.
    // admin-api-service is a token CONSUMER, not an issuer. It verifies tokens
    // using the RSA public key from auth-service. JWT_SECRET is no longer accepted.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const { getJwtVerifyOptions } = require('@aquaculture/backend-common');
        const verifyOpts = getJwtVerifyOptions(config);
        return {
          publicKey: verifyOpts.publicKey,
          verifyOptions: {
            algorithms: ['RS256'],
            issuer: verifyOpts.issuer,
            audience: verifyOpts.audience,
          },
        };
      },
    }),
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
    RlsModule.forRoot({
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
