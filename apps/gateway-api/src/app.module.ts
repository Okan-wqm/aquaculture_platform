import { RemoteGraphQLDataSource } from '@apollo/gateway';
import { RetryableIntrospectAndCompose } from './config/retryable-introspect';
import { ApolloGatewayDriver, ApolloGatewayDriverConfig } from '@nestjs/apollo';
import { Module, MiddlewareConsumer, NestModule, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { JwtModule } from '@nestjs/jwt';
import depthLimit from 'graphql-depth-limit';
import {
  getComplexity,
  simpleEstimator,
  fieldExtensionsEstimator,
} from 'graphql-query-complexity';
import {
  UserContextMiddleware,
  TenantContextMiddleware,
  CorrelationIdMiddleware,
  RequestLoggingMiddleware,
  RedisModule,
  RedisService,
} from '@platform/backend-common';
import { StorageModule, StorageConfig } from '@platform/storage';

import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { AuthGuard, JwtPayload } from './guards/auth.guard';
import { JwtMiddleware } from './middleware/jwt.middleware';
import { RateLimitGuard, RATE_LIMIT_STORE } from './guards/rate-limit.guard';
import { RedisRateLimitStore } from './guards/redis-rate-limit.store';
import {
  TOKEN_BLACKLIST_STORE,
  RedisTokenBlacklistStore,
  InMemoryTokenBlacklistStore,
} from './guards/redis-token-blacklist.store';
import { HealthModule } from './health/health.module';
import { RequestLoggingInterceptor } from './interceptors/request-logging.interceptor';
import { UploadModule } from './upload/upload.module';
import { WebSocketModule } from './websocket/websocket.module';
import { createAliasLimitPlugin } from './plugins/graphql-alias-limit.plugin';

// JwtPayload is imported from auth.guard.ts for consistency

// Module-level logger to avoid re-instantiation per GraphQL operation
const queryComplexityLogger = new Logger('QueryComplexity');

/**
 * Request headers structure
 */
interface RequestHeaders {
  authorization?: string;
  cookie?: string;
  'x-tenant-id'?: string;
  'x-correlation-id'?: string;
  [key: string]: string | undefined;
}

/**
 * Request with user information attached
 */
interface RequestWithUser {
  headers: RequestHeaders;
  user?: JwtPayload;
  cookies?: Record<string, string>;
}

/**
 * Extended context type for Apollo Gateway
 */
interface GatewayContext {
  req: RequestWithUser;
  res: import('express').Response;
}

/**
 * SECURITY NOTE: JWT decoding moved to guard for proper verification.
 * Context only passes through the original request reference.
 * The guard will verify the JWT and set req.user with validated payload.
 * willSendRequest then forwards the verified user data to subgraphs.
 *
 * DO NOT decode JWT without verification - it creates security risks:
 * 1. Unverified claims could be forwarded to subgraphs
 * 2. Attackers could craft malicious payloads that bypass validation
 */

/**
 * Custom data source that forwards headers to subgraphs
 * Includes error logging for transient failures
 */
class AuthenticatedDataSource extends RemoteGraphQLDataSource<GatewayContext> {
  private readonly logger = new Logger('AuthenticatedDataSource');

  override willSendRequest(params: {
    request: { http?: { headers: { set: (key: string, value: string) => void } } };
    context?: GatewayContext | Record<string, unknown>;
  }): void {
    const { request, context } = params;

    // Handle health checks and schema loading which don't have our GatewayContext
    if (!context || !('req' in context)) {
      return;
    }

    const req = (context as GatewayContext).req;
    const httpRequest = request.http;

    if (!httpRequest) {
      return;
    }

    // Forward authentication header to subgraphs
    const authorization = req.headers.authorization;
    if (authorization) {
      httpRequest.headers.set('authorization', authorization);
    }

    // SECURITY: Forward cookies to subgraphs (needed for httpOnly refresh token)
    const cookie = req.headers.cookie;
    if (cookie) {
      httpRequest.headers.set('cookie', cookie);
    }

    // Forward tenant ID - prefer JWT tenantId, fallback to header
    const tenantId = req.user?.tenantId ?? req.headers['x-tenant-id'];
    if (tenantId) {
      httpRequest.headers.set('x-tenant-id', tenantId);
    }

    // Forward correlation ID and trace context for distributed tracing
    const correlationId = req.headers['x-correlation-id'];
    if (correlationId) {
      httpRequest.headers.set('x-correlation-id', correlationId);
    }

    // Forward W3C Trace Context (traceparent)
    const traceparent = req.headers['traceparent'];
    if (traceparent) {
      httpRequest.headers.set('traceparent', traceparent);
    }

    // Forward trace/span IDs
    const traceId = req.headers['x-trace-id'];
    if (traceId) {
      httpRequest.headers.set('x-trace-id', traceId);
    }

    const spanId = req.headers['x-span-id'];
    if (spanId) {
      httpRequest.headers.set('x-span-id', spanId);
    }

    const parentSpanId = req.headers['x-parent-span-id'];
    if (parentSpanId) {
      httpRequest.headers.set('x-parent-span-id', parentSpanId);
    }

    // Forward user info if decoded
    const user = req.user;
    if (user) {
      httpRequest.headers.set('x-user-id', user.sub);
      httpRequest.headers.set('x-user-roles', JSON.stringify(user.roles ?? []));
      // Forward full user payload for @CurrentUser() decorator in subgraphs
      httpRequest.headers.set('x-user-payload', JSON.stringify(user));
    }
  }

}

@Module({
  imports: [
    // Global configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
      cache: true,
    }),

    // JWT for token validation
    // SECURITY: JWT_SECRET MUST be provided via environment variable
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const secret = configService.get<string>('JWT_SECRET');
        const nodeEnv = configService.get<string>('NODE_ENV', 'development');
        const isProduction = nodeEnv === 'production';

        // CRITICAL: Always require JWT_SECRET in production
        if (!secret && isProduction) {
          throw new Error(
            'CRITICAL SECURITY ERROR: JWT_SECRET environment variable MUST be set in production. ' +
            'Application startup aborted to prevent security vulnerability.',
          );
        }

        // In non-production, require explicit acknowledgment of dev mode
        if (!secret) {
          const allowDevSecret = configService.get<string>('ALLOW_DEV_JWT_SECRET', 'false');
          const devSecret = configService.get<string>('DEV_JWT_SECRET');

          if (allowDevSecret !== 'true') {
            throw new Error(
              'JWT_SECRET is not configured. For development, set ALLOW_DEV_JWT_SECRET=true and provide DEV_JWT_SECRET ' +
              'with at least 32 characters. NEVER enable this in staging/production!',
            );
          }

          if (!devSecret || devSecret.length < 32) {
            throw new Error(
              'DEV_JWT_SECRET must be provided and be at least 32 characters when ALLOW_DEV_JWT_SECRET=true.',
            );
          }

          const jwtLogger = new Logger('JwtModule');
          jwtLogger.warn(
            'Using DEV_JWT_SECRET for development only. ' +
            'This is NOT secure for production use. Set JWT_SECRET environment variable for production.',
          );
          return {
            secret: devSecret,
            signOptions: {
              expiresIn: configService.get('JWT_EXPIRES_IN', '15m'),
            },
          };
        }

        // Validate JWT_SECRET minimum length
        if (secret.length < 32) {
          throw new Error(
            'JWT_SECRET must be at least 32 characters long for adequate security.',
          );
        }

        return {
          secret,
          signOptions: {
            expiresIn: configService.get('JWT_EXPIRES_IN', '15m'),
          },
        };
      },
    }),

    // Apollo Federation Gateway
    GraphQLModule.forRootAsync<ApolloGatewayDriverConfig>({
      driver: ApolloGatewayDriver,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        gateway: {
          supergraphSdl: new RetryableIntrospectAndCompose({
            subgraphs: [
              {
                name: 'auth',
                url: configService.get('AUTH_SERVICE_URL', 'http://localhost:3001/graphql'),
              },
              {
                name: 'farm',
                url: configService.get('FARM_SERVICE_URL', 'http://localhost:3002/graphql'),
              },
              {
                name: 'sensor',
                url: configService.get('SENSOR_SERVICE_URL', 'http://localhost:3003/graphql'),
              },
              {
                name: 'alert',
                url: configService.get('ALERT_SERVICE_URL', 'http://localhost:3004/graphql'),
              },
              {
                name: 'hr',
                url: configService.get('HR_SERVICE_URL', 'http://localhost:3005/graphql'),
              },
              {
                name: 'billing',
                url: configService.get('BILLING_SERVICE_URL', 'http://localhost:3006/graphql'),
              },
              {
                name: 'hydroponics',
                url: configService.get('HYDROPONICS_SERVICE_URL', 'http://localhost:4007/graphql'),
              },
              {
                name: 'config',
                url: configService.get('CONFIG_SERVICE_URL', 'http://localhost:3007/graphql'),
              },
              // NOTE: notification-service doesn't expose GraphQL - it's event-driven only
              // {
              //   name: 'notification',
              //   url: configService.get('NOTIFICATION_SERVICE_URL', 'http://localhost:3007/graphql'),
              // },
            ],
            pollIntervalInMs: 300000, // Poll for schema changes every 5 minutes
          }),
          buildService({ url }) {
            return new AuthenticatedDataSource({ url });
          },
        },
        server: {
          // SECURITY: Disable batched HTTP requests to prevent rate-limit bypass
          // A single HTTP request with many batched operations would count as 1 request
          allowBatchedHttpRequests: false,
          playground: configService.get('NODE_ENV') !== 'production',
          // SECURITY: Disable introspection in production to prevent schema discovery attacks
          // Explicit env var allows overriding independently of NODE_ENV
          introspection: configService.get('GRAPHQL_INTROSPECTION', 'false') === 'true' ||
            configService.get('NODE_ENV') !== 'production',
          // SECURITY: Hide stack traces in production error responses (C-4)
          includeStacktraceInErrorResponses: configService.get('NODE_ENV') !== 'production',
          // SECURITY: Strip internal details from error responses in production
          formatError: configService.get('NODE_ENV') === 'production'
            ? (formattedError: { message: string; extensions?: Record<string, unknown> }) => ({
                message: formattedError.message,
                extensions: {
                  code: formattedError.extensions?.code ?? 'INTERNAL_SERVER_ERROR',
                },
              })
            : undefined,
          // SECURITY: Depth limiting to prevent deeply nested query DoS attacks
          // Maximum query depth of 10 prevents excessive resource consumption
          validationRules: [depthLimit(10)],
          // SECURITY: Query complexity limiting to prevent expensive query DoS attacks
          plugins: [
            // SECURITY: Alias brute-force protection (H-2)
            createAliasLimitPlugin(),
            {
              // Hoist Logger out of per-request closure to avoid re-instantiation per operation
              requestDidStart: async () => ({
                async didResolveOperation({ request, document, schema }) {
                  const logger = queryComplexityLogger;
                  const maxComplexity = configService.get<number>('GRAPHQL_MAX_COMPLEXITY', 1000);

                  try {
                    const complexity = getComplexity({
                      schema,
                      operationName: request.operationName ?? undefined,
                      query: document,
                      variables: request.variables ?? {},
                      estimators: [
                        fieldExtensionsEstimator(),
                        simpleEstimator({ defaultComplexity: 1 }),
                      ],
                    });

                    if (complexity > maxComplexity) {
                      logger.warn(
                        `Query complexity ${complexity} exceeds maximum allowed ${maxComplexity}`,
                      );
                      throw new Error(
                        `Query is too complex: ${complexity}. Maximum allowed complexity: ${maxComplexity}`,
                      );
                    }

                    if (configService.get('NODE_ENV') !== 'production') {
                      logger.debug(`Query complexity: ${complexity}/${maxComplexity}`);
                    }
                  } catch (error) {
                    if (error instanceof Error && error.message.includes('Query is too complex')) {
                      throw error;
                    }
                    // Log but don't fail on complexity calculation errors
                    // (e.g., schema not available during startup)
                    logger.warn(`Could not calculate query complexity: ${error}`);
                  }
                },
              }),
            },
          ],
          context: ({ req, res }: { req: RequestWithUser; res: import('express').Response }): GatewayContext => {
            // SECURITY: req.user is set by JwtMiddleware which runs before context creation.
            // JwtMiddleware verifies the JWT signature and decodes the payload.
            // This ensures req.user is available when willSendRequest forwards headers.
            //
            // AuthGuard still runs as an additional validation layer and handles
            // token blacklist checks, but JwtMiddleware ensures headers are forwarded.
            //
            // res is passed through so auth-service can set httpOnly cookies via the gateway.

            return { req, res };
          },
        },
      }),
    }),

    // MinIO Storage Module for file uploads
    // SECURITY: No default credentials - must be explicitly configured
    StorageModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): StorageConfig => {
        const nodeEnv = configService.get<string>('NODE_ENV', 'development');
        const isProduction = nodeEnv === 'production';
        const accessKey = configService.get<string>('MINIO_ACCESS_KEY', '');
        const secretKey = configService.get<string>('MINIO_SECRET_KEY', '');

        // SECURITY: Fail fast in production if MinIO credentials are not configured
        // Prevents silent fallback to well-known default credentials
        if (isProduction && (!accessKey || !secretKey)) {
          throw new Error(
            'CRITICAL: MINIO_ACCESS_KEY and MINIO_SECRET_KEY must be explicitly configured in production. ' +
            'Application startup aborted to prevent use of default credentials.',
          );
        }

        // In development, use defaults only if not explicitly set
        const resolvedAccessKey = accessKey || 'minioadmin';
        const resolvedSecretKey = secretKey || 'minioadmin';

        if (!accessKey || !secretKey) {
          const minioLogger = new Logger('StorageModule');
          minioLogger.warn(
            'Using default MinIO credentials for development. ' +
            'Set MINIO_ACCESS_KEY and MINIO_SECRET_KEY for production.',
          );
        }

        return {
          endpoint: configService.get('MINIO_ENDPOINT', 'localhost'),
          port: parseInt(configService.get('MINIO_PORT', '9000'), 10),
          useSSL: configService.get('MINIO_USE_SSL', 'false') === 'true',
          accessKey: resolvedAccessKey,
          secretKey: resolvedSecretKey,
          bucket: configService.get('MINIO_BUCKET', 'aquaculture'),
          region: configService.get('MINIO_REGION', 'us-east-1'),
        };
      },
    }),

    // Health check module
    HealthModule,

    // File upload module
    UploadModule,

    // WebSocket module for real-time sensor data
    WebSocketModule,

    // Redis for distributed rate limiting (optional, falls back to in-memory if not configured)
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        host: configService.get('REDIS_HOST', 'localhost'),
        port: parseInt(configService.get('REDIS_PORT', '6379'), 10),
        password: configService.get('REDIS_PASSWORD'),
        db: parseInt(configService.get('REDIS_DB', '0'), 10),
        keyPrefix: 'gateway:',
      }),
    }),
  ],
  providers: [
    // Global exception filter
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    // Global auth guard (supports JWT, API key, and basic auth)
    // SECURITY: AuthGuard performs proper JWT signature verification
    // with timing-safe comparison and supports token blacklisting
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    // Rate limiting guard
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
    // Redis-based rate limit store for distributed deployments
    // Enabled via RATE_LIMIT_USE_REDIS=true environment variable
    {
      provide: RATE_LIMIT_STORE,
      useFactory: (redisService: RedisService) => new RedisRateLimitStore(redisService),
      inject: [RedisService],
    },
    // Redis-based token blacklist store for distributed token revocation
    // Falls back to in-memory if Redis is unavailable
    // SECURITY: Required for proper logout and token revocation across instances
    {
      provide: TOKEN_BLACKLIST_STORE,
      useFactory: (redisService: RedisService, configService: ConfigService) => {
        const useRedis = configService.get<string>('TOKEN_BLACKLIST_USE_REDIS', 'true') === 'true';
        if (useRedis && redisService) {
          return new RedisTokenBlacklistStore(redisService);
        }
        return new InMemoryTokenBlacklistStore();
      },
      inject: [RedisService, ConfigService],
    },
    // Request logging interceptor
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestLoggingInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(
        // Order matters:
        // 1. Set correlation id for tracing
        // 2. Decode JWT and set req.user (needed for willSendRequest to forward headers)
        // 3. Hydrate user from x-user-payload header (for inter-service calls)
        // 4. Set tenant context
        // 5. Log request
        CorrelationIdMiddleware,
        JwtMiddleware,
        UserContextMiddleware,
        TenantContextMiddleware,
        RequestLoggingMiddleware,
      )
      .forRoutes('*');
  }
}
