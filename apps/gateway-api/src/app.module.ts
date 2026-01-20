import {
  IntrospectAndCompose,
  RemoteGraphQLDataSource,
  GraphQLDataSourceProcessOptions,
} from '@apollo/gateway';
import { ApolloGatewayDriver, ApolloGatewayDriverConfig } from '@nestjs/apollo';
import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { JwtModule } from '@nestjs/jwt';
import {
  TenantContextMiddleware,
  CorrelationIdMiddleware,
  RequestLoggingMiddleware,
} from '@platform/backend-common';
import { StorageModule } from '@platform/storage';

import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { GraphQLAuthGuard } from './guards/graphql-auth.guard';
import { RateLimitGuard } from './guards/rate-limit.guard';
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
 * Request with user information attached
 */
interface RequestWithUser {
  headers?: {
    authorization?: string;
    'x-tenant-id'?: string;
    'x-correlation-id'?: string;
  };
  user?: JwtPayload;
}

/**
 * Extended context type for Apollo Gateway
 */
interface GatewayContext {
  req?: RequestWithUser;
}

/**
 * Extract and decode JWT token from request
 */
function decodeJwtFromRequest(req: RequestWithUser, _jwtSecret: string): JwtPayload | null {
  const authHeader = req.headers?.authorization;
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
 * Custom data source that forwards headers to subgraphs
 */
class AuthenticatedDataSource extends RemoteGraphQLDataSource<GatewayContext> {
  override willSendRequest(options: GraphQLDataSourceProcessOptions<GatewayContext>): void {
    const { request, context } = options;
    const req = context?.req;

    // Forward authentication and tenant headers to subgraphs
    if (req?.headers?.authorization && request.http) {
      request.http.headers.set('authorization', req.headers.authorization);
    }

    // Forward tenant ID - prefer JWT tenantId, fallback to header
    const tenantId = req?.user?.tenantId ?? req?.headers?.['x-tenant-id'];
    if (tenantId && request.http) {
      request.http.headers.set('x-tenant-id', tenantId);
    }

    if (req?.headers?.['x-correlation-id'] && request.http) {
      request.http.headers.set('x-correlation-id', req.headers['x-correlation-id']);
    }

    // Forward user info if decoded
    if (req?.user && request.http) {
      request.http.headers.set('x-user-id', req.user.sub);
      request.http.headers.set('x-user-roles', JSON.stringify(req.user.roles ?? []));
      // Forward full user payload for @CurrentUser() decorator in subgraphs
      request.http.headers.set('x-user-payload', JSON.stringify(req.user));
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
    // SECURITY: JWT_SECRET must be provided via environment variable in production
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const secret = configService.get<string>('JWT_SECRET');
        if (!secret && process.env['NODE_ENV'] === 'production') {
          throw new Error('JWT_SECRET environment variable must be set in production');
        }
        return {
          secret: secret || 'dev-only-secret-do-not-use-in-production',
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
          supergraphSdl: new IntrospectAndCompose({
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
          introspection: true,
          context: ({ req }: { req: RequestWithUser }): GatewayContext => {
            // Decode JWT in context to make user available in willSendRequest
            // Guard runs after context, so we need to decode here for forwarding
            const jwtSecret = configService.get<string>('JWT_SECRET') ?? 'dev-only-secret-do-not-use-in-production';
            const user = decodeJwtFromRequest(req, jwtSecret);
            if (user) {
              req.user = user;
            }
            return { req };
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
      .apply(CorrelationIdMiddleware, TenantContextMiddleware, RequestLoggingMiddleware)
      .forRoutes('*');
  }
}
