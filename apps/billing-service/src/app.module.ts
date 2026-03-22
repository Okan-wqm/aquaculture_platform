import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import { join } from 'path';
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
} from '@nestjs/apollo';
import { ScheduleModule } from '@nestjs/schedule';
import { RedisModule, TenantGuard, RolesGuard, LoggingModule } from '@aquaculture/backend-common';
import { EventBusModule } from '@platform/event-bus';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { BillingModule } from './billing/billing.module';
import { HealthModule } from './health/health.module';
import { MeteringModule } from './modules/metering/metering.module';

// Nested ObjectTypes for orphanedTypes registration
import { InvoiceLineItem, TaxInfo, BillingAddress } from './billing/entities/invoice.entity';
import { PaymentMethodDetails, RefundInfo } from './billing/entities/payment.entity';
import { PlanLimits, PlanPricing } from './billing/entities/subscription.entity';
import { ModuleQuantities, ModuleLineItem } from './billing/entities/subscription-module-item.entity';

@Module({
  imports: [
    LoggingModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    // Database connection with schema separation
    // billing-service owns the 'billing' schema
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        // SECURITY: Fail fast if database password is not configured
        const dbPassword = configService.get<string>('DATABASE_PASSWORD');
        if (!dbPassword) {
          throw new Error('SECURITY: DATABASE_PASSWORD must be configured');
        }
        return {
        type: 'postgres',
        host: configService.get('DATABASE_HOST', 'localhost'),
        port: configService.get<number>('DATABASE_PORT', 5432),
        username: configService.get('DATABASE_USER', 'postgres'),
        password: dbPassword,
        database: configService.get('DATABASE_NAME', 'aquaculture'),
        schema: configService.get('DATABASE_SCHEMA', 'billing'),
        autoLoadEntities: true,
        synchronize: configService.get('NODE_ENV') !== 'production',
        logging: configService.get('NODE_ENV') === 'development',
        // SECURITY: SSL configuration with proper certificate validation
        ssl: (() => {
          const sslEnabled = configService.get('DB_SSL') === 'true';
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
    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      autoSchemaFile: { federation: 2, path: join('/tmp', 'schema.graphql') },
      buildSchemaOptions: {
        orphanedTypes: [
          InvoiceLineItem,
          TaxInfo,
          BillingAddress,
          PaymentMethodDetails,
          RefundInfo,
          PlanLimits,
          PlanPricing,
          ModuleQuantities,
          ModuleLineItem,
        ],
      },
      // SECURITY: Internal subgraph - always disable playground and introspection
      playground: false,
      introspection: false,
      context: ({ req }: { req: Request }) => ({ req }),
    }),
    // Redis for caching and distributed state
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        url: configService.get('REDIS_URL'),
        host: configService.get('REDIS_HOST', 'localhost'),
        port: configService.get<number>('REDIS_PORT', 6379),
        password: configService.get('REDIS_PASSWORD'),
        keyPrefix: 'billing:',
      }),
    }),
    // Event Bus Module (NATS JetStream)
    EventBusModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        natsUrl: configService.get('NATS_URL', 'nats://localhost:4222'),
        streamName: configService.get('NATS_STREAM_NAME', 'AQUACULTURE_EVENTS'),
      }),
    }),
    // Schedule module — single forRoot() for the entire service
    ScheduleModule.forRoot(),
    BillingModule,
    MeteringModule,
    HealthModule,
  ],
  providers: [
    // SECURITY: Global JWT auth guard - requires authentication on all resolvers
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    // SECURITY: Global tenant guard - ensures tenant isolation
    {
      provide: APP_GUARD,
      useClass: TenantGuard,
    },
    // SECURITY: Roles guard - enforces @Roles() decorator authorization
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule {}
