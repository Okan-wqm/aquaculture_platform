import { ApolloFederationDriver, ApolloFederationDriverConfig } from '@nestjs/apollo';
import { Logger, Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import depthLimit from 'graphql-depth-limit';
import { RlsModule, SchemaDriftModule, createServiceTypeOrmConfig } from '@aquaculture/backend-common/database';
import { TenantGuard, RolesGuard, ServiceIdentityGuard } from '@aquaculture/backend-common/guards';
import { RequestContextMiddleware } from '@aquaculture/backend-common/logging';
import { MetricsMiddleware } from '@aquaculture/backend-common/metrics';
import { TenantContextMiddleware, CorrelationIdMiddleware, UserContextMiddleware, RequestLoggingMiddleware, StripInternalHeadersMiddleware } from '@aquaculture/backend-common/middleware';
import { AuditedOperationModule } from '@aquaculture/backend-common/audit';
import { RedisModule } from '@aquaculture/backend-common/redis';
import { TOKEN_BLACKLIST, ITokenBlacklist } from '@aquaculture/backend-common/security';
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

    // AUDITTRAIL-HIGH-008 cure: register the NestJS scheduler so @Cron
    // decorators (currently AuditLogService.scheduledLogCleanup, which
    // enforces the 7-year audit retention floor from AUDITTRAIL-HIGH-001)
    // actually fire at runtime. Without ScheduleModule, every @Cron in
    // this service tree is silent dead code.
    ScheduleModule.forRoot(),

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
           * 2026-04-30: Keep Apollo CSRF prevention explicit while Apollo Server 5
           * migration is blocked by the Nest/Apollo peer graph.
           * WHY: Apollo Server 4 remains in the dependency graph, so XS-Search
           * class protections must be fail-closed at runtime.
           */
          csrfPrevention: true,
          /**
           * SECURITY (H-05): depthLimit(10) prevents deeply nested query DoS attacks.
           * Without depth limiting, an attacker can craft a deeply nested GraphQL query
           * that causes exponential resource consumption on the server.
          */
          validationRules: [depthLimit(10)],
          // 2026-04-30: Deprecated GraphQL Playground is not enabled at runtime.
          // WHY: auth developer UI must not rely on deprecated Apollo Playground behavior.
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
    /**
     * AUDITTRAIL-CRITICAL-002 cure: registers AuditedOperationInterceptor
     * as a global APP_INTERCEPTOR so any handler decorated with
     * @AuditedOperation() in this service writes a transactional audit
     * row — the decorator is structurally inert without this module
     * registration. Independent from the local AuditModule above
     * (which is auth-service-specific schema/service infrastructure).
     */
    AuditedOperationModule.forRoot(),
    HealthModule,

    // Prometheus metrics (per-service /metrics endpoint)
    AuthMetricsModule,

    /**
     * SECURITY (HIGH-004): Tenant Row-Level Security — AUTH IDENTITY SPECIAL CASE
     * ============================================================================
     * auth-service's `auth` schema holds per-tenant data (invitations,
     * refresh_tokens, user_consents, announcements, etc.) that MUST be RLS-
     * gated. `autoApply: true` installs the canonical tenant_isolation_policy
     * on every discovered tenantId-bearing table at OnApplicationBootstrap.
     *
     * # Why `users` is excluded (architectural invariant, not workaround)
     *
     * `auth.users` is the platform's IDENTITY-PRIMITIVE table. By definition,
     * it is queried during the **pre-authentication discovery phase** — the
     * login flow does:
     *
     *   findOne({ where: { email } })   ← no tenant context exists yet
     *
     * because the tenant is DETERMINED from the user row (the JWT is only
     * minted after a successful match). Applying `tenant_isolation_policy`
     * to `auth.users` is a category error: the policy's USING clause
     * (`tenantId = current_tenant OR bypass='on'`) evaluates to UNKNOWN
     * when no tenant GUC is set, so findOne returns 0 rows — breaking every
     * login across the platform (DEPLOY-CRITICAL-006, 2026-04-21 incident).
     *
     * A second, even stronger reason: SUPER_ADMIN users have `tenantId = NULL`
     * by design. `NULL = <any uuid>` is never TRUE, so SUPER_ADMIN identities
     * can NEVER be visible under the policy regardless of GUC state. This
     * alone makes RLS structurally incompatible with auth.users — acknowledged
     * in tenant-rls-sync.service.ts:106-108 ("auth-service — can't support
     * RLS because of nullable tenantId on SUPER_ADMIN rows").
     *
     * # Defense-in-depth is preserved without RLS on users
     *
     *   1. Schema-role isolation: only the `auth_service` PG role can touch
     *      `auth.*` tables (see 00-init-schemas.sh + per-service DB roles).
     *   2. Application-layer tenant scoping: every tenant-admin-facing query
     *      against users (e.g. TenantAdminService.listTenantUsers) explicitly
     *      adds `WHERE tenantId = ?` — verified by controller-level tenant
     *      guards + e2e tests.
     *   3. JWT-authenticated handlers: all non-login users queries run
     *      post-authentication, with tenant context from JwtAuthGuard → an
     *      authenticated caller cannot pivot to another tenant's rows.
     *
     * Runtime enforcement of this invariant lives in apply-tenant-rls.helper.ts
     * (DEFAULT_IDENTITY_TABLES auto-skip) — this exclude list is the audit-
     * visible declaration at the AppModule call site.
     *
     * # Other excludeTables
     *   - `auth_outbox`, `audit_log`, `audit_logs`: cross-tenant infrastructure
     *     (audit logs span tenants by design; outbox rows are enqueued by
     *     owners and consumed by the outbox worker without tenant context).
     */
    RlsModule.forPoolService({
      serviceName: 'auth',
      autoApply: true,
      excludeTables: ['auth_outbox', 'audit_log', 'audit_logs', 'users', 'tenants'],
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
        // SECURITY (SEC-CRITICAL-002): MUST run BEFORE UserContextMiddleware.
        // A Docker-network caller can otherwise forge x-user-payload /
        // x-tenant-id and pass forged SUPER_ADMIN context into downstream
        // guards. The middleware verifies the request carries a valid
        // x-service-identity + x-service-signature pair (HMAC-SHA256 of
        // identity using INTERNAL_SERVICE_SECRET); if not, the four
        // spoofable internal headers are stripped from req.headers.
        StripInternalHeadersMiddleware,
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
