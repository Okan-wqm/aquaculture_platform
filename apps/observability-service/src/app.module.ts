import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { readFile } from 'fs/promises';
import { PrometheusModule } from './prometheus/prometheus.module';
import { MetricsAggregatorModule } from './metrics/metrics-aggregator.module';
import { HealthModule } from './health/health.module';
import { TracingModule } from './tracing/tracing.module';
import { InternalApiGuard } from './guards/internal-api.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const sslEnabled = configService.get<string>('DB_SSL') === 'true';
        const isProduction = configService.get('NODE_ENV') === 'production';
        const caPath = configService.get<string>('DATABASE_SSL_CA');
        const rejectUnauthorized =
          configService.get('DATABASE_SSL_REJECT_UNAUTHORIZED', 'true') !== 'false';

        let sslConfig: boolean | Record<string, unknown> = false;
        if (sslEnabled) {
          if (isProduction && !rejectUnauthorized && !caPath) {
            console.warn('WARNING: SSL certificate verification disabled in production!');
          }
          // Read CA certificate asynchronously to avoid blocking the event loop
          const ca = caPath ? await readFile(caPath) : undefined;
          sslConfig = { rejectUnauthorized, ...(ca ? { ca } : {}) };
        }

        return {
          type: 'postgres',
          host: configService.get<string>('DB_HOST', 'localhost'),
          port: configService.get<number>('DB_PORT', 5432),
          username: configService.get<string>('DB_USERNAME', 'postgres'),
          password: configService.get<string>('DB_PASSWORD', 'postgres'),
          database: configService.get<string>('DB_NAME', 'aquaculture_observability'),
          autoLoadEntities: true,
          synchronize: configService.get<string>('NODE_ENV') === 'development',
          logging: configService.get<string>('NODE_ENV') === 'development',
          // SECURITY: SSL configuration with proper certificate validation
          ssl: sslConfig,
          extra: {
            max: configService.get<number>('DB_POOL_SIZE', 10),
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
          },
        };
      },
    }),
    PrometheusModule,
    MetricsAggregatorModule,
    HealthModule,
    TracingModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: InternalApiGuard,
    },
  ],
})
export class AppModule {}
