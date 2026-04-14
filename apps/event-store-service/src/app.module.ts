import { Module, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { LoggingModule } from '@aquaculture/backend-common';
import { InternalApiKeyGuard } from './guards/internal-api-key.guard';
import { EventStoreModule } from './event-store/event-store.module';
import { ProjectionsModule } from './projections/projections.module';
import { HealthModule } from './health/health.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { AddStoredEventsImmutabilityTriggers1782000000000 } from './migrations/1782000000000-AddStoredEventsImmutabilityTriggers';

@Module({
  imports: [
    LoggingModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST', 'localhost'),
        port: configService.get<number>('DB_PORT', 5432),
        username: configService.get<string>('DB_USERNAME', 'postgres'),
        password: configService.get<string>('DB_PASSWORD', 'postgres'),
        database: configService.get<string>('DB_NAME', 'aquaculture_events'),
        autoLoadEntities: true,
        synchronize: configService.get<string>('NODE_ENV') === 'development',
        migrationsRun:
          configService.get('DATABASE_MIGRATIONS_RUN', 'true') === 'true',
        migrations: [
          AddStoredEventsImmutabilityTriggers1782000000000,
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
          max: configService.get<number>('DB_POOL_SIZE', 20),
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000,
        },
      }),
    }),
    CqrsModule.forRoot(),
    // Schedule module — single forRoot() for the entire service
    ScheduleModule.forRoot(),
    EventStoreModule,
    ProjectionsModule,
    HealthModule,
    /**
     * SECURITY (HIGH-004): Tenant RLS on event-store projections.
     * stored_events and projection tables carry tenant_id; autoApply runs
     * the helper at OnApplicationBootstrap so policies are idempotently
     * installed on every cold start.
     */
    RlsModule.forPoolService({
      serviceName: 'event-store',
      autoApply: true,
      excludeTables: ['stored_events', 'projection_checkpoint'],
    }),
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    /**
     * Global authentication guard for event-store-service.
     * InternalApiKeyGuard ensures only authenticated internal services
     * can access event streams. This prevents unauthorized containers
     * from reading or writing tenant event data.
     */
    {
      provide: APP_GUARD,
      useClass: InternalApiKeyGuard,
    },
  ],
})
export class AppModule {}
