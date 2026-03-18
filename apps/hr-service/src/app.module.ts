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
import { GraphQLError, GraphQLFormattedError } from 'graphql';
import depthLimit from 'graphql-depth-limit';
import { fieldExtensionsEstimator, getComplexity, simpleEstimator } from 'graphql-query-complexity';
import {
  TenantContextMiddleware,
  CorrelationIdMiddleware,
  RequestContextMiddleware,
  UserContextMiddleware,
  TenantGuard,
  RolesGuard,
  SourceSchemaBootstrapService,
} from '@platform/backend-common';
import { TenantSchemaMiddleware } from './middleware/tenant-schema.middleware';
import { TenantConnectionBootstrap } from './infrastructure/tenant-connection-bootstrap.service';
import { HRModule } from './hr/hr.module';
import { HealthModule } from './health/health.module';
import { LeaveModule } from './leave/leave.module';
import { AttendanceModule } from './attendance/attendance.module';
import { TrainingModule } from './training/training.module';
import { AquacultureModule } from './aquaculture/aquaculture.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { PerformanceModule } from './performance/performance.module';

// Explicit entity imports (required for webpack bundle - glob patterns don't work)
// Core HR entities
import { Employee } from './hr/entities/employee.entity';
import { Payroll } from './hr/entities/payroll.entity';
import { DepartmentHR } from './hr/entities/department.entity';
// Leave entities
import { LeaveType } from './leave/entities/leave-type.entity';
import { LeaveBalance } from './leave/entities/leave-balance.entity';
import { LeaveRequest } from './leave/entities/leave-request.entity';
// Attendance entities
import { Shift } from './attendance/entities/shift.entity';
import { Schedule } from './attendance/entities/schedule.entity';
import { ScheduleEntry } from './attendance/entities/schedule-entry.entity';
import { AttendanceRecord } from './attendance/entities/attendance-record.entity';
// Training entities
import { CertificationType } from './training/entities/certification-type.entity';
import { EmployeeCertification } from './training/entities/employee-certification.entity';
import { TrainingCourse } from './training/entities/training-course.entity';
import { TrainingEnrollment } from './training/entities/training-enrollment.entity';
// Aquaculture entities
import { WorkArea } from './aquaculture/entities/work-area.entity';
import { WorkRotation } from './aquaculture/entities/work-rotation.entity';
import { SafetyTrainingRecord } from './aquaculture/entities/safety-training-record.entity';
// Scheduling entities
import { SchedulingSettings } from './scheduling/entities/scheduling-settings.entity';
import { WeeklyPlan } from './scheduling/entities/weekly-plan.entity';
import { WeeklyPlanEntry } from './scheduling/entities/weekly-plan-entry.entity';
import { Holiday } from './scheduling/entities/holiday.entity';
// Performance entities
import { PerformanceReview } from './performance/entities/performance-review.entity';
import { Goal } from './performance/entities/goal.entity';
import { EmployeeKPI } from './performance/entities/kpi.entity';

