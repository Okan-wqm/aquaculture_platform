/**
 * Storage GraphQL Resolver
 */
import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { CommandBus, QueryBus, PaginatedQueryResult } from '@platform/cqrs';
import { TenantGuard, CurrentTenant, CurrentUser, Roles, Role, fromCqrsPaginated } from '@aquaculture/backend-common';
import { StorageLocationResponse, PaginatedStorageLocationsResponse } from './dto/storage-location.response';
import { StorageInventoryResponse } from './dto/storage-inventory.response';
import { StockMovementResponse, PaginatedStockMovementsResponse } from './dto/stock-movement.response';
import { StorageOverviewResponse } from './dto/storage-overview.response';
import { CreateStorageLocationInput } from './dto/create-storage-location.input';
import { UpdateStorageLocationInput } from './dto/update-storage-location.input';
import { StorageLocationFilterInput } from './dto/storage-location-filter.input';
import { RecordStockMovementInput } from './dto/record-stock-movement.input';
import { TransferStockInput } from './dto/transfer-stock.input';
import { PaginationInput } from '../site/dto/site-filter.input';
import { CreateStorageLocationCommand } from './commands/create-storage-location.command';
import { UpdateStorageLocationCommand } from './commands/update-storage-location.command';
import { DeleteStorageLocationCommand } from './commands/delete-storage-location.command';
import { RecordStockMovementCommand } from './commands/record-stock-movement.command';
import { TransferStockCommand } from './commands/transfer-stock.command';
import { GetStorageLocationQuery } from './queries/get-storage-location.query';
import { ListStorageLocationsQuery } from './queries/list-storage-locations.query';
import { GetStorageInventoryQuery } from './queries/get-storage-inventory.query';
import { ListStockMovementsQuery } from './queries/list-stock-movements.query';
import { GetStorageOverviewQuery } from './queries/get-storage-overview.query';
import { StorageItemType } from './entities/storage-inventory.entity';
import { PurchaseOrderResponse, PaginatedPurchaseOrdersResponse } from './dto/purchase-order.response';
import { CreatePurchaseOrderInput } from './dto/create-purchase-order.input';
import { UpdatePurchaseOrderStatusInput } from './dto/update-purchase-order-status.input';
import { ReceiveDeliveryInput } from './dto/receive-delivery.input';
import { CreatePurchaseOrderCommand } from './commands/create-purchase-order.command';
import { UpdatePurchaseOrderStatusCommand } from './commands/update-purchase-order-status.command';
import { ReceiveDeliveryCommand } from './commands/receive-delivery.command';
import { ListPurchaseOrdersQuery } from './queries/list-purchase-orders.query';
import { GetPurchaseOrderQuery } from './queries/get-purchase-order.query';
import { GetPendingDeliveriesQuery } from './queries/get-pending-deliveries.query';
import { PurchaseOrderCategory, PurchaseOrderStatus } from './entities/purchase-order.entity';
import { InventoryCountResponse, PaginatedInventoryCountsResponse } from './dto/inventory-count.response';
import { CreateInventoryCountInput } from './dto/create-inventory-count.input';
import { UpdateInventoryCountItemsInput } from './dto/update-inventory-count-items.input';
import { CreateInventoryCountCommand } from './commands/create-inventory-count.command';
import { UpdateInventoryCountCommand } from './commands/update-inventory-count.command';
import { SubmitInventoryCountCommand } from './commands/submit-inventory-count.command';
import { ApproveInventoryCountCommand } from './commands/approve-inventory-count.command';
import { ListInventoryCountsQuery } from './queries/list-inventory-counts.query';
import { GetInventoryCountQuery } from './queries/get-inventory-count.query';
import { InventoryCountStatus } from './entities/inventory-count.entity';
import { InputType, Field, Int } from '@nestjs/graphql';
import { IsOptional, IsString, IsEnum, IsUUID, IsInt } from 'class-validator';

@InputType()
export class StockMovementFilterInput {
  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  movementType?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  itemType?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  itemId?: string;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @Field({ nullable: true })
  @IsOptional()
  fromDate?: Date;

  @Field({ nullable: true })
  @IsOptional()
  toDate?: Date;
}

@InputType()
export class PurchaseOrderFilterInput {
  @Field(() => PurchaseOrderCategory, { nullable: true })
  @IsOptional()
  @IsEnum(PurchaseOrderCategory)
  category?: PurchaseOrderCategory;

