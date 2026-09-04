/**
 * Storage Module - Storage locations, inventory, stock movements, and purchase orders
 */
import { MobileFeatureGuard } from '@aquaculture/backend-common/guards';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { StorageLocation } from './entities/storage-location.entity';
import { StorageInventory } from './entities/storage-inventory.entity';
import { StockMovement } from './entities/stock-movement.entity';
import { PurchaseOrder } from './entities/purchase-order.entity';
import { PurchaseOrderItem } from './entities/purchase-order-item.entity';
import { InventoryCount } from './entities/inventory-count.entity';
import { InventoryCountItem } from './entities/inventory-count-item.entity';
import { StorageLotMix } from './entities/storage-lot-mix.entity';
import { LotMixService } from './services/lot-mix.service';
import { StockMovementService } from './services/stock-movement.service';
import { FeedAllocationService } from './services/feed-allocation.service';
import { StockMutationLockAuthority } from './services/stock-mutation-lock.authority';
import { Site } from '../site/entities/site.entity';
import { Feed } from '../feed/entities/feed.entity';
import { Chemical } from '../chemical/entities/chemical.entity';
import { Consumable } from '../consumable/entities/consumable.entity';
// FinanceModule exports the currency SSoT resolver (FARM-HIGH-151).
import { FinanceModule } from '../finance/finance.module';

import { StorageResolver } from './storage.resolver';
import { InventoryCountResponseResolver } from './resolvers/inventory-count-response.resolver';
import { StorageDecimalResolvers } from './resolvers/storage-decimal.resolver';

import { CreateStorageLocationHandler } from './handlers/create-storage-location.handler';
import { UpdateStorageLocationHandler } from './handlers/update-storage-location.handler';
import { DeleteStorageLocationHandler } from './handlers/delete-storage-location.handler';
import { RecordStockMovementHandler } from './handlers/record-stock-movement.handler';
import { TransferStockHandler } from './handlers/transfer-stock.handler';
import { CreatePurchaseOrderHandler } from './handlers/create-purchase-order.handler';
import { UpdatePurchaseOrderStatusHandler } from './handlers/update-purchase-order-status.handler';
import { ReceiveDeliveryHandler } from './handlers/receive-delivery.handler';
import { CreateInventoryCountHandler } from './handlers/create-inventory-count.handler';
import { UpdateInventoryCountHandler } from './handlers/update-inventory-count.handler';
import { SubmitInventoryCountHandler } from './handlers/submit-inventory-count.handler';
import { ApproveInventoryCountHandler } from './handlers/approve-inventory-count.handler';
import { ApprovePurchaseOrderHandler } from './handlers/approve-purchase-order.handler';

import { GetStorageLocationHandler } from './handlers/get-storage-location.handler';
import { ListStorageLocationsHandler } from './handlers/list-storage-locations.handler';
import { GetStorageInventoryHandler } from './handlers/get-storage-inventory.handler';
import { ListStorageInventoryByCursorHandler } from './handlers/list-storage-inventory-by-cursor.handler';
import { ListStockMovementsHandler } from './handlers/list-stock-movements.handler';
import { GetStorageOverviewHandler } from './handlers/get-storage-overview.handler';
import { GetWarehouseSummaryHandler } from './handlers/get-warehouse-summary.handler';
import { ListPurchaseOrdersHandler } from './handlers/list-purchase-orders.handler';
import { GetPurchaseOrderHandler } from './handlers/get-purchase-order.handler';
import { GetPendingDeliveriesHandler } from './handlers/get-pending-deliveries.handler';
import { ListInventoryCountsHandler } from './handlers/list-inventory-counts.handler';
import { GetInventoryCountHandler } from './handlers/get-inventory-count.handler';
import { GetStorageLocationNameHandler } from './handlers/get-storage-location-name.handler';
import { TraceLotHandler } from './handlers/trace-lot.handler';

const CommandHandlers = [
  CreateStorageLocationHandler,
  UpdateStorageLocationHandler,
  DeleteStorageLocationHandler,
  RecordStockMovementHandler,
  TransferStockHandler,
  CreatePurchaseOrderHandler,
  UpdatePurchaseOrderStatusHandler,
  ApprovePurchaseOrderHandler,
  ReceiveDeliveryHandler,
  CreateInventoryCountHandler,
  UpdateInventoryCountHandler,
  SubmitInventoryCountHandler,
  ApproveInventoryCountHandler,
];

const QueryHandlers = [
  GetStorageLocationHandler,
  ListStorageLocationsHandler,
  GetStorageInventoryHandler,
  ListStorageInventoryByCursorHandler,
  ListStockMovementsHandler,
  GetStorageOverviewHandler,
  GetWarehouseSummaryHandler,
  ListPurchaseOrdersHandler,
  GetPurchaseOrderHandler,
  GetPendingDeliveriesHandler,
  ListInventoryCountsHandler,
  GetInventoryCountHandler,
  GetStorageLocationNameHandler,
  TraceLotHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([
      StorageLocation,
      StorageInventory,
      StockMovement,
      PurchaseOrder,
      PurchaseOrderItem,
      InventoryCount,
      InventoryCountItem,
      StorageLotMix,
      Site,
      Feed,
      Chemical,
      Consumable,
    ]),
    FinanceModule,
  ],
  providers: [
    StorageResolver,
    InventoryCountResponseResolver,
    ...StorageDecimalResolvers,
    LotMixService,
    // StockMovementService holds the inventory-mutation core that
    // RecordStockMovementHandler (here) and the feeding callers both use.
    // Exported so FeedingModule can deduct feed stock INSIDE the feeding
    // transaction (fail-closed, atomic) — see StockMovementService header.
    StockMovementService,
    FeedAllocationService,
    // Fiziksel stok mutasyonlarının TEK kilit protokolü — satır kilidi olmayan
    // (henüz var olmayan) fiziksel anahtarı da kapsar.
    StockMutationLockAuthority,
    // SEC-HIGH-051 / SEC-HIGH-052: site authz SSoT + mobile-feature guard.
    SiteAuthorizationService,
    MobileFeatureGuard,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
  exports: [TypeOrmModule, StockMovementService, FeedAllocationService, StockMutationLockAuthority],
})
export class InventoryModule {}
