import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { GraphQLModule } from '@nestjs/graphql';
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
} from '@nestjs/apollo';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { join } from 'path';
import { Request } from 'express';
import {
  TenantContextMiddleware,
  CorrelationIdMiddleware,
  RequestContextMiddleware,
  TenantGuard,
  RolesGuard,
  UserContextMiddleware,
  SourceSchemaBootstrapService,
  ServiceIdentityGuard,
  ThrottlerModule,
} from '@aquaculture/backend-common';

/**
 * Extended request interface for GraphQL context
 */
interface GraphQLContextRequest extends Request {
  user?: {
    sub: string;
    roles: string[];
  };
}
import { createTenantSchemaMiddleware, createTenantConnectionBootstrap, TenantSchemaSyncService, SourceSchemaWriteGuardService } from '@aquaculture/backend-common';
const TenantSchemaMiddleware = createTenantSchemaMiddleware('farm');
const TenantConnectionBootstrap = createTenantConnectionBootstrap('farm');
import { WatchdogCronService } from './infrastructure/watchdog-cron.service';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CqrsModule } from '@platform/cqrs';
import { EventBusModule } from '@platform/event-bus';
import { DatabaseModule } from './database/database.module';
import { FarmModule } from './farm/farm.module';
import { HealthModule } from './health/health.module';
import { SpeciesModule } from './species/species.module';
import { TankModule } from './tank/tank.module';
import { BatchModule } from './batch/batch.module';
import { FeedingModule } from './feeding/feeding.module';
import { GrowthModule } from './growth/growth.module';
import { WaterQualityModule } from './water-quality/water-quality.module';
import { FishHealthModule } from './fish-health/fish-health.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { HarvestModule } from './harvest/harvest.module';
import { SiteModule } from './site/site.module';
import { DepartmentModule } from './department/department.module';
import { EquipmentModule } from './equipment/equipment.module';
import { SupplierModule } from './supplier/supplier.module';
import { ChemicalModule } from './chemical/chemical.module';
import { ConsumableModule } from './consumable/consumable.module';
import { FeedModule } from './feed/feed.module';
import { InventoryModule } from './storage/storage.module';
import { WorkerModule } from './worker/worker.module';
import { SystemModule } from './system/system.module';
import { SentinelHubModule } from './sentinel-hub/sentinel-hub.module';
import { RegulatoryModule } from './regulatory/regulatory.module';
import { WeatherModule } from './weather/weather.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { EventListenersModule } from './events/event-listeners.module';
import { TaskModule } from './task/task.module';
/**
 * WHY: AiInsightsModule integrates the MCP Farm Intelligence server with the
 * farm service, providing AI-powered risk assessment, anomaly detection, growth
 * prediction, and feeding advice via GraphQL queries.
 */
import { AiInsightsModule } from './ai-insights/ai-insights.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { GraphQLContextFactory } from './common/graphql-context.factory';
import { GraphQLContextModule } from './common/graphql-context.module';
import { getTenantSchemaName } from './common/utils/schema-sanitizer';

