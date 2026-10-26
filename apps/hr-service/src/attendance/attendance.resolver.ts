import { Roles, Role, AuditLog, ModuleUserOrHigher } from '@aquaculture/backend-common/decorators';
import { mobileCommandEnvelopeFromInput } from '@aquaculture/backend-common/mobile-command';
import {
  StandardPaginatedResponse,
  IStandardPaginatedResult,
  fromCqrsPaginated,
} from '@aquaculture/backend-common/pagination';
import type { PaginatedQueryResult } from '@platform/cqrs';
import {
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Resolver, Query, Mutation, Args, ID, Context, Int, ObjectType } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { HrModuleCode } from '../common/enums';
import {
  findViewerEmployee,
  isTenantAdmin,
  isWorkforceManager,
  type ViewerClaims,
} from '../common/viewer';
import { GqlAuthGuard } from '../common/guards/gql-auth.guard';
import { RolesGuard } from '@aquaculture/backend-common/guards';
import { Employee } from '../hr/entities/employee.entity';

import {
  ClockInCommand,
  ClockOutCommand,
  CreateShiftCommand,
  UpdateShiftCommand,
  CreateManualAttendanceCommand,
  ApproveAttendanceCommand,
} from './commands';
import { ClockInInput, ClockOutInput, ManualAttendanceInput } from './dto/clock-in-out.input';
import { CreateShiftInput, UpdateShiftInput } from './dto/create-shift.input';
import { AttendanceRecord, AttendanceStatus, ApprovalStatus } from './entities/attendance-record.entity';
import { Shift, ShiftType } from './entities/shift.entity';
import {
  GetShiftsQuery,
  GetShiftQuery,
  GetAttendanceRecordsQuery,
  GetAttendanceSummaryQuery,
  GetPendingAttendanceApprovalsQuery,
  GetTodaysAttendanceQuery,
  GetDailyAttendanceOverviewQuery,
} from './queries';
import { AttendanceSummary } from './query-handlers/get-attendance-summary.handler';
import { DailyAttendanceOverview } from './query-handlers/get-daily-attendance-overview.handler';

// SECURITY: Context only exposes JWT-verified user fields.
// Do NOT add x-tenant-id or x-user-id headers here — those are attacker-controlled
// and must never be used directly (LOW-01).
interface GraphQLContext {
  req: {
    user?: {
      sub: string;
      tenantId: string;
      role?: string;
      roles?: string[];
    };
  };
}

@ObjectType()
class AttendanceRecordConnection extends StandardPaginatedResponse(AttendanceRecord) {}

@ObjectType()
class ShiftConnection extends StandardPaginatedResponse(Shift) {}

@ObjectType()
class PendingAttendanceApprovalsConnection extends StandardPaginatedResponse(AttendanceRecord) {}

