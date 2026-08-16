import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';
import { runInTenantTransaction } from '@aquaculture/backend-common/database';

import { TransferStockCommand } from '../commands/transfer-stock.command';
import { MovementType, StockMovement } from '../entities/stock-movement.entity';
import { StockMovementService } from '../services/stock-movement.service';

/**
 * Transaction boundary for a transfer. Physical projection writes, exact lot
 * semantics, dual-site authorization, roll-up, immutable audit and outbox all
 * belong to StockMovementService; this adapter cannot mutate inventory itself.
 */
@CommandHandler(TransferStockCommand)
export class TransferStockHandler implements ICommandHandler<TransferStockCommand, StockMovement> {
  constructor(
    private readonly dataSource: DataSource,
    private readonly stockMovementService: StockMovementService,
  ) {}

  async execute(command: TransferStockCommand): Promise<StockMovement> {
    const { input, tenantId, userId, userName } = command;
    return runInTenantTransaction(
      this.dataSource,
      'farm',
      tenantId,
      async (_queryRunner, mutationSession) => {
        const result = await this.stockMovementService.recordMovement(
          mutationSession,
          {
            movementType: MovementType.TRANSFER,
            itemType: input.itemType,
            itemId: input.itemId,
            quantity: input.quantity,
            fromLocationId: input.fromLocationId,
            toLocationId: input.toLocationId,
            lotNumber: input.lotNumber,
            reference: input.reference,
            reason: input.reason,
            idempotencyKey: input.idempotencyKey,
          },
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
        return result.saved;
      },
    );
  }
}
