import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { NotFoundException, Logger, BadRequestException } from '@nestjs/common';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { TransferStockCommand } from '../commands/transfer-stock.command';
import { StorageLocation } from '../entities/storage-location.entity';
import { StorageInventory, StorageItemType } from '../entities/storage-inventory.entity';
import { StockMovement, MovementType } from '../entities/stock-movement.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { Chemical } from '../../chemical/entities/chemical.entity';
import { Consumable } from '../../consumable/entities/consumable.entity';

@CommandHandler(TransferStockCommand)
export class TransferStockHandler implements ICommandHandler<TransferStockCommand, StockMovement> {
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
    // SEC-HIGH-051: object-level site authorization SSoT (beneath the role gate).
    private readonly siteAuth: SiteAuthorizationService,
  ) {}

  async execute(command: TransferStockCommand): Promise<StockMovement> {
    const { input, tenantId, userId, userName } = command;

    if (input.quantity <= 0) {
      throw new BadRequestException('Quantity must be positive');
    }

    if (input.fromLocationId === input.toLocationId) {
      throw new BadRequestException('Cannot transfer to the same location');
    }

    if (input.idempotencyKey) {
      const existing = await this.movementRepository.findOne({
        where: { tenantId, idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        this.logger.log(`Idempotent transfer hit: movement ${existing.id} for key ${input.idempotencyKey}`);
        return existing;
      }
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

    // SEC-HIGH-051: object-level site authorization for BOTH legs. A transfer
    // moves stock OUT of the source site INTO the destination site; asserting
    // only one leaves a cross-site escape. StorageLocation.siteId is a direct
    // column. MODULE_MANAGER+ bypasses (managers own cross-site moves); a
    // MODULE_USER not assigned to BOTH sites is DENIED.
    const siteCaller = {
      sub: userId,
      roles: command.userRoles,
      assignedSiteIds: command.callerAssignedSiteIds,
    };
    this.siteAuth.assertSiteAssignment({ caller: siteCaller, siteId: fromLocation.siteId });
    this.siteAuth.assertSiteAssignment({ caller: siteCaller, siteId: toLocation.siteId });

    // Get item name (read-only lookup, safe to run before the transaction)
    const itemName = await this.getItemName(input.itemType as StorageItemType, input.itemId, tenantId);
    if (!itemName) {
      throw new NotFoundException(`${input.itemType} with ID "${input.itemId}" not found`);
    }

    return this.dataSource.transaction(async (manager) => {
      const inventoryRepo = tenantManagerRepo(manager, StorageInventory, tenantId);
      const movementRepo = tenantManagerRepo(manager, StockMovement, tenantId);

      // F-3: Read source inventory INSIDE the transaction with a pessimistic_write lock.
      // Without this lock, two concurrent transfers could both read the same available
      // quantity and both succeed, causing negative inventory (race condition).
      const sourceInventory = await inventoryRepo.findOne({
        where: {
          tenantId,
          storageLocationId: input.fromLocationId,
          itemType: input.itemType as StorageItemType,
          itemId: input.itemId,
          lotNumber: input.lotNumber ?? undefined,
        },
        lock: { mode: 'pessimistic_write' },
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

      // F-4: Capture lotNumber + expiryDate on the transfer movement record.
      // Without these fields, transfers are invisible to TraceLot queries and
      // lot traceability chain is broken (EU 178/2002 Article 18 gap).
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
        lotNumber: input.lotNumber ?? sourceInventory.lotNumber,
        expiryDate: sourceInventory.expiryDate,
        idempotencyKey: input.idempotencyKey,
        performedBy: userId,
        performedByName: userName,
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
