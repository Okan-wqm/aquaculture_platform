import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource, EntityManager } from 'typeorm';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OutboxPublisher } from '@platform/outbox';
import type { StockMovementRecordedEvent } from '@platform/event-contracts';
import { createBaseEvent } from '@platform/event-contracts';
import { RecordStockMovementCommand } from '../commands/record-stock-movement.command';
import { StockMovement } from '../entities/stock-movement.entity';
import { ConditionWarning } from '../dto/stock-movement.response';
import { StockMovementService, RecordMovementInput } from '../services/stock-movement.service';

/**
 * RecordStockMovementHandler — thin transactional wrapper around
 * `StockMovementService.recordMovement`.
 *
 * # Why this is now a wrapper (feed dual-SSoT write-path correctness)
 *
 * The inventory-mutation core moved into `StockMovementService` so it can
 * enlist a CALLER-provided transaction — that is what lets feeding
 * deduction commit atomically with the feeding write (see
 * `StockMovementService` header). This handler keeps the same external
 * contract for manual / GraphQL-driven movements: open a transaction, apply
 * the movement, and ENQUEUE its domain events to the transactional outbox in
 * that same transaction.
 *
 * Events are enqueued via `OutboxPublisher.enqueue(event, manager)` inside the
 * movement transaction, so the outbox row commits atomically with the
 * inventory write (at-least-once). A relay worker delivers them afterwards — a
 * NATS outage can no longer silently drop the StockMovementRecorded record or,
 * critically, the LowStockDetected reorder alert. (The prior post-commit
 * `eventBus.publish` in a swallow-catch was at-most-once and lossy.)
 */
@CommandHandler(RecordStockMovementCommand)
export class RecordStockMovementHandler implements ICommandHandler<RecordStockMovementCommand, StockMovement> {
  private readonly logger = new Logger(RecordStockMovementHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly stockMovementService: StockMovementService,
    // OutboxPublisher is provided app-wide by the @Global() FarmOutboxModule,
    // so no module import is needed here.
    private readonly outboxPublisher: OutboxPublisher,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async execute(command: RecordStockMovementCommand): Promise<StockMovement & { warnings?: ConditionWarning[] }> {
    const { input, tenantId, userId, userName } = command;
    const { movementType, itemType, itemId } = input;

    this.logger.log(`Recording ${movementType} movement for ${itemType} ${itemId}`);

    const movementInput: RecordMovementInput = {
      movementType: input.movementType,
      itemType: input.itemType,
      itemId: input.itemId,
      quantity: input.quantity,
      fromLocationId: input.fromLocationId,
      toLocationId: input.toLocationId,
      lotNumber: input.lotNumber,
      expiryDate: input.expiryDate,
      reference: input.reference,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      movementDate: input.movementDate,
    };

    // Inventory mutation + audit row in a single transaction owned here.
    // SEC-HIGH-051: pass the caller's site-authorization context so the sink
    // (StockMovementService) asserts assignment to each touched location's site
    // BEFORE any write. This is a DIRECT operator movement, so the check applies
    // (feeding callers omit it — they authorize on the feeding site at their sink).
    const result = await this.dataSource.transaction(async (manager) => {
      const movementResult = await this.stockMovementService.recordMovement(manager, movementInput, {
        tenantId,
        userId,
        userName,
        siteAuthorization: {
          sub: userId,
          roles: command.userRoles,
          assignedSiteIds: command.callerAssignedSiteIds,
        },
      });

      // Enqueue the StockMovementRecorded event to the outbox INSIDE this
      // transaction so the outbox row commits atomically with the movement
      // write (at-least-once). Idempotent replay returns the existing
      // movement without re-enqueuing — the original execution already did.
      // LowStockDetected is NOT enqueued here anymore: the single low-stock
      // sink lives inside StockMovementService.recordMovement so feeding
      // deductions and PO receipts emit the same signal without this wrapper.
      if (!movementResult.idempotentHit) {
        await this.enqueueMovementRecorded(manager, movementResult.saved, tenantId, userId);
      }

      return movementResult;
    });

    const { saved, warnings, lowStockCrossings } = result;

    // POST-COMMIT in-process signal for the STOCK_LOW auto-task trigger
    // (task/services/auto-rule-trigger.service.ts). Emitted only after the
    // transaction committed so a rolled-back movement can never spawn a task.
    // That trigger is tenant-level, so it is fed from the POOL tier crossing;
    // the durable, site-aware signal is the outboxed LowStockDetected. The
    // in-process chain is replaced by the AutoRule reconciler in plan PR-B1a-2.
    const poolCrossing = lowStockCrossings.find((crossing) => crossing.reading.level === 'pool');
    if (poolCrossing && !result.idempotentHit) {
      const item = {
        id: saved.itemId,
        name: saved.itemName,
        itemType: saved.itemType,
        currentQuantity: poolCrossing.reading.onHand,
      };
      this.eventEmitter.emit('inventory.lowStock', {
        tenantId,
        outOfStock: poolCrossing.severity === 'out_of_stock' ? [item] : [],
        lowStock:
          poolCrossing.severity === 'low_stock'
            ? [{ ...item, minimumThreshold: poolCrossing.reading.threshold }]
            : [],
      });
    }

    return Object.assign(saved, { warnings: warnings.length > 0 ? warnings : undefined });
  }

  /**
   * Enqueue the universal StockMovementRecorded event to the outbox, inside
   * the caller's transaction, so an enqueue failure rolls the movement back
   * rather than silently dropping the event.
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
