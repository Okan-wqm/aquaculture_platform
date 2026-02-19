---
name: hr-service
description: Knowledge base for hr-service - CQRS-based HR management with leave, attendance, training, payroll, aquaculture-specific features (offshore/onshore, work rotations, safety training)
---

# HR Service Knowledge Base

## Overview
The hr-service manages human resources for aquaculture operations. It covers employee records, payroll, leave management, attendance tracking, training/certification, and aquaculture-specific HR features (offshore/onshore classification, work rotations, sea-worthiness tracking, work areas). All features follow CQRS pattern with NestJS CQRS module. Exposes GraphQL Federation v2 subgraph on port 3005.

## Directory Structure
```
apps/hr-service/src/
  app.module.ts              # Root - TypeORM (explicit entities), GraphQL Fed v2, CQRS, JWT
  main.ts
  middleware/
    tenant-schema.middleware.ts   # Sets search_path: "tenant_xxx", hr, public
  filters/
    global-exception.filter.ts
  common/
    enums.ts                 # WorkAreaType enum (shared)
    enums/role.enum.ts
    decorators/roles.decorator.ts
    guards/
      gql-auth.guard.ts
      roles.guard.ts

  hr/                        # Core employee management
    hr.module.ts
    entities/
      employee.entity.ts     # Core employee with aquaculture-specific fields
      payroll.entity.ts      # Payroll records
    commands/
      create-employee.command.ts
      update-employee.command.ts
      create-payroll.command.ts
      approve-payroll.command.ts
    queries/
      get-employee.query.ts
      get-employees.query.ts
      get-payrolls.query.ts
    query-handlers/
      get-employee.handler.ts
      get-employees.handler.ts
      get-payrolls.handler.ts
    handlers/
      create-payroll.handler.ts
    dto/
      update-employee.input.ts
      employee-filter.input.ts

  leave/                     # Leave request management
    leave.module.ts
    entities/
      leave-type.entity.ts   # Annual, Sick, Offshore Relief, etc.
      leave-balance.entity.ts  # Per-employee balance per leave type
      leave-request.entity.ts  # Leave requests with approval workflow
    commands/
      create-leave-request.command.ts
      submit-leave-request.command.ts
      approve-leave-request.command.ts
      reject-leave-request.command.ts
      cancel-leave-request.command.ts
    queries/
      get-leave-types.query.ts
      get-leave-balances.query.ts
      get-leave-requests.query.ts
      get-leave-request-by-id.query.ts
      get-pending-approvals.query.ts
      get-team-leave-calendar.query.ts
    query-handlers/
      get-leave-types.handler.ts
      get-leave-requests.handler.ts
      get-leave-request-by-id.handler.ts
      get-leave-balances.handler.ts
      get-pending-approvals.handler.ts
      get-team-leave-calendar.handler.ts
    handlers/
      create-leave-request.handler.ts
    events/
      leave.events.ts
    __tests__/
      leave.integration.spec.ts

  attendance/                # Attendance and shift management
    attendance.module.ts
    entities/
      shift.entity.ts        # Shift definitions (Day, Night, Offshore)
      schedule.entity.ts     # Employee schedules
      schedule-entry.entity.ts  # Individual scheduled shifts
      attendance-record.entity.ts  # Clock-in/out records
    commands/
      clock-in.command.ts
      clock-out.command.ts
      create-shift.command.ts
      create-manual-attendance.command.ts
      approve-attendance.command.ts
    queries/
      get-attendance-records.query.ts
      get-attendance-summary.query.ts
      get-shifts.query.ts
      get-pending-attendance-approvals.query.ts
    query-handlers/
      get-attendance-records.handler.ts
      get-attendance-summary.handler.ts
      get-shifts.handler.ts
      get-pending-attendance-approvals.handler.ts
    handlers/
      create-manual-attendance.handler.ts
    events/
      attendance.events.ts

  training/                  # Training and certification management
    training.module.ts
    entities/
      certification-type.entity.ts  # Types of certifications (STCW, HUET, etc.)
      employee-certification.entity.ts  # Employee's certifications with expiry
      training-course.entity.ts    # Training courses available
      training-enrollment.entity.ts  # Employee enrollments in courses
    commands/
      add-employee-certification.command.ts
      verify-certification.command.ts
      revoke-certification.command.ts
      enroll-in-training.command.ts
      complete-training.command.ts
    queries/
      get-certification-types.query.ts
      get-employee-certifications.query.ts
      get-expiring-certifications.query.ts
    query-handlers/
      get-certification-types.handler.ts
      get-expiring-certifications.handler.ts
    handlers/
      add-employee-certification.handler.ts
      enroll-in-training.handler.ts
    events/
      training.events.ts
    __tests__/
      training.integration.spec.ts

  aquaculture/               # Aquaculture-specific HR features
    aquaculture.module.ts
    entities/
      work-area.entity.ts    # Geographic work areas (cage sites, processing areas)
      work-rotation.entity.ts  # Offshore rotation schedules (2-on/2-off, etc.)
      safety-training-record.entity.ts  # Offshore safety training records
    queries/
      get-work-areas.query.ts
      get-work-rotations.query.ts
      get-currently-offshore.query.ts
    query-handlers/
      get-work-areas.handler.ts
      get-work-rotations.handler.ts
      get-currently-offshore.handler.ts

  scheduling/                # Weekly planning and holiday management
    scheduling.module.ts
    entities/
      scheduling-settings.entity.ts  # Work week settings per tenant
      weekly-plan.entity.ts         # Weekly staffing plans
      weekly-plan-entry.entity.ts   # Individual employee entries in weekly plan
      holiday.entity.ts             # Public holidays per region

  health/
    health.module.ts
  database/
    migrations/
      1736000000000-CreateHRModuleSchema.ts
```

