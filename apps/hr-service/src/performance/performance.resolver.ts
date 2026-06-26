import { Resolver, Query, Mutation, Args, ID, Context, Int, ObjectType, Float } from '@nestjs/graphql';
import { UnauthorizedException, UseGuards } from '@nestjs/common';
import { GqlAuthGuard } from '../common/guards/gql-auth.guard';
import { Roles, Role } from '@aquaculture/backend-common/decorators';
import { StandardPaginatedResponse, IStandardPaginatedResult, fromCqrsPaginated } from '@aquaculture/backend-common/pagination';
import { RolesGuard } from '@aquaculture/backend-common/guards';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { PerformanceReview } from './entities/performance-review.entity';
import { Goal } from './entities/goal.entity';
import { EmployeeKPI } from './entities/kpi.entity';
import {
  CreatePerformanceReviewInput,
  SubmitSelfAssessmentInput,
  SubmitManagerAssessmentInput,
  FinalizeReviewInput,
  CreateGoalInput,
  UpdateGoalInput,
  UpdateGoalProgressInput,
  KeyResultInput,
  MilestoneInput,
} from './dto';
import {
  CreatePerformanceReviewCommand,
  SubmitSelfAssessmentCommand,
  SubmitManagerAssessmentCommand,
  FinalizeReviewCommand,
  AcknowledgeReviewCommand,
  ReopenReviewCommand,
  CreateGoalCommand,
  UpdateGoalCommand,
  UpdateGoalProgressCommand,
  CompleteGoalCommand,
  CancelGoalCommand,
  DeferGoalCommand,
  AddKeyResultCommand,
  UpdateKeyResultCommand,
  AddMilestoneCommand,
  CompleteMilestoneCommand,
} from './commands';
import {
  GetPerformanceReviewsQuery,
  GetPerformanceReviewQuery,
  GetMyPerformanceReviewsQuery,
  GetPendingReviewsQuery,
  GetGoalsQuery,
  GetGoalQuery,
  GetMyGoalsQuery,
  GetEmployeeKPIsQuery,
  GetTeamGoalsQuery,
  GetOverdueGoalsQuery,
  GetPerformanceSummaryQuery,
} from './queries';
import { PerformanceSummary } from './query-handlers/get-performance-summary.handler';

// SECURITY: Context only exposes JWT-verified user fields.
interface GraphQLContext {
  req: {
    user?: {
      sub: string;
      tenantId: string;
    };
  };
}

@ObjectType()
class PerformanceReviewConnection extends StandardPaginatedResponse(PerformanceReview) {}

@ObjectType()
class GoalConnection extends StandardPaginatedResponse(Goal) {}

