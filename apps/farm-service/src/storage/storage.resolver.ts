/**
 * Storage GraphQL Resolver
 */
import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards, Logger } from '@nestjs/common';
import { CommandBus, QueryBus, PaginatedQueryResult } from '@platform/cqrs';
import {
  CurrentTenant,
  CurrentUser,
  Roles,
  Role,
  RequiresMobileFeature,
} from '@aquaculture/backend-common/decorators';
import { TenantGuard, MobileFeatureGuard } from '@aquaculture/backend-common/guards';
import { fromCqrsPaginated, CursorPaginationInput } from '@aquaculture/backend-common/pagination';
import {
  StorageLocationResponse,
  PaginatedStorageLocationsResponse,
} from './dto/storage-location.response';
import { StorageInventoryResponse } from './dto/storage-inventory.response';
import { StorageInventoryCursorConnection } from './dto/storage-inventory-cursor.response';
import {
  StockMovementResponse,
  PaginatedStockMovementsResponse,
} from './dto/stock-movement.response';
import { StorageOverviewResponse } from './dto/storage-overview.response';
import { WarehouseSummaryResponse } from './dto/warehouse-summary.response';
import { CreateStorageLocationInput } from './dto/create-storage-location.input';
import { UpdateStorageLocationInput } from './dto/update-storage-location.input';
import { StorageLocationFilterInput } from './dto/storage-location-filter.input';
import { StockMovementFilterInput } from './dto/stock-movement-filter.input';
import { InventoryCountFilterInput } from './dto/inventory-count-filter.input';
import { RecordStockMovementInput } from './dto/record-stock-movement.input';
import { TransferStockInput } from './dto/transfer-stock.input';
import { PaginationInput } from '../site/dto/site-filter.input';
import { CreateStorageLocationCommand } from './commands/create-storage-location.command';
import {
  UpdateStorageLocationCommand,
  UpdateStorageLocationData,
} from './commands/update-storage-location.command';
import { DeleteStorageLocationCommand } from './commands/delete-storage-location.command';
import { RecordStockMovementCommand } from './commands/record-stock-movement.command';
import { TransferStockCommand } from './commands/transfer-stock.command';
import { GetStorageLocationQuery } from './queries/get-storage-location.query';
import { ListStorageLocationsQuery } from './queries/list-storage-locations.query';
import { GetStorageInventoryQuery } from './queries/get-storage-inventory.query';
import { ListStorageInventoryByCursorQuery } from './queries/list-storage-inventory-by-cursor.query';
import { ListStockMovementsQuery } from './queries/list-stock-movements.query';
import { GetStorageOverviewQuery } from './queries/get-storage-overview.query';
import { GetWarehouseSummaryQuery } from './queries/get-warehouse-summary.query';
import { TraceLotQuery } from './queries/trace-lot.query';
import { StorageItemType } from './entities/storage-inventory.entity';
import {
  PurchaseOrderResponse,
  PaginatedPurchaseOrdersResponse,
} from './dto/purchase-order.response';
import { CreatePurchaseOrderInput } from './dto/create-purchase-order.input';
import { UpdatePurchaseOrderStatusInput } from './dto/update-purchase-order-status.input';
import { ReceiveDeliveryInput } from './dto/receive-delivery.input';
import { CreatePurchaseOrderCommand } from './commands/create-purchase-order.command';
import { UpdatePurchaseOrderStatusCommand } from './commands/update-purchase-order-status.command';
import { ApprovePurchaseOrderCommand } from './commands/approve-purchase-order.command';
import { ReceiveDeliveryCommand } from './commands/receive-delivery.command';
import { ListPurchaseOrdersQuery } from './queries/list-purchase-orders.query';
import { GetPurchaseOrderQuery } from './queries/get-purchase-order.query';
import { GetPendingDeliveriesQuery } from './queries/get-pending-deliveries.query';
import { PurchaseOrderCategory, PurchaseOrderStatus } from './entities/purchase-order.entity';
import {
  InventoryCountResponse,
  PaginatedInventoryCountsResponse,
} from './dto/inventory-count.response';
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
import { IsOptional, IsEnum, IsInt } from 'class-validator';

