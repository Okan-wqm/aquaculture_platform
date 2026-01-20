import { Resolver, Query, Mutation, Args, ID, Context, Int, ObjectType, Field } from '@nestjs/graphql';
import { UnauthorizedException } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { LeaveType, LeaveCategory } from './entities/leave-type.entity';
import { LeaveBalance } from './entities/leave-balance.entity';
import { LeaveRequest, LeaveRequestStatus } from './entities/leave-request.entity';
import { CreateLeaveRequestInput, UpdateLeaveRequestInput } from './dto/create-leave-request.input';
import {
  CreateLeaveRequestCommand,
  SubmitLeaveRequestCommand,
  ApproveLeaveRequestCommand,
  RejectLeaveRequestCommand,
  CancelLeaveRequestCommand,
} from './commands';
import {
  GetLeaveTypesQuery,
  GetLeaveBalancesQuery,
  GetLeaveRequestsQuery,
  GetLeaveRequestByIdQuery,
  GetPendingApprovalsQuery,
  GetTeamLeaveCalendarQuery,
} from './queries';
import { PaginatedLeaveRequests } from './query-handlers/get-leave-requests.handler';
import { LeaveCalendarEntry } from './query-handlers/get-team-leave-calendar.handler';

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
class LeaveRequestConnection {
  @Field(() => [LeaveRequest])
  items!: LeaveRequest[];

  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  limit!: number;

  @Field(() => Int)
  offset!: number;

  @Field()
  hasMore!: boolean;
}

@Resolver(() => LeaveRequest)
export class LeaveResolver {
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
  // Leave Type Queries
  // =====================
  @Query(() => [LeaveType], { name: 'leaveTypes' })
  async getLeaveTypes(
    @Context() context: GraphQLContext,
    @Args('isActive', { nullable: true }) isActive?: boolean,
    @Args('category', { type: () => LeaveCategory, nullable: true }) category?: LeaveCategory,
  ): Promise<LeaveType[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetLeaveTypesQuery(tenantId, isActive, category));
  }

  // =====================
  // Leave Balance Queries
  // =====================
  @Query(() => [LeaveBalance], { name: 'leaveBalances' })
  async getLeaveBalances(
    @Args('employeeId', { type: () => ID }) employeeId: string,
    @Context() context: GraphQLContext,
    @Args('year', { type: () => Int, nullable: true }) year?: number,
    @Args('leaveTypeId', { type: () => ID, nullable: true }) leaveTypeId?: string,
  ): Promise<LeaveBalance[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetLeaveBalancesQuery(tenantId, employeeId, year, leaveTypeId),
    );
  }

  @Query(() => [LeaveBalance], { name: 'myLeaveBalances' })
  async getMyLeaveBalances(
    @Context() context: GraphQLContext,
    @Args('year', { type: () => Int, nullable: true }) year?: number,
  ): Promise<LeaveBalance[]> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.queryBus.execute(
      new GetLeaveBalancesQuery(tenantId, userId, year),
    );
  }

  // =====================
  // Leave Request Queries
  // =====================
  @Query(() => LeaveRequest, { name: 'leaveRequest' })
  async getLeaveRequest(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<LeaveRequest> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetLeaveRequestByIdQuery(tenantId, id));
  }

  @Query(() => LeaveRequestConnection, { name: 'leaveRequests' })
  async getLeaveRequests(
    @Context() context: GraphQLContext,
    @Args('employeeId', { type: () => ID, nullable: true }) employeeId?: string,
    @Args('status', { type: () => LeaveRequestStatus, nullable: true }) status?: LeaveRequestStatus,
    @Args('leaveTypeId', { type: () => ID, nullable: true }) leaveTypeId?: string,
    @Args('startDate', { nullable: true }) startDate?: string,
    @Args('endDate', { nullable: true }) endDate?: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 }) offset?: number,
  ): Promise<PaginatedLeaveRequests> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetLeaveRequestsQuery(
        tenantId,
        employeeId,
        status,
        leaveTypeId,
        startDate,
        endDate,
        limit,
        offset,
      ),
    );
  }

  @Query(() => [LeaveRequest], { name: 'myLeaveRequests' })
  async getMyLeaveRequests(
    @Context() context: GraphQLContext,
    @Args('status', { type: () => LeaveRequestStatus, nullable: true }) status?: LeaveRequestStatus,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 }) offset?: number,
  ): Promise<LeaveRequest[]> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    const result = await this.queryBus.execute(
      new GetLeaveRequestsQuery(
        tenantId,
        userId,
        status,
        undefined,
        undefined,
        undefined,
        limit,
        offset,
      ),
    );
    return result.items;
  }

  @Query(() => [LeaveRequest], { name: 'pendingLeaveApprovals' })
  async getPendingLeaveApprovals(
    @Context() context: GraphQLContext,
    @Args('departmentId', { type: () => ID, nullable: true }) departmentId?: string,
  ): Promise<LeaveRequest[]> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.queryBus.execute(
      new GetPendingApprovalsQuery(tenantId, userId, departmentId),
    );
  }

  @Query(() => [LeaveCalendarEntry], { name: 'teamLeaveCalendar' })
  async getTeamLeaveCalendar(
    @Context() context: GraphQLContext,
    @Args('startDate') startDate: string,
    @Args('endDate') endDate: string,
    @Args('departmentId', { type: () => ID, nullable: true }) departmentId?: string,
  ): Promise<LeaveCalendarEntry[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetTeamLeaveCalendarQuery(tenantId, departmentId, startDate, endDate),
    );
  }

  // =====================
  // Leave Request Mutations
  // =====================
  @Mutation(() => LeaveRequest)
  async createLeaveRequest(
    @Args('input') input: CreateLeaveRequestInput,
    @Context() context: GraphQLContext,
  ): Promise<LeaveRequest> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new CreateLeaveRequestCommand(
        tenantId,
        userId,
        input.employeeId,
        input.leaveTypeId,
        input.startDate,
        input.endDate,
        input.totalDays,
        input.isHalfDayStart,
        input.isHalfDayEnd,
        input.halfDayPeriod,
        input.reason,
        input.contactDuringLeave,
      ),
    );
  }

  @Mutation(() => LeaveRequest)
  async submitLeaveRequest(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<LeaveRequest> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new SubmitLeaveRequestCommand(tenantId, userId, id),
    );
  }

  @Mutation(() => LeaveRequest)
  async approveLeaveRequest(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
    @Args('notes', { nullable: true }) notes?: string,
  ): Promise<LeaveRequest> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new ApproveLeaveRequestCommand(tenantId, userId, id, notes),
    );
  }

  @Mutation(() => LeaveRequest)
  async rejectLeaveRequest(
    @Args('id', { type: () => ID }) id: string,
    @Args('reason') reason: string,
    @Context() context: GraphQLContext,
  ): Promise<LeaveRequest> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new RejectLeaveRequestCommand(tenantId, userId, id, reason),
    );
  }

  @Mutation(() => LeaveRequest)
  async cancelLeaveRequest(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
    @Args('reason', { nullable: true }) reason?: string,
  ): Promise<LeaveRequest> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new CancelLeaveRequestCommand(tenantId, userId, id, reason),
    );
  }
}
