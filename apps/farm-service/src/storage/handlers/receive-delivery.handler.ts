import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import {
  mutationInstantDateV1,
  readTenantMutationInstantV1,
  runInTenantTransaction,
  tenantManagerRepo,
} from '@aquaculture/backend-common/database';
import { ReceiveDeliveryCommand } from '../commands/receive-delivery.command';
import {
  PurchaseOrder,
  PurchaseOrderCategory,
  PurchaseOrderStatus,
} from '../entities/purchase-order.entity';
import { PurchaseOrderItem } from '../entities/purchase-order-item.entity';
import { StorageItemType } from '../entities/storage-inventory.entity';
import { MovementType } from '../entities/stock-movement.entity';
import { StockMovementService } from '../services/stock-movement.service';
import { compareStockMutationTargetsV1 } from '../services/stock-mutation-lock.authority';

const STORAGE_ITEM_TYPE_BY_PURCHASE_ORDER_CATEGORY = Object.freeze({
  [PurchaseOrderCategory.FEED]: StorageItemType.FEED,
  [PurchaseOrderCategory.CHEMICAL]: StorageItemType.CHEMICAL,
  [PurchaseOrderCategory.CONSUMABLE]: StorageItemType.CONSUMABLE,
  [PurchaseOrderCategory.HEALTHCARE]: StorageItemType.HEALTHCARE,
} satisfies Readonly<Record<PurchaseOrderCategory, StorageItemType>>);

/** Fixed-width receipt-line identity that fits stock_movements varchar(64). */
export function purchaseOrderReceiptMovementKeyV1(receiptId: string, poItemId: string): string {
  const digest = createHash('sha256')
    .update('aquaculture.purchase-order-receipt-line/v1\0', 'utf8')
    .update(receiptId.toLowerCase(), 'utf8')
    .update('\0', 'utf8')
    .update(poItemId.toLowerCase(), 'utf8')
    .digest('hex');
  return `po-receive:${digest.slice(0, 52)}`;
}

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
 * The client-generated `receiptId` is stable across network retry and each line
 * is bound to it through a domain-separated digest. Unlike cumulative quantity,
 * this identity survives a committed response being lost: a replay reaches the
 * existing movement and skips PO progress, while a genuinely new receipt has a
 * new operation identity.
 */
