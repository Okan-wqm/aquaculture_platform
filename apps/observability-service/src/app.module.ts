import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PrometheusModule } from './prometheus/prometheus.module';
import { MetricsAggregatorModule } from './metrics/metrics-aggregator.module';
import { HealthModule } from './health/health.module';
import { TracingModule } from './tracing/tracing.module';

@Module({
  imports: [
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
        database: configService.get<string>('DB_NAME', 'aquaculture_observability'),
        autoLoadEntities: true,
        synchronize: configService.get<string>('NODE_ENV') === 'development',
        logging: configService.get<string>('NODE_ENV') === 'development',
        ssl:
          configService.get<string>('DB_SSL') === 'true'
            ? { rejectUnauthorized: false }
            : false,
        extra: {
          max: configService.get<number>('DB_POOL_SIZE', 10),
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000,
        },
      }),
    }),
    PrometheusModule,
    MetricsAggregatorModule,
    HealthModule,
    TracingModule,
  ],
})
export class AppModule {}
