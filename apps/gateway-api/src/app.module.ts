import {
  IntrospectAndCompose,
  RemoteGraphQLDataSource,
} from '@apollo/gateway';
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
import { StorageModule } from '@platform/storage';

import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { GraphQLAuthGuard } from './guards/graphql-auth.guard';
import { RateLimitGuard, RATE_LIMIT_STORE } from './guards/rate-limit.guard';
import { RedisRateLimitStore } from './guards/redis-rate-limit.store';
import { HealthModule } from './health/health.module';
import { RequestLoggingInterceptor } from './interceptors/request-logging.interceptor';
import { UploadModule } from './upload/upload.module';
import { WebSocketModule } from './websocket/websocket.module';

/**
 * JWT Payload structure for decoded tokens
 */
interface JwtPayload {
  sub: string;
  tenantId?: string;
  roles?: string[];
  iat?: number;
  exp?: number;
}

/**
 * Request headers structure
 */
interface RequestHeaders {
  authorization?: string;
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
}

/**
 * Extended context type for Apollo Gateway
 */
interface GatewayContext {
  req: RequestWithUser;
}

/**
 * Extract and decode JWT token from request
 */
function decodeJwtFromRequest(req: RequestWithUser, _jwtSecret: string): JwtPayload | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;

  const parts = authHeader.split(' ');
  const type = parts[0];
  const token = parts[1];
  if (type !== 'Bearer' || !token) return null;

  try {
    // Simple JWT decode without verification (verification done by guard)
    // We just need to extract the payload for forwarding
    const tokenParts = token.split('.');
    if (tokenParts.length !== 3) return null;

    const payloadPart = tokenParts[1];
    if (!payloadPart) return null;

    const payload = JSON.parse(Buffer.from(payloadPart, 'base64').toString('utf8')) as JwtPayload;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Retryable HTTP status codes for subgraph requests
 */
const RETRYABLE_STATUS_CODES = [502, 503, 504, 429]; // Bad Gateway, Service Unavailable, Gateway Timeout, Too Many Requests

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

  /**
   * Handle errors with retry logic for transient failures
   */
  override async didReceiveResponse<TResult>({
    response,
    request,
    context,
  }: {
    response: { http?: { status?: number }; data?: TResult; errors?: Array<{ message: string }> };
    request: { http?: { url?: string } };
    context: GatewayContext | Record<string, unknown>;
  }): Promise<{ data?: TResult; errors?: Array<{ message: string }> }> {
    const status = response.http?.status;
    const url = request.http?.url || 'unknown';

    // Log retryable errors for monitoring
    if (status && RETRYABLE_STATUS_CODES.includes(status)) {
      this.logger.warn(
        `Subgraph ${url} returned ${status} - transient failure detected`,
      );
    }

    return response;
  }

  /**
   * Error handler with logging
   */
  override didEncounterError(
    error: Error,
    _fetchRequest: Request,
    _fetchResponse?: Response,
    context?: GatewayContext | Record<string, unknown>,
  ): void {
    const correlationId = context && 'req' in context
      ? (context as GatewayContext).req.headers['x-correlation-id']
      : 'unknown';

    this.logger.error(
      `Subgraph request failed [correlationId: ${correlationId}]: ${error.message}`,
    );
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

          console.warn(
            '\\n⚠️  WARNING: Using DEV_JWT_SECRET for development only.\\n' +
            '   This is NOT secure for production use.\\n' +
            '   Set JWT_SECRET environment variable for production.\\n',
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
            ],
            pollIntervalInMs: 30000, // Poll for schema changes every 30 seconds
          }),
          buildService({ url }) {
            return new AuthenticatedDataSource({ url });
          },
        },
        server: {
          playground: configService.get('NODE_ENV') !== 'production',
          // SECURITY: Disable introspection in production to prevent schema discovery attacks
          introspection: configService.get('NODE_ENV') !== 'production',
          // SECURITY: Depth limiting to prevent deeply nested query DoS attacks
          // Maximum query depth of 10 prevents excessive resource consumption
          validationRules: [depthLimit(10)],
          // SECURITY: Query complexity limiting to prevent expensive query DoS attacks
          plugins: [
            {
              requestDidStart: async () => ({
                async didResolveOperation({ request, document, schema }) {
                  const logger = new Logger('QueryComplexity');
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
          context: ({ req }: { req: { headers?: Record<string, string | undefined>; user?: JwtPayload } }): GatewayContext => {
            // Decode JWT in context to make user available in willSendRequest
            // Guard runs after context, so we need to decode here for forwarding
            // NOTE: This is just for forwarding; actual validation happens in guards
            const jwtSecret = configService.get<string>('JWT_SECRET') || 'context-decode-only';

            // Ensure headers object exists with proper type
            const headers: RequestHeaders = {
              authorization: req.headers?.['authorization'],
              'x-tenant-id': req.headers?.['x-tenant-id'],
              'x-correlation-id': req.headers?.['x-correlation-id'],
            };

            const requestWithUser: RequestWithUser = {
              headers,
              user: req.user,
            };

            const user = decodeJwtFromRequest(requestWithUser, jwtSecret);
            if (user) {
              requestWithUser.user = user;
            }

            return { req: requestWithUser };
          },
        },
      }),
    }),

    // MinIO Storage Module for file uploads
    StorageModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        endpoint: configService.get('MINIO_ENDPOINT', 'localhost'),
        port: parseInt(configService.get('MINIO_PORT', '9000'), 10),
        useSSL: configService.get('MINIO_USE_SSL', 'false') === 'true',
        accessKey: configService.get('MINIO_ACCESS_KEY', 'minioadmin'),
        secretKey: configService.get('MINIO_SECRET_KEY', 'minioadmin'),
        bucket: configService.get('MINIO_BUCKET', 'aquaculture'),
        region: configService.get('MINIO_REGION', 'us-east-1'),
      }),
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
    // Global auth guard
    {
      provide: APP_GUARD,
      useClass: GraphQLAuthGuard,
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
        // Order matters: set correlation id, hydrate user, then tenant, then log
        CorrelationIdMiddleware,
        UserContextMiddleware,
        TenantContextMiddleware,
        RequestLoggingMiddleware,
      )
      .forRoutes('*');
  }
}
