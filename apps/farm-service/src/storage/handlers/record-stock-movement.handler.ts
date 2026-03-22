import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { RecordStockMovementCommand } from '../commands/record-stock-movement.command';
import { StorageLocation } from '../entities/storage-location.entity';
import { StorageInventory, StorageItemType } from '../entities/storage-inventory.entity';
import { StockMovement, MovementType } from '../entities/stock-movement.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { Chemical } from '../../chemical/entities/chemical.entity';
import { Consumable } from '../../consumable/entities/consumable.entity';
import { ConditionWarning } from '../dto/stock-movement.response';

@CommandHandler(RecordStockMovementCommand)
export class RecordStockMovementHandler implements ICommandHandler<RecordStockMovementCommand, StockMovement> {
  private readonly logger = new Logger(RecordStockMovementHandler.name);

  constructor(
    @InjectRepository(StorageLocation)
    private readonly locationRepository: Repository<StorageLocation>,
    @InjectRepository(StorageInventory)
    private readonly inventoryRepository: Repository<StorageInventory>,
    @InjectRepository(StockMovement)
    private readonly movementRepository: Repository<StockMovement>,
    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,
    @InjectRepository(Chemical)
    private readonly chemicalRepository: Repository<Chemical>,
    @InjectRepository(Consumable)
    private readonly consumableRepository: Repository<Consumable>,
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: RecordStockMovementCommand): Promise<StockMovement & { warnings?: ConditionWarning[] }> {
    const { input, tenantId, userId } = command;
    const { movementType, itemType, itemId, quantity } = input;

    this.logger.log(`Recording ${movementType} movement for ${itemType} ${itemId}`);

    if (quantity <= 0) {
      throw new BadRequestException('Quantity must be positive');
    }

    // Get item details
    const itemDetails = await this.getItemDetails(itemType as StorageItemType, itemId, tenantId);
    if (!itemDetails) {
      throw new NotFoundException(`${itemType} with ID "${itemId}" not found`);
    }

    // Validate locations based on movement type
    let fromLocation: StorageLocation | null = null;
    let toLocation: StorageLocation | null = null;

    if (movementType === MovementType.IN || movementType === MovementType.RETURN) {
      if (!input.toLocationId) {
        throw new BadRequestException(`toLocationId is required for ${movementType} movements`);
      }
      toLocation = await this.locationRepository.findOne({
        where: { id: input.toLocationId, tenantId },
      });
      if (!toLocation) {
        throw new NotFoundException(`Storage location "${input.toLocationId}" not found`);
      }
    }

    if (movementType === MovementType.OUT || movementType === MovementType.WASTE) {
      if (!input.fromLocationId) {
        throw new BadRequestException(`fromLocationId is required for ${movementType} movements`);
      }
      fromLocation = await this.locationRepository.findOne({
        where: { id: input.fromLocationId, tenantId },
      });
      if (!fromLocation) {
        throw new NotFoundException(`Storage location "${input.fromLocationId}" not found`);
      }
    }

    if (movementType === MovementType.ADJUSTMENT) {
      if (!input.toLocationId && !input.fromLocationId) {
        throw new BadRequestException('Either fromLocationId or toLocationId is required for adjustments');
      }
      if (input.toLocationId) {
        toLocation = await this.locationRepository.findOne({
          where: { id: input.toLocationId, tenantId },
        });
      }
      if (input.fromLocationId) {
        fromLocation = await this.locationRepository.findOne({
          where: { id: input.fromLocationId, tenantId },
        });
      }
    }

    // Check condition warnings for IN movements
    const warnings: ConditionWarning[] = [];
    if (toLocation && (movementType === MovementType.IN || movementType === MovementType.RETURN)) {
      this.checkConditionWarnings(itemDetails, toLocation, warnings);
    }

    // Execute in transaction
    return this.dataSource.transaction(async (manager) => {
      const inventoryRepo = manager.getRepository(StorageInventory);
      const movementRepo = manager.getRepository(StockMovement);

      // Update inventory based on movement type
      if (fromLocation) {
        await this.decreaseInventory(
          inventoryRepo, tenantId, fromLocation.id,
          itemType as StorageItemType, itemId, quantity, itemDetails.unit,
          input.lotNumber, userId,
        );
      }

      if (toLocation) {
        await this.increaseInventory(
          inventoryRepo, tenantId, toLocation.id,
          itemType as StorageItemType, itemId, quantity, itemDetails.unit,
          input.lotNumber, input.expiryDate, userId,
        );
      }

      // Update item total quantity
      await this.updateItemTotalQuantity(manager, itemType as StorageItemType, itemId, tenantId);

      // Create movement record
      const movement = movementRepo.create({
        tenantId,
        movementType,
        itemType,
        itemId,
        itemName: itemDetails.name,
        quantity,
        unit: itemDetails.unit,
        fromLocationId: input.fromLocationId,
        toLocationId: input.toLocationId,
        reference: input.reference,
        reason: input.reason,
        performedBy: userId,
        performedAt: new Date(),
      });

      const saved = await movementRepo.save(movement);

      // Return with warnings
      return Object.assign(saved, { warnings: warnings.length > 0 ? warnings : undefined });
    });
  }

