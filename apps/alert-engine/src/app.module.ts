import { Module, NestModule, MiddlewareConsumer, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
} from '@nestjs/apollo';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { join } from 'path';
import { EventEmitterModule } from '@nestjs/event-emitter';
import depthLimit from 'graphql-depth-limit';
import {
  TenantContextMiddleware,
  CorrelationIdMiddleware,
  RequestContextMiddleware,
  UserContextMiddleware,
  TenantGuard,
  RolesGuard,
  RedisModule,
  SourceSchemaBootstrapService,
  ServiceIdentityGuard,
  createTenantSchemaMiddleware,
  createTenantConnectionBootstrap,
  TenantSchemaSyncService,
  SourceSchemaWriteGuardService,
  AuditLogModule,
  AuditLogInterceptor,
} from '@aquaculture/backend-common';
const TenantSchemaMiddleware = createTenantSchemaMiddleware('alert');
const TenantConnectionBootstrap = createTenantConnectionBootstrap('alert');
import { EventBusModule } from '@platform/event-bus';
import { AlertModule } from './alert/alert.module';
import { HealthModule } from './health/health.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';

// Nested ObjectTypes for orphanedTypes registration
import { IncidentTimelineEvent } from './database/entities/alert-incident.entity';
import { AlertCondition } from './database/entities/alert-rule.entity';

@Module({
  imports: [
    // Global configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
      cache: true,
    }),

    // Database connection - NO explicit schema!
    // Schema isolation is handled by TenantSchemaMiddleware via PostgreSQL search_path
    // search_path is set to: "tenant_xxx", alert, public
    // This ensures queries use tenant schema first, falling back to alert for shared data
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
        database: configService.get('DATABASE_NAME', 'aquaculture'),
        // NOTE: Do NOT set 'schema' here! Schema is managed dynamically by TenantSchemaMiddleware
        autoLoadEntities: true,
        synchronize: false,
        logging: configService.get('DATABASE_LOGGING', 'false') === 'true',
        extra: { options: '-c search_path=alert,public' },
        // SECURITY: SSL configuration with proper certificate validation
        ssl: (() => {
          const sslEnabled = configService.get('DATABASE_SSL') === 'true';
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
      };
      },
    }),

    // GraphQL Federation
    GraphQLModule.forRootAsync<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
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
          orphanedTypes: [IncidentTimelineEvent, AlertCondition],
        },
        /**
         * In @nestjs/graphql v13 (NestJS v11), the 'playground' option is internally
         * mapped to Apollo Sandbox via ApolloServerPluginLandingPageLocalDefault.
         * When false, ApolloServerPluginLandingPageDisabled is applied instead.
         * Disabled in production for security (no introspection exposure).
         */
        playground: configService.get('NODE_ENV') !== 'production',
        // SECURITY: Disable introspection in production
        introspection: configService.get('NODE_ENV') !== 'production',
        context: ({ req }: { req: unknown }) => ({ req }),
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

    // Redis for distributed state management
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const url = configService.get<string>('REDIS_URL') || 'redis://localhost:6379';
        return {
          url,
          keyPrefix: 'alert:',
        };
      },
    }),

    // In-process event emitter (used by EscalationManagerService, etc.)
    EventEmitterModule.forRoot(),

    // Feature modules
    AlertModule,
    HealthModule,
    /** SEC-M22: Audit trail infrastructure for compliance tracking. */
    AuditLogModule.forRoot(),
  ],
  providers: [
    // Global exception filter
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    // SECURITY: Service identity guard - validates HMAC-signed service identity headers
    // Must be FIRST guard (before tenant/roles) to verify request origin
    // WHY: useFactory bypasses reflect-metadata resolution which fails in Docker Alpine.
    {
      provide: APP_GUARD,
      useFactory: (configService: ConfigService): ServiceIdentityGuard =>
        new ServiceIdentityGuard(configService),
      inject: [ConfigService],
    },
    // Tenant guard
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
    // Bootstrap source schema tables on startup (creates template tables if missing)
    SourceSchemaBootstrapService,
    // Tenant connection pool patching for schema-level isolation
    TenantConnectionBootstrap,
    // Auto-sync tenant schemas with source schema (creates missing tables/columns)
    TenantSchemaSyncService,
    // DB-level write guards on source schema (defense-in-depth)
    SourceSchemaWriteGuardService,
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
        TenantSchemaMiddleware, // Schema-level tenant isolation via search_path
      )
      .forRoutes('*');
  }
}