/**
 * PurchaseOrderFilterInput remains inline because it is only used here
 * and is tightly coupled to the PO query resolver. StockMovementFilterInput
 * and InventoryCountFilterInput were moved to dedicated DTO files (F-10).
 */
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

@Resolver()
// SEC-HIGH-052: MobileFeatureGuard enforces the 'storage' entitlement on the
// stock-movement mutations below (no-op on the other routes).
@UseGuards(TenantGuard, MobileFeatureGuard)
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
    // F-9: Properly typed spread — the `id` is extracted as `locationId` and the
    // remaining fields match UpdateStorageLocationData (Omit<Input, 'id'>).
    const { id, ...updateData }: UpdateStorageLocationInput = input;
    const command = new UpdateStorageLocationCommand(
      id,
      updateData as UpdateStorageLocationData,
      tenantId,
      user.sub,
    );
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

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => StorageLocationResponse, { nullable: true })
  async storageLocation(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<StorageLocationResponse | null> {
    const query = new GetStorageLocationQuery(id, tenantId);
    return this.queryBus.execute(query);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => PaginatedStorageLocationsResponse)
  async storageLocations(
    @Args('filter', { type: () => StorageLocationFilterInput, nullable: true })
    filter: StorageLocationFilterInput | undefined,
    @Args('pagination', { type: () => PaginationInput, nullable: true })
    pagination: PaginationInput | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<PaginatedStorageLocationsResponse> {
    const query = new ListStorageLocationsQuery(tenantId, filter, pagination);
    const result = await this.queryBus.execute<
      ListStorageLocationsQuery,
      PaginatedQueryResult<StorageLocationResponse>
    >(query);
    return fromCqrsPaginated(result);
  }

  // === Storage Inventory ===

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [StorageInventoryResponse])
  async storageInventory(
    @Args('locationId', { type: () => ID, nullable: true }) locationId: string | undefined,
    @Args('itemType', { type: () => StorageItemType, nullable: true })
    itemType: StorageItemType | undefined,
    @Args('limit', { type: () => Int, nullable: true }) limit: number | undefined,
    @Args('offset', { type: () => Int, nullable: true }) offset: number | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<StorageInventoryResponse[]> {
    const query = new GetStorageInventoryQuery(tenantId, locationId, itemType, limit, offset);
    return this.queryBus.execute(query);
  }

  /**
   * Cursor-paginated variant of `storageInventory` — phase 5.1 first
   * adoption. The offset/limit entry above stays in place for the 6-
   * month deprecation window; new UI surfaces (and the mobile app
   * once it updates) request this query for deterministic traversal
   * against concurrent inserts. Large warehouses are the primary
   * beneficiary — offset/limit walked every intervening row under
   * the hood.
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => StorageInventoryCursorConnection)
  async storageInventoryByCursor(
    @Args('locationId', { type: () => ID, nullable: true }) locationId: string | undefined,
    @Args('itemType', { type: () => StorageItemType, nullable: true })
    itemType: StorageItemType | undefined,
    // ORPHAN-CRITICAL-067: CursorPaginationInput is declared
    // `@InputType({ isAbstract: true })` in libs/backend-common/src/pagination/cursor.ts,
    // so the schema builder will not register it as a standalone schema entry
    // without an explicit reference. NestJS's `reflectTypeFromMetadata`
    // (node_modules/@nestjs/graphql/dist/utils/reflection.utilts.js) also
    // throws "Undefined type error" at bootstrap when the implicit
    // `design:paramtypes[2]` for this @Args slot resolves to `Object` —
    // which happens because the parameter is a class type imported across a
    // package boundary (@aquaculture/backend-common/pagination) and the
    // emit-decorator-metadata reflection cannot recover the named class for
    // the cross-package import at this position. The explicit
    // `type: () => CursorPaginationInput` resolver makes the type contract
    // impossible to omit (Tier-1) and pulls the input type into the schema
    // graph via the resolver's args.factory, matching the pattern set by
    // ORPHAN-CRITICAL-064 in PR #250 for CursorEdge<T>.
    @Args('input', { type: () => CursorPaginationInput, nullable: true })
    input: CursorPaginationInput | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<StorageInventoryCursorConnection> {
    const response = await this.queryBus.execute<
      ListStorageInventoryByCursorQuery,
      {
        edges: Array<{ cursor: string; node: unknown }>;
        pageInfo: { endCursor: string | null; hasNextPage: boolean };
      }
    >(new ListStorageInventoryByCursorQuery(tenantId, locationId, itemType, input ?? null));
    return {
      edges: response.edges.map((edge) => ({
        cursor: edge.cursor,
        node: edge.node as StorageInventoryResponse,
      })),
      pageInfo: response.pageInfo,
    };
  }

  // === Stock Movements ===

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @RequiresMobileFeature('storage')
  @Mutation(() => StockMovementResponse)
  async recordStockMovement(
    @Args('input') input: RecordStockMovementInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser()
    user: {
      sub: string;
      firstName?: string;
      lastName?: string;
      roles: Role[];
      assignedSiteIds?: string[];
    },
  ): Promise<StockMovementResponse> {
    // Construct display name from JWT payload for audit trail denormalization.
    // Shows WHO performed the movement in both web panel and mobile app history.
    const userName = [user.firstName, user.lastName].filter(Boolean).join(' ') || undefined;
    const command = new RecordStockMovementCommand(
      input,
      tenantId,
      user.sub,
      userName,
      user.roles,
      user.assignedSiteIds ?? [],
    );
    return this.commandBus.execute(command);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @RequiresMobileFeature('storage')
  @Mutation(() => StockMovementResponse)
  async transferStock(
    @Args('input') input: TransferStockInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser()
    user: {
      sub: string;
      firstName?: string;
      lastName?: string;
      roles: Role[];
      assignedSiteIds?: string[];
    },
  ): Promise<StockMovementResponse> {
    const userName = [user.firstName, user.lastName].filter(Boolean).join(' ') || undefined;
    const command = new TransferStockCommand(
      input,
      tenantId,
      user.sub,
      userName,
      user.roles,
      user.assignedSiteIds ?? [],
    );
    return this.commandBus.execute(command);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => PaginatedStockMovementsResponse)
  async stockMovements(
    @Args('filter', { type: () => StockMovementFilterInput, nullable: true })
    filter: StockMovementFilterInput | undefined,
    @Args('pagination', { type: () => PaginationInput, nullable: true })
    pagination: PaginationInput | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<PaginatedStockMovementsResponse> {
    const query = new ListStockMovementsQuery(tenantId, filter, pagination);
    const result = await this.queryBus.execute<
      ListStockMovementsQuery,
      PaginatedQueryResult<StockMovementResponse>
    >(query);
    return fromCqrsPaginated(result);
  }

  // === Overview ===

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => StorageOverviewResponse)
  async storageOverview(@CurrentTenant() tenantId: string): Promise<StorageOverviewResponse> {
    const query = new GetStorageOverviewQuery(tenantId);
    return this.queryBus.execute(query);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => WarehouseSummaryResponse)
  async warehouseSummary(@CurrentTenant() tenantId: string): Promise<WarehouseSummaryResponse> {
    return this.queryBus.execute(new GetWarehouseSummaryQuery(tenantId));
  }

  // === Lot Traceability ===

  /**
   * Trace all stock movements for a given lot number (EU 178/2002 Article 18).
   *
   * Returns chronological history: delivery IN -> storage TRANSFER -> feeding OUT -> WASTE.
   * Used by farm managers and auditors to answer:
   * - Forward: "Where did lot LOT-2026-0042 go?" (which tanks, feeding events)
   * - Backward: "Where did the feed in Tank A come from?" (supplier, delivery)
   * - Recall: "Find all consumption points for recalled lot X"
   */
  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [StockMovementResponse], {
    description: 'Trace all stock movements for a lot number (regulatory traceability)',
  })
  async traceLot(
    @Args('lotNumber', { type: () => String }) lotNumber: string,
    @CurrentTenant() tenantId: string,
  ): Promise<StockMovementResponse[]> {
    const query = new TraceLotQuery(lotNumber, tenantId);
    return this.queryBus.execute(query);
  }

  // === Purchase Orders ===

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => PaginatedPurchaseOrdersResponse)
  async purchaseOrders(
    @Args('filter', { type: () => PurchaseOrderFilterInput, nullable: true })
    filter: PurchaseOrderFilterInput | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<PaginatedPurchaseOrdersResponse> {
    const query = new ListPurchaseOrdersQuery(
      tenantId,
      filter?.category,
      filter?.status,
      filter?.page,
      filter?.limit,
    );
    const result = await this.queryBus.execute<
      ListPurchaseOrdersQuery,
      PaginatedQueryResult<PurchaseOrderResponse>
    >(query);
    return fromCqrsPaginated(result);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => PurchaseOrderResponse, { nullable: true })
  async purchaseOrder(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
  ): Promise<PurchaseOrderResponse> {
    const query = new GetPurchaseOrderQuery(id, tenantId);
    return this.queryBus.execute(query);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => [PurchaseOrderResponse])
  async pendingDeliveries(@CurrentTenant() tenantId: string): Promise<PurchaseOrderResponse[]> {
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

  // Maker-checker approval gate (SOC2 CC3.4). TENANT_ADMIN only — a MODULE_MANAGER
  // can submit (DRAFT -> SUBMITTED) via updatePurchaseOrderStatus but cannot approve,
  // and the handler additionally blocks self-approval (createdBy === userId).
  @Roles(Role.TENANT_ADMIN)
  @Mutation(() => PurchaseOrderResponse)
  async approvePurchaseOrder(
    @Args('id', { type: () => ID }) id: string,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string; firstName?: string; lastName?: string },
  ): Promise<PurchaseOrderResponse> {
    const userName = [user.firstName, user.lastName].filter(Boolean).join(' ') || undefined;
    const command = new ApprovePurchaseOrderCommand(id, tenantId, user.sub, userName);
    return this.commandBus.execute(command);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER)
  @Mutation(() => PurchaseOrderResponse)
  async receiveDelivery(
    @Args('input') input: ReceiveDeliveryInput,
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: { sub: string; roles: Role[]; assignedSiteIds?: string[] },
  ): Promise<PurchaseOrderResponse> {
    // SEC-HIGH-051: forward the caller's authz context so the stock-movement
    // sink can assert site assignment on the receiving location (mirrors
    // recordStockMovement).
    const command = new ReceiveDeliveryCommand(
      input,
      tenantId,
      user.sub,
      user.roles,
      user.assignedSiteIds ?? [],
    );
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

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
  @Query(() => PaginatedInventoryCountsResponse)
  async inventoryCounts(
    @Args('filter', { type: () => InventoryCountFilterInput, nullable: true })
    filter: InventoryCountFilterInput | undefined,
    @CurrentTenant() tenantId: string,
  ): Promise<PaginatedInventoryCountsResponse> {
    const query = new ListInventoryCountsQuery(
      tenantId,
      filter?.status,
      filter?.locationId,
      filter?.page,
      filter?.limit,
    );
    const result = await this.queryBus.execute<
      ListInventoryCountsQuery,
      PaginatedQueryResult<InventoryCountResponse>
    >(query);
    return fromCqrsPaginated(result);
  }

  @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER)
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
