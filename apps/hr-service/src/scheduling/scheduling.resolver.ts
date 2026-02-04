import { Resolver, Query, Mutation, Args, ID, Context, Int, ObjectType, Field } from '@nestjs/graphql';
import { UnauthorizedException, UseGuards } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { GqlAuthGuard } from '../common/guards/gql-auth.guard';
import { Roles, Role } from '@platform/backend-common';
import { RolesGuard } from '../common/guards/roles.guard';

// Entities
import { WeeklyPlan, WeeklyPlanStatus } from './entities/weekly-plan.entity';
import { WeeklyPlanEntry } from './entities/weekly-plan-entry.entity';
import { SchedulingSettings } from './entities/scheduling-settings.entity';
import { Shift, WeekDay } from '../attendance/entities/shift.entity';

// DTOs
import { CreateWeeklyPlanInput, CreateBulkWeeklyPlansInput } from './dto/create-weekly-plan.input';
import { UpdatePlanEntryInput } from './dto/update-plan-entry.input';
import { BulkAssignShiftsInput } from './dto/bulk-assign.input';
import { UpdateSchedulingSettingsInput } from './dto/scheduling-settings.input';

// Commands
import {
  CreateWeeklyPlanCommand,
  UpdatePlanEntryCommand,
  BulkAssignShiftsCommand,
  PublishWeeklyPlanCommand,
  CopyWeeklyPlanCommand,
  UpdateSchedulingSettingsCommand,
  DeleteWeeklyPlanCommand,
} from './commands';

// Queries
import {
  GetWeeklyPlansQuery,
  GetWeeklyPlanQuery,
  GetTeamWeeklyOverviewQuery,
  GetSchedulingSettingsQuery,
  GetOvertimeSummaryQuery,
} from './queries';

// Query result types
import { WeeklyPlanConnection } from './query-handlers/get-weekly-plans.handler';
import { TeamWeeklyOverview } from './query-handlers/get-team-weekly-overview.handler';
import { OvertimeSummary } from './query-handlers/get-overtime-summary.handler';
import { BulkAssignResult } from './handlers/bulk-assign-shifts.handler';

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

// Pagination limits to prevent DoS and performance issues
const PAGINATION_LIMITS = {
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
  MIN_OFFSET: 0,
  MAX_OFFSET: 10000,
} as const;

@ObjectType()
class BulkAssignResultType {
  @Field()
  success!: boolean;

  @Field(() => Int)
  updatedCount!: number;

  @Field(() => [String])
  errors!: string[];
}

@UseGuards(GqlAuthGuard)
@Resolver(() => WeeklyPlan)
export class SchedulingResolver {
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

  /**
   * Clamp pagination values to safe limits
   * Prevents DoS through excessive data requests
   */
  private clampPagination(limit?: number, offset?: number): { limit: number; offset: number } {
    const clampedLimit = Math.min(
      Math.max(1, limit ?? PAGINATION_LIMITS.DEFAULT_LIMIT),
      PAGINATION_LIMITS.MAX_LIMIT,
    );
    const clampedOffset = Math.min(
      Math.max(PAGINATION_LIMITS.MIN_OFFSET, offset ?? 0),
      PAGINATION_LIMITS.MAX_OFFSET,
    );
    return { limit: clampedLimit, offset: clampedOffset };
  }

  // =====================
  // Queries
  // =====================

  @Query(() => WeeklyPlanConnection, { name: 'weeklyPlans' })
  async getWeeklyPlans(
    @Context() context: GraphQLContext,
    @Args('employeeId', { type: () => ID, nullable: true }) employeeId?: string,
    @Args('departmentId', { type: () => ID, nullable: true }) departmentId?: string,
    @Args('siteId', { type: () => ID, nullable: true }) siteId?: string,
    @Args('weekStartDate', { nullable: true }) weekStartDate?: string,
    @Args('status', { type: () => WeeklyPlanStatus, nullable: true }) status?: WeeklyPlanStatus,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('offset', { type: () => Int, nullable: true, defaultValue: 0 }) offset?: number,
  ): Promise<WeeklyPlanConnection> {
    const tenantId = this.getTenantId(context);
    const pagination = this.clampPagination(limit, offset);
    return this.queryBus.execute(
      new GetWeeklyPlansQuery(
        tenantId,
        employeeId,
        departmentId,
        siteId,
        weekStartDate,
        status,
        pagination.limit,
        pagination.offset,
      ),
    );
  }