  private async getItemDetails(
    itemType: StorageItemType, itemId: string, tenantId: string,
  ): Promise<{ name: string; unit: string; storageTempMin?: number; storageTempMax?: number; storageHumidityMin?: number; storageHumidityMax?: number } | null> {
    switch (itemType) {
      case StorageItemType.FEED: {
        const feed = await this.feedRepository.findOne({ where: { id: itemId, tenantId } });
        return feed ? { name: feed.name, unit: feed.unit, storageTempMin: feed.storageTempMin, storageTempMax: feed.storageTempMax, storageHumidityMin: feed.storageHumidityMin, storageHumidityMax: feed.storageHumidityMax } : null;
      }
      case StorageItemType.CHEMICAL: {
        const chem = await this.chemicalRepository.findOne({ where: { id: itemId, tenantId } });
        return chem ? { name: chem.name, unit: chem.unit, storageTempMin: (chem as any).storageTempMin, storageTempMax: (chem as any).storageTempMax, storageHumidityMin: (chem as any).storageHumidityMin, storageHumidityMax: (chem as any).storageHumidityMax } : null;
      }
      case StorageItemType.CONSUMABLE: {
        const cons = await this.consumableRepository.findOne({ where: { id: itemId, tenantId } });
        return cons ? { name: cons.name, unit: cons.unit, storageTempMin: cons.storageTempMin, storageTempMax: cons.storageTempMax, storageHumidityMin: cons.storageHumidityMin, storageHumidityMax: cons.storageHumidityMax } : null;
      }
      default:
        return null;
    }
  }

  private checkConditionWarnings(
    item: { storageTempMin?: number; storageTempMax?: number; storageHumidityMin?: number; storageHumidityMax?: number },
    location: StorageLocation,
    warnings: ConditionWarning[],
  ): void {
    // Temperature check
    if (item.storageTempMin != null || item.storageTempMax != null) {
      if (location.temperatureMin != null || location.temperatureMax != null) {
        const locMin = location.temperatureMin ?? -Infinity;
        const locMax = location.temperatureMax ?? Infinity;
        const itemMin = item.storageTempMin ?? -Infinity;
        const itemMax = item.storageTempMax ?? Infinity;

        if (locMin > itemMax || locMax < itemMin) {
          warnings.push({
            field: 'temperature',
            message: `Item requires ${item.storageTempMin ?? '?'}-${item.storageTempMax ?? '?'}°C but location provides ${location.temperatureMin ?? '?'}-${location.temperatureMax ?? '?'}°C`,
            itemMin: item.storageTempMin,
            itemMax: item.storageTempMax,
            locationMin: location.temperatureMin,
            locationMax: location.temperatureMax,
          });
        }
      }
    }

    // Humidity check
    if (item.storageHumidityMin != null || item.storageHumidityMax != null) {
      if (location.humidityMin != null || location.humidityMax != null) {
        const locMin = location.humidityMin ?? 0;
        const locMax = location.humidityMax ?? 100;
        const itemMin = item.storageHumidityMin ?? 0;
        const itemMax = item.storageHumidityMax ?? 100;

        if (locMin > itemMax || locMax < itemMin) {
          warnings.push({
            field: 'humidity',
            message: `Item requires ${item.storageHumidityMin ?? '?'}-${item.storageHumidityMax ?? '?'}% humidity but location provides ${location.humidityMin ?? '?'}-${location.humidityMax ?? '?'}%`,
            itemMin: item.storageHumidityMin,
            itemMax: item.storageHumidityMax,
            locationMin: location.humidityMin,
            locationMax: location.humidityMax,
          });
        }
      }
    }
  }

