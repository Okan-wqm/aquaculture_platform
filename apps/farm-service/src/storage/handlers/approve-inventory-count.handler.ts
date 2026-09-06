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
import { StorageItemType } from '../entities/storage-inventory.entity';
import { StockMovementService } from '../services/stock-movement.service';
import { MovementType } from '../entities/stock-movement.entity';

@CommandHandler(ApproveInventoryCountCommand)
export class ApproveInventoryCountHandler
  implements ICommandHandler<ApproveInventoryCountCommand, InventoryCount>
{
  private readonly logger = new Logger(ApproveInventoryCountHandler.name);

  constructor(
    @InjectRepository(InventoryCount)
    private readonly countRepository: Repository<InventoryCount>,
    private readonly dataSource: DataSource,
    // Kanonik envanter mutasyon sink'i — roll-up, düşük-stok sinyali,
    // outbox ve idempotency onun sözleşmesinde (FARM-HIGH-239).
    private readonly stockMovementService: StockMovementService,
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

      // Sayım farkları KANONİK mutasyon sink'inden geçer (FARM-MEDIUM-267 /
      // FARM-HIGH-239). Elle yazılan hareket + projeksiyon ikilisi
      // `recordMovement`'ın yaptığı her şeyi atlıyordu: `Feed.quantity`
      // roll-up'ı güncellenmiyor (forecast fantom stokla çalışıyor),
      // `LowStockDetected` doğmuyor (sayım kaynaklı düşüş alarm üretmiyor),
      // outbox event'i ve idempotency yazılmıyordu.
      for (const item of count.items) {
        const variance = Number(item.variance ?? 0);
        if (variance === 0) continue;

        await this.stockMovementService.recordMovement(
          manager,
          {
            movementType: MovementType.ADJUSTMENT,
            itemType: item.itemType as StorageItemType,
            itemId: item.itemId,
            quantity: Math.abs(variance),
            // Fazla (surplus) lokasyona GİRER, eksik (shrinkage) lokasyondan ÇIKAR.
            fromLocationId: variance < 0 ? count.storageLocationId : undefined,
            toLocationId: variance > 0 ? count.storageLocationId : undefined,
            lotNumber: item.lotNumber,
            reference: `IC:${count.countNumber}`,
            reason: `Inventory count adjustment: variance=${variance} ${item.unit}`,
            // Onayın tekrarı çift düzeltme yazamaz.
            idempotencyKey: `ic-approve-${count.id}-${item.id}`,
          },
          { tenantId, userId, userName },
        );
      }

      // Finalize the count record
      count.status = InventoryCountStatus.APPROVED;
      count.approvedBy = userId;
      count.approvedByName = userName;
      count.approvedAt = new Date();

      const savedCount = await countRepo.save(count);

      this.logger.log(
        `Inventory count ${count.countNumber} approved by ${userId}, ` +
          `${count.items.filter((i) => Number(i.variance ?? 0) !== 0).length} adjustments applied, ` +
          `tenant ${tenantId}`,
      );

      return savedCount;
    });
  }
}