  @Query(() => WeeklyPlan, { name: 'weeklyPlan' })
  async getWeeklyPlan(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<WeeklyPlan> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetWeeklyPlanQuery(tenantId, id));
  }

  @Query(() => TeamWeeklyOverview, { name: 'teamWeeklyOverview' })
  async getTeamWeeklyOverview(
    @Args('weekStartDate') weekStartDate: string,
    @Context() context: GraphQLContext,
    @Args('departmentId', { type: () => ID, nullable: true }) departmentId?: string,
    @Args('siteId', { type: () => ID, nullable: true }) siteId?: string,
  ): Promise<TeamWeeklyOverview> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetTeamWeeklyOverviewQuery(tenantId, weekStartDate, departmentId, siteId),
    );
  }

  @Query(() => SchedulingSettings, { name: 'schedulingSettings' })
  async getSchedulingSettings(
    @Context() context: GraphQLContext,
  ): Promise<SchedulingSettings> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetSchedulingSettingsQuery(tenantId));
  }

  @Query(() => OvertimeSummary, { name: 'overtimeSummary' })
  async getOvertimeSummary(
    @Args('month', { type: () => Int }) month: number,
    @Args('year', { type: () => Int }) year: number,
    @Context() context: GraphQLContext,
    @Args('employeeId', { type: () => ID, nullable: true }) employeeId?: string,
    @Args('departmentId', { type: () => ID, nullable: true }) departmentId?: string,
  ): Promise<OvertimeSummary> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetOvertimeSummaryQuery(tenantId, month, year, employeeId, departmentId),
    );
  }

  // =====================
  // Mutations
  // =====================

  @Mutation(() => WeeklyPlan)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async createWeeklyPlan(
    @Args('input') input: CreateWeeklyPlanInput,
    @Context() context: GraphQLContext,
  ): Promise<WeeklyPlan> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new CreateWeeklyPlanCommand(
        tenantId,
        userId,
        input.employeeId,
        input.weekStartDate,
        input.defaultShiftId,
        input.defaultOffDays,
        input.notes,
      ),
    );
  }

  @Mutation(() => WeeklyPlanEntry)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async updatePlanEntry(
    @Args('input') input: UpdatePlanEntryInput,
    @Context() context: GraphQLContext,
  ): Promise<WeeklyPlanEntry> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new UpdatePlanEntryCommand(
        tenantId,
        userId,
        input.entryId,
        input.shiftId,
        input.isOffDay,
        input.plannedStartTime,
        input.plannedEndTime,
        input.entryType,
        input.notes,
      ),
    );
  }

  @Mutation(() => BulkAssignResultType)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async bulkAssignShifts(
    @Args('input') input: BulkAssignShiftsInput,
    @Context() context: GraphQLContext,
  ): Promise<BulkAssignResult> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new BulkAssignShiftsCommand(
        tenantId,
        userId,
        input.weeklyPlanId,
        input.assignments.map(a => ({
          date: a.date,
          shiftId: a.shiftId,
          isOffDay: a.isOffDay,
        })),
      ),
    );
  }

  @Mutation(() => WeeklyPlan)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async copyWeeklyPlan(
    @Args('sourceId', { type: () => ID }) sourceId: string,
    @Args('targetWeekStartDate') targetWeekStartDate: string,
    @Context() context: GraphQLContext,
  ): Promise<WeeklyPlan> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new CopyWeeklyPlanCommand(tenantId, userId, sourceId, targetWeekStartDate),
    );
  }

  @Mutation(() => WeeklyPlan)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async publishWeeklyPlan(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<WeeklyPlan> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(new PublishWeeklyPlanCommand(tenantId, userId, id));
  }

  @Mutation(() => Boolean)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async deleteWeeklyPlan(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<boolean> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(new DeleteWeeklyPlanCommand(tenantId, userId, id));
  }

  @Mutation(() => SchedulingSettings)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN)
  async updateSchedulingSettings(
    @Args('input') input: UpdateSchedulingSettingsInput,
    @Context() context: GraphQLContext,
  ): Promise<SchedulingSettings> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new UpdateSchedulingSettingsCommand(
        tenantId,
        userId,
        input.standardWeeklyMinutes,
        input.maxOvertimeMinutesPerWeek,
        input.maxOvertimeMinutesPerMonth,
        input.defaultShiftId,
        input.workWeekStartDay,
        input.autoNotifyEmployees,
        input.notifyDaysBefore,
        input.maxConsecutiveWorkDays,
        input.minRestMinutesBetweenShifts,
        input.allowOvertimeWithoutApproval,
      ),
    );
  }
}
