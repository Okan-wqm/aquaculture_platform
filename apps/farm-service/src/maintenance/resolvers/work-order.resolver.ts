/**
 * WorkOrder GraphQL Resolver
 *
 * İş emri CRUD operasyonları ve durum yönetimi için GraphQL API.
 *
 * @module Maintenance/Resolvers
 */
import {
  Resolver,
  Query,
  Mutation,
  Args,
  ID,
  ObjectType,
  Field,
  Int,
  Float,
  InputType,
  registerEnumType,
} from '@nestjs/graphql';
import { Logger, UseGuards } from '@nestjs/common';
import { DecimalScalar } from '@aquaculture/backend-common/graphql';
import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import { Tenant, CurrentUser, Role, Roles } from '@aquaculture/backend-common/decorators';
import { StandardPaginatedResponse, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import {
  WorkOrder,
  WorkOrderStatus,
  WorkOrderType,
  WorkOrderPriority,
  AssetType,
} from '../entities/work-order.entity';
import { WorkOrderService, WorkOrderStatistics } from '../services/work-order.service';
import { QueryBus } from '@platform/cqrs';
import { GetWorkOrderQuery } from '../queries/get-work-order.query';
import { GetWorkOrderByCodeQuery } from '../queries/get-work-order-by-code.query';
import { ListWorkOrdersQuery } from '../queries/list-work-orders.query';
import { ListOverdueWorkOrdersQuery } from '../queries/list-overdue-work-orders.query';
import { ListMyWorkOrdersQuery } from '../queries/list-my-work-orders.query';
import { GetWorkOrderStatisticsQuery } from '../queries/get-work-order-statistics.query';
import { CreateWorkOrderInput } from '../dto/create-work-order.dto';
import {
  UpdateWorkOrderInput,
  StartWorkOrderInput,
  CompleteWorkOrderInput,
  VerifyWorkOrderInput,
  ApproveWorkOrderInput,
} from '../dto/update-work-order.dto';
import { WorkOrderFilterInput } from '../dto/work-order-filter.dto';

// Register enums for GraphQL
registerEnumType(WorkOrderStatus, {
  name: 'WorkOrderStatus',
  description: 'İş emri durumu',
});

registerEnumType(WorkOrderType, {
  name: 'WorkOrderType',
  description: 'İş emri tipi',
});

registerEnumType(WorkOrderPriority, {
  name: 'WorkOrderPriority',
  description: 'Öncelik seviyesi',
});

registerEnumType(AssetType, {
  name: 'AssetType',
  description: 'Varlık tipi',
});

/**
 * User context interface
 */
interface UserContext {
  sub: string;
  email: string;
  tenantId: string;
  roles: string[];
}

// ============================================================================
// RESPONSE TYPES
// ============================================================================

@ObjectType()
export class WorkOrderListResponse extends StandardPaginatedResponse(WorkOrder) {}

@ObjectType()
export class WorkOrderStatisticsResponse {
  @Field(() => Int)
  total!: number;

  @Field(() => Int)
  overdue!: number;

  @Field(() => Int)
  completedOnTime!: number;

  @Field(() => Float)
  avgCompletionTime!: number;

  @Field(() => Float, {
    deprecationReason: 'Use totalCostDecimal (exact decimal string, ADR-0004).',
  })
  totalCost!: number;

  /** Exact-decimal wire form of `totalCost` (ADR-0004 / DATA-MEDIUM-009). */
  @Field(() => DecimalScalar)
  totalCostDecimal!: number;

  @Field(() => Int)
  draft!: number;

  @Field(() => Int)
  pendingApproval!: number;

  @Field(() => Int)
  approved!: number;

  @Field(() => Int)
  scheduled!: number;

  @Field(() => Int)
  inProgress!: number;

  @Field(() => Int)
  onHold!: number;

  @Field(() => Int)
  completed!: number;

  @Field(() => Int)
  verified!: number;

  @Field(() => Int)
  cancelled!: number;
}

@ObjectType()
export class DeleteWorkOrderResponse {
  @Field()
  success!: boolean;

  @Field(() => ID)
  id!: string;

  @Field({ nullable: true })
  message?: string;
}

// ============================================================================
// RESOLVER
// ============================================================================

@UseGuards(GqlAuthGuard)
@Resolver(() => WorkOrder)
export class WorkOrderResolver {
  private readonly logger = new Logger(WorkOrderResolver.name);

  constructor(
    private readonly workOrderService: WorkOrderService,
    private readonly queryBus: QueryBus,
  ) {}

  // -------------------------------------------------------------------------
  // QUERIES
  // -------------------------------------------------------------------------

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => WorkOrder, { name: 'workOrder' })
  async getWorkOrder(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<WorkOrder> {
    this.logger.debug(`Getting work order: ${id}`);
    return this.queryBus.execute(new GetWorkOrderQuery(tenantId, id));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => WorkOrder, { name: 'workOrderByCode' })
  async getWorkOrderByCode(
    @Args('code') code: string,
    @Tenant() tenantId: string,
  ): Promise<WorkOrder> {
    this.logger.debug(`Getting work order by code: ${code}`);
    return this.queryBus.execute(new GetWorkOrderByCodeQuery(tenantId, code));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => WorkOrderListResponse, { name: 'workOrders' })
  async listWorkOrders(
    @Tenant() tenantId: string,
    @Args('filter', { type: () => WorkOrderFilterInput, nullable: true })
    filter?: WorkOrderFilterInput,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 })
    page?: number,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 })
    limit?: number,
    @Args('sortBy', { nullable: true, defaultValue: 'createdAt' })
    sortBy?: string,
    @Args('sortOrder', { nullable: true, defaultValue: 'DESC' })
    sortOrder?: 'ASC' | 'DESC',
  ): Promise<IStandardPaginatedResult<WorkOrder>> {
    this.logger.debug(`Listing work orders for tenant: ${tenantId}`);
    return this.queryBus.execute(
      new ListWorkOrdersQuery(tenantId, filter, page, limit, sortBy, sortOrder),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [WorkOrder], { name: 'overdueWorkOrders' })
  async getOverdueWorkOrders(
    @Tenant() tenantId: string,
  ): Promise<WorkOrder[]> {
    this.logger.debug(`Getting overdue work orders for tenant: ${tenantId}`);
    return this.queryBus.execute(new ListOverdueWorkOrdersQuery(tenantId));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [WorkOrder], { name: 'myWorkOrders' })
  async getMyWorkOrders(
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
    @Args('activeOnly', { type: () => Boolean, nullable: true, defaultValue: true })
    activeOnly?: boolean,
  ): Promise<WorkOrder[]> {
    this.logger.debug(`Getting work orders for user: ${user.sub}`);
    return this.queryBus.execute(new ListMyWorkOrdersQuery(tenantId, user.sub, activeOnly));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => WorkOrderStatisticsResponse, { name: 'workOrderStatistics' })
  async getWorkOrderStatistics(
    @Tenant() tenantId: string,
    @Args('dateFrom', { nullable: true }) dateFrom?: Date,
    @Args('dateTo', { nullable: true }) dateTo?: Date,
  ): Promise<WorkOrderStatisticsResponse> {
    this.logger.debug(`Getting work order statistics for tenant: ${tenantId}`);
    const stats = await this.queryBus.execute<GetWorkOrderStatisticsQuery, WorkOrderStatistics>(
      new GetWorkOrderStatisticsQuery(tenantId, dateFrom, dateTo),
    );

    return {
      total: stats.total,
      overdue: stats.overdue,
      completedOnTime: stats.completedOnTime,
      avgCompletionTime: stats.avgCompletionTime,
      totalCost: stats.totalCost,
      totalCostDecimal: stats.totalCost,
      draft: stats.byStatus[WorkOrderStatus.DRAFT] || 0,
      pendingApproval: stats.byStatus[WorkOrderStatus.PENDING_APPROVAL] || 0,
      approved: stats.byStatus[WorkOrderStatus.APPROVED] || 0,
      scheduled: stats.byStatus[WorkOrderStatus.SCHEDULED] || 0,
      inProgress: stats.byStatus[WorkOrderStatus.IN_PROGRESS] || 0,
      onHold: stats.byStatus[WorkOrderStatus.ON_HOLD] || 0,
      completed: stats.byStatus[WorkOrderStatus.COMPLETED] || 0,
      verified: stats.byStatus[WorkOrderStatus.VERIFIED] || 0,
      cancelled: stats.byStatus[WorkOrderStatus.CANCELLED] || 0,
    };
  }

  // -------------------------------------------------------------------------
  // MUTATIONS
  // -------------------------------------------------------------------------

  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => WorkOrder)
  async createWorkOrder(
    @Args('input') input: CreateWorkOrderInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<WorkOrder> {
    this.logger.log(`Creating work order: ${input.title}`);
    return this.workOrderService.create(tenantId, input, user.sub);
  }

  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => WorkOrder)
  async updateWorkOrder(
    @Args('input') input: UpdateWorkOrderInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<WorkOrder> {
    this.logger.log(`Updating work order: ${input.id}`);
    return this.workOrderService.update(tenantId, input, user.sub);
  }

  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => DeleteWorkOrderResponse)
  async deleteWorkOrder(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<DeleteWorkOrderResponse> {
    this.logger.log(`Deleting work order: ${id}`);
    await this.workOrderService.delete(tenantId, id);
    return {
      success: true,
      id,
      message: 'İş emri başarıyla silindi',
    };
  }

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @Mutation(() => WorkOrder)
  async submitWorkOrderForApproval(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<WorkOrder> {
    this.logger.log(`Submitting work order for approval: ${id}`);
    return this.workOrderService.submitForApproval(tenantId, id);
  }

  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => WorkOrder)
  async approveWorkOrder(
    @Args('input') input: ApproveWorkOrderInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<WorkOrder> {
    this.logger.log(`Approving work order: ${input.id}`);
    return this.workOrderService.approve(tenantId, input, user.sub);
  }

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @Mutation(() => WorkOrder)
  async startWorkOrder(
    @Args('input') input: StartWorkOrderInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<WorkOrder> {
    this.logger.log(`Starting work order: ${input.id}`);
    return this.workOrderService.start(tenantId, input, user.sub);
  }

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @Mutation(() => WorkOrder)
  async completeWorkOrder(
    @Args('input') input: CompleteWorkOrderInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<WorkOrder> {
    this.logger.log(`Completing work order: ${input.id}`);
    return this.workOrderService.complete(tenantId, input, user.sub);
  }

  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => WorkOrder)
  async verifyWorkOrder(
    @Args('input') input: VerifyWorkOrderInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<WorkOrder> {
    this.logger.log(`Verifying work order: ${input.id}`);
    return this.workOrderService.verify(tenantId, input, user.sub);
  }

  @Roles(Role.MODULE_MANAGER, Role.TENANT_ADMIN)
  @Mutation(() => WorkOrder)
  async cancelWorkOrder(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
    @Args('reason', { nullable: true }) reason?: string,
  ): Promise<WorkOrder> {
    this.logger.log(`Cancelling work order: ${id}`);
    return this.workOrderService.cancel(tenantId, id, reason);
  }

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @Mutation(() => WorkOrder)
  async putWorkOrderOnHold(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
    @Args('reason', { nullable: true }) reason?: string,
  ): Promise<WorkOrder> {
    this.logger.log(`Putting work order on hold: ${id}`);
    return this.workOrderService.putOnHold(tenantId, id, reason);
  }

  @Roles(Role.MODULE_MANAGER, Role.MODULE_USER, Role.TENANT_ADMIN)
  @Mutation(() => WorkOrder)
  async resumeWorkOrder(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<WorkOrder> {
    this.logger.log(`Resuming work order: ${id}`);
    return this.workOrderService.resume(tenantId, id);
  }
}