@UseGuards(GqlAuthGuard)
@Resolver(() => PerformanceReview)
export class PerformanceResolver {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  private getTenantId(context: GraphQLContext): string {
    const tenantId = context.req.user?.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException('Tenant ID is required - authentication required');
    }
    return tenantId;
  }

  private getUserId(context: GraphQLContext): string {
    const userId = context.req.user?.sub;
    if (!userId || typeof userId !== 'string') {
      throw new UnauthorizedException('User ID is required - authentication required');
    }
    return userId;
  }

  // =====================
  // Performance Review Queries
  // =====================

  @Query(() => PerformanceReviewConnection, { name: 'performanceReviews' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async getPerformanceReviews(
    @Context() context: GraphQLContext,
    @Args('employeeId', { type: () => ID, nullable: true }) employeeId?: string,
    @Args('status', { nullable: true }) status?: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
  ): Promise<IStandardPaginatedResult<PerformanceReview>> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute(
      new GetPerformanceReviewsQuery(tenantId, employeeId, status, limit, page),
    );
    return fromCqrsPaginated(result);
  }

  @Query(() => PerformanceReview, { name: 'performanceReview' })
  async getPerformanceReview(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<PerformanceReview> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetPerformanceReviewQuery(tenantId, id));
  }

  @Query(() => [PerformanceReview], { name: 'myPerformanceReviews' })
  async getMyPerformanceReviews(
    @Context() context: GraphQLContext,
    @Args('status', { nullable: true }) status?: string,
  ): Promise<PerformanceReview[]> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.queryBus.execute(
      new GetMyPerformanceReviewsQuery(tenantId, userId, status),
    );
  }

  @Query(() => [PerformanceReview], { name: 'pendingReviews' })
  async getPendingReviews(
    @Args('reviewerId', { type: () => ID }) reviewerId: string,
    @Context() context: GraphQLContext,
  ): Promise<PerformanceReview[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetPendingReviewsQuery(tenantId, reviewerId));
  }

  @Query(() => PerformanceSummary, { name: 'performanceSummary' })
  async getPerformanceSummary(
    @Args('employeeId', { type: () => ID }) employeeId: string,
    @Context() context: GraphQLContext,
  ): Promise<PerformanceSummary> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetPerformanceSummaryQuery(tenantId, employeeId),
    );
  }

  // =====================
  // Goal Queries
  // =====================

  @Query(() => GoalConnection, { name: 'goals' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async getGoals(
    @Context() context: GraphQLContext,
    @Args('employeeId', { type: () => ID, nullable: true }) employeeId?: string,
    @Args('status', { nullable: true }) status?: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 }) limit?: number,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 }) page?: number,
  ): Promise<IStandardPaginatedResult<Goal>> {
    const tenantId = this.getTenantId(context);
    const result = await this.queryBus.execute(
      new GetGoalsQuery(tenantId, employeeId, status, limit, page),
    );
    return fromCqrsPaginated(result);
  }

  @Query(() => Goal, { name: 'goal' })
  async getGoal(
    @Args('id', { type: () => ID }) id: string,
    @Context() context: GraphQLContext,
  ): Promise<Goal> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetGoalQuery(tenantId, id));
  }

  @Query(() => [Goal], { name: 'myGoals' })
  async getMyGoals(
    @Context() context: GraphQLContext,
    @Args('status', { nullable: true }) status?: string,
  ): Promise<Goal[]> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.queryBus.execute(new GetMyGoalsQuery(tenantId, userId, status));
  }

  @Query(() => [Goal], { name: 'teamGoals' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async getTeamGoals(
    @Args('managerId', { type: () => ID }) managerId: string,
    @Context() context: GraphQLContext,
    @Args('status', { nullable: true }) status?: string,
  ): Promise<Goal[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetTeamGoalsQuery(tenantId, managerId, status));
  }

  @Query(() => [Goal], { name: 'overdueGoals' })
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async getOverdueGoals(
    @Context() context: GraphQLContext,
    @Args('departmentId', { type: () => ID, nullable: true }) departmentId?: string,
  ): Promise<Goal[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(new GetOverdueGoalsQuery(tenantId, departmentId));
  }

  // =====================
  // KPI Queries
  // =====================

  @Query(() => [EmployeeKPI], { name: 'employeeKPIs' })
  async getEmployeeKPIs(
    @Args('employeeId', { type: () => ID }) employeeId: string,
    @Context() context: GraphQLContext,
    @Args('periodStart', { nullable: true }) periodStart?: string,
    @Args('periodEnd', { nullable: true }) periodEnd?: string,
  ): Promise<EmployeeKPI[]> {
    const tenantId = this.getTenantId(context);
    return this.queryBus.execute(
      new GetEmployeeKPIsQuery(tenantId, employeeId, periodStart, periodEnd),
    );
  }

  // =====================
  // Performance Review Mutations
  // =====================

  @Mutation(() => PerformanceReview)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createPerformanceReview(
    @Args('input') input: CreatePerformanceReviewInput,
    @Context() context: GraphQLContext,
  ): Promise<PerformanceReview> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new CreatePerformanceReviewCommand(
        tenantId,
        userId,
        input.employeeId,
        input.reviewerId,
        input.periodType,
        input.periodStart,
        input.periodEnd,
      ),
    );
  }

  @Mutation(() => PerformanceReview)
  async submitSelfAssessment(
    @Args('input') input: SubmitSelfAssessmentInput,
    @Context() context: GraphQLContext,
  ): Promise<PerformanceReview> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new SubmitSelfAssessmentCommand(
        tenantId,
        userId,
        input.reviewId,
        input.selfAssessment,
        input.selfRating,
        input.competencyRatings,
      ),
    );
  }

  @Mutation(() => PerformanceReview)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async submitManagerAssessment(
    @Args('input') input: SubmitManagerAssessmentInput,
    @Context() context: GraphQLContext,
  ): Promise<PerformanceReview> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new SubmitManagerAssessmentCommand(
        tenantId,
        userId,
        input.reviewId,
        input.managerAssessment,
        input.managerRating,
        input.competencyRatings,
        input.strengths,
        input.areasForImprovement,
        input.developmentPlan,
      ),
    );
  }

  @Mutation(() => PerformanceReview)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async finalizeReview(
    @Args('input') input: FinalizeReviewInput,
    @Context() context: GraphQLContext,
  ): Promise<PerformanceReview> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new FinalizeReviewCommand(
        tenantId,
        userId,
        input.reviewId,
        input.finalRating,
        input.calibrationNotes,
        input.reviewerComments,
      ),
    );
  }

  @Mutation(() => PerformanceReview)
  async acknowledgeReview(
    @Args('reviewId', { type: () => ID }) reviewId: string,
    @Context() context: GraphQLContext,
    @Args('comments', { nullable: true }) comments?: string,
  ): Promise<PerformanceReview> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new AcknowledgeReviewCommand(tenantId, userId, reviewId, comments),
    );
  }

  @Mutation(() => PerformanceReview)
  @UseGuards(RolesGuard)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async reopenReview(
    @Args('reviewId', { type: () => ID }) reviewId: string,
    @Args('reason') reason: string,
    @Context() context: GraphQLContext,
  ): Promise<PerformanceReview> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new ReopenReviewCommand(tenantId, userId, reviewId, reason),
    );
  }

  // =====================
  // Goal Mutations
  // =====================

  @Mutation(() => Goal)
  async createGoal(
    @Args('input') input: CreateGoalInput,
    @Context() context: GraphQLContext,
  ): Promise<Goal> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new CreateGoalCommand(
        tenantId,
        userId,
        input.employeeId,
        input.title,
        input.priority,
        input.startDate,
        input.targetDate,
        input.description,
        input.category,
        input.keyResults,
        input.alignedReviewId,
        input.parentGoalId,
      ),
    );
  }

  @Mutation(() => Goal)
  async updateGoal(
    @Args('input') input: UpdateGoalInput,
    @Context() context: GraphQLContext,
  ): Promise<Goal> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new UpdateGoalCommand(
        tenantId,
        userId,
        input.id,
        input.title,
        input.description,
        input.priority,
        input.targetDate,
        input.status,
      ),
    );
  }

  @Mutation(() => Goal)
  async updateGoalProgress(
    @Args('input') input: UpdateGoalProgressInput,
    @Context() context: GraphQLContext,
  ): Promise<Goal> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new UpdateGoalProgressCommand(
        tenantId,
        userId,
        input.goalId,
        input.progressPercent,
        input.keyResultUpdates,
        input.notes,
      ),
    );
  }

  @Mutation(() => Goal)
  async completeGoal(
    @Args('goalId', { type: () => ID }) goalId: string,
    @Context() context: GraphQLContext,
    @Args('completionNotes', { nullable: true }) completionNotes?: string,
  ): Promise<Goal> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new CompleteGoalCommand(tenantId, userId, goalId, completionNotes),
    );
  }

  @Mutation(() => Goal)
  async cancelGoal(
    @Args('goalId', { type: () => ID }) goalId: string,
    @Args('reason') reason: string,
    @Context() context: GraphQLContext,
  ): Promise<Goal> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new CancelGoalCommand(tenantId, userId, goalId, reason),
    );
  }

  @Mutation(() => Goal)
  async deferGoal(
    @Args('goalId', { type: () => ID }) goalId: string,
    @Args('newTargetDate') newTargetDate: string,
    @Context() context: GraphQLContext,
    @Args('reason', { nullable: true }) reason?: string,
  ): Promise<Goal> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new DeferGoalCommand(tenantId, userId, goalId, newTargetDate, reason),
    );
  }

  @Mutation(() => Goal)
  async addKeyResult(
    @Args('goalId', { type: () => ID }) goalId: string,
    @Args('keyResult') keyResult: KeyResultInput,
    @Context() context: GraphQLContext,
  ): Promise<Goal> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new AddKeyResultCommand(tenantId, userId, goalId, keyResult),
    );
  }

  @Mutation(() => Goal)
  async updateKeyResult(
    @Args('goalId', { type: () => ID }) goalId: string,
    @Args('keyResultId', { type: () => ID }) keyResultId: string,
    @Args('currentValue', { type: () => Float }) currentValue: number,
    @Context() context: GraphQLContext,
  ): Promise<Goal> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new UpdateKeyResultCommand(tenantId, userId, goalId, keyResultId, currentValue),
    );
  }

  @Mutation(() => Goal)
  async addMilestone(
    @Args('goalId', { type: () => ID }) goalId: string,
    @Args('milestone') milestone: MilestoneInput,
    @Context() context: GraphQLContext,
  ): Promise<Goal> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new AddMilestoneCommand(tenantId, userId, goalId, milestone),
    );
  }

  @Mutation(() => Goal)
  async completeMilestone(
    @Args('goalId', { type: () => ID }) goalId: string,
    @Args('milestoneId', { type: () => ID }) milestoneId: string,
    @Context() context: GraphQLContext,
  ): Promise<Goal> {
    const tenantId = this.getTenantId(context);
    const userId = this.getUserId(context);
    return this.commandBus.execute(
      new CompleteMilestoneCommand(tenantId, userId, goalId, milestoneId),
    );
  }
}
