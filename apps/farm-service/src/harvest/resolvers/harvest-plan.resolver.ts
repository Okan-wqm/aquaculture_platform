/**
 * HarvestPlan Resolver
 *
 * GraphQL resolver for harvest plan operations.
 * Provides comprehensive CRUD operations, workflow management, and statistics queries.
 * All operations enforce tenant isolation.
 *
 * @module Harvest/Resolvers
 */
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  Int,
  Float,
  ObjectType,
  Field,
  ResolveField,
  Parent,
} from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { Tenant, CurrentUser, Roles, Role } from '@aquaculture/backend-common/decorators';
import { TenantGuard } from '@aquaculture/backend-common/guards';
import { StandardPaginatedResponse, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';

// Entities
import { HarvestPlan, HarvestPlanStatus } from '../entities/harvest-plan.entity';

// Service
import {
  HarvestPlanService,
  HarvestPlanStats,
} from '../services/harvest-plan.service';
import { QueryBus } from '@platform/cqrs';
import { GetHarvestPlanQuery } from '../queries/get-harvest-plan.query';
import { GetHarvestPlanByCodeQuery } from '../queries/get-harvest-plan-by-code.query';
import { ListHarvestPlansQuery } from '../queries/list-harvest-plans.query';
import { ListHarvestPlansByBatchQuery } from '../queries/list-harvest-plans-by-batch.query';
import { ListUpcomingHarvestPlansQuery } from '../queries/list-upcoming-harvest-plans.query';
import { ListOverdueHarvestPlansQuery } from '../queries/list-overdue-harvest-plans.query';
import { GetHarvestPlanStatsQuery } from '../queries/get-harvest-plan-stats.query';

// DTOs
import { CreateHarvestPlanInput } from '../dto/create-harvest-plan.input';
import { UpdateHarvestPlanInput } from '../dto/update-harvest-plan.input';
import { HarvestPlanFilterInput } from '../dto/harvest-plan-filter.input';

// ============================================================================
// RESPONSE TYPES
// ============================================================================

/**
 * User context interface for CurrentUser decorator
 */
interface UserContext {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
}

/**
 * Paginated harvest plans response
 */
@ObjectType()
export class PaginatedHarvestPlansResponse extends StandardPaginatedResponse(HarvestPlan) {}

/**
 * Harvest plan statistics response
 */
@ObjectType()
export class HarvestPlanStatsResponse {
  @Field(() => Int)
  total: number;

  @Field(() => Int)
  draft: number;

  @Field(() => Int)
  planned: number;

  @Field(() => Int)
  approved: number;

  @Field(() => Int)
  scheduled: number;

  @Field(() => Int)
  inProgress: number;

  @Field(() => Int)
  completed: number;

  @Field(() => Int)
  cancelled: number;

  @Field(() => Int)
  postponed: number;

  @Field(() => Float)
  totalEstimatedBiomass: number;

  @Field(() => Float)
  totalActualBiomass: number;

  @Field(() => Int)
  upcomingCount: number;

  @Field(() => Int)
  overdueCount: number;
}

/**
 * Harvest variance response
 */
@ObjectType()
export class HarvestVarianceResponse {
  @Field(() => Float)
  quantityVariance: number;

  @Field(() => Float)
  biomassVariance: number;

  @Field(() => Float)
  weightVariance: number;
}

// ============================================================================
// RESOLVER
// ============================================================================

@Resolver(() => HarvestPlan)
@UseGuards(TenantGuard)
export class HarvestPlanResolver {
  private readonly logger = new Logger(HarvestPlanResolver.name);

  constructor(
    private readonly harvestPlanService: HarvestPlanService,
    private readonly queryBus: QueryBus,
  ) {}

  // =========================================================================
  // QUERIES
  // =========================================================================

  /**
   * Get a single harvest plan by ID
   */
  @Query(() => HarvestPlan, { nullable: true, description: 'Get harvest plan by ID' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async harvestPlan(
    @Tenant() tenantId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<HarvestPlan | null> {
    return this.queryBus.execute(new GetHarvestPlanQuery(tenantId, id));
  }

  /**
   * Get a harvest plan by plan code
   */
  @Query(() => HarvestPlan, { nullable: true, description: 'Get harvest plan by plan code' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async harvestPlanByCode(
    @Tenant() tenantId: string,
    @Args('planCode') planCode: string,
  ): Promise<HarvestPlan | null> {
    return this.queryBus.execute(new GetHarvestPlanByCodeQuery(tenantId, planCode));
  }

  /**
   * List harvest plans with filtering and pagination
   */
  @Query(() => PaginatedHarvestPlansResponse, { description: 'List harvest plans with filters' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async harvestPlans(
    @Tenant() tenantId: string,
    @Args('filter', { nullable: true }) filter?: HarvestPlanFilterInput,
  ): Promise<IStandardPaginatedResult<HarvestPlan>> {
    return this.queryBus.execute(new ListHarvestPlansQuery(tenantId, filter));
  }

  /**
   * Get harvest plans for a specific batch
   */
  @Query(() => [HarvestPlan], { description: 'Get harvest plans for a batch' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async harvestPlansByBatch(
    @Tenant() tenantId: string,
    @Args('batchId', { type: () => ID }) batchId: string,
    @Args('activeOnly', { nullable: true, defaultValue: false }) activeOnly: boolean,
  ): Promise<HarvestPlan[]> {
    return this.queryBus.execute(
      new ListHarvestPlansByBatchQuery(tenantId, batchId, activeOnly),
    );
  }

  /**
   * Get upcoming harvest plans
   */
  @Query(() => [HarvestPlan], { description: 'Get upcoming harvest plans within specified days' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async upcomingHarvestPlans(
    @Tenant() tenantId: string,
    @Args('days', { type: () => Int, nullable: true, defaultValue: 30 }) days: number,
  ): Promise<HarvestPlan[]> {
    return this.queryBus.execute(new ListUpcomingHarvestPlansQuery(tenantId, days));
  }

  /**
   * Get overdue harvest plans
   */
  @Query(() => [HarvestPlan], { description: 'Get overdue harvest plans' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async overdueHarvestPlans(
    @Tenant() tenantId: string,
  ): Promise<HarvestPlan[]> {
    return this.queryBus.execute(new ListOverdueHarvestPlansQuery(tenantId));
  }

  /**
   * Get harvest plan statistics
   */
  @Query(() => HarvestPlanStatsResponse, { description: 'Get harvest plan statistics' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  async harvestPlanStats(
    @Tenant() tenantId: string,
  ): Promise<HarvestPlanStats> {
    return this.queryBus.execute(new GetHarvestPlanStatsQuery(tenantId));
  }

  // =========================================================================
  // MUTATIONS - CRUD
  // =========================================================================

  /**
   * Create a new harvest plan
   */
  @Mutation(() => HarvestPlan, { description: 'Create a new harvest plan' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createHarvestPlan(
    @Tenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('input') input: CreateHarvestPlanInput,
  ): Promise<HarvestPlan> {
    this.logger.log(`Creating harvest plan for batch ${input.batchId}`);
    return this.harvestPlanService.create(tenantId, input, userId);
  }

  /**
   * Update an existing harvest plan
   */
  @Mutation(() => HarvestPlan, { description: 'Update a harvest plan' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateHarvestPlan(
    @Tenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('input') input: UpdateHarvestPlanInput,
  ): Promise<HarvestPlan> {
    this.logger.log(`Updating harvest plan ${input.id}`);
    return this.harvestPlanService.update(tenantId, input, userId);
  }

  /**
   * Delete a harvest plan (only draft plans can be deleted)
   */
  @Mutation(() => Boolean, { description: 'Delete a harvest plan' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async deleteHarvestPlan(
    @Tenant() tenantId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<boolean> {
    this.logger.log(`Deleting harvest plan ${id}`);
    return this.harvestPlanService.delete(tenantId, id);
  }

  // =========================================================================
  // MUTATIONS - WORKFLOW
  // =========================================================================

  /**
   * Approve a harvest plan
   */
  @Mutation(() => HarvestPlan, { description: 'Approve a harvest plan' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async approveHarvestPlan(
    @Tenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<HarvestPlan> {
    this.logger.log(`Approving harvest plan ${id}`);
    return this.harvestPlanService.approve(tenantId, id, userId);
  }

  /**
   * Schedule a harvest plan with a confirmed date
   */
  @Mutation(() => HarvestPlan, { description: 'Schedule a harvest plan' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async scheduleHarvestPlan(
    @Tenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('confirmedDate') confirmedDate: Date,
  ): Promise<HarvestPlan> {
    this.logger.log(`Scheduling harvest plan ${id} for ${confirmedDate}`);
    return this.harvestPlanService.schedule(tenantId, id, confirmedDate, userId);
  }

  /**
   * Start harvest for a plan
   */
  @Mutation(() => HarvestPlan, { description: 'Start harvest for a plan' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async startHarvestPlan(
    @Tenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<HarvestPlan> {
    this.logger.log(`Starting harvest for plan ${id}`);
    return this.harvestPlanService.startHarvest(tenantId, id, userId);
  }

  /**
   * Complete harvest for a plan
   */
  @Mutation(() => HarvestPlan, { description: 'Complete harvest for a plan' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async completeHarvestPlan(
    @Tenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('actualQuantity', { type: () => Int }) actualQuantity: number,
    @Args('actualBiomass', { type: () => Float }) actualBiomass: number,
    @Args('actualAvgWeight', { type: () => Float }) actualAvgWeight: number,
  ): Promise<HarvestPlan> {
    this.logger.log(`Completing harvest for plan ${id}`);
    return this.harvestPlanService.completeHarvest(
      tenantId,
      id,
      actualQuantity,
      actualBiomass,
      actualAvgWeight,
      userId,
    );
  }

  /**
   * Cancel a harvest plan
   */
  @Mutation(() => HarvestPlan, { description: 'Cancel a harvest plan' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async cancelHarvestPlan(
    @Tenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<HarvestPlan> {
    this.logger.log(`Cancelling harvest plan ${id}`);
    return this.harvestPlanService.cancel(tenantId, id, userId);
  }

  /**
   * Postpone a harvest plan
   */
  @Mutation(() => HarvestPlan, { description: 'Postpone a harvest plan' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async postponeHarvestPlan(
    @Tenant() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Args('id', { type: () => ID }) id: string,
    @Args('newDate') newDate: Date,
  ): Promise<HarvestPlan> {
    this.logger.log(`Postponing harvest plan ${id} to ${newDate}`);
    return this.harvestPlanService.postpone(tenantId, id, newDate, userId);
  }

  // =========================================================================
  // FIELD RESOLVERS
  // =========================================================================

  /**
   * Calculate days until harvest
   */
  @ResolveField(() => Int)
  daysUntilHarvest(@Parent() plan: HarvestPlan): number {
    return plan.getDaysUntilHarvest();
  }

  /**
   * Check if plan is within flexible window
   */
  @ResolveField(() => Boolean)
  isWithinWindow(@Parent() plan: HarvestPlan): boolean {
    return plan.isWithinWindow();
  }

  /**
   * Check if harvest is allowed (health checks passed)
   */
  @ResolveField(() => Boolean)
  isHarvestAllowed(@Parent() plan: HarvestPlan): boolean {
    return plan.isHarvestAllowed();
  }

  /**
   * Calculate variances between estimated and actual values
   */
  @ResolveField(() => HarvestVarianceResponse, { nullable: true })
  variances(@Parent() plan: HarvestPlan): HarvestVarianceResponse | null {
    return plan.calculateVariances();
  }

  /**
   * Check if plan can be edited
   */
  @ResolveField(() => Boolean)
  canEdit(@Parent() plan: HarvestPlan): boolean {
    return ![
      HarvestPlanStatus.COMPLETED,
      HarvestPlanStatus.CANCELLED,
    ].includes(plan.status);
  }

  /**
   * Check if plan can be deleted
   */
  @ResolveField(() => Boolean)
  canDelete(@Parent() plan: HarvestPlan): boolean {
    return plan.status === HarvestPlanStatus.DRAFT;
  }

  /**
   * Check if plan can be approved
   */
  @ResolveField(() => Boolean)
  canApprove(@Parent() plan: HarvestPlan): boolean {
    return plan.status === HarvestPlanStatus.PLANNED;
  }

  /**
   * Check if plan can be scheduled
   */
  @ResolveField(() => Boolean)
  canSchedule(@Parent() plan: HarvestPlan): boolean {
    return plan.status === HarvestPlanStatus.APPROVED;
  }

  /**
   * Check if harvest can be started
   */
  @ResolveField(() => Boolean)
  canStartHarvest(@Parent() plan: HarvestPlan): boolean {
    return plan.status === HarvestPlanStatus.SCHEDULED;
  }

  /**
   * Check if harvest can be completed
   */
  @ResolveField(() => Boolean)
  canComplete(@Parent() plan: HarvestPlan): boolean {
    return plan.status === HarvestPlanStatus.IN_PROGRESS;
  }

  /**
   * Check if plan is overdue
   */
  @ResolveField(() => Boolean)
  isOverdue(@Parent() plan: HarvestPlan): boolean {
    if (
      plan.status === HarvestPlanStatus.COMPLETED ||
      plan.status === HarvestPlanStatus.CANCELLED
    ) {
      return false;
    }
    return plan.getDaysUntilHarvest() < 0;
  }

  /**
   * Get estimated revenue (shortcut from financial projection)
   */
  @ResolveField(() => Float, { nullable: true })
  estimatedRevenue(@Parent() plan: HarvestPlan): number | null {
    return plan.financialProjection?.estimatedRevenue ?? null;
  }

  /**
   * Get estimated profit (shortcut from financial projection)
   */
  @ResolveField(() => Float, { nullable: true })
  estimatedProfit(@Parent() plan: HarvestPlan): number | null {
    return plan.financialProjection?.estimatedProfit ?? null;
  }

  /**
   * Get customer name (shortcut from customer order)
   */
  @ResolveField(() => String, { nullable: true })
  customerName(@Parent() plan: HarvestPlan): string | null {
    return plan.customerOrder?.customerName ?? null;
  }

  /**
   * Calculate biomass accuracy percentage (actual vs estimated)
   */
  @ResolveField(() => Float, { nullable: true })
  biomassAccuracy(@Parent() plan: HarvestPlan): number | null {
    if (!plan.actualBiomassHarvested || !plan.estimates?.estimatedBiomass) {
      return null;
    }
    const accuracy =
      (Number(plan.actualBiomassHarvested) / plan.estimates.estimatedBiomass) * 100;
    return Math.round(accuracy * 100) / 100; // Round to 2 decimal places
  }
}