  private async decreaseInventory(
    repo: Repository<StorageInventory>,
    tenantId: string, locationId: string,
    itemType: StorageItemType, itemId: string,
    quantity: number, unit: string,
    lotNumber: string | undefined, userId: string,
  ): Promise<void> {
    const inventory = await repo.findOne({
      where: {
        tenantId,
        storageLocationId: locationId,
        itemType,
        itemId,
        lotNumber: lotNumber ?? undefined,
      },
    });

    if (!inventory) {
      throw new BadRequestException(`No inventory found for this item in the specified location`);
    }

    if (Number(inventory.quantity) < quantity) {
      throw new BadRequestException(
        `Insufficient stock. Available: ${inventory.quantity} ${unit}, Requested: ${quantity} ${unit}`
      );
    }

    inventory.quantity = Number(inventory.quantity) - quantity;
    inventory.updatedBy = userId;

    if (inventory.quantity <= 0) {
      await repo.remove(inventory);
    } else {
      await repo.save(inventory);
    }
  }

  private async increaseInventory(
    repo: Repository<StorageInventory>,
    tenantId: string, locationId: string,
    itemType: StorageItemType, itemId: string,
    quantity: number, unit: string,
    lotNumber: string | undefined, expiryDate: Date | undefined,
    userId: string,
  ): Promise<void> {
    let inventory = await repo.findOne({
      where: {
        tenantId,
        storageLocationId: locationId,
        itemType,
        itemId,
        lotNumber: lotNumber ?? undefined,
      },
    });

    if (inventory) {
      inventory.quantity = Number(inventory.quantity) + quantity;
      inventory.updatedBy = userId;
      if (expiryDate) inventory.expiryDate = expiryDate;
      await repo.save(inventory);
    } else {
      inventory = repo.create({
        tenantId,
        storageLocationId: locationId,
        itemType,
        itemId,
        quantity,
        unit,
        lotNumber,
        expiryDate,
        createdBy: userId,
        updatedBy: userId,
      });
      await repo.save(inventory);
    }
  }

  private async updateItemTotalQuantity(
    manager: any,
    itemType: StorageItemType, itemId: string, tenantId: string,
  ): Promise<void> {
    // Sum all inventory for this item
    const result = await manager.getRepository(StorageInventory)
      .createQueryBuilder('inv')
      .select('COALESCE(SUM(inv.quantity), 0)', 'total')
      .where('inv.itemType = :itemType', { itemType })
      .andWhere('inv.itemId = :itemId', { itemId })
      .andWhere('inv.tenantId = :tenantId', { tenantId })
      .getRawOne();

    const totalQuantity = parseFloat(result?.total || '0');

    switch (itemType) {
      case StorageItemType.FEED: {
        const feed = await manager.getRepository(Feed).findOne({ where: { id: itemId, tenantId } });
        if (feed) {
          feed.quantity = totalQuantity;
          if (totalQuantity <= 0) feed.status = 'out_of_stock';
          else if (totalQuantity <= Number(feed.minStock)) feed.status = 'low_stock';
          else feed.status = 'available';
          await manager.getRepository(Feed).save(feed);
        }
        break;
      }
      case StorageItemType.CHEMICAL: {
        const chem = await manager.getRepository(Chemical).findOne({ where: { id: itemId, tenantId } });
        if (chem) {
          chem.quantity = totalQuantity;
          chem.updateStockStatus();
          await manager.getRepository(Chemical).save(chem);
        }
        break;
      }
      case StorageItemType.CONSUMABLE: {
        const cons = await manager.getRepository(Consumable).findOne({ where: { id: itemId, tenantId } });
        if (cons) {
          cons.quantity = totalQuantity;
          cons.updateStockStatus();
          await manager.getRepository(Consumable).save(cons);
        }
        break;
      }
    }
  }
}
