# HR Service

Multi-tenant Human Resources management microservice built with NestJS, GraphQL Federation, and TypeORM.

## Features

- **Employee Management**: Employee profiles, contact info, bank details, next of kin
- **Attendance Tracking**: Clock in/out, shifts, schedules, manual attendance
- **Leave Management**: Leave types, balances, requests, approvals
- **Training & Certifications**: Courses, enrollments, certifications, expiry tracking
- **Aquaculture-specific**: Work areas, rotations, offshore/onshore classification

## Architecture

```
src/
├── common/           # Shared utilities, guards, decorators
│   ├── guards/       # Authentication guards (GqlAuthGuard, RolesGuard)
│   ├── decorators/   # Custom decorators (Roles)
│   └── enums/        # Shared enums (Role)
├── database/         # Database module, migrations
├── middleware/       # Tenant schema middleware
├── filters/          # Global exception filter
├── hr/               # Core HR (employees, payroll)
│   ├── entities/     # Employee, Payroll
│   ├── dto/          # Input types
│   ├── commands/     # CQRS commands
│   ├── handlers/     # Command handlers
│   ├── queries/      # CQRS queries
│   └── query-handlers/
├── attendance/       # Time & attendance
│   ├── entities/     # Shift, Schedule, AttendanceRecord
│   ├── dto/          # Input types
│   ├── commands/     # Clock in/out commands
│   ├── handlers/     # Command handlers
│   └── query-handlers/
├── leave/            # Leave management
│   ├── entities/     # LeaveType, LeaveBalance, LeaveRequest
│   ├── dto/          # Input types
│   ├── commands/     # Leave request commands
│   ├── handlers/     # Command handlers
│   └── query-handlers/
├── training/         # Training & certifications
│   ├── entities/     # TrainingCourse, Certification, Enrollment
│   ├── commands/     # Training commands
│   ├── handlers/     # Command handlers
│   └── query-handlers/
├── aquaculture/      # Aquaculture-specific features
│   ├── entities/     # WorkArea, WorkRotation, SafetyTrainingRecord
│   └── query-handlers/
└── health/           # Health checks
```

## Security

### Authentication & Authorization

All GraphQL resolvers are protected with `@UseGuards(GqlAuthGuard)`:

```typescript
@UseGuards(GqlAuthGuard)
@Resolver(() => Employee)
export class HRResolver { }
```

Role-based access control is enforced with `@Roles()` decorator:

```typescript
@Roles(Role.ADMIN, Role.HR_MANAGER)
@Mutation(() => Employee)
async createEmployee() { }
```

### Roles

| Role | Permissions |
|------|-------------|
| `ADMIN` | Full access to all operations |
| `HR_MANAGER` | Employee CRUD, payroll, leave approval |
| `MANAGER` | Team attendance/leave approval |
| `EMPLOYEE` | Self-service operations |

### Multi-Tenancy

- Each tenant has isolated PostgreSQL schema (`hr` schema per tenant)
- Schema routing via `TenantSchemaMiddleware`
- LRU cache for schema validation (1000 entries, 5-min TTL)

## CQRS Pattern

The service uses Command Query Responsibility Segregation:

### Commands (Write Operations)
- `CreateEmployeeCommand`, `UpdateEmployeeCommand`
- `ClockInCommand`, `ClockOutCommand`
- `SubmitLeaveRequestCommand`, `ApproveLeaveRequestCommand`
- `EnrollInTrainingCommand`, `CompleteTrainingCommand`

### Queries (Read Operations)
- `GetEmployeeQuery`, `GetEmployeesQuery`
- `GetAttendanceRecordsQuery`, `GetAttendanceSummaryQuery`
- `GetLeaveRequestsQuery`, `GetLeaveBalancesQuery`
- `GetTrainingEnrollmentsQuery`, `GetExpiringCertificationsQuery`

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `DATABASE_PASSWORD` | Database password (production) | Production |
| `JWT_SECRET` | JWT signing secret | Yes |
| `CORS_ORIGINS` | Allowed CORS origins | Production |
| `NODE_ENV` | Environment (development/production) | Yes |

## Event-Driven Architecture

The service publishes domain events via CQRS EventBus:

### Published Events
- `EmployeeClockedInEvent` - Employee clocked in
- `EmployeeClockedOutEvent` - Employee clocked out
- `LeaveRequestSubmittedEvent` - Leave request submitted
- `LeaveApprovedEvent` - Leave request approved
- `LeaveRejectedEvent` - Leave request rejected
- `TrainingCompletedEvent` - Training completed
- `CertificationAddedEvent` - Certification added
- `CertificationRevokedEvent` - Certification revoked

## Database

### Entities (16 total)

**HR Module:**
- `Employee` - Core employee data with embedded types
- `Payroll` - Payroll records with earnings/deductions

**Attendance Module:**
- `Shift` - Work shift definitions
- `Schedule` - Employee schedules
- `ScheduleEntry` - Individual schedule entries
- `AttendanceRecord` - Clock in/out records

