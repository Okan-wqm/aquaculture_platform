import { Roles, Role, ModuleUserOrHigher, AuditLog, RequiresMobileFeature } from '@aquaculture/backend-common/decorators';
import { MobileFeatureGuard } from '@aquaculture/backend-common/guards';
import { mobileCommandEnvelopeFromInput } from '@aquaculture/backend-common/mobile-command';
import { StandardPaginatedResponse, IStandardPaginatedResult, fromCqrsPaginated } from '@aquaculture/backend-common/pagination';
import { UnauthorizedException, ForbiddenException, NotFoundException, UseGuards } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Resolver, Query, Mutation, Args, ID, Context, Int, ObjectType } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { GqlAuthGuard } from '../common/guards/gql-auth.guard';
import { RolesGuard } from '@aquaculture/backend-common/guards';
import { Employee } from '../hr/entities/employee.entity';

import {
  CreateLeaveRequestCommand,
  SubmitLeaveRequestCommand,
  ApproveLeaveRequestCommand,
  RejectLeaveRequestCommand,
  CancelLeaveRequestCommand,
} from './commands';
import { CreateLeaveRequestInput } from './dto/create-leave-request.input';
import { LeaveBalance } from './entities/leave-balance.entity';
import { LeaveRequest, LeaveRequestStatus } from './entities/leave-request.entity';
import { LeaveType, LeaveCategory } from './entities/leave-type.entity';
import {
  GetLeaveTypesQuery,
  GetLeaveBalancesQuery,
  GetLeaveRequestsQuery,
  GetLeaveRequestByIdQuery,
  GetPendingApprovalsQuery,
  GetTeamLeaveCalendarQuery,
} from './queries';
import { LeaveCalendarEntry } from './query-handlers/get-team-leave-calendar.handler';

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

interface CqrsPaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

@ObjectType()
class LeaveRequestConnection extends StandardPaginatedResponse(LeaveRequest) {}

@ObjectType()
class PendingLeaveApprovalsConnection extends StandardPaginatedResponse(LeaveRequest) {}

@UseGuards(GqlAuthGuard)
@Resolver(() => LeaveRequest)
export class LeaveResolver {
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
   * Resolve auth userId (JWT sub) to HR employeeId.
   * The userId is the auth-service UUID, while employeeId is the HR-service UUID.
   * These are different: Employee.userId links the two.
   */
  private async resolveEmployeeId(userId: string, tenantId: string): Promise<string> {
    const employee = await this.employeeRepository.findOne({
      where: { userId, tenantId, isDeleted: false },
      select: ['id'],
    });
    if (!employee) {
      throw new NotFoundException(
        'Employee record not found for current user. Please contact your administrator.',
      );
    }
    return employee.id;
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
    return this.queryBus.execute<GetLeaveTypesQuery, LeaveType[]>(
      new GetLeaveTypesQuery(tenantId, isActive, category),
    );
  }

