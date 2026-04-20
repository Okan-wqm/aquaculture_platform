import { ApolloFederationDriver, ApolloFederationDriverConfig } from '@nestjs/apollo';
import { Logger, Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import depthLimit from 'graphql-depth-limit';
import { TenantContextMiddleware, CorrelationIdMiddleware, UserContextMiddleware, RequestLoggingMiddleware, RequestContextMiddleware, MetricsMiddleware, TenantGuard, RolesGuard, ServiceIdentityGuard, RedisModule, TOKEN_BLACKLIST, ITokenBlacklist, RlsModule, SchemaDriftModule, createServiceTypeOrmConfig } from '@aquaculture/backend-common';
import { EventBusModule } from '@platform/event-bus';

import { AuthSchemaBootstrapModule } from './database/auth-schema-bootstrap.module';
import { AuditModule } from './audit/audit.module';
import { SECURITY_CONSTANTS } from './constants/auth.constants';
import { HealthModule } from './health/health.module';
import { AuthMetricsModule } from './metrics/metrics.module';
import { JwtAuthGuard } from './modules/authentication/guards/jwt-auth.guard';
import { AnnouncementModule } from './modules/announcement/announcement.module';
import { AuthenticationModule } from './modules/authentication/authentication.module';
import { GdprModule } from './modules/gdpr/gdpr.module';
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

    // Database connection — auth-service owns the 'auth' schema. Uses the
    // platform TypeORM factory so pool size, SSL, fail-fast, env-var
    // contract, and search_path semantics stay identical across services.
    // auth-service does NOT use TenantConnectionBootstrap (it owns a
    // single global schema, not per-tenant ones), but the factory's
    // `extra.options: -c search_path=auth,public` covers schema routing
    // without needing TypeORM's `schema:` option.
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        createServiceTypeOrmConfig(configService, {
          serviceName: 'auth',
          schema: 'auth',
          // INFRA-CRITICAL-021 contract: factory mandates explicit entities
          // (defense-in-depth against the global-metadata fallback path).
          // Empty array + autoLoadEntities (factory default) means every
          // entity registered via TypeOrmModule.forFeature() in any imported
          // domain module is auto-merged into the connection entity list.
          entities: [],
          // Enterprise: TypeORM's built-in migrationsRun is idempotent and
          // safe for multi-replica because the `migrations` table acts as a
          // distributed lock via row-level uniqueness on `name`. auth-service
          // is the ONLY service still on this path; every other service uses
          // the MigrationRunnerService factory which adds search_path
          // invariants and production hard-fail semantics.
          migrationsRun: true,
          migrations: [__dirname + '/migrations/*{.ts,.js}'],
        }),
    }),

    // Schema bootstrap — MUST be before any module that queries auth.users
    // Ensures new columns (like accessType) exist before SeedService runs
    AuthSchemaBootstrapModule,

    // GraphQL Federation
    GraphQLModule.forRootAsync<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const isProduction = configService.get<string>('NODE_ENV') === 'production';
        return {
          autoSchemaFile: { federation: 2, path: join('/tmp', 'schema.graphql') },
          /** SEC-M21: Disable GraphQL query batching to prevent batch-based brute-force attacks.
           *  The gateway already blocks batching, but subgraphs must also enforce this as
           *  defense-in-depth in case a subgraph becomes directly accessible. */
          allowBatchedHttpRequests: false,
          /**
           * SECURITY (H-05): depthLimit(10) prevents deeply nested query DoS attacks.
           * Without depth limiting, an attacker can craft a deeply nested GraphQL query
           * that causes exponential resource consumption on the server.
           */
          validationRules: [depthLimit(10)],
          playground: !isProduction,
          // SECURITY: Disable introspection in production to prevent schema discovery
          introspection: !isProduction,
          context: ({ req, res }: { req: Request; res: Response }) => ({ req, res }),
        };
      },
    }),

    // Global JWT module — RS256 asymmetric signing
    // SECURITY (CRITICAL-001): auth-service is the SOLE token issuer.
    // Signs with JWT_PRIVATE_KEY (RS256). All consumer services verify with
    // the corresponding public key. JWT_SECRET is no longer accepted.
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const nodeEnv = configService.get<string>('NODE_ENV', 'development');
        const isProduction = nodeEnv === 'production';

        // SECURITY: Load RSA private key for token signing
        const loadPrivateKey = (): string => {
          // Inline PEM (Kubernetes secrets, cloud env vars)
          const inlinePem = configService.get<string>('JWT_PRIVATE_KEY');
          if (inlinePem) {
            if (!inlinePem.includes('-----BEGIN')) {
              return Buffer.from(inlinePem, 'base64').toString('utf8');
            }
            return inlinePem;
          }
          // File path (docker-compose volume mounts)
          const keyPath = configService.get<string>('JWT_PRIVATE_KEY_PATH');
          if (keyPath) {
            return require('fs').readFileSync(keyPath, 'utf8');
          }
          return '';
        };

        // SECURITY: Load RSA public key for verification (auth-service also verifies its own tokens)
        const loadPublicKey = (): string => {
          const inlinePem = configService.get<string>('JWT_PUBLIC_KEY');
          if (inlinePem) {
            if (!inlinePem.includes('-----BEGIN')) {
              return Buffer.from(inlinePem, 'base64').toString('utf8');
            }
            return inlinePem;
          }
          const keyPath = configService.get<string>('JWT_PUBLIC_KEY_PATH');
          if (keyPath) {
            return require('fs').readFileSync(keyPath, 'utf8');
          }
          return '';
        };

        const privateKey = loadPrivateKey();
        const publicKey = loadPublicKey();

        // CRITICAL: Always require RSA keys in production
        if (isProduction && (!privateKey || !publicKey)) {
          throw new Error(
            'CRITICAL SECURITY ERROR: JWT_PRIVATE_KEY and JWT_PUBLIC_KEY must be configured in production. ' +
            'auth-service is the sole token issuer and requires RSA key pair for RS256 signing. ' +
            'Application startup aborted to prevent security vulnerability.',
          );
        }

        // In non-production, allow dev fallback with explicit acknowledgment
        if (!privateKey || !publicKey) {
          const allowDevSecret = configService.get<string>('ALLOW_DEV_JWT_SECRET', 'false');
          const devSecret = configService.get<string>('DEV_JWT_SECRET');

          if (allowDevSecret !== 'true') {
            throw new Error(
              'JWT_PRIVATE_KEY and JWT_PUBLIC_KEY are not configured. For development, set ALLOW_DEV_JWT_SECRET=true and provide DEV_JWT_SECRET ' +
              `with at least ${SECURITY_CONSTANTS.JWT_SECRET_MIN_LENGTH} characters. NEVER enable this in staging/production!`,
            );
          }

          if (!devSecret || devSecret.length < SECURITY_CONSTANTS.JWT_SECRET_MIN_LENGTH) {
            throw new Error(
              `DEV_JWT_SECRET must be provided and be at least ${SECURITY_CONSTANTS.JWT_SECRET_MIN_LENGTH} characters when ALLOW_DEV_JWT_SECRET=true.`,
            );
          }

          const logger = new Logger('JwtModule');
          logger.warn(
            'SECURITY: Using DEV_JWT_SECRET with HS256 for local development only. ' +
            'Production MUST use RS256 with JWT_PRIVATE_KEY/JWT_PUBLIC_KEY.',
          );
          return {
            secret: devSecret,
            signOptions: {
              algorithm: 'HS256' as const,
              expiresIn: configService.get('JWT_EXPIRES_IN', SECURITY_CONSTANTS.DEFAULT_JWT_EXPIRES_IN),
              issuer: configService.get('JWT_ISSUER', 'aquaculture-platform'),
              audience: configService.get('JWT_AUDIENCE', 'aquaculture-platform'),
            },
          };
        }

        return {
          privateKey,
          publicKey,
          signOptions: {
            // SECURITY: RS256 asymmetric signing — only auth-service holds the private key.
            // Consumer services verify with the public key; a compromised consumer
            // cannot forge tokens for other services.
            algorithm: 'RS256' as const,
            expiresIn: configService.get('JWT_EXPIRES_IN', SECURITY_CONSTANTS.DEFAULT_JWT_EXPIRES_IN),
            issuer: configService.get('JWT_ISSUER', 'aquaculture-platform'),
            audience: configService.get('JWT_AUDIENCE', 'aquaculture-platform'),
          },
          verifyOptions: {
            algorithms: ['RS256'],
          },
        };
      },
    }),

    // Redis — WebAuthn challenge store, session management, token blacklist.
    // @Optional() in consumers: graceful in-memory fallback when Redis unavailable.
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        url: configService.get<string>('REDIS_URL', 'redis://localhost:6379'),
        keyPrefix: 'auth:',
      }),
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
    GdprModule,
    AuditModule,
    HealthModule,

    // Prometheus metrics (per-service /metrics endpoint)
    AuthMetricsModule,

    /**
     * SECURITY (HIGH-004): Tenant Row-Level Security.
     * auth-service uses the global `auth` schema with tenantId columns on
     * User/Tenant/Invitation/ActionToken tables. autoApply installs the
     * canonical tenant_isolation_policy at OnApplicationBootstrap so
     * defence-in-depth kicks in without a separate migration.
     * excludeTables: audit logs and outbox are cross-tenant by design.
     */
    RlsModule.forPoolService({
      serviceName: 'auth',
      autoApply: true,
      excludeTables: ['auth_outbox', 'audit_log', 'audit_logs'],
    }),
    /** P11 of 2026-04-14 teardown — runtime schema-drift validator. */
    SchemaDriftModule.forRoot({ serviceName: 'auth' }),
  ],
  providers: [
    // WHY: All guards use useFactory to bypass reflect-metadata resolution which fails
    // in Docker Alpine production (design:paramtypes resolves to [null,...]).
    // SECURITY: Service identity guard - validates HMAC-signed service identity headers
    // Must be FIRST guard (before auth/tenant/roles) to verify request origin
    {
      provide: APP_GUARD,
      useFactory: (configService: ConfigService): ServiceIdentityGuard =>
        new ServiceIdentityGuard(configService),
      inject: [ConfigService],
    },
    // SECURITY: Global JWT auth guard
    {
      provide: APP_GUARD,
      useFactory: (jwtService: JwtService, reflector: Reflector, configService: ConfigService, tokenBlacklist?: ITokenBlacklist): JwtAuthGuard =>
        new JwtAuthGuard(jwtService, reflector, configService, tokenBlacklist),
      inject: [JwtService, Reflector, ConfigService, { token: TOKEN_BLACKLIST, optional: true }],
    },
    // SECURITY: Global tenant guard - ensures tenant isolation
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector, configService: ConfigService): TenantGuard =>
        new TenantGuard(reflector, undefined, configService),
      inject: [Reflector, ConfigService],
    },
    // SECURITY: Roles guard - enforces @Roles() decorator authorization
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector): RolesGuard =>
        new RolesGuard(reflector),
      inject: [Reflector],
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(
        MetricsMiddleware,        // Record request metrics (first for accurate duration)
        CorrelationIdMiddleware,
        RequestContextMiddleware, // Populate AsyncLocalStorage for structured logging
        UserContextMiddleware,
        TenantContextMiddleware,
        RequestLoggingMiddleware,
      )
      .forRoutes('*');
  }
}