  @Field(() => PurchaseOrderStatus, { nullable: true })
  @IsOptional()
  @IsEnum(PurchaseOrderStatus)
  status?: PurchaseOrderStatus;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  page?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  limit?: number;
}

@InputType()
export class InventoryCountFilterInput {
  @Field(() => InventoryCountStatus, { nullable: true })
  @IsOptional()
  @IsEnum(InventoryCountStatus)
  status?: InventoryCountStatus;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  page?: number;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  @IsInt()
  limit?: number;
}

@Resolver()
@UseGuards(TenantGuard)
export class StorageResolver {
  private readonly logger = new Logger(StorageResolver.name);

  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  // === Storage Locations ===

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => StorageLocationResponse)
  async createStorageLocation(
    @Args('input') input: CreateStorageLocationInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<StorageLocationResponse> {
    const command = new CreateStorageLocationCommand(input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => StorageLocationResponse)
  async updateStorageLocation(
    @Args('input') input: UpdateStorageLocationInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<StorageLocationResponse> {
    const { id, ...updateData } = input;
    const command = new UpdateStorageLocationCommand(id, updateData as any, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => Boolean)
  async deleteStorageLocation(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<boolean> {
    const command = new DeleteStorageLocationCommand(id, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  @Query(() => StorageLocationResponse, { nullable: true })
  async storageLocation(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<StorageLocationResponse | null> {
    const query = new GetStorageLocationQuery(id, tenantId);
    return this.queryBus.execute(query);
  }

  @Query(() => PaginatedStorageLocationsResponse)
  async storageLocations(
    @Args('filter', { type: () => StorageLocationFilterInput, nullable: true }) filter: StorageLocationFilterInput | undefined,
    @Args('pagination', { type: () => PaginationInput, nullable: true }) pagination: PaginationInput | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<PaginatedStorageLocationsResponse> {
    const query = new ListStorageLocationsQuery(tenantId, filter, pagination);
    const result = await this.queryBus.execute<ListStorageLocationsQuery, PaginatedQueryResult<StorageLocationResponse>>(query);
    return fromCqrsPaginated(result);
  }

  // === Storage Inventory ===

  @Query(() => [StorageInventoryResponse])
  async storageInventory(
    @Args('locationId', { type: () => ID, nullable: true }) locationId: string | undefined,
    @Args('itemType', { type: () => StorageItemType, nullable: true }) itemType: StorageItemType | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<StorageInventoryResponse[]> {
    const query = new GetStorageInventoryQuery(tenantId, locationId, itemType);
    return this.queryBus.execute(query);
  }

  // === Stock Movements ===

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Mutation(() => StockMovementResponse)
  async recordStockMovement(
    @Args('input') input: RecordStockMovementInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string; firstName?: string; lastName?: string },
  ): Promise<StockMovementResponse> {
    // Construct display name from JWT payload for audit trail denormalization.
    // Shows WHO performed the movement in both web panel and mobile app history.
    const userName = [user.firstName, user.lastName].filter(Boolean).join(' ') || undefined;
    const command = new RecordStockMovementCommand(input, tenantId, user.sub, userName);
    return this.commandBus.execute(command);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Mutation(() => StockMovementResponse)
  async transferStock(
    @Args('input') input: TransferStockInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string; firstName?: string; lastName?: string },
  ): Promise<StockMovementResponse> {
    const userName = [user.firstName, user.lastName].filter(Boolean).join(' ') || undefined;
    const command = new TransferStockCommand(input, tenantId, user.sub, userName);
    return this.commandBus.execute(command);
  }

  @Query(() => PaginatedStockMovementsResponse)
  async stockMovements(
    @Args('filter', { type: () => StockMovementFilterInput, nullable: true }) filter: StockMovementFilterInput | undefined,
    @Args('pagination', { type: () => PaginationInput, nullable: true }) pagination: PaginationInput | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<PaginatedStockMovementsResponse> {
    const query = new ListStockMovementsQuery(tenantId, filter, pagination);
    const result = await this.queryBus.execute<ListStockMovementsQuery, PaginatedQueryResult<StockMovementResponse>>(query);
    return fromCqrsPaginated(result);
  }

  // === Overview ===

  @Query(() => StorageOverviewResponse)
  async storageOverview(
    @CurrentTenant() tenantId: string,
  ): Promise<StorageOverviewResponse> {
    const query = new GetStorageOverviewQuery(tenantId);
    return this.queryBus.execute(query);
  }

  // === Purchase Orders ===

  @Query(() => PaginatedPurchaseOrdersResponse)
  async purchaseOrders(
    @Args('filter', { type: () => PurchaseOrderFilterInput, nullable: true }) filter: PurchaseOrderFilterInput | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<PaginatedPurchaseOrdersResponse> {
    const query = new ListPurchaseOrdersQuery(
      tenantId,
      filter?.category,
      filter?.status,
      filter?.page,
      filter?.limit,
    );
    const result = await this.queryBus.execute<ListPurchaseOrdersQuery, PaginatedQueryResult<PurchaseOrderResponse>>(query);
    return fromCqrsPaginated(result);
  }

  @Query(() => PurchaseOrderResponse, { nullable: true })
  async purchaseOrder(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<PurchaseOrderResponse> {
    const query = new GetPurchaseOrderQuery(id, tenantId);
    return this.queryBus.execute(query);
  }

  @Query(() => [PurchaseOrderResponse])
  async pendingDeliveries(
    @CurrentTenant() tenantId: string,
  ): Promise<PurchaseOrderResponse[]> {
    const query = new GetPendingDeliveriesQuery(tenantId);
    return this.queryBus.execute(query);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => PurchaseOrderResponse)
  async createPurchaseOrder(
    @Args('input') input: CreatePurchaseOrderInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<PurchaseOrderResponse> {
    const command = new CreatePurchaseOrderCommand(input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => PurchaseOrderResponse)
  async updatePurchaseOrderStatus(
    @Args('input') input: UpdatePurchaseOrderStatusInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<PurchaseOrderResponse> {
    const command = new UpdatePurchaseOrderStatusCommand(input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => PurchaseOrderResponse)
  async receiveDelivery(
    @Args('input') input: ReceiveDeliveryInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<PurchaseOrderResponse> {
    const command = new ReceiveDeliveryCommand(input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => PurchaseOrderResponse)
  async cancelPurchaseOrder(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<PurchaseOrderResponse> {
    const input = { id, status: PurchaseOrderStatus.CANCELLED } as UpdatePurchaseOrderStatusInput;
    const command = new UpdatePurchaseOrderStatusCommand(input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  // === Inventory Counts ===

  @Query(() => PaginatedInventoryCountsResponse)
  async inventoryCounts(
    @Args('filter', { type: () => InventoryCountFilterInput, nullable: true }) filter: InventoryCountFilterInput | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<PaginatedInventoryCountsResponse> {
    const query = new ListInventoryCountsQuery(
      tenantId,
      filter?.status,
      filter?.locationId,
      filter?.page,
      filter?.limit,
    );
    const result = await this.queryBus.execute<ListInventoryCountsQuery, PaginatedQueryResult<InventoryCountResponse>>(query);
    return fromCqrsPaginated(result);
  }

  @Query(() => InventoryCountResponse, { nullable: true })
  async inventoryCount(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<InventoryCountResponse> {
    const query = new GetInventoryCountQuery(id, tenantId);
    return this.queryBus.execute(query);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => InventoryCountResponse)
  async createInventoryCount(
    @Args('input') input: CreateInventoryCountInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string; firstName?: string; lastName?: string },
  ): Promise<InventoryCountResponse> {
    const userName = [user.firstName, user.lastName].filter(Boolean).join(' ') || undefined;
    const command = new CreateInventoryCountCommand(input, tenantId, user.sub, userName);
    return this.commandBus.execute(command);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Mutation(() => InventoryCountResponse)
  async updateInventoryCountItems(
    @Args('input') input: UpdateInventoryCountItemsInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<InventoryCountResponse> {
    const command = new UpdateInventoryCountCommand(input, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => InventoryCountResponse)
  async submitInventoryCount(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string },
  ): Promise<InventoryCountResponse> {
    const command = new SubmitInventoryCountCommand(id, tenantId, user.sub);
    return this.commandBus.execute(command);
  }

  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => InventoryCountResponse)
  async approveInventoryCount(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string; firstName?: string; lastName?: string },
  ): Promise<InventoryCountResponse> {
    const userName = [user.firstName, user.lastName].filter(Boolean).join(' ') || undefined;
    const command = new ApproveInventoryCountCommand(id, tenantId, user.sub, userName);
    return this.commandBus.execute(command);
  }
}