@CommandHandler(ReceiveDeliveryCommand)
export class ReceiveDeliveryHandler
  implements ICommandHandler<ReceiveDeliveryCommand, PurchaseOrder>
{
  private readonly logger = new Logger(ReceiveDeliveryHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly stockMovementService: StockMovementService,
  ) {}

  async execute(command: ReceiveDeliveryCommand): Promise<PurchaseOrder> {
    const { input, tenantId, userId } = command;

    return runInTenantTransaction(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner, mutationSession) => {
        const manager = queryRunner.manager;
        const poRepo = tenantManagerRepo(manager, PurchaseOrder, tenantId);
        const poItemRepo = tenantManagerRepo(manager, PurchaseOrderItem, tenantId);
        const po = await poRepo.findOne({
          where: { id: input.purchaseOrderId, tenantId, isDeleted: false },
          lock: { mode: 'pessimistic_write' },
        });
        if (!po) {
          throw new NotFoundException(`Purchase order "${input.purchaseOrderId}" not found`);
        }
        if (
          po.status !== PurchaseOrderStatus.ORDERED &&
          po.status !== PurchaseOrderStatus.PARTIALLY_RECEIVED &&
          po.status !== PurchaseOrderStatus.RECEIVED
        ) {
          throw new BadRequestException(
            'PO must be in ORDERED, PARTIALLY_RECEIVED or idempotently replayed RECEIVED status',
          );
        }

        const poItems = await poItemRepo.find({
          where: { tenantId, purchaseOrderId: po.id },
          order: { itemId: 'ASC', id: 'ASC' },
          lock: { mode: 'pessimistic_write' },
        });
        po.items = poItems;
        const poItemsByItemId = new Map<string, PurchaseOrderItem>();
        for (const poItem of poItems) {
          if (poItemsByItemId.has(poItem.itemId)) {
            throw new BadRequestException(
              `Purchase order ${po.id} has duplicate item identity ${poItem.itemId}`,
            );
          }
          poItemsByItemId.set(poItem.itemId, poItem);
        }

        const requestedItemIds = new Set<string>();
        for (const receiveItem of input.items) {
          if (requestedItemIds.has(receiveItem.itemId)) {
            throw new BadRequestException(`Receipt contains duplicate item ${receiveItem.itemId}`);
          }
          requestedItemIds.add(receiveItem.itemId);
        }
        const storageItemType = STORAGE_ITEM_TYPE_BY_PURCHASE_ORDER_CATEGORY[po.category];
        const orderedReceiptItems = [...input.items].sort((left, right) =>
          compareStockMutationTargetsV1(
            tenantId,
            { itemType: storageItemType, itemId: left.itemId },
            { itemType: storageItemType, itemId: right.itemId },
          ),
        );
        let progressChanged = false;

        for (const receiveItem of orderedReceiptItems) {
          const poItem = poItemsByItemId.get(receiveItem.itemId);
          if (!poItem) {
            throw new BadRequestException(`Item ${receiveItem.itemId} not found in PO`);
          }

          // Inventory mutation via the single stock sink: FEFO/lot-mix, the
          // immutable movement row, and the Feed.quantity roll-up all happen
          // inside recordMovement on THIS transaction's manager — a failure
          // rolls back the whole receipt, PO progress included.
          const movementResult = await this.stockMovementService.recordMovement(
            mutationSession,
            {
              movementType: MovementType.IN,
              itemType: storageItemType,
              itemId: poItem.itemId,
              quantity: receiveItem.quantityReceived,
              toLocationId: input.storageLocationId,
              lotNumber: receiveItem.lotNumber,
              expiryDate: receiveItem.expiryDate ? new Date(receiveItem.expiryDate) : undefined,
              reference: `PO: ${po.orderNumber}`,
              idempotencyKey: purchaseOrderReceiptMovementKeyV1(input.receiptId, poItem.id),
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
            // This exact (receipt, PO item) transition was already applied by
            // a previous execution — skip the PO progress mutation too, so the
            // ledger and the PO cannot drift apart on redelivery.
            this.logger.log(
              `Idempotent replay for receipt ${input.receiptId}, PO item ${poItem.id}; skipping progress mutation`,
            );
            continue;
          }

          if (po.status === PurchaseOrderStatus.RECEIVED) {
            throw new BadRequestException(
              'A completed purchase order accepts only exact receipt replay',
            );
          }
          const newReceived = Number(poItem.quantityReceived) + receiveItem.quantityReceived;
          if (newReceived > Number(poItem.quantity)) {
            throw new BadRequestException(
              `Cannot receive ${receiveItem.quantityReceived} of ${poItem.itemName}. ` +
                `Ordered: ${poItem.quantity}, Already received: ${poItem.quantityReceived}`,
            );
          }

          poItem.quantityReceived = newReceived;
          poItem.isFullyReceived = newReceived >= Number(poItem.quantity);
          await poItemRepo.save(poItem);
          progressChanged = true;
        }

        if (!progressChanged) return po;

        // Update PO status
        const allReceived = po.items.every((i) => i.isFullyReceived);
        if (allReceived) {
          po.status = PurchaseOrderStatus.RECEIVED;
          po.actualDeliveryDate = mutationInstantDateV1(
            await readTenantMutationInstantV1(mutationSession, 'farm'),
          );
        } else {
          po.status = PurchaseOrderStatus.PARTIALLY_RECEIVED;
        }

        const savedPO = await poRepo.save(po);
        this.logger.log(`Received delivery for PO ${po.orderNumber}: status=${savedPO.status}`);
        return savedPO;
      },
    );
  }
}
