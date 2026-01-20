import { Resolver, Query, Mutation, Args, ID, Context, Int, ObjectType, Field } from '@nestjs/graphql';
import { UnauthorizedException } from '@nestjs/common';
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
} from './queries';
import { PaginatedAttendanceRecords } from './query-handlers/get-attendance-records.handler';
import { AttendanceSummary } from './query-handlers/get-attendance-summary.handler';

interface GraphQLContext {
  req: {
    headers: {
      'x-tenant-id'?: string;
      'x-user-id'?: string;
    };
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

@Resolver(() => AttendanceRecord)
export class AttendanceResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  private getTenantId(context: GraphQLContext): string {
    const tenantId =
      context.req.user?.tenantId ||
      context.req.headers['x-tenant-id'];
    if (!tenantId) {
      throw new UnauthorizedException('Tenant ID is required');
    }
    return tenantId;
  }

  private getUserId(context: GraphQLContext): string {
    const userId =
      context.req.user?.sub ||
      context.req.headers['x-user-id'] ||
      'system';
    return userId;
  }

  // =====================
  // Shift Queries
  // =====================
  @Query(() => [Shift], { name: 'shifts' })
  async getShifts(
    @Context() context: GraphQLContext,
    @Args('isActive', { nullable: true }) isActive?: boolean,
    @Args('shiftType', { type: () => ShiftType, nullable: true }) shiftType?: ShiftType,
  ): Promise<Shift[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetShiftsQuery(tenantId, isActive, shiftType));
  }

  // =====================
  // Attendance Queries
  // =====================
  @Query(() => AttendanceRecordConnection, { name: 'attendanceRecords' })
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

  @Query(() => [AttendanceRecord], { name: 'pendingAttendanceApprovals' })
  async getPendingAttendanceApprovals(
    @Context() context: GraphQLContext,
    @Args('departmentId', { type: () => ID, nullable: true }) departmentId?: string,
  ): Promise<AttendanceRecord[]> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.queryBus.execute(
      new GetPendingAttendanceApprovalsQuery(tenantId, userId, departmentId),
    );
  }

  // =====================
  // Shift Mutations
  // =====================
  @Mutation(() => Shift)
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
    return this.commandBus.execute(
      new ClockInCommand(
        tenantId,
        userId,
        input.employeeId,
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
    return this.commandBus.execute(
      new ClockOutCommand(
        tenantId,
        userId,
        input.employeeId,
        input.method,
        input.location,
        input.remarks,
      ),
    );
  }

  @Mutation(() => AttendanceRecord)
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
