import { Resolver, Query, Mutation, Args, ID, Context, Int, ObjectType } from '@nestjs/graphql';
import { UnauthorizedException, ForbiddenException, NotFoundException, UseGuards } from '@nestjs/common';
import { GqlAuthGuard } from '../common/guards/gql-auth.guard';
import { Roles, Role, StandardPaginatedResponse, IStandardPaginatedResult, fromCqrsPaginated } from '@platform/backend-common';
import { RolesGuard } from '../common/guards/roles.guard';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Employee } from '../hr/entities/employee.entity';
import { Shift, ShiftType } from './entities/shift.entity';
import { AttendanceRecord, AttendanceStatus, ApprovalStatus } from './entities/attendance-record.entity';
import { ClockInInput, ClockOutInput, ManualAttendanceInput } from './dto/clock-in-out.input';
import { CreateShiftInput, UpdateShiftInput } from './dto/create-shift.input';
import {
  ClockInCommand,
  ClockOutCommand,
  CreateShiftCommand,
  CreateManualAttendanceCommand,
  ApproveAttendanceCommand,
} from './commands';
import {
  GetShiftsQuery,
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

  /**
   * Resolve an auth userId to the HR Employee record.
   * This bridges the namespace gap between auth user UUIDs and HR employee UUIDs.
   */
  private async resolveEmployee(userId: string, tenantId: string): Promise<Employee> {
    const employee = await this.employeeRepository.findOne({
      where: { userId, tenantId, isDeleted: false },
    });
    if (!employee) {
      throw new NotFoundException('Employee record not found for current user');
    }
    return employee;
  }

  // =====================
  // Shift Queries
  // =====================
  @Query(() => ShiftConnection, { name: 'shifts' })
  async getShifts(
    @Context() context: GraphQLContext,
    @Args('isActive', { nullable: true }) isActive?: boolean,
    @Args('shiftType', { type: () => ShiftType, nullable: true }) shiftType?: ShiftType,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
  ): Promise<IStandardPaginatedResult<Shift>> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute(new GetShiftsQuery(tenantId, isActive, shiftType, limit, page));
    return fromCqrsPaginated(result);
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
  ): Promise<IStandardPaginatedResult<AttendanceRecord>> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute(
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
      ),
    );
    return fromCqrsPaginated(result);
  }

  @Query(() => [AttendanceRecord], { name: 'myAttendanceRecords' })
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
    const result = await this.queryBus.execute(
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
    return this.queryBus.execute(
      new GetAttendanceSummaryQuery(tenantId, employeeId, month, year),
    );
  }

  @Query(() => AttendanceSummary, { name: 'myAttendanceSummary' })
  async getMyAttendanceSummary(
    @Args('month', { type: () => Int }) month: number,
    @Args('year', { type: () => Int }) year: number,
    @Context() context: GraphQLContext,
  ): Promise<AttendanceSummary> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    // Resolve auth userId → HR employeeId for correct attendance lookup
    const employee = await this.resolveEmployee(userId, tenantId);
    return this.queryBus.execute(
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
  ): Promise<IStandardPaginatedResult<AttendanceRecord>> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    const result = await this.queryBus.execute(
      new GetPendingAttendanceApprovalsQuery(tenantId, userId, departmentId, limit, page),
    );
    return fromCqrsPaginated(result);
  }

  // =====================
  // Today's Attendance
  // =====================
  @Query(() => [AttendanceRecord], { name: 'todaysAttendance' })
  async getTodaysAttendance(
    @Context() context: GraphQLContext,
    @Args('employeeId', { type: () => ID, nullable: true }) employeeId?: string,
  ): Promise<AttendanceRecord[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetTodaysAttendanceQuery(tenantId, employeeId));
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
  ): Promise<DailyAttendanceOverview> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetDailyAttendanceOverviewQuery(tenantId, date));
  }

  // =====================
  // Shift Mutations
  // =====================
  @Mutation(() => Shift)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createShift(
    @Args('input') input: CreateShiftInput,
    @Context() context: GraphQLContext,
  ): Promise<Shift> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
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

  // =====================
  // Attendance Mutations
  // =====================
  @Mutation(() => AttendanceRecord)
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

    return this.commandBus.execute(
      new ClockInCommand(
        tenantId,
        userId,
        employee.id,
        input.method,
        input.location,
        input.remarks,
        input.workAreaId,
      ),
    );
  }

  @Mutation(() => AttendanceRecord)
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

    return this.commandBus.execute(
      new ClockOutCommand(
        tenantId,
        userId,
        employee.id,
        input.method,
        input.location,
        input.remarks,
        input.breakStartTime,
        input.breakEndTime,
      ),
    );
  }

  @Mutation(() => AttendanceRecord)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async createManualAttendance(
    @Args('input') input: ManualAttendanceInput,
    @Context() context: GraphQLContext,
  ): Promise<AttendanceRecord> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
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
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async approveAttendance(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
    @Args('notes', { nullable: true }) notes?: string,
  ): Promise<AttendanceRecord> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new ApproveAttendanceCommand(tenantId, userId, id, notes),
    );
  }
}
