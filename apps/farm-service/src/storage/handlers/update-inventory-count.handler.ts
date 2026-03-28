/**
 * UpdateInventoryCount Handler
 *
 * Updates actual quantities on individual count items and recalculates
 * per-item variance and aggregate totalVariance.
 *
 * Business rationale: Warehouse staff count items incrementally throughout
 * the day. Each submission updates a batch of items. The handler supports
 * partial updates so staff can count section-by-section without having to
 * submit all items at once.
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { UpdateInventoryCountCommand } from '../commands/update-inventory-count.command';
import { InventoryCount, InventoryCountStatus } from '../entities/inventory-count.entity';
import { InventoryCountItem } from '../entities/inventory-count-item.entity';

@CommandHandler(UpdateInventoryCountCommand)
export class UpdateInventoryCountHandler implements ICommandHandler<UpdateInventoryCountCommand, InventoryCount> {
  private readonly logger = new Logger(UpdateInventoryCountHandler.name);

  constructor(
    @InjectRepository(InventoryCount)
    private readonly countRepository: Repository<InventoryCount>,
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: UpdateInventoryCountCommand): Promise<InventoryCount> {
    const { input, tenantId } = command;

    return this.dataSource.transaction(async (manager) => {
      const countRepo = manager.getRepository(InventoryCount);
      const itemRepo = manager.getRepository(InventoryCountItem);

      // Load the count with optimistic lock check
      const count = await countRepo.findOne({
        where: { id: input.countId, tenantId },
        relations: ['items'],
      });

      if (!count) {
        throw new NotFoundException(`Inventory count "${input.countId}" not found`);
      }

      // Only PLANNED or IN_PROGRESS counts can accept item updates.
      // COMPLETED/APPROVED counts are frozen to preserve audit integrity.
      if (count.status !== InventoryCountStatus.PLANNED && count.status !== InventoryCountStatus.IN_PROGRESS) {
        throw new BadRequestException(
          `Cannot update items on a count with status "${count.status}". ` +
          `Only PLANNED or IN_PROGRESS counts can be modified.`,
        );
      }

      // Build a lookup map for efficient item matching
      const itemMap = new Map<string, InventoryCountItem>();
      for (const item of count.items) {
        itemMap.set(item.id, item);
      }

      // Update each submitted item with actual quantity and compute variance
      for (const update of input.items) {
        const item = itemMap.get(update.itemId);
        if (!item) {
          throw new NotFoundException(
            `Count item "${update.itemId}" not found in inventory count "${input.countId}"`,
          );
        }

        item.actualQuantity = update.actualQuantity;
        item.variance = update.actualQuantity - Number(item.expectedQuantity);
        if (update.notes !== undefined) {
          item.notes = update.notes;
        }
      }

      // Persist updated items
      const updatedItemIds = input.items.map(i => i.itemId);
      const itemsToSave = count.items.filter(i => updatedItemIds.includes(i.id));
      await itemRepo.save(itemsToSave);

      // Recalculate aggregate totalVariance from ALL items (not just updated ones).
      // Items without actualQuantity (not yet counted) are excluded from the sum.
      const allItems = await itemRepo.find({
        where: { inventoryCountId: count.id, tenantId },
      });

      let totalVariance = 0;
      for (const item of allItems) {
        if (item.variance != null) {
          totalVariance += Number(item.variance);
        }
      }
      count.totalVariance = totalVariance;

      // Transition from PLANNED to IN_PROGRESS on first item update.
      // This captures the moment counting actually began for audit timeline.
      if (count.status === InventoryCountStatus.PLANNED) {
        count.status = InventoryCountStatus.IN_PROGRESS;
        count.startedAt = new Date();
      }

      const savedCount = await countRepo.save(count);

      // Reload with fresh items for the response
      const result = await countRepo.findOne({
        where: { id: savedCount.id, tenantId },
        relations: ['items'],
      });

      this.logger.log(
        `Updated ${input.items.length} items on count ${count.countNumber}, ` +
        `totalVariance=${totalVariance}, tenant ${tenantId}`,
      );

      return result!;
    });
  }
}
