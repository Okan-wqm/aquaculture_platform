import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloFederationDriver, ApolloFederationDriverConfig } from '@nestjs/apollo';
import { JwtModule } from '@nestjs/jwt';
import { CqrsModule } from '@nestjs/cqrs';
import { APP_FILTER } from '@nestjs/core';
import depthLimit from 'graphql-depth-limit';
import { ConfigurationModule } from './configuration/configuration.module';
import { HealthModule } from './health/health.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
      cache: true,
    }),

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
          database: configService.get('DATABASE_NAME', 'config_service'),
          autoLoadEntities: true,
          synchronize: false,
          logging: configService.get('DATABASE_LOGGING', 'false') === 'true',
          ssl: (() => {
            const sslEnabled = configService.get('DATABASE_SSL') === 'true';
            if (!sslEnabled) return false;
            const caPath = configService.get<string>('DATABASE_SSL_CA');
            const rejectUnauthorized = configService.get('DATABASE_SSL_REJECT_UNAUTHORIZED', 'true') !== 'false';
            return {
              rejectUnauthorized,
              ...(caPath ? { ca: require('fs').readFileSync(caPath) } : {}),
            };
          })(),
          extra: {
            max: configService.get<number>('DATABASE_POOL_SIZE', 10),
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
      playground: process.env['NODE_ENV'] !== 'production',
      introspection: process.env['NODE_ENV'] !== 'production',
      installSubscriptionHandlers: false,
      validationRules: [depthLimit(10)],
      context: ({ req }: { req: Request }) => ({ req }),
    }),

    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: configService.get('JWT_EXPIRES_IN', '1d') },
      }),
    }),

    CqrsModule,
    ConfigurationModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}
