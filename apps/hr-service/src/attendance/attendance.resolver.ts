import { Resolver, Query, Mutation, Args, ID, Context, Int, ObjectType, Field, Float } from '@nestjs/graphql';
import { UnauthorizedException, ForbiddenException, UseGuards } from '@nestjs/common';
import { GqlAuthGuard } from '../common/guards/gql-auth.guard';
import { Roles, Role } from '@platform/backend-common';
import { RolesGuard } from '../common/guards/roles.guard';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
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
import { PaginatedAttendanceRecords } from './query-handlers/get-attendance-records.handler';
import { AttendanceSummary } from './query-handlers/get-attendance-summary.handler';
import { PaginatedShifts } from './query-handlers/get-shifts.handler';
import { PaginatedPendingAttendanceApprovals } from './query-handlers/get-pending-attendance-approvals.handler';
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
class AttendanceRecordConnection {
  @Field(() => [AttendanceRecord])
  items!: AttendanceRecord[];

  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  limit!: number;

  @Field(() => Int)
  offset!: number;

  @Field()
  hasMore!: boolean;
}

@ObjectType()
class ShiftConnection {
  @Field(() => [Shift])
  items!: Shift[];

  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  limit!: number;

  @Field(() => Int)
  offset!: number;

  @Field()
  hasMore!: boolean;
}

@ObjectType()
class PendingAttendanceApprovalsConnection {
  @Field(() => [AttendanceRecord])
  items!: AttendanceRecord[];

  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  limit!: number;

  @Field(() => Int)
  offset!: number;

  @Field()
  hasMore!: boolean;
}

@UseGuards(GqlAuthGuard)
@Resolver(() => AttendanceRecord)
export class AttendanceResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
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

  // =====================
  // Shift Queries
  // =====================
  @Query(() => ShiftConnection, { name: 'shifts' })
  async getShifts(
    @Context() context: GraphQLContext,
    @Args('isActive', { nullable: true }) isActive?: boolean,
    @Args('shiftType', { type: () => ShiftType, nullable: true }) shiftType?: ShiftType,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 }) offset?: number,
  ): Promise<PaginatedShifts> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetShiftsQuery(tenantId, isActive, shiftType, limit, offset));
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
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 }) offset?: number,
  ): Promise<PaginatedAttendanceRecords> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetAttendanceRecordsQuery(
        tenantId,
        employeeId,
        departmentId,
        status,
        approvalStatus,
        startDate,
        endDate,
        limit,
        offset,
      ),
    );
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
    const result = await this.queryBus.execute(
      new GetAttendanceRecordsQuery(
        tenantId,
        userId,
        undefined,
        undefined,
        undefined,
        startDate,
        endDate,
        limit,
        0,
      ),
    );
    return result.items;
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
    return this.queryBus.execute(
      new GetAttendanceSummaryQuery(tenantId, userId, month, year),
    );
  }

  @Query(() => PendingAttendanceApprovalsConnection, { name: 'pendingAttendanceApprovals' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async getPendingAttendanceApprovals(
    @Context() context: GraphQLContext,
    @Args('departmentId', { type: () => ID, nullable: true }) departmentId?: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 }) offset?: number,
  ): Promise<PaginatedPendingAttendanceApprovals> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.queryBus.execute(
      new GetPendingAttendanceApprovalsQuery(tenantId, userId, departmentId, limit, offset),
    );
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

    // SECURITY: Users can only clock in for themselves unless they have elevated role
    // For self-service, employeeId should match userId or be omitted
    const employeeId = input.employeeId || userId;
    if (employeeId !== userId) {
      // Only managers can clock in others - this should be handled by a separate mutation
      throw new ForbiddenException('You can only clock in for yourself');
    }

    return this.commandBus.execute(
      new ClockInCommand(
        tenantId,
        userId,
        employeeId,
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

    // SECURITY: Users can only clock out for themselves unless they have elevated role
    // For self-service, employeeId should match userId or be omitted
    const employeeId = input.employeeId || userId;
    if (employeeId !== userId) {
      // Only managers can clock out others - this should be handled by a separate mutation
      throw new ForbiddenException('You can only clock out for yourself');
    }

    return this.commandBus.execute(
      new ClockOutCommand(
        tenantId,
        userId,
        employeeId,
        input.method,
        input.location,
        input.remarks,
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
