import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
} from '@nestjs/apollo';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import depthLimit from 'graphql-depth-limit';
import { PlatformJwtModule } from '@aquaculture/backend-common/auth';
import { RlsModule, AuditColumnsModule, createMigrationRunnerService, SchemaDriftModule, createServiceTypeOrmConfig } from '@aquaculture/backend-common/database';
import { ServiceIdentityGuard, TenantGuard, RolesGuard } from '@aquaculture/backend-common/guards';
import { RequestContextMiddleware } from '@aquaculture/backend-common/logging';
import { CorrelationIdMiddleware, UserContextMiddleware, TenantContextMiddleware } from '@aquaculture/backend-common/middleware';
import { RedisModule } from '@aquaculture/backend-common/redis';
import { AuditLogModule, AuditLogInterceptor } from '@aquaculture/backend-common/audit';

/**
 * NotificationMigrationRunnerService — runs pending TypeORM migrations
 * in the notification schema at OnApplicationBootstrap. Added in P2c of
 * the 2026-04-14 public-schema teardown to close the RlsSchemaBootstrap
 * docblock gap (lines 14-27: *"a replacement migration system has not
 * yet been added"*).
 *
 * Source schema is 'notification' (created in P1 via 00-init-schemas.sh).
 * Tables currently live in public (device_tokens, notification_logs);
 * P6 + P7 migrations will move them into the notification schema, at
 * which point the search_path pin here puts them at the front of the
 * resolution chain.
 */
const NotificationMigrationRunnerService = createMigrationRunnerService('notification');
import { ScheduleModule } from '@nestjs/schedule';
import { EventBusModule } from '@platform/event-bus';
import { NotificationModule } from './notification/notification.module';
import { HealthModule } from './health/health.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';

