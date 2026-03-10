import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
} from '@nestjs/apollo';
import { JwtModule } from '@nestjs/jwt';
import { APP_FILTER } from '@nestjs/core';
import {
  CorrelationIdMiddleware,
  UserContextMiddleware,
  TenantContextMiddleware,
} from '@platform/backend-common';
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
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
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

    // Feature modules
    NotificationModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(
        CorrelationIdMiddleware,
        UserContextMiddleware,
        TenantContextMiddleware,
      )
      .forRoutes('*');
  }
}
