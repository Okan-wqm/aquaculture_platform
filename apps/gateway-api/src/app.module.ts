import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloGatewayDriver, ApolloGatewayDriverConfig } from '@nestjs/apollo';
import { IntrospectAndCompose, RemoteGraphQLDataSource } from '@apollo/gateway';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import {
  TenantContextMiddleware,
  CorrelationIdMiddleware,
  RequestLoggingMiddleware,
} from '@platform/backend-common';
import { StorageModule } from '@platform/storage';
import { HealthModule } from './health/health.module';
import { UploadModule } from './upload/upload.module';
import { WebSocketModule } from './websocket/websocket.module';
import { GraphQLAuthGuard } from './guards/graphql-auth.guard';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { RequestLoggingInterceptor } from './interceptors/request-logging.interceptor';

/**
 * Extract and decode JWT token from request
 */
function decodeJwtFromRequest(req: any, jwtSecret: string): any {
  const authHeader = req.headers?.authorization;
  if (!authHeader) return null;

  const [type, token] = authHeader.split(' ');
  if (type !== 'Bearer' || !token) return null;

  try {
    // Simple JWT decode without verification (verification done by guard)
    // We just need to extract the payload for forwarding
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    return payload;
  } catch {
    return null;
  }
}

/**
 * Custom data source that forwards headers to subgraphs
 */
class AuthenticatedDataSource extends RemoteGraphQLDataSource {
  override willSendRequest({
    request,
    context,
  }: {
    request: any;
    context: any;
  }) {
    // Forward authentication and tenant headers to subgraphs
    if (context.req?.headers?.authorization) {
      request.http.headers.set('authorization', context.req.headers.authorization);
    }

    // Forward tenant ID - prefer JWT tenantId, fallback to header
    const tenantId = context.req?.user?.tenantId || context.req?.headers?.['x-tenant-id'];
    // DEBUG: Log tenant ID forwarding
    console.log(`[Gateway] willSendRequest - user.tenantId=${context.req?.user?.tenantId}, header=${context.req?.headers?.['x-tenant-id']}, forwarding=${tenantId}`);
    if (tenantId) {
      request.http.headers.set('x-tenant-id', tenantId);
    }

    if (context.req?.headers?.['x-correlation-id']) {
      request.http.headers.set('x-correlation-id', context.req.headers['x-correlation-id']);
    }
    // Forward user info if decoded
    if (context.req?.user) {
      request.http.headers.set('x-user-id', context.req.user.sub);
      request.http.headers.set('x-user-roles', JSON.stringify(context.req.user.roles || []));
      // Forward full user payload for @CurrentUser() decorator in subgraphs
      request.http.headers.set('x-user-payload', JSON.stringify(context.req.user));
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
          context: ({ req }: { req: any }) => {
            // Decode JWT in context to make user available in willSendRequest
            // Guard runs after context, so we need to decode here for forwarding
            const jwtSecret = configService.get<string>('JWT_SECRET') || 'dev-only-secret-do-not-use-in-production';
            const authHeader = req.headers?.authorization;
            const xTenantId = req.headers?.['x-tenant-id'];
            console.log(`[Gateway Context] authHeader exists=${!!authHeader}, x-tenant-id=${xTenantId}`);
            const user = decodeJwtFromRequest(req, jwtSecret);
            console.log(`[Gateway Context] decoded user tenantId=${user?.tenantId}, sub=${user?.sub}`);
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
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(CorrelationIdMiddleware, TenantContextMiddleware, RequestLoggingMiddleware)
      .forRoutes('*');
  }
}
