import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
} from '@nestjs/apollo';
import { CqrsModule } from '@nestjs/cqrs';
import {
  TenantContextMiddleware,
  CorrelationIdMiddleware,
  UserContextMiddleware,
} from '@platform/backend-common';
import { TenantSchemaMiddleware } from './middleware/tenant-schema.middleware';
import { HRModule } from './hr/hr.module';
import { HealthModule } from './health/health.module';
import { LeaveModule } from './leave/leave.module';
import { AttendanceModule } from './attendance/attendance.module';
import { TrainingModule } from './training/training.module';
import { AquacultureModule } from './aquaculture/aquaculture.module';

// Explicit entity imports (required for webpack bundle - glob patterns don't work)
// Core HR entities
import { Employee } from './hr/entities/employee.entity';
import { Payroll } from './hr/entities/payroll.entity';
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
        ],
        synchronize: configService.get('NODE_ENV') !== 'production',
        logging: configService.get('NODE_ENV') === 'development',
        // SECURITY: SSL configuration with proper certificate validation
        ssl: (() => {
          const sslEnabled = configService.get('DB_SSL') === 'true';
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
      playground: process.env['NODE_ENV'] !== 'production',
      introspection: process.env['NODE_ENV'] !== 'production',
      context: ({ req }: { req: Request }) => ({ req }),
    }),
    CqrsModule.forRoot(),
    HRModule,
    LeaveModule,
    AttendanceModule,
    TrainingModule,
    AquacultureModule,
    HealthModule,
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
        UserContextMiddleware,
        TenantContextMiddleware,
        TenantSchemaMiddleware,
      )
      .forRoutes('*');
  }
}