@Module({
  imports: [
    // Global configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
      cache: true,
    }),

    // Database connection — uses the platform TypeORM factory.
    // NotificationMigrationRunnerService (provider above) executes
    // migrations at OnApplicationBootstrap; factory's migrationsRun:false
    // default keeps TypeORM out of that codepath.
    // INFRA-DB-POOL-001: env var unified to DATABASE_POOL_SIZE (was
    // DATABASE_POOL_MAX). Default 10 (was 20).
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        createServiceTypeOrmConfig(configService, {
          serviceName: 'notification',
          // notification tables currently in `public`; P6/P7 migrations move
          // them to `notification`. After the move, the search_path pin
          // here will resolve them first.
          schema: 'notification',
          migrations: [__dirname + '/database/migrations/*.{js,ts}'],
          // INFRA-CRITICAL-020 contract: env-aware migration timing.
          // - Production: DATABASE_MIGRATIONS_RUN=false (default). The
          //   aqua-db-migrate container runs migrations BEFORE service
          //   containers start, so this service's TypeORM does NOT touch
          //   the migration table at boot — MigrationRunnerService below
          //   verifies the schema is healthy and proceeds.
          // - E2E tests: harness sets DATABASE_MIGRATIONS_RUN=true so
          //   TypeORM runs migrations at DataSource init — BEFORE the
          //   SourceSchemaBootstrapService onApplicationBootstrap hook
          //   fires, which would otherwise hard-fail on an empty source
          //   schema (INFRA-CRITICAL-009, INFRA-CRITICAL-020).
          migrationsRunFromEnv: (cs) =>
            cs.get<string>('DATABASE_MIGRATIONS_RUN', 'false') === 'true',
        }),
    }),

    // GraphQL Federation
    GraphQLModule.forRootAsync<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        autoSchemaFile: { federation: 2 },
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
        /**
         * In @nestjs/graphql v13 (NestJS v11), the 'playground' option is internally
         * mapped to Apollo Sandbox via ApolloServerPluginLandingPageLocalDefault.
         * When false, ApolloServerPluginLandingPageDisabled is applied instead.
         * Disabled in production for security (no introspection exposure).
         */
        playground: configService.get('NODE_ENV') !== 'production',
        introspection: configService.get('NODE_ENV') !== 'production',
        context: ({ req }: { req: Record<string, unknown> & { headers: Record<string, string | undefined>; user?: Record<string, unknown> } }) => {
          const userPayloadHeader = req.headers['x-user-payload'];
          const userIdHeader = req.headers['x-user-id'];
          const userRolesHeader = req.headers['x-user-roles'];
          if (typeof userPayloadHeader === 'string') {
            try { req.user = JSON.parse(userPayloadHeader); } catch {
              if (typeof userIdHeader === 'string') {
                req.user = { sub: userIdHeader, roles: typeof userRolesHeader === 'string' ? JSON.parse(userRolesHeader) : [] };
              }
            }
          } else if (typeof userIdHeader === 'string') {
            req.user = { sub: userIdHeader, roles: typeof userRolesHeader === 'string' ? JSON.parse(userRolesHeader) : [] };
          }
          return { req };
        },
      }),
    }),

    // SECURITY (CRITICAL-001): RS256 asymmetric verification via the shared
    // PlatformJwtModule. notification-service is a token CONSUMER, not an
    // issuer.
    //
    // History: this service was on the legacy HS256 / JWT_SECRET shared-secret
    // path identical to the one that crashed hydroponics-service at boot on
    // 2026-04-14. It would have crashed the same way the next time its deploy
    // lane caught up to the env-var teardown. Migrated to PlatformJwtModule
    // in the WS2.B sweep so the entire platform is RS256-only and there is no
    // remaining HS256 surface to forget.
    PlatformJwtModule,

    // Event Bus Module
    EventBusModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        natsUrl: configService.get('NATS_URL', 'nats://localhost:4222'),
        streamName: configService.get('NATS_STREAM_NAME', 'AQUACULTURE_EVENTS'),
      }),
    }),

    // Redis Module (global – used for distributed rate limiting, etc.)
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        host: configService.get('REDIS_HOST', 'localhost'),
        port: configService.get<number>('REDIS_PORT', 6379),
        password: configService.get<string>('REDIS_PASSWORD'),
        db: configService.get<number>('REDIS_DB', 0),
        keyPrefix: 'aqua:notif:',
      }),
    }),

    // Schedule module — single forRoot() for the entire service
    ScheduleModule.forRoot(),

    // Feature modules
    NotificationModule,
    HealthModule,
    /** SEC-M22: Audit trail infrastructure for compliance tracking. */
    AuditLogModule.forRoot(),
    /**
     * SEC-DB: Tenant Row-Level Security.
     *
     * notification-service is a global-schema service — every tenant's
     * device-tokens and notification-logs live in the same tables in the
     * `notification` schema. RLS is the only DB-level isolation in place.
     *
     * autoApply runs the helper at OnApplicationBootstrap because there
     * is no migration runner wired in for this service.
     */
    RlsModule.forPoolService({
      serviceName: 'notification',
      autoApply: true,
    }),
    /**
     * NEW-H1: Convert TIMESTAMP audit columns to TIMESTAMPTZ at cold start.
     *
     * notification-service is global-schema (one DB, no per-tenant schemas)
     * and has no TypeORM migration runner. The bootstrap path is the
     * canonical delivery vehicle, paired with the RlsModule above on the
     * same OnApplicationBootstrap lifecycle. Idempotent — re-runs are
     * no-ops at the discovery layer.
     */
    AuditColumnsModule.forRoot({ serviceName: 'notification' }),
    /** P11 of 2026-04-14 teardown — runtime schema-drift validator. */
    SchemaDriftModule.forRoot({ serviceName: 'notification' }),
  ],
  providers: [
    // Migration runner — see const declaration near top of file.
    NotificationMigrationRunnerService,
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    /**
     * SECURITY (H-06): Global guards for the notification-service.
     *
     * Although this service is primarily event-driven (NATS handlers process
     * domain events from other services), it also exposes:
     * - HTTP health endpoints (HealthController)
     * - A federated GraphQL subgraph (NotificationResolver) accessible via
     *   the API gateway
     *
     * Without global guards, the GraphQL resolvers and any future HTTP
     * controllers would be unprotected. ServiceIdentityGuard validates
     * that requests originate from the gateway (HMAC-signed identity headers).
     * TenantGuard and RolesGuard enforce tenant isolation and RBAC.
     *
     * NATS event handlers are not affected by HTTP guards because NestJS
     * microservice handlers operate outside the HTTP execution context.
     */
    // WHY: useFactory bypasses reflect-metadata resolution which fails in Docker Alpine.
    {
      provide: APP_GUARD,
      useFactory: (configService: ConfigService): ServiceIdentityGuard =>
        new ServiceIdentityGuard(configService),
      inject: [ConfigService],
    },
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector, configService: ConfigService): TenantGuard =>
        new TenantGuard(reflector, undefined, configService),
      inject: [Reflector, ConfigService],
    },
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
    consumer
      .apply(
        CorrelationIdMiddleware,
        RequestContextMiddleware, // Populate AsyncLocalStorage for structured logging
        UserContextMiddleware,
        TenantContextMiddleware,
      )
      .forRoutes('*');
  }
}
