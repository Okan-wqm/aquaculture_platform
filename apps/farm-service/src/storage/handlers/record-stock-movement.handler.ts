import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Logger, Optional, Inject } from '@nestjs/common';
import { NatsEventBus } from '@platform/event-bus';
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
 * contract for manual / GraphQL-driven movements: open a transaction,
 * apply the movement, then emit the post-commit domain events.
 *
 * Events are emitted AFTER the transaction commits (Outbox-pattern
 * principle: only publish events for data that is confirmed persisted). If
 * the transaction had rolled back, no events fire — preventing phantom
 * notifications. NATS JetStream handles retry/DLQ for delivery failures.
 */
@CommandHandler(RecordStockMovementCommand)
export class RecordStockMovementHandler implements ICommandHandler<RecordStockMovementCommand, StockMovement> {
  private readonly logger = new Logger(RecordStockMovementHandler.name);

  constructor(
    @InjectRepository(Feed)
    private readonly feedRepository: Repository<Feed>,
    private readonly dataSource: DataSource,
    private readonly stockMovementService: StockMovementService,
    // EVENT_BUS is provided globally by EventBusModule (@Global).
    // @Optional() ensures the handler still works in test environments or
    // when NATS is unavailable — event emission is best-effort.
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
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
    const result = await this.dataSource.transaction((manager) =>
      this.stockMovementService.recordMovement(manager, movementInput, { tenantId, userId, userName }),
    );

    const { saved, currentTotal, idempotentHit, warnings } = result;

    // Idempotent replay returns the existing movement without re-emitting
    // events — the original execution already published them.
    if (!idempotentHit) {
      await this.emitMovementEvents(saved, currentTotal, tenantId, userId, itemType as StorageItemType, movementType);
    }

    return Object.assign(saved, { warnings: warnings.length > 0 ? warnings : undefined });
  }

  /**
   * Publish the universal StockMovementRecorded event plus, for
   * stock-reducing movements, a LowStockDetected alert when the post-op
   * aggregate crosses the item's threshold.
   */
  private async emitMovementEvents(
    saved: StockMovement,
    currentTotal: number,
    tenantId: string,
    userId: string,
    itemType: StorageItemType,
    movementType: MovementType,
  ): Promise<void> {
    if (!this.eventBus) return;

    try {
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
      await this.eventBus.publish(movementEvent);
      this.logger.debug(`Published StockMovementRecordedEvent for movement ${saved.id}`);
    } catch (eventError) {
      // Best-effort delivery: the movement record is the source of truth.
      this.logger.warn(
        `Failed to emit StockMovementRecorded event for movement ${saved.id}: ${(eventError as Error).message}`,
      );
    }

    if (saved.fromLocationId && (movementType === MovementType.OUT || movementType === MovementType.WASTE)) {
      try {
        let severity: 'low_stock' | 'out_of_stock' | null = null;
        let minimumThreshold: number | undefined;

        if (currentTotal <= 0) {
          severity = 'out_of_stock';
        } else if (itemType === StorageItemType.FEED) {
          const feed = await this.feedRepository.findOne({ where: { id: saved.itemId, tenantId } });
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
          await this.eventBus.publish(lowStockEvent);
          this.logger.debug(
            `Published LowStockDetectedEvent for ${itemType} ${saved.itemId}: ${severity} (current: ${currentTotal})`,
          );
        }
      } catch (lowStockError) {
        this.logger.warn(`Failed to check/emit low stock event: ${(lowStockError as Error).message}`);
      }
    }
  }
}
