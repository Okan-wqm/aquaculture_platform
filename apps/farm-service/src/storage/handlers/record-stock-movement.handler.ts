import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource, EntityManager } from 'typeorm';
import { Logger } from '@nestjs/common';
import { OutboxPublisher } from '@platform/outbox';
import type { StockMovementRecordedEvent, LowStockDetectedEvent } from '@platform/event-contracts';
import { createBaseEvent } from '@platform/event-contracts';
import { RecordStockMovementCommand } from '../commands/record-stock-movement.command';
import { StorageItemType } from '../entities/storage-inventory.entity';
import { StockMovement, MovementType } from '../entities/stock-movement.entity';
import { Feed } from '../../feed/entities/feed.entity';
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

      // Enqueue the domain events to the outbox INSIDE this transaction so the
      // outbox rows commit atomically with the movement write (at-least-once).
      // Idempotent replay returns the existing movement without re-enqueuing —
      // the original execution already enqueued them.
      if (!movementResult.idempotentHit) {
        await this.enqueueMovementEvents(
          manager,
          movementResult.saved,
          movementResult.currentTotal,
          tenantId,
          userId,
          itemType as StorageItemType,
          movementType,
        );
      }

      return movementResult;
    });

    const { saved, warnings } = result;

    return Object.assign(saved, { warnings: warnings.length > 0 ? warnings : undefined });
  }

  /**
   * Enqueue the universal StockMovementRecorded event plus, for stock-reducing
   * movements, a LowStockDetected alert when the post-op aggregate crosses the
   * item's threshold — both to the outbox, inside the caller's transaction, so
   * an enqueue failure rolls the movement back rather than silently dropping
   * the event.
   */
  private async enqueueMovementEvents(
    manager: EntityManager,
    saved: StockMovement,
    currentTotal: number,
    tenantId: string,
    userId: string,
    itemType: StorageItemType,
    movementType: MovementType,
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

    if (saved.fromLocationId && (movementType === MovementType.OUT || movementType === MovementType.WASTE)) {
      let severity: 'low_stock' | 'out_of_stock' | null = null;
      let minimumThreshold: number | undefined;

      if (currentTotal <= 0) {
        severity = 'out_of_stock';
      } else if (itemType === StorageItemType.FEED) {
        const feed = await manager.findOne(Feed, { where: { id: saved.itemId, tenantId } });
        if (feed && feed.minStock > 0 && currentTotal <= Number(feed.minStock)) {
          severity = 'low_stock';
          minimumThreshold = Number(feed.minStock);
        }
      }

      if (severity) {
        const lowStockEvent: LowStockDetectedEvent = {
          ...createBaseEvent<LowStockDetectedEvent>('LowStockDetected', tenantId),
          itemType,
          itemId: saved.itemId,
          itemName: saved.itemName,
          currentQuantity: currentTotal,
          unit: saved.unit,
          minimumThreshold,
          severity,
        };
        await this.outboxPublisher.enqueue(lowStockEvent, manager);
      }
    }
  }
}
