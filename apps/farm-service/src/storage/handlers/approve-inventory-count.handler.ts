import { Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import {
  mutationInstantDateV1,
  readTenantMutationInstantV1,
  runInTenantTransaction,
  tenantManagerRepo,
} from '@aquaculture/backend-common/database';

import { ApproveInventoryCountCommand } from '../commands/approve-inventory-count.command';
import { InventoryCount, InventoryCountStatus } from '../entities/inventory-count.entity';
import { InventoryCountItem } from '../entities/inventory-count-item.entity';
import { MovementType } from '../entities/stock-movement.entity';
import { StockMovementService } from '../services/stock-movement.service';

/**
 * Approval is a composite command boundary. The count state is serialized
 * here; every physical delta is delegated to the sole stock mutation
 * authority, which owns projection, roll-up, audit, idempotency and outbox.
 */
@CommandHandler(ApproveInventoryCountCommand)
export class ApproveInventoryCountHandler
  implements ICommandHandler<ApproveInventoryCountCommand, InventoryCount>
{
  private readonly logger = new Logger(ApproveInventoryCountHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly stockMovementService: StockMovementService,
  ) {}

  async execute(command: ApproveInventoryCountCommand): Promise<InventoryCount> {
    const { countId, tenantId, userId, userName } = command;
    return runInTenantTransaction(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner, mutationSession) => {
        const manager = queryRunner.manager;
        const countRepo = tenantManagerRepo(manager, InventoryCount, tenantId);
        const count = await countRepo.findOne({
          where: { id: countId, tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!count) {
          throw new NotFoundException(`Inventory count "${countId}" not found`);
        }

        const items = await tenantManagerRepo(manager, InventoryCountItem, tenantId).find({
          where: { tenantId, inventoryCountId: count.id },
          order: { itemType: 'ASC', itemId: 'ASC', lotNumber: 'ASC' },
        });
        count.items = items;

        if (count.status === InventoryCountStatus.APPROVED) {
          return count;
        }
        if (count.status !== InventoryCountStatus.COMPLETED) {
          throw new BadRequestException(
            `Cannot approve a count with status "${count.status}". ` +
              'Only COMPLETED counts can be approved.',
          );
        }
        if (count.performedBy === userId) {
          throw new ForbiddenException(
            'Separation of duties violation: the approver must be a different user ' +
              'than the person who performed the count (SOC2 CC3.4).',
          );
        }

        for (const item of items) {
          const variance = Number(item.variance ?? 0);
          if (variance === 0) continue;
          await this.stockMovementService.recordMovement(
            mutationSession,
            {
              movementType: MovementType.ADJUSTMENT,
              itemType: item.itemType,
              itemId: item.itemId,
              quantity: Math.abs(variance),
              fromLocationId: variance < 0 ? count.storageLocationId : undefined,
              toLocationId: variance > 0 ? count.storageLocationId : undefined,
              lotNumber: item.lotNumber,
              reference: `IC:${count.countNumber}`,
              reason: `Inventory count adjustment: variance=${variance} ${item.unit}`,
              // InventoryCountItem is globally unique and immutably belongs to
              // this count. It is the smallest complete operation identity and
              // remains below stock_movements.idempotency_key's 64-char limit.
              idempotencyKey: `inventory-count:${item.id}`,
            },
            { tenantId, userId, userName },
          );
        }

        count.status = InventoryCountStatus.APPROVED;
        count.approvedBy = userId;
        count.approvedByName = userName;
        count.approvedAt = mutationInstantDateV1(
          await readTenantMutationInstantV1(mutationSession, 'farm'),
        );
        const saved = await countRepo.save(count);
        this.logger.log(
          `Inventory count ${count.countNumber} approved by ${userId}; ` +
            `${items.filter((item) => Number(item.variance ?? 0) !== 0).length} adjustments applied`,
        );
        return saved;
      },
    );
  }
}