**Leave Module:**
- `LeaveType` - Leave type definitions
- `LeaveBalance` - Employee leave balances
- `LeaveRequest` - Leave requests with approval workflow

**Training Module:**
- `CertificationType` - Certification type definitions
- `EmployeeCertification` - Employee certifications
- `TrainingCourse` - Training course definitions
- `TrainingEnrollment` - Course enrollments

**Aquaculture Module:**
- `WorkArea` - Work area with geo-coordinates
- `WorkRotation` - Employee rotations
- `SafetyTrainingRecord` - Safety training records

### Multi-Schema Architecture

```
PostgreSQL
├── public          # Shared tables (tenants, users)
└── hr              # HR-specific tables per tenant
```

## Development

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- pnpm

### Setup

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm run start:dev hr-service

# Run tests
pnpm run test hr-service

# Build for production
pnpm run build hr-service
```

### GraphQL Playground

Available at `http://localhost:3002/graphql` in development mode.

## Testing

```bash
# Unit tests
pnpm run test hr-service

# Integration tests (leave, training modules)
pnpm run test:e2e hr-service

# Coverage report
pnpm run test:cov hr-service
```

### Test Coverage

| Module | Coverage | Notes |
|--------|----------|-------|
| Leave | ~20% | Integration tests |
| Training | ~20% | Integration tests |
| HR | 0% | Needs tests |
| Attendance | 0% | Needs tests |
| Aquaculture | 0% | Needs tests |

## API Documentation

GraphQL Federation schema. Key operations:

### Employees
- `employees(filter: EmployeeFilterInput)` - List employees
- `employee(id: ID!)` - Get single employee
- `createEmployee(input: CreateEmployeeInput!)` - Create employee
- `updateEmployee(input: UpdateEmployeeInput!)` - Update employee
- `terminateEmployee(id: ID!)` - Terminate employee

### Attendance
- `attendanceRecords(filter)` - List attendance records
- `clockIn(input: ClockInInput!)` - Clock in
- `clockOut(input: ClockOutInput!)` - Clock out
- `approveAttendance(id: ID!)` - Approve attendance

### Leave
- `leaveRequests(filter)` - List leave requests
- `submitLeaveRequest(input)` - Submit request
- `approveLeaveRequest(id: ID!)` - Approve request
- `rejectLeaveRequest(id: ID!)` - Reject request

### Training
- `trainingEnrollments(filter)` - List enrollments
- `enrollInTraining(input)` - Enroll in course
- `completeTraining(id: ID!)` - Complete training
- `employeeCertifications(employeeId)` - Get certifications

## Performance Optimizations

### Transaction Management
Critical operations use QueryRunner for ACID compliance:

```typescript
const queryRunner = this.dataSource.createQueryRunner();
await queryRunner.connect();
await queryRunner.startTransaction();
try {
  // operations
  await queryRunner.commitTransaction();
} catch (error) {
  await queryRunner.rollbackTransaction();
  throw error;
} finally {
  await queryRunner.release();
}
```

### Schema Caching
LRU cache for tenant schema validation:
- Max 1000 entries
- 5-minute TTL
- Prevents repeated schema lookups

## Changelog

### Recent Audit & Improvements (January 2026)

#### Security Hardening
- Added `GqlAuthGuard` to all 5 resolver classes
- Added `RolesGuard` with `@Roles()` decorator for RBAC
- Fixed dangerous 'system' user fallback - now throws `UnauthorizedException`
- Created Role enum (ADMIN, HR_MANAGER, MANAGER, EMPLOYEE)

#### Error Handling
- Fixed 2 unsafe `(error as Error)` type assertions
- Fixed 2 silent error swallowing in middleware
- Added `.catch()` handlers to 9 fire-and-forget event publish calls

#### Reliability
- Added transaction management to 4 handlers:
  - `ClockInHandler`
  - `ClockOutHandler`
  - `ApproveLeaveRequestHandler`
  - `CreatePayrollHandler`

#### Code Quality
- Removed unnecessary `forwardRef` in AquacultureModule

### Audit Status

| Category | Status | Notes |
|----------|--------|-------|
| Authentication | ✅ Pass | GqlAuthGuard on all resolvers |
| Authorization | ✅ Pass | @Roles on sensitive mutations |
| User Validation | ✅ Pass | No 'system' fallback |
| Error Handling | ✅ Pass | Proper type guards |
| Transaction Management | ✅ Pass | Critical handlers covered |
| Module Structure | ✅ Pass | No circular deps |
| DTO Validation | ✅ Pass | class-validator decorators |
| Test Coverage | ⚠️ ~8% | Needs improvement |

### Known Limitations

- Test coverage at ~8% (only leave and training have tests)
- Some pagination inconsistencies between modules
- Enum casing not fully standardized

## Contributing

1. Follow NestJS best practices
2. Add `@UseGuards(GqlAuthGuard)` to all resolvers
3. Use `@Roles()` for sensitive mutations
4. Add validation decorators to DTOs
5. Write unit tests for handlers
6. Use transactions for multi-step operations

## License

Proprietary - All rights reserved
