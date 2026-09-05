import { join } from 'path';

import {
  AccessLogModule,
  AuditLogInterceptor,
  AuditLogModule,
  AuditedOperationModule,
} from '@aquaculture/backend-common/audit';
import { TenantErasureTargetModule } from '@aquaculture/backend-common/compliance';
import {
  RlsModule,
  getRlsExcludeTablesForService,
  AuditColumnsModule,
  createSchemaVersionGate,
  SchemaDriftModule,
  createServiceTypeOrmConfig,
  isSchemaDdlOwnedByDbMigrate,
} from '@aquaculture/backend-common/database';
import { TenantGuard, RolesGuard, ServiceIdentityGuard } from '@aquaculture/backend-common/guards';
import { LoggingModule } from '@aquaculture/backend-common/logging';
import { ServiceMetricsModule } from '@aquaculture/backend-common/metrics';
import {
  UserContextMiddleware,
  TenantContextMiddleware,
  StripInternalHeadersMiddleware,
  VerifiedUserAssertionMiddleware,
} from '@aquaculture/backend-common/middleware';
import { RedisModule, buildRedisOptions } from '@aquaculture/backend-common/redis';
import { ApolloFederationDriver, ApolloFederationDriverConfig } from '@nestjs/apollo';
import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { GraphQLModule } from '@nestjs/graphql';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventBusModule, buildEventBusConfig } from '@platform/event-bus';
import depthLimit from 'graphql-depth-limit';

import { BillingModule } from './billing/billing.module';
import { BillingOutboxModule } from './outbox/billing-outbox.module';
import { InvoiceLineItem, TaxInfo, BillingAddress } from './billing/entities/invoice.entity';
import { PaymentMethodDetails, RefundInfo } from './billing/entities/payment.entity';
import {
  ModuleQuantities,
  ModuleLineItem,
} from './billing/entities/subscription-module-item.entity';
import { PlanLimits, PlanPricing } from './billing/entities/subscription.entity';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { HealthModule } from './health/health.module';
import { MeteringModule } from './modules/metering/metering.module';

/**
 * BillingMigrationRunnerService — production schema-version gate for the
 * billing schema. In DB_MIGRATE_AUTHORITATIVE=true deployments, the
 * one-shot aqua-db-migrate container is the DDL writer and this provider
 * verifies the migration ledger before billing-service serves traffic.
 * Local/E2E can still opt into TypeORM migration execution through the
 * standard DATABASE_MIGRATIONS_RUN flow below.
 */
const BillingMigrationRunnerService = createSchemaVersionGate('billing');
const billingSchemaDdlOwnedByDbMigrate = isSchemaDdlOwnedByDbMigrate(process.env);