## Modules & Features

### HRModule (Core)
- Employee CRUD with rich profile (contact info, address, bank details as JSONB)
- Sensitive fields hidden in GraphQL (`@HideField()`): dateOfBirth, nationalId, baseSalary, bankDetails
- Payroll creation and approval workflow
- Aquaculture-specific fields: `personnelCategory` (OFFSHORE/ONSHORE/HYBRID), `seaWorthy`, `assignedWorkAreas`, `currentRotationId`
- IANA timezone per employee for attendance calculations

### LeaveModule
- Leave types: Annual, Sick, Offshore Relief, Emergency (seeded as reference data)
- Leave balance tracking per employee per type
- Approval workflow: DRAFT -> SUBMITTED -> APPROVED/REJECTED -> CANCELLED
- Team leave calendar query for scheduling coordination
- Pending approvals queue for managers
- Emits leave events (NATS)

### AttendanceModule
- Shift definitions (Day Shift, Night Shift, Offshore Shift, etc.)
- Schedule management for planned attendance
- Clock-in/clock-out recording with geolocation support
- Manual attendance entry for managers
- Approval workflow for manual entries
- Attendance summary aggregation
- Emits attendance events (NATS)

### TrainingModule
- Certification types (STCW, HUET, Offshore Safety, etc. - aquaculture-specific)
- Employee certifications with expiry dates
- `GetExpiringCertificationsHandler`: proactive alerts for certifications expiring soon
- Training course catalog
- Enrollment and completion tracking
- Certification verification and revocation

### AquacultureModule
- `WorkArea`: geographic areas (cage site, processing area, feed storage)
  - `GeoCoordinates` as orphaned nested type
- `WorkRotation`: offshore rotation patterns (2 weeks on/2 off, etc.)
  - `TransportInfo`, `CheckInLocation`, `CheckInHistoryEntry` as orphaned nested types
- `SafetyTrainingRecord`: offshore safety training records
- `GetCurrentlyOffshoreHandler`: real-time tracking of who is currently offshore
- Supports MARPOL/STCW compliance tracking for offshore workers

### SchedulingModule
- Weekly staffing plans with per-employee schedule entries
- Scheduling settings (work week structure, overtime rules)
- Holiday calendar management

## Key Entities

### Employee (see employee.entity.ts for full details)
Key fields:
- `employeeNumber` (unique within tenant), `email`, `firstName`, `lastName`
- `status`: ACTIVE | ON_LEAVE | TERMINATED | SUSPENDED
- `employmentType`: FULL_TIME | PART_TIME | CONTRACT | SEASONAL
- `department`: OPERATIONS | MAINTENANCE | FEEDING | QUALITY_CONTROL | etc.
- `personnelCategory`: OFFSHORE | ONSHORE | HYBRID (aquaculture-specific)
- `seaWorthy`: boolean (certified for offshore work)
- `assignedWorkAreas`: WorkAreaType[] (simple-array column)
- `farmId`: links to farm-service farm
- `supervisorId`, `userId` (links to auth-service user)
- `contactInfo`, `address`, `emergencyInfo` as JSONB
- `bankDetails`, `dateOfBirth`, `nationalId` as HideField (sensitive)
- `timezone`: IANA timezone string

### Payroll
- `employeeId`, `tenantId`, `period` (month/year)
- `baseSalary`, `overtimePay`, `allowances`, `deductions`, `netPay`
- `status`: DRAFT | SUBMITTED | APPROVED | PAID
- `currency`, `paymentDate`

