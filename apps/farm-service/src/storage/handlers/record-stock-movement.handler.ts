import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';
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
export class RecordStockMovementHandler
  implements ICommandHandler<RecordStockMovementCommand, StockMovement>
{
  private readonly logger = new Logger(RecordStockMovementHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly stockMovementService: StockMovementService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async execute(
    command: RecordStockMovementCommand,
  ): Promise<StockMovement & { warnings?: ConditionWarning[] }> {
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
    const result = await runInTenantTransaction(
      this.dataSource,
      'farm',
      tenantId,
      async (_queryRunner, mutationSession) => {
        const movementResult = await this.stockMovementService.recordMovement(
          mutationSession,
          movementInput,
          {
            tenantId,
            userId,
            userName,
            siteAuthorization: {
              sub: userId,
              roles: command.userRoles,
              assignedSiteIds: command.callerAssignedSiteIds,
            },
          },
        );

        return movementResult;
      },
    );

    const { saved, warnings, lowStock } = result;

    // POST-COMMIT in-process signal for the STOCK_LOW auto-task trigger
    // (task/services/auto-rule-trigger.service.ts). Emitted only after the
    // transaction committed so a rolled-back movement can never spawn a task.
    // NOTE: this extends the STOCK_LOW trigger to storage items — previously
    // only the spare-parts cron emitted `inventory.lowStock` (documented as
    // new behavior; the AutoRule UI already advertises feed stock as the
    // example use case).
    if (lowStock && !result.idempotentHit) {
      this.eventEmitter.emit('inventory.lowStock', {
        tenantId,
        outOfStock:
          lowStock.severity === 'out_of_stock'
            ? [
                {
                  id: saved.itemId,
                  name: saved.itemName,
                  itemType: saved.itemType,
                  currentQuantity: result.currentTotal,
                },
              ]
            : [],
        lowStock:
          lowStock.severity === 'low_stock'
            ? [
                {
                  id: saved.itemId,
                  name: saved.itemName,
                  itemType: saved.itemType,
                  currentQuantity: result.currentTotal,
                  minimumThreshold: lowStock.minimumThreshold,
                },
              ]
            : [],
      });
    }

    return Object.assign(saved, { warnings: warnings.length > 0 ? warnings : undefined });
  }
}
