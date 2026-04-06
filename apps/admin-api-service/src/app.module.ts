import { ThrottlerModule, RedisModule, LoggingModule } from '@aquaculture/backend-common';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { CqrsModule } from '@nestjs/cqrs';
// JwtModule added: PlatformAdminGuard now uses JwtService.verifyAsync() with
// centralised getJwtVerifyOptions() instead of raw jwt.verify() (sync, no algorithm restriction).
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventBusModule } from '@platform/event-bus';

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
        // Admin-api-service owns the 'admin' schema and all its tables.
        // synchronize:true is safe here because admin schema is exclusively owned by this service.
        // Set DATABASE_SYNC=false to disable (e.g., after initial setup).
        synchronize: configService.get('DATABASE_SYNC', 'true') === 'true',
        logging: configService.get<string>('NODE_ENV') === 'development',
        // SECURITY: SSL configuration with proper certificate validation
        ssl: (() => {
          const sslEnabled = configService.get<string>('DB_SSL') === 'true';
          if (!sslEnabled) return false;

          const isProduction = configService.get('NODE_ENV') === 'production';
          const caPath = configService.get<string>('DATABASE_SSL_CA');
          const rejectUnauthorized = configService.get('DATABASE_SSL_REJECT_UNAUTHORIZED', 'true') !== 'false';

          if (isProduction && !rejectUnauthorized && !caPath) {
            console.warn('⚠️  WARNING: SSL certificate verification disabled in production!');
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
    PasswordResetModule,
    // SECURITY (NEW-03): forRoot() returns empty module when ENABLE_DEBUG_TOOLS != 'true'.
    // No controllers, providers, or entities are registered in the disabled state.
    DebugToolsModule.forRoot(),
    // JwtModule: provides JwtService for PlatformAdminGuard async verification.
    // BEFORE: guard used synchronous jwt.verify() without algorithm restriction.
    // AFTER: guard uses JwtService.verifyAsync() via getJwtVerifyOptions() — async,
    // non-blocking, and enforces HS256 algorithm + issuer + audience.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { algorithm: 'HS256' },
      }),
    }),
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
    GracefulShutdownService,
  ],
})
export class AppModule {}
