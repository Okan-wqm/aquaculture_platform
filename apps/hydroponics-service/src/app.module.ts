import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
} from '@nestjs/apollo';
import { CqrsModule } from '@nestjs/cqrs';
import { GraphQLError } from 'graphql';
import depthLimit from 'graphql-depth-limit';
import { fieldExtensionsEstimator, getComplexity, simpleEstimator } from 'graphql-query-complexity';
import {
  TenantContextMiddleware,
  CorrelationIdMiddleware,
  UserContextMiddleware,
  RolesGuard,
} from '@platform/backend-common';
import { TenantSchemaMiddleware } from './middleware/tenant-schema.middleware';
import { HydroponicsSetupModule } from './setup/setup.module';
import { HealthModule } from './health/health.module';

// Entities
import { HydroponicsConfig } from './setup/entities/hydroponics-config.entity';

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
        synchronize: configService.get('NODE_ENV') !== 'production',
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
            ...(caPath ? { ca: require('fs').readFileSync(caPath) } : {}),
          };
        })(),
        extra: {
          max: configService.get<number>('DB_POOL_SIZE', 20),
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000,
        },
      };
      },
    }),
    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      autoSchemaFile: {
        federation: 2,
      },
      validationRules: [depthLimit(10)],
      plugins: [
        {
          requestDidStart: async () => ({
            async didResolveOperation({ request, document, schema }) {
              const complexity = getComplexity({
                schema,
                operationName: request.operationName,
                query: document,
                variables: request.variables,
                estimators: [fieldExtensionsEstimator(), simpleEstimator({ defaultComplexity: 1 })],
              });
              const maxComplexity = 1000;
              if (complexity > maxComplexity) {
                throw new GraphQLError(`Query too complex: ${complexity}. Maximum allowed: ${maxComplexity}`);
              }
            },
          }),
        },
      ],
      playground: process.env['NODE_ENV'] !== 'production',
      introspection: process.env['NODE_ENV'] !== 'production',
      context: ({ req }: { req: Request }) => ({ req }),
    }),
    CqrsModule.forRoot(),
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get('JWT_SECRET', 'dev-secret'),
        signOptions: { expiresIn: configService.get('JWT_EXPIRES_IN', '1d') },
      }),
    }),
    HydroponicsSetupModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
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
        UserContextMiddleware,
        TenantContextMiddleware,
        TenantSchemaMiddleware,
      )
      .forRoutes('*');
  }
}