@UseGuards(GqlAuthGuard)
@Resolver(() => AttendanceRecord)
export class AttendanceResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {}

  private getTenantId(context: GraphQLContext): string {
    // SECURITY: Only trust JWT-verified tenantId, never trust headers directly
    const tenantId = context.req.user?.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException('Tenant ID is required - authentication required');
    }
    return tenantId;
  }

  private getUserId(context: GraphQLContext): string {
    // SECURITY: Only trust JWT-verified userId, never trust headers directly
    const userId = context.req.user?.sub;
    if (!userId || typeof userId !== 'string') {
      throw new UnauthorizedException('User ID is required - authentication required');
    }
    return userId;
  }

  /** The caller's role claims, as the guards see them, for the in-resolver scope decisions. */
  private viewer(context: GraphQLContext): ViewerClaims {
    return {
      sub: this.getUserId(context),
      role: context.req.user?.role,
      roles: context.req.user?.roles,
    };
  }

  /**
   * The HR Employee record of an auth userId, or null: a tenant admin or owner need not have one.
   * This bridges the namespace gap between auth user UUIDs and HR employee UUIDs.
   */
  private findEmployee(userId: string, tenantId: string): Promise<Employee | null> {
    return this.employeeRepository.findOne({ where: { userId, tenantId, isDeleted: false } });
  }

  /** The caller's own HR Employee record; a request that is about the caller needs one. */
  private async resolveEmployee(userId: string, tenantId: string): Promise<Employee> {
    const employee = await this.findEmployee(userId, tenantId);
    if (!employee) {
      throw new NotFoundException('Employee record not found for current user');
    }
    return employee;
  }

  // =====================
  // Shift Queries
  // =====================
  @Query(() => ShiftConnection, { name: 'shifts' })
  @UseGuards(RolesGuard)
  @ModuleUserOrHigher()
  async getShifts(
    @Context() context: GraphQLContext,
    @Args('isActive', { nullable: true }) isActive?: boolean,
    @Args('shiftType', { type: () => ShiftType, nullable: true }) shiftType?: ShiftType,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
  ): Promise<IStandardPaginatedResult<Shift>> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute<GetShiftsQuery, PaginatedQueryResult<Shift>>(
      new GetShiftsQuery(tenantId, isActive, shiftType, limit, page),
    );
    return fromCqrsPaginated(result);
  }

  @Query(() => Shift, { name: 'shift' })
  @UseGuards(RolesGuard)
  @ModuleUserOrHigher()
  async getShift(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<Shift> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute<GetShiftQuery, Shift>(new GetShiftQuery(tenantId, id));
  }

  // =====================
  // Attendance Queries
  // =====================
  @Query(() => AttendanceRecordConnection, { name: 'attendanceRecords' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async getAttendanceRecords(
    @Context() context: GraphQLContext,
    @Args('employeeId', { type: () => ID, nullable: true }) employeeId?: string,
    @Args('departmentId', { type: () => ID, nullable: true }) departmentId?: string,
    @Args('status', { type: () => AttendanceStatus, nullable: true }) status?: AttendanceStatus,
    @Args('approvalStatus', { type: () => ApprovalStatus, nullable: true }) approvalStatus?: ApprovalStatus,
    @Args('startDate', { nullable: true }) startDate?: string,
    @Args('endDate', { nullable: true }) endDate?: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
    @Args('moduleCode', { type: () => HrModuleCode, nullable: true }) moduleCode?: HrModuleCode,
  ): Promise<IStandardPaginatedResult<AttendanceRecord>> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute<
      GetAttendanceRecordsQuery,
      PaginatedQueryResult<AttendanceRecord>
    >(
      new GetAttendanceRecordsQuery(
        tenantId,
        employeeId,
        departmentId,
        status,
        approvalStatus,
        startDate,
        endDate,
        limit,
        page,
        moduleCode,
      ),
    );
    return fromCqrsPaginated(result);
  }

  @Query(() => [AttendanceRecord], { name: 'myAttendanceRecords' })
  @UseGuards(RolesGuard)
  @ModuleUserOrHigher()
  async getMyAttendanceRecords(
    @Context() context: GraphQLContext,
    @Args('startDate', { nullable: true }) startDate?: string,
    @Args('endDate', { nullable: true }) endDate?: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 30 }) limit?: number,
  ): Promise<AttendanceRecord[]> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    // Resolve auth userId → HR employeeId for correct attendance lookup
    const employee = await this.resolveEmployee(userId, tenantId);
    const result = await this.queryBus.execute<
      GetAttendanceRecordsQuery,
      PaginatedQueryResult<AttendanceRecord>
    >(
      new GetAttendanceRecordsQuery(
        tenantId,
        employee.id,
        undefined,
        undefined,
        undefined,
        startDate,
        endDate,
        limit,
        1,
      ),
    );
    return result.data;
  }

  @Query(() => AttendanceSummary, { name: 'attendanceSummary' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async getAttendanceSummary(
    @Args('employeeId', { type: () => ID }) employeeId: string,
    @Args('month', { type: () => Int }) month: number,
    @Args('year', { type: () => Int }) year: number,
    @Context() context: GraphQLContext,
  ): Promise<AttendanceSummary> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute<GetAttendanceSummaryQuery, AttendanceSummary>(
      new GetAttendanceSummaryQuery(tenantId, employeeId, month, year),
    );
  }

  @Query(() => AttendanceSummary, { name: 'myAttendanceSummary' })
  @UseGuards(RolesGuard)
  @ModuleUserOrHigher()
  async getMyAttendanceSummary(
    @Args('month', { type: () => Int }) month: number,
    @Args('year', { type: () => Int }) year: number,
    @Context() context: GraphQLContext,
  ): Promise<AttendanceSummary> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    // Resolve auth userId → HR employeeId for correct attendance lookup
    const employee = await this.resolveEmployee(userId, tenantId);
    return this.queryBus.execute<GetAttendanceSummaryQuery, AttendanceSummary>(
      new GetAttendanceSummaryQuery(tenantId, employee.id, month, year),
    );
  }

  @Query(() => PendingAttendanceApprovalsConnection, { name: 'pendingAttendanceApprovals' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async getPendingAttendanceApprovals(
    @Context() context: GraphQLContext,
    @Args('departmentId', { type: () => ID, nullable: true }) departmentId?: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
    @Args('moduleCode', { type: () => HrModuleCode, nullable: true }) moduleCode?: HrModuleCode,
  ): Promise<IStandardPaginatedResult<AttendanceRecord>> {
    const tenantId = this.getTenantId(context);
    // The queue works on the approver's EMPLOYEE id (their own records are excluded, their department
    // is looked up by it), not the auth userId. A tenant admin or owner may have no employee record
    // and is not locked out: the queue then has nothing of theirs to exclude or narrow by.
    const viewer = this.viewer(context);
    const approver = await findViewerEmployee(this.employeeRepository.manager, tenantId, viewer);
    const result = await this.queryBus.execute<
      GetPendingAttendanceApprovalsQuery,
      PaginatedQueryResult<AttendanceRecord>
    >(
      new GetPendingAttendanceApprovalsQuery(
        tenantId,
        approver?.id ?? null,
        departmentId,
        limit,
        page,
        moduleCode,
        // A tenant admin approves across departments; only a manager is narrowed to their own.
        !isTenantAdmin(viewer),
      ),
    );
    return fromCqrsPaginated(result);
  }

  // =====================
  // Today's Attendance
  // =====================
  @Query(() => [AttendanceRecord], { name: 'todaysAttendance' })
  @UseGuards(RolesGuard)
  @ModuleUserOrHigher()
  async getTodaysAttendance(
    @Context() context: GraphQLContext,
    @Args('employeeId', { type: () => ID, nullable: true }) employeeId?: string,
    @Args('moduleCode', { type: () => HrModuleCode, nullable: true }) moduleCode?: HrModuleCode,
  ): Promise<AttendanceRecord[]> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);

    // A manager asking for the team needs no employee record of their own (the tenant owner often
    // has none); only a request about the caller does.
    if (isWorkforceManager(this.viewer(context))) {
      return this.queryBus.execute<GetTodaysAttendanceQuery, AttendanceRecord[]>(
        new GetTodaysAttendanceQuery(tenantId, employeeId, moduleCode),
      );
    }

    const employee = await this.resolveEmployee(userId, tenantId);
    if (employeeId && employeeId !== employee.id) {
      throw new ForbiddenException('You can only view your own attendance');
    }
    return this.queryBus.execute<GetTodaysAttendanceQuery, AttendanceRecord[]>(
      new GetTodaysAttendanceQuery(tenantId, employee.id, moduleCode),
    );
  }

  @Query(() => [AttendanceRecord], { name: 'myTodaysAttendance' })
  @UseGuards(RolesGuard)
  @ModuleUserOrHigher()
  async getMyTodaysAttendance(
    @Context() context: GraphQLContext,
  ): Promise<AttendanceRecord[]> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    const employee = await this.resolveEmployee(userId, tenantId);
    return this.queryBus.execute<GetTodaysAttendanceQuery, AttendanceRecord[]>(
      new GetTodaysAttendanceQuery(tenantId, employee.id),
    );
  }

  // =====================
  // Daily Attendance Overview
  // =====================
  @Query(() => DailyAttendanceOverview, { name: 'dailyAttendanceOverview' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async getDailyAttendanceOverview(
    @Context() context: GraphQLContext,
    @Args('date', { nullable: true }) date?: string,
    @Args('moduleCode', { type: () => HrModuleCode, nullable: true }) moduleCode?: HrModuleCode,
  ): Promise<DailyAttendanceOverview> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute<GetDailyAttendanceOverviewQuery, DailyAttendanceOverview>(
      new GetDailyAttendanceOverviewQuery(tenantId, date, moduleCode),
    );
  }

  // =====================
  // Shift Mutations
  // =====================
  @Mutation(() => Shift)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'CREATE_SHIFT', resource: 'Shift', description: 'Create a new work shift' })
  async createShift(
    @Args('input') input: CreateShiftInput,
    @Context() context: GraphQLContext,
  ): Promise<Shift> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute<CreateShiftCommand, Shift>(
      new CreateShiftCommand(
        tenantId,
        userId,
        input.code,
        input.name,
        input.startTime,
        input.endTime,
        input.shiftType,
        input.description,
        input.totalMinutes,
        input.breakMinutes,
        input.breakPeriods,
        input.workDays,
        input.crossesMidnight,
        input.graceMinutes,
        input.earlyClockInMinutes,
        input.lateClockOutMinutes,
        input.colorCode,
        input.displayOrder,
      ),
    );
  }

  @Mutation(() => Shift)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'UPDATE_SHIFT', resource: 'Shift', description: 'Update an existing work shift' })
  async updateShift(
    @Args('input') input: UpdateShiftInput,
    @Context() context: GraphQLContext,
  ): Promise<Shift> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute<UpdateShiftCommand, Shift>(
      new UpdateShiftCommand(
        tenantId,
        userId,
        input.id,
        input.name,
        input.description,
        input.shiftType,
        input.startTime,
        input.endTime,
        input.totalMinutes,
        input.breakMinutes,
        input.breakPeriods,
        input.workDays,
        input.crossesMidnight,
        input.graceMinutes,
        input.isActive,
        input.colorCode,
        input.displayOrder,
      ),
    );
  }

  // =====================
  // Attendance Mutations
  // =====================
  @Mutation(() => AttendanceRecord)
  @UseGuards(RolesGuard)
  @ModuleUserOrHigher()
  @AuditLog({ action: 'CLOCK_IN', resource: 'AttendanceRecord', description: 'Employee clock-in' })
  async clockIn(
    @Args('input') input: ClockInInput,
    @Context() context: GraphQLContext,
  ): Promise<AttendanceRecord> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);

    // SECURITY: Resolve the auth userId to HR employeeId to bridge namespace gap.
    // Users can only clock in for themselves — if input.employeeId is provided,
    // verify it matches the resolved employee.
    const employee = await this.resolveEmployee(userId, tenantId);
    if (input.employeeId && input.employeeId !== employee.id) {
      throw new ForbiddenException('You can only clock in for yourself');
    }

    return this.commandBus.execute<ClockInCommand, AttendanceRecord>(
      new ClockInCommand(
        tenantId,
        userId,
        employee.id,
        input.method,
        input.location,
        input.remarks,
        input.workAreaId,
        undefined,
        mobileCommandEnvelopeFromInput(input),
      ),
    );
  }

  @Mutation(() => AttendanceRecord)
  @UseGuards(RolesGuard)
  @ModuleUserOrHigher()
  @AuditLog({ action: 'CLOCK_OUT', resource: 'AttendanceRecord', description: 'Employee clock-out' })
  async clockOut(
    @Args('input') input: ClockOutInput,
    @Context() context: GraphQLContext,
  ): Promise<AttendanceRecord> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);

    // SECURITY: Resolve the auth userId to HR employeeId to bridge namespace gap.
    const employee = await this.resolveEmployee(userId, tenantId);
    if (input.employeeId && input.employeeId !== employee.id) {
      throw new ForbiddenException('You can only clock out for yourself');
    }

    return this.commandBus.execute<ClockOutCommand, AttendanceRecord>(
      new ClockOutCommand(
        tenantId,
        userId,
        employee.id,
        input.method,
        input.location,
        input.remarks,
        input.breakStartTime,
        input.breakEndTime,
        mobileCommandEnvelopeFromInput(input),
      ),
    );
  }

  @Mutation(() => AttendanceRecord)
  @UseGuards(RolesGuard)
  // MODULE_USER removed: manual attendance creation is an administrative override action
  // (correcting missed clock-ins). BEFORE: regular employees could create attendance
  // records for any colleague, enabling time record falsification.
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'CREATE_MANUAL_ATTENDANCE', resource: 'AttendanceRecord', description: 'Create manual attendance record (admin override)' })
  async createManualAttendance(
    @Args('input') input: ManualAttendanceInput,
    @Context() context: GraphQLContext,
  ): Promise<AttendanceRecord> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute<CreateManualAttendanceCommand, AttendanceRecord>(
      new CreateManualAttendanceCommand(
        tenantId,
        userId,
        input.employeeId,
        input.date,
        input.clockIn,
        input.clockOut,
        input.reason,
        input.shiftId,
      ),
    );
  }

  @Mutation(() => AttendanceRecord)
  @UseGuards(RolesGuard)
  // MODULE_USER removed: attendance approval requires supervisory authority.
  // BEFORE: regular employees could approve their own attendance corrections.
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'APPROVE_ATTENDANCE', resource: 'AttendanceRecord', description: 'Approve an attendance record' })
  async approveAttendance(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
    @Args('notes', { nullable: true }) notes?: string,
  ): Promise<AttendanceRecord> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute<ApproveAttendanceCommand, AttendanceRecord>(
      new ApproveAttendanceCommand(tenantId, userId, id, notes),
    );
  }
}