@Module({
  imports: [
    // Global configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
      cache: true,
    }),

    // Rate limiting (custom sliding-window implementation from backend-common)
    ThrottlerModule,

    // Database connection - NO explicit schema!
    // Schema isolation is handled by TenantSchemaMiddleware via PostgreSQL search_path
    // search_path is set to: "tenant_xxx", farm, public
    // This ensures queries use tenant schema first, falling back to farm for shared data
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
        // Setting schema here would cause TypeORM to add explicit schema prefix to all queries,
        // overriding the search_path and breaking multi-tenant isolation
        autoLoadEntities: true,
        // Enable sync from DATABASE_SYNC env var (default: false for safety)
        // In production, always use migrations: npx typeorm migration:generate
        synchronize: configService.get('DATABASE_SYNC', 'false') === 'true',
        logging: configService.get('DATABASE_LOGGING', 'false') === 'true',
        // SECURITY: SSL configuration with proper certificate validation
        ssl: (() => {
          const sslEnabled = configService.get('DATABASE_SSL') === 'true';
          if (!sslEnabled) return false;

          const isProduction = configService.get('NODE_ENV') === 'production';
          const caPath = configService.get<string>('DATABASE_SSL_CA');
          const rejectUnauthorized = configService.get('DATABASE_SSL_REJECT_UNAUTHORIZED', 'true') !== 'false';

          if (isProduction && !rejectUnauthorized && !caPath) {
            console.warn(
              '⚠️  WARNING: SSL certificate verification disabled in production! ' +
              'Set DATABASE_SSL_CA for proper security.',
            );
          }

          return {
            rejectUnauthorized,
            ...(caPath ? { ca: require('fs').readFileSync(caPath) } : {}),
          };
        })(),
        extra: {
          // Connection pool settings for multi-tenant
          max: configService.get<number>('DATABASE_POOL_SIZE', 50),
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
          // Default search_path targets the source schema so TypeORM sync/migrations
          // create tables there. TenantSchemaMiddleware overrides per-request.
          options: '-c search_path=farm,public',
        },
      };
      },
    }),

    // GraphQL Federation
    GraphQLModule.forRootAsync<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      imports: [ConfigModule, GraphQLContextModule],
      inject: [ConfigService, GraphQLContextFactory],
      useFactory: (configService: ConfigService, contextFactory: GraphQLContextFactory) => ({
        autoSchemaFile: { federation: 2, path: join('/tmp', 'schema.graphql') },
        playground: configService.get('NODE_ENV') !== 'production',
        // SECURITY: Disable introspection in production
        introspection: configService.get('NODE_ENV') !== 'production',
        context: ({ req }: { req: GraphQLContextRequest }) => {
          // Reconstruct user from gateway headers for @CurrentUser() decorator
          const userPayloadHeader = req.headers['x-user-payload'];
          const userIdHeader = req.headers['x-user-id'];
          const userRolesHeader = req.headers['x-user-roles'];

          if (typeof userPayloadHeader === 'string') {
            try {
              req.user = JSON.parse(userPayloadHeader);
            } catch {
              // Fallback: create minimal user from individual headers
              if (typeof userIdHeader === 'string') {
                req.user = {
                  sub: userIdHeader,
                  roles: typeof userRolesHeader === 'string'
                    ? JSON.parse(userRolesHeader)
                    : [],
                };
              }
            }
          } else if (typeof userIdHeader === 'string') {
            // Fallback if x-user-payload not present
            req.user = {
              sub: userIdHeader,
              roles: typeof userRolesHeader === 'string'
                ? JSON.parse(userRolesHeader)
                : [],
            };
          }

          // Create per-request DataLoaders for equipment batch metrics (N+1 → bulk)
          const tenantHeader = req.headers['x-tenant-id'];
          const tenantId = typeof tenantHeader === 'string' ? tenantHeader : undefined;
          let loaders;
          if (tenantId) {
            const schema = getTenantSchemaName(tenantId);
            loaders = contextFactory.createLoaders(tenantId, schema);
          }

          return { req, loaders };
        },
        buildSchemaOptions: {
          orphanedTypes: [],
        },
      }),
    }),

    // JWT Module for auth guards (global for all feature modules)
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: configService.get('JWT_EXPIRES_IN', '1d') },
      }),
    }),

    // Schedule module — single forRoot() for the entire service
    ScheduleModule.forRoot(),

    /**
     * Global EventEmitter2 registration — single forRoot() for the entire service.
     * Feature modules (e.g. EventListenersModule) must NOT call forRoot() again.
     * In NestJS v11, duplicate forRoot() calls create separate EventEmitter2
     * instances, causing events emitted in one context to be invisible to
     * listeners registered in the other.
     */
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      ignoreErrors: false,
      maxListeners: 20,
    }),

    // CQRS Module
    CqrsModule.forRoot(),

    // Event Bus Module
    EventBusModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        natsUrl: configService.get('NATS_URL', 'nats://localhost:4222'),
        streamName: configService.get('NATS_STREAM_NAME', 'AQUACULTURE_EVENTS'),
      }),
    }),

    // Database module (audit, code generation)
    DatabaseModule,

    // Feature modules
    FarmModule,
    HealthModule,
    SpeciesModule,
    TankModule,
    BatchModule,
    FeedingModule,
    GrowthModule,
    WaterQualityModule,
    FishHealthModule,
    MaintenanceModule,
    HarvestModule,
    SiteModule,
    DepartmentModule,
    EquipmentModule,
    SupplierModule,
    ChemicalModule,
    ConsumableModule,
    FeedModule,
    InventoryModule,
    WorkerModule,
    SystemModule,
    SentinelHubModule,
    RegulatoryModule,
    WeatherModule,
    SchedulerModule,
    EventListenersModule,
    TaskModule,
    // WHY: AI insights module — MCP Farm Intelligence integration
    AiInsightsModule,
  ],
  providers: [
    // Global exception filter
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    // SECURITY: Service identity guard - validates HMAC-signed service identity headers
    // Must be FIRST guard (before tenant/roles) to verify request origin
    {
      provide: APP_GUARD,
      useClass: ServiceIdentityGuard,
    },
    // Tenant guard
    {
      provide: APP_GUARD,
      useClass: TenantGuard,
    },
    // SECURITY: Roles guard - enforces @Roles() decorator authorization
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    // Bootstrap source schema tables on startup (creates template tables if missing)
    SourceSchemaBootstrapService,
    // Pool-level tenant schema routing (patches pg Pool.connect for search_path injection)
    TenantConnectionBootstrap,
    // Auto-sync tenant schemas with source schema (creates missing tables/columns)
    TenantSchemaSyncService,
    // DB-level write guards on source schema (defense-in-depth)
    SourceSchemaWriteGuardService,
    WatchdogCronService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Middleware execution order:
    // 1. CorrelationIdMiddleware - Add correlation ID for request tracing
    // 2. UserContextMiddleware - Parse x-user-payload header from gateway (sets req.user)
    // 3. TenantContextMiddleware - Extract tenant from JWT/headers (uses req.user.tenantId)
    // 4. TenantSchemaMiddleware - Set PostgreSQL search_path to tenant schema
    consumer
      .apply(
        CorrelationIdMiddleware,
        RequestContextMiddleware, // Populate AsyncLocalStorage for structured logging
        UserContextMiddleware,
        TenantContextMiddleware,
        TenantSchemaMiddleware,
      )
      .forRoutes('*');
  }
}
