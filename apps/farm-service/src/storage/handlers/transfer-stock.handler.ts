import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { TransferStockCommand } from '../commands/transfer-stock.command';
import { StorageLocation } from '../entities/storage-location.entity';
import { StorageInventory, StorageItemType } from '../entities/storage-inventory.entity';
import { StockMovement, MovementType } from '../entities/stock-movement.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { Chemical } from '../../chemical/entities/chemical.entity';
import { Consumable } from '../../consumable/entities/consumable.entity';

@CommandHandler(TransferStockCommand)
export class TransferStockHandler implements ICommandHandler<TransferStockCommand> {
  private readonly logger = new Logger(TransferStockHandler.name);

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

  async execute(command: TransferStockCommand): Promise<StockMovement> {
    const { input, tenantId, userId } = command;

    if (input.quantity <= 0) {
      throw new BadRequestException('Quantity must be positive');
    }

    if (input.fromLocationId === input.toLocationId) {
      throw new BadRequestException('Cannot transfer to the same location');
    }

    // Validate locations
    const fromLocation = await this.locationRepository.findOne({
      where: { id: input.fromLocationId, tenantId },
    });
    if (!fromLocation) {
      throw new NotFoundException(`Source location "${input.fromLocationId}" not found`);
    }

    const toLocation = await this.locationRepository.findOne({
      where: { id: input.toLocationId, tenantId },
    });
    if (!toLocation) {
      throw new NotFoundException(`Target location "${input.toLocationId}" not found`);
    }

    // Get item name
    const itemName = await this.getItemName(input.itemType as StorageItemType, input.itemId, tenantId);
    if (!itemName) {
      throw new NotFoundException(`${input.itemType} with ID "${input.itemId}" not found`);
    }

    // Get unit from source inventory
    const sourceInventory = await this.inventoryRepository.findOne({
      where: {
        tenantId,
        storageLocationId: input.fromLocationId,
        itemType: input.itemType as StorageItemType,
        itemId: input.itemId,
        lotNumber: input.lotNumber ?? undefined,
      },
    });

    if (!sourceInventory) {
      throw new BadRequestException('No inventory found at source location for this item');
    }

    if (Number(sourceInventory.quantity) < input.quantity) {
      throw new BadRequestException(
        `Insufficient stock at source. Available: ${sourceInventory.quantity}, Requested: ${input.quantity}`
      );
    }

    const unit = sourceInventory.unit;

    return this.dataSource.transaction(async (manager) => {
      const inventoryRepo = manager.getRepository(StorageInventory);
      const movementRepo = manager.getRepository(StockMovement);

      // Decrease from source
      sourceInventory.quantity = Number(sourceInventory.quantity) - input.quantity;
      if (sourceInventory.quantity <= 0) {
        await inventoryRepo.remove(sourceInventory);
      } else {
        sourceInventory.updatedBy = userId;
        await inventoryRepo.save(sourceInventory);
      }

      // Increase at destination
      let destInventory = await inventoryRepo.findOne({
        where: {
          tenantId,
          storageLocationId: input.toLocationId,
          itemType: input.itemType as StorageItemType,
          itemId: input.itemId,
          lotNumber: input.lotNumber ?? undefined,
        },
      });

      if (destInventory) {
        destInventory.quantity = Number(destInventory.quantity) + input.quantity;
        destInventory.updatedBy = userId;
        await inventoryRepo.save(destInventory);
      } else {
        destInventory = inventoryRepo.create({
          tenantId,
          storageLocationId: input.toLocationId,
          itemType: input.itemType as StorageItemType,
          itemId: input.itemId,
          quantity: input.quantity,
          unit,
          lotNumber: input.lotNumber,
          expiryDate: sourceInventory.expiryDate,
          createdBy: userId,
          updatedBy: userId,
        });
        await inventoryRepo.save(destInventory);
      }

      // Create TRANSFER movement
      const movement = movementRepo.create({
        tenantId,
        movementType: MovementType.TRANSFER,
        itemType: input.itemType,
        itemId: input.itemId,
        itemName,
        quantity: input.quantity,
        unit,
        fromLocationId: input.fromLocationId,
        toLocationId: input.toLocationId,
        reference: input.reference,
        reason: input.reason,
        performedBy: userId,
        performedAt: new Date(),
      });

      return movementRepo.save(movement);
    });
  }

  private async getItemName(
    itemType: StorageItemType, itemId: string, tenantId: string,
  ): Promise<string | null> {
    switch (itemType) {
      case StorageItemType.FEED: {
        const feed = await this.feedRepository.findOne({ where: { id: itemId, tenantId } });
        return feed?.name ?? null;
      }
      case StorageItemType.CHEMICAL: {
        const chem = await this.chemicalRepository.findOne({ where: { id: itemId, tenantId } });
        return chem?.name ?? null;
      }
      case StorageItemType.CONSUMABLE: {
        const cons = await this.consumableRepository.findOne({ where: { id: itemId, tenantId } });
        return cons?.name ?? null;
      }
      default:
        return null;
    }
  }
}