// Nested ObjectTypes for orphanedTypes registration
import { ContactInfo, Address, NextOfKin, EmergencyInfo } from './hr/entities/employee.entity';
import { GeoCoordinates } from './aquaculture/entities/work-area.entity';
import { TransportInfo, CheckInLocation, CheckInHistoryEntry } from './aquaculture/entities/work-rotation.entity';
import { DailyAttendanceOverview } from './attendance/query-handlers/get-daily-attendance-overview.handler';
import { HRDashboardStats } from './hr/query-handlers/get-hr-dashboard-stats.handler';
import { CompetencyRating } from './performance/entities/performance-review.entity';
import { KeyResult, GoalMilestone } from './performance/entities/goal.entity';
import { PerformanceSummary, ReviewSummaryItem } from './performance/query-handlers/get-performance-summary.handler';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    // Database connection - NO explicit schema!
    // Schema isolation is handled by TenantSchemaMiddleware via PostgreSQL search_path
    // search_path is set to: "tenant_xxx", hr, public
    // This ensures queries use tenant schema first, falling back to hr for shared data
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
        database: configService.get('DATABASE_NAME', 'aquaculture'),
        // NOTE: Do NOT set 'schema' here! Schema is managed dynamically by TenantSchemaMiddleware
        // Explicit entity list required for webpack bundle (glob patterns don't work)
        entities: [
          // Core HR
          Employee,
          Payroll,
          DepartmentHR,
          // Leave
          LeaveType,
          LeaveBalance,
          LeaveRequest,
          // Attendance
          Shift,
          Schedule,
          ScheduleEntry,
          AttendanceRecord,
          // Training
          CertificationType,
          EmployeeCertification,
          TrainingCourse,
          TrainingEnrollment,
          // Aquaculture
          WorkArea,
          WorkRotation,
          SafetyTrainingRecord,
          // Scheduling
          SchedulingSettings,
          WeeklyPlan,
          WeeklyPlanEntry,
          Holiday,
          // Performance
          PerformanceReview,
          Goal,
          EmployeeKPI,
        ],
        synchronize: configService.get('DATABASE_SYNC', 'false') === 'true',
        logging: configService.get('NODE_ENV') === 'development',
        // SECURITY: SSL configuration with proper certificate validation
        ssl: (() => {
          const sslEnabled = configService.get('DB_SSL') === 'true';
          if (!sslEnabled) return false;

          const isProduction = configService.get('NODE_ENV') === 'production';
          const caPath = configService.get<string>('DATABASE_SSL_CA');
          const rejectUnauthorized = configService.get('DATABASE_SSL_REJECT_UNAUTHORIZED', 'true') !== 'false';

          if (isProduction && !rejectUnauthorized && !caPath) {
            // SECURITY: Hard-fail in production if SSL certificate verification is disabled (LOW-02)
            throw new Error('SECURITY: DATABASE_SSL_REJECT_UNAUTHORIZED must be enabled in production');
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
          // Default search_path targets the source schema so TypeORM sync/migrations
          // create tables there. TenantSchemaMiddleware overrides per-request.
          options: '-c search_path=hr,public',
        },
      };
      },
    }),
    GraphQLModule.forRoot<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      autoSchemaFile: {
        federation: 2,
      },
      buildSchemaOptions: {
        orphanedTypes: [
          ContactInfo,
          Address,
          NextOfKin,
          EmergencyInfo,
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
      playground: process.env['NODE_ENV'] !== 'production',
      introspection: process.env['NODE_ENV'] !== 'production',
      context: ({ req }: { req: Request }) => ({ req }),
    }),
    CqrsModule.forRoot(),
    // JWT Module for auth guards (global for all feature modules)
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: configService.get('JWT_EXPIRES_IN', '1d') },
      }),
    }),
    HRModule,
    LeaveModule,
    AttendanceModule,
    TrainingModule,
    AquacultureModule,
    SchedulingModule,
    PerformanceModule,
    HealthModule,
  ],
  providers: [
    // SECURITY: Tenant guard - ensures tenant isolation
    {
      provide: APP_GUARD,
      useClass: TenantGuard,
    },
    // SECURITY: Roles guard - enforces @Roles() decorator authorization
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    // Bootstrap source schema tables on startup (creates template tables if missing)
    SourceSchemaBootstrapService,
    // Pool-level tenant schema routing (patches pg Pool.connect for search_path injection)
    TenantConnectionBootstrap,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Middleware execution order:
    // 1. CorrelationIdMiddleware - Add correlation ID for request tracing
    // 2. UserContextMiddleware - Parse x-user-payload header from gateway (sets req.user)
    // 3. TenantContextMiddleware - Extract tenant from JWT/headers (uses req.user.tenantId)
    // 4. TenantSchemaMiddleware - Set PostgreSQL search_path to tenant schema
    consumer
      .apply(
        CorrelationIdMiddleware,
        RequestContextMiddleware, // Populate AsyncLocalStorage for structured logging
        UserContextMiddleware,
        TenantContextMiddleware,
        TenantSchemaMiddleware,
      )
      .forRoutes('*');
  }
}
