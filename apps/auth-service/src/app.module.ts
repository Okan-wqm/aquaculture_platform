import { ApolloFederationDriver, ApolloFederationDriverConfig } from '@nestjs/apollo';
import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantContextMiddleware, CorrelationIdMiddleware, UserContextMiddleware, RequestLoggingMiddleware } from '@platform/backend-common';
import { EventBusModule } from '@platform/event-bus';

import { AuditModule } from './audit/audit.module';
import { HealthModule } from './health/health.module';
import { AnnouncementModule } from './modules/announcement/announcement.module';
import { AuthenticationModule } from './modules/authentication/authentication.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { SupportModule } from './modules/support/support.module';
import { SystemModule } from './modules/system-module/system-module.module';
import { TenantModule } from './modules/tenant/tenant.module';

@Module({
  imports: [
    // Global configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
      cache: true,
    }),

    // Database connection with schema separation
    // auth-service owns the 'auth' schema
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
        port: configService.get('DATABASE_PORT', 5432),
        username: configService.get('DATABASE_USER', 'postgres'),
        password: dbPassword || 'postgres',
        database: configService.get('DATABASE_NAME', 'aquaculture'),
        schema: configService.get('DATABASE_SCHEMA', 'auth'),
        autoLoadEntities: true,
        synchronize: configService.get('DATABASE_SYNC', 'false') === 'true',
        logging: configService.get('DATABASE_LOGGING', 'false') === 'true',
        // SECURITY: SSL configuration with proper certificate validation
        ssl: (() => {
          const sslEnabled = configService.get('DATABASE_SSL', 'false') === 'true';
          if (!sslEnabled) return false;

          const isProduction = configService.get('NODE_ENV') === 'production';
          const caPath = configService.get<string>('DATABASE_SSL_CA');
          const rejectUnauthorized = configService.get('DATABASE_SSL_REJECT_UNAUTHORIZED', 'true') !== 'false';

          // CRITICAL: In production, require proper SSL verification unless explicitly disabled
          if (isProduction && !rejectUnauthorized && !caPath) {
            throw new Error(
              'SECURITY ERROR: SSL certificate verification disabled in production! ' +
              'This makes the connection vulnerable to MITM attacks. ' +
              'Set DATABASE_SSL_CA to your CA certificate path or enable verification.',
            );
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
    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      autoSchemaFile: {
        federation: 2,
      },
      playground: process.env['NODE_ENV'] !== 'production',
      // SECURITY: Disable introspection in production to prevent schema discovery
      introspection: process.env['NODE_ENV'] !== 'production',
      context: ({ req }: { req: Request }) => ({ req }),
    }),

    // Global JWT module
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
              issuer: configService.get('JWT_ISSUER', 'aquaculture-platform'),
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
            issuer: configService.get('JWT_ISSUER', 'aquaculture-platform'),
          },
        };
      },
    }),

    // Event Bus
    EventBusModule.forRoot(),

    // Feature modules
    AuthenticationModule,
    TenantModule,
    SystemModule,
    MessagingModule,
    SupportModule,
    AnnouncementModule,
    AuditModule,
    HealthModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(
        CorrelationIdMiddleware,
        UserContextMiddleware,
        TenantContextMiddleware,
        RequestLoggingMiddleware,
      )
      .forRoutes('*');
  }
}
