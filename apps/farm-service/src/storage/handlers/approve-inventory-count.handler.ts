import { createHash } from 'crypto';

import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { ApproveInventoryCountCommand } from '../commands/approve-inventory-count.command';
import { InventoryCountItem } from '../entities/inventory-count-item.entity';
import { InventoryCount, InventoryCountStatus } from '../entities/inventory-count.entity';
import { StockMovementService } from '../services/stock-movement.service';

/** Approves a frozen count and reconciles every line through the mutation sink. */
@CommandHandler(ApproveInventoryCountCommand)
export class ApproveInventoryCountHandler
  implements ICommandHandler<ApproveInventoryCountCommand, InventoryCount>
{
  constructor(
    private readonly dataSource: DataSource,
    private readonly stockMovements: StockMovementService,
  ) {}

  async execute(command: ApproveInventoryCountCommand): Promise<InventoryCount> {
    const { countId, tenantId, userId, userName } = command;
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const countRepo = tenantManagerRepo(manager, InventoryCount, tenantId);
      const count = await countRepo.findOne({
        where: { id: countId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!count) throw new NotFoundException(`Inventory count "${countId}" not found`);
      if (count.status !== InventoryCountStatus.COMPLETED) {
        throw new BadRequestException(
          `Cannot approve a count with status "${count.status}". Only COMPLETED counts can be approved.`,
        );
      }
      if (count.performedBy === userId) {
        throw new ForbiddenException(
          'Separation of duties violation: the approver must be a different user ' +
            'than the person who performed the count (SOC2 CC3.4).',
        );
      }

      const items = await tenantManagerRepo(manager, InventoryCountItem, tenantId).find({
        where: { inventoryCountId: count.id, tenantId },
        order: { id: 'ASC' },
      });
      const physicalKeys = new Set<string>();
      for (const item of items) {
        if (item.actualQuantity == null) {
          throw new BadRequestException(`Inventory count item "${item.id}" has no actual quantity`);
        }
        const physicalKey = [item.itemType, item.itemId, item.lotNumber ?? '<NO_LOT>'].join(
          '\u0000',
        );
        if (physicalKeys.has(physicalKey)) {
          throw new BadRequestException(
            `Inventory count contains duplicate physical key for item "${item.itemId}"`,
          );
        }
        physicalKeys.add(physicalKey);
      }
      for (const item of items) {
        const operationKey = createHash('sha256')
          .update(`inventory-count-reconciliation-v1\u0000${count.id}\u0000${item.id}`)
          .digest('hex');
        await this.stockMovements.reconcilePhysicalCount(
          manager,
          {
            itemType: item.itemType,
            itemId: item.itemId,
            storageLocationId: count.storageLocationId,
            lotNumber: item.lotNumber,
            actualQuantity: Number(item.actualQuantity),
            reference: `IC:${count.countNumber}`,
            reason: `Approved physical count line ${item.id}`,
            idempotencyKey: operationKey,
          },
          { tenantId, userId, userName },
        );
      }

      count.status = InventoryCountStatus.APPROVED;
      count.approvedBy = userId;
      count.approvedByName = userName;
      count.approvedAt = new Date();
      count.items = items;
      return countRepo.save(count);
    });
  }
}
