import { Module, NestModule, MiddlewareConsumer, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import { join } from 'path';
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
} from '@nestjs/apollo';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import depthLimit from 'graphql-depth-limit';
import { RedisModule, TenantGuard, RolesGuard, LoggingModule, ServiceIdentityGuard, UserContextMiddleware, TenantContextMiddleware, AuditLogModule, AuditLogInterceptor, RlsModule, AuditColumnsModule } from '@aquaculture/backend-common';
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
      };
      },
    }),
    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      autoSchemaFile: { federation: 2, path: join('/tmp', 'schema.graphql') },
      /** SEC-M21: Disable GraphQL query batching to prevent batch-based brute-force attacks.
       *  The gateway already blocks batching, but subgraphs must also enforce this as
       *  defense-in-depth in case a subgraph becomes directly accessible. */
      allowBatchedHttpRequests: false,
      /**
       * SECURITY (H-05): depthLimit(10) prevents deeply nested query DoS attacks.
       * Without depth limiting, an attacker can craft a deeply nested GraphQL query
       * that causes exponential resource consumption on the server.
       */
      validationRules: [depthLimit(10)],
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
      /**
       * In @nestjs/graphql v13 (NestJS v11), the 'playground' option is internally
       * mapped to Apollo Sandbox via ApolloServerPluginLandingPageLocalDefault.
       * When false, ApolloServerPluginLandingPageDisabled is applied instead.
       * Disabled in production for security (no introspection exposure).
       */
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
    // Event Emitter — single forRoot() for the entire service
    EventEmitterModule.forRoot(),
    BillingModule,
    MeteringModule,
    HealthModule,
    /** SEC-M22: Audit trail infrastructure for compliance tracking. */
    AuditLogModule.forRoot(),
    /**
     * SEC-DB: Tenant Row-Level Security.
     *
     * - serviceName: 'billing' — log prefix for RlsConnectionBootstrap and
     *   RlsSchemaBootstrap so RLS-related lines are easy to grep.
     * - autoApply: true — billing-service has no TypeORM migration runner
     *   (synchronize was removed in commit 5ce2b127), so policies are
     *   installed at OnApplicationBootstrap by RlsSchemaBootstrap. The
     *   helper is idempotent — cold restarts re-install the canonical
     *   predicate without manual intervention.
     */
    RlsModule.forRoot({
      serviceName: 'billing',
      autoApply: true,
    }),
    /**
     * NEW-H1: Convert TIMESTAMP audit columns to TIMESTAMPTZ at cold start.
     *
     * billing-service has no TypeORM migration runner — synchronize was
     * removed in commit 5ce2b127 to lock the schema down. The bootstrap
     * path closes the audit-column blind spot via OnApplicationBootstrap,
     * mirroring how RlsSchemaBootstrap above installs RLS policies on
     * the same lifecycle hook. Idempotent at the discovery layer.
     *
     * No excludeTables — all billing-service tables should use TIMESTAMPTZ
     * for audit-trail integrity (financial timestamps are compliance-
     * sensitive and must not drift across DST).
     */
    AuditColumnsModule.forRoot({ serviceName: 'billing' }),
  ],
  providers: [
    // SECURITY: Service identity guard - validates HMAC-signed service identity headers
    // Must be FIRST guard (before auth/tenant/roles) to verify request origin
    // WHY: useFactory bypasses reflect-metadata resolution which fails in Docker Alpine.
    {
      provide: APP_GUARD,
      useFactory: (configService: ConfigService): ServiceIdentityGuard =>
        new ServiceIdentityGuard(configService),
      inject: [ConfigService],
    },
    // SECURITY: Global JWT auth guard - requires authentication on all resolvers
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector): JwtAuthGuard =>
        new JwtAuthGuard(reflector),
      inject: [Reflector],
    },
    // SECURITY: Global tenant guard - ensures tenant isolation
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
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Middleware execution order:
    // 1. UserContextMiddleware - Parse x-user-payload header from gateway (sets req.user)
    // 2. TenantContextMiddleware - Extract tenant from JWT/headers (uses req.user.tenantId)
    consumer
      .apply(UserContextMiddleware, TenantContextMiddleware)
      .forRoutes('*');
  }
}
