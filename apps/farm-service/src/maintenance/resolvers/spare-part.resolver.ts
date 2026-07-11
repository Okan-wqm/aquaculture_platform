/**
 * SparePart GraphQL Resolver
 *
 * Yedek parça stok yönetimi ve envanter takibi için GraphQL API.
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
  InputType,
  Field,
  Int,
  Float,
  registerEnumType,
} from '@nestjs/graphql';
import { Logger, UseGuards } from '@nestjs/common';
import { GqlAuthGuard } from '../../common/guards/gql-auth.guard';
import { Tenant, CurrentUser, Roles, Role } from '@aquaculture/backend-common/decorators';
import { StandardPaginatedResponse, IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { SparePart, SparePartStatus } from '../entities/spare-part.entity';
import {
  SparePartService,
  LowStockAlert,
  StockSummary,
} from '../services/spare-part.service';
import { QueryBus } from '@platform/cqrs';
import { GetSparePartQuery } from '../queries/get-spare-part.query';
import { GetSparePartByCodeQuery } from '../queries/get-spare-part-by-code.query';
import { GetSparePartByPartNumberQuery } from '../queries/get-spare-part-by-part-number.query';
import { ListSparePartsQuery } from '../queries/list-spare-parts.query';
import { ListLowStockAlertsQuery } from '../queries/list-low-stock-alerts.query';
import { ListSparePartsByEquipmentTypeQuery } from '../queries/list-spare-parts-by-equipment-type.query';
import { GetStockSummaryQuery } from '../queries/get-stock-summary.query';
import {
  CreateSparePartInput,
  UpdateSparePartInput,
  StockMovementInput,
  SparePartFilterInput,
} from '../dto/spare-part.dto';

// Register enums for GraphQL
registerEnumType(SparePartStatus, {
  name: 'SparePartStatus',
  description: 'Yedek parça stok durumu',
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
export class SparePartListResponse extends StandardPaginatedResponse(SparePart) {}

@ObjectType()
export class LowStockAlertResponse {
  @Field(() => SparePart)
  sparePart!: SparePart;

  @Field(() => Int)
  currentQuantity!: number;

  @Field(() => Int)
  minStock!: number;

  @Field(() => Int)
  reorderPoint!: number;

  @Field(() => Int)
  deficit!: number;
}

@ObjectType()
export class StockSummaryResponse {
  @Field(() => Int)
  totalParts!: number;

  @Field(() => Float)
  totalValue!: number;

  @Field(() => Int)
  lowStockCount!: number;

  @Field(() => Int)
  outOfStockCount!: number;

  @Field(() => Int)
  inStockCount!: number;

  @Field(() => Int)
  onOrderCount!: number;

  @Field(() => Int)
  discontinuedCount!: number;
}

@ObjectType()
export class DeleteSparePartResponse {
  @Field()
  success!: boolean;

  @Field(() => ID)
  id!: string;

  @Field({ nullable: true })
  message?: string;
}

@InputType('BulkStockInItemInput')
export class BulkStockInItemInput {
  @Field(() => ID)
  sparePartId!: string;

  @Field(() => Int)
  quantity!: number;

  @Field({ nullable: true })
  notes?: string;
}

// ============================================================================
// RESOLVER
// ============================================================================

@UseGuards(GqlAuthGuard)
@Resolver(() => SparePart)
export class SparePartResolver {
  private readonly logger = new Logger(SparePartResolver.name);

  constructor(
    private readonly sparePartService: SparePartService,
    private readonly queryBus: QueryBus,
  ) {}

  // -------------------------------------------------------------------------
  // QUERIES
  // -------------------------------------------------------------------------

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => SparePart, { name: 'sparePart' })
  async getSparePart(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<SparePart> {
    this.logger.debug(`Getting spare part: ${id}`);
    return this.queryBus.execute(new GetSparePartQuery(tenantId, id));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => SparePart, { name: 'sparePartByCode' })
  async getSparePartByCode(
    @Args('code') code: string,
    @Tenant() tenantId: string,
  ): Promise<SparePart> {
    this.logger.debug(`Getting spare part by code: ${code}`);
    return this.queryBus.execute(new GetSparePartByCodeQuery(tenantId, code));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => SparePart, { name: 'sparePartByPartNumber' })
  async getSparePartByPartNumber(
    @Args('partNumber') partNumber: string,
    @Tenant() tenantId: string,
  ): Promise<SparePart> {
    this.logger.debug(`Getting spare part by part number: ${partNumber}`);
    return this.queryBus.execute(new GetSparePartByPartNumberQuery(tenantId, partNumber));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => SparePartListResponse, { name: 'spareParts' })
  async listSpareParts(
    @Tenant() tenantId: string,
    @Args('filter', { type: () => SparePartFilterInput, nullable: true })
    filter?: SparePartFilterInput,
    @Args('page', { type: () => Int, nullable: true, defaultValue: 1 })
    page?: number,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 20 })
    limit?: number,
    @Args('sortBy', { nullable: true, defaultValue: 'name' })
    sortBy?: string,
    @Args('sortOrder', { nullable: true, defaultValue: 'ASC' })
    sortOrder?: 'ASC' | 'DESC',
  ): Promise<IStandardPaginatedResult<SparePart>> {
    this.logger.debug(`Listing spare parts for tenant: ${tenantId}`);
    return this.queryBus.execute(
      new ListSparePartsQuery(tenantId, filter, page, limit, sortBy, sortOrder),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [LowStockAlertResponse], { name: 'lowStockAlerts' })
  async getLowStockAlerts(
    @Tenant() tenantId: string,
  ): Promise<LowStockAlertResponse[]> {
    this.logger.debug(`Getting low stock alerts for tenant: ${tenantId}`);
    const alerts = await this.queryBus.execute<ListLowStockAlertsQuery, LowStockAlert[]>(
      new ListLowStockAlertsQuery(tenantId),
    );

    return alerts.map((alert) => ({
      sparePart: alert.sparePart,
      currentQuantity: alert.currentQuantity,
      minStock: alert.minStock,
      reorderPoint: alert.reorderPoint,
      deficit: alert.deficit,
    }));
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [SparePart], { name: 'sparePartsByEquipmentType' })
  async getSparePartsByEquipmentType(
    @Args('equipmentTypeId', { type: () => ID }) equipmentTypeId: string,
    @Tenant() tenantId: string,
  ): Promise<SparePart[]> {
    this.logger.debug(`Getting spare parts for equipment type: ${equipmentTypeId}`);
    return this.queryBus.execute(
      new ListSparePartsByEquipmentTypeQuery(tenantId, equipmentTypeId),
    );
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => StockSummaryResponse, { name: 'stockSummary' })
  async getStockSummary(
    @Tenant() tenantId: string,
  ): Promise<StockSummaryResponse> {
    this.logger.debug(`Getting stock summary for tenant: ${tenantId}`);
    const summary = await this.queryBus.execute<GetStockSummaryQuery, StockSummary>(
      new GetStockSummaryQuery(tenantId),
    );

    return {
      totalParts: summary.totalParts,
      totalValue: summary.totalValue,
      lowStockCount: summary.lowStockCount,
      outOfStockCount: summary.outOfStockCount,
      inStockCount: summary.byStatus[SparePartStatus.IN_STOCK] || 0,
      onOrderCount: summary.byStatus[SparePartStatus.ON_ORDER] || 0,
      discontinuedCount: summary.byStatus[SparePartStatus.DISCONTINUED] || 0,
    };
  }

  // -------------------------------------------------------------------------
  // MUTATIONS
  // -------------------------------------------------------------------------

  @Mutation(() => SparePart)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async createSparePart(
    @Args('input') input: CreateSparePartInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<SparePart> {
    this.logger.log(`Creating spare part: ${input.name}`);
    return this.sparePartService.create(tenantId, input, user.sub);
  }

  @Mutation(() => SparePart)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async updateSparePart(
    @Args('input') input: UpdateSparePartInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<SparePart> {
    this.logger.log(`Updating spare part: ${input.id}`);
    return this.sparePartService.update(tenantId, input, user.sub);
  }

  @Mutation(() => DeleteSparePartResponse)
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async deleteSparePart(
    @Args('id', { type: () => ID }) id: string,
    @Tenant() tenantId: string,
  ): Promise<DeleteSparePartResponse> {
    this.logger.log(`Deleting spare part: ${id}`);
    await this.sparePartService.delete(tenantId, id);
    return {
      success: true,
      id,
      message: 'Yedek parça başarıyla silindi',
    };
  }

  /**
   * Phase 6.1 rename: this was declared as `recordStockMovement`
   * which collided with `storage.resolver.ts:recordStockMovement`
   * (the inventory mutation). GraphQL federation only registers one
   * of two colliding operation names, so one of these mutations
   * silently became unreachable at the federation edge. Renaming
   * the spare-part version to `recordSparePartStockMovement`
   * disambiguates the two endpoints and lets the permission matrix
   * surface per-operation authorisation cleanly.
   */
  @Mutation(() => SparePart, { name: 'recordSparePartStockMovement' })
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async recordStockMovement(
    @Args('input') input: StockMovementInput,
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
  ): Promise<SparePart> {
    this.logger.log(
      `Recording spare-part stock movement: ${input.sparePartId} - ${input.movementType} ${input.quantity}`,
    );
    return this.sparePartService.recordStockMovement(tenantId, input, user.sub);
  }

  @Mutation(() => [SparePart])
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  async bulkStockIn(
    @Args('items', { type: () => [BulkStockInItemInput] })
    items: { sparePartId: string; quantity: number; notes?: string }[],
    @Tenant() tenantId: string,
    @CurrentUser() user: UserContext,
    @Args('reason', { nullable: true }) reason?: string,
  ): Promise<SparePart[]> {
    this.logger.log(`Bulk stock in: ${items.length} items`);
    return this.sparePartService.bulkStockIn(tenantId, items, user.sub, reason);
  }
}
