import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { TenantManagementModule } from './tenant/tenant.module';
import { AuditLogModule } from './audit/audit.module';
import { SystemMetricsModule } from './metrics/system-metrics.module';
import { HealthModule } from './health/health.module';
import { UsersModule } from './users/users.module';
import { SystemModulesModule } from './modules/modules.module';
import { SettingsModule } from './settings/settings.module';
import { BillingModule } from './billing/billing.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { DatabaseManagementModule } from './database-management/database-management.module';
import { SupportModule } from './support/support.module';
import { SecurityModule } from './security/security.module';
import { SystemManagementModule } from './system-management/system-management.module';
import { ImpersonationModule } from './impersonation/impersonation.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { PlatformAdminGuard } from './guards/platform-admin.guard';

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
        synchronize: configService.get<string>('NODE_ENV') === 'development',
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
          max: configService.get<number>('DB_POOL_SIZE', 20),
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000,
        },
      };
      },
    }),
    CqrsModule,
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
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    {
      provide: APP_GUARD,
      useClass: PlatformAdminGuard,
    },
  ],
})
export class AppModule {}
