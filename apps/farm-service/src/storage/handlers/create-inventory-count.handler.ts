/**
 * CreateInventoryCount Handler
 *
 * Creates a new inventory count session for a storage location and
 * auto-populates line items from the current storage_inventory snapshot.
 *
 * Business rationale: BAP/ASC certification requires periodic physical
 * stock verification. Auto-populating items prevents cherry-picking and
 * ensures every item in the location is included in the count.
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Logger, NotFoundException } from '@nestjs/common';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { CreateInventoryCountCommand } from '../commands/create-inventory-count.command';
import { InventoryCount, InventoryCountStatus } from '../entities/inventory-count.entity';
import { InventoryCountItem } from '../entities/inventory-count-item.entity';
import { StorageInventory, StorageItemType } from '../entities/storage-inventory.entity';
import { StorageLocation } from '../entities/storage-location.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { Chemical } from '../../chemical/entities/chemical.entity';
import { Consumable } from '../../consumable/entities/consumable.entity';

@CommandHandler(CreateInventoryCountCommand)
export class CreateInventoryCountHandler implements ICommandHandler<CreateInventoryCountCommand, InventoryCount> {
  private readonly logger = new Logger(CreateInventoryCountHandler.name);

  constructor(
    @InjectRepository(InventoryCount)
    private readonly countRepository: Repository<InventoryCount>,
    @InjectRepository(StorageLocation)
    private readonly locationRepository: Repository<StorageLocation>,
    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,
    @InjectRepository(Chemical)
    private readonly chemicalRepository: Repository<Chemical>,
    @InjectRepository(Consumable)
    private readonly consumableRepository: Repository<Consumable>,
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: CreateInventoryCountCommand): Promise<InventoryCount> {
    const { input, tenantId, userId, userName } = command;

    // Validate the target location exists and belongs to this tenant
    const location = await this.locationRepository.findOne({
      where: { id: input.storageLocationId, tenantId, isDeleted: false },
    });
    if (!location) {
      throw new NotFoundException(`Storage location "${input.storageLocationId}" not found`);
    }

    return this.dataSource.transaction(async (manager) => {
      const countRepo = tenantManagerRepo(manager, InventoryCount, tenantId);
      const itemRepo = tenantManagerRepo(manager, InventoryCountItem, tenantId);
      const inventoryRepo = tenantManagerRepo(manager, StorageInventory, tenantId);

      // Generate count number: IC-YYYYMMDD-NNN (sequential per tenant per day).
      // The date prefix groups counts by day for easy warehouse shift reporting.
      const today = new Date();
      const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
      const prefix = `IC-${dateStr}-`;

      const countResult = await countRepo
        .createQueryBuilder('ic')
        .andWhere('ic.countNumber LIKE :prefix', { prefix: `${prefix}%` })
        .getCount();
      const countNumber = `${prefix}${String(countResult + 1).padStart(3, '0')}`;

      // Snapshot current inventory for the target location. This freezes the
      // system quantities at count creation time — subsequent stock movements
      // do not affect the expectedQuantity, ensuring a fair comparison.
      const inventoryRows = await inventoryRepo.find({
        where: { tenantId, storageLocationId: input.storageLocationId },
      });

      // Build the count entity
      const count = countRepo.create({
        tenantId,
        countNumber,
        storageLocationId: input.storageLocationId,
        status: InventoryCountStatus.PLANNED,
        performedBy: userId,
        performedByName: userName,
        notes: input.notes,
        totalVariance: 0,
      });

      const savedCount = await countRepo.save(count);

      // Auto-populate items from the current inventory snapshot
      const itemEntities: InventoryCountItem[] = [];
      for (const inv of inventoryRows) {
        itemEntities.push(itemRepo.create({
          tenantId,
          inventoryCountId: savedCount.id,
          itemType: inv.itemType,
          itemId: inv.itemId,
          itemName: inv.itemId, // Will be enriched below if item details are available
          unit: inv.unit,
          lotNumber: inv.lotNumber,
          expectedQuantity: Number(inv.quantity),
          actualQuantity: undefined,
          variance: undefined,
        }));
      }

      // F-6: Enrich item names from the actual Feed/Chemical/Consumable entities.
      // A human-readable name is critical for warehouse workers performing physical
      // counts — "Salmon Grower 5mm" is actionable, "feed:3a7b2c9d" is not.
      for (const item of itemEntities) {
        const resolvedName = await this.resolveItemName(
          item.itemType as StorageItemType, item.itemId, tenantId,
        );
        const lotSuffix = item.lotNumber ? ` (${item.lotNumber})` : '';
        item.itemName = resolvedName
          ? `${resolvedName}${lotSuffix}`
          : `${item.itemType}:${item.itemId.slice(0, 8)}${lotSuffix}`;
      }

      const savedItems = await itemRepo.saveMany(itemEntities);

      this.logger.log(
        `Created inventory count ${countNumber} with ${savedItems.length} items ` +
        `for location ${location.name} (${location.code}), tenant ${tenantId}`,
      );

      savedCount.items = savedItems;
      return savedCount;
    });
  }

  /**
   * Resolve the human-readable item name from the corresponding domain entity.
   * Returns null if the item is not found (deleted or orphaned inventory row).
   */
  private async resolveItemName(
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