  // =====================
  // Leave Balance Queries
  // =====================
  @Query(() => [LeaveBalance], { name: 'leaveBalances' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async getLeaveBalances(
    @Args('employeeId', { type: () => ID }) employeeId: string,
    @Context() context: GraphQLContext,
    @Args('year', { type: () => Int, nullable: true }) year?: number,
    @Args('leaveTypeId', { type: () => ID, nullable: true }) leaveTypeId?: string,
  ): Promise<LeaveBalance[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute<GetLeaveBalancesQuery, LeaveBalance[]>(
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
    const employeeId = await this.resolveEmployeeId(userId, tenantId);
    return this.queryBus.execute<GetLeaveBalancesQuery, LeaveBalance[]>(
      new GetLeaveBalancesQuery(tenantId, employeeId, year),
    );
  }

  // =====================
  // Leave Request Queries
  // =====================
  @Query(() => LeaveRequest, { name: 'leaveRequest' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async getLeaveRequest(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<LeaveRequest> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute<GetLeaveRequestByIdQuery, LeaveRequest>(
      new GetLeaveRequestByIdQuery(tenantId, id),
    );
  }

  @Query(() => LeaveRequestConnection, { name: 'leaveRequests' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async getLeaveRequests(
    @Context() context: GraphQLContext,
    @Args('employeeId', { type: () => ID, nullable: true }) employeeId?: string,
    @Args('status', { type: () => LeaveRequestStatus, nullable: true }) status?: LeaveRequestStatus,
    @Args('leaveTypeId', { type: () => ID, nullable: true }) leaveTypeId?: string,
    @Args('startDate', { nullable: true }) startDate?: string,
    @Args('endDate', { nullable: true }) endDate?: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
  ): Promise<IStandardPaginatedResult<LeaveRequest>> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute<
      GetLeaveRequestsQuery,
      CqrsPaginatedResult<LeaveRequest>
    >(
      new GetLeaveRequestsQuery(
        tenantId,
        employeeId,
        status,
        leaveTypeId,
        startDate,
        endDate,
        limit,
        page,
      ),
    );
    return fromCqrsPaginated(result);
  }

  @Query(() => [LeaveRequest], { name: 'myLeaveRequests' })
  async getMyLeaveRequests(
    @Context() context: GraphQLContext,
    @Args('status', { type: () => LeaveRequestStatus, nullable: true }) status?: LeaveRequestStatus,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
  ): Promise<LeaveRequest[]> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    const employeeId = await this.resolveEmployeeId(userId, tenantId);
    const result = await this.queryBus.execute<
      GetLeaveRequestsQuery,
      CqrsPaginatedResult<LeaveRequest>
    >(
      new GetLeaveRequestsQuery(
        tenantId,
        employeeId,
        status,
        undefined,
        undefined,
        undefined,
        limit,
        page,
      ),
    );
    return result.data;
  }

  @Query(() => PendingLeaveApprovalsConnection, { name: 'pendingLeaveApprovals' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async getPendingLeaveApprovals(
    @Context() context: GraphQLContext,
    @Args('departmentId', { type: () => ID, nullable: true }) departmentId?: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
  ): Promise<IStandardPaginatedResult<LeaveRequest>> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    // Admin users may not have an employee record — resolve optionally
    const employee = await this.employeeRepository.findOne({
      where: { userId, tenantId, isDeleted: false },
      select: ['id'],
    });
    const employeeId = employee?.id ?? null;
    const result = await this.queryBus.execute<
      GetPendingApprovalsQuery,
      CqrsPaginatedResult<LeaveRequest>
    >(
      new GetPendingApprovalsQuery(tenantId, employeeId, departmentId, limit, page),
    );
    return fromCqrsPaginated(result);
  }

  @Query(() => [LeaveCalendarEntry], { name: 'teamLeaveCalendar' })
  async getTeamLeaveCalendar(
    @Context() context: GraphQLContext,
    @Args('startDate') startDate: string,
    @Args('endDate') endDate: string,
    @Args('departmentId', { type: () => ID, nullable: true }) departmentId?: string,
  ): Promise<LeaveCalendarEntry[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute<GetTeamLeaveCalendarQuery, LeaveCalendarEntry[]>(
      new GetTeamLeaveCalendarQuery(tenantId, departmentId, startDate, endDate),
    );
  }

  // =====================
  // Leave Request Mutations
  // =====================
  @Mutation(() => LeaveRequest)
  @AuditLog({ action: 'CREATE_LEAVE_REQUEST', resource: 'LeaveRequest', description: 'Create a new leave request' })
  async createLeaveRequest(
    @Args('input') input: CreateLeaveRequestInput,
    @Context() context: GraphQLContext,
  ): Promise<LeaveRequest> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    const myEmployeeId = await this.resolveEmployeeId(userId, tenantId);

    // SECURITY: Users can only create leave requests for themselves unless they have elevated role
    // For self-service, employeeId should match the caller's employee record or be omitted
    const employeeId = input.employeeId || myEmployeeId;
    if (employeeId !== myEmployeeId) {
      // Only managers can create leave requests for others - this should be handled by a separate mutation
      throw new ForbiddenException('You can only create leave requests for yourself');
    }

    return this.commandBus.execute<CreateLeaveRequestCommand, LeaveRequest>(
      new CreateLeaveRequestCommand(
        tenantId,
        userId,
        employeeId,
        input.leaveTypeId,
        input.startDate,
        input.endDate,
        input.totalDays,
        input.isHalfDayStart,
        input.isHalfDayEnd,
        input.halfDayPeriod,
        input.reason,
        input.contactDuringLeave,
        mobileCommandEnvelopeFromInput(input),
      ),
    );
  }

  // SEC-MEDIUM-051: explicit, reflectable minimum-role contract on the
  // self-service submit path (matches createLeaveRequest). The OWNERSHIP check
  // (caller is creator OR owner of the request) is enforced transactionally in
  // SubmitLeaveRequestHandler — NOT duplicated here. This @Roles gate is the
  // defense-in-depth coarse layer beneath that ownership assertion.
  @Mutation(() => LeaveRequest)
  // SEC-HIGH-052: MobileFeatureGuard enforces the 'leave' mobile entitlement
  // server-side (hr-service rebuilds req.user from the same assertion chain, so
  // mobileFeatures is present). It NEVER relaxes the @ModuleUserOrHigher role floor.
  @UseGuards(RolesGuard, MobileFeatureGuard)
  @ModuleUserOrHigher()
  @RequiresMobileFeature('leave')
  @AuditLog({ action: 'SUBMIT_LEAVE_REQUEST', resource: 'LeaveRequest', description: 'Submit a leave request for approval' })
  async submitLeaveRequest(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<LeaveRequest> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute<SubmitLeaveRequestCommand, LeaveRequest>(
      new SubmitLeaveRequestCommand(tenantId, userId, id),
    );
  }

  @Mutation(() => LeaveRequest)
  @UseGuards(RolesGuard)
  // MODULE_USER removed: leave approval is a supervisory action requiring MODULE_MANAGER.
  // BEFORE: regular employees could approve any colleague's leave request.
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'APPROVE_LEAVE_REQUEST', resource: 'LeaveRequest', description: 'Approve a leave request' })
  async approveLeaveRequest(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
    @Args('notes', { nullable: true }) notes?: string,
  ): Promise<LeaveRequest> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute<ApproveLeaveRequestCommand, LeaveRequest>(
      new ApproveLeaveRequestCommand(tenantId, userId, id, notes),
    );
  }

  @Mutation(() => LeaveRequest)
  @UseGuards(RolesGuard)
  // MODULE_USER removed: leave rejection is a supervisory action requiring MODULE_MANAGER.
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @AuditLog({ action: 'REJECT_LEAVE_REQUEST', resource: 'LeaveRequest', description: 'Reject a leave request' })
  async rejectLeaveRequest(
    @Args('id', { type: () => ID }) id: string,
    @Args('reason') reason: string,
    @Context() context: GraphQLContext,
  ): Promise<LeaveRequest> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute<RejectLeaveRequestCommand, LeaveRequest>(
      new RejectLeaveRequestCommand(tenantId, userId, id, reason),
    );
  }

  // SEC-MEDIUM-051: explicit, reflectable minimum-role contract on the
  // self-service cancel path. Ownership (creator OR owner) is enforced in
  // CancelLeaveRequestHandler — this @Roles gate is the coarse layer beneath it.
  @Mutation(() => LeaveRequest)
  // SEC-HIGH-052: 'leave' mobile entitlement enforced beneath the role floor.
  @UseGuards(RolesGuard, MobileFeatureGuard)
  @ModuleUserOrHigher()
  @RequiresMobileFeature('leave')
  @AuditLog({ action: 'CANCEL_LEAVE_REQUEST', resource: 'LeaveRequest', description: 'Cancel a leave request' })
  async cancelLeaveRequest(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
    @Args('reason', { nullable: true }) reason?: string,
  ): Promise<LeaveRequest> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute<CancelLeaveRequestCommand, LeaveRequest>(
      new CancelLeaveRequestCommand(tenantId, userId, id, reason),
    );
  }
}
