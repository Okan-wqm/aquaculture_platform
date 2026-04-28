/**
 * ApproveInventoryCount Handler
 *
 * Transitions a count from COMPLETED to APPROVED and applies inventory
 * adjustments to reconcile system quantities with physical counts.
 *
 * SOC2 CC3.4: The approver MUST be a different user than the performer.
 * This separation of duties prevents a single person from both counting
 * and approving fraudulent adjustments (e.g., hiding theft or waste).
 *
 * On approval, for each item with non-zero variance:
 * 1. Creates an ADJUSTMENT stock movement (audit trail)
 * 2. Updates storage_inventory to match the actual counted quantity
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { ApproveInventoryCountCommand } from '../commands/approve-inventory-count.command';
import { InventoryCount, InventoryCountStatus } from '../entities/inventory-count.entity';
import { InventoryCountItem } from '../entities/inventory-count-item.entity';
import { StorageInventory } from '../entities/storage-inventory.entity';
import { StockMovement, MovementType } from '../entities/stock-movement.entity';

@CommandHandler(ApproveInventoryCountCommand)
export class ApproveInventoryCountHandler implements ICommandHandler<ApproveInventoryCountCommand, InventoryCount> {
  private readonly logger = new Logger(ApproveInventoryCountHandler.name);

  constructor(
    @InjectRepository(InventoryCount)
    private readonly countRepository: Repository<InventoryCount>,
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: ApproveInventoryCountCommand): Promise<InventoryCount> {
    const { countId, tenantId, userId, userName } = command;

    const count = await this.countRepository.findOne({
      where: { id: countId, tenantId },
      relations: ['items'],
    });

    if (!count) {
      throw new NotFoundException(`Inventory count "${countId}" not found`);
    }

    if (count.status !== InventoryCountStatus.COMPLETED) {
      throw new BadRequestException(
        `Cannot approve a count with status "${count.status}". ` +
        `Only COMPLETED counts can be approved.`,
      );
    }

    // SOC2 CC3.4 — Separation of duties enforcement.
    // The person who performed the physical count cannot also approve it.
    // This is a hard regulatory requirement for BAP/ASC certified facilities
    // and a standard internal control for inventory management.
    if (count.performedBy === userId) {
      throw new ForbiddenException(
        'Separation of duties violation: the approver must be a different user ' +
        'than the person who performed the count (SOC2 CC3.4).',
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const countRepo = tenantManagerRepo(manager, InventoryCount, tenantId);
      const inventoryRepo = tenantManagerRepo(manager, StorageInventory, tenantId);
      const movementRepo = tenantManagerRepo(manager, StockMovement, tenantId);

      // Process each item with a non-zero variance
      for (const item of count.items) {
        const variance = Number(item.variance ?? 0);
        if (variance === 0) continue;

        const actualQuantity = Number(item.actualQuantity ?? 0);

        // Create an ADJUSTMENT stock movement for the audit trail.
        // Positive variance (surplus) -> adjustment IN to the location.
        // Negative variance (shrinkage) -> adjustment OUT from the location.
        const movement = movementRepo.create({
          tenantId,
          movementType: MovementType.ADJUSTMENT,
          itemType: item.itemType,
          itemId: item.itemId,
          itemName: item.itemName,
          quantity: Math.abs(variance),
          unit: item.unit,
          // For surplus: stock appears at the location (toLocationId).
          // For shrinkage: stock disappears from the location (fromLocationId).
          fromLocationId: variance < 0 ? count.storageLocationId : undefined,
          toLocationId: variance > 0 ? count.storageLocationId : undefined,
          reference: `IC:${count.countNumber}`,
          reason: `Inventory count adjustment: variance=${variance} ${item.unit}`,
          lotNumber: item.lotNumber,
          performedBy: userId,
          performedByName: userName,
          performedAt: new Date(),
        });
        await movementRepo.save(movement);

        // Update storage_inventory to match the physical count.
        // Find the specific inventory row for this item+lot+location combination.
        const inventory = await inventoryRepo.findOne({
          where: {
            tenantId,
            storageLocationId: count.storageLocationId,
            itemType: item.itemType,
            itemId: item.itemId,
            lotNumber: item.lotNumber ?? undefined,
          },
        });

        if (inventory) {
          if (actualQuantity <= 0) {
            // Physical count shows zero — remove the inventory row entirely.
            // Keeping zero-quantity rows clutters inventory views and confuses
            // future counts with "ghost" items.
            await inventoryRepo.remove(inventory);
          } else {
            inventory.quantity = actualQuantity;
            inventory.updatedBy = userId;
            await inventoryRepo.save(inventory);
          }
        } else if (actualQuantity > 0) {
          // Item was found physically but has no system record — create one.
          // This handles edge cases where inventory was manually placed in a
          // location without going through the normal stock movement process.
          const newInventory = inventoryRepo.create({
            tenantId,
            storageLocationId: count.storageLocationId,
            itemType: item.itemType,
            itemId: item.itemId,
            quantity: actualQuantity,
            unit: item.unit,
            lotNumber: item.lotNumber,
            createdBy: userId,
            updatedBy: userId,
          });
          await inventoryRepo.save(newInventory);
        }
      }

      // Finalize the count record
      count.status = InventoryCountStatus.APPROVED;
      count.approvedBy = userId;
      count.approvedByName = userName;
      count.approvedAt = new Date();

      const savedCount = await countRepo.save(count);

      this.logger.log(
        `Inventory count ${count.countNumber} approved by ${userId}, ` +
        `${count.items.filter(i => Number(i.variance ?? 0) !== 0).length} adjustments applied, ` +
        `tenant ${tenantId}`,
      );

      return savedCount;
    });
  }
}
