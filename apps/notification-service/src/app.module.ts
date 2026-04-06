import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
} from '@nestjs/apollo';
import { JwtModule } from '@nestjs/jwt';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import depthLimit from 'graphql-depth-limit';
import {
  CorrelationIdMiddleware,
  RequestContextMiddleware,
  UserContextMiddleware,
  TenantContextMiddleware,
  RedisModule,
  ServiceIdentityGuard,
  TenantGuard,
  RolesGuard,
  AuditLogModule,
  AuditLogInterceptor,
} from '@aquaculture/backend-common';
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

    // Database connection
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
        host: configService.get('DATABASE_HOST', 'localhost'),
        port: configService.get<number>('DATABASE_PORT', 5432),
        username: configService.get('DATABASE_USER', 'postgres'),
        password: dbPassword || 'postgres',
        database: configService.get('DATABASE_NAME', 'notification_service'),
        autoLoadEntities: true,
        synchronize: configService.get('DATABASE_SYNC', 'false') === 'true',
        logging: configService.get('DATABASE_LOGGING', 'false') === 'true',
        extra: {
          max: configService.get<number>('DATABASE_POOL_MAX', 20),
          min: configService.get<number>('DATABASE_POOL_MIN', 2),
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
        },
        // SECURITY: SSL configuration with proper certificate validation
        ssl: (() => {
          const sslEnabled = configService.get('DATABASE_SSL') === 'true';
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
      };
      },
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

    // JWT Module for auth
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: configService.get('JWT_EXPIRES_IN', '1d') },
      }),
    }),

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
  ],
  providers: [
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
