import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ReceiveDeliveryCommand } from '../commands/receive-delivery.command';
import { PurchaseOrder, PurchaseOrderStatus, PurchaseOrderCategory } from '../entities/purchase-order.entity';
import { PurchaseOrderItem } from '../entities/purchase-order-item.entity';
import { StorageInventory, StorageItemType } from '../entities/storage-inventory.entity';
import { StockMovement, MovementType } from '../entities/stock-movement.entity';
import { StorageLocation } from '../entities/storage-location.entity';

@CommandHandler(ReceiveDeliveryCommand)
export class ReceiveDeliveryHandler implements ICommandHandler<ReceiveDeliveryCommand, PurchaseOrder> {
  private readonly logger = new Logger(ReceiveDeliveryHandler.name);

  constructor(
    @InjectRepository(PurchaseOrder)
    private readonly poRepository: Repository<PurchaseOrder>,
    @InjectRepository(StorageLocation)
    private readonly locationRepository: Repository<StorageLocation>,
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: ReceiveDeliveryCommand): Promise<PurchaseOrder> {
    const { input, tenantId, userId } = command;

    const po = await this.poRepository.findOne({
      where: { id: input.purchaseOrderId, tenantId, isDeleted: false },
      relations: ['items'],
    });

    if (!po) {
      throw new NotFoundException(`Purchase order "${input.purchaseOrderId}" not found`);
    }

    if (po.status !== PurchaseOrderStatus.ORDERED && po.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED) {
      throw new BadRequestException(`PO must be in ORDERED or PARTIALLY_RECEIVED status to receive delivery`);
    }

    const location = await this.locationRepository.findOne({
      where: { id: input.storageLocationId, tenantId },
    });
    if (!location) {
      throw new NotFoundException(`Storage location "${input.storageLocationId}" not found`);
    }

    // Map category to StorageItemType
    const itemTypeMap: Record<string, StorageItemType> = {
      FEED: StorageItemType.FEED,
      CHEMICAL: StorageItemType.CHEMICAL,
      CONSUMABLE: StorageItemType.CONSUMABLE,
      HEALTHCARE: StorageItemType.HEALTHCARE,
    };
    const storageItemType = itemTypeMap[po.category] || StorageItemType.CONSUMABLE;

    return this.dataSource.transaction(async (manager) => {
      const poItemRepo = manager.getRepository(PurchaseOrderItem);
      const inventoryRepo = manager.getRepository(StorageInventory);
      const movementRepo = manager.getRepository(StockMovement);

      for (const receiveItem of input.items) {
        const poItem = po.items.find(i => i.itemId === receiveItem.itemId);
        if (!poItem) {
          throw new BadRequestException(`Item ${receiveItem.itemId} not found in PO`);
        }

        const newReceived = Number(poItem.quantityReceived) + receiveItem.quantityReceived;
        if (newReceived > Number(poItem.quantity)) {
          throw new BadRequestException(
            `Cannot receive ${receiveItem.quantityReceived} of ${poItem.itemName}. ` +
            `Ordered: ${poItem.quantity}, Already received: ${poItem.quantityReceived}`
          );
        }

        poItem.quantityReceived = newReceived;
        poItem.isFullyReceived = newReceived >= Number(poItem.quantity);
        await poItemRepo.save(poItem);

        // Create stock IN movement
        const movement = movementRepo.create({
          tenantId,
          movementType: MovementType.IN,
          itemType: storageItemType,
          itemId: poItem.itemId,
          itemName: poItem.itemName,
          quantity: receiveItem.quantityReceived,
          unit: poItem.unit,
          toLocationId: input.storageLocationId,
          reference: `PO: ${po.orderNumber}`,
          performedBy: userId,
          performedAt: new Date(),
        });
        await movementRepo.save(movement);

        // Upsert inventory
        let inventory = await inventoryRepo.findOne({
          where: {
            tenantId,
            storageLocationId: input.storageLocationId,
            itemType: storageItemType,
            itemId: poItem.itemId,
            lotNumber: receiveItem.lotNumber ?? undefined,
          },
        });

        if (inventory) {
          inventory.quantity = Number(inventory.quantity) + receiveItem.quantityReceived;
          inventory.updatedBy = userId;
          if (receiveItem.expiryDate) inventory.expiryDate = new Date(receiveItem.expiryDate);
          await inventoryRepo.save(inventory);
        } else {
          inventory = inventoryRepo.create({
            tenantId,
            storageLocationId: input.storageLocationId,
            itemType: storageItemType,
            itemId: poItem.itemId,
            quantity: receiveItem.quantityReceived,
            unit: poItem.unit,
            lotNumber: receiveItem.lotNumber,
            expiryDate: receiveItem.expiryDate ? new Date(receiveItem.expiryDate) : undefined,
            createdBy: userId,
            updatedBy: userId,
          });
          await inventoryRepo.save(inventory);
        }
      }

      // Update PO status
      const allReceived = po.items.every(i => i.isFullyReceived);
      if (allReceived) {
        po.status = PurchaseOrderStatus.RECEIVED;
        po.actualDeliveryDate = new Date();
      } else {
        po.status = PurchaseOrderStatus.PARTIALLY_RECEIVED;
      }

      const savedPO = await manager.getRepository(PurchaseOrder).save(po);
      this.logger.log(`Received delivery for PO ${po.orderNumber}: status=${savedPO.status}`);
      return savedPO;
    });
  }
}
