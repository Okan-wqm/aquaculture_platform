import { join } from 'path';

import type { GraphQLRequestContextDidResolveOperation } from '@apollo/server';
import {
  AuditLogModule,
  AuditLogInterceptor,
  AuditedOperationModule,
} from '@aquaculture/backend-common/audit';
import { PlatformJwtModule } from '@aquaculture/backend-common/auth';
import { TenantErasureTargetModule } from '@aquaculture/backend-common/compliance';
import {
  AuditColumnsModule,
  createSchemaVersionGate,
  createServiceTypeOrmConfig,
  createTenantConnectionBootstrap,
  isSchemaDdlOwnedByDbMigrate,
  SchemaDriftModule,
  SourceSchemaBootstrapService,
  SourceSchemaWriteGuardService,
  TenantSchemaSyncService,
} from '@aquaculture/backend-common/database';
import { TenantExecutionContextModule } from '@aquaculture/backend-common/context';
import { RolesGuard, ServiceIdentityGuard, TenantGuard } from '@aquaculture/backend-common/guards';
import { RequestContextMiddleware } from '@aquaculture/backend-common/logging';
import { ServiceMetricsModule } from '@aquaculture/backend-common/metrics';
import {
  CorrelationIdMiddleware,
  createTenantSchemaMiddleware,
  StripInternalHeadersMiddleware,
  VerifiedUserAssertionMiddleware,
  TenantContextMiddleware,
  UserContextMiddleware,
} from '@aquaculture/backend-common/middleware';
import { ApolloFederationDriver, ApolloFederationDriverConfig } from '@nestjs/apollo';
import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { CqrsModule } from '@nestjs/cqrs';
import { GraphQLModule } from '@nestjs/graphql';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventBusModule, buildEventBusConfig } from '@platform/event-bus';
import { Request } from 'express';
import { GraphQLError, GraphQLFormattedError } from 'graphql';
import depthLimit from 'graphql-depth-limit';
import { fieldExtensionsEstimator, getComplexity, simpleEstimator } from 'graphql-query-complexity';

import { AquacultureModule } from './aquaculture/aquaculture.module';
import { SafetyTrainingRecord } from './aquaculture/entities/safety-training-record.entity';
import { GeoCoordinates, WorkArea } from './aquaculture/entities/work-area.entity';
import {
  CheckInHistoryEntry,
  CheckInLocation,
  TransportInfo,
  WorkRotation,
} from './aquaculture/entities/work-rotation.entity';
import { AttendanceModule } from './attendance/attendance.module';
import { AttendanceRecord } from './attendance/entities/attendance-record.entity';
import { ScheduleEntry } from './attendance/entities/schedule-entry.entity';
import { Schedule } from './attendance/entities/schedule.entity';
import { Shift } from './attendance/entities/shift.entity';
import { DailyAttendanceOverview } from './attendance/query-handlers/get-daily-attendance-overview.handler';
import { HealthModule } from './health/health.module';
import { DepartmentHR } from './hr/entities/department.entity';
import { Address, ContactInfo, Employee, NextOfKin } from './hr/entities/employee.entity';
import { HrOutbox } from './hr/entities/hr-outbox.entity';
import { PayrollAudit } from './hr/entities/payroll-audit.entity';
import { Payroll } from './hr/entities/payroll.entity';
import { HRModule } from './hr/hr.module';
import { HRDashboardStats } from './hr/query-handlers/get-hr-dashboard-stats.handler';
import { HrOutboxModule } from './hr-outbox.module';
import { LeaveBalance } from './leave/entities/leave-balance.entity';
import { LeaveRequest } from './leave/entities/leave-request.entity';
import { LeaveType } from './leave/entities/leave-type.entity';
import { LeaveModule } from './leave/leave.module';
import { HrMobileCommandReceipt } from './mobile-command/entities/hr-mobile-command-receipt.entity';
import { Goal, GoalMilestone, KeyResult } from './performance/entities/goal.entity';
import { EmployeeKPI } from './performance/entities/kpi.entity';
import {
  CompetencyRating,
  PerformanceReview,
} from './performance/entities/performance-review.entity';
import { PerformanceModule } from './performance/performance.module';
import {
  PerformanceSummary,
  ReviewSummaryItem,
} from './performance/query-handlers/get-performance-summary.handler';
import { Holiday } from './scheduling/entities/holiday.entity';
import { SchedulingSettings } from './scheduling/entities/scheduling-settings.entity';
import { WeeklyPlanEntry } from './scheduling/entities/weekly-plan-entry.entity';
import { WeeklyPlan } from './scheduling/entities/weekly-plan.entity';
import { SchedulingModule } from './scheduling/scheduling.module';
import { CertificationType } from './training/entities/certification-type.entity';
import { EmployeeCertification } from './training/entities/employee-certification.entity';
import { TrainingCourse } from './training/entities/training-course.entity';
import { TrainingEnrollment } from './training/entities/training-enrollment.entity';
import { TrainingModule } from './training/training.module';

