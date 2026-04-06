import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
} from '@nestjs/apollo';
import { GraphQLError } from 'graphql';
import depthLimit from 'graphql-depth-limit';
import { fieldExtensionsEstimator, getComplexity, simpleEstimator } from 'graphql-query-complexity';
import {
  TenantContextMiddleware,
  CorrelationIdMiddleware,
  RequestContextMiddleware,
  UserContextMiddleware,
  RolesGuard,
  TenantGuard,
  ThrottlerModule,
  ThrottlerGuard,
  SlidingWindowStrategy,
  ServiceIdentityGuard,
  SourceSchemaBootstrapService,
  createTenantSchemaMiddleware,
  createTenantConnectionBootstrap,
  TenantSchemaSyncService,
  SourceSchemaWriteGuardService,
  AuditLogModule,
  AuditLogInterceptor,
} from '@aquaculture/backend-common';
const TenantSchemaMiddleware = createTenantSchemaMiddleware('hydroponics');
const TenantConnectionBootstrap = createTenantConnectionBootstrap('hydroponics');
import { HydroponicsSetupModule } from './setup/setup.module';
import { HealthModule } from './health/health.module';

// Entities
import { HydroponicsConfig } from './setup/entities/hydroponics-config.entity';

// Per-process cache for GraphQL complexity results keyed by document hash.
// This avoids recomputing complexity for identical operations on every request.
const complexityCache = new Map<string, number>();

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    // Database connection - NO explicit schema!
    // Schema isolation is handled by TenantSchemaMiddleware via PostgreSQL search_path
    // search_path is set to: "tenant_xxx", hydroponics, public
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
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
        entities: [
          HydroponicsConfig,
        ],
        synchronize: configService.get('DATABASE_SYNC') === 'true' && configService.get('NODE_ENV') !== 'production',
        logging: configService.get('NODE_ENV') === 'development',
        ssl: (() => {
          const sslEnabled = configService.get('DB_SSL') === 'true';
          if (!sslEnabled) return false;

          const isProduction = configService.get('NODE_ENV') === 'production';
          const caPath = configService.get<string>('DATABASE_SSL_CA');
          const rejectUnauthorized = configService.get('DATABASE_SSL_REJECT_UNAUTHORIZED', 'true') !== 'false';

          if (isProduction && !rejectUnauthorized && !caPath) {
            console.warn('WARNING: SSL certificate verification disabled in production!');
          }

          return {
            rejectUnauthorized,
            ...(caPath ? { ca: readFileSync(caPath) } : {}),
          };
        })(),
        extra: {
          max: configService.get<number>('DB_POOL_SIZE', 5),
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000,
          // Default search_path targets the source schema so TypeORM sync/migrations
          // create tables there. TenantConnectionBootstrap overrides per-request.
          options: '-c search_path=hydroponics,public',
        },
      };
      },
    }),
    GraphQLModule.forRootAsync<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const isProduction = configService.get('NODE_ENV') === 'production';
        return {
          autoSchemaFile: { federation: 2, path: join('/tmp', 'schema.graphql') },
          /** SEC-M21: Disable GraphQL query batching to prevent batch-based brute-force attacks.
           *  The gateway already blocks batching, but subgraphs must also enforce this as
           *  defense-in-depth in case a subgraph becomes directly accessible. */
          allowBatchedHttpRequests: false,
          validationRules: [depthLimit(10)],
          plugins: [
            {
              requestDidStart: async () => ({
                async didResolveOperation({ request, document, schema }) {
                  // Cache complexity by document hash to avoid re-computation for
                  // identical operations. The hash key incorporates the operation name
                  // so distinct named operations in the same document are treated separately.
                  const docSource = request.query ?? '';
                  const opName = request.operationName ?? '';
                  /** SEC-L01: Use SHA-256 instead of deprecated SHA-1 for cache key generation.
                   *  SHA-1 has known collision vulnerabilities (SHAttered attack, 2017). */
                  const cacheKey = createHash('sha256')
                    .update(docSource)
                    .update('\x00')
                    .update(opName)
                    .digest('hex');

                  let complexity = complexityCache.get(cacheKey);
                  if (complexity === undefined) {
                    complexity = getComplexity({
                      schema,
                      operationName: request.operationName,
                      query: document,
                      variables: request.variables,
                      estimators: [fieldExtensionsEstimator(), simpleEstimator({ defaultComplexity: 1 })],
                    });
                    complexityCache.set(cacheKey, complexity);
                  }

                  const maxComplexity = 1000;
                  if (complexity > maxComplexity) {
                    throw new GraphQLError(`Query too complex: ${complexity}. Maximum allowed: ${maxComplexity}`);
                  }
                },
              }),
            },
          ],
          /**
           * In @nestjs/graphql v13 (NestJS v11), the 'playground' option is internally
           * mapped to Apollo Sandbox via ApolloServerPluginLandingPageLocalDefault.
           * When false, ApolloServerPluginLandingPageDisabled is applied instead.
           * Disabled in production for security (no introspection exposure).
           */
          playground: !isProduction && configService.get('GRAPHQL_PLAYGROUND', 'true') === 'true',
          /** SEC-NEW06: Disable introspection override — gateway handles introspection centrally.
           *  Subgraph introspection in production exposes internal schema details. */
          introspection: !isProduction,
          context: ({ req }: { req: Request }) => ({ req }),
        };
      },
    }),
    // NOTE: CqrsModule intentionally omitted — no CQRS handlers are wired in this service yet.
    // Re-add CqrsModule.forRoot() once actual command/query handlers are implemented.
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: configService.get('JWT_EXPIRES_IN', '1d') },
      }),
    }),
    // Rate limiting: applies sliding-window throttling to all GraphQL and REST endpoints.
    // Limits are configurable via THROTTLE_DEFAULT_LIMIT, THROTTLE_DEFAULT_TTL,
    // THROTTLE_ANONYMOUS_LIMIT, and THROTTLE_ENABLED environment variables.
    ThrottlerModule,
    HydroponicsSetupModule,
    HealthModule,
    /** SEC-M22: Audit trail infrastructure for compliance tracking. */
    AuditLogModule.forRoot(),
  ],
  providers: [
    // SECURITY: Service identity guard - validates HMAC-signed service identity headers
    // Must be FIRST guard (before tenant/roles/throttler) to verify request origin
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
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector, configService: ConfigService, rateLimiter: SlidingWindowStrategy): ThrottlerGuard =>
        new ThrottlerGuard(reflector, configService, rateLimiter),
      inject: [Reflector, ConfigService, SlidingWindowStrategy],
    },
    /** SEC-M22: Register global audit logging for compliance — all mutations are tracked. */
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditLogInterceptor,
    },
    // Bootstrap source schema tables on startup (creates template tables if missing)
    SourceSchemaBootstrapService,
    // Pool-level tenant schema routing (patches pg Pool.connect for search_path injection)
    TenantConnectionBootstrap,
    // Auto-sync tenant schemas with source schema (creates missing tables/columns)
    TenantSchemaSyncService,
    // DB-level write guards on source schema (defense-in-depth)
    SourceSchemaWriteGuardService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Middleware execution order:
    // 1. CorrelationIdMiddleware - Add correlation ID for request tracing
    // 2. UserContextMiddleware - Parse x-user-payload header from gateway
    // 3. TenantContextMiddleware - Extract tenant from JWT/headers
    // 4. TenantSchemaMiddleware - Set PostgreSQL search_path to tenant schema
    consumer
      .apply(
        CorrelationIdMiddleware,
        RequestContextMiddleware, // Populate AsyncLocalStorage for structured logging
        UserContextMiddleware,
        TenantContextMiddleware,
        TenantSchemaMiddleware,
      )
      // Express v5 path-to-regexp v8: named wildcard required instead of regex capture group
      .exclude('health', 'health/{*path}')
      .forRoutes('*');
  }
}