@Module({
  imports: [
    // ADR-0006: this service is an nginx upstream (serviceVisibility 'public').
    // AccessLogModule provides AccessLogService; the bootstrap factory mounts
    // AccessLogMiddleware ahead of every Nest middleware so each request this
    // edge terminates writes one shared.access_logs row. Enforced by
    // tests/invariants/public-service-edge-hardening.spec.ts.
    AccessLogModule.forRoot(),
    LoggingModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    // Database connection — billing-service owns the 'billing' schema. Uses
    // the platform TypeORM factory; pool / SSL / fail-fast / env contract
    // are all routed through createServiceTypeOrmConfig.
    //
    // INFRA-DB-SSL-001 fix: previously read DB_SSL while compose set
    // DATABASE_SSL — SSL was silently disabled. Factory uses DATABASE_SSL.
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        createServiceTypeOrmConfig(configService, {
          serviceName: 'billing',
          schema: 'billing',
          // BillingMigrationRunnerService (provider below) executes pending
          // migrations at OnApplicationBootstrap with search_path pinning
          // + per-migration transaction isolation. Factory default
          // (migrationsRun: false) keeps TypeORM out of that codepath.
          migrations: [__dirname + '/database/migrations/[0-9]*.{js,ts}'],
          // INFRA-CRITICAL-020 contract: env-aware migration timing.
          // - Production: DATABASE_MIGRATIONS_RUN=false (default). The
          //   aqua-db-migrate container runs migrations BEFORE service
          //   containers start, so this service's TypeORM does NOT touch
          //   the migration table at boot — MigrationRunnerService below
          //   verifies the schema is healthy and proceeds.
          // - E2E tests: harness sets DATABASE_MIGRATIONS_RUN=true so
          //   TypeORM runs migrations at DataSource init — BEFORE the
          //   SourceSchemaBootstrapService onApplicationBootstrap hook
          //   fires, which would otherwise hard-fail on an empty source
          //   schema (INFRA-CRITICAL-009, INFRA-CRITICAL-020).
          migrationsRunFromEnv: (cs) =>
            cs.get<string>('DATABASE_MIGRATIONS_RUN', 'false') === 'true',
        }),
    }),
    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      autoSchemaFile: {
        federation: 2,
        path: join(process.cwd(), 'dist/graphql/subgraphs/billing.graphql'),
      },
      /** SEC-M21: Disable GraphQL query batching to prevent batch-based brute-force attacks.
       *  The gateway already blocks batching, but subgraphs must also enforce this as
       *  defense-in-depth in case a subgraph becomes directly accessible. */
      allowBatchedHttpRequests: false,
      /**
       * Keep Apollo CSRF prevention explicit as defense in depth against
       * cross-site search and simple-request execution paths.
       */
      csrfPrevention: true,
      playground: false,
      graphiql: process.env['NODE_ENV'] !== 'production',
      /**
       * SECURITY (H-05): depthLimit(10) prevents deeply nested query DoS attacks.
       * Without depth limiting, an attacker can craft a deeply nested GraphQL query
       * that causes exponential resource consumption on the server.
       */
      validationRules: [depthLimit(10)],
      buildSchemaOptions: {
        orphanedTypes: [
          InvoiceLineItem,
          TaxInfo,
          BillingAddress,
          PaymentMethodDetails,
          RefundInfo,
          PlanLimits,
          PlanPricing,
          ModuleQuantities,
          ModuleLineItem,
        ],
      },
      /**
       * 2026-04-30: Deprecated GraphQL Playground is not enabled at runtime.
       * WHY: internal subgraphs must remain fail-closed and not reference deprecated UI paths.
       */
      // SECURITY: Internal subgraph - always disable introspection
      introspection: false,
      context: ({ req }: { req: Request }) => ({ req }),
    }),
    // Redis for caching and distributed state
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        buildRedisOptions(configService, 'billing', 'optional'),
    }),
    // Event Bus Module (NATS JetStream)
    EventBusModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: buildEventBusConfig,
    }),
    BillingOutboxModule,
    TenantErasureTargetModule.forService('billing-service'),
    // Schedule module — single forRoot() for the entire service
    ScheduleModule.forRoot(),
    // Event Emitter — single forRoot() for the entire service
    EventEmitterModule.forRoot(),
    BillingModule,
    MeteringModule,
    HealthModule,
    // OBS-HIGH-001: Prometheus GET /metrics scrape endpoint + HTTP metrics
    // middleware (self-contained platform module — controller is @Public()).
    ServiceMetricsModule,
    /** SEC-M22: Audit trail infrastructure for compliance tracking. */
    AuditLogModule.forRoot(),
    /**
     * AUDITTRAIL-CRITICAL-002 cure: registers AuditedOperationInterceptor
     * as a global APP_INTERCEPTOR so the 7 @AuditedOperation()-decorated
     * billing handlers (create/change/cancel subscription, create/finalize/
     * void invoice, record/refund payment) actually write audit rows.
     * Pre-fix the decorators were structurally inert — no service in the
     * fleet imported AuditedOperationModule, so audit-row coverage across
     * 180 CQRS handlers was ~1%. Mounting this module here is the
     * make-automatic Tier-2 cure that activates the existing decorators
     * without further per-handler changes.
     */
    AuditedOperationModule.forRoot(),
    /**
     * SEC-DB: Tenant Row-Level Security.
     *
     * In production-like deployments DB_MIGRATE_AUTHORITATIVE=true means
     * aqua-db-migrate is the only schema writer. billing-service still patches
     * the connection pool and sets the RLS GUCs per request, but it must not
     * attempt table-level DDL at startup. Local/dev can keep autoApply as a
     * bootstrap convenience when the central migration container is not the
     * active schema owner.
     */
    RlsModule.forPoolService({
      serviceName: 'billing',
      autoApply: !billingSchemaDdlOwnedByDbMigrate,
      excludeTables: getRlsExcludeTablesForService('billing'),
    }),
    /**
     * NEW-H1: Convert TIMESTAMP audit columns to TIMESTAMPTZ.
     *
     * Production DDL is owned by aqua-db-migrate. The runtime bootstrap is
     * kept only for local/dev environments where the authoritative migration
     * container is not active.
     *
     * No excludeTables — all billing-service tables should use TIMESTAMPTZ
     * for audit-trail integrity (financial timestamps are compliance-
     * sensitive and must not drift across DST).
     */
    ...(billingSchemaDdlOwnedByDbMigrate
      ? []
      : [AuditColumnsModule.forRoot({ serviceName: 'billing' })]),
    /**
     * P11 of 2026-04-14 teardown — runtime schema-drift validator.
     * Compares entity metadata to information_schema at every cold start;
     * fires `schema.drift.detected` on uuid/text/schema-location/nullability
     * mismatches. Fatal mode opt-in via SCHEMA_DRIFT_FATAL=true env var.
     * See ADR-012 + docs/runbooks/schema-drift-response.md.
     */
    SchemaDriftModule.forRoot({ serviceName: 'billing' }),
  ],
  providers: [
    // Migration runner — runs pending TypeORM migrations on the billing
    // schema at OnApplicationBootstrap. Declared first in the provider
    // list so NestJS instantiates it early (NestJS does not guarantee
    // OnApplicationBootstrap order beyond module dependency graph, but
    // declaration order is a reliable tiebreaker for same-module
    // providers). The runner itself uses search_path pinning and a
    // dedicated QueryRunner — see createSchemaVersionGate for the
    // full architectural rationale.
    BillingMigrationRunnerService,
    // SECURITY: Service identity guard - validates HMAC-signed service identity headers
    // Must be FIRST guard (before auth/tenant/roles) to verify request origin
    // WHY: useFactory bypasses reflect-metadata resolution which fails in Docker Alpine.
    {
      provide: APP_GUARD,
      useFactory: (configService: ConfigService): ServiceIdentityGuard =>
        new ServiceIdentityGuard(configService, undefined, 'billing-service'),
      inject: [ConfigService],
    },
    // SECURITY: Global JWT auth guard - requires authentication on all resolvers
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector): JwtAuthGuard => new JwtAuthGuard(reflector),
      inject: [Reflector],
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
      useFactory: (reflector: Reflector): RolesGuard => new RolesGuard(reflector),
      inject: [Reflector],
    },
    /** SEC-M22: Register global audit logging for compliance — all mutations are tracked. */
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditLogInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Middleware execution order:
    // 0. StripInternalHeadersMiddleware (SECREV-CRITICAL-002): MUST run
    //    BEFORE UserContextMiddleware. Verifies the request carries a
    //    valid x-service-identity + x-service-signature pair signed with
    //    INTERNAL_SERVICE_SECRET; if not, strips x-user-payload /
    //    x-user-id / x-user-roles / x-tenant-id from req.headers so
    //    UserContextMiddleware cannot pick up a forged SUPER_ADMIN
    //    payload from a Docker-network attacker. The Stripe webhook
    //    controller is @Public() and previously trusted unvalidated
    //    metadata.tenantId — closing this header path closes the
    //    forge-on-public-route surface SECREV-CRITICAL-001 references.
    // 1. VerifiedUserAssertionMiddleware (SEC-HIGH-156) - resolve req.user /
    //    req.tenantId from the gateway-signed verified-user assertion.
    // 2. UserContextMiddleware - Parse x-user-payload header from gateway (sets req.user)
    // 3. TenantContextMiddleware - Extract tenant from JWT/headers (uses req.user.tenantId)
    consumer.apply(StripInternalHeadersMiddleware).forRoutes('*');

    // EXCLUDED from the Stripe webhook (controllers/stripe-webhook.controller.ts,
    // @Controller('webhooks') → /webhooks/stripe per the Faz C prefixExclusions in
    // main.ts): Stripe authenticates with its own webhook signature and sends NO
    // gateway service identity, so requiring one there would 500 the webhook. Both
    // the prefix-stripped (/webhooks) and legacy prefixed (/api/v1/webhooks) forms
    // are excluded to fail safe across the routing change.
    consumer
      .apply(VerifiedUserAssertionMiddleware)
      .exclude('webhooks', 'webhooks/{*path}', 'api/v1/webhooks', 'api/v1/webhooks/{*path}')
      .forRoutes('*');

    consumer.apply(UserContextMiddleware, TenantContextMiddleware).forRoutes('*');
  }
}