/**
 * HrMigrationRunnerService — runs pending TypeORM migrations in the hr
 * source schema at OnApplicationBootstrap. Wired in P6-P8 of the
 * 2026-04-14 teardown plan, replacing the app.module.ts:300 gap
 * declaration ("hr-service has no TypeORM migration runner").
 *
 * First pending migration: 1786000400000-MoveEmployeesToHr (moves
 * public.employees → hr.employees). Existing three migration files
 * in src/database/migrations/ (CreateHRModuleSchema,
 * CreateSchedulingTables, HRMediumFixes) will also execute if not
 * already recorded in the migrations meta table — their idempotency
 * guards handle re-applications on DBs where legacy synchronize/bootstrap
 * paths previously applied overlapping DDL.
 */
const HrMigrationRunnerService = createSchemaVersionGate('hr');
const hrSchemaDdlOwnedByDbMigrate = isSchemaDdlOwnedByDbMigrate(process.env);
const TenantSchemaMiddleware = createTenantSchemaMiddleware('hr');
const TenantConnectionBootstrap = createTenantConnectionBootstrap('hr');

interface ApolloGraphQLContext {
  req: Request;
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    // Database connection — uses the platform TypeORM factory.
    // INTENTIONAL: no `schema:` — TenantSchemaMiddleware manages
    // search_path per request. INFRA-DB-SSL-001 fix: DB_SSL → DATABASE_SSL.
    // HrMigrationRunnerService (provider above) executes migrations at
    // OnApplicationBootstrap; factory's migrationsRun:false default keeps
    // TypeORM out of that codepath (search_path pinning + per-migration
    // transaction isolation belong in the runner, not in TypeORM bootstrap).
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        createServiceTypeOrmConfig(configService, {
          serviceName: 'hr',
          schema: 'hr',
          // Explicit entity list required for webpack bundle (glob patterns
          // don't work). Listing them here keeps autoLoad off so we never
          // auto-pull a stray entity file.
          entities: [
            Employee,
            Payroll,
            PayrollAudit,
            DepartmentHR,
            HrOutbox,
            LeaveType,
            LeaveBalance,
            LeaveRequest,
            Shift,
            Schedule,
            ScheduleEntry,
            AttendanceRecord,
            HrMobileCommandReceipt,
            CertificationType,
            EmployeeCertification,
            TrainingCourse,
            TrainingEnrollment,
            WorkArea,
            WorkRotation,
            SafetyTrainingRecord,
            SchedulingSettings,
            WeeklyPlan,
            WeeklyPlanEntry,
            Holiday,
            PerformanceReview,
            Goal,
            EmployeeKPI,
          ],
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
        path: join(process.cwd(), 'dist/graphql/subgraphs/hr.graphql'),
      },
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
      buildSchemaOptions: {
        orphanedTypes: [
          ContactInfo,
          Address,
          NextOfKin,
          // EmergencyInfo removed: the type contains medical PII (bloodType, medicalConditions,
          // allergies) and is @HideField() on Employee — it is never returned by any resolver.
          // Registering it as an orphanedType unnecessarily exposes field names in GraphQL
          // introspection, leaking PII schema structure to anyone with schema access.
          GeoCoordinates,
          TransportInfo,
          CheckInLocation,
          CheckInHistoryEntry,
          DailyAttendanceOverview,
          HRDashboardStats,
          CompetencyRating,
          KeyResult,
          GoalMilestone,
          PerformanceSummary,
          ReviewSummaryItem,
        ],
      },
      validationRules: [depthLimit(10)],
      plugins: [
        {
          requestDidStart: () =>
            Promise.resolve({
              didResolveOperation({
                request,
                document,
                schema,
              }: GraphQLRequestContextDidResolveOperation<ApolloGraphQLContext>): Promise<void> {
                const complexity = getComplexity({
                  schema,
                  operationName: request.operationName,
                  query: document,
                  variables: request.variables,
                  estimators: [
                    fieldExtensionsEstimator(),
                    simpleEstimator({ defaultComplexity: 1 }),
                  ],
                });
                const maxComplexity = 1000;
                if (complexity > maxComplexity) {
                  throw new GraphQLError(
                    `Query too complex: ${complexity}. Maximum allowed: ${maxComplexity}`,
                  );
                }
                return Promise.resolve();
              },
            }),
        },
      ],
      formatError: (formattedError: GraphQLFormattedError) => {
        if (process.env['NODE_ENV'] === 'production') {
          const extensions = { ...formattedError.extensions };
          if (extensions && extensions['exception']) {
            delete (extensions['exception'] as Record<string, unknown>).stacktrace;
          }
          return { ...formattedError, extensions };
        }
        return formattedError;
      },
      // 2026-04-30: Deprecated GraphQL Playground is not enabled at runtime.
      // WHY: HR subgraph developer UI must not rely on deprecated Apollo Playground behavior.
      introspection: process.env['NODE_ENV'] !== 'production',
      context: ({ req }: { req: Request }) => ({ req }),
    }),
    CqrsModule.forRoot(),
    // AUDITTRAIL-CRITICAL-002 sweep — registers AuditedOperationInterceptor.
    AuditedOperationModule.forRoot(),
    // Schedule module — single forRoot() for the entire service
    ScheduleModule.forRoot(),
    // NATS Event Bus for cross-service event publishing
    EventBusModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: buildEventBusConfig,
    }),
    // SECURITY (CRITICAL-001): RS256 asymmetric verification via the shared
    // PlatformJwtModule. hr-service is a token CONSUMER, not an issuer.
    // Replaced the per-service JwtModule.registerAsync block (WS2.B,
    // 2026-04-14) — single source of truth for all consumer services.
    PlatformJwtModule,
    HRModule,
    LeaveModule,
    AttendanceModule,
    TrainingModule,
    AquacultureModule,
    SchedulingModule,
    PerformanceModule,
    HealthModule,
    // OBS-HIGH-001: Prometheus GET /metrics scrape endpoint + HTTP metrics
    // middleware (self-contained platform module — controller is @Public()).
    ServiceMetricsModule,
    /**
     * HR-HIGH-015: Transactional outbox for at-least-once event delivery.
     * Replaces fire-and-forget EventBus.publish() with outbox pattern.
     * The OutboxWorkerService polls hr_outbox and publishes to NATS.
     */
    HrOutboxModule,
    TenantErasureTargetModule.forService('hr-service'),
    /** SEC-M22: Audit trail infrastructure for compliance tracking. */
    AuditLogModule.forRoot(),
    /**
     * NEW-H1: Convert TIMESTAMP audit columns to TIMESTAMPTZ at cold start.
     *
     * hr-service has no TypeORM migration runner — it currently delivers
     * schema concerns through OnApplicationBootstrap services
     * (SourceSchemaBootstrapService, TenantSchemaSyncService). The
     * AuditColumnsModule.forRoot() pattern mirrors RlsModule.forPoolService()
     * exactly: a single import line that registers the bootstrap with
     * DataSource injection. The bootstrap is idempotent at the discovery
     * layer, so cold restarts re-run safely.
     *
     * No excludeTables — every hr-service table should use TIMESTAMPTZ.
     */
    ...(hrSchemaDdlOwnedByDbMigrate ? [] : [AuditColumnsModule.forRoot({ serviceName: 'hr' })]),
    /** P11 of 2026-04-14 teardown — runtime schema-drift validator. */
    // Tenant execution context interceptor (SSoT registration) — keeps the
    // validated tenant schema in AsyncLocalStorage across Apollo/CQRS async
    // boundaries so per-tenant search_path routing holds at pg checkout.
    TenantExecutionContextModule,
    SchemaDriftModule.forRoot({ serviceName: 'hr' }),
  ],
  providers: [
    // Migration runner — see const declaration near top of file.
    HrMigrationRunnerService,
    // SECURITY: Service identity guard - validates HMAC-signed service identity headers
    // Must be FIRST guard (before tenant/roles) to verify request origin
    // WHY: useFactory bypasses reflect-metadata resolution which fails in Docker Alpine.
    {
      provide: APP_GUARD,
      useFactory: (configService: ConfigService): ServiceIdentityGuard =>
        new ServiceIdentityGuard(configService, undefined, 'hr-service'),
      inject: [ConfigService],
    },
    // SECURITY: Tenant guard - ensures tenant isolation
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
    // Bootstrap source schema tables on startup (creates template tables if missing)
    SourceSchemaBootstrapService,
    // Pool-level tenant schema routing (patches pg Pool.connect for search_path injection)
    TenantConnectionBootstrap,
    // Auto-sync tenant schemas with source schema (creates missing tables/columns)
    TenantSchemaSyncService,
    // DB-level write guards on source schema (defense-in-depth)
    SourceSchemaWriteGuardService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Middleware execution order:
    // 1. CorrelationIdMiddleware - Add correlation ID for request tracing
    // 2. UserContextMiddleware - Parse x-user-payload header from gateway (sets req.user)
    // 3. TenantContextMiddleware - Extract tenant from JWT/headers (uses req.user.tenantId)
    // 4. TenantSchemaMiddleware - Set PostgreSQL search_path to tenant schema
    consumer
      .apply(
        // SEC-CRITICAL-002 sweep — strip forged internal headers when the
        // request lacks a valid x-service-identity HMAC.
        StripInternalHeadersMiddleware,
        // SEC-HIGH-156: resolve req.user/req.tenantId from the gateway-signed
        // verified-user assertion (runs after Strip sets req.verifiedIdentity,
        // before UserContext/TenantContext).
        VerifiedUserAssertionMiddleware,
        CorrelationIdMiddleware,
        RequestContextMiddleware, // Populate AsyncLocalStorage for structured logging
        UserContextMiddleware,
        TenantContextMiddleware,
        TenantSchemaMiddleware,
      )
      .forRoutes('*');
  }
}
