/**
 * Storage Module - Storage locations, inventory, stock movements, and purchase orders
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';

import { StorageLocation } from './entities/storage-location.entity';
import { StorageInventory } from './entities/storage-inventory.entity';
import { StockMovement } from './entities/stock-movement.entity';
import { PurchaseOrder } from './entities/purchase-order.entity';
import { PurchaseOrderItem } from './entities/purchase-order-item.entity';
import { Site } from '../site/entities/site.entity';
import { Feed } from '../feed/entities/feed.entity';
import { Chemical } from '../chemical/entities/chemical.entity';
import { Consumable } from '../consumable/entities/consumable.entity';

import { StorageResolver } from './storage.resolver';

import { CreateStorageLocationHandler } from './handlers/create-storage-location.handler';
import { UpdateStorageLocationHandler } from './handlers/update-storage-location.handler';
import { DeleteStorageLocationHandler } from './handlers/delete-storage-location.handler';
import { RecordStockMovementHandler } from './handlers/record-stock-movement.handler';
import { TransferStockHandler } from './handlers/transfer-stock.handler';
import { CreatePurchaseOrderHandler } from './handlers/create-purchase-order.handler';
import { UpdatePurchaseOrderStatusHandler } from './handlers/update-purchase-order-status.handler';
import { ReceiveDeliveryHandler } from './handlers/receive-delivery.handler';

import { GetStorageLocationHandler } from './handlers/get-storage-location.handler';
import { ListStorageLocationsHandler } from './handlers/list-storage-locations.handler';
import { GetStorageInventoryHandler } from './handlers/get-storage-inventory.handler';
import { ListStockMovementsHandler } from './handlers/list-stock-movements.handler';
import { GetStorageOverviewHandler } from './handlers/get-storage-overview.handler';
import { ListPurchaseOrdersHandler } from './handlers/list-purchase-orders.handler';
import { GetPurchaseOrderHandler } from './handlers/get-purchase-order.handler';
import { GetPendingDeliveriesHandler } from './handlers/get-pending-deliveries.handler';

const CommandHandlers = [
  CreateStorageLocationHandler,
  UpdateStorageLocationHandler,
  DeleteStorageLocationHandler,
  RecordStockMovementHandler,
  TransferStockHandler,
  CreatePurchaseOrderHandler,
  UpdatePurchaseOrderStatusHandler,
  ReceiveDeliveryHandler,
];

const QueryHandlers = [
  GetStorageLocationHandler,
  ListStorageLocationsHandler,
  GetStorageInventoryHandler,
  ListStockMovementsHandler,
  GetStorageOverviewHandler,
  ListPurchaseOrdersHandler,
  GetPurchaseOrderHandler,
  GetPendingDeliveriesHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([
      StorageLocation,
      StorageInventory,
      StockMovement,
      PurchaseOrder,
      PurchaseOrderItem,
      Site,
      Feed,
      Chemical,
      Consumable,
    ]),
    CqrsModule,
  ],
  providers: [
    StorageResolver,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
  exports: [
    TypeOrmModule,
  ],
})
export class StorageModule {}