### LeaveRequest
- `employeeId`, `leaveTypeId`, `tenantId`
- `startDate`, `endDate`, `numberOfDays`
- `status`: DRAFT | SUBMITTED | APPROVED | REJECTED | CANCELLED
- `reason`, `approvedBy`, `approvedAt`, `rejectionReason`

### AttendanceRecord
- `employeeId`, `shiftId`, `date`
- `clockInTime`, `clockOutTime`, `hoursWorked`
- `status`: PENDING | APPROVED | REJECTED
- `clockInLocation`, `clockOutLocation` (JSONB GPS coordinates)

### EmployeeCertification
- `employeeId`, `certificationTypeId`, `issueDate`, `expiryDate`
- `status`: VALID | EXPIRED | REVOKED
- `issuingAuthority`, `certificateNumber`

## API / GraphQL (hr subgraph)
### Key Queries
- `employees`, `employee(id)`, `employeeFilter`
- `payrolls`, `pendingPayrolls`
- `leaveTypes`, `leaveBalances`, `leaveRequests`, `pendingLeaveApprovals`, `teamLeaveCalendar`
- `shifts`, `schedules`, `attendanceRecords`, `attendanceSummary`, `pendingAttendanceApprovals`
- `certificationTypes`, `employeeCertifications`, `expiringCertifications`
- `workAreas`, `workRotations`, `currentlyOffshore`
- `weeklyPlans`, `holidays`

### Key Mutations
- `createEmployee`, `updateEmployee`, `terminateEmployee`
- `createPayroll`, `approvePayroll`
- `createLeaveRequest`, `submitLeaveRequest`, `approveLeaveRequest`, `rejectLeaveRequest`
- `clockIn`, `clockOut`, `createManualAttendance`, `approveAttendance`
- `addEmployeeCertification`, `verifyCertification`, `revokeCertification`
- `enrollInTraining`, `completeTraining`
- `createWorkArea`, `createWorkRotation`
- `createWeeklyPlan`, `addHoliday`

## Patterns Used
- **CQRS** via `@nestjs/cqrs` (CqrsModule.forRoot())
- **Apollo Federation v2** subgraph
- **TenantSchemaMiddleware**: `search_path = "tenant_xxx", hr, public`
- **RolesGuard** globally applied (per @Roles() decorator)
- **Sensitive field hiding**: `@HideField()` for PII/financial data
- **JSONB for complex objects**: contactInfo, address, bankDetails, emergencyInfo stored as JSONB
- **Orphaned types**: nested ObjectTypes registered in buildSchemaOptions.orphanedTypes

## Inter-Service Communication
Publishes NATS events:
- `EmployeeCreated`, `EmployeeUpdated`, `EmployeeTerminated`
- `LeaveApproved`, `LeaveRejected`
- `AttendanceRecorded`
- `CertificationExpiringSoon`

Links to other services:
- `employee.farmId` -> farm-service farm ID
- `employee.userId` -> auth-service user ID
- `employee.supervisorId` -> another employee in hr-service

## Key Dependencies
- `@nestjs/cqrs` - CQRS bus
- `@platform/backend-common` - RolesGuard, TenantGuard, middleware
- TypeORM with explicit entity list (required for webpack)

## Known Gotchas
- **Aquaculture-specific HR** - this service has domain concepts specific to offshore aquaculture (STCW, HUET certifications, offshore rotations, sea-worthiness). Don't treat it as generic HR.
- **Sensitive field visibility** - `dateOfBirth`, `nationalId`, `baseSalary`, `bankDetails` are `@HideField()` - they never appear in GraphQL responses. Use carefully.
- **Orphaned types** - `ContactInfo`, `Address`, `BankDetails`, `NextOfKin`, `EmergencyInfo`, `GeoCoordinates`, `TransportInfo`, `CheckInLocation`, `CheckInHistoryEntry` must be in `buildSchemaOptions.orphanedTypes` in app.module.ts
- **leave_types reference data** - leave types (Annual, Sick, etc.) are seeded as reference data by admin-api-service during tenant provisioning via `REFERENCE_DATA_TABLES` in schema-manager
- **Explicit entity list** - app.module.ts uses explicit entity array (not autoLoadEntities) for webpack compatibility
- **Timezone per employee** - attendance calculations must use `employee.timezone` (IANA format, default 'UTC')

## Related Services
- farm-service: employees linked to farms via farmId
- auth-service: employees linked to users via userId
- admin-api-service: provisions hr module tables and seeds leave types during tenant creation
