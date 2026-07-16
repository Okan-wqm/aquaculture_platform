import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { OutboxPublisher } from '@platform/outbox';
import type { StockMovementRecordedEvent } from '@platform/event-contracts';
import { createBaseEvent } from '@platform/event-contracts';
import { ReceiveDeliveryCommand } from '../commands/receive-delivery.command';
import { PurchaseOrder, PurchaseOrderStatus } from '../entities/purchase-order.entity';
import { PurchaseOrderItem } from '../entities/purchase-order-item.entity';
import { StorageItemType } from '../entities/storage-inventory.entity';
import { MovementType, StockMovement } from '../entities/stock-movement.entity';
import { StockMovementService } from '../services/stock-movement.service';

/**
 * ReceiveDeliveryHandler — PO receipt into the storage ledger.
 *
 * # Why every receipt goes through StockMovementService (stock SSoT Phase 0)
 *
 * This handler used to write `storage_inventory` + `stock_movements` rows
 * DIRECTLY, bypassing the inventory-mutation core. That skipped
 * `updateItemTotalQuantity`, so feed received via a purchase order never
 * rolled up onto `Feed.quantity` — the consumption forecast (which reads the
 * roll-up) could not see PO-received stock, and the two readings of "how much
 * feed do we have" diverged on every delivery. The direct write also carried
 * no idempotency key and emitted no outbox event.
 *
 * Now each received item is one `recordMovement(IN)` on THIS transaction's
 * manager, which owns FEFO/lot-mix bookkeeping, the immutable audit row, the
 * item-total roll-up, and the idempotency guard. The
 * `StockMovementRecordedEvent` is enqueued to the transactional outbox in the
 * same transaction (at-least-once), mirroring `RecordStockMovementHandler`.
 * No LowStockDetected here — receipts only increase stock.
 *
 * # Idempotency key shape
 *
 * `po-receive-<poItemId>-<cumulativeReceived>` is deterministic per PO-item
 * state transition: an in-flight retry or redelivery of the SAME transition
 * replays to the same key (movement sink returns `idempotentHit`, and the
 * handler then also skips the PO-item progress mutation, keeping ledger and
 * PO in lockstep). A genuinely new partial delivery advances the cumulative
 * count and therefore derives a new key.
 */
@CommandHandler(ReceiveDeliveryCommand)
export class ReceiveDeliveryHandler implements ICommandHandler<ReceiveDeliveryCommand, PurchaseOrder> {
  private readonly logger = new Logger(ReceiveDeliveryHandler.name);

  constructor(
    @InjectRepository(PurchaseOrder)
    private readonly poRepository: Repository<PurchaseOrder>,
    private readonly dataSource: DataSource,
    private readonly stockMovementService: StockMovementService,
    // OutboxPublisher is provided app-wide by the @Global() FarmOutboxModule.
    private readonly outboxPublisher: OutboxPublisher,
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

    // Map category to StorageItemType
    const itemTypeMap: Record<string, StorageItemType> = {
      FEED: StorageItemType.FEED,
      CHEMICAL: StorageItemType.CHEMICAL,
      CONSUMABLE: StorageItemType.CONSUMABLE,
      HEALTHCARE: StorageItemType.HEALTHCARE,
    };
    const storageItemType = itemTypeMap[po.category] || StorageItemType.CONSUMABLE;

    return this.dataSource.transaction(async (manager) => {
      const poItemRepo = tenantManagerRepo(manager, PurchaseOrderItem, tenantId);

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

        // Inventory mutation via the single stock sink: FEFO/lot-mix, the
        // immutable movement row, and the Feed.quantity roll-up all happen
        // inside recordMovement on THIS transaction's manager — a failure
        // rolls back the whole receipt, PO progress included.
        const movementResult = await this.stockMovementService.recordMovement(
          manager,
          {
            movementType: MovementType.IN,
            itemType: storageItemType,
            itemId: poItem.itemId,
            quantity: receiveItem.quantityReceived,
            toLocationId: input.storageLocationId,
            lotNumber: receiveItem.lotNumber,
            expiryDate: receiveItem.expiryDate ? new Date(receiveItem.expiryDate) : undefined,
            reference: `PO: ${po.orderNumber}`,
            idempotencyKey: `po-receive-${poItem.id}-${newReceived}`,
          },
          {
            tenantId,
            userId,
            // SEC-HIGH-051: direct operator-issued movement — the sink asserts
            // assignment to the receiving location's site (MODULE_MANAGER+
            // passes via the role hierarchy; the mutation is manager-gated
            // today, so this is the fail-closed floor if roles ever widen).
            siteAuthorization: {
              sub: userId,
              roles: command.userRoles,
              assignedSiteIds: command.callerAssignedSiteIds,
            },
          },
        );

        if (movementResult.idempotentHit) {
          // This exact (poItem, cumulative) transition was already applied by
          // a previous execution — skip the PO progress mutation too, so the
          // ledger and the PO cannot drift apart on redelivery.
          this.logger.log(
            `Idempotent replay for PO item ${poItem.id} (key po-receive-${poItem.id}-${newReceived}); skipping progress mutation`,
          );
          continue;
        }

        poItem.quantityReceived = newReceived;
        poItem.isFullyReceived = newReceived >= Number(poItem.quantity);
        await poItemRepo.save(poItem);

        await this.enqueueMovementRecorded(manager, movementResult.saved, tenantId, userId);
      }

      // Update PO status
      const allReceived = po.items.every(i => i.isFullyReceived);
      if (allReceived) {
        po.status = PurchaseOrderStatus.RECEIVED;
        po.actualDeliveryDate = new Date();
      } else {
        po.status = PurchaseOrderStatus.PARTIALLY_RECEIVED;
      }

      const savedPO = await tenantManagerRepo(manager, PurchaseOrder, tenantId).save(po);
      this.logger.log(`Received delivery for PO ${po.orderNumber}: status=${savedPO.status}`);
      return savedPO;
    });
  }

  /**
   * Enqueue the StockMovementRecorded event inside the receipt transaction so
   * the outbox row commits atomically with the inventory write (at-least-once,
   * same contract as RecordStockMovementHandler).
   */
  private async enqueueMovementRecorded(
    manager: EntityManager,
    saved: StockMovement,
    tenantId: string,
    userId: string,
  ): Promise<void> {
    const movementEvent: StockMovementRecordedEvent = {
      ...createBaseEvent<StockMovementRecordedEvent>('StockMovementRecorded', tenantId),
      userId,
      movementId: saved.id,
      movementType: saved.movementType,
      itemType: saved.itemType,
      itemId: saved.itemId,
      itemName: saved.itemName,
      quantity: saved.quantity,
      unit: saved.unit,
      fromLocationId: saved.fromLocationId,
      toLocationId: saved.toLocationId,
      lotNumber: saved.lotNumber,
    };
    await this.outboxPublisher.enqueue(movementEvent, manager);
  }
}
